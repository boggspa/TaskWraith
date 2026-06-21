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
      visible: true,
      bounds: { x: 0, y: 0, width: opts.width, height: opts.height },
      destroyed: false
    }
    this.entries.set(canvasId, entry)
    parent.addChildView(view)
    view.setBounds(entry.bounds)
    return {
      webContents: view.webContents as unknown as CanvasHostSurface['webContents'],
      getTitle: () => view.webContents.getTitle(),
      setContentSize: (width, height) => {
        entry.bounds = { ...entry.bounds, width: Math.max(0, width), height: Math.max(0, height) }
        if (!entry.destroyed && entry.visible) view.setBounds(entry.bounds)
      },
      isDestroyed: () => entry.destroyed || view.webContents.isDestroyed(),
      destroy: () => this.detach(canvasId),
      // Embedded views don't self-close like windows; the controller owns teardown.
      onClosed: () => {}
    }
  }

  /** Position the floating view over the renderer pane's reported rect. */
  setBounds(canvasId: string, rect: Partial<CanvasEmbedRect>): void {
    const entry = this.entries.get(canvasId)
    if (!entry || entry.destroyed) return
    entry.bounds = clampRect(rect)
    if (entry.visible) entry.view.setBounds(entry.bounds)
  }

  /** Show/hide the view (e.g. hide while an app modal occludes the pane). */
  setVisible(canvasId: string, visible: boolean): void {
    const entry = this.entries.get(canvasId)
    if (!entry || entry.destroyed) return
    entry.visible = visible
    entry.view.setVisible(visible)
    // Belt-and-suspenders: park it off-screen when hidden so it can't paint over
    // the DOM even if a platform ignores setVisible.
    entry.view.setBounds(visible ? entry.bounds : OFFSCREEN)
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
