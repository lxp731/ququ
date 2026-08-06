# ququ Roadmap — 从语音转写工具到真正的语音输入法

> 目标：达到 YuHuang（语皇）级别的流式语音输入体验——"边说边出字，松手即上屏"。

---

## 当前状态分析

### 现有架构

```
麦克风 → MediaRecorder(Opus编码) → WebM blob → AudioBuffer解码
→ WAV拼接 → HTTP上传 → paraformer-large 全量识别 → 标点恢复
→ LLM润色 → 剪贴板/模拟粘贴上屏
```

### 核心问题

1. **无流式识别**：必须录完一整段才开始识别，用户在录音期间看不到任何文字
2. **音频链路损耗大**：Opus 有损编码 → 解码 → WAV，额外延迟 + 准确率损失
3. **纯 CPU 运行**：硬编码 `device="cpu"`，有 GPU 也用不上
4. **单模型**：一个 paraformer-large 干所有活，无流式预览、无离线校对
5. **上屏体验割裂**：文字出现在 Electron 窗口里，需要手动粘贴或等自动粘贴

---

## Phase 1：流式识别基础设施 🎯 P0

> 目标：实现"按住说话，边说明边出字"。这是从工具到输入法的质变。

### 1.1 后端 — 流式 ASR 端点

**新增模型**：`paraformer-zh-streaming`

```python
# backend/streaming_asr.py
from funasr import AutoModel

class StreamingASR:
    def __init__(self, device="cpu"):
        self.model = AutoModel(
            model="paraformer-zh-streaming",
            device=device,
            disable_update=True,
        )
        self.cache = {}  # 跨请求持久化的解码状态

    def process_chunk(self, audio_chunk: bytes, is_final: bool = False) -> str:
        """处理音频块，返回当前累积的识别文本"""
        audio_np = np.frombuffer(audio_chunk, dtype=np.int16)
        audio_float = audio_np.astype(np.float32) / 32768.0

        res = self.model.generate(
            input=audio_float,
            cache=self.cache,
            is_final=is_final,
            chunk_size=[5, 10, 5],
        )
        return res[0].get("text", "") if res else ""

    def reset(self):
        self.cache = {}
```

**新增 API 端点**：

| 端点 | 方法 | 用途 |
|------|------|------|
| `/stream/start` | POST | 创建流式会话，返回 session_id |
| `/stream/chunk` | POST | 发送音频块（raw PCM），返回增量文本 |
| `/stream/stop` | POST | 结束会话，触发最终识别，清理 cache |
| `/stream/ws` | WebSocket | 全双工流式通道（推荐方案） |

**WebSocket 协议设计**（推荐）：

```
Client → Server:  binary (PCM audio chunk, int16, 16kHz, mono)
Server → Client:  JSON {"type": "partial", "text": "今天天气", "timestamp": 123456}
Server → Client:  JSON {"type": "final", "text": "今天天气真不错", "is_complete": true}
```

**任务清单**：
- [ ] 安装 `paraformer-zh-streaming` 模型（约 200MB）
- [ ] 实现 `StreamingASR` 封装类（cache 管理、reset）
- [ ] 实现 WebSocket 端点 `/stream/ws`
- [ ] 实现 session 管理（多会话隔离、超时清理）
- [ ] 单元测试：模拟短/长/中英混语音输入

**预估工作量**：3-5 天
**模型增量**：~200MB（paraformer-zh-streaming）

### 1.2 前端 — 原生音频采集（替代 MediaRecorder）

**问题**：当前 MediaRecorder 录制 Opus 有损编码，stop 后才处理，延迟 1-3 秒。

**方案**：在 Electron 主进程用原生方式采集 raw PCM，直接送到后端。

**Linux**：
```javascript
// frontend/src/helpers/nativeAudio.js
const { spawn } = require('child_process');

class NativeAudioCapture {
    start() {
        // arecord 输出 raw PCM 到 stdout
        this.process = spawn('arecord', [
            '-f', 'S16_LE',   // signed 16-bit little-endian
            '-r', '16000',    // 16kHz sample rate
            '-c', '1',        // mono
            '-t', 'raw',      // raw output
            '-',              // stdout
        ]);
        return this.process.stdout;  // Readable stream of PCM bytes
    }

    stop() {
        if (this.process) {
            this.process.kill('SIGTERM');
            this.process = null;
        }
    }
}
```

**Windows**：
```javascript
// 用 WASAPI 或 portaudio 绑定，或回退到 PowerShell + .NET
// 优先方案：使用 naudiodon (Node.js PortAudio 绑定)
const portAudio = require('naudiodon');
const ai = new portAudio.AudioInput({
    channelCount: 1,
    sampleFormat: portAudio.SampleFormat16Bit,
    sampleRate: 16000,
    deviceId: selectedDeviceId,
});
ai.start();
```

**任务清单**：
- [ ] Linux: `arecord` 子进程采集 raw PCM
- [ ] Windows: 调研 naudiodon / WASAPI 方案
- [ ] 设备选择：扫描可用麦克风，支持 GUI 切换
- [ ] 音频流通过 IPC 传到渲染进程
- [ ] 压测：确认无内存泄漏、无缓冲区溢出

**预估工作量**：3-4 天

### 1.3 前端 — 实时文字显示

**问题**：目前录音期间只显示波形动画，无文字反馈。

**改造 App.jsx**：
```jsx
// 新增状态
const [streamingText, setStreamingText] = useState('');  // 实时流式文字
const [stableText, setStableText] = useState('');        // 已稳定的文字

// 录音期间显示实时文字
{isRecording && streamingText && (
    <motion.div className="glass-light p-4">
        <p className="text-lg text-white/90">
            {stableText}
            <span className="text-white/50">{streamingText}</span>
            <span className="inline-block w-0.5 h-5 bg-indigo-400 animate-pulse ml-0.5" />
        </p>
    </motion.div>
)}
```

**任务清单**：
- [ ] WebSocket 客户端封装（自动重连、心跳）
- [ ] 流式文字状态管理（累积、去重、闪烁光标）
- [ ] 稳定文字 vs 草稿文字的视觉区分
- [ ] 录音停止后切换到最终结果展示

**预估工作量**：2-3 天

### 1.4 前端 — 实时上屏

**问题**：文字录完才粘贴，体验割裂。

**方案**：稳定的前缀文字在录音期间就开始模拟打字上屏。

```javascript
// 当检测到文字前缀 3 秒未变，直接上屏
let lastStablePrefix = '';
const STABLE_THRESHOLD_MS = 3000;

function onStreamingText(fullText) {
    const stable = findLongestStablePrefix(fullText, lastFullText);
    if (stable.length > lastStablePrefix.length + 5) {
        const newChars = stable.slice(lastStablePrefix.length);
        await window.electronAPI.typeText(newChars);  // ydotool/wtype/SendInput
        lastStablePrefix = stable;
    }
}
```

**任务清单**：
- [ ] Linux: ydotool/wtype 模拟打字
- [ ] Windows: SendInput / PowerShell 模拟
- [ ] 稳定前缀检测算法（LCP 思想）
- [ ] 与流式文字的视觉同步（已上屏 + 草稿）

**预估工作量**：2 天

---

## Phase 2：模型升级 🟡 P1

> 目标：用 SenseVoiceSmall 做离线校对，GPU 加速，识别质量接近 YuHuang。

### 2.1 GPU 支持

**现状**：3 处硬编码 `device="cpu"`。

**改造**：
```python
# backend/funasr_server.py
import torch

def detect_device(preferred="cuda"):
    if preferred in ("cuda", "gpu"):
        if torch.cuda.is_available():
            idx = torch.cuda.device_count() - 1
            return f"cuda:{idx}" if idx > 0 else "cuda"
    return "cpu"

DEVICE = os.environ.get("FUNASR_DEVICE", detect_device())
```

**Docker/Podman GPU 透传**：
```yaml
# docker-compose.yml
services:
  backend:
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: 1
              capabilities: [gpu]
```

**任务清单**：
- [ ] 自动检测 cuda/mps/cpu
- [ ] 所有模型统一使用检测到的设备
- [ ] GPU 显存监控（防 OOM）
- [ ] Docker/Podman GPU 透传文档
- [ ] 环境变量 `FUNASR_DEVICE` 支持手动覆盖

**预估工作量**：1 天

### 2.2 集成 SenseVoiceSmall

**新增模型**：`iic/SenseVoiceSmall`（~450MB FP16，254MB Q8）

```python
# backend/funasr_server.py — 在模型加载时新增
from funasr import AutoModel

self.sense_voice = AutoModel(
    model="iic/SenseVoiceSmall",
    device=self.device,
    disable_update=True,
    trust_remote_code=True,
)
```

**新增 API 端点**：
| 端点 | 方法 | 用途 |
|------|------|------|
| `/sensevoice/transcribe` | POST | SenseVoice 离线校对（带 ITN + 自带标点） |

**关键优势**：
- 非自回归架构，CPU 上 RTF 0.058（17x 实时），比 paraformer-large 的 0.064 还快
- 自带 ITN：`"二零二四" → "2024"`，`"一百二十三" → "123"`
- 自带标点：不需要单独的 CT-Transformer
- 中英混合识别更准：`"用 FunASR 做 demo"` 不会识别成 `"用 fun a s r 做 demo"`
- 50+ 语言支持：中文、英文、粤语、日语、韩语

**任务清单**：
- [ ] 模型下载集成（首次启动自动下载 ~450MB）
- [ ] `SenseVoiceASR` 封装类
- [ ] `/sensevoice/transcribe` API 端点
- [ ] 替换 finalize 阶段的 paraformer-large 为 SenseVoice
- [ ] 测试中英混合场景准确率
- [ ] 与现有 paraformer 的 A/B 对比

**预估工作量**：2-3 天
**模型增量**：~450MB (FP16) 或 254MB (GGUF Q8)

### 2.3 模型配置化

将模型选择从硬编码改为可配置：

```yaml
# conf/models.yaml (新增)
streaming:
  model: paraformer-zh-streaming
  device: auto  # auto | cuda | cpu

offline:
  model: iic/SenseVoiceSmall  # 主力离线模型
  fallback: damo/speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-pytorch
  device: auto

vad:
  model: damo/speech_fsmn_vad_zh-cn-16k-common-pytorch

punc:
  model: damo/punc_ct-transformer_zh-cn-common-vocab272727-pytorch
  enabled: false  # SenseVoice 自带标点时关闭
```

**任务清单**：
- [ ] 模型配置文件格式设计
- [ ] 设置页面新增"模型选择"区域
- [ ] 运行时可切换模型（重新加载）

**预估工作量**：1 天

---

## Phase 3：双模型流水线 🟡 P1

> 目标：流式模型实时预览 + 离线模型后台校对，体验和准确率双赢。

### 3.1 双模型协同架构

```
按住触发键
  │
  ├─→ 音频流 (raw PCM, 16kHz)
  │     │
  │     ├─→ [流式模型] paraformer-zh-streaming
  │     │     每 ~300ms 更新一次预览文字
  │     │     显示在 UI 上（闪烁光标跟随）
  │     │
  │     └─→ [离线模型] SenseVoiceSmall
  │            后台异步运行，每新增 25 字或 2.5s 触发
  │            │
  │            ├─ 整段音频重新识别（更准确）
  │            ├─ 与上一轮结果做 LCP 比对
  │            ├─ 连续两次 LCP 超提交边界 → 稳定前缀可以上屏
  │            └─ 更新 UI：稳定文字（亮色） + 校对中文字（暗色）
  │
  ▼ 松开触发键
SenseVoiceSmall 最后一次全量识别 → 剩余文字全部提交
  │
  ▼ 可选
LLM 润色 → 并行切段优化 → 上屏
```

### 3.2 LCP（最长公共前缀）增量提交

```python
# backend/lcp_tracker.py
class LCPTracker:
    """LCP 稳定性追踪器 — 只在连续两轮离线校对前缀一致时才提交"""

    def __init__(self, stability_rounds=2):
        self.stability_rounds = stability_rounds
        self._last_text = ""          # 上一轮离线结果
        self._committed_len = 0       # 已提交的字符数
        self._stable_count = 0        # 连续稳定轮数

    def update(self, new_text: str) -> str | None:
        """返回可以提交的新前缀（如有），否则返回 None"""
        lcp = self._longest_common_prefix(self._last_text, new_text)

        if lcp > self._committed_len:
            # 前缀在增长
            if lcp == self._longest_common_prefix(new_text, self._last_text or new_text):
                self._stable_count += 1
            else:
                self._stable_count = 1

            if self._stable_count >= self.stability_rounds:
                # 连续稳定 → 提交
                to_commit = new_text[self._committed_len:lcp]
                self._committed_len = lcp
                self._stable_count = 0
                self._last_text = new_text
                return to_commit
        else:
            self._stable_count = 0

        self._last_text = new_text
        return None

    def reset(self):
        self._last_text = ""
        self._committed_len = 0
        self._stable_count = 0
```

**任务清单**：
- [ ] 实现 `LCPTracker` 类
- [ ] 后台离线校对循环（asyncio task）
- [ ] 流式文字 + 离线文字的状态同步
- [ ] 前端多区显示：稳定(亮) + 校对中(半透明) + 流式草稿(闪烁)

**预估工作量**：4-5 天

### 3.3 前端双区渲染

```jsx
// 三区显示组件
function StreamingTextPanel({ stable, proofreading, draft }) {
    return (
        <div className="text-lg leading-relaxed">
            {/* 已稳定，即将上屏 */}
            <span className="text-white/90">{stable}</span>

            {/* 离线模型校对中，可能微调 */}
            <span className="text-white/60">{proofreading}</span>

            {/* 流式模型最新草稿，随时变化 */}
            <span className="text-white/30 animate-pulse">{draft}</span>

            <span className="inline-block w-0.5 h-5 bg-indigo-400 animate-pulse ml-0.5" />
        </div>
    );
}
```

**任务清单**：
- [ ] `StreamingTextPanel` 组件
- [ ] 三区文字颜色/透明度动画
- [ ] 稳定文字滑入上屏动画

**预估工作量**：1-2 天

---

## Phase 4：LLM 润色升级 🟢 P2

> 目标：从"录完一次性润色"升级为"增量切段 + 上下文感知 + 并行润色"。

### 4.1 增量润色管道

**现状**：`processAudio()` → ASR 全文 → 一次 LLM 调用 → 完。

**改造后**：
```
绿区稳定文字 (已通过 LCP 验证)
  │
  ├─→ 携带上下文（上文 40 字 + 下文 30 字 + 前文参考 500 字）
  ├─→ LLM 润色
  ├─→ 在润色结果的可靠标点上切句
  ├─→ 上屏完整句子，残句留在绿区
  └─→ 等下一波绿区文字，合并再润（周而复始）
```

### 4.2 上下文感知 prompt

```python
# backend/llm_refiner.py
SYSTEM_PROMPT = """你是中文语音识别（ASR）文本的实时校对助手。输入是 ASR 原始输出，可能存在：
- 同音/近音字错误（人名、术语被写成同音别字）
- 中英混说时英文术语被拆错或拼错
- 英文短语被转写成发音相近的另一个英文词
- 音译成汉字的外来词
- 口头语、结巴重复
- 标点缺失、错误或重复

你的任务：
1. 结合上下文语义推断专有名词的正确写法
2. 根据上下文纠正明显的同音字错误
3. 删除无意义的口头语，修复结巴重复
4. 规范标点（不允许连续标点）
5. 保持原意和口语风格
6. 同一事物的用词、专名拼写须与上文保持一致

只输出校对后的文本，不要任何解释、前缀或引号。"""

def build_refine_prompt(text, prev_context, next_context, background_context):
    parts = []
    if background_context:
        parts.append(f"【前文参考｜用词一致性锚点，禁止输出】\n{background_context}")
    if prev_context:
        parts.append(f"【上文｜禁止输出】\n{prev_context}")
    parts.append(f"【待校对】\n{text}")
    if next_context:
        parts.append(f"【下文｜语义参考，禁止输出】\n{next_context}")
    return "\n\n".join(parts)
```

### 4.3 终审切段并行

**问题**：长文本单次 LLM 调用耗时长（5-7 秒），用户等不起。

**方案**：松手后切成 35 字段，多路并发请求。

```python
async def refine_final_long_text(text: str) -> str:
    """长文本切成 ≤35 字段，并行润色，部分超时只回退对应段"""
    if len(text) <= 40:
        return await llm_refine(text)

    chunks = split_by_semantic_boundary(text, chunk_size=35)
    tasks = [llm_refine(chunk, prev=chunks[i-1][-40:], next=chunks[i+1][:30])
             for i, chunk in enumerate(chunks)]

    done, pending = await asyncio.wait(tasks, timeout=6.0)
    results = []
    for i, task in enumerate(tasks):
        if task in done and not task.exception():
            results.append(task.result())
        else:
            results.append(chunks[i])  # 超时/失败的段用原文

    return "".join(results)
```

**任务清单**：
- [ ] 实现 `LLMRefiner` 类（上下文拼接、prompt 管理）
- [ ] 终审切段 + 并行请求
- [ ] 超时回退策略
- [ ] 防回显逻辑（LLM 抄写上下文）
- [ ] 连接复用（httpx AsyncClient 长驻）

**预估工作量**：3-4 天

---

## Phase 5：健壮性与体验 🟢 P2

### 5.1 错误恢复

- [ ] 音频设备热插拔：设备断开 → 自动暂停 → 重连后恢复
- [ ] WebSocket 断线重连：指数退避，最大 5 次
- [ ] ASR 模型加载失败不阻塞启动
- [ ] 音频缓冲区溢出保护
- [ ] LLM 调用超时不阻塞主流程

### 5.2 性能监控

- [ ] 端到端延迟埋点（按键→首次出字 / 按键→终审上屏）
- [ ] WebSocket 消息往返时间监控
- [ ] GPU/CPU 利用率展示
- [ ] 模型推理耗时分布
- [ ] 内存使用趋势

### 5.3 用户体验

- [ ] 长按模式（hold-to-talk）：按住说话，松手上屏
- [ ] 点击模式（toggle）：点一下开始，再点一下结束
- [ ] 快捷键自定义（支持组合键）
- [ ] 录音状态系统托盘图标变化
- [ ] 静音检测 + 自动停止（可配置）

### 5.4 测试

- [ ] 后端 ASR 单元测试
- [ ] WebSocket 协议集成测试
- [ ] 前端组件测试
- [ ] 端到端测试（模拟完整语音输入流程）
- [ ] 性能基准测试（RTF、延迟分布）

---

## Phase 6：发布与生态 🔵 P3

### 6.1 打包与部署

- [ ] 一键安装脚本（YuHuang 风格的 `install.sh`）
- [ ] 模型自动下载（首次启动后台静默下载）
- [ ] Docker 镜像发布到 Docker Hub / GHCR
- [ ] GitHub Actions CI/CD（测试 + 构建 + 发布）
- [ ] AUR 包（`ququ-bin` 已有，需更新）

### 6.2 文档

- [ ] 架构设计文档（数据流、模块关系）
- [ ] API 文档（WebSocket 协议）
- [ ] 贡献指南
- [ ] 性能调优指南（workers/threads/GPU 配置）

---

## 技术选型对比

| 维度 | 当前 (ququ) | Phase 1-3 目标 | YuHuang 参考 |
|------|------------|---------------|-------------|
| ASR 模型 | 1 个 (paraformer-large) | 3 个 (streaming + large + SenseVoice) | 5 个 |
| 识别方式 | 录完批量 | 流式 + 离线校对 | 流式 + 离线校对 |
| 音频传输 | WebM→WAV→HTTP | Raw PCM→WebSocket | Raw PCM→Unix Socket |
| 文字显示 | 录完才出现 | 边说边出（三区） | 光标处浮现（三区） |
| 上屏方式 | 剪贴板/模拟粘贴 | 实时模拟打字 | fcitx5 preedit |
| GPU 支持 | ❌ 硬编码 CPU | ✅ 自动检测 | ✅ 自动检测 |
| LLM 润色 | 一次性全文 | 增量切段并行 | 增量切段并行 |
| 模型大小 | ~1.2GB | ~2GB (含 streaming + SenseVoice) | ~3GB+ (5 个模型) |

---

## 里程碑时间线

```
Phase 1 (流式识别):        ████████████████  ✅ 完成
Phase 2 (模型升级):        ██████████        ✅ 完成 (GPU 检测 + SenseVoice + 5 模型)
Phase 3 (双模型流水线):     ████████████████  ✅ 完成 (三区管道 + 增量提交 + 离线纠正)
Phase 4 (LLM 润色升级):    ████████████████  ✅ 完成 (上下文感知 + 关思考梯子 + 并行终审)
Phase 5 (健壮性):          ████████████████  ✅ 完成 (WS 重连/心跳/持久连接/热词监控)
Phase 6 (发布):            ░░░░░░░░░░░░░░░░  ⏳ 待完成
─────────────────────────────────────────────
```

### Phase 1-5 实际实现要点

| 阶段 | 关键实现 |
|------|---------|
| Phase 1 | `server.py` (FastAPI 单进程), `streamingSession.js` (持久 WS + 心跳/重连), `asr_engine.py` (5 模型统一引擎) |
| Phase 2 | GPU 自动检测 (cuda/mps/cpu), SenseVoiceSmall 离线纠正, `download_models.py` 预下载 |
| Phase 3 | `pipeline.py` (CandidateBuffer 三区 + PTTPipeline), 绿区逐句提交, 离线周期纠正, commit starvation 防护 |
| Phase 4 | `llm_optimizer.py` (流式 API + 关思考梯子 + 上下文 prompt), 并行终审切片, 防回显剥离 |
| Phase 5 | WS 持久连接 (mount 时建立), 自动重连 (指数退避), 热词文件 os.stat 监控 + 广播, ESLint 零警告 |

## 风险与应对

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| 流式模型 cache 状态管理出错 | 文字重复/丢失 | Phase 3 的 LCP 去重兜底 |
| WebSocket 连接不稳定 | 丢失音频帧 | 客户端缓冲 + 断线重连 |
| SenseVoice 模型下载慢 | 首次安装体验差 | 后台异步下载 + 进度提示 |
| 多模型显存占用过高 | GPU OOM | CPU fallback + 模型按需加载 |
| 跨平台音频采集差异大 | Windows/Linux 体验不一 | 分平台适配 + fallback 链 |
