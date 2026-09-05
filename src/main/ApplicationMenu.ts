import { ipcMain, Menu } from 'electron'
import type { BrowserWindow, MenuItemConstructorOptions } from 'electron'
import { APPLICATION_MENU_READY, type ApplicationMenuCommand } from '../shared/applicationMenu'
import type { DesktopWindowRegistry } from './DesktopWindowRegistry'
import type { AppSettings, KeyCommandBinding } from './store/types'

function nativeAccelerator(binding: KeyCommandBinding): string {
  const keys: Record<string, string> = {
    ' ': 'Space',
    '+': 'Plus',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    ArrowUp: 'Up',
    ArrowDown: 'Down'
  }
  const modifiers = { primary: 'CmdOrCtrl', shift: 'Shift', alt: 'Alt' }
  return [
    ...(['primary', 'shift', 'alt'] as const)
      .filter((modifier) => binding.modifiers.includes(modifier))
      .map((modifier) => modifiers[modifier]),
    keys[binding.key] ?? (binding.key.length === 1 ? binding.key.toUpperCase() : binding.key)
  ].join('+')
}

interface ApplicationMenuActions {
  newWindow: () => void
  command: (command: ApplicationMenuCommand, focusedWindowId?: number) => void
  checkForUpdates: () => void
}

export function buildApplicationMenuTemplate(
  actions: ApplicationMenuActions,
  platform: NodeJS.Platform = process.platform,
  bindings: AppSettings['keyCommandBindings'] = {}
): MenuItemConstructorOptions[] {
  const isMac = platform === 'darwin'
  const shortcut = (id: string, fallback: string): string | undefined => {
    const binding = bindings[id]
    return binding === null ? undefined : binding ? nativeAccelerator(binding) : fallback
  }
  const newShortcut = (fallback: string): string | undefined =>
    Object.values(bindings).some((binding) => binding && nativeAccelerator(binding) === fallback)
      ? undefined
      : fallback
  const settings: MenuItemConstructorOptions = {
    label: 'Settings…',
    accelerator: shortcut('settings', 'CmdOrCtrl+,'),
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
        {
          label: 'New Window',
          accelerator: newShortcut('CmdOrCtrl+Shift+N'),
          click: () => actions.newWindow()
        },
        {
          label: 'New Chat',
          accelerator: shortcut('new-chat', 'CmdOrCtrl+N'),
          click: (_item, window) => actions.command('new-chat', window?.id)
        },
        { type: 'separator' },
        {
          label: 'Open Folder…',
          accelerator: newShortcut('CmdOrCtrl+O'),
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
  getKeyBindings?: () => AppSettings['keyCommandBindings']
}): () => void {
  ipcMain.on(APPLICATION_MENU_READY, (event) => deps.windows.markReady(event.sender.id))
  const refresh = (): void => {
    try {
      Menu.setApplicationMenu(
        Menu.buildFromTemplate(
          buildApplicationMenuTemplate(
            {
              newWindow: deps.createWindow,
              command: (command, id) => deps.windows.dispatch(command, deps.createWindow, id),
              checkForUpdates: deps.openUpdates
            },
            process.platform,
            deps.getKeyBindings?.()
          )
        )
      )
    } catch (error) {
      // Preserve the existing menu and allow desktop startup to continue.
      console.warn('[main] Failed to update application menu:', error)
    }
  }
  refresh()
  return refresh
}
