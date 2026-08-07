# AGENTS.md — 前端开发指南

## 常用命令

```bash
pnpm install               # 安装依赖
pnpm dev                   # 开发模式 (Vite + Electron)
pnpm build:renderer        # 构建 Vite
pnpm build:linux           # 打包 AppImage + deb + rpm
pnpm build:mac             # 打包 dmg + zip
pnpm build:win             # 打包 portable exe
pnpm lint                  # ESLint
pnpm test                  # vitest
```

## 规制

1. **统一 UI 风格**。暗色玻璃拟态（Dark Glassmorphism）。
2. **修改后必须构建验证**。`pnpm build:renderer`。
3. **渲染进程禁止 Node API**。只通过 `window.electronAPI` 访问主进程能力。

## 进程架构

```
┌─ 主进程 (Node.js) ─────────────────────┐
│  main.js                                │
│  src/helpers/                           │
│    ├── ipcHandlers.js   IPC 处理        │
│    ├── funasrManager.js 后端连接管理    │
│    ├── windowManager.js 多窗口 (含浮动预览窗) │
│    ├── tray.js          系统托盘        │
│    ├── hotkeyManager.js 全局快捷键      │
│    ├── clipboard.js     跨平台粘贴      │
│    ├── keyWatcher.js    长按监听        │
│    ├── database.js      SQLite 存取     │
│    └── nativeAudio.js   原生音频        │
└─────────────────────────────────────────┘
         │  IPC (preload.js)
┌─ 渲染进程 (React) ──────────────────────┐
│  floating.html             浮动三区预览窗 │
│  src/App.jsx            主页面          │
│  src/settings.jsx       设置页          │
│  src/history.jsx        转录历史        │
│  src/hooks/                             │
│    ├── useStreamingRecording.js  流式录音│
│    ├── streamingSession.js      WS 客户端│
│    ├── useModelStatus.js        模型状态 │
│    ├── useHotkey.js             快捷键   │
│    └── usePermissions.js        权限     │
└─────────────────────────────────────────┘
```

## 关键设计

- **持久 WS 连接**：组件 mount 时建立，unmount 断开。心跳 15s，自动重连指数退避最多 5 次
- **流式录音**：TT start → getUserMedia → WebSocket PCM → 后端 Pipeline → preedit 三区渲染（浮动窗 + 主窗口内嵌）→ 后端 commit → 自动粘贴
- **LLM 配置**：WS 连接后自动从 SQLite 读取发送 config，设置页修改后立即同步
- **热词通知**：后端文件变化 → broadcast → 主窗口 toast + SQLite + IPC → 设置页实时刷新

## WS 协议 (详见 streamingSession.js)

| 方向 | 消息 | 说明 |
|------|------|------|
| Client → Server | `start_listening` / `stop_listening` | PTT |
| Client → Server | `config` | LLM + 热词配置 |
| Client → Server | binary | PCM int16 16kHz |
| Server → Client | `preedit` | `{green, yellow, red}` |
| Server → Client | `commit` | 提交文本 |
| Server → Client | `hotwords_updated` | 热词重载 `{count}` |
