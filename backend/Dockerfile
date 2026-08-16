# ── 构建阶段：安装依赖（需要编译工具，走宿主机代理）──
FROM python:3.14-slim AS builder

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

# 清华 APT 源
RUN sed -i 's|http://deb.debian.org/debian|https://mirrors.tuna.tsinghua.edu.cn/debian|g' \
    /etc/apt/sources.list.d/debian.sources 2>/dev/null || \
    sed -i 's|http://deb.debian.org/debian|https://mirrors.tuna.tsinghua.edu.cn/debian|g' \
    /etc/apt/sources.list

RUN apt-get update && apt-get install -y --no-install-recommends \
    libsndfile1 curl gcc g++ \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir uv \
    -i https://pypi.tuna.tsinghua.edu.cn/simple

ENV UV_LINK_MODE=copy

# 锁定文件: 保证镜像构建可复现 (uv sync 使用 --locked 拒绝漂移)
COPY pyproject.toml uv.lock ./
RUN uv sync --locked --no-dev --no-editable

# ── 运行阶段 ──
FROM python:3.14-slim

WORKDIR /app

# 清除宿主机注入的代理变量
ENV http_proxy=""
ENV https_proxy=""
ENV HTTP_PROXY=""
ENV HTTPS_PROXY=""
ENV no_proxy=""
ENV NO_PROXY=""

RUN sed -i 's|http://deb.debian.org/debian|https://mirrors.tuna.tsinghua.edu.cn/debian|g' \
    /etc/apt/sources.list.d/debian.sources 2>/dev/null || \
    sed -i 's|http://deb.debian.org/debian|https://mirrors.tuna.tsinghua.edu.cn/debian|g' \
    /etc/apt/sources.list \
    && apt-get update && apt-get install -y --no-install-recommends \
    libsndfile1 curl \
    && rm -rf /var/lib/apt/lists/*

# 从构建阶段复制 .venv 和应用代码
COPY --from=builder /app/.venv /app/.venv
COPY server.py asr_engine.py pipeline.py llm_optimizer.py download_models.py entrypoint.sh ./

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV MODELSCOPE_CACHE=/models
ENV OMP_NUM_THREADS=4
ENV DAMO_ROOT=/models/hub/damo
ENV QUQU_TMP_DIR=/tmp
ENV FUNASR_HOST=0.0.0.0
ENV FUNASR_PORT=8000

# 非 root 运行 (最小权限; 模型缓存卷需属主与 uid 1000 一致)
RUN useradd --create-home --uid 1000 ququ \
    && mkdir -p /models /tmp/ququ_logs \
    && chown -R ququ:ququ /models /tmp/ququ_logs /app
USER ququ

EXPOSE 8000

CMD ["/bin/bash", "/app/entrypoint.sh"]
