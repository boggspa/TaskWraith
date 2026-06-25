import { describe, expect, it, vi } from 'vitest'
import { createVtToolExecutors, isVtMcpToolName, type VtToolDeps } from './VtToolExecutors'

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
  const removed: string[] = []
  const deps: VtToolDeps = {
    jailInput: vi.fn(() => ({ ok: true as const, realPath: '/ws/clip.mp4' })),
    jailOverlay: vi.fn(() => ({ ok: true as const, realPath: '/ws/logo.png' })),
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
    stagingPath: vi.fn((ext: string) => `/staging/out.${ext}`),
    readOutput: vi.fn(() => Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x18]), Buffer.from('ftypmp42clip')])),
    persistOutput: vi.fn((_buffer: Buffer, _mimeType: string) => ({ ok: true as const, sha256: 'f'.repeat(64) })),
    removeFile: vi.fn((p: string) => {
      removed.push(p)
    }),
    ...overrides
  }
  const executors = createVtToolExecutors(deps)
  return {
    executors,
    deps,
    getDecodeParams: () => lastDecodeParams,
    getEncodeParams: () => lastEncodeParams,
    getConcatParams: () => lastConcatParams,
    getMixParams: () => lastMixParams,
    getRemoved: () => removed
  }
}

describe('isVtMcpToolName', () => {
  it('recognizes the VideoToolbox tools only', () => {
    expect(isVtMcpToolName('video_decode_frame')).toBe(true)
    expect(isVtMcpToolName('video_encode_clip')).toBe(true)
    expect(isVtMcpToolName('video_concat_clips')).toBe(true)
    expect(isVtMcpToolName('audio_mix')).toBe(true)
    expect(isVtMcpToolName('video_thumbnail')).toBe(false)
    expect(isVtMcpToolName('video_probe')).toBe(false)
    expect(isVtMcpToolName('something_else')).toBe(false)
  })
})

describe('video_decode_frame', () => {
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
    expect(deps.persistOutput).toHaveBeenCalledWith(expect.any(Buffer), 'video/mp4')
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

  it('a persistOutput failure yields an error result with NO trusted refs (and still cleans up)', async () => {
    const { executors, getRemoved } = build({
      persistOutput: vi.fn(() => ({ ok: false as const, reason: 'disk_full' }))
    })
    const result = await executors.executeVtTool('video_encode_clip', { inputPath: 'clip.mp4' }, {})
    expect(result.isError).toBe(true)
    expect(result.text).toContain('disk_full')
    expect(result.trustedMediaRefs).toBeUndefined()
    expect(getRemoved()).toContain('/staging/out.mp4')
  })

  it('fails (and cleans up) when the encoded output is empty', async () => {
    const { executors, deps, getRemoved } = build({
      readOutput: vi.fn(() => Buffer.alloc(0))
    })
    const result = await executors.executeVtTool('video_encode_clip', { inputPath: 'clip.mp4' }, {})
    expect(result.isError).toBe(true)
    expect(result.text).toContain('empty')
    expect(deps.persistOutput).not.toHaveBeenCalled()
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
      jailInput: vi.fn(() => ({ ok: true as const, realPath: `/ws/seg-${i++}.mp4` }))
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
    expect(deps.persistOutput).toHaveBeenCalledWith(expect.any(Buffer), 'video/mp4')
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
          : ({ ok: true as const, realPath: '/ws/ok.mp4' })
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

  it('a persistOutput failure yields an error result with NO trusted refs (and still cleans up)', async () => {
    const { executors, getRemoved } = build({
      persistOutput: vi.fn(() => ({ ok: false as const, reason: 'disk_full' }))
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

  it('fails (and cleans up) when the concatenated output is empty', async () => {
    const { executors, deps, getRemoved } = build({
      readOutput: vi.fn(() => Buffer.alloc(0))
    })
    const result = await executors.executeVtTool(
      'video_concat_clips',
      { segments: [{ inputPath: 'a.mp4' }, { inputPath: 'b.mp4' }] },
      {}
    )
    expect(result.isError).toBe(true)
    expect(result.text).toContain('empty')
    expect(deps.persistOutput).not.toHaveBeenCalled()
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
      jailInput: vi.fn(() => ({ ok: true as const, realPath: `/ws/trk-${i++}.wav` }))
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
    expect(deps.persistOutput).toHaveBeenCalledWith(expect.any(Buffer), 'audio/wav')
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
    expect(deps.persistOutput).toHaveBeenCalledWith(expect.any(Buffer), 'audio/mp4')
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
          : ({ ok: true as const, realPath: '/ws/ok.wav' })
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

  it('a persistOutput failure yields an error result with NO trusted refs (and still cleans up)', async () => {
    const { executors, getRemoved } = build({
      persistOutput: vi.fn(() => ({ ok: false as const, reason: 'disk_full' }))
    })
    const result = await executors.executeVtTool('audio_mix', { tracks: [{ sourcePath: 'a.wav' }], format: 'wav' }, {})
    expect(result.isError).toBe(true)
    expect(result.text).toContain('disk_full')
    expect(result.trustedMediaRefs).toBeUndefined()
    expect(getRemoved()).toContain('/staging/out.wav')
  })

  it('fails (and cleans up) when the mixed output is empty', async () => {
    const { executors, deps, getRemoved } = build({
      readOutput: vi.fn(() => Buffer.alloc(0))
    })
    const result = await executors.executeVtTool('audio_mix', { tracks: [{ sourcePath: 'a.wav' }], format: 'wav' }, {})
    expect(result.isError).toBe(true)
    expect(result.text).toContain('empty')
    expect(deps.persistOutput).not.toHaveBeenCalled()
    expect(getRemoved()).toContain('/staging/out.wav')
  })

  it('fails LOUDLY (error result, no trusted refs) when buildAvMediaRef would return null', async () => {
    // Force the null-ref branch by handing persistOutput back an empty sha256 (buildAvMediaRef
    // returns null on an empty digest) — the executor must NOT return a silent empty-success.
    const { executors, getRemoved } = build({
      persistOutput: vi.fn(() => ({ ok: true as const, sha256: '' }))
    })
    const result = await executors.executeVtTool('audio_mix', { tracks: [{ sourcePath: 'a.wav' }], format: 'wav' }, {})
    expect(result.isError).toBe(true)
    expect(result.trustedMediaRefs).toBeUndefined()
    expect(getRemoved()).toContain('/staging/out.wav')
  })
})
