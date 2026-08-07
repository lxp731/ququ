# AGENTS.md

本文档记录项目架构和技术栈速查。完整的行为规约见项目根目录 `./CLAUDE.md` 文件。

## 项目架构

```
ququ/
├── frontend/              # Electron + React 桌面应用
│   ├── main.js            # Electron 主进程入口
│   ├── preload.js         # IPC 桥接 (contextBridge)
│   ├── src/
│   │   ├── App.jsx         # 主页面（录音、三区文字、状态管理）
│   │   ├── settings.jsx    # 设置页面（后端地址、AI 配置、热词文件）
│   │   ├── history.jsx     # 转录历史
│   │   ├── helpers/        # Electron 主进程模块
│   │   │   ├── ipcHandlers.js   # 所有 ipcMain.handle 注册
│   │   │   ├── funasrManager.js # 后端连接生命周期
│   │   │   ├── clipboard.js     # 跨平台粘贴 (ydotool/wtype/osascript)
│   │   │   ├── keyWatcher.js    # 长按全局按键监听 (evdev)
│   │   │   ├── hotkeyManager.js # 快捷键注册
│   │   │   ├── database.js      # better-sqlite3 存取
│   │   │   └── ...
│   │   ├── hooks/          # React hooks
│   │   │   ├── useStreamingRecording.js # 流式录音 (WS + mic)
│   │   │   ├── streamingSession.js     # WebSocket 客户端 (心跳/重连)
│   │   │   ├── useModelStatus.js       # 后端/模型状态机
│   │   │   ├── useHotkey.js            # 快捷键
│   │   │   └── usePermissions.js       # 麦克风/辅助功能权限
│   │   └── index.css       # Tailwind 4 + 自定义主题
│   └── assets/             # 图标等资源
├── backend/               # Python FastAPI 服务
│   ├── server.py          # FastAPI 入口 (REST + WebSocket)
│   ├── asr_engine.py      # ASR 引擎 (流式 + 离线 + VAD + 标点)
│   ├── pipeline.py        # 三区 Pipeline (CandidateBuffer + PTTPipeline)
│   ├── llm_optimizer.py   # LLM 校对 (OpenAI 兼容流式 API)
│   ├── download_models.py # 模型预下载脚本
│   ├── entrypoint.sh      # 容器入口（下载 → 启动）
│   ├── test_phase1.py     # 集成测试
│   ├── Dockerfile
│   └── pyproject.toml     # uv 依赖管理
├── nginx.conf             # 反向代理 (WS + HTTP 分流)
└── docker-compose.yml     # Podman/Docker 编排
```

## 技术栈

| 层 | 技术 |
|------|------|
| 桌面框架 | Electron 36 |
| 前端 | React 19, Vite 6, Tailwind CSS 4 |
| UI | Radix UI, Framer Motion, Lucide, sonner |
| 语音识别 | FunASR (paraformer-zh-streaming + SenseVoiceSmall + paraformer-large + VAD + CT-Transformer) |
| AI 校对 | 兼容 OpenAI API 的 LLM（DeepSeek, Qwen, GPT 等），流式 chat/completions |
| 后端框架 | FastAPI + uvicorn (REST + WebSocket 单进程) |
| 数据库 | better-sqlite3（key-value 模式，JSON 序列化存取）|
| Lint | Ruff + basedpyright (Python), ESLint (JS/JSX) |
| 测试 | pytest-asyncio + websockets (Python), vitest (JS) |
| 包管理 | pnpm (Node), uv (Python) |
| 容器化 | Podman / Docker Compose |

## 架构设计

### 语音识别流程

```
麦克风 → getUserMedia → ScriptProcessor → Int16 PCM → WebSocket
  → server.py → ASREngine (流式 paraformer-zh-streaming)
  → PTTPipeline (三区管道)
  → 流式模型中间结果 → 离线 SenseVoiceSmall 周期纠正
  → LLM 绿区校对 → 浮动窗逐句上屏 → 自动粘贴
```

浮动预览窗是独立的 frameless BrowserWindow（`floating.html`），
录音时从屏幕底部滑入，停止后自动淡出。鼠标穿透文字区域，
拖拽手柄可调整位置。

### 三区管道 (来自 YuHuang)

- **红区** (0~10 字): 流式草稿，随时被改写
- **黄区** (10~30 字): 离线修正射程内，等待确认
- **绿区** (30+ 字): 已稳定，送 LLM 校对后逐句提交

### WebSocket 协议

| 方向 | 消息 | 说明 |
|------|------|------|
| Client → Server | `start_listening` | PTT 开始 |
| Client → Server | `stop_listening` | PTT 结束 |
| Client → Server | `config` | LLM + 热词配置 |
| Client → Server | `ping` | 心跳 |
| Client → Server | binary | PCM 音频块 (int16, 16kHz, mono) |
| Server → Client | `preedit` | 三区文字 `{green, yellow, red}` |
| Server → Client | `commit` | 已提交文字 |
| Server → Client | `final` | 最终转写结果 |
| Server → Client | `hotwords_updated` | 热词文件重载通知 |

### API 端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/health` | GET | 健康检查 |
| `/status` | GET | 模型状态 (兼容旧 API) |
| `/transcribe` | POST | 离线批量转写 (旧版兼容) |
| `/stream/ws` | WS | 流式识别 + PTT 控制 |

## 关键设计决策

- **前后端分离**：Electron 桌面端 ↔ FastAPI 后端。后端绑定 `0.0.0.0:8000`，前端通过 WebSocket 直连
- **持久 WS 连接**：前端启动时建立，不随录音启停。支持心跳 (15s)、自动重连 (指数退避, 最多 5 次)
- **后端单进程**：FastAPI + uvicorn，REST + WebSocket 同端口，替代旧 Flask + gunicorn 双进程架构
- **双启动模式**：源码 `cd backend && uv run python server.py` / 容器 `podman compose up -d`
- **模型懒加载**：lifespan 后台预加载，首次 WebSocket 连接时已就绪
- **GPU 自动检测**：cuda → mps → cpu 逐级 fallback，`FUNASR_DEVICE` 环境变量覆盖
- **热词文件监控**：os.stat 轮询 mtime (2s)，变化自动重载并广播通知前端
- **长按录音**：Linux evdev / Windows GetAsyncKeyState / macOS 回退切换模式
- **浮动三区预览窗**：录音时显示在屏幕底部居中（frameless, alwaysOnTop, 鼠标穿透），显示绿/黄/红三区文字，停止后立即消失。拖拽后记住位置，下次录音时复用
- **设置持久化**：SQLite 存于用户数据目录，key-value 模式
