// 全局键盘监听（长按模式）
// Linux:   Python 子进程读取 /dev/input/event* (evdev)
// Windows: PowerShell 子进程通过 C# P/Invoke GetAsyncKeyState 轮询
// macOS:   不支持（静默跳过）
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

  _findKeyboards() {
    const byPath = '/dev/input/by-path';
    const devices = new Set();
    try {
      for (const name of fs.readdirSync(byPath)) {
        if (name.endsWith('-kbd') || name.endsWith('-event-kbd')) {
          devices.add(fs.realpathSync(path.join(byPath, name)));
        }
      }
    } catch (_) {}
    return [...devices];
  }

  start(onKeyEvent) {
    if (this._child) return;
    this._onKeyEvent = onKeyEvent;

    if (process.platform === 'linux') {
      this._startLinux();
    } else if (process.platform === 'win32') {
      this._startWindows();
    } else {
      this.log?.info?.('[KeyWatcher] 当前平台不支持键盘监听');
    }
  }

  // ── Linux: evdev（监听全部键盘设备）──
  _startLinux() {
    const devices = this._findKeyboards();
    if (devices.length === 0) { this.log?.error?.('[KeyWatcher] 找不到键盘设备'); return; }
    this.log?.info?.(`[KeyWatcher] 设备: ${devices.join(', ')}`);

    const deviceList = JSON.stringify(devices);
    const script = `
import struct, os, sys, select, json
WATCH = {29:'Control',97:'Control',57:'Space',125:'Meta',126:'Meta',56:'Alt',100:'Alt'}
devices = json.loads('''${deviceList}''')
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
            data = os.read(fd, 24)
            if len(data) < 24: continue
            tv_sec, tv_usec, typ, code, value = struct.unpack('LLHHI', data)
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
  _startWindows() {
    this.log?.info?.('[KeyWatcher] Windows 键盘监听启动 (GetAsyncKeyState 轮询)');

    // PowerShell + C# P/Invoke：每 10ms 轮询 Ctrl/Alt/Space/Meta 状态
    // 输出格式与 Linux 版本完全一致: "down:Control" / "up:Space"
    const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class KeyState {
    [DllImport("user32.dll")]
    public static extern short GetAsyncKeyState(int vKey);
}
"@

$watch = @(
    @{vk=0x11; name='Control'}   # VK_CONTROL
    @{vk=0x12; name='Alt'}       # VK_MENU
    @{vk=0x20; name='Space'}     # VK_SPACE
    @{vk=0x5B; name='Meta'}      # VK_LWIN
    @{vk=0x5C; name='Meta'}      # VK_RWIN
)
$prev = @($false, $false, $false, $false, $false)

while ($true) {
    for ($i = 0; $i -lt 5; $i++) {
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

  // ── 共享 stdout 解析（Linux & Windows 输出格式一致）──
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
      try { this._child.kill('SIGTERM'); } catch (_) {}
      this._child = null;
    }
    this._onKeyEvent = null;
  }
}

module.exports = KeyWatcher;
