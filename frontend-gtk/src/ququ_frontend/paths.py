"""常量与数据目录。

与 Electron 版保持一致的数据目录 (~/.config/ququ)，确保转录历史与设置可迁移。
"""

from __future__ import annotations

import os
from pathlib import Path

APP_NAME = "ququ"
APP_TITLE = "蛐蛐 (QuQu)"
APP_VERSION = "0.1.0"

DEFAULT_BASE_URL = "http://127.0.0.1:8000"
DEFAULT_HOTKEY = "Ctrl+Space"
DEFAULT_RECORDING_MODE = "toggle"  # toggle | hold

SAMPLE_RATE = 16000
CHANNELS = 1
CHUNK_MS = 100  # 每帧 100ms
CHUNK_SAMPLES = int(SAMPLE_RATE * CHUNK_MS / 1000)  # 1600


def data_dir() -> Path:
    """用户数据目录 (~/.config/ququ)。"""
    d = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / APP_NAME
    d.mkdir(parents=True, exist_ok=True)
    return d


def db_path() -> Path:
    return data_dir() / "transcriptions.db"


def log_dir() -> Path:
    d = data_dir() / "logs"
    d.mkdir(parents=True, exist_ok=True)
    return d
