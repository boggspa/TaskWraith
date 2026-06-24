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

function build(overrides: Partial<FfmpegToolDeps> = {}) {
  let lastArgs: string[] | null = null
  const deps: FfmpegToolDeps = {
    jailInput: vi.fn(
      (): JailedMediaInput => ({ ok: true, realPath: '/ws/clip.mp4', mimeType: 'video/mp4' })
    ),
    resolveFfprobe: vi.fn(() => '/opt/homebrew/bin/ffprobe'),
    runFfprobe: vi.fn(async (_bin: string, args: string[]) => {
      lastArgs = args
      return { stdout: PROBE_JSON, stderr: '' }
    }),
    missingMessage: (which) => `install ${which}`,
    ...overrides
  }
  const executors = createFfmpegToolExecutors(deps)
  return { executors, deps, getArgs: () => lastArgs }
}

describe('isFfmpegMcpToolName', () => {
  it('recognizes the ffmpeg tools only', () => {
    expect(isFfmpegMcpToolName('video_probe')).toBe(true)
    expect(isFfmpegMcpToolName('audio_analyze')).toBe(false)
  })
})

describe('video_probe', () => {
  it('jails the input, runs ffprobe on the REAL path, and returns parsed info', async () => {
    const { executors, deps, getArgs } = build()
    const result = await executors.executeFfmpegTool('video_probe', { sourcePath: 'clip.mp4' }, { appChatId: 'c1' })
    expect(result.isError).toBeFalsy()
    expect(deps.jailInput).toHaveBeenCalledWith('clip.mp4', { appChatId: 'c1' })
    // ffprobe ran against the JAILED real path, never the agent-supplied string.
    expect(getArgs()?.[getArgs()!.length - 1]).toBe('/ws/clip.mp4')
    expect(getArgs()).toContain('-protocol_whitelist')
    const payload = JSON.parse(result.text) as Record<string, unknown>
    expect(payload.ok).toBe(true)
    expect(payload.hasVideo).toBe(true)
    expect(payload.hasAudio).toBe(true)
    expect((payload.video as Record<string, unknown>).codec).toBe('h264')
    expect(payload.sniffedMime).toBe('video/mp4')
  })

  it('requires a sourcePath', async () => {
    const { executors, deps } = build()
    const result = await executors.executeFfmpegTool('video_probe', {}, {})
    expect(result.isError).toBe(true)
    expect(result.text).toContain('provide sourcePath')
    expect(deps.resolveFfprobe).not.toHaveBeenCalled()
  })

  it('surfaces a jail rejection without running ffprobe', async () => {
    const { executors, deps } = build({
      jailInput: vi.fn((): JailedMediaInput => ({ ok: false, reason: 'outside_allowed_roots' }))
    })
    const result = await executors.executeFfmpegTool('video_probe', { sourcePath: '../../etc/passwd' }, {})
    expect(result.isError).toBe(true)
    expect(result.text).toContain('could not read media')
    expect(result.text).toContain('outside_allowed_roots')
    expect(deps.runFfprobe).not.toHaveBeenCalled()
  })

  it('returns an actionable error when ffprobe is not installed', async () => {
    const { executors, deps } = build({ resolveFfprobe: vi.fn(() => null) })
    const result = await executors.executeFfmpegTool('video_probe', { sourcePath: 'clip.mp4' }, {})
    expect(result.isError).toBe(true)
    expect(result.text).toContain('install ffprobe')
    expect(deps.runFfprobe).not.toHaveBeenCalled()
  })

  it('surfaces an ffprobe execution failure', async () => {
    const { executors } = build({
      runFfprobe: vi.fn(async () => {
        throw new Error('ffprobe exited 1: Invalid data found')
      })
    })
    const result = await executors.executeFfmpegTool('video_probe', { sourcePath: 'clip.mp4' }, {})
    expect(result.isError).toBe(true)
    expect(result.text).toContain('Invalid data found')
  })

  it('surfaces malformed ffprobe output', async () => {
    const { executors } = build({ runFfprobe: vi.fn(async () => ({ stdout: 'not json', stderr: '' })) })
    const result = await executors.executeFfmpegTool('video_probe', { sourcePath: 'clip.mp4' }, {})
    expect(result.isError).toBe(true)
    expect(result.text).toContain('not valid JSON')
  })
})
