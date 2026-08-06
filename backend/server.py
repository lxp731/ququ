"""QuQu 统一后端 — FastAPI + WebSocket

单进程承载:
- REST:  /health, /status, /transcribe (legacy fallback), /models/status
- WS:    /stream/ws (音频 + PTT 控制 + preedit/commit 广播)

架构:
  WebSocket ──► server.py (hub + broadcast)
                    ├─ ASREngine (online + offline + VAD + punc)
                    ├─ PTTPipeline (three-zone buffer + commit)
                    └─ audio_capture (optional, Phase 5)
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
import tempfile
import time
import traceback
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from asr_engine import ASREngine
    from pipeline import PTTPipeline

# ── 加载 .env ──────────────────────────────────────────
_env_path = Path(__file__).resolve().parent.parent / ".env"
if _env_path.is_file():
    try:
        with open(_env_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, value = line.partition("=")
                key = key.strip()
                value = value.strip().strip('"').strip("'")
                if key and value:
                    os.environ.setdefault(key, value)
    except OSError:
        pass

os.environ.setdefault("OMP_NUM_THREADS", "4")

# ── 日志 ──────────────────────────────────────────────

def _setup_logging():
    log_dir = os.path.join(tempfile.gettempdir(), "ququ_logs")
    os.makedirs(log_dir, exist_ok=True)
    log_path = os.path.join(log_dir, "ququ_server.log")
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
        handlers=[
            logging.FileHandler(log_path, encoding="utf-8"),
            logging.StreamHandler(),
        ],
    )

_setup_logging()
logger = logging.getLogger("ququ.server")

# ── 环境 ──────────────────────────────────────────────

FUNASR_HOST = os.environ.get("FUNASR_HOST", "0.0.0.0")
FUNASR_PORT = int(os.environ.get("FUNASR_PORT", "8000"))
FUNASR_DEVICE = os.environ.get("FUNASR_DEVICE", "cpu")

logger.info("Server config: host=%s port=%d device=%s",
            FUNASR_HOST, FUNASR_PORT, FUNASR_DEVICE)

# ── 全局引擎 + Pipeline (懒加载) ────────────────────────

_engine = None          # ASREngine
_pipeline = None        # PTTPipeline
_llm = None             # LLMOptimizer
_hotwords: str = ""     # 热词
_hotword_path: str = ""
_hotword_watch_task: asyncio.Task | None = None
_engine_lock = asyncio.Lock()
_clients: set = set()   # connected WebSocket clients


async def _handle_llm_config(cfg: dict):
    """WebSocket config 命令: 创建/更新 LLM 优化器并注入 pipeline。"""
    global _llm

    enabled = cfg.get("enabled", False)
    if not enabled:
        _llm = None
        if _pipeline is not None:
            _pipeline.llm_optimizer = None
            _pipeline.buffer.set_llm_enabled(False)
        logger.info("LLM disabled")
        return

    from llm_optimizer import LLMOptimizer

    if _llm is None:
        _llm = LLMOptimizer(
            base_url=cfg.get("base_url", "http://localhost:8000/v1"),
            api_key=cfg.get("api_key", ""),
            model=cfg.get("model", "qwen2.5-7b-instruct"),
        )
    else:
        _llm.update_config(
            base_url=cfg.get("base_url", _llm.base_url),
            api_key=cfg.get("api_key", _llm.api_key),
            model=cfg.get("model", _llm.model),
        )

    if _pipeline is not None:
        _pipeline.llm_optimizer = _llm
        _pipeline.buffer.set_llm_enabled(True)
    logger.info("LLM configured: %s @ %s", _llm.model, _llm.base_url)


async def _watch_hotword_file(path: str):
    """后台轮询热词文件 mtime, 变化时自动重载。"""
    global _hotwords
    logger.info("Hotword watch started: %s", path)
    last_mtime: float = 0
    try:
        last_mtime = os.stat(path).st_mtime
    except OSError:
        pass

    while True:
        await asyncio.sleep(2)
        try:
            st = os.stat(path)
            if st.st_mtime == last_mtime:
                continue
            last_mtime = st.st_mtime
            with open(path, encoding="utf-8") as f:  # noqa: ASYNC230
                content = f.read()
            words = content.replace(",", " ").replace("，", " ").replace("\n", " ")
            words = [w.strip() for w in words.split() if w.strip()]
            new_hotwords = " ".join(words)
            if new_hotwords != _hotwords:
                _hotwords = new_hotwords
                if _engine is not None:
                    _engine.set_hotwords(new_hotwords)
                logger.info("Hotword file changed, reloaded %d words", len(words))
                await broadcast({"type": "hotwords_updated", "count": len(words)})
        except OSError:
            continue
        except Exception:
            logger.warning("Hotword watch error", exc_info=True)


async def broadcast(message: dict):
    """向所有已连接 WebSocket 客户端广播消息。"""
    global _clients
    if not _clients:
        return
    dead = set()
    for ws in _clients:
        try:
            await ws.send_json(message)
        except Exception:  # noqa: BLE001
            dead.add(ws)
    _clients -= dead


async def _get_engine():
    """懒加载 ASR 引擎 (首次连接时初始化)。"""
    global _engine, _pipeline
    if _engine is not None:
        return _engine, _pipeline

    async with _engine_lock:
        if _engine is not None:
            return _engine, _pipeline

        from asr_engine import ASREngine
        from pipeline import PTTPipeline

        engine = ASREngine(device=FUNASR_DEVICE)
        pipeline = PTTPipeline(broadcast_fn=broadcast)
        pipeline.start_emergency_timer()

        # 绑定 callbacks
        engine.set_intermediate_callback(pipeline.on_intermediate)
        engine.set_offline_callback(pipeline.on_offline_correction)
        pipeline.buffer._trim_audio_callback = engine.trim_committed_audio

        _engine = engine
        _pipeline = pipeline
        logger.info("ASREngine + PTTPipeline initialized (device=%s)",
                    engine.device)
        return engine, pipeline


# ── FastAPI 应用 ──────────────────────────────────────

from contextlib import asynccontextmanager

from fastapi import FastAPI, File, Form, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse


@asynccontextmanager
async def _lifespan(_app: FastAPI):
    # 启动时后台预加载引擎
    asyncio.create_task(_get_engine())
    yield

app = FastAPI(title="QuQu Speech Input", version="2.0.0", lifespan=_lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health():
    engine = _engine
    return {
        "status": "ok",
        "asr_loaded": engine.is_loaded if engine else False,
        "device": FUNASR_DEVICE,
    }


@app.get("/status")
async def status():
    engine = _engine
    if engine is not None and engine.is_loaded:
        return {
            "success": True,
            "installed": True,
            "initialized": True,
            "models_initialized": True,
            "is_initializing": False,
            "version": "2.0.0",
            "device": engine.device,
            "models": {"asr": True, "vad": True, "punc": True},
        }
    # 引擎尚未初始化 → 标记为加载中（首次 WS 连接时懒加载）
    return {
        "success": True,
        "installed": True,
        "initialized": False,
        "models_initialized": False,
        "is_initializing": True,
        "version": "2.0.0",
        "device": FUNASR_DEVICE,
        "models": {"asr": False, "vad": False, "punc": False},
    }


@app.get("/stats")
async def stats():
    return {"transcription_count": 0, "total_audio_duration": 0.0}


@app.post("/transcribe")
async def transcribe_legacy(
    audio: UploadFile = File(...),  # noqa: B008
    options: str = Form(default="{}"),
):
    """Legacy HTTP 转写端点 (MediaRecorder fallback)。"""
    if not audio:
        return JSONResponse({"error": "No audio file"}, status_code=400)

    engine, _ = await _get_engine()
    if not engine.is_loaded:
        return JSONResponse(
            {"error": "ASR models not loaded"}, status_code=503)

    try:
        opts = json.loads(options)
    except json.JSONDecodeError:
        opts = {}

    # 保存临时文件
    import uuid
    tmp_path = os.path.join(
        tempfile.gettempdir(), f"ququ_upload_{uuid.uuid4().hex}.wav")
    try:
        content = await audio.read()
        with open(tmp_path, "wb") as f:  # noqa: ASYNC230
            f.write(content)

        loop = asyncio.get_running_loop()
        result = await loop.run_in_executor(
            None,
            lambda: _transcribe_file(tmp_path, engine, opts),
        )
        return result
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


def _transcribe_file(path: str, engine, opts: dict) -> dict:
    """同步转写文件 (在 executor 中运行)。"""
    try:
        import wave

        import numpy as np

        with wave.open(path, "rb") as wf:
            frames = wf.readframes(wf.getnframes())
            sample_rate = wf.getframerate()
            pcm = np.frombuffer(frames, dtype=np.int16)

        # resample to 16kHz if needed
        if sample_rate != 16000 and len(pcm) > 0:
            ratio = 16000 / sample_rate
            new_len = int(len(pcm) * ratio)
            indices = np.linspace(0, len(pcm) - 1, new_len)
            pcm = np.interp(indices, np.arange(len(pcm)), pcm).astype(np.int16)

        from asr_engine import _clean_sense_voice_text, _preprocess_audio
        audio_float = pcm.astype(np.float32) / 32768.0
        audio_float = _preprocess_audio(audio_float)

        # Try SenseVoice first
        text = ""
        if engine._offline_model:
            res = engine._offline_model.generate(
                input=audio_float, language="zh", use_itn=True)
            if res and len(res) > 0:
                raw = res[0].get("text", "")
                text = _clean_sense_voice_text(raw)

        # fallback
        if not text and engine._fallback_model:
            res = engine._fallback_model.generate(input=audio_float)
            if res and len(res) > 0:
                text = (res[0].get("text", "") or "").strip()

        if not text:
            return {"success": False, "error": "No transcription result"}

        return {
            "success": True,
            "text": text,
            "raw_text": text,
            "confidence": 0.9,
            "duration": len(pcm) / 16000,
            "language": "zh-CN",
        }
    except Exception as e:  # noqa: BLE001
        return {"success": False, "error": str(e)}


@app.post("/cleanup")
async def cleanup():
    import gc
    gc.collect()
    return {"status": "ok"}


# ══════════════════════════════════════════════════════
# WebSocket — 流式识别 + PTT 控制
# ══════════════════════════════════════════════════════


@app.websocket("/stream/ws")
async def stream_ws(ws: WebSocket):
    global _clients  # noqa: PLW0602
    await ws.accept()
    _clients.add(ws)

    # ★ 先接受连接, 后台加载引擎 (避免模型加载阻塞 accept)
    engine_task = asyncio.create_task(_get_engine())

    await ws.send_json({
        "type": "status",
        "streaming_loaded": False,  # will update once engine is ready
        "device": FUNASR_DEVICE,
    })

    connect_time = time.time()
    total_bytes = 0
    chunk_count = 0

    logger.info("WebSocket client connected")

    engine: ASREngine | None = None
    pipeline: PTTPipeline | None = None

    try:
        engine, pipeline = await engine_task

        # 引擎加载完成后发送更新状态
        await ws.send_json({
            "type": "status",
            "streaming_loaded": engine.is_loaded,
            "device": engine.device,
        })

        if pipeline is None:
            await ws.send_json({"type": "error", "message": "Pipeline init failed"})
            return

        while True:
            try:
                msg = await ws.receive()
            except (WebSocketDisconnect, RuntimeError):
                break

            if "text" in msg:
                try:
                    cmd = json.loads(msg["text"])
                except json.JSONDecodeError:
                    await ws.send_json({
                        "type": "error",
                        "message": f"Invalid JSON: {msg['text'][:50]}",
                    })
                    continue
                command = cmd.get("command", "")

                if command == "start_listening":
                    # ★ 防重入
                    if hasattr(engine, "_ptt_active") and engine._ptt_active:
                        logger.warning("start_listening ignored: already listening")
                        continue
                    engine._ptt_active = True
                    pipeline.reset()
                    engine.reset()
                    engine.start_processing()
                    await broadcast({"type": "reset"})
                    logger.info("PTT: START")

                elif command == "stop_listening":
                    engine._ptt_active = False
                    # 等待最后一次离线纠正
                    for _ in range(12):
                        if not engine.offline_busy:
                            break
                        await asyncio.sleep(0.05)
                    await engine.flush_final_offline()
                    await pipeline.finalize()
                    await engine.stop_processing()
                    logger.info("PTT: STOP")

                elif command == "reset":
                    engine.reset()
                    pipeline.reset()
                    await broadcast({"type": "reset"})
                    logger.debug("Session reset")

                elif command == "commit_now":
                    await pipeline.commit_now()

                elif command == "config":
                    await _handle_llm_config(cmd.get("llm", {}))
                    # 热词更新
                    hotwords = cmd.get("hotwords", "")
                    hotword_path = cmd.get("hotword_path", "")
                    if hotword_path or hotwords:
                        global _hotwords, _hotword_path, _hotword_watch_task
                        _hotwords = hotwords
                        if engine is not None and hotwords:
                            engine.set_hotwords(hotwords)
                        # 启动 inotify 文件监控
                        if hotword_path and hotword_path != _hotword_path:
                            _hotword_path = hotword_path
                            if _hotword_watch_task is not None:
                                _hotword_watch_task.cancel()
                            _hotword_watch_task = asyncio.create_task(
                                _watch_hotword_file(hotword_path))
                        logger.info("Hotwords updated: %d chars", len(hotwords))
                    await ws.send_json({"type": "config_ack"})

                elif command == "ping":
                    await ws.send_json({"type": "pong"})

            elif "bytes" in msg:
                # Binary: PCM 音频块
                if engine.is_loaded:
                    await engine.process_audio(msg["bytes"])
                total_bytes += len(msg["bytes"])
                chunk_count += 1

    except WebSocketDisconnect:
        logger.info(
            "WebSocket disconnected after %.1fs (%d bytes, %d chunks)",
            time.time() - connect_time, total_bytes, chunk_count,
        )
    except Exception:  # noqa: BLE001
        logger.error("WebSocket error: %s", traceback.format_exc())
    finally:
        _clients.discard(ws)
        # 如果这是最后一个客户端, 清理引擎状态
        if not _clients and engine is not None:
            engine.reset()
            if pipeline is not None:
                pipeline.reset()


# ── 启动入口 ────────────────────────────────────────────


def main():
    import uvicorn

    # ── 预下载 ──
    _script = os.path.join(os.path.dirname(os.path.abspath(__file__)), "download_models.py")
    try:
        import subprocess as _sp
        _sp.run([sys.executable, _script], check=False, timeout=3600)
    except Exception:  # noqa: BLE001
        logger.warning("模型预下载未完成 (AutoModel 会自行补下)")

    logger.info("Starting QuQu unified server...")
    logger.info("  REST: http://%s:%d/health", FUNASR_HOST, FUNASR_PORT)
    logger.info("  WS:   ws://%s:%d/stream/ws", FUNASR_HOST, FUNASR_PORT)

    uvicorn.run(
        "server:app",
        host=FUNASR_HOST,
        port=FUNASR_PORT,
        log_level="info",
        ws_ping_interval=20,
        ws_ping_timeout=10,
        timeout_keep_alive=300,
    )


if __name__ == "__main__":
    main()
