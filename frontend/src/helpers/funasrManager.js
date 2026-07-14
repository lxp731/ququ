const { exec } = require('child_process');
const path = require('path');

class FunASRManager {
  constructor(logger) {
    this.logger = logger || console;
    this.serverReady = false;
    this.modelsInitialized = false;
    this.modelsDownloaded = false;
    this.initializationPromise = null;
    this.baseUrl = process.env.FUNASR_API_URL || 'http://127.0.0.1:8000';
    this.composeDir = path.join(__dirname, '..', '..', '..');
    this.containerName = 'ququ-funasr';
    this._composeCmd = null;
  }

  async _httpRequest(endpoint, opts = {}) {
    const { method = 'GET', body, formData, timeout = 120000 } = opts;
    const init = { method, signal: AbortSignal.timeout(timeout) };
    if (formData) { init.body = formData; }
    else if (body) { init.headers = { 'Content-Type': 'application/json' }; init.body = JSON.stringify(body); }
    const res = await fetch(`${this.baseUrl}${endpoint}`, init);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async _detectComposeCmd() {
    if (this._composeCmd) return this._composeCmd;
    for (const [cmd, ...args] of [['podman', 'compose', 'version'], ['docker', 'compose', 'version'], ['podman-compose', '--version']]) {
      try {
        await new Promise((res, rej) => exec(`${cmd} ${args.join(' ')}`, { timeout: 5000 }, (e) => e ? rej(e) : res()));
        this._composeCmd = `${cmd} ${args[0]}`;
        return this._composeCmd;
      } catch { continue; }
    }
    throw new Error('未找到可用的 compose 工具');
  }

  _runCompose(args) {
    return this._detectComposeCmd().then(cmd => new Promise((res, rej) => {
      exec(`${cmd} ${args.join(' ')}`, { cwd: this.composeDir, timeout: 120000 }, (e, stdout, stderr) => {
        e ? rej(new Error(stderr || e.message)) : res(stdout.trim());
      });
    }));
  }

  async _checkContainerHealth() {
    try { const r = await this._httpRequest('/health', { timeout: 3000 }); return r.status === 'ok'; } catch { return false; }
  }

  async _waitForContainer(maxRetries = 60, interval = 3000) {
    for (let i = 0; i < maxRetries; i++) { if (await this._checkContainerHealth()) return; await new Promise(r => setTimeout(r, interval)); }
    throw new Error('等待容器就绪超时');
  }

  async _waitForModelReady() {
    const status = await this._httpRequest('/status');
    if (status.initialized) { this.serverReady = true; this.modelsInitialized = true; this.modelsDownloaded = true; return; }
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 3000));
      const s = await this._httpRequest('/status').catch(() => ({}));
      if (s.initialized) { this.serverReady = true; this.modelsInitialized = true; this.modelsDownloaded = true; return; }
    }
    throw new Error('模型初始化超时');
  }

  async _initOrWaitServer() {
    if (await this._checkContainerHealth()) { await this._waitForModelReady(); return; }
    const fs = require('fs');
    if (fs.existsSync(path.join(this.composeDir, 'docker-compose.yml'))) {
      await this._runCompose(['up', '-d', '--wait']);
      await this._waitForContainer();
      await this._waitForModelReady();
      return;
    }
    throw new Error('FunASR 容器未运行，请执行: podman compose up -d');
  }

  async initializeAtStartup() {
    try {
      this.initializationPromise = this._initOrWaitServer();
      await this.initializationPromise;
    } catch (e) {
      this.logger.warn?.('FunASR 容器暂不可用', e.message);
    }
  }

  async checkStatus() {
    try {
      if (this.serverReady) return await this._httpRequest('/status');
      if (await this._checkContainerHealth()) {
        this.serverReady = true;
        const s = await this._httpRequest('/status');
        if (s.initialized) { this.modelsInitialized = true; this.modelsDownloaded = true; }
        return s;
      }
      return { success: false, initialized: false, models_downloaded: false, error: '容器未运行', initializing: !!this.initializationPromise };
    } catch (e) {
      return { success: false, error: e.message, models_downloaded: false };
    }
  }

  async transcribeAudio(audioData, options = {}) {
    if (!this.serverReady) {
      if (this.initializationPromise) await this.initializationPromise;
      if (!this.serverReady) throw new Error('FunASR 服务器未就绪');
    }
    let buf;
    if (audioData instanceof ArrayBuffer || audioData instanceof Uint8Array) buf = Buffer.from(audioData);
    else if (typeof audioData === 'string') buf = Buffer.from(audioData, 'base64');
    else if (audioData?.buffer) buf = Buffer.from(audioData.buffer);
    else throw new Error(`不支持的音频数据类型: ${typeof audioData}`);

    const formData = new FormData();
    formData.append('audio', new Blob([buf], { type: 'audio/wav' }), 'audio.wav');
    formData.append('options', JSON.stringify(options));
    const result = await this._httpRequest('/transcribe', { method: 'POST', formData, timeout: 120000 });
    if (!result.success) throw new Error(result.error || '转录失败');
    return { success: true, text: (result.text || '').trim(), raw_text: result.raw_text || '', confidence: result.confidence || 0, language: result.language || 'zh-CN', duration: result.duration || 0 };
  }

  async checkModelFiles() {
    try {
      if (this.serverReady) {
        const s = await this._httpRequest('/status');
        return { success: true, models_downloaded: s.initialized, missing_models: s.initialized ? [] : ['asr', 'vad', 'punc'], details: s.models || {} };
      }
      return { success: true, models_downloaded: false, missing_models: ['asr', 'vad', 'punc'], details: {} };
    } catch (e) {
      return { success: false, models_downloaded: false, missing_models: ['asr', 'vad', 'punc'], error: e.message };
    }
  }

  async getDownloadProgress() {
    try {
      if (this.serverReady) {
        const s = await this._httpRequest('/status');
        return { success: true, overall_progress: s.initialized ? 100 : 0 };
      }
      return { success: true, overall_progress: 0 };
    } catch { return { success: false, overall_progress: 0 }; }
  }

  async restartServer() {
    try {
      await this._runCompose(['down']);
      this.serverReady = false; this.modelsInitialized = false; this.modelsDownloaded = false;
      this.initializationPromise = this._initOrWaitServer();
      await this.initializationPromise;
      return { success: true };
    } catch (e) {
      this.initializationPromise = null;
      return { success: false, error: e.message };
    }
  }
}

module.exports = FunASRManager;
