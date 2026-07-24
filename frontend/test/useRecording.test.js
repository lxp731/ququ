import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { mockElectronAPI } from './helpers/mockElectron.js'

describe('useRecording', () => {
  let mockStream
  let mockRecorder

  beforeEach(() => {
    vi.restoreAllMocks()
    delete window.electronAPI

    mockStream = {
      getTracks: () => [{ stop: vi.fn() }],
    }

    mockRecorder = {
      start: vi.fn(),
      stop: vi.fn(),
      ondataavailable: null,
      onstop: null,
      onerror: null,
      state: 'inactive',
    }

    window.MediaRecorder = vi.fn(function () { return mockRecorder })

    // Deleted onTranscriptionComplete / onAIOptimizationComplete
    delete window.onTranscriptionComplete
    delete window.onAIOptimizationComplete
  })

  const renderUseRecording = async (modelStatus = { isReady: true }) => {
    const { useRecording } = await import('../src/hooks/useRecording.js')
    return renderHook(() => useRecording(modelStatus))
  }

  describe('初始状态', () => {
    it('应该处于 idle 状态', async () => {
      const { result } = await renderUseRecording()

      expect(result.current.isRecording).toBe(false)
      expect(result.current.isProcessing).toBe(false)
      expect(result.current.error).toBeNull()
    })
  })

  describe('startRecording', () => {
    it('模型未就绪时不应开始录音', async () => {
      const { result } = await renderUseRecording({ isReady: false })

      await act(async () => {
        await result.current.startRecording()
      })

      expect(result.current.isRecording).toBe(false)
      expect(result.current.error).toContain('未就绪')
    })

    it('模型就绪时应该开始录音', async () => {
      navigator.mediaDevices.getUserMedia = vi.fn().mockResolvedValue(mockStream)

      const { result } = await renderUseRecording({ isReady: true })

      await act(async () => {
        await result.current.startRecording()
      })

      expect(result.current.isRecording).toBe(true)
      expect(result.current.error).toBeNull()
      expect(mockRecorder.start).toHaveBeenCalledWith(1000)
    })

    it('录音中再次调用不应重复开始', async () => {
      navigator.mediaDevices.getUserMedia = vi.fn().mockResolvedValue(mockStream)

      const { result } = await renderUseRecording({ isReady: true })

      await act(async () => {
        await result.current.startRecording()
      })
      expect(result.current.isRecording).toBe(true)

      await act(async () => {
        await result.current.startRecording()
      })
      // Should still be recording, getUserMedia called only once
      expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1)
    })

    it('getUserMedia 失败时应该设置错误', async () => {
      navigator.mediaDevices.getUserMedia = vi.fn().mockRejectedValue(new Error('NotAllowedError'))

      const { result } = await renderUseRecording({ isReady: true })

      await act(async () => {
        await result.current.startRecording()
      })

      expect(result.current.isRecording).toBe(false)
      expect(result.current.error).toContain('NotAllowedError')
    })
  })

  describe('stopRecording', () => {
    it('应该停止录音', async () => {
      navigator.mediaDevices.getUserMedia = vi.fn().mockResolvedValue(mockStream)

      const { result } = await renderUseRecording({ isReady: true })

      await act(async () => {
        await result.current.startRecording()
      })
      expect(result.current.isRecording).toBe(true)

      act(() => {
        result.current.stopRecording()
      })

      expect(mockRecorder.stop).toHaveBeenCalled()
      // onstop callback sets isRecording to false, but in test it triggers async
    })

    it('未录音时调用不应报错', async () => {
      const { result } = await renderUseRecording({ isReady: true })

      act(() => {
        result.current.stopRecording()
      })

      // 不应抛出异常
      expect(result.current.isRecording).toBe(false)
    })
  })

  describe('cancelRecording', () => {
    it('应该取消录音并重置状态', async () => {
      navigator.mediaDevices.getUserMedia = vi.fn().mockResolvedValue(mockStream)

      const { result } = await renderUseRecording({ isReady: true })

      await act(async () => {
        await result.current.startRecording()
      })

      act(() => {
        result.current.cancelRecording()
      })

      expect(result.current.isRecording).toBe(false)
      expect(result.current.isProcessing).toBe(false)
      expect(result.current.error).toBeNull()
    })
  })

  // audioBufferToWav is module-internal, tested indirectly
})
