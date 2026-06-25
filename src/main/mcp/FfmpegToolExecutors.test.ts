import { describe, expect, it, vi } from 'vitest'
import {
  createFfmpegToolExecutors,
  isFfmpegMcpToolName,
  type FfmpegToolDeps,
  type JailedMediaInput
} from './FfmpegToolExecutors'

const PROBE_JSON = JSON.stringify({
  streams: [
    { codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, avg_frame_rate: '30/1' },
    { codec_type: 'audio', codec_name: 'aac', channels: 2, sample_rate: '48000' }
  ],
  format: { format_name: 'mov,mp4', duration: '10.0' }
})

function imageBlock(result: { content?: Array<{ type: string }> }) {
  return (result.content ?? []).find((b) => b.type === 'image') as
    | { type: 'image'; mimeType: string; data: string }
    | undefined
}

function build(overrides: Partial<FfmpegToolDeps> = {}) {
  let lastProbeArgs: string[] | null = null
  let lastFfmpegArgs: string[] | null = null
  const removed: string[] = []
  const deps: FfmpegToolDeps = {
    jailInput: vi.fn((): JailedMediaInput => ({ ok: true, realPath: '/ws/clip.mp4', mimeType: 'video/mp4' })),
    resolveFfprobe: vi.fn(() => '/opt/homebrew/bin/ffprobe'),
    resolveFfmpeg: vi.fn(() => '/opt/homebrew/bin/ffmpeg'),
    runFfprobe: vi.fn(async (_bin: string, args: string[]) => {
      lastProbeArgs = args
      return { stdout: PROBE_JSON, stderr: '' }
    }),
    runFfmpeg: vi.fn(async (_bin: string, args: string[]) => {
      lastFfmpegArgs = args
      return { stdout: '', stderr: '' }
    }),
    stagingPath: vi.fn((ext: string) => `/staging/out.${ext}`),
    readOutput: vi.fn(() => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('frame')])),
    persistOutput: vi.fn((_buffer: Buffer, _mimeType: string) => ({ ok: true as const, sha256: 'f'.repeat(64) })),
    removeFile: vi.fn((p: string) => {
      removed.push(p)
    }),
    missingMessage: (which) => `install ${which}`,
    ...overrides
  }
  const executors = createFfmpegToolExecutors(deps)
  return { executors, deps, getProbeArgs: () => lastProbeArgs, getFfmpegArgs: () => lastFfmpegArgs, getRemoved: () => removed }
}

describe('isFfmpegMcpToolName', () => {
  it('recognizes the ffmpeg tools only', () => {
    expect(isFfmpegMcpToolName('video_probe')).toBe(true)
    expect(isFfmpegMcpToolName('video_thumbnail')).toBe(true)
    expect(isFfmpegMcpToolName('audio_extract')).toBe(true)
    expect(isFfmpegMcpToolName('transcode_audio')).toBe(true)
    expect(isFfmpegMcpToolName('transcode_video')).toBe(true)
    expect(isFfmpegMcpToolName('audio_analyze')).toBe(false)
  })
})

describe('video_probe', () => {
  it('jails the input, runs ffprobe on the REAL path, returns parsed info', async () => {
    const { executors, deps, getProbeArgs } = build()
    const result = await executors.executeFfmpegTool('video_probe', { sourcePath: 'clip.mp4' }, { appChatId: 'c1' })
    expect(result.isError).toBeFalsy()
    expect(deps.jailInput).toHaveBeenCalledWith('clip.mp4', { appChatId: 'c1' })
    expect(getProbeArgs()?.[getProbeArgs()!.length - 1]).toBe('/ws/clip.mp4')
    const payload = JSON.parse(result.text) as Record<string, unknown>
    expect(payload.hasVideo).toBe(true)
    expect((payload.video as Record<string, unknown>).codec).toBe('h264')
  })

  it('surfaces a jail rejection without running ffprobe', async () => {
    const { executors, deps } = build({
      jailInput: vi.fn((): JailedMediaInput => ({ ok: false, reason: 'outside_allowed_roots' }))
    })
    const result = await executors.executeFfmpegTool('video_probe', { sourcePath: '../../etc/passwd' }, {})
    expect(result.isError).toBe(true)
    expect(result.text).toContain('outside_allowed_roots')
    expect(deps.runFfprobe).not.toHaveBeenCalled()
  })

  it('returns an actionable error when ffprobe is not installed', async () => {
    const { executors } = build({ resolveFfprobe: vi.fn(() => null) })
    const result = await executors.executeFfmpegTool('video_probe', { sourcePath: 'clip.mp4' }, {})
    expect(result.isError).toBe(true)
    expect(result.text).toContain('install ffprobe')
  })
})

describe('video_thumbnail', () => {
  it('extracts a frame over the JAILED path and returns it as an inline PNG image block', async () => {
    const { executors, getFfmpegArgs, getRemoved } = build()
    const result = await executors.executeFfmpegTool('video_thumbnail', { sourcePath: 'clip.mp4', atMs: 2500, width: 320 }, {})
    expect(result.isError).toBeFalsy()
    const args = getFfmpegArgs()!.join(' ')
    expect(args).toContain('-i /ws/clip.mp4') // jailed input
    expect(args).toContain('-frames:v 1')
    expect(args).toContain('/staging/out.png') // staged output WE named
    // Rides the proven image media spine — returned as an {type:'image'} block.
    const img = imageBlock(result)
    expect(img?.mimeType).toBe('image/png')
    expect(img?.data).toBeTruthy()
    // Staging file cleaned up.
    expect(getRemoved()).toContain('/staging/out.png')
  })

  it('reads the PNG output under the IMAGE byte cap (passes image/png mime to readOutput)', async () => {
    const { executors, deps } = build()
    await executors.executeFfmpegTool('video_thumbnail', { sourcePath: 'clip.mp4' }, {})
    // The mimeType arg selects the 8MB image cap (not the 512MB video default).
    expect(deps.readOutput).toHaveBeenCalledWith('/staging/out.png', 'image/png')
  })

  it('returns an actionable error when ffmpeg is not installed', async () => {
    const { executors, deps } = build({ resolveFfmpeg: vi.fn(() => null) })
    const result = await executors.executeFfmpegTool('video_thumbnail', { sourcePath: 'clip.mp4' }, {})
    expect(result.isError).toBe(true)
    expect(result.text).toContain('install ffmpeg')
    expect(deps.runFfmpeg).not.toHaveBeenCalled()
  })

  it('fails (and still cleans up staging) when ffmpeg produces no frame', async () => {
    const { executors, getRemoved } = build({
      readOutput: vi.fn(() => {
        throw new Error('ENOENT')
      })
    })
    const result = await executors.executeFfmpegTool('video_thumbnail', { sourcePath: 'clip.mp4' }, {})
    expect(result.isError).toBe(true)
    expect(result.text).toContain('ffmpeg output unavailable')
    expect(getRemoved()).toContain('/staging/out.png')
  })

  it('fails (and cleans up) when the ffmpeg run throws', async () => {
    const { executors, getRemoved } = build({
      runFfmpeg: vi.fn(async () => {
        throw new Error('ffmpeg timed out')
      })
    })
    const result = await executors.executeFfmpegTool('video_thumbnail', { sourcePath: 'clip.mp4' }, {})
    expect(result.isError).toBe(true)
    expect(result.text).toContain('timed out')
    expect(getRemoved()).toContain('/staging/out.png')
  })
})

// S1b-3 producers — output is audio/video, so it rides the TRUSTED media channel
// (result.trustedMediaRefs, NOT an image block + NOT provider media_refs).
describe('audio_extract / transcode_audio / transcode_video (trusted AV refs)', () => {
  it('audio_extract persists the output and returns a trusted audio ref with a sha-derived id', async () => {
    const { executors, deps, getFfmpegArgs, getRemoved } = build()
    const result = await executors.executeFfmpegTool(
      'audio_extract',
      { sourcePath: 'clip.mp4', format: 'm4a', bitrateKbps: 128 },
      { appRunId: 'run-7' }
    )
    expect(result.isError).toBeFalsy()
    const args = getFfmpegArgs()!.join(' ')
    expect(args).toContain('-i /ws/clip.mp4') // jailed input
    expect(args).toContain('/staging/out.m4a') // staged output WE named
    // Persisted to the asset store with the format's mime.
    expect(deps.persistOutput).toHaveBeenCalledWith(expect.any(Buffer), 'audio/mp4')
    const refs = result.trustedMediaRefs ?? []
    expect(refs).toHaveLength(1)
    expect(refs[0].kind).toBe('audio')
    expect(refs[0].mimeType).toBe('audio/mp4')
    expect(refs[0].sha256).toBe('f'.repeat(64))
    expect(refs[0].id).toContain('f'.repeat(24)) // sha-derived, non-empty
    expect(refs[0].id).toContain('run-7')
    expect(refs[0].name).toBe('clip.m4a')
    // NOT an image-block result.
    expect((result.content ?? []).some((b) => b.type === 'image')).toBe(false)
    // Staging file cleaned up.
    expect(getRemoved()).toContain('/staging/out.m4a')
  })

  it('transcode_audio returns a trusted audio ref (wav → audio/wav)', async () => {
    const { executors, deps } = build()
    const result = await executors.executeFfmpegTool('transcode_audio', { sourcePath: 'song.flac', format: 'wav' }, {})
    expect(result.isError).toBeFalsy()
    expect(deps.persistOutput).toHaveBeenCalledWith(expect.any(Buffer), 'audio/wav')
    const refs = result.trustedMediaRefs ?? []
    expect(refs).toHaveLength(1)
    expect(refs[0].kind).toBe('audio')
    expect(refs[0].mimeType).toBe('audio/wav')
    expect(refs[0].name).toBe('song.wav')
  })

  it('transcode_video returns a trusted video ref (video/mp4)', async () => {
    const { executors, deps, getFfmpegArgs } = build()
    const result = await executors.executeFfmpegTool('transcode_video', { sourcePath: 'clip.mp4', crf: 28, scaleWidth: 640 }, {})
    expect(result.isError).toBeFalsy()
    expect(getFfmpegArgs()!.join(' ')).toContain('/staging/out.mp4')
    expect(deps.persistOutput).toHaveBeenCalledWith(expect.any(Buffer), 'video/mp4')
    const refs = result.trustedMediaRefs ?? []
    expect(refs).toHaveLength(1)
    expect(refs[0].kind).toBe('video')
    expect(refs[0].mimeType).toBe('video/mp4')
    expect(refs[0].id.length).toBeGreaterThan(0)
  })

  it('rejects a producer with a missing/invalid audio format', async () => {
    const { executors, deps } = build()
    const result = await executors.executeFfmpegTool('audio_extract', { sourcePath: 'clip.mp4' }, {})
    expect(result.isError).toBe(true)
    expect(result.text).toContain('format')
    expect(deps.runFfmpeg).not.toHaveBeenCalled()
  })

  it('a persistOutput failure yields an error result with NO trusted refs (and still cleans up)', async () => {
    const { executors, getRemoved } = build({
      persistOutput: vi.fn(() => ({ ok: false as const, reason: 'disk_full' }))
    })
    const result = await executors.executeFfmpegTool('transcode_video', { sourcePath: 'clip.mp4' }, {})
    expect(result.isError).toBe(true)
    expect(result.text).toContain('disk_full')
    expect(result.trustedMediaRefs).toBeUndefined()
    expect(getRemoved()).toContain('/staging/out.mp4')
  })

  it('fails (and cleans up) when a producer ffmpeg run throws', async () => {
    const { executors, deps, getRemoved } = build({
      runFfmpeg: vi.fn(async () => {
        throw new Error('producer timed out')
      })
    })
    const result = await executors.executeFfmpegTool('transcode_audio', { sourcePath: 'a.wav', format: 'mp3' }, {})
    expect(result.isError).toBe(true)
    expect(result.text).toContain('timed out')
    expect(deps.persistOutput).not.toHaveBeenCalled()
    expect(getRemoved()).toContain('/staging/out.mp3')
  })
})
