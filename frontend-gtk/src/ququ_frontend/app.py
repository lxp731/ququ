"""Gtk.Application 单实例 + 生命周期 + 托盘 + 全局热键编排。"""

from __future__ import annotations

import logging
import sys

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
gi.require_version("Gio", "2.0")
from gi.repository import Gdk, Gio, GLib, Gtk  # noqa: E402

from . import audio, backend, clipboard, controller, keys, paths, settings
from .ui import theme
from .ui.floating import FloatingWindow
from .ui.history_window import HistoryWindow
from .ui.main_window import MainWindow
from .ui.settings_window import SettingsWindow

log = logging.getLogger("ququ.app")


def _setup_logging() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(name)s %(levelname)s %(message)s",
        handlers=[
            logging.FileHandler(paths.log_dir() / "ququ_frontend.log", encoding="utf-8"),
            logging.StreamHandler(),
        ],
    )


class QuQuApp(Gtk.Application):
    def __init__(self):
        super().__init__(application_id="com.ququ.app",
                         flags=Gio.ApplicationFlags.FLAGS_NONE)  # noqa: F821
        self.store: settings.SettingsStore | None = None
        self.backend: backend.BackendClient | None = None
        self.controller: controller.Controller | None = None
        self.main_window: MainWindow | None = None
        self.settings_window: SettingsWindow | None = None
        self.history_window: HistoryWindow | None = None
        self.floating: FloatingWindow | None = None
        self.key_watcher: keys.KeyWatcher | None = None
        self._tray = None

    def do_startup(self) -> None:
        Gtk.Application.do_startup(self)
        theme.apply_css()

        self.store = settings.SettingsStore()
        self.backend = backend.BackendClient(
            str(self.store.get("funasr_base_url", paths.DEFAULT_BASE_URL))
        )
        self.audio = audio.AudioCapture()
        self.controller = controller.Controller(self.backend, self.audio, self.store)

        # 浮动窗（先创建，controller 需要引用）
        self.floating = FloatingWindow()
        self.controller.floating = self.floating

        # 后端 WS 连接（后台线程，失败自动重连）
        self.backend.start()

        self._create_tray()

    def do_activate(self) -> None:
        if self.main_window is None:
            self.main_window = MainWindow(self, self.controller)
            self.add_window(self.main_window)
        self.main_window.show_and_refresh()

        # 全局热键（根据 recording_mode）
        self.restart_key_watcher()

    # ── 窗口打开 ─────────────────────────────────────

    def open_settings(self) -> None:
        if self.settings_window is None:
            self.settings_window = SettingsWindow(self.controller)
            self.add_window(self.settings_window)
        self.settings_window._load_values()
        self.settings_window.show_all()

    def open_history(self) -> None:
        if self.history_window is None:
            self.history_window = HistoryWindow(self.controller)
            self.add_window(self.history_window)
        self.history_window.show_and_refresh()

    # ── 全局热键 ─────────────────────────────────────

    def restart_key_watcher(self) -> None:
        if self.key_watcher is not None:
            self.key_watcher.stop()
            self.key_watcher = None
        mode = self.store.get("recording_mode", "toggle")
        hotkey = self.store.get("global_hotkey", paths.DEFAULT_HOTKEY)
        if not keys.KeyWatcher.supported():
            log.warning("键盘设备不可用，全局热键失效（需 /dev/input 读权限）")
            return
        self.key_watcher = keys.KeyWatcher(hotkey=hotkey, mode=mode)
        self.key_watcher.start(self._on_key_event)

    def _on_key_event(self, typ: str, key: str) -> None:
        # keywatcher 线程回调 → 派发到主线程
        GLib.idle_add(self._handle_key_event, typ, key)

    def _handle_key_event(self, typ: str, _key: str) -> bool:
        if self.controller is None:
            return False
        if typ == "toggle":
            self.controller.toggle_recording()
        elif typ == "down":
            self.controller.start_recording()
        elif typ == "up":
            self.controller.stop_recording()
        return False

    # ── 托盘 ─────────────────────────────────────────

    def _create_tray(self) -> None:
        try:
            gi.require_version("AppIndicator3", "0.1")
            from gi.repository import AppIndicator3 as AppIndicator  # noqa: PLC0415
            self._tray = AppIndicator.Indicator.new(
                "ququ", "input-dialpad-symbolic",
                AppIndicator.IndicatorCategory.APPLICATION_STATUS)
            self._tray.set_status(AppIndicator.IndicatorStatus.ACTIVE)
            self._tray.set_menu(self._build_tray_menu())
            return
        except Exception:  # noqa: BLE001
            pass

        # 回退：GtkStatusIcon（X11）
        try:
            from gi.repository import Gtk  # noqa: PLC0415
            icon = Gtk.StatusIcon.new_from_icon_name("input-dialpad-symbolic")
            icon.set_tooltip_text(paths.APP_TITLE)
            icon.connect("activate", self._on_tray_activate)
            icon.connect("popup-menu", self._on_tray_popup)
            self._tray = icon
        except Exception as e:  # noqa: BLE001
            log.warning("托盘不可用: %s", e)

    def _build_tray_menu(self) -> Gtk.Menu:
        menu = Gtk.Menu()
        show = Gtk.MenuItem(label="显示主窗口")
        show.connect("activate", lambda _m: self.do_activate())
        menu.append(show)
        settings_item = Gtk.MenuItem(label="设置")
        settings_item.connect("activate", lambda _m: self.open_settings())
        menu.append(settings_item)
        menu.append(Gtk.SeparatorMenuItem())
        quit_item = Gtk.MenuItem(label="退出蛐蛐")
        quit_item.connect("activate", lambda _m: self.quit())
        menu.append(quit_item)
        menu.show_all()
        return menu

    def _on_tray_activate(self, _icon: object) -> None:
        if self.main_window is not None:
            if self.main_window.get_visible():
                self.main_window.hide()
            else:
                self.main_window.show_all()

    def _on_tray_popup(self, _icon: object, button: int, time: int) -> None:
        menu = self._build_tray_menu()
        menu.popup(None, None, None, None, button, time)

    # ── 退出 ─────────────────────────────────────────

    def do_shutdown(self) -> None:
        if self.key_watcher is not None:
            self.key_watcher.stop()
        if self.controller is not None:
            self.controller.shutdown()
        if self.store is not None:
            self.store.close()
        Gtk.Application.do_shutdown(self)


def main() -> int:
    _setup_logging()
    app = QuQuApp()
    return app.run(sys.argv)
