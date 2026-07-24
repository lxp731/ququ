import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { mockElectronAPI } from './helpers/mockElectron.js'

// ── Mock window.location for page detection ──
// useHotkey checks URL params to skip registration on non-main pages

describe('useHotkey', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    delete window.electronAPI
    window.history.pushState({}, '', '/')
  })

  const renderUseHotkey = async () => {
    // Dynamic import so window.electronAPI is set before module loads
    const { useHotkey } = await import('../src/hooks/useHotkey.js')
    return renderHook(() => useHotkey())
  }

  describe('初始化', () => {
    it('应该从数据库加载保存的快捷键并注册', async () => {
      mockElectronAPI({
        getSetting: vi.fn().mockResolvedValue('Ctrl+Alt+X'),
      })

      const { result } = await renderUseHotkey()
      await vi.waitFor(() => {
        expect(result.current.rawHotkey).toBe('Ctrl+Alt+X')
      })

      expect(window.electronAPI.getSetting).toHaveBeenCalledWith('global_hotkey', 'Ctrl+Space')
      expect(window.electronAPI.registerHotkey).toHaveBeenCalledWith('Ctrl+Alt+X')
    })

    it('没有保存记录时使用默认 Ctrl+Space', async () => {
      mockElectronAPI({
        getSetting: vi.fn().mockResolvedValue(null),
      })

      const { result } = await renderUseHotkey()
      await vi.waitFor(() => {
        expect(result.current.rawHotkey).toBe('Ctrl+Space')
      })

      expect(window.electronAPI.registerHotkey).toHaveBeenCalledWith('Ctrl+Space')
    })

    it('设置页不应该注册快捷键', async () => {
      window.history.pushState({}, '', '/?page=settings')
      mockElectronAPI({
        getSetting: vi.fn().mockResolvedValue('Ctrl+Alt+X'),
      })

      const { result } = await renderUseHotkey()

      // Wait a tick to ensure init effect ran
      await vi.waitFor(() => {
        expect(result.current.rawHotkey).toBe('Ctrl+Space') // default, never updated
      })

      expect(window.electronAPI.registerHotkey).not.toHaveBeenCalled()
    })

    it('控制面板不应该注册快捷键', async () => {
      window.history.pushState({}, '', '/?panel=control')
      mockElectronAPI({
        getSetting: vi.fn().mockResolvedValue('Ctrl+Alt+X'),
      })

      const { result } = await renderUseHotkey()

      await vi.waitFor(() => {
        expect(result.current.rawHotkey).toBe('Ctrl+Space')
      })

      expect(window.electronAPI.registerHotkey).not.toHaveBeenCalled()
    })
  })

  describe('registerHotkey', () => {
    it('应该调用 IPC 注册并更新状态', async () => {
      mockElectronAPI({
        registerHotkey: vi.fn().mockResolvedValue({ success: true }),
      })

      const { result } = await renderUseHotkey()
      await vi.waitFor(() => expect(result.current.rawHotkey).toBeTruthy())

      let ok
      await act(async () => {
        ok = await result.current.registerHotkey('Ctrl+Shift+A')
      })

      expect(ok).toBe(true)
      expect(window.electronAPI.registerHotkey).toHaveBeenCalledWith('Ctrl+Shift+A')
      expect(result.current.rawHotkey).toBe('Ctrl+Shift+A')
    })

    it('注册失败时不应更新状态', async () => {
      mockElectronAPI({
        registerHotkey: vi.fn().mockResolvedValue({ success: false }),
      })

      const { result } = await renderUseHotkey()
      await vi.waitFor(() => expect(result.current.rawHotkey).toBeTruthy())

      const prevKey = result.current.rawHotkey

      let ok
      await act(async () => {
        ok = await result.current.registerHotkey('InvalidKey')
      })

      expect(ok).toBe(false)
      expect(result.current.rawHotkey).toBe(prevKey)
    })

    it('注册不同快捷键应触发新的 IPC 调用', async () => {
      mockElectronAPI({
        getSetting: vi.fn().mockResolvedValue('Ctrl+Space'),
        registerHotkey: vi.fn().mockResolvedValue({ success: true }),
      })

      const { result } = await renderUseHotkey()
      await vi.waitFor(() => expect(result.current.rawHotkey).toBe('Ctrl+Space'))

      // 清掉 init 的调用计数
      window.electronAPI.registerHotkey.mockClear()

      let ok
      await act(async () => {
        ok = await result.current.registerHotkey('Ctrl+Alt+X')
      })

      expect(ok).toBe(true)
      expect(window.electronAPI.registerHotkey).toHaveBeenCalledWith('Ctrl+Alt+X')
      expect(result.current.rawHotkey).toBe('Ctrl+Alt+X')
    })
  })

  describe('unregisterHotkey', () => {
    it('应该调用 IPC 取消注册', async () => {
      mockElectronAPI({
        getSetting: vi.fn().mockResolvedValue('Ctrl+Space'),
        unregisterHotkey: vi.fn().mockResolvedValue({ success: true }),
      })

      const { result } = await renderUseHotkey()
      await vi.waitFor(() => expect(result.current.rawHotkey).toBe('Ctrl+Space'))

      await act(async () => {
        await result.current.unregisterHotkey('Ctrl+Space')
      })

      expect(window.electronAPI.unregisterHotkey).toHaveBeenCalledWith('Ctrl+Space')
    })
  })

  describe('改键完整流程 — 切换模式 & 长按模式共用', () => {
    it('注销旧键 → 注册新键 → DB 持久化（模拟捕获面板）', async () => {
      const api = mockElectronAPI({
        getSetting: vi.fn().mockResolvedValue('Ctrl+Space'),
        registerHotkey: vi.fn().mockResolvedValue({ success: true }),
        unregisterHotkey: vi.fn().mockResolvedValue({ success: true }),
        setSetting: vi.fn().mockResolvedValue({}),
      })

      const { result } = await renderUseHotkey()
      await vi.waitFor(() => expect(result.current.rawHotkey).toBe('Ctrl+Space'))

      // 捕获面板操作：注销旧键
      await act(async () => {
        await result.current.unregisterHotkey('Ctrl+Space')
      })

      // 注册新键
      let ok
      await act(async () => {
        ok = await result.current.registerHotkey('Ctrl+Shift+L')
      })

      // 保存到数据库
      await act(async () => {
        await window.electronAPI.setSetting('global_hotkey', 'Ctrl+Shift+L')
      })

      expect(ok).toBe(true)
      expect(result.current.rawHotkey).toBe('Ctrl+Shift+L')
      expect(api.setSetting).toHaveBeenCalledWith('global_hotkey', 'Ctrl+Shift+L')
    })

    it('keyName 在切换和长按模式间保持一致', async () => {
      // rawHotkey 是切换模式 globalShortcut 注册和长按模式 KeyWatcher 入参的统一来源
      mockElectronAPI({
        getSetting: vi.fn().mockResolvedValue('Ctrl+Alt+X'),
      })

      const { result } = await renderUseHotkey()
      await vi.waitFor(() => expect(result.current.rawHotkey).toBe('Ctrl+Alt+X'))

      // 两种模式都使用同一个 rawHotkey 值
      const key = result.current.rawHotkey
      expect(key).toBe('Ctrl+Alt+X')

      // 验证 formatted 版本存在
      expect(result.current.hotkey).toBeTruthy()
      expect(result.current.hotkey).not.toBe(result.current.rawHotkey) // formatted vs raw
    })
  })

  describe('formatHotkey', () => {
    it('非 Mac 平台 Ctrl 保持为 Ctrl', async () => {
      Object.defineProperty(navigator, 'platform', { value: 'Linux x86_64', writable: true })

      mockElectronAPI({
        getSetting: vi.fn().mockResolvedValue('Ctrl+Shift+Space'),
      })

      const { result } = await renderUseHotkey()
      await vi.waitFor(() => expect(result.current.hotkey).toBe('Ctrl+⇧+空格'))
    })

    it('Mac 平台 Ctrl 显示为 ⌘', async () => {
      Object.defineProperty(navigator, 'platform', { value: 'MacIntel', writable: true })

      mockElectronAPI({
        getSetting: vi.fn().mockResolvedValue('Ctrl+Space'),
      })

      const { result } = await renderUseHotkey()
      await vi.waitFor(() => expect(result.current.hotkey).toBe('⌘+空格'))
    })
  })
})
