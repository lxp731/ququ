"""SQLite 持久化 — 与 Electron 版兼容的 schema。

表结构：
- transcriptions(id, text, raw_text, processed_text, confidence, language,
  duration, file_size, created_at, updated_at)
- settings(key, value, updated_at)  # value 为 JSON 序列化字符串

注意：与 Electron 版共享同一个 ~/.config/ququ/transcriptions.db 文件，
因此两个版本可交替使用、数据互通。
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any

from . import paths

# 允许写入的设置键白名单（与 Electron ipcHandlers 一致）
ALLOWED_SETTING_KEYS = {
    "ai_api_key", "ai_base_url", "ai_model", "enable_ai_optimization",
    "hotwords", "hotword_path", "hotwords_count", "funasr_base_url",
    "global_hotkey", "recording_mode",
}

# 敏感键（Electron 版用 safeStorage 加密，GTK 版暂以明文兼容）
SENSITIVE_KEYS = {"ai_api_key"}
_ENC_PREFIX = "enc:v1:"


class SettingsStore:
    """key-value 设置 + 转录历史存取。线程安全由 sqlite3 默认串行保证。"""

    def __init__(self, db_file: Path | None = None):
        self.db_file = db_file or paths.db_path()
        self.db_file.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(str(self.db_file), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        try:
            self.db_file.chmod(0o600)
        except OSError:
            pass
        self._create_tables()

    def _create_tables(self) -> None:
        self._conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS transcriptions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                text TEXT NOT NULL,
                raw_text TEXT,
                processed_text TEXT,
                confidence REAL DEFAULT 0,
                language TEXT DEFAULT 'zh-CN',
                duration REAL DEFAULT 0,
                file_size INTEGER DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS idx_transcriptions_time
                ON transcriptions(created_at DESC);
            """
        )
        self._conn.commit()

    # ── 设置 ──────────────────────────────────────────

    def get(self, key: str, default: Any = None) -> Any:
        row = self._conn.execute(
            "SELECT value FROM settings WHERE key = ?", (key,)
        ).fetchone()
        if row is None:
            return default
        raw = row["value"]
        if isinstance(raw, str) and raw.startswith(_ENC_PREFIX):
            # Electron safeStorage 加密值 — GTK 无法解密，返回脱敏占位
            return "••••••••"
        try:
            return json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            return raw

    def set(self, key: str, value: Any) -> bool:
        if key not in ALLOWED_SETTING_KEYS:
            return False
        stored = json.dumps(value, ensure_ascii=False)
        self._conn.execute(
            "INSERT OR REPLACE INTO settings (key, value, updated_at) "
            "VALUES (?, ?, CURRENT_TIMESTAMP)",
            (key, stored),
        )
        self._conn.commit()
        return True

    def get_all(self) -> dict[str, Any]:
        rows = self._conn.execute("SELECT key, value FROM settings").fetchall()
        out: dict[str, Any] = {}
        for r in rows:
            raw = r["value"]
            if isinstance(raw, str) and raw.startswith(_ENC_PREFIX):
                out[r["key"]] = "••••••••"
                continue
            try:
                out[r["key"]] = json.loads(raw)
            except (json.JSONDecodeError, TypeError):
                out[r["key"]] = raw
        return out

    # ── 转录历史 ──────────────────────────────────────

    def save_transcription(self, data: dict[str, Any]) -> int:
        text = (data.get("text") or data.get("raw_text") or "").strip()
        if not text:
            raise ValueError("转录文本不能为空")
        cur = self._conn.execute(
            "INSERT INTO transcriptions "
            "(text, raw_text, processed_text, confidence, language, duration, file_size) "
            "VALUES (?,?,?,?,?,?,?)",
            (
                text,
                data.get("raw_text"),
                data.get("processed_text"),
                data.get("confidence", 0),
                data.get("language", "zh-CN"),
                data.get("duration", 0),
                data.get("file_size", 0),
            ),
        )
        self._conn.commit()
        return cur.lastrowid

    def get_transcriptions(self, limit: int = 50, offset: int = 0) -> list[dict[str, Any]]:
        limit = limit if isinstance(limit, int) and 0 <= limit <= 1000 else 50
        offset = offset if isinstance(offset, int) and offset >= 0 else 0
        rows = self._conn.execute(
            "SELECT * FROM transcriptions ORDER BY created_at DESC LIMIT ? OFFSET ?",
            (limit, offset),
        ).fetchall()
        return [dict(r) for r in rows]

    def search_transcriptions(self, query: str, limit: int = 50) -> list[dict[str, Any]]:
        q = str(query or "")[:500]
        if not q:
            return []
        limit = limit if isinstance(limit, int) and 0 < limit <= 500 else 50
        term = f"%{q}%"
        rows = self._conn.execute(
            "SELECT * FROM transcriptions WHERE text LIKE ? OR raw_text LIKE ? "
            "OR processed_text LIKE ? ORDER BY created_at DESC LIMIT ?",
            (term, term, term, limit),
        ).fetchall()
        return [dict(r) for r in rows]

    def delete_transcription(self, tid: int) -> bool:
        if not isinstance(tid, int) or tid <= 0:
            return False
        self._conn.execute("DELETE FROM transcriptions WHERE id = ?", (tid,))
        self._conn.commit()
        return True

    def clear_all(self) -> None:
        self._conn.execute("DELETE FROM transcriptions")
        self._conn.commit()

    def close(self) -> None:
        try:
            self._conn.close()
        except sqlite3.Error:
            pass
