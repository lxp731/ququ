import { vi } from 'vitest'

/**
 * Creates a mock window.electronAPI with all methods returning
 * vi.fn() for spying. Pass overrides to customize responses.
 *
 * Usage:
 *   const api = mockElectronAPI({ getSetting: vi.fn().mockResolvedValue('custom') })
 *   // ... render hook ...
 *   expect(api.registerHotkey).toHaveBeenCalledWith('Ctrl+Space')
 */
export function mockElectronAPI(overrides = {}) {
  const api = {
    // ── 窗口控制 ──
    hideWindow: vi.fn().mockResolvedValue(true),
    showWindow: vi.fn().mockResolvedValue(true),
    minimizeWindow: vi.fn().mockResolvedValue(true),
    maximizeWindow: vi.fn().mockResolvedValue(true),
    closeWindow: vi.fn().mockResolvedValue(true),

    // ── 录音 ──
    startRecording: vi.fn().mockResolvedValue(true),
    stopRecording: vi.fn().mockResolvedValue(true),
    onToggleDictation: vi.fn().mockReturnValue(() => {}),

    // ── FunASR ──
    transcribeAudio: vi.fn().mockResolvedValue({ success: true, text: '测试识别结果', confidence: 0.95 }),
    checkFunASRStatus: vi.fn().mockResolvedValue({
      success: false, initialized: false, models_initialized: false,
      server_ready: false, is_initializing: false, connecting: false,
    }),
    restartFunasrServer: vi.fn().mockResolvedValue({ success: true }),
    checkModelFiles: vi.fn().mockResolvedValue({ success: false, models_downloaded: false, missing_models: ['asr', 'vad', 'punc'] }),
    getDownloadProgress: vi.fn().mockResolvedValue({ success: true, overall_progress: 0 }),

    // ── AI ──
    processText: vi.fn().mockResolvedValue({ success: true, text: '优化后文本' }),
    checkAIStatus: vi.fn().mockResolvedValue({ available: true, model: 'test-model' }),

    // ── 剪贴板 ──
    pasteText: vi.fn().mockResolvedValue({ success: true }),
    copyText: vi.fn().mockResolvedValue({ success: true }),
    readClipboard: vi.fn().mockResolvedValue(''),
    writeClipboard: vi.fn().mockResolvedValue({ success: true }),

    // ── 数据库 ──
    saveTranscription: vi.fn().mockResolvedValue({}),
    getTranscriptions: vi.fn().mockResolvedValue([]),
    deleteTranscription: vi.fn().mockResolvedValue({}),
    clearAllTranscriptions: vi.fn().mockResolvedValue({}),
    exportTranscriptions: vi.fn().mockResolvedValue({ success: true }),

    // ── 设置 ──
    getSetting: vi.fn().mockResolvedValue(null),
    setSetting: vi.fn().mockResolvedValue({}),
    saveSetting: vi.fn().mockResolvedValue({}),
    getAllSettings: vi.fn().mockResolvedValue({}),
    getSettings: vi.fn().mockResolvedValue({}),
    resetSettings: vi.fn().mockResolvedValue({}),

    // ── 快捷键 ──
    registerHotkey: vi.fn().mockResolvedValue({ success: true }),
    unregisterHotkey: vi.fn().mockResolvedValue({ success: true }),
    getCurrentHotkey: vi.fn().mockResolvedValue('Ctrl+Space'),
    setRecordingState: vi.fn().mockResolvedValue({ success: true }),
    getRecordingState: vi.fn().mockResolvedValue({ success: true, isRecording: false }),
    onHotkeyTriggered: vi.fn().mockReturnValue(() => {}),

    // ── 长按模式 ──
    startHoldWatch: vi.fn().mockResolvedValue({ success: true }),
    stopHoldWatch: vi.fn().mockResolvedValue({ success: true }),
    onHoldKeyDown: vi.fn().mockReturnValue(() => {}),
    onHoldKeyUp: vi.fn().mockReturnValue(() => {}),

    // ── 系统 ──
    getSystemInfo: vi.fn().mockResolvedValue({ platform: 'linux', arch: 'x64', isPackaged: false }),
    checkPermissions: vi.fn().mockResolvedValue({ microphone: true, accessibility: true }),
    testAccessibilityPermission: vi.fn().mockResolvedValue({ success: true }),
    openSystemPermissions: vi.fn().mockResolvedValue({ success: true }),
    getAppVersion: vi.fn().mockResolvedValue('1.0.0'),
    showItemInFolder: vi.fn(),
    openExternal: vi.fn().mockResolvedValue(true),

    // ── 日志 ──
    log: vi.fn().mockResolvedValue(true),
    getDebugInfo: vi.fn().mockResolvedValue({}),

    // ── 模型 & 后端 ──
    downloadModel: vi.fn().mockResolvedValue({ success: true }),
    startLocalBackend: vi.fn().mockResolvedValue({ success: true }),
    getAvailableModels: vi.fn().mockResolvedValue({ models: [] }),
    getCurrentModel: vi.fn().mockResolvedValue({ model: 'paraformer-large', status: 'ready' }),
    switchModel: vi.fn().mockResolvedValue({ success: false }),
    onModelDownloadProgress: vi.fn().mockReturnValue(() => {}),

    // ── 事件 ──
    onTranscriptionUpdate: vi.fn().mockReturnValue(() => {}),
    onProcessingUpdate: vi.fn().mockReturnValue(() => {}),
    onError: vi.fn().mockReturnValue(() => {}),
    onSettingsUpdate: vi.fn().mockReturnValue(() => {}),

    // ── 其他窗口 ──
    openControlPanel: vi.fn(),
    closeControlPanel: vi.fn(),
    openHistoryWindow: vi.fn(),
    closeHistoryWindow: vi.fn(),
    hideHistoryWindow: vi.fn(),
    openSettingsWindow: vi.fn(),
    closeSettingsWindow: vi.fn(),
    hideSettingsWindow: vi.fn(),

    // ── 中文 ──
    detectLanguage: vi.fn().mockResolvedValue({ language: 'zh-CN', confidence: 0.95 }),
    segmentChinese: vi.fn().mockResolvedValue({ segments: [] }),
    addPunctuation: vi.fn().mockResolvedValue({ text: '' }),

    // ── 音频 ──
    convertAudioFormat: vi.fn().mockResolvedValue({ success: true }),
    enhanceAudio: vi.fn().mockResolvedValue({ success: true }),

    // ── 性能 ──
    getPerformanceStats: vi.fn().mockResolvedValue({}),
    clearPerformanceStats: vi.fn().mockResolvedValue({ success: true }),

    ...overrides,
  }

  window.electronAPI = api
  return api
}

/**
 * Set the page URL for tests that check window.location.search.
 * Uses history.pushState which is supported in jsdom.
 */
export function setPageSearch(search) {
  window.history.pushState({}, '', `/${search}`)
}
