import { vi } from 'vitest'

// jsdom-only setup — skipped in node environment tests
if (typeof window !== 'undefined') {
  // @testing-library/jest-dom matchers
  const { default: matchers } = await import('@testing-library/jest-dom/vitest')

  // ── Mock navigator APIs ──
  Object.defineProperty(navigator, 'mediaDevices', {
    value: { getUserMedia: vi.fn() },
    writable: true,
  })

  Object.defineProperty(navigator, 'platform', {
    value: 'Linux x86_64',
    writable: true,
  })

  // ── Mock AudioContext ──
  window.AudioContext = vi.fn(function () {
    return {
      sampleRate: 16000,
      decodeAudioData: vi.fn().mockResolvedValue({
        length: 1000,
        sampleRate: 16000,
        numberOfChannels: 1,
        getChannelData: () => new Float32Array(1000),
      }),
      close: vi.fn(),
    }
  })

  // ── Mock MediaRecorder ──
  window.MediaRecorder = vi.fn().mockImplementation(() => ({
    start: vi.fn(),
    stop: vi.fn(),
    ondataavailable: null,
    onstop: null,
    onerror: null,
  }))
}
