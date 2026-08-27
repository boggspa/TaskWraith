/**
 * Lifecycle registry for the chat-scoped Canvas utility window.
 *
 * The manager is intentionally Electron-light: index.ts supplies the hardened
 * BrowserWindow constructor and renderer loader, while this module owns
 * one-window-per-chat reuse, sender authority, focus, and close-vs-dock intent.
 */

export type CanvasPopoutSurface = 'browser' | 'sketch' | 'mesh' | 'simulator' | 'media'

export interface CanvasPopoutSessionSeed {
  canvasId: string
  kind: 'web' | 'sketch'
  url?: string
  title?: string
}

export interface CanvasPopoutOpenInput {
  chatId: string
  surface: CanvasPopoutSurface
  session?: CanvasPopoutSessionSeed
}

export interface CanvasPopoutWindowHandle {
  readonly webContents: {
    readonly id: number
    isDestroyed(): boolean
    send(channel: string, payload: unknown): void
  }
  isDestroyed(): boolean
  isMinimized(): boolean
  restore(): void
  focus(): void
  show(): void
  close(): void
  on(event: 'closed' | 'ready-to-show', callback: () => void): void
}

export interface CanvasPopoutWindowManagerDeps {
  createWindow(): CanvasPopoutWindowHandle
  loadWindow(window: CanvasPopoutWindowHandle, input: CanvasPopoutOpenInput): Promise<void>
  onWindowClosed?(input: {
    chatId: string
    senderId: number
    reason: 'closed' | 'docked'
  }): void | Promise<void>
}

interface CanvasPopoutRecord {
  readonly chatId: string
  readonly window: CanvasPopoutWindowHandle
  closingReason: 'closed' | 'docked'
}

export interface CanvasPopoutOpenResult {
  senderId: number
  created: boolean
}

export class CanvasPopoutWindowManager {
  private readonly byChatId = new Map<string, CanvasPopoutRecord>()
  private readonly bySenderId = new Map<number, CanvasPopoutRecord>()

  constructor(private readonly deps: CanvasPopoutWindowManagerDeps) {}

  ownerForSender(senderId: number): { chatId: string } | null {
    const record = this.bySenderId.get(senderId)
    if (!record || record.window.isDestroyed() || record.window.webContents.isDestroyed()) {
      return null
    }
    return { chatId: record.chatId }
  }

  windowForSender(senderId: number): CanvasPopoutWindowHandle | null {
    const record = this.bySenderId.get(senderId)
    return record && !record.window.isDestroyed() ? record.window : null
  }

  /**
   * Open or focus the chat's Canvas window. `beforePresent` runs after the
   * destination WebContents id exists but before React sees the session seed,
   * allowing a WebContentsView to be reparented without a visible reload race.
   */
  async open(
    input: CanvasPopoutOpenInput,
    beforePresent?: (senderId: number) => void | Promise<void>
  ): Promise<CanvasPopoutOpenResult> {
    const existing = this.byChatId.get(input.chatId)
    if (existing && !existing.window.isDestroyed() && !existing.window.webContents.isDestroyed()) {
      const senderId = existing.window.webContents.id
      await beforePresent?.(senderId)
      if (existing.window.isMinimized()) existing.window.restore()
      existing.window.focus()
      existing.window.webContents.send('canvas-popout-open-surface', input)
      return { senderId, created: false }
    }
    if (existing) this.forget(existing)

    const window = this.deps.createWindow()
    const record: CanvasPopoutRecord = {
      chatId: input.chatId,
      window,
      closingReason: 'closed'
    }
    this.byChatId.set(input.chatId, record)
    this.bySenderId.set(window.webContents.id, record)
    window.on('ready-to-show', () => {
      if (!window.isDestroyed()) window.show()
    })
    window.on('closed', () => {
      this.forget(record)
      void Promise.resolve(
        this.deps.onWindowClosed?.({
          chatId: record.chatId,
          senderId: window.webContents.id,
          reason: record.closingReason
        })
      ).catch(() => undefined)
    })

    try {
      await beforePresent?.(window.webContents.id)
      await this.deps.loadWindow(window, input)
      return { senderId: window.webContents.id, created: true }
    } catch (error) {
      this.forget(record)
      if (!window.isDestroyed()) window.close()
      throw error
    }
  }

  closeForDock(senderId: number): void {
    const record = this.bySenderId.get(senderId)
    if (!record || record.window.isDestroyed()) return
    record.closingReason = 'docked'
    record.window.close()
  }

  closeChat(chatId: string): void {
    const record = this.byChatId.get(chatId)
    if (!record || record.window.isDestroyed()) return
    record.window.close()
  }

  broadcast(channel: string, payload: unknown, chatId?: string): void {
    for (const record of this.byChatId.values()) {
      if (chatId && record.chatId !== chatId) continue
      const webContents = record.window.webContents
      if (record.window.isDestroyed() || webContents.isDestroyed()) continue
      try {
        webContents.send(channel, payload)
      } catch {
        // A renderer can disappear between the liveness checks and send.
      }
    }
  }

  private forget(record: CanvasPopoutRecord): void {
    if (this.byChatId.get(record.chatId) === record) this.byChatId.delete(record.chatId)
    if (this.bySenderId.get(record.window.webContents.id) === record) {
      this.bySenderId.delete(record.window.webContents.id)
    }
  }
}
