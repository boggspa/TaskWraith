import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { UpdateStateSnapshot } from './UpdateService'

const state = vi.hoisted(() => ({ windows: [] as any[] }))
vi.mock('electron', () => ({
  BrowserWindow: class extends EventEmitter {
    webContents = Object.assign(new EventEmitter(), {
      isDestroyed: () => false,
      send: vi.fn(),
      setWindowOpenHandler: vi.fn()
    })
    destroyed = false
    isDestroyed = () => this.destroyed
    isMinimized = () => true
    show = vi.fn()
    focus = vi.fn()
    restore = vi.fn()
    setMenuBarVisibility = vi.fn()
    loadFile = vi.fn().mockResolvedValue(undefined)
    loadURL = vi.fn().mockResolvedValue(undefined)
    constructor(readonly options: unknown) {
      super()
      state.windows.push(this)
    }
  }
}))
import { UpdateDialogWindow } from './UpdateDialogWindow'

function setup(status: UpdateStateSnapshot['status'] = 'idle', rendererUrl?: string) {
  const listeners = new Set<(snapshot: UpdateStateSnapshot) => void>()
  const service = {
    snapshot: () => ({ status, enabled: true, channel: 'stable' as const }),
    checkForUpdates: vi.fn().mockResolvedValue(null),
    subscribe: (listener: (snapshot: UpdateStateSnapshot) => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
  }
  const manager = new UpdateDialogWindow({
    preloadPath: '/preload/index.js',
    rendererFile: '/renderer/updater.html',
    rendererUrl,
    updateService: service,
    openExternal: vi.fn()
  })
  return { manager, service, listeners }
}

describe('update dialog window', () => {
  beforeEach(() => {
    state.windows.length = 0
  })

  it('uses a separate renderer entry and focuses the existing dialog on repeated clicks', () => {
    const { manager, service } = setup()
    manager.open()
    manager.open()
    expect(state.windows).toHaveLength(1)
    const window = state.windows[0]
    expect(window.loadFile).toHaveBeenCalledWith('/renderer/updater.html')
    expect(window.options.webPreferences).toMatchObject({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    })
    expect(window.restore).toHaveBeenCalledOnce()
    expect(window.focus).toHaveBeenCalledOnce()
    expect(service.checkForUpdates).toHaveBeenCalledTimes(2)
  })

  it('receives progress without an app window and detaches only its own subscription on close', () => {
    const { manager, listeners } = setup()
    manager.open()
    const window = state.windows[0]
    const snapshot: UpdateStateSnapshot = { status: 'downloaded', enabled: true, channel: 'stable' }
    for (const listener of listeners) listener(snapshot)
    expect(window.webContents.send).toHaveBeenCalledWith('update-status-changed', snapshot)
    window.destroyed = true
    window.emit('closed')
    expect(listeners.size).toBe(0)
    manager.open()
    expect(state.windows).toHaveLength(2)
    expect(listeners.size).toBe(1)
  })

  it.each(['checking', 'downloading', 'downloaded'] as const)(
    'preserves %s work on reopen',
    (status) => {
      const { manager, service } = setup(status)
      manager.open()
      expect(service.checkForUpdates).not.toHaveBeenCalled()
    }
  )

  it('loads the dedicated Vite entry in development', () => {
    const { manager } = setup('idle', 'http://localhost:5173')
    manager.open()
    expect(state.windows[0].loadURL).toHaveBeenCalledWith('http://localhost:5173/updater.html')
  })
})
