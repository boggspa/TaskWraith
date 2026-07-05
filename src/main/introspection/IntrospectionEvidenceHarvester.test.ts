import { describe, expect, it } from 'vitest'
import { createRunEventRecord } from '../RunEventStore'
import { harvestIntrospectionEvidence } from './IntrospectionEvidenceHarvester'
import type {
  ApprovalLedgerRecord,
  ChatRecord,
  MessageFeedbackReceipt,
  RunEventRecord
} from '../store/types'

const WINDOW = {
  windowStart: '2026-07-05T00:00:00.000Z',
  windowEnd: '2026-07-05T23:59:59.999Z',
  workspaceId: 'ws-1'
}

function harvest(substrate: Parameters<typeof harvestIntrospectionEvidence>[0]['substrate']) {
  return harvestIntrospectionEvidence({
    window: WINDOW,
    substrate,
    idFactory: () => 'ev-id'
  })
}

describe('IntrospectionEvidenceHarvester', () => {
  it('returns empty evidence for an empty window', () => {
    expect(harvest({})).toEqual([])
  })

  it('harvests approval denial and timeout from run events', () => {
    const events: RunEventRecord[] = [
      createRunEventRecord(
        {
          runId: 'run-1',
          chatId: 'chat-1',
          workspaceId: 'ws-1',
          kind: 'approval_response',
          phase: 'control',
          source: 'main',
          timestamp: '2026-07-05T10:00:00.000Z',
          summary: 'Approval response: decline',
          payload: { requestId: 'apr-1', action: 'decline' }
        },
        1
      ),
      createRunEventRecord(
        {
          runId: 'run-1',
          chatId: 'chat-1',
          workspaceId: 'ws-1',
          kind: 'approval_timer_timeout',
          phase: 'control',
          source: 'main',
          timestamp: '2026-07-05T11:00:00.000Z',
          summary: 'Approval timer fired after 30000ms'
        },
        2
      )
    ]

    const items = harvest({ runEvents: events })
    expect(items.map((item) => item.signal)).toEqual(['approval_denied', 'approval_timeout'])
    expect(items[0]?.citationToken).toContain('⟦recall:event:run-1:')
    expect(items[0]?.eventId).toBeTruthy()
  })

  it('harvests tool failures, loops, and provider errors', () => {
    const events: RunEventRecord[] = [
      createRunEventRecord(
        {
          runId: 'run-tool',
          chatId: 'chat-1',
          workspaceId: 'ws-1',
          provider: 'cursor',
          kind: 'provider_error',
          phase: 'normalized',
          source: 'provider',
          timestamp: '2026-07-05T09:00:00.000Z',
          summary: 'Provider stream failed'
        },
        1
      ),
      ...[2, 3, 4, 5].map((sequence) =>
        createRunEventRecord(
          {
            runId: 'run-tool',
            chatId: 'chat-1',
            workspaceId: 'ws-1',
            kind: 'tool',
            phase: 'normalized',
            source: 'renderer',
            timestamp: `2026-07-05T09:0${sequence}:00.000Z`,
            summary: `Tool call ${sequence}`,
            payload: {
              toolName: 'write_file',
              isError: sequence === 2 || sequence === 3
            }
          },
          sequence
        )
      )
    ]

    const signals = harvest({ runEvents: events }).map((item) => item.signal)
    expect(signals).toContain('provider_error')
    expect(signals).toContain('tool_failure')
    expect(signals).toContain('tool_loop')
    expect(signals).toContain('repeated_retry')
  })

  it('harvests approval friction from the approval ledger', () => {
    const approvalRecords: ApprovalLedgerRecord[] = [
      {
        schemaVersion: 1,
        id: 'ledger-1',
        approvalId: 'apr-deny',
        provider: 'codex',
        method: 'run_shell_command',
        title: 'Approve shell command',
        actions: ['accept', 'decline'],
        status: 'denied',
        requestedAt: '2026-07-05T08:00:00.000Z',
        respondedAt: '2026-07-05T08:01:00.000Z',
        decision: 'decline',
        decisionSource: 'user',
        expiration: { mode: 'on_decision', description: 'Denied by user.' },
        chatId: 'chat-1',
        runId: 'run-1',
        workspaceId: 'ws-1'
      }
    ]

    const items = harvest({ approvalRecords })
    expect(items).toHaveLength(1)
    expect(items[0]?.signal).toBe('approval_denied')
    expect(items[0]?.source).toBe('approval_ledger')
  })

  it('harvests feedback corrections and user corrections from chat messages', () => {
    const feedbackReceipts: MessageFeedbackReceipt[] = [
      {
        schemaVersion: 1,
        id: 'fb-1',
        source: 'message_metadata',
        action: 'set',
        chatId: 'chat-1',
        workspaceId: 'ws-1',
        messageId: 'msg-1',
        runId: 'run-1',
        provider: 'cursor',
        vote: 'down',
        at: Date.parse('2026-07-05T12:00:00.000Z'),
        recordedAt: Date.parse('2026-07-05T12:00:00.000Z'),
        note: 'Too verbose — keep final summaries concise.'
      }
    ]

    const chats: ChatRecord[] = [
      {
        appChatId: 'chat-1',
        title: 'Test chat',
        workspaceId: 'ws-1',
        createdAt: Date.parse('2026-07-04T00:00:00.000Z'),
        updatedAt: Date.parse('2026-07-05T12:30:00.000Z'),
        archived: false,
        provider: 'cursor',
        messages: [
          {
            id: 'msg-assistant',
            role: 'assistant',
            content: 'Here is a long summary of everything I changed.',
            timestamp: '2026-07-05T12:29:00.000Z',
            runId: 'run-1'
          },
          {
            id: 'msg-user',
            role: 'user',
            content: 'No — keep final summaries concise after edits.',
            timestamp: '2026-07-05T12:30:00.000Z',
            runId: 'run-1'
          }
        ],
        runs: []
      }
    ]

    const signals = harvest({ feedbackReceipts, chats }).map((item) => item.signal)
    expect(signals).toContain('feedback_down')
    expect(signals).toContain('feedback_correction')
    expect(signals).toContain('user_correction')
  })

  it('ignores substrate outside the window or workspace', () => {
    const events: RunEventRecord[] = [
      createRunEventRecord(
        {
          runId: 'run-old',
          chatId: 'chat-1',
          workspaceId: 'ws-1',
          kind: 'provider_error',
          phase: 'normalized',
          source: 'provider',
          timestamp: '2026-07-04T12:00:00.000Z',
          summary: 'Old provider error'
        },
        1
      ),
      createRunEventRecord(
        {
          runId: 'run-other',
          chatId: 'chat-2',
          workspaceId: 'ws-2',
          kind: 'provider_error',
          phase: 'normalized',
          source: 'provider',
          timestamp: '2026-07-05T12:00:00.000Z',
          summary: 'Other workspace error'
        },
        1
      )
    ]

    expect(harvest({ runEvents: events })).toEqual([])
  })
})