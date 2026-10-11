"""麦克风 PCM 采集 — arecord 子进程输出 raw PCM。

与 Electron nativeAudio.js 一致：16kHz / 16bit / mono / raw，边录边送。
GStreamer 可作为后续优化（处理 PipeWire 更稳），此处先沿用已验证方案。
"""

from __future__ import annotations

import logging
import subprocess
import threading
from typing import Callable

from . import paths

log = logging.getLogger("ququ.audio")

DataCallback = Callable[[bytes], None]


class AudioCapture:
    def __init__(self, device: str | None = None):
        self._proc: subprocess.Popen | None = None
        self._thread: threading.Thread | None = None
        self._capturing = False
        self._device = device  # 如 "hw:1,0"，None 用默认
        self._on_data: DataCallback | None = None

    @staticmethod
    def list_devices() -> list[dict[str, str]]:
        """枚举 ALSA 录音设备。"""
        devices: list[dict[str, str]] = []
        try:
            out = subprocess.run(
                ["arecord", "-l"], capture_output=True, text=True, timeout=5
            ).stdout
            for line in out.splitlines():
                if line.startswith("card "):
                    # "card 1: Device [USB Mic], device 0: ..."
                    import re
                    m = re.match(r"card\s+(\d+):\s+.+?\[(.+?)\]", line)
                    if m:
                        devices.append({"id": f"hw:{m.group(1)},0", "name": m.group(2)})
        except (OSError, subprocess.SubprocessError):
            pass
        return devices

    def set_device(self, name: str | None) -> None:
        # 安全：仅接受 list_devices 产生的 hw: 格式
        if name and not (name.startswith("hw:") and name.replace(",", "").replace(":", "").replace("hw", "").isdigit()):
            name = None
        self._device = name

    def start(self, on_data: DataCallback) -> bool:
        if self._capturing:
            return True
        self._on_data = on_data
        args = [
            "arecord",
            "-f", "S16_LE",
            "-r", str(paths.SAMPLE_RATE),
            "-c", str(paths.CHANNELS),
            "-t", "raw",
            "--period-size", str(paths.CHUNK_SAMPLES),
            "-",
        ]
        if self._device:
            args[1:1] = ["-D", self._device]
        try:
            self._proc = subprocess.Popen(
                args, stdout=subprocess.PIPE, stderr=subprocess.PIPE
            )
        except OSError as e:
            log.error("arecord 启动失败: %s", e)
            return False

        self._capturing = True
        self._thread = threading.Thread(target=self._pump, name="ququ-audio", daemon=True)
        self._thread.start()
        return True

    def _pump(self) -> None:
        assert self._proc is not None and self._proc.stdout is not None
        try:
            while self._capturing:
                chunk = self._proc.stdout.read(paths.CHUNK_SAMPLES * 2)
                if not chunk:
                    break
                if self._on_data:
                    self._on_data(chunk)
        except OSError as e:
            log.warning("音频读取中断: %s", e)
        finally:
            self._cleanup()

    def stop(self) -> None:
        self._capturing = False
        if self._proc and self._proc.poll() is None:
            try:
                self._proc.terminate()
                self._proc.wait(timeout=2)
            except Exception:  # noqa: BLE001
                try:
                    self._proc.kill()
                except Exception:  # noqa: BLE001
                    pass
        self._cleanup()

    def _cleanup(self) -> None:
        self._capturing = False
        self._proc = None
        self._thread = None
