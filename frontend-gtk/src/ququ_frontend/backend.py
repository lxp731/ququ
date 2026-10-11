"""后端客户端 — REST (urllib) + WebSocket (websocket-client)。

WS 协议（与 server.py 一致）：
- Client→Server: start_listening / stop_listening / reset / commit_now / ping / config
- Client→Server binary: PCM (int16, 16kHz, mono)
- Server→Client: status / preedit{green,yellow,red} / commit / final / reset /
  error / hotwords_updated / pong / config_ack
"""

from __future__ import annotations

import json
import logging
import threading
import time
import urllib.request
import urllib.error
from typing import Any, Callable

import websocket

from . import paths

log = logging.getLogger("ququ.backend")

# 重连参数（与 Electron streamingSession 一致）
RECONNECT_MAX = 8
RECONNECT_BASE_MS = 1000
RECONNECT_MAX_DELAY_MS = 30000
CONNECT_TIMEOUT = 5.0
PING_INTERVAL = 15.0

# 消息回调签名
Callback = Callable[..., None]


def _dispatch(fn: Callable[..., None], *args: Any) -> None:
    """将回调派发到 GTK 主线程。若主循环未运行则直接同步执行（便于测试）。"""
    try:
        import gi  # noqa: PLC0415
        gi.require_version("GLib", "2.0")
        from gi.repository import GLib
        if GLib.main_depth() > 0:
            GLib.idle_add(fn, *args)
            return
    except Exception:  # noqa: BLE001
        pass
    fn(*args)


class BackendClient:
    def __init__(self, base_url: str | None = None):
        self.base_url = (base_url or paths.DEFAULT_BASE_URL).rstrip("/")
        self._ws: websocket.WebSocket | None = None
        self._ws_url = self.base_url.replace("http", "ws", 1) + "/stream/ws"
        self._lock = threading.Lock()
        self._recv_thread: threading.Thread | None = None
        self._stopped = threading.Event()
        self._reconnect_attempts = 0
        self._pong_received = True
        self.connected = False
        self.streaming_loaded = False

        # 回调（在主线程执行）
        self.on_status: Callback | None = None
        self.on_preedit: Callback | None = None
        self.on_commit: Callback | None = None
        self.on_final: Callback | None = None
        self.on_reset: Callback | None = None
        self.on_error: Callback | None = None
        self.on_hotwords_updated: Callback | None = None

    # ── REST ──────────────────────────────────────────

    def _http(self, path: str, method: str = "GET", timeout: float = 3.0) -> dict[str, Any]:
        req = urllib.request.Request(self.base_url + path, method=method)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except (urllib.error.URLError, OSError, json.JSONDecodeError) as e:
            return {"error": str(e)}

    def health(self) -> dict[str, Any]:
        return self._http("/health", timeout=3.0)

    def status(self) -> dict[str, Any]:
        return self._http("/status", timeout=3.0)

    def download_models(self) -> dict[str, Any]:
        return self._http("/models/download", method="POST", timeout=3600.0)

    # ── WebSocket ─────────────────────────────────────

    def ws_url(self) -> str:
        return self._ws_url

    def start(self) -> None:
        """启动 WS 连接（后台线程，失败自动重连）。"""
        if self._recv_thread is not None and self._recv_thread.is_alive():
            return
        self._stopped.clear()
        self._reconnect_attempts = 0
        self._recv_thread = threading.Thread(target=self._run, name="ququ-ws", daemon=True)
        self._recv_thread.start()

    def stop(self) -> None:
        self._stopped.set()
        ws = self._ws
        if ws is not None:
            try:
                ws.close()
            except Exception:  # noqa: BLE001
                pass
        self.connected = False

    def _run(self) -> None:
        while not self._stopped.is_set():
            try:
                self._connect_once()
            except Exception as e:  # noqa: BLE001
                log.warning("WS connect error: %s", e)
            if self._stopped.is_set():
                break
            if self.connected:
                break  # 正常连接后 recv 循环退出代表断开，进入重连
            delay = min(RECONNECT_BASE_MS * (2 ** self._reconnect_attempts), RECONNECT_MAX_DELAY_MS)
            self._reconnect_attempts += 1
            if RECONNECT_MAX > 0 and self._reconnect_attempts > RECONNECT_MAX:
                log.warning("WS 重连次数超限，停止重试")
                self._emit_error(f"WebSocket 重连失败 (已达上限 {RECONNECT_MAX})")
                break
            log.info("WS 重连: %dms (attempt %d)", delay, self._reconnect_attempts)
            self._stopped.wait(delay / 1000.0)

    def _connect_once(self) -> None:
        ws = websocket.WebSocket()
        ws.settimeout(CONNECT_TIMEOUT)
        # suppress_origin: 非浏览器客户端不携带 Origin，避免后端 403
        ws.connect(self._ws_url, suppress_origin=True, timeout=CONNECT_TIMEOUT)
        self._ws = ws
        self.connected = True
        self._reconnect_attempts = 0
        self._pong_received = True
        log.info("WS connected: %s", self._ws_url)
        self._dispatch(self.on_status, {"streaming_loaded": self.streaming_loaded})
        self._receive_loop(ws)

    def _receive_loop(self, ws: websocket.WebSocket) -> None:
        """阻塞接收循环；退出时 connected=False 触发重连。"""
        ws.settimeout(PING_INTERVAL)
        last_ping = time.time()
        while not self._stopped.is_set():
            try:
                data = ws.recv()
            except websocket.WebSocketTimeoutException:
                # 心跳：超时无数据则发 ping；连续两次未收到 pong 则断开重连
                if not self._pong_received:
                    log.warning("WS ping 超时，断开重连")
                    break
                self._pong_received = False
                self.send_command({"command": "ping"})
                last_ping = time.time()
                continue
            except (websocket.WebSocketConnectionClosedException, OSError):
                break
            except Exception as e:  # noqa: BLE001
                log.warning("WS recv error: %s", e)
                break

            if isinstance(data, bytes):
                continue  # 服务端不会发二进制
            try:
                msg = json.loads(data)
            except json.JSONDecodeError:
                continue
            self._handle_message(msg)
            if time.time() - last_ping > PING_INTERVAL * 2:
                last_ping = time.time()

        try:
            ws.close()
        except Exception:  # noqa: BLE001
            pass
        self.connected = False
        self._dispatch(self.on_status, {"streaming_loaded": False, "disconnected": True})

    def _handle_message(self, msg: dict[str, Any]) -> None:
        t = msg.get("type")
        if t == "status":
            self.streaming_loaded = bool(msg.get("streaming_loaded"))
            self._dispatch(self.on_status, {
                "streaming_loaded": self.streaming_loaded,
                "device": msg.get("device", ""),
            })
        elif t == "preedit":
            self._dispatch(self.on_preedit, {
                "green": msg.get("green", ""),
                "yellow": msg.get("yellow", ""),
                "red": msg.get("red", ""),
            })
        elif t == "commit":
            self._dispatch(self.on_commit, {"text": msg.get("text", "")})
        elif t == "final":
            self._dispatch(self.on_final, {"text": msg.get("text", "")})
        elif t == "reset":
            self._dispatch(self.on_reset)
        elif t == "error":
            self._dispatch(self.on_error, {"message": msg.get("message", "")})
        elif t == "hotwords_updated":
            self._dispatch(self.on_hotwords_updated, {"count": msg.get("count", 0)})
        elif t == "pong":
            self._pong_received = True

    def _dispatch(self, fn: Callback | None, *args: Any) -> None:
        if fn is not None:
            _dispatch(fn, *args)

    def _emit_error(self, message: str) -> None:
        self._dispatch(self.on_error, {"message": message})

    # ── 发送（线程安全）───────────────────────────────

    def send_command(self, cmd: dict[str, Any]) -> bool:
        with self._lock:
            ws = self._ws
            if ws is None or not self.connected:
                return False
            try:
                ws.send(json.dumps(cmd, ensure_ascii=False))
                return True
            except Exception:  # noqa: BLE001
                return False

    def send_audio(self, pcm: bytes) -> bool:
        with self._lock:
            ws = self._ws
            if ws is None or not self.connected:
                return False
            try:
                ws.send_binary(pcm)
                return True
            except Exception:  # noqa: BLE001
                return False

    def start_listening(self) -> bool:
        return self.send_command({"command": "start_listening"})

    def stop_listening(self) -> bool:
        return self.send_command({"command": "stop_listening"})

    def reset(self) -> bool:
        return self.send_command({"command": "reset"})

    def commit_now(self) -> bool:
        return self.send_command({"command": "commit_now"})

    def send_config(self, llm: dict[str, Any] | None = None,
                    hotwords: str = "", hotword_path: str = "") -> bool:
        cmd: dict[str, Any] = {"command": "config"}
        if llm is not None:
            cmd["llm"] = llm
        cmd["hotwords"] = hotwords
        cmd["hotword_path"] = hotword_path
        return self.send_command(cmd)
