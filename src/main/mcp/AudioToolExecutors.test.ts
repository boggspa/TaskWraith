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

// Distinct metrics for a WINDOWED analyze (shorter duration/frames, different levels)
// so a test can prove a window measures the slice, not the whole file.
const FAKE_WINDOWED_META: AudioAnalysisMeta = {
  durationMs: 500,
  analysisSampleRate: 44100,
  channels: 2,
  frames: 22050,
  peak: 0.5,
  peakDbfs: -6.02,
  rms: 0.12,
  rmsDbfs: -18.42,
  clippedSamples: 0,
  clippedPercent: 0,
  silencePercent: 0
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
      // The real offscreen engine measures only the windowed slice when a window is
      // present, so a windowed call yields DIFFERENT metrics than the whole file. The
      // fake mirrors that observable contract: a window → a distinct windowed meta.
      if (input.startMs !== undefined && input.endMs !== undefined) {
        return { png: FAKE_PNG, meta: FAKE_WINDOWED_META }
      }
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
    expect(isAudioMcpToolName('inspect_audio_segment')).toBe(true)
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

describe('inspect_audio_segment', () => {
  it('threads the [startMs,endMs] window into the engine and returns an image block + group hint + window levels', async () => {
    const { executors, resolveAudioSource, getAnalyzeInput } = build()
    const result = await executors.executeAudioTool(
      'inspect_audio_segment',
      { sourcePath: 'clip.wav', startMs: 65000, endMs: 80000 },
      { appChatId: 'c1' }
    )
    expect(result.isError).toBeFalsy()
    expect(resolveAudioSource).toHaveBeenCalled()
    // The WINDOW reaches the engine (the math is enforced in-page; here we assert it's
    // forwarded, plus the clamped canvas dims + resolved bytes).
    expect(getAnalyzeInput()).toEqual({
      dataBase64: 'QUJD',
      mimeType: 'audio/wav',
      width: 1024,
      height: 256,
      startMs: 65000,
      endMs: 80000
    })
    // Rides the proven SANITIZED image media spine — a single waveform PNG block.
    const img = imageContent(result)
    expect(img?.mimeType).toBe('image/png')
    // The audio_segment group hint + the <m:ss>–<m:ss> window-range caption.
    expect(result.mediaRefHints?.groupKind).toBe('audio_segment')
    expect(result.mediaRefHints?.labels).toEqual(['1:05–1:20'])
    // The text summary is the WINDOW range + the WINDOWED levels (peak/RMS dBFS + silence%).
    expect(result.text).toContain('1:05–1:20')
    expect(result.text).toContain('-6.02 dBFS')
    expect(result.text).toContain('0% silent')
    // structuredContent carries the windowed meta + the window bounds/label.
    const sc = result.structuredContent as Record<string, unknown>
    expect(sc.windowStartMs).toBe(65000)
    expect(sc.windowEndMs).toBe(80000)
    expect(sc.windowLabel).toBe('1:05–1:20')
    expect(sc.durationMs).toBe(500)
    expect(sc.peakDbfs).toBe(-6.02)
    // Read-only: no produced file / no trusted AV channel.
    expect(result.trustedMediaRefs).toBeUndefined()
  })

  it('measures a DIFFERENT result for a window than the whole file (windowing is observable)', async () => {
    const { executors } = build()
    const whole = await executors.executeAudioTool('audio_analyze', { sourcePath: 'clip.wav' }, {})
    const windowed = await executors.executeAudioTool(
      'inspect_audio_segment',
      { sourcePath: 'clip.wav', startMs: 0, endMs: 500 },
      {}
    )
    const wholePayload = JSON.parse(whole.text) as Record<string, unknown>
    const windowedSc = windowed.structuredContent as Record<string, unknown>
    // Whole-file peakDbfs (-0.92) vs windowed (-6.02) — the slice is measured, not the file.
    expect(wholePayload.peakDbfs).toBe(-0.92)
    expect(windowedSc.peakDbfs).toBe(-6.02)
    expect(windowedSc.durationMs).not.toBe(wholePayload.durationMs)
  })

  it('rejects a missing window (no startMs/endMs) before reading the source', async () => {
    const { executors, resolveAudioSource, engine } = build()
    const result = await executors.executeAudioTool('inspect_audio_segment', { sourcePath: 'clip.wav' }, {})
    expect(result.isError).toBe(true)
    expect(result.text).toContain('provide startMs and endMs')
    expect(resolveAudioSource).not.toHaveBeenCalled()
    expect(engine.analyzeAudio).not.toHaveBeenCalled()
  })

  it('rejects an inverted / non-positive window (endMs <= startMs, negative startMs)', async () => {
    const { executors, engine } = build()
    for (const win of [
      { startMs: 5000, endMs: 5000 },
      { startMs: 8000, endMs: 2000 },
      { startMs: -1, endMs: 1000 }
    ]) {
      const result = await executors.executeAudioTool('inspect_audio_segment', { sourcePath: 'clip.wav', ...win }, {})
      expect(result.isError).toBe(true)
      expect(result.text).toContain('0 <= startMs < endMs')
    }
    expect(engine.analyzeAudio).not.toHaveBeenCalled()
  })

  it('rejects a non-finite window value (NaN/Infinity) as a missing window', async () => {
    const { executors, engine } = build()
    const result = await executors.executeAudioTool(
      'inspect_audio_segment',
      { sourcePath: 'clip.wav', startMs: 0, endMs: Infinity },
      {}
    )
    expect(result.isError).toBe(true)
    expect(result.text).toContain('provide startMs and endMs')
    expect(engine.analyzeAudio).not.toHaveBeenCalled()
  })

  it('surfaces a source-resolution (jail) failure as a tool error, never reaching the engine', async () => {
    const { executors, engine } = build({ source: { ok: false, reason: 'outside_allowed_roots' } })
    const result = await executors.executeAudioTool(
      'inspect_audio_segment',
      { sourcePath: '../etc/x.wav', startMs: 0, endMs: 1000 },
      {}
    )
    expect(result.isError).toBe(true)
    expect(result.text).toContain('could not read audio')
    expect(result.text).toContain('outside_allowed_roots')
    expect(engine.analyzeAudio).not.toHaveBeenCalled()
  })

  it('fails before reading the source when the canvas is oversized', async () => {
    const { executors, resolveAudioSource } = build()
    const result = await executors.executeAudioTool(
      'inspect_audio_segment',
      { sourcePath: 'clip.wav', startMs: 0, endMs: 1000, width: 8192, height: 8192 },
      {}
    )
    expect(result.isError).toBe(true)
    expect(result.text).toContain('waveform too large')
    expect(resolveAudioSource).not.toHaveBeenCalled()
  })

  it('surfaces a decode failure as a graceful tool error', async () => {
    const { executors } = build({
      engine: {
        analyzeAudio: vi.fn(async () => {
          throw new Error('Unable to decode audio data')
        })
      }
    })
    const result = await executors.executeAudioTool(
      'inspect_audio_segment',
      { sourcePath: 'clip.wav', startMs: 0, endMs: 1000 },
      {}
    )
    expect(result.isError).toBe(true)
    expect(result.text).toContain('Unable to decode audio data')
  })
})
