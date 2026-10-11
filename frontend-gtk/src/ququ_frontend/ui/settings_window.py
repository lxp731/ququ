"""设置窗口 — 后端地址 / AI 配置 / 热词文件 / 录音模式。"""

from __future__ import annotations

import logging

import gi

gi.require_version("Gtk", "3.0")
from gi.repository import Gtk, Pango  # noqa: E402

from .. import paths
from ..controller import Controller

log = logging.getLogger("ququ.settings")


class SettingsWindow(Gtk.Window):
    def __init__(self, controller: Controller):
        super().__init__(type=Gtk.WindowType.TOPLEVEL)
        self.controller = controller
        self.set_name("settings")
        self.set_title("设置 - 蛐蛐")
        self.set_default_size(560, 480)
        self.set_resizable(True)

        self._build_ui()
        self._load_values()

    def _build_ui(self) -> None:
        grid = Gtk.Grid(column_spacing=12, row_spacing=14)
        grid.set_margin_top(20)
        grid.set_margin_bottom(20)
        grid.set_margin_start(24)
        grid.set_margin_end(24)

        def row(label_text: str, widget: Gtk.Widget, r: int) -> None:
            lbl = Gtk.Label(label=label_text)
            lbl.set_halign(Gtk.Align.START)
            grid.attach(lbl, 0, r, 1, 1)
            grid.attach(widget, 1, r, 1, 1)

        # 后端地址
        self.base_url_entry = Gtk.Entry()
        self.base_url_entry.set_hexpand(True)
        row("后端地址", self.base_url_entry, 0)

        # AI 优化开关
        self.ai_switch = Gtk.Switch()
        self.ai_switch.set_halign(Gtk.Align.START)
        row("启用 AI 校对", self.ai_switch, 1)

        # AI base url
        self.ai_url_entry = Gtk.Entry()
        self.ai_url_entry.set_hexpand(True)
        row("AI API 地址", self.ai_url_entry, 2)

        # AI api key
        self.api_key_entry = Gtk.Entry()
        self.api_key_entry.set_visibility(False)
        self.api_key_entry.set_hexpand(True)
        row("AI API Key", self.api_key_entry, 3)

        # AI model
        self.model_entry = Gtk.Entry()
        self.model_entry.set_hexpand(True)
        row("AI 模型", self.model_entry, 4)

        # 热词文件
        hotword_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        self.hotword_label = Gtk.Label(label="未选择")
        self.hotword_label.set_ellipsize(Pango.EllipsizeMode.END)
        self.hotword_label.set_hexpand(True)
        self.hotword_label.set_xalign(0.0)
        hotword_box.pack_start(self.hotword_label, True, True, 0)
        choose_btn = Gtk.Button(label="选择...")
        choose_btn.connect("clicked", self._on_choose_hotword)
        hotword_box.pack_start(choose_btn, False, False, 0)
        row("热词文件", hotword_box, 5)

        # 录音模式
        mode_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        self.mode_combo = Gtk.ComboBoxText()
        self.mode_combo.append("toggle", "切换模式（按一次开始，再按停止）")
        self.mode_combo.append("hold", "长按模式（按住录音，松开停止）")
        mode_box.pack_start(self.mode_combo, True, True, 0)
        row("录音模式", mode_box, 6)

        # 按钮
        btn_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=10)
        btn_box.set_halign(Gtk.Align.END)
        cancel = Gtk.Button(label="取消")
        cancel.connect("clicked", lambda _b: self.hide())
        save = Gtk.Button(label="保存")
        save.get_style_context().add_class("primary")
        save.connect("clicked", self._on_save)
        btn_box.pack_start(cancel, False, False, 0)
        btn_box.pack_start(save, False, False, 0)
        grid.attach(btn_box, 1, 7, 1, 1)

        self.add(grid)

    def _load_values(self) -> None:
        s = self.controller.store
        self.base_url_entry.set_text(str(s.get("funasr_base_url", paths.DEFAULT_BASE_URL)))
        self.ai_switch.set_active(bool(s.get("enable_ai_optimization", True)))
        self.ai_url_entry.set_text(str(s.get("ai_base_url", "https://api.openai.com/v1")))
        self.api_key_entry.set_text(str(s.get("ai_api_key", "") or ""))
        self.model_entry.set_text(str(s.get("ai_model", "gpt-3.5-turbo")))
        hp = str(s.get("hotword_path", "") or "")
        self.hotword_label.set_text(hp or "未选择")
        mode = s.get("recording_mode", "toggle")
        self.mode_combo.set_active_id(mode if mode in ("toggle", "hold") else "toggle")

    def _on_choose_hotword(self, _btn: Gtk.Button) -> None:
        dialog = Gtk.FileChooserDialog(
            title="选择热词文件", parent=self,
            action=Gtk.FileChooserAction.OPEN,
        )
        dialog.add_buttons("取消", Gtk.ResponseType.CANCEL, "选择", Gtk.ResponseType.OK)
        filt = Gtk.FileFilter()
        filt.set_name("文本文件")
        filt.add_pattern("*.txt")
        dialog.add_filter(filt)
        resp = dialog.run()
        if resp == Gtk.ResponseType.OK:
            path = dialog.get_filename()
            try:
                with open(path, encoding="utf-8") as f:
                    content = f.read()
                words = [w.strip() for w in content.replace("，", " ").replace(",", " ").split() if w.strip()]
                self.hotword_label.set_text(path)
                self._pending_hotwords = " ".join(words)
                self._pending_hotword_count = len(words)
                self._pending_hotword_path = path
            except OSError as e:
                self.controller.notify(f"读取热词文件失败: {e}")
        dialog.destroy()

    def _on_save(self, _btn: Gtk.Button) -> None:
        s = self.controller.store
        old_base = str(s.get("funasr_base_url", ""))
        new_base = self.base_url_entry.get_text().strip().rstrip("/")

        s.set("funasr_base_url", new_base)
        s.set("enable_ai_optimization", self.ai_switch.get_active())
        s.set("ai_base_url", self.ai_url_entry.get_text().strip())
        s.set("ai_api_key", self.api_key_entry.get_text().strip())
        s.set("ai_model", self.model_entry.get_text().strip())
        s.set("recording_mode", self.mode_combo.get_active_id() or "toggle")

        if hasattr(self, "_pending_hotword_path"):
            s.set("hotword_path", self._pending_hotword_path)
            s.set("hotwords", self._pending_hotwords)
            s.set("hotwords_count", self._pending_hotword_count)

        # 后端地址变化 → 重连
        if old_base != new_base:
            self.controller.backend.base_url = new_base
            self.controller.backend._ws_url = new_base.replace("http", "ws", 1) + "/stream/ws"

        # 同步配置到后端
        self.controller.send_config()

        # 通知主窗口刷新 + 重启 keywatcher
        app = self.get_application()
        if app is not None:
            if hasattr(app, "restart_key_watcher"):
                app.restart_key_watcher()
            if hasattr(app, "main_window") and app.main_window is not None:
                app.main_window.show_and_refresh()

        self.controller.notify("设置已保存")
        self.hide()
