import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: './',
  publicDir: 'assets',
  clearScreen: false,
  server: {
    port: 5173,
    host: 'localhost',
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    sourcemap: false,
    minify: 'esbuild',
    target: 'chrome120',
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'src', 'index.html'),
        history: path.resolve(__dirname, 'src', 'history.html'),
        settings: path.resolve(__dirname, 'src', 'settings.html'),
      },
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom'],
          motion: ['framer-motion'],
          ui: ['@radix-ui/react-dialog', '@radix-ui/react-select', '@radix-ui/react-tabs'],
        },
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  optimizeDeps: {
    include: ['react', 'react-dom', 'framer-motion', 'lucide-react'],
    exclude: ['electron'],
  },
  define: {
    __APP_VERSION__: JSON.stringify('1.0.0'),
    __DEV__: JSON.stringify(process.env.NODE_ENV === 'development'),
  },
})
