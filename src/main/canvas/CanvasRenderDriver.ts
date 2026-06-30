/**
 * CanvasRenderDriver — the `html` driver: a screenshot-only Canvas backed by
 * agent-authored HTML/SVG rasterized through the SAME hardened offscreen engine
 * the image tools use (OffscreenImageRenderer.renderHtmlToPng).
 *
 * Why this and not the live `web` driver: the offscreen engine renders with
 * `javascript:false` and ALL network egress cancelled, so agent markup is a
 * fully-contained, NON-scriptable preview — no RCE, no SSRF, no local-file read.
 * That keeps the tool's gating posture identical to canvas_open (a prompt, not a
 * new signed-elevated service) while still letting an agent "draw a layout/SVG
 * and screenshot it". The DOM/interactive verbs (snapshot/inspect/click/fill/
 * eval/network/console/annotate/reload) have no analog for a one-shot raster and
 * throw a clear error, exactly like the screenshot-only device driver.
 *
 * The renderer is INJECTED so the orchestration is unit-testable without
 * Electron (the real impl is createNativeImageEngine().renderHtmlToPng).
 */
import { createHash } from 'crypto'
import type {
  CanvasActionInput,
  CanvasActResult,
  CanvasConsoleEntry,
  CanvasDriver,
  CanvasElementDetail,
  CanvasElementTree,
  CanvasEvalResult,
  CanvasFrame,
  CanvasMark,
  CanvasNetworkEntry,
  CanvasOpenInput,
  CanvasSessionHandle,
  CanvasViewport
} from './canvasTypes'
import { clampViewportDimension, readPngDimensions, validateCanvasHtml } from './canvasTypes'

/** Rasterize self-contained HTML/SVG to PNG bytes (offscreen, JS-off, egress-cut). */
export type CanvasHtmlRenderer = (html: string, width: number, height: number) => Promise<Buffer>

export interface CanvasRenderDriverDeps {
  render: CanvasHtmlRenderer
  now?: () => string
}

function unsupported(verb: string): never {
  throw new Error(
    `canvas_${verb} is not available for the html driver (an agent-rendered layout is a static, screenshot-only preview).`
  )
}

export class CanvasRenderDriver implements CanvasDriver {
  readonly kind = 'html' as const

  private html: string | null = null
  private viewport: CanvasViewport = { width: 1280, height: 800 }
  /** Last rendered frame — reused until the html or viewport changes (the markup
   * is static, so re-screenshotting identical content should not re-rasterize). */
  private cachedFrame: CanvasFrame | null = null

  private readonly render: CanvasHtmlRenderer
  private readonly nowFn: () => string

  constructor(_sessionId: string, deps: CanvasRenderDriverDeps) {
    this.render = deps.render
    this.nowFn = deps.now ?? (() => new Date().toISOString())
  }

  async open(input: CanvasOpenInput): Promise<CanvasSessionHandle> {
    const html = input.html ?? ''
    // Defence-in-depth: CanvasService validates too, but never trust a single gate.
    const verdict = validateCanvasHtml(html)
    if (!verdict.ok) throw new Error(verdict.reason || 'Invalid canvas html.')
    this.html = html
    this.viewport = {
      width: clampViewportDimension(input.viewport?.width, 1280),
      height: clampViewportDimension(input.viewport?.height, 800)
    }
    // Render once up front so a markup error surfaces at open() (fail-fast) and
    // the first canvas_screenshot is served from cache (one rasterize, not two).
    const frame = await this.rasterize()
    // sha8 of the markup gives a stable, secret-free id for the audit record.
    const hash = createHash('sha256').update(html).digest('hex').slice(0, 8)
    return {
      url: `html://${hash}`,
      title: 'Rendered HTML',
      viewport: { width: frame.width, height: frame.height }
    }
  }

  private async rasterize(): Promise<CanvasFrame> {
    if (this.html == null) throw new Error('Html canvas is not open.')
    const png = await this.render(this.html, this.viewport.width, this.viewport.height)
    const { width, height } = readPngDimensions(png)
    const frame: CanvasFrame = {
      mimeType: 'image/png',
      data: png.toString('base64'),
      // Fall back to the requested viewport if the PNG header can't be read.
      width: width || this.viewport.width,
      height: height || this.viewport.height,
      byteLength: png.byteLength,
      hash: createHash('sha256').update(png).digest('hex'),
      capturedAt: this.nowFn()
    }
    this.cachedFrame = frame
    return frame
  }

  async screenshot(): Promise<CanvasFrame> {
    if (this.cachedFrame) return this.cachedFrame
    return this.rasterize()
  }

  async resize(viewport: CanvasViewport): Promise<CanvasViewport> {
    this.viewport = {
      width: clampViewportDimension(viewport.width, this.viewport.width),
      height: clampViewportDimension(viewport.height, this.viewport.height)
    }
    // New size → the cached raster is stale; the next screenshot re-renders.
    this.cachedFrame = null
    return this.viewport
  }

  async close(): Promise<void> {
    // Nothing to tear down — the offscreen window is created+destroyed inside
    // each render() call, so there is no long-lived OS resource to release.
    this.html = null
    this.cachedFrame = null
  }

  // --- DOM/structured verbs: no analog for a one-shot raster. ---
  async snapshot(): Promise<CanvasElementTree> {
    return unsupported('snapshot')
  }
  async inspect(): Promise<CanvasElementDetail> {
    return unsupported('inspect')
  }
  async network(): Promise<CanvasNetworkEntry[]> {
    return unsupported('network')
  }
  async console(): Promise<CanvasConsoleEntry[]> {
    return unsupported('console')
  }
  async act(_action: CanvasActionInput): Promise<CanvasActResult> {
    return unsupported('click/fill')
  }
  async annotate(_marks: CanvasMark[]): Promise<{ count: number }> {
    return unsupported('annotate')
  }
  async evaluate(_args: { script: string }): Promise<CanvasEvalResult> {
    return unsupported('eval')
  }
  async reload(): Promise<void> {
    return unsupported('reload')
  }
}
