import { describe, it, expect, vi } from 'vitest'
import {
  AudioAnalysisInput,
  AudioAnalysisMeta,
  AudioRenderMeta,
  AudioRenderSpec,
  AUDIO_PEAKS_MAX_BUCKETS,
  AUDIO_PEAKS_TARGET_BUCKETS,
  createAudioToolExecutors,
  isAudioMcpToolName,
  MAX_AUDIO_DURATION_MS,
  normalizeHarvestedPeaks,
  type AudioEngine,
  type ResolvedAudioSource
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

const FAKE_ANALYSIS_META: AudioAnalysisMeta = {
  durationMs: 1000,
  analysisSampleRate: 44100,
  channels: 2,
  frames: 44100,
  peak: 0.9,
  peakDbfs: -0.92,
  rms: 0.3,
  rmsDbfs: -10.46,
  clippedSamples: 12,
  clippedPercent: 0.0136,
  silencePercent: 4.2
}

function build(overrides: { engine?: Partial<AudioEngine>; source?: ResolvedAudioSource } = {}) {
  let lastSpec: AudioRenderSpec | null = null
  let lastAnalyzeInput: AudioAnalysisInput | null = null
  const engine: AudioEngine = {
    renderWaveformPng: vi.fn(async (spec: AudioRenderSpec) => {
      lastSpec = spec
      return { png: FAKE_PNG, meta: metaFor(spec) }
    }),
    analyzeAudio: vi.fn(async (input: AudioAnalysisInput) => {
      lastAnalyzeInput = input
      return { png: FAKE_PNG, meta: FAKE_ANALYSIS_META }
    }),
    ...overrides.engine
  }
  const resolveAudioSource = vi.fn(
    async (): Promise<ResolvedAudioSource> =>
      overrides.source ?? { ok: true, dataBase64: 'QUJD', mimeType: 'audio/wav', byteLength: 1024 }
  )
  const executors = createAudioToolExecutors({ engine, resolveAudioSource })
  return {
    executors,
    engine,
    resolveAudioSource,
    getSpec: () => lastSpec,
    getAnalyzeInput: () => lastAnalyzeInput
  }
}

describe('isAudioMcpToolName', () => {
  it('recognizes the audio tools only', () => {
    expect(isAudioMcpToolName('audio_render_wav')).toBe(true)
    expect(isAudioMcpToolName('audio_analyze')).toBe(true)
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

describe('audio_analyze', () => {
  it('decodes the resolved source and returns a PNG block + analysis meta', async () => {
    const { executors, resolveAudioSource, getAnalyzeInput } = build()
    const result = await executors.executeAudioTool(
      'audio_analyze',
      { sourcePath: 'clip.wav' },
      { appChatId: 'c1' }
    )
    expect(result.isError).toBeFalsy()
    expect(resolveAudioSource).toHaveBeenCalled()
    const img = imageContent(result)
    expect(img?.mimeType).toBe('image/png')
    // Resolved bytes + clamped dims reach the engine.
    expect(getAnalyzeInput()).toEqual({
      dataBase64: 'QUJD',
      mimeType: 'audio/wav',
      width: 1024,
      height: 256
    })
    const payload = JSON.parse(result.text) as Record<string, unknown>
    expect(payload.ok).toBe(true)
    expect(payload.peakDbfs).toBe(-0.92)
    expect(payload.clippedSamples).toBe(12)
    // The executor merges source provenance into the meta.
    expect(payload.sourceMimeType).toBe('audio/wav')
    expect(payload.sourceBytes).toBe(1024)
  })

  it('fails before reading the source when the canvas is oversized', async () => {
    const { executors, resolveAudioSource, engine } = build()
    const result = await executors.executeAudioTool(
      'audio_analyze',
      { sourcePath: 'clip.wav', width: 8192, height: 8192 },
      {}
    )
    expect(result.isError).toBe(true)
    expect(result.text).toContain('waveform too large')
    expect(resolveAudioSource).not.toHaveBeenCalled()
    expect(engine.analyzeAudio).not.toHaveBeenCalled()
  })

  it('surfaces a source-resolution failure as a tool error', async () => {
    const { executors, engine } = build({ source: { ok: false, reason: 'outside_allowed_roots' } })
    const result = await executors.executeAudioTool('audio_analyze', { sourcePath: '../etc/x.wav' }, {})
    expect(result.isError).toBe(true)
    expect(result.text).toContain('could not read audio')
    expect(result.text).toContain('outside_allowed_roots')
    expect(engine.analyzeAudio).not.toHaveBeenCalled()
  })

  it('surfaces a decode failure as a tool error', async () => {
    const { executors } = build({
      engine: {
        analyzeAudio: vi.fn(async () => {
          throw new Error('Unable to decode audio data')
        })
      }
    })
    const result = await executors.executeAudioTool('audio_analyze', { sourcePath: 'clip.wav' }, {})
    expect(result.isError).toBe(true)
    expect(result.text).toContain('Unable to decode audio data')
  })
})

describe('normalizeHarvestedPeaks (waveform peaks shape contract)', () => {
  it('passes a well-formed envelope through, coercing to ints', () => {
    const out = normalizeHarvestedPeaks([0, 1, 127, 254.6, 255])
    expect(out).toEqual([0, 1, 127, 255, 255])
    // Every bucket is an int in 0..255.
    for (const v of out!) {
      expect(Number.isInteger(v)).toBe(true)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(255)
    }
  })

  it('clamps out-of-range values into 0..255 (no negatives, no >255)', () => {
    expect(normalizeHarvestedPeaks([-50, -1, 256, 9999])).toEqual([0, 0, 255, 255])
  })

  it('coerces non-finite buckets to 0 rather than dropping them (length preserved)', () => {
    const out = normalizeHarvestedPeaks([10, NaN, Infinity, -Infinity, 20])
    expect(out).toEqual([10, 0, 0, 0, 20])
  })

  it('HARD-caps the array at AUDIO_PEAKS_MAX_BUCKETS (512)', () => {
    const oversized = Array.from({ length: 4000 }, () => 200)
    const out = normalizeHarvestedPeaks(oversized)
    expect(out).toHaveLength(AUDIO_PEAKS_MAX_BUCKETS)
    expect(AUDIO_PEAKS_MAX_BUCKETS).toBe(512)
    // The target the page is asked for is the more modest 256.
    expect(AUDIO_PEAKS_TARGET_BUCKETS).toBe(256)
  })

  it('returns undefined for a non-array / empty input (ref omits peaks → poster fallback)', () => {
    expect(normalizeHarvestedPeaks(undefined)).toBeUndefined()
    expect(normalizeHarvestedPeaks(null)).toBeUndefined()
    expect(normalizeHarvestedPeaks([])).toBeUndefined()
    expect(normalizeHarvestedPeaks('not-an-array')).toBeUndefined()
    expect(normalizeHarvestedPeaks({ 0: 1 })).toBeUndefined()
  })

  it('stays compact: a 256-bucket envelope serializes well under the 180KB projection cap', () => {
    const full = normalizeHarvestedPeaks(Array.from({ length: 256 }, (_, i) => i % 256))
    expect(full).toHaveLength(256)
    const bytes = JSON.stringify(full).length
    expect(bytes).toBeLessThan(1500)
  })
})
