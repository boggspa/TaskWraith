import type { BrowserWindow } from 'electron'
import { APPLICATION_MENU_COMMAND, type ApplicationMenuCommand } from '../shared/applicationMenu'

/** Only complete app windows belong here; chat/canvas/updater popouts do not. */
export class DesktopWindowRegistry {
  private readonly entries = new Map<number, BrowserWindow>()
  private readonly ready = new Set<number>()
  private readonly pending = new Map<number, ApplicationMenuCommand[]>()
  private selectedId: number | undefined

  constructor(private readonly onSelection: (window: BrowserWindow | null) => void = () => {}) {}

  all(): BrowserWindow[] {
    return [...this.entries.values()].filter((window) => !window.isDestroyed())
  }

  selected(): BrowserWindow | null {
    const selected = this.selectedId === undefined ? undefined : this.entries.get(this.selectedId)
    return selected && !selected.isDestroyed() ? selected : (this.all()[0] ?? null)
  }

  ownsSender(senderId: number): boolean {
    return this.all().some((window) => window.webContents.id === senderId)
  }

  add(window: BrowserWindow): void {
    this.entries.set(window.id, window)
    this.select(window)
    const senderId = window.webContents.id
    window.on('focus', () => this.select(window))
    window.webContents.on('did-start-loading', () => this.ready.delete(senderId))
    window.once('closed', () => {
      this.entries.delete(window.id)
      this.ready.delete(senderId)
      this.pending.delete(senderId)
      if (this.selectedId === window.id) {
        this.selectedId = undefined
        const next = this.selected()
        this.selectedId = next?.id
        this.onSelection(next)
      }
    })
  }

  private select(window: BrowserWindow): void {
    if (!this.entries.has(window.id) || window.isDestroyed()) return
    this.selectedId = window.id
    this.onSelection(window)
  }

  markReady(senderId: number): void {
    if (!this.ownsSender(senderId)) return
    this.ready.add(senderId)
    const commands = this.pending.get(senderId) ?? []
    this.pending.delete(senderId)
    const window = this.all().find((entry) => entry.webContents.id === senderId)
    if (window)
      for (const command of commands) this.sendTo(window, APPLICATION_MENU_COMMAND, command)
  }

  dispatch(
    command: ApplicationMenuCommand,
    createWindow: () => BrowserWindow,
    focusedWindowId?: number
  ): void {
    const focused = focusedWindowId === undefined ? undefined : this.entries.get(focusedWindowId)
    const window = (focused && !focused.isDestroyed() ? focused : this.selected()) ?? createWindow()
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
    const senderId = window.webContents.id
    if (this.ready.has(senderId)) {
      this.sendTo(window, APPLICATION_MENU_COMMAND, command)
    } else {
      this.pending.set(senderId, [...(this.pending.get(senderId) ?? []), command])
    }
  }

  broadcast(channel: string, payload?: unknown): void {
    for (const window of this.all()) this.sendTo(window, channel, payload)
  }

  private sendTo(window: BrowserWindow, channel: string, payload: unknown): void {
    if (window.isDestroyed() || window.webContents.isDestroyed()) return
    try {
      window.webContents.send(channel, payload)
    } catch {
      // A closing renderer must not prevent delivery to another app window.
    }
  }
}
