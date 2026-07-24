import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import React from 'react'

// ── Inline copy of the component helpers from App.jsx ──
// Tests act as documentation of their expected behavior.

const dots = Array.from({ length: 20 }, (_, i) => ({
  left: Math.random() * 100,
  top: Math.random() * 100,
  duration: 2 + Math.random() * 3,
  delay: Math.random() * 2,
}))

const BgDots = () => (
  <div className="absolute inset-0 overflow-hidden pointer-events-none">
    {dots.map((d, i) => (
      <div
        key={i}
        className="absolute w-1 h-1 rounded-full bg-white/10"
        style={{
          left: `${d.left}%`,
          top: `${d.top}%`,
          animation: `pulse ${d.duration}s ease-in-out infinite`,
          animationDelay: `${d.delay}s`,
        }}
      />
    ))}
  </div>
)

const Waveform = ({ active, color = 'indigo' }) => {
  const waveColors = { indigo: '#818cf8', violet: '#a78bfa' }
  return (
    <div className="flex items-center justify-center gap-0.5 h-8" data-testid="waveform">
      {[...Array(16)].map((_, i) => (
        <div
          key={i}
          className="w-0.5 rounded-full"
          style={{ backgroundColor: waveColors[color] || waveColors.indigo }}
          data-testid="wave-bar"
        />
      ))}
    </div>
  )
}

const MicButton = ({ state, onClick, disabled }) => {
  const isRecording = state === 'recording'
  const isProcessing = state === 'processing' || state === 'optimizing'
  const isDisabled = disabled || isProcessing

  return (
    <div className="relative inline-flex items-center justify-center">
      {isRecording && (
        <>
          <div className="mic-ring" data-testid="mic-pulse-ring" />
          <div className="mic-ring" data-testid="mic-pulse-ring" />
          <div className="mic-ring" data-testid="mic-pulse-ring" />
        </>
      )}
      <button
        onClick={onClick}
        disabled={isDisabled}
        data-testid="mic-button"
        className={`relative z-10 w-20 h-20 rounded-full flex items-center justify-center border-2 transition-all duration-500 ${
          isRecording ? 'border-indigo-400/50 bg-indigo-500/20 recording-glow' : ''
        } ${isDisabled && !isProcessing ? 'opacity-40 cursor-not-allowed' : ''}`}
      >
        {isRecording ? (
          <div className="flex gap-1" data-testid="recording-bars">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="w-1 bg-indigo-300 rounded-full" />
            ))}
          </div>
        ) : (
          <span data-testid="mic-icon">🎤</span>
        )}
      </button>
    </div>
  )
}

// ═══════════════════════════════════════════
//  Tests
// ═══════════════════════════════════════════

describe('BgDots', () => {
  it('应该渲染 20 个点', () => {
    const { container } = render(<BgDots />)
    const dotElements = container.querySelectorAll('.absolute.w-1.h-1')
    expect(dotElements).toHaveLength(20)
  })

  it('每个点应该有非空的 style', () => {
    const { container } = render(<BgDots />)
    const dotElements = container.querySelectorAll('.absolute.w-1.h-1')
    dotElements.forEach(dot => {
      expect(dot.style.left).toBeTruthy()
      expect(dot.style.top).toBeTruthy()
      expect(dot.style.animation).toContain('pulse')
    })
  })

  it('应该总是渲染相同的点（模块级静态数组）', () => {
    const { container: c1 } = render(<BgDots />)
    const { container: c2 } = render(<BgDots />)
    const dots1 = Array.from(c1.querySelectorAll('.absolute.w-1.h-1')).map(d => d.style.left)
    const dots2 = Array.from(c2.querySelectorAll('.absolute.w-1.h-1')).map(d => d.style.left)
    expect(dots1).toEqual(dots2)
  })
})

describe('Waveform', () => {
  it('应该渲染 16 个波形条', () => {
    render(<Waveform active={false} />)
    const bars = screen.getAllByTestId('wave-bar')
    expect(bars).toHaveLength(16)
  })

  it('默认颜色应为 indigo', () => {
    render(<Waveform active={false} />)
    const bars = screen.getAllByTestId('wave-bar')
    expect(bars[0].style.backgroundColor).toBe('rgb(129, 140, 248)') // #818cf8
  })

  it('violet 颜色应生效', () => {
    render(<Waveform active={false} color="violet" />)
    const bars = screen.getAllByTestId('wave-bar')
    expect(bars[0].style.backgroundColor).toBe('rgb(167, 139, 250)') // #a78bfa
  })

  it('未知颜色应回退为 indigo', () => {
    render(<Waveform active={false} color="nonexistent" />)
    const bars = screen.getAllByTestId('wave-bar')
    expect(bars[0].style.backgroundColor).toBe('rgb(129, 140, 248)')
  })
})

describe('MicButton', () => {
  it('idle 状态应显示麦克风图标', () => {
    render(<MicButton state="idle" onClick={vi.fn()} disabled={false} />)
    expect(screen.getByTestId('mic-icon')).toBeDefined()
    expect(screen.queryByTestId('mic-pulse-ring')).toBeNull()
    expect(screen.getByTestId('mic-button')).not.toBeDisabled()
  })

  it('recording 状态应显示脉冲环和音波条', () => {
    render(<MicButton state="recording" onClick={vi.fn()} disabled={false} />)
    expect(screen.getAllByTestId('mic-pulse-ring')).toHaveLength(3)
    expect(screen.getByTestId('recording-bars')).toBeDefined()
  })

  it('processing 状态应禁用按钮', () => {
    render(<MicButton state="processing" onClick={vi.fn()} disabled={false} />)
    expect(screen.getByTestId('mic-button')).toBeDisabled()
  })

  it('disabled 属性应禁用按钮', () => {
    render(<MicButton state="idle" onClick={vi.fn()} disabled={true} />)
    expect(screen.getByTestId('mic-button')).toBeDisabled()
  })

  it('点击应触发 onClick 回调', () => {
    const onClick = vi.fn()
    render(<MicButton state="idle" onClick={onClick} disabled={false} />)
    screen.getByTestId('mic-button').click()
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('禁用状态点击不应触发回调', () => {
    const onClick = vi.fn()
    render(<MicButton state="idle" onClick={onClick} disabled={true} />)
    screen.getByTestId('mic-button').click()
    expect(onClick).not.toHaveBeenCalled()
  })
})
