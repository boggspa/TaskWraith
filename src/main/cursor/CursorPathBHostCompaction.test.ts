import { describe, expect, it } from 'vitest'

import {
  planCursorPathBHostCompaction,
  compactCursorPathBHostContext
} from './CursorPathBHostCompaction'
import type { ChatMessage, ChatRecord, EnsembleParticipant } from '../store/types'

function msg(id: string, role: ChatMessage['role'], content: string): ChatMessage {
  return { id, role, content, timestamp: '2026-09-07T00:00:00.000Z' }
}

function cursorSeat(overrides: Partial<EnsembleParticipant> = {}): EnsembleParticipant {
  return {
    id: 'seat-cursor',
    provider: 'cursor',
    role: 'Captain',
    model: 'composer-2-fast',
    linkedProviderSessionId: 'cursor-session-1',
    promptShellVersion: 'shell-v1',
    promptDynamicStateVersion: 'dyn-v1',
    ...overrides
  } as EnsembleParticipant
}

function makeChat(overrides: Partial<ChatRecord> = {}): ChatRecord {
  return {
    appChatId: 'chat-1',
    title: 'Chat',
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    messages: [],
    runs: [],
    ...overrides
  }
}

function chatWithSeat(participant: EnsembleParticipant): ChatRecord {
  return makeChat({
    title: 'Ensemble',
    messages: Array.from({ length: 16 }, (_, index) =>
      msg(`m${index}`, index % 2 === 0 ? 'user' : 'assistant', `row ${index}`)
    ),
    provider: 'claude',
    ensemble: {
      enabled: true,
      maxParticipants: 2,
      participants: [
        participant,
        { id: 'seat-other', provider: 'codex', role: 'Worker' } as EnsembleParticipant
      ]
    }
  })
}

describe('planCursorPathBHostCompaction', () => {
  it('extracts a Path-B summary and resets the ensemble seat session', () => {
    const plan = planCursorPathBHostCompaction({
      chat: chatWithSeat(cursorSeat()),
      participantId: 'seat-cursor',
      roundPrompt: 'Continue the Path-B wiring.',
      nowIso: '2026-09-07T15:26:00.000Z',
      preTokens: 24_000,
      eventUuid: 'cursor-host-compact-1'
    })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.summary.provider).toBe('cursor')
    expect(plan.summary.text).toContain('Continue the Path-B wiring.')
    expect(plan.summary.text).toContain('row 0')
    const nextSeat = plan.nextChat.ensemble?.participants.find((seat) => seat.id === 'seat-cursor')
    expect(nextSeat?.linkedProviderSessionId).toBeNull()
    expect(nextSeat?.promptShellVersion).toBeUndefined()
    expect(nextSeat?.promptDynamicStateVersion).toBeUndefined()
    expect(nextSeat?.contextCompactionSummary?.text).toBe(plan.summary.text)
    expect(
      plan.nextChat.ensemble?.participants.find((seat) => seat.id === 'seat-other')?.provider
    ).toBe('codex')
    expect(plan.signal).toMatchObject({
      kind: 'completed',
      telemetry: {
        provider: 'cursor',
        trigger: 'manual',
        preTokens: 24_000,
        eventUuid: 'cursor-host-compact-1'
      }
    })
  })

  it('rejects a non-Cursor ensemble seat', () => {
    const plan = planCursorPathBHostCompaction({
      chat: chatWithSeat({ ...cursorSeat(), provider: 'codex' }),
      participantId: 'seat-cursor',
      roundPrompt: 'x',
      nowIso: '2026-09-07T15:26:00.000Z',
      eventUuid: 'cursor-host-compact-2'
    })
    expect(plan).toEqual({
      ok: false,
      error: 'Participant provider does not match the request.'
    })
  })

  it('resets a solo Cursor chat without spawning a compact RPC', () => {
    const solo = makeChat({
      appChatId: 'solo-1',
      title: 'Solo',
      provider: 'cursor',
      linkedProviderSessionId: 'cursor-solo-session',
      messages: [msg('u1', 'user', 'Ship the overlay'), msg('a1', 'assistant', 'Working on it')]
    })
    const plan = planCursorPathBHostCompaction({
      chat: solo,
      roundPrompt: 'Ship the overlay',
      nowIso: '2026-09-07T15:26:00.000Z',
      eventUuid: 'cursor-host-compact-solo'
    })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.nextChat.linkedProviderSessionId).toBeUndefined()
    expect(plan.nextChat.contextCompactionSummary?.provider).toBe('cursor')
    expect(plan.nextChat.contextCompactionSummary?.text).toContain('Ship the overlay')
    expect(plan.signal.telemetry.trigger).toBe('manual')
  })
})

describe('compactCursorPathBHostContext', () => {
  it('persists the extractive plan only while the reservation can write', () => {
    const saved: ChatRecord[] = []
    const chat = makeChat({
      appChatId: 'solo-1',
      title: 'Solo',
      provider: 'cursor',
      linkedProviderSessionId: 'cursor-solo-session',
      messages: [msg('u1', 'user', 'Ship the overlay'), msg('a1', 'assistant', 'Working on it')]
    })
    const durable: Array<{ kind: string; summary: string }> = []
    const progress: string[] = []
    const result = compactCursorPathBHostContext(
      {
        chatId: 'solo-1',
        trigger: 'manual',
        reservationCanWrite: () => true
      },
      {
        getChat: () => chat,
        saveChat: (next) => {
          saved.push(next)
        },
        now: () => 99,
        nowIso: () => '2026-09-07T15:26:00.000Z',
        appendCard: () => undefined,
        appendDurableRunEvent: ({ kind, summary }) => {
          durable.push({ kind, summary })
        },
        broadcastProgress: (status) => {
          progress.push(status)
        },
        seatPreTokens: () => undefined
      }
    )
    expect(result).toEqual({ ok: true })
    expect(saved[0]?.linkedProviderSessionId).toBeUndefined()
    expect(saved[0]?.contextCompactionSummary?.provider).toBe('cursor')
    expect(saved[0]?.updatedAt).toBe(99)
    expect(durable).toEqual([
      expect.objectContaining({
        kind: 'context_compaction',
        summary: expect.stringContaining('Context compacted')
      })
    ])
    expect(progress).toEqual(['started', 'completed'])
  })

  it('does not persist after a history-deletion cancel', () => {
    const result = compactCursorPathBHostContext(
      {
        chatId: 'solo-1',
        reservationCanWrite: () => false
      },
      {
        getChat: () => {
          throw new Error('should not read chat after cancel')
        },
        saveChat: () => {
          throw new Error('should not save')
        },
        now: () => 0,
        nowIso: () => '2026-09-07T15:26:00.000Z',
        appendCard: () => undefined,
        broadcastProgress: () => undefined,
        seatPreTokens: () => undefined
      }
    )
    expect(result).toEqual({
      ok: false,
      error: 'Compaction was cancelled for history deletion.'
    })
  })
})
