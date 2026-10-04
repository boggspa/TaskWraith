import { spawn } from 'node:child_process'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  COOPERATIVE_STREAM_TURN_BUDGET_MS,
  createOrderedStreamPump,
  orderedStreamPumpCounters,
  resetOrderedStreamPumpCountersForTest,
  setOrderedStreamPumpPacingForTest,
  type OrderedStreamPumpOptions
} from './CooperativeStreamPump'

const SLOW = COOPERATIVE_STREAM_TURN_BUDGET_MS
const MAX_TURNS = 100_000

/**
 * A clock that only the visit advances, and deferred turns the test runs by
 * hand: the pump's pacing becomes a property of the items, not of the machine.
 */
function harness<T = string>(
  overrides: Partial<OrderedStreamPumpOptions<T>> & { cost?: (item: T) => number } = {}
) {
  let clock = 0
  const turns: Array<() => void> = []
  const seen: T[] = []
  const { cost = () => SLOW, visit, ...options } = overrides
  const pump = createOrderedStreamPump<T>({
    label: 'test',
    now: () => clock,
    schedule: (resume) => turns.push(resume),
    visit: (item) => {
      seen.push(item)
      clock += cost(item)
      visit?.(item)
    },
    ...options
  })
  return {
    pump,
    seen,
    turns,
    runNextTurn: (): void => {
      const turn = turns.shift()
      if (!turn) throw new Error('no deferred turn is waiting')
      turn()
    },
    runAllTurns: (): void => {
      // A pump that never runs dry is a failure to report, not a loop to sit in.
      for (let ran = 0; turns.length > 0; ran += 1) {
        if (ran >= MAX_TURNS) throw new Error(`still deferring after ${MAX_TURNS} turns`)
        turns.shift()!()
      }
    }
  }
}

function recordingSource() {
  const calls: string[] = []
  return {
    calls,
    pause: (): void => {
      calls.push('pause')
    },
    resume: (): void => {
      calls.push('resume')
    }
  }
}

beforeEach(() => {
  resetOrderedStreamPumpCountersForTest()
  // Off by default under test (see the last describe); this file tests pacing.
  setOrderedStreamPumpPacingForTest(true)
})

describe('createOrderedStreamPump', () => {
  it('visits every item synchronously when the turn stays under budget', () => {
    const { pump, seen, turns } = harness<number>({ cost: () => 0 })
    pump.pushAll([1, 2, 3])
    expect(seen).toEqual([1, 2, 3])
    expect(turns).toHaveLength(0)
    expect(pump.pending).toBe(0)
  })

  it('yields the remainder once a turn exceeds the G-lag budget', () => {
    const { pump, seen, turns, runNextTurn } = harness()
    pump.pushAll(['a', 'b', 'c'])

    expect(seen).toEqual(['a'])
    expect(turns).toHaveLength(1)
    runNextTurn()
    expect(seen).toEqual(['a', 'b'])
    expect(turns).toHaveLength(1)
    runNextTurn()
    expect(seen).toEqual(['a', 'b', 'c'])
    // One boundary is still owed, to clear the last turn's spend. It finds
    // nothing waiting and schedules nothing further.
    expect(turns).toHaveLength(1)
    runNextTurn()
    expect(seen).toEqual(['a', 'b', 'c'])
    expect(turns).toHaveLength(0)
  })

  describe('the budget belongs to the loop turn, not to a call', () => {
    it('paces a burst that arrives one item per push, the way readline delivers it', () => {
      const { pump, seen, runAllTurns } = harness()
      pump.push('a1')
      pump.push('a2')
      pump.push('a3')
      // a1 spent the turn; a2 and a3 do not each get a budget of their own.
      expect(seen).toEqual(['a1'])

      runAllTurns()
      expect(seen).toEqual(['a1', 'a2', 'a3'])
    })

    it('spends one budget across the pushes of a turn', () => {
      const third = Math.ceil(SLOW / 3)
      const { pump, seen } = harness({ cost: () => third })
      pump.push('a1')
      pump.push('a2')
      expect(seen).toEqual(['a1', 'a2'])
      pump.push('a3')
      expect(seen).toEqual(['a1', 'a2', 'a3'])
      // Three thirds are spent: the fourth push of the same turn has to wait.
      pump.push('a4')
      expect(seen).toEqual(['a1', 'a2', 'a3'])
    })

    it('gives the next loop turn a full budget again', () => {
      const half = Math.ceil(SLOW / 2)
      const { pump, seen, runNextTurn } = harness({ cost: () => half })
      pump.push('a1')
      pump.push('a2')
      pump.push('a3')
      expect(seen).toEqual(['a1', 'a2'])

      runNextTurn()
      expect(seen).toEqual(['a1', 'a2', 'a3'])
      // The new turn has half its budget left, so this is handled on arrival.
      pump.push('a4')
      expect(seen).toEqual(['a1', 'a2', 'a3', 'a4'])
    })

    it('starts the next turn fresh after a turn that left nothing waiting', () => {
      const { pump, seen, turns, runNextTurn } = harness()
      pump.push('a1')
      // Nothing is waiting, but the turn is spent and a boundary is owed.
      expect(turns).toHaveLength(1)
      runNextTurn()

      pump.push('a2')
      expect(seen).toEqual(['a1', 'a2'])
    })

    it('counts one yield per turn, however many pushes that turn turned away', () => {
      const { pump, runNextTurn } = harness()
      pump.push('a1')
      pump.push('a2')
      pump.push('a3')
      pump.push('a4')
      expect(orderedStreamPumpCounters().test.yields).toBe(1)

      runNextTurn()
      expect(orderedStreamPumpCounters().test.yields).toBe(2)
    })
  })

  it('keeps arrival order when a second chunk lands behind a deferred remainder', () => {
    const { pump, seen, runAllTurns } = harness()
    pump.pushAll(['a1', 'a2', 'a3'])
    pump.pushAll(['b1', 'b2'])
    // The newer chunk must not start a turn of its own ahead of a2 and a3.
    expect(seen).toEqual(['a1'])

    runAllTurns()
    expect(seen).toEqual(['a1', 'a2', 'a3', 'b1', 'b2'])
  })

  it('keeps arrival order for single pushes behind a deferred remainder', () => {
    const { pump, seen, runAllTurns } = harness()
    pump.pushAll(['a1', 'a2'])
    pump.push('b1')
    expect(seen).toEqual(['a1'])

    runAllTurns()
    expect(seen).toEqual(['a1', 'a2', 'b1'])
  })

  it('finishes the visit in hand before handling what that visit pushed', () => {
    const events: string[] = []
    const h = harness({
      cost: () => 0,
      visit: (item) => {
        events.push(`enter ${item}`)
        if (item === 'a') h.pump.push('pushed-by-a')
        events.push(`exit ${item}`)
      }
    })
    h.pump.pushAll(['a', 'b'])
    expect(events).toEqual([
      'enter a',
      'exit a',
      'enter b',
      'exit b',
      'enter pushed-by-a',
      'exit pushed-by-a'
    ])
  })

  describe('flush', () => {
    it('handles everything still waiting, in order, before it returns', () => {
      const { pump, seen, turns } = harness()
      pump.pushAll(['a1', 'a2', 'a3'])
      pump.pushAll(['b1', 'b2'])
      expect(seen).toEqual(['a1'])

      pump.flush()
      expect(seen).toEqual(['a1', 'a2', 'a3', 'b1', 'b2'])
      expect(pump.pending).toBe(0)
      // The deferred turn is still on the schedule; it must find nothing to do.
      expect(turns).toHaveLength(1)
    })

    it('leaves nothing for the turn that was already scheduled to repeat', () => {
      const { pump, seen, runAllTurns } = harness()
      pump.pushAll(['a1', 'a2', 'a3'])
      pump.flush()
      runAllTurns()
      expect(seen).toEqual(['a1', 'a2', 'a3'])
    })

    it('keeps the pump usable for output that arrives after a flush', () => {
      const { pump, seen, runAllTurns } = harness()
      pump.pushAll(['a1', 'a2'])
      pump.flush()
      pump.pushAll(['b1', 'b2'])
      runAllTurns()
      expect(seen).toEqual(['a1', 'a2', 'b1', 'b2'])
    })

    it('finishes the backlog and keeps a visit error away from the caller', () => {
      const reported: unknown[] = []
      const boom = new Error('boom')
      const { pump, seen } = harness({
        onFlushVisitError: (error) => reported.push(error),
        visit: (item) => {
          if (item === 'a2') throw boom
        }
      })
      pump.pushAll(['a1', 'a2', 'a3'])
      expect(seen).toEqual(['a1'])

      expect(() => pump.flush()).not.toThrow()
      expect(seen).toEqual(['a1', 'a2', 'a3'])
      expect(reported).toEqual([boom])
    })

    it('is a no-op when nothing is waiting', () => {
      const { pump, seen } = harness({ cost: () => 0 })
      pump.pushAll(['a'])
      pump.flush()
      expect(seen).toEqual(['a'])
      expect(orderedStreamPumpCounters().test.flushes).toBe(0)
    })
  })

  describe('a visit that throws in a paced turn', () => {
    it('propagates, is not repeated, and does not strand what was behind it', () => {
      const { pump, seen, turns, runAllTurns } = harness({
        cost: () => 0,
        visit: (item) => {
          if (item === 'boom') throw new Error('boom')
        }
      })

      expect(() => pump.pushAll(['a', 'boom', 'c', 'd'])).toThrow('boom')
      expect(seen).toEqual(['a', 'boom'])
      expect(turns).toHaveLength(1)

      runAllTurns()
      expect(seen).toEqual(['a', 'boom', 'c', 'd'])
    })
  })

  describe('backlog bound', () => {
    it('pauses the source at the high-water mark and resumes it at the low-water mark', () => {
      const source = recordingSource()
      const { pump, seen, runNextTurn } = harness({
        source,
        highWaterItems: 4,
        lowWaterItems: 1
      })
      pump.pushAll(['1', '2', '3', '4', '5', '6'])
      // One slow item handled, five waiting: over the mark.
      expect(seen).toEqual(['1'])
      expect(source.calls).toEqual(['pause'])

      runNextTurn() // 4 waiting
      runNextTurn() // 3 waiting
      runNextTurn() // 2 waiting
      expect(source.calls).toEqual(['pause'])
      runNextTurn() // 1 waiting: at the low-water mark
      expect(source.calls).toEqual(['pause', 'resume'])
      expect(pump.pending).toBe(1)
    })

    it('pauses once, however much more arrives while the source is paused', () => {
      const source = recordingSource()
      const { pump } = harness({ source, highWaterItems: 2, lowWaterItems: 0 })
      pump.pushAll(['1', '2', '3'])
      pump.pushAll(['4', '5'])
      expect(source.calls).toEqual(['pause'])
    })

    it('does not pause for a burst it clears within the turn', () => {
      const source = recordingSource()
      const { pump, seen } = harness({ source, cost: () => 0, highWaterItems: 4, lowWaterItems: 1 })
      pump.pushAll(['1', '2', '3', '4', '5', '6', '7', '8'])
      expect(seen).toHaveLength(8)
      expect(source.calls).toEqual([])
    })

    it('pauses on backlog weight even when few items are waiting', () => {
      const source = recordingSource()
      const { pump, runAllTurns } = harness({
        source,
        highWaterChars: 10,
        lowWaterChars: 0
      })
      pump.pushAll(['x', 'yyyyyy', 'zzzzzz'])
      // 'x' handled; 12 characters still waiting against a mark of 10.
      expect(source.calls).toEqual(['pause'])

      runAllTurns()
      expect(source.calls).toEqual(['pause', 'resume'])
    })

    it('holds the source paused until the backlog weight is under its low-water mark', () => {
      const source = recordingSource()
      const { pump, runNextTurn } = harness({
        source,
        highWaterChars: 10,
        lowWaterChars: 3
      })
      pump.pushAll(['x', 'yyyyyy', 'zzzzzz', 'w'])
      expect(source.calls).toEqual(['pause'])

      runNextTurn() // 7 characters waiting: few items, still too heavy
      expect(source.calls).toEqual(['pause'])
      runNextTurn() // 1 character waiting
      expect(source.calls).toEqual(['pause', 'resume'])
    })

    it('resumes a paused source when the backlog is flushed', () => {
      const source = recordingSource()
      const { pump } = harness({ source, highWaterItems: 2, lowWaterItems: 0 })
      pump.pushAll(['1', '2', '3', '4'])
      expect(source.calls).toEqual(['pause'])

      pump.flush()
      expect(source.calls).toEqual(['pause', 'resume'])
    })

    it('never resumes a source it did not pause', () => {
      const source = recordingSource()
      const { pump, runAllTurns } = harness({ source })
      pump.pushAll(['1', '2', '3'])
      runAllTurns()
      pump.flush()
      expect(source.calls).toEqual([])
    })

    it('keeps taking output when the source cannot be paused', () => {
      const { pump, seen, runAllTurns } = harness({
        source: {
          pause: () => {
            throw new Error('not pausable')
          },
          resume: () => {
            throw new Error('not resumable')
          }
        },
        highWaterItems: 1,
        lowWaterItems: 0
      })
      pump.pushAll(['1', '2', '3'])
      runAllTurns()
      expect(seen).toEqual(['1', '2', '3'])
    })
  })

  it('keeps order across a backlog long enough to be compacted', () => {
    // Every item is slow, so the queue never fully drains while more arrives:
    // the handled prefix has to be dropped without disturbing what is waiting.
    const { pump, seen, runNextTurn, turns } = harness<number>()
    const total = 5000
    let next = 0
    const pushSome = (count: number): void => {
      const batch: number[] = []
      for (let i = 0; i < count && next < total; i += 1) batch.push(next++)
      if (batch.length > 0) pump.pushAll(batch)
    }
    pushSome(8)
    for (let ran = 0; turns.length > 0; ran += 1) {
      if (ran >= MAX_TURNS) throw new Error(`still deferring after ${MAX_TURNS} turns`)
      // One out, one in: the backlog persists until the source runs dry.
      runNextTurn()
      pushSome(1)
    }
    expect(seen).toHaveLength(total)
    expect(seen).toEqual(Array.from({ length: total }, (_, index) => index))
  })

  describe('counters', () => {
    it('describes a backlog: what queued, what yielded, and how deep it got', () => {
      const source = recordingSource()
      const { pump, runNextTurn } = harness({
        source,
        highWaterItems: 3,
        lowWaterItems: 0,
        cost: (item) => (item === 'slowest' ? SLOW * 4 : SLOW)
      })
      pump.pushAll(['a', 'bb', 'slowest', 'd'])
      runNextTurn()
      pump.flush()

      expect(orderedStreamPumpCounters().test).toEqual({
        pumps: 1,
        pushed: 4,
        visited: 4,
        yields: 2,
        flushes: 1,
        flushedItems: 2,
        pauses: 1,
        visitErrors: 0,
        slowVisits: 4,
        maxPending: 3,
        maxPendingChars: 10,
        maxItemChars: 7,
        maxVisitMs: SLOW * 4
      })
    })

    it('counts a visit error whichever path it was thrown on', () => {
      const { pump } = harness({
        onFlushVisitError: () => undefined,
        visit: (item) => {
          if (item.startsWith('boom')) throw new Error(item)
        }
      })
      expect(() => pump.pushAll(['boom-paced', 'boom-flushed'])).toThrow('boom-paced')
      pump.flush()
      expect(orderedStreamPumpCounters().test.visitErrors).toBe(2)
    })

    it('keeps one group per label and hands out copies', () => {
      createOrderedStreamPump<string>({ label: 'codex', visit: () => undefined }).push('x')
      createOrderedStreamPump<string>({ label: 'codex', visit: () => undefined }).push('y')
      createOrderedStreamPump<string>({ label: 'muse', visit: () => undefined })

      const snapshot = orderedStreamPumpCounters()
      expect(snapshot.codex.pumps).toBe(2)
      expect(snapshot.codex.pushed).toBe(2)
      expect(snapshot.muse.pumps).toBe(1)
      expect(snapshot.muse.pushed).toBe(0)

      snapshot.codex.pushed = 99
      expect(orderedStreamPumpCounters().codex.pushed).toBe(2)
    })
  })

  it('paces on the real clock and schedule when none are injected', async () => {
    const seen: string[] = []
    const busyFor = (ms: number): void => {
      const until = Date.now() + ms
      while (Date.now() < until) {
        /* hold the turn, the way a slow handler does */
      }
    }
    const pump = createOrderedStreamPump<string>({
      label: 'test',
      visit: (item) => {
        seen.push(item)
        busyFor(COOPERATIVE_STREAM_TURN_BUDGET_MS + 5)
      }
    })
    pump.pushAll(['a1', 'a2'])
    pump.push('b1')
    expect(seen).toEqual(['a1'])

    await new Promise<void>((resolve) => {
      const check = (): void => {
        if (pump.pending === 0) resolve()
        else setImmediate(check)
      }
      setImmediate(check)
    })
    expect(seen).toEqual(['a1', 'a2', 'b1'])
  })

  it('follows a test clock installed after the pump was created', () => {
    const seen: string[] = []
    const pump = createOrderedStreamPump<string>({
      label: 'test',
      visit: (item) => {
        seen.push(item)
        vi.setSystemTime(Date.now() + SLOW)
      }
    })
    // Fake timers replace the clock AND the deferral together. A pump still
    // reading the real clock would measure real time against a deferred turn
    // only the test can run, and stop handling once it had spent its budget.
    vi.useFakeTimers()
    try {
      pump.pushAll(['a', 'b'])
      expect(seen).toEqual(['a'])
      vi.runAllTimers()
      expect(seen).toEqual(['a', 'b'])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('against a real child pipe', () => {
  it('keeps every line in order through pauses of the pipe, and close flushes the rest', async () => {
    const total = 20_000
    // Writes as fast as the pipe accepts, the way a provider in a burst does.
    const child = spawn(
      process.execPath,
      [
        '-e',
        `let i = 0
         const write = () => {
           while (i < ${total}) {
             if (!process.stdout.write('line ' + i++ + '\\n')) return process.stdout.once('drain', write)
           }
         }
         write()`
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] }
    )
    const seen: string[] = []
    let carry = ''
    const pump = createOrderedStreamPump<string>({
      label: 'test',
      source: child.stdout,
      // Small marks and a 1 ms budget: the burst has to be deferred and the
      // pipe paused many times over, not once.
      budgetMs: 1,
      highWaterItems: 256,
      lowWaterItems: 64,
      visit: (line) => {
        seen.push(line)
        if (seen.length % 50 === 0) {
          const until = Date.now() + 1
          while (Date.now() < until) {
            /* a handler that costs something */
          }
        }
      }
    })
    child.stdout.on('data', (chunk: Buffer) => {
      const lines = (carry + chunk.toString()).split('\n')
      carry = lines.pop() ?? ''
      pump.pushAll(lines)
    })

    // A child blocked on a full pipe cannot exit, so reaching `close` at all
    // proves the pump resumed the pipe every time it paused it. Node itself
    // resumes stdout once the child HAS exited, which is why whatever was
    // still buffered arrives in one piece and is left for the flush.
    const exitCode = await new Promise<number | null>((resolve) => {
      child.on('close', (code) => {
        pump.flush()
        resolve(code)
      })
    })

    expect(exitCode).toBe(0)
    expect(pump.pending).toBe(0)
    expect(seen).toHaveLength(total)
    expect(seen.findIndex((line, index) => line !== `line ${index}`)).toBe(-1)
    const counters = orderedStreamPumpCounters().test
    expect(counters.yields).toBeGreaterThan(1)
    expect(counters.pauses).toBeGreaterThan(1)
  })
})

/**
 * Pacing is a wall-clock behaviour. A provider client's unit test feeds output
 * and asserts on the next line; if one long GC pause inside a visit could defer
 * that output, every such suite would fail at random on a loaded machine.
 */
describe('pacing outside this file', () => {
  /** A pump from `module` whose every visit costs a full budget. */
  function slowPump(module: typeof import('./CooperativeStreamPump')) {
    let clock = 0
    const seen: string[] = []
    const pump = module.createOrderedStreamPump<string>({
      label: 'test',
      now: () => clock,
      schedule: () => {},
      visit: (item) => {
        seen.push(item)
        clock += SLOW
      }
    })
    return { pump, seen }
  }

  it('is off under test until a test turns it on', async () => {
    vi.resetModules()
    try {
      // A fresh copy of the module, as a client suite that never mentions
      // pacing gets it.
      const untouched = await import('./CooperativeStreamPump')
      const arrival = slowPump(untouched)
      arrival.pump.pushAll(['a', 'b'])
      arrival.pump.push('c')
      expect(arrival.seen).toEqual(['a', 'b', 'c'])

      untouched.setOrderedStreamPumpPacingForTest(true)
      const paced = slowPump(untouched)
      paced.pump.pushAll(['a', 'b'])
      expect(paced.seen).toEqual(['a'])
    } finally {
      vi.resetModules()
    }
  })

  it('schedules nothing while it is off', () => {
    setOrderedStreamPumpPacingForTest(false)
    const { pump, seen, turns } = harness()

    pump.pushAll(['a', 'b'])

    expect(seen).toEqual(['a', 'b'])
    expect(turns).toHaveLength(0)
    expect(orderedStreamPumpCounters().test.yields).toBe(0)
  })

  it('still honours a budget the caller sets itself', () => {
    setOrderedStreamPumpPacingForTest(false)
    const { pump, seen } = harness({ budgetMs: SLOW })

    pump.pushAll(['a', 'b'])

    expect(seen).toEqual(['a'])
  })

  it('is on in the app, where the switch itself is refused', async () => {
    vi.resetModules()
    vi.stubEnv('NODE_ENV', 'production')
    try {
      const app = await import('./CooperativeStreamPump')
      const { pump, seen } = slowPump(app)

      pump.pushAll(['a', 'b'])

      expect(seen).toEqual(['a'])
      expect(() => app.setOrderedStreamPumpPacingForTest(false)).toThrow(
        'only be switched in tests'
      )
    } finally {
      vi.unstubAllEnvs()
      vi.resetModules()
    }
  })
})
