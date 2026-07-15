#!/bin/bash
# ---------------------------------------------------------------------------
# 蛐蛐 FunASR 容器入口
# 1. 检查/下载模型文件（已缓存则跳过）
# 2. 启动 gunicorn 服务
# ---------------------------------------------------------------------------
set -e

echo "[entrypoint] 开始模型检查..." >&2
python3 /app/download_models.py

echo "[entrypoint] 启动 FunASR 服务..." >&2
exec uv run gunicorn --bind 0.0.0.0:8000 \
    --workers 1 --threads 4 \
    --timeout 300 --graceful-timeout 30 \
    "funasr_server:app"
