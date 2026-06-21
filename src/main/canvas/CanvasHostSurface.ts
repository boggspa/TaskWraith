/**
 * CanvasHostSurface — abstracts WHERE a CanvasWebDriver's previewed page lives.
 *
 * The driver only needs a `webContents` to drive (snapshot/screenshot/inspect/
 * act/eval) plus a few lifecycle hooks. WHERE that webContents is hosted — a
 * standalone BrowserWindow (the P0–P4 behaviour) or a WebContentsView embedded in
 * the app window (the renderer-pane slice) — is the surface's concern, NOT the
 * driver's. Keeping this behind an interface lets the embedded surface drop in
 * without touching the driver's security-critical scripting/SSRF logic.
 */
import { BrowserWindow, type WebContents } from 'electron'

export interface CanvasSurfaceOptions {
  partition: string
  width: number
  height: number
}

export interface CanvasHostSurface {
  readonly webContents: WebContents
  getTitle(): string
  /** Resize the surface's content (window content size / embedded view size). */
  setContentSize(width: number, height: number): void
  isDestroyed(): boolean
  destroy(): void
  /** Fires if the surface goes away on its own (window closed). No-op for views. */
  onClosed(callback: () => void): void
}

/** Default surface: a standalone, visible, sandboxed BrowserWindow. */
export function createBrowserWindowSurface(opts: CanvasSurfaceOptions): CanvasHostSurface {
  const win = new BrowserWindow({
    width: opts.width,
    height: opts.height,
    title: 'TaskWraith Canvas',
    backgroundColor: '#111111',
    show: true,
    webPreferences: {
      partition: opts.partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false
    }
  })
  return {
    webContents: win.webContents,
    getTitle: () => win.getTitle(),
    setContentSize: (width, height) => {
      if (!win.isDestroyed()) win.setContentSize(width, height)
    },
    isDestroyed: () => win.isDestroyed(),
    destroy: () => {
      if (!win.isDestroyed()) win.destroy()
    },
    onClosed: (callback) => {
      win.on('closed', callback)
    }
  }
}
