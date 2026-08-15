import { createHash, generateKeyPairSync, sign as signPayload } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  loadManagedPolicyFromEnvironment,
  ManagedPolicyService,
  parseManagedPolicyDocument
} from './ManagedPolicyService'
import type { AppSettings } from './store/types'

function stableJson(value: unknown): string {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? 'null' : stableJson(item))).join(',')}]`
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
  return `{${entries
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableJson(entryValue)}`)
    .join(',')}}`
}

function signedPolicyEnvelope(payload: unknown): {
  envelope: unknown
  publicKeyDerBase64: string
} {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const serializedPayload = stableJson(payload)
  return {
    publicKeyDerBase64: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    envelope: {
      schemaVersion: 1,
      payload,
      signature: {
        algorithm: 'ed25519',
        keyId: 'managed-test-key',
        payloadHash: createHash('sha256').update(serializedPayload, 'utf8').digest('hex'),
        signatureBase64: signPayload(null, Buffer.from(serializedPayload, 'utf8'), privateKey).toString(
          'base64'
        )
      }
    }
  }
}

function settings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    activeProvider: 'codex',
    storeLocalChatHistory: true,
    storeRawEvents: false,
    storePromptResponseInUsage: true,
    ensembleModeEnabled: true,
    geminiCheckpointingEnabled: false,
    chatContextTurns: 6,
    appearanceMode: 'soft_glass',
    visualEffectStyle: 'sidebar',
    themeAppearance: 'dark',
    themeCornerStyle: 'rounded',
    themeAccentStyle: 'system',
    toolIconAccent: 'system',
    userBubbleColor: 'system',
    appIconVariant: 'regular',
    promptSurfaceStyle: 'default',
    composerStyle: 'default',
    funFxEnabled: true,
    funFxMode: 'cinematic',
    advancedFx: {
      agentAura: true,
      livingWorkspace: true,
      dataViz: true,
      refraction: true,
      intensity: 'cinematic'
    },
    reduceTransparency: false,
    reduceMotion: false,
    compactDensity: false,
    liveActivityViewport: true,
    showInspector: true,
    inspectorWidth: 420,
    sidebarWidth: 280,
    agenticServices: {
      shellCommands: 'allow',
      fileChanges: 'workspace',
      externalPublish: 'allow',
      mcpTools: 'ask',
      subThreadDelegation: 'ask',
      canvasInteraction: 'ask',
      canvasEval: 'ask',
      crossThreadRead: 'ask',
      mediaEditing: 'ask',
      mediaRecording: 'deny',
      networkAccess: 'allow'
    },
    agenticWorkspaceGrants: [
      {
        id: 'grant-1',
        workspacePath: '/repo',
        provider: 'codex',
        service: 'shellCommands',
        createdAt: '2026-07-03T00:00:00.000Z',
        updatedAt: '2026-07-03T00:00:00.000Z'
      }
    ],
    geminiMcpBridgeEnabled: true,
    codexSandboxFallback: 'ask_rerun',
    autoUpdateEnabled: false,
    updateChannel: 'debug',
    approvalTimeouts: {
      enabled: true,
      perProviderMs: {
        gemini: 120_000,
        codex: 30_000,
        claude: 120_000,
        kimi: 60_000,
        grok: 120_000,
        cursor: 120_000,
        ollama: 120_000
      },
      mainAuthorityMs: 120_000
    },
    userMcpServers: [
      {
        id: 'unsafe',
        name: 'Unsafe',
        enabled: true,
        transport: 'stdio',
        command: '/tmp/unsafe',
        args: []
      }
    ],
    currency: 'USD',
    ...overrides
  } as AppSettings
}

describe('ManagedPolicyService', () => {
  it('loads env JSON and computes locked/enforced settings', () => {
    const service = loadManagedPolicyFromEnvironment({
      env: {
        TASKWRAITH_MANAGED_POLICY_JSON: JSON.stringify({
          schemaVersion: 1,
          organizationName: 'Acme Corp',
          lockedSettings: ['approvalTimeouts'],
          settings: {
            autoUpdateEnabled: true,
            updateChannel: 'stable',
            geminiMcpBridgeEnabled: false,
            codexSandboxFallback: 'off',
            agenticServices: {
              shellCommands: 'ask',
              fileChanges: 'ask',
              externalPublish: 'deny',
              networkAccess: 'deny'
            },
            approvalTimeouts: {
              enabled: true,
              perProviderMs: {
                codex: 45_000,
                grok: 75_000,
                cursor: 80_000,
                ollama: 85_000,
                antigravity: 95_000,
                muse: 105_000
              },
              mainAuthorityMs: 90_000
            },
            auditRetention: {
              enabled: true,
              maxAgeDays: { approvalLedger: 180, messageFeedback: 90 }
            },
            userMcpServers: [{ ignored: true }],
            agenticWorkspaceGrants: [{ ignored: true }]
          }
        })
      }
    })

    expect(service.snapshot()).toMatchObject({
      active: true,
      source: 'env-json',
      organizationName: 'Acme Corp',
      lockedSettings: expect.arrayContaining([
        'approvalTimeouts',
        'autoUpdateEnabled',
        'updateChannel',
        'geminiMcpBridgeEnabled',
        'codexSandboxFallback',
        'agenticServices',
        'auditRetention',
        'userMcpServers',
        'agenticWorkspaceGrants'
      ]),
      errors: []
    })
    const patch = service.enforcedSettingsPatch(settings())
    expect(patch).toMatchObject({
      autoUpdateEnabled: true,
      updateChannel: 'stable',
      geminiMcpBridgeEnabled: false,
      codexSandboxFallback: 'off',
      userMcpServers: [],
      agenticWorkspaceGrants: []
    })
    expect(patch.agenticServices).toMatchObject({
      shellCommands: 'ask',
      fileChanges: 'ask',
      externalPublish: 'deny',
      networkAccess: 'deny'
    })
    expect(patch.approvalTimeouts).toMatchObject({
      enabled: true,
      perProviderMs: {
        codex: 45_000,
        grok: 75_000,
        cursor: 80_000,
        ollama: 85_000,
        antigravity: 95_000,
        muse: 105_000
      },
      mainAuthorityMs: 90_000
    })
    expect(patch.auditRetention).toEqual({
      enabled: true,
      maxAgeDays: { approvalLedger: 180, messageFeedback: 90 }
    })
  })

  it('loads a signed managed policy envelope when its public key verifies', () => {
    const payload = {
      schemaVersion: 1,
      organizationName: 'Signed Corp',
      lockedSettings: ['updateChannel'],
      settings: {
        updateChannel: 'stable',
        autoUpdateEnabled: true
      }
    }
    const signed = signedPolicyEnvelope(payload)
    const service = loadManagedPolicyFromEnvironment({
      env: {
        TASKWRAITH_MANAGED_POLICY_JSON: JSON.stringify(signed.envelope),
        TASKWRAITH_MANAGED_POLICY_PUBLIC_KEY_DER_BASE64: signed.publicKeyDerBase64
      }
    })

    expect(service.snapshot()).toMatchObject({
      active: true,
      source: 'signed-env-json',
      organizationName: 'Signed Corp',
      lockedSettings: expect.arrayContaining(['updateChannel', 'autoUpdateEnabled']),
      errors: [],
      signature: {
        required: true,
        present: true,
        valid: true,
        keyId: 'managed-test-key',
        payloadHash: expect.any(String)
      }
    })
    expect(service.enforcedSettingsPatch(settings())).toMatchObject({
      updateChannel: 'stable',
      autoUpdateEnabled: true
    })
  })

  it('loads a signed managed policy envelope from a configured path', () => {
    const signed = signedPolicyEnvelope({
      schemaVersion: 1,
      settings: { geminiMcpBridgeEnabled: false }
    })
    const service = loadManagedPolicyFromEnvironment({
      env: {
        TASKWRAITH_MANAGED_POLICY_PATH: '/managed/taskwraith-policy.json',
        TASKWRAITH_MANAGED_POLICY_PUBLIC_KEY_DER_BASE64: signed.publicKeyDerBase64
      },
      readFileSync: (filePath) => {
        expect(filePath).toBe('/managed/taskwraith-policy.json')
        return JSON.stringify(signed.envelope)
      }
    })

    expect(service.snapshot()).toMatchObject({
      active: true,
      source: 'signed-env-path',
      errors: [],
      signature: {
        present: true,
        valid: true
      }
    })
    expect(service.enforcedSettingsPatch(settings())).toEqual({
      geminiMcpBridgeEnabled: false
    })
  })

  it('loads MDM managed preferences before user-controlled env policy', () => {
    const service = loadManagedPolicyFromEnvironment({
      env: {
        TASKWRAITH_MANAGED_POLICY_JSON: JSON.stringify({
          schemaVersion: 1,
          settings: { updateChannel: 'nightly' }
        })
      },
      readManagedPreference: (key, type) => {
        expect(key).toBe('TaskWraithManagedPolicy')
        return type === 'dictionary'
          ? {
              schemaVersion: 1,
              organizationName: 'Managed Corp',
              settings: { updateChannel: 'stable', autoUpdateEnabled: true }
            }
          : undefined
      }
    })

    expect(service.snapshot()).toMatchObject({
      active: true,
      source: 'mdm-preferences',
      organizationName: 'Managed Corp',
      errors: []
    })
    expect(service.enforcedSettingsPatch(settings())).toMatchObject({
      updateChannel: 'stable',
      autoUpdateEnabled: true
    })
  })

  it('loads MDM managed preferences from a JSON string value', () => {
    const service = loadManagedPolicyFromEnvironment({
      readManagedPreference: (_key, type) => {
        if (type === 'dictionary') throw new Error('not a dictionary')
        return JSON.stringify({
          schemaVersion: 1,
          settings: { geminiMcpBridgeEnabled: false }
        })
      }
    })

    expect(service.snapshot()).toMatchObject({
      active: true,
      source: 'mdm-preferences',
      errors: []
    })
    expect(service.enforcedSettingsPatch(settings())).toEqual({
      geminiMcpBridgeEnabled: false
    })
  })

  it('loads signed MDM managed preferences when a public key verifies', () => {
    const signed = signedPolicyEnvelope({
      schemaVersion: 1,
      settings: { codexSandboxFallback: 'off' }
    })
    const service = loadManagedPolicyFromEnvironment({
      env: {
        TASKWRAITH_MANAGED_POLICY_PUBLIC_KEY_DER_BASE64: signed.publicKeyDerBase64
      },
      readManagedPreference: (_key, type) =>
        type === 'dictionary' ? (signed.envelope as Record<string, unknown>) : undefined
    })

    expect(service.snapshot()).toMatchObject({
      active: true,
      source: 'signed-mdm-preferences',
      errors: [],
      signature: {
        required: true,
        present: true,
        valid: true
      }
    })
    expect(service.enforcedSettingsPatch(settings())).toEqual({
      codexSandboxFallback: 'off'
    })
  })

  it('requires signed managed policy envelopes when a public key is configured', () => {
    const signed = signedPolicyEnvelope({ schemaVersion: 1 })
    const service = loadManagedPolicyFromEnvironment({
      env: {
        TASKWRAITH_MANAGED_POLICY_JSON: JSON.stringify({
          schemaVersion: 1,
          settings: { updateChannel: 'stable' }
        }),
        TASKWRAITH_MANAGED_POLICY_PUBLIC_KEY_DER_BASE64: signed.publicKeyDerBase64
      }
    })

    expect(service.snapshot()).toMatchObject({
      active: true,
      source: 'env-json',
      errors: ['Managed policy signature is required.'],
      signature: {
        required: true,
        present: false,
        valid: false,
        reason: 'missing_signature'
      }
    })
    expect(service.enforcedSettingsPatch(settings())).toEqual({})
  })

  it('rejects signed managed policy envelopes whose payload was tampered', () => {
    const signed = signedPolicyEnvelope({
      schemaVersion: 1,
      settings: { updateChannel: 'stable' }
    })
    const envelope = signed.envelope as {
      payload: { settings: { updateChannel: string } }
      signature: { payloadHash: string }
    }
    envelope.payload.settings.updateChannel = 'nightly'
    envelope.signature.payloadHash = createHash('sha256')
      .update(stableJson(envelope.payload), 'utf8')
      .digest('hex')

    const service = loadManagedPolicyFromEnvironment({
      env: {
        TASKWRAITH_MANAGED_POLICY_JSON: JSON.stringify(envelope),
        TASKWRAITH_MANAGED_POLICY_PUBLIC_KEY_DER_BASE64: signed.publicKeyDerBase64
      }
    })

    expect(service.snapshot()).toMatchObject({
      active: true,
      source: 'signed-env-json',
      errors: ['Managed policy signature verification failed.'],
      signature: {
        required: true,
        present: true,
        valid: false,
        reason: 'signature_verification_failed'
      }
    })
    expect(service.enforcedSettingsPatch(settings())).toEqual({})
  })

  it('filters locked settings from user patches while keeping unrelated changes', () => {
    const service = new ManagedPolicyService(
      'env-json',
      parseManagedPolicyDocument({
        lockedSettings: ['updateChannel'],
        settings: { agenticServices: { shellCommands: 'deny' } }
      })
    )
    expect(
      service.filterSettingsPatch({
        updateChannel: 'nightly',
        agenticServices: settings().agenticServices,
        chatContextTurns: 2
      })
    ).toEqual({ chatContextTurns: 2 })
  })

  it('disables user MCP servers that fail the managed launch allowlist at save time', () => {
    const service = new ManagedPolicyService(
      'env-json',
      parseManagedPolicyDocument({
        userMcpLaunchAllowlist: {
          allowedTransports: ['stdio'],
          allowedCommandRoots: ['/opt/taskwraith/mcp']
        }
      })
    )

    const filtered = service.filterSettingsPatch({
      userMcpServers: [
        {
          id: 'safe',
          name: 'Safe',
          enabled: true,
          transport: 'stdio',
          command: '/opt/taskwraith/mcp/safe-server'
        },
        {
          id: 'unsafe',
          name: 'Unsafe',
          enabled: true,
          transport: 'stdio',
          command: '/tmp/unsafe-server'
        }
      ]
    })

    expect(filtered.userMcpServers).toEqual([
      expect.objectContaining({ id: 'safe', enabled: true }),
      expect.objectContaining({ id: 'unsafe', enabled: false })
    ])
  })

  it('disables user MCP servers with stale plugin provenance at save time', () => {
    const service = new ManagedPolicyService(
      'env-json',
      parseManagedPolicyDocument({
        userMcpLaunchAllowlist: {
          allowedTransports: ['stdio'],
          requirePluginProvenance: true
        }
      }),
      [],
      {
        validateUserMcpPluginProvenance: (server) =>
          server.id === 'stale'
            ? 'plugin provenance does not match the installed manifest'
            : undefined
      }
    )

    const filtered = service.filterSettingsPatch({
      userMcpServers: [
        {
          id: 'fresh',
          name: 'Fresh',
          enabled: true,
          transport: 'stdio',
          command: '/opt/taskwraith/mcp/fresh-server',
          pluginProvenance: {
            pluginId: 'docs',
            publisher: 'taskwraith',
            version: '1.0.0',
            source: 'builtin',
            namespace: 'plugin.taskwraith.docs',
            manifestHash: 'sha256:fresh',
            kind: 'mcpServer',
            objectId: 'docs-stdio',
            materializedAt: '2026-07-03T12:00:00.000Z'
          }
        },
        {
          id: 'stale',
          name: 'Stale',
          enabled: true,
          transport: 'stdio',
          command: '/opt/taskwraith/mcp/stale-server',
          pluginProvenance: {
            pluginId: 'docs',
            publisher: 'taskwraith',
            version: '1.0.0',
            source: 'builtin',
            namespace: 'plugin.taskwraith.docs',
            manifestHash: 'sha256:stale',
            kind: 'mcpServer',
            objectId: 'docs-stdio',
            materializedAt: '2026-07-03T12:00:00.000Z'
          }
        }
      ]
    })

    expect(filtered.userMcpServers).toEqual([
      expect.objectContaining({ id: 'fresh', enabled: true }),
      expect.objectContaining({ id: 'stale', enabled: false })
    ])
  })

  it('reports malformed env policy without throwing during startup', () => {
    const service = loadManagedPolicyFromEnvironment({
      env: { TASKWRAITH_MANAGED_POLICY_JSON: '{' }
    })
    expect(service.snapshot()).toMatchObject({
      active: true,
      source: 'env-json',
      errors: [expect.any(String)]
    })
    expect(service.enforcedSettingsPatch(settings())).toEqual({})
  })

  it('surfaces a redacted user MCP launch allowlist policy', () => {
    const service = loadManagedPolicyFromEnvironment({
      env: {
        TASKWRAITH_MANAGED_POLICY_JSON: JSON.stringify({
          userMcpLaunchAllowlist: {
            allowedTransports: ['stdio', 'http', 'bogus'],
            allowedCommandRoots: ['/opt/taskwraith/mcp'],
            allowedCommandArgPrefixes: ['--config=', '/opt/taskwraith/config/'],
            allowedRemoteSchemes: ['https', 'ftp'],
            allowedRemoteHosts: ['mcp.example.com'],
            allowedRemotePorts: [443, '8443', 70_000, 0],
            allowedRemotePathPrefixes: ['mcp', '/api'],
            blockPrivateRemoteHosts: true,
            allowedHeaderNames: ['X-TaskWraith'],
            allowedEnvKeys: ['SAFE_TOKEN'],
            requirePluginProvenance: true,
            allowedPluginIds: ['managed-tools']
          }
        })
      }
    })

    expect(service.userMcpLaunchAllowlistPolicy()).toEqual({
      allowedTransports: ['stdio', 'http'],
      allowedCommandRoots: ['/opt/taskwraith/mcp'],
      allowedCommandArgPrefixes: ['--config=', '/opt/taskwraith/config/'],
      allowedRemoteSchemes: ['https'],
      allowedRemoteHosts: ['mcp.example.com'],
      allowedRemotePorts: [443, 8443],
      allowedRemotePathPrefixes: ['/mcp', '/api'],
      blockPrivateRemoteHosts: true,
      allowedHeaderNames: ['X-TaskWraith'],
      allowedEnvKeys: ['SAFE_TOKEN'],
      requirePluginProvenance: true,
      allowedPluginIds: ['managed-tools']
    })
    expect(service.snapshot()).toMatchObject({
      active: true,
      userMcpLaunchAllowlist: {
        active: true,
        allowedTransportCount: 2,
        allowedCommandRootCount: 1,
        allowedCommandArgPrefixCount: 2,
        allowedRemoteSchemeCount: 1,
        allowedRemoteHostCount: 1,
        allowedRemotePortCount: 2,
        allowedRemotePathPrefixCount: 2,
        blockPrivateRemoteHosts: true,
        allowedHeaderNameCount: 1,
        allowedEnvKeyCount: 1,
        requirePluginProvenance: true,
        allowedPluginIdCount: 1
      }
    })
  })
})
