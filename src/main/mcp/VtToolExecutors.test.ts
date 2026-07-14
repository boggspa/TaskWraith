import { describe, expect, it, vi } from 'vitest'
import {
  createVtToolExecutors,
  isVtMcpToolName,
  type VtJailedInput,
  type VtToolDeps
} from './VtToolExecutors'

function imageBlock(result: { content?: Array<{ type: string }> }) {
  return (result.content ?? []).find((b) => b.type === 'image') as
    | { type: 'image'; mimeType: string; data: string }
    | undefined
}

const DECODE_RESULT = {
  pngBase64: Buffer.from('frame-bytes').toString('base64'),
  width: 1920,
  height: 1080,
  timestampSeconds: 0,
  codec: 'h264',
  usedHardware: true
}

const ENCODE_RESULT = {
  width: 1280,
  height: 720,
  durationMs: 4000,
  codec: 'h264',
  usedHardware: true
}

const CONCAT_RESULT = {
  width: 1280,
  height: 720,
  durationMs: 12400,
  codec: 'h264',
  usedHardware: true,
  segmentCount: 3
}

const MIX_RESULT = {
  durationMs: 8200,
  sampleRate: 44100,
  channels: 2,
  codec: 'pcm_s16le',
  trackCount: 3
}

const TRANSCRIBE_RESULT = {
  text: 'hello world',
  segments: [
    { text: 'hello', startMs: 0, endMs: 480, confidence: 0.97 },
    { text: 'world', startMs: 500, endMs: 1020, confidence: 0.93 }
  ],
  localeIdentifier: 'en-US',
  onDevice: true
}

function build(overrides: Partial<VtToolDeps> = {}) {
  let lastDecodeParams: { inputPath: string; timestampSeconds?: number; preferHardware?: boolean } | null = null
  let lastEncodeParams: {
    sourcePath: string
    outputPath: string
    scaleWidth?: number
    targetBitrateKbps?: number
    startSeconds?: number
    durationSeconds?: number
    overlayPath?: string
    overlayX?: number
    overlayY?: number
    overlayWidth?: number
    overlayOpacity?: number
  } | null = null
  let lastConcatParams: {
    outputPath: string
    segments: Array<{ sourcePath: string; startSeconds?: number; durationSeconds?: number }>
    scaleWidth?: number
    targetBitrateKbps?: number
  } | null = null
  let lastMixParams: {
    outputPath: string
    format: 'wav' | 'm4a'
    sampleRate: number
    channels: number
    bitrateKbps?: number
    tracks: Array<{ sourcePath: string; gainDb?: number; pan?: number; offsetMs?: number; fadeInMs?: number; fadeOutMs?: number }>
  } | null = null
  let lastTranscribeParams: { sourcePath: string; localeIdentifier?: string } | null = null
  const removed: string[] = []
  const inputCleanup = vi.fn(() => true)
  const overlayCleanup = vi.fn(() => true)
  const deps: VtToolDeps = {
    jailInput: vi.fn(() => ({ ok: true as const, realPath: '/ws/clip.mp4', cleanup: inputCleanup })),
    jailOverlay: vi.fn(() => ({ ok: true as const, realPath: '/ws/logo.png', cleanup: overlayCleanup })),
    decodeFrame: vi.fn(async (params) => {
      lastDecodeParams = params
      return { ...DECODE_RESULT }
    }),
    encodeClip: vi.fn(async (params) => {
      lastEncodeParams = params
      return { ...ENCODE_RESULT }
    }),
    concatClips: vi.fn(async (params) => {
      lastConcatParams = params
      return { ...CONCAT_RESULT }
    }),
    mixdown: vi.fn(async (params) => {
      lastMixParams = params
      return { ...MIX_RESULT }
    }),
    transcribe: vi.fn(async (params) => {
      lastTranscribeParams = params
      return { ...TRANSCRIBE_RESULT, segments: [...TRANSCRIBE_RESULT.segments] }
    }),
    stagingPath: vi.fn((ext: string) => `/staging/out.${ext}`),
    persistOutputFile: vi.fn((_path: string, _mimeType: string) => ({
      ok: true as const,
      path: '/assets/canonical-output',
      sha256: 'f'.repeat(64),
      byteLength: 42
    })),
    // Default: no poster. Specific tests override to assert the thumbnail is threaded
    // onto the ref, and that a throwing generator still yields a ref WITHOUT one.
    generatePoster: vi.fn(async () => undefined),
    removeFile: vi.fn((p: string) => {
      removed.push(p)
    }),
    ...overrides
  }
  const executors = createVtToolExecutors(deps)
  return {
    executors,
    deps,
    inputCleanup,
    overlayCleanup,
    getDecodeParams: () => lastDecodeParams,
    getEncodeParams: () => lastEncodeParams,
    getConcatParams: () => lastConcatParams,
    getMixParams: () => lastMixParams,
    getTranscribeParams: () => lastTranscribeParams,
    getRemoved: () => removed
  }
}

describe('isVtMcpToolName', () => {
  it('recognizes the VideoToolbox tools only', () => {
    expect(isVtMcpToolName('video_decode_frame')).toBe(true)
    expect(isVtMcpToolName('inspect_video_frames')).toBe(true)
    expect(isVtMcpToolName('video_encode_clip')).toBe(true)
    expect(isVtMcpToolName('video_concat_clips')).toBe(true)
    expect(isVtMcpToolName('audio_mix')).toBe(true)
    expect(isVtMcpToolName('transcribe_audio')).toBe(true)
    expect(isVtMcpToolName('video_thumbnail')).toBe(false)
    expect(isVtMcpToolName('video_probe')).toBe(false)
    expect(isVtMcpToolName('something_else')).toBe(false)
  })
})

describe('video_decode_frame', () => {
  it('waits for an asynchronous jail before invoking the daemon', async () => {
    const cleanup = vi.fn(() => true)
    let resolveJail!: (value: VtJailedInput) => void
    const jailResult = new Promise<VtJailedInput>((resolve) => {
      resolveJail = resolve
    })
    const { executors, deps } = build({ jailInput: vi.fn(() => jailResult) })

    const pending = executors.executeVtTool(
      'video_decode_frame',
      { inputPath: 'clip.mp4' },
      { appChatId: 'c1' }
    )
    expect(deps.jailInput).toHaveBeenCalledTimes(1)
    expect(deps.decodeFrame).not.toHaveBeenCalled()

    resolveJail({ ok: true, realPath: '/ws/deferred.mp4', cleanup })
    const result = await pending
    expect(result.isError).toBeFalsy()
    expect(deps.decodeFrame).toHaveBeenCalledTimes(1)
    expect(cleanup).toHaveBeenCalledTimes(1)
  })

  it('jails the input, decodes over the REAL path, and returns an inline PNG image block', async () => {
    const { executors, deps, getDecodeParams } = build()
    const result = await executors.executeVtTool(
      'video_decode_frame',
      { inputPath: 'clip.mp4', timestampSeconds: 2.5, preferHardware: true },
      { appChatId: 'c1' }
    )
    expect(result.isError).toBeFalsy()
    expect(deps.jailInput).toHaveBeenCalledWith('clip.mp4', { appChatId: 'c1' })
    // Decode runs over the JAILED real path, not the agent-supplied string.
    expect(getDecodeParams()?.inputPath).toBe('/ws/clip.mp4')
    expect(getDecodeParams()?.timestampSeconds).toBe(2.5)
    expect(getDecodeParams()?.preferHardware).toBe(true)
    // Rides the proven image media spine — returned as an {type:'image'} block.
    const img = imageBlock(result)
    expect(img?.mimeType).toBe('image/png')
    expect(img?.data).toBe(DECODE_RESULT.pngBase64)
    // Plus a concise text summary block.
    const textBlock = (result.content ?? []).find((b) => b.type === 'text') as { type: 'text'; text: string } | undefined
    expect(textBlock?.text).toContain('Decoded frame')
    expect(textBlock?.text).toContain('1920×1080')
    expect(textBlock?.text).toContain('h264')
    expect(textBlock?.text).toContain('hardware')
  })

  it('defaults timestamp/preferHardware (passes undefined) when not supplied', async () => {
    const { executors, getDecodeParams } = build()
    const result = await executors.executeVtTool('video_decode_frame', { inputPath: 'clip.mp4' }, {})
    expect(result.isError).toBeFalsy()
    expect(getDecodeParams()?.timestampSeconds).toBeUndefined()
    expect(getDecodeParams()?.preferHardware).toBeUndefined()
  })

  it('surfaces a jail rejection WITHOUT calling decodeFrame', async () => {
    const { executors, deps } = build({
      jailInput: vi.fn(() => ({ ok: false as const, reason: 'outside_allowed_roots' }))
    })
    const result = await executors.executeVtTool('video_decode_frame', { inputPath: '../../etc/passwd' }, {})
    expect(result.isError).toBe(true)
    expect(result.text).toContain('outside_allowed_roots')
    expect(deps.decodeFrame).not.toHaveBeenCalled()
  })

  it('rejects a missing inputPath before jailing', async () => {
    const { executors, deps } = build()
    const result = await executors.executeVtTool('video_decode_frame', {}, {})
    expect(result.isError).toBe(true)
    expect(result.text).toContain('inputPath')
    expect(deps.jailInput).not.toHaveBeenCalled()
    expect(deps.decodeFrame).not.toHaveBeenCalled()
  })

  it('rejects a negative timestamp before jailing', async () => {
    const { executors, deps } = build()
    const result = await executors.executeVtTool('video_decode_frame', { inputPath: 'clip.mp4', timestampSeconds: -1 }, {})
    expect(result.isError).toBe(true)
    expect(result.text).toContain('timestampSeconds')
    expect(deps.jailInput).not.toHaveBeenCalled()
  })

  it('returns an error result (no throw) when the daemon decode rejects', async () => {
    const { executors } = build({
      decodeFrame: vi.fn(async () => {
        throw new Error('VideoToolbox could not open the asset')
      })
    })
    const result = await executors.executeVtTool('video_decode_frame', { inputPath: 'clip.mp4' }, {})
    expect(result.isError).toBe(true)
    expect(result.text).toContain('video_decode_frame failed')
    expect(result.text).toContain('VideoToolbox could not open the asset')
    expect(imageBlock(result)).toBeUndefined()
  })

  it('renders the software-decode label when usedHardware is false', async () => {
    const { executors } = build({
      decodeFrame: vi.fn(async () => ({ ...DECODE_RESULT, usedHardware: false, timestampSeconds: 3.2 }))
    })
    const result = await executors.executeVtTool('video_decode_frame', { inputPath: 'clip.mp4' }, {})
    expect(result.isError).toBeFalsy()
    expect(result.text).toContain('3.2s')
    expect(result.text).toContain('software')
  })
})

// inspect_video_frames — loops the SAME native decodeFrame RPC to return several frames
// in one call. The frames are PNGs that ride the SANITIZED image lane (image blocks +
// mediaRefHints), NOT the trusted AV channel. Read-only-safe.
describe('inspect_video_frames', () => {
  function imageBlocks(result: { content?: Array<{ type: string }> }) {
    return (result.content ?? []).filter((b) => b.type === 'image') as Array<{
      type: 'image'
      mimeType: string
      data: string
    }>
  }

  it('decodes each explicit timestamp over the JAILED path and returns N image blocks + group hints', async () => {
    const calls: number[] = []
    const { executors, deps } = build({
      decodeFrame: vi.fn(async (params) => {
        calls.push(params.timestampSeconds ?? -1)
        // Echo the requested timestamp back (the daemon may snap, but here it matches).
        return { ...DECODE_RESULT, timestampSeconds: params.timestampSeconds ?? 0 }
      })
    })
    const result = await executors.executeVtTool(
      'inspect_video_frames',
      { inputPath: 'clip.mp4', timestamps: [0, 3, 75.4] },
      { appChatId: 'c1' }
    )
    expect(result.isError).toBeFalsy()
    expect(deps.jailInput).toHaveBeenCalledTimes(1)
    expect(deps.jailInput).toHaveBeenCalledWith('clip.mp4', { appChatId: 'c1' })
    // One decode per timestamp, all over the jailed real path, preferHardware true.
    expect(deps.decodeFrame).toHaveBeenCalledTimes(3)
    expect(calls).toEqual([0, 3, 75.4])
    expect((deps.decodeFrame as ReturnType<typeof vi.fn>).mock.calls.every(([p]) => p.inputPath === '/ws/clip.mp4' && p.preferHardware === true)).toBe(true)
    // N image blocks, content order, plus a leading text summary.
    expect(imageBlocks(result)).toHaveLength(3)
    expect(imageBlocks(result).every((b) => b.mimeType === 'image/png')).toBe(true)
    // mediaRefHints carries groupKind + per-frame labels aligned to the image blocks.
    expect(result.mediaRefHints?.groupKind).toBe('video_frames')
    expect(result.mediaRefHints?.labels).toEqual(['0:00', '0:03', '1:15'])
    expect(result.trustedMediaRefs).toBeUndefined()
  })

  it('defaults to a single frame at 0 when neither timestamps nor everyNSeconds is given', async () => {
    const { executors, deps } = build()
    const result = await executors.executeVtTool('inspect_video_frames', { inputPath: 'clip.mp4' }, {})
    expect(result.isError).toBeFalsy()
    expect(deps.decodeFrame).toHaveBeenCalledTimes(1)
    expect((deps.decodeFrame as ReturnType<typeof vi.fn>).mock.calls[0][0].timestampSeconds).toBe(0)
    expect(imageBlocks(result)).toHaveLength(1)
    expect(result.mediaRefHints?.labels).toEqual(['0:00'])
  })

  it('samples every N seconds from 0 (0, n, 2n, …)', async () => {
    const calls: number[] = []
    const { executors } = build({
      decodeFrame: vi.fn(async (params) => {
        calls.push(params.timestampSeconds ?? -1)
        return { ...DECODE_RESULT, timestampSeconds: params.timestampSeconds ?? 0 }
      })
    })
    const result = await executors.executeVtTool(
      'inspect_video_frames',
      { inputPath: 'clip.mp4', everyNSeconds: 5, maxFrames: 4 },
      {}
    )
    expect(result.isError).toBeFalsy()
    expect(calls).toEqual([0, 5, 10, 15])
    expect(result.mediaRefHints?.labels).toEqual(['0:00', '0:05', '0:10', '0:15'])
  })

  it('STOPS at end-of-clip (a failed decode) and returns the frames gathered so far', async () => {
    let n = 0
    const { executors } = build({
      decodeFrame: vi.fn(async (params) => {
        n += 1
        // First two timestamps succeed; the third (past EOF) throws.
        if (n >= 3) throw new Error('VideoToolbox: requested time past end of asset')
        return { ...DECODE_RESULT, timestampSeconds: params.timestampSeconds ?? 0 }
      })
    })
    const result = await executors.executeVtTool(
      'inspect_video_frames',
      { inputPath: 'clip.mp4', everyNSeconds: 10, maxFrames: 8 },
      {}
    )
    // NOT an error — we keep the 2 frames we got, the EOF just stops the loop.
    expect(result.isError).toBeFalsy()
    expect(imageBlocks(result)).toHaveLength(2)
    expect(result.mediaRefHints?.labels).toEqual(['0:00', '0:10'])
    expect(result.text).toContain('Inspected 2 frames')
  })

  it('returns an ERROR result (not a throw) when ZERO frames decode', async () => {
    const { executors } = build({
      decodeFrame: vi.fn(async () => {
        throw new Error('VideoToolbox could not open the asset')
      })
    })
    const result = await executors.executeVtTool('inspect_video_frames', { inputPath: 'clip.mp4', timestamps: [0, 1] }, {})
    expect(result.isError).toBe(true)
    expect(result.text).toContain('inspect_video_frames failed')
    expect(result.text).toContain('VideoToolbox could not open the asset')
    expect(imageBlocks(result)).toHaveLength(0)
    expect(result.mediaRefHints).toBeUndefined()
  })

  it('clamps the frame count to the hard cap of 24 even when maxFrames is larger', async () => {
    const { executors, deps } = build({
      decodeFrame: vi.fn(async (params) => ({ ...DECODE_RESULT, timestampSeconds: params.timestampSeconds ?? 0 }))
    })
    const result = await executors.executeVtTool(
      'inspect_video_frames',
      { inputPath: 'clip.mp4', everyNSeconds: 1, maxFrames: 50 },
      {}
    )
    expect(result.isError).toBeFalsy()
    // Hard cap = INSPECT_VIDEO_FRAMES_MAX (24).
    expect(deps.decodeFrame).toHaveBeenCalledTimes(24)
    expect(imageBlocks(result)).toHaveLength(24)
    expect(result.mediaRefHints?.labels).toHaveLength(24)
    // The result carries a per-call maxRefs hint so the dispatch seam emits all 24.
    expect(result.mediaRefHints?.maxRefs).toBe(24)
  })

  it('clamps an explicit oversized timestamps array to the DEFAULT 8 when maxFrames is unset', async () => {
    const { executors, deps } = build({
      decodeFrame: vi.fn(async (params) => ({ ...DECODE_RESULT, timestampSeconds: params.timestampSeconds ?? 0 }))
    })
    const result = await executors.executeVtTool(
      'inspect_video_frames',
      { inputPath: 'clip.mp4', timestamps: Array.from({ length: 40 }, (_, i) => i) },
      {}
    )
    expect(result.isError).toBeFalsy()
    // No maxFrames → the default 8 still applies (24 is a ceiling on an explicit ask).
    expect(deps.decodeFrame).toHaveBeenCalledTimes(8)
  })

  it('honors an explicit maxFrames up to 24 with an oversized timestamps array', async () => {
    const { executors, deps } = build({
      decodeFrame: vi.fn(async (params) => ({ ...DECODE_RESULT, timestampSeconds: params.timestampSeconds ?? 0 }))
    })
    const result = await executors.executeVtTool(
      'inspect_video_frames',
      { inputPath: 'clip.mp4', timestamps: Array.from({ length: 40 }, (_, i) => i), maxFrames: 24 },
      {}
    )
    expect(result.isError).toBeFalsy()
    expect(deps.decodeFrame).toHaveBeenCalledTimes(24)
  })

  it('still defaults to 8 frames (and a maxRefs hint of 24) when maxFrames is unset', async () => {
    const { executors, deps } = build({
      decodeFrame: vi.fn(async (params) => ({ ...DECODE_RESULT, timestampSeconds: params.timestampSeconds ?? 0 }))
    })
    const result = await executors.executeVtTool(
      'inspect_video_frames',
      { inputPath: 'clip.mp4', everyNSeconds: 1 },
      {}
    )
    expect(result.isError).toBeFalsy()
    // Default stays 8 (a sensible scrub size); the cap is only a ceiling on explicit asks.
    expect(deps.decodeFrame).toHaveBeenCalledTimes(8)
    expect(result.mediaRefHints?.maxRefs).toBe(24)
  })

  it('rejects a missing inputPath before jailing', async () => {
    const { executors, deps } = build()
    const result = await executors.executeVtTool('inspect_video_frames', {}, {})
    expect(result.isError).toBe(true)
    expect(result.text).toContain('inputPath')
    expect(deps.jailInput).not.toHaveBeenCalled()
    expect(deps.decodeFrame).not.toHaveBeenCalled()
  })

  it('rejects a negative timestamp before jailing', async () => {
    const { executors, deps } = build()
    const result = await executors.executeVtTool(
      'inspect_video_frames',
      { inputPath: 'clip.mp4', timestamps: [0, -2] },
      {}
    )
    expect(result.isError).toBe(true)
    expect(result.text).toContain('timestamp')
    expect(deps.jailInput).not.toHaveBeenCalled()
    expect(deps.decodeFrame).not.toHaveBeenCalled()
  })

  it('surfaces a jail rejection WITHOUT calling decodeFrame', async () => {
    const { executors, deps } = build({
      jailInput: vi.fn(() => ({ ok: false as const, reason: 'outside_allowed_roots' }))
    })
    const result = await executors.executeVtTool(
      'inspect_video_frames',
      { inputPath: '../../etc/passwd', timestamps: [0] },
      {}
    )
    expect(result.isError).toBe(true)
    expect(result.text).toContain('outside_allowed_roots')
    expect(deps.decodeFrame).not.toHaveBeenCalled()
  })
})

// video_encode_clip — output is a VIDEO FILE, so it rides the TRUSTED media channel
// (result.trustedMediaRefs, NOT an image block + NOT provider media_refs), exactly
// like the ffmpeg transcode_video producer.
describe('video_encode_clip', () => {
  it('jails the input, encodes over the REAL path into a staged output, and returns a trusted video ref', async () => {
    const { executors, deps, getEncodeParams, getRemoved } = build()
    const result = await executors.executeVtTool(
      'video_encode_clip',
      { inputPath: 'clip.mp4', scaleWidth: 1280, targetBitrateKbps: 4000, startSeconds: 2, durationSeconds: 4 },
      { appRunId: 'run-7' }
    )
    expect(result.isError).toBeFalsy()
    expect(deps.jailInput).toHaveBeenCalledWith('clip.mp4', { appRunId: 'run-7' })
    // Encode runs over the JAILED real path + the staging path WE named.
    expect(getEncodeParams()?.sourcePath).toBe('/ws/clip.mp4')
    expect(getEncodeParams()?.outputPath).toBe('/staging/out.mp4')
    expect(getEncodeParams()?.scaleWidth).toBe(1280)
    expect(getEncodeParams()?.targetBitrateKbps).toBe(4000)
    expect(getEncodeParams()?.startSeconds).toBe(2)
    expect(getEncodeParams()?.durationSeconds).toBe(4)
    // Persisted to the asset store with the fixed video mime.
    expect(deps.persistOutputFile).toHaveBeenCalledWith('/staging/out.mp4', 'video/mp4')
    // Rides the TRUSTED AV channel — a video ref, not an image block.
    const refs = result.trustedMediaRefs ?? []
    expect(refs).toHaveLength(1)
    expect(refs[0].kind).toBe('video')
    expect(refs[0].mimeType).toBe('video/mp4')
    expect(refs[0].sha256).toBe('f'.repeat(64))
    expect(refs[0].id).toContain('f'.repeat(24)) // sha-derived, non-empty
    expect(refs[0].id).toContain('run-7')
    expect(refs[0].name).toBe('clip.mp4')
    expect(refs[0].durationMs).toBe(ENCODE_RESULT.durationMs)
    expect(refs[0].codecs).toBe('h264')
    // NOT an image-block result, but DOES carry a text summary block.
    expect((result.content ?? []).some((b) => b.type === 'image')).toBe(false)
    const textBlock = (result.content ?? []).find((b) => b.type === 'text') as { type: 'text'; text: string } | undefined
    expect(textBlock?.text).toContain('Encoded clip')
    expect(textBlock?.text).toContain('1280×720')
    expect(textBlock?.text).toContain('h264')
    expect(textBlock?.text).toContain('hardware')
    // Staging file cleaned up.
    expect(getRemoved()).toContain('/staging/out.mp4')
  })

  it('rejects a missing inputPath before jailing or encoding', async () => {
    const { executors, deps } = build()
    const result = await executors.executeVtTool('video_encode_clip', {}, {})
    expect(result.isError).toBe(true)
    expect(result.text).toContain('inputPath')
    expect(deps.jailInput).not.toHaveBeenCalled()
    expect(deps.encodeClip).not.toHaveBeenCalled()
  })

  it('rejects a non-positive durationSeconds before jailing or encoding', async () => {
    const { executors, deps } = build()
    const result = await executors.executeVtTool('video_encode_clip', { inputPath: 'clip.mp4', durationSeconds: 0 }, {})
    expect(result.isError).toBe(true)
    expect(result.text).toContain('durationSeconds')
    expect(deps.jailInput).not.toHaveBeenCalled()
    expect(deps.encodeClip).not.toHaveBeenCalled()
  })

  it('surfaces a jail rejection WITHOUT calling encodeClip', async () => {
    const { executors, deps } = build({
      jailInput: vi.fn(() => ({ ok: false as const, reason: 'outside_allowed_roots' }))
    })
    const result = await executors.executeVtTool('video_encode_clip', { inputPath: '../../etc/passwd' }, {})
    expect(result.isError).toBe(true)
    expect(result.text).toContain('outside_allowed_roots')
    expect(deps.encodeClip).not.toHaveBeenCalled()
  })

  it('returns an error result (no throw, and still cleans up) when the daemon encode rejects', async () => {
    const { executors, getRemoved } = build({
      encodeClip: vi.fn(async () => {
        throw new Error('VideoToolbox could not open the asset')
      })
    })
    const result = await executors.executeVtTool('video_encode_clip', { inputPath: 'clip.mp4' }, {})
    expect(result.isError).toBe(true)
    expect(result.text).toContain('VideoToolbox could not open the asset')
    expect(result.trustedMediaRefs).toBeUndefined()
    expect(getRemoved()).toContain('/staging/out.mp4')
  })

  it('a persistOutputFile failure yields an error result with NO trusted refs (and still cleans up)', async () => {
    const { executors, getRemoved } = build({
      persistOutputFile: vi.fn(async () => ({ ok: false as const, reason: 'disk_full' }))
    })
    const result = await executors.executeVtTool('video_encode_clip', { inputPath: 'clip.mp4' }, {})
    expect(result.isError).toBe(true)
    expect(result.text).toContain('disk_full')
    expect(result.trustedMediaRefs).toBeUndefined()
    expect(getRemoved()).toContain('/staging/out.mp4')
  })

  it('awaits file persistence before building the ref or removing staging', async () => {
    let resolvePersistence!: (value: {
      ok: true
      path: string
      sha256: string
      byteLength: number
    }) => void
    const pendingPersistence = new Promise<{
      ok: true
      path: string
      sha256: string
      byteLength: number
    }>((resolve) => {
      resolvePersistence = resolve
    })
    let announcePersistenceStarted!: () => void
    const persistenceStarted = new Promise<void>((resolve) => {
      announcePersistenceStarted = resolve
    })
    const { executors, getRemoved } = build({
      persistOutputFile: vi.fn(() => {
        announcePersistenceStarted()
        return pendingPersistence
      })
    })
    let settled = false
    const pending = executors
      .executeVtTool('video_encode_clip', { inputPath: 'clip.mp4' }, {})
      .finally(() => {
        settled = true
      })

    await persistenceStarted
    expect(settled).toBe(false)
    expect(getRemoved()).toEqual([])
    resolvePersistence({
      ok: true,
      path: '/assets/deferred.mp4',
      sha256: 'd'.repeat(64),
      byteLength: 4096
    })
    const result = await pending
    expect(result.trustedMediaRefs?.[0]).toMatchObject({ sha256: 'd'.repeat(64), byteLength: 4096 })
    expect(getRemoved()).toEqual(['/staging/out.mp4'])
  })

  it('fails without a ref when persistence rejects an empty encoded output', async () => {
    const { executors, getRemoved } = build({
      persistOutputFile: vi.fn(async () => ({ ok: false as const, reason: 'too_large' }))
    })
    const result = await executors.executeVtTool('video_encode_clip', { inputPath: 'clip.mp4' }, {})
    expect(result.isError).toBe(true)
    expect(result.text).toContain('too_large')
    expect(result.trustedMediaRefs).toBeUndefined()
    expect(getRemoved()).toContain('/staging/out.mp4')
  })

  it('renders the software-encode label when usedHardware is false', async () => {
    const { executors } = build({
      encodeClip: vi.fn(async () => ({ ...ENCODE_RESULT, usedHardware: false }))
    })
    const result = await executors.executeVtTool('video_encode_clip', { inputPath: 'clip.mp4' }, {})
    expect(result.isError).toBeFalsy()
    expect(result.text).toContain('software')
  })

  // Optional CoreImage overlay — jailed via the SEPARATE image jail (jailOverlay),
  // NOT jailInput (whose video/audio mime-sniff would reject a PNG).
  it('jails the overlay via jailOverlay and forwards the jailed realPath + position/opacity to encodeClip', async () => {
    const { executors, deps, getEncodeParams } = build()
    const result = await executors.executeVtTool(
      'video_encode_clip',
      { inputPath: 'clip.mp4', overlayPath: 'logo.png', overlayX: 12, overlayY: 24, overlayWidth: 96, overlayOpacity: 0.6 },
      { appRunId: 'run-9' }
    )
    expect(result.isError).toBeFalsy()
    // Overlay jailed through the image jail (NOT jailInput).
    expect(deps.jailOverlay).toHaveBeenCalledWith('logo.png', { appRunId: 'run-9' })
    // The JAILED overlay realPath + position/opacity are forwarded to the daemon.
    expect(getEncodeParams()?.overlayPath).toBe('/ws/logo.png')
    expect(getEncodeParams()?.overlayX).toBe(12)
    expect(getEncodeParams()?.overlayY).toBe(24)
    expect(getEncodeParams()?.overlayWidth).toBe(96)
    expect(getEncodeParams()?.overlayOpacity).toBe(0.6)
    // Still a trusted video ref; summary notes the overlay.
    const refs = result.trustedMediaRefs ?? []
    expect(refs).toHaveLength(1)
    expect(refs[0].kind).toBe('video')
    expect(result.text).toContain('+ overlay')
  })

  it('surfaces an overlay jail rejection WITHOUT calling encodeClip', async () => {
    const { executors, deps } = build({
      jailOverlay: vi.fn(() => ({ ok: false as const, reason: 'unsupported' }))
    })
    const result = await executors.executeVtTool(
      'video_encode_clip',
      { inputPath: 'clip.mp4', overlayPath: '../../etc/evil.svg' },
      {}
    )
    expect(result.isError).toBe(true)
    expect(result.text).toContain('could not read overlay image')
    expect(result.text).toContain('unsupported')
    // The input still got jailed, but the encode never ran.
    expect(deps.jailInput).toHaveBeenCalled()
    expect(deps.encodeClip).not.toHaveBeenCalled()
  })

  it('does NOT call jailOverlay when no overlayPath is supplied (unchanged path)', async () => {
    const { executors, deps, getEncodeParams } = build()
    const result = await executors.executeVtTool('video_encode_clip', { inputPath: 'clip.mp4' }, {})
    expect(result.isError).toBeFalsy()
    expect(deps.jailOverlay).not.toHaveBeenCalled()
    expect(getEncodeParams()?.overlayPath).toBeUndefined()
    expect(getEncodeParams()?.overlayX).toBeUndefined()
    expect(result.text).not.toContain('+ overlay')
  })

  // Part 1 — poster threading + fail-tolerance (mirrors the ffmpeg producer behavior).
  it('threads the generated poster onto the trusted ref (called with the staging path, BEFORE cleanup)', async () => {
    const order: string[] = []
    const { executors, deps } = build({
      generatePoster: vi.fn(async () => {
        order.push('poster')
        return { thumbnail: { dataBase64: 'UE9TVEVS', mimeType: 'image/jpeg', width: 320, height: 180 } }
      }),
      removeFile: vi.fn(() => {
        order.push('remove')
      })
    })
    const result = await executors.executeVtTool('video_encode_clip', { inputPath: 'clip.mp4' }, {})
    expect(result.isError).toBeFalsy()
    expect(deps.generatePoster).toHaveBeenCalledWith('/assets/canonical-output', 'video', 'video/mp4', 42)
    const refs = result.trustedMediaRefs ?? []
    expect(refs).toHaveLength(1)
    expect(refs[0].thumbnail).toEqual({ dataBase64: 'UE9TVEVS', mimeType: 'image/jpeg', width: 320, height: 180 })
    expect(order).toEqual(['poster', 'remove'])
  })

  it('still returns the ref WITHOUT a thumbnail when the poster generator throws', async () => {
    const { executors } = build({
      generatePoster: vi.fn(async () => {
        throw new Error('decode exploded')
      })
    })
    const result = await executors.executeVtTool('video_encode_clip', { inputPath: 'clip.mp4' }, {})
    expect(result.isError).toBeFalsy()
    const refs = result.trustedMediaRefs ?? []
    expect(refs).toHaveLength(1)
    expect(refs[0].thumbnail).toBeUndefined()
  })
})

// video_concat_clips — joins N video SEGMENTS into one MP4. Like video_encode_clip the
// output is a VIDEO FILE, so it rides the TRUSTED media channel (trustedMediaRefs). Each
// segment is INDEPENDENTLY realpath-jailed via jailInput before the daemon runs.
describe('video_concat_clips', () => {
  it('jails every segment, forwards the realPaths + trims to concatClips, and returns a trusted video ref', async () => {
    // Per-segment realPath so we can prove each agent-supplied path was jailed and the
    // JAILED path (not the raw string) reached the daemon, preserving order.
    let i = 0
    const { executors, deps, getConcatParams, getRemoved } = build({
      jailInput: vi.fn(() => ({ ok: true as const, realPath: `/ws/seg-${i++}.mp4`, cleanup: vi.fn(() => true) }))
    })
    const result = await executors.executeVtTool(
      'video_concat_clips',
      {
        segments: [
          { inputPath: 'a.mp4' },
          { inputPath: 'b.mp4', startSeconds: 1, durationSeconds: 4 },
          { inputPath: 'c.mp4' }
        ],
        scaleWidth: 1280,
        targetBitrateKbps: 5000
      },
      { appRunId: 'run-7' }
    )
    expect(result.isError).toBeFalsy()
    // Every segment path was jailed (with the ctx).
    expect(deps.jailInput).toHaveBeenCalledTimes(3)
    expect(deps.jailInput).toHaveBeenCalledWith('a.mp4', { appRunId: 'run-7' })
    expect(deps.jailInput).toHaveBeenCalledWith('b.mp4', { appRunId: 'run-7' })
    expect(deps.jailInput).toHaveBeenCalledWith('c.mp4', { appRunId: 'run-7' })
    // The JAILED realPaths (in order) + trims + staging path WE named reach the daemon.
    const params = getConcatParams()
    expect(params?.outputPath).toBe('/staging/out.mp4')
    expect(params?.scaleWidth).toBe(1280)
    expect(params?.targetBitrateKbps).toBe(5000)
    expect(params?.segments.map((s) => s.sourcePath)).toEqual(['/ws/seg-0.mp4', '/ws/seg-1.mp4', '/ws/seg-2.mp4'])
    expect(params?.segments[1].startSeconds).toBe(1)
    expect(params?.segments[1].durationSeconds).toBe(4)
    expect(params?.segments[0].startSeconds).toBeUndefined()
    // Persisted with the fixed video mime; rides the TRUSTED AV channel.
    expect(deps.persistOutputFile).toHaveBeenCalledWith('/staging/out.mp4', 'video/mp4')
    const refs = result.trustedMediaRefs ?? []
    expect(refs).toHaveLength(1)
    expect(refs[0].kind).toBe('video')
    expect(refs[0].mimeType).toBe('video/mp4')
    expect(refs[0].sha256).toBe('f'.repeat(64))
    expect(refs[0].id).toContain('run-7')
    // Output label derives from the FIRST segment's input.
    expect(refs[0].name).toBe('a-concat.mp4')
    expect(refs[0].durationMs).toBe(CONCAT_RESULT.durationMs)
    // NOT an image-block result, but DOES carry a text summary block.
    expect((result.content ?? []).some((b) => b.type === 'image')).toBe(false)
    const textBlock = (result.content ?? []).find((b) => b.type === 'text') as { type: 'text'; text: string } | undefined
    expect(textBlock?.text).toContain('Concatenated 3 clips')
    expect(textBlock?.text).toContain('1280×720')
    expect(textBlock?.text).toContain('h264')
    expect(textBlock?.text).toContain('hardware')
    // Staging file cleaned up.
    expect(getRemoved()).toContain('/staging/out.mp4')
  })

  it('accepts the minimum of 2 segments', async () => {
    const { executors, getConcatParams } = build()
    const result = await executors.executeVtTool(
      'video_concat_clips',
      { segments: [{ inputPath: 'a.mp4' }, { inputPath: 'b.mp4' }] },
      {}
    )
    expect(result.isError).toBeFalsy()
    expect(getConcatParams()?.segments).toHaveLength(2)
  })

  it('rejects fewer than 2 segments WITHOUT jailing or concatenating', async () => {
    const { executors, deps } = build()
    const result = await executors.executeVtTool('video_concat_clips', { segments: [{ inputPath: 'a.mp4' }] }, {})
    expect(result.isError).toBe(true)
    expect(result.text).toContain('at least 2 segments')
    expect(deps.jailInput).not.toHaveBeenCalled()
    expect(deps.concatClips).not.toHaveBeenCalled()
  })

  it('rejects a non-array / missing segments WITHOUT concatenating', async () => {
    const { executors, deps } = build()
    const result = await executors.executeVtTool('video_concat_clips', {}, {})
    expect(result.isError).toBe(true)
    expect(result.text).toContain('at least 2 segments')
    expect(deps.concatClips).not.toHaveBeenCalled()
  })

  it('rejects more than 50 segments WITHOUT concatenating', async () => {
    const { executors, deps } = build()
    const segments = Array.from({ length: 51 }, (_, n) => ({ inputPath: `clip-${n}.mp4` }))
    const result = await executors.executeVtTool('video_concat_clips', { segments }, {})
    expect(result.isError).toBe(true)
    expect(result.text).toContain('too many segments')
    expect(deps.concatClips).not.toHaveBeenCalled()
  })

  it('surfaces a segment jail rejection (with its index) WITHOUT calling concatClips', async () => {
    // The 2nd segment fails the jail; the whole concat must abort and never run.
    let call = 0
    const { executors, deps } = build({
      jailInput: vi.fn(() => {
        call++
        return call === 2
          ? ({ ok: false as const, reason: 'outside_allowed_roots' })
          : ({ ok: true as const, realPath: '/ws/ok.mp4', cleanup: vi.fn(() => true) })
      })
    })
    const result = await executors.executeVtTool(
      'video_concat_clips',
      { segments: [{ inputPath: 'ok.mp4' }, { inputPath: '../../etc/passwd' }, { inputPath: 'c.mp4' }] },
      {}
    )
    expect(result.isError).toBe(true)
    expect(result.text).toContain('segment 1')
    expect(result.text).toContain('outside_allowed_roots')
    expect(deps.concatClips).not.toHaveBeenCalled()
  })

  it('rejects a segment with an empty inputPath WITHOUT concatenating', async () => {
    const { executors, deps } = build()
    const result = await executors.executeVtTool(
      'video_concat_clips',
      { segments: [{ inputPath: 'a.mp4' }, { inputPath: '   ' }] },
      {}
    )
    expect(result.isError).toBe(true)
    expect(result.text).toContain('segment 1')
    expect(result.text).toContain('inputPath')
    expect(deps.concatClips).not.toHaveBeenCalled()
  })

  it('rejects a segment with a non-positive durationSeconds WITHOUT concatenating', async () => {
    const { executors, deps } = build()
    const result = await executors.executeVtTool(
      'video_concat_clips',
      { segments: [{ inputPath: 'a.mp4' }, { inputPath: 'b.mp4', durationSeconds: 0 }] },
      {}
    )
    expect(result.isError).toBe(true)
    expect(result.text).toContain('segment 1')
    expect(result.text).toContain('durationSeconds')
    expect(deps.concatClips).not.toHaveBeenCalled()
  })

  it('returns an error result (no throw, and still cleans up) when the daemon concat rejects', async () => {
    const { executors, getRemoved } = build({
      concatClips: vi.fn(async () => {
        throw new Error('VideoToolbox could not open the asset')
      })
    })
    const result = await executors.executeVtTool(
      'video_concat_clips',
      { segments: [{ inputPath: 'a.mp4' }, { inputPath: 'b.mp4' }] },
      {}
    )
    expect(result.isError).toBe(true)
    expect(result.text).toContain('VideoToolbox could not open the asset')
    expect(result.trustedMediaRefs).toBeUndefined()
    expect(getRemoved()).toContain('/staging/out.mp4')
  })

  it('a persistOutputFile failure yields an error result with NO trusted refs (and still cleans up)', async () => {
    const { executors, getRemoved } = build({
      persistOutputFile: vi.fn(async () => ({ ok: false as const, reason: 'disk_full' }))
    })
    const result = await executors.executeVtTool(
      'video_concat_clips',
      { segments: [{ inputPath: 'a.mp4' }, { inputPath: 'b.mp4' }] },
      {}
    )
    expect(result.isError).toBe(true)
    expect(result.text).toContain('disk_full')
    expect(result.trustedMediaRefs).toBeUndefined()
    expect(getRemoved()).toContain('/staging/out.mp4')
  })

  it('fails without a ref when persistence rejects an empty concatenated output', async () => {
    const { executors, getRemoved } = build({
      persistOutputFile: vi.fn(async () => ({ ok: false as const, reason: 'too_large' }))
    })
    const result = await executors.executeVtTool(
      'video_concat_clips',
      { segments: [{ inputPath: 'a.mp4' }, { inputPath: 'b.mp4' }] },
      {}
    )
    expect(result.isError).toBe(true)
    expect(result.text).toContain('too_large')
    expect(result.trustedMediaRefs).toBeUndefined()
    expect(getRemoved()).toContain('/staging/out.mp4')
  })

  it('renders the software-encode label when usedHardware is false', async () => {
    const { executors } = build({
      concatClips: vi.fn(async () => ({ ...CONCAT_RESULT, usedHardware: false }))
    })
    const result = await executors.executeVtTool(
      'video_concat_clips',
      { segments: [{ inputPath: 'a.mp4' }, { inputPath: 'b.mp4' }] },
      {}
    )
    expect(result.isError).toBeFalsy()
    expect(result.text).toContain('software')
  })
})

// audio_mix — mixes N audio TRACKS into one WAV/M4A. Like the video producers the output
// is an AUDIO FILE, so it rides the TRUSTED media channel (trustedMediaRefs). Each track
// is INDEPENDENTLY realpath-jailed via jailInput before the daemon runs. Output mime is
// the asset-store-known 'audio/wav' | 'audio/mp4' (NEVER 'audio/x-m4a').
describe('audio_mix', () => {
  it('jails every track, forwards the realPaths + per-track knobs to mixdown, and returns a trusted audio ref', async () => {
    // Per-track realPath so we can prove each agent-supplied path was jailed and the
    // JAILED path (not the raw string) reached the daemon, preserving order.
    let i = 0
    const { executors, deps, getMixParams, getRemoved } = build({
      jailInput: vi.fn(() => ({ ok: true as const, realPath: `/ws/trk-${i++}.wav`, cleanup: vi.fn(() => true) }))
    })
    const result = await executors.executeVtTool(
      'audio_mix',
      {
        tracks: [
          { sourcePath: 'a.wav' },
          { sourcePath: 'b.wav', gainDb: -3, pan: 0.5, offsetMs: 250, fadeInMs: 100, fadeOutMs: 200 },
          { sourcePath: 'c.wav' }
        ],
        format: 'wav',
        sampleRate: 48000,
        channels: 1
      },
      { appRunId: 'run-7' }
    )
    expect(result.isError).toBeFalsy()
    // Every track path was jailed (with the ctx).
    expect(deps.jailInput).toHaveBeenCalledTimes(3)
    expect(deps.jailInput).toHaveBeenCalledWith('a.wav', { appRunId: 'run-7' })
    expect(deps.jailInput).toHaveBeenCalledWith('b.wav', { appRunId: 'run-7' })
    expect(deps.jailInput).toHaveBeenCalledWith('c.wav', { appRunId: 'run-7' })
    // The JAILED realPaths (in order) + per-track knobs + staging path WE named reach the daemon.
    const params = getMixParams()
    expect(params?.outputPath).toBe('/staging/out.wav')
    expect(params?.format).toBe('wav')
    expect(params?.sampleRate).toBe(48000)
    expect(params?.channels).toBe(1)
    expect(params?.bitrateKbps).toBe(192) // defaulted
    expect(params?.tracks.map((t) => t.sourcePath)).toEqual(['/ws/trk-0.wav', '/ws/trk-1.wav', '/ws/trk-2.wav'])
    expect(params?.tracks[1].gainDb).toBe(-3)
    expect(params?.tracks[1].pan).toBe(0.5)
    expect(params?.tracks[1].offsetMs).toBe(250)
    expect(params?.tracks[1].fadeInMs).toBe(100)
    expect(params?.tracks[1].fadeOutMs).toBe(200)
    expect(params?.tracks[0].gainDb).toBeUndefined()
    // Persisted with the WAV mime; rides the TRUSTED AV channel.
    expect(deps.persistOutputFile).toHaveBeenCalledWith('/staging/out.wav', 'audio/wav')
    const refs = result.trustedMediaRefs ?? []
    expect(refs).toHaveLength(1)
    expect(refs[0].kind).toBe('audio')
    expect(refs[0].mimeType).toBe('audio/wav')
    expect(refs[0].sha256).toBe('f'.repeat(64))
    expect(refs[0].id).toContain('run-7')
    // Output label derives from the FIRST track's source.
    expect(refs[0].name).toBe('a-mix.wav')
    expect(refs[0].durationMs).toBe(MIX_RESULT.durationMs)
    expect(refs[0].codecs).toBe('pcm_s16le')
    // NOT an image-block result, but DOES carry a text summary block.
    expect((result.content ?? []).some((b) => b.type === 'image')).toBe(false)
    const textBlock = (result.content ?? []).find((b) => b.type === 'text') as { type: 'text'; text: string } | undefined
    expect(textBlock?.text).toContain('Mixed 3 tracks')
    expect(textBlock?.text).toContain('a-mix.wav')
    // Staging file cleaned up.
    expect(getRemoved()).toContain('/staging/out.wav')
  })

  it('accepts the minimum of 1 track and defaults format=wav / sampleRate=44100 / channels=2', async () => {
    const { executors, getMixParams } = build()
    const result = await executors.executeVtTool('audio_mix', { tracks: [{ sourcePath: 'a.wav' }] }, {})
    expect(result.isError).toBeFalsy()
    const params = getMixParams()
    expect(params?.tracks).toHaveLength(1)
    expect(params?.format).toBe('wav')
    expect(params?.sampleRate).toBe(44100)
    expect(params?.channels).toBe(2)
    expect(params?.bitrateKbps).toBe(192)
    expect(result.text).toContain('Mixed 1 tracks')
  })

  it('emits an m4a/audio-mp4 ref (NEVER audio/x-m4a) for format m4a + forwards bitrateKbps', async () => {
    const { executors, deps, getMixParams } = build()
    const result = await executors.executeVtTool(
      'audio_mix',
      { tracks: [{ sourcePath: 'a.wav' }], format: 'm4a', bitrateKbps: 256 },
      {}
    )
    expect(result.isError).toBeFalsy()
    expect(getMixParams()?.format).toBe('m4a')
    expect(getMixParams()?.outputPath).toBe('/staging/out.m4a')
    expect(getMixParams()?.bitrateKbps).toBe(256)
    // Asset-store-known AV mime — audio/mp4, NOT audio/x-m4a.
    expect(deps.persistOutputFile).toHaveBeenCalledWith('/staging/out.m4a', 'audio/mp4')
    const refs = result.trustedMediaRefs ?? []
    expect(refs[0].mimeType).toBe('audio/mp4')
    expect(refs[0].kind).toBe('audio')
    expect(refs[0].name).toBe('a-mix.m4a')
  })

  it('falls back to wav for an unrecognized format string', async () => {
    const { executors, getMixParams } = build()
    const result = await executors.executeVtTool(
      'audio_mix',
      { tracks: [{ sourcePath: 'a.wav' }], format: 'flac' },
      {}
    )
    expect(result.isError).toBeFalsy()
    expect(getMixParams()?.format).toBe('wav')
    expect(getMixParams()?.outputPath).toBe('/staging/out.wav')
  })

  it('rejects an empty / non-array tracks WITHOUT mixing', async () => {
    const { executors, deps } = build()
    const result = await executors.executeVtTool('audio_mix', { tracks: [] }, {})
    expect(result.isError).toBe(true)
    expect(result.text).toContain('at least 1 track')
    expect(deps.jailInput).not.toHaveBeenCalled()
    expect(deps.mixdown).not.toHaveBeenCalled()
    const missing = await executors.executeVtTool('audio_mix', {}, {})
    expect(missing.isError).toBe(true)
    expect(missing.text).toContain('at least 1 track')
  })

  it('rejects more than 24 tracks WITHOUT mixing', async () => {
    const { executors, deps } = build()
    const tracks = Array.from({ length: 25 }, (_, n) => ({ sourcePath: `clip-${n}.wav` }))
    const result = await executors.executeVtTool('audio_mix', { tracks, format: 'wav' }, {})
    expect(result.isError).toBe(true)
    expect(result.text).toContain('too many tracks')
    expect(deps.mixdown).not.toHaveBeenCalled()
  })

  it('rejects a track with an empty sourcePath WITHOUT mixing', async () => {
    const { executors, deps } = build()
    const result = await executors.executeVtTool(
      'audio_mix',
      { tracks: [{ sourcePath: 'a.wav' }, { sourcePath: '   ' }], format: 'wav' },
      {}
    )
    expect(result.isError).toBe(true)
    expect(result.text).toContain('track 1')
    expect(result.text).toContain('sourcePath')
    expect(deps.mixdown).not.toHaveBeenCalled()
  })

  it('surfaces a per-track jail rejection (with its index) and ABORTS before mixdown', async () => {
    // The 2nd track fails the jail; the whole mix must abort and never run.
    let call = 0
    const { executors, deps } = build({
      jailInput: vi.fn(() => {
        call++
        return call === 2
          ? ({ ok: false as const, reason: 'outside_allowed_roots' })
          : ({ ok: true as const, realPath: '/ws/ok.wav', cleanup: vi.fn(() => true) })
      })
    })
    const result = await executors.executeVtTool(
      'audio_mix',
      { tracks: [{ sourcePath: 'ok.wav' }, { sourcePath: '../../etc/passwd' }, { sourcePath: 'c.wav' }], format: 'wav' },
      {}
    )
    expect(result.isError).toBe(true)
    expect(result.text).toContain('track 1')
    expect(result.text).toContain('outside_allowed_roots')
    expect(deps.mixdown).not.toHaveBeenCalled()
  })

  it('returns an error result (no throw, and still cleans up) when the daemon mixdown rejects', async () => {
    const { executors, getRemoved } = build({
      mixdown: vi.fn(async () => {
        throw new Error('audio engine could not open the asset')
      })
    })
    const result = await executors.executeVtTool('audio_mix', { tracks: [{ sourcePath: 'a.wav' }], format: 'wav' }, {})
    expect(result.isError).toBe(true)
    expect(result.text).toContain('audio engine could not open the asset')
    expect(result.trustedMediaRefs).toBeUndefined()
    expect(getRemoved()).toContain('/staging/out.wav')
  })

  it('a persistOutputFile failure yields an error result with NO trusted refs (and still cleans up)', async () => {
    const { executors, getRemoved } = build({
      persistOutputFile: vi.fn(async () => ({ ok: false as const, reason: 'disk_full' }))
    })
    const result = await executors.executeVtTool('audio_mix', { tracks: [{ sourcePath: 'a.wav' }], format: 'wav' }, {})
    expect(result.isError).toBe(true)
    expect(result.text).toContain('disk_full')
    expect(result.trustedMediaRefs).toBeUndefined()
    expect(getRemoved()).toContain('/staging/out.wav')
  })

  it('fails without a ref when persistence rejects an empty mixed output', async () => {
    const { executors, getRemoved } = build({
      persistOutputFile: vi.fn(async () => ({ ok: false as const, reason: 'too_large' }))
    })
    const result = await executors.executeVtTool('audio_mix', { tracks: [{ sourcePath: 'a.wav' }], format: 'wav' }, {})
    expect(result.isError).toBe(true)
    expect(result.text).toContain('too_large')
    expect(result.trustedMediaRefs).toBeUndefined()
    expect(getRemoved()).toContain('/staging/out.wav')
  })

  it('fails LOUDLY (error result, no trusted refs) when buildAvMediaRef would return null', async () => {
    // Force the null-ref branch by handing persistOutputFile back an empty sha256 (buildAvMediaRef
    // returns null on an empty digest) — the executor must NOT return a silent empty-success.
    const { executors, getRemoved } = build({
      persistOutputFile: vi.fn(() => ({
        ok: true as const,
        path: '/assets/canonical-output',
        sha256: '',
        byteLength: 42
      }))
    })
    const result = await executors.executeVtTool('audio_mix', { tracks: [{ sourcePath: 'a.wav' }], format: 'wav' }, {})
    expect(result.isError).toBe(true)
    expect(result.trustedMediaRefs).toBeUndefined()
    expect(getRemoved()).toContain('/staging/out.wav')
  })

  // Part 1 — audio_mix asks for an AUDIO-kind waveform poster + harvested peaks, both
  // threaded onto the ref (the poster is the fallback; peaks drive the DAW waveform).
  it('threads an audio-kind waveform poster AND peaks onto the mixed ref', async () => {
    const { executors, deps } = build({
      generatePoster: vi.fn(async () => ({
        thumbnail: { dataBase64: 'V0FWRQ==', mimeType: 'image/jpeg', width: 320, height: 80 },
        peaks: [0, 128, 255, 64]
      }))
    })
    const result = await executors.executeVtTool('audio_mix', { tracks: [{ sourcePath: 'a.wav' }], format: 'wav' }, {})
    expect(result.isError).toBeFalsy()
    expect(deps.generatePoster).toHaveBeenCalledWith('/assets/canonical-output', 'audio', 'audio/wav', 42)
    const refs = result.trustedMediaRefs ?? []
    expect(refs).toHaveLength(1)
    expect(refs[0].thumbnail).toEqual({ dataBase64: 'V0FWRQ==', mimeType: 'image/jpeg', width: 320, height: 80 })
    expect(refs[0].peaks).toEqual([0, 128, 255, 64])
  })

  it('still returns the mixed ref WITHOUT a thumbnail when the poster generator throws', async () => {
    const { executors } = build({
      generatePoster: vi.fn(async () => {
        throw new Error('analyze exploded')
      })
    })
    const result = await executors.executeVtTool('audio_mix', { tracks: [{ sourcePath: 'a.wav' }], format: 'wav' }, {})
    expect(result.isError).toBeFalsy()
    const refs = result.trustedMediaRefs ?? []
    expect(refs).toHaveLength(1)
    expect(refs[0].thumbnail).toBeUndefined()
  })
})

describe('transcribe_audio', () => {
  it('jails the input, transcribes over the REAL path, and returns STRUCTURED TEXT (no media ref)', async () => {
    const { executors, deps, getTranscribeParams } = build()
    const result = await executors.executeVtTool(
      'transcribe_audio',
      { sourcePath: 'memo.m4a', localeIdentifier: 'en-US' },
      { appChatId: 'c1', appRunId: 'r1' }
    )
    expect(result.isError).toBeFalsy()
    expect(deps.jailInput).toHaveBeenCalledWith('memo.m4a', { appChatId: 'c1', appRunId: 'r1' })
    // Transcribe runs over the JAILED real path, not the agent-supplied string.
    expect(getTranscribeParams()?.sourcePath).toBe('/ws/clip.mp4')
    expect(getTranscribeParams()?.localeIdentifier).toBe('en-US')
    // Structured text: the human header carries the transcript, structuredContent carries
    // the typed transcript + per-segment array. There is NO media ref (read-only text).
    expect(result.text).toContain('hello world')
    expect(result.text).toContain('on-device')
    expect(result.text).toContain('"startMs":0')
    expect(result.trustedMediaRefs).toBeUndefined()
    expect((result.content ?? []).some((b) => b.type === 'image')).toBe(false)
    const sc = result.structuredContent as { ok: boolean; text: string; onDevice: boolean; segments: unknown[] }
    expect(sc.ok).toBe(true)
    expect(sc.text).toBe('hello world')
    expect(sc.onDevice).toBe(true)
    expect(sc.segments).toHaveLength(2)
  })

  it('passes undefined locale (daemon default) when none / blank supplied', async () => {
    const { executors, getTranscribeParams } = build()
    await executors.executeVtTool('transcribe_audio', { sourcePath: 'memo.m4a' }, {})
    expect(getTranscribeParams()?.localeIdentifier).toBeUndefined()
    await executors.executeVtTool('transcribe_audio', { sourcePath: 'memo.m4a', localeIdentifier: '  ' }, {})
    expect(getTranscribeParams()?.localeIdentifier).toBeUndefined()
  })

  it('rejects a missing sourcePath before jailing or transcribing', async () => {
    const { executors, deps } = build()
    const result = await executors.executeVtTool('transcribe_audio', {}, {})
    expect(result.isError).toBe(true)
    expect(result.text).toContain('provide sourcePath')
    expect(deps.jailInput).not.toHaveBeenCalled()
    expect(deps.transcribe).not.toHaveBeenCalled()
  })

  it('surfaces a jail rejection WITHOUT calling transcribe', async () => {
    const { executors, deps } = build({
      jailInput: vi.fn(() => ({ ok: false as const, reason: 'outside_allowed_roots' }))
    })
    const result = await executors.executeVtTool('transcribe_audio', { sourcePath: '../../etc/passwd' }, {})
    expect(result.isError).toBe(true)
    expect(result.text).toContain('outside_allowed_roots')
    expect(deps.transcribe).not.toHaveBeenCalled()
  })

  it('gracefully fails (does NOT throw) on the auth-denied daemon error, surfacing the actionable message', async () => {
    const { executors } = build({
      transcribe: vi.fn(async () => {
        throw new Error(
          'Speech Recognition permission not granted — enable it in System Settings › Privacy & Security › Speech Recognition'
        )
      })
    })
    const result = await executors.executeVtTool('transcribe_audio', { sourcePath: 'memo.m4a' }, {})
    expect(result.isError).toBe(true)
    // The daemon's actionable permission message rides through verbatim.
    expect(result.text).toContain('System Settings')
    expect(result.text).toContain('Speech Recognition')
    expect(result.trustedMediaRefs).toBeUndefined()
  })

  it('gracefully fails on a generic recognizer error (no crash, no ref)', async () => {
    const { executors } = build({
      transcribe: vi.fn(async () => {
        throw new Error('speech recognition failed: kAFAssistantErrorDomain 1101')
      })
    })
    const result = await executors.executeVtTool('transcribe_audio', { sourcePath: 'memo.m4a' }, {})
    expect(result.isError).toBe(true)
    expect(result.text).toContain('1101')
  })

  it('renders an empty transcript as a "(no speech detected)" placeholder, still ok', async () => {
    const { executors } = build({
      transcribe: vi.fn(async () => ({ text: '', segments: [], localeIdentifier: 'en-US', onDevice: true }))
    })
    const result = await executors.executeVtTool('transcribe_audio', { sourcePath: 'silence.wav' }, {})
    expect(result.isError).toBeFalsy()
    expect(result.text).toContain('(no speech detected)')
    expect(result.text).toContain('segments: []')
  })
})

describe('staged input cleanup ownership', () => {
  it('cleans decode, frame-inspection, and transcription inputs exactly once on success and daemon failure', async () => {
    const decodeSuccess = build()
    await decodeSuccess.executors.executeVtTool('video_decode_frame', { inputPath: 'clip.mp4' }, {})
    expect(decodeSuccess.inputCleanup).toHaveBeenCalledTimes(1)

    const decodeFailureCleanup = vi.fn(() => true)
    const decodeFailure = build({
      jailInput: vi.fn(() => ({
        ok: true as const,
        realPath: '/staged/decode.mp4',
        cleanup: decodeFailureCleanup
      })),
      decodeFrame: vi.fn(async () => {
        throw new Error('decode failed')
      })
    })
    const failedDecode = await decodeFailure.executors.executeVtTool(
      'video_decode_frame',
      { inputPath: 'clip.mp4' },
      {}
    )
    expect(failedDecode.isError).toBe(true)
    expect(decodeFailureCleanup).toHaveBeenCalledTimes(1)

    const inspectCleanup = vi.fn(() => true)
    let inspectCall = 0
    const inspect = build({
      jailInput: vi.fn(() => ({
        ok: true as const,
        realPath: '/staged/inspect.mp4',
        cleanup: inspectCleanup
      })),
      decodeFrame: vi.fn(async (params) => {
        inspectCall += 1
        if (inspectCall > 1) throw new Error('past EOF')
        return { ...DECODE_RESULT, timestampSeconds: params.timestampSeconds ?? 0 }
      })
    })
    const inspected = await inspect.executors.executeVtTool(
      'inspect_video_frames',
      { inputPath: 'clip.mp4', timestamps: [0, 1] },
      {}
    )
    expect(inspected.isError).toBeFalsy()
    expect(inspectCleanup).toHaveBeenCalledTimes(1)

    const transcribeCleanup = vi.fn(() => true)
    const transcription = build({
      jailInput: vi.fn(() => ({
        ok: true as const,
        realPath: '/staged/memo.m4a',
        cleanup: transcribeCleanup
      })),
      transcribe: vi.fn(async () => {
        throw new Error('recognizer failed')
      })
    })
    const failedTranscription = await transcription.executors.executeVtTool(
      'transcribe_audio',
      { sourcePath: 'memo.m4a' },
      {}
    )
    expect(failedTranscription.isError).toBe(true)
    expect(transcribeCleanup).toHaveBeenCalledTimes(1)
  })

  it('cleans the encode input and overlay exactly once on success, failure, and overlay rejection', async () => {
    const inputCleanup = vi.fn(() => true)
    const overlayCleanup = vi.fn(() => true)
    const success = build({
      jailInput: vi.fn(() => ({ ok: true as const, realPath: '/staged/clip.mp4', cleanup: inputCleanup })),
      jailOverlay: vi.fn(() => ({ ok: true as const, realPath: '/staged/logo.png', cleanup: overlayCleanup }))
    })
    const result = await success.executors.executeVtTool(
      'video_encode_clip',
      { inputPath: 'clip.mp4', overlayPath: 'logo.png' },
      {}
    )
    expect(result.isError).toBeFalsy()
    expect(inputCleanup).toHaveBeenCalledTimes(1)
    expect(overlayCleanup).toHaveBeenCalledTimes(1)

    const failedInputCleanup = vi.fn(() => true)
    const failedOverlayCleanup = vi.fn(() => true)
    const failed = build({
      jailInput: vi.fn(() => ({
        ok: true as const,
        realPath: '/staged/clip.mp4',
        cleanup: failedInputCleanup
      })),
      jailOverlay: vi.fn(() => ({
        ok: true as const,
        realPath: '/staged/logo.png',
        cleanup: failedOverlayCleanup
      })),
      encodeClip: vi.fn(async () => {
        throw new Error('encode failed')
      })
    })
    const failedResult = await failed.executors.executeVtTool(
      'video_encode_clip',
      { inputPath: 'clip.mp4', overlayPath: 'logo.png' },
      {}
    )
    expect(failedResult.isError).toBe(true)
    expect(failedInputCleanup).toHaveBeenCalledTimes(1)
    expect(failedOverlayCleanup).toHaveBeenCalledTimes(1)

    const rejectedInputCleanup = vi.fn(() => true)
    const rejected = build({
      jailInput: vi.fn(() => ({
        ok: true as const,
        realPath: '/staged/clip.mp4',
        cleanup: rejectedInputCleanup
      })),
      jailOverlay: vi.fn(() => ({ ok: false as const, reason: 'unsafe_overlay' }))
    })
    const rejectedResult = await rejected.executors.executeVtTool(
      'video_encode_clip',
      { inputPath: 'clip.mp4', overlayPath: 'logo.svg' },
      {}
    )
    expect(rejectedResult.isError).toBe(true)
    expect(rejectedInputCleanup).toHaveBeenCalledTimes(1)
    expect(rejected.deps.encodeClip).not.toHaveBeenCalled()
  })

  it('cleans all concatenation inputs exactly once, including a later jail failure', async () => {
    const successCleanups = [vi.fn(() => true), vi.fn(() => true), vi.fn(() => true)]
    let successIndex = 0
    const success = build({
      jailInput: vi.fn(() => {
        const index = successIndex++
        return {
          ok: true as const,
          realPath: `/staged/segment-${index}.mp4`,
          cleanup: successCleanups[index]
        }
      })
    })
    const successResult = await success.executors.executeVtTool(
      'video_concat_clips',
      { segments: [{ inputPath: 'a.mp4' }, { inputPath: 'b.mp4' }, { inputPath: 'c.mp4' }] },
      {}
    )
    expect(successResult.isError).toBeFalsy()
    for (const cleanup of successCleanups) expect(cleanup).toHaveBeenCalledTimes(1)

    const partialCleanup = vi.fn(() => true)
    let partialIndex = 0
    const partial = build({
      jailInput: vi.fn(() => {
        partialIndex += 1
        return partialIndex === 1
          ? { ok: true as const, realPath: '/staged/a.mp4', cleanup: partialCleanup }
          : { ok: false as const, reason: 'outside_allowed_roots' }
      })
    })
    const partialResult = await partial.executors.executeVtTool(
      'video_concat_clips',
      { segments: [{ inputPath: 'a.mp4' }, { inputPath: 'bad.mp4' }, { inputPath: 'c.mp4' }] },
      {}
    )
    expect(partialResult.isError).toBe(true)
    expect(partialCleanup).toHaveBeenCalledTimes(1)
    expect(partial.deps.jailInput).toHaveBeenCalledTimes(2)
    expect(partial.deps.concatClips).not.toHaveBeenCalled()

    const failedCleanups = [vi.fn(() => true), vi.fn(() => true)]
    let failedIndex = 0
    const failed = build({
      jailInput: vi.fn(() => {
        const index = failedIndex++
        return {
          ok: true as const,
          realPath: `/staged/segment-${index}.mp4`,
          cleanup: failedCleanups[index]
        }
      }),
      concatClips: vi.fn(async () => {
        throw new Error('concat failed')
      })
    })
    const failedResult = await failed.executors.executeVtTool(
      'video_concat_clips',
      { segments: [{ inputPath: 'a.mp4' }, { inputPath: 'b.mp4' }] },
      {}
    )
    expect(failedResult.isError).toBe(true)
    for (const cleanup of failedCleanups) expect(cleanup).toHaveBeenCalledTimes(1)
  })

  it('cleans all mixdown inputs exactly once, including a later jail failure', async () => {
    const successCleanups = [vi.fn(() => true), vi.fn(() => true), vi.fn(() => true)]
    let successIndex = 0
    const success = build({
      jailInput: vi.fn(() => {
        const index = successIndex++
        return {
          ok: true as const,
          realPath: `/staged/track-${index}.wav`,
          cleanup: successCleanups[index]
        }
      })
    })
    const successResult = await success.executors.executeVtTool(
      'audio_mix',
      { tracks: [{ sourcePath: 'a.wav' }, { sourcePath: 'b.wav' }, { sourcePath: 'c.wav' }] },
      {}
    )
    expect(successResult.isError).toBeFalsy()
    for (const cleanup of successCleanups) expect(cleanup).toHaveBeenCalledTimes(1)

    const partialCleanup = vi.fn(() => true)
    let partialIndex = 0
    const partial = build({
      jailInput: vi.fn(() => {
        partialIndex += 1
        return partialIndex === 1
          ? { ok: true as const, realPath: '/staged/a.wav', cleanup: partialCleanup }
          : { ok: false as const, reason: 'outside_allowed_roots' }
      })
    })
    const partialResult = await partial.executors.executeVtTool(
      'audio_mix',
      { tracks: [{ sourcePath: 'a.wav' }, { sourcePath: 'bad.wav' }, { sourcePath: 'c.wav' }] },
      {}
    )
    expect(partialResult.isError).toBe(true)
    expect(partialCleanup).toHaveBeenCalledTimes(1)
    expect(partial.deps.jailInput).toHaveBeenCalledTimes(2)
    expect(partial.deps.mixdown).not.toHaveBeenCalled()

    const failedCleanups = [vi.fn(() => true), vi.fn(() => true)]
    let failedIndex = 0
    const failed = build({
      jailInput: vi.fn(() => {
        const index = failedIndex++
        return {
          ok: true as const,
          realPath: `/staged/track-${index}.wav`,
          cleanup: failedCleanups[index]
        }
      }),
      mixdown: vi.fn(async () => {
        throw new Error('mixdown failed')
      })
    })
    const failedResult = await failed.executors.executeVtTool(
      'audio_mix',
      { tracks: [{ sourcePath: 'a.wav' }, { sourcePath: 'b.wav' }] },
      {}
    )
    expect(failedResult.isError).toBe(true)
    for (const cleanup of failedCleanups) expect(cleanup).toHaveBeenCalledTimes(1)
  })

  it('cleans successfully jailed inputs when staging path creation throws and ignores cleanup errors', async () => {
    const stagingCleanup = vi.fn(() => true)
    const stagingFailure = build({
      jailInput: vi.fn(() => ({
        ok: true as const,
        realPath: '/staged/clip.mp4',
        cleanup: stagingCleanup
      })),
      stagingPath: vi.fn(() => {
        throw new Error('staging unavailable')
      })
    })
    await expect(
      stagingFailure.executors.executeVtTool('video_encode_clip', { inputPath: 'clip.mp4' }, {})
    ).rejects.toThrow('staging unavailable')
    expect(stagingCleanup).toHaveBeenCalledTimes(1)

    const throwingCleanup = vi.fn(() => {
      throw new Error('cleanup failed')
    })
    const cleanupFailure = build({
      jailInput: vi.fn(() => ({
        ok: true as const,
        realPath: '/staged/clip.mp4',
        cleanup: throwingCleanup
      }))
    })
    const result = await cleanupFailure.executors.executeVtTool(
      'video_decode_frame',
      { inputPath: 'clip.mp4' },
      {}
    )
    expect(result.isError).toBeFalsy()
    expect(throwingCleanup).toHaveBeenCalledTimes(1)
  })
})
