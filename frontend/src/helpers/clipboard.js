const { clipboard } = require('electron');
const { spawn, execSync } = require('child_process');
const fs = require('fs');

class ClipboardManager {
  constructor(logger) {
    this.logger = logger;
    this._pasteCmd = null; // 缓存的 paste 命令
  }

  _log(msg, data) {
    try { this.logger?.info(msg, data); } catch (e) { if (e.code !== 'EPIPE') console.log(msg); }
  }

  // 检测可用的粘贴工具，返回可用列表（逐个尝试）
  _detectPasteTools() {
    if (this._pasteCmd) return this._pasteCmd;
    const tools = [];
    // ydotool (Wayland/X11) — 需要 ydotoold 真正在运行
    try {
      execSync('pgrep -x ydotoold', { stdio: 'ignore' });
      tools.push({ name: 'ydotool', paste: () => spawn('ydotool', ['key', '29:1', '47:1', '47:0', '29:0']) });
    } catch {}
    // wtype (Wayland native)
    try { execSync('which wtype', { stdio: 'ignore' }); tools.push({ name: 'wtype', paste: () => spawn('wtype', ['-M', 'ctrl', 'v', '-m', 'ctrl']) }); } catch {}
    // xdotool (X11/XWayland)
    try { execSync('which xdotool', { stdio: 'ignore' }); tools.push({ name: 'xdotool', paste: () => spawn('xdotool', ['key', '--clearmodifiers', 'ctrl+v']) }); } catch {}
    this._pasteCmd = tools;
    this._log('📋 可用粘贴工具: ' + tools.map(t => t.name).join(', ') || '无');
    return tools;
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
    // 确保 ydotoold 在运行
    try {
      const { execSync } = require('child_process');
      execSync('pgrep -x ydotoold', { stdio: 'ignore' });
    } catch {
      // daemon 没运行，尝试启动
      try {
        const sock = '/run/user/' + process.getuid() + '/.ydotool_socket';
        try { fs.unlinkSync(sock); } catch {}
        spawn('ydotoold', [], { detached: true, stdio: 'ignore' }).unref();
      } catch {}
    }

    const tools = this._detectPasteTools();
    return new Promise((resolve) => {
      setTimeout(() => {
        const tryNext = (i) => {
          if (i >= tools.length) {
            this._log('⚠️ 无可用的粘贴工具，文字已在剪贴板中');
            resolve({ success: true, pasted: false });
            return;
          }
          const tool = tools[i];
          this._log('尝试粘贴: ' + tool.name);
          const proc = tool.paste();
          proc.on('close', (code) => {
            if (code === 0) {
              this._log('粘贴成功: ' + tool.name);
              resolve({ success: true, pasted: true, tool: tool.name });
            } else {
              this._log('粘贴失败: ' + tool.name + ' (code=' + code + ')');
              tryNext(i + 1);
            }
          });
          proc.on('error', (e) => {
            this._log('粘贴错误: ' + tool.name + ' - ' + e.message);
            tryNext(i + 1);
          });
        };
        tryNext(0);
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
        const proc = spawn('powershell', [
          '-Command',
          '$wshell = New-Object -ComObject wscript.shell; $wshell.SendKeys(\'^v\')'
        ]);
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; proc.kill(); reject(new Error('粘贴超时，文本已复制到剪贴板，请手动 Ctrl+V')); }, 3000);
        proc.on('close', (code) => {
          if (timedOut) return;
          clearTimeout(timer);
          code === 0 ? resolve({ success: true }) : reject(new Error('粘贴失败，文本已复制到剪贴板，请手动 Ctrl+V'));
        });
        proc.on('error', () => { clearTimeout(timer); reject(new Error('粘贴失败，文本已复制到剪贴板，请手动 Ctrl+V')); });
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
