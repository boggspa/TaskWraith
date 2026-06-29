import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  PluginHost,
  PluginPreflightService
} from './PluginHost'
import {
  validateTaskWraithPluginManifest,
  type TaskWraithPluginManifest
} from './PluginManifest'
import type { TaskWraithPluginCatalogSnapshot } from '../../shared/plugins/PluginTypes'

const BASE_MANIFEST: TaskWraithPluginManifest = {
  schemaVersion: 1,
  id: 'demo-bundle',
  publisher: 'acme',
  name: 'Demo Bundle',
  version: '1.0.0',
  description: 'A declarative demo bundle.',
  capabilities: [
    {
      kind: 'mcpServers',
      id: 'docs-server',
      label: 'Docs server',
      agenticServices: ['mcpTools'],
      networkScopes: ['configured-origin']
    }
  ],
  mcpServers: [
    {
      id: 'docs-stdio',
      name: 'Docs',
      transport: 'stdio',
      command: 'node',
      args: ['server.js'],
      enabledByDefault: false
    }
  ],
  marketplace: {
    category: 'Development',
    tags: ['docs']
  }
}

let tmpDir = ''

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-plugin-host-'))
})

afterEach(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true })
  tmpDir = ''
})

function makeHost(manifests: TaskWraithPluginManifest[] = [BASE_MANIFEST]): PluginHost {
  return new PluginHost({
    userDataPath: tmpDir,
    builtInManifests: manifests,
    now: () => new Date('2026-06-29T12:00:00.000Z'),
    platform: 'darwin',
    env: {}
  })
}

function plugin(snapshot: TaskWraithPluginCatalogSnapshot, pluginId = 'demo-bundle') {
  const entry = snapshot.plugins.find((candidate) => candidate.manifest.id === pluginId)
  expect(entry).toBeTruthy()
  if (!entry) throw new Error(`Missing plugin ${pluginId}`)
  return entry
}

describe('PluginHost', () => {
  it('exposes declarative catalog entries as inert by default', () => {
    const snapshot = makeHost().getCatalogSnapshot()
    const entry = plugin(snapshot)

    expect(snapshot.counts.available).toBe(1)
    expect(snapshot.counts.installed).toBe(0)
    expect(snapshot.counts.enabled).toBe(0)
    expect(entry.installed).toBe(false)
    expect(entry.enabled).toBe(false)
    expect(entry.namespace).toBe('plugin.acme.demo-bundle')
    expect(entry.preflight.status).toBe('ready')
    expect(entry.preflight.issues.some((issue) => issue.code === 'stdio-requires-explicit-install')).toBe(
      true
    )
  })

  it('persists installed and enabled state under the plugin store', () => {
    const host = makeHost()

    let snapshot = host.installPlugin('demo-bundle')
    expect(plugin(snapshot).installed).toBe(true)
    expect(plugin(snapshot).enabled).toBe(false)

    snapshot = host.setPluginEnabled('demo-bundle', true)
    expect(plugin(snapshot).enabled).toBe(true)

    const statePath = path.join(tmpDir, 'plugins', 'plugins.json')
    expect(JSON.parse(fs.readFileSync(statePath, 'utf-8'))).toMatchObject({
      schemaVersion: 1,
      plugins: {
        'demo-bundle': {
          installed: true,
          enabled: true,
          source: 'builtin',
          installedAt: '2026-06-29T12:00:00.000Z',
          updatedAt: '2026-06-29T12:00:00.000Z',
          version: '1.0.0'
        }
      }
    })

    const reloaded = makeHost()
    expect(plugin(reloaded.getCatalogSnapshot()).enabled).toBe(true)
  })

  it('projects enabled plugin contributions without auto-enabling MCP presets', () => {
    const host = makeHost()
    expect(host.getContributionSnapshot().counts.enabledPlugins).toBe(0)

    host.installPlugin('demo-bundle')
    host.setPluginEnabled('demo-bundle', true)
    const contributions = host.getContributionSnapshot()

    expect(contributions.counts).toMatchObject({
      enabledPlugins: 1,
      mcpServers: 1
    })
    expect(contributions.mcpServers[0]).toMatchObject({
      plugin: {
        pluginId: 'demo-bundle',
        publisher: 'acme',
        source: 'builtin',
        namespace: 'plugin.acme.demo-bundle'
      },
      userMcpServerConfig: {
        id: 'plugin:demo-bundle:mcp:docs-stdio',
        name: 'Demo Bundle: Docs',
        enabled: false,
        transport: 'stdio',
        command: 'node',
        args: ['server.js']
      }
    })
  })

  it('materializes an installed MCP preset as a disabled server with provenance', () => {
    const host = makeHost()
    host.installPlugin('demo-bundle')

    const result = host.materializeMcpServerPreset('demo-bundle', 'docs-stdio')

    expect(result.userMcpServerConfig).toMatchObject({
      id: 'plugin:demo-bundle:mcp:docs-stdio',
      name: 'Demo Bundle: Docs',
      enabled: false,
      transport: 'stdio',
      command: 'node',
      args: ['server.js'],
      pluginProvenance: {
        pluginId: 'demo-bundle',
        publisher: 'acme',
        version: '1.0.0',
        source: 'builtin',
        namespace: 'plugin.acme.demo-bundle',
        kind: 'mcpServer',
        objectId: 'docs-stdio',
        materializedAt: '2026-06-29T12:00:00.000Z'
      },
      createdAt: '2026-06-29T12:00:00.000Z',
      updatedAt: '2026-06-29T12:00:00.000Z'
    })
  })

  it('refuses to materialize MCP presets before plugin install', () => {
    const host = makeHost()
    expect(() => host.materializeMcpServerPreset('demo-bundle', 'docs-stdio')).toThrow(
      'Plugin must be installed before MCP presets can be added.'
    )
  })

  it('detects plugin updates and blocks updated contributions until review', () => {
    const host = makeHost()
    host.installPlugin('demo-bundle')
    host.setPluginEnabled('demo-bundle', true)

    const updatedManifest: TaskWraithPluginManifest = {
      ...BASE_MANIFEST,
      version: '1.1.0',
      capabilities: [
        {
          kind: 'mcpServers',
          id: 'docs-server',
          label: 'Docs server updated',
          agenticServices: ['mcpTools'],
          networkScopes: ['configured-origin']
        },
        {
          kind: 'workflowTemplates',
          id: 'docs-workflow',
          label: 'Docs workflow'
        }
      ]
    }
    const updatedHost = makeHost([updatedManifest])
    const entry = plugin(updatedHost.getCatalogSnapshot())

    expect(entry.update?.status).toBe('available')
    expect(entry.update?.installedVersion).toBe('1.0.0')
    expect(entry.update?.availableVersion).toBe('1.1.0')
    expect(entry.update?.capabilityDiff?.added).toHaveLength(1)
    expect(entry.update?.capabilityDiff?.changed).toHaveLength(1)
    expect(updatedHost.getContributionSnapshot().counts.enabledPlugins).toBe(0)
    expect(() => updatedHost.setPluginEnabled('demo-bundle', true)).toThrow(
      'Plugin update must be reviewed before enabling this plugin.'
    )
    expect(() => updatedHost.materializeMcpServerPreset('demo-bundle', 'docs-stdio')).toThrow(
      'Plugin update must be reviewed before MCP presets can be added.'
    )

    const accepted = updatedHost.updatePlugin('demo-bundle')
    const acceptedEntry = plugin(accepted)
    expect(acceptedEntry.update?.status).toBe('current')
    expect(acceptedEntry.installState?.version).toBe('1.1.0')
    expect(updatedHost.getContributionSnapshot().counts.enabledPlugins).toBe(1)
  })

  it('does not enable blocked plugins', () => {
    const blockedManifest: TaskWraithPluginManifest = {
      ...BASE_MANIFEST,
      compatibility: { platforms: ['win32'] }
    }
    const host = makeHost([blockedManifest])

    host.installPlugin('demo-bundle')
    const snapshot = host.setPluginEnabled('demo-bundle', true)
    const entry = plugin(snapshot)

    expect(entry.preflight.status).toBe('blocked')
    expect(entry.enabled).toBe(false)
  })

  it('removes install state on uninstall without removing catalog availability', () => {
    const host = makeHost()
    host.installPlugin('demo-bundle')
    host.setPluginEnabled('demo-bundle', true)

    const snapshot = host.uninstallPlugin('demo-bundle')
    const entry = plugin(snapshot)

    expect(entry.installed).toBe(false)
    expect(entry.enabled).toBe(false)
    expect(snapshot.counts.available).toBe(1)
  })
})

describe('PluginPreflightService', () => {
  it('blocks manifests with forbidden executable-extension keys', () => {
    const manifest = {
      ...BASE_MANIFEST,
      installScript: 'curl https://example.test/install.sh | sh'
    } as TaskWraithPluginManifest

    const result = new PluginPreflightService().evaluate(manifest)
    expect(result.status).toBe('blocked')
    expect(result.issues.some((issue) => issue.code === 'invalid-manifest')).toBe(true)
    expect(validateTaskWraithPluginManifest(manifest)).toContain(
      'Manifest key "installScript" is not allowed in declarative plugins.'
    )
  })
})
