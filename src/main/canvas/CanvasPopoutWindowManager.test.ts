import { describe, expect, it, vi } from 'vitest'
import {
  CanvasPopoutWindowManager,
  type CanvasPopoutOpenInput,
  type CanvasPopoutWindowHandle
} from './CanvasPopoutWindowManager'

class FakeWindow implements CanvasPopoutWindowHandle {
  destroyed = false
  minimized = false
  visible = false
  focused = false
  readonly sent: Array<[string, unknown]> = []
  private readonly listeners = new Map<string, Array<() => void>>()
  private readonly contents: CanvasPopoutWindowHandle['webContents']

  constructor(id: number) {
    this.contents = {
      id,
      isDestroyed: () => this.destroyed,
      send: (channel, payload) => this.sent.push([channel, payload])
    }
  }

  get webContents(): CanvasPopoutWindowHandle['webContents'] {
    if (this.destroyed) throw new Error('WebContents was destroyed')
    return this.contents
  }

  isDestroyed(): boolean {
    return this.destroyed
  }
  isMinimized(): boolean {
    return this.minimized
  }
  restore(): void {
    this.minimized = false
  }
  focus(): void {
    this.focused = true
  }
  show(): void {
    this.visible = true
  }
  close(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.emit('closed')
  }
  on(event: 'closed' | 'ready-to-show', callback: () => void): void {
    const listeners = this.listeners.get(event) ?? []
    listeners.push(callback)
    this.listeners.set(event, listeners)
  }
  emit(event: 'closed' | 'ready-to-show'): void {
    for (const callback of this.listeners.get(event) ?? []) callback()
  }
}

function harness() {
  let id = 10
  const windows: FakeWindow[] = []
  const loaded: CanvasPopoutOpenInput[] = []
  const closed = vi.fn()
  const manager = new CanvasPopoutWindowManager({
    createWindow: () => {
      const window = new FakeWindow(++id)
      windows.push(window)
      return window
    },
    loadWindow: async (_window, input) => {
      loaded.push(input)
    },
    onWindowClosed: closed
  })
  return { manager, windows, loaded, closed }
}

describe('CanvasPopoutWindowManager', () => {
  it('registers authority before loading and shows only on ready-to-show', async () => {
    const { manager, windows, loaded } = harness()
    let ownerDuringPrepare: { chatId: string } | null = null
    const result = await manager.open({ chatId: 'chat-a', surface: 'browser' }, (senderId) => {
      ownerDuringPrepare = manager.ownerForSender(senderId)
    })

    expect(result).toEqual({ senderId: 11, created: true })
    expect(ownerDuringPrepare).toEqual({ chatId: 'chat-a' })
    expect(loaded).toEqual([{ chatId: 'chat-a', surface: 'browser' }])
    expect(windows[0].visible).toBe(false)
    windows[0].emit('ready-to-show')
    expect(windows[0].visible).toBe(true)
  })

  it('reuses one window per chat and delivers later surface requests in place', async () => {
    const { manager, windows, loaded } = harness()
    await manager.open({ chatId: 'chat-a', surface: 'mesh' })
    windows[0].minimized = true
    const seed = { canvasId: 'c1', kind: 'web' as const, url: 'https://example.test/' }

    const result = await manager.open({ chatId: 'chat-a', surface: 'browser', session: seed })

    expect(result).toEqual({ senderId: 11, created: false })
    expect(windows).toHaveLength(1)
    expect(loaded).toHaveLength(1)
    expect(windows[0].minimized).toBe(false)
    expect(windows[0].focused).toBe(true)
    expect(windows[0].sent).toContainEqual([
      'canvas-popout-open-surface',
      { chatId: 'chat-a', surface: 'browser', session: seed }
    ])
  })

  it('distinguishes ordinary close from a return-to-dock close', async () => {
    const { manager, windows, closed } = harness()
    const first = await manager.open({ chatId: 'chat-a', surface: 'simulator' })
    manager.closeForDock(first.senderId)
    await vi.waitFor(() =>
      expect(closed).toHaveBeenCalledWith({
        chatId: 'chat-a',
        senderId: first.senderId,
        reason: 'docked'
      })
    )

    const second = await manager.open({ chatId: 'chat-a', surface: 'mesh' })
    windows[1].close()
    await vi.waitFor(() =>
      expect(closed).toHaveBeenCalledWith({
        chatId: 'chat-a',
        senderId: second.senderId,
        reason: 'closed'
      })
    )
  })

  it('broadcasts only to matching live chat windows', async () => {
    const { manager, windows } = harness()
    await manager.open({ chatId: 'chat-a', surface: 'browser' })
    await manager.open({ chatId: 'chat-b', surface: 'mesh' })

    manager.broadcast('canvas-event', { chatId: 'chat-a' }, 'chat-a')

    expect(windows[0].sent).toContainEqual(['canvas-event', { chatId: 'chat-a' }])
    expect(windows[1].sent).toEqual([])
  })
})
