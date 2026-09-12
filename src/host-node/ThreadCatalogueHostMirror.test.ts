import { describe, expect, it } from 'vitest'

import type { HostProfileThread } from '../host-runtime/HostProfileDomainStore'
import { projectHostCatalogueThread } from './ThreadCatalogueHostMirror'
import { projectThreadCatalogueRecord } from '../main/store/ThreadCatalogueFromRecord'
import type { ChatRecord } from '../main/store/types'

describe('Host thread catalogue write projection', () => {
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
      { id: 'm4', role: 'tool', content: 'tool result body', timestamp: '2026-09-01T00:03:00.000Z' },
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
        { id: 'seat-1', provider: 'codex', role: 'Worker', order: 1, enabled: true, instructions: 'Work' }
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
    const {
      status: _desktopStatus,
      ...desktopPresentation
    } = desktop.summary.presentation ?? {}
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
})
