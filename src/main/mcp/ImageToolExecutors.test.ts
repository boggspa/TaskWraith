import { describe, it, expect, vi } from 'vitest'
import {
  createImageToolExecutors,
  isImageMcpToolName,
  type ImageEngine,
  type ResolvedRasterSource,
  type ResolvedSvgSource
} from './ImageToolExecutors'

// PNG magic header so sniffImageMime() classifies our fakes as raster PNG.
const FAKE_PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('fake-png-body')
])
const SVG_BYTES = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')

function imageContent(result: { content?: Array<{ type: string }> }) {
  return (result.content ?? []).find((b) => b.type === 'image') as
    | { type: 'image'; mimeType: string; data: string }
    | undefined
}

function build(overrides: {
  engine?: Partial<ImageEngine>
  raster?: ResolvedRasterSource
  svg?: ResolvedSvgSource
} = {}) {
  let lastHtml = ''
  const engine: ImageEngine = {
    getSize: () => ({ width: 800, height: 600 }),
    crop: vi.fn(() => FAKE_PNG),
    resize: vi.fn(() => FAKE_PNG),
    renderHtmlToPng: vi.fn(async (html: string) => {
      lastHtml = html
      return FAKE_PNG
    }),
    ...overrides.engine
  }
  const resolveRasterSource = vi.fn(
    async (): Promise<ResolvedRasterSource> =>
      overrides.raster ?? { ok: true, buffer: FAKE_PNG, mimeType: 'image/png' }
  )
  const resolveSvgSource = vi.fn(
    async (args: Record<string, unknown>): Promise<ResolvedSvgSource> =>
      overrides.svg ?? { ok: true, svg: String(args.svg || '') }
  )
  const executors = createImageToolExecutors({ engine, resolveRasterSource, resolveSvgSource })
  return { executors, engine, resolveRasterSource, resolveSvgSource, getHtml: () => lastHtml }
}

describe('isImageMcpToolName', () => {
  it('recognizes the two image tools only', () => {
    expect(isImageMcpToolName('image_edit')).toBe(true)
    expect(isImageMcpToolName('svg_rasterize')).toBe(true)
    expect(isImageMcpToolName('canvas_screenshot')).toBe(false)
  })
})

describe('image_edit', () => {
  it('blurs a region via the offscreen renderer and returns a PNG image block', async () => {
    const { executors, getHtml } = build()
    const result = await executors.executeImageTool(
      'image_edit',
      { op: 'blur', region: { x: 100, y: 50, width: 200, height: 80 }, radius: 16 },
      {}
    )
    expect(result.isError).toBeFalsy()
    const img = imageContent(result)
    expect(img?.mimeType).toBe('image/png')
    expect(img?.data).toBe(FAKE_PNG.toString('base64'))
    // Region blur HTML clips to the region and blurs an offset copy.
    const html = getHtml()
    expect(html).toContain('filter:blur(16px)')
    expect(html).toContain('left:100px')
    expect(html).toContain('left:-100px')
  })

  it('blurs the whole image when no region is given', async () => {
    const { executors, getHtml } = build()
    const result = await executors.executeImageTool('image_edit', { op: 'blur', radius: 8 }, {})
    expect(result.isError).toBeFalsy()
    expect(getHtml()).toContain('filter:blur(8px)')
    expect(getHtml()).not.toContain('overflow:hidden') // whole-image path, no clip div
  })

  it('crops with nativeImage (no renderer) using a clamped rect', async () => {
    const { executors, engine } = build()
    const result = await executors.executeImageTool(
      'image_edit',
      { op: 'crop', region: { x: 10, y: 10, width: 9999, height: 9999 } },
      {}
    )
    expect(result.isError).toBeFalsy()
    expect(engine.crop).toHaveBeenCalledWith(FAKE_PNG, { x: 10, y: 10, width: 790, height: 590 })
    expect(engine.renderHtmlToPng).not.toHaveBeenCalled()
  })

  it('resizes preserving aspect when only one dimension is given', async () => {
    const { executors, engine } = build()
    await executors.executeImageTool('image_edit', { op: 'resize', width: 400 }, {})
    // 800x600 -> width 400 -> height 300
    expect(engine.resize).toHaveBeenCalledWith(FAKE_PNG, { width: 400, height: 300 })
  })

  it('rejects redact without a region', async () => {
    const { executors } = build()
    const result = await executors.executeImageTool('image_edit', { op: 'redact' }, {})
    expect(result.isError).toBe(true)
    expect(result.text).toContain('region')
  })

  it('rejects an unknown op', async () => {
    const { executors } = build()
    const result = await executors.executeImageTool('image_edit', { op: 'sharpen' }, {})
    expect(result.isError).toBe(true)
    expect(result.text).toMatch(/unknown op/)
  })

  it('C2: rejects a source that sniffs as SVG (not a raster image)', async () => {
    const { executors } = build({ raster: { ok: true, buffer: SVG_BYTES, mimeType: 'image/png' } })
    const result = await executors.executeImageTool('image_edit', { op: 'blur' }, {})
    expect(result.isError).toBe(true)
    expect(result.text).toMatch(/not a supported raster image/)
  })

  it('surfaces a source-resolution failure', async () => {
    const { executors } = build({ raster: { ok: false, reason: 'unknown media id' } })
    const result = await executors.executeImageTool('image_edit', { op: 'blur' }, {})
    expect(result.isError).toBe(true)
    expect(result.text).toContain('unknown media id')
  })

  it('C2: fails closed if the engine produces non-raster bytes', async () => {
    const { executors } = build({ engine: { renderHtmlToPng: async () => SVG_BYTES } })
    const result = await executors.executeImageTool('image_edit', { op: 'blur' }, {})
    expect(result.isError).toBe(true)
    expect(result.text).toMatch(/not a raster image/)
  })
})

describe('svg_rasterize', () => {
  it('rasterizes inline SVG to a PNG via the offscreen renderer', async () => {
    const { executors, getHtml } = build()
    const result = await executors.executeImageTool(
      'svg_rasterize',
      { svg: '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>', width: 512, height: 256 },
      {}
    )
    expect(result.isError).toBeFalsy()
    expect(imageContent(result)?.mimeType).toBe('image/png')
    const html = getHtml()
    // SVG is embedded as a base64 data: URL inside an <img> — never inline DOM,
    // so the (untrusted) SVG source cannot inject HTML or run scripts.
    expect(html).toContain('data:image/svg+xml;base64,')
    expect(html).not.toContain('<rect/>')
    expect(html).toContain('width="512"')
  })

  it('rejects empty SVG', async () => {
    const { executors } = build()
    const result = await executors.executeImageTool('svg_rasterize', { svg: '   ' }, {})
    expect(result.isError).toBe(true)
    expect(result.text).toContain('empty')
  })
})
