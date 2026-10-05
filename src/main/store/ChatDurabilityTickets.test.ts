import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CHAT_DURABILITY_MOMENTS,
  CHAT_TICKET_COVERAGE_GRACE_MS,
  ChatDurabilityTickets,
  USER_DURABILITY_MOMENTS,
  type ChatDurabilityMoment
} from './ChatDurabilityTickets'

/** A barrier the test settles by hand, as the off-loop sync would. */
function barrier(): { promise: Promise<void>; resolve(): void; reject(reason: unknown): void } {
  let resolve!: () => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<void>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

/** Lets every promise reaction that is ready run. */
function turn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

function watch(promise: Promise<void>): {
  state: 'pending' | 'resolved' | 'rejected'
  reason?: unknown
} {
  const seen: { state: 'pending' | 'resolved' | 'rejected'; reason?: unknown } = {
    state: 'pending'
  }
  promise.then(
    () => {
      seen.state = 'resolved'
    },
    (reason) => {
      seen.state = 'rejected'
      seen.reason = reason
    }
  )
  return seen
}

function tickets(): { tickets: ChatDurabilityTickets; clock: { now: number } } {
  const clock = { now: 1_000 }
  return { tickets: new ChatDurabilityTickets({ now: () => clock.now }), clock }
}

const GATE_MOMENTS = CHAT_DURABILITY_MOMENTS.filter((moment) => moment !== 'run_final')

describe('chat durability tickets', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('names the four moments that wait for a sync', () => {
    expect(CHAT_DURABILITY_MOMENTS).toEqual([
      'user_message',
      'decision',
      'run_final',
      'destructive'
    ])
  })

  it.each(CHAT_DURABILITY_MOMENTS)(
    'makes awaitChat wait for a %s ticket until its barrier resolves',
    async (moment: ChatDurabilityMoment) => {
      const { tickets: store } = tickets()
      const sync = barrier()
      store.note('chat-1', 7, moment, sync.promise)
      const waiting = watch(store.awaitChat('chat-1'))
      await turn()
      expect(waiting.state).toBe('pending')
      expect(store.snapshot().moments[moment]).toMatchObject({ noted: 1, pending: 1, covered: 1 })
      sync.resolve()
      await turn()
      expect(waiting.state).toBe('resolved')
      expect(store.snapshot().moments[moment]).toMatchObject({ noted: 1, pending: 0, covered: 1 })
    }
  )

  it('resolves at once for a chat whose saves noted nothing, such as streamed text', async () => {
    const { tickets: store } = tickets()
    // Another chat is waiting for a sync; this one only streamed.
    store.note('chat-2', 3, 'user_message', barrier().promise)
    const waiting = watch(store.awaitChat('chat-1'))
    await turn()
    expect(waiting.state).toBe('resolved')
    expect(store.snapshot().chats).toBe(1)
  })

  it('waits for every ticket noted so far for the chat, in whatever order they settle', async () => {
    const { tickets: store } = tickets()
    const first = barrier()
    const second = barrier()
    const third = barrier()
    store.note('chat-1', 1, 'user_message', first.promise)
    store.note('chat-1', 2, 'decision', second.promise)
    store.note('chat-1', 3, 'run_final', third.promise)
    const waiting = watch(store.awaitChat('chat-1'))
    third.resolve()
    first.resolve()
    await turn()
    expect(waiting.state).toBe('pending')
    second.resolve()
    await turn()
    expect(waiting.state).toBe('resolved')
  })

  it('does not wait for a ticket noted after awaitChat was called', async () => {
    const { tickets: store } = tickets()
    const before = barrier()
    const after = barrier()
    store.note('chat-1', 1, 'user_message', before.promise)
    const waiting = watch(store.awaitChat('chat-1'))
    store.note('chat-1', 2, 'decision', after.promise)
    before.resolve()
    await turn()
    expect(waiting.state).toBe('resolved')
    // The later ticket has its own awaiter, which does wait for it.
    const later = watch(store.awaitChat('chat-1'))
    await turn()
    expect(later.state).toBe('pending')
    after.resolve()
    await turn()
    expect(later.state).toBe('resolved')
  })

  it('keeps chats apart: one chat never waits for the sync of another', async () => {
    const { tickets: store } = tickets()
    const slow = barrier()
    const quick = barrier()
    store.note('chat-1', 1, 'user_message', slow.promise)
    store.note('chat-2', 1, 'user_message', quick.promise)
    const one = watch(store.awaitChat('chat-1'))
    const two = watch(store.awaitChat('chat-2'))
    quick.resolve()
    await turn()
    expect(two.state).toBe('resolved')
    expect(one.state).toBe('pending')
    slow.resolve()
    await turn()
    expect(one.state).toBe('resolved')
  })

  it('hands a failed barrier to the awaiter as that failure', async () => {
    const { tickets: store } = tickets()
    const sync = barrier()
    const failure = new Error('fsync failed: EIO')
    store.note('chat-1', 4, 'decision', sync.promise)
    const waiting = store.awaitChat('chat-1')
    sync.reject(failure)
    await expect(waiting).rejects.toBe(failure)
    expect(store.snapshot().moments.decision).toMatchObject({ failed: 1, covered: 1, pending: 0 })
    expect(store.snapshot()).toMatchObject({ awaits: 1, awaitsRejected: 1 })
  })

  it('rejects every awaiter that was waiting for the failed ticket, without waiting for the rest', async () => {
    const { tickets: store } = tickets()
    const failing = barrier()
    const slow = barrier()
    const failure = new Error('fsync failed')
    store.note('chat-1', 1, 'user_message', failing.promise)
    store.note('chat-1', 2, 'decision', slow.promise)
    const first = watch(store.awaitChat('chat-1'))
    const second = watch(store.awaitChat('chat-1'))
    failing.reject(failure)
    await turn()
    expect(first).toEqual({ state: 'rejected', reason: failure })
    expect(second).toEqual({ state: 'rejected', reason: failure })
    slow.resolve()
    await turn()
    expect(store.snapshot().chats).toBe(0)
  })

  it('still fails an awaiter that arrives after the barrier has already failed', async () => {
    const { tickets: store } = tickets()
    const sync = barrier()
    const failure = new Error('fsync failed')
    store.note('chat-1', 4, 'user_message', sync.promise)
    sync.reject(failure)
    await turn()
    // The save's own caller reaches its gate a moment later: it must not be told "done".
    await expect(store.awaitChat('chat-1')).rejects.toBe(failure)
    expect(store.snapshot().moments.user_message).toMatchObject({ failed: 1, covered: 1 })
  })

  it('tells a late awaiter of the first failure when several went unheard', async () => {
    const { tickets: store } = tickets()
    const first = new Error('first sync failed')
    store.note('chat-1', 1, 'user_message', Promise.reject(first))
    await turn()
    store.note('chat-1', 2, 'decision', Promise.reject(new Error('second sync failed')))
    await turn()
    await expect(store.awaitChat('chat-1')).rejects.toBe(first)
    // Both were covered by that awaiter; neither is handed out again.
    await expect(store.awaitChat('chat-1')).resolves.toBeUndefined()
    expect(store.snapshot().chats).toBe(0)
  })

  it('never turns a failure nobody awaits into an unhandled rejection', async () => {
    const { tickets: store, clock } = tickets()
    const unhandled: unknown[] = []
    const listener = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', listener)
    try {
      store.note('chat-1', 4, 'run_final', Promise.reject(new Error('fsync failed')))
      const late = barrier()
      store.note('chat-2', 9, 'destructive', late.promise)
      late.reject(new Error('fsync failed later'))
      await turn()
      await turn()
      clock.now += CHAT_TICKET_COVERAGE_GRACE_MS
      store.collect()
      await turn()
    } finally {
      process.off('unhandledRejection', listener)
    }
    expect(unhandled).toEqual([])
    expect(store.snapshot().moments.run_final).toMatchObject({ failed: 1, uncovered: 1 })
    expect(store.snapshot().moments.destructive).toMatchObject({ failed: 1, uncovered: 1 })
    expect(store.snapshot().chats).toBe(0)
  })

  it('does not let one failure poison the tickets noted after it', async () => {
    const { tickets: store } = tickets()
    const failure = new Error('fsync failed')
    store.note('chat-1', 1, 'user_message', Promise.reject(failure))
    await turn()
    // A later ticket succeeds. The first awaiter still hears of the failure it covers...
    const next = barrier()
    store.note('chat-1', 2, 'decision', next.promise)
    await expect(store.awaitChat('chat-1')).rejects.toBe(failure)
    // ...and after that the chat is clean again.
    const waiting = watch(store.awaitChat('chat-1'))
    await turn()
    expect(waiting.state).toBe('pending')
    next.resolve()
    await turn()
    expect(waiting.state).toBe('resolved')
    store.note('chat-1', 3, 'decision', Promise.resolve())
    await expect(store.awaitChat('chat-1')).resolves.toBeUndefined()
    expect(store.snapshot()).toMatchObject({ awaits: 3, awaitsRejected: 1 })
  })

  it('does not hand a failure to an awaiter whose own tickets all succeeded', async () => {
    const { tickets: store } = tickets()
    const mine = barrier()
    store.note('chat-1', 1, 'user_message', mine.promise)
    const waiting = watch(store.awaitChat('chat-1'))
    // Noted after the awaiter asked: not its ticket.
    store.note('chat-1', 2, 'decision', Promise.reject(new Error('fsync failed')))
    await turn()
    expect(waiting.state).toBe('pending')
    mine.resolve()
    await turn()
    expect(waiting.state).toBe('resolved')
  })

  it('counts a ticket as covered when it is awaited while pending', async () => {
    const { tickets: store } = tickets()
    const sync = barrier()
    store.note('chat-1', 1, 'user_message', sync.promise)
    void store.awaitChat('chat-1')
    sync.resolve()
    await turn()
    expect(store.snapshot().moments.user_message).toMatchObject({
      noted: 1,
      covered: 1,
      uncovered: 0,
      undecided: 0
    })
    expect(store.snapshot().missingGates).toBe(0)
  })

  it('counts a ticket as covered when it is awaited after its barrier already resolved', async () => {
    const { tickets: store, clock } = tickets()
    store.note('chat-1', 1, 'decision', Promise.resolve())
    await turn()
    expect(store.snapshot().moments.decision).toMatchObject({
      pending: 0,
      covered: 0,
      undecided: 1
    })
    clock.now += CHAT_TICKET_COVERAGE_GRACE_MS - 1
    await store.awaitChat('chat-1')
    expect(store.snapshot().moments.decision).toMatchObject({
      covered: 1,
      uncovered: 0,
      undecided: 0
    })
    expect(store.snapshot().chats).toBe(0)
  })

  it.each(GATE_MOMENTS)(
    'counts a %s ticket nobody awaited within the grace period as a missing gate',
    async (moment: ChatDurabilityMoment) => {
      const { tickets: store, clock } = tickets()
      store.note('chat-9', 41, moment, Promise.resolve())
      await turn()
      clock.now += CHAT_TICKET_COVERAGE_GRACE_MS - 1
      expect(store.snapshot().missingGates).toBe(0)
      clock.now += 1
      const snapshot = store.snapshot()
      expect(snapshot.moments[moment]).toMatchObject({ noted: 1, covered: 0, uncovered: 1 })
      expect(snapshot.missingGates).toBe(1)
      expect(snapshot.uncoveredRunFinals).toBe(0)
      expect(snapshot.lastMissingGate).toEqual({ chatId: 'chat-9', revision: 41, moment })
      // Too late to cover it now: it has been judged, and the count stands.
      await store.awaitChat('chat-9')
      expect(store.snapshot().moments[moment]).toMatchObject({ covered: 0, uncovered: 1 })
      // Of several unawaited tickets for one moment, the newest revision is the one named.
      store.note('chat-9', 50, moment, Promise.resolve())
      store.note('chat-9', 58, moment, Promise.resolve())
      store.note('chat-9', 55, moment, Promise.resolve())
      await turn()
      clock.now += CHAT_TICKET_COVERAGE_GRACE_MS
      expect(store.snapshot().lastMissingGate).toEqual({ chatId: 'chat-9', revision: 58, moment })
      expect(store.snapshot().missingGates).toBe(4)
    }
  )

  it("names the user's moments: everything but a run's final record", () => {
    expect(USER_DURABILITY_MOMENTS).toEqual(GATE_MOMENTS)
  })

  it('waits only for the moments it is given, and leaves the others to their own gates', async () => {
    const { tickets: store, clock } = tickets()
    const runEnd = barrier()
    const message = barrier()
    store.note('chat-1', 4, 'run_final', runEnd.promise)
    store.note('chat-1', 5, 'user_message', message.promise)

    const waiting = watch(store.awaitChat('chat-1', USER_DURABILITY_MOMENTS))
    message.resolve()
    await turn()
    expect(waiting.state).toBe('resolved')

    runEnd.resolve()
    await turn()
    clock.now += CHAT_TICKET_COVERAGE_GRACE_MS
    const snapshot = store.snapshot()
    expect(snapshot.moments.user_message).toMatchObject({ covered: 1, uncovered: 0 })
    // Not waited for, so not covered: it stays what it is, a run end nobody followed.
    expect(snapshot.moments.run_final).toMatchObject({ covered: 0, uncovered: 1 })
    expect(snapshot.missingGates).toBe(0)
  })

  it('keeps waiting when a ticket of a moment it does not wait for settles or fails first', async () => {
    const { tickets: store } = tickets()
    const finished = barrier()
    const failed = barrier()
    const message = barrier()
    store.note('chat-1', 3, 'run_final', finished.promise)
    store.note('chat-1', 4, 'run_final', failed.promise)
    store.note('chat-1', 5, 'user_message', message.promise)

    const waiting = watch(store.awaitChat('chat-1', USER_DURABILITY_MOMENTS))
    finished.resolve()
    failed.reject(new Error('run end sync failed'))
    await turn()
    expect(waiting.state).toBe('pending')

    message.resolve()
    await turn()
    expect(waiting.state).toBe('resolved')
  })

  it('tells an awaiter only of the failures of the moments it waits for', async () => {
    const { tickets: store } = tickets()
    const failure = new Error('run end sync failed')
    store.note('chat-1', 4, 'run_final', Promise.reject(failure))
    store.note('chat-1', 5, 'user_message', Promise.resolve())
    await turn()

    await expect(store.awaitChat('chat-1', USER_DURABILITY_MOMENTS)).resolves.toBeUndefined()
    // Still held for whoever waits for a run's end.
    await expect(store.awaitChat('chat-1')).rejects.toBe(failure)
  })

  it('tells an awaiter of the first failure in time, whichever moment it was for', async () => {
    const { tickets: store } = tickets()
    const first = new Error('decision sync failed')
    store.note('chat-1', 1, 'decision', Promise.reject(first))
    await turn()
    store.note('chat-1', 2, 'user_message', Promise.reject(new Error('message sync failed')))
    await turn()

    await expect(store.awaitChat('chat-1')).rejects.toBe(first)
  })

  it('says whether a chat holds anything of the given moments to wait for, cover or report', async () => {
    const { tickets: store } = tickets()
    expect(store.holds('chat-1')).toBe(false)
    const runEnd = barrier()
    store.note('chat-1', 4, 'run_final', runEnd.promise)
    expect(store.holds('chat-1')).toBe(true)
    expect(store.holds('chat-1', USER_DURABILITY_MOMENTS)).toBe(false)

    store.note('chat-1', 5, 'user_message', Promise.resolve())
    await turn()
    // Settled but not yet awaited: there is still a ticket to cover.
    expect(store.holds('chat-1', USER_DURABILITY_MOMENTS)).toBe(true)
    await store.awaitChat('chat-1', USER_DURABILITY_MOMENTS)
    expect(store.holds('chat-1', USER_DURABILITY_MOMENTS)).toBe(false)
    expect(store.chatIds()).toEqual(['chat-1'])

    runEnd.resolve()
    await store.awaitChat('chat-1')
    expect(store.holds('chat-1')).toBe(false)
    expect(store.chatIds()).toEqual([])
  })

  it('refuses to wait for a moment it does not know', () => {
    const { tickets: store } = tickets()
    expect(() => store.awaitChat('chat-1', ['typed' as ChatDurabilityMoment])).toThrow(
      'Invalid durability moment'
    )
  })

  it('counts an unawaited final run record apart from the missing gates', async () => {
    const { tickets: store, clock } = tickets()
    store.note('chat-1', 12, 'run_final', Promise.resolve())
    await turn()
    clock.now += CHAT_TICKET_COVERAGE_GRACE_MS
    const snapshot = store.snapshot()
    expect(snapshot.moments.run_final).toMatchObject({ noted: 1, uncovered: 1 })
    expect(snapshot.uncoveredRunFinals).toBe(1)
    expect(snapshot.missingGates).toBe(0)
    expect(snapshot.lastMissingGate).toBeNull()
  })

  it('measures the grace period from the latest ticket of the chat, and judges the chat as a whole', async () => {
    const { tickets: store, clock } = tickets()
    store.note('chat-1', 1, 'user_message', Promise.resolve())
    expect(store.nextDeadline()).toBe(1_000 + CHAT_TICKET_COVERAGE_GRACE_MS)
    clock.now += 20_000
    store.note('chat-1', 2, 'destructive', Promise.resolve())
    expect(store.nextDeadline()).toBe(21_000 + CHAT_TICKET_COVERAGE_GRACE_MS)
    await turn()
    clock.now += CHAT_TICKET_COVERAGE_GRACE_MS - 1
    expect(store.snapshot().missingGates).toBe(0)
    clock.now += 1
    expect(store.snapshot()).toMatchObject({
      missingGates: 2,
      lastMissingGate: { chatId: 'chat-1', revision: 2, moment: 'destructive' },
      chats: 0
    })
    expect(store.nextDeadline()).toBeNull()
    expect(CHAT_TICKET_COVERAGE_GRACE_MS).toBe(30_000)
  })

  it('keeps a ticket whose sync is still running past the grace period, and judges it once it settles', async () => {
    const { tickets: store, clock } = tickets()
    const slow = barrier()
    store.note('chat-1', 1, 'user_message', slow.promise)
    clock.now += CHAT_TICKET_COVERAGE_GRACE_MS + 5
    expect(store.snapshot()).toMatchObject({ missingGates: 0, chats: 1 })
    expect(store.snapshot().moments.user_message).toMatchObject({ pending: 1, uncovered: 0 })
    slow.resolve()
    await turn()
    clock.now += CHAT_TICKET_COVERAGE_GRACE_MS
    expect(store.snapshot()).toMatchObject({ missingGates: 1, chats: 0 })
    expect(store.snapshot().moments.user_message.longestWaitMs).toBe(
      CHAT_TICKET_COVERAGE_GRACE_MS + 5
    )
  })

  it('judges each chat by its own latest ticket when chats take turns', async () => {
    const { tickets: store, clock } = tickets()
    store.note('chat-1', 1, 'user_message', Promise.resolve())
    clock.now += 10_000
    store.note('chat-2', 1, 'decision', Promise.resolve())
    clock.now += 10_000
    store.note('chat-1', 2, 'user_message', Promise.resolve())
    await turn()
    // The second chat falls due first, although the first chat was noted before it.
    expect(store.nextDeadline()).toBe(11_000 + CHAT_TICKET_COVERAGE_GRACE_MS)
    clock.now = 11_000 + CHAT_TICKET_COVERAGE_GRACE_MS
    expect(store.snapshot()).toMatchObject({
      missingGates: 1,
      lastMissingGate: { chatId: 'chat-2', revision: 1, moment: 'decision' },
      chats: 1
    })
    clock.now = 21_000 + CHAT_TICKET_COVERAGE_GRACE_MS
    expect(store.snapshot()).toMatchObject({ missingGates: 3, chats: 0 })
  })

  it('forgets a failure nobody came for once its ticket has been judged', async () => {
    const { tickets: store, clock } = tickets()
    const slow = barrier()
    store.note('chat-1', 1, 'decision', Promise.reject(new Error('disk full')))
    store.note('chat-1', 2, 'run_final', slow.promise)
    await turn()
    clock.now += CHAT_TICKET_COVERAGE_GRACE_MS
    expect(store.snapshot()).toMatchObject({ missingGates: 1, chats: 1 })
    // The gate that arrives now is for later work: it waits for the sync still running, no more.
    const waiting = watch(store.awaitChat('chat-1'))
    await turn()
    expect(waiting.state).toBe('pending')
    slow.resolve()
    await turn()
    expect(waiting.state).toBe('resolved')
    expect(store.snapshot()).toMatchObject({ awaitsRejected: 0, chats: 0 })
  })

  it('leaves nothing to judge for a chat whose tickets were all awaited', async () => {
    const { tickets: store, clock } = tickets()
    store.note('chat-1', 1, 'user_message', Promise.resolve())
    await store.awaitChat('chat-1')
    expect(store.nextDeadline()).toBeNull()
    clock.now += CHAT_TICKET_COVERAGE_GRACE_MS
    expect(store.snapshot()).toMatchObject({ missingGates: 0, chats: 0 })
  })

  it('takes its grace period from the caller, and refuses one that is not a positive time', async () => {
    const clock = { now: 0 }
    const store = new ChatDurabilityTickets({ now: () => clock.now, graceMs: 250 })
    store.note('chat-1', 1, 'destructive', Promise.resolve())
    await turn()
    expect(store.nextDeadline()).toBe(250)
    clock.now = 249
    expect(store.snapshot().missingGates).toBe(0)
    clock.now = 250
    expect(store.snapshot().missingGates).toBe(1)
    for (const graceMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new ChatDurabilityTickets({ now: () => 0, graceMs })).toThrow(
        'Invalid coverage grace period'
      )
    }
  })

  it('judges overdue chats while it takes notes, without a timer of its own', async () => {
    vi.useFakeTimers()
    const { tickets: store, clock } = tickets()
    store.note('chat-1', 1, 'user_message', Promise.resolve())
    await Promise.resolve()
    await Promise.resolve()
    clock.now += CHAT_TICKET_COVERAGE_GRACE_MS
    expect(store.nextDeadline()).toBe(1_000 + CHAT_TICKET_COVERAGE_GRACE_MS)
    // Any later note, for any chat, sweeps what has fallen due.
    store.note('chat-2', 1, 'run_final', barrier().promise)
    expect(store.nextDeadline()).toBe(clock.now + CHAT_TICKET_COVERAGE_GRACE_MS)
    void store.awaitChat('chat-2')
    expect(vi.getTimerCount()).toBe(0)
    vi.useRealTimers()
    const snapshot = store.snapshot()
    expect(snapshot.missingGates).toBe(1)
    expect(snapshot.chats).toBe(1)
  })

  it('judges overdue chats when any gate is reached, too', async () => {
    const { tickets: store, clock } = tickets()
    store.note('chat-1', 1, 'destructive', Promise.resolve())
    await turn()
    clock.now += CHAT_TICKET_COVERAGE_GRACE_MS
    await store.awaitChat('chat-2')
    expect(store.nextDeadline()).toBeNull()
    expect(store.snapshot().missingGates).toBe(1)
  })

  it('reports the longest sync wait per moment and the longest wait at a gate', async () => {
    const { tickets: store, clock } = tickets()
    const quick = barrier()
    const slow = barrier()
    store.note('chat-1', 1, 'user_message', quick.promise)
    store.note('chat-2', 1, 'user_message', slow.promise)
    clock.now += 4
    const gate = store.awaitChat('chat-2')
    clock.now += 3
    quick.resolve()
    await turn()
    clock.now += 40
    slow.resolve()
    await gate
    const snapshot = store.snapshot()
    expect(snapshot.moments.user_message.longestWaitMs).toBe(47)
    expect(snapshot.moments.decision.longestWaitMs).toBe(0)
    expect(snapshot.longestAwaitMs).toBe(43)
    expect(snapshot.awaits).toBe(1)
  })

  it('reports every counter for every moment', async () => {
    const { tickets: store } = tickets()
    expect(store.snapshot()).toEqual({
      moments: {
        user_message: {
          noted: 0,
          covered: 0,
          uncovered: 0,
          failed: 0,
          pending: 0,
          undecided: 0,
          longestWaitMs: 0
        },
        decision: {
          noted: 0,
          covered: 0,
          uncovered: 0,
          failed: 0,
          pending: 0,
          undecided: 0,
          longestWaitMs: 0
        },
        run_final: {
          noted: 0,
          covered: 0,
          uncovered: 0,
          failed: 0,
          pending: 0,
          undecided: 0,
          longestWaitMs: 0
        },
        destructive: {
          noted: 0,
          covered: 0,
          uncovered: 0,
          failed: 0,
          pending: 0,
          undecided: 0,
          longestWaitMs: 0
        }
      },
      missingGates: 0,
      uncoveredRunFinals: 0,
      lastMissingGate: null,
      awaits: 0,
      awaitsRejected: 0,
      awaitsWaiting: 0,
      longestAwaitMs: 0,
      chats: 0
    })
    const pending = barrier()
    store.note('chat-1', 1, 'user_message', pending.promise)
    void store.awaitChat('chat-1')
    expect(store.snapshot()).toMatchObject({ awaits: 1, awaitsWaiting: 1, chats: 1 })
    pending.resolve()
    await turn()
    expect(store.snapshot()).toMatchObject({ awaits: 1, awaitsWaiting: 0, chats: 0 })
  })

  it('holds one small record per open chat, never one per ticket', async () => {
    const { tickets: store, clock } = tickets()
    const CHATS = 500
    const TICKETS = 100_000
    const slow = Array.from({ length: CHATS }, () => barrier())
    let largest = 0
    for (let index = 0; index < TICKETS; index++) {
      const chat = index % CHATS
      const moment = CHAT_DURABILITY_MOMENTS[index % CHAT_DURABILITY_MOMENTS.length]
      // Most syncs are already done when the ticket is noted; one per chat is still running.
      const sync = index < CHATS ? slow[chat].promise : Promise.resolve()
      store.note(`chat-${chat}`, index, moment, sync)
      if (index % 1_000 === 0) largest = Math.max(largest, store.snapshot().chats)
    }
    await turn()
    largest = Math.max(largest, store.snapshot().chats)
    expect(largest).toBe(CHATS)
    const total = (field: 'noted' | 'covered' | 'uncovered' | 'pending' | 'undecided'): number =>
      CHAT_DURABILITY_MOMENTS.reduce(
        (sum, moment) => sum + store.snapshot().moments[moment][field],
        0
      )
    expect(total('noted')).toBe(TICKETS)
    expect(total('pending')).toBe(CHATS)
    expect(total('undecided')).toBe(TICKETS - CHATS)

    // Half the chats reach a gate: everything noted for them is covered and their records go.
    const gates = Array.from({ length: CHATS / 2 }, (_, chat) => store.awaitChat(`chat-${chat}`))
    for (const sync of slow) sync.resolve()
    await Promise.all(gates)
    expect(store.snapshot().chats).toBe(CHATS / 2)
    expect(total('covered')).toBe(TICKETS / 2)

    // The other half never does: after the grace period they are judged and dropped too.
    clock.now += CHAT_TICKET_COVERAGE_GRACE_MS
    expect(store.snapshot().chats).toBe(0)
    expect(total('uncovered')).toBe(TICKETS / 2)
    expect(total('covered') + total('uncovered')).toBe(TICKETS)
    expect(total('pending') + total('undecided')).toBe(0)
    expect(store.nextDeadline()).toBeNull()
  })

  it('rejects a malformed note instead of losing it', () => {
    const { tickets: store } = tickets()
    expect(() => store.note('', 1, 'decision', Promise.resolve())).toThrow('Invalid chat id')
    expect(() => store.note('chat-1', -1, 'decision', Promise.resolve())).toThrow(
      'Invalid revision'
    )
    expect(() =>
      store.note('chat-1', 1, 'streamed' as ChatDurabilityMoment, Promise.resolve())
    ).toThrow('Invalid durability moment')
    expect(store.snapshot().chats).toBe(0)
  })
})
