import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { APPLICATION_MENU_COMMAND } from '../shared/applicationMenu'
import { DesktopWindowRegistry } from './DesktopWindowRegistry'

class FakeWindow extends EventEmitter {
  destroyed = false
  webContents = Object.assign(new EventEmitter(), {
    id: 0,
    isDestroyed: () => this.destroyed,
    send: vi.fn()
  })
  show = vi.fn()
  restore = vi.fn()
  isMinimized = () => true
  isDestroyed = () => this.destroyed
  focus = () => this.emit('focus')
  constructor(readonly id: number) {
    super()
    this.webContents.id = id + 100
  }
  close(): void {
    this.destroyed = true
    this.emit('closed')
  }
  electron(): BrowserWindow {
    return this as unknown as BrowserWindow
  }
}

describe('DesktopWindowRegistry', () => {
  it('tracks multiple complete windows and promotes a survivor when the selected one closes', () => {
    const selected = vi.fn()
    const registry = new DesktopWindowRegistry(selected)
    const first = new FakeWindow(1)
    const second = new FakeWindow(2)
    registry.add(first.electron())
    registry.add(second.electron())
    expect(registry.ownsSender(first.webContents.id)).toBe(true)
    expect(registry.ownsSender(second.webContents.id)).toBe(true)
    expect(registry.ownsSender(999)).toBe(false)
    first.focus()
    expect(registry.selected()).toBe(first)
    second.close()
    expect(registry.selected()).toBe(first)
    expect(selected).toHaveBeenLastCalledWith(first)
    first.close()
    expect(registry.selected()).toBeNull()
    expect(selected).toHaveBeenLastCalledWith(null)
  })

  it('queues menu commands until the intended renderer has installed its handler', () => {
    const registry = new DesktopWindowRegistry()
    const first = new FakeWindow(1)
    const second = new FakeWindow(2)
    registry.add(first.electron())
    registry.add(second.electron())
    const create = vi.fn()
    registry.dispatch('settings', create, first.id)
    registry.dispatch('new-chat', create, second.id)
    registry.markReady(999)
    registry.markReady(first.webContents.id)
    expect(first.webContents.send).toHaveBeenCalledExactlyOnceWith(
      APPLICATION_MENU_COMMAND,
      'settings'
    )
    expect(second.webContents.send).not.toHaveBeenCalled()
    registry.markReady(second.webContents.id)
    expect(second.webContents.send).toHaveBeenCalledExactlyOnceWith(
      APPLICATION_MENU_COMMAND,
      'new-chat'
    )
    expect(create).not.toHaveBeenCalled()
  })

  it('creates a complete window when none remains and waits again after reload', () => {
    const registry = new DesktopWindowRegistry()
    const window = new FakeWindow(1)
    const create = vi.fn(() => {
      registry.add(window.electron())
      return window.electron()
    })
    registry.dispatch('open-folder', create)
    expect(create).toHaveBeenCalledOnce()
    registry.markReady(window.webContents.id)
    window.webContents.emit('did-start-loading')
    registry.dispatch('new-chat', create)
    expect(window.webContents.send).toHaveBeenCalledTimes(1)
    registry.markReady(window.webContents.id)
    expect(window.webContents.send).toHaveBeenLastCalledWith(APPLICATION_MENU_COMMAND, 'new-chat')
    expect(window.restore).toHaveBeenCalled()
  })

  it('broadcasts shared changes to every complete window, even if one send fails', () => {
    const registry = new DesktopWindowRegistry()
    const first = new FakeWindow(1)
    const second = new FakeWindow(2)
    registry.add(first.electron())
    registry.add(second.electron())
    first.webContents.send.mockImplementation(() => {
      throw new Error('Frame disposed')
    })
    registry.broadcast('workspace-list-updated', ['workspace'])
    expect(second.webContents.send).toHaveBeenCalledWith('workspace-list-updated', ['workspace'])
    first.close()
    expect(registry.ownsSender(first.webContents.id)).toBe(false)
    expect(registry.selected()).toBe(second)
  })
})
