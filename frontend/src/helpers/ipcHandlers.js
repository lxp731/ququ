const { ipcMain, app, shell, BrowserWindow, dialog } = require('electron');
const fs = require('fs');

// ── 安全常量 ──
// 允许渲染进程写入的设置键白名单
const ALLOWED_SETTING_KEYS = new Set([
  'ai_api_key', 'ai_base_url', 'ai_model', 'enable_ai_optimization',
  'hotwords', 'hotword_path', 'hotwords_count', 'funasr_base_url',
  'global_hotkey', 'recording_mode',
]);
// openExternal 协议白名单
const ALLOWED_EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);
// 音频上传大小上限 (50MB)
const MAX_AUDIO_BYTES = 50 * 1024 * 1024;
// 日志 level 白名单
const LOG_LEVELS = new Set(['debug', 'info', 'warn', 'error']);

// 本应用可信来源 (打包 file:// 或 dev localhost)
function isTrustedSender(event) {
  try {
    const url = event.senderFrame?.url || '';
    if (!url) return false;
    if (url.startsWith('file://')) return true;
    if (url.startsWith('http://localhost:') || url.startsWith('http://127.0.0.1:')) return true;
    return false;
  } catch (_) { return false; }
}

class IPCHandlers {
  constructor({ databaseManager, clipboardManager, funasrManager, windowManager, hotkeyManager, keyWatcher, logger }) {
    this.db = databaseManager;
    this.clip = clipboardManager;
    this.funasr = funasrManager;
    this.wm = windowManager;
    this.hotkey = hotkeyManager;
    this.keyWatcher = keyWatcher;
    this.log = logger;
    this._setup();
  }

  _setup() {
    // ── 窗口控制 ──
    ipcMain.handle('hide-window', (e) => { if (!isTrustedSender(e)) return false; this.wm.mainWindow?.hide(); return true; });
    ipcMain.handle('show-window', (e) => { if (!isTrustedSender(e)) return false; this.wm.mainWindow?.show(); return true; });
    ipcMain.handle('minimize-window', (e) => { if (!isTrustedSender(e)) return false; this.wm.mainWindow?.minimize(); return true; });
    ipcMain.handle('maximize-window', (e) => {
      if (!isTrustedSender(e)) return false;
      const w = this.wm.mainWindow;
      if (w) w.isMaximized() ? w.unmaximize() : w.maximize();
      return true;
    });
    ipcMain.handle('close-window', (e) => { if (!isTrustedSender(e)) return false; this.wm.mainWindow?.hide(); return true; });
    ipcMain.handle('open-control-panel', (e) => { if (!isTrustedSender(e)) return false; this.wm.showControlPanel(); return true; });
    ipcMain.handle('close-control-panel', (e) => { if (!isTrustedSender(e)) return false; this.wm.hideControlPanel(); return true; });
    ipcMain.handle('open-history-window', (e) => { if (!isTrustedSender(e)) return false; this.wm.showHistoryWindow(); return true; });
    ipcMain.handle('close-history-window', (e) => { if (!isTrustedSender(e)) return false; this.wm.closeHistoryWindow(); return true; });
    ipcMain.handle('hide-history-window', (e) => { if (!isTrustedSender(e)) return false; this.wm.hideHistoryWindow(); return true; });
    ipcMain.handle('open-settings-window', (e) => { if (!isTrustedSender(e)) return false; this.wm.showSettingsWindow(); return true; });
    ipcMain.handle('close-settings-window', (e) => { if (!isTrustedSender(e)) return false; this.wm.closeSettingsWindow(); return true; });
    ipcMain.handle('hide-settings-window', (e) => { if (!isTrustedSender(e)) return false; this.wm.hideSettingsWindow(); return true; });

    // ── 浮动三区预览窗 ──
    ipcMain.handle('show-floating-window', async (e) => { if (!isTrustedSender(e)) return false; await this.wm.showFloatingWindow(); return true; });
    ipcMain.handle('hide-floating-window', (e) => { if (!isTrustedSender(e)) return false; this.wm.hideFloatingWindow(); return true; });
    ipcMain.handle('update-floating-preedit', (e, data) => {
      if (!isTrustedSender(e) || typeof data !== 'object' || data === null) return false;
      this.wm.updateFloatingPreedit({
        green: String(data.green || '').slice(0, 5000),
        yellow: String(data.yellow || '').slice(0, 5000),
        red: String(data.red || '').slice(0, 5000),
      });
      return true;
    });
    ipcMain.handle('move-floating-window', (e, dx, dy) => {
      if (!isTrustedSender(e)) return false;
      if (Number.isFinite(dx) && Number.isFinite(dy)) this.wm.moveFloatingWindow(dx, dy);
      return true;
    });

    // ── FunASR ──
    ipcMain.handle('check-funasr-status', async (e) => {
      if (!isTrustedSender(e)) return { success: false };
      const s = await this.funasr.checkStatus();
      return { ...s, models_initialized: this.funasr.modelsInitialized, server_ready: this.funasr.serverReady, is_initializing: !!this.funasr.initializationPromise, connecting: s.connecting };
    });
    ipcMain.handle('transcribe-audio', async (e, audioData, options) => {
      if (!isTrustedSender(e)) return { success: false, error: '未授权调用' };
      // 大小上限: 防止渲染层打爆主进程内存
      const size = _audioDataSize(audioData);
      if (size > MAX_AUDIO_BYTES) {
        return { success: false, error: `音频过大 (最大 ${MAX_AUDIO_BYTES / (1024 * 1024)}MB)` };
      }
      return this.funasr.transcribeAudio(audioData, _sanitizeOptions(options));
    });
    ipcMain.handle('check-model-files', (e) => { if (!isTrustedSender(e)) return { success: false }; return this.funasr.checkModelFiles(); });
    ipcMain.handle('get-download-progress', (e) => { if (!isTrustedSender(e)) return { success: false }; return this.funasr.getDownloadProgress(); });
    ipcMain.handle('restart-funasr-server', (e) => { if (!isTrustedSender(e)) return { success: false }; return this.funasr.restartServer(); });
    // 按名下载模型 → 触发后端模型下载/补全
    ipcMain.handle('download-model', (e, name) => {
      if (!isTrustedSender(e)) return { success: false, error: '未授权调用' };
      return this.funasr.downloadModel(typeof name === 'string' ? name : '');
    });
    ipcMain.handle('start-local-backend', (e) => { if (!isTrustedSender(e)) return { success: false }; return this.funasr.startLocalBackend(); });
    ipcMain.handle('notify-settings-update', (e, data) => {
      if (!isTrustedSender(e)) return false;
      if (this.wm.settingsWindow && !this.wm.settingsWindow.isDestroyed()) {
        this.wm.settingsWindow.webContents.send('settings-update', data);
      }
      return true;
    });

    // ── 热词文件选择 ──
    ipcMain.handle('select-hotword-file', async (e) => {
      if (!isTrustedSender(e)) return { canceled: true };
      const result = await dialog.showOpenDialog({
        title: '选择热词文件',
        filters: [{ name: '文本文件', extensions: ['txt'] }],
        properties: ['openFile'],
      });
      if (result.canceled || !result.filePaths.length) return { canceled: true };
      try {
        const p = result.filePaths[0];
        const st = fs.statSync(p);
        if (st.size > 5 * 1024 * 1024) return { error: '热词文件过大 (最大 5MB)' };
        const content = fs.readFileSync(p, 'utf-8');
        const words = content.split('\n').map(w => w.trim()).filter(Boolean);
        return { path: p, words, count: words.length };
      } catch (err) {
        return { error: err.message };
      }
    });

    // ── AI 文本处理 ──
    ipcMain.handle('process-text', (e, text, mode = 'optimize') => {
      if (!isTrustedSender(e)) return { success: false, error: '未授权调用' };
      return this._processWithAI(String(text || '').slice(0, 20000), String(mode || 'optimize'));
    });
    ipcMain.handle('check-ai-status', (e, testConfig) => {
      if (!isTrustedSender(e)) return { available: false };
      return this._checkAIStatus(testConfig);
    });
    // 模型列表拉取移入主进程, 渲染层不再直连携带 Bearer key
    ipcMain.handle('get-ai-models', async (e, { baseUrl, apiKey } = {}) => {
      if (!isTrustedSender(e)) return { success: false, error: '未授权调用' };
      return this._fetchAIModels(baseUrl, apiKey);
    });

    // ── 数据库 ──
    ipcMain.handle('save-transcription', (e, data) => {
      if (!isTrustedSender(e)) return { success: false };
      return this.db.saveTranscription(data || {});
    });
    ipcMain.handle('get-transcriptions', (e, limit, offset) => {
      if (!isTrustedSender(e)) return [];
      return this.db.getTranscriptions(limit, offset);
    });
    ipcMain.handle('delete-transcription', (e, id) => { if (!isTrustedSender(e)) return { success: false }; return this.db.deleteTranscription(id); });
    ipcMain.handle('clear-all-transcriptions', (e) => { if (!isTrustedSender(e)) return { success: false }; return this.db.clearAllTranscriptions(); });
    ipcMain.handle('search-transcriptions', (e, query, limit) => { if (!isTrustedSender(e)) return []; return this.db.searchTranscriptions(query, limit); });
    ipcMain.handle('export-transcriptions', async (e, format = 'txt') => {
      if (!isTrustedSender(e)) return { success: false, error: '未授权调用' };
      return this._exportTranscriptions(String(format));
    });

    // ── 设置 ──
    ipcMain.handle('get-setting', (e, key, def) => {
      if (!isTrustedSender(e)) return def;
      return this.db.getSetting(String(key || ''), def);
    });
    ipcMain.handle('set-setting', (e, key, value) => {
      if (!isTrustedSender(e)) return false;
      const k = String(key || '');
      if (!ALLOWED_SETTING_KEYS.has(k)) return false;
      this.db.setSetting(k, value);
      if (k === 'funasr_base_url') this.funasr?.setBaseUrl?.(value);
      return true;
    });
    ipcMain.handle('save-setting', (e, key, value) => {
      if (!isTrustedSender(e)) return false;
      const k = String(key || '');
      if (!ALLOWED_SETTING_KEYS.has(k)) return false;
      this.db.setSetting(k, value);
      if (k === 'funasr_base_url' && value) this.funasr?.connect?.(value);
      return true;
    });
    // 渲染进程展示用: 敏感键脱敏
    ipcMain.handle('get-all-settings', (e) => { if (!isTrustedSender(e)) return {}; return this.db.getSettingsMasked(); });
    ipcMain.handle('get-settings', (e) => { if (!isTrustedSender(e)) return {}; return this.db.getSettingsMasked(); });
    ipcMain.handle('reset-settings', (e) => { if (!isTrustedSender(e)) return false; return this.db.resetSettings(); });

    // ── 剪贴板 ──
    ipcMain.handle('copy-text', async (e, text) => { if (!isTrustedSender(e)) return { success: false }; try { return await this.clip.copyText(String(text ?? '')); } catch (err) { return { success: false, error: err.message }; } });
    ipcMain.handle('paste-text', async (e, text) => { if (!isTrustedSender(e)) return { success: false }; try { return await this.clip.pasteText(String(text ?? '')); } catch (err) { return { success: false, error: err.message }; } });
    ipcMain.handle('read-clipboard', (e) => { if (!isTrustedSender(e)) return ''; return this.clip.readClipboard(); });
    ipcMain.handle('write-clipboard', async (e, text) => { if (!isTrustedSender(e)) return { success: false }; try { return await this.clip.writeClipboard(String(text ?? '')); } catch (err) { return { success: false, error: err.message }; } });

    // ── 快捷键 ──
    ipcMain.handle('register-hotkey', (event, hotkey) => {
      if (!isTrustedSender(event)) return { success: false, error: '未授权调用' };
      try {
        const ok = this.hotkey.registerHotkey(hotkey, () => {
          if (this.wm.mainWindow && !this.wm.mainWindow.isDestroyed()) {
            this.wm.mainWindow.webContents.send('hotkey-triggered', { hotkey });
          }
        });
        return { success: ok };
      } catch (err) { return { success: false, error: err.message }; }
    });
    ipcMain.handle('unregister-hotkey', (event, hotkey) => {
      if (!isTrustedSender(event)) return { success: false };
      try {
        return { success: this.hotkey.unregisterHotkey(hotkey) };
      } catch (err) { return { success: false, error: err.message }; }
    });
    ipcMain.handle('get-current-hotkey', () => {
      const keys = this.hotkey.getRegisteredHotkeys();
      return keys[0] || 'Ctrl+Space';
    });
    ipcMain.handle('set-recording-state', (e, v) => { if (!isTrustedSender(e)) return { success: false }; this.hotkey.setRecordingState(v); return { success: true }; });
    ipcMain.handle('get-recording-state', (e) => { if (!isTrustedSender(e)) return { success: false }; return { success: true, isRecording: this.hotkey.getRecordingState() }; });

    // ── 长按模式：全局键盘监听 keydown+keyup（替代 globalShortcut）──
    // Linux: evdev   Windows: GetAsyncKeyState   macOS: 不支持
    ipcMain.handle('start-hold-watch', (event, hotkey) => {
      if (!isTrustedSender(event)) return { success: false, error: '未授权调用' };
      if (!this.keyWatcher) return { success: false, error: 'KeyWatcher 不可用' };
      if (process.platform === 'darwin') return { success: false, error: 'macOS 暂不支持长按模式' };
      const win = this.wm.mainWindow;
      if (!win) return { success: false };

      // 注销全局快捷键，交给 KeyWatcher 接管
      this.hotkey.unregisterAll();

      this.keyWatcher.start((type, keyName) => {
        this.log?.info?.(`[Hold] 全局 ${type}: ${keyName}`);
        const wc = this.wm.mainWindow?.webContents;
        if (!wc || wc.isDestroyed()) return;
        if (type === 'down') {
          wc.send('hold-key-down', { key: keyName });
        } else if (type === 'up') {
          wc.send('hold-key-up', { key: keyName });
        }
      }, hotkey || 'Ctrl+Space');
      return { success: true };
    });
    ipcMain.handle('stop-hold-watch', (event) => {
      if (!isTrustedSender(event)) return { success: false };
      this.keyWatcher?.stop();
      // 恢复用户自定义的快捷键（从数据库读取，不硬编码）
      if (this.wm.mainWindow && !this.wm.mainWindow.isDestroyed()) {
        const savedKey = this.db.getSetting('global_hotkey', 'Ctrl+Space') || 'Ctrl+Space';
        this.hotkey.registerHotkey(savedKey, () => {
          this.wm.mainWindow.webContents.send('hotkey-triggered', { hotkey: savedKey });
        });
      }
      return { success: true };
    });

    // ── 系统 ──
    ipcMain.handle('get-system-info', (e) => {
      if (!isTrustedSender(e)) return {};
      return { platform: process.platform, arch: process.arch, nodeVersion: process.version, electronVersion: process.versions.electron, isPackaged: app.isPackaged };
    });
    ipcMain.handle('get-app-version', (e) => { if (!isTrustedSender(e)) return ''; return app.getVersion(); });
    ipcMain.handle('check-permissions', async (e) => {
      if (!isTrustedSender(e)) return { microphone: false, accessibility: false };
      const a11y = await this.clip.checkAccessibilityPermissions().catch(() => false);
      return { microphone: true, accessibility: a11y };
    });
    ipcMain.handle('test-accessibility-permission', async (e) => {
      if (!isTrustedSender(e)) return { success: false };
      try { await this.clip.pasteText('蛐蛐权限测试'); return { success: true }; } catch (err) { return { success: false, error: err.message }; }
    });
    ipcMain.handle('open-system-permissions', (e) => { if (!isTrustedSender(e)) return { success: false }; this.clip.openSystemSettings(); return { success: true }; });
    ipcMain.handle('show-item-in-folder', (e, p) => {
      if (!isTrustedSender(e) || typeof p !== 'string' || !p) return;
      shell.showItemInFolder(p);
    });
    ipcMain.handle('open-external', async (e, url) => {
      if (!isTrustedSender(e)) return { success: false, error: '未授权调用' };
      // 协议白名单: 防止 file:// / 自定义协议被渲染层触发
      try {
        const parsed = new URL(String(url));
        if (!ALLOWED_EXTERNAL_PROTOCOLS.has(parsed.protocol)) {
          return { success: false, error: `不允许打开该协议: ${parsed.protocol}` };
        }
        await shell.openExternal(parsed.toString());
        return { success: true };
      } catch (err) {
        return { success: false, error: err.message };
      }
    });

    // ── 日志 ──
    ipcMain.handle('log', (e, level, message, data) => {
      if (!isTrustedSender(e)) return false;
      const lv = String(level || '');
      if (LOG_LEVELS.has(lv)) this.log?.[lv]?.(`[Renderer] ${message}`, data);
      return true;
    });
    ipcMain.handle('get-debug-info', (e) => {
      if (!isTrustedSender(e)) return {};
      return { platform: process.platform, arch: process.arch, nodeVersion: process.version, electronVersion: process.versions.electron, appVersion: app.getVersion() };
    });

    // ── 可用模型列表 ──
    ipcMain.handle('get-available-models', (e) => {
      if (!isTrustedSender(e)) return { models: [] };
      return {
        models: [
          { name: 'paraformer-large', displayName: 'Paraformer Large (ASR)', type: 'asr', size: '840MB', description: '大型中文语音识别模型' },
          { name: 'fsmn-vad', displayName: 'FSMN VAD', type: 'vad', size: '1.6MB', description: '语音活动检测模型' },
          { name: 'ct-transformer-punc', displayName: 'CT Transformer (标点)', type: 'punc', size: '278MB', description: '标点符号恢复模型' },
        ],
      };
    });
    ipcMain.handle('get-current-model', async (e) => {
      if (!isTrustedSender(e)) return { model: '', status: 'unknown' };
      const s = await this.funasr.checkStatus();
      return { model: 'paraformer-large', status: s.models_downloaded ? 'ready' : 'not_downloaded', details: s };
    });
    ipcMain.handle('switch-model', () => ({ success: false, error: 'FunASR使用固定模型组合，暂不支持切换' }));
    ipcMain.handle('get-performance-stats', () => ({}));
    ipcMain.handle('clear-performance-stats', () => ({ success: true }));

    // ── 开发工具 ──
    if (process.env.NODE_ENV === 'development') {
      ipcMain.handle('open-dev-tools', (event) => {
        if (!isTrustedSender(event)) return;
        BrowserWindow.fromWebContents(event.sender)?.webContents.openDevTools();
      });
      ipcMain.handle('reload-window', (event) => {
        if (!isTrustedSender(event)) return;
        BrowserWindow.fromWebContents(event.sender)?.reload();
      });
    }
  }

  // ── AI 文本处理 (内部实现) ──
  async _processWithAI(text, mode = 'optimize') {
    try {
      const apiKey = await this.db.getSetting('ai_api_key');
      if (!apiKey) return { success: false, error: '请先在设置页面配置AI API密钥' };
      const baseUrl = await this.db.getSetting('ai_base_url') || 'https://api.openai.com/v1';
      if (!isHttpUrl(baseUrl)) return { success: false, error: '仅支持 http/https 地址' };
      const model = await this.db.getSetting('ai_model') || 'gpt-3.5-turbo';

      const prompts = {
        format: `请将以下语音识别文本进行格式化，添加适当的段落分隔和标点符号：\n\n${text}`,
        correct: `请纠正以下文本中的语法错误、错别字和语音识别错误，保持原意不变：\n\n${text}`,
        optimize: `你是专业的语音转录文本优化助手。请对ASR识别文本进行最小化润色：

**执行规则:**
1. 纠正明显的同音错字和标点误用
2. 移除无意义填充词：呃、嗯、那个、就是说、然后那个
3. 合并无意义重复："我我我觉得"→"我觉得"
4. 整合自我修正："周三，呃不对，周四"→"周四"

**严格禁止:**
- 禁止将口语替换为书面语（保留"蛮不错"、"录个影"等）
- 禁止改变句式结构
- 禁止删除语气词（啊、呀、呢、吧、嘛）
- 禁止添加原文没有的信息

原始文本：
\`\`\`
${text}
\`\`\`

直接返回优化后的文本，不要任何解释。`,
        optimize_long: `你是专业的长文本整理助手。请清理语音转录长段内容：

**任务:**
1. 去除思考过程中的冗余表达（"然后"、"就是说"、"其实"、"怎么说呢"等）
2. 处理话题跳转表达
3. 清理同一观点的重复表述
4. 保留自我纠正后的最终表达

**分段规则:**
- 在话题转换、观点变化处进行自然分段
- 每段保持逻辑完整性
- 不添加原文没有的信息

原始文本：
\`\`\`
${text}
\`\`\`

直接返回整理后的文本。`,
        summarize: `请总结以下文本的主要内容，提取关键信息：\n\n${text}`,
      };

      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: prompts[mode] || prompts.optimize }], temperature: 0.3, max_tokens: 2000, stream: false }),
        signal: AbortSignal.timeout(60000),
      });
      if (!res.ok) { const errBody = await res.text(); throw new Error(`API error ${res.status}: ${errBody}`); }
      const data = await res.json();
      return data.choices?.[0]?.message?.content
        ? { success: true, text: data.choices[0].message.content.trim(), usage: data.usage, model }
        : { success: false, error: 'AI返回数据格式错误' };
    } catch (err) {
      return { success: false, error: err.message || '文本处理失败' };
    }
  }

  async _checkAIStatus(testConfig = null) {
    try {
      const apiKey = testConfig?.ai_api_key || await this.db.getSetting('ai_api_key');
      if (!apiKey) return { available: false, error: '未配置API密钥' };
      const baseUrl = testConfig?.ai_base_url || await this.db.getSetting('ai_base_url') || 'https://api.openai.com/v1';
      if (!isHttpUrl(baseUrl)) return { available: false, error: '仅支持 http/https 地址' };
      const model = testConfig?.ai_model || await this.db.getSetting('ai_model') || 'gpt-3.5-turbo';

      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: '请回复"测试成功"' }], max_tokens: 50, temperature: 0.1 }),
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) { const errBody = await res.text(); throw new Error(`HTTP ${res.status}: ${errBody}`); }
      const data = await res.json();
      return data.choices?.[0]
        ? { available: true, model, status: 'connected', response: data.choices[0].message?.content, usage: data.usage, details: `成功连接到 ${model}` }
        : { available: false, error: '返回数据格式异常' };
    } catch (err) {
      return { available: false, error: err.message };
    }
  }

  // 模型列表拉取 (主进程代理, 渲染层不直接持有 key 发请求)
  async _fetchAIModels(baseUrl, apiKey) {
    const url = String(baseUrl || '').trim();
    const key = String(apiKey || '');
    if (!url || !key) return { success: false, error: '缺少 Base URL 或 API Key' };
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) return { success: false, error: '仅支持 http/https' };
      const res = await fetch(`${url.replace(/\/+$/, '')}/models`, {
        headers: { 'Authorization': `Bearer ${key}` },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const ids = (data.data || []).map(m => m.id).filter(Boolean).sort();
      return { success: true, models: ids };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  async _exportTranscriptions(format) {
    try {
      const items = this.db.getTranscriptions(9999, 0);
      const ext = format === 'json' ? 'json' : 'txt';
      let content;
      if (format === 'json') {
        content = JSON.stringify(items, null, 2);
      } else {
        content = items.map(i => `[${i.created_at}]\n${i.text}\n---\n`).join('\n');
      }
      const { filePath } = await dialog.showSaveDialog({
        defaultPath: `ququ_export_${Date.now()}.${ext}`,
        filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
      });
      if (!filePath) return { success: false, canceled: true };
      await fs.promises.writeFile(filePath, content, 'utf-8');
      return { success: true, path: filePath };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }
}

function _audioDataSize(audioData) {
  if (audioData instanceof ArrayBuffer) return audioData.byteLength;
  if (ArrayBuffer.isView(audioData)) return audioData.byteLength;
  if (typeof audioData === 'string') return audioData.length; // base64 近似
  if (audioData && audioData.buffer) return audioData.buffer.byteLength || 0;
  return 0;
}

function isHttpUrl(url) {
  try {
    const parsed = new URL(String(url));
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch (_) { return false; }
}

function _sanitizeOptions(options) {
  if (typeof options !== 'object' || options === null) return {};
  const out = {};
  for (const k of ['language', 'hotwords', 'use_itn']) {
    if (Object.prototype.hasOwnProperty.call(options, k)) out[k] = options[k];
  }
  return out;
}

module.exports = IPCHandlers;
