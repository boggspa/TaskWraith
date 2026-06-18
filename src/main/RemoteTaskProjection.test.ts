import { describe, expect, it } from 'vitest'
import type { ChatRecord, ChatRun, DiffFileSummary, ExternalPathGrant } from './store/types'
import {
  buildMobileDiffSummary,
  buildMobileQuestionCard,
  buildRemoteProjectionEnvelope,
  buildRemoteShellAppearance,
  buildRemoteTaskCard,
  buildRemoteTaskFeedSnapshot
} from './RemoteTaskProjection'

const NOW = Date.UTC(2026, 4, 30, 12, 0, 0)
const ISO = new Date(NOW).toISOString()

function chat(overrides: Partial<ChatRecord> = {}): ChatRecord {
  return {
    appChatId: 'chat-1',
    scope: 'workspace',
    provider: 'codex',
    title: 'Implement remote console',
    workspaceId: 'ws-1',
    workspacePath: '/repo',
    createdAt: NOW - 1000,
    updatedAt: NOW,
    archived: false,
    messages: [
      {
        id: 'm1',
        role: 'assistant',
        content: 'Working on the projection path',
        timestamp: ISO
      }
    ],
    runs: [],
    ...overrides
  }
}

function file(
  path: string,
  status: DiffFileSummary['status'],
  additions = 0,
  deletions = 0
): DiffFileSummary {
  return {
    path,
    status,
    additions,
    deletions,
    previewKind: status === 'deleted' ? 'none' : 'git_diff'
  }
}

function run(overrides: Partial<ChatRun> = {}): ChatRun {
  return {
    runId: 'run-1',
    provider: 'codex',
    startedAt: '2026-05-30T11:59:00.000Z',
    status: 'running',
    ...overrides
  }
}

function externalGrant(overrides: Partial<ExternalPathGrant> = {}): ExternalPathGrant {
  return {
    id: 'grant-1',
    provider: 'codex',
    path: '/other',
    kind: 'directory',
    access: 'read',
    duration: 'thisThread',
    createdAt: ISO,
    ...overrides
  }
}

describe('RemoteTaskProjection', () => {
  it('wraps Mac-authored payloads in a stable projection envelope', () => {
    const payload = { promptId: 'q1' }
    const envelope = buildRemoteProjectionEnvelope({
      kind: 'questionCard',
      payload,
      generatedAt: ISO,
      threadId: 'chat-1',
      runId: 'run-1',
      workspaceId: 'ws-1',
      envelopeId: 'env-1'
    })
    expect(envelope).toEqual({
      schemaVersion: 1,
      envelopeId: 'env-1',
      source: 'mac',
      kind: 'questionCard',
      generatedAt: ISO,
      workspaceId: 'ws-1',
      threadId: 'chat-1',
      runId: 'run-1',
      payload
    })
  })

  it('projects privacy-safe shell appearance settings and semantic colors', () => {
    const appearance = buildRemoteShellAppearance(
      {
        appearanceMode: 'native_glass',
        visualEffectStyle: 'liquid_glass',
        themeAppearance: 'obsidian',
        themeCornerStyle: 'hard',
        themeAccentStyle: 'purple',
        promptSurfaceStyle: 'liquid_glass',
        composerStyle: 'claude',
        reduceTransparency: true,
        reduceMotion: true,
        compactDensity: true
      },
      { generatedAt: ISO }
    )

    expect(appearance).toMatchObject({
      schemaVersion: 1,
      generatedAt: ISO,
      appearanceMode: 'native_glass',
      visualEffectStyle: 'liquid_glass',
      themeAppearance: 'obsidian',
      themeCornerStyle: 'hard',
      themeAccentStyle: 'purple',
      promptSurfaceStyle: 'liquid_glass',
      composerStyle: 'claude',
      reduceTransparency: true,
      reduceMotion: true,
      compactDensity: true,
      preferredColorScheme: 'dark',
      colors: {
        accent: '#bf7cff',
        windowBase: { light: '#f4f6f8', dark: '#141414' },
        composerSurface: { light: '#ffffffc7', dark: '#071024eb' }
      }
    })
  })

  it('builds a bounded task feed sorted by recent activity', () => {
    const question = buildMobileQuestionCard({
      questionId: 'q1',
      threadId: 'chat-2',
      workspaceId: 'ws-1',
      provider: 'codex',
      question: 'Ship this option?',
      createdAt: ISO
    })
    const snapshot = buildRemoteTaskFeedSnapshot({
      generatedAt: ISO,
      maxTasks: 2,
      questions: [question],
      chats: [
        chat({ appChatId: 'chat-1', updatedAt: NOW - 1000 }),
        chat({ appChatId: 'chat-2', updatedAt: NOW, runs: [run()] }),
        chat({ appChatId: 'chat-3', updatedAt: NOW - 2000 })
      ]
    })

    expect(snapshot.tasks.map((task) => task.threadId)).toEqual(['chat-2', 'chat-1'])
    expect(snapshot.totalTasks).toBe(3)
    expect(snapshot.truncated).toBe(true)
    expect(snapshot.tasks[0].status).toBe('awaitingQuestion')
    expect(snapshot.totalPendingQuestions).toBe(1)
  })

  it('projects task card status, preview and latest run details', () => {
    const card = buildRemoteTaskCard(
      chat({
        activeGoal: {
          id: 'goal-1',
          objective: 'Finish the goal rail',
          status: 'active',
          mode: 'taskwraith_steered',
          provider: 'codex',
          createdAt: ISO,
          updatedAt: ISO
        },
        runs: [
          run({ runId: 'old', startedAt: '2026-05-30T11:00:00.000Z', status: 'success' }),
          run({ runId: 'new', startedAt: '2026-05-30T12:00:00.000Z', status: 'running' })
        ]
      }),
      { pendingApprovalCount: 1 }
    )
    expect(card).toMatchObject({
      id: 'chat-1',
      runId: 'new',
      latestRunId: 'new',
      status: 'awaitingApproval',
      preview: 'Working on the projection path',
      pendingApprovalCount: 1,
      activeGoal: {
        id: 'goal-1',
        objective: 'Finish the goal rail',
        status: 'active'
      }
    })
  })

  it('projects provider model metadata for remote composer seeding', () => {
    const card = buildRemoteTaskCard(
      chat({
        provider: 'codex',
        parentChatId: 'parent-1',
        parentChatRelation: 'sideChat',
        sideChatContext: {
          createdAt: NOW,
          mode: 'singleProvider',
          lifecycleState: 'active',
          transcriptVisibility: 'none'
        },
        providerMetadata: {
          selectedModelType: 'gpt-5.5',
          customModel: '',
          codexReasoningEffort: 'xhigh',
          claudeReasoningEffort: 'off'
        }
      })
    )

    expect(card).toMatchObject({
      provider: 'codex',
      parentChatRelation: 'sideChat',
      sideChatMode: 'singleProvider',
      selectedModelType: 'gpt-5.5',
      codexReasoningEffort: 'xhigh',
      claudeReasoningEffort: 'off'
    })
    expect(card.customModel).toBeUndefined()
  })

  it('projects sanitized additional workspace rows from external path grants', () => {
    const card = buildRemoteTaskCard(
      chat({
        providerMetadata: {
          externalPathGrants: [
            externalGrant({
              id: 'grant-primary',
              provider: 'codex',
              path: '/repo',
              access: 'write',
              securityScopedBookmark: 'secret-bookmark',
              signature: 'secret-signature'
            }),
            externalGrant({
              id: 'grant-read',
              provider: 'codex',
              path: '/other',
              access: 'read',
              order: 3,
              securityScopedBookmark: 'secret-bookmark',
              signature: 'secret-signature'
            }),
            externalGrant({
              id: 'grant-write',
              provider: 'gemini',
              path: '/other',
              access: 'write',
              order: 2
            }),
            externalGrant({
              id: 'grant-doc',
              provider: 'claude',
              path: '/docs/brief.md',
              kind: 'file',
              access: 'read',
              order: 1
            })
          ]
        }
      })
    )

    expect(card.additionalWorkspaces).toEqual([
      {
        id: '/docs/brief.md',
        path: '/docs/brief.md',
        kind: 'file',
        access: 'read',
        providers: ['claude'],
        order: 1
      },
      {
        id: '/other',
        path: '/other',
        kind: 'directory',
        access: 'write',
        providers: ['codex', 'gemini'],
        order: 2
      }
    ])
    expect(JSON.stringify(card.additionalWorkspaces)).not.toContain('secret')
  })

  it('projects child-thread relation metadata used by the iOS Agents tab', () => {
    const guest = buildRemoteTaskCard(
      chat({
        appChatId: 'guest-1',
        parentChatId: 'parent-1',
        parentChatRelation: 'sideChat',
        sideChatContext: {
          createdAt: NOW,
          mode: 'guestParticipant',
          lifecycleState: 'active',
          transcriptVisibility: 'none'
        }
      })
    )
    const sideChat = buildRemoteTaskCard(
      chat({
        appChatId: 'side-1',
        parentChatId: 'parent-1',
        parentChatRelation: 'sideChat',
        sideChatContext: {
          createdAt: NOW,
          mode: 'singleProvider',
          lifecycleState: 'active',
          transcriptVisibility: 'none'
        }
      })
    )
    const subThread = buildRemoteTaskCard(
      chat({
        appChatId: 'sub-1',
        parentChatId: 'parent-1',
        parentChatRelation: 'subThread'
      })
    )

    expect(guest).toMatchObject({
      id: 'guest-1',
      parentChatId: 'parent-1',
      parentChatRelation: 'sideChat',
      sideChatMode: 'guestParticipant',
      sideChatLifecycleState: 'active'
    })
    expect(sideChat).toMatchObject({
      id: 'side-1',
      parentChatId: 'parent-1',
      parentChatRelation: 'sideChat',
      sideChatMode: 'singleProvider'
    })
    expect(subThread).toMatchObject({
      id: 'sub-1',
      parentChatId: 'parent-1',
      parentChatRelation: 'subThread'
    })
  })

  it('projects the closed lifecycle of a removed guest so the phone can drop its chip', () => {
    // removeGuestParticipant marks the guest child `closed` (it is not deleted),
    // so the card MUST carry the lifecycle for the phone's active-guest detector
    // to filter it out — otherwise the composer guest chip lingers after removal.
    const closedGuest = buildRemoteTaskCard(
      chat({
        appChatId: 'guest-closed',
        parentChatId: 'parent-1',
        parentChatRelation: 'sideChat',
        sideChatContext: {
          createdAt: NOW,
          mode: 'guestParticipant',
          lifecycleState: 'closed',
          closedAt: NOW,
          transcriptVisibility: 'none'
        }
      })
    )
    expect(closedGuest).toMatchObject({
      id: 'guest-closed',
      sideChatMode: 'guestParticipant',
      sideChatLifecycleState: 'closed'
    })
  })

  it('summarises RunDiffResult arrays and runDiffByPath workspace changes', () => {
    const summary = buildMobileDiffSummary(
      run({
        status: 'success',
        runDiff: {
          runId: 'run-1',
          preSnapshot: { capturedAt: ISO, isGitRepo: true, workspacePath: '/repo' },
          postSnapshot: { capturedAt: ISO, isGitRepo: true, workspacePath: '/repo' },
          createdFiles: [file('new.ts', 'created', 8, 0)],
          modifiedFiles: [file('main.ts', 'modified', 3, 2)],
          deletedFiles: [file('old.ts', 'deleted', 0, 4)],
          preExistingFiles: [file('dirty.ts', 'modified', 10, 1)]
        },
        runDiffByPath: {
          '/other': [file('extra.ts', 'created', 2, 0), file('edit.ts', 'modified', 1, 1)]
        }
      }),
      { workspaceId: 'workspace-1' }
    )

    expect(summary).toMatchObject({
      runId: 'run-1',
      filesChanged: 5,
      additions: 14,
      deletions: 7,
      createdFiles: 2,
      modifiedFiles: 2,
      deletedFiles: 1,
      preExistingFiles: 1
    })
    expect(summary?.workspaces.map((workspace) => workspace.workspacePath)).toEqual([
      '/repo',
      '/other'
    ])
    expect(summary?.workspaces[0]?.workspaceId).toBe('workspace-1')
  })

  it('projects active ensemble state compactly', () => {
    const card = buildRemoteTaskCard(
      chat({
        chatKind: 'ensemble',
        ensemble: {
          enabled: true,
          maxParticipants: 2,
          participants: [],
          activeRound: {
            roundId: 'round-1',
            status: 'running',
            prompt: 'Coordinate',
            startedAt: ISO,
            activeParticipantId: 'p1',
            queuedPrompts: ['next'],
            participants: [
              {
                participantId: 'p1',
                provider: 'codex',
                role: 'Implementer',
                order: 1,
                status: 'running',
                runId: 'run-1'
              }
            ]
          }
        }
      })
    )
    expect(card.chatKind).toBe('ensemble')
    expect(card.ensembleState).toMatchObject({
      threadId: 'chat-1',
      roundId: 'round-1',
      status: 'running',
      queuedPromptCount: 1,
      participantCount: 1
    })
  })

  it('derives per-lane todo plans from the activity stream (ensemble PlanRail)', () => {
    const card = buildRemoteTaskCard(
      chat({
        chatKind: 'ensemble',
        messages: [
          {
            id: 'm1',
            role: 'assistant',
            content: 'planning',
            timestamp: ISO,
            toolActivities: [
              {
                id: 'a1',
                toolName: 'todo_write',
                displayName: 'Plan',
                category: 'task',
                status: 'success',
                parameters: {
                  merge: false,
                  todos: [{ id: '1', content: 'Codex step', status: 'in_progress' }]
                },
                metadata: { ensembleProvider: 'codex' }
              },
              {
                id: 'a2',
                toolName: 'codex_plan',
                displayName: 'Plan',
                category: 'task',
                status: 'success',
                parameters: {
                  merge: false,
                  todos: [{ id: '1', content: 'Claude step', status: 'pending' }]
                },
                metadata: { ensembleProvider: 'claude' }
              },
              {
                // A sub-agent child must NOT leak into the parent's PlanRail.
                id: 'a3',
                toolName: 'todo_write',
                displayName: 'Plan',
                category: 'task',
                status: 'success',
                parentToolCallId: 'task-parent',
                parameters: {
                  merge: false,
                  todos: [{ id: '1', content: 'Delegate step', status: 'pending' }]
                },
                metadata: { ensembleProvider: 'codex' }
              }
            ]
          }
        ]
      })
    )
    expect(card.todoLanes).toEqual([
      { lane: 'claude', items: [{ id: '1', content: 'Claude step', status: 'pending' }] },
      { lane: 'codex', items: [{ id: '1', content: 'Codex step', status: 'in_progress' }] }
    ])
  })

  it('collapses solo todos to the solo lane and omits todoLanes when empty', () => {
    const solo = buildRemoteTaskCard(
      chat({
        messages: [
          {
            id: 'm1',
            role: 'assistant',
            content: 'planning',
            timestamp: ISO,
            toolActivities: [
              {
                id: 'a1',
                toolName: 'update_todo_list',
                displayName: 'Plan',
                category: 'task',
                status: 'success',
                parameters: { merge: false, todos: [{ id: '1', content: 'Solo step', status: 'pending' }] }
              }
            ]
          }
        ]
      })
    )
    expect(solo.todoLanes).toEqual([
      { lane: '__solo__', items: [{ id: '1', content: 'Solo step', status: 'pending' }] }
    ])
    // No todo activities → field omitted entirely (keeps the wire lean).
    expect(buildRemoteTaskCard(chat()).todoLanes).toBeUndefined()
  })
})
