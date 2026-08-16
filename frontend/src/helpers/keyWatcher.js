// 全局键盘监听（长按模式）
// Linux:   Python 子进程读取 /dev/input/event* (evdev)
// Windows: PowerShell 子进程通过 C# P/Invoke GetAsyncKeyState 轮询
// macOS:   不支持（静默跳过）
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// evdev 键码映射（字母 + 常用键）
const EV_KEY_MAP = {
  'Space': 57,
  'A': 30, 'B': 48, 'C': 46, 'D': 32, 'E': 18, 'F': 33, 'G': 34,
  'H': 35, 'I': 23, 'J': 36, 'K': 37, 'L': 38, 'M': 50, 'N': 49,
  'O': 24, 'P': 25, 'Q': 16, 'R': 19, 'S': 31, 'T': 20, 'U': 22,
  'V': 47, 'W': 17, 'X': 45, 'Y': 21, 'Z': 44,
  '0': 11, '1': 2, '2': 3, '3': 4, '4': 5, '5': 6, '6': 7, '7': 8, '8': 9, '9': 10,
  'Tab': 15, 'Enter': 28, 'Escape': 1, 'Backspace': 14,
};

// 修饰键 evdev 码
const EV_MODS = { Ctrl: [29, 97], Shift: [42, 54], Alt: [56, 100], Meta: [125, 126] };

// Windows VK 码
const WIN_VK_MAP = {
  'Space': 0x20,
  'A': 0x41, 'B': 0x42, 'C': 0x43, 'D': 0x44, 'E': 0x45, 'F': 0x46, 'G': 0x47,
  'H': 0x48, 'I': 0x49, 'J': 0x4A, 'K': 0x4B, 'L': 0x4C, 'M': 0x4D, 'N': 0x4E,
  'O': 0x4F, 'P': 0x50, 'Q': 0x51, 'R': 0x52, 'S': 0x53, 'T': 0x54, 'U': 0x55,
  'V': 0x56, 'W': 0x57, 'X': 0x58, 'Y': 0x59, 'Z': 0x5A,
  '0': 0x30, '1': 0x31, '2': 0x32, '3': 0x33, '4': 0x34,
  '5': 0x35, '6': 0x36, '7': 0x37, '8': 0x38, '9': 0x39,
};

// 检测 Python 所在平台的 C long 大小 (evdev input_event 布局依赖)
// 64 位 Linux: long=8 → 24 字节; 32 位: long=4 → 16 字节
function structCalcsizeLong() {
  try {
    const { execFileSync } = require('child_process');
    const out = execFileSync('python3', ['-c', 'import struct; print(struct.calcsize("L"))'], { encoding: 'utf8', timeout: 5000 });
    return parseInt(out.trim(), 10) || 8;
  } catch (_) { return 8; }
}

class KeyWatcher {
  constructor(logger) {
    this.log = logger;
    this._child = null;
    this._onKeyEvent = null;
    this._hotkey = 'Ctrl+Space';
  }

  _findKeyboards() {
    const byPath = '/dev/input/by-path';
    const devices = new Set();
    try {
      for (const name of fs.readdirSync(byPath)) {
        if (name.endsWith('-kbd') || name.endsWith('-event-kbd')) {
          devices.add(fs.realpathSync(path.join(byPath, name)));
        }
      }
    } catch (_) { /* ignore */ }
    return [...devices];
  }

  /**
   * 解析快捷键，返回要监听的键。
   * 格式: 'Ctrl+Shift+L' → { trigger: 'L', triggerCode: 38, mods: ['Ctrl','Shift'] }
   */
  _parseHotkey(hotkey) {
    // 安全: 热键字符串白名单, 防止注入到生成的脚本字面量
    if (typeof hotkey !== 'string' || !/^[A-Za-z0-9+]+$/.test(hotkey)) {
      this.log?.warn?.('[KeyWatcher] 非法热键格式, 已拒绝:', hotkey);
      return null;
    }
    const parts = hotkey.split('+');
    const trigger = parts[parts.length - 1];
    const modNames = parts.slice(0, -1);
    return { trigger, modNames };
  }

  /**
   * 启动键鼠监听。
   * @param {function} onKeyEvent (type, keyName) => void
   * @param {string}   hotkey     用户自定义快捷键，如 'Ctrl+Shift+L'
   */
  start(onKeyEvent, hotkey = 'Ctrl+Space') {
    if (this._child) return;
    const parsed = this._parseHotkey(hotkey);
    if (!parsed) { this.log?.error?.('[KeyWatcher] 热键格式非法:', hotkey); return; }
    this._onKeyEvent = onKeyEvent;
    this._hotkey = hotkey;

    if (process.platform === 'linux') {
      this._startLinux(parsed);
    } else if (process.platform === 'win32') {
      this._startWindows(parsed);
    } else {
      this.log?.info?.('[KeyWatcher] 当前平台不支持键盘监听');
    }
  }

  // ── Linux: evdev ──
  _startLinux(parsed) {
    const devices = this._findKeyboards();
    if (devices.length === 0) { this.log?.error?.('[KeyWatcher] 找不到键盘设备'); return; }
    this.log?.info?.(`[KeyWatcher] 设备: ${devices.join(', ')}, 热键: ${this._hotkey}`);

    const { trigger, modNames } = parsed;
    const triggerCode = EV_KEY_MAP[trigger];
    if (!triggerCode) { this.log?.error?.(`[KeyWatcher] 不支持的触发键: ${trigger}`); return; }

    // 构建动态 WATCH 映射
    const watch = {};
    for (const mod of modNames) {
      const codes = EV_MODS[mod];
      if (codes) codes.forEach(c => { watch[c] = mod; });
    }
    watch[triggerCode] = trigger;

    const deviceList = JSON.stringify(devices);
    // 生成 Python dict 字面量（整数 key，非 JSON 字符串 key）
    // 注: trigger/mod 均来自白名单映射表, 不存在注入面
    const watchItems = Object.entries(watch).map(([c, n]) => `${c}:'${n}'`).join(',');
    // evdev input_event: timeval(long,long) + u16 type + u16 code + s32 value
    // 64 位 Linux 上 long=8 字节 → 24 字节; 32 位为 16 字节, 需用对应格式
    const structFmt = structCalcsizeLong() === 8 ? 'LLHHI' : 'llHHI';
    const script = `
import struct, os, sys, select, json
WATCH = {${watchItems}}
devices = json.loads('''${deviceList}''')
FMT = '${structFmt}'
SIZE = struct.calcsize(FMT)
fds = []
for d in devices:
    try:
        fds.append(os.open(d, os.O_RDONLY))
    except:
        sys.stderr.write(f'[KeyWatcher] 无法打开设备: {d}\\n')
sys.stdout.flush()
if not fds:
    sys.exit(1)
while True:
    try:
        ready, _, _ = select.select(fds, [], [])
        for fd in ready:
            data = os.read(fd, SIZE)
            if len(data) < SIZE: continue
            tv_sec, tv_usec, typ, code, value = struct.unpack(FMT, data)
            if typ == 1 and code in WATCH:
                if value == 1:
                    sys.stdout.write('down:' + WATCH[code] + '\\n')
                elif value == 0:
                    sys.stdout.write('up:' + WATCH[code] + '\\n')
                sys.stdout.flush()
    except KeyboardInterrupt:
        break
    except:
        break
`;

    this._child = spawn('python3', ['-c', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this._bindStdio();
  }

  // ── Windows: GetAsyncKeyState 轮询 ──
  _startWindows(parsed) {
    this.log?.info?.(`[KeyWatcher] Windows 键盘监听启动, 热键: ${this._hotkey}`);

    const { trigger, modNames } = parsed;
    const triggerVk = WIN_VK_MAP[trigger];
    if (!triggerVk) { this.log?.error?.(`[KeyWatcher] 不支持的触发键: ${trigger}`); return; }

    const vkModMap = { Ctrl: 0x11, Shift: 0x10, Alt: 0x12, Meta: [0x5B, 0x5C] };
    const watch = [];
    for (const mod of modNames) {
      const vk = vkModMap[mod];
      if (Array.isArray(vk)) vk.forEach(v => watch.push([v, mod]));
      else if (vk) watch.push([vk, mod]);
    }
    watch.push([triggerVk, trigger]);

    // 生成 PowerShell 脚本
    const watchParts = watch.map(([vk, name]) => `@{vk=${vk}; name='${name}'}`)
    const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class KeyState {
    [DllImport("user32.dll")]
    public static extern short GetAsyncKeyState(int vKey);
}
"@

$watch = @(${watchParts.join(', ')})
$n = ${watch.length}
$prev = @(${[...Array(watch.length)].map(() => '$false').join(', ')})

while ($true) {
    for ($i = 0; $i -lt $n; $i++) {
        $s = [KeyState]::GetAsyncKeyState($watch[$i].vk)
        $down = ($s -band 0x8000) -ne 0
        if ($down -ne $prev[$i]) {
            $prev[$i] = $down
            $action = if ($down) { 'down' } else { 'up' }
            Write-Output "$action\`:$($watch[$i].name)"
        }
    }
    Start-Sleep -Milliseconds 10
}
`;

    this._child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this._bindStdio();
  }

  // ── 共享 stdout 解析 ──
  _bindStdio() {
    let buf = '';
    this._child.stdout.on('data', (chunk) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        const m = line.trim().match(/^(down|up):(.+)$/);
        if (m) {
          const type = m[1];
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
      try { this._child.kill('SIGTERM'); } catch (_) { /* ignore */ }
      this._child = null;
    }
    this._onKeyEvent = null;
  }
}

module.exports = KeyWatcher;
