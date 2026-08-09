/**
 * Electron adapters for CanvasEmbedController — kept in their own module so the
 * controller itself stays Electron-free (and unit-testable). This is the only
 * canvas module that constructs a real WebContentsView.
 */
import { WebContentsView, type BrowserWindow } from 'electron'
import type { EmbeddedViewHandle, EmbedParentWindow } from './CanvasEmbedController'

/** A sandboxed WebContentsView on TaskWraith's dedicated Canvas profile
 * partition (mirrors the standalone BrowserWindow webPreferences). */
export function createElectronEmbedView(partition: string): EmbeddedViewHandle {
  const view = new WebContentsView({
    webPreferences: {
      partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false
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
