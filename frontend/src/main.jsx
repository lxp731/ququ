import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import './index.css';
import { Toaster } from 'sonner';

class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { hasError: false, error: null }; }
  static getDerivedStateFromError() { return { hasError: true }; }
  componentDidCatch(error) { this.setState({ error }); window.electronAPI?.log('error', `React Error: ${error.message}`); }
  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen animated-bg flex items-center justify-center p-6">
          <div className="glass p-8 max-w-md text-center">
            <div className="w-14 h-14 mx-auto mb-4 rounded-full bg-red-500/20 flex items-center justify-center">
              <span className="text-2xl">!</span>
            </div>
            <h2 className="text-lg font-semibold text-white mb-2">应用出现错误</h2>
            <p className="text-sm text-gray-400 mb-4">蛐蛐遇到了意外错误，请尝试重启。</p>
            <button onClick={() => window.location.reload()} className="px-4 py-2 bg-indigo-500 hover:bg-indigo-600 rounded-lg text-sm text-white transition-colors">重新加载</button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

document.documentElement.classList.add('dark');
document.addEventListener('dragover', e => { e.preventDefault(); e.stopPropagation(); });
document.addEventListener('drop', e => { e.preventDefault(); e.stopPropagation(); });

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
      <Toaster theme="dark" position="bottom-center" richColors closeButton duration={2000} />
    </ErrorBoundary>
  </React.StrictMode>
);
