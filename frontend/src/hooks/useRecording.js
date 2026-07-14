import { useState, useRef, useCallback } from 'react';

export const useRecording = (modelStatus) => {
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isOptimizing, setIsOptimizing] = useState(false);
  const [error, setError] = useState(null);
  const mr = useRef(null);
  const chunks = useRef([]);
  const stream = useRef(null);
  const startingRef = useRef(false); // 同步标记，在 async 之前设置

  const startRecording = useCallback(async () => {
    if (mr.current || stream.current || startingRef.current) return;
    startingRef.current = true; // 立即可锁定，不等 async
    try {
      setError(null);
      if (!modelStatus?.isReady) throw new Error('FunASR 服务器未就绪');
      const s = await navigator.mediaDevices.getUserMedia({
        audio: { sampleRate: 16000, channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });
      // await 期间 stopRecording 可能已被调用 → startingRef 被设为 false
      if (!startingRef.current) {
        s.getTracks().forEach(t => t.stop());
        return; // 已被取消，不继续创建 recorder
      }
      stream.current = s;
      chunks.current = [];
      const recorder = new MediaRecorder(s, { mimeType: 'audio/webm;codecs=opus' });
      mr.current = recorder;
      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.current.push(e.data); };
      recorder.onstop = async () => {
        mr.current = null;
        startingRef.current = false;
        setIsRecording(false);
        setIsProcessing(true);
        try {
          const blob = new Blob(chunks.current, { type: 'audio/webm;codecs=opus' });
          chunks.current = [];
          await processAudio(blob);
        } catch (err) { setError(err.message); }
        finally { setIsProcessing(false); }
      };
      recorder.onerror = (e) => {
        mr.current = null;
        startingRef.current = false;
        chunks.current = [];
        stream.current?.getTracks().forEach(t => t.stop());
        stream.current = null;
        setError(`录音错误: ${e.error?.message || '未知'}`);
        setIsRecording(false);
        setIsProcessing(false);
      };
      recorder.start(1000);
      setIsRecording(true);
      startingRef.current = false;
    } catch (err) {
      startingRef.current = false;
      mr.current = null;
      stream.current?.getTracks().forEach(t => t.stop());
      stream.current = null;
      setError(`无法录音: ${err.message}`);
      setIsRecording(false);
    }
  }, [modelStatus?.isReady]);

  const stopRecording = useCallback(() => {
    startingRef.current = false; // 取消待处理的启动
    if (mr.current) {
      mr.current.stop();
      stream.current?.getTracks().forEach(t => t.stop());
      stream.current = null;
      mr.current = null;
      setIsRecording(false);
    }
  }, []);

  const cancelRecording = useCallback(() => {
    startingRef.current = false;
    mr.current?.stop();
    stream.current?.getTracks().forEach(t => t.stop());
    stream.current = null;
    mr.current = null;
    setIsRecording(false); setIsProcessing(false); setError(null);
    chunks.current = [];
  }, []);

  const audioBufferToWav = (buf) => {
    const len = buf.length, sr = buf.sampleRate, ch = buf.numberOfChannels;
    const dataSize = len * ch * 2, bufferSize = 44 + dataSize;
    const b = new ArrayBuffer(bufferSize);
    const v = new DataView(b);
    const ws = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    ws(0, 'RIFF'); v.setUint32(4, bufferSize - 8, true); ws(8, 'WAVE'); ws(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, ch, true);
    v.setUint32(24, sr, true); v.setUint32(28, sr * ch * 2, true); v.setUint16(32, ch * 2, true); v.setUint16(34, 16, true);
    ws(36, 'data'); v.setUint32(40, dataSize, true);
    let off = 44;
    for (let i = 0; i < len; i++) { for (let c = 0; c < ch; c++) { const s = Math.max(-1, Math.min(1, buf.getChannelData(c)[i])); v.setInt16(off, s * 0x7FFF, true); off += 2; } }
    return b;
  };

  const convertToWav = async (blob) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
        const audioBuf = await ctx.decodeAudioData(reader.result);
        const wavBuf = audioBufferToWav(audioBuf);
        ctx.close();
        resolve(new Blob([wavBuf], { type: 'audio/wav' }));
      } catch (e) { reject(new Error(`音频转换失败: ${e.message}`)); }
    };
    reader.onerror = () => reject(new Error('读取音频失败'));
    reader.readAsArrayBuffer(blob);
  });

  const processAudio = async (audioBlob) => {
    const wav = await convertToWav(audioBlob);
    const ab = await wav.arrayBuffer();
    const data = new Uint8Array(ab);

    if (!window.electronAPI) {
      // 没有 Electron API 时的模拟
      const mock = { success: true, text: '🎤 这是模拟识别结果（FunASR 未连接）', confidence: 0.9, duration: 1.0, enhanced_by_ai: false };
      window.onTranscriptionComplete?.(mock);
      window.onAIOptimizationComplete?.(mock);
      setIsOptimizing(false);
      return;
    }

    const result = await window.electronAPI.transcribeAudio(data);
    if (!result?.success) throw new Error(result?.error || '识别失败');

    const raw = { ...result, enhanced_by_ai: false };
    window.onTranscriptionComplete?.(raw);

    setIsOptimizing(true);
    const useAI = await window.electronAPI.getSetting('enable_ai_optimization', true);
    let finalText = result.text;
    let processed = null;

    if (useAI) {
      try {
        const aiRes = await window.electronAPI.processText(result.text, 'optimize');
        if (aiRes?.success && aiRes.text) { processed = aiRes.text; finalText = processed; }
      } catch (_) {}
    }

    try {
      await window.electronAPI.saveTranscription({
        text: finalText, raw_text: result.text, processed_text: processed,
        confidence: result.confidence || 0, language: result.language || 'zh-CN',
        duration: result.duration || 0, file_size: data.length,
      });
    } catch (_) {}

    window.onAIOptimizationComplete?.({ ...result, text: finalText, processed_text: processed, enhanced_by_ai: !!processed });
    setIsOptimizing(false);
  };

  return { isRecording, isProcessing, isOptimizing, error, startRecording, stopRecording, cancelRecording };
};
