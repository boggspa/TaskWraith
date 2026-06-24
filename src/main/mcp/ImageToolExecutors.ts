import type { McpToolContentBlock, McpToolExecutionResult } from './McpBridgeRuntime'
import {
  isTranscriptRasterImageMime,
  isTranscriptSvgMime,
  sniffImageMime
} from '../services/TranscriptMediaService'
import { TRANSCRIPT_MEDIA_MAX_FULL_IMAGE_BYTES } from '../services/TranscriptMediaAssetStore'

/**
 * image_edit + svg_rasterize MCP tool executors.
 *
 * Engine split (see OffscreenImageRenderer for the Electron impl):
 *  - crop / resize: pure `nativeImage` (no renderer).
 *  - blur / redact / svg_rasterize: an offscreen, network-cut, sandboxed
 *    BrowserWindow rendering self-contained HTML, captured to PNG.
 *
 * This module is pure logic (engine + source resolution injected) so it is
 * unit-testable without Electron. Security invariants enforced HERE:
 *  - C2: the bytes returned to the model are magic-byte-sniffed raster-only
 *    (SVG/polyglot rejected) on BOTH the input source and the produced output;
 *  - all HTML handed to the renderer interpolates ONLY clamped integers and
 *    base64 `data:` URLs — never raw untrusted text — so neither image bytes
 *    nor SVG source can break out of the document or inject script. The SVG is
 *    rasterized inside an <img> (img-context SVG cannot script) and the renderer
 *    cuts all network egress (XXE/SSRF containment).
 */

export const IMAGE_MCP_TOOL_NAMES = ['image_edit', 'svg_rasterize'] as const
export type ImageMcpToolName = (typeof IMAGE_MCP_TOOL_NAMES)[number]

export function isImageMcpToolName(name: string): name is ImageMcpToolName {
  return (IMAGE_MCP_TOOL_NAMES as readonly string[]).includes(name)
}

export const MAX_IMAGE_DIMENSION = 8192
/** Local mirror of OffscreenImageRenderer.MAX_OFFSCREEN_RENDER_PIXELS — kept here
 * (not imported) so this module stays Electron-free / unit-testable, exactly as
 * MAX_IMAGE_DIMENSION is. Caps the offscreen-render AREA so a per-axis-legal
 * 8192×8192 (~1GB framebuffer) is rejected with a clean tool error before the
 * window is ever created. */
export const MAX_OFFSCREEN_RENDER_PIXELS = 24_000_000
const MAX_BLUR_RADIUS = 200
const RENDER_TIMEOUT_MS = 20_000
const MAX_SVG_CHARS = 2_000_000

export interface ImageRect {
  x: number
  y: number
  width: number
  height: number
}

export interface ImageEngine {
  getSize(buffer: Buffer): { width: number; height: number }
  crop(buffer: Buffer, rect: ImageRect): Buffer
  resize(buffer: Buffer, size: { width: number; height: number }): Buffer
  renderHtmlToPng(html: string, width: number, height: number, timeoutMs: number): Promise<Buffer>
}

export type ResolvedRasterSource =
  | { ok: true; buffer: Buffer; mimeType: string }
  | { ok: false; reason: string }

export type ResolvedSvgSource = { ok: true; svg: string } | { ok: false; reason: string }

export interface ImageToolContext {
  appChatId?: string
  appRunId?: string
  workspacePath?: string
}

export interface ImageToolExecutorDeps {
  engine: ImageEngine
  /** Resolve a raster image source (sourceMediaId / sourcePath) to bytes. */
  resolveRasterSource: (
    args: Record<string, unknown>,
    ctx: ImageToolContext
  ) => Promise<ResolvedRasterSource>
  /** Resolve an SVG source (inline `svg` text or sourcePath to a .svg). */
  resolveSvgSource: (
    args: Record<string, unknown>,
    ctx: ImageToolContext
  ) => Promise<ResolvedSvgSource>
}

export interface ImageToolExecutors {
  executeImageTool: (
    toolName: ImageMcpToolName,
    rawArgs: unknown,
    ctx: ImageToolContext
  ) => Promise<McpToolExecutionResult>
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function intArg(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isFinite(n) ? Math.round(n) : null
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n))
}

/** True when an offscreen render of w×h would exceed the framebuffer area cap.
 * Both dims are already per-axis-clamped to MAX_IMAGE_DIMENSION by callers; this
 * bounds the PRODUCT (8192×8192 is per-axis-legal but ~1GB of framebuffer). */
function exceedsRenderPixelBudget(w: number, h: number): boolean {
  return w * h > MAX_OFFSCREEN_RENDER_PIXELS
}

function renderPixelBudgetMessage(w: number, h: number): string {
  return `render too large (${w}×${h} = ${w * h}px; max ${MAX_OFFSCREEN_RENDER_PIXELS}px). Reduce dimensions.`
}

function fail(toolName: string, message: string): McpToolExecutionResult {
  const value = { ok: false, tool: toolName, error: message }
  const text = JSON.stringify(value)
  return { text, isError: true, structuredContent: value, content: [{ type: 'text', text }] }
}

/** Wrap a produced PNG into a tool result AFTER the C2 output sniff. */
function pngResult(toolName: string, value: Record<string, unknown>, png: Buffer): McpToolExecutionResult {
  const sniffed = sniffImageMime(png)
  if (!isTranscriptRasterImageMime(sniffed) || isTranscriptSvgMime(sniffed)) {
    return fail(toolName, 'internal error: produced output was not a raster image')
  }
  if (png.byteLength > TRANSCRIPT_MEDIA_MAX_FULL_IMAGE_BYTES) {
    return fail(
      toolName,
      `output image is too large (${png.byteLength} bytes; max ${TRANSCRIPT_MEDIA_MAX_FULL_IMAGE_BYTES}). Reduce dimensions.`
    )
  }
  const full = { ...value, ok: true, tool: toolName, mimeType: 'image/png', byteLength: png.byteLength }
  const text = JSON.stringify(full)
  const block: McpToolContentBlock = { type: 'image', mimeType: 'image/png', data: png.toString('base64') }
  return { text, structuredContent: full, content: [{ type: 'text', text }, block] }
}

const HTML_HEAD =
  '<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:transparent}</style></head>'

/** Build a `data:` URL from raster bytes. mimeType is a sniffed canonical value
 * and the payload is base64, so neither can break out of the HTML attribute. */
function rasterDataUrl(buffer: Buffer, mimeType: string): string {
  return `data:${mimeType};base64,${buffer.toString('base64')}`
}

function blurHtml(dataUrl: string, w: number, h: number, region: ImageRect | null, radius: number): string {
  if (!region) {
    return `${HTML_HEAD}<body><img src="${dataUrl}" style="display:block;width:${w}px;height:${h}px;filter:blur(${radius}px)"></body></html>`
  }
  const { x, y, width, height } = region
  return (
    `${HTML_HEAD}<body style="position:relative;width:${w}px;height:${h}px">` +
    `<img src="${dataUrl}" style="display:block;width:${w}px;height:${h}px">` +
    `<div style="position:absolute;left:${x}px;top:${y}px;width:${width}px;height:${height}px;overflow:hidden">` +
    `<img src="${dataUrl}" style="position:absolute;left:${-x}px;top:${-y}px;width:${w}px;height:${h}px;filter:blur(${radius}px)">` +
    `</div></body></html>`
  )
}

function redactHtml(dataUrl: string, w: number, h: number, region: ImageRect): string {
  const { x, y, width, height } = region
  return (
    `${HTML_HEAD}<body style="position:relative;width:${w}px;height:${h}px">` +
    `<img src="${dataUrl}" style="display:block;width:${w}px;height:${h}px">` +
    `<div style="position:absolute;left:${x}px;top:${y}px;width:${width}px;height:${height}px;background:#000"></div>` +
    `</body></html>`
  )
}

function svgHtml(svgDataUrl: string, w: number, h: number): string {
  return `${HTML_HEAD}<body><img src="${svgDataUrl}" width="${w}" height="${h}" style="display:block"></body></html>`
}

/** Parse + clamp a region rect against the image bounds. */
function parseRegion(raw: unknown, imgW: number, imgH: number): ImageRect | { error: string } | null {
  if (raw === undefined || raw === null) return null
  const r = asRecord(raw)
  const x = intArg(r.x)
  const y = intArg(r.y)
  const width = intArg(r.width ?? r.w)
  const height = intArg(r.height ?? r.h)
  if (x === null || y === null || width === null || height === null) {
    return { error: 'region requires numeric x, y, width, height' }
  }
  // Clamp the origin to [0, imgDim-1] so there is always >=1px of room — a
  // crop rect can never extend past the image edge.
  const cx = clamp(x, 0, imgW - 1)
  const cy = clamp(y, 0, imgH - 1)
  const cw = clamp(width, 1, imgW - cx)
  const ch = clamp(height, 1, imgH - cy)
  return { x: cx, y: cy, width: cw, height: ch }
}

export function createImageToolExecutors(deps: ImageToolExecutorDeps): ImageToolExecutors {
  const { engine, resolveRasterSource, resolveSvgSource } = deps

  async function executeImageEdit(
    args: Record<string, unknown>,
    ctx: ImageToolContext
  ): Promise<McpToolExecutionResult> {
    const op = String(args.op || '').trim().toLowerCase()
    if (!['blur', 'redact', 'crop', 'resize'].includes(op)) {
      return fail('image_edit', `unknown op "${op}". Use blur | redact | crop | resize.`)
    }
    const source = await resolveRasterSource(args, ctx)
    if (!source.ok) return fail('image_edit', `could not read source image: ${source.reason}`)

    // C2 input sniff — the source must be a real raster image (never SVG).
    const inMime = sniffImageMime(source.buffer)
    if (!isTranscriptRasterImageMime(inMime) || isTranscriptSvgMime(inMime)) {
      return fail('image_edit', 'source is not a supported raster image (PNG/JPEG/WebP/GIF/BMP)')
    }

    let size: { width: number; height: number }
    try {
      size = engine.getSize(source.buffer)
    } catch (error) {
      return fail('image_edit', error instanceof Error ? error.message : String(error))
    }
    const { width: imgW, height: imgH } = size
    if (imgW < 1 || imgH < 1) return fail('image_edit', 'source image has no dimensions')

    try {
      if (op === 'crop') {
        const region = parseRegion(args.region, imgW, imgH)
        if (region === null) return fail('image_edit', 'crop requires a region {x,y,width,height}')
        if ('error' in region) return fail('image_edit', region.error)
        const png = engine.crop(source.buffer, region)
        return pngResult('image_edit', { op, width: region.width, height: region.height }, png)
      }
      if (op === 'resize') {
        let targetW = intArg(args.width ?? args.w)
        let targetH = intArg(args.height ?? args.h)
        if (targetW === null && targetH === null) {
          return fail('image_edit', 'resize requires width and/or height')
        }
        if (targetW === null && targetH !== null) targetW = Math.round((imgW / imgH) * targetH)
        if (targetH === null && targetW !== null) targetH = Math.round((imgH / imgW) * targetW)
        targetW = clamp(targetW as number, 1, MAX_IMAGE_DIMENSION)
        targetH = clamp(targetH as number, 1, MAX_IMAGE_DIMENSION)
        const png = engine.resize(source.buffer, { width: targetW, height: targetH })
        return pngResult('image_edit', { op, width: targetW, height: targetH }, png)
      }
      // blur / redact go through the offscreen renderer — guard the framebuffer
      // area BEFORE building the (potentially large) data URL or spinning a window.
      const region = parseRegion(args.region, imgW, imgH)
      if (region && 'error' in region) return fail('image_edit', region.error)
      if (exceedsRenderPixelBudget(imgW, imgH)) {
        return fail('image_edit', renderPixelBudgetMessage(imgW, imgH))
      }
      const dataUrl = rasterDataUrl(source.buffer, inMime as string)
      let html: string
      if (op === 'redact') {
        if (!region) return fail('image_edit', 'redact requires a region {x,y,width,height}')
        html = redactHtml(dataUrl, imgW, imgH, region)
      } else {
        const radius = clamp(intArg(args.radius) ?? 12, 1, MAX_BLUR_RADIUS)
        html = blurHtml(dataUrl, imgW, imgH, region, radius)
      }
      const png = await engine.renderHtmlToPng(html, imgW, imgH, RENDER_TIMEOUT_MS)
      return pngResult('image_edit', { op, width: imgW, height: imgH }, png)
    } catch (error) {
      return fail('image_edit', error instanceof Error ? error.message : String(error))
    }
  }

  async function executeSvgRasterize(
    args: Record<string, unknown>,
    ctx: ImageToolContext
  ): Promise<McpToolExecutionResult> {
    const source = await resolveSvgSource(args, ctx)
    if (!source.ok) return fail('svg_rasterize', `could not read SVG: ${source.reason}`)
    if (!source.svg.trim()) return fail('svg_rasterize', 'SVG is empty')
    if (source.svg.length > MAX_SVG_CHARS) {
      return fail('svg_rasterize', `SVG too large (${source.svg.length} chars; max ${MAX_SVG_CHARS})`)
    }
    const width = clamp(intArg(args.width ?? args.w) ?? 1024, 1, MAX_IMAGE_DIMENSION)
    const height = clamp(intArg(args.height ?? args.h) ?? 768, 1, MAX_IMAGE_DIMENSION)
    if (exceedsRenderPixelBudget(width, height)) {
      return fail('svg_rasterize', renderPixelBudgetMessage(width, height))
    }
    try {
      const svgDataUrl = `data:image/svg+xml;base64,${Buffer.from(source.svg, 'utf-8').toString('base64')}`
      const png = await engine.renderHtmlToPng(svgHtml(svgDataUrl, width, height), width, height, RENDER_TIMEOUT_MS)
      return pngResult('svg_rasterize', { width, height }, png)
    } catch (error) {
      return fail('svg_rasterize', error instanceof Error ? error.message : String(error))
    }
  }

  return {
    executeImageTool(toolName, rawArgs, ctx) {
      const args = asRecord(rawArgs)
      if (toolName === 'image_edit') return executeImageEdit(args, ctx)
      return executeSvgRasterize(args, ctx)
    }
  }
}
