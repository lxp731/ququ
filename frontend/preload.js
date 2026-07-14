const { contextBridge, ipcRenderer } = require('electron');

// 安全的 listener 包装: 确保 on/removeListener 使用同一个函数引用
const on = (channel, cb) => {
  const handler = (_event, data) => cb(data);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('electronAPI', {
  // 窗口控制
  hideWindow: () => ipcRenderer.invoke('hide-window'),
  showWindow: () => ipcRenderer.invoke('show-window'),
  minimizeWindow: () => ipcRenderer.invoke('minimize-window'),
  maximizeWindow: () => ipcRenderer.invoke('maximize-window'),
  closeWindow: () => ipcRenderer.invoke('close-window'),

  // 录音
  startRecording: () => ipcRenderer.invoke('start-recording'),
  stopRecording: () => ipcRenderer.invoke('stop-recording'),
  onToggleDictation: (cb) => on('toggle-dictation', cb),

  // FunASR
  transcribeAudio: (data) => ipcRenderer.invoke('transcribe-audio', data),
  checkFunASRStatus: () => ipcRenderer.invoke('check-funasr-status'),
  restartFunasrServer: () => ipcRenderer.invoke('restart-funasr-server'),
  checkModelFiles: () => ipcRenderer.invoke('check-model-files'),
  getDownloadProgress: () => ipcRenderer.invoke('get-download-progress'),

  // AI
  processText: (text, mode) => ipcRenderer.invoke('process-text', text, mode),
  checkAIStatus: (config) => ipcRenderer.invoke('check-ai-status', config),

  // 剪贴板
  pasteText: (text) => ipcRenderer.invoke('paste-text', text),
  copyText: (text) => ipcRenderer.invoke('copy-text', text),
  readClipboard: () => ipcRenderer.invoke('read-clipboard'),
  writeClipboard: (text) => ipcRenderer.invoke('write-clipboard', text),

  // 数据库
  saveTranscription: (data) => ipcRenderer.invoke('save-transcription', data),
  getTranscriptions: (limit, offset) => ipcRenderer.invoke('get-transcriptions', limit, offset),
  deleteTranscription: (id) => ipcRenderer.invoke('delete-transcription', id),
  clearAllTranscriptions: () => ipcRenderer.invoke('clear-all-transcriptions'),
  exportTranscriptions: (format) => ipcRenderer.invoke('export-transcriptions', format),

  // 设置
  getSetting: (key, def) => ipcRenderer.invoke('get-setting', key, def),
  setSetting: (key, value) => ipcRenderer.invoke('set-setting', key, value),
  saveSetting: (key, value) => ipcRenderer.invoke('save-setting', key, value),
  getAllSettings: () => ipcRenderer.invoke('get-all-settings'),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  resetSettings: () => ipcRenderer.invoke('reset-settings'),

  // 快捷键
  registerHotkey: (hotkey) => ipcRenderer.invoke('register-hotkey', hotkey),
  unregisterHotkey: (hotkey) => ipcRenderer.invoke('unregister-hotkey', hotkey),
  getCurrentHotkey: () => ipcRenderer.invoke('get-current-hotkey'),
  setRecordingState: (v) => ipcRenderer.invoke('set-recording-state', v),
  getRecordingState: () => ipcRenderer.invoke('get-recording-state'),
  onHotkeyTriggered: (cb) => on('hotkey-triggered', cb),

  // 长按模式 evdev 全局监听
  startHoldWatch: () => ipcRenderer.invoke('start-hold-watch'),
  stopHoldWatch: () => ipcRenderer.invoke('stop-hold-watch'),
  onHoldKeyDown: (cb) => on('hold-key-down', cb),
  onHoldKeyUp: (cb) => on('hold-key-up', cb),

  // 系统
  getSystemInfo: () => ipcRenderer.invoke('get-system-info'),
  checkPermissions: () => ipcRenderer.invoke('check-permissions'),
  testAccessibilityPermission: () => ipcRenderer.invoke('test-accessibility-permission'),
  openSystemPermissions: () => ipcRenderer.invoke('open-system-permissions'),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  showItemInFolder: (p) => ipcRenderer.invoke('show-item-in-folder', p),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),

  // 日志
  log: (level, msg) => ipcRenderer.invoke('log', level, msg),
  getDebugInfo: () => ipcRenderer.invoke('get-debug-info'),

  // 模型
  downloadModel: (name) => ipcRenderer.invoke('download-model', name),
  getAvailableModels: () => ipcRenderer.invoke('get-available-models'),
  getCurrentModel: () => ipcRenderer.invoke('get-current-model'),
  switchModel: (name) => ipcRenderer.invoke('switch-model', name),
  onModelDownloadProgress: (cb) => on('model-download-progress', cb),

  // 事件
  onTranscriptionUpdate: (cb) => on('transcription-update', cb),
  onProcessingUpdate: (cb) => on('processing-update', cb),
  onError: (cb) => on('error', cb),
  onSettingsUpdate: (cb) => on('settings-update', cb),

  // 其他窗口
  openControlPanel: () => ipcRenderer.invoke('open-control-panel'),
  closeControlPanel: () => ipcRenderer.invoke('close-control-panel'),
  openHistoryWindow: () => ipcRenderer.invoke('open-history-window'),
  closeHistoryWindow: () => ipcRenderer.invoke('close-history-window'),
  hideHistoryWindow: () => ipcRenderer.invoke('hide-history-window'),
  openSettingsWindow: () => ipcRenderer.invoke('open-settings-window'),
  closeSettingsWindow: () => ipcRenderer.invoke('close-settings-window'),
  hideSettingsWindow: () => ipcRenderer.invoke('hide-settings-window'),

  // 中文
  detectLanguage: (t) => ipcRenderer.invoke('detect-language', t),
  segmentChinese: (t) => ipcRenderer.invoke('segment-chinese', t),
  addPunctuation: (t) => ipcRenderer.invoke('add-punctuation', t),

  // 音频
  convertAudioFormat: (d, f) => ipcRenderer.invoke('convert-audio-format', d, f),
  enhanceAudio: (d) => ipcRenderer.invoke('enhance-audio', d),

  // 性能
  getPerformanceStats: () => ipcRenderer.invoke('get-performance-stats'),
  clearPerformanceStats: () => ipcRenderer.invoke('clear-performance-stats'),
});

// 常量
contextBridge.exposeInMainWorld('constants', {
  APP_NAME: '蛐蛐 (QuQu)',
  VERSION: '1.0.0',
  SUPPORTED_AUDIO_FORMATS: ['wav', 'mp3', 'm4a', 'flac'],
  SUPPORTED_EXPORT_FORMATS: ['txt', 'docx', 'pdf', 'json'],
  DEFAULT_HOTKEY: 'Ctrl+Space',
  MAX_RECORDING_DURATION: 300000,
  MAX_TEXT_LENGTH: 10000,
});

// 开发模式调试
if (process.env.NODE_ENV === 'development') {
  contextBridge.exposeInMainWorld('debug', {
    getElectronVersion: () => process.versions.electron,
    getNodeVersion: () => process.versions.node,
    getChromeVersion: () => process.versions.chrome,
    getPlatform: () => process.platform,
    getArch: () => process.arch,
  });
}
