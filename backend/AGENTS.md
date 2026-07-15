# AGENTS.md

## 启动后端

```bash
# 测试/开发环境（源码运行）
uv sync                            # 安装 Python 依赖（仅首次）
uv run python funasr_server.py     # 启动服务，首次自动下载模型 ~1.2GB

# 生产环境（容器）
podman compose build               # 构建镜像
podman compose up -d               # 启动容器
podman compose down                # 停止容器
podman logs -f ququ-backend        # 查看日志
```

## API 端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/health` | GET | 健康检查，返回 `{"status":"ok"}` |
| `/status` | GET | 模型状态（server_ready, models_initialized 等）|
| `/transcribe` | POST | 上传音频（multipart/form-data `file` 字段），返回 `{"text":"..."}` |
| `/stats` | GET | 性能统计 |

## 模型自动下载流程

```
容器模式:                          源码模式:
entrypoint.sh                      funasr_server.py 模块加载
  └─ download_models.py              └─ init_server()
       └─ snapshot_download (×3)          ├─ _default_damo_root()  探测模型目录
       └─ sys.exit(1) 若失败              ├─ check_model_files()   检查文件
  └─ gunicorn funasr_server:app           └─ _download_models()    缺失则自动下载
       └─ post_worker_init → init_server()
```

- `snapshot_download` 内置缓存检测，已下载则跳过（幂等）
- 三个模型并行下载：ASR、VAD、标点恢复
- 容器模式模型缓存于 `~/.cache/modelscope`（通过 volume 挂载到 `/models`）

## 关键环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `MODELSCOPE_CACHE` | Docker: `/models`, 源码: `~/.cache/modelscope` | 模型缓存根目录 |
| `DAMO_ROOT` | 由 `_default_damo_root()` 自动探测 | damo 模型实际路径 |
| `OMP_NUM_THREADS` | `4` | PyTorch 并行线程数 |

## gunicorn 配置

- 1 worker / 4 threads / timeout 300s / graceful-timeout 30s
- `post_worker_init` 钩子触发 `init_server()` 确保 worker 启动时模型已就绪
- 绑定 `0.0.0.0:8000`，通过 Flask-CORS 允许跨域

## 代码结构

- `funasr_server.py` — Flask 应用 + FunASR 模型封装 (FunASRServer 类) + 模型下载逻辑
- `download_models.py` — 独立的模型下载脚本（容器入口使用）
- `entrypoint.sh` — 容器启动脚本，先下载模型再启动 gunicorn（`set -e`，任一步失败则退出）
