import { describe, it, expect, vi } from 'vitest'
import {
  applyRuntimeProfileToPayload,
  createCliEnv,
  getCliProviderMcpStatus,
  runtimeSettings,
  type CliProviderRuntimeDependencies,
  type RuntimeProfilePayload
} from './CliProviderRuntime'
import type { AppSettings, RuntimeProfile } from '../store/types'

// CliProviderRuntime imports AppStore from '../store', which touches Electron/fs
// at module load. We exercise applyRuntimeProfileToPayload with INJECTED deps, so
// AppStore is never called — mock the module purely to avoid the side-effectful
// import during the test run. (vitest hoists vi.mock above the imports.)
vi.mock('../store', () => ({
  AppStore: {
    getSettings: () => ({}),
    getRuntimeProfiles: () => [],
    resolveExtensionSecretValues: () => []
  }
}))

function makeProfile(overrides: Partial<RuntimeProfile> = {}): RuntimeProfile {
  return {
    id: 'builtin:grok:global',
    name: 'Grok global',
    provider: 'grok',
    scope: 'workspace',
    workspaceMode: 'local',
    env: {},
    approvalMode: 'default',
    networkPolicy: 'inherit',
    persistence: 'reusable',
    builtin: true,
    createdAt: '0',
    updatedAt: '0',
    ...overrides
  }
}

const depsWith = (profile: RuntimeProfile): CliProviderRuntimeDependencies => ({
  getRuntimeProfiles: () => [profile]
})

const payload = (overrides: Partial<RuntimeProfilePayload>): RuntimeProfilePayload => ({
  provider: 'grok',
  scope: 'workspace',
  runtimeProfileId: 'builtin:grok:global',
  ...overrides
})

describe('applyRuntimeProfileToPayload — read-only is a safety floor', () => {
  it('does NOT loosen an explicit read-only (plan) seat to a write-capable profile default', () => {
    // The live regression: builtin:grok:global (approvalMode 'default') clobbered
    // a user's explicit "Plan / Read-only" choice, turning the seat write-capable.
    const out = applyRuntimeProfileToPayload(
      payload({ approvalMode: 'plan' }),
      depsWith(makeProfile({ approvalMode: 'default' }))
    )
    expect(out.approvalMode).toBe('plan')
  })

  it('still applies the profile mode for a non-read-only seat', () => {
    const out = applyRuntimeProfileToPayload(
      payload({ approvalMode: 'acceptEdits' }),
      depsWith(makeProfile({ approvalMode: 'default' }))
    )
    expect(out.approvalMode).toBe('default')
  })

  it('lets a profile TIGHTEN a non-read-only seat to read-only', () => {
    const out = applyRuntimeProfileToPayload(
      payload({ approvalMode: 'default' }),
      depsWith(makeProfile({ approvalMode: 'plan' }))
    )
    expect(out.approvalMode).toBe('plan')
  })

  it('does NOT raise a verified default seat to auto_edit via runtime profile', () => {
    const out = applyRuntimeProfileToPayload(
      payload({ approvalMode: 'default' }),
      depsWith(makeProfile({ approvalMode: 'auto_edit' }))
    )
    expect(out.approvalMode).toBe('default')
  })

  it('preserves an explicit auto_edit seat when the matching profile is also auto_edit', () => {
    const out = applyRuntimeProfileToPayload(
      payload({ approvalMode: 'auto_edit' }),
      depsWith(makeProfile({ approvalMode: 'auto_edit' }))
    )
    expect(out.approvalMode).toBe('auto_edit')
  })

  it('leaves approvalMode untouched when no runtime profile id is set', () => {
    const out = applyRuntimeProfileToPayload(
      { provider: 'grok', scope: 'workspace', approvalMode: 'plan' },
      depsWith(makeProfile())
    )
    expect(out.approvalMode).toBe('plan')
  })
})

describe('runtimeSettings', () => {
  const baseSettings = {
    agenticServices: {
      shellCommands: 'ask',
      fileChanges: 'deny',
      externalPublish: 'ask',
      mcpTools: 'ask',
      subThreadDelegation: 'workspace',
      networkAccess: 'deny'
    }
  } as AppSettings

  it('allows runtime profiles to tighten but not loosen agentic services', () => {
    const settings = runtimeSettings(
      baseSettings,
      makeProfile({
        agenticServices: {
          shellCommands: 'allow',
          fileChanges: 'allow',
          externalPublish: 'allow',
          mcpTools: 'deny',
          subThreadDelegation: 'allow',
          canvasInteraction: 'ask',
          canvasEval: 'ask',
          networkAccess: 'allow'
        }
      })
    )

    expect(settings.agenticServices.shellCommands).toBe('ask')
    expect(settings.agenticServices.fileChanges).toBe('deny')
    expect(settings.agenticServices.externalPublish).toBe('ask')
    expect(settings.agenticServices.mcpTools).toBe('deny')
    expect(settings.agenticServices.subThreadDelegation).toBe('workspace')
    expect(settings.agenticServices.networkAccess).toBe('deny')
  })
})

describe('createCliEnv', () => {
  it('scrubs signing and publishing credentials after merging process/profile/extra env', () => {
    const env = createCliEnv(
      {
        TASKWRAITH_RUNTIME_PROFILE_ID: 'profile-1',
        GH_TOKEN: 'extra-gh',
        FORCE_COLOR: '0'
      },
      null,
      {
        getRuntimeProfiles: () => [
          makeProfile({
            id: 'profile-1',
            env: {
              APPLE_ID: 'profile-apple',
              CSC_LINK: 'profile-csc',
              SAFE_PROFILE_FLAG: 'kept'
            }
          })
        ]
      }
    )

    expect(env.GH_TOKEN).toBeUndefined()
    expect(env.APPLE_ID).toBeUndefined()
    expect(env.CSC_LINK).toBeUndefined()
    expect(env.SAFE_PROFILE_FLAG).toBe('kept')
    expect(env.FORCE_COLOR).toBe('0')
  })

  it('resolves runtime profile secret env refs and lets encrypted values beat plaintext profile env', () => {
    const env = createCliEnv(
      {
        TASKWRAITH_RUNTIME_PROFILE_ID: 'profile-1',
        FORCE_COLOR: '0'
      },
      null,
      {
        getRuntimeProfiles: () => [
          makeProfile({
            id: 'profile-1',
            env: {
              SAFE_PROFILE_FLAG: 'kept',
              SERVICE_TOKEN: 'plaintext-placeholder'
            },
            secretRefs: {
              env: ['SERVICE_TOKEN']
            }
          })
        ],
        resolveExtensionSecretValues: (refs) =>
          refs.map((ref) => ({
            ref,
            status: 'ok' as const,
            value: ref.fieldName === 'SERVICE_TOKEN' ? 'encrypted-token' : ''
          }))
      }
    )

    expect(env.SAFE_PROFILE_FLAG).toBe('kept')
    expect(env.SERVICE_TOKEN).toBe('encrypted-token')
  })

  it('fails closed when a runtime profile secret env ref cannot be resolved', () => {
    expect(() =>
      createCliEnv(
        {
          TASKWRAITH_RUNTIME_PROFILE_ID: 'profile-1',
          FORCE_COLOR: '0'
        },
        null,
        {
          getRuntimeProfiles: () => [
            makeProfile({
              id: 'profile-1',
              secretRefs: {
                env: ['SERVICE_TOKEN']
              }
            })
          ],
          resolveExtensionSecretValues: (refs) =>
            refs.map((ref) => ({
              ref,
              status: 'missing' as const
            }))
        }
      )
    ).toThrow(/encrypted env secret SERVICE_TOKEN is missing/)
  })
})

describe('getCliProviderMcpStatus', () => {
  it('keeps Claude MCP available for user-managed servers when the TaskWraith bridge is off', () => {
    const status = getCliProviderMcpStatus('claude', {
      getSettings: () =>
        ({
          geminiMcpBridgeEnabled: false,
          userMcpServers: [
            {
              id: 'docs',
              name: 'Docs',
              enabled: true,
              transport: 'http',
              url: 'https://example.test/mcp'
            }
          ]
        }) as AppSettings
    })

    expect(status.available).toBe(true)
    expect(status.enabled).toBe(true)
    expect(status.source).toBe('provider')
    expect(status.serverName).toBe('User MCP servers')
    expect(status.tools).toEqual([])
    expect(status.message).toContain('1 user-managed MCP server')
    expect(status.message).toContain('TaskWraith MCP bridge is disabled')
  })
})
