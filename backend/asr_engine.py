"""统一 ASR 引擎 — 流式 + 离线修正 + GPU 检测 + 音频裁剪

整合自:
- streaming_asr.py (流式引擎核心)
- funasr_server.py (离线模型加载、转写逻辑)
- YuHuang asr_engine.py (generation stamps, background loop, trim, sync)

单一 ASREngine 类承载所有模型、后台处理循环、回调注册。
"""

import asyncio
import logging
import re
import threading
import time
from collections.abc import Callable

import numpy as np

logger = logging.getLogger("ququ.asr")

# 音频缓冲水位上限 (约 10 分钟 @16k/16bit/mono), 超限丢最旧
MAX_AUDIO_BUFFER_BYTES = 20 * 1024 * 1024
# _finalized_audio 仅用于调试, 保留最近 2MB 即可
MAX_FINALIZED_BYTES = 2 * 1024 * 1024

# ══════════════════════════════════════════════════════
# GPU 检测（移植自 YuHuang）
# ══════════════════════════════════════════════════════


def detect_device(preferred: str = "cuda") -> str:
    """检测可用计算设备。返回 "cuda:0" / "cpu" / "mps"。"""
    if preferred in ("cuda", "gpu"):
        try:
            import torch
            if torch.cuda.is_available():
                count = torch.cuda.device_count()
                name = torch.cuda.get_device_name(0)
                device = "cuda" if count == 1 else "cuda:0"
                logger.info("GPU detected: %s (%s)", name, device)
                return device
        except ImportError:
            pass
        logger.info("CUDA not available, falling back to CPU")
        return "cpu"

    if preferred == "mps":
        try:
            import torch
            if torch.backends.mps.is_available():
                logger.info("MPS (Apple Silicon GPU) detected")
                return "mps"
        except ImportError:
            pass
        logger.info("MPS not available, falling back to CPU")
        return "cpu"

    return preferred  # pass through "cpu" or explicit device


# ══════════════════════════════════════════════════════
# 工具
# ══════════════════════════════════════════════════════


def _preprocess_audio(audio: np.ndarray) -> np.ndarray:
    """去直流偏移 + 防止削波。"""
    audio = audio - np.mean(audio)
    peak = np.max(np.abs(audio))
    if peak > 0.9:
        audio = audio * (0.9 / peak)
    return audio.astype(np.float32)


def _clean_sense_voice_text(text: str) -> str:
    """去除 SenseVoice 特殊 token: <|zh|>, <|NEUTRAL|> 等。"""
    return re.sub(r'<\|[^|]+\|>', '', text).strip()


# ══════════════════════════════════════════════════════
# ASR 引擎
# ══════════════════════════════════════════════════════


class ASREngine:
    """统一语音识别引擎。

    模型:
      - online:  paraformer-zh-streaming (流式实时解码)
      - offline: iic/SenseVoiceSmall  (离线纠错, 中英混合, 自带标点/ITN)
                 fallback → paraformer-large + ct-punc

    后台循环:
      - _processing_loop: 150ms 轮询, 送新增音频到流式模型
      - _periodic_offline_correction: 按字数+时长双重触发 SenseVoice 全量纠正

    generation stamp:
      每次 reset / trim / offline_sync 时递增, 作废在途的流式/离线解码结果,
      防止旧音频文本追加到已更新的 buffer 尾部导致重复。
    """

    INTERMEDIATE_INTERVAL = 0.3  # 流式回调最小间隔 (秒), 防洪水
    OFFLINE_TRIGGER_CHARS = 25   # 离线纠正触发: 新增字数
    OFFLINE_TRIGGER_FIRST = 10   # 首轮更低阈值
    OFFLINE_TRIGGER_AUDIO_S = 2.5  # 离线纠正触发: 新增录音时长
    OFFLINE_TRIGGER_FIRST_S = 1.5
    OFFLINE_MIN_INTERVAL = 1.0   # 最小离线纠正间隔
    OFFLINE_POLL_INTERVAL = 0.3
    PROCESSING_POLL_INTERVAL = 0.15

    def __init__(
        self,
        online_model: str = "shuai1618/paraformer-zh-streaming",
        offline_model: str = "iic/SenseVoiceSmall",
        fallback_model: str = (
            "iic/speech_paraformer-large_asr_nat-zh-cn-"
            "16k-common-vocab8404-pytorch"
        ),
        vad_model: str = "iic/speech_fsmn_vad_zh-cn-16k-common-pytorch",
        punc_model: str = (
            "iic/punc_ct-transformer_zh-cn-common-vocab272727-pytorch"
        ),
        sample_rate: int = 16000,
        device: str = "cpu",
    ):
        self.sample_rate = sample_rate
        self.device = detect_device(device)

        # ── 模型占位 ──
        self._online_model = None
        self._offline_model = None      # SenseVoiceSmall
        self._fallback_model = None     # paraformer-large
        self._vad_model = None
        self._punc_model = None
        self._models_loaded = False

        # ── 模型名 ──
        self._online_name = online_model
        self._offline_name = offline_model
        self._fallback_name = fallback_model
        self._vad_name = vad_model
        self._punc_name = punc_model

        # ── 音频缓冲 (executor 线程与事件循环共享, 需加锁) ──
        self._audio_buffer = bytearray()
        self._finalized_audio = bytearray()  # 已裁剪 (debug)
        self._audio_lock = threading.Lock()

        # ── 离线模型串行锁 (SenseVoice/fallback 非线程安全) ──
        self._offline_lock = threading.Lock()

        # ── 流式解码状态 ──
        self._stream_cache: dict = {}
        self._stream_audio_offset: int = 0     # int16 样本偏移量
        self._stream_generation: int = 0        # 代数戳
        self._accumulated_raw: str = ""         # 所有 chunk 累积
        self._last_raw_text: str = ""
        self._simple_append: bool = False      # 直追加模式 (离线 sync 后)

        # ── 离线纠正状态 ──
        self._offline_text: str = ""
        self._offline_text_generation: int = 0
        self._offline_last_text_len: int = 0
        self._offline_last_audio_samples: int = 0

        # ── 后台任务 ──
        self._running: bool = False
        self._processing: bool = False
        self._offline_busy: bool = False
        self._processing_task: asyncio.Task | None = None
        self._offline_task: asyncio.Task | None = None
        self._new_audio_event = asyncio.Event()

        # ── PTT 状态 ──
        self._ptt_active: bool = False
        self._hotwords: str = ""

        # ── 回调 ──
        self._intermediate_callback: Callable | None = None
        self._offline_callback: Callable | None = None

        # ── 加载 ──
        self._load_models()

    # ══════════════════════════════════════════════════
    # 模型加载
    # ══════════════════════════════════════════════════

    def _load_models(self):
        try:
            from funasr import AutoModel

            logger.info(
                "Loading online ASR: %s (device=%s)",
                self._online_name, self.device,
            )
            self._online_model = AutoModel(
                model=self._online_name,
                device=self.device,
                disable_update=True,
            )

            if self._offline_name:
                logger.info(
                    "Loading offline ASR: %s (device=%s)",
                    self._offline_name, self.device,
                )
                self._offline_model = AutoModel(
                    model=self._offline_name,
                    device=self.device,
                    disable_update=True,
                    trust_remote_code=True,
                )

            logger.info(
                "Loading fallback ASR: %s (device=%s)",
                self._fallback_name, self.device,
            )
            self._fallback_model = AutoModel(
                model=self._fallback_name,
                device=self.device,
                disable_update=True,
            )

            logger.info(
                "Loading VAD: %s (device=%s)",
                self._vad_name, self.device,
            )
            self._vad_model = AutoModel(
                model=self._vad_name,
                device=self.device,
                disable_update=True,
            )

            logger.info(
                "Loading punc: %s (device=%s)",
                self._punc_name, self.device,
            )
            self._punc_model = AutoModel(
                model=self._punc_name,
                device=self.device,
                disable_update=True,
            )

            self._models_loaded = True
            logger.info("All ASR models loaded successfully")

        except ImportError:
            logger.warning("FunASR not installed — ASR in mock mode")
            self._models_loaded = False
        except Exception as e:  # noqa: BLE001
            logger.error("Failed to load ASR models: %s", e)
            self._models_loaded = False

    # ══════════════════════════════════════════════════
    # 回调注册
    # ══════════════════════════════════════════════════

    def set_intermediate_callback(self, cb: Callable):
        self._intermediate_callback = cb

    def set_offline_callback(self, cb: Callable):
        self._offline_callback = cb

    @property
    def is_loaded(self) -> bool:
        return self._models_loaded

    def set_hotwords(self, hotwords: str):
        """设置热词, 传给各模型的 generate()。

        FunASR hotword 参数用空格分隔, 逗号/换行统一转空格。
        建议每行一个专有名词（Claude、Codex 这类生僻词），
        不要放常见词（会干扰正常识别）。
        """
        raw = hotwords.replace(",", " ").replace("，", " ").replace("\n", " ")
        words = [w.strip() for w in raw.split() if w.strip()]
        self._hotwords = " ".join(words)
        logger.info("Hotwords: %d words", len(words))

    def get_accumulated_text(self) -> str:
        return self._accumulated_raw

    # ══════════════════════════════════════════════════
    # 状态管理
    # ══════════════════════════════════════════════════

    def reset(self):
        with self._audio_lock:
            self._audio_buffer = bytearray()
            self._finalized_audio = bytearray()
        self._stream_cache = {}
        self._stream_audio_offset = 0
        self._stream_generation += 1
        self._accumulated_raw = ""
        self._last_raw_text = ""
        self._offline_text = ""
        self._offline_text_generation = 0
        self._offline_last_text_len = 0
        self._offline_last_audio_samples = 0
        self._simple_append = False
        self._new_audio_event.clear()

    # ── PTT 状态 (由 server.py 管理, 断连时清理) ──

    def set_ptt_active(self, active: bool):
        self._ptt_active = bool(active)

    def is_ptt_active(self) -> bool:
        return self._ptt_active

    def trim_committed_audio(self, char_count: int, commit_text: str = "",
                             remaining_text: str = ""):
        """裁剪已提交部分对应的音频, 实现增量离线纠正。

        pipeline commit 后调用, 从 _audio_buffer 头部移除对应字节,
        使后续离线纠正只处理未提交音频, 避免 O(n²) 全量重算。
        """
        if not char_count or not self._audio_buffer:
            return

        with self._audio_lock:
            audio_bytes = len(self._audio_buffer)
            audio_samples = audio_bytes // 2

            # 转写滞后余量: 尾部 0.6s 音频不参与比例分配
            LAG_MARGIN_SAMPLES = int(0.6 * self.sample_rate)
            effective_samples = max(0, audio_samples - LAG_MARGIN_SAMPLES)

            def _char_weight(c: str) -> float:
                if c.isascii():
                    return 0.3 if c.isalnum() else 0.0
                return 1.0

            if commit_text:
                committed_weight = sum(_char_weight(c) for c in commit_text)
            else:
                committed_weight = char_count

            if commit_text and remaining_text:
                total_weight = committed_weight + sum(
                    _char_weight(c) for c in remaining_text)
                total_weight = max(1.0, total_weight)
            elif self._accumulated_raw:
                total_weight = sum(
                    _char_weight(c) for c in self._accumulated_raw)
                total_weight = max(1.0, total_weight)
            else:
                total_weight = max(1, char_count)

            weight_ratio = min(1.0, committed_weight / total_weight)
            remove_samples = int(effective_samples * weight_ratio)
            remove_bytes = remove_samples * 2
            remove_bytes = min(remove_bytes, audio_bytes)

            if remove_bytes <= 0:
                return

            self._finalized_audio.extend(self._audio_buffer[:remove_bytes])
            if len(self._finalized_audio) > MAX_FINALIZED_BYTES:
                del self._finalized_audio[:-MAX_FINALIZED_BYTES]
            del self._audio_buffer[:remove_bytes]

            self._stream_audio_offset = max(
                0, self._stream_audio_offset - (remove_bytes // 2))

            if remaining_text:
                self._accumulated_raw = remaining_text
            elif self._accumulated_raw and char_count <= len(self._accumulated_raw):
                self._accumulated_raw = self._accumulated_raw[char_count:]
            else:
                self._accumulated_raw = ""

            self._offline_last_text_len = max(
                0, self._offline_last_text_len - char_count)
            self._offline_last_audio_samples = max(
                0, len(self._audio_buffer) // 2)

        # 裁剪后重置流式缓存
        self._stream_cache = {}
        self._last_raw_text = ""
        self._stream_generation += 1
        self._simple_append = True

        logger.info(
            "Audio trimmed: weight=%.1f/%.1f (%.0f%%) → %d bytes, "
            "committed='%s' (%d chars), remaining: %d bytes",
            committed_weight, total_weight, weight_ratio * 100,
            remove_bytes, commit_text[:20], char_count,
            len(self._audio_buffer),
        )

    # ══════════════════════════════════════════════════
    # 音频输入
    # ══════════════════════════════════════════════════

    async def process_audio(self, pcm_data: bytes):
        """接收音频数据 (非阻塞: 只积累缓冲, 触发后台处理)。

        带水位上限: 超限时丢弃最旧数据, 防止长时间会话内存无界增长。
        """
        if not pcm_data:
            return
        with self._audio_lock:
            self._audio_buffer.extend(pcm_data)
            overflow = len(self._audio_buffer) - MAX_AUDIO_BUFFER_BYTES
            if overflow > 0:
                del self._audio_buffer[:overflow]
                logger.warning(
                    "Audio buffer overflow: dropped %d bytes (cap %d)",
                    overflow, MAX_AUDIO_BUFFER_BYTES)
        if self._models_loaded:
            self._new_audio_event.set()

    # ══════════════════════════════════════════════════
    # 后台处理循环
    # ══════════════════════════════════════════════════

    def start_processing(self):
        if self._processing_task is None:
            self._running = True
            self._processing_task = asyncio.create_task(self._processing_loop())
            self._offline_task = asyncio.create_task(
                self._periodic_offline_correction())
            logger.info("ASR background processing started")

    async def stop_processing(self):
        self._running = False
        self._new_audio_event.set()  # 唤醒等待
        for task in (self._processing_task, self._offline_task):
            if task:
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass
        self._processing_task = None
        self._offline_task = None

    async def _processing_loop(self):
        while self._running:
            try:
                await asyncio.wait_for(
                    self._new_audio_event.wait(),
                    timeout=self.PROCESSING_POLL_INTERVAL,
                )
            except TimeoutError:
                pass
            except asyncio.CancelledError:
                break

            self._new_audio_event.clear()

            if (not self._models_loaded
                    or len(self._audio_buffer) < 800
                    or self._processing):
                continue

            self._processing = True
            try:
                loop = asyncio.get_running_loop()
                text = await loop.run_in_executor(
                    None, self._transcribe_partial)
                if text and text.strip():  # noqa: SIM102
                    if self._intermediate_callback:
                        await self._intermediate_callback(text.strip())
            except Exception as e:  # noqa: BLE001
                logger.error("ASR intermediate error: %s", e)
            finally:
                self._processing = False

    async def _periodic_offline_correction(self):
        _last_offline_at = 0.0
        _cycle_count = 0
        STATUS_EVERY = 17

        while self._running:
            try:
                await asyncio.sleep(self.OFFLINE_POLL_INTERVAL)
            except asyncio.CancelledError:
                break
            if not self._running:
                break

            _cycle_count += 1
            if (not self._models_loaded
                    or self._offline_busy
                    or not self._audio_buffer):
                continue

            current_text_len = len(self._accumulated_raw)
            new_chars = current_text_len - self._offline_last_text_len
            first_run = (self._offline_last_text_len == 0)

            current_audio_samples = len(self._audio_buffer) // 2
            new_audio_s = (current_audio_samples
                           - self._offline_last_audio_samples
                           ) / self.sample_rate

            char_threshold = (
                self.OFFLINE_TRIGGER_FIRST if first_run
                else self.OFFLINE_TRIGGER_CHARS
            )
            audio_threshold = (
                self.OFFLINE_TRIGGER_FIRST_S if first_run
                else self.OFFLINE_TRIGGER_AUDIO_S
            )

            if _cycle_count % STATUS_EVERY == 0:
                buf_len = len(self._audio_buffer)
                audio_dur = buf_len / (self.sample_rate * 2)
                logger.info(
                    "Offline check: text=%d chars "
                    "(new=%d/%d), audio=%.1fs (new=%.1fs/%.1fs)",
                    current_text_len, new_chars, char_threshold,
                    audio_dur, new_audio_s, audio_threshold,
                )

            trigger = (new_chars >= char_threshold
                       or new_audio_s >= audio_threshold)
            if not trigger:
                continue

            now = time.time()
            if now - _last_offline_at < self.OFFLINE_MIN_INTERVAL:
                continue

            audio_dur = len(self._audio_buffer) / (self.sample_rate * 2)
            if audio_dur < 1.0:
                continue

            _last_offline_at = now
            self._offline_last_audio_samples = current_audio_samples
            self._offline_busy = True

            reason = "chars" if new_chars >= char_threshold else "audio"
            try:
                gen_snapshot = self._stream_generation
                loop = asyncio.get_running_loop()
                text = await loop.run_in_executor(
                    None, self._run_offline_quick)
                if gen_snapshot != self._stream_generation:
                    logger.info(
                        "Offline correction dropped: "
                        "audio trimmed/reset during decode")
                    continue
                if text and text.strip():
                    self._offline_text = text.strip()
                    self._offline_text_generation += 1
                    self._offline_last_text_len = len(self._offline_text)
                    logger.info(
                        "Offline correction (#%d): %d chars (+%d new, "
                        "%.0fs audio, reason=%s)",
                        self._offline_text_generation,
                        len(self._offline_text), new_chars,
                        audio_dur, reason,
                    )
                    if self._offline_callback:
                        await self._offline_callback(
                            self._offline_text,
                            self._offline_text_generation,
                        )
                    self._sync_streaming_from_offline()
                else:
                    logger.warning(
                        "Offline correction empty (audio=%.0fs)", audio_dur)
            except Exception as e:
                logger.error("Offline correction error: %s", e, exc_info=True)  # noqa: G201
            finally:
                self._offline_busy = False

    # ══════════════════════════════════════════════════
    # 离线快速纠正 (SenseVoice)
    # ══════════════════════════════════════════════════

    def _run_offline_quick(self) -> str:
        with self._audio_lock:
            buf_snapshot = bytes(self._audio_buffer)
        if len(buf_snapshot) < 1600:
            return ""
        audio_np = np.frombuffer(buf_snapshot, dtype=np.int16)
        audio_float = audio_np.astype(np.float32) / 32768.0
        audio_float = _preprocess_audio(audio_float)

        # 离线模型非线程安全: 串行化 (与 _transcribe_final / 周期性纠正互斥)
        with self._offline_lock:
            try:
                if self._offline_model:
                    res = self._offline_model.generate(
                        input=audio_float,
                        language="zh",
                        use_itn=True,
                        hotword=self._hotwords,
                    )
                    if res and len(res) > 0:
                        raw = res[0].get("text", "")
                        text = _clean_sense_voice_text(raw)
                        if text:
                            return text

                # fallback
                if self._fallback_model is None:
                    return ""
                res = self._fallback_model.generate(
                    input=audio_float, hotword=self._hotwords)
                if res and len(res) > 0:
                    text = (res[0].get("text", "") or "").strip()
                    if text:
                        return text
            except Exception as e:  # noqa: BLE001
                logger.warning("Offline quick ASR failed: %s", e)
        return ""

    def _sync_streaming_from_offline(self):
        """离线纠正后重置流式状态, 后续增量追加到离线文本上。"""
        offline_text = self._offline_text
        if not offline_text:
            return
        self._accumulated_raw = offline_text
        self._last_raw_text = ""
        self._stream_cache = {}
        self._stream_audio_offset = max(0, len(self._audio_buffer) // 2)
        self._stream_generation += 1
        self._simple_append = True
        logger.info(
            "Streaming reset after offline correction: "
            "accumulated=%d chars, audio_offset=%d samples",
            len(offline_text), self._stream_audio_offset,
        )

    # ══════════════════════════════════════════════════
    # 流式中间结果 (online)
    # ══════════════════════════════════════════════════

    def _transcribe_partial(self) -> str:
        with self._audio_lock:
            if not self._models_loaded or len(self._audio_buffer) < 800:
                return ""
            buf_len_snapshot = len(self._audio_buffer)
            byte_offset = self._stream_audio_offset * 2
            gen_snapshot = self._stream_generation

            if byte_offset >= buf_len_snapshot:
                return ""

            MAX_BYTES = self.sample_rate * 3 * 2  # 最多 3s 音频
            process_end = min(byte_offset + MAX_BYTES, buf_len_snapshot)
            new_bytes = bytes(self._audio_buffer[byte_offset:process_end])

        if len(new_bytes) < 800:
            return ""

        if self._online_model is None:
            return ""

        audio_np = np.frombuffer(new_bytes, dtype=np.int16)
        try:
            audio_float = audio_np.astype(np.float32) / 32768.0
            audio_float = _preprocess_audio(audio_float)

            res = self._online_model.generate(
                input=audio_float,
                cache=self._stream_cache,
                is_final=False,
                chunk_size=[5, 10, 5],
                hotword=self._hotwords,
            )

            if gen_snapshot != self._stream_generation:
                logger.info(
                    "ASR partial dropped: stream state reset during decode")
                return ""

            self._stream_audio_offset += len(audio_np)

            if res and len(res) > 0:
                chunk_text = (res[0].get("text", "") or "").strip()
                if chunk_text:
                    self._accumulate(chunk_text)
                    return self._accumulated_raw
        except Exception as e:  # noqa: BLE001
            logger.debug("Partial transcription error: %s", e)
            try:
                self._stream_audio_offset += len(audio_np)
            except NameError:
                self._stream_audio_offset += int(len(new_bytes) // 2)

        return self._accumulated_raw if self._accumulated_raw else ""

    def _accumulate(self, chunk_text: str):
        """增量累积, 抗上下文重置拼接。"""
        if not chunk_text:
            return

        if self._simple_append:
            prev = self._last_raw_text
            lcp = 0
            max_lcp = min(len(chunk_text), len(prev))
            while lcp < max_lcp and chunk_text[lcp] == prev[lcp]:
                lcp += 1
            if lcp >= len(prev) or lcp > 0:
                new_content = chunk_text[lcp:]
                if new_content:
                    self._accumulated_raw += new_content
            else:
                self._accumulated_raw += chunk_text
            self._last_raw_text = chunk_text
            return

        if not self._accumulated_raw:
            self._accumulated_raw = chunk_text
            self._last_raw_text = chunk_text
            return

        prev = self._last_raw_text
        lcp = 0
        max_lcp = min(len(chunk_text), len(prev))
        while lcp < max_lcp and chunk_text[lcp] == prev[lcp]:
            lcp += 1

        if lcp >= len(prev) or lcp > 0:
            new_content = chunk_text[lcp:]
            if new_content:
                self._accumulated_raw += new_content
        else:
            best_overlap = 0
            search_limit = min(
                len(chunk_text), len(self._accumulated_raw), 80)
            for i in range(search_limit, 0, -1):
                if self._accumulated_raw.endswith(chunk_text[:i]):
                    best_overlap = i
                    break
            if best_overlap > 0:
                new_content = chunk_text[best_overlap:]
                if new_content:
                    self._accumulated_raw += new_content
            elif chunk_text in self._accumulated_raw:
                pass  # 冗余, 跳过
            else:
                self._accumulated_raw += chunk_text

        self._last_raw_text = chunk_text

    # ══════════════════════════════════════════════════
    # 尾部音频补刀 + 最终转写
    # ══════════════════════════════════════════════════

    async def flush_final_offline(self):
        """松键前最后一次离线解码: 把尚未解碼的尾部音频抛回文本链。"""
        if not self._models_loaded or not self._audio_buffer:
            return
        current_samples = len(self._audio_buffer) // 2
        new_samples = current_samples - self._offline_last_audio_samples
        if new_samples < int(0.2 * self.sample_rate):
            return
        logger.info(
            "Final offline flush: +%.1fs undecoded tail audio",
            new_samples / self.sample_rate)
        self._offline_busy = True
        try:
            self._offline_last_audio_samples = current_samples
            gen_snapshot = self._stream_generation
            loop = asyncio.get_running_loop()
            text = await loop.run_in_executor(None, self._run_offline_quick)
            if gen_snapshot != self._stream_generation:
                logger.info("Final offline flush dropped: "
                            "audio trimmed/reset during decode")
                return
            if text and text.strip():
                self._offline_text = text.strip()
                self._offline_text_generation += 1
                self._offline_last_text_len = len(self._offline_text)
                if self._offline_callback:
                    await self._offline_callback(
                        self._offline_text,
                        self._offline_text_generation,
                    )
                self._sync_streaming_from_offline()
        except Exception as e:
            logger.error("Final offline flush failed: %s", e, exc_info=True)  # noqa: G201
        finally:
            self._offline_busy = False

    async def finalize(self) -> str:
        """最终识别 — SenseVoice 全量, fallback paraformer+punc。"""
        if not self._audio_buffer:
            return ""

        if not self._models_loaded:
            return ""

        try:
            loop = asyncio.get_running_loop()
            text = await loop.run_in_executor(None, self._transcribe_final)
            if text and text.strip():
                return text.strip()
        except Exception as e:  # noqa: BLE001
            logger.error("Final transcription error: %s", e)
        return ""

    def _transcribe_final(self) -> str:
        with self._audio_lock:
            audio_np = np.frombuffer(bytes(self._audio_buffer), dtype=np.int16)
        if len(audio_np) < 160:
            return ""
        audio_float = audio_np.astype(np.float32) / 32768.0
        audio_float = _preprocess_audio(audio_float)

        audio_duration = len(audio_float) / self.sample_rate
        logger.info("Final offline ASR: %.1fs audio", audio_duration)

        with self._offline_lock:
            try:
                if self._offline_model:
                    res = self._offline_model.generate(
                        input=audio_float,
                        language="zh",
                        use_itn=True,
                        hotword=self._hotwords,
                    )
                    if res and len(res) > 0:
                        raw = res[0].get("text", "")
                        text = _clean_sense_voice_text(raw)
                        if text:
                            return text
                    logger.info("SenseVoice empty, fallback to paraformer")

                if self._fallback_model is None:
                    return ""
                res = self._fallback_model.generate(
                    input=audio_float, hotword=self._hotwords)
                if not res or len(res) == 0:
                    return ""

                text = (res[0].get("text", "") or "").strip()
                if not text:
                    return ""

                if len(text) <= 500 and self._punc_model is not None:
                    try:
                        punc_res = self._punc_model.generate(input=text)
                        if punc_res and len(punc_res) > 0:
                            text = punc_res[0].get("text", text)
                    except Exception as e:  # noqa: BLE001
                        logger.warning(
                            "Punctuation restoration failed: %s", e)

                return text
            except Exception:
                logger.exception("Final transcription error")
                return ""

    @property
    def offline_busy(self) -> bool:
        return self._offline_busy
