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
  const inputCleanup = vi.fn(() => true)
  const deps: FfmpegToolDeps = {
    jailInput: vi.fn(
      (): JailedMediaInput => ({
        ok: true,
        realPath: '/ws/clip.mp4',
        mimeType: 'video/mp4',
        cleanup: inputCleanup
      })
    ),
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
    readOutput: vi.fn(() =>
      Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.from('frame')
      ])
    ),
    persistOutputFile: vi.fn((_path: string, _mimeType: string) => ({
      ok: true as const,
      path: '/assets/canonical-output',
      sha256: 'f'.repeat(64),
      byteLength: 42,
      pendingToolMediaPersistence: {
        commit: vi.fn(() => true),
        rollback: vi.fn(async () => undefined)
      }
    })),
    // Default: no poster (mirrors a generator that can't produce one). Specific
    // tests override this to assert the thumbnail is threaded onto the ref, and
    // that a throwing generator still yields a ref WITHOUT a thumbnail.
    generatePoster: vi.fn(async () => undefined),
    removeFile: vi.fn((p: string) => {
      removed.push(p)
    }),
    missingMessage: (which) => `install ${which}`,
    ...overrides
  }
  const executors = createFfmpegToolExecutors(deps)
  return {
    executors,
    deps,
    inputCleanup,
    getProbeArgs: () => lastProbeArgs,
    getFfmpegArgs: () => lastFfmpegArgs,
    getRemoved: () => removed
  }
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
  it('waits for an asynchronous jail before invoking ffprobe', async () => {
    const cleanup = vi.fn(() => true)
    let resolveJail!: (value: JailedMediaInput) => void
    const jailResult = new Promise<JailedMediaInput>((resolve) => {
      resolveJail = resolve
    })
    const { executors, deps } = build({ jailInput: vi.fn(() => jailResult) })

    const pending = executors.executeFfmpegTool(
      'video_probe',
      { sourcePath: 'clip.mp4' },
      { appChatId: 'c1' }
    )
    expect(deps.jailInput).toHaveBeenCalledTimes(1)
    expect(deps.runFfprobe).not.toHaveBeenCalled()

    resolveJail({
      ok: true,
      realPath: '/ws/deferred.mp4',
      mimeType: 'video/mp4',
      cleanup
    })
    const result = await pending
    expect(result.isError).toBeFalsy()
    expect(deps.runFfprobe).toHaveBeenCalledTimes(1)
    expect(cleanup).toHaveBeenCalledTimes(1)
  })

  it('jails the input, runs ffprobe on the REAL path, returns parsed info', async () => {
    const { executors, deps, getProbeArgs, inputCleanup } = build()
    const result = await executors.executeFfmpegTool(
      'video_probe',
      { sourcePath: 'clip.mp4' },
      { appChatId: 'c1' }
    )
    expect(result.isError).toBeFalsy()
    expect(deps.jailInput).toHaveBeenCalledWith('clip.mp4', { appChatId: 'c1' })
    expect(getProbeArgs()?.[getProbeArgs()!.length - 1]).toBe('/ws/clip.mp4')
    const payload = JSON.parse(result.text) as Record<string, unknown>
    expect(payload.hasVideo).toBe(true)
    expect((payload.video as Record<string, unknown>).codec).toBe('h264')
    expect(inputCleanup).toHaveBeenCalledTimes(1)
  })

  it('surfaces a jail rejection without running ffprobe', async () => {
    const { executors, deps } = build({
      jailInput: vi.fn((): JailedMediaInput => ({ ok: false, reason: 'outside_allowed_roots' }))
    })
    const result = await executors.executeFfmpegTool(
      'video_probe',
      { sourcePath: '../../etc/passwd' },
      {}
    )
    expect(result.isError).toBe(true)
    expect(result.text).toContain('outside_allowed_roots')
    expect(deps.runFfprobe).not.toHaveBeenCalled()
  })

  it('returns an actionable error when ffprobe is not installed', async () => {
    const { executors, inputCleanup } = build({ resolveFfprobe: vi.fn(() => null) })
    const result = await executors.executeFfmpegTool('video_probe', { sourcePath: 'clip.mp4' }, {})
    expect(result.isError).toBe(true)
    expect(result.text).toContain('install ffprobe')
    expect(inputCleanup).toHaveBeenCalledTimes(1)
  })

  it('cleans the staged input exactly once on argv rejection and runner failure', async () => {
    const invalidCleanup = vi.fn(() => true)
    const invalid = build({
      jailInput: vi.fn(
        (): JailedMediaInput => ({
          ok: true,
          realPath: 'relative.mp4',
          mimeType: 'video/mp4',
          cleanup: invalidCleanup
        })
      )
    })
    const invalidResult = await invalid.executors.executeFfmpegTool(
      'video_probe',
      { sourcePath: 'clip.mp4' },
      {}
    )
    expect(invalidResult.isError).toBe(true)
    expect(invalidResult.text).toContain('must be absolute')
    expect(invalidCleanup).toHaveBeenCalledTimes(1)
    expect(invalid.deps.runFfprobe).not.toHaveBeenCalled()

    const failedCleanup = vi.fn(() => true)
    const failed = build({
      jailInput: vi.fn(
        (): JailedMediaInput => ({
          ok: true,
          realPath: '/ws/clip.mp4',
          mimeType: 'video/mp4',
          cleanup: failedCleanup
        })
      ),
      runFfprobe: vi.fn(async () => {
        throw new Error('probe runner failed')
      })
    })
    const failedResult = await failed.executors.executeFfmpegTool(
      'video_probe',
      { sourcePath: 'clip.mp4' },
      {}
    )
    expect(failedResult.isError).toBe(true)
    expect(failedResult.text).toContain('probe runner failed')
    expect(failedCleanup).toHaveBeenCalledTimes(1)
  })

  it('does not mask the tool result when staged-input cleanup throws', async () => {
    const cleanup = vi.fn(() => {
      throw new Error('cleanup failed')
    })
    const { executors } = build({
      jailInput: vi.fn(
        (): JailedMediaInput => ({
          ok: true,
          realPath: '/ws/clip.mp4',
          mimeType: 'video/mp4',
          cleanup
        })
      )
    })
    const result = await executors.executeFfmpegTool('video_probe', { sourcePath: 'clip.mp4' }, {})
    expect(result.isError).toBeFalsy()
    expect(cleanup).toHaveBeenCalledTimes(1)
  })
})

describe('video_thumbnail', () => {
  it('extracts a frame over the JAILED path and returns it as an inline PNG image block', async () => {
    const { executors, getFfmpegArgs, getRemoved, inputCleanup } = build()
    const result = await executors.executeFfmpegTool(
      'video_thumbnail',
      { sourcePath: 'clip.mp4', atMs: 2500, width: 320 },
      {}
    )
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
    expect(inputCleanup).toHaveBeenCalledTimes(1)
  })

  it('reads the PNG output under the IMAGE byte cap (passes image/png mime to readOutput)', async () => {
    const { executors, deps } = build()
    await executors.executeFfmpegTool('video_thumbnail', { sourcePath: 'clip.mp4' }, {})
    // The mimeType arg selects the 8MB image cap (not the 512MB video default).
    expect(deps.readOutput).toHaveBeenCalledWith('/staging/out.png', 'image/png')
  })

  it('awaits the bounded thumbnail read before returning or cleaning staging', async () => {
    let resolveRead!: (buffer: Buffer) => void
    let announceReadStarted!: () => void
    const pendingRead = new Promise<Buffer>((resolve) => {
      resolveRead = resolve
    })
    const readStarted = new Promise<void>((resolve) => {
      announceReadStarted = resolve
    })
    const { executors, getRemoved } = build({
      readOutput: vi.fn(() => {
        announceReadStarted()
        return pendingRead
      })
    })
    let settled = false
    const pending = executors
      .executeFfmpegTool('video_thumbnail', { sourcePath: 'clip.mp4' }, {})
      .finally(() => {
        settled = true
      })

    await readStarted
    expect(settled).toBe(false)
    expect(getRemoved()).toEqual([])
    resolveRead(
      Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.from('frame')
      ])
    )
    const result = await pending
    expect(result.isError).toBeFalsy()
    expect(getRemoved()).toEqual(['/staging/out.png'])
  })

  it('returns an actionable error when ffmpeg is not installed', async () => {
    const { executors, deps, inputCleanup } = build({ resolveFfmpeg: vi.fn(() => null) })
    const result = await executors.executeFfmpegTool(
      'video_thumbnail',
      { sourcePath: 'clip.mp4' },
      {}
    )
    expect(result.isError).toBe(true)
    expect(result.text).toContain('install ffmpeg')
    expect(deps.runFfmpeg).not.toHaveBeenCalled()
    expect(inputCleanup).toHaveBeenCalledTimes(1)
  })

  it('fails (and still cleans up staging) when ffmpeg produces no frame', async () => {
    const { executors, getRemoved, inputCleanup } = build({
      readOutput: vi.fn(() => {
        throw new Error('ENOENT')
      })
    })
    const result = await executors.executeFfmpegTool(
      'video_thumbnail',
      { sourcePath: 'clip.mp4' },
      {}
    )
    expect(result.isError).toBe(true)
    expect(result.text).toContain('ffmpeg output unavailable')
    expect(getRemoved()).toContain('/staging/out.png')
    expect(inputCleanup).toHaveBeenCalledTimes(1)
  })

  it('fails (and cleans up) when the ffmpeg run throws', async () => {
    const { executors, getRemoved, inputCleanup } = build({
      runFfmpeg: vi.fn(async () => {
        throw new Error('ffmpeg timed out')
      })
    })
    const result = await executors.executeFfmpegTool(
      'video_thumbnail',
      { sourcePath: 'clip.mp4' },
      {}
    )
    expect(result.isError).toBe(true)
    expect(result.text).toContain('timed out')
    expect(getRemoved()).toContain('/staging/out.png')
    expect(inputCleanup).toHaveBeenCalledTimes(1)
  })

  it('cleans the staged input exactly once when argv validation rejects it', async () => {
    const cleanup = vi.fn(() => true)
    const { executors, deps } = build({
      jailInput: vi.fn(
        (): JailedMediaInput => ({
          ok: true,
          realPath: 'relative.mp4',
          mimeType: 'video/mp4',
          cleanup
        })
      )
    })
    const result = await executors.executeFfmpegTool(
      'video_thumbnail',
      { sourcePath: 'clip.mp4' },
      {}
    )
    expect(result.isError).toBe(true)
    expect(result.text).toContain('must be absolute')
    expect(deps.runFfmpeg).not.toHaveBeenCalled()
    expect(cleanup).toHaveBeenCalledTimes(1)
  })
})

// S1b-3 producers — output is audio/video, so it rides the TRUSTED media channel
// (result.trustedMediaRefs, NOT an image block + NOT provider media_refs).
describe('audio_extract / transcode_audio / transcode_video (trusted AV refs)', () => {
  it('audio_extract persists the output and returns a trusted audio ref with a sha-derived id', async () => {
    const { executors, deps, getFfmpegArgs, getRemoved, inputCleanup } = build()
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
    expect(deps.persistOutputFile).toHaveBeenCalledWith('/staging/out.m4a', 'audio/mp4', {
      appRunId: 'run-7'
    })
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
    expect(result.pendingToolMediaPersistence).toBeDefined()
    // Staging file cleaned up.
    expect(getRemoved()).toContain('/staging/out.m4a')
    expect(inputCleanup).toHaveBeenCalledTimes(1)
  })

  it('transcode_audio returns a trusted audio ref (wav → audio/wav)', async () => {
    const { executors, deps } = build()
    const result = await executors.executeFfmpegTool(
      'transcode_audio',
      { sourcePath: 'song.flac', format: 'wav' },
      {}
    )
    expect(result.isError).toBeFalsy()
    expect(deps.persistOutputFile).toHaveBeenCalledWith('/staging/out.wav', 'audio/wav', {})
    const refs = result.trustedMediaRefs ?? []
    expect(refs).toHaveLength(1)
    expect(refs[0].kind).toBe('audio')
    expect(refs[0].mimeType).toBe('audio/wav')
    expect(refs[0].name).toBe('song.wav')
  })

  it('transcode_video returns a trusted video ref (video/mp4)', async () => {
    const { executors, deps, getFfmpegArgs } = build()
    const result = await executors.executeFfmpegTool(
      'transcode_video',
      { sourcePath: 'clip.mp4', crf: 28, scaleWidth: 640 },
      {}
    )
    expect(result.isError).toBeFalsy()
    expect(getFfmpegArgs()!.join(' ')).toContain('/staging/out.mp4')
    expect(deps.persistOutputFile).toHaveBeenCalledWith('/staging/out.mp4', 'video/mp4', {})
    const refs = result.trustedMediaRefs ?? []
    expect(refs).toHaveLength(1)
    expect(refs[0].kind).toBe('video')
    expect(refs[0].mimeType).toBe('video/mp4')
    expect(refs[0].id.length).toBeGreaterThan(0)
  })

  it('rejects a producer with a missing/invalid audio format', async () => {
    const { executors, deps, inputCleanup } = build()
    const result = await executors.executeFfmpegTool(
      'audio_extract',
      { sourcePath: 'clip.mp4' },
      {}
    )
    expect(result.isError).toBe(true)
    expect(result.text).toContain('format')
    expect(deps.runFfmpeg).not.toHaveBeenCalled()
    expect(inputCleanup).toHaveBeenCalledTimes(1)
  })

  it('an awaited persistOutputFile failure yields no trusted refs and still cleans up', async () => {
    const { executors, getRemoved, inputCleanup } = build({
      persistOutputFile: vi.fn(async () => ({ ok: false as const, reason: 'disk_full' }))
    })
    const result = await executors.executeFfmpegTool(
      'transcode_video',
      { sourcePath: 'clip.mp4' },
      {}
    )
    expect(result.isError).toBe(true)
    expect(result.text).toContain('disk_full')
    expect(result.trustedMediaRefs).toBeUndefined()
    expect(getRemoved()).toContain('/staging/out.mp4')
    expect(inputCleanup).toHaveBeenCalledTimes(1)
  })

  it('does not build a ref or clean staging until file persistence resolves', async () => {
    let resolvePersistence!: (value: {
      ok: true
      path: string
      sha256: string
      byteLength: number
      pendingToolMediaPersistence: {
        commit: () => boolean
        rollback: () => Promise<void>
      }
    }) => void
    const pendingPersistence = new Promise<{
      ok: true
      path: string
      sha256: string
      byteLength: number
      pendingToolMediaPersistence: {
        commit: () => boolean
        rollback: () => Promise<void>
      }
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
      .executeFfmpegTool('transcode_video', { sourcePath: 'clip.mp4' }, {})
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
      byteLength: 2048,
      pendingToolMediaPersistence: {
        commit: () => true,
        rollback: async () => undefined
      }
    })
    const result = await pending
    expect(result.trustedMediaRefs?.[0]).toMatchObject({ sha256: 'd'.repeat(64), byteLength: 2048 })
    expect(getRemoved()).toEqual(['/staging/out.mp4'])
  })

  it('carries exact rollback authority when a post-persist validation becomes a tool error', async () => {
    const pendingToolMediaPersistence = {
      commit: vi.fn(() => true),
      rollback: vi.fn(async () => undefined)
    }
    const { executors } = build({
      persistOutputFile: vi.fn(() => ({
        ok: true as const,
        path: '/assets/invalid.mp4',
        sha256: '',
        byteLength: 2048,
        pendingToolMediaPersistence
      }))
    })

    const result = await executors.executeFfmpegTool(
      'transcode_video',
      { sourcePath: 'clip.mp4' },
      { appChatId: 'chat-a', appRunId: 'run-a' }
    )

    expect(result.isError).toBe(true)
    expect(result.trustedMediaRefs).toBeUndefined()
    expect(result.pendingToolMediaPersistence).toBe(pendingToolMediaPersistence)
    expect(pendingToolMediaPersistence.commit).not.toHaveBeenCalled()
    expect(pendingToolMediaPersistence.rollback).not.toHaveBeenCalled()
  })

  it('fails (and cleans up) when a producer ffmpeg run throws', async () => {
    const { executors, deps, getRemoved, inputCleanup } = build({
      runFfmpeg: vi.fn(async () => {
        throw new Error('producer timed out')
      })
    })
    const result = await executors.executeFfmpegTool(
      'transcode_audio',
      { sourcePath: 'a.wav', format: 'mp3' },
      {}
    )
    expect(result.isError).toBe(true)
    expect(result.text).toContain('timed out')
    expect(deps.persistOutputFile).not.toHaveBeenCalled()
    expect(getRemoved()).toContain('/staging/out.mp3')
    expect(inputCleanup).toHaveBeenCalledTimes(1)
  })

  it('cleans the staged input exactly once on missing binary and argv rejection', async () => {
    const missing = build({ resolveFfmpeg: vi.fn(() => null) })
    const missingResult = await missing.executors.executeFfmpegTool(
      'transcode_audio',
      { sourcePath: 'a.wav', format: 'mp3' },
      {}
    )
    expect(missingResult.isError).toBe(true)
    expect(missingResult.text).toContain('install ffmpeg')
    expect(missing.inputCleanup).toHaveBeenCalledTimes(1)
    expect(missing.getRemoved()).toEqual(['/staging/out.mp3'])

    const invalidCleanup = vi.fn(() => true)
    const invalid = build({
      jailInput: vi.fn(
        (): JailedMediaInput => ({
          ok: true,
          realPath: 'relative.wav',
          mimeType: 'audio/wav',
          cleanup: invalidCleanup
        })
      )
    })
    const invalidResult = await invalid.executors.executeFfmpegTool(
      'transcode_audio',
      { sourcePath: 'a.wav', format: 'mp3' },
      {}
    )
    expect(invalidResult.isError).toBe(true)
    expect(invalidResult.text).toContain('must be absolute')
    expect(invalid.deps.runFfmpeg).not.toHaveBeenCalled()
    expect(invalidCleanup).toHaveBeenCalledTimes(1)
    expect(invalid.getRemoved()).toEqual(['/staging/out.mp3'])
  })

  // Part 1 — poster/waveform threading + fail-tolerance.
  it('threads the generated poster from the canonical asset before staging cleanup', async () => {
    const order: string[] = []
    const { executors, deps } = build({
      generatePoster: vi.fn(async () => {
        order.push('poster')
        return {
          thumbnail: { dataBase64: 'UE9TVEVS', mimeType: 'image/jpeg', width: 320, height: 180 }
        }
      }),
      removeFile: vi.fn(() => {
        order.push('remove')
      })
    })
    const result = await executors.executeFfmpegTool(
      'transcode_video',
      { sourcePath: 'clip.mp4' },
      {}
    )
    expect(result.isError).toBeFalsy()
    expect(deps.generatePoster).toHaveBeenCalledWith(
      '/assets/canonical-output',
      'video',
      'video/mp4',
      42
    )
    const refs = result.trustedMediaRefs ?? []
    expect(refs).toHaveLength(1)
    expect(refs[0].thumbnail).toEqual({
      dataBase64: 'UE9TVEVS',
      mimeType: 'image/jpeg',
      width: 320,
      height: 180
    })
    // The poster ran BEFORE the staging file was removed (file must still exist).
    expect(order).toEqual(['poster', 'remove'])
  })

  it('audio producers ask for an audio-kind poster', async () => {
    const { executors, deps } = build()
    await executors.executeFfmpegTool(
      'transcode_audio',
      { sourcePath: 'song.flac', format: 'wav' },
      {}
    )
    expect(deps.generatePoster).toHaveBeenCalledWith(
      '/assets/canonical-output',
      'audio',
      'audio/wav',
      42
    )
  })

  it('still returns the ref WITHOUT a thumbnail when the poster generator throws (fail-tolerant)', async () => {
    const { executors } = build({
      generatePoster: vi.fn(async () => {
        throw new Error('decode exploded')
      })
    })
    const result = await executors.executeFfmpegTool(
      'transcode_video',
      { sourcePath: 'clip.mp4' },
      {}
    )
    // The producer must not fail just because the decorative poster failed.
    expect(result.isError).toBeFalsy()
    const refs = result.trustedMediaRefs ?? []
    expect(refs).toHaveLength(1)
    expect(refs[0].thumbnail).toBeUndefined()
  })

  // Part 2 — best-effort durationMs/codecs from an ffprobe on the OUTPUT.
  it('fills durationMs + codecs from a best-effort ffprobe on the output', async () => {
    const { executors, getProbeArgs } = build()
    const result = await executors.executeFfmpegTool(
      'transcode_video',
      { sourcePath: 'clip.mp4' },
      {}
    )
    const refs = result.trustedMediaRefs ?? []
    expect(refs).toHaveLength(1)
    // PROBE_JSON: format.duration "10.0" → 10000ms; streams h264 + aac → "h264,aac".
    expect(refs[0].durationMs).toBe(10000)
    expect(refs[0].codecs).toBe('h264,aac')
    expect(getProbeArgs()).toContain('/assets/canonical-output')
  })

  it('omits durationMs/codecs (badges conditional) when the output ffprobe fails', async () => {
    const { executors } = build({
      // First probe (none here) — but the producer's OUTPUT probe throws.
      runFfprobe: vi.fn(async () => {
        throw new Error('ffprobe failed')
      })
    })
    const result = await executors.executeFfmpegTool(
      'transcode_audio',
      { sourcePath: 'a.wav', format: 'mp3' },
      {}
    )
    // The producer still succeeds; the metadata is simply absent.
    expect(result.isError).toBeFalsy()
    const refs = result.trustedMediaRefs ?? []
    expect(refs).toHaveLength(1)
    expect(refs[0].durationMs).toBeUndefined()
    expect(refs[0].codecs).toBeUndefined()
  })

  it('omits durationMs/codecs when ffprobe is not installed', async () => {
    const { executors } = build({ resolveFfprobe: vi.fn(() => null) })
    const result = await executors.executeFfmpegTool(
      'transcode_video',
      { sourcePath: 'clip.mp4' },
      {}
    )
    expect(result.isError).toBeFalsy()
    const refs = result.trustedMediaRefs ?? []
    expect(refs).toHaveLength(1)
    expect(refs[0].durationMs).toBeUndefined()
    expect(refs[0].codecs).toBeUndefined()
  })
})
