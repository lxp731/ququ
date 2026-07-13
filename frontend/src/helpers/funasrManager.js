const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

class FunASRManager {
  constructor(logger = null) {
    this.logger = logger || console;
    this.isInitialized = false;
    this.modelsInitialized = false;
    this.serverReady = false;
    this.initializationPromise = null;
    this.modelsDownloaded = null;

    // 容器配置
    this.baseUrl = process.env.FUNASR_API_URL || "http://127.0.0.1:8000";
    // docker-compose.yml 所在目录（项目根目录）
    this.composeDir = path.join(__dirname, "..", "..", "..");
    this.containerName = "ququ-funasr";

    // 检测 compose 命令（podman compose > docker compose > podman-compose）
    this._composeCmd = null;

    // 模型配置（用于本地文件检查）
    this.modelConfigs = {
      "asr": {
        "name": "damo/speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-pytorch",
        "cache_path": "speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-pytorch",
        "expected_size": 840 * 1024 * 1024
      },
      "vad": {
        "name": "damo/speech_fsmn_vad_zh-cn-16k-common-pytorch",
        "cache_path": "speech_fsmn_vad_zh-cn-16k-common-pytorch",
        "expected_size": 1.6 * 1024 * 1024
      },
      "punc": {
        "name": "damo/punc_ct-transformer_zh-cn-common-vocab272727-pytorch",
        "cache_path": "punc_ct-transformer_zh-cn-common-vocab272727-pytorch",
        "expected_size": 278 * 1024 * 1024
      }
    };
  }

  // ============================================================
  //  HTTP 客户端
  // ============================================================

  async _httpRequest(endpoint, options = {}) {
    const url = `${this.baseUrl}${endpoint}`;
    const { method = "GET", body, formData, timeout = 120000 } = options;

    const fetchOptions = { method, signal: AbortSignal.timeout(timeout) };

    if (formData) {
      fetchOptions.body = formData;
    } else if (body) {
      fetchOptions.headers = { "Content-Type": "application/json" };
      fetchOptions.body = JSON.stringify(body);
    }

    const response = await fetch(url, fetchOptions);
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`HTTP ${response.status}: ${text}`);
    }
    return await response.json();
  }

  // ============================================================
  //  容器生命周期
  // ============================================================

  async _detectComposeCmd() {
    if (this._composeCmd) return this._composeCmd;

    const candidates = [
      { cmd: "podman compose", test: ["podman", "compose", "version"] },
      { cmd: "docker compose", test: ["docker", "compose", "version"] },
      { cmd: "podman-compose", test: ["podman-compose", "--version"] },
    ];

    for (const { cmd, test } of candidates) {
      try {
        await new Promise((resolve, reject) => {
          exec(`${test.join(" ")}`, { timeout: 5000 }, (error) => {
            error ? reject(error) : resolve();
          });
        });
        this._composeCmd = cmd;
        this.logger.info && this.logger.info(`使用 compose 命令: ${cmd}`);
        return cmd;
      } catch {
        continue;
      }
    }
    throw new Error("未找到可用的 compose 工具（podman compose / docker compose / podman-compose）");
  }

  _runComposeCommand(args) {
    const self = this;
    return new Promise((resolve, reject) => {
      self._detectComposeCmd().then((cmd) => {
        const fullCmd = `${cmd} ${args.join(" ")}`;
        exec(fullCmd, { cwd: self.composeDir, timeout: 120000 }, (error, stdout, stderr) => {
          if (error) {
            reject(new Error(`容器命令失败: ${stderr || error.message}`));
          } else {
            resolve(stdout.trim());
          }
        });
      }).catch(reject);
    });
  }

  async _startContainer() {
    this.logger.info && this.logger.info('启动 FunASR 容器...');
    await this._runComposeCommand(["up", "-d", "--wait"]);
    this.logger.info && this.logger.info('容器启动完成');
  }

  async _stopContainer() {
    try {
      await this._runComposeCommand(["down"]);
      this.logger.info && this.logger.info('容器已停止');
    } catch (e) {
      this.logger.warn && this.logger.warn('停止容器时出错:', e.message);
    }
  }

  async _checkContainerHealth() {
    try {
      const result = await this._httpRequest("/health", { timeout: 3000 });
      return result.status === "ok";
    } catch {
      return false;
    }
  }

  async _waitForContainer(maxRetries = 60, interval = 3000) {
    for (let i = 0; i < maxRetries; i++) {
      if (await this._checkContainerHealth()) {
        return true;
      }
      await new Promise(r => setTimeout(r, interval));
    }
    throw new Error("等待容器就绪超时");
  }

  // ============================================================
  //  服务器初始化（替代原来的 _startFunASRServer）
  // ============================================================

  _hasComposeFile() {
    return fs.existsSync(path.join(this.composeDir, "docker-compose.yml"));
  }

  async _initOrWaitServer() {
    try {
      // 先检查 API 是否已可达（容器已由用户手动启动）
      if (await this._checkContainerHealth()) {
        this.logger.info && this.logger.info('FunASR 容器已在运行');
        await this._waitForModelReady();
        return;
      }

      // 如果有 compose 文件，尝试自动启动容器（开发模式）
      if (this._hasComposeFile()) {
        this.logger.info && this.logger.info('启动 FunASR 容器...');
        await this._startContainer();
        await this._waitForContainer();
        await this._waitForModelReady();
        return;
      }

      // 生产模式（AppImage）：容器需用户手动启动
      throw new Error("FunASR 容器未运行，请在终端执行: podman compose up -d");
    } catch (error) {
      this.logger.error && this.logger.error('容器启动失败:', error.message);
      this.serverReady = false;
      this.initializationPromise = null;
      throw error;
    }
  }

  async _waitForModelReady() {
    const status = await this._httpRequest("/status");
    if (status.initialized) {
      this.serverReady = true;
      this.modelsInitialized = true;
      this.modelsDownloaded = true;
      this.logger.info && this.logger.info('模型已就绪');
      return;
    }
    // 等待模型加载
    this.logger.info && this.logger.info('等待模型初始化...');
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 3000));
      const s = await this._httpRequest("/status").catch(() => ({}));
      if (s.initialized) {
        this.serverReady = true;
        this.modelsInitialized = true;
        this.modelsDownloaded = true;
        this.logger.info && this.logger.info('模型加载完成，服务器就绪');
        return;
      }
    }
    throw new Error("等待模型初始化超时");
  }

  // ============================================================
  //  公开 API
  // ============================================================

  async initializeAtStartup() {
    try {
      this.logger.info && this.logger.info('FunASR 管理器启动初始化开始');
      this.initializationPromise = this._initOrWaitServer();
      await this.initializationPromise;
      this.isInitialized = true;
      this.logger.info && this.logger.info('FunASR 管理器启动初始化完成');
    } catch (error) {
      this.logger.warn && this.logger.warn(
        'FunASR 容器在启动时不可用，这不是关键问题', error.message
      );
      this.isInitialized = true;
    }
  }

  async checkStatus() {
    try {
      if (this.serverReady) {
        return await this._httpRequest("/status");
      }
      const healthy = await this._checkContainerHealth();
      if (healthy) {
        this.serverReady = true;
        const result = await this._httpRequest("/status");
        if (result.initialized) {
          this.modelsInitialized = true;
          this.modelsDownloaded = true;
        }
        return result;
      }
      return {
        success: false,
        installed: false,
        initialized: false,
        error: "容器未运行",
        models_downloaded: false,
        initializing: this.initializationPromise !== null,
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        installed: false,
        models_downloaded: false,
      };
    }
  }

  async transcribeAudio(audioData, options = {}) {
    if (!this.serverReady) {
      if (this.initializationPromise) {
        await this.initializationPromise;
      }
      if (!this.serverReady) {
        throw new Error("FunASR 服务器未就绪");
      }
    }

    // 将音频数据转为 Buffer
    let buf;
    if (audioData instanceof ArrayBuffer) {
      buf = Buffer.from(audioData);
    } else if (audioData instanceof Uint8Array) {
      buf = Buffer.from(audioData);
    } else if (typeof audioData === "string") {
      buf = Buffer.from(audioData, "base64");
    } else if (audioData && audioData.buffer) {
      buf = Buffer.from(audioData.buffer);
    } else {
      throw new Error(`不支持的音频数据类型: ${typeof audioData}`);
    }

    // HTTP multipart 上传（不写临时文件）
    const formData = new FormData();
    const blob = new Blob([buf], { type: "audio/wav" });
    formData.append("audio", blob, "audio.wav");
    formData.append("options", JSON.stringify(options));

    const result = await this._httpRequest("/transcribe", {
      method: "POST",
      formData,
      timeout: 120000,
    });

    if (!result.success) {
      throw new Error(result.error || "转录失败");
    }

    return {
      success: true,
      text: (result.text || "").trim(),
      raw_text: result.raw_text || "",
      confidence: result.confidence || 0.0,
      language: result.language || "zh-CN",
      duration: result.duration || 0,
    };
  }

  async checkModelFiles() {
    try {
      if (this.serverReady) {
        const status = await this._httpRequest("/status");
        return {
          success: true,
          models_downloaded: status.initialized,
          missing_models: status.initialized ? [] : ["asr", "vad", "punc"],
          details: status.models || {},
        };
      }
      return this._checkModelFilesLocally();
    } catch {
      return this._checkModelFilesLocally();
    }
  }

  async _checkModelFilesLocally() {
    const baseCachePath =
      process.env.MODELSCOPE_CACHE || path.join(os.homedir(), '.cache', 'modelscope');

    const candidates = [
      path.join(baseCachePath, 'damo'),
      path.join(baseCachePath, 'hub', 'damo'),
      path.join(baseCachePath, 'hub', 'models', 'damo'),
      path.join(baseCachePath, 'models', 'damo'),
    ];

    let cachePath = null;
    for (const c of candidates) {
      if (fs.existsSync(c)) { cachePath = c; break; }
    }

    if (!cachePath) {
      return {
        success: true,
        models_downloaded: false,
        missing_models: ["asr", "vad", "punc"],
        details: {}
      };
    }

    const results = {};
    const missingModels = [];
    for (const [modelType, config] of Object.entries(this.modelConfigs)) {
      const modelFile = path.join(cachePath, config.cache_path, "model.pt");
      const exists = fs.existsSync(modelFile) &&
        fs.statSync(modelFile).size >= config.expected_size * 0.95;
      results[modelType] = { exists, path: modelFile };
      if (!exists) missingModels.push(modelType);
    }

    return {
      success: true,
      models_downloaded: missingModels.length === 0,
      missing_models: missingModels,
      details: results,
    };
  }

  async getDownloadProgress() {
    try {
      if (this.serverReady) {
        const status = await this._httpRequest("/status");
        return {
          success: true,
          overall_progress: status.initialized ? 100 : 0,
          models: {},
        };
      }
      return { success: true, overall_progress: 0, models: {} };
    } catch {
      return { success: false, overall_progress: 0, models: {} };
    }
  }

  async restartServer() {
    try {
      this.logger.info && this.logger.info('重启 FunASR 服务器...');
      await this._stopContainer();
      this.serverReady = false;
      this.modelsInitialized = false;
      this.modelsDownloaded = false;
      this.initializationPromise = null;

      this.initializationPromise = this._initOrWaitServer();
      await this.initializationPromise;
      return { success: true, message: "服务器重启成功" };
    } catch (error) {
      this.initializationPromise = null;
      return { success: false, error: error.message };
    }
  }

  async getPerformanceStats() {
    try {
      const result = await this._httpRequest("/stats");
      return result.stats || {};
    } catch {
      return {};
    }
  }
}

module.exports = FunASRManager;
