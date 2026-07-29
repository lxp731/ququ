#!/usr/bin/env python3

import argparse
import contextlib
import glob
import json
import logging
import os
import signal
import struct
import sys
import tempfile
import threading
import traceback
from pathlib import Path


# ---------------------------------------------------------------------------
# 加载 .env 文件（仅设置未定义的环境变量，已有则保留）
# ---------------------------------------------------------------------------
def _load_dotenv():
    """从项目根目录 .env 加载环境变量（仅在变量未设置时生效）"""
    env_path = Path(__file__).resolve().parent.parent / ".env"
    if not env_path.is_file():
        return
    try:
        with open(env_path, "r", encoding="utf-8") as f:
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
        pass  # .env 加载失败不影响服务启动

_load_dotenv()

# PyTorch 并行线程数（需在所有 import 之前设置，torch 在 import 时读取此变量）
os.environ.setdefault("OMP_NUM_THREADS", "4")

from flask import Flask, jsonify, request
from flask_cors import CORS

# ---------------------------------------------------------------------------
# 日志配置
# ---------------------------------------------------------------------------

def get_log_path():
    log_dir = os.path.join(tempfile.gettempdir(), "ququ_logs")
    os.makedirs(log_dir, exist_ok=True)
    return os.path.join(log_dir, "funasr_server.log")

log_file_path = get_log_path()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s",
    handlers=[
        logging.FileHandler(log_file_path, encoding="utf-8"),
        logging.StreamHandler(),
    ],
)
logger = logging.getLogger(__name__)
logger.info(f"FunASR服务器日志文件: {log_file_path}")


@contextlib.contextmanager
def suppress_stdout():
    """临时重定向 stdout 到 devnull，防止 FunASR 内部日志污染 HTTP 输出"""
    old_stdout = sys.stdout
    with open(os.devnull, "w") as devnull:
        sys.stdout = devnull
        try:
            yield
        finally:
            sys.stdout = old_stdout


# ---------------------------------------------------------------------------
# FunASR 核心服务
# ---------------------------------------------------------------------------

class FunASRServer:
    def __init__(self, damo_root=None):
        self.asr_model = None
        self.vad_model = None
        self.punc_model = None
        self.initialized = False
        self.transcription_count = 0
        self.total_audio_duration = 0.0
        self._transcribe_lock = threading.Lock()

        self.damo_root = damo_root or os.environ.get("DAMO_ROOT")

        signal.signal(signal.SIGTERM, self._signal_handler)
        signal.signal(signal.SIGINT, self._signal_handler)

    def _signal_handler(self, signum, frame):
        logger.info(f"收到信号 {signum}，准备退出...")
        if os.name == 'nt':
            # Windows: 信号机制不完善，直接强制退出
            os._exit(0)
        else:
            # Linux/macOS: sys.exit() 触发正常的清理流程（__exit__, atexit, finally）
            sys.exit(0)

    def _load_asr_model(self):
        try:
            logger.info("开始加载ASR模型...")
            from funasr import AutoModel
            self.asr_model = AutoModel(
                model="damo/speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-pytorch",
                model_revision="v2.0.4",
                disable_update=True,
                device="cpu",
            )
            logger.info("ASR模型加载完成")
            return True
        except Exception as e:  # noqa: BLE001
            logger.error(f"ASR模型加载失败: {e!s}")
            return False

    def _load_vad_model(self):
        try:
            logger.info("开始加载VAD模型...")
            from funasr import AutoModel
            self.vad_model = AutoModel(
                model="damo/speech_fsmn_vad_zh-cn-16k-common-pytorch",
                model_revision="v2.0.4",
                disable_update=True,
                device="cpu",
            )
            logger.info("VAD模型加载完成")
            return True
        except Exception as e:  # noqa: BLE001
            logger.error(f"VAD模型加载失败: {e!s}")
            return False

    def _load_punc_model(self):
        try:
            import time
            start_time = time.time()
            logger.info("开始加载标点恢复模型...")

            import_start = time.time()
            from funasr import AutoModel
            import_time = time.time() - import_start
            logger.info(f"FunASR导入耗时: {import_time:.2f}秒")

            model_start = time.time()
            self.punc_model = AutoModel(
                model="damo/punc_ct-transformer_zh-cn-common-vocab272727-pytorch",
                model_revision="v2.0.4",
                disable_update=True,
                device="cpu",
            )
            model_time = time.time() - model_start
            total_time = time.time() - start_time
            logger.info(f"标点恢复模型加载完成 - 耗时: {model_time:.2f}秒 / 总: {total_time:.2f}秒")
            return True
        except Exception as e:  # noqa: BLE001
            logger.error(f"标点恢复模型加载失败: {e!s}")
            return False

    def initialize(self):
        """并行初始化 FunASR 模型（抑制 stdout 防止 FunASR 内部日志污染）"""
        if self.initialized:
            return {"success": True, "message": "模型已初始化"}

        try:
            import time

            logger.info("正在并行初始化FunASR模型...")
            start_time = time.time()

            results = {}

            def load_model_thread(model_name, load_func):
                thread_start = time.time()
                results[model_name] = load_func()
                thread_time = time.time() - thread_start
                logger.info(f"{model_name}模型加载线程耗时: {thread_time:.2f}秒")

            # suppress_stdout 放在主线程统一管理，避免多线程竞态
            with suppress_stdout():
                threads = [
                    threading.Thread(target=load_model_thread, args=("asr", self._load_asr_model)),
                    threading.Thread(target=load_model_thread, args=("vad", self._load_vad_model)),
                    threading.Thread(target=load_model_thread, args=("punc", self._load_punc_model)),
                ]

                for thread in threads:
                    thread.start()

                for thread in threads:
                    thread.join(timeout=300)
                    if thread.is_alive():
                        logger.error("模型加载线程超时")
                        return {"success": False, "error": "模型加载超时", "type": "timeout_error"}

            failed_models = [name for name, success in results.items() if not success]
            if failed_models:
                error_msg = f"以下模型加载失败: {', '.join(failed_models)}"
                logger.error(error_msg)
                return {"success": False, "error": error_msg, "type": "init_error"}

            total_time = time.time() - start_time
            self.initialized = True
            logger.info(f"所有FunASR模型并行初始化完成，总耗时: {total_time:.2f}秒")
            return {
                "success": True,
                "message": f"FunASR模型并行初始化成功，耗时: {total_time:.2f}秒",
            }

        except ImportError:
            error_msg = "FunASR未安装，请先安装FunASR: pip install funasr"
            logger.error(error_msg)
            return {"success": False, "error": error_msg, "type": "import_error"}
        except Exception as e:  # noqa: BLE001
            error_msg = f"FunASR模型初始化失败: {e!s}"
            logger.error(error_msg)
            logger.error(traceback.format_exc())
            return {"success": False, "error": error_msg, "type": "init_error"}

    def transcribe_audio(self, audio_path, options=None):
        """转录音频文件（线程安全，同一时间只允许一个转录）"""
        if not self.initialized:
            init_result = self.initialize()
            if not init_result["success"]:
                return init_result

        if not self.asr_model or not self.vad_model:
            return {"success": False, "error": "模型未加载"}

        if not self._transcribe_lock.acquire(timeout=300):
            return {"success": False, "error": "转录请求超时，服务器繁忙", "type": "busy_error"}

        try:
            if not os.path.exists(audio_path):
                return {"success": False, "error": f"音频文件不存在: {audio_path}"}

            logger.info(f"开始转录音频文件: {audio_path}")

            default_options = {
                "batch_size_s": 60,
                "hotword": "",
                "use_vad": True,
                "use_punc": True,
                "language": "zh",
            }
            if options:
                default_options.update(options)

            asr_result = self.asr_model.generate(
                input=audio_path,
                batch_size_s=default_options["batch_size_s"],
                hotword=default_options["hotword"],
                cache={},
            )

            if isinstance(asr_result, list) and len(asr_result) > 0:
                if isinstance(asr_result[0], dict) and "text" in asr_result[0]:
                    raw_text = asr_result[0]["text"]
                else:
                    raw_text = str(asr_result[0])
            else:
                raw_text = str(asr_result)

            logger.info(f"ASR识别完成，原始文本: {raw_text[:100]}...")

            final_text = raw_text
            if default_options["use_punc"] and self.punc_model and raw_text.strip():
                try:
                    punc_result = self.punc_model.generate(input=raw_text)
                    if isinstance(punc_result, list) and len(punc_result) > 0:
                        if isinstance(punc_result[0], dict) and "text" in punc_result[0]:
                            final_text = punc_result[0]["text"]
                        else:
                            final_text = str(punc_result[0])
                    logger.info("FunASR标点恢复完成")
                except Exception as e:  # noqa: BLE001
                    logger.warning(f"FunASR标点恢复失败，使用原始文本: {e!s}")

            duration = self._record_audio_duration(audio_path)
            self.transcription_count += 1

            result = {
                "success": True,
                "text": final_text,
                "raw_text": raw_text,
                "confidence": (
                    getattr(asr_result[0], "confidence", 0.0)
                    if isinstance(asr_result, list)
                    else 0.0
                ),
                "duration": duration,
                "language": "zh-CN",
                "model_type": "pytorch",
            }

            if self.transcription_count % 10 == 0:
                self._cleanup_memory()
                logger.info(f"已完成 {self.transcription_count} 次转录，执行内存清理")

            logger.info(f"转录完成，最终文本: {final_text[:100]}...")
            return result

        except Exception as e:  # noqa: BLE001
            error_msg = f"音频转录失败: {e!s}"
            logger.error(error_msg)
            logger.error(traceback.format_exc())
            return {"success": False, "error": error_msg, "type": "transcription_error"}
        finally:
            self._transcribe_lock.release()

    def _get_audio_duration(self, audio_path):
        """从 WAV 头读取音频时长（仅解析 RIFF header，不解码整个文件）"""
        try:
            with open(audio_path, "rb") as f:
                riff, _size, wave = struct.unpack("<4sI4s", f.read(12))
                if riff != b"RIFF" or wave != b"WAVE":
                    return 0.0
                # 遍历 chunk 找到 fmt 和 data
                data_size = 0
                sample_rate = 0
                channels = 0
                bits_per_sample = 0
                while True:
                    chunk_header = f.read(8)
                    if len(chunk_header) < 8:
                        break
                    chunk_id, chunk_size = struct.unpack("<4sI", chunk_header)
                    if chunk_id == b"fmt ":
                        fmt_data = f.read(chunk_size)
                        audio_format, channels, sample_rate = struct.unpack("<HHI", fmt_data[:8])
                        if audio_format == 1:  # PCM
                            bits_per_sample = struct.unpack("<H", fmt_data[14:16])[0]
                    elif chunk_id == b"data":
                        data_size = chunk_size
                        break
                    else:
                        f.seek(chunk_size, 1)
                if data_size > 0 and sample_rate > 0 and channels > 0:
                    total_samples = data_size / (channels * (bits_per_sample or 16) / 8)
                    duration = total_samples / sample_rate
                    return duration
            return 0.0
        except (struct.error, OSError, ValueError):
            return 0.0

    def _record_audio_duration(self, audio_path):
        """仅在统计采样点（每 10 次）记录音频时长，其余跳过以节省 I/O"""
        # transcription_count 在下游累加，这里取当前值（尚未 +1）判断
        if self.transcription_count % 10 == 0:
            duration = self._get_audio_duration(audio_path)
            self.total_audio_duration += duration
            return duration
        return 0.0

    def _cleanup_memory(self):
        try:
            import gc
            gc.collect()
            logger.info("内存清理完成")
        except Exception as e:  # noqa: BLE001
            logger.warning(f"内存清理失败: {e!s}")

    def get_performance_stats(self):
        return {
            "transcription_count": self.transcription_count,
            "total_audio_duration": round(self.total_audio_duration, 2),
            "average_duration": round(
                self.total_audio_duration / max(1, self.transcription_count), 2
            ),
            "initialized": self.initialized,
            "models_loaded": {
                "asr": self.asr_model is not None,
                "vad": self.vad_model is not None,
                "punc": self.punc_model is not None,
            },
        }

    def check_status(self):
        """检查 FunASR 状态"""
        try:
            import funasr
            return {
                "success": True,
                "installed": True,
                "initialized": self.initialized,
                "version": getattr(funasr, "__version__", "unknown"),
                "models": {
                    "asr": self.asr_model is not None,
                    "vad": self.vad_model is not None,
                    "punc": self.punc_model is not None,
                },
            }
        except ImportError:
            return {
                "success": False,
                "installed": False,
                "initialized": False,
                "error": "FunASR未安装",
            }


# ---------------------------------------------------------------------------
# Flask HTTP API
# ---------------------------------------------------------------------------

app = Flask(__name__)
app.config['MAX_CONTENT_LENGTH'] = 50 * 1024 * 1024  # 50MB，超过返回 413
CORS(app)

# 全局服务实例（启动时初始化）
server: "FunASRServer | None" = None


@app.route('/health', methods=['GET'])
def health():
    """存活 / 就绪探针（模型未就绪时返回 503，配合 K8s readiness probe）"""
    if server is None or not server.initialized:
        return jsonify({"status": "not_ready"}), 503
    return jsonify({"status": "ok"})


@app.route('/status', methods=['GET'])
def status():
    """返回 FunASR 安装和模型状态"""
    if server is None:
        return jsonify({
            "success": False,
            "installed": False,
            "initialized": False,
            "error": "服务器尚未初始化",
            "models": {"asr": False, "vad": False, "punc": False},
        })
    return jsonify(server.check_status())


@app.route('/transcribe', methods=['POST'])
def transcribe():
    """接受 WAV 音频上传（multipart/form-data），返回转录结果"""
    if server is None or not server.initialized:
        return jsonify({"success": False, "error": "服务器未初始化，模型未就绪"}), 503

    if 'audio' not in request.files:
        return jsonify({"success": False, "error": "缺少 audio 文件"}), 400

    audio_file = request.files['audio']
    options = request.form.get('options', '{}')
    try:
        options = json.loads(options)
    except json.JSONDecodeError:
        options = {}

    suffix = Path(audio_file.filename or 'audio.wav').suffix or '.wav'
    tmp_dir = os.environ.get("QUQU_TMP_DIR", tempfile.gettempdir())
    with tempfile.NamedTemporaryFile(suffix=suffix, dir=tmp_dir, delete=False) as tmp:
        audio_file.save(tmp.name)
        tmp_path = tmp.name

    try:
        result = server.transcribe_audio(tmp_path, options)
        return jsonify(result)
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


@app.route('/stats', methods=['GET'])
def stats():
    """性能统计"""
    if server is None:
        return jsonify({"success": False, "error": "服务器未初始化"})
    return jsonify({"success": True, "stats": server.get_performance_stats()})


@app.route('/cleanup', methods=['POST'])
def cleanup():
    """触发内存清理"""
    if server is not None:
        server._cleanup_memory()
    return jsonify({"success": True, "message": "内存清理完成"})


# ---------------------------------------------------------------------------
# 服务初始化（模块加载时执行 — gunicorn 和 app.run 均会触发）
# ---------------------------------------------------------------------------

def _default_damo_root():
    root = os.environ.get("MODELSCOPE_CACHE")
    if root:
        for sub in ["damo", "hub/damo", "hub/models/damo"]:
            p = os.path.join(root, sub)
            if os.path.isdir(p):
                return p
    home_dir = os.path.expanduser("~")
    for sub in ["damo", "hub/damo", "hub/models/damo"]:
        p = os.path.join(home_dir, ".cache", "modelscope", sub)
        if os.path.isdir(p):
            return p
    return os.path.join(home_dir, ".cache", "modelscope", "hub", "damo")


def check_model_files(cache_path):
    """检查模型文件是否存在（支持版本化子目录如 v2.0.4/）"""
    repos = [
        "speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-pytorch",
        "speech_fsmn_vad_zh-cn-16k-common-pytorch",
        "punc_ct-transformer_zh-cn-common-vocab272727-pytorch",
    ]
    missing = []
    for r in repos:
        rd = os.path.join(cache_path, r)
        if not os.path.isdir(rd):
            missing.append(r)
            continue
        patterns = ["model.pt", "pytorch_model.bin", "*.onnx", "config.json", "model.yaml", "vocab*"]
        found = False
        for p in patterns:
            if glob.glob(os.path.join(rd, p)) or glob.glob(os.path.join(rd, '*', p)):
                found = True
                break
        if not found:
            missing.append(r)
    return missing


_init_done = False


def _download_models():
    """自动下载缺失模型（并行），返回 True 表示全部成功"""
    from modelscope.hub.snapshot_download import snapshot_download

    models = [
        ("damo/speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-pytorch", "v2.0.4"),
        ("damo/speech_fsmn_vad_zh-cn-16k-common-pytorch", "v2.0.4"),
        ("damo/punc_ct-transformer_zh-cn-common-vocab272727-pytorch", "v2.0.4"),
    ]
    cache_dir = os.environ.get("MODELSCOPE_CACHE")
    results = {}

    def _dl(mid, rev, idx):
        try:
            snapshot_download(mid, revision=rev, cache_dir=cache_dir)
            results[idx] = True
        except Exception as e:  # noqa: BLE001
            logger.error(f"模型下载失败 {mid}: {e}")
            results[idx] = False

    logger.info("开始自动下载模型（~1.2GB，首次可能需要几分钟）...")
    threads = [threading.Thread(target=_dl, args=(mid, rev, i)) for i, (mid, rev) in enumerate(models)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    return all(results.values())


def init_server():
    """初始化全局 FunASR 服务实例（模块加载时自动调用，幂等）"""
    global server, _init_done
    if _init_done and server is not None and server.initialized:
        return
    _init_done = True

    damo_root = _default_damo_root()
    logger.info(f"使用的模型根目录(damo root): {damo_root}")

    server = FunASRServer(damo_root=damo_root)

    missing = check_model_files(damo_root)
    if missing:
        logger.warning(f"模型文件缺失: {', '.join(missing)}，自动下载中...")
        if not _download_models():
            logger.error("模型自动下载失败，跳过初始化。请检查网络后重试。")
            return
        # 下载后 damo 子目录可能已创建，重新探测
        damo_root = _default_damo_root()
        logger.info(f"下载完成，重新确定模型根目录: {damo_root}")

    logger.info("模型文件就绪，开始初始化...")
    init_result = server.initialize()
    if init_result.get('success'):
        logger.info(f"模型初始化成功: {init_result.get('message')}")
    else:
        logger.warning(f"模型初始化失败: {init_result}")


# gunicorn post_worker_init 钩子
def post_worker_init(worker):
    init_server()


# 模块加载时立即初始化（支持 gunicorn preload 或直接 app.run）
init_server()


# ---------------------------------------------------------------------------
# gunicorn 程序化启动封装
# ---------------------------------------------------------------------------

_IS_WINDOWS = sys.platform == 'win32'

if _IS_WINDOWS:
    _GunicornApp = None  # Windows 不支持 gunicorn
else:
    import gunicorn.app.base as gunicorn_app_base

    class _GunicornApp(gunicorn_app_base.BaseApplication):
        """将 Flask app 封装为 gunicorn Application，支持程序化传入配置"""

        def __init__(self, flask_app, options=None):
            self._flask_app = flask_app
            self._options = options or {}
            super().__init__()

        def load_config(self):
            for key, value in self._options.items():
                if key in self.cfg.settings and value is not None:
                    self.cfg.set(key.lower(), value)

        def load(self):
            return self._flask_app


# ---------------------------------------------------------------------------
# 启动入口（python funasr_server.py 直接运行时使用）
# ---------------------------------------------------------------------------

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description="FunASR HTTP 服务器")
    parser.add_argument('--host', default=os.environ.get('FUNASR_HOST', '0.0.0.0'), help='监听地址')
    parser.add_argument('--port', type=int, default=int(os.environ.get('FUNASR_PORT', '8000')), help='监听端口')
    parser.add_argument('--debug', action='store_true', default=False, help='Flask 调试模式（仅开发使用，会禁用 gunicorn）')
    args = parser.parse_args()

    if _IS_WINDOWS or args.debug:
        if _IS_WINDOWS and not args.debug:
            logger.warning("Windows 不支持 gunicorn，使用 Flask 开发服务器（生产环境推荐用 Docker）")
        logger.info(f"启动 Flask 开发服务器 -> {args.host}:{args.port}")
        app.run(host=args.host, port=args.port, debug=args.debug)
    else:
        workers = int(os.environ.get('FUNASR_WORKERS', '1'))
        threads = int(os.environ.get('FUNASR_THREADS', '8'))
        logger.info(
            f"启动 gunicorn -> {args.host}:{args.port} "
            f"(workers={workers}, threads={threads})"
        )
        _GunicornApp(app, {
            'bind': f'{args.host}:{args.port}',
            'workers': workers,
            'threads': threads,
            'timeout': 300,
            'graceful_timeout': 30,
        }).run()
