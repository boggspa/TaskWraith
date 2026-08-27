import { describe, expect, it, vi } from 'vitest'
import type { RemoteEnsembleParticipantState, RemoteTaskCard } from './RemoteTaskProjection'
import type { LiveActivityPushFanout } from './LiveActivityPushFanout'
import {
  projectWorkspaceLiveActivities,
  WorkspaceLiveActivityCoordinator
} from './WorkspaceLiveActivityCoordinator'

function card(
  id: string,
  status: RemoteTaskCard['status'],
  options: {
    workspaceId?: string
    monitor?: boolean
    provider?: RemoteTaskCard['provider']
    startedAt?: string
    updatedAt?: string
    additions?: number
    deletions?: number
    ensembleParticipants?: Array<Pick<RemoteEnsembleParticipantState, 'provider' | 'status'>>
  } = {}
): RemoteTaskCard {
  return {
    id,
    threadId: id,
    title: `private-${id}`,
    status,
    chatKind: options.ensembleParticipants ? 'ensemble' : undefined,
    workspaceId: options.workspaceId ?? 'workspace-secret',
    provider: options.provider ?? 'codex',
    preview: `private-preview-${id}`,
    previewTruncated: false,
    pendingApprovalCount: 0,
    pendingQuestionCount: 0,
    runStartedAt: options.startedAt,
    updatedAt: options.updatedAt,
    capabilities: { monitor: options.monitor ?? true } as RemoteTaskCard['capabilities'],
    ensembleState: options.ensembleParticipants
      ? {
          threadId: id,
          status: 'running',
          queuedPromptCount: 0,
          participantCount: options.ensembleParticipants.length,
          participants: options.ensembleParticipants.map((participant, index) => ({
            participantId: `seat-${index}`,
            provider: participant.provider,
            role: 'worker',
            order: index,
            status: participant.status
          }))
        }
      : undefined,
    diffSummary: {
      filesChanged: 99,
      additions: options.additions ?? 900,
      deletions: options.deletions ?? 90,
      files: [{ path: `/private/${id}.ts`, additions: 900, deletions: 90, status: 'modified' }]
    }
  } as RemoteTaskCard
}

function fanoutSpy(): LiveActivityPushFanout & {
  onTaskCard: ReturnType<typeof vi.fn>
  onWorkspaceActivity: ReturnType<typeof vi.fn>
  abandonThread: ReturnType<typeof vi.fn>
  abandonWorkspace: ReturnType<typeof vi.fn>
} {
  return {
    onTaskCard: vi.fn(),
    onWorkspaceActivity: vi.fn(),
    abandonThread: vi.fn(),
    abandonWorkspace: vi.fn()
  } as unknown as LiveActivityPushFanout & {
    onTaskCard: ReturnType<typeof vi.fn>
    onWorkspaceActivity: ReturnType<typeof vi.fn>
    abandonThread: ReturnType<typeof vi.fn>
    abandonWorkspace: ReturnType<typeof vi.fn>
  }
}

describe('workspace Live Activity projection', () => {
  it('keeps one run per-run and collapses two monitor-authorized runs', () => {
    const one = projectWorkspaceLiveActivities([card('a', 'running')], new Map(), 100)
    expect(one).toEqual([])

    const two = projectWorkspaceLiveActivities(
      [
        card('a', 'running', {
          provider: 'codex',
          startedAt: '2026-08-04T02:00:00.000Z',
          updatedAt: '1'
        }),
        card('b', 'awaitingQuestion', {
          provider: 'grok',
          startedAt: '2026-08-04T02:01:00.000Z',
          updatedAt: '2'
        })
      ],
      new Map([
        [
          'workspace-secret',
          {
            counts: { changed: 12 },
            lineStats: { additions: 539, deletions: 202 },
            ahead: 89,
            behind: 3
          }
        ]
      ]),
      100
    )
    expect(two).toHaveLength(1)
    expect(two[0].summary).toMatchObject({
      phase: 'awaitingQuestion',
      activeRuns: 2,
      activeSeats: 1,
      respondedSeats: 0,
      blockedSeats: 0,
      filesChanged: 12,
      additions: 539,
      deletions: 202,
      ahead: 89,
      behind: 3,
      hasGitSnapshot: true
    })
    expect(two[0].summary.seats.map((seat) => seat.provider)).toEqual(['grok', 'codex'])
    expect(two[0].summary.seats.map((seat) => seat.phase)).toEqual(['awaitingQuestion', 'running'])
    // Per-run diffs were 900 each; the summary uses Git once, never 1,800.
    expect(two[0].summary.additions).not.toBe(1_800)
  })

  it('uses the ensemble display provider in workspace summaries', () => {
    const projected = projectWorkspaceLiveActivities(
      [
        card('a', 'running', { provider: 'pi', ensembleParticipants: [] }),
        card('b', 'running', { provider: 'pi', ensembleParticipants: [] })
      ],
      new Map(),
      100
    )[0]

    const providers = projected.summary.seats.map((seat) => seat.provider)
    expect(providers).toEqual(['ensemble', 'ensemble'])
  })

  it('fails closed when any active member lacks monitor capability', () => {
    const projected = projectWorkspaceLiveActivities(
      [card('a', 'running'), card('b', 'running', { monitor: false })],
      new Map(),
      100
    )
    expect(projected).toEqual([])
  })

  it('uses unavailable rather than zero when no Git snapshot exists', () => {
    const projected = projectWorkspaceLiveActivities(
      [card('a', 'running'), card('b', 'running')],
      new Map(),
      100
    )[0]
    expect(projected.summary).toMatchObject({
      filesChanged: 0,
      additions: 0,
      deletions: 0,
      ahead: 0,
      behind: 0,
      hasGitSnapshot: false
    })
  })
})

describe('workspace Live Activity reconciliation', () => {
  it('projects answered ensemble seats as complete and names the ensemble', () => {
    const fanout = fanoutSpy()
    const coordinator = new WorkspaceLiveActivityCoordinator({ fanout, now: () => 100 })
    const answered: Array<Pick<RemoteEnsembleParticipantState, 'provider' | 'status'>> = Array.from(
      { length: 8 },
      () => ({ provider: 'pi', status: 'answered' })
    )

    coordinator.reconcile([
      card('ensemble', 'running', { provider: 'pi', ensembleParticipants: answered })
    ])

    expect(fanout.onTaskCard).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'ensemble',
        provider: 'ensemble',
        isEnsemble: true,
        activeSeats: 0,
        respondedSeats: 8,
        blockedSeats: 0,
        seats: answered.map(() => ({ provider: 'pi', phase: 'complete' }))
      })
    )
  })

  it('preserves the canonical terminal and active ensemble seat phases', () => {
    const fanout = fanoutSpy()
    const coordinator = new WorkspaceLiveActivityCoordinator({ fanout, now: () => 100 })
    const participants: Array<Pick<RemoteEnsembleParticipantState, 'provider' | 'status'>> = [
      { provider: 'codex', status: 'answered' },
      { provider: 'codex', status: 'answered' },
      { provider: 'grok', status: 'answered' },
      { provider: 'grok', status: 'answered' },
      { provider: 'pi', status: 'answered' },
      { provider: 'pi', status: 'failed' },
      { provider: 'kimi', status: 'sleeping' },
      { provider: 'mistral', status: 'running' }
    ]

    coordinator.reconcile([
      card('ensemble', 'running', { provider: 'pi', ensembleParticipants: participants })
    ])

    expect(fanout.onTaskCard).toHaveBeenCalledWith(
      expect.objectContaining({
        activeSeats: 1,
        respondedSeats: 6,
        blockedSeats: 1,
        seats: [
          { provider: 'codex', phase: 'complete' },
          { provider: 'codex', phase: 'complete' },
          { provider: 'grok', phase: 'complete' },
          { provider: 'grok', phase: 'complete' },
          { provider: 'pi', phase: 'complete' },
          { provider: 'pi', phase: 'failed' },
          { provider: 'kimi', phase: 'complete' },
          { provider: 'mistral', phase: 'running' }
        ]
      })
    )
  })

  it('keeps a non-ensemble provider as its display provider', () => {
    const fanout = fanoutSpy()
    const coordinator = new WorkspaceLiveActivityCoordinator({ fanout, now: () => 100 })

    coordinator.reconcile([card('single', 'running', { provider: 'grok' })])

    expect(fanout.onTaskCard).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'single', provider: 'grok', isEnsemble: false })
    )
  })

  it('replaces member cards with one summary and restores a single run later', () => {
    const fanout = fanoutSpy()
    const coordinator = new WorkspaceLiveActivityCoordinator({ fanout, now: () => 100 })
    const first = card('a', 'running')
    const second = card('b', 'running')

    coordinator.reconcile([first, second], new Map())
    expect(fanout.abandonThread).toHaveBeenCalledWith('a')
    expect(fanout.abandonThread).toHaveBeenCalledWith('b')
    expect(fanout.onWorkspaceActivity).toHaveBeenCalledTimes(1)
    expect(fanout.onTaskCard).not.toHaveBeenCalled()

    coordinator.reconcile([first], new Map())
    expect(fanout.abandonWorkspace).toHaveBeenCalledWith('workspace-secret')
    expect(fanout.onTaskCard).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }))
  })

  it('refreshes only the active workspace summary on a Git watcher tick', () => {
    const fanout = fanoutSpy()
    const coordinator = new WorkspaceLiveActivityCoordinator({ fanout, now: () => 100 })
    coordinator.reconcile([card('a', 'running'), card('b', 'running')], new Map())
    fanout.onWorkspaceActivity.mockClear()
    fanout.onTaskCard.mockClear()

    coordinator.updateGitSnapshot('workspace-secret', {
      counts: { changed: 4 },
      lineStats: { additions: 20, deletions: 3 },
      ahead: 2,
      behind: 1
    })
    expect(fanout.onWorkspaceActivity).toHaveBeenCalledWith(
      expect.objectContaining({ filesChanged: 4, additions: 20, deletions: 3 })
    )
    expect(fanout.onTaskCard).not.toHaveBeenCalled()
  })

  it('retains watcher-owned Git truth across later card reconciliation', () => {
    const fanout = fanoutSpy()
    const coordinator = new WorkspaceLiveActivityCoordinator({ fanout, now: () => 100 })
    coordinator.updateGitSnapshot('workspace-secret', {
      counts: { changed: 7 },
      lineStats: { additions: 44, deletions: 5 },
      ahead: 8,
      behind: 2
    })

    coordinator.reconcile([card('a', 'running'), card('b', 'running')])

    expect(fanout.onWorkspaceActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        filesChanged: 7,
        additions: 44,
        deletions: 5,
        ahead: 8,
        behind: 2,
        hasGitSnapshot: true
      })
    )
  })
})
