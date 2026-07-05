import type {
  TaskWraithPluginActivatedConnector,
  TaskWraithPluginActivationSnapshot,
  TaskWraithPluginResourceProvenance,
  TaskWraithPluginSecretStatusSnapshot
} from './PluginManifest'
import type { TaskWraithPluginNetworkScope } from '../../shared/plugins/PluginTypes'

export interface PluginConnectorClientSecret {
  secretId: string
  label?: string
  configured: boolean
  required: boolean
  envVar?: string
}

export interface PluginConnectorCapabilityScope {
  pluginId: string
  connectorId: string
  kind: TaskWraithPluginActivatedConnector['connector']['kind']
  networkScopes: TaskWraithPluginNetworkScope[]
}

export interface PluginConnectorClient {
  id: string
  pluginId: string
  connectorId: string
  label: string
  kind: TaskWraithPluginActivatedConnector['connector']['kind']
  description?: string
  networkScopes: TaskWraithPluginNetworkScope[]
  pluginProvenance: TaskWraithPluginResourceProvenance
  secrets: PluginConnectorClientSecret[]
  ready: boolean
  unavailableReasons: string[]
  capabilityScope: PluginConnectorCapabilityScope
  getSecretValue: (secretId: string) => string | null
}

export interface BuildPluginConnectorClientsInput {
  activation: Pick<TaskWraithPluginActivationSnapshot, 'connectors'>
  secretStatus?: TaskWraithPluginSecretStatusSnapshot | null
  loadSecretValue?: (pluginId: string, secretId: string) => string | null
}

function configuredSecretIdsForPlugin(
  secretStatus: TaskWraithPluginSecretStatusSnapshot | null | undefined,
  pluginId: string
): Map<string, PluginConnectorClientSecret> {
  const configured = new Map<string, PluginConnectorClientSecret>()
  for (const secret of secretStatus?.secrets ?? []) {
    if (secret.pluginId !== pluginId) continue
    configured.set(secret.secretId, {
      secretId: secret.secretId,
      label: secret.label,
      configured: secret.configured,
      required: secret.required,
      ...(secret.envVar ? { envVar: secret.envVar } : {})
    })
  }
  return configured
}

export function buildPluginConnectorClients({
  activation,
  secretStatus,
  loadSecretValue
}: BuildPluginConnectorClientsInput): PluginConnectorClient[] {
  return activation.connectors.map((entry) => {
    const pluginId = entry.plugin.pluginId
    const connectorId = entry.connector.id
    const knownSecrets = configuredSecretIdsForPlugin(secretStatus, pluginId)
    const requiredSecrets = entry.connector.requiredSecrets ?? []
    const secrets = requiredSecrets.map((secretId) => {
      const known = knownSecrets.get(secretId)
      return (
        known ?? {
          secretId,
          configured: false,
          required: true
        }
      )
    })
    const missingSecrets = secrets
      .filter((secret) => !secret.configured)
      .map((secret) => secret.label || secret.secretId)
    const unavailableReasons = [
      ...missingSecrets.map((secret) => `Missing required secret: ${secret}`)
    ]
    const networkScopes = entry.connector.networkScopes ?? []
    return {
      id: entry.id,
      pluginId,
      connectorId,
      label: entry.connector.label,
      kind: entry.connector.kind,
      ...(entry.connector.description ? { description: entry.connector.description } : {}),
      networkScopes,
      pluginProvenance: entry.pluginProvenance,
      secrets,
      ready: unavailableReasons.length === 0,
      unavailableReasons,
      capabilityScope: {
        pluginId,
        connectorId,
        kind: entry.connector.kind,
        networkScopes
      },
      getSecretValue: (secretId: string) => {
        if (!requiredSecrets.includes(secretId)) return null
        return loadSecretValue?.(pluginId, secretId) ?? null
      }
    }
  })
}
