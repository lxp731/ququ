FROM python:3.14-slim

WORKDIR /app

# 清除主机代理设置
ENV http_proxy=""
ENV https_proxy=""
ENV HTTP_PROXY=""
ENV HTTPS_PROXY=""
ENV no_proxy=""
ENV NO_PROXY=""

# uv 国内镜像
ENV UV_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple
ENV UV_EXTRA_INDEX_URL=https://download.pytorch.org/whl/cpu

# 切换为清华 APT 源
RUN sed -i 's|http://deb.debian.org/debian|https://mirrors.tuna.tsinghua.edu.cn/debian|g' \
    /etc/apt/sources.list.d/debian.sources 2>/dev/null || \
    sed -i 's|http://deb.debian.org/debian|https://mirrors.tuna.tsinghua.edu.cn/debian|g' \
    /etc/apt/sources.list

# 系统依赖
RUN apt-get update && apt-get install -y --no-install-recommends \
    libsndfile1 curl gcc g++ \
    && rm -rf /var/lib/apt/lists/*

# 安装 uv
RUN pip install --no-cache-dir uv \
    -i https://pypi.tuna.tsinghua.edu.cn/simple

ENV UV_LINK_MODE=copy

# 用 uv 安装 Python 依赖（CPU-only PyTorch 由 UV_EXTRA_INDEX_URL 控制）
COPY pyproject.toml .
RUN uv sync --no-dev --no-editable

# 应用代码 + 入口脚本
COPY funasr_server.py download_models.py entrypoint.sh ./

# 运行环境
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV MODELSCOPE_CACHE=/models
ENV OMP_NUM_THREADS=4
ENV DAMO_ROOT=/models/hub/damo

EXPOSE 8000

CMD ["/bin/bash", "/app/entrypoint.sh"]
