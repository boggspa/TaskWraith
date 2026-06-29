import { ipcMain } from 'electron'
import type { PluginHost } from '../plugins/PluginHost'
import type { PluginSecretStore } from '../plugins/PluginSecretStore'

export interface PluginHandlerDeps {
  pluginHost: Pick<
    PluginHost,
    | 'getCatalogSnapshot'
    | 'getContributionSnapshot'
    | 'materializeMcpServerPreset'
    | 'installPlugin'
    | 'setPluginEnabled'
    | 'updatePlugin'
    | 'uninstallPlugin'
  >
  pluginSecretStore?: Pick<
    PluginSecretStore,
    'getSecretStatusSnapshot' | 'setSecret' | 'clearSecret' | 'clearPluginSecrets'
  >
  requireNonEmptyString: (value: unknown, label: string) => string
}

export function registerPluginHandlers(deps: PluginHandlerDeps): void {
  ipcMain.handle('plugins:get-catalog', () => deps.pluginHost.getCatalogSnapshot())
  ipcMain.handle('plugins:get-contributions', () => deps.pluginHost.getContributionSnapshot())
  ipcMain.handle('plugins:get-secret-status', () =>
    deps.pluginSecretStore?.getSecretStatusSnapshot(deps.pluginHost.getCatalogSnapshot()) ?? {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      encryptionAvailable: false,
      secrets: []
    }
  )
  ipcMain.handle('plugins:set-secret', (_event, pluginId: string, secretId: string, value: string) =>
    deps.pluginSecretStore?.setSecret(
      deps.pluginHost.getCatalogSnapshot(),
      deps.requireNonEmptyString(pluginId, 'Plugin id'),
      deps.requireNonEmptyString(secretId, 'Plugin secret id'),
      typeof value === 'string' ? value : ''
    ) ?? {
      ok: false,
      error: 'Plugin secret store is unavailable.'
    }
  )
  ipcMain.handle('plugins:clear-secret', (_event, pluginId: string, secretId: string) =>
    deps.pluginSecretStore?.clearSecret(
      deps.pluginHost.getCatalogSnapshot(),
      deps.requireNonEmptyString(pluginId, 'Plugin id'),
      deps.requireNonEmptyString(secretId, 'Plugin secret id')
    ) ?? {
      ok: false,
      error: 'Plugin secret store is unavailable.'
    }
  )
  ipcMain.handle('plugins:materialize-mcp-preset', (_event, pluginId: string, presetId: string) =>
    deps.pluginHost.materializeMcpServerPreset(
      deps.requireNonEmptyString(pluginId, 'Plugin id'),
      deps.requireNonEmptyString(presetId, 'MCP preset id')
    )
  )
  ipcMain.handle('plugins:install', (_event, pluginId: string) =>
    deps.pluginHost.installPlugin(deps.requireNonEmptyString(pluginId, 'Plugin id'))
  )
  ipcMain.handle('plugins:set-enabled', (_event, pluginId: string, enabled: boolean) =>
    deps.pluginHost.setPluginEnabled(
      deps.requireNonEmptyString(pluginId, 'Plugin id'),
      Boolean(enabled)
    )
  )
  ipcMain.handle('plugins:update', (_event, pluginId: string) =>
    deps.pluginHost.updatePlugin(deps.requireNonEmptyString(pluginId, 'Plugin id'))
  )
  ipcMain.handle('plugins:uninstall', (_event, pluginId: string) => {
    const normalizedPluginId = deps.requireNonEmptyString(pluginId, 'Plugin id')
    const snapshot = deps.pluginHost.uninstallPlugin(normalizedPluginId)
    deps.pluginSecretStore?.clearPluginSecrets(normalizedPluginId)
    return snapshot
  })
}
