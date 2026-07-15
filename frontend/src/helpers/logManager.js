const fs = require('fs');
const path = require('path');
const os = require('os');

class LogManager {
  constructor() {
    let dataDir;
    if (process.platform === 'win32') {
      dataDir = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'ququ');
    } else if (process.platform === 'darwin') {
      dataDir = path.join(os.homedir(), 'Library', 'Application Support', 'ququ');
    } else {
      dataDir = path.join(os.homedir(), '.config', 'ququ');
    }
    this.logDir = path.join(dataDir, 'logs');
    this.logFile = path.join(this.logDir, 'app.log');
    this.funasrLogFile = path.join(this.logDir, 'funasr.log');
    try { fs.mkdirSync(this.logDir, { recursive: true }); } catch (_) {}
  }

  _write(level, message, data = null, file = null) {
    const entry = { timestamp: new Date().toISOString(), level, message, data, pid: process.pid };
    const line = JSON.stringify(entry) + '\n';
    console[level](`[${entry.timestamp}] ${message}`, data ?? '');
    try { fs.appendFileSync(file || this.logFile, line); } catch (_) {}
  }

  info(msg, data) { this._write('info', msg, data); }
  error(msg, data) { this._write('error', msg, data); }
  warn(msg, data) { this._write('warn', msg, data); }
  debug(msg, data) { this._write('debug', msg, data); }
  logFunASR(level, message, data) {
    this._write(level, `[FunASR] ${message}`, data, this.funasrLogFile);
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
