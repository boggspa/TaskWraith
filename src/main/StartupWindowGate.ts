/**
 * Prevents a second-instance activation from creating a renderer window before
 * main-process IPC registration has completed. Electron can deliver that
 * activation while the first instance is still awaiting startup recovery.
 */
export class StartupWindowGate {
  private ready = false
  private pendingWindowRequest = false

  requestWindow(createWindow: () => void): boolean {
    if (!this.ready) {
      this.pendingWindowRequest = true
      return false
    }

    createWindow()
    return true
  }

  release(createWindow: () => void): boolean {
    if (this.ready) return false
    this.ready = true

    if (!this.pendingWindowRequest) return false
    this.pendingWindowRequest = false
    createWindow()
    return true
  }
}
