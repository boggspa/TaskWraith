/**
 * CanvasEmbedController — hosts canvas previews as WebContentsViews embedded in
 * the app's main window (the renderer-pane surface), instead of standalone
 * BrowserWindows.
 *
 * It hands the CanvasWebDriver an embedded {@link CanvasHostSurface} via
 * `surfaceFor(canvasId)` (so the driver's scripting/SSRF logic is unchanged), and
 * separately exposes `setBounds` / `setVisible` / `detach` so the renderer can
 * position the floating view over its pane region (a WebContentsView always
 * paints above the window's DOM, so the pane reports its rect and we float the
 * view there; an occluding modal flips visibility off).
 *
 * The WebContentsView + parent-window access are injected so the rect/lifecycle
 * bookkeeping is unit-testable without Electron.
 */
import type { CanvasHostSurface, CanvasSurfaceOptions } from './CanvasHostSurface'

export interface CanvasEmbedRect {
  x: number
  y: number
  width: number
  height: number
}

/** The minimal WebContentsView surface the controller drives. */
export interface EmbeddedViewHandle {
  readonly webContents: {
    getTitle(): string
    isDestroyed(): boolean
    close(): void
  }
  setBounds(rect: CanvasEmbedRect): void
  setVisible(visible: boolean): void
}

/** The minimal parent-window surface (the app's main window). */
export interface EmbedParentWindow {
  isDestroyed(): boolean
  addChildView(view: EmbeddedViewHandle): void
  removeChildView(view: EmbeddedViewHandle): void
  /** The window webContents' zoom factor — the renderer reports CSS-px rects, but
   * setBounds wants DIP, so a zoomed window needs the rect scaled. Defaults to 1. */
  getZoomFactor?(): number
}

export interface CanvasEmbedControllerDeps {
  getParentWindow: () => EmbedParentWindow | null
  createView: (partition: string) => EmbeddedViewHandle
}

interface EmbeddedEntry {
  view: EmbeddedViewHandle
  visible: boolean
  bounds: CanvasEmbedRect
  destroyed: boolean
}

const OFFSCREEN: CanvasEmbedRect = { x: -100000, y: -100000, width: 1, height: 1 }

function clampRect(rect: Partial<CanvasEmbedRect> | undefined): CanvasEmbedRect {
  const n = (v: unknown, fallback: number): number => {
    const x = Math.round(Number(v))
    return Number.isFinite(x) ? x : fallback
  }
  return {
    x: n(rect?.x, 0),
    y: n(rect?.y, 0),
    width: Math.max(0, n(rect?.width, 0)),
    height: Math.max(0, n(rect?.height, 0))
  }
}

export class CanvasEmbedController {
  private readonly entries = new Map<string, EmbeddedEntry>()

  constructor(private readonly deps: CanvasEmbedControllerDeps) {}

  private canDrive(entry: EmbeddedEntry): boolean {
    if (entry.destroyed || entry.view.webContents.isDestroyed()) {
      entry.destroyed = true
      return false
    }
    return true
  }

  private safeSetBounds(entry: EmbeddedEntry, rect: CanvasEmbedRect): void {
    if (!this.canDrive(entry)) return
    try {
      entry.view.setBounds(rect)
    } catch {
      entry.destroyed = true
    }
  }

  private safeSetVisible(entry: EmbeddedEntry, visible: boolean): void {
    if (!this.canDrive(entry)) return
    try {
      entry.view.setVisible(visible)
    } catch {
      entry.destroyed = true
    }
  }

  /** Is this canvas currently embedded (vs standalone)? */
  has(canvasId: string): boolean {
    return this.entries.has(canvasId)
  }

  /**
   * A surface factory bound to `canvasId` — pass as CanvasWebDriver
   * `deps.createSurface`. Creates the WebContentsView, attaches it to the parent
   * window, and tracks it for later setBounds/setVisible/detach.
   */
  surfaceFor(canvasId: string): (opts: CanvasSurfaceOptions) => CanvasHostSurface {
    return (opts) => this.createSurface(canvasId, opts)
  }

  private createSurface(canvasId: string, opts: CanvasSurfaceOptions): CanvasHostSurface {
    const parent = this.deps.getParentWindow()
    if (!parent || parent.isDestroyed()) {
      throw new Error('Main window is unavailable for an embedded canvas.')
    }
    // Replace any stale entry for this id.
    this.detach(canvasId)
    const view = this.deps.createView(opts.partition)
    const entry: EmbeddedEntry = {
      view,
      // A model-requested dock presentation can be created before React has
      // mounted the dock and reported its bounds. Start hidden + parked so the
      // WebContentsView never flashes over unrelated consent or transcript UI.
      visible: false,
      bounds: { x: 0, y: 0, width: opts.width, height: opts.height },
      destroyed: false
    }
    this.entries.set(canvasId, entry)
    parent.addChildView(view)
    this.safeSetVisible(entry, false)
    this.safeSetBounds(entry, OFFSCREEN)
    return {
      webContents: view.webContents as unknown as CanvasHostSurface['webContents'],
      getTitle: () => view.webContents.getTitle(),
      setContentSize: (width, height) => {
        entry.bounds = { ...entry.bounds, width: Math.max(0, width), height: Math.max(0, height) }
        if (entry.visible) this.safeSetBounds(entry, this.scaled(entry.bounds))
      },
      isDestroyed: () => entry.destroyed || view.webContents.isDestroyed(),
      destroy: () => this.detach(canvasId),
      // Embedded views don't self-close like windows; the controller owns teardown.
      onClosed: () => {}
    }
  }

  /**
   * Map a renderer-reported (CSS-px) rect into the window's DIP space the
   * WebContentsView is positioned in. They are 1:1 at zoom 1; a zoomed main window
   * lays the DOM out in CSS px but paints it scaled, so the view rect must scale by
   * the same factor to sit over the pane. (Stored bounds stay raw; we scale only at
   * the setBounds call, so a later zoom change is picked up on the next report.)
   */
  private scaled(rect: CanvasEmbedRect): CanvasEmbedRect {
    const zoom = this.deps.getParentWindow()?.getZoomFactor?.() ?? 1
    if (!Number.isFinite(zoom) || zoom <= 0 || zoom === 1) return rect
    return {
      x: Math.round(rect.x * zoom),
      y: Math.round(rect.y * zoom),
      width: Math.round(rect.width * zoom),
      height: Math.round(rect.height * zoom)
    }
  }

  /** Position the floating view over the renderer pane's reported rect. */
  setBounds(canvasId: string, rect: Partial<CanvasEmbedRect>): void {
    const entry = this.entries.get(canvasId)
    if (!entry || entry.destroyed) return
    entry.bounds = clampRect(rect)
    if (entry.visible) this.safeSetBounds(entry, this.scaled(entry.bounds))
  }

  /** Show/hide the view (e.g. hide while an app modal occludes the pane). */
  setVisible(canvasId: string, visible: boolean): void {
    const entry = this.entries.get(canvasId)
    if (!entry || entry.destroyed) return
    entry.visible = visible
    this.safeSetVisible(entry, visible)
    // Belt-and-suspenders: park it off-screen when hidden so it can't paint over
    // the DOM even if a platform ignores setVisible.
    this.safeSetBounds(entry, visible ? this.scaled(entry.bounds) : OFFSCREEN)
  }

  /** Detach + destroy the embedded view for a canvas (idempotent). */
  detach(canvasId: string): void {
    const entry = this.entries.get(canvasId)
    if (!entry) return
    this.entries.delete(canvasId)
    entry.destroyed = true
    const parent = this.deps.getParentWindow()
    try {
      if (parent && !parent.isDestroyed()) parent.removeChildView(entry.view)
    } catch {
      // Parent may be torn down.
    }
    try {
      if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close()
    } catch {
      // Already gone.
    }
  }

  /** Detach every embedded view — call on app shutdown / main-window close. */
  detachAll(): void {
    for (const id of [...this.entries.keys()]) this.detach(id)
  }
}
