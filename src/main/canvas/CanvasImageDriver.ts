/**
 * CanvasImageDriver — the `image` driver: a screenshot-only Canvas that shows an
 * EXISTING content-addressed image attachment (canvas_open_attachment). The bytes
 * are loaded through an INJECTED resolver that goes through the media asset store's
 * realpath jail (sha256 + mime→ext whitelist) and decodes via nativeImage, so an
 * agent can only view assets it/its tools already produced — never an arbitrary
 * file. There is no live surface and no scripting; the DOM/interactive verbs throw
 * like the device driver.
 *
 * The loader is injected so the driver is unit-testable without Electron / the
 * real asset store (the real impl reads the jailed asset + nativeImage.toPNG()).
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
import { readPngDimensions, validateCanvasImageRef } from './canvasTypes'

/** Resolve a content-addressed image asset to PNG bytes (jailed; throws if absent/undecodable). */
export type CanvasImageLoader = (sha256: string, mimeType: string) => Promise<Buffer>

export interface CanvasImageDriverDeps {
  load: CanvasImageLoader
  now?: () => string
}

function unsupported(verb: string): never {
  throw new Error(
    `canvas_${verb} is not available for the image driver (an attachment preview is a static, screenshot-only image).`
  )
}

export class CanvasImageDriver implements CanvasDriver {
  readonly kind = 'image' as const

  private frame: CanvasFrame | null = null

  private readonly load: CanvasImageLoader
  private readonly nowFn: () => string

  constructor(_sessionId: string, deps: CanvasImageDriverDeps) {
    this.load = deps.load
    this.nowFn = deps.now ?? (() => new Date().toISOString())
  }

  async open(input: CanvasOpenInput): Promise<CanvasSessionHandle> {
    const sha256 = (input.mediaSha256 || '').trim()
    const mimeType = (input.mediaMimeType || '').trim()
    const verdict = validateCanvasImageRef(sha256, mimeType)
    if (!verdict.ok) throw new Error(verdict.reason || 'Invalid image attachment.')
    const png = await this.load(sha256, mimeType)
    const { width, height } = readPngDimensions(png)
    this.frame = {
      mimeType: 'image/png',
      data: png.toString('base64'),
      width,
      height,
      byteLength: png.byteLength,
      hash: createHash('sha256').update(png).digest('hex'),
      capturedAt: this.nowFn()
    }
    return {
      // Content hash only — never a filesystem path or secret.
      url: `image://${sha256}`,
      title: mimeType,
      viewport: { width: width || 1, height: height || 1 }
    }
  }

  async screenshot(): Promise<CanvasFrame> {
    if (!this.frame) throw new Error('Image canvas is not open.')
    return this.frame
  }

  async close(): Promise<void> {
    this.frame = null
  }

  // --- An attachment image has an intrinsic size and no DOM. ---
  async resize(_viewport: CanvasViewport): Promise<CanvasViewport> {
    return unsupported('resize')
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
  async evaluate(_args: { script: string }): Promise<CanvasEvalResult> {
    return unsupported('eval')
  }
  async reload(): Promise<void> {
    return unsupported('reload')
  }
}
