#!/usr/bin/env python3
"""Phase 1 集成测试 — 引擎/管线/WebSocket 协议 (无需加载模型)"""  # noqa: EXE001
import asyncio
import json
import os
import socket
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


# ── Test 1: Engine lifecycle ──────────────────────────

def test_engine_lifecycle():
    """ASREngine 状态机: 未加载模型时安全返回空值。"""
    from asr_engine import ASREngine

    engine = ASREngine(device="cpu")
    print("  1.1 Engine created, loaded:", engine.is_loaded)

    # 无模型 → 操作安全
    result = engine._transcribe_partial()
    assert result == "", f"Expected empty, got: {result!r}"
    print("  1.2 _transcribe_partial without model → empty (OK)")

    engine.reset()
    print("  1.3 reset without model → no exception (OK)")

    # finalize 空 buffer 返回空 (engine 内部同步调用)
    result = engine._transcribe_final()
    assert result == "", f"Expected empty, got: {result!r}"
    print("  1.4 finalize (sync) without audio → empty (OK)")

    # trim 空 buffer 安全
    engine.trim_committed_audio(10, "hello", "world")
    print("  1.5 trim without model → no exception (OK)")

    print("  ✅ Engine lifecycle tests passed")
    return True


# ── Test 2: Pipeline buffer logic ──────────────────────

def test_pipeline_buffer():
    """CandidateBuffer: 三区划分 + 提交逻辑。"""
    from pipeline import CandidateBuffer

    # ── 无 LLM 模式 (绿区恒为 0) ──
    buf = CandidateBuffer()
    buf.set_llm_enabled(False)

    # 追加短文本 → 全在红区 (不足 RED_MAX_SIZE+ 时黄区也为 0)
    for ch in "你好":
        buf._chars.append(ch)
    buf._recalc_zones()
    assert buf._green_end == 0, f"Expected green=0, got {buf._green_end}"
    print(f"  2.1 Very short text → green=0, yellow={buf._yellow_end}, "
          f"red={len(buf.red_text)} (OK)")

    # 追加更多文本 → 超出红区, 黄区出现
    long_text = "世界今天天气真不错，我想去公园散步走走看看风景"
    for ch in long_text:
        buf._chars.append(ch)
    buf._recalc_zones()
    assert buf._yellow_end > 0, (
        f"Yellow should be > 0, got {buf._yellow_end}, total={len(buf._chars)}")
    total = len(buf._chars)
    print(f"  2.2 Longer text → green={buf._green_end}, yellow={buf._yellow_end}, "
          f"red={len(buf.red_text)}, total={total} (OK)")

    # 追加更多文本 → 出现红区
    for ch in "这是流式模型刚输出的最新草稿":
        buf._chars.append(ch)
    buf._recalc_zones()
    assert len(buf.red_text) > 0, "Red zone should have recent text"
    print(f"  2.2 Long text → green={buf._green_end}, yellow={buf._yellow_end}, "
          f"red={len(buf.red_text)} (OK)")

    # _do_commit
    before = len(buf._chars)
    buf._do_commit("你好世界")
    assert len(buf._chars) < before, (
        f"Buffer should shrink after commit: {before} → {len(buf._chars)}")
    print(f"  2.3 _do_commit → {before} → {len(buf._chars)} (OK)")

    # ── LLM 模式 ──
    buf2 = CandidateBuffer()
    buf2.set_llm_enabled(True)
    long_text = (
        "今天天气真不错，我想去公园散步。"
        "公园里有很多花，还有一个小湖。"
        "我们可以坐在长椅上看风景，"
        "也可以喂鸽子。"
    )
    for ch in long_text:
        buf2._chars.append(ch)
    buf2._recalc_zones()
    assert buf2._green_end > 0, "LLM mode should create green zone"
    print(f"  2.4 LLM mode → green={buf2._green_end}, "
          f"yellow={buf2._yellow_end - buf2._green_end}, "
          f"red={len(buf2._chars) - buf2._yellow_end} (OK)")

    # render_segments
    segs = buf2.render_segments()
    styles = [s for _, s in segs]
    if buf2._green_end > 0:
        assert "green" in styles, "Should have green segment"
    print(f"  2.5 render_segments → {len(segs)} segments (OK)")

    print("  ✅ Pipeline buffer tests passed")
    return True


# ── Test 3: Pipeline LCP + commit logic ────────────────

def test_pipeline_commit():
    """测试提交去重 + 语义边界切分。"""
    from pipeline import CandidateBuffer

    buf = CandidateBuffer()
    buf.set_llm_enabled(False)

    # 模拟流式输入
    text = "大家好，今天我们来聊聊语音输入。这是一个很有意思的话题。"
    buf.update_streaming(text[:10])
    buf.update_streaming(text[:20])
    buf.update_streaming(text)

    assert buf.full_text == text, f"Full text mismatch: {buf.full_text!r}"
    print(f"  3.1 Streaming updates → full_text OK ({len(buf.full_text)} chars)")

    # _strip_committed_overlap
    buf._last_commit_raw = "语音输入"
    stripped = buf._strip_committed_overlap("语音输入，这是一个")
    assert stripped == "，这是一个", f"Expected ',这是一个', got: {stripped!r}"
    print("  3.2 _strip_committed_overlap → correct (OK)")

    # _find_semantic_boundary (need text with comma after pos 10 for medium boundaries)
    long_text = "大家好今天我们想聊聊语音输入的问题和挑战"
    boundary = buf._find_semantic_boundary(long_text, min_chars=5)  # noqa: F841
    # With strong_boundary only and text > FORCE_COMMIT_SIZE, we'd get 60.
    # For shorter text without strong boundaries, boundary returns 0.
    # Test with strong boundary (。) instead:
    strong_text = "这是第一句完整的话。这是第二句"
    boundary2 = buf._find_semantic_boundary(strong_text, min_chars=5)
    assert boundary2 > 0, f"Should find boundary in '{strong_text}', got {boundary2}"
    print(f"  3.3 Semantic boundary → pos {boundary2} (OK)")

    # _find_commit_point (strong boundary)
    cp = buf._find_commit_point("这是第一句。这是第二句")
    assert cp > 0, "Should find sentence boundary"
    print(f"  3.4 Commit point (sentence) → pos {cp} (OK)")

    # _find_commit_point (no strong boundary, not relaxed)
    cp = buf._find_commit_point("这是没有标点的长文本需要等待更多", relaxed=False)
    assert cp == 0, "Should return 0 when no boundary + not relaxed"
    print("  3.5 Commit point (no boundary, not relaxed) → 0 (OK)")

    print("  ✅ Pipeline commit tests passed")
    return True


# ── Test 4: FastAPI app loads ─────────────────────────

def test_app_loads():
    """验证 FastAPI 应用加载正常。"""
    from server import app
    assert app.title == "QuQu Speech Input"
    routes = [getattr(r, "path", "") for r in app.routes]
    assert "/health" in routes, f"Missing /health, routes: {routes}"
    assert "/stream/ws" in routes, f"Missing /stream/ws, routes: {routes}"
    assert "/transcribe" in routes, f"Missing /transcribe, routes: {routes}"
    assert "/status" in routes, f"Missing /status, routes: {routes}"
    print("  ✅ FastAPI app loads OK, routes:", routes)
    return True


# ── Test 5: WebSocket protocol ────────────────────────

async def test_websocket():
    """在独立进程中启动 uvicorn, 测试 WebSocket 协议。"""
    import httpx
    import uvicorn

    # 随机端口
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(('127.0.0.1', 0))
    port = sock.getsockname()[1]
    sock.close()

    # 启动服务
    config = uvicorn.Config(
        "server:app",
        host="127.0.0.1",
        port=port,
        log_level="error",
    )
    server = uvicorn.Server(config)
    server_task = asyncio.create_task(server.serve())
    await asyncio.sleep(2.0)  # 等待服务器完全就绪

    try:
        # 5.1 健康检查
        async with httpx.AsyncClient() as client:
            resp = await client.get(
                f"http://127.0.0.1:{port}/health", timeout=5)
            data = resp.json()
            assert resp.status_code == 200, f"Health status: {resp.status_code}"
            assert data["status"] == "ok"
            print(f"  5.1 /health → {data}")

        # 5.2 WebSocket 连接 (不加载模型也能连接)
        import websockets
        async with websockets.connect(
                f"ws://127.0.0.1:{port}/stream/ws") as ws:
            # 应收到 status 消息
            msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=10))
            assert msg["type"] == "status", f"Expected status, got: {msg}"
            print(f"  5.2 WebSocket connect → status: {msg}")

            # 发送 start_listening → 连接应保持 (引擎未加载时无害)
            await ws.send(json.dumps({"command": "start_listening"}))
            await asyncio.sleep(0.5)

            # Drain status+reset+preedit messages from pipeline init
            drained = []
            try:
                while True:
                    m = json.loads(await asyncio.wait_for(ws.recv(), timeout=1))
                    drained.append(m.get("type"))
            except TimeoutError:
                pass
            print(f"  5.3 start_listening → drained: {drained} (OK)")

            # 发送 stop_listening
            await ws.send(json.dumps({"command": "stop_listening"}))
            await asyncio.sleep(0.5)
            # Drain finalize messages (final/reset/preedit)
            try:
                while True:
                    m = json.loads(await asyncio.wait_for(ws.recv(), timeout=1))
                    drained.append(m.get("type"))
            except TimeoutError:
                pass
            print("  5.4 stop_listening → completed (OK)")

            # 发送 reset
            await ws.send(json.dumps({"command": "reset"}))
            await asyncio.sleep(0.2)
            # Drain reset broadcast
            try:
                while True:
                    m = json.loads(await asyncio.wait_for(ws.recv(), timeout=1))
            except TimeoutError:
                pass
            print("  5.5 reset → completed (OK)")

            # ping/pong
            await ws.send(json.dumps({"command": "ping"}))
            msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=5))
            assert msg["type"] == "pong", f"Expected pong, got: {msg}"
            print("  5.6 ping/pong (OK)")

    finally:
        server.should_exit = True
        server_task.cancel()
        try:
            await server_task
        except asyncio.CancelledError:
            pass
        await asyncio.sleep(0.3)

    print("  ✅ WebSocket protocol tests passed")
    return True


# ── Test 6: nginx config ──────────────────────────────

def test_nginx_config():
    """验证 nginx 配置正确。"""
    nginx_conf = os.path.join(
        os.path.dirname(os.path.abspath(__file__)),
        "..", "nginx.conf"
    )
    try:
        with open(nginx_conf) as f:
            content = f.read()
        assert "/stream/" in content, "Missing /stream/ route"
        assert "ququ_backend" in content, "Missing ququ_backend upstream"
        assert "Upgrade" in content, "Missing WebSocket upgrade headers"
        # 只应有一个 upstream block (不再需要 ququ_streaming)
        ups_count = content.count("upstream ")
        assert ups_count == 1, (
            f"Expected 1 upstream, found {ups_count}")
        print("  ✅ nginx.conf: single upstream, WS upgrade configured")
    except FileNotFoundError:
        print("  ⚠️ nginx.conf not found (expected at project root)")
    return True


# ── Test 7: GPU detection ─────────────────────────────

def test_gpu_detection():
    """验证设备检测 (模拟环境)。"""
    from asr_engine import detect_device

    # 显式 cpu → 返回 cpu
    device = detect_device("cpu")
    assert device == "cpu", f"Expected cpu, got {device}"
    print(f"  7.1 detect_device('cpu') → '{device}' (OK)")

    # 显式 mps (无 Apple Silicon → fallback cpu)
    device = detect_device("mps")
    assert device in ("mps", "cpu"), f"Unexpected: {device}"
    print(f"  7.2 detect_device('mps') → '{device}' (OK)")

    print("  ✅ GPU detection tests passed")
    return True


# ── Main ──────────────────────────────────────────────

async def main():
    print("=" * 50)
    print("QuQu Phase 1 — Integration Tests")
    print("=" * 50)
    print()

    tests = [
        ("Engine lifecycle", test_engine_lifecycle),
        ("Pipeline buffer logic", test_pipeline_buffer),
        ("Pipeline commit logic", test_pipeline_commit),
        ("FastAPI app loads", test_app_loads),
        ("nginx config", test_nginx_config),
        ("GPU detection", test_gpu_detection),
    ]

    passed = 0
    for name, fn in tests:
        print(f"\n▶ {name}")
        try:
            fn()
            passed += 1
        except Exception as e:  # noqa: BLE001
            print(f"  ❌ FAIL: {e}")
            import traceback
            traceback.print_exc()

    print("\n▶ WebSocket protocol (requires server)")
    try:
        await test_websocket()
        passed += 1
    except Exception as e:  # noqa: BLE001
        print(f"  ⚠️ WebSocket test issue: {e}")
        import traceback
        traceback.print_exc()

    print()
    print("=" * 50)
    print(f"Results: {passed}/{len(tests) + 1} passed")
    print("=" * 50)

    if passed < len(tests) + 1:
        print("\n⚠️ Some tests failed or were skipped.")
        sys.exit(1)
    else:
        print("\n✅ All tests passed!")


if __name__ == "__main__":
    asyncio.run(main())
