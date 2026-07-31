import { describe, expect, it } from 'vitest'
import type { ChatRecord } from './store/types'
import {
  deriveParentChatIds,
  isReapableAbandonedChat,
  reapAbandonedChats,
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
  it('protects a delegation-configured chat', () => {
    expect(isReapableAbandonedChat(chat({ delegationContext: {} as never }))).toBe(false)
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

describe('isReapableAbandonedChat — iOS remote drafts are off-limits', () => {
  it('never reaps a chat with the remoteDraft provider metadata', () => {
    expect(isReapableAbandonedChat(chat({ providerMetadata: { remoteDraft: { source: 'ios' } } }))).toBe(
      false
    )
  })
  it('never reaps a legacy ios- prefixed draft', () => {
    expect(isReapableAbandonedChat(chat({ appChatId: 'ios-abc' }))).toBe(false)
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

describe('reapableAbandonedChatIds — survivorCount quota ("one survivable New Chat")', () => {
  it('defaults to zero survivors (back-compat: every reapable chat is listed)', () => {
    const a = chat({ appChatId: 'a', createdAt: 1000 })
    const b = chat({ appChatId: 'b', createdAt: 2000 })
    expect(reapableAbandonedChatIds([a, b])).toEqual(['a', 'b'])
    expect(reapableAbandonedChatIds([a, b], { survivorCount: 0 })).toEqual(['a', 'b'])
  })

  it('keeps the newest reapable chat and reaps the older ones', () => {
    const oldest = chat({ appChatId: 'oldest', createdAt: 1000 })
    const middle = chat({ appChatId: 'middle', createdAt: 2000 })
    const newest = chat({ appChatId: 'newest', createdAt: 3000 })
    expect(reapableAbandonedChatIds([oldest, middle, newest], { survivorCount: 1 })).toEqual([
      'oldest',
      'middle'
    ])
  })

  it('survives everything when reapable count <= survivorCount', () => {
    const only = chat({ appChatId: 'only', createdAt: 1000 })
    expect(reapableAbandonedChatIds([only], { survivorCount: 1 })).toEqual([])
    expect(reapableAbandonedChatIds([], { survivorCount: 1 })).toEqual([])
  })

  it('coexists with keepChatId: the just-created chat plus one survivor stay', () => {
    const a = chat({ appChatId: 'a', createdAt: 1000 }) // oldest ⇒ reaped
    const b = chat({ appChatId: 'b', createdAt: 2000 }) // newest non-keep ⇒ survivor
    const c = chat({ appChatId: 'c', createdAt: 3000 }) // just created ⇒ keep
    expect(reapableAbandonedChatIds([a, b, c], { keepChatId: 'c', survivorCount: 1 })).toEqual(['a'])
  })

  it('breaks createdAt ties deterministically by appChatId (desc)', () => {
    const a = chat({ appChatId: 'a', createdAt: 1000 })
    const b = chat({ appChatId: 'b', createdAt: 1000 })
    expect(reapableAbandonedChatIds([a, b], { survivorCount: 1 })).toEqual(['a'])
    expect(reapableAbandonedChatIds([b, a], { survivorCount: 1 })).toEqual(['a'])
  })

  it('never spends the survivor slot on an already-protected chat', () => {
    // The quota is evaluated on chats the predicate ALREADY deemed reapable,
    // so a pinned (protected) newest chat cannot consume the slot.
    const pinned = chat({ appChatId: 'pinned', createdAt: 3000, pinned: true })
    const old = chat({ appChatId: 'old', createdAt: 1000 })
    const mid = chat({ appChatId: 'mid', createdAt: 2000 })
    expect(reapableAbandonedChatIds([pinned, old, mid], { survivorCount: 1 })).toEqual(['old'])
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

describe('reapAbandonedChats (orchestration)', () => {
  it('deletes exactly the reapable ids, protects everything else, and keeps one survivable New Chat', () => {
    const kept = chat({ appChatId: 'kept' }) // the just-created chat
    const started = chat({ appChatId: 'started', messages: [{} as never] })
    const wf = chat({ appChatId: 'wf' }) // backs a workflow
    const sched = chat({ appChatId: 'sched' }) // scheduled task target
    const drafting = chat({ appChatId: 'drafting' }) // unsent composer text
    const active = chat({ appChatId: 'active' }) // open in a pane
    const ensemble = chat({ appChatId: 'ens', chatKind: 'ensemble', title: 'New Ensemble' })
    const tombstone1 = chat({ appChatId: 't1', createdAt: 900 }) // older ⇒ reaped
    const tombstone2 = chat({ appChatId: 't2', createdAt: 1100 }) // newest ⇒ the 1 survivor

    const deleted: string[] = []
    const reaped = reapAbandonedChats(
      {
        getChats: () => [kept, started, wf, sched, drafting, active, ensemble, tombstone1, tombstone2],
        getWorkflowChatIds: () => new Set(['wf']),
        getScheduledChatIds: () => new Set(['sched']),
        deleteChat: (id) => deleted.push(id)
      },
      { keepChatId: 'kept', draftChatIds: ['drafting'], protectedChatIds: ['active'] }
    )

    // t1 (older) is reaped; t2 (newest) survives per the "one survivable New
    // Chat" create-time quota; ensemble is never reaped here.
    expect(reaped).toEqual(['t1'])
    expect(deleted).toEqual(['t1'])
  })

  it('caps the burst at `limit`, leaving the rest for the next create', () => {
    const tombstones = Array.from({ length: 5 }, (_, i) => chat({ appChatId: `t${i}` }))
    const deleted: string[] = []
    const reaped = reapAbandonedChats(
      {
        getChats: () => tombstones,
        getWorkflowChatIds: () => new Set(),
        getScheduledChatIds: () => new Set(),
        deleteChat: (id) => deleted.push(id)
      },
      {},
      2
    )
    expect(reaped).toHaveLength(2)
    expect(deleted).toHaveLength(2)
  })

  it('returns [] and deletes nothing when there is nothing abandoned', () => {
    const deleted: string[] = []
    const reaped = reapAbandonedChats({
      getChats: () => [chat({ appChatId: 'a', messages: [{} as never] })],
      getWorkflowChatIds: () => new Set(),
      getScheduledChatIds: () => new Set(),
      deleteChat: (id) => deleted.push(id)
    })
    expect(reaped).toEqual([])
    expect(deleted).toEqual([])
  })
})

describe('shared chats are never abandoned', () => {
  it('protects a chat with a live share even at zero messages and zero runs', () => {
    // The host invites someone and waits. Every other "started" check reads
    // that as abandoned, because a share lives in its own store.
    expect(reapableAbandonedChatIds([chat({ appChatId: 'shared-1' })], {})).toEqual(['shared-1'])
    expect(
      reapableAbandonedChatIds([chat({ appChatId: 'shared-1' })], { sharedChatIds: new Set(['shared-1']) })
    ).toEqual([])
  })

  it('protects a chat whose only content is a contribution awaiting review', () => {
    // A held contribution is not in chat.messages — it is in the queue — so the
    // message-count guard cannot see it.
    expect(
      reapableAbandonedChatIds([chat({ appChatId: 'queued-1' })], { sharedChatIds: new Set(['queued-1']) })
    ).toEqual([])
  })
})
