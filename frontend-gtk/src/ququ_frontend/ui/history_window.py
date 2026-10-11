"""历史窗口 — 转录历史列表 / 搜索 / 删除 / 清空 / 导出。"""

from __future__ import annotations

import logging
from datetime import datetime

import gi

gi.require_version("Gtk", "3.0")
from gi.repository import Gtk  # noqa: E402

from ..controller import Controller
from .. import export as export_mod

log = logging.getLogger("ququ.history")


class HistoryWindow(Gtk.Window):
    def __init__(self, controller: Controller):
        super().__init__(type=Gtk.WindowType.TOPLEVEL)
        self.controller = controller
        self.set_name("history")
        self.set_title("转录历史 - 蛐蛐")
        self.set_default_size(720, 560)
        self.set_resizable(True)

        self._rows: list[dict] = []

        self._build_ui()
        self._load()

    def _build_ui(self) -> None:
        vbox = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
        vbox.set_margin_top(12)
        vbox.set_margin_bottom(12)
        vbox.set_margin_start(12)
        vbox.set_margin_end(12)

        # 顶部：搜索 + 导出
        top = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        self.search_entry = Gtk.Entry()
        self.search_entry.set_placeholder_text("搜索转录文本...")
        self.search_entry.set_hexpand(True)
        self.search_entry.connect("activate", lambda _e: self._search())
        top.pack_start(self.search_entry, True, True, 0)

        search_btn = Gtk.Button(label="搜索")
        search_btn.connect("clicked", lambda _b: self._search())
        top.pack_start(search_btn, False, False, 0)

        self.export_combo = Gtk.ComboBoxText()
        for fmt in ("txt", "json", "docx", "pdf"):
            self.export_combo.append(fmt, fmt.upper())
        self.export_combo.set_active_id("txt")
        top.pack_start(self.export_combo, False, False, 0)

        export_btn = Gtk.Button(label="导出")
        export_btn.connect("clicked", self._on_export)
        top.pack_start(export_btn, False, False, 0)
        vbox.pack_start(top, False, False, 0)

        # 列表
        self.liststore = Gtk.ListStore(int, str, str)  # id, time, text
        self.tree = Gtk.TreeView(model=self.liststore)
        self.tree.set_name("history-list")

        col_time = Gtk.TreeViewColumn("时间", Gtk.CellRendererText(), text=1)
        col_time.set_min_width(140)
        self.tree.append_column(col_time)

        col_text = Gtk.TreeViewColumn("文本", Gtk.CellRendererText(), text=2)
        col_text.set_expand(True)
        self.tree.append_column(col_text)

        scroll = Gtk.ScrolledWindow()
        scroll.set_policy(Gtk.PolicyType.AUTOMATIC, Gtk.PolicyType.AUTOMATIC)
        scroll.add(self.tree)
        vbox.pack_start(scroll, True, True, 0)

        # 底部按钮
        bottom = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        bottom.set_halign(Gtk.Align.END)
        delete_btn = Gtk.Button(label="删除选中")
        delete_btn.get_style_context().add_class("danger")
        delete_btn.connect("clicked", self._on_delete)
        clear_btn = Gtk.Button(label="清空全部")
        clear_btn.get_style_context().add_class("danger")
        clear_btn.connect("clicked", self._on_clear)
        close_btn = Gtk.Button(label="关闭")
        close_btn.connect("clicked", lambda _b: self.hide())
        bottom.pack_start(delete_btn, False, False, 0)
        bottom.pack_start(clear_btn, False, False, 0)
        bottom.pack_start(close_btn, False, False, 0)
        vbox.pack_start(bottom, False, False, 0)

        self.add(vbox)

    def _load(self) -> None:
        rows = self.controller.store.get_transcriptions(limit=200)
        self._fill(rows)

    def _search(self) -> None:
        q = self.search_entry.get_text().strip()
        if q:
            rows = self.controller.store.search_transcriptions(q, limit=200)
        else:
            rows = self.controller.store.get_transcriptions(limit=200)
        self._fill(rows)

    def _fill(self, rows: list[dict]) -> None:
        self._rows = rows
        self.liststore.clear()
        for r in rows:
            ts = r.get("created_at", "")
            try:
                dt = datetime.strptime(ts, "%Y-%m-%d %H:%M:%S")
                ts = dt.strftime("%m-%d %H:%M")
            except (ValueError, TypeError):
                pass
            self.liststore.append([r["id"], ts, r.get("text", "")])

    def _selected_id(self) -> int | None:
        _model, it = self.tree.get_selection().get_selected()
        if it is None:
            return None
        return self.liststore[it][0]

    def _on_delete(self, _btn: Gtk.Button) -> None:
        tid = self._selected_id()
        if tid is None:
            self.controller.notify("请先选中一条记录")
            return
        self.controller.store.delete_transcription(tid)
        self._load()

    def _on_clear(self, _btn: Gtk.Button) -> None:
        dialog = Gtk.MessageDialog(
            parent=self, flags=0, type=Gtk.MessageType.QUESTION,
            buttons=Gtk.ButtonsType.YES_NO, message_format="确定清空全部转录历史？",
        )
        resp = dialog.run()
        dialog.destroy()
        if resp == Gtk.ResponseType.YES:
            self.controller.store.clear_all()
            self._load()

    def _on_export(self, _btn: Gtk.Button) -> None:
        rows = self._rows
        if not rows:
            self.controller.notify("没有可导出的记录")
            return
        fmt = self.export_combo.get_active_id() or "txt"
        dialog = Gtk.FileChooserDialog(
            title="导出转录历史", parent=self,
            action=Gtk.FileChooserAction.SAVE,
        )
        dialog.add_buttons("取消", Gtk.ResponseType.CANCEL, "导出", Gtk.ResponseType.OK)
        dialog.set_current_name(f"ququ_history.{fmt}")
        resp = dialog.run()
        if resp == Gtk.ResponseType.OK:
            path = dialog.get_filename()
            dialog.destroy()
            try:
                import pathlib
                export_mod.export(rows, fmt, pathlib.Path(path))
                self.controller.notify(f"已导出到 {path}")
            except Exception as e:  # noqa: BLE001
                self.controller.notify(f"导出失败: {e}")
            return
        dialog.destroy()

    def show_and_refresh(self) -> None:
        self._load()
        self.show_all()
