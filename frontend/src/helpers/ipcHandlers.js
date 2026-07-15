const { ipcMain, app, shell, BrowserWindow } = require('electron');

class IPCHandlers {
  constructor({ databaseManager, clipboardManager, funasrManager, windowManager, hotkeyManager, keyWatcher, logger }) {
    this.db = databaseManager;
    this.clip = clipboardManager;
    this.funasr = funasrManager;
    this.wm = windowManager;
    this.hotkey = hotkeyManager;
    this.keyWatcher = keyWatcher;
    this.log = logger;
    this._registeredSenders = new Set();
    this._setup();
  }

  _setup() {
    // ── 窗口控制 ──
    ipcMain.handle('hide-window', () => { this.wm.mainWindow?.hide(); return true; });
    ipcMain.handle('show-window', () => { this.wm.mainWindow?.show(); return true; });
    ipcMain.handle('minimize-window', () => { this.wm.mainWindow?.minimize(); return true; });
    ipcMain.handle('maximize-window', () => {
      const w = this.wm.mainWindow;
      if (w) w.isMaximized() ? w.unmaximize() : w.maximize();
      return true;
    });
    ipcMain.handle('close-window', () => { this.wm.mainWindow?.hide(); return true; });
    ipcMain.handle('open-control-panel', () => { this.wm.showControlPanel(); return true; });
    ipcMain.handle('close-control-panel', () => { this.wm.hideControlPanel(); return true; });
    ipcMain.handle('open-history-window', () => { this.wm.showHistoryWindow(); return true; });
    ipcMain.handle('close-history-window', () => { this.wm.closeHistoryWindow(); return true; });
    ipcMain.handle('hide-history-window', () => { this.wm.hideHistoryWindow(); return true; });
    ipcMain.handle('open-settings-window', () => { this.wm.showSettingsWindow(); return true; });
    ipcMain.handle('close-settings-window', () => { this.wm.closeSettingsWindow(); return true; });
    ipcMain.handle('hide-settings-window', () => { this.wm.hideSettingsWindow(); return true; });

    // ── 录音 ──
    ipcMain.handle('start-recording', () => ({ success: true }));
    ipcMain.handle('stop-recording', () => ({ success: true }));

    // ── FunASR ──
    ipcMain.handle('check-funasr-status', async () => {
      const s = await this.funasr.checkStatus();
      return { ...s, models_initialized: this.funasr.modelsInitialized, server_ready: this.funasr.serverReady, is_initializing: !!this.funasr.initializationPromise, connecting: s.connecting };
    });
    ipcMain.handle('transcribe-audio', async (_, audioData, options) => this.funasr.transcribeAudio(audioData, options));
    ipcMain.handle('check-model-files', () => this.funasr.checkModelFiles());
    ipcMain.handle('get-download-progress', () => this.funasr.getDownloadProgress());
    ipcMain.handle('restart-funasr-server', () => this.funasr.restartServer());
    ipcMain.handle('download-model', async (event) => this.funasr.restartServer());
    ipcMain.handle('start-local-backend', async () => this.funasr.startLocalBackend());

    // ── AI 文本处理 ──
    ipcMain.handle('process-text', async (_, text, mode = 'optimize') => this._processWithAI(text, mode));
    ipcMain.handle('check-ai-status', async (_, testConfig) => this._checkAIStatus(testConfig));

    // ── 数据库 ──
    ipcMain.handle('save-transcription', (_, data) => this.db.saveTranscription(data));
    ipcMain.handle('get-transcriptions', (_, limit, offset) => this.db.getTranscriptions(limit, offset));
    ipcMain.handle('delete-transcription', (_, id) => this.db.deleteTranscription(id));
    ipcMain.handle('clear-all-transcriptions', () => this.db.clearAllTranscriptions());
    ipcMain.handle('search-transcriptions', (_, query, limit) => this.db.searchTranscriptions(query, limit));
    ipcMain.handle('export-transcriptions', async () => {
      const { dialog } = require('electron');
      const items = this.db.getTranscriptions(9999, 0);
      const content = items.map(i => `[${i.created_at}]\n${i.text}\n---\n`).join('\n');
      const { filePath } = await dialog.showSaveDialog({ defaultPath: `ququ_export_${Date.now()}.txt`, filters: [{ name: 'Text', extensions: ['txt'] }] });
      if (filePath) require('fs').writeFileSync(filePath, content, 'utf-8');
      return { success: true, path: filePath };
    });

    // ── 设置 ──
    ipcMain.handle('get-setting', (_, key, def) => this.db.getSetting(key, def));
    ipcMain.handle('set-setting', (_, key, value) => {
      this.db.setSetting(key, value);
      if (key === 'funasr_base_url') this.funasr?.setBaseUrl?.(value);
    });
    ipcMain.handle('save-setting', (_, key, value) => {
      this.db.setSetting(key, value);
      if (key === 'funasr_base_url' && value) this.funasr?.connect?.(value);
    });
    ipcMain.handle('get-all-settings', () => this.db.getAllSettings());
    ipcMain.handle('get-settings', () => this.db.getAllSettings());
    ipcMain.handle('reset-settings', () => this.db.resetSettings());

    // ── 剪贴板 ──
    ipcMain.handle('copy-text', async (_, text) => { try { return await this.clip.copyText(text); } catch (e) { return { success: false, error: e.message }; } });
    ipcMain.handle('paste-text', async (_, text) => { try { return await this.clip.pasteText(text); } catch (e) { return { success: false, error: e.message }; } });
    ipcMain.handle('read-clipboard', () => this.clip.readClipboard());
    ipcMain.handle('write-clipboard', async (_, text) => { try { return await this.clip.writeClipboard(text); } catch (e) { return { success: false, error: e.message }; } });

    // ── 快捷键 ──
    ipcMain.handle('register-hotkey', (event, hotkey) => {
      try {
        const sid = event.sender.id;
        if (this._registeredSenders.has(sid)) return { success: true };
        const ok = this.hotkey.registerHotkey(hotkey, () => {
          if (this.wm.mainWindow && !this.wm.mainWindow.isDestroyed()) {
            this.wm.mainWindow.webContents.send('hotkey-triggered', { hotkey });
          }
        });
        if (ok) {
          this._registeredSenders.add(sid);
          event.sender.on('destroyed', () => this._registeredSenders.delete(sid));
        }
        return { success: ok };
      } catch (e) { return { success: false, error: e.message }; }
    });
    ipcMain.handle('unregister-hotkey', (_, hotkey) => {
      try { return { success: this.hotkey.unregisterHotkey(hotkey) }; } catch (e) { return { success: false, error: e.message }; }
    });
    ipcMain.handle('get-current-hotkey', () => {
      const keys = this.hotkey.getRegisteredHotkeys();
      return keys.find(k => k !== 'F2') || 'Ctrl+Space';
    });
    ipcMain.handle('set-recording-state', (_, v) => { this.hotkey.setRecordingState(v); return { success: true }; });
    ipcMain.handle('get-recording-state', () => ({ success: true, isRecording: this.hotkey.getRecordingState() }));

    // ── 长按模式：evdev 全局监听 keydown+keyup（替代 globalShortcut）──
    // 同时注销全局快捷键，避免双触发
    ipcMain.handle('start-hold-watch', () => {
      if (!this.keyWatcher) return { success: false, error: 'KeyWatcher 不可用' };
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
      });
      return { success: true };
    });
    ipcMain.handle('stop-hold-watch', () => {
      this.keyWatcher?.stop();
      // 恢复全局快捷键 Ctrl+Space
      if (this.wm.mainWindow && !this.wm.mainWindow.isDestroyed()) {
        this.hotkey.registerHotkey('Ctrl+Space', () => {
          this.wm.mainWindow.webContents.send('hotkey-triggered', { hotkey: 'Ctrl+Space' });
        });
      }
      return { success: true };
    });

    // ── 系统 ──
    ipcMain.handle('get-system-info', () => ({ platform: process.platform, arch: process.arch, nodeVersion: process.version, electronVersion: process.versions.electron }));
    ipcMain.handle('get-app-version', () => app.getVersion());
    ipcMain.handle('check-permissions', async () => {
      const a11y = await this.clip.checkAccessibilityPermissions().catch(() => false);
      return { microphone: true, accessibility: a11y };
    });
    ipcMain.handle('test-accessibility-permission', async () => {
      try { await this.clip.pasteText('蛐蛐权限测试'); return { success: true }; } catch (e) { return { success: false, error: e.message }; }
    });
    ipcMain.handle('open-system-permissions', () => { this.clip.openSystemSettings(); return { success: true }; });
    ipcMain.handle('show-item-in-folder', (_, p) => shell.showItemInFolder(p));
    ipcMain.handle('open-external', (_, url) => shell.openExternal(url));

    // ── 日志 ──
    ipcMain.handle('log', (_, level, message, data) => { this.log?.[level]?.(`[Renderer] ${message}`, data); return true; });
    ipcMain.handle('get-debug-info', () => ({ platform: process.platform, arch: process.arch, nodeVersion: process.version, electronVersion: process.versions.electron, appVersion: app.getVersion() }));

    // ── 可用模型列表 ──
    ipcMain.handle('get-available-models', () => ({
      models: [
        { name: 'paraformer-large', displayName: 'Paraformer Large (ASR)', type: 'asr', size: '840MB', description: '大型中文语音识别模型' },
        { name: 'fsmn-vad', displayName: 'FSMN VAD', type: 'vad', size: '1.6MB', description: '语音活动检测模型' },
        { name: 'ct-transformer-punc', displayName: 'CT Transformer (标点)', type: 'punc', size: '278MB', description: '标点符号恢复模型' },
      ],
    }));
    ipcMain.handle('get-current-model', async () => {
      const s = await this.funasr.checkStatus();
      return { model: 'paraformer-large', status: s.models_downloaded ? 'ready' : 'not_downloaded', details: s };
    });
    ipcMain.handle('switch-model', () => ({ success: false, error: 'FunASR使用固定模型组合，暂不支持切换' }));
    ipcMain.handle('get-performance-stats', () => ({}));
    ipcMain.handle('clear-performance-stats', () => ({ success: true }));

    // ── 中文相关 ──
    ipcMain.handle('detect-language', (_, text) => ({ language: 'zh-CN', confidence: 0.95 }));
    ipcMain.handle('segment-chinese', (_, text) => ({ segments: [...text] }));
    ipcMain.handle('add-punctuation', (_, text) => ({ text }));

    // ── 音频 ──
    ipcMain.handle('convert-audio-format', (_, data) => ({ success: true, data }));
    ipcMain.handle('enhance-audio', (_, data) => ({ success: true, data }));

    // ── 开发工具 ──
    if (process.env.NODE_ENV === 'development') {
      ipcMain.handle('open-dev-tools', (event) => { BrowserWindow.fromWebContents(event.sender)?.webContents.openDevTools(); });
      ipcMain.handle('reload-window', (event) => { BrowserWindow.fromWebContents(event.sender)?.reload(); });
    }
  }

  // ── AI 文本处理 (内部实现) ──
  async _processWithAI(text, mode = 'optimize') {
    try {
      const apiKey = await this.db.getSetting('ai_api_key');
      if (!apiKey) return { success: false, error: '请先在设置页面配置AI API密钥' };
      const baseUrl = await this.db.getSetting('ai_base_url') || 'https://api.openai.com/v1';
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
      });
      if (!res.ok) { const e = await res.text(); throw new Error(`API error ${res.status}: ${e}`); }
      const data = await res.json();
      return data.choices?.[0]?.message?.content
        ? { success: true, text: data.choices[0].message.content.trim(), usage: data.usage, model }
        : { success: false, error: 'AI返回数据格式错误' };
    } catch (e) {
      return { success: false, error: e.message || '文本处理失败' };
    }
  }

  async _checkAIStatus(testConfig = null) {
    try {
      const apiKey = testConfig?.ai_api_key || await this.db.getSetting('ai_api_key');
      if (!apiKey) return { available: false, error: '未配置API密钥' };
      const baseUrl = testConfig?.ai_base_url || await this.db.getSetting('ai_base_url') || 'https://api.openai.com/v1';
      const model = testConfig?.ai_model || await this.db.getSetting('ai_model') || 'gpt-3.5-turbo';

      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: '请回复"测试成功"' }], max_tokens: 50, temperature: 0.1 }),
      });
      if (!res.ok) { const e = await res.text(); throw new Error(`HTTP ${res.status}: ${e}`); }
      const data = await res.json();
      return data.choices?.[0]
        ? { available: true, model, status: 'connected', response: data.choices[0].message?.content, usage: data.usage, details: `成功连接到 ${model}` }
        : { available: false, error: '返回数据格式异常' };
    } catch (e) {
      return { available: false, error: e.message };
    }
  }

  removeAllHandlers() { ipcMain.removeAllListeners(); }
}

module.exports = IPCHandlers;
