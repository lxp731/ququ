import { useState, useCallback } from 'react';

export const useTextProcessing = () => {
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState(null);

  const determineMode = useCallback((text, userMode = 'auto') => {
    if (userMode !== 'auto') return userMode;
    const trimmed = text.trim();
    return (trimmed.length > 150 || trimmed.split(/\s+/).length > 30) ? 'optimize_long' : 'optimize';
  }, []);

  const processText = useCallback(async (text, mode) => {
    if (!text?.trim()) return null;
    setIsProcessing(true); setError(null);
    try {
      const actualMode = determineMode(text, mode);
      if (window.electronAPI) {
        const result = await window.electronAPI.processText(text, actualMode);
        if (result?.success) return result;
        throw new Error(result?.error || '处理失败');
      }
      throw new Error('Electron API 不可用');
    } catch (e) {
      setError(e.message);
      return { success: false, error: e.message };
    } finally {
      setIsProcessing(false);
    }
  }, [determineMode]);

  return { processText, isProcessing, error };
};
