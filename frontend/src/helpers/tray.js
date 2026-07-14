const { Tray, Menu, nativeImage, app } = require('electron');
const path = require('path');
const fs = require('fs');

class TrayManager {
  constructor(logger) {
    this.logger = logger;
    this.tray = null;
    this.mainWindow = null;
    this.settingsWindow = null;
    this.onShowSettings = null;
    this.onQuit = null;
  }

  setWindows(main, settings) { this.mainWindow = main; this.settingsWindow = settings; }
  setCreateSettingsCallback(cb) { this.onShowSettings = cb; }
  setQuitCallback(cb) { this.onQuit = cb; }

  async createTray() {
    const iconPath = path.join(__dirname, '..', '..', 'assets', 'icon.png');
    let icon = nativeImage.createEmpty();
    if (fs.existsSync(iconPath)) {
      icon = nativeImage.createFromPath(iconPath);
      icon = icon.resize({ width: process.platform === 'darwin' ? 16 : 22, height: process.platform === 'darwin' ? 16 : 22 });
    }
    this.tray = new Tray(icon);
    this.tray.setToolTip('蛐蛐 - 中文语音转文字');
    this._updateMenu();
    this.tray.on('click', () => {
      if (!this.mainWindow) return;
      this.mainWindow.isVisible() ? this.mainWindow.hide() : (this.mainWindow.show(), this.mainWindow.focus());
    });
    this.tray.on('right-click', () => this.tray?.popUpContextMenu());
  }

  _updateMenu() {
    if (!this.tray) return;
    this.tray.setContextMenu(Menu.buildFromTemplate([
      { label: '显示主窗口', click: () => { this.mainWindow?.show(); this.mainWindow?.focus(); } },
      { label: '设置', click: () => { this.settingsWindow ? (this.settingsWindow.show(), this.settingsWindow.focus()) : this.onShowSettings?.(); } },
      { type: 'separator' },
      { label: '退出蛐蛐', click: () => { if (this.onQuit) this.onQuit(); else app.quit(); } },
    ]));
  }

  setStatus(s) {
    if (!this.tray) return;
    const tips = { recording: '蛐蛐 - 正在录音...', processing: '蛐蛐 - 正在处理...' };
    this.tray.setToolTip(tips[s] || '蛐蛐 - 中文语音转文字');
  }

  destroy() { this.tray?.destroy(); this.tray = null; }
}

module.exports = TrayManager;
