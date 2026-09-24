export const APPLICATION_MENU_COMMAND = 'application-menu:command'
export const APPLICATION_MENU_READY = 'application-menu:ready'

export type ApplicationMenuCommand = 'new-chat' | 'open-folder' | 'settings'

export function isApplicationMenuCommand(value: unknown): value is ApplicationMenuCommand {
  return value === 'new-chat' || value === 'open-folder' || value === 'settings'
}

export interface ApplicationMenuBridge {
  onCommand: (listener: (command: ApplicationMenuCommand) => void) => () => void
}
