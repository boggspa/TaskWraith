import { describe, expect, it, vi } from 'vitest'
import { createRunEventRecord } from '../RunEventStore'
import { runManualIntrospection } from './IntrospectionRunService'
import type {
  ApprovalLedgerRecord,
  ChatRecord,
  IntrospectionRunRecord,
  MemoryProposalPack,
  MessageFeedbackReceipt,
  RunEventRecord
} from '../store/types'

function makeFakeStore(seed: {
  chats?: ChatRecord[]
  runEvents?: RunEventRecord[]
  approvalRecords?: ApprovalLedgerRecord[]
  feedbackReceipts?: MessageFeedbackReceipt[]
}) {
  const runs: IntrospectionRunRecord[] = []
  const packs: MemoryProposalPack[] = []

  return {
    getChats: vi.fn(() => seed.chats || []),
    getRunEvents: vi.fn(() => seed.runEvents || []),
    getApprovalLedger: vi.fn(() => seed.approvalRecords || []),
    getMessageFeedbackReceipts: vi.fn(() => seed.feedbackReceipts || []),
    createIntrospectionRun: vi.fn((input) => {
      const record: IntrospectionRunRecord = {
        schemaVersion: 1,
        id: input.id || 'run-1',
        status: input.status,
        trigger: input.trigger,
        windowStart: input.windowStart,
        windowEnd: input.windowEnd,
        evidenceItems: input.evidenceItems || [],
        createdAt: '2026-07-05T13:00:00.000Z',
        updatedAt: '2026-07-05T13:00:00.000Z',
        ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
        ...(input.workspacePath ? { workspacePath: input.workspacePath } : {}),
        ...(input.startedAt ? { startedAt: input.startedAt } : {})
      }
      runs.push(record)
      return record
    }),
    updateIntrospectionRun: vi.fn((id, partial) => {
      const index = runs.findIndex((run) => run.id === id)
      if (index < 0) return null
      runs[index] = { ...runs[index], ...partial, updatedAt: '2026-07-05T13:01:00.000Z' }
      return runs[index]
    }),
    saveMemoryProposalPack: vi.fn((pack) => {
      const saved: MemoryProposalPack = {
        schemaVersion: 1,
        id: 'pack-1',
        introspectionRunId: pack.introspectionRunId || 'run-1',
        windowStart: pack.windowStart || '2026-07-05T00:00:00.000Z',
        windowEnd: pack.windowEnd || '2026-07-05T23:59:59.999Z',
        proposals: pack.proposals || [],
        evidenceItemCount: pack.evidenceItemCount ?? 0,
        createdAt: '2026-07-05T13:00:00.000Z',
        updatedAt: '2026-07-05T13:00:00.000Z',
        ...(pack.workspaceId ? { workspaceId: pack.workspaceId } : {}),
        ...(pack.summary ? { summary: pack.summary } : {})
      }
      packs.push(saved)
      return saved
    }),
    runs,
    packs
  }
}

describe('IntrospectionRunService', () => {
  it('persists a manual run and proposal pack from harvested evidence', () => {
    const store = makeFakeStore({
      runEvents: [
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
        )
      ],
      feedbackReceipts: [
        {
          schemaVersion: 1,
          id: 'fb-1',
          source: 'message_metadata',
          action: 'set',
          chatId: 'chat-1',
          workspaceId: 'ws-1',
          messageId: 'msg-1',
          vote: 'down',
          at: Date.parse('2026-07-05T11:00:00.000Z'),
          recordedAt: Date.parse('2026-07-05T11:00:00.000Z'),
          note: 'Prefer concise summaries.'
        }
      ]
    })

    const result = runManualIntrospection(
      {
        store,
        now: () => '2026-07-05T13:00:00.000Z',
        uuid: () => 'uuid-1'
      },
      {
        windowStart: '2026-07-05T00:00:00.000Z',
        windowEnd: '2026-07-05T23:59:59.999Z',
        workspaceId: 'ws-1',
        workspacePath: '/repo'
      }
    )

    expect(result.evidenceCount).toBeGreaterThanOrEqual(2)
    expect(result.proposalCount).toBeGreaterThanOrEqual(1)
    expect(result.run.status).toBe('review_pending')
    expect(result.run.proposalPackId).toBe('pack-1')
    expect(result.pack.evidenceItemCount).toBe(result.evidenceCount)
    expect(store.createIntrospectionRun).toHaveBeenCalled()
    expect(store.saveMemoryProposalPack).toHaveBeenCalled()
  })

  it('returns an empty pack for a window with no evidence', () => {
    const store = makeFakeStore({})

    const result = runManualIntrospection(
      {
        store,
        now: () => '2026-07-05T13:00:00.000Z',
        uuid: () => 'uuid-empty'
      },
      {
        windowStart: '2026-07-05T00:00:00.000Z',
        windowEnd: '2026-07-05T23:59:59.999Z',
        workspaceId: 'ws-empty'
      }
    )

    expect(result.evidenceCount).toBe(0)
    expect(result.proposalCount).toBe(0)
    expect(result.run.status).toBe('review_pending')
    expect(result.pack.proposals).toEqual([])
  })
})