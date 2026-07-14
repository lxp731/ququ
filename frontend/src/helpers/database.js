const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

class DatabaseManager {
  constructor(logger) {
    this.db = null;
    this.logger = logger;
  }

  initialize(dataDir) {
    this.dbPath = path.join(dataDir, 'transcriptions.db');
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
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
    return this.db.prepare('SELECT * FROM transcriptions ORDER BY created_at DESC LIMIT ? OFFSET ?').all(limit, offset);
  }

  deleteTranscription(id) {
    return this.db.prepare('DELETE FROM transcriptions WHERE id = ?').run(id);
  }

  clearAllTranscriptions() {
    return this.db.prepare('DELETE FROM transcriptions').run();
  }

  searchTranscriptions(query, limit = 50) {
    const term = `%${query}%`;
    return this.db.prepare(
      'SELECT * FROM transcriptions WHERE text LIKE ? OR raw_text LIKE ? OR processed_text LIKE ? ORDER BY created_at DESC LIMIT ?'
    ).all(term, term, term, limit);
  }

  setSetting(key, value) {
    return this.db.prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?,?,CURRENT_TIMESTAMP)').run(key, JSON.stringify(value));
  }

  getSetting(key, defaultValue = null) {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    if (!row) return defaultValue;
    try { return JSON.parse(row.value); } catch { return row.value; }
  }

  getAllSettings() {
    const rows = this.db.prepare('SELECT key, value FROM settings').all();
    const out = {};
    rows.forEach(r => { try { out[r.key] = JSON.parse(r.value); } catch { out[r.key] = r.value; } });
    return out;
  }

  resetSettings() {
    return this.db.prepare('DELETE FROM settings').run();
  }

  close() { if (this.db) { this.db.close(); this.db = null; } }
}

module.exports = DatabaseManager;
