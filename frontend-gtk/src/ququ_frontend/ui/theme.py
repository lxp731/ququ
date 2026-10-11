"""GTK CSS 主题 — 还原 Electron 版暗色玻璃质感（配色一致，动画降级）。"""

from __future__ import annotations

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
from gi.repository import Gdk, Gtk  # noqa: E402

# 与 index.css 一致的配色
ACCENT = "#818cf8"
ACCENT_STRONG = "#6366f1"
SURFACE = "#0a0a0f"
SURFACE_RAISED = "#12121a"
TEXT = "#e2e8f0"

# 三区文字色（浮动窗）
GREEN = "#a3e635"
YELLOW = "#fbbf24"
RED = "#f87171"

CSS = """
window#main, window#settings, window#history {
    background-image: linear-gradient(270deg, #1e1b4b, #0f172a, #1e1b4b, #0f172a);
    color: #e2e8f0;
}
window#floating {
    background: transparent;
}

/* ── 主标题渐变（纯色近似，GTK 不支持 background-clip:text）── */
#title {
    font-size: 24px;
    font-weight: 800;
    color: #a5b4fc;
}

/* ── 玻璃面板 ── */
#glass {
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 12px;
    padding: 14px;
}

/* ── 麦克风按钮 ── */
#mic-button {
    min-width: 80px;
    min-height: 80px;
    border-radius: 40px;
    border: 2px solid rgba(255, 255, 255, 0.10);
    background: rgba(255, 255, 255, 0.06);
    color: rgba(255, 255, 255, 0.60);
    font-size: 28px;
    transition: 300ms;
}
#mic-button:hover {
    background: rgba(255, 255, 255, 0.12);
    border-color: rgba(255, 255, 255, 0.20);
}
#mic-button.recording {
    border-color: rgba(129, 140, 248, 0.50);
    background: rgba(129, 140, 248, 0.20);
    color: #c7d2fe;
}
#mic-button.processing {
    border-color: rgba(255, 255, 255, 0.10);
    background: rgba(255, 255, 255, 0.05);
}

/* ── 三区文字 ── */
#green-zone { color: rgba(255, 255, 255, 0.90); }
#yellow-zone { color: rgba(255, 255, 255, 0.60); }
#red-zone { color: rgba(255, 255, 255, 0.30); }

/* ── 状态文字 ── */
#status-label {
    color: rgba(255, 255, 255, 0.40);
    font-size: 12px;
}

/* ── 小按钮（热键/模式）── */
.small-button {
    padding: 6px 12px;
    border-radius: 8px;
    border: 1px solid rgba(255, 255, 255, 0.10);
    color: rgba(255, 255, 255, 0.40);
    background: transparent;
    font-size: 11px;
    transition: 200ms;
}
.small-button:hover {
    border-color: rgba(255, 255, 255, 0.20);
    color: rgba(255, 255, 255, 0.60);
}
.small-button.active {
    border-color: rgba(129, 140, 248, 0.50);
    background: rgba(129, 140, 248, 0.10);
    color: #a5b4fc;
}

/* ── 设置/历史通用 ── */
label.hint { color: rgba(255, 255, 255, 0.35); font-size: 11px; }
entry, spinbutton, combobox {
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 8px;
    color: #e2e8f0;
    padding: 6px 8px;
}
entry:focus, spinbutton:focus {
    border-color: rgba(129, 140, 248, 0.50);
}
switch {
    background: rgba(255, 255, 255, 0.10);
}
switch:checked {
    background: #6366f1;
}
progressbar trough {
    background: rgba(255, 255, 255, 0.05);
    min-height: 4px;
    border-radius: 2px;
}
progressbar progress {
    background-image: linear-gradient(to right, #6366f1, #a855f7);
    border-radius: 2px;
}
button.danger {
    color: #f87171;
    border-color: rgba(248, 113, 113, 0.30);
}
button.primary {
    background: rgba(99, 102, 241, 0.20);
    color: #a5b4fc;
    border: 1px solid rgba(129, 140, 248, 0.40);
    border-radius: 8px;
    padding: 6px 14px;
}
button.primary:hover {
    background: rgba(99, 102, 241, 0.30);
}

/* ── 浮动窗 ── */
#floating-box {
    background: rgba(0, 0, 0, 0.72);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 14px;
    padding: 10px 16px;
}
#floating-green { color: #a3e635; }
#floating-yellow { color: #fbbf24; }
#floating-red { color: #f87171; }
#floating-status { color: rgba(255, 255, 255, 0.35); font-size: 11px; }
#drag-handle { color: rgba(255, 255, 255, 0.25); font-size: 11px; }

/* ── 历史列表 ── */
#history-list {
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 10px;
}
"""


def apply_css() -> None:
    provider = Gtk.CssProvider()
    provider.load_from_data(CSS.encode("utf-8"))
    Gtk.StyleContext.add_provider_for_screen(
        Gdk.Screen.get_default(),
        provider,
        Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION,
    )


def add_class(widget: Gtk.Widget, name: str) -> None:
    ctx = widget.get_style_context()
    ctx.add_class(name)


def remove_class(widget: Gtk.Widget, name: str) -> None:
    ctx = widget.get_style_context()
    ctx.remove_class(name)
