import React, { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { motion, AnimatePresence } from 'framer-motion';
import { toast, Toaster } from 'sonner';
import { Search, Copy, Trash2, Download, Clock, History, FileText, ChevronRight } from 'lucide-react';
import './index.css';

const formatDate = (dateStr) => {
  const d = new Date(dateStr);
  const now = new Date();
  const diff = Math.ceil(Math.abs(now - d) / (1000 * 60 * 60 * 24));
  const time = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  if (diff === 0) return `今天 ${time}`;
  if (diff === 1) return `昨天 ${time}`;
  if (diff <= 7) return `${diff - 1}天前`;
  return d.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' }) + ` ${time}`;
};

const HistoryPage = () => {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState(null);

  const load = async () => {
    if (!window.electronAPI) return;
    setLoading(true);
    try {
      const r = await window.electronAPI.getTranscriptions(200, 0);
      setItems(r || []);
    } catch (_) { }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const filtered = search.trim()
    ? items.filter(i => i.text?.includes(search) || i.raw_text?.includes(search) || i.processed_text?.includes(search))
    : items;

  const handleCopy = async (text) => {
    try {
      if (window.electronAPI) await window.electronAPI.copyText(text);
      else await navigator.clipboard.writeText(text);
      toast.success('已复制到剪贴板');
    } catch (_) { toast.error('复制失败'); }
  };

  const handleDelete = async (id) => {
    if (!window.electronAPI) return;
    try {
      await window.electronAPI.deleteTranscription(id);
      setItems(prev => prev.filter(i => i.id !== id));
      if (selected?.id === id) setSelected(null);
      toast.success('已删除');
    } catch (_) { toast.error('删除失败'); }
  };

  const handleExport = async () => {
    if (!window.electronAPI) return;
    try {
      await window.electronAPI.exportTranscriptions('txt');
      toast.success('导出成功');
    } catch (_) { toast.error('导出失败'); }
  };

  return (
    <div className="h-screen animated-bg flex flex-col">
      <Toaster theme="dark" position="top-center" richColors />

      {/* Header */}
      <div className="glass border-b-0 rounded-none px-6 py-4 flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-3">
          <History className="w-5 h-5 text-indigo-400" />
          <h1 className="text-lg font-bold text-white">转录历史</h1>
          <span className="text-xs text-white/20">({filtered.length})</span>
        </div>
        <button onClick={handleExport} className="p-2 rounded-lg hover:bg-white/10 transition-colors" title="导出">
          <Download className="w-4 h-4 text-white/50" />
        </button>
      </div>

      {/* Search */}
      <div className="px-6 py-4 flex-shrink-0">
        <div className="relative max-w-2xl mx-auto">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/20" />
          <input
            type="text" value={search} onChange={e => setSearch(e.target.value)}
            placeholder="搜索转录内容..."
            className="w-full pl-10 pr-4 py-2.5 text-sm bg-white/[0.04] border border-white/[0.08] rounded-xl focus:ring-2 focus:ring-indigo-500/50 focus:border-transparent text-white placeholder-white/20 transition-all"
          />
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto min-h-0 px-6 pb-6">
        <div className="max-w-3xl mx-auto">
          {loading ? (
            <div className="flex items-center justify-center py-20">
              <div className="w-5 h-5 border-2 border-indigo-400/60 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : filtered.length === 0 ? (
            <div className="text-center py-20">
              <FileText className="w-10 h-10 text-white/10 mx-auto mb-3" />
              <p className="text-sm text-white/30">{search ? '无匹配记录' : '暂无转录历史'}</p>
            </div>
          ) : (
            <div className="space-y-2">
              <AnimatePresence>
                {filtered.map((item, idx) => (
                  <motion.div
                    key={item.id}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, x: -20 }}
                    transition={{ delay: idx * 0.02 }}
                    className={`glass-light p-4 cursor-pointer transition-all hover:border-white/20 ${selected?.id === item.id ? 'border-indigo-400/30 bg-indigo-500/[0.04]' : ''}`}
                    onClick={() => setSelected(selected?.id === item.id ? null : item)}
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1.5">
                          <Clock className="w-3 h-3 text-white/25" />
                          <span className="text-[10px] text-white/30">{formatDate(item.created_at)}</span>
                          {item.confidence > 0 && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/[0.04] text-white/30">
                              {(item.confidence * 100).toFixed(0)}%
                            </span>
                          )}
                        </div>
                        <p className="text-sm text-white/70 line-clamp-2 leading-relaxed">
                          {item.processed_text || item.text}
                        </p>
                      </div>
                      <div className="flex items-center gap-1 ml-3 flex-shrink-0" onClick={e => e.stopPropagation()}>
                        <button onClick={() => handleCopy(item.processed_text || item.text)}
                          className="p-1.5 rounded-lg hover:bg-white/10 transition-colors" title="复制">
                          <Copy className="w-3.5 h-3.5 text-white/30" />
                        </button>
                        <button onClick={() => handleDelete(item.id)}
                          className="p-1.5 rounded-lg hover:bg-red-500/20 transition-colors" title="删除">
                          <Trash2 className="w-3.5 h-3.5 text-red-400/50" />
                        </button>
                        <ChevronRight className={`w-3.5 h-3.5 text-white/20 transition-transform ${selected?.id === item.id ? 'rotate-90' : ''}`} />
                      </div>
                    </div>

                    {/* Expanded detail */}
                    <AnimatePresence>
                      {selected?.id === item.id && (
                        <motion.div
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: 'auto', opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }}
                          className="overflow-hidden"
                        >
                          <div className="mt-3 pt-3 border-t border-white/[0.06] space-y-2">
                            {item.raw_text && item.raw_text !== item.text && (
                              <div>
                                <span className="text-[10px] text-white/25 uppercase tracking-wider">原始识别</span>
                                <p className="text-xs text-white/40 mt-1 leading-relaxed">{item.raw_text}</p>
                              </div>
                            )}
                            {item.processed_text && item.processed_text !== item.text && (
                              <div>
                                <span className="text-[10px] text-indigo-300/50 uppercase tracking-wider">AI 优化</span>
                                <p className="text-xs text-indigo-300/70 mt-1 leading-relaxed">{item.processed_text}</p>
                              </div>
                            )}
                            {(item.duration > 0 || item.file_size > 0) && (
                              <div className="flex gap-4 text-[10px] text-white/20">
                                {item.duration > 0 && <span>时长: {item.duration.toFixed(1)}s</span>}
                                {item.file_size > 0 && <span>大小: {(item.file_size / 1024).toFixed(1)}KB</span>}
                              </div>
                            )}
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

// Standalone render
const container = document.getElementById('history-root');
if (container) {
  createRoot(container).render(
    <React.StrictMode><HistoryPage /></React.StrictMode>
  );
}
