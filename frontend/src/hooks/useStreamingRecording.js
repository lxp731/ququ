import { useState, useRef, useCallback, useEffect } from 'react';
import { StreamingSession } from './streamingSession';

const STREAMING_WS_URL = 'ws://127.0.0.1:8000/stream/ws';

/**
 * 流式录音 hook — PTT 驱动, WebSocket 连接 Python pipeline
 *
 * 状态:
 *   idle → recording (PTT start) → processing (PTT stop, wait final) → done
 *
 * 与后端 pipeline 协议:
 *   Client → Server: start_listening, stop_listening, reset, commit_now, ping
 *   Server → Client: preedit {green,yellow,red}, commit {text}, final {text}
 */
export const useStreamingRecording = () => {
    const [isRecording, setIsRecording] = useState(false);
    const [isProcessing, setIsProcessing] = useState(false);
    const [isOptimizing, setIsOptimizing] = useState(false);
    const [error, setError] = useState(null);

    const sessionRef = useRef(null);        // StreamingSession
    const streamRef = useRef(null);         // MediaStream
    const ctxRef = useRef(null);            // AudioContext
    const processorRef = useRef(null);      // ScriptProcessorNode
    const sourceRef = useRef(null);         // MediaStreamAudioSourceNode
    const startingRef = useRef(false);
    const _callbacksRef = useRef({});       // { onText, onPreedit, onCommit, onFinal }

    // ── 持久 WS 连接 (不随录音启停) ──
    useEffect(() => {
        let cancelled = false;
        const session = new StreamingSession(STREAMING_WS_URL);

        session.on('hotwords_updated', ({ count }) => {
            _callbacksRef.current?.onHotwordsUpdated?.(count);
        });
        session.on('preedit', ({ green, yellow, red }) => {
            _callbacksRef.current?.onPreedit?.({ green, yellow, red });
        });
        session.on('commit', ({ text }) => {
            _callbacksRef.current?.onCommit?.(text);
        });
        session.on('final', ({ text }) => {
            _callbacksRef.current?.onFinal?.(text);
        });
        session.on('partial', ({ text }) => {
            _callbacksRef.current?.onText?.(text);
        });
        session.on('status', ({ streamingLoaded }) => {
            if (!streamingLoaded) console.warn('[Streaming] Server model not loaded');
        });
        session.on('error', ({ message }) => {
            console.warn('[Streaming] Server error:', message);
        });
        session.on('reset', () => {
            _callbacksRef.current?.onPreedit?.({ green: '', yellow: '', red: '' });
        });

        const connect = async () => {
            while (!cancelled) {
                try {
                    await session.start();
                    if (cancelled) { session.stop(); return; }
                    sessionRef.current = session;
                    setError(null);
                    console.log('[Streaming] WS connected');
                    // 同步配置到后端
                    try {
                        const enabled = !!(await window.electronAPI?.getSetting('enable_ai_optimization', true));
                        const base_url = await window.electronAPI?.getSetting('ai_base_url', 'https://api.openai.com/v1');
                        const api_key = await window.electronAPI?.getSetting('ai_api_key', '') || '';
                        const model = await window.electronAPI?.getSetting('ai_model', 'gpt-3.5-turbo');
                        const hotwords = await window.electronAPI?.getSetting('hotwords', '') || '';
                        const hotword_path = await window.electronAPI?.getSetting('hotword_path', '') || '';
                        session.sendConfig({
                            enabled: enabled && !!api_key,
                            base_url, api_key, model,
                            hotwords, hotword_path,
                        });
                    } catch (_) { /* settings not available */ }
                    return;  // connected, stop retrying
                } catch (_e) {
                    console.warn('[Streaming] WS connect failed, retrying in 3s...');
                    await new Promise(r => setTimeout(r, 3000));
                }
            }
        };
        connect();

        return () => { cancelled = true; session.stop(); sessionRef.current = null; };
    }, []);

    // ── Audio cleanup helper ──
    const _cleanupAudio = () => {
        if (processorRef.current) {
            processorRef.current.disconnect();
            processorRef.current = null;
        }
        if (sourceRef.current) {
            sourceRef.current.disconnect();
            sourceRef.current = null;
        }
        if (streamRef.current) {
            streamRef.current.getTracks().forEach(t => t.stop());
            streamRef.current = null;
        }
        if (ctxRef.current && ctxRef.current.state !== 'closed') {
            ctxRef.current.close();
            ctxRef.current = null;
        }
    };

    // Cleanup audio on unmount
    useEffect(() => {
        return () => {
            if (streamRef.current) {
                streamRef.current.getTracks().forEach(t => t.stop());
                streamRef.current = null;
            }
            if (ctxRef.current && ctxRef.current.state !== 'closed') {
                ctxRef.current.close();
                ctxRef.current = null;
            }
            _cleanupAudio();
        };
    }, []);

    // ── Start Recording ──

    const startRecording = useCallback(async () => {
        if (startingRef.current || isRecording) return;
        startingRef.current = true;
        setError(null);

        try {
            const session = sessionRef.current;
            if (!session?.ready) throw new Error('WebSocket 未连接');

            // Start mic → PCM → WebSocket
            const micStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    sampleRate: 16000,
                    channelCount: 1,
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true,
                }
            });

            // await 期间可能被取消
            if (!startingRef.current) {
                micStream.getTracks().forEach(t => t.stop());
                return;
            }

            streamRef.current = micStream;
            const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
            ctxRef.current = ctx;
            const source = ctx.createMediaStreamSource(micStream);
            sourceRef.current = source;
            const processor = ctx.createScriptProcessor(4096, 1, 1);
            processorRef.current = processor;

            processor.onaudioprocess = (e) => {
                if (!sessionRef.current?.ready) return;
                const input = e.inputBuffer.getChannelData(0);
                const pcm = new Int16Array(input.length);
                for (let i = 0; i < input.length; i++) {
                    const s = Math.max(-1, Math.min(1, input[i]));
                    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
                }
                sessionRef.current.sendAudio(new Uint8Array(pcm.buffer));
            };

            source.connect(processor);
            processor.connect(ctx.destination);

            // PTT start
            session.startListening();
            setIsRecording(true);
            startingRef.current = false;

        } catch (err) {
            startingRef.current = false;
            _cleanupAudio();
            const msg = `无法开始录音: ${err.message}`;
            setError(msg);
            console.error('[Streaming]', msg);
            // 如果 WS 未连接, 尝试重连
            if (err.message === 'WebSocket 未连接') {
                setTimeout(() => {
                    const s = new StreamingSession(STREAMING_WS_URL);
                    s.start().then(() => {
                        sessionRef.current = s;
                        setError(null);
                        console.log('[Streaming] WS reconnected');
                    }).catch(() => {});
                }, 1000);
            }
        }
    }, []);

    // ── Stop Recording ──

    const stopRecording = useCallback(async () => {
        startingRef.current = false;
        if (!sessionRef.current) return;

        // 停止音频采集
        _cleanupAudio();

        setIsRecording(false);
        setIsProcessing(true);

        try {
            const session = sessionRef.current;

            session.stopListening();

            // 等待 final 消息 (pipeline finalize)
            const finalPromise = new Promise((resolve) => {
                session.on('final', ({ text }) => {
                    resolve(text || '');
                });
            });

            // 超时 8s
            const timeoutPromise = new Promise((resolve) => {
                setTimeout(() => resolve(''), 8000);
            });

            await Promise.race([finalPromise, timeoutPromise]);

        } catch (err) {
            setError(`处理失败: ${err.message}`);
        } finally {
            setIsProcessing(false);
            setIsOptimizing(false);
        }
    }, []);

    // ── Cancel ──

    const cancelRecording = useCallback(() => {
        startingRef.current = false;
        _cleanupAudio();
        if (sessionRef.current) {
            sessionRef.current.reset();
        }
        setIsRecording(false);
        setIsProcessing(false);
        setIsOptimizing(false);
        setError(null);
    }, []);

    return {
        isRecording,
        isProcessing,
        isOptimizing,
        error,
        startRecording,
        stopRecording,
        cancelRecording,
        // Callbacks ref — set by App.jsx
        get _callbacks() { return _callbacksRef.current; },
        set _callbacks(v) { _callbacksRef.current = v; },
    };
};
