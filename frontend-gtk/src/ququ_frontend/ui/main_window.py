"""主窗口 — 麦克风按钮 + 三区文字 + 状态 + 热键/模式控制。"""

from __future__ import annotations

import logging
from typing import Any

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
from gi.repository import Gdk, GLib, Gtk, Pango  # noqa: E402

from .. import paths
from ..controller import Controller
from . import theme

log = logging.getLogger("ququ.main")


def _white(alpha: str, text: str) -> str:
    """白色透明度 markup（与 Electron 主窗口三区一致）。"""
    return f'<span color="rgba(255,255,255,{alpha})">{GLib.markup_escape_text(text)}</span>'


class MainWindow(Gtk.ApplicationWindow):
    def __init__(self, app: Gtk.Application, controller: Controller):
        super().__init__(application=app)
        self.controller = controller
        self.set_name("main")
        self.set_title(paths.APP_TITLE)
        self.set_default_size(420, 580)
        self.set_resizable(True)
        self.set_skip_taskbar_hint(True)

        self._capturing_hotkey = False
        self._model_ready = False

        # 注册 UI 回调
        controller.on_preedit = self._on_preedit
        controller.on_final_text = self._on_final_text
        controller.on_state = self._on_state
        controller.on_notify = self._on_notify

        self._build_ui()

        # 键盘事件（热键捕获）
        self.connect("key-press-event", self._on_key_press)
        self.connect("delete-event", self._on_close)

        # 模型状态轮询（3s）
        GLib.timeout_add_seconds(3, self._poll_status)
        self._poll_status()

    # ── UI 构建 ──────────────────────────────────────

    def _build_ui(self) -> None:
        root = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
        root.set_margin_top(16)
        root.set_margin_bottom(16)
        root.set_margin_start(20)
        root.set_margin_end(20)
        root.set_halign(Gtk.Align.CENTER)

        # 标题栏
        header = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        title = Gtk.Label(label="蛐蛐")
        title.set_name("title")
        header.pack_start(title, True, True, 0)

        history_btn = Gtk.Button(label="历史")
        history_btn.set_relief(Gtk.ReliefStyle.NONE)
        history_btn.connect("clicked", self._on_open_history)
        header.pack_start(history_btn, False, False, 0)

        settings_btn = Gtk.Button(label="设置")
        settings_btn.set_relief(Gtk.ReliefStyle.NONE)
        settings_btn.connect("clicked", self._on_open_settings)
        header.pack_start(settings_btn, False, False, 0)
        root.pack_start(header, False, False, 0)

        # 麦克风区
        mic_area = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
        mic_area.set_halign(Gtk.Align.CENTER)

        self.mic_button = Gtk.Button(label="🎙")
        self.mic_button.set_name("mic-button")
        self.mic_button.set_relief(Gtk.ReliefStyle.NONE)
        self.mic_button.connect("clicked", self._on_mic_clicked)
        mic_area.pack_start(self.mic_button, False, False, 0)

        self.status_label = Gtk.Label(label="")
        self.status_label.set_name("status-label")
        self.status_label.set_justify(Gtk.Justification.CENTER)
        self.status_label.set_line_wrap(True)
        mic_area.pack_start(self.status_label, False, False, 0)
        root.pack_start(mic_area, False, False, 0)

        # 三区文字面板
        self.preedit_label = Gtk.Label(label="")
        self.preedit_label.set_name("preedit")
        self.preedit_label.set_line_wrap(True)
        self.preedit_label.set_line_wrap_mode(Gtk.WrapMode.CHAR)
        self.preedit_label.set_xalign(0.0)
        self.preedit_label.set_ellipsize(Pango.EllipsizeMode.NONE)
        panel = Gtk.Frame()
        panel.set_name("glass")
        panel.add(self.preedit_label)
        root.pack_start(panel, True, True, 0)

        # 热键 + 模式控制
        controls = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        controls.set_halign(Gtk.Align.CENTER)

        self.hotkey_button = Gtk.Button(label=paths.DEFAULT_HOTKEY)
        theme.add_class(self.hotkey_button, "small-button")
        self.hotkey_button.connect("clicked", self._on_capture_hotkey)
        controls.pack_start(self.hotkey_button, False, False, 0)

        self.mode_button = Gtk.Button(label="切换")
        theme.add_class(self.mode_button, "small-button")
        self.mode_button.connect("clicked", self._on_toggle_mode)
        controls.pack_start(self.mode_button, False, False, 0)
        root.pack_start(controls, False, False, 0)

        # 后端状态 banner
        self.banner = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
        self.banner.set_name("glass")
        self.banner_label = Gtk.Label(label="")
        self.banner_label.set_line_wrap(True)
        self.banner.pack_start(self.banner_label, False, False, 0)
        self.download_button = Gtk.Button(label="下载模型")
        self.download_button.connect("clicked", self._on_download_models)
        self.banner.pack_start(self.download_button, False, False, 0)
        root.pack_start(self.banner, False, False, 0)
        self.banner.set_visible(False)

        self.add(root)

    # ── 事件处理 ─────────────────────────────────────

    def _on_mic_clicked(self, _btn: Gtk.Button) -> None:
        if not self._model_ready:
            self.controller.notify("模型未就绪，请先启动后端")
            return
        self.controller.toggle_recording()

    def _on_open_history(self, _btn: Gtk.Button) -> None:
        app = self.get_application()
        if app is not None and hasattr(app, "open_history"):
            app.open_history()

    def _on_open_settings(self, _btn: Gtk.Button) -> None:
        app = self.get_application()
        if app is not None and hasattr(app, "open_settings"):
            app.open_settings()

    def _on_close(self, _w: Any, _e: Any) -> bool:
        self.hide()  # 隐藏到托盘，不退出
        return True

    def _on_capture_hotkey(self, _btn: Gtk.Button) -> None:
        self._capturing_hotkey = True
        self.hotkey_button.set_label("请按键...")
        self.grab_focus()

    def _on_toggle_mode(self, _btn: Gtk.Button) -> None:
        cur = self.controller.store.get("recording_mode", "toggle")
        nxt = "hold" if cur == "toggle" else "toggle"
        self.controller.store.set("recording_mode", nxt)
        self._refresh_mode_ui()
        app = self.get_application()
        if app is not None and hasattr(app, "restart_key_watcher"):
            app.restart_key_watcher()

    def _on_key_press(self, _w: Any, event: Gdk.EventKey) -> bool:  # noqa: F821
        if not self._capturing_hotkey:
            return False
        keyval = event.keyval
        name = Gdk.keyval_name(keyval)  # noqa: F821
        if name in ("Control_L", "Control_R", "Shift_L", "Shift_R",
                    "Alt_L", "Alt_R", "Super_L", "Super_R", "ISO_Level3_Shift"):
            return True  # 等待非修饰键
        parts: list[str] = []
        state = event.state
        if state & Gdk.ModifierType.CONTROL_MASK:  # noqa: F821
            parts.append("Ctrl")
        if state & Gdk.ModifierType.SHIFT_MASK:  # noqa: F821
            parts.append("Shift")
        if state & Gdk.ModifierType.MOD1_MASK:  # noqa: F821
            parts.append("Alt")
        if name == "space":
            name = "Space"
        elif name and len(name) == 1:
            name = name.upper()
        elif name is None:
            return True
        parts.append(name)
        hotkey = "+".join(parts)

        self.controller.store.set("global_hotkey", hotkey)
        self._capturing_hotkey = False
        self.hotkey_button.set_label(hotkey)
        app = self.get_application()
        if app is not None and hasattr(app, "restart_key_watcher"):
            app.restart_key_watcher()
        self.controller.notify(f"快捷键已设为 {hotkey}")
        return True

    # ── 状态轮询 ─────────────────────────────────────

    def _poll_status(self) -> bool:
        s = self.controller.backend.status()
        if "error" in s or not s.get("success", True):
            self._model_ready = False
            self._set_banner("后端服务未连接", show_download=False)
        elif s.get("models_initialized"):
            self._model_ready = True
            self._set_banner("", show_download=False)
            self.banner.set_visible(False)
        else:
            self._model_ready = False
            self._set_banner("模型加载中...", show_download=False)
        self._refresh_status_text()
        return True

    def _on_download_models(self, _btn: Gtk.Button) -> None:
        self._set_banner("正在下载模型...", show_download=False)
        GLib.timeout_add(100, self._do_download)

    def _do_download(self) -> bool:
        r = self.controller.backend.download_models()
        if r.get("success"):
            self.controller.notify("模型下载完成")
        else:
            self.controller.notify(f"模型下载失败: {r.get('error', '未知')}")
        self._poll_status()
        return False

    def _set_banner(self, text: str, show_download: bool) -> None:
        if not text:
            self.banner.set_visible(False)
            return
        self.banner_label.set_text(text)
        self.download_button.set_visible(show_download)
        self.banner.set_visible(True)

    # ── Controller 回调 ──────────────────────────────

    def _on_preedit(self, green: str, yellow: str, red: str) -> None:
        parts: list[str] = []
        if green:
            parts.append(_white("0.90", green))
        if yellow:
            parts.append(_white("0.60", yellow))
        if red:
            parts.append(_white("0.30", red))
        if parts:
            self.preedit_label.set_markup("".join(parts))
        else:
            self.preedit_label.set_text("")

    def _on_final_text(self, text: str) -> None:
        # 最终结果已由 controller 粘贴并保存；此处清空 preedit
        self.preedit_label.set_text("")

    def _on_state(self, is_recording: bool, is_processing: bool) -> None:
        ctx = self.mic_button.get_style_context()
        ctx.remove_class("recording")
        ctx.remove_class("processing")
        if is_recording:
            ctx.add_class("recording")
        elif is_processing:
            ctx.add_class("processing")
        self._refresh_status_text()

    def _refresh_mode_ui(self) -> None:
        mode = self.controller.store.get("recording_mode", "toggle")
        self.mode_button.set_label("长按" if mode == "toggle" else "切换")
        ctx = self.mode_button.get_style_context()
        if mode == "hold":
            ctx.add_class("active")
        else:
            ctx.remove_class("active")

    def _refresh_status_text(self) -> None:
        mode = self.controller.store.get("recording_mode", "toggle")
        hotkey = self.controller.store.get("global_hotkey", paths.DEFAULT_HOTKEY)
        if self.controller.is_recording:
            text = "正在录音，文字实时显示中"
        elif self.controller.is_processing:
            text = "正在识别语音..."
        elif not self._model_ready:
            text = "后端服务未连接或模型加载中"
        else:
            text = f"按 {hotkey} 或点击麦克风"
        self.status_label.set_text(text)
        self._refresh_mode_ui()

    def _on_notify(self, msg: str) -> None:
        # 简化 toast：状态栏短暂显示
        self.status_label.set_text(msg)
        GLib.timeout_add(2500, self._refresh_status_text)

    def show_and_refresh(self) -> None:
        self.show_all()
        self._poll_status()
