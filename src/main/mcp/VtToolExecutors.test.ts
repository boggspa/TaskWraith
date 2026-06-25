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

function build(overrides: Partial<VtToolDeps> = {}) {
  let lastDecodeParams: { inputPath: string; timestampSeconds?: number; preferHardware?: boolean } | null = null
  const deps: VtToolDeps = {
    jailInput: vi.fn(() => ({ ok: true as const, realPath: '/ws/clip.mp4' })),
    decodeFrame: vi.fn(async (params) => {
      lastDecodeParams = params
      return { ...DECODE_RESULT }
    }),
    ...overrides
  }
  const executors = createVtToolExecutors(deps)
  return { executors, deps, getDecodeParams: () => lastDecodeParams }
}

describe('isVtMcpToolName', () => {
  it('recognizes the VideoToolbox tools only', () => {
    expect(isVtMcpToolName('video_decode_frame')).toBe(true)
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
