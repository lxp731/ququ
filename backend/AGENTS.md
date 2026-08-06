# AGENTS.md — 后端开发指南

## 启动

```bash
# 开发（源码）
uv sync
uv run python server.py

# 生产（容器）
podman compose up -d --build
podman compose logs -f backend
```

## API

| 端点 | 方法 | 说明 |
|------|------|------|
| `/health` | GET | 健康检查 → `{"status":"ok","asr_loaded":true}` |
| `/status` | GET | 模型状态 → `{"success":true,"models_initialized":true,"is_initializing":false}` |
| `/transcribe` | POST | 离线批量转写 (旧版兼容) |
| `/stats` | GET | 性能统计 |
| `/cleanup` | POST | 手动 gc |

## WebSocket `/stream/ws`

单连接承载所有双向通信，协议见 `server.py` 注释和 README。

## 模型

5 个模型，`ASREngine._load_models()` 中加载：

| 模型 | ModelScope ID | 用途 |
|------|-------------|------|
| online | `shuai1618/paraformer-zh-streaming` | 流式实时解码 |
| offline | `iic/SenseVoiceSmall` | 离线纠正 (中英混合 + ITN) |
| fallback | `iic/speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-pytorch` | 离线 fallback |
| VAD | `iic/speech_fsmn_vad_zh-cn-16k-common-pytorch` | 语音活动检测 |
| punc | `iic/punc_ct-transformer_zh-cn-common-vocab272727-pytorch` | 标点恢复 |

模型通过 lifespan 后台预加载，首次 WebSocket 连接时已就绪。

## 代码结构

| 文件 | 职责 |
|------|------|
| `server.py` | FastAPI 入口 (REST + WS)，全局引擎/Pipeline/LLM 管理，广播，热词监控 |
| `asr_engine.py` | `ASREngine` — 5 模型统一引擎，流式+离线+后台循环+generation stamp+音频裁剪 |
| `pipeline.py` | `CandidateBuffer` (三区管道) + `PTTPipeline` — 绿区提交、LLM 润色、终审 |
| `llm_optimizer.py` | `LLMOptimizer` — 流式 OpenAI 兼容 API，关思考梯子，上下文 prompt |
| `download_models.py` | `snapshot_download` 预下载 5 模型，`python server.py` 启动时自动调用 |
| `test_phase1.py` | 集成测试 (引擎/管道/WS/nginx)，`uv run python test_phase1.py` |

## 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `FUNASR_HOST` | `0.0.0.0` | 绑定地址 |
| `FUNASR_PORT` | `8000` | 端口 |
| `FUNASR_DEVICE` | `cpu` | 设备 (auto/cpu/cuda/mps) |
| `OMP_NUM_THREADS` | `4` | PyTorch 并行线程数 |
| `MODELSCOPE_CACHE` | Docker: `/models` | 模型缓存目录 |

## 测试与 Lint

```bash
uv run python test_phase1.py              # 集成测试
uv run --with ruff ruff check *.py        # lint
uv run --with ruff ruff check --fix *.py  # auto-fix
uv run --with basedpyright basedpyright *.py  # type check
```
