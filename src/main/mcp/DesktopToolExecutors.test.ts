import { describe, expect, it, vi } from 'vitest'

import {
  createDesktopToolExecutors,
  type DesktopToolContext,
  type DesktopToolExecutorDeps
} from './DesktopToolExecutors'
import type {
  AgenticWorkspaceGrant,
  AppSettings,
  ChatRecord,
  HandoffCard,
  RunEventFilter,
  RunEventRecord,
  RunEventReplay
} from '../store/types'

function chat(appChatId: string, runIds: string[]): ChatRecord {
  return {
    appChatId,
    title: appChatId,
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    messages: [],
    runs: runIds.map((runId) => ({ runId, startedAt: '2026-07-18T00:00:00.000Z' }))
  }
}

function replay(runId: string, events: RunEventRecord[] = []): RunEventReplay {
  return {
    runId,
    events,
    count: events.length,
    lastSequence: events[events.length - 1]?.sequence || 0,
    hashChainValid: true,
    countsByKind: {},
    timeline: [],
    approvalIds: []
  }
}

function event(input: Partial<RunEventRecord> = {}): RunEventRecord {
  return {
    schemaVersion: 1,
    id: 'event-a',
    sequence: 1,
    runId: 'run-history',
    chatId: 'chat-a',
    kind: 'reference_context',
    phase: 'artifact',
    source: 'main',
    timestamp: '2026-07-18T00:00:00.000Z',
    ...input
  }
}

function createExecutor(input: {
  chats: ChatRecord[]
  settings?: AppSettings
  replays?: Record<string, RunEventReplay>
  rawEvents?: RunEventRecord[]
  providerAuth?: DesktopToolExecutorDeps['providerAuth']
}) {
  const chats = new Map(input.chats.map((item) => [item.appChatId, item]))
  const getRunEventReplay = vi.fn(
    (runId: string) => input.replays?.[runId] || replay(runId)
  )
  const getRunEvents = vi.fn((_filter?: RunEventFilter) => input.rawEvents || [])
  const deps: DesktopToolExecutorDeps = {
    getBridgeDaemon: () => null,
    getCreativeApprovalGate: () => null,
    attachedWindow: {
      get: () => null,
      set: () => undefined
    },
    store: {
      getSettings: () => input.settings || ({} as AppSettings),
      getApprovalLedger: () => [],
      getProviderUsageSnapshot: () => null,
      getChat: (chatId) => chats.get(chatId) || null,
      saveChat: () => undefined,
      getHandoffCards: () => [],
      saveHandoffCard: (handoff) => handoff as HandoffCard
    },
    runRepository: { getRunEventReplay, getRunEvents },
    shell: {
      showItemInFolder: () => undefined,
      openPath: async () => ''
    },
    ...(input.providerAuth ? { providerAuth: input.providerAuth } : {})
  }
  return { executor: createDesktopToolExecutors(deps), getRunEventReplay, getRunEvents }
}

const activeContext: DesktopToolContext = {
  scope: 'workspace',
  cwd: '/workspace',
  workspacePath: '/workspace',
  appChatId: 'chat-a',
  appRunId: 'run-current'
}

describe('DesktopToolExecutors run history scope', () => {
  it('allows the current run and historical runs recorded by the active chat', () => {
    const { executor, getRunEventReplay } = createExecutor({
      chats: [chat('chat-a', ['run-history'])],
      replays: {
        'run-current': replay('run-current'),
        'run-history': replay('run-history')
      }
    })

    expect(executor.executeRunTimeline({}, activeContext)).toMatchObject({ runId: 'run-current' })
    expect(executor.executeRunTimeline({ runId: 'run-history' }, activeContext)).toMatchObject({
      runId: 'run-history'
    })
    expect(getRunEventReplay).toHaveBeenCalledTimes(2)
  })

  it('rejects cross-chat and unknown run ids before opening a replay', () => {
    const { executor, getRunEventReplay } = createExecutor({
      chats: [chat('chat-a', ['run-history']), chat('chat-b', ['run-other'])]
    })

    expect(() => executor.executeRunTimeline({ runId: 'run-other' }, activeContext)).toThrow(
      'run_timeline can only inspect the active run or a run from the active chat.'
    )
    expect(() => executor.executeRunTimeline({ runId: 'run-unknown' }, activeContext)).toThrow(
      'run_timeline can only inspect the active run or a run from the active chat.'
    )
    expect(getRunEventReplay).not.toHaveBeenCalled()
  })

  it('redacts private artifact paths from timeline events without dropping safe fields', () => {
    const privateSnapshotPath = '/private/taskwraith/project-reference-snapshots/abc.snapshot'
    const { executor } = createExecutor({
      chats: [chat('chat-a', ['run-history'])],
      replays: {
        'run-history': replay('run-history', [
          event({
            artifacts: [
              {
                id: 'project-reference:abc',
                kind: 'snapshot',
                path: privateSnapshotPath,
                sha256: 'a'.repeat(64),
                sizeBytes: 42,
                sequence: 1,
                metadata: { source: 'project_reference_context', referenceTitle: 'Brief' }
              }
            ]
          })
        ])
      }
    })

    const result = executor.executeRunTimeline(
      { runId: 'run-history', includeEvents: true },
      activeContext
    )

    expect(result.events?.[0]?.artifacts).toEqual([
      {
        id: 'project-reference:abc',
        kind: 'snapshot',
        sha256: 'a'.repeat(64),
        sizeBytes: 42,
        sequence: 1,
        metadata: { source: 'project_reference_context', referenceTitle: 'Brief' }
      }
    ])
    expect(JSON.stringify(result)).not.toContain(privateSnapshotPath)
  })

  it('keeps raw provider event queries in the active chat and redacts their artifact paths', () => {
    const privateArtifactPath = '/private/taskwraith/run-artifacts/run-current/stdout.log'
    const { executor, getRunEvents } = createExecutor({
      chats: [chat('chat-a', ['run-history']), chat('chat-b', ['run-other'])],
      rawEvents: [
        event({
          runId: 'run-history',
          kind: 'provider_raw',
          phase: 'raw',
          source: 'provider',
          artifacts: [
            {
              id: 'run-history:stdout:1',
              kind: 'stdout',
              path: privateArtifactPath,
              sha256: 'b'.repeat(64),
              sizeBytes: 9
            }
          ]
        })
      ]
    })

    expect(() => executor.executeRawProviderEvents({ chatId: 'chat-b' }, activeContext)).toThrow(
      'raw_provider_events can only inspect the active chat.'
    )
    expect(() => executor.executeRawProviderEvents({ runId: 'run-other' }, activeContext)).toThrow(
      'raw_provider_events can only inspect the active run or a run from the active chat.'
    )
    expect(getRunEvents).not.toHaveBeenCalled()

    const result = executor.executeRawProviderEvents({ runId: 'run-history' }, activeContext)
    expect(getRunEvents).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run-history', kinds: ['provider_raw', 'provider_error', 'provider_exit'] })
    )
    expect(result.events[0]?.artifacts).toEqual([
      {
        id: 'run-history:stdout:1',
        kind: 'stdout',
        sha256: 'b'.repeat(64),
        sizeBytes: 9
      }
    ])
    expect(JSON.stringify(result)).not.toContain(privateArtifactPath)
  })
})

describe('DesktopToolExecutors Kimi auth projection', () => {
  function providerAuth(
    status: { available: boolean; authState: string; error?: string },
    storedKimiApiKey: unknown = null
  ): NonNullable<DesktopToolExecutorDeps['providerAuth']> {
    return {
      getGeminiAuthStatusSnapshot: async () => {
        throw new Error('not used by Kimi projection')
      },
      getCodexStatusSnapshot: async () => {
        throw new Error('not used by Kimi projection')
      },
      getCliProviderStatus: async () => status,
      getStoredClaudeApiKey: () => null,
      getStoredKimiApiKey: () => storedKimiApiKey,
      encryptionAvailable: () => true,
      isCodexClientStarted: () => false
    }
  }

  it('distinguishes OAuth-only, provider-key, and unqualified Kimi states', async () => {
    const oauth = createExecutor({
      chats: [],
      providerAuth: providerAuth({ available: true, authState: 'oauth' })
    })
    await expect(oauth.executor.executeProviderAuthStatus({ provider: 'kimi' })).resolves.toMatchObject(
      {
        providers: {
          kimi: {
            authState: 'authenticated',
            apiKeyConfigured: false,
            mcpStatusSupport: true
          }
        }
      }
    )

    const managedProviderKey = createExecutor({
      chats: [],
      providerAuth: providerAuth({ available: true, authState: 'api-key' })
    })
    await expect(
      managedProviderKey.executor.executeProviderAuthStatus({ provider: 'kimi' })
    ).resolves.toMatchObject({
      providers: {
        kimi: { authState: 'authenticated', apiKeyConfigured: false }
      }
    })

    const settingsUsageKey = createExecutor({
      chats: [],
      providerAuth: providerAuth({ available: true, authState: 'unknown' }, 'stored-key')
    })
    await expect(
      settingsUsageKey.executor.executeProviderAuthStatus({ provider: 'kimi' })
    ).resolves.toMatchObject({
      providers: {
        kimi: { authState: 'not-observable', apiKeyConfigured: true }
      }
    })

    const unqualified = createExecutor({
      chats: [],
      providerAuth: providerAuth({
        available: false,
        authState: 'oauth',
        error: 'Kimi inventory does not advertise the qualified ACP-only transport posture.'
      })
    })
    await expect(
      unqualified.executor.executeProviderAuthStatus({ provider: 'kimi' })
    ).resolves.toMatchObject({
      providers: {
        kimi: {
          serverState: 'unavailable',
          authState: 'missing',
          authReason: expect.stringContaining('ACP-only transport posture')
        }
      }
    })
  })
})

describe('DesktopToolExecutors Codex auth projection', () => {
  it('uses the private-home app-server snapshot instead of the generic CLI probe', async () => {
    const getCliProviderStatus = vi.fn(async () => ({
      available: true,
      authState: 'unknown'
    }))
    const getCodexStatusSnapshot = vi.fn(async () => ({
      available: true,
      appServer: 'started',
      authState: 'missing',
      requiresOpenaiAuth: true,
      setupRequired: true
    }))
    const { executor } = createExecutor({
      chats: [],
      providerAuth: {
        getGeminiAuthStatusSnapshot: async () => {
          throw new Error('not used by Codex projection')
        },
        getCodexStatusSnapshot,
        getCliProviderStatus,
        getStoredClaudeApiKey: () => null,
        getStoredKimiApiKey: () => null,
        encryptionAvailable: () => true,
        isCodexClientStarted: () => true
      }
    })

    await expect(
      executor.executeProviderAuthStatus({ provider: 'codex' })
    ).resolves.toMatchObject({
      providers: {
        codex: {
          authState: 'missing',
          requiresOpenaiAuth: true,
          setupRequired: true,
          serverState: 'started',
          transport: 'app-server'
        }
      }
    })
    expect(getCodexStatusSnapshot).toHaveBeenCalledOnce()
    expect(getCliProviderStatus).not.toHaveBeenCalled()
  })
})

describe('DesktopToolExecutors approval status workspace grants', () => {
  it("reports 'agents' wildcard grants alongside the caller's own legacy rows", () => {
    const grants: AgenticWorkspaceGrant[] = [
      {
        id: 'grant-agents',
        provider: 'agents',
        workspacePath: '/workspace',
        service: 'fileChanges',
        createdAt: '2026-07-28T00:00:00.000Z',
        updatedAt: '2026-07-28T00:00:00.000Z'
      },
      {
        id: 'grant-legacy-codex',
        provider: 'codex',
        workspacePath: '/workspace',
        service: 'fileChanges',
        createdAt: '2026-07-28T00:00:00.000Z',
        updatedAt: '2026-07-28T00:00:00.000Z'
      },
      {
        id: 'grant-agents-elsewhere',
        provider: 'agents',
        workspacePath: '/elsewhere',
        service: 'fileChanges',
        createdAt: '2026-07-28T00:00:00.000Z',
        updatedAt: '2026-07-28T00:00:00.000Z'
      }
    ]
    const { executor } = createExecutor({
      chats: [chat('chat-a', [])],
      settings: { agenticWorkspaceGrants: grants } as AppSettings
    })

    // 'agents' rows report for any caller; the legacy codex row stays scoped
    // to codex; the other-workspace row is filtered by path.
    const claudeResult = executor.executeApprovalStatus(activeContext, {}, 'claude') as {
      workspaceGrants: AgenticWorkspaceGrant[]
    }
    expect(claudeResult.workspaceGrants.map((grant) => grant.id)).toEqual(['grant-agents'])

    const codexResult = executor.executeApprovalStatus(activeContext, {}, 'codex') as {
      workspaceGrants: AgenticWorkspaceGrant[]
    }
    expect(codexResult.workspaceGrants.map((grant) => grant.id)).toEqual([
      'grant-agents',
      'grant-legacy-codex'
    ])
  })
})
