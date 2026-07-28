import { promises as fs } from 'fs'
import { describe, it, expect, vi } from 'vitest'
import {
  applyRuntimeProfileToPayload,
  createCliEnv,
  createCliProviderRunEnv,
  getCliProviderStatus,
  getCliProviderMcpStatus,
  getAgentMcpStatusSnapshotDirect,
  getAgentStatusSnapshotDirect,
  readResolvedCliVersion,
  runtimeSettings,
  type CliProviderRuntimeDependencies,
  type RuntimeProfilePayload
} from './CliProviderRuntime'
import type { AppSettings, EffectiveRunPermissions, RuntimeProfile } from '../store/types'

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

function fullAccessPermissions(): EffectiveRunPermissions {
  return {
    presetId: 'full_access',
    approvalMode: 'auto_edit',
    agenticServices: {
      shellCommands: 'allow',
      fileChanges: 'allow',
      externalPublish: 'allow',
      mcpTools: 'allow',
      subThreadDelegation: 'allow',
      canvasInteraction: 'allow',
      sketchCanvas: 'allow',
      meshCanvas: 'allow',
      canvasEval: 'ask',
      crossThreadRead: 'allow',
      threadMessage: 'allow',
      mediaEditing: 'allow',
      mediaRecording: 'deny'
    },
    networkAccess: 'allow',
    externalPathGrants: [],
    workspaceGrantServiceIds: [],
    readOnly: false
  }
}

function settingsWithServices(agenticServices: AppSettings['agenticServices']): AppSettings {
  return {
    agenticServices,
    agenticWorkspaceGrants: []
  } as unknown as AppSettings
}

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

  it('re-derives the signed service map when a profile tightens auto_edit to default', () => {
    const out = applyRuntimeProfileToPayload(
      payload({
        workspace: '/repo',
        approvalMode: 'auto_edit',
        effectivePermissions: fullAccessPermissions()
      }),
      {
        ...depsWith(
          makeProfile({
            approvalMode: 'default',
            agenticServices: { fileChanges: 'deny' }
          })
        ),
        getSettings: () =>
          settingsWithServices({
            shellCommands: 'ask',
            fileChanges: 'ask',
            externalPublish: 'ask',
            mcpTools: 'ask',
            subThreadDelegation: 'ask',
            canvasInteraction: 'ask',
            sketchCanvas: 'allow',
            canvasEval: 'ask',
            crossThreadRead: 'ask',
            threadMessage: 'ask',
            mediaEditing: 'ask',
            mediaRecording: 'deny',
            networkAccess: 'allow'
          })
      }
    )

    expect(out.approvalMode).toBe('default')
    expect(out.effectivePermissions).toMatchObject({
      presetId: 'default',
      approvalMode: 'default',
      readOnly: false,
      agenticServices: {
        shellCommands: 'ask',
        fileChanges: 'deny'
      }
    })
  })

  it('re-derives the read-only service map when a profile tightens auto_edit to plan', () => {
    const out = applyRuntimeProfileToPayload(
      payload({
        workspace: '/repo',
        approvalMode: 'auto_edit',
        effectivePermissions: fullAccessPermissions()
      }),
      {
        ...depsWith(makeProfile({ approvalMode: 'plan' })),
        getSettings: () =>
          settingsWithServices({
            shellCommands: 'allow',
            fileChanges: 'allow',
            externalPublish: 'allow',
            mcpTools: 'allow',
            subThreadDelegation: 'allow',
            canvasInteraction: 'allow',
            sketchCanvas: 'allow',
            canvasEval: 'ask',
            crossThreadRead: 'allow',
            threadMessage: 'allow',
            mediaEditing: 'allow',
            mediaRecording: 'deny',
            networkAccess: 'allow'
          })
      }
    )

    expect(out.approvalMode).toBe('plan')
    expect(out.effectivePermissions).toMatchObject({
      presetId: 'read_only',
      approvalMode: 'plan',
      readOnly: true,
      agenticServices: {
        shellCommands: 'deny',
        fileChanges: 'deny',
        subThreadDelegation: 'deny',
        crossThreadRead: 'deny',
        threadMessage: 'deny'
      }
    })
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

  it('stamps worktree runtime intent for workspace-scoped worktree profiles', () => {
    const out = applyRuntimeProfileToPayload(
      payload({
        runtimeProfileId: 'profile-worktree',
        workspace: '/repo',
        approvalMode: 'default'
      }),
      depsWith(
        makeProfile({
          id: 'profile-worktree',
          name: 'Grok worktree',
          workspaceMode: 'worktree'
        })
      )
    )

    expect(out.runtimeWorktree).toEqual({
      requested: true,
      source: 'runtimeProfile',
      profileId: 'profile-worktree',
      profileName: 'Grok worktree',
      baseWorkspacePath: '/repo',
      effectiveWorkspacePath: undefined,
      status: 'selection-required'
    })
  })

  it('preserves an already selected composer worktree path while adding profile provenance', () => {
    const out = applyRuntimeProfileToPayload(
      payload({
        runtimeProfileId: 'profile-worktree',
        workspace: '/repo',
        runtimeWorktree: {
          requested: true,
          source: 'composer',
          baseWorkspacePath: '/repo',
          effectiveWorkspacePath: '/repo-worktrees/task',
          status: 'selected'
        }
      }),
      depsWith(makeProfile({ id: 'profile-worktree', workspaceMode: 'worktree' }))
    )

    expect(out.runtimeWorktree).toMatchObject({
      requested: true,
      source: 'composer',
      profileId: 'profile-worktree',
      baseWorkspacePath: '/repo',
      effectiveWorkspacePath: '/repo-worktrees/task',
      status: 'selected'
    })
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
          sketchCanvas: 'allow',
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

  it('builds the exact one-shot dispatch routing environment', () => {
    const env = createCliProviderRunEnv({
      provider: 'cursor',
      command: '/opt/taskwraith/bin/cursor-agent',
      appRunId: 'run-1',
      appChatId: 'chat-1',
      scope: 'workspace',
      workspace: '/repo',
      runtimeProfileId: 'profile-1',
      auditRun: true,
      extraEnv: { SCHEDULED_OCCURRENCE: '1' },
      deps: {
        getRuntimeProfiles: () => [makeProfile({ id: 'profile-1', env: { PROFILE: 'yes' } })]
      }
    })

    expect(env).toMatchObject({
      FORCE_COLOR: '0',
      NO_COLOR: '1',
      TASKWRAITH_PARENT_PROVIDER: 'cursor',
      TASKWRAITH_RUN_ID: 'run-1',
      TASKWRAITH_CHAT_ID: 'chat-1',
      TASKWRAITH_WORKSPACE_PATH: '/repo',
      TASKWRAITH_RUNTIME_PROFILE_ID: 'profile-1',
      TASKWRAITH_MCP_AUDIT: '1',
      SCHEDULED_OCCURRENCE: '1',
      PROFILE: 'yes'
    })
  })
})

describe('getCliProviderMcpStatus', () => {
  it('returns static Cursor provider-managed MCP status without consulting settings', () => {
    const getSettings = vi.fn(() => {
      throw new Error('must not read settings')
    })
    const status = getCliProviderMcpStatus('cursor', { getSettings })

    expect(status).toMatchObject({
      provider: 'cursor',
      available: false,
      enabled: false,
      source: 'provider-managed',
      serverName: null,
      tools: [],
      sections: []
    })
    expect(status.message).toMatch(/provider-managed/i)
    expect(status.message).toMatch(/Path-B|OS sandbox|not injected/i)
    expect(getSettings).not.toHaveBeenCalled()
  })

  it('keeps the direct MCP wrapper explicit for Cursor adapters', async () => {
    const getSettings = vi.fn(() => {
      throw new Error('must not read settings')
    })

    await expect(getAgentMcpStatusSnapshotDirect('cursor', { getSettings })).resolves.toMatchObject({
      provider: 'cursor',
      available: false,
      enabled: false,
      source: 'provider-managed',
      serverName: null,
      tools: []
    })
    expect(getSettings).not.toHaveBeenCalled()
  })

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

describe('Cursor CLI status/version (un-gated: normal provider)', () => {
  it('probes for version instead of returning the removed static security-unavailable sentinel', async () => {
    // Cursor is un-gated (no per-build fingerprint / no-process status gate): it
    // resolves + probes like a normal CLI provider. Version discovery actually
    // probes the binary, so a non-existent binary yields a probe error, NOT the
    // old 'security-unavailable' sentinel.
    const version = await readResolvedCliVersion({
      provider: 'cursor',
      binaryPath: '/definitely/not/a/real/cursor-agent-sentinel',
      source: 'settings'
    })
    expect(version).not.toBe('security-unavailable')
  })
})

describe('Pi CLI status', () => {
  it('keeps Pi on its own generic CLI status path instead of the Gemini fallback', async () => {
    const stat = vi
      .spyOn(fs, 'stat')
      .mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
    try {
      await expect(
        getAgentStatusSnapshotDirect('pi', {
          env: { PATH: '' },
          getRuntimeProfiles: () => [],
          getSettings: () => ({}) as AppSettings
        })
      ).resolves.toMatchObject({ provider: 'pi' })
    } finally {
      stat.mockRestore()
    }
  })
})

describe('Kimi status admission', () => {
  it('fails closed without the reviewed status seam and starts no generic discovery path', async () => {
    const getSettings = vi.fn(() => {
      throw new Error('must not read settings')
    })
    const getRuntimeProfiles = vi.fn(() => {
      throw new Error('must not resolve profiles')
    })

    await expect(
      getCliProviderStatus('kimi', { getSettings, getRuntimeProfiles })
    ).resolves.toMatchObject({
      provider: 'kimi',
      available: false,
      setupRequired: true,
      binaryPath: null,
      version: 'admission-required',
      appServer: 'acp-admission-required'
    })
    expect(getSettings).not.toHaveBeenCalled()
    expect(getRuntimeProfiles).not.toHaveBeenCalled()
  })
})
