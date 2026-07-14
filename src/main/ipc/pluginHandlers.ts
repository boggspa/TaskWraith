import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { PluginHost } from '../plugins/PluginHost'
import type { PluginSecretStore } from '../plugins/PluginSecretStore'
import type { PluginContributionManager } from '../plugins/PluginContributionManager'
import type { TaskWraithPluginActivationSnapshot } from '../../shared/plugins/PluginTypes'

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
  pluginContributionManager?: Pick<
    PluginContributionManager,
    'sync' | 'getActivationSnapshot'
  >
  onActivationChanged?: (snapshot: TaskWraithPluginActivationSnapshot) => void
  isMainRendererSender: (event: IpcMainInvokeEvent) => boolean
  requireNonEmptyString: (value: unknown, label: string) => string
}

export function rendererSafePluginActivation(
  snapshot: TaskWraithPluginActivationSnapshot
): TaskWraithPluginActivationSnapshot {
  return {
    schemaVersion: 1,
    generatedAt: snapshot.generatedAt,
    mcpServers: [],
    runtimeProfileIds: [],
    taskwraithToolBundles: [],
    workflowTemplates: snapshot.workflowTemplates.map((entry) => ({
      id: entry.id,
      plugin: {
        pluginId: entry.plugin.pluginId,
        publisher: entry.plugin.publisher,
        version: entry.plugin.version,
        source: entry.plugin.source,
        namespace: entry.plugin.namespace,
        manifestHash: entry.plugin.manifestHash
      },
      template: {
        id: entry.template.id,
        name: entry.template.name,
        ...(entry.template.description ? { description: entry.template.description } : {}),
        prompt: entry.template.prompt,
        ...(entry.template.provider ? { provider: entry.template.provider } : {})
      },
      pluginProvenance: {
        pluginId: entry.pluginProvenance.pluginId,
        publisher: entry.pluginProvenance.publisher,
        version: entry.pluginProvenance.version,
        source: entry.pluginProvenance.source,
        namespace: entry.pluginProvenance.namespace,
        manifestHash: entry.pluginProvenance.manifestHash,
        kind: entry.pluginProvenance.kind,
        objectId: entry.pluginProvenance.objectId,
        materializedAt: entry.pluginProvenance.materializedAt
      }
    })),
    connectors: [],
    localServices: [],
    providerSetup: [],
    mobileRemoteProjection: [],
    materializedResources: snapshot.materializedResources.map((resource) => ({
      id: resource.id,
      kind: resource.kind,
      ...(resource.label ? { label: resource.label } : {}),
      ...(resource.enabled !== undefined ? { enabled: resource.enabled } : {}),
      ...(resource.running !== undefined ? { running: resource.running } : {}),
      ...(resource.pluginProvenance
        ? {
            pluginProvenance: {
              pluginId: resource.pluginProvenance.pluginId,
              publisher: resource.pluginProvenance.publisher,
              version: resource.pluginProvenance.version,
              source: resource.pluginProvenance.source,
              namespace: resource.pluginProvenance.namespace,
              manifestHash: resource.pluginProvenance.manifestHash,
              kind: resource.pluginProvenance.kind,
              objectId: resource.pluginProvenance.objectId,
              materializedAt: resource.pluginProvenance.materializedAt
            }
          }
        : {})
    })),
    counts: {
      enabledPlugins: snapshot.counts.enabledPlugins,
      mcpServers: snapshot.counts.mcpServers,
      runtimeProfiles: snapshot.counts.runtimeProfiles,
      taskwraithToolBundles: snapshot.counts.taskwraithToolBundles,
      workflowTemplates: snapshot.counts.workflowTemplates,
      connectors: snapshot.counts.connectors,
      localServices: snapshot.counts.localServices,
      providerSetup: snapshot.counts.providerSetup,
      mobileRemoteProjection: snapshot.counts.mobileRemoteProjection
    }
  }
}

function syncPlugins<T>(deps: PluginHandlerDeps, mutate: () => T): T {
  const result = mutate()
  const snapshot = deps.pluginContributionManager?.sync()
  if (snapshot) deps.onActivationChanged?.(snapshot)
  return result
}

export function registerPluginHandlers(deps: PluginHandlerDeps): void {
  ipcMain.handle('plugins:get-catalog', () => deps.pluginHost.getCatalogSnapshot())
  ipcMain.handle('plugins:get-contributions', () => deps.pluginHost.getContributionSnapshot())
  ipcMain.handle('plugins:get-activation', (event) => {
    const snapshot: TaskWraithPluginActivationSnapshot =
      deps.pluginContributionManager?.getActivationSnapshot() ?? {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        mcpServers: [],
        runtimeProfileIds: [],
        taskwraithToolBundles: [],
        workflowTemplates: [],
        connectors: [],
        localServices: [],
        providerSetup: [],
        mobileRemoteProjection: [],
        materializedResources: [],
        counts: {
          enabledPlugins: 0,
          mcpServers: 0,
          runtimeProfiles: 0,
          taskwraithToolBundles: 0,
          workflowTemplates: 0,
          connectors: 0,
          localServices: 0,
          providerSetup: 0,
          mobileRemoteProjection: 0
        }
      }
    return deps.isMainRendererSender(event) ? snapshot : rendererSafePluginActivation(snapshot)
  })
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
    syncPlugins(deps, () =>
      deps.pluginHost.installPlugin(deps.requireNonEmptyString(pluginId, 'Plugin id'))
    )
  )
  ipcMain.handle('plugins:set-enabled', (_event, pluginId: string, enabled: boolean) =>
    syncPlugins(deps, () =>
      deps.pluginHost.setPluginEnabled(
        deps.requireNonEmptyString(pluginId, 'Plugin id'),
        Boolean(enabled)
      )
    )
  )
  ipcMain.handle('plugins:update', (_event, pluginId: string) =>
    syncPlugins(deps, () =>
      deps.pluginHost.updatePlugin(deps.requireNonEmptyString(pluginId, 'Plugin id'))
    )
  )
  ipcMain.handle('plugins:uninstall', (_event, pluginId: string) => {
    const normalizedPluginId = deps.requireNonEmptyString(pluginId, 'Plugin id')
    return syncPlugins(deps, () => {
      const snapshot = deps.pluginHost.uninstallPlugin(normalizedPluginId)
      deps.pluginSecretStore?.clearPluginSecrets(normalizedPluginId)
      return snapshot
    })
  })
}
