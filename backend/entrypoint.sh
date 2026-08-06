#!/bin/bash
# ---------------------------------------------------------------------------
# 蛐蛐 FunASR 统一服务入口
# 1. 检查/下载模型文件（已缓存则跳过）
# 2. 启动 FastAPI + uvicorn 服务 (REST + WebSocket)
# ---------------------------------------------------------------------------
set -e

echo "[entrypoint] 开始模型检查..." >&2
/app/.venv/bin/python3 /app/download_models.py

echo "[entrypoint] 启动 QuQu 统一服务 (FastAPI + uvicorn :8000)..." >&2
exec /app/.venv/bin/uvicorn server:app \
    --host ${FUNASR_HOST:-0.0.0.0} \
    --port ${FUNASR_PORT:-8000} \
    --ws-ping-interval 20 \
    --ws-ping-timeout 10 \
    --timeout-keep-alive 300 \
    --log-level info
