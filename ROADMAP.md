# ROADMAP

## 跨平台支持 (Windows / macOS)

> **状态：计划中** — 当前仅 Linux (AppImage) 可用。以下方案待实施和测试验证。

### 当前阻碍

| 文件 | 问题 | 严重度 |
|------|------|--------|
| `frontend/src/helpers/keyWatcher.js` | 整个文件 — Python 读 `/dev/input/event*` (Linux evdev) | 🔴 阻塞 |
| `frontend/src/helpers/clipboard.js` | `_pasteLinux()` 用 ydotool/wtype/xdotool | 🟡 已有 Windows/macOS 框架 |
| `frontend/src/helpers/logManager.js` | 日志路径硬编码 `~/.config/ququ/logs` | 🟢 小问题 |
| `frontend/main.js` | `ensureYdotoolDaemon()` Linux 套接字路径 | 🟢 已有 `process.platform` 守卫 |

### 核心方案：uiohook-napi

用 [uiohook-napi](https://github.com/kwhat/libuiohook)（底层 C 库 `libuiohook`）统一三平台的全局键盘钩子，一套代码替代 Linux evdev/Python 方案。

**改造对照：**

```
当前 (Linux only)               →  新方案 (跨平台)
─────────────────────────────────────────────────────
keyWatcher.js                   →  inputHook.js
  └─ Python 读 /dev/input           └─ uiohook.on('keydown/keyup')
  └─ _findKeyboard() 扫描设备       └─ 自动检测，无需配置
  └─ 仅监听 Ctrl/Space/Meta/Alt     └─ 同样过滤
clipboard.js                    →  clipboard.js (微调)
  └─ _pasteLinux()  保留            └─ 保持不变
  └─ _pasteWindows() 已存在         └─ 测试验证
  └─ _pasteMacOS()   已存在         └─ 测试验证
logManager.js                   →  logManager.js
  └─ ~/.config/ququ/logs            └─ app.getPath('userData')/logs
```

### 实施步骤

#### 步骤 1：安装依赖

```bash
cd frontend && pnpm add uiohook-napi
```

#### 步骤 2：新建 `frontend/src/helpers/inputHook.js`

封装 `uiohook-napi`，提供与当前 KeyWatcher 相同的接口：
- `start(onKeyEvent)` — 启动全局键盘监听
- `stop()` — 停止监听
- 回调格式：`{type: 'down'|'up', key: 'Control'|'Space'|'Meta'|'Alt'}`

预计 ~80 行。

#### 步骤 3：修改 `frontend/src/helpers/ipcHandlers.js`

- `start-hold-watch` / `stop-hold-watch` 改用 `inputHook` 替代 `keyWatcher`

#### 步骤 4：修改 `frontend/main.js`

- 移除 `require('./src/helpers/keyWatcher')` 引用
- `ensureYdotoolDaemon()` 已有平台守卫，无需改动

#### 步骤 5：修复 `frontend/src/helpers/logManager.js`

```js
// 改前
this.logDir = path.join(os.homedir(), '.config', 'ququ', 'logs');
// 改后
const { app } = require('electron');
this.logDir = path.join(app.getPath('userData'), 'logs');
```

#### 步骤 6：完善 Windows 构建配置

`package.json` 的 `build.win` 增加 NSIS 安装器：

```json
"win": {
  "icon": "assets/icon.ico",
  "target": [
    { "target": "nsis", "arch": ["x64"] }
  ]
},
"nsis": {
  "oneClick": false,
  "allowToChangeInstallationDirectory": true
}
```

#### 步骤 7：CI 自动构建

在 `.github/workflows/build.yml` 中添加 Windows runner，自动构建 NSIS `.exe` 安装包并上传到 Release。

### 风险与缓解

| 风险 | 缓解 |
|------|------|
| uiohook-napi 需编译 C 代码 (node-gyp) | CI 预装 `windows-build-tools`；npm 提供预编译二进制 |
| Linux 下 uiohook 需 `/dev/uinput` 权限 | 文档添加 udev 规则说明；可保留 evdev 作为 Linux 回退 |
| Windows NSIS 打包体积大 (~150MB) | 排除 `electron/`、`.cache/` 等不必要文件 |
| Windows Defender 可能误报 | 提交 Microsoft 软件认证（长期） |
| macOS 需辅助功能权限 | 已有 `checkAccessibilityPermissions()` 框架 |

### 不做的事情

- ❌ 不在 Windows 上强制 Podman — Windows 用户可用 Docker Desktop 运行后端容器
- ❌ 不做自动更新（Squirrel.Windows）— 首版手动下载即可
- ❌ 不重构 Linux 粘贴工具检测 — 当前方案工作正常

### 待解决

- [ ] 在 Windows 10/11 虚拟机中测试 uiohook-napi 全局键盘钩子
- [ ] 在 macOS 上测试辅助功能权限流程
- [ ] 验证 Windows NSIS 打包产物可正常安装运行
- [ ] 验证三平台 hold-to-talk 模式行为一致
- [ ] 更新 README.md 平台标识和安装说明
