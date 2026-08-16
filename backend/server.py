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
    # 安全: 日志文件含敏感上下文, 收紧为仅属主可读写
    try:
        os.chmod(log_path, 0o600)
        os.chmod(log_dir, 0o700)
    except OSError:
        pass

_setup_logging()
logger = logging.getLogger("ququ.server")

# ── 环境 ──────────────────────────────────────────────

FUNASR_HOST = os.environ.get("FUNASR_HOST", "0.0.0.0")
FUNASR_PORT = int(os.environ.get("FUNASR_PORT", "8000"))
FUNASR_DEVICE = os.environ.get("FUNASR_DEVICE", "cpu")

# ── 安全: CORS 白名单 (默认仅本机) ──
_CORS_ORIGINS = [
    o.strip() for o in os.environ.get(
        "QUQU_CORS_ORIGINS",
        "http://localhost:5173,http://127.0.0.1:5173,file://",
    ).split(",") if o.strip()
]

# ── 安全: 音频/上传大小上限 ──
MAX_AUDIO_BUFFER_BYTES = int(os.environ.get(
    "QUQU_MAX_AUDIO_BUFFER", str(20 * 1024 * 1024)))   # 20MB ≈ 10min @16k
MAX_UPLOAD_BYTES = int(os.environ.get(
    "QUQU_MAX_UPLOAD", str(100 * 1024 * 1024)))          # 100MB
MAX_WS_BINARY_BYTES = int(os.environ.get(
    "QUQU_MAX_WS_BINARY", str(1024 * 1024)))             # 单块 1MB

logger.info("Server config: host=%s port=%d device=%s cors=%s",
            FUNASR_HOST, FUNASR_PORT, FUNASR_DEVICE, _CORS_ORIGINS)

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

    base_url = str(cfg.get("base_url", "http://localhost:8000/v1")).strip()
    if not _is_valid_llm_url(base_url):
        logger.warning("LLM base_url rejected (scheme/host not allowed): %s",
                       base_url)
        await _broadcast_error("LLM base_url 不合法: 仅允许 http/https")
        return

    if _llm is None:
        _llm = LLMOptimizer(
            base_url=base_url,
            api_key=cfg.get("api_key", ""),
            model=cfg.get("model", "qwen2.5-7b-instruct"),
        )
    else:
        _llm.update_config(
            base_url=base_url,
            api_key=cfg.get("api_key", _llm.api_key),
            model=cfg.get("model", _llm.model),
        )

    if _pipeline is not None:
        _pipeline.llm_optimizer = _llm
        _pipeline.buffer.set_llm_enabled(True)
    logger.info("LLM configured: %s @ %s", _llm.model, _llm.base_url)


def _is_valid_llm_url(url: str) -> bool:
    """SSRF 缓解: 仅允许 http/https, 且禁止元数据/链路本地地址。"""
    try:
        from urllib.parse import urlparse
        parsed = urlparse(url)
        if parsed.scheme not in ("http", "https"):
            return False
        host = (parsed.hostname or "").lower()
        if not host:
            return False
        # 禁止链路本地 / 云元数据地址
        import ipaddress
        for blocked in ("169.254.169.254", "metadata.google.internal"):
            if host == blocked:
                return False
        try:
            addr = ipaddress.ip_address(host)
            if addr.is_link_local or addr.is_multicast or addr.is_unspecified:
                return False
        except ValueError:
            pass  # 域名, 放行 (DNS 解析层无法在此校验)
        return True
    except Exception:  # noqa: BLE001
        return False


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
    # 快照迭代: 避免并发连接增减导致 "Set changed size during iteration"
    for ws in list(_clients):
        try:
            await ws.send_json(message)
        except Exception:  # noqa: BLE001
            dead.add(ws)
    if dead:
        _clients -= dead


async def _broadcast_error(message: str):
    await broadcast({"type": "error", "message": message})


async def _get_engine():
    """懒加载 ASR 引擎 (首次连接时初始化)。

    模型加载是 CPU 密集同步操作, 必须移入 executor,
    否则加载期间整个事件循环冻结 (所有 REST/WS 请求卡死)。
    """
    global _engine, _pipeline
    if _engine is not None:
        return _engine, _pipeline

    async with _engine_lock:
        if _engine is not None:
            return _engine, _pipeline

        from asr_engine import ASREngine
        from pipeline import PTTPipeline

        loop = asyncio.get_running_loop()
        engine = await loop.run_in_executor(
            None, lambda: ASREngine(device=FUNASR_DEVICE))
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
    # 启动时后台预加载引擎 (异常仅记录, 不阻塞启动)
    task = asyncio.create_task(_get_engine())

    def _on_done(t: asyncio.Task):
        if t.cancelled():
            return
        exc = t.exception()
        if exc:
            logger.error("Preload engine failed: %s", exc)

    task.add_done_callback(_on_done)
    yield

app = FastAPI(title="QuQu Speech Input", version="2.0.0", lifespan=_lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=_CORS_ORIGINS,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type", "Authorization"],
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

    # 上传大小上限, 防止内存 DoS
    content = await audio.read(MAX_UPLOAD_BYTES + 1)
    if len(content) > MAX_UPLOAD_BYTES:
        return JSONResponse(
            {"error": f"File too large (max {MAX_UPLOAD_BYTES // (1024 * 1024)}MB)"},
            status_code=413)

    engine, _ = await _get_engine()
    if not engine.is_loaded:
        return JSONResponse(
            {"error": "ASR models not loaded"}, status_code=503)

    try:
        opts = json.loads(options)
    except json.JSONDecodeError:
        opts = {}
    if not isinstance(opts, dict):
        opts = {}

    # 保存临时文件
    import uuid
    tmp_path = os.path.join(
        tempfile.gettempdir(), f"ququ_upload_{uuid.uuid4().hex}.wav")
    try:
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


@app.post("/models/download")
async def models_download():
    """按需预下载/补全模型文件 (download_models.py)。

    与容器 entrypoint 共用同一脚本; 已缓存模型会自动跳过。
    """
    if _engine is not None and _engine.is_loaded:
        return {"success": True, "message": "models already loaded"}

    script = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                          "download_models.py")
    try:
        proc = await asyncio.create_subprocess_exec(
            sys.executable, script,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout, stderr = await asyncio.wait_for(proc.communicate(), 3600)
        except TimeoutError:
            proc.kill()
            await proc.wait()
            return {"success": False, "error": "模型下载超时 (3600s)"}
        if proc.returncode != 0:
            tail = (stderr or b"").decode("utf-8", "replace")[-500:]
            return {"success": False, "error": f"模型下载失败: {tail}"}
        return {"success": True, "message": stdout.decode("utf-8", "replace")[-200:]}
    except Exception as e:  # noqa: BLE001
        logger.warning("models/download failed: %s", e)
        return {"success": False, "error": str(e)}


def _origin_allowed(origin: str) -> bool:
    """WebSocket Origin 白名单: 空 (非浏览器客户端) 或本机开发/打包来源。"""
    if not origin:
        return True  # 非浏览器客户端 (Electron net / ws 库) 不携带 Origin
    allowed = (
        "http://localhost:5173", "http://127.0.0.1:5173",
        "file://", "http://localhost", "http://127.0.0.1",
    )
    return origin.rstrip("/") in allowed


def _valid_hotword_path(path: str) -> bool:
    """热词文件路径校验: 必须是存在的常规文件, 且大小受限。"""
    try:
        p = Path(path).expanduser()
        if not p.is_absolute():
            return False
        st = p.stat()
        return p.is_file() and st.st_size <= 5 * 1024 * 1024
    except OSError:
        return False


# ══════════════════════════════════════════════════════
# WebSocket — 流式识别 + PTT 控制
# ══════════════════════════════════════════════════════


@app.websocket("/stream/ws")
async def stream_ws(ws: WebSocket):
    global _clients  # noqa: PLW0602

    # ── Origin 校验: 只接受本机应用来源, 防 CSWSH ──
    origin = ws.headers.get("origin", "")
    if not _origin_allowed(origin):
        logger.warning("WebSocket rejected (origin not allowed): %r", origin)
        await ws.close(code=1008)
        return

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
                    if engine.is_ptt_active():
                        logger.warning("start_listening ignored: already listening")
                        continue
                    engine.set_ptt_active(True)
                    pipeline.reset()
                    engine.reset()
                    engine.start_processing()
                    await broadcast({"type": "reset"})
                    logger.info("PTT: START")

                elif command == "stop_listening":
                    engine.set_ptt_active(False)
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
                        # 启动 mtime 轮询文件监控 (路径安全校验)
                        if hotword_path and hotword_path != _hotword_path:
                            if _valid_hotword_path(hotword_path):
                                _hotword_path = hotword_path
                                if _hotword_watch_task is not None:
                                    _hotword_watch_task.cancel()
                                _hotword_watch_task = asyncio.create_task(
                                    _watch_hotword_file(hotword_path))
                            else:
                                logger.warning(
                                    "Hotword path rejected: %s", hotword_path)
                        logger.info("Hotwords updated: %d chars", len(hotwords))
                    await ws.send_json({"type": "config_ack"})

                elif command == "ping":
                    await ws.send_json({"type": "pong"})

            elif "bytes" in msg:
                # Binary: PCM 音频块 — 仅 PTT 激活期间接收, 且限制单块大小
                if engine.is_ptt_active() and len(msg["bytes"]) <= MAX_WS_BINARY_BYTES:
                    if engine.is_loaded:
                        await engine.process_audio(msg["bytes"])
                elif len(msg["bytes"]) > MAX_WS_BINARY_BYTES:
                    logger.warning("Oversized WS binary dropped (%d bytes)",
                                   len(msg["bytes"]))
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
        # 如果这是最后一个客户端, 清理引擎状态 (含 PTT 标志, 防止重连后卡死)
        if not _clients and engine is not None:
            try:
                await engine.stop_processing()
            except Exception:
                logger.warning("stop_processing on disconnect failed",
                               exc_info=True)
            engine.set_ptt_active(False)
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
