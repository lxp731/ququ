import React, { useState, useEffect } from 'react';
import ReactDOM from 'react-dom/client';
import { motion } from 'framer-motion';
import { toast } from 'sonner';
import { Settings, Save, Eye, EyeOff, Loader2, TestTube, Mic, Shield, Zap, Cpu, ChevronDown, Server } from 'lucide-react';
import './index.css';
import { usePermissions } from './hooks/usePermissions';

// 模块级 Input 组件 — 避免每次 render 重建导致失焦
const Input = ({ label, hint, ...props }) => (
  <div>
    <label className="block text-xs font-medium text-white/60 mb-1.5">{label}</label>
    <input {...props} className="w-full px-3 py-2 text-sm bg-white/[0.04] border border-white/[0.08] rounded-lg focus:ring-2 focus:ring-indigo-500/50 focus:border-transparent text-white placeholder-white/20 transition-all" />
    {hint && <p className="mt-1 text-[10px] text-white/25">{hint}</p>}
  </div>
);

// 自定义下拉组件 — 完全控制背景/字体色
const ModelSelect = ({ value, onChange, options, fetching, children }) => {
  const [open, setOpen] = useState(false);
  const [customizing, setCustomizing] = useState(false);
  const [draft, setDraft] = useState('');
  const ref = React.useRef(null);
  const inputRef = React.useRef(null);
  useEffect(() => {
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const handleSelect = (v) => {
    onChange(v);
    setOpen(false);
    setCustomizing(false);
  };

  const commitCustom = () => {
    const v = draft.trim();
    if (v) onChange(v);
    setOpen(false);
    setCustomizing(false);
  };

  const isPreset = ['deepseek-v4-flash', 'deepseek-v4-pro', 'qwen3.7-max', 'qwen3.5-max', 'gpt-4o-mini', 'gpt-4o'].includes(value);
  const btnText = fetching ? '正在获取模型列表…'
    : options.length > 0 ? (options.find(o => o.value === value)?.label || value || '选择模型')
    : value || '选择模型';

  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => { setOpen(!open); setCustomizing(false); }}
        className="w-full flex items-center justify-between px-3 py-2 text-sm bg-white/[0.04] border border-white/[0.08] rounded-lg hover:border-white/20 transition-all text-white text-left">
        <span className={value ? 'text-white' : 'text-white/25'}>{btnText}</span>
        <ChevronDown className={`w-3.5 h-3.5 text-white/30 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="absolute z-50 top-full left-0 right-0 mt-1 max-h-56 overflow-y-auto rounded-lg border border-white/[0.08] bg-[#1a1a2e] backdrop-blur-xl shadow-2xl">
          {customizing ? (
            <div className="flex items-center gap-2 px-2 py-2 border-b border-white/[0.06]">
              <input ref={inputRef} autoFocus type="text" value={draft}
                onChange={e => setDraft(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') commitCustom(); if (e.key === 'Escape') setCustomizing(false); }}
                placeholder="输入模型名称…"
                className="flex-1 px-2 py-1.5 text-sm bg-white/[0.06] border border-white/[0.08] rounded text-white placeholder-white/20 focus:outline-none focus:border-indigo-500/50" />
              <button onClick={commitCustom}
                className="text-xs px-2 py-1.5 rounded bg-indigo-500/20 text-indigo-300 hover:bg-indigo-500/30 transition-colors whitespace-nowrap">确认</button>
            </div>
          ) : (
            <button type="button" onClick={() => { setCustomizing(true); setDraft(value && !isPreset ? value : ''); }}
              className="w-full text-left px-3 py-2 text-sm text-white/40 hover:bg-white/[0.08] transition-colors border-b border-white/[0.06]">
              ⚡ 自定义模型…
            </button>
          )}
          {fetching && (
            <div className="flex items-center gap-2 px-3 py-2 text-xs text-white/30">
              <Loader2 className="w-3 h-3 animate-spin" /> 获取中…
            </div>
          )}
          {options.length > 0 ? (
            options.map(o => (
              <button key={o.value} type="button" onClick={() => handleSelect(o.value)}
                className={`w-full text-left px-3 py-2 text-sm transition-colors hover:bg-white/[0.08] ${o.value === value ? 'text-indigo-300 bg-indigo-500/10' : 'text-white/70'}`}>
                {o.label}
              </button>
            ))
          ) : !fetching ? (children) : null}
        </div>
      )}
    </div>
  );
};

const SettingsPage = () => {
  const [settings, setSettings] = useState({
    ai_api_key: '', ai_base_url: 'https://api.openai.com/v1',
    ai_model: 'gpt-3.5-turbo', enable_ai_optimization: true,
    funasr_base_url: '',
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testingBackend, setTestingBackend] = useState(false);
  const [availableModels, setAvailableModels] = useState([]);
  const [fetchingModels, setFetchingModels] = useState(false);
  const fetchedRef = React.useRef('');

  const showAlert = (a) => toast(a.title, { description: a.description, duration: 4000 });
  const { micPermissionGranted, accessibilityPermissionGranted, requestMicPermission, testAccessibilityPermission } = usePermissions(showAlert);

  useEffect(() => { loadSettings(); }, []);

  // 自动拉取可用模型列表（API Key + Base URL 就绪时）
  useEffect(() => {
    const key = settings.ai_api_key.trim();
    const base = settings.ai_base_url.trim();
    if (!key || !base) { setAvailableModels([]); return; }
    const cacheKey = `${base}|||${key.slice(0, 8)}`;
    if (fetchedRef.current === cacheKey) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      setFetchingModels(true);
      try {
        const res = await fetch(`${base}/models`, {
          headers: { 'Authorization': `Bearer ${key}` },
        });
        if (!res.ok) throw new Error('fail');
        const data = await res.json();
        const ids = (data.data || []).map(m => m.id).filter(Boolean).sort();
        if (!cancelled) { setAvailableModels(ids); fetchedRef.current = cacheKey; }
      } catch {
        if (!cancelled) setAvailableModels([]);
      } finally {
        if (!cancelled) setFetchingModels(false);
      }
    }, 800);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [settings.ai_api_key, settings.ai_base_url]);

  const loadSettings = async () => {
    try {
      setLoading(true);
      if (window.electronAPI) {
        const all = await window.electronAPI.getAllSettings();
        setSettings({
          ai_api_key: all.ai_api_key || '',
          ai_base_url: all.ai_base_url || 'https://api.openai.com/v1',
          ai_model: all.ai_model || 'gpt-3.5-turbo',
          enable_ai_optimization: all.enable_ai_optimization !== false,
          funasr_base_url: all.funasr_base_url || '',
        });
      }
    } catch (e) { toast.error('加载设置失败'); }
    finally { setLoading(false); }
  };

  const saveBackendSetting = async () => {
    try {
      const url = settings.funasr_base_url.trim();
      if (window.electronAPI) {
        await window.electronAPI.saveSetting('funasr_base_url', url);
      }
      toast.success('后端地址已保存');
    } catch (e) { toast.error('保存失败'); }
  };

  const saveAISettings = async () => {
    try {
      setSaving(true);
      if (window.electronAPI) {
        for (const k of ['ai_api_key', 'ai_base_url', 'ai_model', 'enable_ai_optimization']) {
          await window.electronAPI.setSetting(k, settings[k]);
        }
        toast.success('AI 设置保存成功');
      }
    } catch (e) { toast.error('保存失败'); }
    finally { setSaving(false); }
  };

  const testConfig = async () => {
    if (!settings.ai_api_key.trim()) { toast.error('请先输入 API Key'); return; }
    setTesting(true);
    try {
      const r = await window.electronAPI.checkAIStatus({
        ai_api_key: settings.ai_api_key.trim(),
        ai_base_url: settings.ai_base_url.trim() || 'https://api.openai.com/v1',
        ai_model: settings.ai_model.trim() || 'gpt-3.5-turbo',
      });
      toast[r.available ? 'success' : 'error'](r.available ? '配置测试通过' : '配置测试失败', { description: r.available ? `模型: ${r.model}` : r.error });
    } catch (e) { toast.error('测试失败', { description: e.message }); }
    finally { setTesting(false); }
  };

  const testBackendConnection = async () => {
    const url = settings.funasr_base_url.trim() || 'http://127.0.0.1:8000';
    setTestingBackend(true);
    try {
      const res = await fetch(`${url.replace(/\/+$/, '')}/health`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        toast.success('后端连接成功', { description: url });
      } else {
        toast.error(`HTTP ${res.status}`, { description: url });
      }
    } catch (e) {
      toast.error('后端连接失败', { description: e.message });
    }
    finally { setTestingBackend(false); }
  };

  if (loading) {
    return (
      <div className="min-h-screen animated-bg flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-indigo-400" />
      </div>
    );
  }

  return (
    <div className="h-screen animated-bg flex flex-col">
      {/* Header */}
      <div className="glass border-b-0 rounded-none px-6 py-4 flex items-center flex-shrink-0">
        <div className="flex items-center gap-3">
          <Settings className="w-5 h-5 text-indigo-400" />
          <h1 className="text-lg font-bold text-white">设置</h1>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto min-h-0">
        <div className="max-w-xl mx-auto p-6 space-y-6 pb-10">
          {/* Permissions */}
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="glass-light p-5">
            <h2 className="text-sm font-semibold text-white/80 mb-4 flex items-center gap-2">
              <Shield className="w-4 h-4 text-indigo-400" /> 权限管理
            </h2>
            <div className="space-y-2">
              <div className="flex items-center justify-between p-3 rounded-lg bg-white/[0.02]">
                <div className="flex items-center gap-3">
                  <Mic className="w-4 h-4 text-white/40" />
                  <div><p className="text-sm text-white/70">麦克风权限</p><p className="text-[10px] text-white/30">录制语音所需</p></div>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`w-2 h-2 rounded-full ${micPermissionGranted ? 'bg-emerald-400' : 'bg-white/20'}`} />
                  <button onClick={requestMicPermission} className="text-xs px-2 py-1 rounded bg-indigo-500/20 hover:bg-indigo-500/30 text-indigo-300 transition-colors">测试</button>
                </div>
              </div>
              <div className="flex items-center justify-between p-3 rounded-lg bg-white/[0.02]">
                <div className="flex items-center gap-3">
                  <Cpu className="w-4 h-4 text-white/40" />
                  <div><p className="text-sm text-white/70">辅助功能权限</p><p className="text-[10px] text-white/30">自动粘贴所需</p></div>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`w-2 h-2 rounded-full ${accessibilityPermissionGranted ? 'bg-emerald-400' : 'bg-white/20'}`} />
                  <button onClick={testAccessibilityPermission} className="text-xs px-2 py-1 rounded bg-indigo-500/20 hover:bg-indigo-500/30 text-indigo-300 transition-colors">测试</button>
                </div>
              </div>
            </div>
          </motion.div>

          {/* FunASR 后端 */}
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }} className="glass-light p-5">
            <h2 className="text-sm font-semibold text-white/80 mb-4 flex items-center gap-2">
              <Server className="w-4 h-4 text-emerald-400" /> FunASR 后端
            </h2>
            <p className="text-[10px] text-white/30 mb-4">设置语音识别后端服务地址。留空则使用本地默认地址。</p>
            <Input label="后端地址" type="url" value={settings.funasr_base_url}
              onChange={e => setSettings(p => ({ ...p, funasr_base_url: e.target.value }))}
              placeholder="http://127.0.0.1:8000" hint="FunASR 服务所在的主机地址，支持局域网或远程部署" />
            <div className="flex items-center justify-end gap-3 pt-4 border-t border-white/[0.06]">
              <button onClick={testBackendConnection} disabled={testingBackend}
                className="flex items-center gap-2 px-3 py-1.5 text-xs rounded-lg bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20 transition-colors disabled:opacity-50">
                {testingBackend ? <Loader2 className="w-3 h-3 animate-spin" /> : <TestTube className="w-3 h-3" />}
                测试连接
              </button>
              <button onClick={saveBackendSetting}
                className="flex items-center gap-2 px-3 py-1.5 text-xs rounded-lg bg-indigo-500/20 text-indigo-300 hover:bg-indigo-500/30 transition-colors">
                <Save className="w-3 h-3" />
                保存并连接
              </button>
            </div>
          </motion.div>

          {/* AI Config */}
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 }} className="glass-light p-5">
            <h2 className="text-sm font-semibold text-white/80 mb-4 flex items-center gap-2">
              <Zap className="w-4 h-4 text-amber-400" /> AI 配置
            </h2>
            <p className="text-[10px] text-white/30 mb-4">配置 AI 模型以优化语音识别结果。未配置时优化功能自动禁用。</p>

            <div className="space-y-4">
              {/* Toggle */}
              <div className="flex items-center justify-between">
                <span className="text-sm text-white/70">启用 AI 文本优化</span>
                <button
                  role="switch"
                  aria-checked={settings.enable_ai_optimization}
                  onClick={() => setSettings(p => ({ ...p, enable_ai_optimization: !p.enable_ai_optimization }))}
                  className={`relative inline-flex h-5 w-9 rounded-full transition-colors ${settings.enable_ai_optimization ? 'bg-indigo-500' : 'bg-white/10'}`}
                >
                  <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform mt-0.5 ${settings.enable_ai_optimization ? 'translate-x-[18px]' : 'translate-x-[2px]'}`} />
                </button>
              </div>

              <Input label="API Key *" type={showApiKey ? 'text' : 'password'} value={settings.ai_api_key}
                onChange={e => setSettings(p => ({ ...p, ai_api_key: e.target.value }))}
                placeholder="sk-..." />

              <Input label="API Base URL" type="url" value={settings.ai_base_url}
                onChange={e => setSettings(p => ({ ...p, ai_base_url: e.target.value }))}
                placeholder="https://api.openai.com/v1" hint="兼容 OpenAI API 的服务地址" />

              {/* Model */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-xs font-medium text-white/60">AI 模型</label>
                  <div className="flex gap-1">
                    <button onClick={() => { setSettings(p => ({ ...p, ai_base_url: 'https://api.deepseek.com/v1', ai_model: 'deepseek-v4-flash' })); }}
                      className="text-[10px] px-2 py-0.5 rounded bg-indigo-500/10 text-indigo-400 hover:bg-indigo-500/20 transition-colors">DeepSeek</button>
                    <button onClick={() => { setSettings(p => ({ ...p, ai_base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', ai_model: 'qwen3.7-max' })); }}
                      className="text-[10px] px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 transition-colors">Qwen</button>
                    <button onClick={() => { setSettings(p => ({ ...p, ai_base_url: 'https://api.openai.com/v1', ai_model: 'gpt-4o-mini' })); }}
                      className="text-[10px] px-2 py-0.5 rounded bg-blue-500/10 text-blue-400 hover:bg-blue-500/20 transition-colors">OpenAI</button>
                  </div>
                </div>

                {/* 模型下拉 */}
                <div className="space-y-2">
                  <ModelSelect
                    value={settings.ai_model}
                    onChange={(v) => setSettings(p => ({ ...p, ai_model: v }))}
                    fetching={fetchingModels}
                    options={
                      (() => {
                        const models = availableModels.length > 0
                          ? availableModels.map(m => ({ value: m, label: m }))
                          : [];
                        // DeepSeek 模型互斥显示：当前为 flash → 显示 pro，当前为 pro → 显示 flash
                        const peerMap = {
                          'deepseek-v4-flash': 'deepseek-v4-pro', 'deepseek-v4-pro': 'deepseek-v4-flash',
                          'qwen3.7-max': 'qwen3.5-max', 'qwen3.5-max': 'qwen3.7-max',
                          'gpt-4o-mini': 'gpt-4o', 'gpt-4o': 'gpt-4o-mini',
                        };
                        const peer = peerMap[settings.ai_model];
                        if (peer && !models.some(m => m.value === peer)) {
                          models.push({ value: peer, label: peer });
                        }
                        return models;
                      })()
                    }
                  />
                </div>
              </div>

              {/* AI Actions */}
              <div className="flex items-center justify-end gap-3 pt-4 border-t border-white/[0.06]">
                <button onClick={testConfig} disabled={testing}
                  className="flex items-center gap-2 px-3 py-1.5 text-xs rounded-lg bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20 transition-colors disabled:opacity-50">
                  {testing ? <Loader2 className="w-3 h-3 animate-spin" /> : <TestTube className="w-3 h-3" />}
                  测试 AI 配置
                </button>
                <button onClick={saveAISettings} disabled={saving || !settings.ai_api_key}
                  className="flex items-center gap-2 px-3 py-1.5 text-xs rounded-lg bg-indigo-500/20 text-indigo-300 hover:bg-indigo-500/30 transition-colors disabled:opacity-50">
                  {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
                  保存 AI 设置
                </button>
              </div>
            </div>
          </motion.div>

          {/* About */}
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }}
            className="glass-light p-5">
            <h2 className="text-sm font-semibold text-white/80 mb-3">关于蛐蛐</h2>
            <div className="p-4 rounded-lg bg-indigo-500/[0.04] border border-indigo-500/10">
              <p className="text-sm text-white/60 mb-2">🎤 <strong>蛐蛐 (QuQu)</strong> — 开源免费的 Wispr Flow 替代方案</p>
              <p className="text-xs text-white/30 leading-relaxed">
                高精度中文语音识别 · AI 智能文本优化 · 隐私保护设计 · 数据本地处理
              </p>
            </div>
          </motion.div>
        </div>
      </div>
    </div>
  );
};

export { SettingsPage };
export default SettingsPage;

// Standalone render
if (document.getElementById('settings-root')) {
  ReactDOM.createRoot(document.getElementById('settings-root')).render(
    <React.StrictMode><SettingsPage /></React.StrictMode>
  );
}
