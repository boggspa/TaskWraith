/**
 * CanvasEmulatorDriver — internal, packaged WebAssembly-emulator surface.
 *
 * This foundation deliberately is not admitted by CanvasService or MCP yet.
 * It proves the lifecycle seam only: a fixed `twemu://app` entry URL is passed
 * to an injected trusted runtime bridge, and pixels come from the same live
 * Canvas host surface the human will later see. Eval, typed observation, and
 * bounded input integration intentionally land in later slices.
 */
import { createHash } from 'node:crypto'
import { emulatorEntryUrl } from '../emulator/EmulatorAssetManifest'
import type { CanvasHostSurface, CanvasSurfaceOptions } from './CanvasHostSurface'
import type {
  CanvasActionInput,
  CanvasActResult,
  CanvasConsoleEntry,
  CanvasDriver,
  CanvasEmulatorGameId,
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
import { isCanvasEmulatorGameId, readPngDimensions, resolveViewport } from './canvasTypes'

const DEFAULT_TITLE = 'Homebrew emulator'

export interface CanvasEmulatorRuntimeBridge {
  /**
   * Boot the fixed packaged page in the supplied live Canvas host surface.
   * The concrete later bridge owns its WebContents hardening; this injected
   * lifecycle foundation does not claim navigation/egress/download containment.
   */
  boot(input: {
    gameId: CanvasEmulatorGameId
    url: string
    surface: CanvasHostSurface
  }): Promise<void>
  /** Optional bridge teardown for a partially booted WASM runtime. */
  shutdown?(input: { gameId: CanvasEmulatorGameId; surface: CanvasHostSurface }): Promise<void>
}

export interface CanvasEmulatorDriverDeps {
  /** Required: product wiring later supplies a dock-owned CanvasEmbedController surface. */
  createSurface: (options: CanvasSurfaceOptions) => CanvasHostSurface
  runtime: CanvasEmulatorRuntimeBridge
  /** Fixed at construction; input.gameId must match this reviewed bundle. */
  gameId?: CanvasEmulatorGameId
  now?: () => string
  /** Host-initiated close callback; CanvasService wiring lands in a later slice. */
  onSurfaceClosed?: () => void
}

function unsupported(verb: string): never {
  throw new Error(
    `canvas_${verb} is not available for the emulator driver (use the dedicated emulator surface contract).`
  )
}

export class CanvasEmulatorDriver implements CanvasDriver {
  readonly kind = 'emulator' as const

  private readonly gameId: CanvasEmulatorGameId
  private readonly partition: string
  private readonly nowFn: () => string
  private readonly closedSurfaces = new WeakSet<CanvasHostSurface>()
  private surface: CanvasHostSurface | null = null
  private viewport: CanvasViewport = { width: 1280, height: 800 }
  private closeRequested = false
  private closePromise: Promise<void> | null = null

  constructor(
    sessionId: string,
    private readonly deps: CanvasEmulatorDriverDeps
  ) {
    this.gameId = deps.gameId ?? 'homebrew-demo'
    this.partition = `canvas-emulator-${sessionId}`
    this.nowFn = deps.now ?? (() => new Date().toISOString())
  }

  private requireSurface(): CanvasHostSurface {
    if (!this.surface || this.surface.isDestroyed()) {
      throw new Error('Emulator canvas is not open (or was closed).')
    }
    return this.surface
  }

  private async teardown(surface: CanvasHostSurface, gameId: CanvasEmulatorGameId): Promise<void> {
    if (this.closedSurfaces.has(surface)) return
    this.closedSurfaces.add(surface)
    try {
      await this.deps.runtime.shutdown?.({ gameId, surface })
    } catch {
      // Surface destruction is the containment boundary. A bridge cleanup
      // failure must not leave a failed-close retry path pretending the live
      // WebContentsView still exists; teardown remains best-effort and closes.
    } finally {
      if (!surface.isDestroyed()) surface.destroy()
    }
  }

  async open(input: CanvasOpenInput): Promise<CanvasSessionHandle> {
    if (this.closeRequested) {
      throw new Error('Emulator canvas open was cancelled because the driver was closed.')
    }
    if (this.surface) throw new Error('Emulator canvas is already open.')
    if (input.driver !== undefined && input.driver !== 'emulator') {
      throw new Error('CanvasEmulatorDriver requires driver "emulator".')
    }
    if (input.url !== undefined) {
      throw new Error('Emulator canvas never accepts a URL; it loads a fixed packaged entry page.')
    }
    if (input.gameId !== undefined && !isCanvasEmulatorGameId(input.gameId)) {
      throw new Error('Emulator canvas has an unsupported game id.')
    }
    const gameId = input.gameId ?? this.gameId
    if (gameId !== this.gameId) {
      throw new Error('Emulator canvas game id does not match this reviewed runtime bundle.')
    }

    const viewport = resolveViewport({
      width: input.viewport?.width,
      height: input.viewport?.height
    })
    const surface = this.deps.createSurface({
      partition: this.partition,
      kind: 'emulator',
      width: viewport.width,
      height: viewport.height
    })
    const url = emulatorEntryUrl(gameId)
    this.surface = surface
    this.viewport = viewport
    surface.onClosed(() => {
      if (this.surface !== surface || this.closedSurfaces.has(surface)) return
      this.surface = null
      this.closeRequested = true
      this.closePromise = this.teardown(surface, gameId)
      this.deps.onSurfaceClosed?.()
    })

    try {
      await this.deps.runtime.boot({ gameId, url, surface })
      if (this.closeRequested || this.surface !== surface) {
        throw new Error('Emulator canvas open was cancelled because the driver was closed.')
      }
      return {
        url,
        title: surface.getTitle().trim() || DEFAULT_TITLE,
        viewport
      }
    } catch (error) {
      if (this.surface === surface) this.surface = null
      await this.teardown(surface, gameId)
      throw error
    }
  }

  async screenshot(): Promise<CanvasFrame> {
    const image = await this.requireSurface().webContents.capturePage()
    const png = image.toPNG()
    const dimensions = readPngDimensions(png)
    return {
      mimeType: 'image/png',
      data: png.toString('base64'),
      width: dimensions.width || this.viewport.width,
      height: dimensions.height || this.viewport.height,
      byteLength: png.byteLength,
      hash: createHash('sha256').update(png).digest('hex'),
      capturedAt: this.nowFn()
    }
  }

  async resize(viewport: CanvasViewport): Promise<CanvasViewport> {
    const next = resolveViewport({ width: viewport.width, height: viewport.height })
    this.requireSurface().setContentSize(next.width, next.height)
    this.viewport = next
    return next
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.closeRequested = true
    const surface = this.surface
    this.surface = null
    this.closePromise = surface ? this.teardown(surface, this.gameId) : Promise.resolve()
    return this.closePromise
  }

  // --- Generic DOM/eval verbs have no emulator analogue in this foundation. ---
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
