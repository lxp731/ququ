#!/bin/bash
# ---------------------------------------------------------------------------
# 蛐蛐 FunASR 容器入口
# 1. 检查/下载模型文件（已缓存则跳过）
# 2. 启动 gunicorn 服务
# ---------------------------------------------------------------------------
set -e

echo "[entrypoint] 开始模型检查..." >&2
/app/.venv/bin/python3 /app/download_models.py

echo "[entrypoint] 启动 FunASR 服务..." >&2
exec /app/.venv/bin/gunicorn --bind ${FUNASR_HOST:-0.0.0.0}:${FUNASR_PORT:-8000} \
    --workers 1 --threads 4 \
    --timeout 300 --graceful-timeout 30 \
    "funasr_server:app"
