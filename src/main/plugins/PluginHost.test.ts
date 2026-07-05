import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { generateKeyPairSync, sign as signData, type KeyObject } from 'crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  PluginHost,
  PluginPreflightService,
  type PluginHostOptions
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

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJsonValue)
  if (!value || typeof value !== 'object') return value
  const output: Record<string, unknown> = {}
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const child = (value as Record<string, unknown>)[key]
    if (typeof child !== 'undefined') output[key] = stableJsonValue(child)
  }
  return output
}

function signedManifest(
  manifest: TaskWraithPluginManifest,
  privateKey: KeyObject,
  keyId = 'dev-key'
): TaskWraithPluginManifest {
  const { signatures: _signatures, ...unsignedManifest } = manifest
  const payload = JSON.stringify(stableJsonValue(unsignedManifest))
  return {
    ...manifest,
    signatures: [
      {
        algorithm: 'ed25519',
        keyId,
        signatureBase64: signData(null, Buffer.from(payload, 'utf-8'), privateKey).toString('base64'),
        signedAt: '2026-06-29T12:00:00.000Z'
      }
    ]
  }
}

function writeLocalManifest(manifest: TaskWraithPluginManifest): void {
  const pluginsDir = path.join(tmpDir, 'plugins')
  fs.mkdirSync(pluginsDir, { recursive: true })
  fs.writeFileSync(path.join(pluginsDir, `${manifest.id}.json`), JSON.stringify(manifest, null, 2))
}

function makeHost(
  manifests: TaskWraithPluginManifest[] = [BASE_MANIFEST],
  overrides: Partial<PluginHostOptions> = {}
): PluginHost {
  return new PluginHost({
    userDataPath: tmpDir,
    builtInManifests: manifests,
    now: () => new Date('2026-06-29T12:00:00.000Z'),
    platform: 'darwin',
    env: {},
    ...overrides
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
    expect(entry.trust).toMatchObject({
      status: 'trusted',
      source: 'builtin'
    })
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
    const stateFile = JSON.parse(fs.readFileSync(statePath, 'utf-8'))
    expect(stateFile).toMatchObject({
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
    expect(stateFile.lifecycleEvents.map((event: { action: string }) => event.action)).toEqual([
      'install',
      'enable'
    ])
    expect(stateFile.lifecycleEvents[1]).toMatchObject({
      pluginId: 'demo-bundle',
      action: 'enable',
      source: 'builtin',
      version: '1.0.0',
      result: 'applied',
      enabled: true
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
    expect(JSON.parse(fs.readFileSync(path.join(tmpDir, 'plugins', 'plugins.json'), 'utf-8'))).toMatchObject({
      lifecycleEvents: [
        {
          pluginId: 'demo-bundle',
          action: 'install'
        },
        {
          pluginId: 'demo-bundle',
          action: 'materialize-mcp-preset',
          source: 'builtin',
          version: '1.0.0',
          objectKind: 'mcpServer',
          objectId: 'docs-stdio',
          result: 'prepared'
        }
      ]
    })
  })

  it('materializes plugin requiredSecrets as encrypted user-MCP launch refs', () => {
    const manifest: TaskWraithPluginManifest = {
      ...BASE_MANIFEST,
      secrets: [
        {
          id: 'docs-token',
          label: 'Docs token',
          envVar: 'DOCS_TOKEN',
          required: true
        }
      ],
      mcpServers: [
        {
          id: 'docs-stdio',
          name: 'Docs',
          transport: 'stdio',
          command: 'node',
          args: ['server.js'],
          env: {
            DOCS_AUTH_TOKEN: '${DOCS_TOKEN}',
            DOCS_REGION: 'eu'
          },
          headers: {
            'X-Docs-Token': '$DOCS_TOKEN',
            'X-Docs-Region': 'eu'
          },
          requiredSecrets: ['docs-token'],
          enabledByDefault: false
        }
      ]
    }
    const host = makeHost([manifest])
    host.installPlugin('demo-bundle')

    const result = host.materializeMcpServerPreset('demo-bundle', 'docs-stdio')

    expect(result.userMcpServerConfig).toMatchObject({
      env: {
        DOCS_REGION: 'eu'
      },
      headers: {
        'X-Docs-Region': 'eu'
      },
      secretRefs: {
        env: ['DOCS_AUTH_TOKEN'],
        headers: ['X-Docs-Token']
      }
    })
    expect(result.userMcpServerConfig.env).not.toHaveProperty('DOCS_AUTH_TOKEN')
    expect(result.userMcpServerConfig.headers).not.toHaveProperty('X-Docs-Token')
  })

  it('validates materialized MCP provenance against the current installed plugin', () => {
    const host = makeHost()
    host.installPlugin('demo-bundle')
    host.setPluginEnabled('demo-bundle', true)
    const result = host.materializeMcpServerPreset('demo-bundle', 'docs-stdio')
    const provenance = result.userMcpServerConfig.pluginProvenance

    expect(host.validateMcpServerProvenance(provenance)).toEqual({ ok: true })
    expect(
      host.validateMcpServerProvenance(
        provenance ? { ...provenance, manifestHash: 'sha256:stale' } : undefined
      )
    ).toEqual({
      ok: false,
      reason: 'plugin provenance does not match the installed manifest'
    })

    host.setPluginEnabled('demo-bundle', false)
    expect(host.validateMcpServerProvenance(provenance)).toEqual({
      ok: false,
      reason: 'plugin is not enabled'
    })
  })

  it('refuses to materialize MCP presets before plugin install', () => {
    const host = makeHost()
    expect(() => host.materializeMcpServerPreset('demo-bundle', 'docs-stdio')).toThrow(
      'Plugin must be installed before MCP presets can be added.'
    )
  })

  it('keeps unsigned local manifests visible but inert until source trust is verified', () => {
    writeLocalManifest(BASE_MANIFEST)
    const host = makeHost([])
    const entry = plugin(host.getCatalogSnapshot())

    expect(entry.source).toBe('local')
    expect(entry.trust).toMatchObject({
      status: 'unsigned',
      source: 'local',
      reason: 'local plugin manifest is unsigned.'
    })
    expect(entry.preflight.status).toBe('repairable')
    expect(entry.preflight.issues.some((issue) => issue.code === 'source-trust-unsigned')).toBe(
      true
    )

    host.installPlugin('demo-bundle')
    const enabled = plugin(host.setPluginEnabled('demo-bundle', true))

    expect(enabled.enabled).toBe(false)
    expect(host.getContributionSnapshot().counts.enabledPlugins).toBe(0)
    expect(() => host.materializeMcpServerPreset('demo-bundle', 'docs-stdio')).toThrow(
      'Plugin source trust must be verified before MCP presets can be added.'
    )
    const stateFile = JSON.parse(fs.readFileSync(path.join(tmpDir, 'plugins', 'plugins.json'), 'utf-8'))
    expect(stateFile.lifecycleEvents.at(-1)).toMatchObject({
      pluginId: 'demo-bundle',
      action: 'enable',
      result: 'blocked',
      message: 'local plugin manifest is unsigned.'
    })
  })

  it('trusts signed local manifests when the publisher key verifies', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    writeLocalManifest(signedManifest(BASE_MANIFEST, privateKey))
    const host = makeHost([], {
      trustedPublisherKeys: {
        acme: [
          {
            keyId: 'dev-key',
            publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString()
          }
        ]
      }
    })
    const entry = plugin(host.getCatalogSnapshot())

    expect(entry.source).toBe('local')
    expect(entry.trust).toMatchObject({
      status: 'trusted',
      source: 'local',
      keyId: 'dev-key',
      algorithm: 'ed25519'
    })
    expect(entry.preflight.status).toBe('ready')

    host.installPlugin('demo-bundle')
    const enabled = plugin(host.setPluginEnabled('demo-bundle', true))
    expect(enabled.enabled).toBe(true)
    expect(host.getContributionSnapshot().counts.enabledPlugins).toBe(1)
    expect(host.materializeMcpServerPreset('demo-bundle', 'docs-stdio').plugin).toMatchObject({
      pluginId: 'demo-bundle',
      source: 'local'
    })
  })

  it('blocks tampered signed manifests when a trusted publisher key is registered', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    writeLocalManifest({
      ...signedManifest(BASE_MANIFEST, privateKey),
      description: 'Tampered after signing.'
    })
    const host = makeHost([], {
      trustedPublisherKeys: {
        acme: [
          {
            keyId: 'dev-key',
            publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString()
          }
        ]
      }
    })
    const entry = plugin(host.getCatalogSnapshot())

    expect(entry.trust).toMatchObject({
      status: 'invalid',
      source: 'local',
      keyId: 'dev-key'
    })
    expect(entry.preflight.status).toBe('blocked')
    expect(entry.preflight.issues.some((issue) => issue.code === 'source-trust-invalid')).toBe(
      true
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
    const stateFile = JSON.parse(fs.readFileSync(path.join(tmpDir, 'plugins', 'plugins.json'), 'utf-8'))
    const updateEvent = stateFile.lifecycleEvents.find(
      (event: { action: string }) => event.action === 'update'
    )
    expect(updateEvent).toMatchObject({
      pluginId: 'demo-bundle',
      action: 'update',
      source: 'builtin',
      version: '1.1.0',
      result: 'applied',
      capabilityDiff: {
        added: [{ id: 'docs-workflow', kind: 'workflowTemplates' }],
        changed: [
          {
            before: { id: 'docs-server', label: 'Docs server' },
            after: { id: 'docs-server', label: 'Docs server updated' }
          }
        ]
      }
    })
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
    const stateFile = JSON.parse(fs.readFileSync(path.join(tmpDir, 'plugins', 'plugins.json'), 'utf-8'))
    const tombstone = entry.tombstone
    expect(tombstone).toBeTruthy()
    if (!tombstone) throw new Error('Expected uninstall tombstone')

    expect(entry.installed).toBe(false)
    expect(entry.enabled).toBe(false)
    expect(tombstone).toMatchObject({
      pluginId: 'demo-bundle',
      publisher: 'acme',
      name: 'Demo Bundle',
      version: '1.0.0',
      source: 'builtin',
      namespace: 'plugin.acme.demo-bundle',
      installedAt: '2026-06-29T12:00:00.000Z',
      updatedAt: '2026-06-29T12:00:00.000Z',
      uninstalledAt: '2026-06-29T12:00:00.000Z',
      enabledAtUninstall: true
    })
    expect(stateFile.plugins).toEqual({})
    expect(stateFile.tombstones['demo-bundle']).toMatchObject(tombstone)
    expect(stateFile.lifecycleEvents.map((event: { action: string }) => event.action)).toEqual([
      'install',
      'enable',
      'uninstall'
    ])
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
      'Manifest key "manifest.installScript" is not allowed in declarative plugins.'
    )
  })

  it('reports strict manifest validation diagnostics for local JSON manifests', () => {
    const oversized = 'x'.repeat(4097)
    const manifest = {
      ...BASE_MANIFEST,
      description: oversized,
      compatibility: {
        providers: ['unknown-provider']
      },
      capabilities: [
        ...Array.from({ length: 65 }, (_, index) => ({
          kind: 'mcpServers',
          id: `cap-${index}`,
          label: `Capability ${index}`
        })),
        {
          kind: 'unknown-kind',
          id: 'bad-kind',
          label: 'Bad kind',
          agenticServices: ['unknown-service'],
          networkScopes: ['moon']
        }
      ],
      mcpServers: [
        {
          id: 'dup',
          name: 'Dup',
          transport: 'http',
          url: 'ftp://example.test/mcp',
          env: { 'bad-key': 'value' },
          headers: { 'bad header': 'value' }
        },
        {
          id: 'dup',
          name: 'Dup 2',
          transport: 'http',
          url: 'https://example.test/mcp'
        }
      ],
      taskwraithToolBundles: [
        {
          id: 'tools',
          label: 'Tools',
          tools: ['not_a_real_tool']
        }
      ],
      runtimeProfiles: [
        {
          id: 'runtime',
          name: 'Runtime',
          provider: 'unknown-provider',
          scope: 'workspace',
          workspaceMode: 'spaceship'
        }
      ],
      connectors: [
        {
          id: 'connector',
          label: 'Connector',
          kind: 'raw-code',
          scripts: ['install.sh']
        }
      ],
      localServices: [
        {
          id: 'service',
          label: 'Service',
          ports: [0, 70000],
          healthCheck: { url: 'not a url' },
          launchTargetHints: ['', 123]
        }
      ],
      providerSetup: [{ provider: 'unknown-provider' }],
      marketplace: {
        category: 'Bad',
        tags: [],
        homepageUrl: 'file:///tmp/plugin.html'
      },
      signatures: [
        {
          algorithm: 'rsa',
          keyId: 'bad key',
          signatureBase64: 'not base64!'
        },
        {
          algorithm: 'ed25519',
          keyId: 'bad key',
          signatureBase64: ''
        }
      ]
    } as unknown as TaskWraithPluginManifest

    const errors = validateTaskWraithPluginManifest(manifest)

    expect(errors).toContain('Plugin description exceeds 4096 characters.')
    expect(errors).toContain('Compatibility providers contains unsupported value "unknown-provider".')
    expect(errors).toContain('Capabilities exceeds 64 entries.')
    expect(errors).toContain('Capability "bad-kind" has unsupported kind "unknown-kind".')
    expect(errors).toContain(
      'Capability "bad-kind" agentic services contains unsupported value "unknown-service".'
    )
    expect(errors).toContain(
      'Capability "bad-kind" network scopes contains unsupported value "moon".'
    )
    expect(errors).toContain('MCP server preset "dup" is duplicated.')
    expect(errors).toContain('MCP server preset "dup" URL must be an http(s) URL.')
    expect(errors).toContain('MCP server preset "dup" env contains invalid key "bad-key".')
    expect(errors).toContain('MCP server preset "dup" headers contains invalid key "bad header".')
    expect(errors).toContain(
      'TaskWraith tool bundle "tools" tools contains unsupported value "not_a_real_tool".'
    )
    expect(errors).toContain('Runtime profile "runtime" has unsupported provider "unknown-provider".')
    expect(errors).toContain('Runtime profile "runtime" has unsupported workspace mode "spaceship".')
    expect(errors).toContain('Connector "connector" has unsupported kind "raw-code".')
    expect(errors).toContain('Manifest key "manifest.connectors[0].scripts" is not allowed in declarative plugins.')
    expect(errors).toContain('Local service "service" has invalid port "0".')
    expect(errors).toContain('Local service "service" has invalid port "70000".')
    expect(errors).toContain('Local service "service" health check URL must be a valid URL.')
    expect(errors).toContain(
      'Local service "service" launch target hints contains invalid string "".'
    )
    expect(errors).toContain(
      'Local service "service" launch target hints contains invalid string "123".'
    )
    expect(errors).toContain('Provider setup has unsupported provider "unknown-provider".')
    expect(errors).toContain('Marketplace homepage URL must be an http(s) URL.')
    expect(errors).toContain('Manifest signature has unsupported algorithm "rsa".')
    expect(errors).toContain('Manifest signature key id "bad key" is invalid.')
    expect(errors).toContain('Manifest signature key id "bad key" is duplicated.')
    expect(errors).toContain('Manifest signature "bad key" must include base64 signature material.')
  })

  it('rejects plugin requiredSecrets that are not declared in the manifest', () => {
    const manifest: TaskWraithPluginManifest = {
      ...BASE_MANIFEST,
      secrets: [
        {
          id: 'docs-token',
          label: 'Docs token',
          envVar: 'DOCS_TOKEN'
        }
      ],
      mcpServers: [
        {
          id: 'docs-stdio',
          name: 'Docs',
          transport: 'stdio',
          command: 'node',
          args: ['server.js'],
          requiredSecrets: ['missing-token']
        }
      ],
      connectors: [
        {
          id: 'docs-api',
          label: 'Docs API',
          kind: 'api-key',
          requiredSecrets: ['also-missing']
        }
      ]
    }

    expect(validateTaskWraithPluginManifest(manifest)).toEqual(
      expect.arrayContaining([
        'MCP server preset "docs-stdio" required secrets references unknown secret "missing-token".',
        'Connector "docs-api" required secrets references unknown secret "also-missing".'
      ])
    )
  })
})
