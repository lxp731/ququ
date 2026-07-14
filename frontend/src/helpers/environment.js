const path = require('path');
const fs = require('fs');
const os = require('os');

class EnvironmentManager {
  constructor() {
    const envPath = path.join(process.cwd(), '.env');
    if (fs.existsSync(envPath)) require('dotenv').config({ path: envPath });
  }

  getDataDirectory() {
    const name = 'ququ';
    const map = { win32: ['AppData', 'Roaming'], darwin: ['Library', 'Application Support'], linux: ['.config'] };
    const segs = map[process.platform] || [`.${name}`];
    return path.join(os.homedir(), ...segs, name);
  }

  ensureDataDirectory() {
    const dir = this.getDataDirectory();
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
}

module.exports = EnvironmentManager;
