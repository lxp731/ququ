<div align="center">

# 蛐蛐 (QuQu)

**开源免费的 Wispr Flow 替代方案 | 为中文而生的下一代智能语音工作流**

<img src="https://img.shields.io/badge/license-Apache_2.0-blue.svg" alt="License">
<img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey" alt="Platform">
<img src="https://img.shields.io/badge/release-v1.0.0-brightgreen" alt="Release">
<img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg" alt="PRs Welcome">

</div>

> **厌倦了 Wispr Flow 的订阅费用？寻找开源免费的语音输入方案？来试试「蛐蛐」！**

**蛐蛐 (QuQu)** 是 **Wispr Flow 的开源免费替代方案**，专为中文用户打造的注重隐私的桌面端语音输入工具。完全开源免费，数据本地处理，专为中文优化，支持国产AI模型。

---

## 架构

```
┌──────────────────────────┐     HTTP REST     ┌─────────────────────┐
│   Electron 桌面应用       │ ◄─────────────── ► │   FunASR 容器        │
│   (前端，原生运行)         │   localhost:8000   │   (Python 后端)      │
│                          │                    │                     │
│   • 系统托盘 / 快捷键     │                    │   • 语音识别 (ASR)   │
│   • 录音 / 剪贴板        │                    │   • VAD / 标点恢复   │
│   • AI 文本优化          │                    │   • 模型本地运行     │
└──────────────────────────┘                    └─────────────────────┘
```

- **前端**：Electron + React，原生运行在桌面（需要托盘、快捷键、剪贴板权限）
- **后端**：Python FunASR 服务，运行在 Podman/Docker 容器中（所有 Python 依赖封装隔离，不污染系统环境）

---

## 快速开始

### 前置条件

- **Node.js 18+** 和 **pnpm**
- **Podman** 或 **Docker**（用于运行 FunASR 后端容器）
- **Linux**（当前主要支持平台；macOS/Windows 后续适配）

### 1. 安装 Podman

```bash
# Arch / CachyOS
sudo pacman -S podman

# Ubuntu / Debian
sudo apt install podman

# macOS
brew install podman && podman machine init && podman machine start
```

### 2. 克隆项目并启动后端

```bash
git clone https://github.com/lxp731/ququ.git
cd ququ

# 构建并启动 FunASR 容器
podman compose up -d

# 查看日志，等待模型加载完成（首次约 1-2 分钟）
podman logs -f ququ-backend
```

### 3. 运行前端

#### 开发模式

```bash
cd frontend
pnpm install
pnpm run dev
```

#### 生产模式（AppImage）

从 [Releases](https://github.com/lxp731/ququ/releases) 下载最新 AppImage，确保容器已启动后直接运行：

```bash
chmod +x QuQu-1.0.0.AppImage
./QuQu-1.0.0.AppImage
```

### 4. 配置 AI 模型（可选）

启动应用后，在**设置页面**中填入 AI 服务商的 **API Key**、**Base URL** 和**模型名称**。支持通义千问、Kimi、智谱AI 等国产模型。

---

## 开发

### 项目结构

```
ququ/
├── frontend/              # Electron + React 桌面应用
│   ├── src/
│   │   ├── helpers/       # Electron 主进程模块
│   │   ├── hooks/         # React hooks
│   │   └── components/    # UI 组件
│   ├── package.json
│   └── vite.config.js
├── backend/               # Python FunASR HTTP 服务（容器化）
│   ├── funasr_server.py   # Flask REST API
│   ├── Dockerfile
│   └── pyproject.toml     # uv 依赖管理
└── docker-compose.yml     # Podman 编排
```

### 常用命令

```bash
# 前端开发（frontend/ 目录下）
pnpm run dev               # 启动 Electron + Vite 开发模式
pnpm run build:renderer    # 构建前端
pnpm run build:linux       # 打包 Linux AppImage

# 后端容器（项目根目录）
podman compose build       # 构建容器镜像
podman compose up -d       # 启动容器
podman compose down        # 停止容器
podman logs -f ququ-backend # 查看日志
```

### 后端 API

| 端点 | 方法 | 说明 |
|------|------|------|
| `/health` | GET | 健康检查 |
| `/status` | GET | 模型状态 |
| `/transcribe` | POST | 上传音频（multipart/form-data），返回转录文本 |
| `/stats` | GET | 性能统计 |

---

## 构建与打包

### AppImage

```bash
cd frontend
pnpm install
pnpm run build:linux
# 产物：dist/蛐蛐-1.0.0.AppImage（~120MB，不含 Python）
```

### 容器镜像

```bash
podman compose build
# 镜像：ququ-backend:latest（~3GB，含 CPU-only PyTorch + FunASR）
```

---

## 技术栈

| 层 | 技术 |
|------|------|
| 桌面框架 | Electron 36 |
| 前端 | React 19, Vite 6, Tailwind CSS 4, shadcn/ui |
| 语音识别 | FunASR (Paraformer-large, FSMN-VAD, CT-Transformer) |
| AI 文本优化 | 兼容 OpenAI API（通义千问、Kimi、智谱等） |
| 后端框架 | Flask + gunicorn |
| 容器化 | Podman / Docker Compose |
| 数据库 | better-sqlite3 |
| 依赖管理 | pnpm (Node), uv (Python) |

---

## 参与贡献

- 🤔 **提建议**：[Issues](https://github.com/lxp731/ququ/issues)
- 🐛 **报 Bug**：[Issues](https://github.com/lxp731/ququ/issues)
- 💻 **贡献代码**：Fork → 创建分支 → 提交 PR

## 致谢

- [FunASR](https://github.com/modelscope/FunASR) — 阿里巴巴开源的工业级语音识别工具包
- [shadcn/ui](https://ui.shadcn.com/) — 高质量 React 组件库

## 许可证

[Apache License 2.0](LICENSE)
