import { ipcMain, Menu } from 'electron'
import type { BrowserWindow, MenuItemConstructorOptions } from 'electron'
import { APPLICATION_MENU_READY, type ApplicationMenuCommand } from '../shared/applicationMenu'
import type { DesktopWindowRegistry } from './DesktopWindowRegistry'

interface ApplicationMenuActions {
  newWindow: () => void
  command: (command: ApplicationMenuCommand, focusedWindowId?: number) => void
  checkForUpdates: () => void
}

export function buildApplicationMenuTemplate(
  actions: ApplicationMenuActions,
  platform: NodeJS.Platform = process.platform
): MenuItemConstructorOptions[] {
  const isMac = platform === 'darwin'
  const settings: MenuItemConstructorOptions = {
    label: 'Settings…',
    accelerator: 'CmdOrCtrl+,',
    click: (_item, window) => actions.command('settings', window?.id)
  }
  const updates: MenuItemConstructorOptions = {
    label: 'Check for Updates…',
    click: () => actions.checkForUpdates()
  }
  return [
    ...(isMac
      ? [
          {
            label: 'TaskWraith',
            submenu: [
              { role: 'about', label: 'About TaskWraith' },
              { type: 'separator' },
              settings,
              updates,
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide', label: 'Hide TaskWraith' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit', label: 'Quit TaskWraith' }
            ]
          } as MenuItemConstructorOptions
        ]
      : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Window', accelerator: 'CmdOrCtrl+Shift+N', click: () => actions.newWindow() },
        {
          label: 'New Chat',
          accelerator: 'CmdOrCtrl+N',
          click: (_item, window) => actions.command('new-chat', window?.id)
        },
        { type: 'separator' },
        {
          label: 'Open Folder…',
          accelerator: 'CmdOrCtrl+O',
          click: (_item, window) => actions.command('open-folder', window?.id)
        },
        { type: 'separator' },
        { role: 'close', label: 'Close', accelerator: 'CmdOrCtrl+W' },
        ...(!isMac
          ? ([{ type: 'separator' }, settings, { role: 'quit' }] as MenuItemConstructorOptions[])
          : [])
      ]
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    { role: 'help', submenu: isMac ? [] : [updates] }
  ]
}

export function installApplicationMenu(deps: {
  windows: DesktopWindowRegistry
  createWindow: () => BrowserWindow
  openUpdates: () => void
}): void {
  ipcMain.on(APPLICATION_MENU_READY, (event) => deps.windows.markReady(event.sender.id))
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      buildApplicationMenuTemplate({
        newWindow: deps.createWindow,
        command: (command, id) => deps.windows.dispatch(command, deps.createWindow, id),
        checkForUpdates: deps.openUpdates
      })
    )
  )
}
