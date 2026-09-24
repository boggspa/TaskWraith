import type { MenuItemConstructorOptions } from 'electron'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  ipcMain: { on: vi.fn() },
  Menu: { buildFromTemplate: vi.fn(), setApplicationMenu: vi.fn() }
}))
import { Menu } from 'electron'
import { buildApplicationMenuTemplate, installApplicationMenu } from './ApplicationMenu'
import { DesktopWindowRegistry } from './DesktopWindowRegistry'

function submenu(item: MenuItemConstructorOptions): MenuItemConstructorOptions[] {
  return item.submenu as MenuItemConstructorOptions[]
}

type MenuOutline = Array<string | { [name: string]: MenuOutline }>

/** Labels, roles and separators, nested: what a user sees, without the handlers. */
function outline(items: MenuItemConstructorOptions[]): MenuOutline {
  return items.map((item) => {
    const name = item.label ?? (item.role ? `role:${item.role}` : `type:${item.type}`)
    return Array.isArray(item.submenu)
      ? { [name]: outline(item.submenu as MenuItemConstructorOptions[]) }
      : name
  })
}

/** The menu as it was before Restart Host existed, recorded from d5cfb587f. */
const MENU_BEFORE_RESTART_HOST: Record<'darwin' | 'win32' | 'linux', MenuOutline> = {
  darwin: [
    {
      TaskWraith: [
        'About TaskWraith',
        'type:separator',
        'Settings…',
        'Check for Updates…',
        'type:separator',
        'role:services',
        'type:separator',
        'Hide TaskWraith',
        'role:hideOthers',
        'role:unhide',
        'type:separator',
        'Quit TaskWraith'
      ]
    },
    {
      File: ['New Window', 'New Chat', 'type:separator', 'Open Folder…', 'type:separator', 'Close']
    },
    'role:editMenu',
    'role:viewMenu',
    'role:windowMenu',
    { 'role:help': [] }
  ],
  win32: [
    {
      File: [
        'New Window',
        'New Chat',
        'type:separator',
        'Open Folder…',
        'type:separator',
        'Close',
        'type:separator',
        'Settings…',
        'role:quit'
      ]
    },
    'role:editMenu',
    'role:viewMenu',
    'role:windowMenu',
    { 'role:help': ['Check for Updates…'] }
  ],
  linux: [
    {
      File: [
        'New Window',
        'New Chat',
        'type:separator',
        'Open Folder…',
        'type:separator',
        'Close',
        'type:separator',
        'Settings…',
        'role:quit'
      ]
    },
    'role:editMenu',
    'role:viewMenu',
    'role:windowMenu',
    { 'role:help': ['Check for Updates…'] }
  ]
}

describe('application menu', () => {
  it('keeps desktop startup alive if the native menu cannot be installed', () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(Menu.buildFromTemplate).mockImplementationOnce(() => {
      throw new Error('Native menu unavailable')
    })
    expect(() =>
      installApplicationMenu({
        windows: new DesktopWindowRegistry(),
        createWindow: vi.fn(),
        openUpdates: vi.fn()
      })
    ).not.toThrow()
    expect(warning).toHaveBeenCalledOnce()
    warning.mockRestore()
  })
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
        { newWindow: vi.fn(), command: vi.fn(), checkForUpdates: vi.fn() },
        platform
      )
      expect(menu.some((item) => item.label === 'TaskWraith')).toBe(false)
      expect(submenu(menu[0]).some((item) => item.label === 'Settings…')).toBe(true)
      expect(submenu(menu.find((item) => item.role === 'help')!)[0].label).toBe(
        'Check for Updates…'
      )
    }
  })

  it('preserves customized and disabled shortcuts without stealing a configured chord', () => {
    const menu = buildApplicationMenuTemplate(
      { newWindow: vi.fn(), command: vi.fn(), checkForUpdates: vi.fn() },
      'darwin',
      { 'new-chat': { key: 'O', modifiers: ['primary'] }, settings: null }
    )
    const file = submenu(menu.find((item) => item.label === 'File')!)
    expect(file.find((item) => item.label === 'New Chat')?.accelerator).toBe('CmdOrCtrl+O')
    expect(file.find((item) => item.label === 'Open Folder…')?.accelerator).toBeUndefined()
    expect(submenu(menu[0]).find((item) => item.label === 'Settings…')?.accelerator).toBeUndefined()
  })

  it('adds nothing without a restart action: the recorded menu on every platform', () => {
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      const menu = buildApplicationMenuTemplate(
        { newWindow: vi.fn(), command: vi.fn(), checkForUpdates: vi.fn() },
        platform
      )
      expect(outline(menu)).toEqual(MENU_BEFORE_RESTART_HOST[platform])
    }
  })

  it('puts Restart Host right after Check for Updates…, and changes nothing else', () => {
    const invoke = (item: MenuItemConstructorOptions): void => {
      item.click?.({} as never, { id: 42 } as never, {} as never)
    }
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      const actions = {
        newWindow: vi.fn(),
        command: vi.fn(),
        checkForUpdates: vi.fn(),
        restartHost: vi.fn()
      }
      const menu = buildApplicationMenuTemplate(actions, platform)
      const home = submenu(
        platform === 'darwin' ? menu[0] : menu.find((item) => item.role === 'help')!
      )
      const updates = home.findIndex((item) => item.label === 'Check for Updates…')
      expect(home[updates + 1].label).toBe('Restart Host')
      invoke(home[updates + 1])
      expect(actions.restartHost).toHaveBeenCalledOnce()
      expect(actions.command).not.toHaveBeenCalled()
      expect(actions.checkForUpdates).not.toHaveBeenCalled()
      // Take the one item out and the menu is the recorded one again.
      home.splice(updates + 1, 1)
      expect(outline(menu)).toEqual(MENU_BEFORE_RESTART_HOST[platform])
    }
  })

  it('passes the restart action through the installed menu', () => {
    const restartHost = vi.fn()
    vi.mocked(Menu.buildFromTemplate).mockClear()
    installApplicationMenu({
      windows: new DesktopWindowRegistry(),
      createWindow: vi.fn(),
      openUpdates: vi.fn(),
      restartHost
    })
    const template = vi
      .mocked(Menu.buildFromTemplate)
      .mock.calls.at(-1)![0] as MenuItemConstructorOptions[]
    const items = template.flatMap((item) =>
      Array.isArray(item.submenu) ? (item.submenu as MenuItemConstructorOptions[]) : []
    )
    items
      .find((item) => item.label === 'Restart Host')!
      .click?.({} as never, undefined as never, {} as never)
    expect(restartHost).toHaveBeenCalledOnce()
  })
})
