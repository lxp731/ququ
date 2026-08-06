"""ququ PTT 流水线 — 三区间字符串模型 + 增量音频裁剪 + 润色结果切句提交

直接从 YuHuang (https://github.com/Homio/YuHuang) 的 pipeline.py 移植，
适配 ququ 的 WebSocket 广播（替代 fcitx5 Unix Socket）。

流式识别的文本按新旧分三段推进：红区（最新草稿，离线模型必重写）→
黄区（离线修正射程内）→ 绿区（已稳定，可提交）。绿区整段送 LLM 润色，
在润色文的可靠标点上找切点、映射回原文位置后整句上屏，切点之后的残句
留在绿区与后续新文字合并再润，周而复始。每次上屏都通知 ASR 引擎裁掉
已提交部分的音频，避免重复解码。
"""

import asyncio
import difflib
import logging
import time
from collections import deque
from collections.abc import Callable

logger = logging.getLogger("ququ.pipeline")


class CandidateBuffer:
    """
    三区间字符串模型：绿(安全区) → 黄(修正中) → 红(实时流)

    基于离线模型回溯射程（10~30字）的距离判定:
      - 红区: 尾部 0~10 字 — 流式草稿，离线模型必重写
      - 黄区: 尾部 10~30 字 — 离线修正射程内，上限 20 字
      - 绿区: 尾部 30+ 字 — 安全区，可立即提交

    纯字数距离判定 + 语义边界对齐，不依赖置信度。
    """

    # === 配置参数（基于 SenseVoice 回溯射程实证）===
    RED_MAX_SIZE = 10          # 红区最大字数
    MAX_YELLOW_SIZE = 20       # 黄区最大字数
    MIN_COMMIT_CHARS = 20      # 最小提交字数
    SAFE_DISTANCE = 30         # 安全距离 — 距尾部超过此值可提交
    STABLE_TIME_THRESHOLD = 3.0  # 绿区稳定超时兜底
    FORCE_COMMIT_SIZE = 60     # 绿区超限强制提交
    YELLOW_STABLE_TIMEOUT = 3.0  # 黄区稳定超时推绿
    COMMIT_STARVATION_TIMEOUT = 12.0  # 距上次提交超时 → 泄压

    # 语义边界字符集
    STRONG_BOUNDARIES = frozenset({'。', '！', '？', '；', '\n'})
    MEDIUM_BOUNDARIES = frozenset({'，', '、', '：'})
    WEAK_BOUNDARIES = frozenset({'呢', '啊', '吧', '吗', '嘛', '哦', '哈'})
    ASCII_STRONG = frozenset({'.', '!', '?', ';'})
    ASCII_MEDIUM = frozenset({','})

    def __init__(self):
        self._chars: deque[str] = deque()
        self._green_end: int = 0
        self._yellow_end: int = 0
        self._committed_chars: int = 0
        self._last_commit_text: str = ""
        self._last_commit_raw: str = ""
        self._last_yellow_modified: float = 0
        self._last_green_modified: float = 0
        self._last_green_snapshot: str = ""
        self._last_commit_time: float = time.time()
        self._showing_placeholder: bool = False
        self._frozen_green_len: int = 0

        # 回调
        # _trim_audio_callback: (char_count, commit_text, remaining_text) -> None
        self._trim_audio_callback: Callable[[int, str, str], None] | None = None
        self._notify_commit: Callable[[str], None] = lambda text: None
        # _request_refine: (raw_text, relaxed) -> None (通常调度异步任务)
        self._request_refine: Callable[[str, bool], None] | None = None

        # LLM 可用性：决定是否有绿区
        self._llm_enabled: bool = False

    def set_llm_enabled(self, enabled: bool):
        self._llm_enabled = bool(enabled)

    # ============ 属性 ============

    @property
    def green_text(self) -> str:
        return ''.join(list(self._chars)[:self._green_end])

    @property
    def yellow_text(self) -> str:
        return ''.join(list(self._chars)[self._green_end:self._yellow_end])

    @property
    def red_text(self) -> str:
        return ''.join(list(self._chars)[self._yellow_end:])

    @property
    def full_text(self) -> str:
        return ''.join(self._chars)

    # ============ 流式输入 ============

    def append_streaming(self, text: str):
        for ch in text:
            self._chars.append(ch)
        self._showing_placeholder = False

    def update_streaming(self, full_text: str):
        """更新红区流式文本。"""
        buf_str = self.full_text
        if not buf_str:
            for ch in full_text:
                self._chars.append(ch)
            return

        idx = full_text.find(buf_str)
        if idx >= 0:
            new_chars = full_text[idx + len(buf_str):]
            for ch in new_chars:
                self._chars.append(ch)
        else:
            preserved = self._yellow_end
            kept = buf_str[:preserved]
            rest = self._align_head(kept, full_text) if kept else None
            if rest is not None:
                while len(self._chars) > preserved:
                    self._chars.pop()
                for ch in rest:
                    self._chars.append(ch)
                return
            if len(full_text) < preserved:
                while len(self._chars) > preserved:
                    self._chars.pop()
                return
            new_red = full_text[preserved:]
            while len(self._chars) > preserved:
                self._chars.pop()
            for ch in new_red:
                self._chars.append(ch)

    # ============ 离线修正 ============

    def apply_offline_correction(self, offline_text: str):
        """离线模型纠正：直接替换 buffer，重新划分三区。"""
        if not offline_text:
            return

        offline_text = self._strip_committed_overlap(offline_text)
        offline_text = offline_text.lstrip('。，！？；、：,.!?;: ')
        if not offline_text:
            return

        self._frozen_green_len = 0
        if self._llm_enabled and self._green_end > 0:
            green = ''.join(list(self._chars)[:self._green_end])
            if green:
                offline_text = self._align_frozen_green(green, offline_text)
                if offline_text.startswith(green):
                    self._frozen_green_len = len(green)

        self._chars.clear()
        for ch in offline_text:
            self._chars.append(ch)

        self._recalc_zones()
        self._last_yellow_modified = time.time()
        self._try_commit()

    @staticmethod
    def _align_head(head: str, text: str) -> str | None:
        """在 text 头部窗口内定位 head 对应的终点。"""
        _PUNCT = '。，！？；、：,.!?;: '
        search_end = min(len(text), len(head) + 15)
        core = head.rstrip(_PUNCT)
        trailing = head[len(core):]
        for n in (10, 6, 4, 3):
            if n > len(core):
                continue
            tail = core[-n:]
            pos = text.rfind(tail, 0, search_end)
            if pos >= 0:
                rest = text[pos + n:]
                if trailing:
                    rest = rest.lstrip(_PUNCT)
                return rest
        sm = difflib.SequenceMatcher(None, head, text[:search_end], autojunk=False)
        if sm.ratio() >= 0.5:
            end = 0
            for a, b, size in sm.get_matching_blocks():
                if size == 0:
                    continue
                end = b + size + (len(head) - (a + size))
            end = min(end, search_end)
            if end > 0:
                rest = text[end:]
                if trailing:
                    rest = rest.lstrip(_PUNCT)
                return rest
        return None

    def _align_frozen_green(self, green: str, offline_text: str) -> str:
        rest = self._align_head(green, offline_text)
        if rest is not None:
            return green + rest
        logger.warning(
            f"Frozen green alignment failed, falling back to full replace "
            f"(green='{green[:15]}...', offline='{offline_text[:15]}...')")
        return offline_text

    def _strip_committed_overlap(self, offline_text: str) -> str:
        """去掉离线纠正文本开头与上次 commit 结尾的重叠部分。"""
        if not offline_text:
            return offline_text
        candidates = []
        if self._last_commit_raw:
            candidates.append(self._last_commit_raw)
        if self._last_commit_text and self._last_commit_text != self._last_commit_raw:
            candidates.append(self._last_commit_text)

        for last_commit in candidates:
            base = last_commit.rstrip('。，！？；、：,.!?;: ')
            if not base:
                continue
            max_check = min(20, len(base))
            for n in range(max_check, 0, -1):
                suffix = base[-n:]
                if offline_text.startswith(suffix):
                    remaining = offline_text[n:]
                    if not remaining:
                        return ""
                    if remaining[0] != suffix[-1]:
                        logger.debug(
                            f"Stripped committed overlap: '{suffix}' "
                            f"({n} chars) from offline correction head")
                        return remaining
        return offline_text

    # ============ 三区划分 ============

    def _recalc_zones(self):
        L = len(self._chars)
        if L == 0:
            self._green_end = 0
            self._yellow_end = 0
            return

        yellow_end = max(0, L - self.RED_MAX_SIZE)
        if yellow_end > 0:
            prefix = ''.join(list(self._chars)[:yellow_end])
            b = self._find_semantic_boundary(prefix, min_chars=5)
            if b > 0:
                yellow_end = b

        if not self._llm_enabled:
            self._yellow_end = yellow_end
            self._green_end = 0
            self._last_green_modified = time.time()
            return

        if yellow_end >= self.MIN_COMMIT_CHARS + self.MAX_YELLOW_SIZE:
            green_end = yellow_end - self.MAX_YELLOW_SIZE
        elif yellow_end >= self.MIN_COMMIT_CHARS:
            green_end = self.MIN_COMMIT_CHARS
        else:
            green_end = 0

        if green_end > 0:
            prefix = ''.join(list(self._chars)[:green_end])
            b = self._find_semantic_boundary(prefix, min_chars=5)
            if b > 0:
                green_end = b
            green_end = self._snap_out_of_ascii_run(
                list(self._chars), green_end)

        self._yellow_end = yellow_end
        self._green_end = green_end

        if self._frozen_green_len > 0:
            self._green_end = max(
                self._green_end,
                min(self._frozen_green_len, self._yellow_end))

        green_now = ''.join(list(self._chars)[:self._green_end])
        if green_now != self._last_green_snapshot:
            self._last_green_snapshot = green_now
            self._last_green_modified = time.time()

    # ============ 提交 ============

    def _try_commit(self, relaxed: bool = False):
        if not self._llm_enabled:
            if self._yellow_end < self.MIN_COMMIT_CHARS:
                return
            yellow_text = self.yellow_text
            commit_point = self._find_commit_point(yellow_text, relaxed=True)
            if commit_point <= 0:
                return
            self._do_commit(yellow_text[:commit_point])
        else:
            if self._green_end < self.MIN_COMMIT_CHARS:
                return
            green = self.green_text
            if self._request_refine is not None:
                has_boundary = any(
                    (c in self.STRONG_BOUNDARIES
                     or c in self.MEDIUM_BOUNDARIES
                     or c in self.WEAK_BOUNDARIES) for c in green) or any(
                    self._ascii_boundary_kind(green, i)
                    for i in range(len(green)))
                if has_boundary or relaxed or len(green) >= self.FORCE_COMMIT_SIZE:
                    self._request_refine(green, relaxed)
            else:
                commit_point = self._find_commit_point(green, relaxed=relaxed)
                if commit_point > 0:
                    self._do_commit(green[:commit_point])

    @staticmethod
    def _pad_ascii_tail(text: str) -> str:
        if text and text[-1].isascii() and (
                text[-1].isalnum() or text[-1] in '.!?;,'):
            return text + ' '
        return text

    def _do_commit(self, text: str):
        if not text or not text.strip():
            return

        commit_text = text.strip()
        pop_len = len(text)

        for _ in range(pop_len):
            if self._chars:
                self._chars.popleft()

        self._green_end = max(0, self._green_end - pop_len)
        self._yellow_end = max(self._green_end, self._yellow_end - pop_len)
        self._frozen_green_len = max(0, self._frozen_green_len - pop_len)

        self._committed_chars += len(commit_text)
        self._last_commit_text = commit_text
        self._last_commit_raw = commit_text

        self._last_commit_time = time.time()
        self._notify_commit(self._pad_ascii_tail(commit_text))

        if self._trim_audio_callback:
            try:
                self._trim_audio_callback(pop_len, commit_text, self.full_text)
            except Exception:
                logger.warning("trim_audio_callback failed", exc_info=True)

        self._recalc_zones()
        self._try_commit()

    def commit_refined(self, raw_text: str, refined_text: str) -> bool:
        raw_len = len(raw_text)
        if raw_len == 0:
            return False
        if self.full_text[:raw_len] != raw_text:
            logger.warning(
                "commit_refined dropped: buffer head changed during LLM wait")
            return False

        refined = refined_text.strip() or raw_text.strip()
        if not refined:
            return False

        for _ in range(raw_len):
            if self._chars:
                self._chars.popleft()

        self._green_end = max(0, self._green_end - raw_len)
        self._yellow_end = max(self._green_end, self._yellow_end - raw_len)
        self._frozen_green_len = max(0, self._frozen_green_len - raw_len)

        self._committed_chars += len(refined)
        self._last_commit_text = refined
        self._last_commit_raw = raw_text.strip()

        self._last_commit_time = time.time()
        self._notify_commit(self._pad_ascii_tail(refined))

        if self._trim_audio_callback:
            try:
                self._trim_audio_callback(raw_len, raw_text, self.full_text)
            except Exception:
                logger.warning("trim_audio_callback failed", exc_info=True)

        self._recalc_zones()
        self._try_commit()
        return True

    # ============ 兜底 ============

    def emergency_check(self):
        now = time.time()

        if not self._llm_enabled:
            yellow_len = self._yellow_end
            if yellow_len >= self.MIN_COMMIT_CHARS and self._last_yellow_modified > 0:  # noqa: SIM102
                if now - self._last_yellow_modified > self.YELLOW_STABLE_TIMEOUT:
                    self._try_commit()
            return

        if self._green_end > 0 and self._last_green_modified > 0:  # noqa: SIM102
            if now - self._last_green_modified > self.STABLE_TIME_THRESHOLD:
                self._try_commit(relaxed=True)

        yellow_len = self._yellow_end - self._green_end
        if yellow_len > 0 and self._last_yellow_modified > 0:  # noqa: SIM102
            if now - self._last_yellow_modified > self.YELLOW_STABLE_TIMEOUT:
                self._recalc_zones()
                self._try_commit(relaxed=True)

        if self._green_end > self.FORCE_COMMIT_SIZE:
            self._try_commit(relaxed=True)

        if (now - self._last_commit_time > self.COMMIT_STARVATION_TIMEOUT
                and self._green_end > 0
                and (self._green_end >= self.MIN_COMMIT_CHARS
                     or len(self._chars) >= self.FORCE_COMMIT_SIZE)):
            green = self.green_text
            cut = self._find_commit_point(green, relaxed=True)
            if cut <= 0:
                cut = min(len(green), self.FORCE_COMMIT_SIZE)
            cut = self._snap_out_of_ascii_run(list(green), cut) or len(green)
            logger.warning(
                f"Commit starvation: "
                f"{now - self._last_commit_time:.0f}s since last commit, "
                f"force-committing {cut}/{len(green)} raw chars")
            self._do_commit(green[:cut])

    # ============ 语义边界 ============

    @classmethod
    def _ascii_boundary_kind(cls, text: str, i: int) -> str | None:
        ch = text[i]
        if ch in cls.ASCII_STRONG:
            if ch == '.':
                nxt = text[i + 1] if i + 1 < len(text) else ''
                if nxt and nxt.isascii() and nxt.isalnum():
                    return None
            return 'strong'
        if ch in cls.ASCII_MEDIUM:
            nxt = text[i + 1] if i + 1 < len(text) else ''
            if nxt and nxt.isascii() and nxt.isalnum():
                return None
            return 'medium'
        return None

    @staticmethod
    def _snap_out_of_ascii_run(chars, pos: int) -> int:
        while (0 < pos < len(chars)
               and chars[pos - 1].isascii() and chars[pos - 1].isalnum()
               and chars[pos].isascii() and chars[pos].isalnum()):
            pos -= 1
        return pos

    def _find_semantic_boundary(self, text: str, min_chars: int = 5) -> int:
        for i in range(len(text) - 1, min_chars - 1, -1):
            if (i < len(text) - 1
                    and text[i].isascii()
                    and text[i + 1].isascii()
                    and text[i].isalnum()
                    and text[i + 1].isalnum()):
                continue
            if text[i] in self.STRONG_BOUNDARIES:
                return i + 1
            if text[i] in self.MEDIUM_BOUNDARIES and i > min_chars + 5:
                return i + 1
            if text[i] in self.WEAK_BOUNDARIES and i > min_chars + 5:
                return i + 1
            kind = self._ascii_boundary_kind(text, i)
            if kind == 'strong':
                return i + 1
            if kind == 'medium' and i > min_chars + 5:
                return i + 1
        if len(text) >= self.FORCE_COMMIT_SIZE:
            return self.FORCE_COMMIT_SIZE
        return 0

    def _find_commit_point(self, green_text: str, relaxed: bool = False) -> int:
        for i in range(len(green_text) - 1, 4, -1):
            if (green_text[i] in self.STRONG_BOUNDARIES
                    or self._ascii_boundary_kind(green_text, i) == 'strong'):
                return i + 1
        if not relaxed and len(green_text) < self.FORCE_COMMIT_SIZE:
            return 0
        boundary = self._find_semantic_boundary(green_text, min_chars=5)
        if boundary >= self.MIN_COMMIT_CHARS:
            return boundary
        if len(green_text) >= self.FORCE_COMMIT_SIZE:
            return self.FORCE_COMMIT_SIZE
        return 0

    # ============ 渲染 ============

    def render_segments(self) -> list[tuple[str, str]]:
        if self._showing_placeholder:
            return [("…", "gray")]
        result: list[tuple[str, str]] = []
        if self._green_end > 0:
            result.append((self.green_text, "green"))
        if self._yellow_end > self._green_end:
            result.append((self.yellow_text, "yellow"))
        if len(self._chars) > self._yellow_end:
            result.append((self.red_text, "red"))
        return result

    def show_placeholder(self):
        self._showing_placeholder = True


class PTTPipeline:
    """PTT 语音识别流水线 — 适配 ququ WebSocket 广播"""

    LLM_REFINE_TIMEOUT = 8.0
    LLM_FINAL_TIMEOUT = 6.0
    FINAL_SPLIT_THRESHOLD = 40
    FINAL_CHUNK_SIZE = 35
    PREV_CONTEXT_CHARS = 40
    NEXT_CONTEXT_CHARS = 30
    BACKGROUND_CONTEXT_CHARS = 500
    COMMITTED_TAIL_CAP = 800

    def __init__(self, broadcast_fn=None, llm_optimizer=None):
        async def _noop(_msg):
            pass
        self._broadcast = broadcast_fn if broadcast_fn is not None else _noop
        self.llm_optimizer = llm_optimizer
        self.buffer = CandidateBuffer()
        self.buffer._notify_commit = self._on_commit
        self.buffer.set_llm_enabled(llm_optimizer is not None)
        self.buffer._request_refine = self._schedule_refine
        self._emergency_timer: asyncio.Task | None = None
        self._prev_offline_text = ""
        self._committed_tail: str = ""
        self._refine_task: asyncio.Task | None = None
        self._finalizing: bool = False

    def reset(self):
        saved_trim_cb = self.buffer._trim_audio_callback
        saved_llm = self.buffer._llm_enabled
        self.buffer = CandidateBuffer()
        self.buffer._notify_commit = self._on_commit
        self.buffer._trim_audio_callback = saved_trim_cb
        self.buffer.set_llm_enabled(saved_llm)
        self.buffer._request_refine = self._schedule_refine
        self._prev_offline_text = ""
        self._committed_tail = ""
        if self._refine_task and not self._refine_task.done():
            self._refine_task.cancel()
        self._refine_task = None

    async def commit_now(self):
        """回车键强制提交：立即提交 buffer 全部内容。"""
        full = self.buffer.full_text
        if not full or not full.strip():
            await self._broadcast({"type": "reset"})
            return
        stripped = full.strip()
        self.buffer._do_commit(stripped)
        await self._update_display()

    async def on_intermediate(self, text: str):
        if not text:
            return
        self.buffer.update_streaming(text)
        await self._update_display()

    async def on_offline_correction(self, text: str, generation: int):
        if not text or generation <= 0:
            return
        if self._finalizing:
            return
        self.buffer.apply_offline_correction(text)
        self._prev_offline_text = text
        await self._update_display()

    def _schedule_refine(self, raw_text: str, relaxed: bool = False):
        """绿区就绪时调度异步润色任务（Phase 4 时实现）。"""
        if self._finalizing:
            return
        if not self.llm_optimizer:
            cut = self.buffer._find_commit_point(raw_text, relaxed=True)
            if cut > 0:
                self.buffer._do_commit(raw_text[:cut])
            return
        if self._refine_task and not self._refine_task.done():
            return
        prev_ctx = self._committed_tail[-self.PREV_CONTEXT_CHARS:]
        next_ctx = self.buffer.full_text[
            len(raw_text):len(raw_text) + self.NEXT_CONTEXT_CHARS]
        bg_ctx = self._background_context()
        try:
            self._refine_task = asyncio.create_task(
                self._refine_and_commit(
                    raw_text, prev_ctx, next_ctx, relaxed, bg_ctx))
        except RuntimeError:
            cut = self.buffer._find_commit_point(raw_text, relaxed=True)
            if cut > 0:
                self.buffer._do_commit(raw_text[:cut])

    def _background_context(self) -> str:
        return self._committed_tail[:-self.PREV_CONTEXT_CHARS][
            -self.BACKGROUND_CONTEXT_CHARS:]

    @staticmethod
    def _strip_context_echo(refined: str, prev_ctx: str,
                            next_ctx: str = "") -> str:
        if refined.startswith('【'):
            end = refined.find('】')
            if 0 < end < 20:
                refined = refined[end + 1:].lstrip('\n ')
        base = prev_ctx.rstrip('。，！？；、：,.!?;: ')
        if base:
            max_check = min(20, len(base), len(refined) - 1)
            for n in range(max_check, 0, -1):
                if refined.startswith(base[-n:]):
                    refined = refined[n:].lstrip('。，！？；、：,.!?;: ')
                    break
        tail = next_ctx.lstrip('。，！？；、：,.!?;: ')
        if tail:
            max_check = min(20, len(tail), len(refined) - 1)
            for n in range(max_check, 3, -1):
                if refined.rstrip('。，！？；、：,.!?;: ').endswith(tail[:n]):
                    refined = refined.rstrip('。，！？；、：,.!?;: ')[:-n]
                    break
        return refined

    @staticmethod
    def _refined_cut(refined: str, relaxed: bool, overflowed: bool) -> int:
        CB = CandidateBuffer
        for i in range(len(refined) - 1, 4, -1):
            if (refined[i] in CB.STRONG_BOUNDARIES
                    or CB._ascii_boundary_kind(refined, i) == 'strong'):
                return i + 1
        if not (relaxed or overflowed):
            return 0
        for i in range(len(refined) - 1, 4, -1):
            if (refined[i] in CB.MEDIUM_BOUNDARIES
                    or refined[i] in CB.WEAK_BOUNDARIES
                    or CB._ascii_boundary_kind(refined, i) == 'medium'):
                return i + 1
        return len(refined) if overflowed else 0

    @staticmethod
    def _map_refined_to_raw(raw: str, refined: str, cut: int) -> int:
        sm = difflib.SequenceMatcher(None, refined, raw, autojunk=False)
        for a, b, size in sm.get_matching_blocks():
            if a <= cut <= a + size:
                return b + (cut - a)
            if a > cut:
                return b
        return min(len(raw), round(cut * len(raw) / max(1, len(refined))))

    async def _refine_and_commit(self, raw_text: str, prev_ctx: str = "",
                                 next_ctx: str = "", relaxed: bool = False,
                                 bg_ctx: str = ""):
        """LLM 润色整个绿区, 在润色结果上切句提交; 超时回退原文切分。"""
        if self.llm_optimizer is None:
            return
        refined: str | None = None
        try:
            refined = await asyncio.wait_for(
                self.llm_optimizer.optimize(
                    raw_text, prev_context=prev_ctx, next_context=next_ctx,
                    background_context=bg_ctx),
                timeout=self.LLM_REFINE_TIMEOUT)
        except TimeoutError:
            logger.warning("LLM refine timed out, falling back to raw split")
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.warning("LLM refine failed", exc_info=True)

        if self._finalizing:
            return

        overflowed = len(raw_text) >= CandidateBuffer.FORCE_COMMIT_SIZE
        text = (refined or "").strip()
        if text:
            text = self._strip_context_echo(text, prev_ctx, next_ctx)

        if not text:
            cut = self.buffer._find_commit_point(
                raw_text, relaxed=relaxed or overflowed)
            if cut > 0 and self.buffer.commit_refined(
                    raw_text[:cut], raw_text[:cut]):
                await self._update_display()
            return

        b = self._refined_cut(text, relaxed, overflowed)
        if b <= 0:
            return  # 润色结果还没有完整句子, 等下轮合并
        r = self._map_refined_to_raw(raw_text, text, b)
        if r <= 0:
            return

        # 越界守卫: 防止 LLM 把下文抄进输出
        if b > r + max(8, r // 2):
            logger.warning(
                "LLM echo guard: raw %d → refined %d chars, "
                "falling back to raw split", r, b)
            cut = self.buffer._find_commit_point(
                raw_text, relaxed=relaxed or overflowed)
            if cut > 0 and self.buffer.commit_refined(
                    raw_text[:cut], raw_text[:cut]):
                await self._update_display()
            return

        if self.buffer.commit_refined(raw_text[:r], text[:b]):
            logger.info("LLM refined commit: raw %d/%d → refined %d/%d chars",
                        r, len(raw_text), b, len(text))
            await self._update_display()

    async def finalize(self):
        """PTT 松键：所有剩余文本推绿，提交。"""
        self._finalizing = True
        try:
            if self._refine_task and not self._refine_task.done():
                self._refine_task.cancel()
            self._refine_task = None

            self.buffer._yellow_end = len(self.buffer._chars)
            self.buffer._green_end = self.buffer._yellow_end
            self.buffer._last_green_modified = time.time()
            await self._update_display()

            text_to_commit = self.buffer.full_text
            if text_to_commit and self.llm_optimizer:
                text_to_commit = await self._refine_final(text_to_commit)

            if text_to_commit:
                stripped = text_to_commit.strip()
                if stripped:
                    await self._broadcast({"type": "final", "text": stripped})
                    self.buffer._chars.clear()
                    for ch in stripped:
                        self.buffer._chars.append(ch)
                    self.buffer._green_end = len(stripped)
                    self.buffer._yellow_end = self.buffer._green_end
                    self.buffer._do_commit(stripped)
            else:
                await self._broadcast({"type": "reset"})

            self.reset()
        finally:
            self._finalizing = False

    async def _refine_final(self, raw: str) -> str:
        """松手终审：长文本切片并行润色, 部分超时只回退对应段。"""
        if not raw or self.llm_optimizer is None:
            return raw
        opt = self.llm_optimizer  # type narrowed
        if len(raw) <= self.FINAL_SPLIT_THRESHOLD:
            # 短文本: 单次 LLM 润色
            refined = await opt.optimize(raw)
            if refined and refined.strip():
                refined = self._strip_context_echo(refined, "", "")
                return refined.strip()
            return raw

        chunks = self._split_final_chunks(raw)
        bg_ctx = self._background_context()
        # 并行润色, 每段带上文/下文上下文
        tasks = []
        for i, c in enumerate(chunks):
            prev = (chunks[i - 1][-self.PREV_CONTEXT_CHARS:]
                    if i > 0
                    else self._committed_tail[-self.PREV_CONTEXT_CHARS:])
            nxt = chunks[i + 1][:self.NEXT_CONTEXT_CHARS] if i + 1 < len(chunks) else ""
            tasks.append(asyncio.ensure_future(
                opt.optimize(
                    c, prev_context=prev, next_context=nxt,
                    background_context=bg_ctx, urgent=True)))

        try:
            await asyncio.wait(tasks, timeout=self.LLM_FINAL_TIMEOUT)
        except Exception:  # noqa: BLE001
            logger.warning("LLM finalize wait failed")

        parts = []
        for i, t in enumerate(tasks):
            res = None
            if t.done() and not t.cancelled() and t.exception() is None:
                res = t.result()
            else:
                t.cancel()
            part = (res or "").strip()
            if part:
                part = self._strip_context_echo(part,
                    (chunks[i - 1][-self.PREV_CONTEXT_CHARS:]
                     if i > 0 else ""),
                    chunks[i + 1][:self.NEXT_CONTEXT_CHARS]
                    if i + 1 < len(chunks) else "")
            part = part or chunks[i]  # 超时段回退原文
            if i > 0:
                part = part.lstrip('。，！？；、：,.!?;: ') or part
            parts.append(part)

        result = "".join(parts).strip()
        logger.info("LLM finalize: %d chunks, %d→%d chars",
                    len(chunks), len(raw), len(result or raw))
        return result or raw

    def _split_final_chunks(self, raw: str) -> list[str]:
        if len(raw) <= self.FINAL_SPLIT_THRESHOLD:
            return [raw]
        chunks = []
        rest = raw
        while len(rest) > self.FINAL_CHUNK_SIZE + 10:
            head = rest[:self.FINAL_CHUNK_SIZE + 10]
            b = self.buffer._find_semantic_boundary(head, min_chars=10)
            if not (10 <= b <= len(head)):
                b = self.FINAL_CHUNK_SIZE
            chunks.append(rest[:b])
            rest = rest[b:]
        if rest:
            chunks.append(rest)
        return chunks

    async def _update_display(self):
        """推送 preedit 到 WebSocket 客户端。"""
        segments = self.buffer.render_segments()
        msg: dict = {"type": "preedit"}
        for text, style in segments:
            msg[style] = text
        await self._broadcast(msg)

    def _on_commit(self, text: str):
        if text:
            self._committed_tail = (
                self._committed_tail + text)[-self.COMMITTED_TAIL_CAP:]
        if text:
            async def _push():
                await self._broadcast({"type": "commit", "text": text})
                await self._update_display()
            try:
                asyncio.create_task(_push())
            except RuntimeError:
                pass

    def start_emergency_timer(self):
        async def tick():
            while True:
                try:
                    if not self._finalizing:
                        self.buffer.emergency_check()
                except Exception:  # noqa: BLE001, S110
                    pass
                await asyncio.sleep(1.0)
        self._emergency_timer = asyncio.create_task(tick())

    def stop_emergency_timer(self):
        if self._emergency_timer:
            self._emergency_timer.cancel()
            self._emergency_timer = None
