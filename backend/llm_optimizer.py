"""LLM 文本校对 — 流式 OpenAI 兼容 API

移植自 YuHuang (https://github.com/Homio/YuHuang)，适配 ququ pipeline。

特性:
  - 流式 chat/completions (stream: true)
  - 自适应关思考梯子 (DeepSeek/Qwen/vLLM 各家开关写法不同)
  - 上下文感知 prompt (上文/下文/前文参考)
  - 防回显剥离
  - 连接复用 (httpx AsyncClient)
"""

import asyncio
import json
import logging
import time

import httpx

logger = logging.getLogger("ququ.llm")


def _mask_secret(secret: str) -> str:
    """日志安全: 只保留末 4 位, 其余打码。"""
    if not secret:
        return "(empty)"
    if len(secret) <= 4:
        return "****"
    return f"****{secret[-4:]}"


class LLMOptimizer:
    """调用 OpenAI 兼容 API 校对语音识别文本。"""

    OPTIMIZE_DELAY = 0.5  # 绿区润色前短延迟，合并相邻触发器

    # 各家"关闭思考"开关不统一, 逐档尝试:
    # 0: DeepSeek V3+/V4
    # 1: 通义 Qwen3 / DashScope
    # 2: vLLM 跑 Qwen3 系列 (chat_template_kwargs 透传)
    # 3: 放弃
    _THINK_OFF_LADDER = (
        {"thinking": {"type": "disabled"}},
        {"enable_thinking": False},
        {"chat_template_kwargs": {"enable_thinking": False}},
        {},
    )

    def __init__(
        self,
        base_url: str = "http://localhost:8000/v1",
        api_key: str = "",
        model: str = "qwen2.5-7b-instruct",
        temperature: float = 0.3,
        max_tokens: int = 2000,
    ):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.model = model
        self.temperature = temperature
        self.max_tokens = max_tokens
        self._client: httpx.AsyncClient | None = None
        self._client_base_url: str = ""
        self._think_off_idx: int = 0
        self._think_warned: bool = False

    def update_config(self, **kwargs):
        for key, value in kwargs.items():
            if key in ("base_url", "api_key", "model", "temperature", "max_tokens"):
                if getattr(self, key) != value and key in ("model", "base_url"):
                    self._think_off_idx = 0
                    self._think_warned = False
                setattr(self, key, value)
                # 安全: api_key 绝不写入日志, 其余字段正常记录
                if key == "api_key":
                    logger.info("LLM config: api_key updated (%s)", _mask_secret(value))
                else:
                    logger.info("LLM config: %s=%s", key, value)

    async def optimize(
        self,
        text: str,
        prev_context: str = "",
        next_context: str = "",
        background_context: str = "",
        urgent: bool = False,
    ) -> str | None:
        """校对语音识别文本, 上下文感知。

        prev_context:   紧邻上文 (已上屏尾部 ~40字) — 衔接参考
        next_context:   后续粗识别 (~30字) — 术语纠错佐证
        background_context: 更早的上文 (~500字) — 用词一致性锚点
        urgent:         True 跳过 delay, 用于终审
        """
        if not text or not text.strip():
            return None

        parts = []
        if background_context:
            parts.append(f"【前文参考｜统一用词与专名, 禁止输出】\n{background_context}")
        if prev_context:
            parts.append(f"【上文｜已上屏, 禁止输出】\n{prev_context}")
        parts.append(f"【待校对】\n{text}")
        if next_context:
            parts.append(f"【下文｜语义参考, 禁止输出】\n{next_context}")

        if prev_context or next_context or background_context:
            user_msg = (
                "校对【待校对段】, 结合上下文纠错, "
                "保证与上文衔接自然。同一事物用词须与【前文参考】一致。"
                "输出必须在待校对段结束处停笔。只输出校对结果:\n\n"
                + "\n\n".join(parts)
            )
        else:
            user_msg = f"校对这段语音识别文本:\n\n{text}"

        return await self._call_llm(user_msg, urgent=urgent)

    async def _call_llm(self, user_msg: str, urgent: bool = False) -> str | None:
        if not user_msg or not user_msg.strip():
            return None

        if self.optimize_delay > 0 and not urgent:
            await asyncio.sleep(self.optimize_delay)

        payload = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": _SYSTEM_PROMPT},
                {"role": "user", "content": user_msg},
            ],
            "temperature": self.temperature,
            "max_tokens": self.max_tokens,
            "stream": True,
        }
        think_off = self._THINK_OFF_LADDER[self._think_off_idx]
        payload.update(think_off)

        t0 = time.monotonic()
        try:
            client = self._get_client()
            async with client.stream(
                "POST",
                f"{self.base_url}/chat/completions",
                headers={
                    "Authorization": f"Bearer {self.api_key}",
                    "Content-Type": "application/json",
                },
                json=payload,
            ) as response:
                if response.status_code == 400 and think_off:
                    self._think_off_idx += 1
                    logger.info(
                        "Server rejected think-off %s, trying level %d",
                        list(think_off), self._think_off_idx)
                    await response.aread()
                    return await self._call_llm(user_msg, urgent=True)

                response.raise_for_status()

                parts: list[str] = []
                reasoning = 0
                ttft = -1.0
                async for line in response.aiter_lines():
                    if not line.startswith("data: "):
                        continue
                    data = line[6:]
                    if data.strip() == "[DONE]":
                        break
                    try:
                        chunk = json.loads(data)
                        delta = chunk.get("choices", [{}])[0].get("delta", {})
                        reasoning += len(delta.get("reasoning_content") or "")
                        content = delta.get("content", "")
                        if content:
                            if ttft < 0:
                                ttft = time.monotonic() - t0
                            parts.append(content)
                    except (json.JSONDecodeError, IndexError, KeyError):
                        continue

                result = "".join(parts).strip()
                if result:
                    # 关思考梯子自适应
                    if reasoning:
                        if self._think_off_idx < len(self._THINK_OFF_LADDER) - 1:
                            self._think_off_idx += 1
                        elif not self._think_warned:
                            self._think_warned = True
                            logger.warning(
                                "Cannot disable thinking on '%s' — "
                                "consider a non-thinking model", self.model)
                    logger.info(
                        "LLM result (%.1fs, ttft %.1fs, %d chars%s): %s",
                        time.monotonic() - t0, ttft, len(result),
                        f", thinking {reasoning} chars!" if reasoning else "",
                        result[:60])
                    return result

        except httpx.TimeoutException:
            logger.warning("LLM request timed out")
        except httpx.HTTPStatusError as e:
            logger.error("LLM HTTP %d: %s", e.response.status_code, e)
        except Exception:
            logger.warning("LLM request failed", exc_info=True)
            self._client = None

        return None

    def _get_client(self) -> httpx.AsyncClient:
        if self._client is None or self._client_base_url != self.base_url:
            self._client = httpx.AsyncClient(timeout=30.0, trust_env=False)
            self._client_base_url = self.base_url
        return self._client

    @property
    def optimize_delay(self) -> float:
        return self.OPTIMIZE_DELAY


_SYSTEM_PROMPT = (
    "你是中文语音识别（ASR）文本的实时校对助手。输入是 ASR 原始输出，可能存在：\n"
    "- 同音/近音字错误（人名、术语、古典词汇被写成同音别字）\n"
    "- 中英混说时英文术语被拆错或拼错（如 lininux 实为 Linux）\n"
    "- 英文短语被转写成发音相近的另一个英文词（如 web coding 实为 vibe coding）\n"
    "- 音译成汉字的外来词（如 乌邦图 实为 Ubuntu）\n"
    "- 古典文学/文言文中的生僻词被现代同音词替换（如 敛声屏气 被识别为 连声平起）\n"
    "- 口头语、结巴重复\n"
    "- 标点缺失、错误或重复\n\n"
    "你的任务：\n"
    "1. 结合上下文语义推断专有名词、古典文学的通行写法\n"
    "2. 当遇到不通顺的词组时（如 敛生兵气），想象可能对应的古典原文或成语，"
    "查找发音相近的经典表述并替换\n"
    "3. 对口语中听起来不自然的词保持警觉：如果整个句子有古典韵味，"
    "优先从古典文学角度推测原文\n"
    "4. 删除无意义的口头语，修复结巴重复\n"
    "5. 规范标点（不允许连续标点）\n"
    "6. 保持原意和风格，不增加原文没有的内容\n"
    "7. 除非确有依据，不要改写本就正确的内容\n\n"
    "只输出校对后的文本，不要任何解释、前缀或引号。"
)
