import { useState, useEffect, useCallback } from 'react';

const isOtherPage = () => {
  const p = new URLSearchParams(window.location.search);
  return p.get('panel') === 'control' || p.get('page') === 'settings';
};

export const useModelStatus = () => {
  const [status, setStatus] = useState({
    isLoading: true, isReady: false, modelsDownloaded: false,
    downloadProgress: 0, missingModels: [], error: null,
    stage: 'checking', noApi: false, connecting: false,
  });

  const checkStatus = useCallback(async () => {
    if (!window.electronAPI) {
      setStatus(prev => ({ ...prev, isLoading: false, noApi: true, stage: 'no_api', error: 'Electron API 不可用' }));
      return;
    }
    try {
      const s = await window.electronAPI.checkFunASRStatus();
      const serverReady = s?.server_ready || false;
      const isConnecting = s?.connecting || false;

      // 后端未连接
      if (!serverReady && !isConnecting) {
        setStatus(prev => ({
          ...prev, isLoading: false, isReady: false,
          modelsDownloaded: false, stage: 'need_backend',
          connecting: false, noApi: false,
        }));
        return;
      }

      // 正在连接中
      if (!serverReady && isConnecting) {
        setStatus(prev => ({
          ...prev, isLoading: true, isReady: false,
          stage: 'connecting', connecting: true, noApi: false,
        }));
        return;
      }

      // 后端已连接，检查返回数据
      if (!s?.success) {
        const files = await window.electronAPI.checkModelFiles().catch(() => ({}));
        setStatus(prev => ({
          ...prev, isLoading: false, isReady: false,
          modelsDownloaded: files?.models_downloaded || false,
          missingModels: files?.missing_models || [],
          stage: files?.models_downloaded ? 'loading' : 'need_download',
          connecting: false, noApi: false,
        }));
        return;
      }
      if (s.models_initialized) {
        setStatus(prev => ({ ...prev, isLoading: false, isReady: true, modelsDownloaded: true, downloadProgress: 100, stage: 'ready', connecting: false, noApi: false }));
      } else if (s.is_initializing) {
        setStatus(prev => ({ ...prev, isLoading: true, isReady: false, modelsDownloaded: true, stage: 'loading', connecting: false, noApi: false }));
      } else {
        setStatus(prev => ({ ...prev, isLoading: false, isReady: false, stage: 'error', error: s.error || '未就绪', connecting: false, noApi: false }));
      }
    } catch (e) {
      setStatus(prev => ({ ...prev, isLoading: false, isReady: false, stage: 'error', error: e.message, connecting: false, noApi: false }));
    }
  }, []);

  useEffect(() => {
    if (isOtherPage()) return;
    checkStatus();
  }, [checkStatus]);

  // Poll until ready
  useEffect(() => {
    if (isOtherPage() || status.isReady || status.stage === 'downloading' || status.noApi) return;
    const id = setInterval(checkStatus, 5000);
    return () => clearInterval(id);
  }, [status.isReady, status.stage, status.noApi, checkStatus]);

  const startLocalBackend = useCallback(async () => {
    if (!window.electronAPI) return;
    setStatus(prev => ({ ...prev, stage: 'connecting', connecting: true }));
    await window.electronAPI.startLocalBackend();
    checkStatus();
  }, [checkStatus]);

  return { ...status, checkStatus, startLocalBackend };
};
