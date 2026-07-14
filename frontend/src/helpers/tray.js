const { Tray, Menu, nativeImage, app } = require('electron');
const path = require('path');
const fs = require('fs');

class TrayManager {
  constructor(logger) {
    this.logger = logger;
    this.tray = null;
    this.mainWindow = null;
    this.controlPanelWindow = null;
    this.onShowControlPanel = null;
  }

  setWindows(main, ctrl) { this.mainWindow = main; this.controlPanelWindow = ctrl; }
  setCreateControlPanelCallback(cb) { this.onShowControlPanel = cb; }

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
      { label: '控制面板', click: () => { this.controlPanelWindow ? (this.controlPanelWindow.show(), this.controlPanelWindow.focus()) : this.onShowControlPanel?.(); } },
      { type: 'separator' },
      { label: '退出蛐蛐', click: () => app.quit() },
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
