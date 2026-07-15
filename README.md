<div align="center">

# 蛐蛐 (QuQu)

**开源免费的 Wispr Flow 替代方案 | 为中文而生的下一代智能语音工作流**

<img src="https://img.shields.io/badge/license-Apache_2.0-blue.svg" alt="License">
<img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey" alt="Platform">
<img src="https://img.shields.io/badge/release-v1.1.2-brightgreen" alt="Release">
<img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg" alt="PRs Welcome">

</div>

> **厌倦了 Wispr Flow 的订阅费用？寻找开源免费的语音输入方案？来试试「蛐蛐」！**

**蛐蛐 (QuQu)** 是 **Wispr Flow 的开源免费替代方案**，专为中文用户打造的注重隐私的桌面端语音输入工具。完全开源免费，数据本地处理，专为中文优化，支持国产AI模型。

---

## 效果演示

<video src="https://img.liuxp.eu.org/file/BAACAgUAAyEGAATfDMmJAAMGaleowTaZkiOoHeoPGXefTY19DgcAAkUfAAKMysFWWEtIEdCSASw9BA.mp4" controls width="100%"></video>

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

### 方式一：测试/开发环境（源码运行）

适合开发调试、快速体验。前后端均从源码启动，模型首次自动下载。

#### 前置条件

- **Python 3.11+** 和 **uv**（Python 依赖管理）
- **Node.js 18+** 和 **pnpm**（前端依赖管理）
- **Linux / macOS / Windows**（均支持开发与打包运行）

#### 1. 克隆项目

```bash
git clone https://github.com/lxp731/ququ.git
cd ququ
```

#### 2. 启动后端（源码）

```bash
cd backend

# 安装 Python 依赖（首次）
uv sync

# 启动 FunASR 服务（首次运行自动下载模型 ~1.2GB，需 1-2 分钟）
uv run python funasr_server.py --port 8000
```

后端启动后访问 `http://127.0.0.1:8000/health` 验证，返回 `{"status":"ok"}` 即就绪。

#### 3. 启动前端（开发模式）

```bash
cd frontend
pnpm install
pnpm run dev
```

#### 4. 配置 AI 模型（可选）

启动应用后，在**设置页面**中填入 AI 服务商的 **API Key**、**Base URL** 和**模型名称**。支持通义千问、Kimi、智谱AI 等国产模型。

---

### 方式二：生产环境（容器 + 桌面安装包）

适合日常稳定使用。后端容器化运行，前端使用打包好的安装包。

#### 前置条件

- **Podman** 或 **Docker**（运行后端容器）

#### 1. 安装 Podman

```bash
# Arch / CachyOS
sudo pacman -S podman

# Ubuntu / Debian
sudo apt install podman

# macOS
brew install podman && podman machine init && podman machine start
```

#### 2. 启动后端容器

```bash
git clone https://github.com/lxp731/ququ.git
cd ququ

# 构建镜像并启动容器
podman compose up -d --build

# 查看日志，等待模型加载完成（首次约 1-2 分钟，需下载 ~1.2GB 模型）
podman logs -f ququ-backend
```

> 模型文件缓存于 `~/.cache/modelscope`，销毁重建容器无需重新下载。

#### 3. 安装前端

**Windows：**

从 [Releases](https://github.com/lxp731/ququ/releases) 下载最新 `ququ-v*-portable.exe`，免安装，双击即用。

**macOS：**

从 [Releases](https://github.com/lxp731/ququ/releases) 下载最新 `.dmg` 文件，拖入 Applications 文件夹。

**Arch 系 Linux：**

```bash
yay -S ququ-bin
```

**其他 Linux 发行版：**

从 [Releases](https://github.com/lxp731/ququ/releases) 下载最新 `.AppImage` 文件：

```bash
chmod +x ququ-v*.AppImage
./ququ-v*.AppImage
```

#### 4. 配置 AI 模型（可选）

启动应用后，在**设置页面**中填入 AI 服务商的 **API Key**、**Base URL** 和**模型名称**。支持通义千问、Kimi、智谱AI 等国产模型。

> **提示**：
>1. 如果后端部署在其他主机，可在设置页面中修改 FunASR 后端地址，指向远程服务。
>2. 后端默认允许来自所有 IP 的访问，即 0.0.0.0:8000，安全生产环境自行限制。

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
pnpm run build             # 打包当前平台安装包（Windows: portable exe / Linux: AppImage / macOS: dmg）

# 单独打包指定平台（跨平台构建）
pnpm run build:linux       # 打包 Linux AppImage
pnpm run build:mac         # 打包 macOS dmg
# Windows 便携版需在 Windows 上直接运行 pnpm run build

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
