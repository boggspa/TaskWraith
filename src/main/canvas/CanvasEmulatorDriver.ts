/**
 * CanvasEmulatorDriver — internal, packaged WebAssembly-emulator surface.
 *
 * This driver is admitted only through CanvasService's internal fixed-game dock
 * path; no public MCP route is wired yet. It passes a fixed `twemu://app` entry
 * URL to an injected trusted runtime bridge and exposes internal-only atomic
 * observation plus one-frame input. Generic Canvas snapshot/eval and public
 * agent control remain intentionally out of scope.
 */
import { createHash } from 'node:crypto'
import {
  isEmulatorButton,
  type EmulatorButton,
  type EmulatorObservationToken
} from '../../shared/emulatorCanvas'
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

/**
 * Bounded state copied from the page-owned TWGB ABI. This intentionally has no
 * Module, HEAP, RAM pointer, or arbitrary memory range.
 */
export interface CanvasEmulatorRuntimeState {
  readonly magic: readonly [number, number, number, number]
  readonly schema: 1
  readonly status: 3
  readonly x: number
  readonly y: number
  readonly input: number
  readonly frameCounter: number
  /** SHA-256 of the page's swizzled RGBA frame, distinct from PNG `frame.hash`. */
  readonly rgbaHash: string
}

/** Main-owned projection of one exact page canvas/ABI transaction. */
export interface CanvasEmulatorAtomicObservation extends EmulatorObservationToken {
  readonly schemaVersion: 1
  readonly capturedAt: string
  readonly frame: Readonly<CanvasFrame>
  readonly state: Readonly<CanvasEmulatorRuntimeState>
}

/**
 * Internal-only runtime extension. CanvasEmulatorDriver's normal lifecycle
 * bridge stays source-compatible for factory callers; observation/input are
 * reachable only when the concrete bridge explicitly implements this seam.
 */
export interface CanvasEmulatorObservationRuntimeBridge extends CanvasEmulatorRuntimeBridge {
  observe(input: {
    gameId: CanvasEmulatorGameId
    surface: CanvasHostSurface
  }): Promise<CanvasEmulatorAtomicObservation>
  step(input: {
    gameId: CanvasEmulatorGameId
    surface: CanvasHostSurface
    buttons: readonly EmulatorButton[]
    expectedFrameId: number
    expectedInputEpoch: number
  }): Promise<CanvasEmulatorAtomicObservation>
}

/** Typed refusal for a human transition that invalidated a planned internal step. */
export class CanvasEmulatorInputEpochStaleError extends Error {
  readonly code = 'stale_input_epoch' as const

  constructor(readonly observation?: CanvasEmulatorAtomicObservation) {
    super('Emulator human input changed since the expected observation epoch.')
    this.name = 'CanvasEmulatorInputEpochStaleError'
  }
}

/** Typed refusal for a page frame that no longer matches the cached observation. */
export class CanvasEmulatorObservationStaleError extends Error {
  readonly code = 'stale_observation' as const

  constructor(readonly observation?: CanvasEmulatorAtomicObservation) {
    super('Emulator frame changed since the expected observation.')
    this.name = 'CanvasEmulatorObservationStaleError'
  }
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
  private lastObservation: CanvasEmulatorAtomicObservation | null = null

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

  private observationRuntime(): CanvasEmulatorObservationRuntimeBridge {
    const runtime = this.deps.runtime as Partial<CanvasEmulatorObservationRuntimeBridge>
    if (typeof runtime.observe !== 'function' || typeof runtime.step !== 'function') {
      throw new Error('Emulator runtime does not support the internal observation contract yet.')
    }
    return runtime as CanvasEmulatorObservationRuntimeBridge
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
    this.lastObservation = null
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

  /**
   * Internal-only exact observation. It deliberately does not implement the
   * generic Canvas snapshot contract and is not wired to any public tool.
   */
  async observeEmulator(): Promise<CanvasEmulatorAtomicObservation> {
    const observation = await this.observationRuntime().observe({
      gameId: this.gameId,
      surface: this.requireSurface()
    })
    this.lastObservation = observation
    return observation
  }

  /**
   * Internal-only one-frame control. The optional opaque id must match the
   * driver's latest trusted observation; the frame/input token never comes
   * from a caller. The page re-checks both values inside its operation queue.
   */
  async stepEmulator(
    buttons: readonly EmulatorButton[],
    expectedObservationId?: string
  ): Promise<CanvasEmulatorAtomicObservation> {
    if (!Array.isArray(buttons) || buttons.some((button) => !isEmulatorButton(button))) {
      throw new Error('Emulator step requires only supported named buttons.')
    }
    const expected = this.lastObservation
    if (!expected) {
      throw new Error('Observe the emulator before stepping.')
    }
    if (expectedObservationId !== undefined && expectedObservationId !== expected.observationId) {
      throw new CanvasEmulatorObservationStaleError()
    }
    try {
      const observation = await this.observationRuntime().step({
        gameId: this.gameId,
        surface: this.requireSurface(),
        buttons: [...buttons],
        expectedFrameId: expected.frameId,
        expectedInputEpoch: expected.inputEpoch
      })
      this.lastObservation = observation
      return observation
    } catch (error) {
      if (
        (error instanceof CanvasEmulatorInputEpochStaleError ||
          error instanceof CanvasEmulatorObservationStaleError) &&
        error.observation
      ) {
        this.lastObservation = error.observation
      }
      throw error
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
    this.lastObservation = null
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
