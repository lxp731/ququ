<div align="center">

# 蛐蛐 (QuQu)

**开源免费的 Wispr Flow 替代方案 | 为中文而生的下一代智能语音工作流**

<img src="https://img.shields.io/badge/license-Apache_2.0-blue.svg" alt="License">
<img src="https://img.shields.io/badge/platform-Windows%20%7C%20Linux%20%7C%20macOS-lightgrey" alt="Platform">
<img src="https://img.shields.io/badge/release-v1.2.0-brightgreen" alt="Release">
<img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg" alt="PRs Welcome">

</div>

> **厌倦了 Wispr Flow 的订阅费用？寻找开源免费的语音输入方案？来试试「蛐蛐」！**

**蛐蛐 (QuQu)** 是 **Wispr Flow 的开源免费替代方案**，专为中文用户打造的注重隐私的桌面端语音输入工具。完全开源免费，数据本地处理，专为中文优化，支持国产AI模型。

---

## 效果演示

![效果演示](assets/ququ.gif)

---

## 架构

```
┌──────────────────────────┐   WebSocket + REST  ┌─────────────────────┐
│   Electron 桌面应用       │ ◄─────────────────► │  FastAPI 后端        │
│   (前端，原生运行)         │    localhost:8000   │  (Python, 单进程)    │
│                          │                     │                     │
│   • 系统托盘 / 快捷键     │                     │  • 流式实时识别       │
│   • 录音 / 浮动三区文字    │                     │  • 离线 SenseVoice 纠正│
│   • AI 校对              │                     │  • LLM 上下文校对     │
│   • 热词文件监控           │                     │  • 热词自动重载       │
│   • 桌面浮动预览窗 (屏幕底部)│                    │                     │
└──────────────────────────┘                     └─────────────────────┘
```

- **前端**：Electron + React，原生桌面运行（托盘、快捷键、剪贴板）
- **后端**：FastAPI + uvicorn，单进程承载 REST + WebSocket


## 快速开始

### 方式一：测试/开发环境（源码运行）

#### 1. 启动后端

```bash
cd backend
uv sync
uv run python server.py --port 8000
```

访问 `http://127.0.0.1:8000/health` → `{"status":"ok"}` 即就绪。首次启动自动下载模型 (~2GB)。

#### 2. 启动前端

```bash
cd frontend
pnpm install
pnpm dev
```

#### 3. 配置 AI 校对（可选）

设置页填入 API Key / Base URL / Model，支持 DeepSeek / Qwen / OpenAI 一键预设。

---

### 方式二：容器部署

```bash
git clone https://github.com/lxp731/ququ.git && cd ququ
podman compose up -d --build
```

模型缓存于 `~/.cache/modelscope`，重建容器无需重新下载。

前端从 [Releases](https://github.com/lxp731/ququ/releases) 下载：Linux 用 AppImage/deb/rpm，macOS 用 dmg/zip，Windows 用 exe 便携版。

---

## 功能

| 功能 | 说明 |
|------|------|
| 🎙️ 流式识别 | 边说边出字，三区管道（红/黄/绿）桌面浮动预览窗实时显示 |
| 🔧 离线纠正 | SenseVoiceSmall 周期全量重识别，中英混合 + ITN + 标点 |
| 🤖 AI 校对 | 绿区文字送 LLM 润色，上下文感知，逐句上屏 |
| 📝 热词 | txt 文件一行一词，文件变化自动重载，广播通知前端 |
| 🎹 快捷键 | Ctrl+Space 切换录音，长按模式（Linux evdev / macOS 回退切换） |
| 🌐 跨平台 | Linux (AppImage/deb/rpm) / macOS (dmg/zip) / Windows (portable exe) |

---

## 开发

### 项目结构

```
ququ/
├── frontend/                  # Electron + React
│   ├── src/App.jsx            # 主页面
│   ├── src/settings.jsx       # 设置页
│   ├── floating.html          # 桌面浮动三区预览窗 (独立 BrowserWindow)
│   ├── src/hooks/             # React hooks
│   │   ├── useStreamingRecording.js  # 流式录音 (持久 WS)
│   │   ├── streamingSession.js       # WS 客户端 (心跳/重连)
│   │   └── useModelStatus.js         # 模型状态机
│   └── src/helpers/           # 主进程模块 (IPC, 剪贴板, 按键监听)
├── backend/                   # Python FastAPI
│   ├── server.py              # 入口 (REST + WebSocket)
│   ├── asr_engine.py          # ASR 引擎 (5 模型)
│   ├── pipeline.py            # 三区管道 (CandidateBuffer + PTTPipeline)
│   ├── llm_optimizer.py       # LLM 校对 (流式 OpenAI API)
│   └── download_models.py     # 模型预下载
├── nginx.conf
└── docker-compose.yml
```

### 常用命令

```bash
# 前端
cd frontend
pnpm dev                    # 开发模式
pnpm lint                   # ESLint 检查
pnpm test                   # vitest
pnpm build:linux            # 打包 AppImage + deb + rpm
pnpm build:mac              # 打包 dmg + zip
pnpm build:win              # 打包 portable exe

# 后端
cd backend
uv run python server.py     # 源码启动
uv run python test_phase1.py # 集成测试
uv run --with ruff ruff check *.py  # lint
uv run --with basedpyright basedpyright *.py  # type check

# 容器
podman compose up -d --build
podman compose logs -f backend
podman compose down
```

### API

| 端点 | 方法 | 说明 |
|------|------|------|
| `/health` | GET | 健康检查 |
| `/status` | GET | 模型状态 `{success, models_initialized, is_initializing}` |
| `/transcribe` | POST | 离线批量转写 (旧版兼容) |
| `/stream/ws` | WS | 流式识别 + PTT 控制 |

### WebSocket 协议

| 方向 | 消息 | 说明 |
|------|------|------|
| Client → Server | `start_listening` / `stop_listening` | PTT |
| Client → Server | `config {llm, hotwords}` | 配置同步 |
| Client → Server | `ping` | 心跳 (15s) |
| Client → Server | binary | PCM int16 16kHz mono |
| Server → Client | `preedit {green, yellow, red}` | 三区文字 |
| Server → Client | `commit {text}` | 已提交 |
| Server → Client | `hotwords_updated {count}` | 热词重载通知 |

---

## 致谢

- [FunASR](https://github.com/modelscope/FunASR) — 阿里巴巴工业级语音识别工具包
- [YuHuang](https://github.com/Homio/YuHuang) — 语皇语音输入法（三区管道 + LLM 校对设计参考）
- [ModelScope](https://modelscope.cn) — 模型托管平台

## 许可证

[Apache License 2.0](LICENSE)
