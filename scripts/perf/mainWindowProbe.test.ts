import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)

type Asked = {
  askedAtMs: number
  answeredAtMs: number
  answer?: unknown
  error?: { code: string | null; message: string }
}
const probe = require('./mainWindowProbe.cjs') as {
  MAIN_PROBE_LAG_FIELDS: readonly string[]
  failedMainProbeChecks: (input: {
    begin: unknown
    end: unknown
    windowId: string
    windowMs: number
  }) => string[]
  askMainProbe: (read: () => unknown, nowMs: () => number) => Promise<Asked>
  mainProbeAnswer: (asked: Asked) => Record<string, unknown>
}

const WINDOW_ID = 'light_beside_0'
const WINDOW_MS = 120_000
const STARTED_AT_MS = 1_000.25

/** Main's answer to a window's start. */
function begun(change: Record<string, unknown> = {}) {
  return {
    status: 'started',
    id: WINDOW_ID,
    startedAtMs: STARTED_AT_MS,
    expectedEndAtMs: STARTED_AT_MS + WINDOW_MS,
    durability: { pool: 1 },
    ...change
  }
}

/** Main's receipt for a window's end, its timer half a millisecond late. */
function receipt(change: Record<string, unknown> = {}, lag: Record<string, unknown> = {}) {
  return {
    status: 'complete',
    id: WINDOW_ID,
    startedAtMs: STARTED_AT_MS,
    endedAtMs: STARTED_AT_MS + WINDOW_MS + 0.5,
    expectedEndAtMs: STARTED_AT_MS + WINDOW_MS,
    eventLoopLag: {
      sampling: true,
      observedForMs: WINDOW_MS,
      p50Ms: 1,
      p95Ms: 28,
      p99Ms: 40,
      maxMs: 50,
      meanMs: 2,
      ...lag
    },
    ...change
  }
}

const checks = (begin: unknown, end: unknown) =>
  probe.failedMainProbeChecks({ begin, end, windowId: WINDOW_ID, windowMs: WINDOW_MS })

describe('the checks a window’s probe answers must pass', () => {
  it('fails none for a window main began and then answered for in full', () => {
    expect(checks(begun(), receipt())).toEqual([])
  })

  const refused = { status: 'unavailable', reason: 'window_held' }
  it.each<[string, unknown, unknown, string[]]>([
    // The end of a window main would not start is never asked for: the
    // verdict reads the start's answer in its place.
    ['a window main would not start', refused, refused, ['begin_not_started']],
    ['an answer to the start that was not main’s', null, null, ['begin_not_started']],
    [
      'a window begun under another name',
      begun({ id: 'light_beside_1' }),
      receipt(),
      ['begin_other_window']
    ],
    [
      'an end main had not finished timing',
      begun(),
      { status: 'unavailable', reason: 'window_incomplete' },
      ['end_not_complete']
    ],
    ['an end that says started', begun(), receipt({ status: 'started' }), ['end_not_complete']],
    [
      'the receipt of another window',
      begun(),
      receipt({ id: 'light_beside_2' }),
      ['end_other_window']
    ],
    ['no start', begun(), receipt({ startedAtMs: undefined }), ['end_started_at_invalid']],
    ['a start that is null', begun(), receipt({ startedAtMs: null }), ['end_started_at_invalid']],
    ['an end that is text', begun(), receipt({ endedAtMs: '121001' }), ['end_ended_at_invalid']],
    ['an end before zero', begun(), receipt({ endedAtMs: -1 }), ['end_ended_at_invalid']],
    [
      'a window its timer ended under a millisecond short',
      begun(),
      receipt({ endedAtMs: STARTED_AT_MS + WINDOW_MS - 0.4 }),
      ['end_short_of_window']
    ],
    ['no lag', begun(), receipt({ eventLoopLag: null }), ['lag_missing']],
    ['lag as a list', begun(), receipt({ eventLoopLag: [] }), ['lag_missing']],
    ['lag that was not sampled', begun(), receipt({}, { sampling: false }), ['lag_not_sampling']],
    ['no time observed', begun(), receipt({}, { observedForMs: 0 }), ['lag_observed_nothing']],
    [
      'an observed time that is not a number',
      begun(),
      receipt({}, { observedForMs: Number.NaN }),
      ['lag_observed_nothing', 'lag_figure_invalid:observedForMs']
    ]
  ])('names %s', (_name, begin, end, failed) => {
    expect(checks(begin, end)).toEqual(failed)
  })

  it.each(['p50Ms', 'p95Ms', 'p99Ms', 'maxMs', 'meanMs'])(
    'names a lag %s that is missing',
    (name) => {
      expect(checks(begun(), receipt({}, { [name]: undefined }))).toEqual([
        `lag_figure_invalid:${name}`
      ])
    }
  )

  it('reads every lag figure the verdict reads', () => {
    expect(probe.MAIN_PROBE_LAG_FIELDS).toEqual([
      'p50Ms',
      'p95Ms',
      'p99Ms',
      'maxMs',
      'meanMs',
      'observedForMs'
    ])
  })

  it('names every check a pair of answers fails, in the order the verdict reads them', () => {
    expect(
      checks(
        begun({ id: 'light_beside_1' }),
        receipt({ endedAtMs: STARTED_AT_MS + 1 }, { sampling: 'true', maxMs: -1 })
      )
    ).toEqual([
      'begin_other_window',
      'end_short_of_window',
      'lag_not_sampling',
      'lag_figure_invalid:maxMs'
    ])
  })

  it('does not call a window short whose times are not times', () => {
    expect(checks(begun(), receipt({ startedAtMs: null, endedAtMs: 'late' }))).toEqual([
      'end_started_at_invalid',
      'end_ended_at_invalid'
    ])
  })

  // The verdict took a window exactly when every one of these held, written
  // as one condition in each window module before the checks had names.
  function everyConditionHolds(begin: any, end: any) {
    const finite = (value: unknown) =>
      typeof value === 'number' && Number.isFinite(value) && value >= 0
    const plain = (value: unknown) =>
      value !== null && typeof value === 'object' && !Array.isArray(value)
    return (
      begin.status === 'started' &&
      begin.id === WINDOW_ID &&
      end.status === 'complete' &&
      end.id === WINDOW_ID &&
      finite(end.startedAtMs) &&
      finite(end.endedAtMs) &&
      end.endedAtMs - end.startedAtMs >= WINDOW_MS &&
      plain(end.eventLoopLag) &&
      end.eventLoopLag.sampling === true &&
      end.eventLoopLag.observedForMs > 0 &&
      ['p50Ms', 'p95Ms', 'p99Ms', 'maxMs', 'meanMs', 'observedForMs'].every((name) =>
        finite(end.eventLoopLag[name])
      )
    )
  }

  it('passes a pair of answers exactly when every condition the verdict read holds', () => {
    let seed = 7
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
      return seed / 2_147_483_648
    }
    const pick = <T>(values: T[]) => values[Math.floor(random() * values.length)]
    const often = <T>(good: T, bad: T[]) => (random() < 0.9 ? good : pick(bad))
    const notTimes = [null, undefined, '5', Number.NaN, -1, Number.POSITIVE_INFINITY, {}]
    let taken = 0
    for (let made = 0; made < 3_000; made += 1) {
      const begin = begun({
        status: often('started', ['complete', 'unavailable', undefined]),
        id: often(WINDOW_ID, ['light_beside_1', undefined])
      })
      const startedAtMs = often(STARTED_AT_MS, notTimes)
      const lag = receipt().eventLoopLag as Record<string, unknown>
      for (const name of Object.keys(lag)) {
        lag[name] = often(lag[name], name === 'sampling' ? [false, 'true'] : [0, ...notTimes])
      }
      const end = receipt({
        status: often('complete', ['started', 'unavailable']),
        id: often(WINDOW_ID, ['light_beside_2']),
        startedAtMs,
        endedAtMs: often(
          STARTED_AT_MS + pick([WINDOW_MS, WINDOW_MS + 0.001, WINDOW_MS - 0.001, WINDOW_MS - 1]),
          notTimes
        ),
        eventLoopLag: often(lag, [null, [], 5])
      })
      const asked = begin.status === 'started' ? end : begin
      const holds = everyConditionHolds(begin, asked)
      if (holds) taken += 1
      expect(checks(begin, asked).length === 0).toBe(holds)
    }
    // Both kinds of pair were made: windows taken and windows refused.
    expect(taken).toBeGreaterThan(100)
    expect(taken).toBeLessThan(2_900)
  })
})

describe('one ask of main’s window probe, kept as main answered it', () => {
  const clock = (...readings: number[]) => {
    const left = [...readings]
    return () => left.shift() ?? Number.NaN
  }

  it('keeps main’s answer unchanged, with when it was asked and when it came', async () => {
    const answer = receipt()
    const asked = await probe.askMainProbe(async () => answer, clock(10, 25))
    expect(asked).toEqual({ askedAtMs: 10, answeredAtMs: 25, answer })
    expect(asked.answer).toBe(answer)
    expect(probe.mainProbeAnswer(asked)).toBe(answer)
  })

  it.each<[string, unknown]>([
    ['nothing', null],
    ['undefined', undefined],
    ['a list', [receipt()]],
    ['text', 'complete']
  ])(
    'keeps an answer of %s as it came, and the verdict reads it as not main’s',
    async (_name, value) => {
      const asked = await probe.askMainProbe(async () => value, clock(10, 25))
      expect(asked).toEqual({ askedAtMs: 10, answeredAtMs: 25, answer: value ?? null })
      expect(probe.mainProbeAnswer(asked)).toEqual({
        status: 'unavailable',
        reason: 'main_probe_invalid'
      })
    }
  )

  it('keeps the error a read timed out with, in place of an answer', async () => {
    const timedOut = Object.assign(new Error('main window probe timed out after 5ms'), {
      code: 'CAPTURE_TIMEOUT'
    })
    const asked = await probe.askMainProbe(() => Promise.reject(timedOut), clock(10, 5_010))
    expect(asked).toEqual({
      askedAtMs: 10,
      answeredAtMs: 5_010,
      error: { code: 'CAPTURE_TIMEOUT', message: 'main window probe timed out after 5ms' }
    })
    expect('answer' in asked).toBe(false)
    expect(probe.mainProbeAnswer(asked)).toEqual({
      status: 'unavailable',
      reason: 'main_unresponsive'
    })
  })

  it('keeps the error of a read that failed, thrown or rejected', async () => {
    const thrown = await probe.askMainProbe(
      () => {
        throw new Error('renderer went away')
      },
      clock(1, 2)
    )
    expect(thrown).toEqual({
      askedAtMs: 1,
      answeredAtMs: 2,
      error: { code: null, message: 'renderer went away' }
    })
    expect(probe.mainProbeAnswer(thrown)).toEqual({
      status: 'unavailable',
      reason: 'main_probe_failed'
    })
    const rejected = await probe.askMainProbe(() => Promise.reject('closed'), clock(1, 2))
    expect(rejected.error).toEqual({ code: null, message: 'closed' })
    expect(probe.mainProbeAnswer(rejected).reason).toBe('main_probe_failed')
  })

  it('keeps the start of a long error message only', async () => {
    const asked = await probe.askMainProbe(
      () => Promise.reject(new Error('x'.repeat(1_000))),
      clock(1, 2)
    )
    expect(asked.error?.message).toBe('x'.repeat(300))
  })
})
