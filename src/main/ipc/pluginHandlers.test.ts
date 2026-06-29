import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'
import { registerPluginHandlers } from './pluginHandlers'
import type {
  TaskWraithPluginCatalogSnapshot,
  TaskWraithPluginContributionSnapshot
} from '../../shared/plugins/PluginTypes'

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn()
  }
}))

const mockedHandle = vi.mocked(ipcMain.handle)

beforeEach(() => {
  mockedHandle.mockReset()
})

type RegisteredHandler = (event: unknown, ...args: unknown[]) => unknown

function handlerFor(channel: string): RegisteredHandler {
  const handler = mockedHandle.mock.calls.find(([registered]) => registered === channel)?.[1] as
    | RegisteredHandler
    | undefined
  expect(handler).toBeTypeOf('function')
  if (!handler) throw new Error(`Handler not registered: ${channel}`)
  return handler
}

function snapshot(overrides: Partial<TaskWraithPluginCatalogSnapshot> = {}): TaskWraithPluginCatalogSnapshot {
  return {
    schemaVersion: 1,
    generatedAt: '2026-06-29T12:00:00.000Z',
    plugins: [],
    counts: {
      available: 0,
      installed: 0,
      enabled: 0,
      blocked: 0,
      repairable: 0,
      byCapability: {}
    },
    ...overrides
  }
}

function contributions(): TaskWraithPluginContributionSnapshot {
  return {
    schemaVersion: 1,
    generatedAt: '2026-06-29T12:00:00.000Z',
    mcpServers: [],
    taskwraithToolBundles: [],
    workflowTemplates: [],
    runtimeProfiles: [],
    connectors: [],
    localServices: [],
    providerSetup: [],
    mobileRemoteProjection: [],
    counts: {
      enabledPlugins: 0,
      mcpServers: 0,
      taskwraithToolBundles: 0,
      workflowTemplates: 0,
      runtimeProfiles: 0,
      connectors: 0,
      localServices: 0,
      providerSetup: 0,
      mobileRemoteProjection: 0
    }
  }
}

describe('registerPluginHandlers', () => {
  it('registers read and lifecycle handlers against the plugin host', () => {
    const catalog = snapshot()
    const contributionSnapshot = contributions()
    const installed = snapshot({ counts: { ...catalog.counts, installed: 1 } })
    const enabled = snapshot({ counts: { ...catalog.counts, enabled: 1, installed: 1 } })
    const uninstalled = snapshot({ counts: { ...catalog.counts, installed: 0 } })
    const deps = {
      pluginHost: {
        getCatalogSnapshot: vi.fn(() => catalog),
        getContributionSnapshot: vi.fn(() => contributionSnapshot),
        materializeMcpServerPreset: vi.fn(() => ({
          plugin: {
            pluginId: 'demo-bundle',
            publisher: 'acme',
            version: '1.0.0',
            source: 'builtin' as const,
            namespace: 'plugin.acme.demo-bundle',
            manifestHash: 'abc'
          },
          preset: {
            id: 'docs',
            name: 'Docs',
            transport: 'stdio' as const
          },
          userMcpServerConfig: {
            id: 'plugin:demo-bundle:mcp:docs',
            name: 'Demo: Docs',
            enabled: false,
            transport: 'stdio' as const
          }
        })),
        installPlugin: vi.fn(() => installed),
        setPluginEnabled: vi.fn(() => enabled),
        uninstallPlugin: vi.fn(() => uninstalled)
      },
      requireNonEmptyString: vi.fn((value: unknown) => String(value))
    }

    registerPluginHandlers(deps)

    expect(handlerFor('plugins:get-catalog')({})).toBe(catalog)
    expect(handlerFor('plugins:get-contributions')({})).toBe(contributionSnapshot)
    expect(handlerFor('plugins:materialize-mcp-preset')({}, 'demo-bundle', 'docs')).toEqual({
      plugin: {
        pluginId: 'demo-bundle',
        publisher: 'acme',
        version: '1.0.0',
        source: 'builtin',
        namespace: 'plugin.acme.demo-bundle',
        manifestHash: 'abc'
      },
      preset: {
        id: 'docs',
        name: 'Docs',
        transport: 'stdio'
      },
      userMcpServerConfig: {
        id: 'plugin:demo-bundle:mcp:docs',
        name: 'Demo: Docs',
        enabled: false,
        transport: 'stdio'
      }
    })
    expect(deps.pluginHost.materializeMcpServerPreset).toHaveBeenCalledWith(
      'demo-bundle',
      'docs'
    )
    expect(handlerFor('plugins:install')({}, 'demo-bundle')).toBe(installed)
    expect(deps.requireNonEmptyString).toHaveBeenCalledWith('demo-bundle', 'Plugin id')
    expect(deps.pluginHost.installPlugin).toHaveBeenCalledWith('demo-bundle')

    expect(handlerFor('plugins:set-enabled')({}, 'demo-bundle', 1)).toBe(enabled)
    expect(deps.pluginHost.setPluginEnabled).toHaveBeenCalledWith('demo-bundle', true)

    expect(handlerFor('plugins:uninstall')({}, 'demo-bundle')).toBe(uninstalled)
    expect(deps.pluginHost.uninstallPlugin).toHaveBeenCalledWith('demo-bundle')
  })
})
