import { describe, expect, it } from 'vitest'
import type { ChatMessage, ChatRecord, ChatRun } from '../../../main/store/types'
import {
  childChatsForCloseout,
  closeoutSubagentRefreshFingerprint
} from './closeoutSubagentRefresh'

function message(
  id: string,
  role: ChatMessage['role'],
  content: string,
  metadata?: ChatMessage['metadata']
): ChatMessage {
  return {
    id,
    role,
    content,
    timestamp: '2026-08-08T12:00:10.000Z',
    ...(metadata ? { metadata } : {})
  }
}

function child(overrides: Partial<ChatRecord> = {}): ChatRecord {
  return {
    appChatId: 'child-a',
    title: 'Worker A',
    provider: 'codex',
    scope: 'workspace',
    parentChatId: 'parent-1',
    messages: [],
    runs: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides
  } as ChatRecord
}

const runId = 'run-parent-1'
const window = {
  startedAt: '2026-08-08T12:00:00.000Z',
  completedAt: '2026-08-08T12:01:00.000Z'
}

const delegation: ChatMessage = {
  ...message('del-a', 'system', '↪ Delegated.', {
    kind: 'subThreadDelegation',
    subThreadId: 'child-a',
    subThreadProvider: 'codex',
    subThreadTitle: 'Worker A',
    joinPolicy: { groupId: runId }
  }),
  timestamp: '2026-08-08T12:00:05.000Z'
}

const lateReturn: ChatMessage = {
  ...message('ret-a', 'tool', '↩ Result', {
    kind: 'subThreadReturn',
    subThreadId: 'child-a',
    subThreadProvider: 'codex',
    subThreadTitle: 'Worker A',
    subThreadOutcome: 'success',
    parallelResultWaveId: runId
  }),
  // After parent completedAt — still affiliated via wave/join stamps.
  timestamp: '2026-08-08T12:02:00.000Z'
}

describe('closeoutSubagentRefreshFingerprint', () => {
  it('changes when a late scoped subThreadReturn arrives', () => {
    const early = closeoutSubagentRefreshFingerprint({
      messages: [delegation],
      parentRunIds: new Set([runId]),
      window
    })
    const late = closeoutSubagentRefreshFingerprint({
      messages: [delegation, lateReturn],
      parentRunIds: new Set([runId]),
      window
    })
    expect(early).not.toBe(late)
    expect(early.length).toBeGreaterThan(0)
    expect(late.length).toBeGreaterThan(0)
  })

  it('changes when a child chat run status flips without a return card', () => {
    const created = closeoutSubagentRefreshFingerprint({
      messages: [delegation],
      parentRunIds: new Set([runId]),
      window,
      childChats: [child({ runs: [] })]
    })
    const running = closeoutSubagentRefreshFingerprint({
      messages: [delegation],
      parentRunIds: new Set([runId]),
      window,
      childChats: [
        child({
          runs: [
            {
              runId: 'child-run-1',
              provider: 'codex',
              startedAt: '2026-08-08T12:00:10.000Z',
              status: 'running'
            } satisfies ChatRun
          ]
        })
      ]
    })
    expect(created).not.toBe(running)
  })

  it('stays stable across unrelated assistant streaming deltas', () => {
    const baseMessages = [
      delegation,
      { ...message('a1', 'assistant', 'Working…'), runId, timestamp: '2026-08-08T12:00:20.000Z' }
    ]
    const streamed = [
      delegation,
      {
        ...message('a1', 'assistant', 'Working… still going with more tokens.'),
        runId,
        timestamp: '2026-08-08T12:00:20.000Z'
      }
    ]
    const a = closeoutSubagentRefreshFingerprint({
      messages: baseMessages,
      parentRunIds: new Set([runId]),
      window
    })
    const b = closeoutSubagentRefreshFingerprint({
      messages: streamed,
      parentRunIds: new Set([runId]),
      window
    })
    expect(a).toBe(b)
  })

  it('ignores return body content churn when status metadata is unchanged', () => {
    const retA = {
      ...lateReturn,
      content: '↩ Result from Codex\n\nLooks clean.'
    }
    const retB = {
      ...lateReturn,
      content: '↩ Result from Codex\n\nLooks clean. (extra prose)'
    }
    const a = closeoutSubagentRefreshFingerprint({
      messages: [delegation, retA],
      parentRunIds: new Set([runId]),
      window
    })
    const b = closeoutSubagentRefreshFingerprint({
      messages: [delegation, retB],
      parentRunIds: new Set([runId]),
      window
    })
    expect(a).toBe(b)
  })
  it('changes when a late return arrives even if childChats still report running', () => {
    const stillRunning = [
      child({
        runs: [
          {
            runId: 'child-run-1',
            provider: 'codex',
            startedAt: '2026-08-08T12:00:10.000Z',
            status: 'running'
          } satisfies ChatRun
        ]
      })
    ]
    const early = closeoutSubagentRefreshFingerprint({
      messages: [delegation],
      parentRunIds: new Set([runId]),
      window,
      childChats: stillRunning
    })
    const late = closeoutSubagentRefreshFingerprint({
      messages: [delegation, lateReturn],
      parentRunIds: new Set([runId]),
      window,
      childChats: stillRunning
    })
    expect(early).not.toBe(late)
  })
})

describe('childChatsForCloseout', () => {
  it('includes sub-threads and excludes side chats', () => {
    const parentId = 'parent-1'
    const kids = childChatsForCloseout(parentId, [
      child({ appChatId: 'sub-1', parentChatId: parentId }),
      child({
        appChatId: 'side-1',
        parentChatId: parentId,
        parentChatRelation: 'sideChat'
      }),
      child({ appChatId: 'other', parentChatId: 'parent-2' })
    ])
    expect(kids.map((c) => c.appChatId)).toEqual(['sub-1'])
  })
})
