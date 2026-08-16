import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'
import { registerSettingsHandlers } from './settingsHandlers'
import type { ExtensionSecretRef } from '../ExtensionSecretStore'
import type { AppSettings, HandoffCard, ProviderId, RuntimeProfile } from '../store/types'

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

function runtimeProfile(overrides: Partial<RuntimeProfile> = {}): RuntimeProfile {
  return {
    id: 'runtime-1',
    name: 'Runtime',
    provider: 'codex',
    scope: 'workspace',
    workspaceMode: 'local',
    env: {},
    networkPolicy: 'inherit',
    persistence: 'reusable',
    createdAt: '2026-06-27T16:00:00.000Z',
    updatedAt: '2026-06-27T16:00:00.000Z',
    ...overrides
  }
}

function handoffCard(overrides: Partial<HandoffCard> = {}): HandoffCard {
  return {
    id: 'handoff-1',
    status: 'draft',
    sourceChatId: 'chat-1',
    sourceProvider: 'codex',
    summary: 'Summary',
    selectedFiles: [],
    workspaceChangeSetIds: [],
    rawEventRunIds: [],
    finalPrompt: 'Continue',
    createdAt: '2026-06-27T16:00:00.000Z',
    updatedAt: '2026-06-27T16:00:00.000Z',
    ...overrides
  }
}

function createDeps(overrides: Partial<Parameters<typeof registerSettingsHandlers>[0]> = {}) {
  const settings = { bridgeDaemonEnabled: false } as AppSettings
  return {
    settingsService: {
      getSettings: vi.fn(() => settings),
      updateSettings: vi.fn()
    },
    getPromptCacheCapabilities: vi.fn(() => [
      {
        provider: 'claude' as ProviderId,
        label: 'Claude',
        transport: 'cli-opaque' as const,
        guaranteeTier: 'best-effort' as const,
        guaranteeLabel: 'Best effort',
        detail: 'Opaque transport',
        defaultMode: 'auto' as const,
        controllable: false,
        supportsModeControl: true
      }
    ]),
    getPromptCacheDiagnostics: vi.fn(() => [{ provider: 'claude', cacheReadInputTokens: 12 }]),
    setBridgeDaemonEnabled: vi.fn(async () => ({
      lan: { enabled: true },
      tailscale: { available: true }
    })),
    getRuntimeProfiles: vi.fn(() => [runtimeProfile()]),
    saveRuntimeProfile: vi.fn((profile) => runtimeProfile(profile)),
    deleteRuntimeProfile: vi.fn(() => true),
    getExtensionSecretStatusSnapshot: vi.fn(() => ({
      schemaVersion: 1 as const,
      generatedAt: '2026-07-03T00:00:00.000Z',
      encryptionAvailable: true,
      secrets: []
    })),
    setExtensionSecret: vi.fn((ref: ExtensionSecretRef, _value: string) => ({
      ok: true,
      snapshot: {
        schemaVersion: 1 as const,
        generatedAt: '2026-07-03T00:00:00.000Z',
        encryptionAvailable: true,
        secrets: [{ ...ref, configured: true, updatedAt: '2026-07-03T00:00:00.000Z' }]
      }
    })),
    clearExtensionSecret: vi.fn((ref: ExtensionSecretRef) => ({
      ok: true,
      snapshot: {
        schemaVersion: 1 as const,
        generatedAt: '2026-07-03T00:00:00.000Z',
        encryptionAvailable: true,
        secrets: [{ ...ref, configured: false }]
      }
    })),
    getManagedPolicyStatus: vi.fn(() => ({
      active: true,
      source: 'signed-mdm-preferences',
      lockedSettings: ['approvalTimeouts'],
      enforcedSettings: ['approvalTimeouts'],
      errors: []
    })),
    resolveSenderSettingsScope: vi.fn(() => ({ kind: 'main' as const })),
    workspacePathsEqual: vi.fn((left: string, right: string) => left === right),
    resolveSenderHandoffCardScope: vi.fn(() => ({ kind: 'all' as const })),
    getHandoffCards: vi.fn(() => [handoffCard()]),
    saveHandoffCard: vi.fn((card) => handoffCard(card)),
    updateHandoffCard: vi.fn((id, partial) => handoffCard({ id, ...partial })),
    deleteHandoffCard: vi.fn(() => true),
    assertProviderId: vi.fn((provider: ProviderId) => provider),
    requireNonEmptyString: vi.fn((value: string) => value),
    sanitizeRuntimeProfileForSave: vi.fn((profile) => profile as any),
    sanitizeHandoffCardForSave: vi.fn((card) => card as any),
    sanitizeHandoffCardPatch: vi.fn((partial) => partial as any),
    sanitizeHandoffCardFilter: vi.fn((filter) => filter as any),
    ...overrides
  }
}

describe('registerSettingsHandlers', () => {
  it('registers settings read and update handlers against the settings service', () => {
    const deps = createDeps()
    registerSettingsHandlers(deps)

    expect(handlerFor('get-settings')({} as any)).toEqual(deps.settingsService.getSettings())
    expect(handlerFor('update-settings')({} as any, { compactDensity: true })).toBeUndefined()
    expect(deps.settingsService.updateSettings).toHaveBeenCalledWith({ compactDensity: true })
  })

  it('projects generic settings reads without plaintext secrets or encrypted credential blobs', () => {
    const settings = {
      compactDensity: true,
      claudeApiKey: 'secret-claude',
      kimiApiKey: 'secret-kimi',
      ollamaApiKey: 'secret-ollama',
      geminiAuthProfiles: [
        {
          id: 'gemini-1',
          label: 'Gemini API',
          kind: 'api-key',
          createdAt: '2026-07-03T00:00:00.000Z',
          updatedAt: '2026-07-03T00:00:00.000Z',
          encryptedApiKey: 'secret-gemini'
        }
      ],
      codexUsageCredential: {
        encryptedAccessToken: 'secret-codex',
        accountId: 'account-1',
        encryptionAvailable: true
      },
      userMcpServers: [
        {
          id: 'mcp-1',
          name: 'MCP',
          enabled: true,
          transport: 'stdio',
          command: 'mcp-server',
          env: {
            DEBUG: '1',
            API_TOKEN: 'secret-mcp-env',
            TOKEN_REFERENCE: '$TOKEN_REFERENCE',
            DECLARED_SECRET: 'secret-declared-env'
          },
          headers: {
            'X-Mode': 'test',
            Authorization: 'secret-mcp-header'
          },
          secretRefs: { env: ['DECLARED_SECRET'], headers: ['Authorization'] }
        }
      ],
      apnsConfig: {
        encryptedAuthKey: 'secret-apns',
        keyId: 'KEY1234567',
        encryptionAvailable: true
      },
      imageGeneration: {
        enabled: true,
        provider: 'openai',
        encryptedKeys: { openai: 'secret-image-openai', xai: 'secret-image-xai' }
      },
      tailscaleOAuth: {
        clientId: 'public-client-id',
        encryptedClientSecret: 'secret-tailscale',
        encryptionAvailable: true
      }
    } as unknown as AppSettings
    const deps = createDeps({
      settingsService: {
        getSettings: vi.fn(() => settings),
        updateSettings: vi.fn()
      }
    })
    registerSettingsHandlers(deps)

    const result = handlerFor('get-settings')({} as any) as AppSettings

    expect(result).toMatchObject({
      compactDensity: true,
      geminiAuthProfiles: [expect.objectContaining({ id: 'gemini-1' })],
      codexUsageCredential: { accountId: 'account-1', encryptionAvailable: true },
      userMcpServers: [
        expect.objectContaining({
          env: { DEBUG: '1', TOKEN_REFERENCE: '$TOKEN_REFERENCE' },
          headers: { 'X-Mode': 'test' },
          secretRefs: { env: ['DECLARED_SECRET'], headers: ['Authorization'] }
        })
      ],
      apnsConfig: { keyId: 'KEY1234567', encryptionAvailable: true },
      imageGeneration: { enabled: true, provider: 'openai' },
      tailscaleOAuth: {
        clientId: 'public-client-id',
        encryptionAvailable: true
      }
    })
    expect(result).not.toHaveProperty('claudeApiKey')
    expect(result).not.toHaveProperty('kimiApiKey')
    expect(result).not.toHaveProperty('ollamaApiKey')
    expect(result.geminiAuthProfiles?.[0]).not.toHaveProperty('encryptedApiKey')
    expect(result.codexUsageCredential).not.toHaveProperty('encryptedAccessToken')
    expect(result.apnsConfig).not.toHaveProperty('encryptedAuthKey')
    expect(result.imageGeneration).not.toHaveProperty('encryptedKeys')
    expect(result.tailscaleOAuth).not.toHaveProperty('encryptedClientSecret')
    expect(JSON.stringify(result)).not.toContain('secret-')
  })

  it('projects chat settings to the frozen workspace without global host configuration', () => {
    const settings = {
      appearanceMode: 'solid',
      composerStyle: 'default',
      antigravityEnabled: true,
      antigravityOptInAcceptedAt: 1_700_000_000_000,
      antigravityGeminiApiDisclosureAcceptedAt: 1_700_000_000_100,
      antigravityGeminiApiMonthlySpendCapUsd: 25,
      agenticServices: { shellCommands: 'ask' },
      agenticWorkspaceGrants: [
        {
          id: 'grant-test-1',
          workspacePath: '/work/Test 1',
          provider: 'codex',
          service: 'shellCommands',
          createdAt: '2026-07-13T00:00:00.000Z',
          updatedAt: '2026-07-13T00:00:00.000Z'
        },
        {
          id: 'grant-test-3',
          workspacePath: '/work/Test 3',
          provider: 'claude',
          service: 'fileChanges',
          createdAt: '2026-07-13T00:00:00.000Z',
          updatedAt: '2026-07-13T00:00:00.000Z'
        }
      ],
      approvalModeElevationAcknowledgements: {
        '/work/Test 1|codex': true,
        '/work/Test 1/|grok': true,
        '/work/Test 1': true,
        '/work/Test 3|claude': true,
        '/work/Test 3': true
      },
      userMcpServers: [
        {
          id: 'private-mcp',
          name: 'Private MCP',
          enabled: true,
          transport: 'stdio',
          command: '/private/bin/server',
          args: ['--token', 'plaintext-token'],
          url: 'https://user:password@example.test/mcp?token=secret',
          env: { DATABASE_URL: 'postgres://secret' },
          headers: { Authorization: 'Bearer secret' }
        }
      ],
      geminiMcpBridgeLastStatus: {
        checkedAt: '2026-07-13T00:00:00.000Z',
        enabled: true,
        installed: true,
        available: true,
        serverName: 'TaskWraith',
        socketPath: '/private/tmp/taskwraith.sock',
        command: '/private/bin/bridge',
        raw: 'sensitive host output'
      },
      windowBounds: { width: 1200, height: 800 },
      claudeBinaryPath: '/private/bin/claude',
      kimiBinaryPath: '/private/bin/kimi',
      ollamaBaseUrl: 'http://127.0.0.1:11434',
      iosRemoteRelayUrl: 'wss://private-relay.example.test',
      futureGlobalSecret: 'must-not-cross-renderers'
    } as unknown as AppSettings
    const deps = createDeps({
      settingsService: {
        getSettings: vi.fn(() => settings),
        updateSettings: vi.fn()
      },
      resolveSenderSettingsScope: vi.fn(() => ({
        kind: 'chat' as const,
        workspacePath: '/work/Test 1'
      })),
      workspacePathsEqual: vi.fn(
        (left: string, right: string) => left.replace(/\/+$/, '') === right.replace(/\/+$/, '')
      )
    })
    registerSettingsHandlers(deps)

    const result = handlerFor('get-settings')({} as any) as AppSettings

    expect(result).toMatchObject({
      antigravityEnabled: true,
      antigravityOptInAcceptedAt: 1_700_000_000_000,
      antigravityGeminiApiDisclosureAcceptedAt: 1_700_000_000_100,
      antigravityGeminiApiMonthlySpendCapUsd: 25
    })
    expect(result.agenticWorkspaceGrants).toEqual([
      expect.objectContaining({ id: 'grant-test-1', workspacePath: '/work/Test 1' })
    ])
    expect(result.approvalModeElevationAcknowledgements).toEqual({
      '/work/Test 1|codex': true,
      '/work/Test 1/|grok': true,
      '/work/Test 1': true
    })
    expect(result).not.toHaveProperty('userMcpServers')
    expect(result).not.toHaveProperty('geminiMcpBridgeLastStatus')
    expect(result).not.toHaveProperty('windowBounds')
    expect(result).not.toHaveProperty('claudeBinaryPath')
    expect(result).not.toHaveProperty('kimiBinaryPath')
    expect(result).not.toHaveProperty('ollamaBaseUrl')
    expect(result).not.toHaveProperty('iosRemoteRelayUrl')
    expect(result).not.toHaveProperty('futureGlobalSecret')
    expect(JSON.stringify(result)).not.toContain('Test 3')
    expect(JSON.stringify(result)).not.toContain('plaintext-token')
    expect(JSON.stringify(result)).not.toContain('must-not-cross-renderers')
  })

  it('returns only appearance settings to utility renderers', () => {
    const settings = {
      appearanceMode: 'native_glass',
      themeAppearance: 'dark',
      composerStyle: 'compact',
      agenticServices: { shellCommands: 'allow' },
      agenticWorkspaceGrants: [{ workspacePath: '/work/Test 1' }],
      userMcpServers: [{ command: '/private/bin/server' }]
    } as unknown as AppSettings
    const deps = createDeps({
      settingsService: {
        getSettings: vi.fn(() => settings),
        updateSettings: vi.fn()
      },
      resolveSenderSettingsScope: vi.fn(() => ({ kind: 'utility' as const }))
    })
    registerSettingsHandlers(deps)

    const result = handlerFor('get-settings')({} as any) as AppSettings

    expect(result).toMatchObject({
      appearanceMode: 'native_glass',
      themeAppearance: 'dark',
      composerStyle: 'compact',
      showInspector: false
    })
    expect(result).not.toHaveProperty('agenticServices')
    expect(result).not.toHaveProperty('agenticWorkspaceGrants')
    expect(result).not.toHaveProperty('userMcpServers')
  })

  it('delegates bridge daemon toggles through the injected bridge callback', async () => {
    const deps = createDeps()
    registerSettingsHandlers(deps)

    await expect(handlerFor('set-bridge-daemon-enabled')({} as any, 1)).resolves.toEqual({
      lan: { enabled: true },
      tailscale: { available: true }
    })
    expect(deps.setBridgeDaemonEnabled).toHaveBeenCalledWith(true)
  })

  it('exposes prompt cache policy and summary IPC', async () => {
    const settings = {
      promptCache: {
        enabled: true,
        providers: { claude: { mode: 'auto' as const } }
      }
    } as AppSettings
    const deps = createDeps({
      settingsService: {
        getSettings: vi.fn(() => settings),
        updateSettings: vi.fn()
      }
    })
    registerSettingsHandlers(deps)

    expect(handlerFor('prompt-cache:get-policy')({} as any)).toEqual(settings.promptCache)
    expect(
      handlerFor('prompt-cache:save-policy')({} as any, {
        enabled: false,
        providers: { claude: { mode: 'explicit' } }
      })
    ).toEqual({ ok: true })
    expect(deps.settingsService.updateSettings).toHaveBeenCalledWith({
      promptCache: {
        enabled: false,
        providers: { claude: { mode: 'explicit' } }
      }
    })
    expect(handlerFor('prompt-cache:get-capabilities')({} as any)).toEqual([
      expect.objectContaining({ provider: 'claude', guaranteeTier: 'best-effort' })
    ])
    expect(handlerFor('prompt-cache:get-diagnostics')({} as any)).toEqual([
      { provider: 'claude', cacheReadInputTokens: 12 }
    ])
  })

  it('sanitizes provider filters and runtime profile mutations', () => {
    const deps = createDeps()
    const profileInput = { name: 'Runtime', provider: 'codex' as ProviderId }
    registerSettingsHandlers(deps)

    expect(handlerFor('get-runtime-profiles')({} as any, 'codex')).toEqual([runtimeProfile()])
    expect(deps.assertProviderId).toHaveBeenCalledWith('codex')
    expect(deps.getRuntimeProfiles).toHaveBeenCalledWith('codex')

    expect(handlerFor('save-runtime-profile')({} as any, profileInput)).toEqual(
      runtimeProfile(profileInput)
    )
    expect(deps.sanitizeRuntimeProfileForSave).toHaveBeenCalledWith(profileInput)
    expect(deps.saveRuntimeProfile).toHaveBeenCalledWith(profileInput)

    expect(handlerFor('delete-runtime-profile')({} as any, 'runtime-1')).toBe(true)
    expect(deps.requireNonEmptyString).toHaveBeenCalledWith('runtime-1', 'Runtime profile id')
    expect(deps.deleteRuntimeProfile).toHaveBeenCalledWith('runtime-1')
  })

  it('redacts legacy plaintext secrets from runtime profile reads', () => {
    const deps = createDeps({
      getRuntimeProfiles: vi.fn(() => [
        runtimeProfile({
          env: {
            DEBUG: '1',
            OPENAI_API_KEY: 'secret-runtime-key',
            TOKEN_REFERENCE: '$TOKEN_REFERENCE',
            DECLARED_SECRET: 'secret-declared-runtime'
          },
          secretRefs: { env: ['DECLARED_SECRET'] }
        })
      ])
    })
    registerSettingsHandlers(deps)

    expect(handlerFor('get-runtime-profiles')({} as any, 'codex')).toEqual([
      expect.objectContaining({
        env: { DEBUG: '1', TOKEN_REFERENCE: '$TOKEN_REFERENCE' },
        secretRefs: { env: ['DECLARED_SECRET'] }
      })
    ])
  })

  it('returns runtime profile metadata only to secondary renderers', () => {
    const deps = createDeps({
      resolveSenderSettingsScope: vi.fn(() => ({
        kind: 'chat' as const,
        workspacePath: '/work/Test 1'
      })),
      getRuntimeProfiles: vi.fn(() => [
        runtimeProfile({
          binaryPath: '/private/bin/codex',
          env: { DATABASE_URL: 'postgres://secret' },
          secretRefs: { env: ['DATABASE_URL'] },
          mcpProfileId: 'private-mcp',
          approvalMode: 'allow-all',
          agenticServices: { shellCommands: 'allow' },
          containerConfig: {
            image: 'private-image',
            mounts: [{ source: '/private/source', target: '/workspace', access: 'write' }]
          }
        })
      ])
    })
    registerSettingsHandlers(deps)

    const [result] = handlerFor('get-runtime-profiles')({} as any, 'codex') as RuntimeProfile[]

    expect(result).toMatchObject({
      id: 'runtime-1',
      name: 'Runtime',
      provider: 'codex',
      scope: 'workspace',
      workspaceMode: 'local'
    })
    for (const key of [
      'binaryPath',
      'env',
      'secretRefs',
      'mcpProfileId',
      'approvalMode',
      'agenticServices',
      'containerConfig'
    ]) {
      expect(result).not.toHaveProperty(key)
    }
  })

  it('stores runtime profile env secrets as encrypted refs during save', () => {
    const deps = createDeps()
    const profileInput = {
      name: 'Runtime',
      provider: 'codex' as ProviderId,
      env: { SAFE_FLAG: 'kept' }
    }
    registerSettingsHandlers(deps)

    expect(
      handlerFor('save-runtime-profile')({} as any, profileInput, {
        env: {
          SERVICE_TOKEN: 'secret-token',
          'bad-name': 'ignored',
          EMPTY_SECRET: ''
        }
      })
    ).toMatchObject({
      id: 'runtime-1',
      env: { SAFE_FLAG: 'kept' },
      secretRefs: { env: ['SERVICE_TOKEN'] }
    })
    expect(deps.saveRuntimeProfile).toHaveBeenCalledWith({
      ...profileInput,
      secretRefs: { env: ['SERVICE_TOKEN'] }
    })
    expect(deps.setExtensionSecret).toHaveBeenCalledWith(
      {
        ownerKind: 'runtimeProfile',
        ownerId: 'runtime-1',
        fieldKind: 'env',
        fieldName: 'SERVICE_TOKEN'
      },
      'secret-token'
    )
    expect(vi.mocked(deps.saveRuntimeProfile).mock.calls[0]?.[0].env).not.toHaveProperty(
      'SERVICE_TOKEN'
    )
  })

  it('rolls back a new runtime profile when encrypted env secret storage fails', () => {
    const deps = createDeps({
      setExtensionSecret: vi.fn(() => ({
        ok: false,
        error: 'Encryption unavailable.',
        snapshot: {
          schemaVersion: 1 as const,
          generatedAt: '2026-07-03T00:00:00.000Z',
          encryptionAvailable: false,
          secrets: []
        }
      }))
    })
    registerSettingsHandlers(deps)

    expect(() =>
      handlerFor('save-runtime-profile')(
        {} as any,
        { name: 'Runtime', provider: 'codex' as ProviderId },
        { env: { SERVICE_TOKEN: 'secret-token' } }
      )
    ).toThrow('Encryption unavailable.')
    expect(deps.saveRuntimeProfile).toHaveBeenCalledWith({
      name: 'Runtime',
      provider: 'codex',
      secretRefs: { env: ['SERVICE_TOKEN'] }
    })
    expect(deps.deleteRuntimeProfile).toHaveBeenCalledWith('runtime-1')
  })

  it('exposes extension secret status and mutation handlers without plaintext reads', () => {
    const deps = createDeps()
    const ref: ExtensionSecretRef = {
      ownerKind: 'runtimeProfile',
      ownerId: 'runtime-1',
      fieldKind: 'env',
      fieldName: 'SERVICE_TOKEN'
    }
    registerSettingsHandlers(deps)

    expect(handlerFor('get-extension-secret-status')({} as any)).toEqual({
      schemaVersion: 1,
      generatedAt: '2026-07-03T00:00:00.000Z',
      encryptionAvailable: true,
      secrets: []
    })
    expect(handlerFor('set-extension-secret')({} as any, ref, 'token-value')).toMatchObject({
      ok: true,
      snapshot: {
        secrets: [{ ...ref, configured: true }]
      }
    })
    expect(deps.requireNonEmptyString).toHaveBeenCalledWith('token-value', 'Secret value')
    expect(deps.setExtensionSecret).toHaveBeenCalledWith(ref, 'token-value')

    expect(handlerFor('clear-extension-secret')({} as any, ref)).toMatchObject({
      ok: true,
      snapshot: {
        secrets: [{ ...ref, configured: false }]
      }
    })
    expect(deps.clearExtensionSecret).toHaveBeenCalledWith(ref)
  })

  it('exposes redacted managed-policy status for Settings affordances', () => {
    const deps = createDeps()
    registerSettingsHandlers(deps)

    expect(handlerFor('get-managed-policy-status')({} as any)).toEqual({
      active: true,
      source: 'signed-mdm-preferences',
      lockedSettings: ['approvalTimeouts'],
      enforcedSettings: ['approvalTimeouts'],
      errors: []
    })
    expect(deps.getManagedPolicyStatus).toHaveBeenCalled()
  })

  it('sanitizes handoff card reads and mutations', () => {
    const deps = createDeps()
    const cardInput = {
      sourceChatId: 'chat-1',
      sourceProvider: 'codex' as ProviderId,
      summary: 'Summary',
      finalPrompt: 'Continue'
    }
    registerSettingsHandlers(deps)

    expect(handlerFor('get-handoff-cards')({} as any, { status: 'draft' })).toEqual([handoffCard()])
    expect(deps.sanitizeHandoffCardFilter).toHaveBeenCalledWith({ status: 'draft' })
    expect(deps.getHandoffCards).toHaveBeenCalledWith({ status: 'draft' })

    expect(handlerFor('save-handoff-card')({} as any, cardInput)).toEqual(handoffCard(cardInput))
    expect(deps.sanitizeHandoffCardForSave).toHaveBeenCalledWith(cardInput)
    expect(deps.saveHandoffCard).toHaveBeenCalledWith(cardInput)

    expect(
      handlerFor('update-handoff-card')({} as any, 'handoff-1', { summary: 'Updated' })
    ).toEqual(handoffCard({ id: 'handoff-1', summary: 'Updated' }))
    expect(deps.requireNonEmptyString).toHaveBeenCalledWith('handoff-1', 'Handoff card id')
    expect(deps.sanitizeHandoffCardPatch).toHaveBeenCalledWith({ summary: 'Updated' })
    expect(deps.updateHandoffCard).toHaveBeenCalledWith('handoff-1', { summary: 'Updated' })

    expect(handlerFor('delete-handoff-card')({} as any, 'handoff-1')).toBe(true)
    expect(deps.deleteHandoffCard).toHaveBeenCalledWith('handoff-1')
  })

  it('scopes handoff card reads from a chat renderer to its owning chat', () => {
    const deps = createDeps({
      resolveSenderHandoffCardScope: vi.fn(() => ({
        kind: 'chat' as const,
        chatId: 'chat-1'
      }))
    })
    registerSettingsHandlers(deps)

    expect(handlerFor('get-handoff-cards')({} as any, { status: 'draft' })).toEqual([handoffCard()])
    expect(deps.getHandoffCards).toHaveBeenCalledWith({
      status: 'draft',
      sourceChatId: 'chat-1'
    })
  })

  it('rejects handoff card reads for another chat', () => {
    const deps = createDeps({
      resolveSenderHandoffCardScope: vi.fn(() => ({
        kind: 'chat' as const,
        chatId: 'chat-1'
      }))
    })
    registerSettingsHandlers(deps)

    expect(() => handlerFor('get-handoff-cards')({} as any, { sourceChatId: 'chat-3' })).toThrow(
      'Renderer cannot read handoff cards for another chat.'
    )
    expect(deps.getHandoffCards).not.toHaveBeenCalled()
  })
})
