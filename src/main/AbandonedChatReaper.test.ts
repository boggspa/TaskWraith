import { describe, expect, it } from 'vitest'
import type { ChatRecord } from './store/types'
import {
  deriveParentChatIds,
  isReapableAbandonedChat,
  reapableAbandonedChatIds
} from './AbandonedChatReaper'

/** Minimal abandoned single "New Chat" — the baseline reapable record. */
function chat(overrides: Partial<ChatRecord> = {}): ChatRecord {
  return {
    appChatId: 'c1',
    scope: 'workspace',
    chatKind: 'single',
    provider: 'claude',
    title: 'New Chat',
    workspaceId: 'ws1',
    workspacePath: '/ws1',
    createdAt: 1000,
    updatedAt: 1000,
    archived: false,
    messages: [],
    runs: [],
    ...overrides
  } as ChatRecord
}

describe('isReapableAbandonedChat — the baseline reaps', () => {
  it('reaps a bare empty single New Chat', () => {
    expect(isReapableAbandonedChat(chat())).toBe(true)
  })
  it('reaps a bare empty global New Chat', () => {
    expect(
      isReapableAbandonedChat(chat({ scope: 'global', workspaceId: undefined, workspacePath: undefined }))
    ).toBe(true)
  })
  it('protects null/undefined', () => {
    expect(isReapableAbandonedChat(null)).toBe(false)
    expect(isReapableAbandonedChat(undefined)).toBe(false)
  })
})

describe('isReapableAbandonedChat — content/started exclusions', () => {
  it('protects a chat with messages', () => {
    expect(isReapableAbandonedChat(chat({ messages: [{} as never] }))).toBe(false)
  })
  it('protects a chat with runs', () => {
    expect(isReapableAbandonedChat(chat({ runs: [{} as never] }))).toBe(false)
  })
  it('protects a bound provider/gemini session', () => {
    expect(isReapableAbandonedChat(chat({ linkedProviderSessionId: 'p' }))).toBe(false)
    expect(isReapableAbandonedChat(chat({ linkedGeminiSessionId: 'g' }))).toBe(false)
  })
  it('protects pruned ollama session memory', () => {
    expect(isReapableAbandonedChat(chat({ ollamaSessionMemory: {} as never }))).toBe(false)
  })
})

describe('isReapableAbandonedChat — explicit-intent exclusions', () => {
  it('protects pinned / pinnedNotes', () => {
    expect(isReapableAbandonedChat(chat({ pinned: true }))).toBe(false)
    expect(isReapableAbandonedChat(chat({ pinnedNotes: 'remember' }))).toBe(false)
    expect(isReapableAbandonedChat(chat({ pinnedNotes: '   ' }))).toBe(true) // whitespace-only ⇒ no note
  })
  it('protects an active goal', () => {
    expect(isReapableAbandonedChat(chat({ activeGoal: {} as never }))).toBe(false)
  })
  it('protects non-empty chatTodos, ignores empty lanes', () => {
    expect(isReapableAbandonedChat(chat({ chatTodos: { a: [{} as never] } }))).toBe(false)
    expect(isReapableAbandonedChat(chat({ chatTodos: { a: [] } }))).toBe(true)
  })
  it('protects scheduled solo wakeups', () => {
    expect(isReapableAbandonedChat(chat({ soloWakeups: { w: {} as never } }))).toBe(false)
    expect(isReapableAbandonedChat(chat({ soloWakeups: {} }))).toBe(true)
  })
  it('protects a chat renamed from the default title', () => {
    expect(isReapableAbandonedChat(chat({ title: 'My notes' }))).toBe(false)
    expect(isReapableAbandonedChat(chat({ chatKind: 'ensemble', title: 'New Ensemble' }), {
      isDefaultEnsemble: () => true
    })).toBe(true)
  })
})

describe('isReapableAbandonedChat — relationship exclusions', () => {
  it('protects a child chat (parent/sub-thread/side)', () => {
    expect(isReapableAbandonedChat(chat({ parentChatId: 'p' }))).toBe(false)
    expect(isReapableAbandonedChat(chat({ parentChatRelation: 'subThread' }))).toBe(false)
    expect(isReapableAbandonedChat(chat({ sideChatContext: {} as never }))).toBe(false)
  })
  it('protects a delegation/guest-configured chat', () => {
    expect(isReapableAbandonedChat(chat({ delegationContext: {} as never }))).toBe(false)
    expect(isReapableAbandonedChat(chat({ guestParticipant: {} as never }))).toBe(false)
  })
  it('protects a chat that HAS children', () => {
    expect(isReapableAbandonedChat(chat({ appChatId: 'parent' }), { parentChatIds: new Set(['parent']) })).toBe(
      false
    )
  })
})

describe('isReapableAbandonedChat — workflow / scheduled / draft / active', () => {
  it('protects a workflow-linked chat (saved def or in-flight compose)', () => {
    expect(isReapableAbandonedChat(chat(), { workflowChatIds: new Set(['c1']) })).toBe(false)
  })
  it('protects a chat targeted by a scheduled task', () => {
    expect(isReapableAbandonedChat(chat(), { scheduledChatIds: new Set(['c1']) })).toBe(false)
  })
  it('protects a chat with unsent composer text', () => {
    expect(isReapableAbandonedChat(chat(), { draftChatIds: new Set(['c1']) })).toBe(false)
  })
  it('protects the active / protected set', () => {
    expect(isReapableAbandonedChat(chat(), { protectedChatIds: new Set(['c1']) })).toBe(false)
  })
  it('protects the keepChatId (just-created in a replace)', () => {
    expect(isReapableAbandonedChat(chat(), { keepChatId: 'c1' })).toBe(false)
  })
})

describe('isReapableAbandonedChat — ensemble safety', () => {
  it('NEVER reaps an ensemble when no isDefaultEnsemble is supplied', () => {
    expect(isReapableAbandonedChat(chat({ chatKind: 'ensemble', title: 'New Ensemble' }))).toBe(false)
  })
  it('reaps a default-roster ensemble, protects an edited one', () => {
    const ens = chat({ chatKind: 'ensemble', title: 'New Ensemble', ensemble: {} as never })
    expect(isReapableAbandonedChat(ens, { isDefaultEnsemble: () => true })).toBe(true)
    expect(isReapableAbandonedChat(ens, { isDefaultEnsemble: () => false })).toBe(false)
  })
})

describe('isReapableAbandonedChat — archived + age gate', () => {
  it('protects an archived chat', () => {
    expect(isReapableAbandonedChat(chat({ archived: true }))).toBe(false)
  })
  it('age gate: protects young, reaps old (sweep mode)', () => {
    const young = chat({ createdAt: 9000 })
    expect(isReapableAbandonedChat(young, { now: 10000, ttlMs: 5000 })).toBe(false) // 1s old < 5s ttl
    expect(isReapableAbandonedChat(young, { now: 20000, ttlMs: 5000 })).toBe(true) // 11s old >= ttl
  })
  it('no age gate when ttl/now omitted (create-time replace)', () => {
    expect(isReapableAbandonedChat(chat({ createdAt: 9999 }))).toBe(true)
  })
})

describe('reapableAbandonedChatIds + deriveParentChatIds', () => {
  it('derives parent ids and protects parents from reaping', () => {
    const parent = chat({ appChatId: 'parent', messages: [] })
    const child = chat({ appChatId: 'child', parentChatId: 'parent' })
    const lonely = chat({ appChatId: 'lonely' })
    expect(deriveParentChatIds([parent, child, lonely])).toEqual(new Set(['parent']))
    // parent has a child ⇒ not reaped; child is a child ⇒ not reaped; lonely ⇒ reaped
    expect(reapableAbandonedChatIds([parent, child, lonely])).toEqual(['lonely'])
  })
  it('keeps the keepChatId out of the reap set', () => {
    const a = chat({ appChatId: 'a' })
    const b = chat({ appChatId: 'b' })
    expect(reapableAbandonedChatIds([a, b], { keepChatId: 'a' })).toEqual(['b'])
  })
})
