import { useState, useEffect, useCallback, useRef } from 'react';

export const useHotkey = () => {
  const [hotkey, setHotkey] = useState('Ctrl+Space');
  const [isRegistered, setIsRegistered] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    const init = async () => {
      // 只在主窗口注册快捷键，设置页/控制面板跳过
      const p = new URLSearchParams(window.location.search);
      if (p.get('panel') === 'control' || p.get('page') === 'settings') return;
      const savedKey = await window.electronAPI?.getSetting('global_hotkey', 'Ctrl+Space') || 'Ctrl+Space';
      // 若用户已通过捕获面板注册过（ref 非空），不覆盖
      if (ref.current) return;
      const r = await window.electronAPI?.registerHotkey(savedKey);
      if (r?.success) { ref.current = savedKey; setHotkey(savedKey); setIsRegistered(true); }
    };
    init();
  }, []);

  const registerHotkey = useCallback(async (newKey) => {
    if (ref.current === newKey && isRegistered) return true;
    if (!window.electronAPI) return false;
    const r = await window.electronAPI.registerHotkey(newKey);
    if (r?.success) { ref.current = newKey; setHotkey(newKey); setIsRegistered(true); return true; }
    return false;
  }, [isRegistered]);

  const unregisterHotkey = useCallback(async (key) => {
    if (!window.electronAPI) return;
    const r = await window.electronAPI.unregisterHotkey(key || hotkey);
    if (r?.success) setIsRegistered(false);
  }, [hotkey]);

  const syncRecordingState = useCallback(async (rec) => {
    try { await window.electronAPI?.setRecordingState(rec); } catch (_) {}
  }, []);

  const formatHotkey = (h) => {
    return h.replace('Ctrl', navigator.platform.includes('Mac') ? '⌘' : 'Ctrl')
      .replace('Shift', '⇧').replace('Alt', '⌥').replace('Space', '空格');
  };

  return {
    hotkey: formatHotkey(hotkey),
    rawHotkey: hotkey,
    isRegistered,
    registerHotkey,
    unregisterHotkey,
    syncRecordingState,
  };
};
