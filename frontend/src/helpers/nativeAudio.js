/**
 * 原生音频采集 — 替代浏览器 MediaRecorder (WebM/Opus → WAV 转码)
 *
 * Linux: arecord 子进程输出 raw PCM 到 stdout
 * Windows: 未实现 (提示使用点击模式)
 *
 * 优势:
 *   - 零转码: raw PCM 直接送 ASR，消除 Opus 有损压缩 + WebM→WAV 往返
 *   - 低延迟: 边录边送，不等 stop()
 *   - 可控码率: 16kHz 16bit mono = 32KB/s，可忽略
 */

const { spawn, execFile } = require('child_process');
const { EventEmitter } = require('events');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const SAMPLE_RATE = 16000;
const CHUNK_MS = 100; // 每 100ms 发一帧（1600 samples → 3200 bytes）

class NativeAudioCapture extends EventEmitter {
    constructor() {
        super();
        this._process = null;
        this._stream = null;
        this._capturing = false;
        this._deviceName = null;
    }

    // ── 设备列表 ──

    static async listDevices() {
        const devices = [];

        if (process.platform === 'linux') {
            try {
                const { stdout } = await execFileAsync('arecord', ['-l'], { encoding: 'utf8', timeout: 5000 });
                // 解析 arecord -l 输出: "card 1: Device [USB Mic], device 0: ..."
                const lines = stdout.split('\n');
                for (const line of lines) {
                    const m = line.match(/^card\s+(\d+):\s+(.+?)\s*\[(.+?)\]/);
                    if (m) {
                        devices.push({
                            id: `hw:${m[1]},0`,
                            name: m[3] || m[2] || `Card ${m[1]}`,
                            platform: 'linux',
                        });
                    }
                }
            } catch (_) { /* no arecord */ }
        }

        if (process.platform === 'win32') {
            // Windows 原生采集未实现, 设备枚举也跳过
        }

        return devices;
    }

    // ── 启动采集 ──

    setDevice(name) {
        // 安全: 仅接受由 listDevices 产生的 hw: 格式设备名, 防止注入异常参数
        if (!name || (process.platform === 'linux' && !/^hw:\d+,\d+$/.test(name))) {
            this._deviceName = null;
            return;
        }
        this._deviceName = name;
    }

    start() {
        if (this._capturing) return;

        if (process.platform === 'linux') {
            this._startLinux();
        } else if (process.platform === 'win32') {
            this._startWindows();
        } else {
            this.emit('error', new Error(`Unsupported platform: ${process.platform}`));
        }
    }

    _startLinux() {
        const args = [
            '-f', 'S16_LE',      // signed 16-bit little-endian
            '-r', String(SAMPLE_RATE),
            '-c', '1',           // mono
            '-t', 'raw',         // raw PCM, no header
            '--period-size', String(Math.floor(SAMPLE_RATE * CHUNK_MS / 1000)),
            '-',                 // stdout
        ];

        if (this._deviceName) {
            args.unshift('-D', this._deviceName);
        }

        this._process = spawn('arecord', args, {
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        this._capturing = true;
        this.emit('start');

        // 数据事件
        this._process.stdout.on('data', (chunk) => {
            this.emit('data', chunk);  // Buffer of raw PCM (int16)
        });

        // 错误处理
        this._process.stderr.on('data', (d) => {
            const msg = d.toString().trim();
            if (msg && !msg.includes('underrun') && !msg.includes('overrun')) {
                this.emit('warn', msg);
            }
        });

        this._process.on('error', (e) => {
            this.emit('error', e);
            this._cleanup();
        });

        this._process.on('exit', (code) => {
            if (code !== null && code !== 0 && this._capturing) {
                this.emit('warn', `arecord exited with code ${code}`);
            }
            this._cleanup();
        });
    }

    _startWindows() {
        // Windows 原生音频采集未实现, 提示使用点击模式回退
        this.emit('error', new Error(
            'Windows native audio capture not yet implemented. ' +
            'Please use the toggle-mode (click to record) as fallback.'
        ));
    }

    // ── 停止 ──

    stop() {
        if (this._process) {
            // SIGTERM → arecord 正常退出; 2s 未退出补 SIGKILL 防残留
            try { this._process.kill('SIGTERM'); } catch (_) { /* ignore */ }
            const proc = this._process;
            const killTimer = setTimeout(() => {
                try { proc.kill('SIGKILL'); } catch (_) { /* ignore */ }
            }, 2000);
            proc.once('exit', () => clearTimeout(killTimer));
        }
        this._cleanup();
        this.emit('stop');
    }

    _cleanup() {
        this._capturing = false;
        if (this._process) {
            try {
                this._process.stdout.removeAllListeners();
                this._process.stderr.removeAllListeners();
            } catch (_) { /* ignore */ }
            this._process = null;
        }
    }

    get isCapturing() {
        return this._capturing;
    }
}

module.exports = { NativeAudioCapture, SAMPLE_RATE, CHUNK_MS };
