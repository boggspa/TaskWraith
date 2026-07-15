import { delimiter, dirname } from 'path'
import { describe, expect, it, vi } from 'vitest'
import {
  canonicalizeClaudeRuntimeProfilePayload,
  ClaudeEnvironmentAuthorityError,
  prepareClaudeEnvironmentAuthority,
  resolvePreparedClaudeRunAuthority,
  type ClaudeEnvironmentAuthorityInput
} from './ClaudeRuntimeEnvironment'
import {
  applyRuntimeProfileToPayload,
  type CliProviderRuntimeDependencies
} from './CliProviderRuntime'
import type { AgentRunPayload } from '../run/AgentRunTypes'
import type { RuntimeProfile } from '../store/types'

vi.mock('../store', () => ({
  AppStore: {
    getSettings: () => ({}),
    getRuntimeProfiles: () => [],
    resolveExtensionSecretValues: () => []
  }
}))

const binaryPath = '/opt/taskwraith/claude/bin/claude'

function runtimeProfile(overrides: Partial<RuntimeProfile> = {}): RuntimeProfile {
  return {
    id: 'profile-claude',
    name: 'Claude test profile',
    provider: 'claude',
    scope: 'workspace',
    workspaceMode: 'local',
    env: {
      PROFILE_VISIBLE: 'profile-value',
      PROFILE_SECRET: 'unresolved-placeholder',
      TASKWRAITH_MCP_AUDIT: '1',
      CSC_LINK: 'profile-signing-material'
    },
    secretRefs: { env: ['PROFILE_SECRET'] },
    networkPolicy: 'inherit',
    persistence: 'reusable',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  }
}

function inheritedEnv(): Readonly<Record<string, string>> {
  return {
    PATH: '/host/bin',
    TERM: 'test-term',
    COLORTERM: 'test-colorterm',
    HOME: '/test/home',
    SAFE_INHERITED: 'safe-value',
    GH_TOKEN: 'inherited-publish-credential',
    APPLE_ID: 'inherited-signing-credential'
  }
}

function dependencies(
  resolveValue: () => string = () => 'resolved-test-value'
): CliProviderRuntimeDependencies {
  return {
    env: inheritedEnv(),
    getRuntimeProfiles: () => {
      throw new Error('An exact prepared profile must not be looked up again.')
    },
    resolveExtensionSecretValues: (refs) =>
      refs.map((ref) => ({ ref, status: 'ok' as const, value: resolveValue() }))
  }
}

function authorityInput(
  overrides: Partial<ClaudeEnvironmentAuthorityInput> = {}
): ClaudeEnvironmentAuthorityInput {
  return {
    runtimeProfile: runtimeProfile(),
    binaryPath,
    scope: 'workspace',
    workspace: '/workspace',
    runId: 'run-1',
    chatId: 'chat-1',
    apiKey: 'test-api-key',
    ...overrides
  }
}

describe('Claude environment authority', () => {
  it('propagates the current default profile and downstream application does not reread it', () => {
    const payload: AgentRunPayload = {
      provider: 'claude',
      scope: 'workspace',
      workspace: '/workspace',
      prompt: 'test'
    }
    const profile = runtimeProfile({ id: 'default-profile', env: {}, secretRefs: undefined })

    canonicalizeClaudeRuntimeProfilePayload(payload, [profile])
    applyRuntimeProfileToPayload(payload, dependencies())

    expect(payload.runtimeProfileId).toBe('default-profile')
    expect(payload.runtimeProfile).toBe(profile)
  })

  it('rejects route fallback or chat identities that disagree with the prepared payload', () => {
    const payload: AgentRunPayload = {
      provider: 'claude',
      scope: 'workspace',
      workspace: '/workspace',
      prompt: 'test',
      appRunId: 'run-prepared',
      appChatId: 'chat-1',
      runtimeProfileId: 'profile-claude',
      runtimeProfile: runtimeProfile()
    }

    expect(() =>
      resolvePreparedClaudeRunAuthority({
        payload,
        route: { appRunId: 'run-fallback', appChatId: 'chat-1' }
      })
    ).toThrow(/coordinator-assigned run identity/)
    expect(() =>
      resolvePreparedClaudeRunAuthority({
        payload,
        route: { appRunId: 'run-prepared', appChatId: 'chat-other' }
      })
    ).toThrow(/coordinator-assigned chat identity/)
  })

  it('enables audit env only for an exact payload-to-registry identity', () => {
    const payload: AgentRunPayload = {
      provider: 'claude',
      scope: 'workspace',
      workspace: '/workspace',
      prompt: 'audit',
      appRunId: 'run-1',
      appChatId: 'chat-1',
      runtimeProfileId: 'profile-claude',
      runtimeProfile: runtimeProfile(),
      auditRun: { auditRunId: 'audit-1', role: 'reviewer', dimension: 'security' }
    }
    const prepared = resolvePreparedClaudeRunAuthority({
      payload,
      route: { appRunId: 'run-1', appChatId: 'chat-1' },
      registryAudit: {
        auditRunId: 'audit-1',
        runId: 'run-1',
        role: 'reviewer',
        dimension: 'security',
        provider: 'claude'
      }
    })

    expect(prepared.auditRun).toBe(true)
  })

  it('rejects forged, missing, or mismatched audit registry identity', () => {
    const payload: AgentRunPayload = {
      provider: 'claude',
      scope: 'workspace',
      workspace: '/workspace',
      prompt: 'audit',
      appRunId: 'run-1',
      appChatId: 'chat-1',
      runtimeProfileId: 'profile-claude',
      runtimeProfile: runtimeProfile(),
      auditRun: { auditRunId: 'audit-forged', role: 'reviewer', dimension: 'security' }
    }
    const route = { appRunId: 'run-1', appChatId: 'chat-1' }

    expect(() => resolvePreparedClaudeRunAuthority({ payload, route })).toThrow(/not registered/)
    expect(() =>
      resolvePreparedClaudeRunAuthority({
        payload,
        route,
        registryAudit: {
          auditRunId: 'audit-real',
          runId: 'run-1',
          role: 'reviewer',
          dimension: 'security',
          provider: 'claude'
        }
      })
    ).toThrow(/does not match/)
    expect(() =>
      resolvePreparedClaudeRunAuthority({
        payload: {
          ...payload,
          auditRun: { ...payload.auditRun!, auditRunId: 'audit-real', dimension: ' security ' }
        },
        route,
        registryAudit: {
          auditRunId: 'audit-real',
          runId: 'run-1',
          role: 'reviewer',
          dimension: 'security',
          provider: 'claude'
        }
      })
    ).toThrow(/does not match/)
  })

  it('scrubs hostile inherited/profile vars and preserves the exact profile, binary, and route', () => {
    const authority = prepareClaudeEnvironmentAuthority(authorityInput(), dependencies())

    expect(authority.env.GH_TOKEN).toBeUndefined()
    expect(authority.env.APPLE_ID).toBeUndefined()
    expect(authority.env.CSC_LINK).toBeUndefined()
    expect(authority.env.SAFE_INHERITED).toBe('safe-value')
    expect(authority.env.PROFILE_VISIBLE).toBe('profile-value')
    expect(authority.env.PROFILE_SECRET).toBe('resolved-test-value')
    expect(authority.env.TASKWRAITH_RUNTIME_PROFILE_ID).toBe('profile-claude')
    expect(authority.env.TASKWRAITH_PARENT_PROVIDER).toBe('claude')
    expect(authority.env.TASKWRAITH_RUN_ID).toBe('run-1')
    expect(authority.env.TASKWRAITH_CHAT_ID).toBe('chat-1')
    expect(authority.env.TASKWRAITH_WORKSPACE_PATH).toBe('/workspace')
    expect(authority.env.TASKWRAITH_MCP_AUDIT).toBe('0')
    expect(authority.env.ANTHROPIC_API_KEY).toBe('test-api-key')
    expect(authority.env.PATH.split(delimiter)[0]).toBe(dirname(binaryPath))
    expect(authority.runtimeProfileId).toBe('profile-claude')
    expect(authority.binaryPath).toBe(binaryPath)
    expect(Object.isFrozen(authority)).toBe(true)
    expect(Object.isFrozen(authority.env)).toBe(true)
  })

  it('stamps audit authority once for both SDK and CLI consumers', () => {
    const authority = prepareClaudeEnvironmentAuthority(
      authorityInput({ auditRun: true }),
      dependencies()
    )
    const sdkEnv = authority.env
    const cliFallbackEnv = authority.env

    expect(sdkEnv).toBe(cliFallbackEnv)
    expect(sdkEnv.TASKWRAITH_MCP_AUDIT).toBe('1')
  })

  it('keeps one logical run immutable while a later run observes an intentional secret rotation', () => {
    let currentValue = 'first-test-value'
    const resolveSecret = vi.fn(() => currentValue)
    const deps = dependencies(resolveSecret)
    const first = prepareClaudeEnvironmentAuthority(authorityInput(), deps)

    currentValue = 'second-test-value'
    expect(first.env.PROFILE_SECRET).toBe('first-test-value')
    const sdkEnv = first.env
    const cliFallbackEnv = first.env
    expect(cliFallbackEnv).toBe(sdkEnv)
    expect(resolveSecret).toHaveBeenCalledTimes(1)

    const second = prepareClaudeEnvironmentAuthority(authorityInput({ runId: 'run-2' }), deps)
    expect(second.env).not.toBe(first.env)
    expect(second.env.PROFILE_SECRET).toBe('second-test-value')
    expect(resolveSecret).toHaveBeenCalledTimes(2)
  })

  it('classifies unresolved profile secrets as terminal and never fallback-eligible', () => {
    const deps: CliProviderRuntimeDependencies = {
      env: inheritedEnv(),
      resolveExtensionSecretValues: (refs) =>
        refs.map((ref) => ({ ref, status: 'missing' as const }))
    }

    let thrown: unknown
    try {
      prepareClaudeEnvironmentAuthority(authorityInput(), deps)
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(ClaudeEnvironmentAuthorityError)
    expect(thrown).toMatchObject({
      phase: 'environment-authority',
      terminal: true,
      fallbackAllowed: false
    })
    expect((thrown as Error).message).toMatch(/encrypted env secret PROFILE_SECRET is missing/)
  })
})
