import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { mockElectronAPI } from './helpers/mockElectron.js'

describe('usePermissions', () => {
  let showAlert

  beforeEach(() => {
    vi.restoreAllMocks()
    delete window.electronAPI
    showAlert = vi.fn()
  })

  const renderUsePermissions = async () => {
    const { usePermissions } = await import('../src/hooks/usePermissions.js')
    return renderHook(() => usePermissions(showAlert))
  }

  describe('requestMicPermission', () => {
    it('麦克风授权成功时更新状态并提示', async () => {
      navigator.mediaDevices.getUserMedia = vi.fn().mockResolvedValue({
        getTracks: () => [],
      })

      const { result } = await renderUsePermissions()

      await act(async () => {
        await result.current.requestMicPermission()
      })

      expect(result.current.micPermissionGranted).toBe(true)
      expect(showAlert).toHaveBeenCalledWith(
        expect.objectContaining({ title: expect.stringContaining('✅') })
      )
    })

    it('麦克风授权失败时更新状态并提示', async () => {
      navigator.mediaDevices.getUserMedia = vi.fn().mockRejectedValue(new Error('NotAllowedError'))

      const { result } = await renderUsePermissions()

      await act(async () => {
        await result.current.requestMicPermission()
      })

      expect(result.current.micPermissionGranted).toBe(false)
      expect(showAlert).toHaveBeenCalledWith(
        expect.objectContaining({ title: expect.stringContaining('❌') })
      )
    })
  })

  describe('testAccessibilityPermission', () => {
    it('辅助功能正常时提示成功', async () => {
      mockElectronAPI({
        pasteText: vi.fn().mockResolvedValue({ success: true }),
      })

      const { result } = await renderUsePermissions()

      await act(async () => {
        await result.current.testAccessibilityPermission()
      })

      expect(result.current.accessibilityPermissionGranted).toBe(true)
      expect(window.electronAPI.pasteText).toHaveBeenCalledWith('蛐蛐权限测试')
      expect(showAlert).toHaveBeenCalledWith(
        expect.objectContaining({ title: expect.stringContaining('✅') })
      )
    })

    it('辅助功能失败时提示错误', async () => {
      mockElectronAPI({
        pasteText: vi.fn().mockRejectedValue(new Error('Permission denied')),
      })

      const { result } = await renderUsePermissions()

      await act(async () => {
        await result.current.testAccessibilityPermission()
      })

      expect(result.current.accessibilityPermissionGranted).toBe(false)
      expect(showAlert).toHaveBeenCalledWith(
        expect.objectContaining({ title: expect.stringContaining('❌') })
      )
    })

    it('没有 electronAPI 时可选链静默返回 undefined，视为成功', async () => {
      delete window.electronAPI

      const { result } = await renderUsePermissions()

      await act(async () => {
        await result.current.testAccessibilityPermission()
      })

      // window.electronAPI?.pasteText(...) returns undefined (not rejected),
      // so the try block completes successfully → setA11yGranted(true)
      expect(result.current.accessibilityPermissionGranted).toBe(true)
    })
  })
})
