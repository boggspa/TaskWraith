import { describe, expect, it } from 'vitest'

import { buildRecoveryMessagesForChat, recoveryBatchMessageId } from './recoveryMessageBatch'
import type { RunRecoveryRecord } from '../../../main/store/types'

function makeRecord(
  overrides: Partial<RunRecoveryRecord> & Pick<RunRecoveryRecord, 'runId'>
): RunRecoveryRecord {
  return {
    schemaVersion: 1,
    id: `${overrides.runId}-record`,
    jobId: overrides.runId,
    provider: 'grok',
    previousStatus: 'active',
    recoveredStatus: 'failed',
    action: 'marked_failed',
    reason: 'Run was active when TaskWraith last exited.',
    recoveredAt: '2026-06-30T12:00:00.000Z',
    resumeAvailable: false,
    resumeHint: 'No session.',
    jobSnapshot: {},
    ...overrides
  }
}

describe('buildRecoveryMessagesForChat', () => {
  it('builds one message per record when each recovery pass only has one lane', () => {
    const records = [
      makeRecord({ runId: 'run-1', recoveredAt: '2026-06-30T12:00:00.000Z' }),
      makeRecord({
        runId: 'run-2',
        recoveredAt: '2026-06-30T12:01:00.000Z',
        jobSnapshot: { providerSessionId: 'abc-123' }
      })
    ]

    const messages = buildRecoveryMessagesForChat('chat-1', records, new Set())

    expect(messages).toHaveLength(2)
    expect(messages[0]).toMatchObject({
      id: 'recovery-run-1-record',
      runId: 'run-1',
      role: 'system'
    })
    expect(messages[1].content).toContain('Provider session ID: abc-123')
  })

  it('batches identical recovery-at records into one grouped message', () => {
    const records = [
      makeRecord({
        runId: 'run-1',
        ensembleRole: 'Reviewer',
        ensembleParticipantId: 'participant-a',
        jobSnapshot: { providerSessionId: 'grok-session-1' }
      }),
      makeRecord({
        runId: 'run-2',
        ensembleRole: 'Builder',
        ensembleParticipantId: 'participant-b'
      })
    ]

    const messages = buildRecoveryMessagesForChat('chat-1', records, new Set())

    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      id: recoveryBatchMessageId('chat-1', '2026-06-30T12:00:00.000Z'),
      role: 'system',
      timestamp: '2026-06-30T12:00:00.000Z'
    })
    expect(messages[0].content).toContain('Reviewer')
    expect(messages[0].content).toContain('Builder')
    expect(messages[0].content).toContain('Provider session ID: grok-session-1')
  })

  it('keeps same-pass records separate when they do not carry ensemble identity', () => {
    const records = [makeRecord({ runId: 'run-1' }), makeRecord({ runId: 'run-2' })]

    const messages = buildRecoveryMessagesForChat('chat-1', records, new Set())

    expect(messages).toHaveLength(2)
    expect(messages[0]).toMatchObject({ id: 'recovery-run-1-record', runId: 'run-1' })
    expect(messages[1]).toMatchObject({ id: 'recovery-run-2-record', runId: 'run-2' })
  })

  it('re-derives ensemble identity from the chat runs when the record is unlabelled', () => {
    // A recovered ensemble job that lost its identity → the record has no
    // ensembleRole/participant, but the chat's persisted runs still carry it.
    const records = [
      makeRecord({ runId: 'run-1', provider: 'claude' }),
      makeRecord({ runId: 'run-2', provider: 'codex' })
    ]
    const identityByRunId = new Map([
      ['run-1', { ensembleParticipantId: 'participant-a', ensembleRole: 'Reviewer' }],
      ['run-2', { ensembleParticipantId: 'participant-b', ensembleRole: 'Builder' }]
    ])

    const messages = buildRecoveryMessagesForChat('chat-1', records, new Set(), (runId) =>
      runId ? identityByRunId.get(runId) : undefined
    )

    // Now labelled → batched into one ensemble message with both lane labels.
    expect(messages).toHaveLength(1)
    expect(messages[0].content).toContain('Reviewer')
    expect(messages[0].content).toContain('Builder')
    expect(messages[0].content).toContain('participant-a')
  })

  it('leaves a record unlabelled when the resolver has no identity for its run', () => {
    const records = [makeRecord({ runId: 'solo-run', provider: 'claude' })]
    const messages = buildRecoveryMessagesForChat(
      'chat-1',
      records,
      new Set(),
      () => undefined
    )
    expect(messages).toHaveLength(1)
    // Solo run: still the plain "Claude run" message, no lane label parentheses.
    expect(messages[0].content).toContain('Claude run')
    expect(messages[0].content).not.toMatch(/run \(.*\/.*\)/)
  })

  it('avoids creating a batch when the exact batch message already exists', () => {
    const records = [
      makeRecord({
        runId: 'run-1',
        ensembleRole: 'Reviewer',
        ensembleParticipantId: 'participant-a'
      }),
      makeRecord({
        runId: 'run-2',
        ensembleRole: 'Builder',
        ensembleParticipantId: 'participant-b'
      })
    ]
    const existingMessageIds = new Set([
      recoveryBatchMessageId('chat-1', '2026-06-30T12:00:00.000Z')
    ])
    expect(buildRecoveryMessagesForChat('chat-1', records, existingMessageIds)).toHaveLength(0)
  })

  it('avoids creating a duplicate batch when all legacy per-record messages already exist', () => {
    const records = [
      makeRecord({
        runId: 'run-1',
        ensembleRole: 'Reviewer',
        ensembleParticipantId: 'participant-a'
      }),
      makeRecord({
        runId: 'run-2',
        ensembleRole: 'Builder',
        ensembleParticipantId: 'participant-b'
      })
    ]
    const existingMessageIds = new Set(['recovery-run-1-record', 'recovery-run-2-record'])
    expect(buildRecoveryMessagesForChat('chat-1', records, existingMessageIds)).toHaveLength(0)
  })
})
