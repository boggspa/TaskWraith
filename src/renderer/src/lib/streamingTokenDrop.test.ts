import { describe, it, expect } from 'vitest'
import type { ChatMessage, ChatRecord } from '../../../main/store/types'
import { applyAssistantDelta, type AssistantDeltaInput } from './applyAssistantDelta'
import { reconcileChatRefMap, RECENTLY_COMPLETED_WINDOW_MS } from './reconcileChatRefMap'

/*
 * Token-drop regression simulation — the gate for the planned rAF render-
 * coalescer (#1). It wires the REAL extracted production functions
 * (applyAssistantDelta = the accumulation, reconcileChatRefMap = the
 * preserve logic) into a deterministic model of the streaming loop:
 *
 *   - chatByIdRef is written SYNCHRONOUSLY on every delta (the invariant
 *     the coalescer must keep),
 *   - React `chats` state LAGS the ref (commits are deferred / batched),
 *   - the reconcile effect fires with a STALE closed-over `chats`
 *     snapshot while the ref has already advanced — the exact race the
 *     App.tsx "Phase L2" comment documents.
 *
 * The contract under test: as long as the ref is written synchronously and
 * the chat stays in the preserve set, the final accumulated content is
 * byte-for-byte the concatenation of every delta, no matter how the
 * commits and reconciles interleave. The negative-control tests flip the
 * preserve set off and assert the clobber DOES happen — proving these
 * tests actually exercise the token-drop path.
 */

const userMsg: ChatMessage = { id: 'u', role: 'user', content: 'q', timestamp: '' }

function makeChat(appChatId: string, messages: ChatMessage[]): ChatRecord {
  return {
    appChatId,
    title: appChatId,
    messages,
    runs: [],
    createdAt: 0,
    updatedAt: 0,
    archived: false
  } as unknown as ChatRecord
}

interface ReconcileOpts {
  chats: ChatRecord[]
  currentChat?: ChatRecord | null
  activeRunChatId?: string | null
  activeRunChatIds?: ReadonlySet<string>
  recentlyCompleted?: ReadonlyMap<string, number>
  now?: number
}

function createSim() {
  let liveRef = new Map<string, ChatRecord>()
  let idc = 0
  const deps = { createMessageId: () => `g${++idc}`, now: () => 'T' }
  return {
    seed(chatId: string, messages: ChatMessage[]) {
      liveRef.set(chatId, makeChat(chatId, messages))
    },
    get ref() {
      return liveRef
    },
    applyDelta(chatId: string, incoming: string, opts: Partial<AssistantDeltaInput> = {}) {
      const rec = liveRef.get(chatId)
      if (!rec) throw new Error(`no chat ${chatId}`)
      const messages = applyAssistantDelta(rec.messages, { incoming, ...opts }, deps)
      liveRef.set(chatId, { ...rec, messages })
    },
    /** A React commit: snapshot the ref into a detached `chats` value. */
    snapshot(): ChatRecord[] {
      return [...liveRef.values()].map((r) => ({
        ...r,
        messages: r.messages.map((m) => ({ ...m }))
      }))
    },
    reconcile(opts: ReconcileOpts) {
      liveRef = reconcileChatRefMap({
        chats: opts.chats,
        currentChat: opts.currentChat ?? null,
        prev: liveRef,
        activeRunChatId: opts.activeRunChatId ?? null,
        activeRunChatIds: opts.activeRunChatIds ?? new Set(),
        recentlyCompleted: opts.recentlyCompleted ?? new Map(),
        now: opts.now ?? 0
      })
    },
    content(chatId: string): string | undefined {
      const rec = liveRef.get(chatId)
      if (!rec) return undefined
      return [...rec.messages].reverse().find((m) => m.role === 'assistant')?.content
    },
    /** Models the SEPARATE [currentChat] effect in App.tsx, now guarded for
     *  #1: it seeds the ref from the (React-state-derived, possibly stale)
     *  currentChat, but SKIPS a chat that is actively streaming so a lagging
     *  currentChat under the coalescer can't clobber the byte-exact ref. Pass
     *  the active set to exercise the guard. */
    currentChatEffect(
      currentChat: ChatRecord | null | undefined,
      opts: { activeRunChatId?: string | null; activeRunChatIds?: ReadonlySet<string> } = {}
    ) {
      const id = currentChat?.appChatId
      if (!id || !currentChat) return
      const streaming = opts.activeRunChatId === id || (opts.activeRunChatIds?.has(id) ?? false)
      if (!streaming) liveRef.set(id, currentChat)
    },
    /** Models the fixed handleSelectChat ref write (App.tsx): selecting a chat
     *  writes a record into the ref, but for an actively-streaming chat it
     *  prefers the byte-exact ref entry over the (possibly stale) list record,
     *  so selection can't clobber in-flight tokens. */
    selectChatEffect(
      listRecord: ChatRecord,
      opts: { activeRunChatId?: string | null; activeRunChatIds?: ReadonlySet<string> } = {}
    ): ChatRecord {
      const id = listRecord.appChatId
      const cached = liveRef.get(id)
      const streaming = opts.activeRunChatId === id || (opts.activeRunChatIds?.has(id) ?? false)
      const selected = cached && streaming ? cached : listRecord
      liveRef.set(id, selected)
      return selected
    },
    /** A detached single-record snapshot — stand-in for a React currentChat. */
    recordSnapshot(chatId: string): ChatRecord | null {
      const rec = liveRef.get(chatId)
      if (!rec) return null
      return { ...rec, messages: rec.messages.map((m) => ({ ...m })) }
    }
  }
}

// Deterministic PRNG so the fuzz test is reproducible.
function lcg(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 0x100000000
  }
}

describe('token-drop reconcile — the documented Phase L2 race', () => {
  it('preserves byte-exact content when a stale reconcile fires mid-stream', () => {
    const sim = createSim()
    sim.seed('A', [userMsg])
    for (const c of ['a', 'b', 'c', 'd', 'e']) sim.applyDelta('A', c)
    expect(sim.content('A')).toBe('abcde')

    const stale = sim.snapshot() // React committed "abcde"
    sim.applyDelta('A', 'f') // ref → abcdef (commit pending)
    sim.applyDelta('A', 'g') // ref → abcdefg (commit pending)
    // Reconcile fires with the STALE "abcde" snapshot while a run is active.
    sim.reconcile({ chats: stale, activeRunChatIds: new Set(['A']), now: 1 })
    sim.applyDelta('A', 'h')

    expect(sim.content('A')).toBe('abcdefgh') // nothing dropped
  })

  it('NEGATIVE CONTROL: with no preserve, the same sequence loses tokens', () => {
    const sim = createSim()
    sim.seed('A', [userMsg])
    for (const c of ['a', 'b', 'c', 'd', 'e']) sim.applyDelta('A', c)
    const stale = sim.snapshot()
    sim.applyDelta('A', 'f')
    sim.applyDelta('A', 'g')
    // No active/recent run → the naive rebuild clobbers the ref to "abcde".
    sim.reconcile({ chats: stale, now: 1 })
    sim.applyDelta('A', 'h')

    expect(sim.content('A')).toBe('abcdeh') // matches the documented garbling
    expect(sim.content('A')).not.toBe('abcdefgh')
  })
})

describe('token-drop reconcile — run-start window (Phase K gap)', () => {
  it('activeRunChatId alone preserves content before the activeRuns registry is populated', () => {
    const sim = createSim()
    sim.seed('A', [userMsg])
    sim.applyDelta('A', 'Hello')
    const stale = sim.snapshot()
    sim.applyDelta('A', ' world') // ref ahead of the committed snapshot

    // The registry entry has NOT been written yet (the documented gap). Many
    // reconciles can fire in this window; only activeRunChatId guards them.
    for (let i = 0; i < 5; i++) {
      sim.reconcile({ chats: stale, activeRunChatId: 'A', activeRunChatIds: new Set(), now: i })
    }
    sim.applyDelta('A', '!')
    expect(sim.content('A')).toBe('Hello world!')
  })

  it('NEGATIVE CONTROL: dropping the activeRunChatId predicate regresses the gap', () => {
    const sim = createSim()
    sim.seed('A', [userMsg])
    sim.applyDelta('A', 'Hello')
    const stale = sim.snapshot()
    sim.applyDelta('A', ' world')
    // Simulate the bug: neither predicate set during the gap.
    sim.reconcile({ chats: stale, activeRunChatId: null, activeRunChatIds: new Set(), now: 0 })
    sim.applyDelta('A', '!')
    expect(sim.content('A')).toBe('Hello!') // " world" lost
  })
})

describe('token-drop reconcile — chat switch mid-stream', () => {
  it('keeps streaming chat A intact when the user switches to chat B', () => {
    const sim = createSim()
    sim.seed('A', [userMsg])
    sim.seed('B', [{ ...userMsg, content: 'other question' }])
    sim.applyDelta('A', 'Hello')
    const stale = sim.snapshot()
    sim.applyDelta('A', ' wor') // ref ahead

    // Switch to B mid-stream: currentChat = B, A still streaming (active).
    sim.reconcile({
      chats: stale,
      currentChat: sim.ref.get('B'),
      activeRunChatIds: new Set(['A']),
      now: 1
    })
    sim.applyDelta('A', 'ld')

    expect(sim.content('A')).toBe('Hello world') // A preserved across the switch
    expect(sim.ref.has('B')).toBe(true) // B still present as the current chat
  })
})

describe('token-drop reconcile — coalescer contract (forward-looking #1)', () => {
  it('byte-exact when React commits are batched/deferred and reconciles lag', () => {
    const sim = createSim()
    sim.seed('A', [userMsg])
    const deltas = Array.from({ length: 60 }, (_, i) => `t${i} `)
    let committed = sim.snapshot() // starts as [A: user only]

    for (let i = 0; i < deltas.length; i++) {
      sim.applyDelta('A', deltas[i]) // ref written synchronously every delta
      if (i % 10 === 9) committed = sim.snapshot() // coalesced commit (every 10 deltas)
      if (i % 7 === 3) {
        // reconcile fires off-cadence against the LAGGING committed snapshot
        sim.reconcile({ chats: committed, activeRunChatIds: new Set(['A']), now: i })
      }
    }
    expect(sim.content('A')).toBe(deltas.join(''))
  })
})

describe('token-drop reconcile — recently-completed window', () => {
  it('preserves final streamed content for a late reconcile after the run exits', () => {
    const sim = createSim()
    sim.seed('A', [userMsg])
    sim.applyDelta('A', 'Final')
    const staleMidStream = sim.snapshot() // React still shows "Final"
    sim.applyDelta('A', ' answer') // ref → "Final answer"; run then exits

    // Within the window: still preserved even though no longer active.
    sim.reconcile({
      chats: staleMidStream,
      recentlyCompleted: new Map([['A', 100]]),
      now: 100 + (RECENTLY_COMPLETED_WINDOW_MS - 1)
    })
    expect(sim.content('A')).toBe('Final answer')

    // After the window: React state becomes authoritative (the durable
    // broadcast is expected to have caught up by then).
    sim.reconcile({
      chats: staleMidStream,
      recentlyCompleted: new Map([['A', 100]]),
      now: 100 + RECENTLY_COMPLETED_WINDOW_MS
    })
    expect(sim.content('A')).toBe('Final')
  })
})

describe('token-drop reconcile — randomized interleaving fuzz', () => {
  it('byte-exact across 200 random commit/reconcile schedules while active', () => {
    const rand = lcg(0xc0ffee)
    for (let iter = 0; iter < 200; iter++) {
      const sim = createSim()
      sim.seed('A', [userMsg])
      const n = 5 + Math.floor(rand() * 40)
      const deltas = Array.from({ length: n }, (_, i) => `w${iter}_${i} `)
      const snapshots: ChatRecord[][] = [sim.snapshot()]
      let expected = ''

      for (let i = 0; i < n; i++) {
        sim.applyDelta('A', deltas[i])
        expected += deltas[i]
        if (rand() < 0.3) snapshots.push(sim.snapshot()) // a React commit
        if (rand() < 0.4) {
          // reconcile against a RANDOM (often stale) prior snapshot
          const snap = snapshots[Math.floor(rand() * snapshots.length)]
          sim.reconcile({ chats: snap, activeRunChatIds: new Set(['A']), now: i })
        }
      }
      expect(sim.content('A')).toBe(expected)
    }
  })
})

describe('token-drop reconcile — the [currentChat] ref-write effect', () => {
  // App.tsx has a SECOND ref write besides updateChatById + the reconcile: the
  // effect keyed on [currentChat] does chatByIdRef.set(currentChat). Under #1
  // setCurrentChat is deferred, so currentChat (React state) can lag the ref;
  // the effect is now guarded to skip an actively-streaming chat.
  it('keeps the visible streaming chat byte-exact while currentChat stays fresh', () => {
    const sim = createSim()
    sim.seed('A', [userMsg])
    for (const c of ['a', 'b', 'c']) {
      sim.applyDelta('A', c)
      sim.currentChatEffect(sim.recordSnapshot('A'), { activeRunChatIds: new Set(['A']) })
    }
    sim.applyDelta('A', 'd')
    sim.currentChatEffect(sim.recordSnapshot('A'), { activeRunChatIds: new Set(['A']) })
    expect(sim.content('A')).toBe('abcd')
  })

  it('FIXED: a stale currentChat effect does NOT clobber an actively-streaming chat', () => {
    // The [currentChat] effect now skips a chat in the active set, so a lagging
    // currentChat under the coalescer can't overwrite the byte-exact ref.
    // Without the guard, " world" would be lost (the documented second vector).
    const sim = createSim()
    sim.seed('A', [userMsg])
    sim.applyDelta('A', 'Hello')
    const staleCurrent = sim.recordSnapshot('A') // captured at "Hello"
    sim.applyDelta('A', ' world') // ref → "Hello world"
    sim.currentChatEffect(staleCurrent, { activeRunChatIds: new Set(['A']) })
    expect(sim.content('A')).toBe('Hello world') // preserved, not clobbered
  })

  it('NEGATIVE CONTROL: without the active-set guard, a stale currentChat clobbers', () => {
    // Proves the guard is what saves the content (the test has teeth).
    const sim = createSim()
    sim.seed('A', [userMsg])
    sim.applyDelta('A', 'Hello')
    const staleCurrent = sim.recordSnapshot('A')
    sim.applyDelta('A', ' world')
    sim.currentChatEffect(staleCurrent) // no active set → unguarded seed
    expect(sim.content('A')).toBe('Hello')
  })

  it('still seeds a NON-streaming chat from currentChat (original purpose preserved)', () => {
    const sim = createSim()
    sim.seed('A', [userMsg])
    const fresh = makeChat('B', [{ ...userMsg, content: 'fresh B' }])
    sim.currentChatEffect(fresh, { activeRunChatIds: new Set() }) // B not streaming
    expect(sim.ref.has('B')).toBe(true)
  })
})

describe('token-drop reconcile — selecting a streaming chat (handleSelectChat)', () => {
  it('FIXED: selecting an actively-streaming chat keeps its byte-exact ref content', () => {
    // Clicking a chat in the sidebar writes a record into the ref. Under the
    // coalescer the list record lags; for a streaming chat we must prefer the
    // ref, or in-flight tokens are clobbered (incremental providers never
    // recover them).
    const sim = createSim()
    sim.seed('A', [userMsg])
    sim.applyDelta('A', 'Hello')
    const staleListRecord = sim.recordSnapshot('A')! // sidebar still holds "Hello"
    sim.applyDelta('A', ' world') // ref → "Hello world"
    sim.selectChatEffect(staleListRecord, { activeRunChatIds: new Set(['A']) })
    expect(sim.content('A')).toBe('Hello world')
  })

  it('NEGATIVE CONTROL: selecting without the streaming guard clobbers in-flight tokens', () => {
    const sim = createSim()
    sim.seed('A', [userMsg])
    sim.applyDelta('A', 'Hello')
    const staleListRecord = sim.recordSnapshot('A')!
    sim.applyDelta('A', ' world')
    sim.selectChatEffect(staleListRecord) // no active set → stale list record wins
    expect(sim.content('A')).toBe('Hello')
  })
})

describe('token-drop reconcile — concurrent streaming chats', () => {
  it('keeps two chats byte-exact when both stream and reconciles use stale snapshots', () => {
    const sim = createSim()
    sim.seed('A', [userMsg])
    sim.seed('B', [{ ...userMsg, content: 'qb' }])
    const aParts = ['a1 ', 'a2 ', 'a3 ', 'a4 ']
    const bParts = ['b1 ', 'b2 ', 'b3 ', 'b4 ']
    let expA = ''
    let expB = ''
    const snaps = [sim.snapshot()]
    for (let i = 0; i < aParts.length; i++) {
      sim.applyDelta('A', aParts[i])
      expA += aParts[i]
      sim.applyDelta('B', bParts[i])
      expB += bParts[i]
      snaps.push(sim.snapshot())
      // reconcile against an OLD snapshot with BOTH chats in the preserve set
      const stale = snaps[Math.max(0, i - 1)]
      sim.reconcile({ chats: stale, activeRunChatIds: new Set(['A', 'B']), now: i })
    }
    expect(sim.content('A')).toBe(expA)
    expect(sim.content('B')).toBe(expB)
  })

  it('fuzz: two chats byte-exact across 150 random interleavings', () => {
    const rand = lcg(0x5eed42)
    for (let iter = 0; iter < 150; iter++) {
      const sim = createSim()
      sim.seed('A', [userMsg])
      sim.seed('B', [{ ...userMsg, content: 'qb' }])
      const n = 6 + Math.floor(rand() * 30)
      const exp: Record<string, string> = { A: '', B: '' }
      const snaps = [sim.snapshot()]
      for (let i = 0; i < n; i++) {
        const chat = rand() < 0.5 ? 'A' : 'B'
        const tok = `${chat}${iter}_${i} `
        sim.applyDelta(chat, tok)
        exp[chat] += tok
        if (rand() < 0.3) snaps.push(sim.snapshot())
        if (rand() < 0.4) {
          const snap = snaps[Math.floor(rand() * snaps.length)]
          sim.reconcile({ chats: snap, activeRunChatIds: new Set(['A', 'B']), now: i })
        }
      }
      expect(sim.content('A')).toBe(exp.A)
      expect(sim.content('B')).toBe(exp.B)
    }
  })
})

describe('token-drop reconcile — preserve-only survival (chat absent from chats)', () => {
  it('keeps a streaming chat the preserve loop re-injects when chats omits it', () => {
    const sim = createSim()
    sim.seed('A', [userMsg])
    sim.applyDelta('A', 'streamed')
    // React `chats` does NOT contain A yet (brand-new chat mid-first-stream,
    // or filtered out of the visible list) — only the preserve loop saves it.
    sim.reconcile({ chats: [], activeRunChatIds: new Set(['A']), now: 1 })
    expect(sim.content('A')).toBe('streamed')
    sim.applyDelta('A', ' more')
    expect(sim.content('A')).toBe('streamed more')
  })

  it('NEGATIVE CONTROL: absent from chats AND not preserved → dropped entirely', () => {
    const sim = createSim()
    sim.seed('A', [userMsg])
    sim.applyDelta('A', 'streamed')
    sim.reconcile({ chats: [], now: 1 }) // no preserve
    expect(sim.ref.has('A')).toBe(false)
  })
})

describe('token-drop reconcile — restatement frame crossed with a stale reconcile', () => {
  it('a growing-superset (Cursor) restatement after a stale reconcile stays correct', () => {
    const sim = createSim()
    sim.seed('A', [userMsg])
    sim.applyDelta('A', 'Hello ')
    sim.applyDelta('A', 'wor')
    const stale = sim.snapshot() // "Hello wor"
    sim.applyDelta('A', 'Hello world') // replace → "Hello world"
    expect(sim.content('A')).toBe('Hello world')
    sim.reconcile({ chats: stale, activeRunChatIds: new Set(['A']), now: 1 }) // active → preserved
    expect(sim.content('A')).toBe('Hello world')
    sim.applyDelta('A', '!')
    expect(sim.content('A')).toBe('Hello world!')
  })
})
