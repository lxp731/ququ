"""全局键盘监听（长按/切换模式）— 直接读取 /dev/input/event* (evdev)。

替代 Electron keyWatcher.js 中「spawn python3 -c」的子进程方案，
改为进程内直接读取，零额外依赖（仅标准库 select + struct）。

需要用户对 /dev/input/event* 有读权限（通常需加入 input 组）。
"""

from __future__ import annotations

import logging
import os
import select
import struct
import sys
import threading
from pathlib import Path
from typing import Callable

log = logging.getLogger("ququ.keys")

# evdev 键码映射（与 Electron keyWatcher.js 一致）
EV_KEY_MAP: dict[str, int] = {
    "Space": 57, "Tab": 15, "Enter": 28, "Escape": 1, "Backspace": 14,
    "A": 30, "B": 48, "C": 46, "D": 32, "E": 18, "F": 33, "G": 34,
    "H": 35, "I": 23, "J": 36, "K": 37, "L": 38, "M": 50, "N": 49,
    "O": 24, "P": 25, "Q": 16, "R": 19, "S": 31, "T": 20, "U": 22,
    "V": 47, "W": 17, "X": 45, "Y": 21, "Z": 44,
    "0": 11, "1": 2, "2": 3, "3": 4, "4": 5, "5": 6, "6": 7, "7": 8, "8": 9, "9": 10,
}

EV_MODS: dict[str, list[int]] = {
    "Ctrl": [29, 97], "Shift": [42, 54], "Alt": [56, 100], "Meta": [125, 126],
}

# input_event 结构：timeval(long,long) + u16 type + u16 code + s32 value
_LONG_SIZE = struct.calcsize("@l")
_EVENT_FMT = "LLHHI" if _LONG_SIZE == 8 else "llHHI"
_EVENT_SIZE = struct.calcsize(_EVENT_FMT)

KeyEventCallback = Callable[[str, str], None]  # (type, key_name)  type ∈ {down, up, toggle}


def _find_keyboards() -> list[str]:
    devices: set[str] = set()
    by_path = Path("/dev/input/by-path")
    if by_path.is_dir():
        for name in by_path.iterdir():
            n = name.name
            if n.endswith("-kbd") or n.endswith("-event-kbd"):
                try:
                    devices.add(os.path.realpath(name))
                except OSError:
                    pass
    return list(devices)


def parse_hotkey(hotkey: str) -> tuple[str, list[str]] | None:
    """解析 'Ctrl+Shift+L' → ('L', ['Ctrl','Shift'])。"""
    if not isinstance(hotkey, str) or not hotkey or not all(
        c.isalnum() or c == "+" for c in hotkey
    ):
        return None
    parts = hotkey.split("+")
    trigger = parts[-1]
    mods = parts[:-1]
    return trigger, mods


class KeyWatcher:
    """监听全局按键，触发组合键事件。

    mode='hold':   组合键按下→down，释放→up
    mode='toggle': 组合键按下→toggle（利用 evdev value=1 天然去抖）
    """

    def __init__(self, hotkey: str = "Ctrl+Space", mode: str = "toggle"):
        self.hotkey = hotkey
        self.mode = mode
        self._thread: threading.Thread | None = None
        self._stopped = threading.Event()
        self._on_event: KeyEventCallback | None = None

    @staticmethod
    def supported() -> bool:
        return bool(_find_keyboards())

    def start(self, on_event: KeyEventCallback) -> bool:
        if self._thread and self._thread.is_alive():
            return True
        parsed = parse_hotkey(self.hotkey)
        if parsed is None:
            log.error("非法热键格式: %s", self.hotkey)
            return False
        trigger, mods = parsed
        trigger_code = EV_KEY_MAP.get(trigger)
        if trigger_code is None:
            log.error("不支持的触发键: %s", trigger)
            return False

        # 构建 code -> name 的 watch 映射
        watch: dict[int, str] = {}
        for mod in mods:
            for code in EV_MODS.get(mod, []):
                watch[code] = mod
        watch[trigger_code] = trigger

        devices = _find_keyboards()
        if not devices:
            log.error("找不到键盘设备 (需 /dev/input/by-path/*-kbd 读权限)")
            return False

        self._on_event = on_event
        self._stopped.clear()
        self._thread = threading.Thread(
            target=self._run,
            args=(devices, watch, trigger, set(mods)),
            name="ququ-keys",
            daemon=True,
        )
        self._thread.start()
        return True

    def stop(self) -> None:
        self._stopped.set()
        # 唤醒 select：无需额外操作，daemon 线程会因 stop 事件退出
        self._thread = None

    def _run(self, devices: list[str], watch: dict[int, str],
             trigger_name: str, mods_set: set[str]) -> None:
        fds: list[int] = []
        for d in devices:
            try:
                fds.append(os.open(d, os.O_RDONLY))
            except OSError as e:
                log.warning("无法打开设备 %s: %s", d, e)
        if not fds:
            log.error("无法打开任何键盘设备")
            return

        pressed: set[str] = set()

        try:
            while not self._stopped.is_set():
                try:
                    ready, _, _ = select.select(fds, [], [], 0.5)
                except OSError:
                    break
                if self._stopped.is_set():
                    break
                for fd in ready:
                    try:
                        data = os.read(fd, _EVENT_SIZE)
                    except OSError:
                        continue
                    if len(data) < _EVENT_SIZE:
                        continue
                    _tv_sec, _tv_usec, typ, code, value = struct.unpack(_EVENT_FMT, data)
                    if typ != 1 or code not in watch:
                        continue
                    name = watch[code]
                    if value == 1:  # down
                        pressed.add(name)
                        if self.mode == "toggle":
                            if name == trigger_name and mods_set.issubset(pressed):
                                self._emit("toggle", trigger_name)
                        else:
                            self._emit("down", name)
                    elif value == 0:  # up
                        if self.mode == "hold":
                            self._emit("up", name)
                        pressed.discard(name)
        finally:
            for fd in fds:
                try:
                    os.close(fd)
                except OSError:
                    pass

    def _emit(self, typ: str, key: str) -> None:
        if self._on_event:
            try:
                self._on_event(typ, key)
            except Exception:  # noqa: BLE001
                log.exception("按键回调异常")


# 导出符号便于测试
__all__ = ["KeyWatcher", "parse_hotkey", "EV_KEY_MAP", "EV_MODS"]
