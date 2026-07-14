const { BrowserWindow } = require('electron');
const path = require('path');

const PRELOAD = path.join(__dirname, '..', '..', 'preload.js');
const ICON = path.join(__dirname, '..', '..', 'assets', 'icon.png');
const IS_DEV = process.env.NODE_ENV === 'development';

class WindowManager {
  constructor() {
    this.mainWindow = null;
    this.controlPanelWindow = null;
    this.historyWindow = null;
    this.settingsWindow = null;
  }

  _load(w, devUrl, prodPath, query) {
    if (IS_DEV) {
      w.loadURL(devUrl);
    } else {
      w.loadFile(path.join(__dirname, '..', '..', 'dist', 'src', prodPath), query ? { query } : undefined);
    }
  }

  async createMainWindow() {
    if (this.mainWindow) { this.mainWindow.focus(); return this.mainWindow; }
    this.mainWindow = new BrowserWindow({
      width: 420, height: 580,
      frame: true,
      alwaysOnTop: true, resizable: true, skipTaskbar: true, icon: ICON,
      show: false,
      backgroundColor: '#0f172a',
      title: '蛐蛐 - 中文语音转文字',
      webPreferences: {
        nodeIntegration: false, contextIsolation: true, preload: PRELOAD,
        devTools: true,
      },
    });
    this._load(this.mainWindow, 'http://localhost:5173', 'index.html');

    this.mainWindow.once('ready-to-show', () => {
      this.mainWindow?.show();
      this.mainWindow?.focus();
    });

    const forceShowTimer = setTimeout(() => {
      if (this.mainWindow && !this.mainWindow.isVisible()) {
        this.mainWindow.show();
        this.mainWindow.focus();
      }
    }, 3000);

    this.mainWindow.on('closed', () => {
      clearTimeout(forceShowTimer);
      this.mainWindow = null;
    });
    return this.mainWindow;
  }

  async createControlPanelWindow() {
    if (this.controlPanelWindow) { this.controlPanelWindow.focus(); return this.controlPanelWindow; }
    this.controlPanelWindow = new BrowserWindow({
      width: 860, height: 660, show: false, icon: ICON,
      title: '蛐蛐 - 控制面板',
      webPreferences: { nodeIntegration: false, contextIsolation: true, preload: PRELOAD },
    });
    this._load(this.controlPanelWindow, 'http://localhost:5173?panel=control', 'index.html', { panel: 'control' });
    this.controlPanelWindow.on('closed', () => { this.controlPanelWindow = null; });
    return this.controlPanelWindow;
  }

  async createHistoryWindow() {
    if (this.historyWindow) { this.historyWindow.focus(); return this.historyWindow; }
    this.historyWindow = new BrowserWindow({
      width: 1000, height: 700, show: false, alwaysOnTop: true,
      title: '转录历史 - 蛐蛐', icon: ICON,
      webPreferences: { nodeIntegration: false, contextIsolation: true, preload: PRELOAD },
    });
    if (IS_DEV) {
      this.historyWindow.loadURL('http://localhost:5173/history.html');
    } else {
      this.historyWindow.loadFile(path.join(__dirname, '..', '..', 'dist', 'src', 'history.html'));
    }
    this.historyWindow.on('closed', () => { this.historyWindow = null; });
    return this.historyWindow;
  }

  async createSettingsWindow() {
    if (this.settingsWindow) { this.settingsWindow.focus(); return this.settingsWindow; }
    this.settingsWindow = new BrowserWindow({
      width: 720, height: 640, show: false, alwaysOnTop: true,
      title: '设置 - 蛐蛐', icon: ICON,
      webPreferences: { nodeIntegration: false, contextIsolation: true, preload: PRELOAD },
    });
    if (IS_DEV) {
      this.settingsWindow.loadURL('http://localhost:5173?page=settings');
    } else {
      this.settingsWindow.loadFile(path.join(__dirname, '..', '..', 'dist', 'src', 'settings.html'));
    }
    this.settingsWindow.on('closed', () => { this.settingsWindow = null; });
    return this.settingsWindow;
  }

  showControlPanel() {
    if (this.controlPanelWindow) { this.controlPanelWindow.show(); this.controlPanelWindow.focus(); }
    else this.createControlPanelWindow().then(() => { this.controlPanelWindow?.show(); });
  }

  hideControlPanel() { this.controlPanelWindow?.hide(); }

  showHistoryWindow() {
    if (this.historyWindow) { this.historyWindow.show(); this.historyWindow.focus(); }
    else this.createHistoryWindow().then(() => { this.historyWindow?.show(); this.historyWindow?.focus(); });
  }

  hideHistoryWindow() { this.historyWindow?.hide(); }
  closeHistoryWindow() { this.historyWindow?.close(); }

  showSettingsWindow() {
    if (this.settingsWindow) { this.settingsWindow.show(); this.settingsWindow.focus(); }
    else this.createSettingsWindow().then(() => { this.settingsWindow?.show(); this.settingsWindow?.focus(); });
  }

  hideSettingsWindow() { this.settingsWindow?.hide(); }
  closeSettingsWindow() { this.settingsWindow?.close(); }

  closeAllWindows() {
    this.mainWindow?.close();
    this.controlPanelWindow?.close();
    this.historyWindow?.close();
    this.settingsWindow?.close();
  }
}

module.exports = WindowManager;
