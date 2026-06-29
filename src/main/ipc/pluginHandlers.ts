import { ipcMain } from 'electron'
import type { PluginHost } from '../plugins/PluginHost'

export interface PluginHandlerDeps {
  pluginHost: Pick<PluginHost, 'getCatalogSnapshot' | 'installPlugin' | 'setPluginEnabled' | 'uninstallPlugin'>
  requireNonEmptyString: (value: unknown, label: string) => string
}

export function registerPluginHandlers(deps: PluginHandlerDeps): void {
  ipcMain.handle('plugins:get-catalog', () => deps.pluginHost.getCatalogSnapshot())
  ipcMain.handle('plugins:install', (_event, pluginId: string) =>
    deps.pluginHost.installPlugin(deps.requireNonEmptyString(pluginId, 'Plugin id'))
  )
  ipcMain.handle('plugins:set-enabled', (_event, pluginId: string, enabled: boolean) =>
    deps.pluginHost.setPluginEnabled(
      deps.requireNonEmptyString(pluginId, 'Plugin id'),
      Boolean(enabled)
    )
  )
  ipcMain.handle('plugins:uninstall', (_event, pluginId: string) =>
    deps.pluginHost.uninstallPlugin(deps.requireNonEmptyString(pluginId, 'Plugin id'))
  )
}

