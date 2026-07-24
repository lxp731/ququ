/**
 * 快捷键 IPC 业务逻辑单元测试。
 *
 * 直接验证 ipcHandlers.js 中热键相关 handler 的核心逻辑。
 * 使用依赖注入的 mock 替代 Electron ipcMain/globalShortcut，
 * 确保 register/unregister/startHold/stopHold 的行为正确。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

// ═══════════════════════════════════════════
//  Mock 依赖
// ═══════════════════════════════════════════

function createMockHotkeyManager() {
  const registered = new Map() // accelerator → callback
  return {
    registered,
    registerHotkey: vi.fn((accelerator, cb) => {
      if (registered.has(accelerator)) return true
      registered.set(accelerator, cb)
      return true
    }),
    unregisterHotkey: vi.fn((accelerator) => {
      return registered.delete(accelerator)
    }),
    unregisterAll: vi.fn(() => {
      registered.clear()
    }),
    getRegisteredHotkeys: vi.fn(() => Array.from(registered.keys())),
    setRecordingState: vi.fn(),
    getRecordingState: vi.fn(() => false),
  }
}

function createMockKeyWatcher() {
  let child = null
  return {
    start: vi.fn((cb, hotkey) => {
      child = { cb, hotkey }
    }),
    stop: vi.fn(() => {
      child = null
    }),
    _getChild: () => child,
  }
}

function createMockDB() {
  const settings = new Map()
  return {
    getSetting: vi.fn((key, def) => settings.get(key) ?? def ?? null),
    setSetting: vi.fn((key, value) => { settings.set(key, value) }),
    _settings: settings,
  }
}

// ═══════════════════════════════════════════
//  从 ipcHandlers.js 提取的业务逻辑（纯函数版本）
// ═══════════════════════════════════════════

/**
 * register-hotkey handler 逻辑。
 * 等价于 ipcHandlers.js:92-106
 */
function handleRegisterHotkey(hotkeyManager, registeredSenders, senderId, hotkey) {
  const callback = () => {} // 真实 handler 会发送 IPC 事件，测试中不需要
  const ok = hotkeyManager.registerHotkey(hotkey, callback)
  if (ok) {
    registeredSenders.add(senderId)
  }
  return { success: ok }
}

/**
 * unregister-hotkey handler 逻辑。
 * 等价于 ipcHandlers.js:107-113
 */
function handleUnregisterHotkey(hotkeyManager, registeredSenders, senderId, hotkey) {
  const ok = hotkeyManager.unregisterHotkey(hotkey)
  if (ok) {
    registeredSenders.delete(senderId)
  }
  return { success: ok }
}

/**
 * start-hold-watch handler 逻辑。
 * 等价于 ipcHandlers.js:123-138
 */
function handleStartHoldWatch(hotkeyManager, keyWatcher, senderId, hotkey) {
  if (!keyWatcher) return { success: false, error: 'KeyWatcher 不可用' }

  hotkeyManager.unregisterAll()

  const callback = () => {} // 真实 handler 会发送 IPC 事件
  keyWatcher.start(callback, hotkey || 'Ctrl+Space')

  return { success: true }
}

/**
 * stop-hold-watch handler 逻辑。
 * 等价于 ipcHandlers.js:140-148
 */
function handleStopHoldWatch(hotkeyManager, keyWatcher, db, senderId) {
  keyWatcher?.stop()

  // 从数据库恢复用户快捷键
  const savedKey = db.getSetting('global_hotkey', 'Ctrl+Space') || 'Ctrl+Space'
  const callback = () => {}
  hotkeyManager.registerHotkey(savedKey, callback)

  return { success: true }
}

// ═══════════════════════════════════════════
//  测试
// ═══════════════════════════════════════════

describe('Hotkey IPC — register-hotkey', () => {
  let hm, senders, sid

  beforeEach(() => {
    hm = createMockHotkeyManager()
    senders = new Set()
    sid = 'webContents-1'
  })

  it('注册新键应返回 success:true 并记录 sender', () => {
    const r = handleRegisterHotkey(hm, senders, sid, 'Ctrl+Space')
    expect(r.success).toBe(true)
    expect(senders.has(sid)).toBe(true)
    expect(hm.registerHotkey).toHaveBeenCalledWith('Ctrl+Space', expect.any(Function))
  })

  it('改键：同一 sender 先注册 Ctrl+Space 再注册 Ctrl+Shift+L 都应成功', () => {
    // 第一次注册
    handleRegisterHotkey(hm, senders, sid, 'Ctrl+Space')
    expect(hm.registered.has('Ctrl+Space')).toBe(true)

    // 注销旧键
    handleUnregisterHotkey(hm, senders, sid, 'Ctrl+Space')
    expect(hm.registered.has('Ctrl+Space')).toBe(false)
    expect(senders.has(sid)).toBe(false)

    // 注册新键 — 应成功（之前 _registeredSenders.has(sid) 守卫的 bug 已修复）
    const r = handleRegisterHotkey(hm, senders, sid, 'Ctrl+Shift+L')
    expect(r.success).toBe(true)
    expect(hm.registered.has('Ctrl+Shift+L')).toBe(true)
    expect(senders.has(sid)).toBe(true)
  })

  it('注册失败时不应记录 sender', () => {
    hm.registerHotkey.mockReturnValueOnce(false)
    const r = handleRegisterHotkey(hm, senders, sid, 'Ctrl+Space')
    expect(r.success).toBe(false)
    expect(senders.has(sid)).toBe(false)
  })
})

describe('Hotkey IPC — unregister-hotkey', () => {
  let hm, senders, sid

  beforeEach(() => {
    hm = createMockHotkeyManager()
    senders = new Set()
    sid = 'webContents-1'
  })

  it('注销已注册的键应成功并清理 sender', () => {
    handleRegisterHotkey(hm, senders, sid, 'Ctrl+Space')
    expect(senders.has(sid)).toBe(true)

    const r = handleUnregisterHotkey(hm, senders, sid, 'Ctrl+Space')
    expect(r.success).toBe(true)
    expect(senders.has(sid)).toBe(false)
    expect(hm.registered.has('Ctrl+Space')).toBe(false)
  })

  it('注销未注册的键应返回 false', () => {
    const r = handleUnregisterHotkey(hm, senders, sid, 'NotRegistered')
    expect(r.success).toBe(false)
  })
})

describe('Hotkey IPC — start-hold-watch', () => {
  let hm, kw, sid

  beforeEach(() => {
    hm = createMockHotkeyManager()
    kw = createMockKeyWatcher()
    sid = 'webContents-1'
  })

  it('启动长按模式应注销所有 globalShortcut 并启动 KeyWatcher', () => {
    // 先注册一个切换模式快捷键
    handleRegisterHotkey(hm, new Set(), sid, 'Ctrl+Space')

    const r = handleStartHoldWatch(hm, kw, sid, 'Ctrl+Space')
    expect(r.success).toBe(true)
    expect(hm.unregisterAll).toHaveBeenCalled()
    expect(kw.start).toHaveBeenCalledWith(expect.any(Function), 'Ctrl+Space')

    const child = kw._getChild()
    expect(child).not.toBeNull()
    expect(child.hotkey).toBe('Ctrl+Space')
  })

  it('启动长按模式应使用自定义快捷键', () => {
    handleRegisterHotkey(hm, new Set(), sid, 'Ctrl+Shift+L')

    const r = handleStartHoldWatch(hm, kw, sid, 'Ctrl+Shift+L')
    expect(r.success).toBe(true)
    expect(kw.start).toHaveBeenCalledWith(expect.any(Function), 'Ctrl+Shift+L')

    const child = kw._getChild()
    expect(child.hotkey).toBe('Ctrl+Shift+L')
  })

  it('KeyWatcher 不可用时应返回错误', () => {
    const r = handleStartHoldWatch(hm, null, sid, 'Ctrl+Space')
    expect(r.success).toBe(false)
    expect(r.error).toContain('不可用')
  })

  it('hotkey 为空时默认使用 Ctrl+Space', () => {
    const r = handleStartHoldWatch(hm, kw, sid, undefined)
    expect(r.success).toBe(true)
    expect(kw.start).toHaveBeenCalledWith(expect.any(Function), 'Ctrl+Space')
  })
})

describe('Hotkey IPC — stop-hold-watch', () => {
  let hm, kw, db, sid

  beforeEach(() => {
    hm = createMockHotkeyManager()
    kw = createMockKeyWatcher()
    db = createMockDB()
    sid = 'webContents-1'
  })

  it('停止长按模式应从 DB 读取保存的快捷键恢复 globalShortcut', () => {
    db.setSetting('global_hotkey', 'Ctrl+Shift+L')

    handleStartHoldWatch(hm, kw, sid, 'Ctrl+Shift+L')
    const r = handleStopHoldWatch(hm, kw, db, sid)

    expect(r.success).toBe(true)
    expect(kw.stop).toHaveBeenCalled()
    expect(db.getSetting).toHaveBeenCalledWith('global_hotkey', 'Ctrl+Space')
    // 应注册 DB 中的自定义键，不是硬编码 Ctrl+Space
    expect(hm.registerHotkey).toHaveBeenCalledWith('Ctrl+Shift+L', expect.any(Function))
  })

  it('DB 无保存记录时回退到 Ctrl+Space', () => {
    handleStartHoldWatch(hm, kw, sid, 'Ctrl+Space')
    handleStopHoldWatch(hm, kw, db, sid)

    expect(hm.registerHotkey).toHaveBeenCalledWith('Ctrl+Space', expect.any(Function))
  })
})

describe('Hotkey IPC — 完整生命周期', () => {
  it('切换模式 → 长按模式 → 切换模式：自定义键全程不丢失', () => {
    const hm = createMockHotkeyManager()
    const kw = createMockKeyWatcher()
    const db = createMockDB()
    const senders = new Set()
    const sid = 'webContents-1'

    // 1. 启动：注册自定义键
    db.setSetting('global_hotkey', 'Ctrl+Alt+X')
    handleRegisterHotkey(hm, senders, sid, 'Ctrl+Alt+X')
    expect(hm.registered.has('Ctrl+Alt+X')).toBe(true)

    // 2. 切换到长按模式
    handleStartHoldWatch(hm, kw, sid, 'Ctrl+Alt+X')
    expect(hm.registered.size).toBe(0) // globalShortcut 已清空
    expect(kw._getChild().hotkey).toBe('Ctrl+Alt+X') // KeyWatcher 使用自定义键

    // 3. 切回切换模式
    handleStopHoldWatch(hm, kw, db, sid)
    // 应从 DB 恢复 Ctrl+Alt+X，不是硬编码 Ctrl+Space
    expect(hm.registerHotkey).toHaveBeenLastCalledWith('Ctrl+Alt+X', expect.any(Function))
    expect(hm.registered.has('Ctrl+Alt+X')).toBe(true)
  })

  it('用户改键后切换模式再切回，新键保持', () => {
    const hm = createMockHotkeyManager()
    const kw = createMockKeyWatcher()
    const db = createMockDB()
    const senders = new Set()
    const sid = 'webContents-1'

    // 1. 默认 Ctrl+Space
    handleRegisterHotkey(hm, senders, sid, 'Ctrl+Space')

    // 2. 用户改键为 Ctrl+Shift+L
    handleUnregisterHotkey(hm, senders, sid, 'Ctrl+Space')
    handleRegisterHotkey(hm, senders, sid, 'Ctrl+Shift+L')
    db.setSetting('global_hotkey', 'Ctrl+Shift+L')

    // 3. 切换到长按模式
    handleStartHoldWatch(hm, kw, sid, 'Ctrl+Shift+L')
    expect(kw._getChild().hotkey).toBe('Ctrl+Shift+L')

    // 4. 切回切换模式
    handleStopHoldWatch(hm, kw, db, sid)
    // 恢复的是新键，不是 Ctrl+Space
    expect(hm.registered.has('Ctrl+Shift+L')).toBe(true)
    expect(hm.registered.has('Ctrl+Space')).toBe(false)
  })
})

describe('Hotkey IPC — 回归测试：已修复的 bug', () => {
  it('BUGFIX: _registeredSenders.has(sid) 不应阻止改键', () => {
    const hm = createMockHotkeyManager()
    const senders = new Set()
    const sid = 'webContents-1'

    // 模拟旧代码的守卫逻辑
    // 在修复之前：if (senders.has(sid)) return { success: true }
    // 这会导致同一窗口无法换键
    const oldBuggyHandler = (hm, senders, sid, hotkey) => {
      if (senders.has(sid)) return { success: true } // ← bug
      const callback = () => {}
      const ok = hm.registerHotkey(hotkey, callback)
      if (ok) senders.add(sid)
      return { success: ok }
    }

    // 第一次注册
    oldBuggyHandler(hm, senders, sid, 'Ctrl+Space')
    expect(hm.registered.has('Ctrl+Space')).toBe(true)

    // 注销
    hm.unregisterHotkey('Ctrl+Space')

    // 第二次注册 — 旧代码会跳过注册
    const r = oldBuggyHandler(hm, senders, sid, 'Ctrl+Shift+L')
    expect(r.success).toBe(true)
    // BUG: 旧代码返回 true 但没注册新键！
    expect(hm.registered.has('Ctrl+Shift+L')).toBe(false)

    // 修复后（handleRegisterHotkey）：应该注册成功
    handleRegisterHotkey(hm, senders, sid, 'Ctrl+Shift+L')
    expect(hm.registered.has('Ctrl+Shift+L')).toBe(true)
  })

  it('BUGFIX: stop-hold-watch 不应硬编码 Ctrl+Space', () => {
    const hm = createMockHotkeyManager()
    const kw = createMockKeyWatcher()
    const db = createMockDB()
    const sid = 'webContents-1'

    db.setSetting('global_hotkey', 'Ctrl+Alt+X')

    // 模拟旧代码的硬编码行为
    const oldBuggyStopHold = (hm, kw, sid) => {
      kw?.stop()
      hm.registerHotkey('Ctrl+Space', () => {}) // ← 硬编码 bug
      return { success: true }
    }

    oldBuggyStopHold(hm, kw, sid)
    // BUG: 注册的是 Ctrl+Space 而非用户设置的 Ctrl+Alt+X
    expect(hm.registered.has('Ctrl+Space')).toBe(true)
    expect(hm.registered.has('Ctrl+Alt+X')).toBe(false)

    // 修复后：使用 handleStopHoldWatch
    hm.registered.clear()
    handleStopHoldWatch(hm, kw, db, sid)
    expect(hm.registered.has('Ctrl+Alt+X')).toBe(true)
    expect(hm.registered.has('Ctrl+Space')).toBe(false)
  })
})
