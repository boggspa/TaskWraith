import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ChatRecord, ProviderId, RunQueueJob } from '../../../main/store/types'
import {
  ActiveRunsSection,
  deriveVisibleActiveRunEntries,
  getActiveRunChatLabel,
  isActiveRunVisibleOnSurface,
  resolveActiveRunChat
} from './ActiveRunsSection'

function job(overrides: Partial<RunQueueJob> = {}): RunQueueJob {
  return {
    id: 'job-1',
    runId: 'run-1',
    provider: 'gemini',
    source: 'manual',
    status: 'active',
    priority: 0,
    attempt: 1,
    createdAt: '2026-07-05T01:00:00.000Z',
    updatedAt: '2026-07-05T01:00:00.000Z',
    ...overrides
  } as RunQueueJob
}

function chat(provider: ProviderId, overrides: Partial<ChatRecord> = {}): ChatRecord {
  return {
    appChatId: 'chat-1',
    provider,
    title: 'General',
    messages: [],
    runs: [],
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  } as ChatRecord
}

describe('getActiveRunChatLabel', () => {
  it('prefers the chat title over workspace-only labeling', () => {
    expect(
      getActiveRunChatLabel(
        job({
          workspacePath: '/Users/me/Documents/AGBench',
          promptPreview: 'ignored when title exists'
        }),
        chat('codex', { title: 'Auth rewrite' })
      )
    ).toBe('Auth rewrite')
  })

  it('falls back to prompt preview when chat title is missing', () => {
    expect(
      getActiveRunChatLabel(
        job({ promptPreview: 'Investigate launch stall' }),
        chat('codex', { title: '   ' })
      )
    ).toBe('Investigate launch stall')
  })

  it('falls back to Untitled chat when no title or preview exists', () => {
    expect(getActiveRunChatLabel(job(), null)).toBe('Untitled chat')
  })
})

describe('active run chat attribution', () => {
  it('recovers an Ensemble thread from the participant run id when chatId is absent', () => {
    const ensemble = chat('codex', {
      appChatId: 'ensemble-chat',
      chatKind: 'ensemble',
      title: 'Release review',
      runs: [
        {
          runId: 'participant-run',
          provider: 'claude',
          startedAt: '2026-07-05T01:00:00.000Z',
          ensembleParticipantId: 'participant-2'
        }
      ]
    })
    const participantJob = job({
      id: 'participant-run',
      runId: 'participant-run',
      chatId: undefined,
      promptPreview: 'First few lines of the latest prompt'
    })

    const resolved = resolveActiveRunChat(participantJob, [ensemble])

    expect(resolved).toBe(ensemble)
    expect(getActiveRunChatLabel(participantJob, resolved)).toBe('Release review')
  })

  it('uses the exact app chat id before the run-id fallback', () => {
    const exact = chat('codex', { appChatId: 'exact-chat', title: 'Exact' })
    const historical = chat('claude', {
      appChatId: 'historical-chat',
      title: 'Historical',
      runs: [
        {
          runId: 'run-1',
          startedAt: '2026-07-05T00:00:00.000Z'
        }
      ]
    })

    expect(resolveActiveRunChat(job({ chatId: exact.appChatId }), [historical, exact])).toBe(exact)
  })
})

describe('isActiveRunVisibleOnSurface', () => {
  it('partitions resolved General and workspace threads between Chat and Code', () => {
    const globalChat = chat('claude', { appChatId: 'global-chat', scope: 'global' })
    const workspaceChat = chat('codex', {
      appChatId: 'workspace-chat',
      scope: 'workspace',
      workspaceId: 'workspace-1',
      workspacePath: '/repo'
    })

    expect(isActiveRunVisibleOnSurface(job({ scope: 'global' }), globalChat, 'chat')).toBe(true)
    expect(isActiveRunVisibleOnSurface(job({ scope: 'global' }), globalChat, 'code')).toBe(false)
    expect(isActiveRunVisibleOnSurface(job({ scope: 'workspace' }), workspaceChat, 'code')).toBe(
      true
    )
    expect(isActiveRunVisibleOnSurface(job({ scope: 'workspace' }), workspaceChat, 'chat')).toBe(
      false
    )
  })

  it('uses durable job scope when the chat record is temporarily unavailable', () => {
    expect(isActiveRunVisibleOnSurface(job({ scope: 'global' }), null, 'chat')).toBe(true)
    expect(isActiveRunVisibleOnSurface(job({ scope: 'global' }), null, 'code')).toBe(false)
    expect(
      isActiveRunVisibleOnSurface(
        job({ scope: undefined, workspaceId: 'workspace-1', workspacePath: '/repo' }),
        null,
        'code'
      )
    ).toBe(true)
  })

  it('shows both General and workspace runs in Work only when the thread is a project member', () => {
    const workChatIds = new Set(['global-member', 'workspace-member'])
    const globalMember = chat('claude', { appChatId: 'global-member', scope: 'global' })
    const workspaceMember = chat('codex', {
      appChatId: 'workspace-member',
      scope: 'workspace'
    })
    const outsider = chat('codex', { appChatId: 'not-a-member', scope: 'workspace' })

    expect(isActiveRunVisibleOnSurface(job(), globalMember, 'work', workChatIds)).toBe(true)
    expect(isActiveRunVisibleOnSurface(job(), workspaceMember, 'work', workChatIds)).toBe(true)
    expect(isActiveRunVisibleOnSurface(job(), outsider, 'work', workChatIds)).toBe(false)
    expect(isActiveRunVisibleOnSurface(job({ chatId: 'missing' }), null, 'work', workChatIds)).toBe(
      false
    )
  })
})

describe('deriveVisibleActiveRunEntries', () => {
  const transitioningChat = (): ChatRecord =>
    chat('claude', {
      appChatId: 'ensemble-chat',
      title: 'Release panel',
      chatKind: 'ensemble',
      scope: 'workspace',
      workspaceId: 'workspace-1',
      workspacePath: '/repo',
      runs: [
        {
          runId: 'source-run',
          provider: 'codex',
          startedAt: '2026-07-05T01:00:00.000Z',
          endedAt: '2026-07-05T01:01:00.000Z',
          status: 'success'
        }
      ],
      ensemble: {
        enabled: true,
        maxParticipants: 2,
        participants: [
          {
            id: 'p1',
            provider: 'codex',
            enabled: true,
            role: 'Builder',
            instructions: '',
            order: 0
          },
          {
            id: 'p2',
            provider: 'gemini',
            enabled: true,
            role: 'Reviewer',
            instructions: '',
            order: 1,
            model: 'gemini-3.7-pro'
          }
        ],
        activeRound: {
          roundId: 'round-1',
          status: 'running',
          prompt: 'Ship the release',
          startedAt: '2026-07-05T01:00:00.000Z',
          turnTransition: {
            phase: 'handoff',
            runtimeInstanceId: 'runtime-1',
            sourceParticipantId: 'p1',
            sourceRunId: 'source-run',
            targetParticipantId: 'p2',
            startedAt: '2026-07-05T01:01:00.000Z'
          },
          participants: [
            {
              participantId: 'p1',
              provider: 'codex',
              role: 'Builder',
              order: 0,
              status: 'answered',
              runId: 'source-run',
              endedAt: '2026-07-05T01:01:00.000Z'
            },
            {
              participantId: 'p2',
              provider: 'gemini',
              role: 'Reviewer',
              order: 1,
              status: 'idle'
            }
          ]
        }
      }
    })

  it('projects one chat-backed row while the active-job poll is empty between seats', () => {
    const ensemble = transitioningChat()
    const entries = deriveVisibleActiveRunEntries({
      jobs: [],
      chats: [ensemble],
      surface: 'code'
    })

    expect(entries).toHaveLength(1)
    expect(entries[0].chat).toBe(ensemble)
    expect(entries[0]).toMatchObject({
      isTransitionFallback: true,
      job: {
        id: 'ensemble-transition:ensemble-chat:round-1',
        runId: 'source-run',
        chatId: 'ensemble-chat',
        provider: 'gemini',
        status: 'active',
        startedAt: '2026-07-05T01:00:00.000Z'
      }
    })
  })

  it('renders the fallback as the parent thread rather than a target-seat strip', () => {
    const ensemble = transitioningChat()
    const html = renderToStaticMarkup(
      <ActiveRunsSection
        chats={[ensemble]}
        currentChat={ensemble}
        surface="code"
        onSelectChat={() => undefined}
      />
    )

    expect(html).toContain('Release panel')
    expect(html).toContain('Ensemble')
    expect(html).not.toContain('sidebar-active-run-provider')
    expect(html).toContain('sidebar-chat-running')
    expect(html).toContain('sidebar-active-runs-count">1</span>')
  })

  it('uses the real target job without duplicating the transitioning chat', () => {
    const ensemble = transitioningChat()
    const targetJob = job({
      id: 'target-run',
      runId: 'target-run',
      chatId: ensemble.appChatId,
      provider: 'gemini',
      createdAt: '2026-07-05T01:02:00.000Z',
      updatedAt: '2026-07-05T01:02:00.000Z'
    })

    const entries = deriveVisibleActiveRunEntries({
      jobs: [targetJob],
      chats: [ensemble],
      surface: 'code'
    })

    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      job: targetJob,
      isTransitionFallback: false
    })
  })

  it('collapses concurrent fan-out lanes to one parent thread row', () => {
    const ensemble = chat('codex', {
      appChatId: 'ensemble-chat',
      chatKind: 'ensemble',
      title: 'Release panel',
      scope: 'workspace',
      workspaceId: 'workspace-1',
      workspacePath: '/repo'
    })
    const entries = deriveVisibleActiveRunEntries({
      jobs: [
        job({
          id: 'lane-codex',
          runId: 'lane-codex',
          chatId: ensemble.appChatId,
          provider: 'codex',
          ensembleLaneId: 'lane-codex',
          status: 'queued'
        }),
        job({
          id: 'lane-claude',
          runId: 'lane-claude',
          chatId: ensemble.appChatId,
          provider: 'claude',
          ensembleLaneId: 'lane-claude'
        })
      ],
      chats: [ensemble],
      surface: 'code'
    })

    expect(entries).toHaveLength(1)
    expect(entries[0].chat).toBe(ensemble)
    expect(entries[0].job.id).toBe('lane-claude')
  })

  it('projects active delegated and fan-out children onto their parent thread', () => {
    const parent = chat('codex', {
      appChatId: 'parent-chat',
      title: 'Parent thread',
      scope: 'workspace',
      workspaceId: 'workspace-1',
      workspacePath: '/repo'
    })
    const delegatedChild = chat('claude', {
      appChatId: 'subthread-chat',
      title: 'Delegated child',
      scope: 'workspace',
      parentChatId: parent.appChatId,
      parentChatRelation: 'subThread'
    })
    const fanoutChild = chat('gemini', {
      appChatId: 'fanout-chat',
      title: 'Fan-out child',
      scope: 'workspace',
      parentChatId: parent.appChatId,
      parentChatRelation: 'sideChat',
      sideChatContext: { createdAt: 0, mode: 'fanOut' }
    })
    const entries = deriveVisibleActiveRunEntries({
      jobs: [
        job({ id: 'subthread-run', runId: 'subthread-run', chatId: delegatedChild.appChatId }),
        job({ id: 'fanout-run', runId: 'fanout-run', chatId: fanoutChild.appChatId })
      ],
      chats: [parent, delegatedChild, fanoutChild],
      surface: 'work',
      workChatIds: new Set([parent.appChatId])
    })

    expect(entries).toHaveLength(1)
    expect(entries[0].chat).toBe(parent)
    expect(entries.map((entry) => entry.chat.title)).toEqual(['Parent thread'])
  })

  it('does not revive a transition on a terminal round or the wrong surface', () => {
    const ensemble = transitioningChat()
    expect(deriveVisibleActiveRunEntries({ jobs: [], chats: [ensemble], surface: 'chat' })).toEqual(
      []
    )

    const completed = {
      ...ensemble,
      ensemble: {
        ...ensemble.ensemble!,
        activeRound: {
          ...ensemble.ensemble!.activeRound!,
          status: 'completed' as const,
          endedAt: '2026-07-05T01:02:00.000Z'
        }
      }
    }
    expect(
      deriveVisibleActiveRunEntries({ jobs: [], chats: [completed], surface: 'code' })
    ).toEqual([])
  })

  it('declines a malformed transition whose provider cannot be resolved', () => {
    const ensemble = transitioningChat()
    const unresolved = {
      ...ensemble,
      provider: undefined,
      ensemble: {
        ...ensemble.ensemble!,
        participants: [],
        activeRound: {
          ...ensemble.ensemble!.activeRound!,
          participants: []
        }
      }
    } as ChatRecord

    expect(
      deriveVisibleActiveRunEntries({ jobs: [], chats: [unresolved], surface: 'code' })
    ).toEqual([])
  })
})
