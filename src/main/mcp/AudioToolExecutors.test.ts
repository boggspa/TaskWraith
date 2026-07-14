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
  MAX_AUDIO_SEGMENT_CLIP_MS,
  normalizeHarvestedPeaks,
  type AudioEngine,
  type AudioToolExecutorDeps,
  type ResolvedAudioSource,
  type WindowClipProduction
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

// A well-formed default window-clip production: a content-addressed WAV + peaks + a
// thumbnail + a windowed transcript. Tests override pieces to prove the no-transcript /
// reject paths.
const FAKE_WINDOW_CLIP: WindowClipProduction = {
  sha256: 'a'.repeat(43),
  byteLength: 64_000,
  durationMs: 15_000,
  peaks: [0, 64, 128, 255, 200, 12],
  thumbnail: { dataBase64: 'thumb', mimeType: 'image/jpeg', width: 320, height: 80 },
  transcript: 'the chorus kicks in here',
  segments: [{ text: 'the chorus kicks in here', startMs: 0, endMs: 15_000, confidence: 0.94 }]
}

function build(
  overrides: {
    engine?: Partial<AudioEngine>
    source?: ResolvedAudioSource
    jailAudio?: AudioToolExecutorDeps['jailAudio']
    produceWindowClip?: AudioToolExecutorDeps['produceWindowClip']
    /** Omit the two window-clip deps entirely (proves the not-configured guard). */
    omitWindowDeps?: boolean
  } = {}
) {
  let lastSpec: AudioRenderSpec | null = null
  let lastAnalyzeInput: AudioAnalysisInput | null = null
  let lastWindowClipArgs: { sourcePath: string; startMs: number; endMs: number } | null = null
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
  // Default jail: succeeds, returns a real path. Tests override to a rejection.
  const cleanupStagedInput = vi.fn(() => true)
  const jailAudio =
    overrides.jailAudio ??
    vi.fn((_args: Record<string, unknown>) => ({
      ok: true as const,
      realPath: '/ws/clip.wav',
      cleanup: cleanupStagedInput
    }))
  // Default producer: a well-formed clip with peaks + transcript. Tests override to
  // omit the transcript or to throw (daemon/persist failure).
  const produceWindowClip =
    overrides.produceWindowClip ??
    vi.fn(async (sourcePath: string, startMs: number, endMs: number) => {
      lastWindowClipArgs = { sourcePath, startMs, endMs }
      return { ...FAKE_WINDOW_CLIP }
    })
  const deps: AudioToolExecutorDeps = overrides.omitWindowDeps
    ? { engine, resolveAudioSource }
    : { engine, resolveAudioSource, jailAudio, produceWindowClip }
  const executors = createAudioToolExecutors(deps)
  return {
    executors,
    engine,
    resolveAudioSource,
    jailAudio,
    produceWindowClip,
    cleanupStagedInput,
    getSpec: () => lastSpec,
    getAnalyzeInput: () => lastAnalyzeInput,
    getWindowClipArgs: () => lastWindowClipArgs
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

// inspect_audio_segment v2 — emits a PLAYABLE, content-addressed windowed clip as a
// TRUSTED-AV media ref (peaks + caption) via produceWindowClip, NOT a waveform PNG. The
// windowed transcript (Item 2) rides best-effort in the result text. The clip writes only
// the internal asset store, never the workspace (still read-only-safe).
describe('inspect_audio_segment (interactive clip)', () => {
  it('waits for an asynchronous jail before producing the window clip', async () => {
    const cleanup = vi.fn(() => true)
    let resolveJail!: (value: {
      ok: true
      realPath: string
      cleanup: () => boolean | void
    }) => void
    const jailResult = new Promise<{
      ok: true
      realPath: string
      cleanup: () => boolean | void
    }>((resolve) => {
      resolveJail = resolve
    })
    const { executors, jailAudio, produceWindowClip } = build({
      jailAudio: vi.fn(() => jailResult)
    })

    const pending = executors.executeAudioTool(
      'inspect_audio_segment',
      { sourcePath: 'clip.wav', startMs: 0, endMs: 15_000 },
      { appRunId: 'run-async-jail' }
    )
    expect(jailAudio).toHaveBeenCalledTimes(1)
    expect(produceWindowClip).not.toHaveBeenCalled()

    resolveJail({ ok: true, realPath: '/ws/deferred.wav', cleanup })
    const result = await pending
    expect(result.isError).toBeFalsy()
    expect(produceWindowClip).toHaveBeenCalledWith('/ws/deferred.wav', 0, 15_000)
    expect(cleanup).toHaveBeenCalledTimes(1)
  })

  it('jails the source, produces a windowed clip, and returns a TRUSTED AV ref with peaks + caption', async () => {
    const { executors, jailAudio, produceWindowClip, cleanupStagedInput, getWindowClipArgs } = build()
    const result = await executors.executeAudioTool(
      'inspect_audio_segment',
      { sourcePath: 'song.wav', startMs: 65000, endMs: 80000 },
      { appChatId: 'c1', appRunId: 'run-7' }
    )
    expect(result.isError).toBeFalsy()
    // Jailed first, the REAL path (not the agent string) reaches the producer.
    expect(jailAudio).toHaveBeenCalledTimes(1)
    expect(produceWindowClip).toHaveBeenCalledTimes(1)
    expect(getWindowClipArgs()).toEqual({ sourcePath: '/ws/clip.wav', startMs: 65000, endMs: 80000 })
    // A single TRUSTED AV ref (NOT an image block, NOT mediaRefHints) — the interactive lane.
    expect(result.content?.some((b) => b.type === 'image')).toBe(false)
    expect(result.mediaRefHints).toBeUndefined()
    const refs = result.trustedMediaRefs
    expect(refs).toHaveLength(1)
    const ref = refs![0]
    expect(ref.kind).toBe('audio')
    expect(ref.mimeType).toBe('audio/wav')
    expect(ref.sha256).toBe('a'.repeat(43))
    expect(ref.byteLength).toBe(64_000)
    expect(ref.durationMs).toBe(15_000)
    expect(ref.peaks).toEqual([0, 64, 128, 255, 200, 12])
    expect(ref.thumbnail?.dataBase64).toBe('thumb')
    // The <m:ss>–<m:ss> window range captions the ref + names the clip.
    expect(ref.caption).toBe('1:05–1:20')
    expect(ref.name).toContain('1:05–1:20')
    expect(ref.name).toContain('song') // basename of the agent sourcePath
    // The id is run-scoped (runId threads through buildAvMediaRef).
    expect(ref.id).toContain('run-7:av:')
    // Text answer: the window range + the playable-clip line + the windowed transcript.
    expect(result.text).toContain('1:05–1:20')
    expect(result.text).toContain('playable clip')
    expect(result.text).toContain('the chorus kicks in here')
    expect(cleanupStagedInput).toHaveBeenCalledTimes(1)
  })

  it('still emits the clip+peaks (no transcript, no throw) when the windowed transcribe is omitted', async () => {
    // The producer best-effort transcribe failed → it returns no transcript/segments, but
    // the clip + peaks + duration are intact. The executor must NOT fail and must NOT print
    // a transcript line.
    const { executors } = build({
      produceWindowClip: vi.fn(async () => ({
        sha256: 'b'.repeat(43),
        byteLength: 32_000,
        durationMs: 5_000,
        peaks: [10, 20, 30],
        thumbnail: { dataBase64: 'thumb2', mimeType: 'image/jpeg' }
        // transcript + segments ABSENT (Speech permission / locale unavailable)
      }))
    })
    const result = await executors.executeAudioTool(
      'inspect_audio_segment',
      { sourcePath: 'clip.wav', startMs: 0, endMs: 5000 },
      {}
    )
    expect(result.isError).toBeFalsy()
    expect(result.trustedMediaRefs).toHaveLength(1)
    expect(result.trustedMediaRefs![0].peaks).toEqual([10, 20, 30])
    expect(result.text).not.toContain('Transcript:')
    expect(result.text).toContain('playable clip')
  })

  it('REJECTS a window longer than the 120s playable-clip cap (before jailing/producing)', async () => {
    const { executors, jailAudio, produceWindowClip } = build()
    const result = await executors.executeAudioTool(
      'inspect_audio_segment',
      { sourcePath: 'clip.wav', startMs: 0, endMs: MAX_AUDIO_SEGMENT_CLIP_MS + 1 },
      {}
    )
    expect(result.isError).toBe(true)
    expect(result.text).toContain('window too long')
    // Neither the jail nor the producer ran — rejected up front.
    expect(jailAudio).not.toHaveBeenCalled()
    expect(produceWindowClip).not.toHaveBeenCalled()
  })

  it('accepts a window EXACTLY at the 120s cap', async () => {
    const { executors, produceWindowClip } = build()
    const result = await executors.executeAudioTool(
      'inspect_audio_segment',
      { sourcePath: 'clip.wav', startMs: 1000, endMs: 1000 + MAX_AUDIO_SEGMENT_CLIP_MS },
      {}
    )
    expect(result.isError).toBeFalsy()
    expect(produceWindowClip).toHaveBeenCalledTimes(1)
  })

  it('rejects a missing window (no startMs/endMs) before jailing/producing', async () => {
    const { executors, jailAudio, produceWindowClip } = build()
    const result = await executors.executeAudioTool('inspect_audio_segment', { sourcePath: 'clip.wav' }, {})
    expect(result.isError).toBe(true)
    expect(result.text).toContain('provide startMs and endMs')
    expect(jailAudio).not.toHaveBeenCalled()
    expect(produceWindowClip).not.toHaveBeenCalled()
  })

  it('rejects an inverted / non-positive window (endMs <= startMs, negative startMs)', async () => {
    const { executors, produceWindowClip } = build()
    for (const win of [
      { startMs: 5000, endMs: 5000 },
      { startMs: 8000, endMs: 2000 },
      { startMs: -1, endMs: 1000 }
    ]) {
      const result = await executors.executeAudioTool('inspect_audio_segment', { sourcePath: 'clip.wav', ...win }, {})
      expect(result.isError).toBe(true)
      expect(result.text).toContain('0 <= startMs < endMs')
    }
    expect(produceWindowClip).not.toHaveBeenCalled()
  })

  it('rejects a non-finite window value (NaN/Infinity) as a missing window', async () => {
    const { executors, produceWindowClip } = build()
    const result = await executors.executeAudioTool(
      'inspect_audio_segment',
      { sourcePath: 'clip.wav', startMs: 0, endMs: Infinity },
      {}
    )
    expect(result.isError).toBe(true)
    expect(result.text).toContain('provide startMs and endMs')
    expect(produceWindowClip).not.toHaveBeenCalled()
  })

  it('surfaces a jail rejection as a tool error, never reaching the producer', async () => {
    const { executors, produceWindowClip } = build({
      jailAudio: vi.fn(() => ({ ok: false as const, reason: 'outside_allowed_roots' }))
    })
    const result = await executors.executeAudioTool(
      'inspect_audio_segment',
      { sourcePath: '../etc/x.wav', startMs: 0, endMs: 1000 },
      {}
    )
    expect(result.isError).toBe(true)
    expect(result.text).toContain('could not read audio')
    expect(result.text).toContain('outside_allowed_roots')
    expect(produceWindowClip).not.toHaveBeenCalled()
  })

  it('surfaces a producer (daemon/persist) failure as a graceful tool error', async () => {
    const cleanup = vi.fn(() => true)
    const { executors } = build({
      jailAudio: vi.fn(() => ({ ok: true as const, realPath: '/staged/clip.wav', cleanup })),
      produceWindowClip: vi.fn(async () => {
        throw new Error('audio engine produced an empty clip')
      })
    })
    const result = await executors.executeAudioTool(
      'inspect_audio_segment',
      { sourcePath: 'clip.wav', startMs: 0, endMs: 1000 },
      {}
    )
    expect(result.isError).toBe(true)
    expect(result.text).toContain('audio engine produced an empty clip')
    expect(cleanup).toHaveBeenCalledTimes(1)
  })

  it('cleans the staged input exactly once when produced clip validation returns early', async () => {
    const cleanup = vi.fn(() => true)
    const { executors } = build({
      jailAudio: vi.fn(() => ({ ok: true as const, realPath: '/staged/clip.wav', cleanup })),
      produceWindowClip: vi.fn(async () => ({
        ...FAKE_WINDOW_CLIP,
        sha256: ''
      }))
    })
    const result = await executors.executeAudioTool(
      'inspect_audio_segment',
      { sourcePath: 'clip.wav', startMs: 0, endMs: 1000 },
      {}
    )
    expect(result.isError).toBe(true)
    expect(result.text).toContain('unsupported output mime')
    expect(cleanup).toHaveBeenCalledTimes(1)
  })

  it('does not let a staged-input cleanup throw mask a successful clip result', async () => {
    const cleanup = vi.fn(() => {
      throw new Error('unlink failed')
    })
    const { executors } = build({
      jailAudio: vi.fn(() => ({ ok: true as const, realPath: '/staged/clip.wav', cleanup }))
    })
    const result = await executors.executeAudioTool(
      'inspect_audio_segment',
      { sourcePath: 'clip.wav', startMs: 0, endMs: 1000 },
      {}
    )
    expect(result.isError).toBeFalsy()
    expect(result.trustedMediaRefs).toHaveLength(1)
    expect(cleanup).toHaveBeenCalledTimes(1)
  })

  it('fails loudly (not a crash) when the window-clip pipeline is not configured', async () => {
    const { executors } = build({ omitWindowDeps: true })
    const result = await executors.executeAudioTool(
      'inspect_audio_segment',
      { sourcePath: 'clip.wav', startMs: 0, endMs: 1000 },
      {}
    )
    expect(result.isError).toBe(true)
    expect(result.text).toContain('not configured')
  })
})
