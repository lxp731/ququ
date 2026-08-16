const path = require('path');
const fs = require('fs');
const os = require('os');

class EnvironmentManager {
  constructor() {
    const envPath = this._getEnvPath();
    if (fs.existsSync(envPath)) require('dotenv').config({ path: envPath });
  }

  // .env 固定在应用资源目录下查找, 不依赖进程 cwd (打包后 cwd 不可控)
  _getEnvPath() {
    try {
      const { app } = require('electron');
      return path.join(app.getAppPath(), '.env');
    } catch (_) { /* non-Electron env */
      return path.join(process.cwd(), '.env');
    }
  }

  // 与 logManager.js 统一: 使用 Electron userData 目录
  getDataDirectory() {
    try {
      const { app } = require('electron');
      return app.getPath('userData');
    } catch (_) { /* non-Electron env */
      const name = 'ququ';
      const map = { win32: ['AppData', 'Roaming'], darwin: ['Library', 'Application Support'], linux: ['.config'] };
      const segs = map[process.platform] || [`.${name}`];
      return path.join(os.homedir(), ...segs, name);
    }
  }

  ensureDataDirectory() {
    const dir = this.getDataDirectory();
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
}

module.exports = EnvironmentManager;
