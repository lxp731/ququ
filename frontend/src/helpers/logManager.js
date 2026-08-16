const fs = require('fs');
const path = require('path');
const os = require('os');

const MAX_LOG_BYTES = 5 * 1024 * 1024; // 单文件 5MB, 超出轮转
const VALID_LEVELS = new Set(['info', 'error', 'warn', 'debug']);

class LogManager {
  constructor() {
    this.dataDir = this._getDataDir();
    this.logDir = path.join(this.dataDir, 'logs');
    this.logFile = path.join(this.logDir, 'app.log');
    this.funasrLogFile = path.join(this.logDir, 'funasr.log');
    try {
      fs.mkdirSync(this.logDir, { recursive: true });
      fs.chmodSync(this.logDir, 0o700);
    } catch (_) { /* ignore */ }
  }

  // 与 environment.js 统一: userData 目录
  _getDataDir() {
    try {
      const { app } = require('electron');
      return app.getPath('userData');
    } catch (_) { /* non-Electron env */
      const map = { win32: ['AppData', 'Roaming'], darwin: ['Library', 'Application Support'], linux: ['.config'] };
      const segs = map[process.platform] || ['.ququ'];
      return path.join(os.homedir(), ...segs, 'ququ');
    }
  }

  _rotateIfNeeded(file) {
    try {
      const st = fs.statSync(file);
      if (st.size > MAX_LOG_BYTES) {
        fs.renameSync(file, `${file}.1`);
      }
    } catch (_) { /* 不存在则无需轮转 */ }
  }

  _write(level, message, data = null, file = null) {
    const entry = { timestamp: new Date().toISOString(), level, message, data, pid: process.pid };
    const line = JSON.stringify(entry) + '\n';
    try { console[level](`[${entry.timestamp}] ${message}`, data ?? ''); } catch (_) { /* ignore */ }
    try {
      const target = file || this.logFile;
      this._rotateIfNeeded(target);
      fs.appendFileSync(target, line);
    } catch (_) { /* ignore */ }
  }

  info(msg, data) { this._write('info', msg, data); }
  error(msg, data) { this._write('error', msg, data); }
  warn(msg, data) { this._write('warn', msg, data); }
  debug(msg, data) { this._write('debug', msg, data); }
  logFunASR(level, message, data) {
    let lv = String(level || '');
    if (!VALID_LEVELS.has(lv)) lv = 'info';
    this._write(lv, `[FunASR] ${message}`, data, this.funasrLogFile);
  }

  getRecentLogs(lines = 100) {
    try { return fs.readFileSync(this.logFile, 'utf8').trim().split('\n').slice(-lines).map(l => { try { return JSON.parse(l); } catch { return { message: l }; } }); } catch { return []; }
  }

  getLogFilePath() { return this.logFile; }
  getFunASRLogFilePath() { return this.funasrLogFile; }

  getSystemInfo() {
    return {
      platform: process.platform, arch: process.arch, nodeVersion: process.version,
      electronVersion: process.versions.electron, logDir: this.logDir,
      env: { NODE_ENV: process.env.NODE_ENV },
    };
  }
}

module.exports = LogManager;
