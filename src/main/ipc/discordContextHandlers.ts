import { ipcMain } from 'electron'

export interface DiscordContextHandlersDeps {
  listTargets: () => Promise<unknown>
  readChannel: (input: unknown) => Promise<unknown>
}

export function registerDiscordContextHandlers(deps: DiscordContextHandlersDeps): void {
  ipcMain.handle('discord-context:list-targets', () => deps.listTargets())
  ipcMain.handle('discord-context:read-channel', (_, input: unknown) => deps.readChannel(input))
}
