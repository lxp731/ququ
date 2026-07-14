const { globalShortcut } = require('electron');

class HotkeyManager {
  constructor(logger) {
    this.logger = logger;
    this.registered = new Map();
    this.lastTrigger = new Map();
    this.debounceMs = 800; // 按键重复每~30ms触发一次，800ms防抖确保只响应一次
    this._recording = false;
  }

  registerHotkey(hotkey, callback) {
    if (this.registered.has(hotkey)) return true;
    const debounced = () => {
      const now = Date.now();
      if (now - (this.lastTrigger.get(hotkey) || 0) < this.debounceMs) return;
      this.lastTrigger.set(hotkey, now);
      callback();
    };
    const ok = globalShortcut.register(hotkey, debounced);
    if (ok) {
      this.registered.set(hotkey, debounced);
      this.logger?.info?.(`热键 ${hotkey} 注册成功`);
    }
    return ok;
  }

  unregisterHotkey(hotkey) {
    if (!this.registered.has(hotkey)) return false;
    globalShortcut.unregister(hotkey);
    this.registered.delete(hotkey);
    return true;
  }

  unregisterAll() {
    globalShortcut.unregisterAll();
    this.registered.clear();
  }

  getRegisteredHotkeys() { return Array.from(this.registered.keys()); }

  setRecordingState(v) { this._recording = v; }
  getRecordingState() { return this._recording; }
}

module.exports = HotkeyManager;
