# AGENTS.md

## 常用命令

```bash
pnpm install               # 安装依赖
pnpm run dev               # 启动 Electron + Vite 开发模式
pnpm run build:renderer    # 构建前端（Vite production build）
pnpm run build:linux       # 打包 Linux AppImage
```

## 规约

1. **统一 UI 风格**。暗色玻璃拟态（Dark Glassmorphism）— 深色背景 `#0f172a`/slate-900、半透明毛玻璃面板、动态点阵背景、Framer Motion 动画过渡。修改 UI 必须保持风格一致。

2. **修改后必须构建验证**。`pnpm run build:renderer` 能检测 import 路径错误、JSX 语法错误、依赖缺失。注意：它**不能**检测 Electron 主进程逻辑错误、IPC 通信问题、运行时状态 bug。

## 进程架构

```
┌─ 主进程 (Node.js) ─────────────────────┐
│  main.js                                │
│  src/helpers/                           │
│    ├── ipcHandlers.js   IPC 处理中心    │
│    ├── funasrManager.js FunASR 连接管理 │
│    ├── windowManager.js 多窗口管理      │
│    ├── tray.js          系统托盘        │
│    ├── hotkeyManager.js 全局快捷键      │
│    ├── clipboard.js     剪贴板操作      │
│    ├── keyWatcher.js    按键监听        │
│    ├── database.js      better-sqlite3  │
│    ├── logManager.js    日志管理        │
│    └── environment.js   环境检测        │
├─────────────────────────────────────────┤
│  preload.js  ← contextBridge 暴露 API   │
├─────────────────────────────────────────┤
│  ┌─ 渲染进程 (React) ─────────────────┐ │
│  │  src/App.jsx         主页面        │ │
│  │  src/settings.jsx    设置页面      │ │
│  │  src/history.jsx     历史页面      │ │
│  │  src/hooks/                        │ │
│  │    ├── useModelStatus.js 模型状态  │ │
│  │    ├── useRecording.js   录音管理  │ │
│  │    ├── useHotkey.js      快捷键    │ │
│  │    ├── useTextProcessing.js AI优化 │ │
│  │    └── usePermissions.js 权限检测  │ │
│  └────────────────────────────────────┘ │
└─────────────────────────────────────────┘
```

> **关键规则**：`src/helpers/` 是主进程代码，可用所有 Node.js/Electron API；`src/hooks/` 和页面文件是渲染进程代码，**不能**直接调用 Node.js API，必须通过 `window.electronAPI.*`。

## IPC 通道

| 通道 | 方向 | 说明 |
|------|------|------|
| `save-setting` | renderer→main | 保存设置（key: `funasr_base_url` 时触发 `funasr.connect()`）|
| `get-setting` | renderer→main | 读取单个设置 |
| `get-all-settings` | renderer→main | 读取全部设置 |
| `check-funasr-status` | renderer→main | 获取后端连接状态（含 `connecting` 标志）|
| `start-local-backend` | renderer→main | 启动本地 FunASR 后端（compose → source fallback）|
| `open-settings-window` | renderer→main | 打开设置窗口 |
| `open-history-window` | renderer→main | 打开历史窗口 |
| `paste-text` | renderer→main | 粘贴文本到光标位置 |
| `copy-to-clipboard` | renderer→main | 复制文本到剪贴板 |

## 核心 Hook

### useModelStatus — 模型/后端状态机

```
checking → need_backend → connecting → need_download → downloading → loading → ready
                                    ↘ error / no_api
```

- `checkStatus()` 先检查 `server_ready` 和 `connecting`，再检查模型状态
- `startLocalBackend()` 先尝试 compose，失败则 fallback 到源码启动
- 状态通过 `modelStatus.stage` 暴露给 UI

### useRecording — 录音管理

- MediaRecorder API，WAV 格式，16kHz 单声道
- 状态：`idle` → `recording` → `processing` → `idle`
- 录音前通过 `modelStatus.stage` 守卫，后端不可用时阻止录音

### useHotkey — 全局快捷键

- 注册/注销 Electron 全局快捷键，支持按压和释放触发

## 数据库 (better-sqlite3)

- 数据库文件位于系统用户数据目录（`app.getPath('userData')`）
- Key-value 模式：`db.setSetting(key, value)` / `db.getSetting(key)`
- 存：`JSON.stringify(value)`，取：`JSON.parse(result)`
- 关键 key：`funasr_base_url`、`ai_api_key`、`ai_base_url`、`ai_model`、`enable_ai_optimization`

## FunASR 连接生命周期

```
app 启动
  └─ 读取 funasr_base_url 设置 → setBaseUrl()
  └─ initializeAtStartup() → tryConnect()    非阻塞，失败不阻止启动
       ├─ _checkContainerHealth()   ping /health
       └─ _waitForModelReady()      轮询 /status 直到模型就绪

用户保存新后端地址
  └─ save-setting(funasr_base_url, url)
       └─ funasr.connect(url)   设置新地址 → 断开旧连接 → 重新连接

用户点击"启动本地"
  └─ startLocalBackend()
       ├─ compose up → 等待就绪
       └─ compose 失败 → uv run python funasr_server.py → 等待就绪
```

## UI 组件风格参考

- **面板**: `bg-slate-900/80 backdrop-blur-xl border border-white/10 rounded-2xl`
- **按钮**: `hover:bg-white/10`，Framer Motion 缩放动效 (`whileTap={{ scale: 0.95 }}`)
- **文字**: `text-white` 主文本，`text-slate-400` 次要文本
- **状态指示**: `bg-green-500` 就绪，`bg-yellow-500` 处理中，`bg-red-500` 错误
- **Toast**: 使用 `sonner` 库 `toast.success()` / `toast.error()`，不在组件内额外渲染结果
