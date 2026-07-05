import { describe, expect, it } from 'vitest'
import { buildPluginConnectorClients } from './PluginConnectorClients'
import type {
  TaskWraithPluginActivatedConnector,
  TaskWraithPluginSecretStatusSnapshot
} from './PluginManifest'

const connector: TaskWraithPluginActivatedConnector = {
  id: 'plugin:design-bundle:connector:design-api',
  plugin: {
    pluginId: 'design-bundle',
    publisher: 'acme',
    version: '1.0.0',
    source: 'builtin',
    namespace: 'plugin.acme.design-bundle',
    manifestHash: 'sha256:abc'
  },
  connector: {
    id: 'design-api',
    label: 'Design API',
    kind: 'api-key',
    requiredSecrets: ['design-token'],
    networkScopes: ['configured-origin']
  },
  pluginProvenance: {
    pluginId: 'design-bundle',
    publisher: 'acme',
    version: '1.0.0',
    source: 'builtin',
    namespace: 'plugin.acme.design-bundle',
    manifestHash: 'sha256:abc',
    kind: 'connector',
    objectId: 'design-api',
    materializedAt: '2026-06-29T12:00:00.000Z'
  }
}

function secretStatus(configured: boolean): TaskWraithPluginSecretStatusSnapshot {
  return {
    schemaVersion: 1,
    generatedAt: '2026-06-29T12:00:00.000Z',
    encryptionAvailable: true,
    secrets: [
      {
        pluginId: 'design-bundle',
        secretId: 'design-token',
        label: 'Design token',
        required: true,
        configured,
        installed: true,
        enabled: true,
        envVar: 'DESIGN_TOKEN'
      }
    ]
  }
}

describe('PluginConnectorClients', () => {
  it('marks active connectors unavailable until their required secrets are configured', () => {
    const [client] = buildPluginConnectorClients({
      activation: { connectors: [connector] },
      secretStatus: secretStatus(false)
    })

    expect(client).toMatchObject({
      id: 'plugin:design-bundle:connector:design-api',
      pluginId: 'design-bundle',
      connectorId: 'design-api',
      label: 'Design API',
      kind: 'api-key',
      networkScopes: ['configured-origin'],
      ready: false,
      unavailableReasons: ['Missing required secret: Design token'],
      capabilityScope: {
        pluginId: 'design-bundle',
        connectorId: 'design-api',
        kind: 'api-key',
        networkScopes: ['configured-origin']
      }
    })
    expect(client?.secrets).toEqual([
      {
        secretId: 'design-token',
        label: 'Design token',
        configured: false,
        required: true,
        envVar: 'DESIGN_TOKEN'
      }
    ])
  })

  it('resolves only declared connector secrets for ready clients', () => {
    const [client] = buildPluginConnectorClients({
      activation: { connectors: [connector] },
      secretStatus: secretStatus(true),
      loadSecretValue: (pluginId, secretId) =>
        `${pluginId}:${secretId}` === 'design-bundle:design-token' ? 'secret-value' : null
    })

    expect(client?.ready).toBe(true)
    expect(client?.unavailableReasons).toEqual([])
    expect(client?.getSecretValue('design-token')).toBe('secret-value')
    expect(client?.getSecretValue('other-token')).toBeNull()
  })
})
