import { describe, it, expect, vi } from 'vitest'
import {
  createImageGenExecutor,
  isImageGenMcpToolName,
  parseImageGenResponse,
  type ImageGenConfig,
  type ImageGenResult
} from './ImageGenExecutor'

describe('parseImageGenResponse', () => {
  it('prefers inline b64_json', () => {
    expect(parseImageGenResponse({ data: [{ b64_json: 'AAAA' }] })).toEqual({ ok: true, b64: 'AAAA' })
  })
  it('falls back to url', () => {
    expect(parseImageGenResponse({ data: [{ url: 'https://cdn.example/x.png' }] })).toEqual({
      ok: true,
      url: 'https://cdn.example/x.png'
    })
  })
  it('rejects empty/invalid shapes', () => {
    expect(parseImageGenResponse(null).ok).toBe(false)
    expect(parseImageGenResponse({ data: [] }).ok).toBe(false)
    expect(parseImageGenResponse({ data: [{}] }).ok).toBe(false)
  })
})

const FAKE_PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('gen-png')
])
const SVG_BYTES = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')

function build(
  config: Partial<ImageGenConfig> = {},
  generateResult: ImageGenResult = { ok: true, buffer: FAKE_PNG, mimeType: 'image/png' }
) {
  const getConfig = (): ImageGenConfig => ({
    enabled: true,
    defaultProvider: 'openai',
    configuredProviders: ['openai'],
    ...config
  })
  const generate = vi.fn(async () => generateResult)
  return { exec: createImageGenExecutor({ getConfig, generate }), generate }
}

function imageContent(result: { content?: Array<{ type: string }> }) {
  return (result.content ?? []).find((b) => b.type === 'image') as
    | { type: 'image'; mimeType: string; data: string }
    | undefined
}

describe('isImageGenMcpToolName', () => {
  it('recognizes image_generate only', () => {
    expect(isImageGenMcpToolName('image_generate')).toBe(true)
    expect(isImageGenMcpToolName('image_edit')).toBe(false)
  })
})

describe('image_generate gating', () => {
  it('refuses when disabled (default OFF)', async () => {
    const { exec, generate } = build({ enabled: false })
    const r = await exec.executeImageGen({ prompt: 'a cat' })
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/disabled/)
    expect(generate).not.toHaveBeenCalled()
  })

  it('refuses when no provider key is configured', async () => {
    const { exec, generate } = build({ configuredProviders: [] })
    const r = await exec.executeImageGen({ prompt: 'a cat' })
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/no image-generation API key/)
    expect(generate).not.toHaveBeenCalled()
  })

  it('refuses an empty prompt', async () => {
    const { exec } = build()
    expect((await exec.executeImageGen({ prompt: '   ' })).isError).toBe(true)
  })

  it('refuses a requested provider with no key', async () => {
    const { exec } = build({ configuredProviders: ['openai'] })
    const r = await exec.executeImageGen({ prompt: 'a cat', provider: 'xai' })
    expect(r.isError).toBe(true)
    expect((r.structuredContent as { error: string }).error).toBe(
      'no API key configured for provider "xai"'
    )
  })
})

describe('image_generate success + C2', () => {
  it('returns a PNG image block on success', async () => {
    const { exec, generate } = build()
    const r = await exec.executeImageGen({ prompt: 'a red square', size: '1024x1024' })
    expect(r.isError).toBeFalsy()
    expect(imageContent(r)?.data).toBe(FAKE_PNG.toString('base64'))
    expect(generate).toHaveBeenCalledWith({ provider: 'openai', prompt: 'a red square', size: '1024x1024' })
  })

  it('picks the default provider, falling back to the first configured', async () => {
    const { exec, generate } = build({ defaultProvider: 'xai', configuredProviders: ['openai'] })
    await exec.executeImageGen({ prompt: 'x' })
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({ provider: 'openai' }))
  })

  it('C2: rejects a generation result that is not a raster image', async () => {
    const { exec } = build({}, { ok: true, buffer: SVG_BYTES, mimeType: 'image/png' })
    const r = await exec.executeImageGen({ prompt: 'x' })
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/not a raster image/)
  })

  it('surfaces an egress failure reason', async () => {
    const { exec } = build({}, { ok: false, reason: 'endpoint returned 401' })
    const r = await exec.executeImageGen({ prompt: 'x' })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('endpoint returned 401')
  })
})
