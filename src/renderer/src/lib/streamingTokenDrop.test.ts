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
    /** Models the SEPARATE [currentChat] effect at App.tsx:7341-7346, which
     *  writes the (React-state-derived, possibly stale) currentChat straight
     *  into the ref OUTSIDE the reconcile/preserve loop — a second clobber
     *  vector the coalescer must keep fresh or make preserve-aware. */
    currentChatEffect(currentChat: ChatRecord | null | undefined) {
      if (currentChat?.appChatId) {
        liveRef.set(currentChat.appChatId, currentChat)
      }
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
  // App.tsx has a SECOND ref write besides updateChatById + the reconcile:
  // the effect keyed on [currentChat] (App.tsx:7341-7346) does
  // chatByIdRef.set(currentChat.appChatId, currentChat). Today currentChat is
  // advanced synchronously by updateChatById so it is always fresh; the
  // coalescer will defer that setCurrentChat, so we model both states here.
  it('is a no-op for the visible streaming chat while currentChat stays fresh (today)', () => {
    const sim = createSim()
    sim.seed('A', [userMsg])
    for (const c of ['a', 'b', 'c']) {
      sim.applyDelta('A', c)
      sim.currentChatEffect(sim.recordSnapshot('A')) // synchronous → fresh
    }
    sim.applyDelta('A', 'd')
    sim.currentChatEffect(sim.recordSnapshot('A'))
    expect(sim.content('A')).toBe('abcd')
  })

  it('HAZARD (coalescer constraint): a STALE currentChat effect clobbers the visible chat', () => {
    // Documents why the coalescer must keep currentChat's ref write fresh (or
    // make the [currentChat] effect preserve-aware): if setCurrentChat is
    // deferred, this effect writes a lagging currentChat over fresher ref
    // content, INDEPENDENT of the reconcile preserve loop. When #1 lands, the
    // fix should flip this assertion to the byte-exact 'Hello world'.
    const sim = createSim()
    sim.seed('A', [userMsg])
    sim.applyDelta('A', 'Hello')
    const staleCurrent = sim.recordSnapshot('A') // captured at "Hello"
    sim.applyDelta('A', ' world') // ref → "Hello world"
    sim.currentChatEffect(staleCurrent) // stale write, even though A is active
    expect(sim.content('A')).toBe('Hello') // " world" lost via the currentChat path
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
