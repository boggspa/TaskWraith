/**
 * CanvasChartDriver — the `chart` driver: a screenshot-capable Canvas backed by
 * a structured chart document (not agent HTML/JS). Rasterizes SVG from the
 * shared `chartDocumentToSvg` builder through the same hardened offscreen engine
 * as the html driver (javascript:false, egress cut).
 *
 * Live presentation is a native TelemetryPane in the Canvas dock — there is no
 * WebContentsView. CanvasService grants presentation:"dock" without embed.
 * Agent-facing canvas_open must never accept driver:"chart"; canvas_render_chart
 * owns that contract.
 *
 * The `render` function is injected so the driver stays unit-testable without
 * Electron.
 */
import { createHash } from 'crypto'
import { chartDocumentToSvg } from '../../shared/canvasChartSvg'
import type {
  CanvasActionInput,
  CanvasActResult,
  CanvasChartDocument,
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
  CanvasSketchDocument,
  CanvasSketchUpdateInput,
  CanvasViewport
} from './canvasTypes'
import { clampViewportDimension, readPngDimensions, validateCanvasChart } from './canvasTypes'
import type { CanvasHtmlRenderer } from './CanvasRenderDriver'

export interface CanvasChartDriverDeps {
  render: CanvasHtmlRenderer
  now?: () => string
}

function unsupported(verb: string): never {
  throw new Error(
    `canvas_${verb} is not available for the chart driver (a structured chart is a static, screenshot-only preview).`
  )
}

export class CanvasChartDriver implements CanvasDriver {
  readonly kind = 'chart' as const

  private document: CanvasChartDocument | null = null
  private viewport: CanvasViewport = { width: 1280, height: 800 }
  private cachedFrame: CanvasFrame | null = null
  private readonly render: CanvasHtmlRenderer
  private readonly nowFn: () => string

  constructor(_sessionId: string, deps: CanvasChartDriverDeps) {
    this.render = deps.render
    this.nowFn = deps.now ?? (() => new Date().toISOString())
  }

  async open(input: CanvasOpenInput): Promise<CanvasSessionHandle> {
    if (input.chartDocument === undefined) {
      throw new Error('The chart driver requires a `chartDocument` object.')
    }
    const verdict = validateCanvasChart(input.chartDocument)
    if (!verdict.ok) {
      throw new Error(verdict.reason || 'Invalid chart document.')
    }
    this.document = verdict.document
    this.viewport = {
      width: clampViewportDimension(input.viewport?.width, 1280),
      height: clampViewportDimension(input.viewport?.height, 800)
    }
    const frame = await this.rasterize()
    const hash = createHash('sha256')
      .update(JSON.stringify(this.document))
      .digest('hex')
      .slice(0, 8)
    return {
      url: `chart://${hash}`,
      title: this.document.title,
      viewport: { width: frame.width, height: frame.height }
    }
  }

  private async rasterize(): Promise<CanvasFrame> {
    if (!this.document) throw new Error('Chart canvas is not open.')
    const svg = chartDocumentToSvg(this.document, {
      width: this.viewport.width,
      height: this.viewport.height
    })
    const png = await this.render(svg, this.viewport.width, this.viewport.height)
    const { width, height } = readPngDimensions(png)
    const frame: CanvasFrame = {
      mimeType: 'image/png',
      data: png.toString('base64'),
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
    this.cachedFrame = null
    return this.viewport
  }

  async close(): Promise<void> {
    this.document = null
    this.cachedFrame = null
  }

  chartDocument(): CanvasChartDocument | null {
    return this.document
  }

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
  async sketchDocument(): Promise<CanvasSketchDocument> {
    return unsupported('sketch_get')
  }
  async sketchUpdate(_update: CanvasSketchUpdateInput): Promise<CanvasSketchDocument> {
    return unsupported('sketch_update')
  }
  async evaluate(_args: { script: string }): Promise<CanvasEvalResult> {
    return unsupported('eval')
  }
  async reload(): Promise<void> {
    return unsupported('reload')
  }
}
