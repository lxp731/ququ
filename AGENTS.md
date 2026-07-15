# AGENTS.md

本文档记录项目架构和技术栈速查。

## 项目架构

```
ququ/
├── frontend/              # Electron + React 桌面应用
│   ├── main.js            # Electron 主进程入口
│   ├── preload.js         # IPC 桥接 (contextBridge)
│   ├── src/
│   │   ├── App.jsx         # 主页面（录音、状态管理）
│   │   ├── settings.jsx    # 设置页面
│   │   ├── history.jsx     # 转录历史
│   │   ├── helpers/        # Electron 主进程模块
│   │   └── hooks/          # React hooks（渲染进程）
│   └── assets/             # 图标等资源
├── backend/               # Python FunASR HTTP 服务
│   ├── funasr_server.py   # Flask REST API
│   ├── download_models.py # 模型下载脚本
│   ├── entrypoint.sh      # 容器入口（下载→启动）
│   ├── Dockerfile
│   └── pyproject.toml     # uv 依赖管理
└── docker-compose.yml     # Podman/Docker 编排
```

## 技术栈

| 层 | 技术 |
|------|------|
| 桌面框架 | Electron 36 |
| 前端 | React 19, Vite 6, Tailwind CSS 4 |
| UI | Radix UI（无头组件）, Framer Motion（动画）, Lucide（图标）, sonner（toast）|
| 语音识别 | FunASR (Paraformer-large, FSMN-VAD, CT-Transformer) |
| AI 文本优化 | 兼容 OpenAI API（通义千问、Kimi、智谱等）|
| 后端框架 | Flask + gunicorn |
| 数据库 | better-sqlite3（key-value 模式，JSON 序列化存取）|
| 包管理 | pnpm (Node), uv (Python) |
| 容器化 | Podman / Docker Compose |

## 关键设计决策

- **跨平台支持**：Windows / macOS / Linux 三平台。Windows 打包为免安装 portable exe
- **前后端分离**：Electron 桌面端 ↔ Flask HTTP 服务。后端绑定 `0.0.0.0:8000`（接受所有 IP），前端默认连接 `127.0.0.1:8000`，可在设置中改为远程地址
- **后端双启动模式**：源码 `uv run python funasr_server.py` / 容器 `podman compose up -d`
- **模型自动下载**：首次启动自动从 ModelScope 下载 ~1.2GB，`snapshot_download` 幂等，已缓存则跳过
- **设置持久化**：`better-sqlite3` 存于用户数据目录，key-value 模式，存时 `JSON.stringify`，取时 `JSON.parse`
- **长按录音**：KeyWatcher 跨平台实现 — Linux 用 evdev (Python)，Windows 用 GetAsyncKeyState (PowerShell + C# P/Invoke)，macOS 暂不支持（前端自动回退到切换模式）
