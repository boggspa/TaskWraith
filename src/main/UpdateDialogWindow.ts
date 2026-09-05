import { BrowserWindow } from 'electron'
import type { UpdateService } from './UpdateService'

interface UpdateDialogDeps {
  preloadPath: string
  rendererFile: string
  rendererUrl?: string
  updateService: Pick<UpdateService, 'snapshot' | 'checkForUpdates' | 'subscribe'>
  openExternal: (url: string) => void
}

/** Independent of the app renderer; downloads and restart coordination stay in main. */
export class UpdateDialogWindow {
  private window: BrowserWindow | null = null

  constructor(private readonly deps: UpdateDialogDeps) {}

  open(): void {
    if (this.window && !this.window.isDestroyed()) {
      if (this.window.isMinimized()) this.window.restore()
      this.window.show()
      this.window.focus()
      this.check()
      return
    }
    const window = new BrowserWindow({
      title: 'TaskWraith Updates',
      width: 740,
      height: 680,
      minWidth: 520,
      minHeight: 420,
      show: false,
      autoHideMenuBar: true,
      backgroundColor: '#1e1e1e',
      webPreferences: {
        preload: this.deps.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    })
    this.window = window
    window.setMenuBarVisibility(false)
    window.webContents.setWindowOpenHandler(({ url }) => {
      this.deps.openExternal(url)
      return { action: 'deny' }
    })
    window.webContents.on('will-navigate', (event) => event.preventDefault())
    const unsubscribe = this.deps.updateService.subscribe((snapshot) => {
      if (window.isDestroyed() || window.webContents.isDestroyed()) return
      try {
        window.webContents.send('update-status-changed', snapshot)
      } catch {
        // Closing the dialog never interrupts the shared update service.
      }
    })
    window.once('closed', () => {
      unsubscribe()
      if (this.window === window) this.window = null
    })
    window.once('ready-to-show', () => {
      window.show()
      window.focus()
    })
    const loaded = this.deps.rendererUrl
      ? window.loadURL(new URL('updater.html', `${this.deps.rendererUrl.replace(/\/$/, '')}/`).href)
      : window.loadFile(this.deps.rendererFile)
    void loaded.catch((error) => console.error('[updates] Could not load update dialog:', error))
    this.check()
  }

  private check(): void {
    const status = this.deps.updateService.snapshot().status
    // Reopening the dialog must preserve an in-flight download or queued restart.
    if (status === 'checking' || status === 'downloading' || status === 'downloaded') return
    void this.deps.updateService.checkForUpdates().catch((error) => {
      console.error('[updates] Check failed:', error)
    })
  }
}
