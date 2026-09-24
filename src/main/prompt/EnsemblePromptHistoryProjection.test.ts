import { describe, expect, it } from 'vitest'
import { ANTIGRAVITY_UNSUPPORTED_PERMISSION_CLAIM_NOTE } from '../antigravity/AntigravityPermissionClaimEvidence'
import type { ChatMessage, ToolActivity } from '../store/types'
import { projectTaggedTranscript } from './EnsemblePromptHistoryProjection'

function row(id: string, content: string, fields: Partial<ChatMessage> = {}): ChatMessage {
  return { id, role: 'user', content, timestamp: '2026-09-24T00:00:00.000Z', ...fields }
}

describe('synchronous Ensemble history projection', () => {
  it('preserves exact text, row receipts and freshness when widening to the previous seat turn', () => {
    const messages = [
      row('outside', 'Old history'),
      row('lead', 'Lead-in'),
      row('own', 'Prior work', {
        role: 'assistant',
        metadata: {
          ensembleProvider: 'codex',
          ensembleParticipantId: 'seat',
          ensembleRole: 'Worker'
        }
      }),
      row('peer', 'Peer update', { role: 'assistant' }),
      row('steer', '  Continue\r\ncarefully.  ')
    ]
    const before = structuredClone(messages)
    const full = projectTaggedTranscript(
      messages,
      1,
      new Map([['seat', 'p1']]),
      undefined,
      undefined,
      'seat'
    )
    const lines = [
      '[User]\nLead-in',
      '[Codex / Worker #p1]\nPrior work',
      '[Assistant]\nPeer update',
      '[User]\nContinue\ncarefully.'
    ]
    expect(full).toEqual({
      text: lines.join('\n\n'),
      truncated: true,
      eligibleMessageIds: ['outside', 'lead', 'own', 'peer', 'steer'],
      suppliedMessageIds: ['lead', 'own', 'peer', 'steer'],
      omittedMessageIds: ['outside'],
      suppliedRows: [
        { messageId: 'lead', start: 0, end: lines[0].length, freshness: 'replayed' },
        {
          messageId: 'own',
          start: lines[0].length + 2,
          end: lines.slice(0, 2).join('\n\n').length,
          freshness: 'replayed'
        },
        {
          messageId: 'peer',
          start: lines.slice(0, 2).join('\n\n').length + 2,
          end: lines.slice(0, 3).join('\n\n').length,
          freshness: 'fresh'
        },
        {
          messageId: 'steer',
          start: lines.slice(0, 3).join('\n\n').length + 2,
          end: lines.join('\n\n').length,
          freshness: 'fresh'
        }
      ]
    })

    const delta = projectTaggedTranscript(messages, 1, undefined, undefined, undefined, 'seat', {
      deltaOnly: true
    })
    expect(delta.text).toBe(lines.slice(2).join('\n\n'))
    expect(delta.suppliedMessageIds).toEqual(['peer', 'steer'])
    expect(delta.omittedMessageIds).toEqual(['outside', 'lead', 'own'])
    expect(delta.suppliedRows.every((receipt) => receipt.freshness === 'fresh')).toBe(true)
    expect(delta.truncated).toBe(false)

    const cold = projectTaggedTranscript(messages, 1, undefined, undefined, undefined, 'new-seat', {
      deltaOnly: true
    })
    expect(cold.text).toBe(delta.text)
    expect(cold.truncated).toBe(true)
    expect(messages).toEqual(before)
  })

  it('excludes only the selected round request while preserving prior, ordinary and fanout requests', () => {
    const messages = [
      row('prior', 'Prior request', {
        metadata: { kind: 'ensembleRoundPrompt', ensembleRoundId: 'prior-round' }
      }),
      row('opening', 'Opening request', {
        metadata: { kind: 'ensembleRoundPrompt', ensembleRoundId: 'round' }
      }),
      row('ordinary', 'Host steering'),
      row('lane', 'Fanout request', {
        metadata: { kind: 'ensembleRoundPrompt', ensembleRoundId: 'lane-round' }
      })
    ]
    const result = projectTaggedTranscript(
      messages,
      6,
      undefined,
      undefined,
      undefined,
      undefined,
      { excludeEnsembleRoundPromptRoundId: 'round' }
    )
    expect(result.text).toBe(
      '[User]\nPrior request\n\n[User]\nHost steering\n\n[User]\nFanout request'
    )
    expect(result.eligibleMessageIds).toEqual(['prior', 'ordinary', 'lane'])
    expect(result.suppliedMessageIds).toEqual(result.eligibleMessageIds)
    expect(result.omittedMessageIds).toEqual([])
    expect(result.truncated).toBe(false)
  })

  it('keeps newest rows and exact receipt offsets after a character-budget warning', () => {
    const messages = [row('older', 'a'.repeat(4000)), row('newer', 'b'.repeat(4000))]
    const result = projectTaggedTranscript(messages, 6, undefined, 5000)
    const warning = '[Transcript truncated to fit Ensemble V1 context budget.]\n\n'
    expect(result.text).toBe(warning + '[User]\n' + 'b'.repeat(4000))
    expect(result.suppliedMessageIds).toEqual(['newer'])
    expect(result.omittedMessageIds).toEqual(['older'])
    expect(result.suppliedRows).toEqual([
      { messageId: 'newer', start: warning.length, end: result.text.length, freshness: 'fresh' }
    ])
    expect(result.truncated).toBe(true)
  })

  it('reads nested tool evidence again on each invocation without relying on a persistence revision', () => {
    const activity: ToolActivity = {
      id: 'permission-result',
      toolName: 'read_file',
      displayName: 'Read file',
      category: 'read',
      status: 'success'
    }
    const messages = [
      row('tool', '', { role: 'tool', runId: 'agy-run', toolActivities: [activity] }),
      row('claim', 'I cannot read this file because permission was denied.', {
        role: 'assistant',
        runId: 'agy-run',
        metadata: { ensembleProvider: 'antigravity' }
      })
    ]
    const first = projectTaggedTranscript(messages, 6)
    expect(first.text).toContain(ANTIGRAVITY_UNSUPPORTED_PERMISSION_CLAIM_NOTE)
    activity.status = 'error'
    activity.resultSummary = 'read_file: permission denied'
    const second = projectTaggedTranscript(messages, 6)
    expect(second.text).not.toContain(ANTIGRAVITY_UNSUPPORTED_PERMISSION_CLAIM_NOTE)
    expect(second.suppliedMessageIds).toEqual(['claim'])
    expect(second.eligibleMessageIds).toEqual(['claim'])
    expect(first.text).toContain(ANTIGRAVITY_UNSUPPORTED_PERMISSION_CLAIM_NOTE)
  })

  it('observes in-place origin and content changes without changing an earlier result', () => {
    const origin = { channel: 'local-control' as const, label: 'Before', pid: 42 }
    const message = row('request', 'Initial direction', { metadata: { origin } })
    const first = projectTaggedTranscript([message], 6)
    origin.label = 'After'
    message.content = 'Updated direction'
    const second = projectTaggedTranscript([message], 6)
    expect(first.text).toBe('[User]\n[External Agent · Before · PID 42]\nInitial direction')
    expect(second.text).toBe('[User]\n[External Agent · After · PID 42]\nUpdated direction')
  })

  it('collects a long run without repeatedly reading the accumulated tool-activity prefix', () => {
    let idReads = 0
    const activityCount = 512
    const messages = Array.from({ length: activityCount }, (_, index) =>
      row(`tool-${index}`, '', {
        role: 'tool',
        runId: 'long-run',
        toolActivities: [
          {
            get id() {
              idReads += 1
              return `activity-${index}`
            },
            toolName: 'read_file',
            displayName: 'Read file',
            category: 'read',
            status: index === activityCount - 1 ? 'error' : 'success',
            resultSummary:
              index === activityCount - 1
                ? 'read_file: permission denied'
                : 'Read file successfully'
          }
        ]
      })
    )
    messages.push(
      row('claim', 'I cannot read this file because permission was denied.', {
        role: 'assistant',
        runId: 'long-run',
        metadata: { ensembleProvider: 'antigravity' }
      })
    )

    const result = projectTaggedTranscript(messages, 6)
    expect(result.suppliedMessageIds).toEqual(['claim'])
    expect(result.text).not.toContain(ANTIGRAVITY_UNSUPPORTED_PERMISSION_CLAIM_NOTE)
    // A deterministic work bound: no wall-clock threshold or benchmark load.
    expect(idReads).toBeLessThanOrEqual(activityCount * 2)
  })

  it('uses the last duplicate tool result within its own run without borrowing another run’s denial', () => {
    const tool = (runId: string, id: string, denied: boolean): ChatMessage =>
      row(id, '', {
        role: 'tool',
        runId,
        toolActivities: [
          {
            id: 'shared-tool-id',
            toolName: 'read_file',
            displayName: 'Read file',
            category: 'read',
            status: denied ? 'error' : 'success',
            resultSummary: denied ? 'read_file: permission denied' : 'Read file successfully'
          }
        ]
      })
    const claim = (runId: string): ChatMessage =>
      row(`claim-${runId}`, 'I cannot read this file because permission was denied.', {
        role: 'assistant',
        runId,
        metadata: { ensembleProvider: 'antigravity' }
      })
    const result = projectTaggedTranscript(
      [
        tool('allowed', 'old-denial', true),
        tool('denied', 'old-success', false),
        tool('allowed', 'new-success', false),
        tool('denied', 'new-denial', true),
        claim('allowed'),
        claim('denied')
      ],
      6
    )
    const rendered = result.suppliedRows.map(({ start, end }) => result.text.slice(start, end))
    expect(result.suppliedMessageIds).toEqual(['claim-allowed', 'claim-denied'])
    expect(rendered[0]).toContain(ANTIGRAVITY_UNSUPPORTED_PERMISSION_CLAIM_NOTE)
    expect(rendered[1]).not.toContain(ANTIGRAVITY_UNSUPPORTED_PERMISSION_CLAIM_NOTE)
  })
})
