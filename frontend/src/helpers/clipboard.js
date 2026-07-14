const { clipboard } = require('electron');
const { spawn } = require('child_process');

class ClipboardManager {
  constructor(logger) {
    this.logger = logger;
  }

  _log(msg, data) {
    try { this.logger?.info(msg, data); } catch (e) { if (e.code !== 'EPIPE') console.log(msg); }
  }

  async copyText(text) {
    clipboard.writeText(text);
    return { success: true };
  }

  async writeClipboard(text) {
    clipboard.writeText(text);
    return { success: true };
  }

  async readClipboard() {
    return clipboard.readText();
  }

  async pasteText(text) {
    clipboard.writeText(text);
    this._log('📋 文本已写入剪贴板');

    if (process.platform === 'linux') {
      return this._pasteLinux();
    } else if (process.platform === 'darwin') {
      return this._pasteMacOS();
    } else if (process.platform === 'win32') {
      return this._pasteWindows();
    }
    throw new Error('不支持的操作系统');
  }

  _pasteLinux() {
    return new Promise((resolve, reject) => {
      // 先等剪贴板写入完成，再模拟 Ctrl+V
      setTimeout(() => {
        const proc = spawn('xdotool', ['key', '--clearmodifiers', 'ctrl+v']);
        proc.on('close', (code) => {
          code === 0 ? resolve({ success: true }) : reject(new Error('粘贴失败，文本已复制到剪贴板，请手动 Ctrl+V'));
        });
        proc.on('error', () => reject(new Error('xdotool 不可用，文本已复制到剪贴板，请手动 Ctrl+V')));
      }, 200);
    });
  }

  _pasteMacOS() {
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        const proc = spawn('osascript', ['-e', 'tell application "System Events" to keystroke "v" using command down']);
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; proc.kill(); reject(new Error('粘贴超时，文本已复制到剪贴板，请手动 Cmd+V')); }, 3000);
        proc.on('close', (code) => {
          if (timedOut) return;
          clearTimeout(timer);
          code === 0 ? resolve({ success: true }) : reject(new Error('粘贴失败，文本已复制到剪贴板，请手动 Cmd+V'));
        });
        proc.on('error', () => { clearTimeout(timer); reject(new Error('粘贴失败，文本已复制到剪贴板，请手动 Cmd+V')); });
      }, 200);
    });
  }

  _pasteWindows() {
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        const proc = spawn('powershell', ['-Command', 'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait("^v")']);
        proc.on('close', (code) => {
          code === 0 ? resolve({ success: true }) : reject(new Error('粘贴失败，文本已复制到剪贴板，请手动 Ctrl+V'));
        });
        proc.on('error', () => reject(new Error('粘贴失败，文本已复制到剪贴板，请手动 Ctrl+V')));
      }, 200);
    });
  }

  async checkAccessibilityPermissions() {
    if (process.platform !== 'darwin') return true;
    return new Promise((resolve) => {
      const proc = spawn('osascript', ['-e', 'tell application "System Events" to get name of first process']);
      proc.on('close', (code) => resolve(code === 0));
      proc.on('error', () => resolve(false));
    });
  }

  openSystemSettings() {
    spawn('open', ['x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility']);
  }
}

module.exports = ClipboardManager;
