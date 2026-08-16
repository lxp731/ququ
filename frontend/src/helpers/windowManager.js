const { BrowserWindow, screen } = require('electron');
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
    this.floatingWindow = null;
    this._floatingPos = null;  // 用户拖拽后记住的位置 {x, y}
    this._floatingHideTimer = null; // 延迟隐藏定时器句柄
    this._forceQuit = false;
  }

  _load(w, devUrl, prodPath, query) {
    if (IS_DEV) {
      w.loadURL(devUrl);
    } else {
      w.loadFile(path.join(__dirname, '..', '..', 'dist', prodPath), query ? { query } : undefined);
    }
  }

  // 安全守卫: 阻止窗口导航到任意 URL / 打开新窗口
  _harden(w) {
    w.webContents.setWindowOpenHandler(({ url }) => {
      // 只允许本应用页面; 其余一律拒绝
      if (url.startsWith('file://') || url.startsWith('http://localhost:') || url.startsWith('http://127.0.0.1:')) {
        return { action: 'allow' };
      }
      return { action: 'deny' };
    });
    w.webContents.on('will-navigate', (event, url) => {
      const current = w.webContents.getURL();
      if (url === current) return;
      if (!(url.startsWith('file://') || url.startsWith('http://localhost:') || url.startsWith('http://127.0.0.1:'))) {
        event.preventDefault();
      }
    });
  }

  async createMainWindow() {
    if (this.mainWindow) { this.mainWindow.focus(); return this.mainWindow; }
    this.mainWindow = new BrowserWindow({
      width: 420, height: 580,
      frame: true,
      resizable: true, skipTaskbar: true, icon: ICON,
      show: false,
      backgroundColor: '#0f172a',
      title: '蛐蛐 - 中文语音转文字',
      webPreferences: {
        nodeIntegration: false, contextIsolation: true, sandbox: true, preload: PRELOAD,
        devTools: IS_DEV,
      },
    });
    this._load(this.mainWindow, 'http://localhost:5173', 'index.html');
    this._harden(this.mainWindow);

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

    // 关闭 → 隐藏到托盘，不销毁（托盘期间仍需 webContents 通信）
    this.mainWindow.on('close', (e) => {
      if (this._forceQuit) return; // 用户主动退出，不拦截
      e.preventDefault();
      this.mainWindow?.hide();
    });
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
      width: 1000, height: 700, show: false,
      title: '转录历史 - 蛐蛐', icon: ICON,
      webPreferences: { nodeIntegration: false, contextIsolation: true, preload: PRELOAD },
    });
    if (IS_DEV) {
      this.historyWindow.loadURL('http://localhost:5173/history.html');
    } else {
      this.historyWindow.loadFile(path.join(__dirname, '..', '..', 'dist', 'history.html'));
    }
    this.historyWindow.on('closed', () => { this.historyWindow = null; });
    return this.historyWindow;
  }

  async createSettingsWindow() {
    if (this.settingsWindow) { this.settingsWindow.focus(); return this.settingsWindow; }
    this.settingsWindow = new BrowserWindow({
      width: 720, height: 640, show: false,
      title: '设置 - 蛐蛐', icon: ICON,
      webPreferences: { nodeIntegration: false, contextIsolation: true, preload: PRELOAD },
    });
    if (IS_DEV) {
      this.settingsWindow.loadURL('http://localhost:5173?page=settings');
    } else {
      this.settingsWindow.loadFile(path.join(__dirname, '..', '..', 'dist', 'settings.html'));
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

  // ═══════════════════════════════════════════════════════════════
  //  浮动三区预览窗
  // ═══════════════════════════════════════════════════════════════
  //
  // 独立 frameless BrowserWindow，透明底、始终置顶、不抢焦点。
  // 文字区域鼠标穿透（CSS pointer-events: none），顶部拖拽手柄可拖动。
  //
  // 默认位置：屏幕底部居中。可拖拽到任意位置，每次显示会回到默认位置。

  async createFloatingWindow() {
    if (this.floatingWindow) return this.floatingWindow;
    this.floatingWindow = new BrowserWindow({
      width: 620, height: 140,
      frame: false, transparent: true, alwaysOnTop: true,
      skipTaskbar: true, focusable: false, resizable: false,
      show: false, hasShadow: false,
      webPreferences: {
        nodeIntegration: false, contextIsolation: true, sandbox: true, preload: PRELOAD,
        devTools: IS_DEV,
      },
    });

    if (IS_DEV) {
      this.floatingWindow.loadURL('http://localhost:5173/floating.html');
    } else {
      this.floatingWindow.loadFile(path.join(__dirname, '..', '..', 'dist', 'floating.html'));
    }

    // 阻止键盘事件被浮动窗捕获
    this.floatingWindow.webContents.on('before-input-event', (_e, input) => {
      if (input.type === 'keyDown') _e.preventDefault();
    });

      // 拖拽后记住位置，下次显示时复用（仅在窗口可见时记录）
    this.floatingWindow.on('move', () => {
      if (this.floatingWindow && this.floatingWindow.isVisible()) {
        const pos = this.floatingWindow.getPosition();
        this._floatingPos = { x: pos[0], y: pos[1] };
      }
    });

    this.floatingWindow.on('closed', () => { this.floatingWindow = null; });

    return this.floatingWindow;
  }

  // 定位：优先使用用户拖拽记住的位置，否则默认屏幕底部居中
  _positionFloating() {
    if (!this.floatingWindow) return;
    if (this._floatingPos) {
      this.floatingWindow.setPosition(this._floatingPos.x, this._floatingPos.y);
      return;
    }
    const { x, y, width, height } = screen.getPrimaryDisplay().workArea;
    const [w, h] = this.floatingWindow.getSize();
    const px = x + Math.round((width - w) / 2);
    const py = y + height - h - 40;
    this.floatingWindow.setPosition(px, py);
  }

  async showFloatingWindow() {
    if (!this.floatingWindow) {
      await this.createFloatingWindow();
    }
    // 取消可能挂起的隐藏定时器, 防止 10s 后误隐藏
    if (this._floatingHideTimer) {
      clearTimeout(this._floatingHideTimer);
      this._floatingHideTimer = null;
    }
    this._positionFloating();
    this.floatingWindow?.show();
    this.floatingWindow?.webContents.send('floating-visibility-change', true);
    this.floatingWindow?.setAlwaysOnTop(true);
  }

  hideFloatingWindow() {
    this.floatingWindow?.webContents.send('floating-visibility-change', false);
    // 10s 安全兜底，正常情况 hover 逻辑在 floating.html 里控制实际消失时机
    if (this._floatingHideTimer) clearTimeout(this._floatingHideTimer);
    this._floatingHideTimer = setTimeout(() => {
      this._floatingHideTimer = null;
      this.floatingWindow?.hide();
    }, 10000);
  }

  updateFloatingPreedit(data) {
    if (this.floatingWindow && !this.floatingWindow.isDestroyed()) {
      this.floatingWindow.webContents.send('floating-preedit-update', data);
    }
  }

  // JS 拖拽：接收 renderer 传来的位移增量
  moveFloatingWindow(dx, dy) {
    if (this.floatingWindow && !this.floatingWindow.isDestroyed()) {
      const [x, y] = this.floatingWindow.getPosition();
      this.floatingWindow.setPosition(x + dx, y + dy);
    }
  }

  closeFloatingWindow() {
    this.floatingWindow?.close();
  }

  forceQuit() {
    this._forceQuit = true;
    this.closeAllWindows();
  }

  closeAllWindows() {
    this.mainWindow?.close();
    this.controlPanelWindow?.close();
    this.historyWindow?.close();
    this.settingsWindow?.close();
    this.floatingWindow?.close();
  }
}

module.exports = WindowManager;
