"""录音状态机 + 后端回调 + 自动粘贴编排。

对应 Electron 版 App.jsx 中的 useStreamingRecording + pipeline 回调 + safePaste。
将 UI 无关的逻辑集中于此，便于测试与窗口解耦。
"""

from __future__ import annotations

import logging
import time
from typing import Any, Callable

from . import audio as audio_mod
from . import backend as backend_mod
from . import clipboard as clipboard_mod
from . import settings as settings_mod

log = logging.getLogger("ququ.controller")

# 三区文字
Preedit = tuple[str, str, str]  # (green, yellow, red)


class Controller:
    def __init__(self, backend: backend_mod.BackendClient,
                 audio: audio_mod.AudioCapture,
                 store: settings_mod.SettingsStore):
        self.backend = backend
        self.audio = audio
        self.store = store
        self.is_recording = False
        self.is_processing = False
        self.preedit: Preedit = ("", "", "")
        self.final_text = ""

        # UI 回调（由窗口层注册，均在 GTK 主线程执行）
        self.on_preedit: Callable[[str, str, str], None] | None = None
        self.on_final_text: Callable[[str], None] | None = None
        self.on_state: Callable[[bool, bool], None] | None = None
        self.on_status: Callable[[dict[str, Any]], None] | None = None
        self.on_notify: Callable[[str], None] | None = None

        # 浮动窗（可选注入）
        self.floating: Any = None

        self._last_paste: tuple[str, float] = ("", 0.0)

        self._wire_backend()

    def _wire_backend(self) -> None:
        b = self.backend
        b.on_preedit = self._handle_preedit
        b.on_commit = self._handle_commit
        b.on_final = self._handle_final
        b.on_reset = self._handle_reset
        b.on_status = self._handle_status
        b.on_error = lambda d: self.notify(f"后端错误: {d.get('message', '')}")
        b.on_hotwords_updated = self._handle_hotwords

    # ── 后端回调（已在主线程）─────────────────────────

    def _handle_preedit(self, data: dict[str, Any]) -> None:
        g, y, r = data.get("green", ""), data.get("yellow", ""), data.get("red", "")
        self.preedit = (g, y, r)
        if self.on_preedit:
            self.on_preedit(g, y, r)
        if self.floating is not None:
            self.floating.set_preedit(g, y, r)
        # 安全网：录音中浮动窗意外消失则重新显示
        if self.is_recording and self.floating is not None:
            self.floating.show()

    def _handle_commit(self, data: dict[str, Any]) -> None:
        text = data.get("text", "")
        if text:
            self.final_text = text
            self._safe_paste(text)

    def _handle_final(self, data: dict[str, Any]) -> None:
        text = data.get("text", "")
        self.final_text = text
        self.preedit = ("", "", "")
        if self.on_preedit:
            self.on_preedit("", "", "")
        if text:
            self._safe_paste(text)
            self._save_history(text)
            if self.on_final_text:
                self.on_final_text(text)
        # 录音真正停止后才隐藏浮动窗
        if not self.is_recording and self.floating is not None:
            self.floating.set_preedit("", "", "")
            self.floating.hide()

    def _handle_reset(self, *_: Any) -> None:
        self.preedit = ("", "", "")
        if self.on_preedit:
            self.on_preedit("", "", "")

    def _handle_status(self, data: dict[str, Any]) -> None:
        if self.on_status:
            self.on_status(data)

    def _handle_hotwords(self, data: dict[str, Any]) -> None:
        count = data.get("count", 0)
        try:
            self.store.set("hotwords_count", count)
        except Exception:  # noqa: BLE001
            pass
        self.notify(f"热词文件已更新 ({count} 词)")

    # ── 录音控制 ─────────────────────────────────────

    def toggle_recording(self) -> None:
        if self.is_recording:
            self.stop_recording()
        else:
            self.start_recording()

    def start_recording(self) -> None:
        if self.is_recording or self.is_processing:
            return
        if not self.backend.connected:
            self.notify("后端未连接，无法录音")
            return

        ok = self.audio.start(self._on_audio_data)
        if not ok:
            self.notify("无法开始录音（麦克风不可用）")
            return

        self.backend.start_listening()
        self.is_recording = True
        if self.floating is not None:
            self.floating.show()
        self._set_state()

    def _on_audio_data(self, pcm: bytes) -> None:
        # 音频线程回调：直接送后端（send 线程安全）
        self.backend.send_audio(pcm)

    def stop_recording(self) -> None:
        if not self.is_recording:
            return
        self.is_recording = False
        self.audio.stop()
        self.backend.stop_listening()
        self.is_processing = True
        self._set_state()

    def cancel_recording(self) -> None:
        self.is_recording = False
        self.audio.stop()
        self.backend.reset()
        self.is_processing = False
        self._set_state()

    def _set_state(self) -> None:
        if self.on_state:
            self.on_state(self.is_recording, self.is_processing)

    # ── 粘贴（带去重）────────────────────────────────

    def _safe_paste(self, text: str) -> None:
        now = time.time()
        if self._last_paste[0] == text and now - self._last_paste[1] < 1.0:
            return
        self._last_paste = (text, now)
        try:
            r = clipboard_mod.paste(text)
            if r.get("success"):
                self.notify("已自动粘贴到当前输入框")
            else:
                self.notify("粘贴失败，请手动 Ctrl+V")
        except Exception as e:  # noqa: BLE001
            log.warning("粘贴异常: %s", e)

    def _save_history(self, text: str) -> None:
        try:
            self.store.save_transcription({"text": text, "language": "zh-CN"})
        except Exception as e:  # noqa: BLE001
            log.warning("保存历史失败: %s", e)

    # ── 其他 ─────────────────────────────────────────

    def notify(self, msg: str) -> None:
        log.info(msg)
        if self.on_notify:
            self.on_notify(msg)

    def send_config(self) -> None:
        """将当前设置同步到后端（LLM + 热词）。"""
        enabled = bool(self.store.get("enable_ai_optimization", True))
        api_key = str(self.store.get("ai_api_key", "") or "")
        llm = {
            "enabled": enabled and bool(api_key),
            "base_url": str(self.store.get("ai_base_url", "https://api.openai.com/v1")),
            "api_key": api_key,
            "model": str(self.store.get("ai_model", "gpt-3.5-turbo")),
        }
        hotwords = str(self.store.get("hotwords", "") or "")
        hotword_path = str(self.store.get("hotword_path", "") or "")
        self.backend.send_config(llm=llm, hotwords=hotwords, hotword_path=hotword_path)

    def shutdown(self) -> None:
        self.audio.stop()
        self.backend.stop()
