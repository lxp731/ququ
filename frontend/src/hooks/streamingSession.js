/**
 * 流式 ASR WebSocket 客户端 (渲染进程用)
 *
 * 协议:
 *   Server → Client JSON:
 *     {"type":"status",   "streaming_loaded":bool, "device":str}
 *     {"type":"preedit",  "green":str, "yellow":str, "red":str}
 *     {"type":"partial",  "text":"...", "timestamp":...}    (向后兼容)
 *     {"type":"final",    "text":"...", "timestamp":...}
 *     {"type":"commit",   "text":"..."}
 *     {"type":"error",    "message":"..."}
 *     {"type":"reset"}
 *     {"type":"pong"}
 *   Client → Server JSON:
 *     {"command":"start_listening"}
 *     {"command":"stop_listening"}
 *     {"command":"reset"}
 *     {"command":"commit_now"}
 *     {"command":"ping"}
 *   Client → Server binary:
 *     PCM audio chunk (int16, 16kHz, mono)
 */

const SAMPLE_RATE = 16000;
const CHUNK_MS = 100;
const CHUNK_SIZE = Math.floor(SAMPLE_RATE * CHUNK_MS / 1000) * 2;
const PING_INTERVAL = 15000;       // 心跳间隔 15s
const RECONNECT_MAX = 5;           // 最大重连次数
const RECONNECT_BASE_MS = 1000;    // 重连基础延迟
const CONNECT_TIMEOUT = 5000;      // 连接超时

function floatTo16BitPCM(float32Array) {
    const buffer = new ArrayBuffer(float32Array.length * 2);
    const view = new DataView(buffer);
    for (let i = 0; i < float32Array.length; i++) {
        const s = Math.max(-1, Math.min(1, float32Array[i]));
        view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    }
    return new Uint8Array(buffer);
}

class StreamingSession {
    constructor(wsUrl) {
        this._wsUrl = wsUrl || 'ws://127.0.0.1:8000/stream/ws';
        this._ws = null;
        this._ready = false;
        this._streamingLoaded = false;
        this._reconnectAttempts = 0;
        this._reconnecting = false;
        this._pingTimer = null;
        this._pongReceived = true;
        this._listeners = {};
    }

    // ── Events ──

    on(event, fn) { (this._listeners[event] ||= []).push(fn); }
    _emit(event, data) {
        (this._listeners[event] || []).forEach(fn => {
            try { fn(data); } catch (e) { console.error('[StreamingSession]', event, e); }
        });
    }

    // ── Connection ──

    async start() {
        this._reconnectAttempts = 0;
        return this._connect();
    }

    async _connect() {
        return new Promise((resolve, reject) => {
            if (this._reconnectAttempts >= RECONNECT_MAX) {
                reject(new Error(`WebSocket reconnect limit (${RECONNECT_MAX}) exceeded`));
                return;
            }

            const ws = new WebSocket(this._wsUrl);
            ws.binaryType = 'arraybuffer';

            const timeoutId = setTimeout(() => {
                if (!this._ready) {
                    ws.close();
                    reject(new Error('WebSocket connection timeout'));
                }
            }, CONNECT_TIMEOUT);

            ws.onopen = () => {
                clearTimeout(timeoutId);
                this._ws = ws;
                this._ready = true;
                this._reconnectAttempts = 0;
                this._reconnecting = false;
                this._startHeartbeat();
                this._emit('status', { connected: true });
                resolve();
            };

            ws.onmessage = (event) => {
                if (typeof event.data === 'string') {
                    try {
                        const msg = JSON.parse(event.data);
                        this._handleMessage(msg);
                    } catch (_) { /* ignore */ }
                }
            };

            ws.onerror = () => {
                clearTimeout(timeoutId);
                this._emit('error', { message: 'WebSocket error' });
                if (!this._reconnecting) {
                    reject(new Error('WebSocket connection failed'));
                }
            };

            ws.onclose = (e) => {
                clearTimeout(timeoutId);
                this._ready = false;
                this._ws = null;
                this._stopHeartbeat();
                this._emit('status', { connected: false, code: e.code });

                // 自动重连
                if (!this._reconnecting && e.code !== 1000) {
                    this._reconnectAttempts++;
                    this._reconnecting = true;
                    const delay = RECONNECT_BASE_MS * Math.pow(2, this._reconnectAttempts - 1);
                    console.log(`[StreamingSession] Reconnecting in ${delay}ms (attempt ${this._reconnectAttempts}/${RECONNECT_MAX})`);
                    setTimeout(() => {
                        this._connect().catch(() => { /* ignore */ });
                    }, delay);
                }
            };
        });
    }

    _handleMessage(msg) {
        switch (msg.type) {
            case 'status':
                this._streamingLoaded = msg.streaming_loaded || false;
                this._emit('status', {
                    connected: true,
                    streamingLoaded: this._streamingLoaded,
                    device: msg.device,
                });
                break;

            case 'preedit':
                this._emit('preedit', {
                    green: msg.green || '',
                    yellow: msg.yellow || '',
                    red: msg.red || '',
                });
                break;

            case 'partial':
                // 向后兼容: 旧版 streaming_server 用的 partial
                this._emit('partial', {
                    text: msg.text || '',
                    timestamp: msg.timestamp,
                });
                break;

            case 'final':
                this._emit('final', {
                    text: msg.text || '',
                    timestamp: msg.timestamp,
                });
                break;

            case 'commit':
                this._emit('commit', {
                    text: msg.text || '',
                });
                break;

            case 'reset':
                this._emit('reset', {});
                break;

            case 'error':
                this._emit('error', { message: msg.message });
                break;

            case 'hotwords_updated':
                this._emit('hotwords_updated', { count: msg.count });
                break;

            case 'pong':
                this._pongReceived = true;
                break;
        }
    }

    // ── Heartbeat ──

    _startHeartbeat() {
        this._stopHeartbeat();
        this._pongReceived = true;
        this._pingTimer = setInterval(() => {
            if (!this._pongReceived) {
                console.warn('[StreamingSession] Ping timeout, reconnecting...');
                this.stop();
                this._reconnectAttempts++;
                this._reconnecting = true;
                const delay = RECONNECT_BASE_MS * Math.pow(2, this._reconnectAttempts - 1);
                setTimeout(() => this._connect().catch(() => { /* ignore */ }), delay);
                return;
            }
            this._pongReceived = false;
            this.sendCommand({ command: 'ping' });
        }, PING_INTERVAL);
    }

    _stopHeartbeat() {
        if (this._pingTimer) {
            clearInterval(this._pingTimer);
            this._pingTimer = null;
        }
    }

    // ── Audio send ──

    sendAudio(chunk) {
        if (!this._ws || !this._ready) return;
        if (this._ws.readyState !== WebSocket.OPEN) return;
        if (chunk instanceof Uint8Array) {
            this._ws.send(chunk.buffer);
        } else if (chunk instanceof ArrayBuffer) {
            this._ws.send(chunk);
        } else if (ArrayBuffer.isView(chunk)) {
            this._ws.send(chunk.buffer);
        }
    }

    // ── Commands ──

    sendCommand(cmd) {
        if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
        this._ws.send(JSON.stringify(cmd));
    }

    startListening() {
        this.sendCommand({ command: 'start_listening' });
    }

    stopListening() {
        this.sendCommand({ command: 'stop_listening' });
    }

    reset() {
        this.sendCommand({ command: 'reset' });
    }

    commitNow() {
        this.sendCommand({ command: 'commit_now' });
    }

    sendConfig(llmConfig) {
        this.sendCommand({ command: 'config', llm: llmConfig });
    }

    // ── Cleanup ──

    stop() {
        this._stopHeartbeat();
        this._reconnecting = false;
        if (this._ws) {
            this._ws.close(1000);
            this._ws = null;
        }
        this._ready = false;
    }

    get ready() { return this._ready; }
    get streamingLoaded() { return this._streamingLoaded; }
}

export { StreamingSession, SAMPLE_RATE, CHUNK_MS, CHUNK_SIZE, floatTo16BitPCM };
