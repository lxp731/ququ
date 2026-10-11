"""剪贴板 + 自动粘贴。

与 Electron clipboard.js 一致：先写剪贴板，再调用 ydotoold/wtype/xdotool
模拟 Ctrl+V，带降级链与超时兜底。
"""

from __future__ import annotations

import logging
import shutil
import subprocess
import time

log = logging.getLogger("ququ.clipboard")


def _clipboard_set(text: str) -> None:
    """写入系统剪贴板（X11/Wayland）。"""
    try:
        import gi  # noqa: PLC0415
        gi.require_version("Gtk", "3.0")
        from gi.repository import Gtk
        cb = Gtk.Clipboard.get(Gtk.SelectionClipboard.CLIPBOARD)
        cb.set_text(text, -1)
        cb.store()  # 持久化，退出后仍可粘贴
        return
    except Exception:  # noqa: BLE001
        pass
    # 回退：xclip / wl-copy
    for tool in (["xclip", "-selection", "clipboard"], ["wl-copy"]):
        if shutil.which(tool[0]):
            try:
                subprocess.run(tool, input=text.encode("utf-8"), timeout=3)
                return
            except Exception:  # noqa: BLE001
                pass


def _have(tool: str) -> bool:
    return shutil.which(tool) is not None


def _ydotoold_running() -> bool:
    try:
        subprocess.run(["pgrep", "-x", "ydotoold"], check=True, timeout=2)
        return True
    except (subprocess.SubprocessError, OSError):
        return False


def _paste_tools() -> list[tuple[str, list[str]]]:
    """返回可用的粘贴工具链 (name, argv)。"""
    tools: list[tuple[str, list[str]]] = []
    if _ydotoold_running():
        # 29=Ctrl 47=V (按下/释放)
        tools.append(("ydotool", ["ydotool", "key", "29:1", "47:1", "47:0", "29:0"]))
    if _have("wtype"):
        tools.append(("wtype", ["wtype", "-M", "ctrl", "v", "-m", "ctrl"]))
    if _have("xdotool"):
        tools.append(("xdotool", ["xdotool", "key", "--clearmodifiers", "ctrl+v"]))
    return tools


def paste(text: str) -> dict[str, object]:
    """写入剪贴板并模拟 Ctrl+V 粘贴到当前焦点输入框。"""
    _clipboard_set(text)

    tools = _paste_tools()
    log.info("可用粘贴工具: %s", ", ".join(t[0] for t in tools) or "无")
    if not tools:
        return {"success": False, "pasted": False, "error": "无可用的粘贴工具"}

    for name, argv in tools:
        log.info("尝试粘贴: %s", name)
        try:
            proc = subprocess.Popen(argv)
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                proc.kill()
                continue
            if proc.returncode == 0:
                return {"success": True, "pasted": True, "tool": name}
        except OSError:
            continue

    return {"success": False, "pasted": False, "error": "粘贴失败（文本已在剪贴板）"}


def copy_text(text: str) -> bool:
    _clipboard_set(text)
    return True
