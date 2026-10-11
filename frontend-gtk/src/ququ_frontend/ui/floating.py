"""浮动三区预览窗 — 无边框/透明/置顶/可拖拽/文字区鼠标穿透。

X11：用 input_shape 只让顶部拖拽手柄接收输入，其余区域穿透。
Wayland：input_shape 无效，降级为整窗可拖（后续可用 gtk-layer-shell 优化）。
"""

from __future__ import annotations

import logging
from typing import Any

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
from gi.repository import Gdk, GLib, Gtk  # noqa: E402

from . import theme

log = logging.getLogger("ququ.floating")

HANDLE_HEIGHT = 16  # 拖拽手柄高度（px）
WIDTH, HEIGHT = 620, 140


class FloatingWindow(Gtk.Window):
    def __init__(self):
        super().__init__(type=Gtk.WindowType.TOPLEVEL)
        self.set_name("floating")
        self.set_decorated(False)
        self.set_keep_above(True)
        self.set_accept_focus(False)
        self.set_skip_taskbar_hint(True)
        self.set_skip_pager_hint(True)
        self.set_type_hint(Gdk.WindowTypeHint.NOTIFICATION)
        self.set_default_size(WIDTH, HEIGHT)
        self.set_size_request(200, 60)

        # 透明底
        screen = self.get_screen()
        visual = screen.get_rgba_visual()
        if visual is not None and screen.is_composited():
            self.set_visual(visual)
        self.set_app_paintable(True)

        # 位置记忆（内存，与 Electron 一致不持久化）
        self._saved_pos: tuple[int, int] | None = None

        # 拖拽状态
        self._drag_offset: tuple[int, int] | None = None

        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=4)
        box.set_name("floating-box")

        # 拖拽手柄
        handle = Gtk.Label(label="•••")
        handle.set_name("drag-handle")
        handle.set_size_request(-1, HANDLE_HEIGHT)
        box.pack_start(handle, False, False, 0)

        # 状态条
        self.status_label = Gtk.Label(label="正在聆听...")
        self.status_label.set_name("floating-status")
        self.status_label.set_halign(Gtk.Align.START)
        box.pack_start(self.status_label, False, False, 0)

        # 三区文字（单 label + Pango markup 分色）
        self.text_label = Gtk.Label(label="")
        self.text_label.set_name("floating-text")
        self.text_label.set_halign(Gtk.Align.START)
        self.text_label.set_line_wrap(True)
        self.text_label.set_line_wrap_mode(Gtk.WrapMode.CHAR)
        self.text_label.set_xalign(0.0)
        self.text_label.set_selectable(False)
        box.pack_start(self.text_label, True, True, 0)

        self.add(box)

        # 拖拽事件（手柄区域通过 input_shape 接收）
        self.add_events(Gdk.EventMask.BUTTON_PRESS_MASK | Gdk.EventMask.BUTTON_RELEASE_MASK
                        | Gdk.EventMask.POINTER_MOTION_MASK)
        self.connect("button-press-event", self._on_press)
        self.connect("button-release-event", self._on_release)
        self.connect("motion-notify-event", self._on_motion)
        self.connect("configure-event", self._on_configure)

    # ── 显示 / 隐藏 ──────────────────────────────────

    def show(self) -> None:  # noqa: A003
        if not self.get_realized():
            self.realize()
        self._position()
        self._apply_input_shape()
        super().show_all()

    def hide(self) -> None:  # noqa: A003
        super().hide()

    def _position(self) -> None:
        if self._saved_pos is not None:
            self.move(self._saved_pos[0], self._saved_pos[1])
            return
        screen = self.get_screen()
        monitor = screen.get_primary_monitor()
        geo = screen.get_monitor_workarea(monitor)
        w, h = self.get_size()
        x = geo.x + (geo.width - w) // 2
        y = geo.y + geo.height - h - 40
        self.move(x, y)

    def _apply_input_shape(self) -> None:
        """只让顶部手柄接收输入，其余区域鼠标穿透（仅 X11 支持）。"""
        gdkwin = self.get_window()
        if gdkwin is None:
            return
        # Wayland backend 不支持 input_shape（需 gtk-layer-shell），跳过避免 Gdk-CRITICAL
        try:
            from gi.repository import GdkX11  # noqa: PLC0415
            if not isinstance(gdkwin, GdkX11.X11Window):
                return
        except Exception:  # noqa: BLE001
            pass
        try:
            import cairo  # noqa: PLC0415
            w = self.get_allocated_width()
            region = cairo.Region()
            region.rectangle(cairo.RectangleInt(0, 0, w, HANDLE_HEIGHT))
            gdkwin.input_shape_combine_region(region)
        except Exception as e:  # noqa: BLE001
            log.debug("input_shape 不可用，降级整窗可拖: %s", e)

    def _on_configure(self, _w: Any, _e: Any) -> None:
        self._apply_input_shape()

    # ── 拖拽 ─────────────────────────────────────────

    def _on_press(self, _w: Any, event: Gdk.EventButton) -> bool:
        if event.button == 1:
            x, y = self.get_position()
            self._drag_offset = (int(event.x_root - x), int(event.y_root - y))
        return True

    def _on_release(self, _w: Any, _e: Any) -> bool:
        if self._drag_offset is not None:
            self._saved_pos = self.get_position()
        self._drag_offset = None
        return True

    def _on_motion(self, _w: Any, event: Gdk.EventMotion) -> bool:
        if self._drag_offset is not None:
            dx, dy = self._drag_offset
            self.move(int(event.x_root - dx), int(event.y_root - dy))
        return True

    # ── 内容更新 ─────────────────────────────────────

    def set_preedit(self, green: str, yellow: str, red: str) -> None:
        parts: list[str] = []
        if green:
            parts.append(f'<span color="{theme.GREEN}">{GLib.markup_escape_text(green)}</span>')
        if yellow:
            parts.append(f'<span color="{theme.YELLOW}">{GLib.markup_escape_text(yellow)}</span>')
        if red:
            parts.append(f'<span color="{theme.RED}">{GLib.markup_escape_text(red)}</span>')
        if parts:
            self.text_label.set_markup("".join(parts))
        else:
            self.text_label.set_markup("")

    def set_status(self, text: str) -> None:
        self.status_label.set_text(text)
