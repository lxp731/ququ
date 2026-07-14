const { app, globalShortcut, BrowserWindow } = require('electron');
const path = require('path');

const LogManager = require('./src/helpers/logManager');
const EnvironmentManager = require('./src/helpers/environment');
const WindowManager = require('./src/helpers/windowManager');
const DatabaseManager = require('./src/helpers/database');
const ClipboardManager = require('./src/helpers/clipboard');
const FunASRManager = require('./src/helpers/funasrManager');
const TrayManager = require('./src/helpers/tray');
const HotkeyManager = require('./src/helpers/hotkeyManager');
const IPCHandlers = require('./src/helpers/ipcHandlers');
const KeyWatcher = require('./src/helpers/keyWatcher');

const logger = new LogManager();
const env = new EnvironmentManager();
const wm = new WindowManager();
const db = new DatabaseManager(logger);
const clip = new ClipboardManager(logger);
const funasr = new FunASRManager(logger);
const tray = new TrayManager(logger);
const hotkey = new HotkeyManager(logger);
const keyWatcher = new KeyWatcher(logger);

// 初始化数据库
db.initialize(env.ensureDataDirectory());

// 初始化 IPC
new IPCHandlers({ databaseManager: db, clipboardManager: clip, funasrManager: funasr, windowManager: wm, hotkeyManager: hotkey, keyWatcher, logger });

// 全局错误处理
process.on('uncaughtException', (e) => { if (e.code !== 'EPIPE') logger.error('Uncaught Exception:', e); });
process.on('unhandledRejection', (r) => logger.error('Unhandled Rejection:', r));

async function startApp() {
  logger.info('应用启动', { platform: process.platform, arch: process.arch, electron: process.versions.electron });

  if (process.env.NODE_ENV === 'development') {
    await new Promise(r => setTimeout(r, 2000));
  }

  // macOS dock
  if (process.platform === 'darwin' && app.dock) app.dock.show();

  // 异步启动 FunASR 容器
  funasr.initializeAtStartup().catch(e => logger.warn('FunASR 容器暂不可用:', e.message));

  // 创建窗口
  try { await wm.createMainWindow(); logger.info('主窗口创建成功'); } catch (e) { logger.error('主窗口创建失败:', e); }
  try { await wm.createControlPanelWindow(); logger.info('控制面板窗口创建成功'); } catch (e) { logger.error('控制面板创建失败:', e); }

  // 托盘
  tray.setWindows(wm.mainWindow, wm.controlPanelWindow);
  tray.setCreateControlPanelCallback(() => wm.createControlPanelWindow());
  await tray.createTray();

  logger.info('应用启动完成');
}

app.whenReady().then(startApp);

app.on('window-all-closed', () => {
  // 不退出，保留在托盘
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) wm.createMainWindow();
});

app.on('will-quit', async () => {
  globalShortcut.unregisterAll();
  keyWatcher.stop();
  try { await funasr._runCompose(['down']); } catch (_) {}
});
