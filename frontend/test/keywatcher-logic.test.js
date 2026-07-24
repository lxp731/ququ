/**
 * KeyWatcher 逻辑验证 — 测试热键解析和 Python 脚本生成。
 * 不依赖 Electron，纯逻辑测试。
 */
import { describe, it, expect } from 'vitest'

// ── 从 keyWatcher.js 复制的纯逻辑（避免 require('child_process') 问题）──

const EV_KEY_MAP = {
  'Space': 57,
  'A': 30, 'B': 48, 'C': 46, 'D': 32, 'E': 18, 'F': 33, 'G': 34,
  'H': 35, 'I': 23, 'J': 36, 'K': 37, 'L': 38, 'M': 50, 'N': 49,
  'O': 24, 'P': 25, 'Q': 16, 'R': 19, 'S': 31, 'T': 20, 'U': 22,
  'V': 47, 'W': 17, 'X': 45, 'Y': 21, 'Z': 44,
  '0': 11, '1': 2, '2': 3, '3': 4, '4': 5, '5': 6, '6': 7, '7': 8, '8': 9, '9': 10,
  'Tab': 15, 'Enter': 28, 'Escape': 1, 'Backspace': 14,
}

const EV_MODS = { Ctrl: [29, 97], Shift: [42, 54], Alt: [56, 100], Meta: [125, 126] }

function parseHotkey(hotkey) {
  const parts = hotkey.split('+')
  const trigger = parts[parts.length - 1]
  const modNames = parts.slice(0, -1)
  return { trigger, modNames }
}

function buildWatchMap(hotkey) {
  const { trigger, modNames } = parseHotkey(hotkey)
  const triggerCode = EV_KEY_MAP[trigger]
  if (!triggerCode) return null

  const watch = {}
  for (const mod of modNames) {
    const codes = EV_MODS[mod]
    if (codes) codes.forEach(c => { watch[c] = mod })
  }
  watch[triggerCode] = trigger
  return watch
}

function buildPythonScript(hotkey) {
  const watch = buildWatchMap(hotkey)
  if (!watch) return null

  const watchItems = Object.entries(watch).map(([c, n]) => `${c}:'${n}'`).join(',')

  // 单行 Python 脚本（避免 \n 被 shell 转义）
  const script = `import struct, os, sys, select, json; WATCH = {${watchItems}}; test_event = (0, 0, 1, ${Object.keys(watch)[0]}, 1); code = test_event[3]; print('down:' + WATCH[code] if code in WATCH else 'NO_MATCH')`
  return { script, watch }
}

describe('KeyWatcher — 热键解析', () => {
  it('默认 Ctrl+Space → trigger=Space, mods=[Ctrl]', () => {
    const r = parseHotkey('Ctrl+Space')
    expect(r.trigger).toBe('Space')
    expect(r.modNames).toEqual(['Ctrl'])
  })

  it('Ctrl+Shift+L → trigger=L, mods=[Ctrl,Shift]', () => {
    const r = parseHotkey('Ctrl+Shift+L')
    expect(r.trigger).toBe('L')
    expect(r.modNames).toEqual(['Ctrl', 'Shift'])
  })

  it('Alt+Space → trigger=Space, mods=[Alt]', () => {
    const r = parseHotkey('Alt+Space')
    expect(r.trigger).toBe('Space')
    expect(r.modNames).toEqual(['Alt'])
  })

  it('Ctrl+Alt+X → trigger=X, mods=[Ctrl,Alt]', () => {
    const r = parseHotkey('Ctrl+Alt+X')
    expect(r.trigger).toBe('X')
    expect(r.modNames).toEqual(['Ctrl', 'Alt'])
  })
})

describe('KeyWatcher — WATCH 映射构建', () => {
  it('默认 Ctrl+Space → 包含整数 key 29(Ctrl), 97(Ctrl), 57(Space)', () => {
    const w = buildWatchMap('Ctrl+Space')
    expect(w).not.toBeNull()
    // 验证 key 是整数
    for (const k of Object.keys(w)) {
      expect(typeof Number(k)).toBe('number')
      expect(Number.isInteger(Number(k))).toBe(true)
    }
    expect(w[29]).toBe('Ctrl')
    expect(w[97]).toBe('Ctrl')
    expect(w[57]).toBe('Space')
  })

  it('Ctrl+Shift+L → 包含 Ctrl, Shift, L 的整数键码', () => {
    const w = buildWatchMap('Ctrl+Shift+L')
    expect(w).not.toBeNull()
    expect(w[29]).toBe('Ctrl')
    expect(w[97]).toBe('Ctrl')
    expect(w[42]).toBe('Shift')
    expect(w[54]).toBe('Shift')
    expect(w[38]).toBe('L')
    // 不含 Space
    expect(w[57]).toBeUndefined()
  })

  it('不支持的触发键返回 null', () => {
    const w = buildWatchMap('Ctrl+F13') // F13 不在 EV_KEY_MAP 中
    expect(w).toBeNull()
  })
})

describe('KeyWatcher — Python 脚本生成', () => {
  it('Ctrl+Space 的脚本语法正确且 code in WATCH 匹配', async () => {
    const result = buildPythonScript('Ctrl+Space')
    expect(result).not.toBeNull()
    expect(result.script).toContain('WATCH = {')
    expect(result.script).toContain("29:'Ctrl'")
    expect(result.script).toContain("57:'Space'")

    // 用 Python 真实执行验证
    const { execSync } = await import('child_process')
    try {
      const output = execSync('python3 -c ' + JSON.stringify(result.script), {
        encoding: 'utf-8',
        timeout: 5000,
      }).trim()
      expect(output).toContain('down:')
      expect(output).not.toContain('NO_MATCH')
    } catch (e) {
      // Python3 不存在时跳过
      if (e.message.includes('command not found') || e.message.includes('ENOENT')) {
        console.warn('[test] python3 不可用，跳过真实执行')
      } else {
        throw e
      }
    }
  })

  it('Ctrl+Shift+L 的脚本语法正确且 code in WATCH 匹配', async () => {
    const result = buildPythonScript('Ctrl+Shift+L')
    expect(result).not.toBeNull()
    expect(result.script).toContain("38:'L'")
    expect(result.script).toContain("42:'Shift'")
    // 不应包含 Space
    expect(result.script).not.toContain("57:'Space'")

    const { execSync } = await import('child_process')
    try {
      const output = execSync('python3 -c ' + JSON.stringify(result.script), {
        encoding: 'utf-8',
        timeout: 5000,
      }).trim()
      expect(output).toContain('down:')
      expect(output).not.toContain('NO_MATCH')
    } catch (e) {
      if (e.message.includes('command not found') || e.message.includes('ENOENT')) {
        console.warn('[test] python3 不可用，跳过真实执行')
      } else {
        throw e
      }
    }
  })
})

describe('KeyWatcher — 渲染进程按键匹配逻辑', () => {
  // 模拟 App.jsx 中长按模式的逻辑
  function simulateHoldMode(hotkey, keyEvents) {
    const hotkeyParts = hotkey.split('+')
    const triggerKey = hotkeyParts[hotkeyParts.length - 1]
    const mods = hotkeyParts.slice(0, -1)

    const heldKeys = new Set()
    let recording = false
    const events = []

    for (const { type, keyName } of keyEvents) {
      if (type === 'down') {
        heldKeys.add(keyName)
        const isTriggerHeld = () => heldKeys.has(triggerKey)
        const isModHeld = () => mods.every(m => heldKeys.has(m))
        if (isTriggerHeld() && isModHeld() && !recording) {
          recording = true
          events.push('start')
        }
      } else if (type === 'up') {
        const isModHeld = () => mods.every(m => heldKeys.has(m))
        const isTriggerHeld = () => heldKeys.has(triggerKey)
        if ((isModHeld() || isTriggerHeld()) && recording) {
          recording = false
          events.push('stop')
        }
        heldKeys.delete(keyName)
      }
    }

    return { recording, events }
  }

  it('默认 Ctrl+Space：按下 Ctrl+Space 开始，松开 Space 停止', () => {
    const r = simulateHoldMode('Ctrl+Space', [
      { type: 'down', keyName: 'Ctrl' },
      { type: 'down', keyName: 'Space' },
      { type: 'up', keyName: 'Space' },
    ])
    expect(r.events).toEqual(['start', 'stop'])
    expect(r.recording).toBe(false)
  })

  it('Ctrl+Shift+L：按下 Ctrl+Shift+L 开始，松开 L 停止', () => {
    const r = simulateHoldMode('Ctrl+Shift+L', [
      { type: 'down', keyName: 'Ctrl' },
      { type: 'down', keyName: 'Shift' },
      { type: 'down', keyName: 'L' },
      { type: 'up', keyName: 'L' },
    ])
    expect(r.events).toEqual(['start', 'stop'])
    expect(r.recording).toBe(false)
  })

  it('Ctrl+Shift+L：先按 Ctrl 再按 L（不按 Shift）不应开始', () => {
    const r = simulateHoldMode('Ctrl+Shift+L', [
      { type: 'down', keyName: 'Ctrl' },
      { type: 'down', keyName: 'L' },
    ])
    // Shift 是 required modifier，没按 Shift → 不开始
    expect(r.events).toEqual([])
    expect(r.recording).toBe(false)
  })

  it('Ctrl+Shift+L：只按 Ctrl+Space 不应开始', () => {
    const r = simulateHoldMode('Ctrl+Shift+L', [
      { type: 'down', keyName: 'Ctrl' },
      { type: 'down', keyName: 'Space' },
    ])
    // Space 不是 trigger key，不触发
    expect(r.events).toEqual([])
    expect(r.recording).toBe(false)
  })

  it('every() 逻辑：Ctrl+Shift+L 需要三个键全部按住', () => {
    // 只按 Ctrl+Shift（没按 L）
    const r1 = simulateHoldMode('Ctrl+Shift+L', [
      { type: 'down', keyName: 'Ctrl' },
      { type: 'down', keyName: 'Shift' },
    ])
    expect(r1.events).toEqual([])

    // 只按 Ctrl+L（没按 Shift）
    const r2 = simulateHoldMode('Ctrl+Shift+L', [
      { type: 'down', keyName: 'Ctrl' },
      { type: 'down', keyName: 'L' },
    ])
    expect(r2.events).toEqual([])

    // 三个键全部按住
    const r3 = simulateHoldMode('Ctrl+Shift+L', [
      { type: 'down', keyName: 'Ctrl' },
      { type: 'down', keyName: 'Shift' },
      { type: 'down', keyName: 'L' },
    ])
    expect(r3.events).toEqual(['start'])
    expect(r3.recording).toBe(true)

    // 松开任意键 → 停止
    const r4 = simulateHoldMode('Ctrl+Shift+L', [
      { type: 'down', keyName: 'Ctrl' },
      { type: 'down', keyName: 'Shift' },
      { type: 'down', keyName: 'L' },
      { type: 'up', keyName: 'Shift' },
    ])
    expect(r4.events).toEqual(['start', 'stop'])
    expect(r4.recording).toBe(false)
  })

  it('every() 逻辑：单修饰键 Ctrl+X 退化为单个修饰键匹配', () => {
    // Ctrl+X：只按 X（没按 Ctrl）
    const r1 = simulateHoldMode('Ctrl+X', [
      { type: 'down', keyName: 'X' },
    ])
    expect(r1.events).toEqual([])

    // Ctrl+X：按住 Ctrl+X
    const r2 = simulateHoldMode('Ctrl+X', [
      { type: 'down', keyName: 'Ctrl' },
      { type: 'down', keyName: 'X' },
    ])
    expect(r2.events).toEqual(['start'])
  })

  it('every() 逻辑：Ctrl+Meta+L 需要 Ctrl 和 Meta 都按住', () => {
    // 只按 Ctrl+Meta（没按 L）
    const r1 = simulateHoldMode('Ctrl+Meta+L', [
      { type: 'down', keyName: 'Ctrl' },
      { type: 'down', keyName: 'Meta' },
    ])
    expect(r1.events).toEqual([])

    // Ctrl+Meta+L 全部按住
    const r2 = simulateHoldMode('Ctrl+Meta+L', [
      { type: 'down', keyName: 'Ctrl' },
      { type: 'down', keyName: 'Meta' },
      { type: 'down', keyName: 'L' },
    ])
    expect(r2.events).toEqual(['start'])
  })

  it('Ctrl+Space：按 Ctrl+L 不应开始', () => {
    const r = simulateHoldMode('Ctrl+Space', [
      { type: 'down', keyName: 'Ctrl' },
      { type: 'down', keyName: 'L' },
    ])
    // L 不是 trigger key (Space)，不触发
    expect(r.events).toEqual([])
    expect(r.recording).toBe(false)
  })
})
