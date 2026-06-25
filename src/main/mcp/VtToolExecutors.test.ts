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
    getRemoved: () => removed
  }
}

describe('isVtMcpToolName', () => {
  it('recognizes the VideoToolbox tools only', () => {
    expect(isVtMcpToolName('video_decode_frame')).toBe(true)
    expect(isVtMcpToolName('video_encode_clip')).toBe(true)
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
