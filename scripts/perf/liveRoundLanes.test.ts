import { createRequire } from 'module'
import vm from 'node:vm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)

type Round = {
  roundId: string
  sentAtMs: number
  acceptedAtMs: number
  pageMs: number | null
  endedAtMs: number | null
  status: string | null
  control?: Record<string, unknown>
}
type Report = {
  observer: {
    installId: string | null
    faults: number
    otherSource: { light: number; heavy: number }
    failure: string | null
  }
  heavy: { rounds: Round[]; idle: Array<{ fromMs: number; toMs: number }>; failure: string | null }
  light: { rounds: Round[]; failure: string | null }
}
type Lanes = {
  install: () => Promise<void>
  startHeavy: () => Promise<void>
  runLight: (options: {
    untilMs: number
  }) => Promise<{ rounds: Round[]; failure: string | null; drainedAtMs: number | null }>
  snapshot: () => Report
  stop: () => Promise<Report>
}

const lanesModule = require('./liveRoundLanes.cjs') as {
  cancelRoundExpression: (chatId: string) => string
  createLiveLanes: (options: Record<string, unknown>) => Lanes
  sendRoundExpression: (chatId: string, prompt: string) => string
}
const { LANE_OBSERVER_GLOBAL } = require('./liveLaneObserver.cjs') as {
  LANE_OBSERVER_GLOBAL: string
}

const LIGHT = 'perf-light_beside_large_live-chat-01'
const HEAVY = 'perf-light_beside_large_live-chat-02'
const T0 = Date.parse('2026-09-24T12:00:00.000Z')

type Listener = (payload: unknown) => void
type AppOptions = {
  lightMs?: number
  heavyMs?: number
  acceptMs?: number
  /** Lanes whose round end the app never broadcasts. */
  silentEnds?: Array<'light' | 'heavy'>
  /** Lanes whose round start the app never broadcasts. */
  silentStarts?: Array<'light' | 'heavy'>
  /** A lane whose sends never answer. */
  hangingSends?: 'light' | 'heavy'
  /** A lane whose second send answers `started` with the first round's id. */
  repeatRoundId?: 'light' | 'heavy'
}

/**
 * The page and a scripted main: runEnsembleRound starts a round (or answers
 * `steered` when the chat already has one, as main absorbs a live steer),
 * broadcasts it running, and ends it after the lane's duration; a cancel ends
 * it as cancelled. The light chat's changes arrive as chat-updated patches,
 * the heavy chat's as compact invalidations, as for a selected and an
 * unselected chat.
 */
function fakeApp(options: AppOptions = {}) {
  const lightMs = options.lightMs ?? 300
  const heavyMs = options.heavyMs ?? 1_000
  const acceptMs = options.acceptMs ?? 20
  const listeners = { delivery: [] as Listener[], invalidation: [] as Listener[] }
  const active = new Map<string, string | null>()
  const counters = new Map<string, number>()
  const endTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const sends: Array<{ lane: string; atMs: number; prompt: string }> = []
  let steered = 0
  let evaluations = 0
  const laneOf = (chatId: string) => (chatId === LIGHT ? 'light' : 'heavy')
  const emit = (chatId: string, roundId: string, status: string) => {
    const ensemble = { activeRound: { roundId, status } }
    if (chatId === LIGHT) {
      for (const listener of [...listeners.delivery]) {
        listener({
          protocolVersion: 2,
          kind: 'patch',
          chatId,
          baseRevision: 1,
          revision: 2,
          recordMask: ['ensemble'],
          recordDelta: { ensemble }
        })
      }
    } else {
      for (const listener of [...listeners.invalidation]) {
        listener({
          protocolVersion: 1,
          kind: 'invalidation',
          chatId,
          revision: 3,
          summary: { appChatId: chatId, summaryOnly: true, ensemble }
        })
      }
    }
  }
  const end = (chatId: string, roundId: string, status: string) => {
    if (active.get(chatId) !== roundId) return
    active.set(chatId, null)
    if (!options.silentEnds?.includes(laneOf(chatId))) emit(chatId, roundId, status)
  }
  const start = (chatId: string): string => {
    const index = (counters.get(chatId) ?? 0) + 1
    counters.set(chatId, index)
    const roundId = `${laneOf(chatId)}-${index}`
    active.set(chatId, roundId)
    if (!options.silentStarts?.includes(laneOf(chatId))) {
      setTimeout(() => emit(chatId, roundId, 'running'), 5)
    }
    endTimers.set(
      roundId,
      setTimeout(() => end(chatId, roundId, 'completed'), chatId === LIGHT ? lightMs : heavyMs)
    )
    return roundId
  }
  const subscribe = (channel: 'delivery' | 'invalidation') => (callback: Listener) => {
    listeners[channel].push(callback)
    return () => {
      listeners[channel] = listeners[channel].filter((listener) => listener !== callback)
    }
  }
  const window: Record<string, unknown> = {
    api: {
      onChatUpdated: subscribe('delivery'),
      onChatUpdateInvalidated: subscribe('invalidation'),
      runEnsembleRound: (payload: { chatId: string; prompt: string }) =>
        new Promise((resolve) => {
          const lane = laneOf(payload.chatId)
          sends.push({ lane, atMs: Date.now(), prompt: payload.prompt })
          if (options.hangingSends === lane) return
          const current = active.get(payload.chatId)
          if (current) {
            steered += 1
            setTimeout(() => resolve({ status: 'steered', roundId: current }), acceptMs)
            return
          }
          if (options.repeatRoundId === lane && (counters.get(payload.chatId) ?? 0) === 1) {
            setTimeout(() => resolve({ status: 'started', roundId: `${lane}-1` }), acceptMs)
            return
          }
          const roundId = start(payload.chatId)
          setTimeout(
            () => resolve({ status: 'started', roundId, prompt: 'secret reply text' }),
            acceptMs
          )
        }),
      cancelEnsembleRound: (chatId: string) =>
        new Promise((resolve) => {
          const roundId = active.get(chatId)
          if (!roundId) {
            setTimeout(() => resolve(false), 5)
            return
          }
          clearTimeout(endTimers.get(roundId))
          setTimeout(() => end(chatId, roundId, 'cancelled'), 30)
          setTimeout(() => resolve(true), 10)
        })
    }
  }
  const context = vm.createContext({
    window,
    Date: { now: () => Date.now() },
    performance: { now: () => Date.now() }
  })
  return {
    window,
    sends,
    get steered() {
      return steered
    },
    get evaluations() {
      return evaluations
    },
    /** A round the harness did not start, as a user's own send would be. */
    startExternally: (chatId: string) => start(chatId),
    page: {
      evaluate: (expression: string) => {
        evaluations += 1
        return Promise.resolve(vm.runInContext(expression, context))
      }
    }
  }
}

function lanesFor(app: ReturnType<typeof fakeApp>, options: Record<string, unknown> = {}) {
  return lanesModule.createLiveLanes({
    page: app.page,
    lightChatId: LIGHT,
    heavyChatId: HEAVY,
    pollMs: 50,
    lightGapMs: 100,
    ...options
  })
}

/** Advance the fake clock until `promise` settles. */
async function drive<T>(promise: Promise<T>, maxMs = 120_000): Promise<T> {
  let settled = false
  let failed = false
  let value: T | undefined
  let error: unknown
  promise.then(
    (result) => {
      settled = true
      value = result
    },
    (reason) => {
      settled = true
      failed = true
      error = reason
    }
  )
  for (let elapsed = 0; !settled && elapsed < maxMs; elapsed += 10) {
    await vi.advanceTimersByTimeAsync(10)
  }
  if (!settled) throw new Error(`did not settle within ${maxMs} ms`)
  if (failed) throw error
  return value as T
}

async function started(app: ReturnType<typeof fakeApp>, options: Record<string, unknown> = {}) {
  const lanes = lanesFor(app, options)
  await drive(lanes.install())
  await drive(lanes.startHeavy())
  return lanes
}

beforeEach(() => {
  vi.useFakeTimers({ now: T0 })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('the heavy lane', () => {
  it('keeps a round streaming, sending the next as soon as it sees one end', async () => {
    const app = fakeApp({ heavyMs: 1_000 })
    const lanes = await started(app)
    await vi.advanceTimersByTimeAsync(3_500)
    const report = await drive(lanes.stop())
    const { rounds, idle, failure } = report.heavy
    expect(failure).toBeNull()
    expect(rounds.length).toBeGreaterThanOrEqual(4)
    expect(rounds.slice(0, -1).every((round) => round.status === 'completed')).toBe(true)
    // Never two at once, and each idle gap is one observation plus one send.
    for (let index = 1; index < rounds.length; index += 1) {
      expect(rounds[index].sentAtMs).toBeGreaterThanOrEqual(rounds[index - 1].endedAtMs!)
      expect(idle[index - 1]).toEqual({
        fromMs: rounds[index - 1].endedAtMs,
        toMs: rounds[index].acceptedAtMs
      })
      expect(idle[index - 1].toMs - idle[index - 1].fromMs).toBeLessThanOrEqual(100)
    }
    expect(idle).toHaveLength(rounds.length - 1)
    expect(app.steered).toBe(0)
    expect(app.sends.every((send) => send.lane === 'heavy')).toBe(true)
  })

  it('stops, without a probe, when it never sees its round end', async () => {
    const app = fakeApp({ silentEnds: ['heavy'] })
    const lanes = await started(app, { heavyRoundTimeoutMs: 2_000 })
    await vi.advanceTimersByTimeAsync(10_000)
    const report = await drive(lanes.stop())
    expect(report.heavy.failure).toBe('heavy_unobserved')
    expect(app.sends).toHaveLength(1)
  })

  it('refuses to start when its first round is never seen', async () => {
    const app = fakeApp({ silentStarts: ['heavy'], silentEnds: ['heavy'] })
    const lanes = lanesFor(app, { heavyStartTimeoutMs: 1_000 })
    await drive(lanes.install())
    await expect(drive(lanes.startHeavy())).rejects.toMatchObject({
      code: 'T2_LIVE_LANE_HEAVY',
      reason: 'unobserved'
    })
    await drive(lanes.stop())
  })
})

describe('the light lane', () => {
  it('sends one round at a time until the window ends, then drains the last', async () => {
    const app = fakeApp({ lightMs: 300, heavyMs: 60_000 })
    const lanes = await started(app)
    const untilMs = Date.now() + 2_000
    const run = await drive(lanes.runLight({ untilMs }))
    expect(run.failure).toBeNull()
    expect(run.rounds.length).toBeGreaterThanOrEqual(3)
    expect(run.rounds.every((round) => round.status === 'completed')).toBe(true)
    expect(run.rounds.every((round) => round.sentAtMs < untilMs)).toBe(true)
    for (let index = 1; index < run.rounds.length; index += 1) {
      // Each after the one before ended, plus the gap.
      expect(run.rounds[index].sentAtMs).toBeGreaterThanOrEqual(
        run.rounds[index - 1].endedAtMs! + 100
      )
    }
    expect(run.drainedAtMs).toBe(run.rounds[run.rounds.length - 1].endedAtMs)
    expect(run.drainedAtMs).toBeGreaterThanOrEqual(untilMs - 400)
    expect(app.steered).toBe(0)
    // A later window picks up where this one stopped.
    const next = await drive(lanes.runLight({ untilMs: Date.now() + 500 }))
    expect(next.rounds[0].roundId).toBe(`light-${run.rounds.length + 1}`)
    await drive(lanes.stop())
  })

  it('waits out a round still running when the window ends', async () => {
    const app = fakeApp({ lightMs: 1_000, heavyMs: 60_000 })
    const lanes = await started(app)
    const untilMs = Date.now() + 10
    const run = await drive(lanes.runLight({ untilMs }))
    expect(run.rounds).toHaveLength(1)
    expect(run.rounds[0]).toMatchObject({ status: 'completed' })
    expect(run.rounds[0].acceptedAtMs).toBeGreaterThan(untilMs)
    expect(run.drainedAtMs).toBe(run.rounds[0].endedAtMs)
    expect(run.drainedAtMs).toBeGreaterThanOrEqual(run.rounds[0].sentAtMs + 1_000)
    await drive(lanes.stop())
  })

  it('cancels every Nth round at its offset after acceptance, timed from the page', async () => {
    const app = fakeApp({ lightMs: 1_000, heavyMs: 60_000 })
    const lanes = await started(app, { cancelEvery: 2, cancelAfterMs: 100 })
    const run = await drive(lanes.runLight({ untilMs: Date.now() + 3_000 }))
    expect(run.failure).toBeNull()
    const [first, second, third] = run.rounds
    expect(first).toMatchObject({ status: 'completed' })
    expect(first.control).toBeUndefined()
    expect(second).toMatchObject({ status: 'cancelled' })
    expect(second.control).toEqual({
      action: 'cancel',
      dueAtMs: second.acceptedAtMs + 100,
      sentAtMs: expect.any(Number),
      returnedAtMs: expect.any(Number),
      ok: true,
      cancelled: true,
      pageMs: 10
    })
    expect(second.control?.sentAtMs).toBeGreaterThanOrEqual(second.acceptedAtMs + 100)
    expect(third).toMatchObject({ status: 'completed' })
    await drive(lanes.stop())
  })

  it('skips a cancel whose round ended before it was due', async () => {
    const app = fakeApp({ lightMs: 100, heavyMs: 60_000 })
    const lanes = await started(app, { cancelEvery: 1, cancelAfterMs: 500 })
    const run = await drive(lanes.runLight({ untilMs: Date.now() + 100 }))
    expect(run.rounds[0]).toMatchObject({
      status: 'completed',
      control: { action: 'cancel', skipped: 'round_ended' }
    })
    await drive(lanes.stop())
  })

  it('never sends while the observer shows a round it did not see end', async () => {
    const app = fakeApp({ heavyMs: 60_000 })
    const lanes = await started(app)
    app.startExternally(LIGHT)
    await vi.advanceTimersByTimeAsync(200)
    const run = await drive(lanes.runLight({ untilMs: Date.now() + 1_000 }))
    expect(run).toEqual({ rounds: [], failure: 'light_busy_before_send', drainedAtMs: null })
    expect(app.sends.filter((send) => send.lane === 'light')).toEqual([])
    await drive(lanes.stop())
  })

  it('stops on a steered answer and never sends again', async () => {
    // A round the observer has not yet heard about: main absorbs the send.
    const app = fakeApp({ heavyMs: 60_000, silentStarts: ['light'] })
    const lanes = await started(app)
    app.startExternally(LIGHT)
    const run = await drive(lanes.runLight({ untilMs: Date.now() + 1_000 }))
    expect(run.failure).toBe('light_steered')
    expect(app.steered).toBe(1)
    expect(app.sends.filter((send) => send.lane === 'light')).toHaveLength(1)
    await drive(lanes.stop())
  })

  it('stops when it never sees its round end', async () => {
    const app = fakeApp({ heavyMs: 60_000, silentEnds: ['light'] })
    const lanes = await started(app, { lightRoundTimeoutMs: 1_000 })
    const run = await drive(lanes.runLight({ untilMs: Date.now() + 5_000 }))
    expect(run.failure).toBe('light_unobserved')
    expect(run.rounds).toHaveLength(1)
    expect(app.sends.filter((send) => send.lane === 'light')).toHaveLength(1)
    await drive(lanes.stop())
  })

  it('refuses a round id main already gave it', async () => {
    const app = fakeApp({ lightMs: 100, heavyMs: 60_000, repeatRoundId: 'light' })
    const lanes = await started(app)
    const run = await drive(lanes.runLight({ untilMs: Date.now() + 2_000 }))
    expect(run.failure).toBe('light_not_started')
    expect(run.rounds.map((round) => round.roundId)).toEqual(['light-1'])
    await drive(lanes.stop())
  })

  it('bounds a send that never answers', async () => {
    const app = fakeApp({ heavyMs: 60_000, hangingSends: 'light' })
    const lanes = await started(app, { callTimeoutMs: 1_000 })
    const run = await drive(lanes.runLight({ untilMs: Date.now() + 5_000 }))
    expect(run).toEqual({ rounds: [], failure: 'light_send_failed', drainedAtMs: null })
    await drive(lanes.stop())
  })
})

describe('the lanes together', () => {
  it('fails both lanes when the page loses its observer, as on a reload', async () => {
    const app = fakeApp({ heavyMs: 60_000 })
    const lanes = await started(app)
    delete app.window[LANE_OBSERVER_GLOBAL]
    await vi.advanceTimersByTimeAsync(200)
    const run = await drive(lanes.runLight({ untilMs: Date.now() + 1_000 }))
    expect(run.failure).toBe('observer_not_installed')
    const report = await drive(lanes.stop())
    expect(report.heavy.failure).toBe('observer_not_installed')
    expect(report.observer.failure).toBe('observer_not_installed')
  })

  it('fails both lanes when the observer lost transitions between two reads', async () => {
    const app = fakeApp({ lightMs: 1, heavyMs: 60_000 })
    const lanes = await started(app, { pollMs: 5_000 })
    // More light rounds than the observer keeps, all between two reads.
    for (let index = 0; index < 40; index += 1) {
      app.startExternally(LIGHT)
      await vi.advanceTimersByTimeAsync(10)
    }
    await vi.advanceTimersByTimeAsync(5_000)
    const report = await drive(lanes.stop())
    expect(report.observer.failure).toBe('observer_light_transitions_lost')
    expect(report.heavy.failure).toBe('observer_light_transitions_lost')
  })

  it('refuses a page that already carries an observer', async () => {
    const app = fakeApp()
    await drive(lanesFor(app).install())
    await expect(drive(lanesFor(app).install())).rejects.toMatchObject({
      code: 'T2_LIVE_LANE_OBSERVER',
      reason: 'already_installed'
    })
  })

  it('makes no page call once stopped', async () => {
    const app = fakeApp({ heavyMs: 500 })
    const lanes = await started(app)
    await vi.advanceTimersByTimeAsync(1_000)
    const report = await drive(lanes.stop())
    const calls = app.evaluations
    await vi.advanceTimersByTimeAsync(10_000)
    expect(app.evaluations).toBe(calls)
    expect(report.heavy.failure).toBeNull()
    expect(report.observer).toMatchObject({ failure: null, faults: 0 })
  })

  it('keeps every reply to its status, round id and page time', async () => {
    const app = fakeApp({ lightMs: 100, heavyMs: 60_000 })
    const lanes = await started(app)
    await drive(lanes.runLight({ untilMs: Date.now() + 100 }))
    const report = await drive(lanes.stop())
    expect(JSON.stringify(report)).not.toContain('secret')
    expect(Object.keys(report.light.rounds[0]).sort()).toEqual(
      ['acceptedAtMs', 'endedAtMs', 'pageMs', 'roundId', 'sentAtMs', 'status'].sort()
    )
    expect(app.sends.map((send) => send.prompt)).toEqual([
      'M1 live lane heavy round 1: answer briefly.',
      'M1 live lane light round 1: answer briefly.'
    ])
  })

  it.each([
    ['pollMs', { pollMs: 0 }],
    ['callTimeoutMs', { callTimeoutMs: -1 }],
    ['lightGapMs', { lightGapMs: Number.NaN }],
    ['cancelEvery', { cancelEvery: 1.5 }],
    ['cancelAfterMs', { cancelAfterMs: 0 }]
  ])('refuses a bad %s', (name, options) => {
    expect(() => lanesFor(fakeApp(), options)).toThrow(name)
  })

  it('refuses one chat on both lanes', () => {
    expect(() =>
      lanesModule.createLiveLanes({ page: fakeApp().page, lightChatId: LIGHT, heavyChatId: LIGHT })
    ).toThrow(/distinct/)
  })
})

describe('the page expressions', () => {
  const run = (expression: string, api: Record<string, unknown>) =>
    vm.runInNewContext(expression, {
      window: { api },
      performance: {
        now: (() => {
          let now = 0
          return () => (now += 7)
        })()
      }
    }) as Promise<unknown>

  it('reduce a send to its status, round id and duration', async () => {
    vi.useRealTimers()
    const reply = await run(lanesModule.sendRoundExpression(LIGHT, 'hello'), {
      runEnsembleRound: async (payload: unknown) => ({
        status: 'started',
        roundId: 'r-1',
        echo: payload,
        transcript: 'secret'
      })
    })
    expect(reply).toEqual({ status: 'started', roundId: 'r-1', pageMs: 7 })
    expect(
      await run(lanesModule.sendRoundExpression(LIGHT, 'hello'), {
        runEnsembleRound: async () => undefined
      })
    ).toEqual({ status: null, roundId: null, pageMs: 7 })
  })

  it('carry the chat and prompt as data, never as code', async () => {
    vi.useRealTimers()
    let received: unknown = null
    await run(lanesModule.sendRoundExpression("x');window.hacked=1;('", "y')+('"), {
      runEnsembleRound: async (payload: unknown) => {
        received = payload
        return { status: 'started', roundId: 'r-1' }
      }
    })
    expect(received).toEqual({ chatId: "x');window.hacked=1;('", prompt: "y')+('" })
  })

  it('turn a refused cancel into an answer', async () => {
    vi.useRealTimers()
    expect(
      await run(lanesModule.cancelRoundExpression(LIGHT), {
        cancelEnsembleRound: async () => {
          throw new Error('Renderer cannot act on another chat.')
        }
      })
    ).toEqual({ ok: false, cancelled: false, pageMs: 7 })
    expect(
      await run(lanesModule.cancelRoundExpression(LIGHT), { cancelEnsembleRound: async () => true })
    ).toEqual({ ok: true, cancelled: true, pageMs: 7 })
  })
})
