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
const RECONNECT_MAX = 8;           // 最大连续重连次数 (0 = 无限)
const RECONNECT_BASE_MS = 1000;    // 重连基础延迟
const RECONNECT_MAX_DELAY_MS = 30000; // 退避上限
const CONNECT_TIMEOUT = 5000;      // 连接超时
const MAX_MESSAGE_BYTES = 1024 * 1024; // 单条入站消息上限 1MB

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
        this._stopped = false;
        this._pingTimer = null;
        this._reconnectTimer = null;
        this._pongReceived = true;
        this._listeners = {};
        this._connectPromise = null;
    }

    // ── Events ──

    on(event, fn) { (this._listeners[event] ||= []).push(fn); }
    off(event, fn) {
        const list = this._listeners[event];
        if (!list) return;
        const i = list.indexOf(fn);
        if (i >= 0) list.splice(i, 1);
    }
    _emit(event, data) {
        (this._listeners[event] || []).forEach(fn => {
            try { fn(data); } catch (e) { console.error('[StreamingSession]', event, e); }
        });
    }

    // ── Connection ──

    async start() {
        if (this._stopped) this._stopped = false;
        this._reconnectAttempts = 0;
        return this._ensureConnect();
    }

    // 单一连接调度器: 并发调用共享同一 in-flight promise
    _ensureConnect() {
        if (this._connectPromise) return this._connectPromise;
        this._connectPromise = this._connect().finally(() => { this._connectPromise = null; });
        return this._connectPromise;
    }

    _connect() {
        return new Promise((resolve) => {
            if (this._stopped) { resolve(false); return; }

            const ws = new WebSocket(this._wsUrl);
            ws.binaryType = 'arraybuffer';

            const timeoutId = setTimeout(() => {
                if (!this._ready) {
                    try { ws.close(); } catch (_) { /* ignore */ }
                    this._scheduleReconnect();
                    resolve(false);
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
                resolve(true);
            };

            ws.onmessage = (event) => {
                if (typeof event.data !== 'string') return;
                // 入站消息大小限制: 防恶意/异常后端打爆渲染进程内存
                if (event.data.length > MAX_MESSAGE_BYTES) {
                    console.warn(`[StreamingSession] oversized message (${event.data.length} bytes), closing`);
                    this.stop();
                    return;
                }
                try {
                    const msg = JSON.parse(event.data);
                    this._handleMessage(msg);
                } catch (_) { /* ignore */ }
            };

            ws.onerror = () => {
                clearTimeout(timeoutId);
                this._emit('error', { message: 'WebSocket error' });
            };

            ws.onclose = (e) => {
                clearTimeout(timeoutId);
                const wasReady = this._ready;
                this._ready = false;
                this._ws = null;
                this._stopHeartbeat();
                this._emit('status', { connected: false, code: e.code });

                // 主动关闭 (stop) 不重连
                if (this._stopped) { resolve(false); return; }
                // 失败即重试: 任何非 1000 关闭都排程下一次 (受 RECONNECT_MAX 限制)
                if (e.code !== 1000 || !wasReady) {
                    this._scheduleReconnect();
                }
                resolve(false);
            };
        });
    }

    _scheduleReconnect() {
        if (this._stopped) return;
        if (this._reconnectTimer) return; // 已排程
        if (RECONNECT_MAX > 0 && this._reconnectAttempts >= RECONNECT_MAX) {
            this._reconnecting = false;
            this._emit('error', { message: `WebSocket 重连失败 (已达上限 ${RECONNECT_MAX})` });
            return;
        }
        this._reconnecting = true;
        const delay = Math.min(
            RECONNECT_BASE_MS * Math.pow(2, this._reconnectAttempts),
            RECONNECT_MAX_DELAY_MS);
        this._reconnectAttempts++;
        console.log(`[StreamingSession] Reconnecting in ${delay}ms (attempt ${this._reconnectAttempts}/${RECONNECT_MAX || '∞'})`);
        this._reconnectTimer = setTimeout(() => {
            this._reconnectTimer = null;
            if (this._stopped) return;
            this._ensureConnect().then(ok => {
                if (!ok) this._reconnecting = false;
            });
        }, delay);
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
                this._reconnectByHeartbeat();
                return;
            }
            this._pongReceived = false;
            this.sendCommand({ command: 'ping' });
        }, PING_INTERVAL);
    }

    _reconnectByHeartbeat() {
        this._stopHeartbeat();
        const oldWs = this._ws;
        this._ws = null;
        this._ready = false;
        try { oldWs?.close(1000); } catch (_) { /* ignore */ }
        // 心跳超时视为连接失效 → 走统一重连调度
        this._reconnectAttempts = Math.max(1, this._reconnectAttempts);
        this._scheduleReconnect();
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
            // 视图切片: 只发送视图内的字节, 防止 byteOffset 时多发包头字节
            this._ws.send(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
        } else if (chunk instanceof ArrayBuffer) {
            this._ws.send(chunk);
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
        this._stopped = true;
        this._stopHeartbeat();
        this._reconnecting = false;
        if (this._reconnectTimer) {
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
        }
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
