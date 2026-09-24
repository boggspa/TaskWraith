import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  HostProfileDomainStore,
  type HostProfileRun,
  type HostProfileThread
} from '../host-runtime/HostProfileDomainStore'
import { projectHostProfileDomainSnapshot } from '../host-runtime/HostProfileDomainProjection'
import type { ThreadCatalogueMirror } from '../host-shared/thread-catalogue/ThreadCatalogueMirror'
import {
  hostCatalogueSummaries,
  projectHostCatalogueThread,
  queryHostCatalogue
} from './ThreadCatalogueHostMirror'
import { ThreadCatalogueRequestError } from '../shared/threadCatalogueRequestError'
import { projectThreadCatalogueRecord } from '../main/store/ThreadCatalogueFromRecord'
import type { ChatRecord } from '../main/store/types'

const temporaryPaths: string[] = []

afterEach(() => {
  while (temporaryPaths.length > 0) rmSync(temporaryPaths.pop()!, { recursive: true, force: true })
})

describe('Host thread catalogue write projection', () => {
  it('returns a body-free catalogue-local failure and forwards the background lane', async () => {
    const query = async (_request: unknown, options?: { priority?: string }) => {
      expect(options).toEqual({ priority: 'background' })
      throw new ThreadCatalogueRequestError('source_changed')
    }

    await expect(
      queryHostCatalogue(
        { query } as never,
        { method: 'open', chatId: 'moving-chat', mode: 'metadata' },
        { priority: 'background' }
      )
    ).resolves.toEqual({ data: null, error: { code: 'source_changed' } })
  })

  it('does not recast an unknown worker failure as request-local contention', async () => {
    const failure = new Error('sqlite catalogue corrupt')
    await expect(
      queryHostCatalogue({ query: async () => Promise.reject(failure) } as never, {
        method: 'summary',
        chatId: 'chat'
      })
    ).rejects.toBe(failure)
  })

  it('projects bounded metadata from an already-loaded Host record', () => {
    const longParticipantId = 'p'.repeat(490)
    const thread: HostProfileThread = {
      appChatId: 'host-thread',
      scope: 'workspace',
      workspaceId: 'workspace-one',
      workspacePath: '/private/workspace',
      title: 'Host thread',
      provider: 'codex',
      chatKind: 'ensemble',
      archived: false,
      pinned: true,
      createdAt: 10,
      updatedAt: 30,
      persistenceRevision: 7,
      messages: [
        {
          id: 'message-one',
          role: 'user',
          content: `latest ${'x'.repeat(200_000)}`,
          timestamp: '2026-09-08T00:00:00.000Z'
        }
      ],
      runs: [
        {
          runId: 'run-one',
          provider: 'codex',
          status: 'running',
          startedAt: '2026-09-08T00:01:00.000Z',
          requestedModel: 'gpt-6-astra'
        }
      ],
      ensemble: {
        wakeups: { wake: { status: 'pending' } },
        blackboard: [{ expiresAt: '2026-09-09T00:00:00.000Z' }],
        participants: Array.from({ length: 100 }, (_, index) => ({
          id: index === 0 ? longParticipantId : `participant-${index}`,
          provider: 'codex',
          role: 'Worker',
          order: index,
          enabled: true
        }))
      },
      soloWakeups: { solo: { status: 'pending' } },
      delegationContext: {
        joinPolicy: { groupId: 'join-one' },
        workerControl: {
          events: [
            { status: 'pending', joinPolicy: { groupId: 'join-two' } },
            { status: 'complete' }
          ]
        }
      }
    }

    const projected = projectHostCatalogueThread(thread)
    expect(projected).toMatchObject({
      revision: 7,
      summary: {
        chatId: 'host-thread',
        title: 'Host thread',
        provider: 'codex',
        chatKind: 'ensemble',
        scope: 'workspace',
        workspaceId: 'workspace-one',
        archived: false,
        messageCount: 1,
        runCount: 1,
        presentation: { status: 'running', runId: 'run-one', runningRunCount: 1 },
        lastRun: { runId: 'run-one', requestedModel: 'gpt-6-astra' },
        chrome: {
          pinned: true,
          searchPreview: expect.stringMatching(/^latest x/),
          lastUserMessageAt: Date.parse('2026-09-08T00:00:00.000Z')
        }
      },
      recovery: {
        unsettledRuns: 1,
        ensembleWakeups: 1,
        soloWakeups: 1,
        workerEvents: 1,
        joinPolicies: 2,
        nextBlackboardExpiryAt: Date.parse('2026-09-09T00:00:00.000Z')
      }
    })
    expect(projected.summary.chrome?.searchPreview).toHaveLength(1024)
    const participants = (
      projected.summary.chrome?.ensemble as {
        participants?: Array<{ id?: string }>
      }
    ).participants
    expect(participants).toHaveLength(50)
    expect(participants?.[0]?.id).toBe(longParticipantId)
    expect(JSON.stringify(projected)).not.toContain('x'.repeat(10_000))
    expect(Buffer.byteLength(JSON.stringify(projected), 'utf8')).toBeLessThan(64 * 1024)
  })

  it('matches the desktop projection field-for-field except the task-status source', () => {
    // The mirror's equality gate compares locally-observed (desktop) rows with
    // indexed (host) rows; any field drift fans a saveless invalidation out to
    // every renderer minutes after the edit. A tool-message tail with empty
    // contents is exactly where the two scans used to disagree.
    const messages = [
      { id: 'm1', role: 'user', content: 'first', timestamp: '2026-09-01T00:00:00.000Z' },
      { id: 'm2', role: 'assistant', content: 'reply', timestamp: '2026-09-01T00:01:00.000Z' },
      { id: 'm3', role: 'user', content: '', timestamp: '2026-09-01T00:02:00.000Z' },
      {
        id: 'm4',
        role: 'tool',
        content: 'tool result body',
        timestamp: '2026-09-01T00:03:00.000Z'
      },
      { id: 'm5', role: 'error', content: 'boom', timestamp: '2026-09-01T00:04:00.000Z' }
    ]
    const runs = [
      {
        runId: 'run-one',
        provider: 'codex',
        status: 'success',
        startedAt: '2026-09-01T00:05:00.000Z',
        endedAt: '2026-09-01T00:06:00.000Z'
      }
    ]
    const ensemble = {
      maxContinuationHops: 7,
      participants: [
        {
          id: 'seat-1',
          provider: 'codex',
          role: 'Worker',
          order: 1,
          enabled: true,
          instructions: 'Work'
        }
      ]
    }
    const chat = {
      appChatId: 'parity-thread',
      scope: 'workspace',
      workspaceId: 'workspace-one',
      workspacePath: '/private/workspace',
      title: 'Parity thread',
      provider: 'codex',
      chatKind: 'ensemble',
      archived: false,
      createdAt: 10,
      updatedAt: 30,
      persistenceRevision: 7,
      messages,
      runs,
      ensemble
    } as unknown as ChatRecord
    const thread = { ...chat } as unknown as HostProfileThread

    const desktop = projectThreadCatalogueRecord(chat)
    const host = projectHostCatalogueThread(thread)

    expect(host.revision).toBe(desktop.revision)
    const { status: _desktopStatus, ...desktopPresentation } = desktop.summary.presentation ?? {}
    const { status: _hostStatus, ...hostPresentation } = host.summary.presentation ?? {}
    expect(hostPresentation).toEqual(desktopPresentation)
    // The status functions intentionally differ in depth (the desktop one
    // folds in pending approvals/questions), so `status` is the one field
    // exempt from parity; it is genuine content, not scan drift.
    const { presentation: _desktopPres, ...desktopSummaryRest } = desktop.summary
    const { presentation: _hostPres, ...hostSummaryRest } = host.summary
    expect(hostSummaryRest).toEqual(desktopSummaryRest)
    expect(host.recovery).toEqual(desktop.recovery)
    // The tool/error tail is the regression pin: both scans must pick it up.
    expect(host.summary.chrome?.searchPreview).toBe('boom')
    expect(desktop.summary.chrome?.searchPreview).toBe('boom')
  })

  it('carries live and terminal Ensemble activity through catalogue summaries into Host families', () => {
    const liveRoundId = 'ensemble-live-round'
    const liveRunId = 'run-live-captain'
    const terminalRoundId = 'ensemble-terminal-round'
    const terminalRunIds = ['run-terminal-builder', 'run-terminal-reviewer']
    const live = {
      appChatId: 'host-live-ensemble',
      scope: 'workspace',
      workspaceId: 'workspace-one',
      workspacePath: '/private/workspace',
      title: 'Live ensemble',
      provider: 'codex',
      chatKind: 'ensemble',
      archived: false,
      createdAt: 10,
      updatedAt: 30,
      persistenceRevision: 7,
      messages: [],
      runs: [
        {
          runId: liveRunId,
          provider: 'codex',
          status: 'running',
          startedAt: '2026-09-12T11:33:59.427Z',
          ensembleRoundId: liveRoundId,
          ensembleParticipantId: 'seat-captain'
        }
      ],
      ensemble: {
        enabled: true,
        orchestrationMode: 'continuous',
        fanoutPolicy: 'off',
        participants: [
          {
            id: 'seat-captain',
            provider: 'codex',
            role: 'Captain',
            order: 1,
            enabled: true,
            instructions: ''
          },
          {
            id: 'seat-reviewer',
            provider: 'claude',
            role: 'Reviewer',
            order: 2,
            enabled: true,
            instructions: ''
          }
        ],
        activeRound: {
          roundId: liveRoundId,
          status: 'running',
          prompt: 'Review the release.',
          startedAt: '2026-09-12T11:33:58.945Z',
          activeParticipantId: 'seat-captain',
          continuationHops: 1,
          maxContinuationHops: 4,
          participants: [
            {
              participantId: 'seat-captain',
              provider: 'codex',
              role: 'Captain',
              order: 1,
              status: 'running',
              runId: liveRunId,
              startedAt: '2026-09-12T11:33:59.427Z'
            },
            {
              participantId: 'seat-reviewer',
              provider: 'claude',
              role: 'Reviewer',
              order: 2,
              status: 'idle'
            }
          ]
        }
      }
    } as unknown as HostProfileThread
    const terminal = {
      ...live,
      appChatId: 'host-terminal-ensemble',
      title: 'Terminal ensemble',
      updatedAt: 40,
      persistenceRevision: 8,
      runs: terminalRunIds.map((runId, index) => ({
        runId,
        provider: index === 0 ? 'codex' : 'claude',
        status: index === 0 ? 'cancelled' : 'success',
        startedAt: `2026-09-12T11:3${4 + index}:00.000Z`,
        endedAt: `2026-09-12T11:3${5 + index}:00.000Z`,
        ensembleRoundId: terminalRoundId,
        ensembleParticipantId: index === 0 ? 'seat-captain' : 'seat-reviewer'
      })),
      ensemble: {
        ...(live.ensemble as Record<string, unknown>),
        activeRound: {
          roundId: terminalRoundId,
          status: 'cancelled',
          prompt: 'Review the release.',
          startedAt: '2026-09-12T11:33:58.945Z',
          endedAt: '2026-09-12T11:36:32.791Z',
          continuationHops: 2,
          maxContinuationHops: 4,
          participants: [
            {
              participantId: 'seat-captain',
              provider: 'codex',
              role: 'Captain',
              order: 1,
              status: 'cancelled',
              runId: terminalRunIds[0],
              startedAt: '2026-09-12T11:34:00.000Z',
              endedAt: '2026-09-12T11:35:00.000Z'
            },
            {
              participantId: 'seat-reviewer',
              provider: 'claude',
              role: 'Reviewer',
              order: 2,
              status: 'answered',
              runId: terminalRunIds[1],
              startedAt: '2026-09-12T11:35:00.000Z',
              endedAt: '2026-09-12T11:36:00.000Z'
            }
          ]
        }
      }
    } as unknown as HostProfileThread
    const projections = [projectHostCatalogueThread(live), projectHostCatalogueThread(terminal)]
    const mirror = {
      projections: () => projections
    } as unknown as ThreadCatalogueMirror
    const summaries = hostCatalogueSummaries(mirror)
    const profilePath = mkdtempSync(join(tmpdir(), 'host-catalogue-round-projection-'))
    temporaryPaths.push(profilePath)
    const runEntries = [live, terminal].flatMap((thread) =>
      (thread.runs ?? []).map((run) => ({
        chatId: thread.appChatId,
        run: run as HostProfileRun
      }))
    )
    const store = new HostProfileDomainStore({
      profilePath,
      authority: { assertProfileAuthority: () => {} },
      threadSummarySource: () => summaries,
      runSummarySource: () => ({ entries: runEntries, total: runEntries.length, complete: true })
    })

    const donor = projectHostProfileDomainSnapshot({
      store,
      health: { hostStatus: 'ok', connectionPhase: 'live', supervised: true, freshness: 'live' },
      providers: []
    })

    expect(donor.rounds).toEqual([
      expect.objectContaining({
        roundId: liveRoundId,
        threadId: live.appChatId,
        status: 'running',
        participantIds: ['seat-captain', 'seat-reviewer'],
        providerRunIds: [liveRunId]
      }),
      expect.objectContaining({
        roundId: terminalRoundId,
        threadId: terminal.appChatId,
        status: 'cancelled',
        endedAt: Date.parse('2026-09-12T11:36:32.791Z'),
        participantIds: ['seat-captain', 'seat-reviewer'],
        providerRunIds: terminalRunIds
      })
    ])
    expect(donor.threads.find((thread) => thread.id === live.appChatId)).toEqual(
      expect.objectContaining({ activeRoundId: liveRoundId })
    )
    expect(
      donor.threads.find((thread) => thread.id === terminal.appChatId)?.activeRoundId
    ).toBeUndefined()
    expect(donor.participants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'seat-captain',
          threadId: live.appChatId,
          status: 'running',
          active: true
        }),
        expect.objectContaining({
          id: 'seat-captain',
          threadId: terminal.appChatId,
          status: 'cancelled',
          active: false
        }),
        expect.objectContaining({
          id: 'seat-reviewer',
          threadId: terminal.appChatId,
          status: 'answered',
          active: false
        })
      ])
    )
  })
})
