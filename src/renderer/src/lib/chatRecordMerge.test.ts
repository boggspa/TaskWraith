import { describe, expect, it } from 'vitest'
import type { ChatListItem, ChatRecord } from '../../../main/store/types'
import {
  isChatSummaryRecord,
  mergeChatRecord,
  mergeChatRecordValue,
  reconcileChatRecords
} from './chatRecordMerge'

function chat(overrides: Partial<ChatRecord> = {}): ChatRecord {
  return {
    appChatId: 'chat-1',
    title: 'Hydrated chat',
    createdAt: 100,
    updatedAt: 100,
    archived: false,
    messages: [{ id: 'message-1', role: 'user', content: 'Hello', timestamp: 'now' }],
    runs: [{ runId: 'run-1', startedAt: 'now' }],
    ...overrides
  }
}

function summary(overrides: Partial<ChatListItem> = {}): ChatListItem {
  return {
    ...chat({
      messages: [],
      runs: [],
      title: 'Summary chat',
      updatedAt: 200
    }),
    summaryOnly: true,
    messageCount: 10,
    runCount: 2,
    searchText: 'summary text',
    searchPreview: 'summary preview',
    ...overrides
  }
}

describe('chat record merge helpers', () => {
  it('detects chat summary records', () => {
    expect(isChatSummaryRecord(summary())).toBe(true)
    expect(isChatSummaryRecord(chat())).toBe(false)
    expect(isChatSummaryRecord(null)).toBe(false)
  })

  it('preserves hydrated messages and runs when a summary refresh arrives', () => {
    const existing = chat({
      appChatId: 'chat-1',
      title: 'Hydrated',
      messages: [{ id: 'message-1', role: 'assistant', content: 'Live', timestamp: 'now' }],
      runs: [{ runId: 'run-1', startedAt: 'now', status: 'running' }]
    })
    const incoming = summary({
      appChatId: 'chat-1',
      title: 'Summary title',
      messages: [{ id: 'message-summary', role: 'user', content: 'Stale', timestamp: 'now' }],
      runs: [{ runId: 'run-summary', startedAt: 'now' }]
    })

    expect(mergeChatRecordValue(existing, incoming)).toEqual({
      ...existing,
      appChatId: 'chat-1',
      title: 'Summary title',
      createdAt: incoming.createdAt,
      updatedAt: incoming.updatedAt,
      archived: incoming.archived,
      messages: existing.messages,
      runs: existing.runs
    })
  })

  it('keeps hydrated ensemble roster when a lean summary refresh arrives', () => {
    const hydratedEnsemble = {
      enabled: true,
      maxParticipants: 15,
      participants: [
        {
          id: 'seat-1',
          provider: 'claude' as const,
          enabled: true,
          role: 'SolBoss',
          instructions: 'REAL seat brief — must survive summary refresh',
          order: 0
        },
        {
          id: 'seat-2',
          provider: 'cursor' as const,
          enabled: true,
          role: 'CursorWork',
          instructions: 'Another real brief',
          order: 1
        }
      ]
    }
    const leanSummaryEnsemble = {
      enabled: true,
      maxParticipants: 15,
      participants: [
        {
          id: 'seat-1',
          provider: 'claude' as const,
          enabled: true,
          role: 'SolBoss',
          instructions: '',
          order: 0
        },
        {
          id: 'seat-2',
          provider: 'cursor' as const,
          enabled: true,
          role: 'CursorWork',
          instructions: '',
          order: 1
        }
      ]
    }
    const existing = chat({
      appChatId: 'chat-1',
      chatKind: 'ensemble',
      ensemble: hydratedEnsemble
    })
    const incoming = summary({
      appChatId: 'chat-1',
      chatKind: 'ensemble',
      title: 'Lean list refresh',
      ensemble: leanSummaryEnsemble
    })

    const merged = mergeChatRecordValue(existing, incoming)

    expect(merged.ensemble).toBe(hydratedEnsemble)
    expect(merged.ensemble?.participants[0]?.instructions).toBe(
      'REAL seat brief — must survive summary refresh'
    )
    expect(merged.ensemble?.participants[1]?.instructions).toBe('Another real brief')
    expect(merged.title).toBe('Lean list refresh')
    expect(merged.messages).toBe(existing.messages)
  })

  it('uses incoming records directly when not protecting an existing hydrated chat', () => {
    const incomingSummary = summary()
    const incomingHydrated = chat({ title: 'Incoming hydrated' })

    expect(mergeChatRecordValue(undefined, incomingSummary)).toBe(incomingSummary)
    expect(mergeChatRecordValue(summary(), incomingHydrated)).toBe(incomingHydrated)
  })

  it('merges a chat into a sorted list', () => {
    const older = chat({ appChatId: 'older', updatedAt: 100 })
    const newer = chat({ appChatId: 'newer', updatedAt: 300 })
    const replacement = chat({ appChatId: 'older', updatedAt: 400, title: 'Updated older' })

    expect(mergeChatRecord([older, newer], replacement).map((entry) => entry.appChatId)).toEqual([
      'older',
      'newer'
    ])
  })

  it('reconciles incoming chats while preserving hydrated records', () => {
    const hydrated = chat({ appChatId: 'chat-1', title: 'Hydrated', updatedAt: 100 })
    const incoming = [
      summary({ appChatId: 'chat-1', title: 'Summary refresh', updatedAt: 300 }),
      chat({ appChatId: 'chat-2', title: 'Second', updatedAt: 200 })
    ]

    const reconciled = reconcileChatRecords([hydrated], incoming)

    expect(reconciled.map((entry) => entry.appChatId)).toEqual(['chat-1', 'chat-2'])
    expect(reconciled[0].messages).toBe(hydrated.messages)
    expect(reconciled[0].title).toBe('Summary refresh')
  })
})
