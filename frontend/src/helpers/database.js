const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// 敏感设置键: 值用 Electron safeStorage 加密后落盘
const SENSITIVE_KEYS = new Set(['ai_api_key']);
// 加密值前缀 (解密失败时回退明文兼容)
const ENC_PREFIX = 'enc:v1:';

class DatabaseManager {
  constructor(logger) {
    this.db = null;
    this.logger = logger;
    this._safeStorage = null; // 延迟 require('electron').safeStorage
  }

  _getSafeStorage() {
    if (this._safeStorage) return this._safeStorage;
    try {
      // 仅在 Electron 主进程可用; 单元测试环境回退 null
      const { safeStorage } = require('electron');
      this._safeStorage = safeStorage.isEncryptionAvailable() ? safeStorage : null;
    } catch (_) { /* non-Electron env */ }
    return this._safeStorage;
  }

  _encrypt(value) {
    const ss = this._getSafeStorage();
    if (!ss || typeof value !== 'string' || !value) return value;
    try {
      return ENC_PREFIX + ss.encryptString(value).toString('base64');
    } catch (e) {
      this.logger?.warn?.('safeStorage 加密失败, 回退明文:', e.message);
      return value;
    }
  }

  _decrypt(value) {
    if (typeof value !== 'string' || !value.startsWith(ENC_PREFIX)) return value;
    const ss = this._getSafeStorage();
    if (!ss) return value;
    try {
      return ss.decryptString(Buffer.from(value.slice(ENC_PREFIX.length), 'base64'));
    } catch (e) {
      this.logger?.warn?.('safeStorage 解密失败 (可能换了系统密钥环):', e.message);
      return value;
    }
  }

  initialize(dataDir) {
    this.dbPath = path.join(dataDir, 'transcriptions.db');
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    // 安全: 数据库含敏感设置, 仅属主可读写
    try { fs.chmodSync(this.dbPath, 0o600); } catch (_) { /* ignore */ }
    this._createTables();
  }

  _createTables() {
    this.db.exec(`
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
      CREATE INDEX IF NOT EXISTS idx_transcriptions_time ON transcriptions(created_at DESC);
    `);
  }

  saveTranscription(data) {
    const text = (data.text || data.raw_text || '').trim();
    if (!text) throw new Error('转录文本不能为空');
    const stmt = this.db.prepare(
      'INSERT INTO transcriptions (text, raw_text, processed_text, confidence, language, duration, file_size) VALUES (?,?,?,?,?,?,?)'
    );
    return stmt.run(text, data.raw_text || null, data.processed_text || null, data.confidence || 0, data.language || 'zh-CN', data.duration || 0, data.file_size || 0);
  }

  getTranscriptions(limit = 50, offset = 0) {
    // 参数校验: 防止 LIMIT -1 拉全表 / 非数字抛异常
    const safeLimit = (Number.isInteger(limit) && limit >= 0 && limit <= 1000) ? limit : 50;
    const safeOffset = (Number.isInteger(offset) && offset >= 0) ? offset : 0;
    return this.db.prepare('SELECT * FROM transcriptions ORDER BY created_at DESC LIMIT ? OFFSET ?').all(safeLimit, safeOffset);
  }

  deleteTranscription(id) {
    const safeId = Number(id);
    if (!Number.isInteger(safeId) || safeId <= 0) throw new Error('非法记录 ID');
    return this.db.prepare('DELETE FROM transcriptions WHERE id = ?').run(safeId);
  }

  clearAllTranscriptions() {
    return this.db.prepare('DELETE FROM transcriptions').run();
  }

  searchTranscriptions(query, limit = 50) {
    const safeQuery = String(query || '').slice(0, 500);
    const safeLimit = (Number.isInteger(limit) && limit > 0 && limit <= 500) ? limit : 50;
    if (!safeQuery) return [];
    const term = `%${safeQuery}%`;
    return this.db.prepare(
      'SELECT * FROM transcriptions WHERE text LIKE ? OR raw_text LIKE ? OR processed_text LIKE ? ORDER BY created_at DESC LIMIT ?'
    ).all(term, term, term, safeLimit);
  }

  setSetting(key, value) {
    const safeKey = String(key || '').slice(0, 128);
    if (!safeKey) throw new Error('非法设置键');
    const stored = SENSITIVE_KEYS.has(safeKey) ? this._encrypt(JSON.stringify(value)) : JSON.stringify(value);
    return this.db.prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?,?,CURRENT_TIMESTAMP)').run(safeKey, stored);
  }

  getSetting(key, defaultValue = null) {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(String(key || ''));
    if (!row) return defaultValue;
    let raw = row.value;
    if (SENSITIVE_KEYS.has(String(key)) && typeof raw === 'string' && raw.startsWith(ENC_PREFIX)) {
      raw = this._decrypt(raw);
    }
    try { return JSON.parse(raw); } catch { return raw; }
  }

  getAllSettings() {
    const rows = this.db.prepare('SELECT key, value FROM settings').all();
    const out = {};
    rows.forEach(r => {
      let raw = r.value;
      if (SENSITIVE_KEYS.has(r.key) && typeof raw === 'string' && raw.startsWith(ENC_PREFIX)) {
        raw = this._decrypt(raw);
      }
      try { out[r.key] = JSON.parse(raw); } catch { out[r.key] = raw; }
    });
    return out;
  }

  // 脱敏视图: 供渲染进程展示, 敏感键只保留掩码
  getSettingsMasked() {
    const all = this.getAllSettings();
    const out = { ...all };
    for (const key of SENSITIVE_KEYS) {
      if (out[key]) out[key] = maskSecret(String(out[key]));
    }
    return out;
  }

  resetSettings() {
    return this.db.prepare('DELETE FROM settings').run();
  }

  close() { if (this.db) { this.db.close(); this.db = null; } }
}

function maskSecret(secret) {
  if (!secret) return '';
  if (secret.length <= 8) return '••••••••';
  return secret.slice(0, 4) + '••••••••' + secret.slice(-4);
}

module.exports = DatabaseManager;
