import { createRequire } from 'module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)

type Timings = {
  count: number
  minMs: number
  p50Ms: number
  p95Ms: number
  maxMs: number
} | null
type Measures = {
  rounds: {
    sent: number
    ran: number
    completed: number
    endedOther: Record<string, number>
    unended: number
    withoutTurn: number
  }
  turns: { started: number; done: number; notDone: Record<string, number> }
  sendToAcceptedMs: Timings
  acceptedToFirstTurnMs: Timings
  sendToFirstTurnMs: Timings
  roundMs: Timings
  turnSpacing: {
    modelTurnMs: Timings
    startToStartMs: Timings
    betweenTurnsMs: Timings
    overlapped: number
    appMsPerTurn: Timings
  }
}
type Summary = {
  window: { startedAtMs: number; endedAtMs: number; lengthMs: number }
  asked: { threads: number; seats: number; agents: number; seatMode: string; atOnce: number }
  configuredTurnMs: number
  overall: Measures & {
    runningAtOnce: { asked: number; max: number; mean: number; noneMs: number }
    threadsFailed: number
    otherTurns: number
  }
  threads: Array<
    Measures & {
      thread: number
      chatId: string
      model: string
      failure: string | null
      runningAtOnce: { max: number }
    }
  >
}

const metrics = require('./manyAgentMetrics.cjs') as {
  agentsAsked: (shape: unknown) => Summary['asked']
  summariseManyAgents: (input: unknown) => Summary
  summariseAgentWaiting: (input: unknown) => Record<string, unknown>
  timingsOf: (values: unknown[]) => Timings
}

const WINDOW = { startedAtMs: 10_000, endedAtMs: 20_000 }
const round = (
  roundId: string,
  sentAtMs: number,
  acceptedAtMs: number,
  pageMs: number | null,
  endedAtMs: number | null,
  status: string | null = endedAtMs === null ? null : 'completed'
) => ({ roundId, sentAtMs, acceptedAtMs, pageMs, endedAtMs, status })
const turn = (
  model: string,
  startedAtMs: number,
  endedAtMs: number | null,
  outcome = endedAtMs === null ? 'streaming' : 'done'
) => ({ model, startedAtMs, endedAtMs, outcome })

/** A serial thread: one seat after another, three rounds across the window. */
const SERIAL = {
  chatId: 'chat-a',
  model: 'm:a',
  failure: null,
  rounds: [
    round('a1', 9_000, 9_050, 40, 11_000),
    round('a2', 11_100, 11_160, 50, 15_000),
    round('a3', 15_050, 15_100, 45, 21_000)
  ]
}
const SERIAL_TURNS = [
  turn('m:a', 9_100, 10_700),
  turn('m:a', 11_200, 12_800),
  turn('m:a', 13_000, 14_600),
  turn('m:a', 15_150, 16_750),
  turn('m:a', 17_000, 18_600),
  turn('m:a', 19_000, 20_600)
]
/** A thread whose seats run together, with a second round still running. */
const PARALLEL = {
  chatId: 'chat-b',
  model: 'm:b',
  failure: null,
  rounds: [round('b1', 10_500, 10_520, 15, 12_400), round('b2', 12_450, 12_470, 12, null)]
}
const PARALLEL_TURNS = [
  turn('m:b', 10_600, 12_200),
  turn('m:b', 10_610, 12_210),
  turn('m:b', 12_500, null)
]

function summarise(extra: Record<string, unknown> = {}) {
  return metrics.summariseManyAgents({
    window: WINDOW,
    threads: [SERIAL, PARALLEL],
    turns: [...SERIAL_TURNS, ...PARALLEL_TURNS].sort(
      (left, right) => left.startedAtMs - right.startedAtMs
    ),
    seats: 3,
    seatMode: 'serial',
    configuredTurnMs: 1_600,
    ...extra
  })
}

describe('timings over a list of values', () => {
  it('gives nearest-rank figures, and none for no values', () => {
    expect(metrics.timingsOf([])).toBeNull()
    expect(metrics.timingsOf([7])).toEqual({ count: 1, minMs: 7, p50Ms: 7, p95Ms: 7, maxMs: 7 })
    const values = Array.from({ length: 100 }, (_value, index) => 100 - index)
    expect(metrics.timingsOf(values)).toEqual({
      count: 100,
      minMs: 1,
      p50Ms: 50,
      p95Ms: 95,
      maxMs: 100
    })
  })

  it('keeps a negative value and drops what is not a number', () => {
    expect(metrics.timingsOf([30, -12, null, undefined, Number.NaN, '5', 4])).toEqual({
      count: 3,
      minMs: -12,
      p50Ms: 4,
      p95Ms: 30,
      maxMs: 30
    })
  })

  it('rounds to a thousandth of a millisecond', () => {
    expect(metrics.timingsOf([1 / 3])).toMatchObject({ minMs: 0.333, maxMs: 0.333 })
  })
})

describe('one thread’s measures', () => {
  it('counts the rounds sent in the window, run in it, completed in it, and still running', () => {
    const { threads } = summarise()
    // a1 was sent before the window and ended in it; a3 ended after it.
    expect(threads[0].rounds).toEqual({
      sent: 2,
      ran: 3,
      completed: 2,
      endedOther: {},
      unended: 0,
      withoutTurn: 0
    })
    expect(threads[1].rounds).toEqual({
      sent: 2,
      ran: 2,
      completed: 1,
      endedOther: {},
      unended: 1,
      withoutTurn: 0
    })
  })

  it('counts a round that ended any other way by how it ended', () => {
    const failed = {
      ...SERIAL,
      rounds: [
        round('a1', 10_100, 10_150, 40, 11_000, 'failed'),
        round('a2', 11_100, 11_160, 50, 12_000, 'cancelled'),
        round('a3', 12_100, 12_160, 50, 13_000, 'failed'),
        // Ended at the window's last millisecond, and at its end: only the first is inside.
        round('a4', 13_100, 13_160, 50, 19_999),
        round('a5', 19_999, 19_999, 50, 20_000)
      ]
    }
    const { threads } = summarise({ threads: [failed], turns: [] })
    expect(threads[0].rounds).toEqual({
      sent: 5,
      ran: 5,
      completed: 1,
      endedOther: { failed: 2, cancelled: 1 },
      unended: 0,
      withoutTurn: 5
    })
  })

  it('counts a round that ran in the window and ended any other way after it', () => {
    const thread = (place: number, ...rounds: Array<ReturnType<typeof round>>) => ({
      chatId: `chat-${place}`,
      model: `m:${place}`,
      failure: null,
      rounds
    })
    const { threads, overall } = summarise({
      threads: [
        // Running through the whole window, failed once it had closed.
        thread(1, round('r', 9_000, 9_050, 40, 21_000, 'failed')),
        // Sent in the window, cancelled as it closed.
        thread(2, round('r', 12_000, 12_050, 40, 20_000, 'cancelled')),
        // Over before the window began, or sent as it closed: not this window's.
        thread(3, round('r', 9_000, 9_050, 40, 9_999, 'failed')),
        thread(4, round('r', 20_000, 20_050, 40, 21_000, 'failed')),
        // Failed on the window's first millisecond.
        thread(5, round('r', 9_000, 9_050, 40, 10_000, 'failed')),
        // Completed after the window: no round of it, and nothing against it.
        thread(6, round('r', 12_000, 12_050, 40, 21_000))
      ],
      turns: []
    })
    expect(threads.map((entry) => entry.rounds.endedOther)).toEqual([
      { failed: 1 },
      { cancelled: 1 },
      {},
      {},
      { failed: 1 },
      {}
    ])
    expect(overall.rounds).toMatchObject({
      sent: 2,
      completed: 0,
      endedOther: { failed: 2, cancelled: 1 },
      unended: 0
    })
  })

  it('times send to accepted as the page measured it, for every round that ran in the window', () => {
    const { threads } = summarise()
    // a1 too, though it was sent before the window.
    expect(threads[0].sendToAcceptedMs).toEqual({
      count: 3,
      minMs: 40,
      p50Ms: 45,
      p95Ms: 50,
      maxMs: 50
    })
    expect(threads[1].sendToAcceptedMs).toMatchObject({ count: 2, minMs: 12, maxMs: 15 })
  })

  it('times accepted, and send, to the round’s first model turn by the daemon’s clock', () => {
    const { threads } = summarise()
    expect(threads[0].acceptedToFirstTurnMs).toMatchObject({ count: 3, minMs: 40, maxMs: 50 })
    expect(threads[0].sendToFirstTurnMs).toMatchObject({ count: 3, minMs: 100, maxMs: 100 })
    expect(threads[1].acceptedToFirstTurnMs).toMatchObject({ count: 2, minMs: 30, maxMs: 80 })
  })

  it('keeps a first turn that began before the runner heard the acceptance', () => {
    const early = { ...SERIAL, rounds: [round('a1', 11_000, 11_300, 250, 13_000)] }
    const { threads } = summarise({ threads: [early], turns: [turn('m:a', 11_200, 12_800)] })
    expect(threads[0].acceptedToFirstTurnMs).toMatchObject({ count: 1, minMs: -100 })
    expect(threads[0].sendToFirstTurnMs).toMatchObject({ count: 1, minMs: 200 })
  })

  it('gives a round no first turn from the round before or after it', () => {
    const rounds = [
      round('a1', 10_100, 10_150, 40, 12_000),
      round('a2', 12_100, 12_150, 40, 14_000),
      round('a3', 14_100, 14_150, 40, 16_000)
    ]
    // Only the first and third rounds ran a turn.
    const turns = [turn('m:a', 10_200, 11_800), turn('m:a', 14_300, 15_900)]
    const { threads } = summarise({ threads: [{ ...SERIAL, rounds }], turns })
    expect(threads[0].rounds.withoutTurn).toBe(1)
    expect(threads[0].acceptedToFirstTurnMs).toMatchObject({ count: 2, minMs: 50, maxMs: 150 })
  })

  it('counts the model turns started in the window and how each ended', () => {
    const { threads } = summarise()
    expect(threads[0].turns).toEqual({ started: 5, done: 5, notDone: {} })
    expect(threads[1].turns).toEqual({ started: 3, done: 2, notDone: { streaming: 1 } })
    const aborted = summarise({
      threads: [SERIAL],
      turns: [
        turn('m:a', 9_999, 10_500),
        turn('m:a', 10_000, 10_400, 'aborted'),
        turn('m:a', 19_999, 20_500, 'fault-omit-done'),
        turn('m:a', 20_000, 20_500)
      ]
    })
    expect(aborted.threads[0].turns).toEqual({
      started: 2,
      done: 0,
      notDone: { aborted: 1, 'fault-omit-done': 1 }
    })
  })

  it('sets the spacing of a round’s turns against the model’s own pace', () => {
    const { threads, configuredTurnMs } = summarise()
    expect(configuredTurnMs).toBe(1_600)
    // Rounds a1 to a3: each turn streamed 1,600 ms, the next began 200,
    // 250 and 400 ms after the one before ended.
    expect(threads[0].turnSpacing).toEqual({
      modelTurnMs: { count: 5, minMs: 1_600, p50Ms: 1_600, p95Ms: 1_600, maxMs: 1_600 },
      startToStartMs: { count: 3, minMs: 1_800, p50Ms: 1_850, p95Ms: 2_000, maxMs: 2_000 },
      betweenTurnsMs: { count: 3, minMs: 200, p50Ms: 250, p95Ms: 400, maxMs: 400 },
      overlapped: 0,
      // a1: 2,000 ms with 1,600 streaming, one turn; a2: 3,900 with 3,200,
      // two; a3: 5,950 with 4,800, three.
      appMsPerTurn: { count: 3, minMs: 350, p50Ms: 383.333, p95Ms: 400, maxMs: 400 }
    })
    expect(threads[0].roundMs).toMatchObject({ count: 3, minMs: 2_000, maxMs: 5_950 })
  })

  it('counts turns that ran together as overlapped, not as a gap', () => {
    const { threads } = summarise()
    expect(threads[1].turnSpacing).toEqual({
      modelTurnMs: { count: 2, minMs: 1_600, p50Ms: 1_600, p95Ms: 1_600, maxMs: 1_600 },
      startToStartMs: { count: 1, minMs: 10, p50Ms: 10, p95Ms: 10, maxMs: 10 },
      betweenTurnsMs: null,
      overlapped: 1,
      // b1: 1,900 ms, a turn streaming for 1,610 of them, two turns.
      appMsPerTurn: { count: 1, minMs: 145, p50Ms: 145, p95Ms: 145, maxMs: 145 }
    })
    expect(threads[1].runningAtOnce).toEqual({ max: 2 })
    expect(threads[0].runningAtOnce).toEqual({ max: 1 })
  })

  it('judges the spacing of every round that ran in the window and was seen to end', () => {
    const { threads } = summarise()
    // b2 never ended: it is not judged. a1 was sent before the window and is.
    expect(threads[1].roundMs).toMatchObject({ count: 1, minMs: 1_900 })
    expect(threads[0].roundMs?.count).toBe(3)
  })

  it('takes no figure from a round over before the window began or sent after it', () => {
    const rounds = [
      round('a0', 7_000, 7_050, 30, 9_500),
      round('a1', 10_100, 10_150, 40, 12_000),
      round('a2', 20_000, 20_050, 35, 22_000)
    ]
    const turns = [
      turn('m:a', 7_100, 8_700),
      turn('m:a', 10_200, 11_800),
      turn('m:a', 20_100, 21_700)
    ]
    const { threads } = summarise({ threads: [{ ...SERIAL, rounds }], turns })
    expect(threads[0].rounds).toMatchObject({ sent: 1, ran: 1, completed: 1 })
    expect(threads[0].sendToAcceptedMs).toEqual({
      count: 1,
      minMs: 40,
      p50Ms: 40,
      p95Ms: 40,
      maxMs: 40
    })
    expect(threads[0].roundMs).toMatchObject({ count: 1, minMs: 1_900 })
  })

  it('counts a turn still streaming when its round ended up to that end', () => {
    const rounds = [round('a1', 10_000, 10_010, 5, 12_000)]
    const turns = [turn('m:a', 10_500, null)]
    const { threads } = summarise({ threads: [{ ...SERIAL, rounds }], turns })
    // 2,000 ms of round, 1,500 of them streaming, one turn.
    expect(threads[0].turnSpacing.appMsPerTurn).toMatchObject({ count: 1, minMs: 500 })
    expect(threads[0].turnSpacing.modelTurnMs).toBeNull()
  })

  it('counts a turn the daemon closed after its round was seen to end up to that end', () => {
    // A cancelled round: the daemon notices the abandoned stream a moment later.
    const rounds = [round('a1', 10_000, 10_010, 5, 12_000, 'cancelled')]
    const turns = [turn('m:a', 10_500, 12_300, 'aborted')]
    const { threads } = summarise({ threads: [{ ...SERIAL, rounds }], turns })
    expect(threads[0].turnSpacing.appMsPerTurn).toMatchObject({ count: 1, minMs: 500 })
  })

  it('counts a turn that began as the one before ended as a gap of nothing', () => {
    const rounds = [round('a1', 10_000, 10_010, 5, 14_000)]
    const turns = [turn('m:a', 11_000, 12_000), turn('m:a', 12_000, 13_000)]
    const { threads } = summarise({ threads: [{ ...SERIAL, rounds }], turns })
    expect(threads[0].turnSpacing.betweenTurnsMs).toMatchObject({ count: 1, minMs: 0, maxMs: 0 })
    expect(threads[0].turnSpacing.overlapped).toBe(0)
  })

  it('counts a turn that began while the one before still streamed as overlapped', () => {
    const rounds = [round('a1', 10_000, 10_010, 5, 14_000)]
    const turns = [turn('m:a', 10_500, null), turn('m:a', 10_600, 12_000)]
    const { threads } = summarise({ threads: [{ ...SERIAL, rounds }], turns })
    expect(threads[0].turnSpacing.betweenTurnsMs).toBeNull()
    expect(threads[0].turnSpacing.overlapped).toBe(1)
  })

  it('does not take a round with no end for one that ended, in a window from the epoch', () => {
    const rounds = [round('a1', 100, 110, 5, null)]
    const { threads } = summarise({
      window: { startedAtMs: 0, endedAtMs: 10_000 },
      threads: [{ ...SERIAL, rounds }],
      turns: []
    })
    expect(threads[0].rounds).toEqual({
      sent: 1,
      ran: 1,
      completed: 0,
      endedOther: {},
      unended: 1,
      withoutTurn: 1
    })
  })

  it('takes the daemon’s turns in any order', () => {
    const shuffled = [...PARALLEL_TURNS, ...SERIAL_TURNS].reverse()
    expect(summarise({ turns: shuffled })).toEqual(summarise())
  })

  it('names each thread by its place, chat, tag and failure', () => {
    const { threads } = summarise({
      threads: [SERIAL, { ...PARALLEL, failure: 'unobserved' }]
    })
    expect(
      threads.map(({ thread, chatId, model, failure }) => [thread, chatId, model, failure])
    ).toEqual([
      [1, 'chat-a', 'm:a', null],
      [2, 'chat-b', 'm:b', 'unobserved']
    ])
  })
})

describe('all threads together', () => {
  it('pools every thread’s rounds, turns and timings', () => {
    const { overall } = summarise()
    expect(overall.rounds).toEqual({
      sent: 4,
      ran: 5,
      completed: 3,
      endedOther: {},
      unended: 1,
      withoutTurn: 0
    })
    expect(overall.turns).toEqual({ started: 8, done: 7, notDone: { streaming: 1 } })
    expect(overall.sendToAcceptedMs).toEqual({
      count: 5,
      minMs: 12,
      p50Ms: 40,
      p95Ms: 50,
      maxMs: 50
    })
    expect(overall.acceptedToFirstTurnMs).toMatchObject({ count: 5, minMs: 30, maxMs: 80 })
    expect(overall.turnSpacing.startToStartMs).toMatchObject({ count: 4, minMs: 10, maxMs: 2_000 })
    expect(overall.turnSpacing.betweenTurnsMs).toMatchObject({ count: 3, minMs: 200 })
    expect(overall.turnSpacing.overlapped).toBe(1)
    expect(overall.turnSpacing.appMsPerTurn).toMatchObject({ count: 4, minMs: 145, maxMs: 400 })
    expect(overall.turnSpacing.modelTurnMs).toMatchObject({ count: 7, minMs: 1_600, maxMs: 1_600 })
    expect(overall.roundMs).toMatchObject({ count: 4, minMs: 1_900, maxMs: 5_950 })
    // What two threads share is added up, not replaced.
    const both = summarise({
      threads: [
        { ...SERIAL, rounds: [round('a1', 10_100, 10_150, 40, 11_000, 'failed')] },
        { ...PARALLEL, rounds: [round('b1', 10_100, 10_150, 40, 11_000, 'failed')] }
      ],
      turns: [turn('m:a', 10_200, null), turn('m:b', 10_200, null)]
    }).overall
    expect(both.rounds.endedOther).toEqual({ failed: 2 })
    expect(both.turns.notDone).toEqual({ streaming: 2 })
    expect(overall.threadsFailed).toBe(0)
    expect(
      summarise({ threads: [SERIAL, { ...PARALLEL, failure: 'steered' }] }).overall
    ).toMatchObject({ threadsFailed: 1 })
  })

  it('says how many agents ran at once against how many were asked for', () => {
    const { overall, asked, window } = summarise()
    expect(window).toEqual({ startedAtMs: 10_000, endedAtMs: 20_000, lengthMs: 10_000 })
    expect(asked).toEqual({ threads: 2, seats: 3, agents: 6, seatMode: 'serial', atOnce: 2 })
    // Three at once from 11,200 to 12,200; 18,800 ms of streaming in a
    // 10,000 ms window; some turn streaming throughout.
    expect(overall.runningAtOnce).toEqual({ asked: 2, max: 3, mean: 1.88, noneMs: 0 })
  })

  it('asks for every seat at once when a thread’s seats run in parallel', () => {
    const { asked, overall } = summarise({ seatMode: 'parallel' })
    expect(asked).toEqual({ threads: 2, seats: 3, agents: 6, seatMode: 'parallel', atOnce: 6 })
    expect(overall.runningAtOnce.asked).toBe(6)
  })

  it('measures running at once inside the window only', () => {
    const threads = [{ ...SERIAL, rounds: [] }]
    const turns = [
      // Over before the window began.
      turn('m:a', 2_000, 4_000),
      // Streaming before the window and into it, and from inside it past its end.
      turn('m:a', 5_000, 12_000),
      turn('m:a', 18_000, 30_000),
      // Still streaming at the read: counted to the window's end.
      turn('m:a', 19_000, null),
      // Begun once the window was over, as a round still draining does.
      turn('m:a', 20_000, 21_000),
      turn('m:a', 25_000, null)
    ]
    const { overall } = summarise({ threads, turns })
    expect(overall.runningAtOnce).toEqual({ asked: 1, max: 2, mean: 0.5, noneMs: 6_000 })
  })

  it('does not count two turns as together when one ended as the other began', () => {
    const threads = [{ ...SERIAL, rounds: [] }]
    const turns = [turn('m:a', 11_000, 12_000), turn('m:a', 12_000, 13_000)]
    expect(summarise({ threads, turns }).overall.runningAtOnce).toMatchObject({ max: 1 })
  })

  it('counts turns of no thread’s tag apart, and leaves them out of every measure', () => {
    const { overall } = summarise({
      turns: [...SERIAL_TURNS, turn('m:other', 11_000, 19_000), turn('m:other', 11_000, 19_000)]
    })
    expect(overall.otherTurns).toBe(2)
    expect(overall.turns.started).toBe(5)
    expect(overall.runningAtOnce.max).toBe(1)
  })

  it('reports an idle window as nothing running', () => {
    const { overall, threads } = summarise({ threads: [{ ...SERIAL, rounds: [] }], turns: [] })
    expect(overall.runningAtOnce).toEqual({ asked: 1, max: 0, mean: 0, noneMs: 10_000 })
    expect(overall.sendToAcceptedMs).toBeNull()
    expect(threads[0].turnSpacing).toEqual({
      modelTurnMs: null,
      startToStartMs: null,
      betweenTurnsMs: null,
      overlapped: 0,
      appMsPerTurn: null
    })
  })
})

describe('how many agents a shape asks for', () => {
  it('asks for one seat of each thread at a time when seats run one after another', () => {
    expect(metrics.agentsAsked({ threads: 20, seats: 10, seatMode: 'serial' })).toEqual({
      threads: 20,
      seats: 10,
      agents: 200,
      seatMode: 'serial',
      atOnce: 20
    })
  })

  it('asks for every seat at once when they run together', () => {
    expect(metrics.agentsAsked({ threads: 20, seats: 10, seatMode: 'parallel' })).toEqual({
      threads: 20,
      seats: 10,
      agents: 200,
      seatMode: 'parallel',
      atOnce: 200
    })
  })

  it.each([
    ['threads', { threads: 0 }],
    ['threads', { threads: 1.5 }],
    ['seats', { seats: 0 }],
    ['seats', { seats: '2' }],
    ['seatMode', { seatMode: 'off' }]
  ])('refuses a bad %s', (name, extra) => {
    expect(() =>
      metrics.agentsAsked({ threads: 2, seats: 2, seatMode: 'serial', ...extra })
    ).toThrow(name)
  })
})

describe('what it refuses', () => {
  const WINDOW_MESSAGE = 'window must have a start before its end'
  const THREADS_MESSAGE = 'threads must each have a chat, a model tag of their own and their rounds'
  it.each([
    [WINDOW_MESSAGE, { window: { startedAtMs: 5, endedAtMs: 5 } }],
    [WINDOW_MESSAGE, { window: null }],
    [WINDOW_MESSAGE, { window: { startedAtMs: '5', endedAtMs: 10 } }],
    [WINDOW_MESSAGE, { window: { startedAtMs: 5, endedAtMs: '10' } }],
    ['threads must be a positive integer', { threads: [] }],
    [THREADS_MESSAGE, { threads: null }],
    [THREADS_MESSAGE, { threads: [null] }],
    [THREADS_MESSAGE, { threads: [{ ...SERIAL, chatId: 7 }] }],
    [THREADS_MESSAGE, { threads: [{ ...SERIAL, model: 7 }] }],
    [THREADS_MESSAGE, { threads: [{ ...SERIAL, model: '' }] }],
    [THREADS_MESSAGE, { threads: [SERIAL, { ...PARALLEL, model: 'm:a' }] }],
    [THREADS_MESSAGE, { threads: [{ ...SERIAL, rounds: null }] }],
    ['turns must be the daemon’s list', { turns: null }],
    ['seats must be a positive integer', { seats: 0 }],
    ['seatMode must be serial or parallel', { seatMode: 'both' }],
    ['configuredTurnMs must be positive', { configuredTurnMs: 0 }],
    ['configuredTurnMs must be positive', { configuredTurnMs: Number.NaN }],
    ['configuredTurnMs must be positive', { configuredTurnMs: '1600' }]
  ])('refuses with “%s”', (message, extra) => {
    expect(() => summarise(extra)).toThrow(new Error(message))
  })

  it('refuses no input at all the same way', () => {
    expect(() => metrics.summariseManyAgents(null)).toThrow(new Error(WINDOW_MESSAGE))
  })
})

describe('waiting, with its cause', () => {
  const span = (kind: string, resource: string, durationMs: number, reason?: string) => ({
    kind,
    resource,
    startedAt: 11_000,
    durationMs,
    ...(reason === undefined ? {} : { reason })
  })
  const admission = (metrics: Record<string, number>, occupancy: Record<string, unknown> = {}) => ({
    occupancy: {
      maxActive: 30,
      maxForeground: 24,
      maxQueued: 256,
      active: 0,
      queued: 0,
      shuttingDown: false,
      ...occupancy
    },
    metrics: {
      requests: 0,
      reservations: 0,
      initiallyQueued: 0,
      admitted: 0,
      cancelledQueued: 0,
      overflowRejected: 0,
      admittedQueueWaitMs: 0,
      maxAdmittedQueueWaitMs: 0,
      peakActive: 0,
      peakQueued: 0,
      ...metrics
    }
  })

  it('reports the pool’s limits and what queued behind them in the window', () => {
    const waiting = metrics.summariseAgentWaiting({
      spansByThread: [[], []],
      admissionBefore: admission({
        requests: 10,
        reservations: 10,
        admitted: 10,
        initiallyQueued: 1,
        admittedQueueWaitMs: 40,
        peakActive: 4,
        peakQueued: 1
      }),
      admissionAtEnd: admission(
        {
          requests: 210,
          reservations: 208,
          admitted: 200,
          initiallyQueued: 171,
          admittedQueueWaitMs: 90_040,
          overflowRejected: 2,
          cancelledQueued: 1,
          maxAdmittedQueueWaitMs: 2_500,
          peakActive: 30,
          peakQueued: 170
        },
        { active: 30, queued: 8 }
      )
    })
    expect(waiting.limits).toEqual({ maxActive: 30, maxForeground: 24, maxQueued: 256 })
    expect(waiting.pool).toEqual({
      cause: 'ensemble_pool',
      requests: 200,
      reservations: 198,
      admitted: 190,
      queued: 170,
      queueWaitMs: 90_000,
      overflowRejected: 2,
      cancelledQueued: 1,
      activeAtEnd: 30,
      queuedAtEnd: 8,
      sinceLaunch: { peakActive: 30, peakQueued: 170, maxQueueWaitMs: 2_500 }
    })
    expect(waiting.limited).toBe(true)
  })

  it('says nothing was held back when no run queued', () => {
    const waiting = metrics.summariseAgentWaiting({
      spansByThread: [[]],
      admissionBefore: admission({ requests: 4, admitted: 4 }),
      admissionAtEnd: admission({ requests: 24, admitted: 24, peakActive: 6 })
    })
    expect(waiting.pool).toMatchObject({ requests: 20, queued: 0, queueWaitMs: 0 })
    expect(waiting.limited).toBe(false)
  })

  it('is limited by a queued run alone', () => {
    const waiting = metrics.summariseAgentWaiting({
      spansByThread: [[]],
      admissionBefore: admission({}),
      admissionAtEnd: admission({ initiallyQueued: 1 })
    })
    expect(waiting.pool).toMatchObject({ queued: 1, overflowRejected: 0 })
    expect(waiting.limited).toBe(true)
  })

  it('is limited by a rejected run alone', () => {
    const waiting = metrics.summariseAgentWaiting({
      spansByThread: [[]],
      admissionBefore: admission({}),
      admissionAtEnd: admission({ overflowRejected: 1 })
    })
    expect(waiting.limited).toBe(true)
  })

  it('has no pool figures without both admission reads, and says so', () => {
    for (const [before, atEnd] of [
      [null, admission({})],
      [admission({}), null],
      [admission({}), { occupancy: {}, metrics: {} }],
      // One part missing, or one figure of either part not a number.
      [admission({}), { occupancy: admission({}).occupancy }],
      [admission({}), { metrics: admission({}).metrics }],
      [admission({}, { maxQueued: undefined }), admission({})],
      [admission({}, { active: undefined }), admission({})],
      [admission({}, { queued: '0' }), admission({})],
      [admission({ requests: 'many' as unknown as number }), admission({})],
      [admission({ peakQueued: Number.NaN }), admission({})]
    ]) {
      const waiting = metrics.summariseAgentWaiting({
        spansByThread: [[]],
        admissionBefore: before,
        admissionAtEnd: atEnd
      })
      expect(waiting.pool).toBeNull()
      expect(waiting.limits).toBeNull()
      expect(waiting.limited).toBeNull()
    }
  })

  it('groups each thread’s waits by what was waited on', () => {
    const waiting = metrics.summariseAgentWaiting({
      spansByThread: [
        [
          span('admission_wait', 'ensemble_pool', 0, 'admitted'),
          span('admission_wait', 'ensemble_pool', 1_200, 'admitted'),
          span('admission_wait', 'ensemble_pool', 300, 'cancelled'),
          span('admission_wait', 'ollama_model', 50),
          span('prompt_build', 'none', 9),
          span('host_queue_wait', 'host_chain', 20)
        ],
        [span('admission_wait', 'ensemble_pool', 700, 'admitted')],
        // A thread whose spans could not be read.
        null
      ],
      admissionBefore: null,
      admissionAtEnd: null
    })
    expect(waiting.threads).toEqual([
      [
        {
          kind: 'admission_wait',
          resource: 'ensemble_pool',
          count: 3,
          waited: 2,
          totalMs: 1_500,
          p50Ms: 300,
          p95Ms: 1_200,
          maxMs: 1_200,
          reasons: { admitted: 2, cancelled: 1 }
        },
        {
          kind: 'admission_wait',
          resource: 'ollama_model',
          count: 1,
          waited: 1,
          totalMs: 50,
          p50Ms: 50,
          p95Ms: 50,
          maxMs: 50,
          reasons: {}
        },
        {
          kind: 'host_queue_wait',
          resource: 'host_chain',
          count: 1,
          waited: 1,
          totalMs: 20,
          p50Ms: 20,
          p95Ms: 20,
          maxMs: 20,
          reasons: {}
        }
      ],
      [
        {
          kind: 'admission_wait',
          resource: 'ensemble_pool',
          count: 1,
          waited: 1,
          totalMs: 700,
          p50Ms: 700,
          p95Ms: 700,
          maxMs: 700,
          reasons: { admitted: 1 }
        }
      ],
      null
    ])
    // And over every thread that was read.
    expect(waiting.waits).toEqual([
      {
        kind: 'admission_wait',
        resource: 'ensemble_pool',
        count: 4,
        waited: 3,
        totalMs: 2_200,
        p50Ms: 300,
        p95Ms: 1_200,
        maxMs: 1_200,
        reasons: { admitted: 3, cancelled: 1 }
      },
      expect.objectContaining({ kind: 'admission_wait', resource: 'ollama_model', count: 1 }),
      expect.objectContaining({ kind: 'host_queue_wait', resource: 'host_chain', count: 1 })
    ])
    expect(waiting.threadsUnread).toBe(1)
  })

  it('refuses spans that are not one list per thread, and no input at all', () => {
    const refusal = new Error('spansByThread must be one list per thread')
    expect(() =>
      metrics.summariseAgentWaiting({
        spansByThread: null,
        admissionBefore: null,
        admissionAtEnd: null
      })
    ).toThrow(refusal)
    expect(() => metrics.summariseAgentWaiting(null)).toThrow(refusal)
  })
})
