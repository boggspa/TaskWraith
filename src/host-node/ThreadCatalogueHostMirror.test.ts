import { describe, expect, it } from 'vitest'

import type { HostProfileThread } from '../host-runtime/HostProfileDomainStore'
import { projectHostCatalogueThread } from './ThreadCatalogueHostMirror'

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
})
