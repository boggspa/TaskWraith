import { BrowserWindow } from 'electron'

import type { SignInWindowHandle } from './WebLoginSignInWindow'

/**
 * The only module that constructs a real sign-in BrowserWindow, kept apart from
 * the controller so the controller stays Electron-free and unit-testable -
 * mirroring how `CanvasEmbedView.ts` is the sole constructor of a real
 * WebContentsView.
 *
 * `nodeIntegration: false` / `contextIsolation: true` / `sandbox: true` and no
 * preload: the user is typing a password into this window, and it must be an
 * ordinary web page with no bridge into the app. Their password manager works
 * here exactly as it would in any browser surface, which is the intended answer
 * to "what happens to my password" - TaskWraith never needs one.
 */
export function createSignInBrowserWindow(opts: {
  partition: string
  title: string
}): SignInWindowHandle {
  const win = new BrowserWindow({
    width: 980,
    height: 760,
    title: opts.title,
    autoHideMenuBar: true,
    webPreferences: {
      partition: opts.partition,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false
    }
  })
  return {
    loadURL: (url) => win.loadURL(url),
    onClosed: (callback) => win.on('closed', callback),
    onDidNavigate: (callback) => {
      win.webContents.on('did-navigate', (_event, url) => callback(url))
      win.webContents.on('did-navigate-in-page', (_event, url) => callback(url))
    },
    close: () => {
      if (!win.isDestroyed()) win.close()
    },
    isDestroyed: () => win.isDestroyed()
  }
}
