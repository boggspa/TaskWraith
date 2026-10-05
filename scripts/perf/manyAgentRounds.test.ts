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
}
type Report = {
  observer: { installId: string | null; faults: number; failure: string | null }
  sending: boolean
  threads: Array<{
    chatId: string
    rounds: Round[]
    failure: string | null
    deliveries: { full: number; compact: number }
  }>
}
type Lanes = {
  install: () => Promise<void>
  start: () => void
  stopSending: () => Promise<{ drainedAtMs: number | null }>
  snapshot: () => Report
  stop: () => Promise<Report>
}

const roundsModule = require('./manyAgentRounds.cjs') as {
  DEFAULT_MANY_AGENT_LANE_OPTIONS: Record<string, number>
  createManyAgentLanes: (options: Record<string, unknown>) => Lanes
  manyAgentPrompt: (place: number, index: number) => string
}
const { THREAD_OBSERVER_GLOBAL } = require('./liveThreadObserver.cjs') as {
  THREAD_OBSERVER_GLOBAL: string
}

const CHATS = ['perf-many-01', 'perf-many-02', 'perf-many-03', 'perf-many-04']
const T0 = Date.parse('2026-10-04T12:00:00.000Z')

type Listener = (payload: unknown) => void
type AppOptions = {
  /** How long each chat's rounds run, by place; 400 ms where unset. */
  roundMs?: number[]
  acceptMs?: number
  /** Places whose round end the app never broadcasts. */
  silentEnds?: number[]
  /** Places whose round start the app never broadcasts. */
  silentStarts?: number[]
  /** A place whose sends never answer. */
  hangingSends?: number
  /** A place whose second send answers `started` with the first round's id. */
  repeatRoundId?: number
  /** A place whose sends main answers with a round it did not start. */
  refusedSends?: number
  /** A place whose sends main answers as started, with no round id. */
  idlessSends?: number
  /** How each round of a place ends; `completed` where unset. */
  endStatus?: Record<number, string>
}

/**
 * The page and a scripted main for any number of chats: runEnsembleRound
 * starts a round (or answers `steered` when the chat already has one),
 * broadcasts it running, and ends it after the chat's duration. The first
 * chat's changes arrive in full, as the open chat's do, and every other
 * chat's as compact invalidations.
 */
function fakeApp(options: AppOptions = {}) {
  const acceptMs = options.acceptMs ?? 20
  const listeners = { delivery: [] as Listener[], invalidation: [] as Listener[] }
  const active = new Map<string, string | null>()
  const counters = new Map<string, number>()
  const sends: Array<{ place: number; atMs: number; prompt: string }> = []
  let steered = 0
  let evaluations = 0
  const placeOf = (chatId: string) => CHATS.indexOf(chatId)
  const emit = (chatId: string, roundId: string, status: string) => {
    const ensemble = { activeRound: { roundId, status } }
    if (placeOf(chatId) === 0) {
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
  const end = (chatId: string, roundId: string) => {
    if (active.get(chatId) !== roundId) return
    active.set(chatId, null)
    const place = placeOf(chatId)
    if (!options.silentEnds?.includes(place)) {
      emit(chatId, roundId, options.endStatus?.[place] ?? 'completed')
    }
  }
  const start = (chatId: string): string => {
    const place = placeOf(chatId)
    const index = (counters.get(chatId) ?? 0) + 1
    counters.set(chatId, index)
    const roundId = `t${place + 1}-${index}`
    active.set(chatId, roundId)
    if (!options.silentStarts?.includes(place)) {
      setTimeout(() => emit(chatId, roundId, 'running'), 5)
    }
    setTimeout(() => end(chatId, roundId), options.roundMs?.[place] ?? 400)
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
          const place = placeOf(payload.chatId)
          sends.push({ place, atMs: Date.now(), prompt: payload.prompt })
          if (options.hangingSends === place) return
          if (options.refusedSends === place) {
            setTimeout(() => resolve({ status: 'queued', roundId: 'queued-1' }), acceptMs)
            return
          }
          if (options.idlessSends === place) {
            setTimeout(() => resolve({ status: 'started', roundId: null }), acceptMs)
            return
          }
          const current = active.get(payload.chatId)
          if (current) {
            steered += 1
            setTimeout(() => resolve({ status: 'steered', roundId: current }), acceptMs)
            return
          }
          if (options.repeatRoundId === place && (counters.get(payload.chatId) ?? 0) === 1) {
            setTimeout(() => resolve({ status: 'started', roundId: `t${place + 1}-1` }), acceptMs)
            return
          }
          const roundId = start(payload.chatId)
          setTimeout(
            () => resolve({ status: 'started', roundId, prompt: 'secret reply text' }),
            acceptMs
          )
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
    startExternally: (place: number) => start(CHATS[place]),
    /** A delivery the observer cannot read. */
    deliverUnreadable: (place: number) => {
      for (const listener of [...listeners.invalidation]) {
        listener({
          chatId: CHATS[place],
          get summary(): unknown {
            throw new Error('unreadable delivery')
          }
        })
      }
    },
    page: {
      evaluate: (expression: string) => {
        evaluations += 1
        return Promise.resolve(vm.runInContext(expression, context))
      }
    }
  }
}

function lanesFor(app: ReturnType<typeof fakeApp>, options: Record<string, unknown> = {}) {
  return roundsModule.createManyAgentLanes({
    page: app.page,
    chatIds: CHATS,
    pollMs: 50,
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
  lanes.start()
  return lanes
}

beforeEach(() => {
  vi.useFakeTimers({ now: T0 })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('rounds on every thread', () => {
  it('starts one on each thread at once and keeps one running on each', async () => {
    const app = fakeApp({ roundMs: [400, 400, 1_000, 250] })
    const lanes = await started(app)
    await vi.advanceTimersByTimeAsync(10)
    // Every thread's first send left before any had answered.
    expect(app.sends.map((send) => send.place).sort()).toEqual([0, 1, 2, 3])
    expect(new Set(app.sends.map((send) => send.atMs)).size).toBe(1)
    await vi.advanceTimersByTimeAsync(4_000)
    const report = await drive(lanes.stop())
    expect(report.threads.map((thread) => thread.chatId)).toEqual(CHATS)
    for (const [place, thread] of report.threads.entries()) {
      expect(thread.failure).toBeNull()
      expect(thread.rounds.length).toBeGreaterThanOrEqual(place === 2 ? 3 : 7)
      const ended = thread.rounds.slice(0, -1)
      expect(ended.every((round) => round.status === 'completed')).toBe(true)
      expect(thread.rounds.map((round) => round.roundId)).toEqual(
        thread.rounds.map((_round, index) => `t${place + 1}-${index + 1}`)
      )
      // One at a time on a thread: each sent once the one before was seen to
      // end, within one observer poll of it.
      for (let index = 1; index < thread.rounds.length; index += 1) {
        const before = thread.rounds[index - 1]
        expect(thread.rounds[index].sentAtMs).toBeGreaterThanOrEqual(before.endedAtMs!)
        expect(thread.rounds[index].sentAtMs - before.endedAtMs!).toBeLessThanOrEqual(60)
      }
    }
    expect(app.steered).toBe(0)
    expect(report.observer).toMatchObject({ failure: null, faults: 0 })
  })

  it('records each round as its send, its acceptance and its observed end', async () => {
    const app = fakeApp({ roundMs: [400, 400, 400, 400], acceptMs: 20 })
    const lanes = await started(app)
    const startedAtMs = Date.now()
    await vi.advanceTimersByTimeAsync(700)
    const report = await drive(lanes.stop())
    const [first, second] = report.threads[1].rounds
    expect(first).toEqual({
      roundId: 't2-1',
      sentAtMs: startedAtMs,
      acceptedAtMs: startedAtMs + 20,
      pageMs: 20,
      endedAtMs: startedAtMs + 400,
      status: 'completed'
    })
    // The second was accepted and is still running: no end, no status.
    expect(second).toMatchObject({ roundId: 't2-2', endedAtMs: null, status: null })
    expect(Object.keys(second).sort()).toEqual(Object.keys(first).sort())
  })

  it('leaves a gap between a thread’s rounds when asked', async () => {
    const app = fakeApp({ roundMs: [200, 200, 200, 200] })
    const lanes = await started(app, { roundGapMs: 500 })
    await vi.advanceTimersByTimeAsync(3_000)
    const report = await drive(lanes.stop())
    for (const thread of report.threads) {
      expect(thread.rounds.length).toBeGreaterThanOrEqual(3)
      for (let index = 1; index < thread.rounds.length; index += 1) {
        expect(thread.rounds[index].sentAtMs).toBeGreaterThanOrEqual(
          thread.rounds[index - 1].endedAtMs! + 500
        )
      }
    }
  })

  it('counts a round that ends failed and sends the next', async () => {
    const app = fakeApp({ endStatus: { 1: 'failed' } })
    const lanes = await started(app)
    await vi.advanceTimersByTimeAsync(1_500)
    const report = await drive(lanes.stop())
    expect(report.threads[1].failure).toBeNull()
    expect(report.threads[1].rounds.length).toBeGreaterThanOrEqual(3)
    expect(report.threads[1].rounds[0].status).toBe('failed')
    expect(report.threads[0].rounds[0].status).toBe('completed')
  })
})

describe('stopping the sends', () => {
  it('sends no more, waits for every round in flight and says when the last ended', async () => {
    const app = fakeApp({ roundMs: [400, 400, 1_000, 250] })
    const lanes = await started(app)
    await vi.advanceTimersByTimeAsync(1_100)
    const sentBefore = app.sends.length
    const stoppedAtMs = Date.now()
    const drained = await drive(lanes.stopSending())
    expect(app.sends).toHaveLength(sentBefore)
    const report = lanes.snapshot()
    expect(report.sending).toBe(false)
    const lastEnds = report.threads.map(
      (thread) => thread.rounds[thread.rounds.length - 1].endedAtMs!
    )
    expect(lastEnds.every((endedAtMs) => endedAtMs !== null)).toBe(true)
    expect(drained).toEqual({ drainedAtMs: Math.max(...lastEnds) })
    expect(drained.drainedAtMs).toBeGreaterThan(stoppedAtMs)
    // Nothing is sent afterwards either.
    await vi.advanceTimersByTimeAsync(5_000)
    expect(app.sends).toHaveLength(sentBefore)
    await drive(lanes.stop())
  })

  it('has no drain time when a thread’s last round was never seen to end', async () => {
    const app = fakeApp({ silentEnds: [3] })
    const lanes = await started(app, { roundTimeoutMs: 2_000 })
    await vi.advanceTimersByTimeAsync(500)
    expect(await drive(lanes.stopSending())).toEqual({ drainedAtMs: null })
    expect(lanes.snapshot().threads[3].failure).toBe('unobserved')
    await drive(lanes.stop())
  })

  it('has no drain time when a thread never sent a round', async () => {
    const app = fakeApp({ refusedSends: 0 })
    const lanes = await started(app)
    await vi.advanceTimersByTimeAsync(500)
    expect(await drive(lanes.stopSending())).toEqual({ drainedAtMs: null })
    await drive(lanes.stop())
  })

  it('says the sends are running until they are stopped', async () => {
    const app = fakeApp()
    const lanes = lanesFor(app)
    await drive(lanes.install())
    expect(lanes.snapshot().sending).toBe(false)
    lanes.start()
    expect(lanes.snapshot().sending).toBe(true)
    await drive(lanes.stopSending())
    expect(lanes.snapshot().sending).toBe(false)
    await drive(lanes.stop())
  })
})

describe('a thread that fails', () => {
  it('stops alone when it never sees its round end, without a probe', async () => {
    const app = fakeApp({ silentEnds: [1] })
    const lanes = await started(app, { roundTimeoutMs: 2_000 })
    // Its bound runs from its acceptance: not yet at 1,950 ms, by 2,100.
    await vi.advanceTimersByTimeAsync(1_950)
    expect(lanes.snapshot().threads[1].failure).toBeNull()
    await vi.advanceTimersByTimeAsync(150)
    expect(lanes.snapshot().threads[1].failure).toBe('unobserved')
    await vi.advanceTimersByTimeAsync(3_900)
    const report = await drive(lanes.stop())
    expect(report.threads[1].failure).toBe('unobserved')
    expect(report.threads[1].rounds).toHaveLength(1)
    expect(app.sends.filter((send) => send.place === 1)).toHaveLength(1)
    for (const place of [0, 2, 3]) {
      expect(report.threads[place].failure).toBeNull()
      expect(report.threads[place].rounds.length).toBeGreaterThanOrEqual(10)
    }
    expect(report.observer.failure).toBeNull()
  })

  it('never sends while the observer shows a round it did not see end', async () => {
    const app = fakeApp()
    const lanes = lanesFor(app)
    await drive(lanes.install())
    app.startExternally(2)
    await vi.advanceTimersByTimeAsync(100)
    lanes.start()
    await vi.advanceTimersByTimeAsync(1_000)
    const report = await drive(lanes.stop())
    expect(report.threads[2]).toMatchObject({ rounds: [], failure: 'busy_before_send' })
    expect(app.sends.filter((send) => send.place === 2)).toEqual([])
    expect(report.threads[0].failure).toBeNull()
  })

  it('stops on a steered answer and never sends again', async () => {
    // A round the observer has not heard about: main absorbs the send.
    const app = fakeApp({ silentStarts: [2], roundMs: [400, 400, 60_000, 400] })
    const lanes = lanesFor(app)
    await drive(lanes.install())
    app.startExternally(2)
    lanes.start()
    await vi.advanceTimersByTimeAsync(2_000)
    const report = await drive(lanes.stop())
    expect(report.threads[2]).toMatchObject({ rounds: [], failure: 'steered' })
    expect(app.steered).toBe(1)
    expect(app.sends.filter((send) => send.place === 2)).toHaveLength(1)
  })

  it('refuses a round id main already gave the thread', async () => {
    const app = fakeApp({ repeatRoundId: 3 })
    const lanes = await started(app)
    await vi.advanceTimersByTimeAsync(2_000)
    const report = await drive(lanes.stop())
    expect(report.threads[3].failure).toBe('not_started')
    expect(report.threads[3].rounds.map((round) => round.roundId)).toEqual(['t4-1'])
  })

  it('stops when main does not start its round, or names none', async () => {
    const app = fakeApp({ refusedSends: 0, idlessSends: 3 })
    const lanes = await started(app)
    await vi.advanceTimersByTimeAsync(1_000)
    const report = await drive(lanes.stop())
    for (const place of [0, 3]) {
      expect(report.threads[place]).toMatchObject({ rounds: [], failure: 'not_started' })
      expect(app.sends.filter((send) => send.place === place)).toHaveLength(1)
    }
  })

  it('bounds a send that never answers', async () => {
    const app = fakeApp({ hangingSends: 1 })
    const lanes = await started(app, { callTimeoutMs: 1_000 })
    await vi.advanceTimersByTimeAsync(3_000)
    const report = await drive(lanes.stop())
    expect(report.threads[1]).toMatchObject({ rounds: [], failure: 'send_failed' })
    expect(report.threads[0].failure).toBeNull()
  })
})

describe('the observer under the threads', () => {
  it('fails every thread when the page loses its observer, as on a reload', async () => {
    const app = fakeApp({ roundMs: [60_000, 60_000, 60_000, 60_000] })
    const lanes = await started(app)
    await vi.advanceTimersByTimeAsync(200)
    delete app.window[THREAD_OBSERVER_GLOBAL]
    await vi.advanceTimersByTimeAsync(200)
    expect(await drive(lanes.stopSending())).toEqual({ drainedAtMs: null })
    // A lost observer is not asked again.
    const calls = app.evaluations
    await vi.advanceTimersByTimeAsync(1_000)
    expect(app.evaluations).toBe(calls)
    const report = await drive(lanes.stop())
    expect(report.observer.failure).toBe('observer_not_installed')
    expect(report.threads.map((thread) => thread.failure)).toEqual(
      CHATS.map(() => 'observer_not_installed')
    )
  })

  it('fails every thread when the observer lost transitions between two reads', async () => {
    const app = fakeApp({ roundMs: [1, 1, 1, 1] })
    const lanes = lanesFor(app, { pollMs: 5_000 })
    await drive(lanes.install())
    // More rounds than the observer keeps, all between two reads.
    for (let index = 0; index < 2_100; index += 1) {
      app.startExternally(0)
      await vi.advanceTimersByTimeAsync(2)
    }
    await vi.advanceTimersByTimeAsync(5_000)
    lanes.start()
    await vi.advanceTimersByTimeAsync(100)
    const report = await drive(lanes.stop())
    expect(report.observer.failure).toBe('observer_transitions_lost')
    expect(report.threads.map((thread) => thread.failure)).toEqual(
      CHATS.map(() => 'observer_transitions_lost')
    )
    expect(app.sends).toEqual([])
  })

  it('keeps up with more transitions than the observer retains, read as they come', async () => {
    const app = fakeApp({ roundMs: [1, 1, 1, 1] })
    const lanes = lanesFor(app, { pollMs: 50 })
    await drive(lanes.install())
    for (let index = 0; index < 2_100; index += 1) {
      app.startExternally(0)
      await vi.advanceTimersByTimeAsync(2)
    }
    await vi.advanceTimersByTimeAsync(100)
    const report = await drive(lanes.stop())
    expect(report.observer.failure).toBeNull()
  })

  it('reports the observer’s own faults', async () => {
    const app = fakeApp()
    const lanes = await started(app)
    app.deliverUnreadable(1)
    app.deliverUnreadable(2)
    await vi.advanceTimersByTimeAsync(100)
    const report = await drive(lanes.stop())
    expect(report.observer.faults).toBe(2)
    expect(report.observer.failure).toBeNull()
  })

  it('reports how each thread’s changes reached the page', async () => {
    const app = fakeApp({ roundMs: [300, 60_000, 60_000, 60_000] })
    const lanes = await started(app)
    await vi.advanceTimersByTimeAsync(340)
    const report = await drive(lanes.stop())
    // The open chat's start and end in full, the others' start compact.
    expect(report.threads.map((thread) => thread.deliveries)).toEqual([
      { full: 2, compact: 0 },
      { full: 0, compact: 1 },
      { full: 0, compact: 1 },
      { full: 0, compact: 1 }
    ])
  })

  it('refuses a page that already carries an observer', async () => {
    const app = fakeApp()
    await drive(lanesFor(app).install())
    await expect(drive(lanesFor(app).install())).rejects.toMatchObject({
      code: 'T2_LIVE_THREAD_OBSERVER',
      reason: 'already_installed'
    })
  })

  it('refuses a first read that is not this install’s', async () => {
    const app = fakeApp()
    const evaluate = app.page.evaluate
    let calls = 0
    const lanes = roundsModule.createManyAgentLanes({
      chatIds: CHATS,
      page: {
        evaluate: (expression: string) => {
          calls += 1
          return calls === 2 ? Promise.resolve(null) : evaluate(expression)
        }
      }
    })
    await expect(drive(lanes.install())).rejects.toMatchObject({
      code: 'T2_LIVE_THREAD_OBSERVER',
      reason: 'not_installed'
    })
  })

  it('makes no page call once stopped', async () => {
    const app = fakeApp()
    const lanes = await started(app)
    await vi.advanceTimersByTimeAsync(1_000)
    const report = await drive(lanes.stop())
    expect(report.sending).toBe(false)
    const calls = app.evaluations
    await vi.advanceTimersByTimeAsync(10_000)
    expect(app.evaluations).toBe(calls)
  })

  it('sends nothing once stopped, even from the gap between two rounds', async () => {
    const app = fakeApp({ roundMs: [200, 200, 200, 200] })
    const lanes = await started(app, { roundGapMs: 2_000 })
    // Every thread's first round has ended and its gap is running.
    await vi.advanceTimersByTimeAsync(600)
    await drive(lanes.stop())
    const sent = app.sends.length
    await vi.advanceTimersByTimeAsync(10_000)
    expect(app.sends).toHaveLength(sent)
    expect(sent).toBe(4)
  })

  it('waits for a send in flight before it reports', async () => {
    // Each send answers only after the pump has taken its last turn.
    const app = fakeApp({ acceptMs: 80 })
    const lanes = await started(app)
    // Stopped before any send has answered: each is still recorded.
    const report = await drive(lanes.stop())
    expect(report.threads.map((thread) => thread.rounds.length)).toEqual([1, 1, 1, 1])
    expect(report.threads.every((thread) => thread.failure === null)).toBe(true)
  })

  it('stops cleanly when it never installed or never started', async () => {
    const app = fakeApp()
    const idle = await drive(lanesFor(app).stop())
    expect(idle.threads.map((thread) => thread.rounds)).toEqual([[], [], [], []])
    expect(idle.observer).toEqual({ installId: null, faults: 0, failure: null })
    const lanes = lanesFor(app)
    await drive(lanes.install())
    const installed = await drive(lanes.stop())
    expect(installed.observer.installId).toEqual(expect.any(String))
    expect(installed.sending).toBe(false)
  })

  it('reads the page once a poll, however many threads there are', async () => {
    const app = fakeApp({ roundMs: [60_000, 60_000, 60_000, 60_000] })
    const lanes = await started(app, { pollMs: 100 })
    await vi.advanceTimersByTimeAsync(50)
    const calls = app.evaluations
    await vi.advanceTimersByTimeAsync(1_000)
    expect(app.evaluations - calls).toBe(10)
    await drive(lanes.stop())
  })
})

describe('what crosses to the runner, and what is refused', () => {
  it('keeps every reply to its status, round id and page time', async () => {
    const app = fakeApp()
    const lanes = await started(app)
    await vi.advanceTimersByTimeAsync(100)
    const report = await drive(lanes.stop())
    expect(JSON.stringify(report)).not.toContain('secret')
    expect(app.sends.map((send) => send.prompt)).toEqual([
      'Many agents, thread 1, round 1: answer briefly.',
      'Many agents, thread 2, round 1: answer briefly.',
      'Many agents, thread 3, round 1: answer briefly.',
      'Many agents, thread 4, round 1: answer briefly.'
    ])
    // Named once, so whoever finds a send again by its text asks for the same.
    expect(app.sends.map((send) => send.prompt)).toEqual(
      [0, 1, 2, 3].map((place) => roundsModule.manyAgentPrompt(place, 1))
    )
  })

  it('gives copies, not its own records', async () => {
    const app = fakeApp()
    const lanes = await started(app)
    await vi.advanceTimersByTimeAsync(100)
    const first = lanes.snapshot()
    first.threads[0].rounds[0].roundId = 'changed'
    first.threads[0].deliveries.full = 99
    expect(lanes.snapshot().threads[0].rounds[0].roundId).toBe('t1-1')
    expect(lanes.snapshot().threads[0].deliveries.full).not.toBe(99)
    await drive(lanes.stop())
  })

  it('must be installed before it starts, and starts and installs once', async () => {
    const app = fakeApp()
    const lanes = lanesFor(app)
    expect(() => lanes.start()).toThrow(/install/)
    await expect(drive(lanes.stopSending())).rejects.toThrow(/not started/)
    await drive(lanes.install())
    await expect(drive(lanes.install())).rejects.toThrow(/already installed/)
    lanes.start()
    expect(() => lanes.start()).toThrow(/already started/)
    await drive(lanes.stop())
  })

  it.each([
    ['pollMs', { pollMs: 0 }],
    ['callTimeoutMs', { callTimeoutMs: -1 }],
    ['roundTimeoutMs', { roundTimeoutMs: Number.NaN }],
    ['roundGapMs', { roundGapMs: -1 }],
    ['roundGapMs', { roundGapMs: Number.POSITIVE_INFINITY }]
  ])('refuses a bad %s', (name, options) => {
    expect(() => lanesFor(fakeApp(), options)).toThrow(name)
  })

  it('refuses a missing page and a bad thread list', () => {
    expect(() => roundsModule.createManyAgentLanes({ chatIds: CHATS })).toThrow(/page adapter/)
    expect(() => roundsModule.createManyAgentLanes(null as never)).toThrow(/page adapter/)
    expect(() =>
      roundsModule.createManyAgentLanes({ page: fakeApp().page, chatIds: [CHATS[0], CHATS[0]] })
    ).toThrow(/twice/)
  })

  it('has defaults for a real run', () => {
    expect(roundsModule.DEFAULT_MANY_AGENT_LANE_OPTIONS).toEqual({
      pollMs: 250,
      callTimeoutMs: 60_000,
      roundTimeoutMs: 600_000,
      roundGapMs: 0
    })
  })
})
