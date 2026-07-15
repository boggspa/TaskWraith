import { describe, expect, it } from 'vitest'
import { WorkflowBudgetRegistry, type RegisteredBudget, type WorkflowBudgetEvent } from './WorkflowBudgetRegistry'

// A fake timer seam: setTimer records {fn, ms, handle}; the test fires it
// manually via fireTimer(handle). clearTimer marks it cleared so a fired-after-
// clear assertion is possible. The clock is a mutable `nowMs` the test advances.
interface FakeTimer {
  handle: number
  fn: () => void
  ms: number
  cleared: boolean
}

function makeHarness(startNow = 1_000_000) {
  let nowMs = startNow
  let nextHandle = 1
  const timers = new Map<number, FakeTimer>()
  const aborts: Array<{ provider: string; runId: string }> = []
  const marks: Array<{ runId: string; scheduledTaskId: string; lastError: string }> = []
  const events: WorkflowBudgetEvent[] = []

  const registry = new WorkflowBudgetRegistry({
    abort: (provider, runId) => aborts.push({ provider, runId }),
    markTaskFailed: (failure) => marks.push(failure),
    now: () => nowMs,
    setTimer: (fn, ms) => {
      const handle = nextHandle++
      timers.set(handle, { handle, fn, ms, cleared: false })
      return handle
    },
    clearTimer: (handle) => {
      const t = timers.get(handle as number)
      if (t) t.cleared = true
    },
    onEvent: (e) => events.push(e)
  })

  return {
    registry,
    aborts,
    marks,
    events,
    timers,
    setNow: (ms: number) => {
      nowMs = ms
    },
    advance: (deltaMs: number) => {
      nowMs += deltaMs
    },
    /** Fire the most recently armed (non-cleared) timer, as setTimeout would. */
    fireLatestTimer: () => {
      const live = [...timers.values()].filter((t) => !t.cleared)
      const t = live[live.length - 1]
      if (!t) throw new Error('no live timer to fire')
      t.fn()
    },
    fireTimer: (handle: number) => {
      const t = timers.get(handle)
      if (!t) throw new Error(`no timer ${handle}`)
      t.fn()
    }
  }
}

const budget = (over: Partial<RegisteredBudget> = {}): RegisteredBudget => ({
  runId: 'run-1',
  scheduledTaskId: 'task-1',
  startedAtMs: 1_000_000,
  provider: 'claude',
  ...over
})

describe('WorkflowBudgetRegistry.register', () => {
  it('arms a wall-clock timer when timeoutSeconds is set', () => {
    const h = makeHarness(1_000_000)
    h.registry.register(budget({ timeoutSeconds: 60 }))
    const live = [...h.timers.values()]
    expect(live).toHaveLength(1)
    // startedAtMs === now → full 60s remaining.
    expect(live[0].ms).toBe(60_000)
    expect(h.events).toContainEqual({
      kind: 'registered',
      runId: 'run-1',
      provider: 'claude',
      scheduledTaskId: 'task-1'
    })
  })

  it('arms the timer for the REMAINING window when registration lands after start', () => {
    const h = makeHarness(1_010_000) // 10s after startedAtMs
    h.registry.register(budget({ timeoutSeconds: 60, startedAtMs: 1_000_000 }))
    expect([...h.timers.values()][0].ms).toBe(50_000)
  })

  it('clamps a past deadline to 0ms (fires immediately) rather than negative', () => {
    const h = makeHarness(1_100_000) // 100s after start, past a 60s cap
    h.registry.register(budget({ timeoutSeconds: 60, startedAtMs: 1_000_000 }))
    expect([...h.timers.values()][0].ms).toBe(0)
  })

  it('arms NO timer when there is no timeoutSeconds (token/cost-only budget)', () => {
    const h = makeHarness()
    h.registry.register(budget({ maxTokens: 1000 }))
    expect(h.timers.size).toBe(0)
    expect(h.registry.size).toBe(1)
  })
})

describe('WorkflowBudgetRegistry.onUsage — token breach', () => {
  it('aborts the run AND marks the task failed AT THE KILL on a token breach (not at exit)', () => {
    const h = makeHarness()
    h.registry.register(budget({ maxTokens: 1000 }))

    h.registry.onUsage('run-1', { total_tokens: 999 })
    expect(h.aborts).toHaveLength(0) // below the cap
    expect(h.marks).toHaveLength(0)

    h.registry.onUsage('run-1', { total_tokens: 1000 })
    expect(h.aborts).toEqual([{ provider: 'claude', runId: 'run-1' }])
    expect(h.registry.isKilled('run-1')).toBe(true)
    // The terminal mark is made at the kill DECISION — deterministic and ahead
    // of any transport/compat-exit cleanup or renderer run-end mark.
    expect(h.marks).toHaveLength(1)
    expect(h.marks[0].runId).toBe('run-1')
    expect(h.marks[0].scheduledTaskId).toBe('task-1')
    expect(h.marks[0].lastError).toContain('token budget exceeded')
    expect(h.marks[0].lastError).toContain('1000 / 1000 tokens')

    // onExit is cleanup-only and must NOT re-mark.
    h.registry.onExit('run-1')
    expect(h.marks).toHaveLength(1)
  })

  it('aborts + marks on a cost breach (best-effort signal)', () => {
    const h = makeHarness()
    h.registry.register(budget({ maxCostUsd: 0.5 }))
    h.registry.onUsage('run-1', { total_cost_usd: 0.5 })
    expect(h.aborts).toEqual([{ provider: 'claude', runId: 'run-1' }])
    expect(h.marks[0].lastError).toContain('cost budget exceeded')
  })

  it('uses the CAPTURED provider on abort (e.g. codex), not a default', () => {
    const h = makeHarness()
    h.registry.register(budget({ maxTokens: 100, provider: 'codex' }))
    h.registry.onUsage('run-1', { total_tokens: 100 })
    expect(h.aborts).toEqual([{ provider: 'codex', runId: 'run-1' }])
  })

  it('is a no-op for an unregistered run', () => {
    const h = makeHarness()
    h.registry.onUsage('ghost', { total_tokens: 9_999_999 })
    expect(h.aborts).toHaveLength(0)
    expect(h.marks).toHaveLength(0)
  })

  it('never throws and does not breach on missing / NaN usage', () => {
    const h = makeHarness()
    h.registry.register(budget({ maxTokens: 1000 }))
    expect(() => h.registry.onUsage('run-1', undefined)).not.toThrow()
    expect(() => h.registry.onUsage('run-1', null)).not.toThrow()
    expect(() => h.registry.onUsage('run-1', { total_tokens: Number.NaN })).not.toThrow()
    expect(h.aborts).toHaveLength(0)
  })
})

describe('WorkflowBudgetRegistry.onWallclock — wall-clock breach', () => {
  it('aborts + marks when the timer fires past the deadline and clears the timer', () => {
    const h = makeHarness(1_000_000)
    h.registry.register(budget({ timeoutSeconds: 60 }))
    const handle = [...h.timers.values()][0].handle

    h.setNow(1_060_000) // exactly at the 60s cap
    h.fireTimer(handle)

    expect(h.aborts).toEqual([{ provider: 'claude', runId: 'run-1' }])
    expect(h.timers.get(handle)?.cleared).toBe(true)
    expect(h.marks).toHaveLength(1)
    expect(h.marks[0]).toMatchObject({ runId: 'run-1', scheduledTaskId: 'task-1' })
    expect(h.marks[0].lastError).toContain('wall-clock budget exceeded')
  })

  it('re-validates against the real clock: a too-early timer fire does NOT kill', () => {
    const h = makeHarness(1_000_000)
    h.registry.register(budget({ timeoutSeconds: 60 }))
    const handle = [...h.timers.values()][0].handle

    // Timer fires but only 30s of wall-clock has actually elapsed (coalesced/early).
    h.setNow(1_030_000)
    h.fireTimer(handle)
    expect(h.aborts).toHaveLength(0)
    expect(h.marks).toHaveLength(0)
    expect(h.registry.isKilled('run-1')).toBe(false)
  })

  it('direct onWallclock for an unregistered run is a no-op', () => {
    const h = makeHarness()
    expect(() => h.registry.onWallclock('ghost')).not.toThrow()
    expect(h.aborts).toHaveLength(0)
  })
})

describe('WorkflowBudgetRegistry idempotency', () => {
  it('passes the exact breached run identity when live runs share a scheduled task id', () => {
    const h = makeHarness()
    h.registry.register(budget({ runId: 'run-old', scheduledTaskId: 'task-shared', maxTokens: 1000 }))
    h.registry.register(budget({ runId: 'run-current', scheduledTaskId: 'task-shared', maxTokens: 1000 }))

    h.registry.onUsage('run-current', { total_tokens: 1000 })

    expect(h.marks).toEqual([
      expect.objectContaining({ runId: 'run-current', scheduledTaskId: 'task-shared' })
    ])
    expect(h.aborts).toEqual([{ provider: 'claude', runId: 'run-current' }])
  })

  it('aborts ONCE and marks ONCE when token + wall-clock both breach', () => {
    const h = makeHarness(1_000_000)
    h.registry.register(budget({ timeoutSeconds: 60, maxTokens: 1000 }))
    const handle = [...h.timers.values()][0].handle

    // Token breach fires first → abort + mark, timer cleared.
    h.registry.onUsage('run-1', { total_tokens: 1000 })
    expect(h.aborts).toHaveLength(1)
    expect(h.marks).toHaveLength(1)
    expect(h.timers.get(handle)?.cleared).toBe(true)

    // A racing wall-clock fire after the kill is a no-op.
    h.setNow(1_060_000)
    h.registry.onWallclock('run-1')
    // A second usage event after the kill is also a no-op.
    h.registry.onUsage('run-1', { total_tokens: 2000 })
    expect(h.aborts).toHaveLength(1)
    expect(h.marks).toHaveLength(1)

    // Exit (even delivered twice) never re-marks.
    h.registry.onExit('run-1')
    h.registry.onExit('run-1')
    expect(h.marks).toHaveLength(1)
  })

  it('records the FIRST breach reason (tokens) for the terminal mark', () => {
    const h = makeHarness(1_000_000)
    h.registry.register(budget({ timeoutSeconds: 60, maxTokens: 1000 }))
    h.registry.onUsage('run-1', { total_tokens: 1500 })
    expect(h.marks[0].lastError).toContain('token budget exceeded')
  })
})

describe('WorkflowBudgetRegistry.onExit cleanup', () => {
  it('clears the timer + drops state so a late timer fire cannot kill a finished run', () => {
    const h = makeHarness(1_000_000)
    h.registry.register(budget({ timeoutSeconds: 60 }))
    const handle = [...h.timers.values()][0].handle

    // Run finishes normally (no breach) BEFORE the deadline.
    h.registry.onExit('run-1')
    expect(h.registry.size).toBe(0)
    expect(h.timers.get(handle)?.cleared).toBe(true)
    expect(h.marks).toHaveLength(0) // not killed → no terminal mark

    // A stale timer somehow fires after exit (or the id is reused): no abort.
    h.setNow(1_060_000)
    h.fireTimer(handle)
    expect(h.aborts).toHaveLength(0)
  })

  it('a normal (non-killed) exit does not mark the task failed', () => {
    const h = makeHarness()
    h.registry.register(budget({ maxTokens: 1000 }))
    h.registry.onExit('run-1')
    expect(h.marks).toHaveLength(0)
  })

  it('onExit for a never-registered run does not throw or mark', () => {
    const h = makeHarness()
    expect(() => h.registry.onExit('never-registered')).not.toThrow()
    expect(h.marks).toHaveLength(0)
  })
})

describe('WorkflowBudgetRegistry.isKilled gates the Claude fallback (RC2)', () => {
  it('is false before a breach and true after, so the CLI fallback can be skipped', () => {
    const h = makeHarness()
    h.registry.register(budget({ maxTokens: 1000 }))
    expect(h.registry.isKilled('run-1')).toBe(false)
    h.registry.onUsage('run-1', { total_tokens: 1000 })
    expect(h.registry.isKilled('run-1')).toBe(true)
  })

  it('drops the killed flag after onExit (a reused id starts clean)', () => {
    const h = makeHarness()
    h.registry.register(budget({ maxTokens: 1000 }))
    h.registry.onUsage('run-1', { total_tokens: 1000 })
    expect(h.registry.isKilled('run-1')).toBe(true)
    h.registry.onExit('run-1')
    expect(h.registry.isKilled('run-1')).toBe(false)
  })
})

describe('WorkflowBudgetRegistry.disposeAll', () => {
  it('clears every armed timer (will-quit) and empties the live set', () => {
    const h = makeHarness()
    h.registry.register(budget({ runId: 'a', scheduledTaskId: 't-a', timeoutSeconds: 60 }))
    h.registry.register(budget({ runId: 'b', scheduledTaskId: 't-b', timeoutSeconds: 120 }))
    expect(h.registry.size).toBe(2)

    h.registry.disposeAll()
    expect(h.registry.size).toBe(0)
    for (const t of h.timers.values()) expect(t.cleared).toBe(true)

    // A timer that fires after disposeAll cannot abort (state dropped).
    for (const t of h.timers.values()) t.fn()
    expect(h.aborts).toHaveLength(0)
  })
})

describe('WorkflowBudgetRegistry — re-register safety', () => {
  it('a register after a kill for the same id is ignored (no resurrection)', () => {
    const h = makeHarness()
    h.registry.register(budget({ maxTokens: 1000 }))
    h.registry.onUsage('run-1', { total_tokens: 1000 })
    expect(h.registry.isKilled('run-1')).toBe(true)

    // A duplicate/late register for the same id must not clear the killed flag.
    h.registry.register(budget({ maxTokens: 1000, timeoutSeconds: 60 }))
    expect(h.registry.isKilled('run-1')).toBe(true)
    expect(h.timers.size).toBe(0) // no new timer armed
  })

  it('re-registering a LIVE id replaces the prior entry and clears the old timer', () => {
    const h = makeHarness(1_000_000)
    h.registry.register(budget({ timeoutSeconds: 60 }))
    const first = [...h.timers.values()][0]
    h.registry.register(budget({ timeoutSeconds: 120 }))
    expect(first.cleared).toBe(true)
    expect(h.registry.size).toBe(1)
    const live = [...h.timers.values()].filter((t) => !t.cleared)
    expect(live).toHaveLength(1)
    expect(live[0].ms).toBe(120_000)
  })
})

describe('WorkflowBudgetRegistry.onTerminalUsage — post-hoc (grok/cursor)', () => {
  it('marks the task FAILED when final usage exceeds the token budget, WITHOUT aborting', () => {
    const h = makeHarness()
    h.registry.register(budget({ maxTokens: 1000, provider: 'grok' }))
    h.registry.onTerminalUsage('run-1', { total_tokens: 1500 })
    // No abort — the run already exited; this is a post-hoc budget signal only.
    expect(h.aborts).toHaveLength(0)
    expect(h.marks).toHaveLength(1)
    expect(h.marks[0]).toMatchObject({ runId: 'run-1', scheduledTaskId: 'task-1' })
    expect(h.marks[0].lastError).toContain('finished over its token budget')
    expect(h.marks[0].lastError).toContain('1500 / 1000 tokens')
    expect(h.registry.isKilled('run-1')).toBe(true)
  })

  it('does NOT mark when final usage is within budget', () => {
    const h = makeHarness()
    h.registry.register(budget({ maxTokens: 1000, provider: 'cursor' }))
    h.registry.onTerminalUsage('run-1', { total_tokens: 999 })
    expect(h.marks).toHaveLength(0)
    expect(h.aborts).toHaveLength(0)
  })

  it('emits a task-failed event CARRYING the breach (slice 3 — for the run ledger)', () => {
    const h = makeHarness()
    h.registry.register(budget({ maxTokens: 1000, provider: 'grok' }))
    h.registry.onTerminalUsage('run-1', { total_tokens: 1500 })
    const failed = h.events.find((e) => e.kind === 'task-failed')
    expect(failed).toBeDefined()
    expect(failed).toMatchObject({
      kind: 'task-failed',
      breach: { kind: 'tokens', limit: 1000, observed: 1500 }
    })
  })

  it('is idempotent with a prior mid-run kill (no double mark, no second abort)', () => {
    const h = makeHarness()
    h.registry.register(budget({ maxTokens: 1000 }))
    h.registry.onUsage('run-1', { total_tokens: 1000 }) // live kill: 1 abort + 1 mark
    expect(h.aborts).toHaveLength(1)
    expect(h.marks).toHaveLength(1)
    h.registry.onTerminalUsage('run-1', { total_tokens: 2000 }) // already killed → no-op
    expect(h.aborts).toHaveLength(1)
    expect(h.marks).toHaveLength(1)
  })

  it('is a no-op for an unregistered run', () => {
    const h = makeHarness()
    h.registry.onTerminalUsage('ghost', { total_tokens: 9_999_999 })
    expect(h.marks).toHaveLength(0)
  })

  it('honors a cost-only budget post-hoc (grok projected cost lands at close)', () => {
    const h = makeHarness()
    h.registry.register(budget({ maxCostUsd: 0.5, provider: 'grok' }))
    h.registry.onTerminalUsage('run-1', { total_cost_usd: 0.75 })
    expect(h.marks[0].lastError).toContain('finished over its cost budget')
    expect(h.aborts).toHaveLength(0)
  })
})
