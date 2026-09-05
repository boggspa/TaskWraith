import type { MenuItemConstructorOptions } from 'electron'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ ipcMain: {}, Menu: {} }))
import { buildApplicationMenuTemplate } from './ApplicationMenu'

function submenu(item: MenuItemConstructorOptions): MenuItemConstructorOptions[] {
  return item.submenu as MenuItemConstructorOptions[]
}

describe('application menu', () => {
  it('routes native commands with the selected window and keeps Close a native window action', () => {
    const actions = { newWindow: vi.fn(), command: vi.fn(), checkForUpdates: vi.fn() }
    const menu = buildApplicationMenuTemplate(actions, 'darwin')
    expect(menu[0].label).toBe('TaskWraith')
    const file = submenu(menu.find((item) => item.label === 'File')!)
    expect(file.filter((item) => item.type !== 'separator').map((item) => item.label)).toEqual([
      'New Window',
      'New Chat',
      'Open Folder…',
      'Close'
    ])
    const invoke = (item: MenuItemConstructorOptions): void => {
      item.click?.({} as never, { id: 42 } as never, {} as never)
    }
    invoke(file[0])
    invoke(file[1])
    invoke(file[3])
    expect(actions.newWindow).toHaveBeenCalledOnce()
    expect(actions.command.mock.calls).toEqual([
      ['new-chat', 42],
      ['open-folder', 42]
    ])
    expect(file[5]).toMatchObject({ role: 'close', accelerator: 'CmdOrCtrl+W' })
    const app = submenu(menu[0])
    invoke(app.find((item) => item.label === 'Settings…')!)
    invoke(app.find((item) => item.label === 'Check for Updates…')!)
    expect(actions.command).toHaveBeenLastCalledWith('settings', 42)
    expect(actions.checkForUpdates).toHaveBeenCalledOnce()
  })

  it('keeps Settings and Updates reachable on Windows and Linux', () => {
    for (const platform of ['win32', 'linux'] as const) {
      const menu = buildApplicationMenuTemplate(
        { newWindow() {}, command() {}, checkForUpdates() {} },
        platform
      )
      expect(menu.some((item) => item.label === 'TaskWraith')).toBe(false)
      expect(submenu(menu[0]).some((item) => item.label === 'Settings…')).toBe(true)
      expect(submenu(menu.find((item) => item.role === 'help')!)[0].label).toBe(
        'Check for Updates…'
      )
    }
  })
})
