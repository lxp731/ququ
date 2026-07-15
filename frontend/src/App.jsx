import React, { useState, useEffect, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';
import { Mic, Settings, History, Copy, Download, Sparkles, Keyboard, Timer } from 'lucide-react';
import './index.css';
import { useHotkey } from './hooks/useHotkey';
import { useRecording } from './hooks/useRecording';
import { useModelStatus } from './hooks/useModelStatus';

// ═══════════════════════════════════════════
//  Subtle animated background dots
// ═══════════════════════════════════════════
const BgDots = () => (
  <div className="absolute inset-0 overflow-hidden pointer-events-none">
    {[...Array(20)].map((_, i) => (
      <div
        key={i}
        className="absolute w-1 h-1 rounded-full bg-white/10"
        style={{
          left: `${Math.random() * 100}%`,
          top: `${Math.random() * 100}%`,
          animation: `pulse ${2 + Math.random() * 3}s ease-in-out infinite`,
          animationDelay: `${Math.random() * 2}s`,
        }}
      />
    ))}
  </div>
);

// ═══════════════════════════════════════════
//  Animated Waveform
// ═══════════════════════════════════════════
const Waveform = ({ active, color = 'indigo' }) => (
  <div className="flex items-center justify-center gap-0.5 h-8">
    {[...Array(16)].map((_, i) => (
      <motion.div
        key={i}
        className={`w-0.5 rounded-full bg-${color}-400`}
        animate={active ? {
          height: [4, Math.random() * 24 + 4, 4],
          opacity: [0.4, 1, 0.4],
        } : { height: 4, opacity: 0.3 }}
        transition={active ? {
          duration: 0.6 + Math.random() * 0.4,
          repeat: Infinity,
          delay: i * 0.05,
          ease: 'easeInOut',
        } : {}}
      />
    ))}
  </div>
);

// ═══════════════════════════════════════════
//  Mic Button — the hero
// ═══════════════════════════════════════════
const MicButton = ({ state, onClick, disabled }) => {
  const isRecording = state === 'recording';
  const isProcessing = state === 'processing' || state === 'optimizing';
  const isDisabled = disabled || isProcessing;

  return (
    <motion.div className="relative inline-flex items-center justify-center" whileHover={{ scale: isDisabled ? 1 : 1.05 }}>
      {/* Pulse rings when recording */}
      {isRecording && (
        <>
          <div className="mic-ring" />
          <div className="mic-ring" />
          <div className="mic-ring" />
        </>
      )}

      {/* Main button */}
      <motion.button
        onClick={onClick}
        disabled={isDisabled}
        className={`relative z-10 w-20 h-20 rounded-full flex items-center justify-center
          border-2 transition-all duration-500 cursor-pointer
          ${isRecording
            ? 'border-indigo-400/50 bg-indigo-500/20 recording-glow'
            : isProcessing
              ? 'border-white/10 bg-white/5 cursor-wait'
              : 'border-white/10 bg-white/[0.06] hover:bg-white/[0.12] hover:border-white/20'
          }
          ${isDisabled && !isProcessing ? 'opacity-40 cursor-not-allowed' : ''}
        `}
        whileTap={isDisabled ? {} : { scale: 0.92 }}
        animate={isRecording ? { scale: [1, 1.03, 1] } : { scale: 1 }}
        transition={isRecording ? { duration: 2, repeat: Infinity, ease: 'easeInOut' } : {}}
      >
        {/* Inner icon area */}
        <div className={`w-14 h-14 rounded-full flex items-center justify-center transition-all duration-500
          ${isRecording ? 'bg-indigo-500/20' : 'bg-white/[0.04]'}`}
        >
          {isProcessing ? (
            <motion.div
              className="w-6 h-6 border-2 border-indigo-400/60 border-t-transparent rounded-full"
              animate={{ rotate: 360 }}
              transition={{ duration: 1, repeat: Infinity, ease: 'linear' }}
            />
          ) : isRecording ? (
            <div className="flex gap-1">
              {[...Array(4)].map((_, i) => (
                <motion.div
                  key={i}
                  className="w-1 bg-indigo-300 rounded-full"
                  animate={{ height: [8, 20, 8] }}
                  transition={{ duration: 0.6, repeat: Infinity, delay: i * 0.1, ease: 'easeInOut' }}
                />
              ))}
            </div>
          ) : (
            <Mic className="w-6 h-6 text-white/60" />
          )}
        </div>
      </motion.button>
    </motion.div>
  );
};

// ═══════════════════════════════════════════
//  Tooltip
// ═══════════════════════════════════════════
const Tooltip = ({ children, content, position = "top" }) => {
  const [show, setShow] = useState(false);
  const isTop = position === "top";
  return (
    <div className="relative" onMouseEnter={() => setShow(true)} onMouseLeave={() => setShow(false)}>
      {children}
      <AnimatePresence>
        {show && (
          <motion.div
            initial={{ opacity: 0, y: isTop ? 4 : -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: isTop ? 4 : -4 }}
            className={`absolute left-1/2 -translate-x-1/2 px-2.5 py-1 text-[10px] whitespace-nowrap rounded-lg bg-white/10 backdrop-blur-md border border-white/10 text-white/80 z-50 ${
              isTop ? 'bottom-full mb-2' : 'top-full mt-2'
            }`}
          >
            {content}
            <div className="absolute top-full left-1/2 -translate-x-1/2 w-0 h-0 border-l-4 border-r-4 border-t-4 border-transparent border-t-white/10" />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

// ═══════════════════════════════════════════
//  Text Display Panel
// ═══════════════════════════════════════════
const TextPanel = ({ original, processed, isOptimizing, onCopy, onPaste }) => {
  if (!original && !processed) return null;
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="space-y-3"
    >
      {/* Original text */}
      {original && (
        <div className="glass-light p-4 group">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] uppercase tracking-widest text-white/30">识别结果</span>
            <button onClick={() => onCopy(original)}
              className="p-1.5 rounded-lg hover:bg-white/10 transition-colors opacity-0 group-hover:opacity-100">
              <Copy className="w-3.5 h-3.5 text-white/50" />
            </button>
          </div>
          <p className="text-sm text-white/80 leading-relaxed">{original}</p>
        </div>
      )}

      {/* AI Optimized */}
      {(processed || isOptimizing) && (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="glass-light p-4 border-indigo-400/20"
        >
          <div className="flex items-center justify-between mb-2">
            <span className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-indigo-300/70">
              <Sparkles className="w-3 h-3" /> AI 优化
            </span>
            <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
              {processed && (
                <>
                  <button onClick={() => onPaste(processed)}
                    className="p-1.5 rounded-lg hover:bg-indigo-500/20 transition-colors" title="粘贴">
                    <Download className="w-3.5 h-3.5 text-indigo-400/70" />
                  </button>
                  <button onClick={() => onCopy(processed)}
                    className="p-1.5 rounded-lg hover:bg-indigo-500/20 transition-colors" title="复制">
                    <Copy className="w-3.5 h-3.5 text-indigo-400/70" />
                  </button>
                </>
              )}
            </div>
          </div>
          {isOptimizing ? (
            <div className="flex items-center gap-3 py-2">
              <motion.div className="w-4 h-4 border-2 border-indigo-400/60 border-t-transparent rounded-full"
                animate={{ rotate: 360 }} transition={{ duration: 1, repeat: Infinity, ease: 'linear' }} />
              <span className="text-sm text-indigo-300/60">AI 正在优化文本...</span>
            </div>
          ) : (
            <p className="text-sm text-white/90 leading-relaxed">{processed}</p>
          )}
        </motion.div>
      )}
    </motion.div>
  );
};

// ═══════════════════════════════════════════
//  MAIN APP
// ═══════════════════════════════════════════
export default function App() {
  const urlParams = new URLSearchParams(window.location.search);
  const isSettings = urlParams.get('page') === 'settings';
  const isControl = urlParams.get('panel') === 'control';

  if (isSettings) {
    const SettingsPage = React.lazy(() => import('./settings.jsx'));
    return (
      <React.Suspense fallback={<div className="min-h-screen animated-bg flex items-center justify-center"><div className="w-6 h-6 border-2 border-indigo-400/60 border-t-transparent rounded-full animate-spin" /></div>}>
        <SettingsPage />
      </React.Suspense>
    );
  }

  const [originalText, setOriginalText] = useState('');
  const [processedText, setProcessedText] = useState('');
  const [isOptimizing, setIsOptimizing] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const [recordingMode, setRecordingMode] = useState('toggle');
  const [isCapturingHotkey, setIsCapturingHotkey] = useState(false);

  const modelStatus = useModelStatus();
  const { isRecording, isProcessing: isRecProcessing, startRecording, stopRecording } = useRecording(modelStatus);
  const { hotkey, rawHotkey, registerHotkey, unregisterHotkey, syncRecordingState } = useHotkey();

  const lastPasteRef = useRef({ text: '', ts: 0 });

  // Load saved recording mode
  useEffect(() => {
    window.electronAPI?.getSetting('recording_mode', 'toggle').then(setRecordingMode);
  }, []);

  // Safe paste with dedup
  const safePaste = useCallback(async (text) => {
    const now = Date.now();
    if (lastPasteRef.current.text === text && now - lastPasteRef.current.ts < 1000) return;
    lastPasteRef.current = { text, ts: now };
    try {
      if (window.electronAPI) {
        await window.electronAPI.pasteText(text);
        toast.success('已自动粘贴到当前输入框');
      } else {
        await navigator.clipboard.writeText(text);
        toast.info('已复制到剪贴板');
      }
    } catch (e) {
      toast.error('粘贴失败，请手动粘贴');
    }
  }, []);

  // Recording complete callback
  const handleRecordingComplete = useCallback(async (result) => {
    if (!result?.success || !result.text) return;
    setOriginalText(result.text);
    setProcessedText('');
    setIsOptimizing(true);
  }, []);

  // AI optimization complete callback
  const handleAIOptimizationComplete = useCallback(async (result) => {
    setIsOptimizing(false);
    if (result?.enhanced_by_ai) {
      // AI 实际优化过的文本，显示在优化区块
      setProcessedText(result.text);
      await safePaste(result.text);
      toast.success('AI 优化完成，已自动粘贴');
    } else {
      // AI 未启用或优化失败，只粘贴原始文本，不显示 AI 优化区块
      setProcessedText('');
      if (originalText) {
        await safePaste(originalText);
      }
    }
  }, [safePaste, originalText]);

  // Register callbacks on window
  useEffect(() => {
    window.onTranscriptionComplete = handleRecordingComplete;
    window.onAIOptimizationComplete = handleAIOptimizationComplete;
    return () => { window.onTranscriptionComplete = null; window.onAIOptimizationComplete = null; };
  }, [handleRecordingComplete, handleAIOptimizationComplete]);

  // Toggle recording
  const toggleRecording = useCallback(() => {
    if (!modelStatus.isReady) {
      const msgs = { need_backend: '请先启动后端服务', connecting: '正在连接后端...', need_download: '请先下载 AI 模型', downloading: '模型下载中...', loading: '模型加载中...', error: `模型错误: ${modelStatus.error}` };
      toast.warning(msgs[modelStatus.stage] || '模型未就绪');
      return;
    }
    if (!isRecording && !isRecProcessing) startRecording();
    else if (isRecording) stopRecording();
  }, [modelStatus, isRecording, isRecProcessing, startRecording, stopRecording]);

  // Hotkey capture
  useEffect(() => {
    if (!isCapturingHotkey) return;
    const handler = async (e) => {
      e.preventDefault(); e.stopPropagation();
      if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
      const parts = [];
      if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
      if (e.shiftKey) parts.push('Shift');
      if (e.altKey) parts.push('Alt');
      parts.push(e.key === ' ' ? 'Space' : e.key.length === 1 ? e.key.toUpperCase() : e.key);
      const newKey = parts.join('+');
      await unregisterHotkey(rawHotkey);
      const ok = await registerHotkey(newKey);
      if (ok) await window.electronAPI?.setSetting('global_hotkey', newKey);
      setIsCapturingHotkey(false);
    };
    window.addEventListener('keydown', handler, true);
    const t = setTimeout(() => setIsCapturingHotkey(false), 5000);
    return () => { window.removeEventListener('keydown', handler, true); clearTimeout(t); };
  }, [isCapturingHotkey, rawHotkey, registerHotkey, unregisterHotkey]);

  // 用 ref 避免闭包过期
  const isRecordingRef = useRef(isRecording);
  isRecordingRef.current = isRecording;
  const startRef = useRef(startRecording);
  startRef.current = startRecording;
  const stopRef = useRef(stopRecording);
  stopRef.current = stopRecording;

  // Hold mode: KeyWatcher (evdev) 全局监听，追踪组合键 Ctrl/Meta + Space
  const heldKeys = useRef(new Set());

  useEffect(() => {
    if (recordingMode !== 'hold') return;
    window.electronAPI?.startHoldWatch().then(r => {
      if (!r?.success) {
        toast.warning('当前平台不支持长按模式，已切换回切换模式');
        setRecordingMode('toggle');
        window.electronAPI?.setSetting('recording_mode', 'toggle');
      }
    });

    const isModHeld = () => heldKeys.current.has('Control') || heldKeys.current.has('Meta') || heldKeys.current.has('Alt');
    const isSpaceHeld = () => heldKeys.current.has('Space');

    const u1 = window.electronAPI?.onHoldKeyDown((data) => {
      const key = data?.key;
      heldKeys.current.add(key);
      // 只有同时按住 Ctrl/Meta/Alt + Space 才触发录音
      if (isSpaceHeld() && isModHeld() && !isRecordingRef.current && !isRecProcessingRef.current) {
        startRef.current();
      }
    });

    const u2 = window.electronAPI?.onHoldKeyUp((data) => {
      const key = data?.key;
      // Ctrl/Meta/Alt 或 Space 松开 → 停止录音
      if ((isModHeld() || isSpaceHeld()) && isRecordingRef.current) {
        stopRef.current();
      }
      heldKeys.current.delete(key);
    });

    return () => {
      u1?.(); u2?.();
      heldKeys.current.clear();
      window.electronAPI?.stopHoldWatch();
    };
  }, [recordingMode]);

  // isRecProcessing ref（避免闭包问题）
  const isRecProcessingRef = useRef(isRecProcessing);
  isRecProcessingRef.current = isRecProcessing;

  // 全局快捷键: 仅切换模式使用；长按模式由 KeyWatcher 接管
  useEffect(() => {
    if (recordingMode === 'hold') return;
    const handler = () => toggleRecording();
    const u1 = window.electronAPI?.onHotkeyTriggered(handler);
    const u2 = window.electronAPI?.onToggleDictation(handler);
    return () => { u1?.(); u2?.(); };
  }, [toggleRecording, recordingMode]);

  // Sync recording state to main process
  useEffect(() => { syncRecordingState?.(isRecording); }, [isRecording, syncRecordingState]);

  // Init hotkey
  useEffect(() => {
    if (!isControl) registerHotkey('Ctrl+Space');
  }, []);

  const micState = isRecording ? 'recording' : (isRecProcessing || isOptimizing) ? 'processing' : isHovered ? 'hover' : 'idle';

  return (
    <div className="min-h-screen animated-bg relative">
      <BgDots />

      <div className="relative z-10 max-w-lg mx-auto min-h-screen flex flex-col px-5 py-4">
        {/* ── Title Bar ── */}
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-bold gradient-text tracking-tight">蛐蛐</h1>
          <div className="flex items-center gap-1">
            <Tooltip content="历史记录" position="bottom">
              <button onClick={() => window.electronAPI?.openHistoryWindow()}
                className="p-2 rounded-lg hover:bg-white/10 transition-colors">
                <History className="w-4 h-4 text-white/50" />
              </button>
            </Tooltip>
            <Tooltip content="设置" position="bottom">
              <button onClick={() => window.electronAPI?.openSettingsWindow()}
                className="p-2 rounded-lg hover:bg-white/10 transition-colors">
                <Settings className="w-4 h-4 text-white/50" />
              </button>
            </Tooltip>
          </div>
        </div>

        {/* ── Mic Area ── */}
        <div className="flex flex-col items-center mb-6">
          <div
            className="relative"
            onMouseEnter={() => setIsHovered(true)}
            onMouseLeave={() => setIsHovered(false)}
          >
            <MicButton
              state={modelStatus.isReady ? micState : 'disabled'}
              onClick={toggleRecording}
              disabled={!modelStatus.isReady}
            />
          </div>

          {/* Status text */}
          <motion.p
            key={micState + (modelStatus.isReady ? 'ready' : 'not')}
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            className="mt-4 text-sm text-white/40 text-center"
          >
            {modelStatus.noApi && 'Electron API 不可用'}
            {!modelStatus.noApi && modelStatus.stage === 'need_backend' && '后端服务未连接'}
            {modelStatus.stage === 'connecting' && '正在连接后端服务...'}
            {modelStatus.stage === 'checking' && '正在检查模型状态...'}
            {modelStatus.stage === 'need_download' && '需要下载 AI 模型文件'}
            {modelStatus.stage === 'downloading' && `模型下载中 ${modelStatus.downloadProgress || 0}%`}
            {modelStatus.stage === 'loading' && 'FunASR 模型加载中...'}
            {modelStatus.stage === 'error' && `模型错误: ${String(modelStatus.error || '未知')}`}
            {modelStatus.stage === 'ready' && micState === 'recording' && '正在录音，再次点击停止'}
            {modelStatus.stage === 'ready' && micState === 'processing' && '正在识别语音...'}
            {modelStatus.stage === 'ready' && micState === 'optimizing' && 'AI 正在优化文本...'}
            {modelStatus.stage === 'ready' && micState === 'idle' && `按 ${hotkey} 或点击麦克风`}
            {modelStatus.stage === 'ready' && micState === 'hover' && '点击开始录音'}
          </motion.p>

          {/* Waveform when recording */}
          <div className="mt-2 h-8">
            {isRecording && <Waveform active={true} />}
            {isRecProcessing && <Waveform active={true} color="violet" />}
          </div>

          {/* Hotkey & Mode Controls */}
          <div className="mt-3 flex items-center gap-2 no-drag">
            <Tooltip content={isCapturingHotkey ? '请按下新快捷键...' : '点击修改快捷键'} position="bottom">
              <motion.button
                onClick={() => setIsCapturingHotkey(true)}
                animate={isCapturingHotkey ? { scale: [1, 1.03, 1] } : {}}
                transition={{ duration: 1, repeat: Infinity }}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border transition-all ${
                  isCapturingHotkey
                    ? 'border-indigo-400/50 bg-indigo-500/10 text-indigo-300'
                    : 'border-white/10 text-white/40 hover:border-white/20 hover:text-white/60'
                }`}
              >
                <Keyboard className="w-3 h-3" />
                {isCapturingHotkey ? '请按键...' : hotkey}
              </motion.button>
            </Tooltip>

            <Tooltip content={recordingMode === 'toggle' ? '切换模式：按一次开始，再按停止' : '长按模式：按住录音，松开停止'} position="bottom">
              <button
                onClick={async () => {
                  const next = recordingMode === 'toggle' ? 'hold' : 'toggle';
                  setRecordingMode(next);
                  await window.electronAPI?.setSetting('recording_mode', next);
                }}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border transition-all ${
                  recordingMode === 'hold'
                    ? 'border-emerald-400/30 bg-emerald-500/10 text-emerald-300'
                    : 'border-white/10 text-white/40 hover:border-white/20'
                }`}
              >
                <Timer className="w-3 h-3" />
                {recordingMode === 'toggle' ? '切换' : '长按'}
              </button>
            </Tooltip>
          </div>
        </div>

        {/* ── Model Status Banner ── */}
        <AnimatePresence>
          {(modelStatus.stage === 'need_download' || modelStatus.stage === 'downloading' || modelStatus.stage === 'loading') && (
            <motion.div
              initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}
              className="mb-4 overflow-hidden"
            >
              <div className="glass-light p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs text-white/60">
                    {modelStatus.stage === 'need_download' && '需要下载 AI 模型'}
                    {modelStatus.stage === 'downloading' && `下载中 ${modelStatus.downloadProgress || 0}%`}
                    {modelStatus.stage === 'loading' && '模型加载中...'}
                  </span>
                  {modelStatus.stage === 'need_download' && (
                    <button onClick={async () => {
                      toast.info('开始下载模型...');
                      const r = await window.electronAPI?.downloadModel();
                      if (r?.success) toast.success('模型下载完成');
                    }} className="text-xs px-3 py-1 bg-indigo-500/20 text-indigo-300 rounded-lg hover:bg-indigo-500/30 transition-colors">
                      下载
                    </button>
                  )}
                </div>
                {(modelStatus.stage === 'downloading' || modelStatus.stage === 'loading') && (
                  <div className="h-1 bg-white/5 rounded-full overflow-hidden">
                    <motion.div
                      className="h-full bg-gradient-to-r from-indigo-500 to-purple-500 rounded-full"
                      animate={{ width: modelStatus.stage === 'loading' ? '90%' : `${modelStatus.downloadProgress || 0}%` }}
                      transition={{ duration: 0.5 }}
                    />
                  </div>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* ── Backend Status Banner ── */}
        <AnimatePresence>
          {(modelStatus.stage === 'need_backend' || modelStatus.stage === 'connecting') && (
            <motion.div
              initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}
              className="mb-4 overflow-hidden"
            >
              <div className="glass-light p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs text-white/60">
                    {modelStatus.stage === 'need_backend' && '后端服务未连接'}
                    {modelStatus.stage === 'connecting' && '正在连接后端服务...'}
                  </span>
                  {modelStatus.stage === 'need_backend' && (
                    <div className="flex gap-2">
                      <button onClick={async () => {
                        toast.info('正在启动本地后端...');
                        const r = await modelStatus.startLocalBackend();
                        if (r?.success) toast.success('后端启动成功');
                      }} className="text-xs px-3 py-1 bg-emerald-500/20 text-emerald-300 rounded-lg hover:bg-emerald-500/30 transition-colors">
                        启动本地
                      </button>
                      <button onClick={() => window.electronAPI?.openSettingsWindow()}
                        className="text-xs px-3 py-1 bg-indigo-500/20 text-indigo-300 rounded-lg hover:bg-indigo-500/30 transition-colors">
                        手动设置
                      </button>
                    </div>
                  )}
                </div>
                {modelStatus.stage === 'connecting' && (
                  <div className="h-1 bg-white/5 rounded-full overflow-hidden">
                    <motion.div
                      className="h-full bg-gradient-to-r from-emerald-500 to-indigo-500 rounded-full"
                      animate={{ width: '90%' }}
                      transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
                    />
                  </div>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* ── Text Display ── */}
        <div className="flex-1 overflow-y-auto min-h-0">
          <TextPanel
            original={originalText}
            processed={processedText}
            isOptimizing={isOptimizing}
            onCopy={async (t) => { await window.electronAPI?.copyText(t); toast.success('已复制'); }}
            onPaste={safePaste}
          />
        </div>

        {/* ── Footer Branding ── */}
        <div className="text-center py-3 flex items-center justify-center gap-3">
          <span className="text-[10px] text-white/15 tracking-widest">QUQU</span>
          {/* Live status dot to confirm React is interactive */}
          <span className={`inline-block w-1.5 h-1.5 rounded-full ${
            modelStatus.noApi ? 'bg-red-400' :
            modelStatus.stage === 'ready' ? 'bg-emerald-400' :
            modelStatus.stage === 'checking' ? 'bg-amber-400 animate-pulse' :
            modelStatus.stage === 'loading' ? 'bg-blue-400 animate-pulse' :
            modelStatus.stage === 'connecting' ? 'bg-emerald-400 animate-pulse' :
            modelStatus.stage === 'need_backend' ? 'bg-amber-400' :
            modelStatus.stage === 'error' ? 'bg-red-400' :
            'bg-white/20'
          }`} />
          <span className="text-[10px] text-white/20">{modelStatus.stage}</span>
        </div>
      </div>
    </div>
  );
}
