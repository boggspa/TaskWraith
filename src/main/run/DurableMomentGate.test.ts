/**
 * The bounded wait at the places that report a moment as done, over the real
 * tickets, a clock and timers moved by hand.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ChatDurabilityTickets } from '../store/ChatDurabilityTickets'
import {
  DURABLE_MOMENT_GATE_BOUND_MS,
  DurableMomentGate,
  afterUserMoment,
  awaitRunFinal,
  awaitUserMoment,
  durableMomentGateSnapshot,
  installDurableMomentGate,
  settleUserMoment
} from './DurableMomentGate'

afterEach(() => {
  installDurableMomentGate(null)
  vi.restoreAllMocks()
})

/** A barrier the test settles by hand, as the off-loop sync would. */
function barrier() {
  let resolve!: () => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<void>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

function turn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

function watch(promise: Promise<unknown>) {
  const seen: { state: 'pending' | 'resolved' | 'rejected'; reason?: unknown } = {
    state: 'pending'
  }
  promise.then(
    () => (seen.state = 'resolved'),
    (reason) => {
      seen.state = 'rejected'
      seen.reason = reason
    }
  )
  return seen
}

/** A gate over real tickets, with its clock and its timers in the test's hands. */
function gated() {
  const clock = { now: 0 }
  const timers: Array<{ callback: () => void; ms: number; cleared: boolean; unref: () => void }> =
    []
  const tickets = new ChatDurabilityTickets({ now: () => clock.now })
  const log = vi.fn()
  const gate = new DurableMomentGate({
    source: tickets,
    now: () => clock.now,
    setTimer: (callback, ms) => {
      const timer = { callback, ms, cleared: false, unref: vi.fn() }
      timers.push(timer)
      return timer
    },
    clearTimer: (handle) => {
      ;(handle as { cleared: boolean }).cleared = true
    },
    log
  })
  /** Passes the bound: fires every timer still armed. */
  const expire = () => {
    for (const timer of timers) if (!timer.cleared) timer.callback()
  }
  return { clock, timers, tickets, gate, log, expire }
}

describe('the durable moment gate', () => {
  it('waits for nothing, at once and synchronously, for a chat with no ticket to wait for', () => {
    const { tickets, gate, timers } = gated()
    tickets.note('chat-2', 3, 'user_message', barrier().promise)

    expect(gate.userMoment('chat-1')).toBeNull()
    expect(gate.runFinal('chat-1')).toBeNull()
    expect(gate.userMoment('')).toBeNull()
    expect(gate.userMoment(undefined)).toBeNull()
    expect(timers).toHaveLength(0)
    expect(gate.snapshot().waits).toBe(0)
  })

  it("waits at a place the user sits in for the user's moments, and never for a run's end", async () => {
    const { tickets, gate } = gated()
    const runEnd = barrier()
    const message = barrier()
    tickets.note('chat-1', 4, 'run_final', runEnd.promise)
    // A run's end alone is nothing the user waits for.
    expect(gate.userMoment('chat-1')).toBeNull()

    tickets.note('chat-1', 5, 'user_message', message.promise)
    const waiting = watch(gate.userMoment('chat-1')!)
    await turn()
    expect(waiting.state).toBe('pending')

    message.resolve()
    await turn()
    expect(waiting.state).toBe('resolved')
    expect(tickets.snapshot().moments.run_final.pending).toBe(1)
  })

  it("waits for every ticket of the chat before the work that follows a run's end", async () => {
    const { tickets, gate } = gated()
    const runEnd = barrier()
    tickets.note('chat-1', 4, 'run_final', runEnd.promise)

    const waiting = watch(gate.runFinal('chat-1')!)
    await turn()
    expect(waiting.state).toBe('pending')
    runEnd.resolve()
    await turn()
    expect(waiting.state).toBe('resolved')
    expect(tickets.snapshot().moments.run_final.covered).toBe(1)
  })

  it('lets the action go at the bound when the barrier hangs, and counts the wait as overdue', async () => {
    const { clock, tickets, gate, timers, expire } = gated()
    const hung = barrier()
    tickets.note('chat-1', 5, 'user_message', hung.promise)

    const waiting = watch(gate.userMoment('chat-1')!)
    expect(timers.map((timer) => timer.ms)).toEqual([DURABLE_MOMENT_GATE_BOUND_MS])
    expect(timers[0].unref).toHaveBeenCalled()
    await turn()
    expect(waiting.state).toBe('pending')

    clock.now += DURABLE_MOMENT_GATE_BOUND_MS
    expire()
    await turn()
    expect(waiting.state).toBe('resolved')
    expect(gate.snapshot()).toEqual({
      waits: 1,
      overdue: 1,
      rejected: 0,
      waitMsTotal: DURABLE_MOMENT_GATE_BOUND_MS,
      longestWaitMs: DURABLE_MOMENT_GATE_BOUND_MS
    })
    // The barrier keeps running and settles its ticket later; the wait is not counted again.
    expect(tickets.snapshot().moments.user_message.pending).toBe(1)
    hung.resolve()
    await turn()
    expect(tickets.snapshot().moments.user_message.pending).toBe(0)
    expect(gate.snapshot()).toMatchObject({ waits: 1, overdue: 1 })
  })

  it("rejects with the disk's refusal when it comes before the bound, and stops the timer", async () => {
    const { clock, tickets, gate, timers } = gated()
    const refused = barrier()
    const failure = new Error('EIO: the disk refused')
    tickets.note('chat-1', 5, 'decision', refused.promise)

    const waiting = gate.userMoment('chat-1')!
    clock.now += 7
    refused.reject(failure)

    await expect(waiting).rejects.toBe(failure)
    expect(timers[0].cleared).toBe(true)
    expect(gate.snapshot()).toEqual({
      waits: 1,
      overdue: 0,
      rejected: 1,
      waitMsTotal: 7,
      longestWaitMs: 7
    })
  })

  it('counts a refusal that comes after the bound, and logs the first one alone', async () => {
    const { tickets, gate, log, expire } = gated()
    const first = barrier()
    const second = barrier()
    tickets.note('chat-1', 5, 'user_message', first.promise)
    const one = gate.userMoment('chat-1')!
    tickets.note('chat-2', 6, 'user_message', second.promise)
    const two = gate.userMoment('chat-2')!
    expire()
    await Promise.all([one, two])

    first.reject(new Error('EIO'))
    second.reject(new Error('EIO again'))
    await turn()

    expect(gate.snapshot()).toMatchObject({ waits: 2, overdue: 2, rejected: 2 })
    expect(log).toHaveBeenCalledTimes(1)
  })

  it('times each wait from its start to its end, and keeps the longest', async () => {
    const { clock, tickets, gate } = gated()
    for (const [chatId, ms] of [
      ['chat-1', 12],
      ['chat-2', 30]
    ] as const) {
      const sync = barrier()
      tickets.note(chatId, 1, 'destructive', sync.promise)
      const waiting = gate.userMoment(chatId)!
      clock.now += ms
      sync.resolve()
      await waiting
    }

    expect(gate.snapshot()).toMatchObject({ waits: 2, waitMsTotal: 42, longestWaitMs: 30 })
  })

  it('bounds a wait the caller holds already, as the dispatch barrier does', async () => {
    const { gate, expire } = gated()
    const held = barrier()

    const waiting = watch(gate.bound(held.promise))
    await turn()
    expect(waiting.state).toBe('pending')
    expire()
    await turn()
    expect(waiting.state).toBe('resolved')
    expect(gate.snapshot()).toMatchObject({ waits: 1, overdue: 1 })
  })

  it('refuses a bound that is not a positive time', () => {
    const tickets = new ChatDurabilityTickets({ now: () => 0 })
    for (const boundMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new DurableMomentGate({ source: tickets, boundMs })).toThrow(
        'Invalid durable moment bound'
      )
    }
  })
})

describe('the installed gate', () => {
  it('waits for nothing and counts nothing with no gate installed, as with the switch off', () => {
    const reply = { accepted: true }

    expect(awaitUserMoment('chat-1')).toBeNull()
    expect(awaitRunFinal('chat-1')).toBeNull()
    expect(settleUserMoment('chat-1', 'an answer')).toBeNull()
    expect(afterUserMoment('chat-1', reply)).toBe(reply)
    expect(durableMomentGateSnapshot()).toBeNull()
  })

  it('hands a reply back synchronously when there is nothing to wait for, and after the wait otherwise', async () => {
    const { tickets, gate } = gated()
    installDurableMomentGate(gate)
    const reply = { accepted: true }
    expect(afterUserMoment('chat-1', reply)).toBe(reply)

    const sync = barrier()
    tickets.note('chat-1', 5, 'user_message', sync.promise)
    const later = afterUserMoment('chat-1', reply)
    expect(later).toBeInstanceOf(Promise)
    const seen = watch(later as Promise<typeof reply>)
    await turn()
    expect(seen.state).toBe('pending')
    sync.resolve()
    await expect(later).resolves.toBe(reply)
    expect(durableMomentGateSnapshot()).toMatchObject({ waits: 1 })
  })

  it("passes a run's end to the installed gate", async () => {
    const { tickets, gate } = gated()
    installDurableMomentGate(gate)
    const runEnd = barrier()
    tickets.note('chat-1', 4, 'run_final', runEnd.promise)

    expect(awaitUserMoment('chat-1')).toBeNull()
    const waiting = watch(awaitRunFinal('chat-1')!)
    runEnd.resolve()
    await turn()
    expect(waiting.state).toBe('resolved')
  })

  it('logs a refusal once and goes ahead, for a site that logs its persistence failures', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { tickets, gate } = gated()
    installDurableMomentGate(gate)
    for (const chatId of ['chat-1', 'chat-2']) {
      const refused = barrier()
      tickets.note(chatId, 5, 'decision', refused.promise)
      const waiting = settleUserMoment(chatId, 'an answer to an agent')!
      refused.reject(new Error('EIO'))
      await expect(waiting).resolves.toBeUndefined()
    }

    expect(error).toHaveBeenCalledTimes(1)
    expect(String(error.mock.calls[0][0])).toContain('an answer to an agent')
    expect(gate.snapshot().rejected).toBe(2)
  })
})
