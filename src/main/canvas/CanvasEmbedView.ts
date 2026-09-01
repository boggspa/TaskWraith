/**
 * Electron adapters for CanvasEmbedController — kept in their own module so the
 * controller itself stays Electron-free (and unit-testable). This is the only
 * canvas module that constructs a real WebContentsView.
 */
import { WebContentsView, type BrowserWindow } from 'electron'
import type { EmbeddedViewHandle, EmbedParentWindow } from './CanvasEmbedController'
import type { CanvasSurfaceKind } from './CanvasHostSurface'

/** A sandboxed WebContentsView on TaskWraith's dedicated Canvas profile
 * partition (mirrors the standalone BrowserWindow webPreferences). Emulator
 * surfaces additionally disable Electron's background throttling: their WASM
 * core must keep producing frames while the view is occluded or the app
 * window is backgrounded (same policy as the offscreen MCP renderers). */
export function createElectronEmbedView(
  partition: string,
  kind?: CanvasSurfaceKind
): EmbeddedViewHandle {
  const view = new WebContentsView({
    webPreferences: {
      partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      backgroundThrottling: kind !== 'emulator'
    }
  })
  return view as unknown as EmbeddedViewHandle
}

/** Adapt the app's main BrowserWindow to the controller's parent-window contract. */
export function asEmbedParent(win: BrowserWindow): EmbedParentWindow {
  return {
    isDestroyed: () => win.isDestroyed(),
    addChildView: (view) => win.contentView.addChildView(view as unknown as WebContentsView),
    removeChildView: (view) => win.contentView.removeChildView(view as unknown as WebContentsView),
    getZoomFactor: () => {
      try {
        return win.isDestroyed() ? 1 : win.webContents.getZoomFactor()
      } catch {
        return 1
      }
    }
  }
}
