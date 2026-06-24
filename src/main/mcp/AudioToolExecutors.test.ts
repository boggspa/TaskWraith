import { describe, it, expect, vi } from 'vitest'
import {
  AudioRenderMeta,
  AudioRenderSpec,
  createAudioToolExecutors,
  isAudioMcpToolName,
  MAX_AUDIO_DURATION_MS,
  type AudioEngine
} from './AudioToolExecutors'

// PNG magic header so sniffImageMime() classifies our fake as raster PNG.
const FAKE_PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('fake-png-body')
])

function metaFor(spec: AudioRenderSpec): AudioRenderMeta {
  return {
    sampleRate: spec.sampleRate,
    frames: spec.frames,
    durationMs: spec.durationMs,
    channels: 1,
    waveform: spec.waveform,
    frequencyHz: spec.frequencyHz,
    gain: spec.gain,
    peak: 0.8,
    rms: 0.56,
    peakDbfs: -1.94,
    wavByteLength: 44 + spec.frames * 2,
    wavHeaderOk: true
  }
}

function imageContent(result: { content?: Array<{ type: string }> }) {
  return (result.content ?? []).find((b) => b.type === 'image') as
    | { type: 'image'; mimeType: string; data: string }
    | undefined
}

function build(overrides: { engine?: Partial<AudioEngine> } = {}) {
  let lastSpec: AudioRenderSpec | null = null
  const engine: AudioEngine = {
    renderWaveformPng: vi.fn(async (spec: AudioRenderSpec) => {
      lastSpec = spec
      return { png: FAKE_PNG, meta: metaFor(spec) }
    }),
    ...overrides.engine
  }
  const executors = createAudioToolExecutors({ engine })
  return { executors, engine, getSpec: () => lastSpec }
}

describe('isAudioMcpToolName', () => {
  it('recognizes the audio tool only', () => {
    expect(isAudioMcpToolName('audio_render_wav')).toBe(true)
    expect(isAudioMcpToolName('image_edit')).toBe(false)
    expect(isAudioMcpToolName('canvas_screenshot')).toBe(false)
  })
})

describe('audio_render_wav', () => {
  it('renders a tone with defaults and returns a PNG image block + meta', async () => {
    const { executors, getSpec } = build()
    const result = await executors.executeAudioTool('audio_render_wav', {}, {})
    expect(result.isError).toBeFalsy()
    const img = imageContent(result)
    expect(img?.mimeType).toBe('image/png')
    expect(img?.data).toBe(FAKE_PNG.toString('base64'))
    const spec = getSpec()
    expect(spec).not.toBeNull()
    // Defaults: 440Hz sine, 1s @ 44100, full-width waveform.
    expect(spec?.frequencyHz).toBe(440)
    expect(spec?.waveform).toBe('sine')
    expect(spec?.sampleRate).toBe(44100)
    expect(spec?.frames).toBe(44100)
    const payload = JSON.parse(result.text) as Record<string, unknown>
    expect(payload.ok).toBe(true)
    expect(payload.wavHeaderOk).toBe(true)
    expect(payload.peakDbfs).toBe(-1.94)
  })

  it('clamps duration to the hard cap', async () => {
    const { executors, getSpec } = build()
    await executors.executeAudioTool('audio_render_wav', { durationMs: 999_999 }, {})
    expect(getSpec()?.durationMs).toBe(MAX_AUDIO_DURATION_MS)
    expect(getSpec()?.frames).toBe((44100 * MAX_AUDIO_DURATION_MS) / 1000)
  })

  it('snaps an odd sample rate to the nearest allowed rate', async () => {
    const { executors, getSpec } = build()
    await executors.executeAudioTool('audio_render_wav', { sampleRate: 43000 }, {})
    expect(getSpec()?.sampleRate).toBe(44100)
  })

  it('bounds frequency by Nyquist for a low sample rate', async () => {
    const { executors, getSpec } = build()
    await executors.executeAudioTool(
      'audio_render_wav',
      { sampleRate: 8000, frequencyHz: 19000 },
      {}
    )
    // Nyquist for 8kHz is 4000; frequency is clamped below it.
    expect(getSpec()?.frequencyHz).toBeLessThan(4000)
  })

  it('falls back to a sine for an unknown waveform', async () => {
    const { executors, getSpec } = build()
    await executors.executeAudioTool('audio_render_wav', { waveform: 'noise' }, {})
    expect(getSpec()?.waveform).toBe('sine')
  })

  it('rejects an oversized canvas before calling the engine', async () => {
    const { executors, engine } = build()
    const result = await executors.executeAudioTool(
      'audio_render_wav',
      { width: 8192, height: 8192 },
      {}
    )
    expect(result.isError).toBe(true)
    expect(result.text).toContain('waveform too large')
    expect(engine.renderWaveformPng).not.toHaveBeenCalled()
  })

  it('surfaces an engine failure as a tool error', async () => {
    const { executors } = build({
      engine: {
        renderWaveformPng: vi.fn(async () => {
          throw new Error('OfflineAudioContext unavailable')
        })
      }
    })
    const result = await executors.executeAudioTool('audio_render_wav', {}, {})
    expect(result.isError).toBe(true)
    expect(result.text).toContain('OfflineAudioContext unavailable')
  })

  it('rejects non-raster engine output (C2 output sniff)', async () => {
    const { executors } = build({
      engine: {
        renderWaveformPng: vi.fn(async (spec: AudioRenderSpec) => ({
          png: Buffer.from('<svg></svg>'),
          meta: metaFor(spec)
        }))
      }
    })
    const result = await executors.executeAudioTool('audio_render_wav', {}, {})
    expect(result.isError).toBe(true)
    expect(result.text).toContain('not a raster image')
  })
})
