# 蛐蛐 GTK 前端 (frontend-gtk)

Electron 前端的轻量级替代 — Python + GTK3 (PyGObject)，对接同一个 FunASR 后端
（`backend/` 的 FastAPI 服务，容器或源码双启动均可用），协议完全一致。

## 为什么是 GTK

- 后端已是 Python，前端与后端同语言，`uv` 统一管理
- 无 Chromium/V8/webview，体积与内存大幅下降
- Electron 的 IPC 层（preload + ipcHandlers）在单进程 GTK 应用中直接归零

## 目录结构

```
frontend-gtk/
├── pyproject.toml           # uv 依赖 (仅 websocket-client 一个 pip 依赖)
├── .python-version          # 固定系统 Python 3.14（PyGObject 所在）
└── src/ququ_frontend/
    ├── __main__.py          # 入口 (python -m ququ_frontend)
    ├── app.py               # Gtk.Application 单实例 + 托盘 + 全局热键编排
    ├── paths.py             # 常量与数据目录 (~/.config/ququ)
    ├── settings.py          # SQLite 持久化（与 Electron 版 schema 兼容）
    ├── backend.py           # REST + WebSocket 客户端（心跳/重连）
    ├── audio.py             # arecord 子进程采集 PCM (16kHz/16bit/mono)
    ├── clipboard.py         # 剪贴板 + ydotool/xdotool 自动粘贴
    ├── keys.py              # evdev 全局键盘监听（长按/切换模式）
    ├── export.py            # 历史导出 txt/json/docx/pdf
    ├── controller.py        # 录音状态机 + 后端回调 + 粘贴编排
    └── ui/
        ├── theme.py         # GTK CSS 暗色主题
        ├── main_window.py   # 主窗口
        ├── floating.py      # 浮动三区预览窗
        ├── settings_window.py
        └── history_window.py
```

## 系统依赖

需提前安装（PyGObject 是系统包，无法用 pip 安装）：

```bash
# Arch (本项目作者环境)
sudo pacman -S python-gobject gtk3 gst-python libappindicator-gtk3

# Debian/Ubuntu
sudo apt install python3-gi gir1.2-gtk-3.0 python3-gi-cairo \
                 gir1.2-appindicator3-0.1 gstreamer1.0-tools

# 粘贴工具（三选一，ydotool 推荐 Wayland）
sudo pacman -S ydotool xdotool   # 或 wtype
```

## 安装 & 运行

```bash
cd frontend-gtk

# 使用系统 Python 3.14 + 继承系统 site-packages（访问 gi）
uv venv --system-site-packages --python /usr/bin/python3.14
uv sync

# 运行
uv run python -m ququ_frontend
# 或
uv run ququ-gtk
```

> 注意：必须用 `--system-site-packages`，否则 venv 里访问不到系统安装的 PyGObject。

### 全局热键 / 长按模式权限

evdev 需要读取 `/dev/input/event*`，通常需将用户加入 `input` 组：

```bash
sudo usermod -aG input $USER   # 重新登录后生效
```

无权限时应用仍可运行（点麦克风按钮录音），仅全局热键失效。

## 功能状态

| 功能 | 状态 |
|------|------|
| 主窗口（麦克风 + 三区文字 + 状态） | ✅ |
| 流式录音（arecord → PCM → WS） | ✅ |
| 持久 WS 连接（心跳 + 退避重连） | ✅ |
| 浮动三区预览窗（无边框/置顶/拖拽/位置记忆） | ✅ |
| 自动粘贴（ydotool/xdotool 降级链） | ✅ |
| 全局热键（切换 + 长按，evdev） | ✅ |
| 设置窗口（后端/AI/热词/模式） | ✅ |
| 历史窗口（列表/搜索/删除/清空/导出） | ✅ |
| SQLite 持久化（与 Electron 版共享 db） | ✅ |
| 后端管理（健康检查/模型下载） | ✅ |
| AI 校对（config 同步到后端） | ✅（后端处理） |
| 托盘 | ✅（AppIndicator3，回退 StatusIcon） |

## 已知限制

1. **毛玻璃 blur**：GTK 无 `backdrop-filter`，玻璃面板退化为半透明纯色。
2. **渐变文字标题**：GTK 不支持 `background-clip:text`，标题降级为纯色 indigo。
3. **动画**：无 framer-motion 弹簧动画，仅 CSS transition。
4. **浮动窗点击穿透**：X11 用 input_shape 实现；Wayland 降级为整窗可拖
   （后续可用 `gtk-layer-shell` 优化）。
5. **api_key 加密**：Electron 用 safeStorage，GTK 版暂以明文存 SQLite
   （后续可用 secretstorage）。
6. **跨平台**：当前仅支持 Linux（符合需求范围）。

## 与后端对接

前端通过以下协议与 `backend/server.py` 通信（与 Electron 版完全一致）：

- REST：`/health` `/status` `/models/download`
- WS：`/stream/ws`（`start_listening`/`stop_listening`/`config`/`ping` + 二进制 PCM）

数据目录 `~/.config/ququ/transcriptions.db` 与 Electron 版共用，可交替使用。
