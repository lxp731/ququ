import { useState, useEffect, useCallback, useRef } from 'react';

export const useHotkey = () => {
  const [hotkey, setHotkey] = useState('Ctrl+Space');
  const [isRegistered, setIsRegistered] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    window.electronAPI?.getCurrentHotkey().then(k => { if (k) setHotkey(k); });
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
