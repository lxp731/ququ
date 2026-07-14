# AGENTS.md

此文件为在此代码库中工作的AI助手提供指导。

## 项目管理

- **GitHub Project**: https://github.com/users/yan5xu/projects/2

## 目录结构

```
ququ/
├── frontend/          # Electron + React 桌面应用（原生运行）
│   ├── main.js        # Electron 主进程入口
│   ├── preload.js     # IPC 桥接
│   ├── src/           # React 前端源码 + Electron helpers
│   └── assets/        # 图标
├── backend/           # Python FunASR HTTP 服务（容器内运行）
│   ├── funasr_server.py   # Flask HTTP API
│   ├── Dockerfile
│   └── requirements.txt
└── docker-compose.yml # Podman 编排
```

## 构建命令

所有命令在 `frontend/` 目录下运行：

- `pnpm run dev` - 启动开发模式（Electron + Vite）
- `pnpm run build:renderer` - 构建前端（Vite）
- `pnpm run build:linux` - 构建 Linux AppImage

## 关键架构

### FunASR 服务器通信（容器化）
- Python 后端运行在 Podman 容器中，通过 HTTP REST API 通信
- `frontend/src/helpers/funasrManager.js` 管理容器生命周期和 HTTP 调用
- API 端点：`/health`、`/status`、`/transcribe`（multipart/form-data）、`/stats`
- 音频通过 HTTP multipart 直接上传，不写临时文件
- 模型缓存目录通过 Docker 卷挂载：`~/.cache/modelscope:/models`

### 容器管理
- `docker-compose.yml` 位于项目根目录
- 支持 `podman compose` / `docker compose` / `podman-compose` 自动检测
- Electron 启动时自动启动容器，退出时优雅关闭

### IPC 架构
- 所有 Electron IPC 集中在 `frontend/src/helpers/ipcHandlers.js`
- 删除了 `check-python`、`install-python`、`install-funasr`、`download-models` 等通道（不再需要）
- 保留了 `check-funasr-status`、`transcribe-audio`、`restart-funasr-server` 等核心通道

### 前端路径引用
- Vite 配置文件在 `frontend/vite.config.js`
- `publicDir` 指向 `assets`（相对于 frontend/）
- 源码在 `frontend/src/`
- 构建输出到 `frontend/dist/`

## 注意事项

- 不需要在主机上安装 Python 或 FunASR —— 一切在容器中
- 需要 Podman 或 Docker 用于后端容器
- AppImage ~200MB（不含 Python），容器镜像 ~2GB（CPU-only PyTorch）
