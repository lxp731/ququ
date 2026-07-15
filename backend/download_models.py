#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
FunASR 模型下载脚本
并行下载所有模型文件到 MODELSCOPE_CACHE 目录（默认 /models）
snapshot_download 内置缓存检测，已下载的模型自动跳过
"""

import os
import sys
import threading

from modelscope.hub.snapshot_download import snapshot_download

CACHE_DIR = os.environ.get("MODELSCOPE_CACHE")  # Docker 设置 /models，本地 None→使用默认 ~/.cache/modelscope

MODELS = [
    ("damo/speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-pytorch", "v2.0.4"),
    ("damo/speech_fsmn_vad_zh-cn-16k-common-pytorch", "v2.0.4"),
    ("damo/punc_ct-transformer_zh-cn-common-vocab272727-pytorch", "v2.0.4"),
]


def download_one(model_id, revision, results, idx):
    """下载单个模型（snapshot_download 内部已缓存则跳过）"""
    try:
        path = snapshot_download(model_id, revision=revision, cache_dir=CACHE_DIR)
        results[idx] = (True, path)
    except Exception as e:
        results[idx] = (False, str(e))


def main():
    print("[download_models] 检查/下载模型...", flush=True)

    results = {}
    threads = []
    for i, (model_id, revision) in enumerate(MODELS):
        t = threading.Thread(target=download_one, args=(model_id, revision, results, i), daemon=True)
        t.start()
        threads.append(t)

    for t in threads:
        t.join()

    names = ["ASR", "VAD", "标点"]
    all_ok = True
    for i, (model_id, _) in enumerate(MODELS):
        r = results.get(i)
        label = names[i]
        if r and r[0]:
            print(f"  ✓ {label}", flush=True)
        else:
            err = r[1] if r else "线程未返回"
            print(f"  ✗ {label}: {err}", flush=True)
            all_ok = False

    if not all_ok:
        print("[download_models] 模型下载失败，请检查网络。", flush=True)
        sys.exit(1)

    print("[download_models] 模型就绪。", flush=True)


if __name__ == "__main__":
    main()
