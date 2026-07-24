import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { mockElectronAPI } from './helpers/mockElectron.js'

describe('useModelStatus', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    delete window.electronAPI
    window.history.pushState({}, '', '/')
  })

  const renderUseModelStatus = async () => {
    const { useModelStatus } = await import('../src/hooks/useModelStatus.js')
    return renderHook(() => useModelStatus())
  }

  describe('checkStatus — 后端未连接', () => {
    it('应该将 stage 设为 need_backend', async () => {
      mockElectronAPI({
        checkFunASRStatus: vi.fn().mockResolvedValue({
          success: false, server_ready: false, connecting: false,
          models_initialized: false, is_initializing: false,
        }),
      })

      const { result } = await renderUseModelStatus()

      await vi.waitFor(() => {
        expect(result.current.stage).toBe('need_backend')
      })
      expect(result.current.isReady).toBe(false)
    })
  })

  describe('checkStatus — 正在连接', () => {
    it('应该将 stage 设为 connecting', async () => {
      mockElectronAPI({
        checkFunASRStatus: vi.fn().mockResolvedValue({
          success: false, server_ready: false, connecting: true,
          models_initialized: false, is_initializing: false,
        }),
      })

      const { result } = await renderUseModelStatus()

      await vi.waitFor(() => {
        expect(result.current.stage).toBe('connecting')
      })
      expect(result.current.connecting).toBe(true)
    })
  })

  describe('checkStatus — 后端就绪', () => {
    it('应该将 stage 设为 ready 当模型已初始化', async () => {
      mockElectronAPI({
        checkFunASRStatus: vi.fn().mockResolvedValue({
          success: true, server_ready: true, connecting: false,
          models_initialized: true, is_initializing: false,
        }),
      })

      const { result } = await renderUseModelStatus()

      await vi.waitFor(() => {
        expect(result.current.stage).toBe('ready')
      })
      expect(result.current.isReady).toBe(true)
      expect(result.current.modelsDownloaded).toBe(true)
    })

    it('应该将 stage 设为 loading 当模型初始化中', async () => {
      mockElectronAPI({
        checkFunASRStatus: vi.fn().mockResolvedValue({
          success: true, server_ready: true, connecting: false,
          models_initialized: false, is_initializing: true,
        }),
      })

      const { result } = await renderUseModelStatus()

      await vi.waitFor(() => {
        expect(result.current.stage).toBe('loading')
      })
    })
  })

  describe('checkStatus — 模型未下载', () => {
    it('应该将 stage 设为 need_download', async () => {
      mockElectronAPI({
        checkFunASRStatus: vi.fn().mockResolvedValue({
          success: false, server_ready: true, connecting: false,
          models_initialized: false, is_initializing: false,
        }),
        checkModelFiles: vi.fn().mockResolvedValue({
          models_downloaded: false, missing_models: ['asr'],
        }),
      })

      const { result } = await renderUseModelStatus()

      await vi.waitFor(() => {
        expect(result.current.stage).toBe('need_download')
      })
      expect(result.current.isReady).toBe(false)
    })
  })

  describe('checkStatus — Electron API 不可用', () => {
    it('应该将 stage 设为 no_api', async () => {
      // Don't set window.electronAPI at all
      delete window.electronAPI

      const { result } = await renderUseModelStatus()

      await vi.waitFor(() => {
        expect(result.current.stage).toBe('no_api')
      })
      expect(result.current.noApi).toBe(true)
    })
  })

  describe('checkStatus — 错误', () => {
    it('应该在异常时设为 error', async () => {
      mockElectronAPI({
        checkFunASRStatus: vi.fn().mockRejectedValue(new Error('网络错误')),
      })

      const { result } = await renderUseModelStatus()

      await vi.waitFor(() => {
        expect(result.current.stage).toBe('error')
      })
      expect(result.current.error).toContain('网络错误')
    })

    it('后端在线但返回未知状态时应设为 error', async () => {
      mockElectronAPI({
        checkFunASRStatus: vi.fn().mockResolvedValue({
          success: true, server_ready: true, connecting: false,
          models_initialized: false, is_initializing: false,
        }),
      })

      const { result } = await renderUseModelStatus()

      await vi.waitFor(() => {
        expect(result.current.stage).toBe('error')
      })
    })
  })

  describe('startLocalBackend', () => {
    it('应该调用 IPC 启动后端然后重新检查', async () => {
      mockElectronAPI({
        startLocalBackend: vi.fn().mockResolvedValue({ success: true }),
        checkFunASRStatus: vi.fn()
          .mockResolvedValueOnce({ success: false, server_ready: false, connecting: false,
            models_initialized: false, is_initializing: false })
          .mockResolvedValueOnce({ success: true, server_ready: true, connecting: false,
            models_initialized: true, is_initializing: false }),
      })

      const { result } = await renderUseModelStatus()

      await vi.waitFor(() => expect(result.current.stage).toBe('need_backend'))

      await act(async () => {
        await result.current.startLocalBackend()
      })

      expect(window.electronAPI.startLocalBackend).toHaveBeenCalled()
      // After start, should re-check and find ready
      await vi.waitFor(() => {
        expect(result.current.stage).toBe('ready')
      })
    })
  })

  describe('设置页跳过检查', () => {
    it('设置页不应该自动检查状态', async () => {
      window.history.pushState({}, '', '/?page=settings')
      mockElectronAPI()

      const { result } = await renderUseModelStatus()

      // Should stay at initial 'checking' — never called checkFunASRStatus
      expect(result.current.stage).toBe('checking')
      expect(window.electronAPI.checkFunASRStatus).not.toHaveBeenCalled()
    })
  })

  describe('手动 checkStatus', () => {
    it('暴露的 checkStatus 允许外部调用', async () => {
      mockElectronAPI({
        checkFunASRStatus: vi.fn()
          .mockResolvedValueOnce({ success: false, server_ready: false, connecting: false,
            models_initialized: false, is_initializing: false })
          .mockResolvedValueOnce({ success: true, server_ready: true, connecting: false,
            models_initialized: true, is_initializing: false }),
      })

      const { result } = await renderUseModelStatus()

      await vi.waitFor(() => expect(result.current.stage).toBe('need_backend'))

      // Manually check again after backend comes up
      await act(async () => {
        await result.current.checkStatus()
      })

      await vi.waitFor(() => {
        expect(result.current.stage).toBe('ready')
      })
      expect(result.current.isReady).toBe(true)
    })
  })
})
