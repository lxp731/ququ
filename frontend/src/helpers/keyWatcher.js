// Linux evdev 全局键盘监听 — Python 子进程读取 /dev/input/event*
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

class KeyWatcher {
  constructor(logger) {
    this.log = logger;
    this._child = null;
    this._onKeyEvent = null; // (type, keyName) => void, type='down'|'up'
    this._device = null;
  }

  _findKeyboard() {
    const byPath = '/dev/input/by-path';
    try {
      for (const name of fs.readdirSync(byPath)) {
        if (name.endsWith('-kbd') || name.endsWith('-event-kbd')) {
          return fs.realpathSync(path.join(byPath, name));
        }
      }
    } catch (_) {}
    return null;
  }

  start(onKeyEvent) {
    if (this._child) return;
    this._onKeyEvent = onKeyEvent;

    const device = this._findKeyboard();
    if (!device) { this.log?.error?.('[KeyWatcher] 找不到键盘设备'); return; }
    this._device = device;
    this.log?.info?.(`[KeyWatcher] 设备: ${device}`);

    // Python 脚本：阻塞读 evdev，检测 keydown(忽略repeat) + keyup
    // 输出格式: "down:Control" 或 "up:Space"（每行一个事件）
    const script = `
import struct, os, sys
WATCH = {29:'Control',97:'Control',57:'Space',125:'Meta',126:'Meta',56:'Alt',100:'Alt'}
fd = os.open('${device}', os.O_RDONLY)
sys.stdout.flush()
while True:
    try:
        data = os.read(fd, 24)
        if len(data) < 24: break
        tv_sec, tv_usec, typ, code, value = struct.unpack('LLHHI', data)
        if typ == 1 and code in WATCH:
            if value == 1:
                sys.stdout.write('down:' + WATCH[code] + '\\n')
                sys.stdout.flush()
            elif value == 0:
                sys.stdout.write('up:' + WATCH[code] + '\\n')
                sys.stdout.flush()
            # value==2 是 key repeat，忽略
    except KeyboardInterrupt:
        break
    except:
        break
`;

    this._child = spawn('python3', ['-c', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let buf = '';
    this._child.stdout.on('data', (chunk) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        const m = line.trim().match(/^(down|up):(.+)$/);
        if (m) {
          const type = m[1]; // 'down' or 'up'
          const key = m[2];
          this.log?.info?.(`[KeyWatcher] ${type}: ${key}`);
          this._onKeyEvent?.(type, key);
        }
      }
    });

    this._child.stderr.on('data', (d) => {
      this.log?.warn?.(`[KeyWatcher] stderr: ${d.toString().trim()}`);
    });

    this._child.on('error', (e) => {
      this.log?.error?.(`[KeyWatcher] 子进程启动失败: ${e.message}`);
      this._child = null;
    });

    this._child.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        this.log?.warn?.(`[KeyWatcher] 子进程退出 code=${code}`);
      }
      this._child = null;
    });
  }

  stop() {
    if (this._child) {
      this._child.kill('SIGTERM');
      this._child = null;
    }
    this._onKeyEvent = null;
  }
}

module.exports = KeyWatcher;
