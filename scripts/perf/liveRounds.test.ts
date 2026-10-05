import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const live = require('./liveRounds.cjs') as {
  D1_COUNTERS_EXPRESSION: string
  NEUTRALIZED_OLLAMA_ENV_KEYS: string[]
  buildScriptedDaemonConfig: (fixture: unknown, options?: Record<string, unknown>) => unknown
  liveSeatsOf: (fixture: unknown) => { provider: string; model: string }
  liveRoundPrompt: (purpose: string) => string
  neutralizeOllamaEnvironmentOnSpawnPlan: (
    plan: unknown,
    inherited: unknown
  ) => {
    spawnPlan: { env: Record<string, string>; shellCommand: string }
    record: { neutralized: Array<{ key: string; inherited: boolean }> }
  }
  readD1Counters: (page: FakePage) => Promise<unknown>
  d1Delta: (before: unknown, after: unknown) => Record<string, number | null> | null
  readScriptedDaemonState: (
    baseUrl: string,
    options?: Record<string, unknown>
  ) => Promise<{ inFlight: number; turnsDone: number }>
  readScriptedDaemonActivity: (
    baseUrl: string,
    options: unknown
  ) => Promise<{ started: number; done: number; busyMs: number; maxQuietMs: number }>
  readScriptedDaemonTurns: (
    baseUrl: string,
    options: unknown
  ) => Promise<
    Array<{ model: string; startedAtMs: number; endedAtMs: number | null; outcome: string }>
  >
  roundStateExpression: (chatId: string) => string
  runLiveSmokeRound: (options: Record<string, unknown>) => Promise<Record<string, unknown>>
  runLiveRoundSequence: (options: Record<string, unknown>) => Promise<{
    rounds: Array<Record<string, unknown>>
    verdict: { ok: boolean; reasons: string[] }
  }>
  liveRoundsVerdict: (
    rounds: unknown,
    options?: { barrierDurability?: unknown }
  ) => { ok: boolean; reasons: string[] }
  windowJournalPathReasons: (input: Record<string, unknown>) => string[]
  daemonStopFailures: (stopped: unknown) => string[]
  withDaemonStopFailures: (verdict: unknown, failures: string[]) => unknown
  t2RunOk: (report: unknown) => boolean
  startScriptedDaemonChild: (options: Record<string, unknown>) => Promise<DaemonHandle>
}
const { generatePerfFixture } = require('./fixtureGenerator.cjs') as {
  generatePerfFixture: (options: Record<string, unknown>) => { seed: number; shape: unknown }
}
const { createScriptedOllamaDaemon } = require('./scriptedOllamaDaemon.cjs') as {
  createScriptedOllamaDaemon: (options: Record<string, unknown>) => {
    listen(): Promise<{ baseUrl: string }>
    close(): Promise<void>
  }
}

type FakePage = { evaluate(expression: string): Promise<unknown> }
type DaemonHandle = {
  pid: number
  baseUrl: string
  stop(): Promise<{
    exit: { code: number | null; signal: string | null } | null
    forced: boolean
    summary: { requestCounts: Record<string, number> } | null
    stderrTail: string
  }>
}

/** Every directory this file makes is named so, directly in the temporary folder. */
const MADE_PREFIX = 'harness-live-rounds-'
const made: string[] = []

/** Removes a directory only when it is one this file made: never the folder above it. */
function removeMade(dir: string) {
  const root = tmpdir()
  if (dir === root || resolve(dir) !== dir || !dir.startsWith(root + sep + MADE_PREFIX)) {
    throw new Error(`refusing to remove ${dir}: not a directory this file made`)
  }
  rmSync(dir, { recursive: true, force: true })
}

afterEach(() => {
  while (made.length > 0) removeMade(made.pop()!)
})

function temporaryDirectory(): string {
  const dir = mkdtempSync(join(tmpdir(), MADE_PREFIX))
  made.push(dir)
  return dir
}

describe('live-round fixtures and daemon config', () => {
  it('builds the daemon config from the fixture seat and seed, and refuses replay workloads', () => {
    const fixture = generatePerfFixture({
      workload: 'light_beside_large_live',
      seed: 42,
      scaleDown: 50
    })
    // Every tag a live chat's seats use, the light chat's first.
    const models = [{ name: 'scripted-llama:latest' }, { name: 'scripted-llama:heavy' }]
    expect(live.buildScriptedDaemonConfig(fixture)).toEqual({ seed: 42, models })
    expect(
      live.buildScriptedDaemonConfig(fixture, { seed: 7, shape: { chunkIntervalMs: 0 } })
    ).toEqual({
      seed: 7,
      models,
      shape: { chunkIntervalMs: 0 }
    })
    // A fixture without per-chat tags serves its one seat tag.
    const oneTag = {
      ...fixture,
      shape: {
        ...(fixture.shape as Record<string, unknown>),
        liveSeats: { provider: 'ollama', model: 'scripted-llama:latest' }
      }
    }
    expect(live.buildScriptedDaemonConfig(oneTag)).toEqual({
      seed: 42,
      models: [{ name: 'scripted-llama:latest' }]
    })
    const replay = generatePerfFixture({ workload: 'light_beside_large', seed: 42, scaleDown: 50 })
    expect(() => live.buildScriptedDaemonConfig(replay)).toThrow(/live-round workload/)
  })
})

describe('the daemon state read', () => {
  it('reads the live counts from a running daemon', async () => {
    const daemon = createScriptedOllamaDaemon({ seed: 1 })
    const { baseUrl } = await daemon.listen()
    try {
      await expect(live.readScriptedDaemonState(baseUrl)).resolves.toEqual({
        inFlight: 0,
        turnsDone: 0
      })
    } finally {
      await daemon.close()
    }
  })

  it('refuses a non-loopback address and fails loudly on a bad answer', async () => {
    await expect(live.readScriptedDaemonState('http://localhost:1')).rejects.toThrow(
      /loopback base URL/
    )
    const answer = (status: number, body: unknown) => ({
      fetch: async () => ({ ok: status === 200, status, json: async () => body })
    })
    await expect(
      live.readScriptedDaemonState('http://127.0.0.1:1', answer(404, {}))
    ).rejects.toMatchObject({ code: 'T2_LIVE_DAEMON_STATE' })
    await expect(
      live.readScriptedDaemonState('http://127.0.0.1:1', answer(200, { inFlight: '0' }))
    ).rejects.toMatchObject({ code: 'T2_LIVE_DAEMON_STATE' })
    await expect(
      live.readScriptedDaemonState('http://127.0.0.1:1', {
        fetch: async () => {
          throw new Error('connect ECONNREFUSED')
        }
      })
    ).rejects.toMatchObject({
      code: 'T2_LIVE_DAEMON_STATE',
      message: expect.stringMatching(/ECONNREFUSED/)
    })
  })
})

describe('the daemon activity read', () => {
  const RANGE = { model: 'scripted-llama:heavy', fromMs: 1_000, toMs: 61_000 }
  const RECORD = { ...RANGE, started: 5, done: 4, busyMs: 9_000, maxQuietMs: 12_000 }
  const answer = (status: number, body: unknown) => {
    const calls: Array<{ url: string; init: { signal?: AbortSignal } }> = []
    return {
      calls,
      fetch: async (url: string, init: { signal?: AbortSignal }) => {
        calls.push({ url, init })
        return { ok: status === 200, status, json: async () => body }
      }
    }
  }

  it('reads one tag’s turns over a range from a running daemon', async () => {
    const daemon = createScriptedOllamaDaemon({
      seed: 1,
      models: [{ name: 'scripted-llama:latest' }, { name: 'scripted-llama:heavy' }]
    })
    const { baseUrl } = await daemon.listen()
    try {
      await expect(live.readScriptedDaemonActivity(baseUrl, RANGE)).resolves.toEqual({
        started: 0,
        done: 0,
        busyMs: 0,
        maxQuietMs: 60_000
      })
    } finally {
      await daemon.close()
    }
  })

  it('asks for the tag, encoded, and the range, with a bound', async () => {
    const fake = answer(200, RECORD)
    await expect(
      live.readScriptedDaemonActivity('http://127.0.0.1:43998', { ...RANGE, fetch: fake.fetch })
    ).resolves.toEqual({ started: 5, done: 4, busyMs: 9_000, maxQuietMs: 12_000 })
    expect(fake.calls.map((call) => call.url)).toEqual([
      'http://127.0.0.1:43998/_scripted/activity?model=scripted-llama%3Aheavy&from=1000&to=61000'
    ])
    expect(fake.calls[0].init.signal).toBeInstanceOf(AbortSignal)
  })

  it('refuses a bad address or range before asking', async () => {
    const fake = answer(200, RECORD)
    const read = (baseUrl: string, extra: Record<string, unknown>) =>
      live.readScriptedDaemonActivity(baseUrl, { ...RANGE, ...extra, fetch: fake.fetch })
    await expect(read('http://localhost:1', {})).rejects.toThrow(/loopback base URL/)
    for (const extra of [
      { model: undefined },
      { model: 7 },
      { fromMs: 1.5 },
      { fromMs: -1 },
      { toMs: '61000' },
      { toMs: RANGE.fromMs },
      { toMs: RANGE.fromMs - 1 }
    ]) {
      await expect(read('http://127.0.0.1:1', extra)).rejects.toThrow(/tag and a range/)
    }
    await expect(live.readScriptedDaemonActivity('http://127.0.0.1:1', null)).rejects.toThrow(
      /tag and a range/
    )
    expect(fake.calls).toEqual([])
  })

  it('fails loudly on an answer that is not this tag’s record for this range', async () => {
    const span = RANGE.toMs - RANGE.fromMs
    const bodies = [
      { ...RECORD, model: 'scripted-llama:latest' },
      { ...RECORD, fromMs: RANGE.fromMs + 1 },
      { ...RECORD, toMs: RANGE.toMs + 1 },
      { ...RECORD, started: '5' },
      { ...RECORD, busyMs: -1 },
      { ...RECORD, maxQuietMs: 0.5 },
      { ...RECORD, done: 6 },
      { ...RECORD, busyMs: span + 1 },
      { ...RECORD, maxQuietMs: span + 1 },
      null
    ]
    for (const body of bodies) {
      await expect(
        live.readScriptedDaemonActivity('http://127.0.0.1:1', {
          ...RANGE,
          fetch: answer(200, body).fetch
        })
      ).rejects.toMatchObject({ code: 'T2_LIVE_DAEMON_STATE' })
    }
    // At the limits the record is whole.
    await expect(
      live.readScriptedDaemonActivity('http://127.0.0.1:1', {
        ...RANGE,
        fetch: answer(200, { ...RECORD, done: 5, busyMs: span, maxQuietMs: span }).fetch
      })
    ).resolves.toMatchObject({ done: 5, busyMs: span, maxQuietMs: span })
    await expect(
      live.readScriptedDaemonActivity('http://127.0.0.1:1', {
        ...RANGE,
        fetch: answer(404, { error: 'unknown model' }).fetch
      })
    ).rejects.toMatchObject({
      code: 'T2_LIVE_DAEMON_STATE',
      message: expect.stringMatching(/HTTP 404/)
    })
    await expect(
      live.readScriptedDaemonActivity('http://127.0.0.1:1', {
        ...RANGE,
        fetch: async () => {
          throw new Error('connect ECONNREFUSED')
        }
      })
    ).rejects.toMatchObject({
      code: 'T2_LIVE_DAEMON_STATE',
      message: expect.stringMatching(/ECONNREFUSED/)
    })
  })

  it('gives up on a daemon that never answers', async () => {
    const hanging = (_url: string, init: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason))
      })
    await expect(
      live.readScriptedDaemonActivity('http://127.0.0.1:1', {
        ...RANGE,
        fetch: hanging,
        timeoutMs: 20
      })
    ).rejects.toMatchObject({ code: 'T2_LIVE_DAEMON_STATE' })
  })
})

describe('the daemon turns read', () => {
  const RANGE = { fromMs: 1_000, toMs: 61_000 }
  const TURNS = [
    { model: 'scripted-llama:t001', startedAtMs: 900, endedAtMs: 2_500, outcome: 'done' },
    { model: 'scripted-llama:t002', startedAtMs: 1_200, endedAtMs: 1_300, outcome: 'aborted' },
    {
      model: 'scripted-llama:t001',
      startedAtMs: 2_600,
      endedAtMs: 2_600,
      outcome: 'fault-omit-done'
    },
    { model: 'scripted-llama:t002', startedAtMs: 60_999, endedAtMs: null, outcome: 'streaming' }
  ]
  const answer = (status: number, body: unknown) => {
    const calls: Array<{ url: string; init: { signal?: AbortSignal } }> = []
    return {
      calls,
      fetch: async (url: string, init: { signal?: AbortSignal }) => {
        calls.push({ url, init })
        return { ok: status === 200, status, json: async () => body }
      }
    }
  }

  it('reads every tag’s turns over a range from a running daemon', async () => {
    const daemon = createScriptedOllamaDaemon({
      seed: 1,
      models: [{ name: 'scripted-llama:latest' }, { name: 'scripted-llama:t001' }]
    })
    const { baseUrl } = await daemon.listen()
    try {
      await expect(live.readScriptedDaemonTurns(baseUrl, RANGE)).resolves.toEqual([])
    } finally {
      await daemon.close()
    }
  })

  it('asks for the range, with a bound, and returns each turn as its tag and times', async () => {
    const fake = answer(200, { ...RANGE, turns: TURNS.map((turn) => ({ ...turn, extra: 1 })) })
    await expect(
      live.readScriptedDaemonTurns('http://127.0.0.1:43998', { ...RANGE, fetch: fake.fetch })
    ).resolves.toEqual(TURNS)
    expect(fake.calls.map((call) => call.url)).toEqual([
      'http://127.0.0.1:43998/_scripted/turns?from=1000&to=61000'
    ])
    expect(fake.calls[0].init.signal).toBeInstanceOf(AbortSignal)
  })

  it('refuses a bad address or range before asking', async () => {
    const fake = answer(200, { ...RANGE, turns: [] })
    const read = (baseUrl: string, extra: Record<string, unknown>) =>
      live.readScriptedDaemonTurns(baseUrl, { ...RANGE, ...extra, fetch: fake.fetch })
    await expect(read('http://localhost:1', {})).rejects.toThrow(/loopback base URL/)
    for (const extra of [
      { fromMs: 1.5 },
      { fromMs: -1 },
      { toMs: '61000' },
      { toMs: RANGE.fromMs },
      { toMs: RANGE.fromMs - 1 }
    ]) {
      await expect(read('http://127.0.0.1:1', extra)).rejects.toThrow(/range of whole/)
    }
    await expect(live.readScriptedDaemonTurns('http://127.0.0.1:1', null)).rejects.toThrow(
      /range of whole/
    )
    expect(fake.calls).toEqual([])
  })

  it('fails loudly on an answer that is not the turns of this range', async () => {
    const [first, second] = TURNS
    const bodies = [
      { ...RANGE, fromMs: RANGE.fromMs + 1, turns: [] },
      { ...RANGE, toMs: RANGE.toMs + 1, turns: [] },
      { ...RANGE },
      { ...RANGE, turns: {} },
      { ...RANGE, turns: [null] },
      { ...RANGE, turns: [{ ...first, model: 7 }] },
      { ...RANGE, turns: [{ ...first, startedAtMs: '900' }] },
      { ...RANGE, turns: [{ ...first, startedAtMs: -1 }] },
      // A turn that began at or after the range's end was not in it.
      { ...RANGE, turns: [{ ...first, startedAtMs: RANGE.toMs, endedAtMs: RANGE.toMs }] },
      // Nor was one that had ended before the range began.
      { ...RANGE, turns: [{ ...first, startedAtMs: 100, endedAtMs: RANGE.fromMs - 1 }] },
      // No turn ends before it starts.
      { ...RANGE, turns: [{ ...first, startedAtMs: 2_000, endedAtMs: 1_999 }] },
      { ...RANGE, turns: [{ ...first, endedAtMs: 2_500.5 }] },
      { ...RANGE, turns: [{ ...first, outcome: 'finished' }] },
      // A turn still streaming has no end, and an ended one is not streaming.
      { ...RANGE, turns: [{ ...first, outcome: 'streaming' }] },
      { ...RANGE, turns: [{ ...first, endedAtMs: null }] },
      // Start order is what the daemon answers in.
      { ...RANGE, turns: [second, first] },
      null
    ]
    for (const body of bodies) {
      await expect(
        live.readScriptedDaemonTurns('http://127.0.0.1:1', {
          ...RANGE,
          fetch: answer(200, body).fetch
        })
      ).rejects.toMatchObject({ code: 'T2_LIVE_DAEMON_STATE' })
    }
    // At the limits a turn is in the range: ended on its first millisecond,
    // begun on its last, and two that began together.
    const edges = [
      { ...first, startedAtMs: 0, endedAtMs: RANGE.fromMs },
      { ...second, startedAtMs: RANGE.toMs - 1, endedAtMs: RANGE.toMs - 1 },
      { ...first, startedAtMs: RANGE.toMs - 1, endedAtMs: RANGE.toMs + 5 }
    ]
    await expect(
      live.readScriptedDaemonTurns('http://127.0.0.1:1', {
        ...RANGE,
        fetch: answer(200, { ...RANGE, turns: edges }).fetch
      })
    ).resolves.toEqual(edges)
    await expect(
      live.readScriptedDaemonTurns('http://127.0.0.1:1', {
        ...RANGE,
        fetch: answer(400, { error: 'to must not be in the future' }).fetch
      })
    ).rejects.toMatchObject({
      code: 'T2_LIVE_DAEMON_STATE',
      message: expect.stringMatching(/HTTP 400/)
    })
    await expect(
      live.readScriptedDaemonTurns('http://127.0.0.1:1', {
        ...RANGE,
        fetch: async () => {
          throw new Error('connect ECONNREFUSED')
        }
      })
    ).rejects.toMatchObject({
      code: 'T2_LIVE_DAEMON_STATE',
      message: expect.stringMatching(/ECONNREFUSED/)
    })
  })

  it('gives up on a daemon that never answers', async () => {
    const hanging = (_url: string, init: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason))
      })
    await expect(
      live.readScriptedDaemonTurns('http://127.0.0.1:1', {
        ...RANGE,
        fetch: hanging,
        timeoutMs: 20
      })
    ).rejects.toMatchObject({ code: 'T2_LIVE_DAEMON_STATE' })
  })
})

describe('the measured child environment', () => {
  it('blanks the operator Ollama variables and records only whether each was set', () => {
    const { spawnPlan, record } = live.neutralizeOllamaEnvironmentOnSpawnPlan(
      { env: { TASKWRAITH_INSTANCE_ID: 'perf' }, shellCommand: 'env A=1 Electron .' },
      { OLLAMA_API_KEY: 'operator-secret', OLLAMA_MAX_LOADED_MODELS: ' ' }
    )
    expect(live.NEUTRALIZED_OLLAMA_ENV_KEYS).toEqual(['OLLAMA_API_KEY', 'OLLAMA_MAX_LOADED_MODELS'])
    expect(spawnPlan.env).toEqual({
      TASKWRAITH_INSTANCE_ID: 'perf',
      OLLAMA_API_KEY: '',
      OLLAMA_MAX_LOADED_MODELS: ''
    })
    expect(spawnPlan.shellCommand).toBe(
      'env OLLAMA_API_KEY= OLLAMA_MAX_LOADED_MODELS= env A=1 Electron .'
    )
    expect(record).toEqual({
      neutralized: [
        { key: 'OLLAMA_API_KEY', inherited: true },
        { key: 'OLLAMA_MAX_LOADED_MODELS', inherited: false }
      ]
    })
    expect(JSON.stringify({ spawnPlan, record })).not.toContain('operator-secret')
    expect(() =>
      live.neutralizeOllamaEnvironmentOnSpawnPlan(
        { env: { OLLAMA_API_KEY: 'x' }, shellCommand: 'Electron' },
        {}
      )
    ).toThrow(/already sets OLLAMA_API_KEY/)
  })
})

describe('D1 counters through the page API', () => {
  it('reads the journal and boundary counters, and null when the section is missing', async () => {
    const expressions: string[] = []
    const page = (value: unknown): FakePage => ({
      async evaluate(expression) {
        expressions.push(expression)
        return value
      }
    })
    await expect(
      live.readD1Counters(page({ deferredAppends: 3, unsyncedAppends: 4, normalSaves: 5 }))
    ).resolves.toEqual({ deferredAppends: 3, unsyncedAppends: 4, normalSaves: 5 })
    // A build from before barrier durability does not count unsynced appends.
    await expect(
      live.readD1Counters(page({ deferredAppends: 3, normalSaves: 5 }))
    ).resolves.toEqual({ deferredAppends: 3, unsyncedAppends: null, normalSaves: 5 })
    await expect(live.readD1Counters(page(null))).resolves.toBeNull()
    await expect(
      live.readD1Counters(page({ deferredAppends: 'x', unsyncedAppends: 0, normalSaves: 5 }))
    ).resolves.toBeNull()
    expect(expressions[0]).toBe(live.D1_COUNTERS_EXPRESSION)
    expect(live.D1_COUNTERS_EXPRESSION).toContain('window.api.getMainPerfSnapshot()')
    // Evaluated as the page would, against main's persistence section.
    const read = (journal: Record<string, number>) =>
      runInNewContext(live.D1_COUNTERS_EXPRESSION, {
        window: {
          api: {
            getMainPerfSnapshot: async () => ({
              sections: { incrementalChatPersistence: { journal, boundaryMix: { normal: 9 } } }
            })
          }
        }
      })
    await expect(read({ deferredAppends: 1, unsyncedAppends: 2 })).resolves.toEqual({
      deferredAppends: 1,
      unsyncedAppends: 2,
      normalSaves: 9
    })
  })
})

describe('one live smoke round', () => {
  it('cancels an ambiguous timed-out install before delayed page execution', async () => {
    const window: any = {
      api: { onChatUpdated: () => () => {}, onChatUpdateInvalidated: () => () => {} }
    }
    let late = ''
    await expect(
      live.runLiveSmokeRound({
        page: {
          evaluate: async (expression: string) => {
            if (expression.includes('function installLaneObserverInPage')) {
              late = expression
              return new Promise(() => {})
            }
            return runInNewContext(expression, { window })
          }
        },
        chatId: 'smoke',
        prompt: 'p',
        readDaemonState: async () => ({ inFlight: 0, turnsDone: 0 }),
        callTimeoutMs: 5
      })
    ).rejects.toThrow('install smoke observer')
    expect(runInNewContext(late, { window })).toBe('install_cancelled')
    expect(window.__TASKWRAITH_PERF_SMOKE__).toBeUndefined()
  })
  it.each(['api_unavailable', 'install_failed', 'installed_for_other_chats', 'already_installed'])(
    'refuses %s before send and awaits cleanup',
    async (installed) => {
      const evaluated: string[] = []
      let cleaned = false
      await expect(
        live.runLiveSmokeRound({
          page: {
            evaluate: async (expression: string) => {
              evaluated.push(expression)
              if (expression.includes('function installLaneObserverInPage')) return installed
              if (expression.includes('function uninstallLaneObserverInPage')) {
                await Promise.resolve()
                cleaned = true
                return 'uninstalled'
              }
              throw new Error('Send must not run')
            }
          },
          chatId: 'smoke',
          prompt: 'p',
          readDaemonState: async () => ({ inFlight: 0, turnsDone: 0 })
        })
      ).rejects.toThrow('installation refused')
      expect(cleaned).toBe(true)
      expect(
        evaluated.some((expression) => expression.includes('window.api.runEnsembleRound'))
      ).toBe(false)
    }
  )
  it.each(['completed', 'missing', 'censored', 'wrong-id'])(
    'observes compact deliveries without getChat: %s',
    async (mode) => {
      let updated: any
      let removed = 0
      let now = 0
      const window: any = {
        api: {
          getChat: () => {
            throw new Error('source_changed')
          },
          onChatUpdated: (listener: any) => {
            updated = listener
            return () => {
              removed++
            }
          },
          onChatUpdateInvalidated: () => () => {
            removed++
          },
          getMainPerfSnapshot: () => ({ sections: {} }),
          runEnsembleRound: () => {
            if (mode !== 'missing') {
              updated({
                chatId: 'chat-smoke',
                kind: 'snapshot',
                chat: {
                  ensemble: {
                    activeRound: {
                      roundId: mode === 'wrong-id' ? 'foreign' : 'accepted',
                      status: 'completed'
                    }
                  }
                }
              })
              if (mode === 'censored') window.__TASKWRAITH_PERF_SMOKE__.faults = 1
            }
            return { status: 'started', roundId: 'accepted' }
          }
        }
      }
      const promise = live.runLiveSmokeRound({
        page: { evaluate: async (expression: string) => runInNewContext(expression, { window }) },
        chatId: 'chat-smoke',
        prompt: 'p',
        readDaemonState: async () => ({ inFlight: 0, turnsDone: 1 }),
        nowMs: () => now,
        sleep: async (ms: number) => {
          now += ms
        },
        timeoutMs: 10,
        pollMs: 5
      })
      if (mode === 'censored') await expect(promise).rejects.toThrow('censored')
      else expect((await promise).outcome).toBe(mode === 'completed' ? 'settled' : 'timeout')
      expect(removed).toBe(2)
      expect(window.__TASKWRAITH_PERF_SMOKE__).toBeUndefined()
    }
  )
  function clock() {
    let now = 1_000
    return {
      nowMs: () => now,
      sleep: async (ms: number) => {
        now += ms
      }
    }
  }

  const CHAT = 'perf-light_beside_large_live-chat-01'

  // A page whose round starts as `start` and then reports `statuses` in turn.
  function roundPage(start: unknown, statuses: string[], d1 = [10, 17]) {
    const evaluated: string[] = []
    let d1Reads = 0
    const page: FakePage = {
      async evaluate(expression) {
        evaluated.push(expression)
        if (expression.includes('function installLaneObserverInPage')) return 'installed'
        if (expression === live.D1_COUNTERS_EXPRESSION) {
          d1Reads += 1
          const appends = d1Reads === 1 ? d1[0] : d1[1]
          return { deferredAppends: appends, unsyncedAppends: 0, normalSaves: appends - 6 }
        }
        if (expression === live.roundStateExpression(CHAT)) {
          const status = statuses.length > 1 ? statuses.shift() : statuses[0]
          return { roundId: 'round-1', status }
        }
        return start
      }
    }
    return { page, evaluated }
  }

  const idleDaemon = (turnsDone: number[]) => {
    const states = turnsDone.map((done) => ({ inFlight: 0, turnsDone: done }))
    return async () => states.shift() ?? { inFlight: 0, turnsDone: turnsDone.at(-1)! }
  }

  it('sends through the page API, waits for main to report the round terminal, and reports the D1 delta', async () => {
    const { page, evaluated } = roundPage({ status: 'started', roundId: 'round-1' }, [
      'running',
      'running',
      'completed'
    ])
    // A stream still open when main reports completed holds the settle back.
    const states = [
      { inFlight: 0, turnsDone: 5 },
      { inFlight: 1, turnsDone: 5 },
      { inFlight: 1, turnsDone: 8 },
      { inFlight: 1, turnsDone: 9 },
      { inFlight: 0, turnsDone: 10 }
    ]
    const result = await live.runLiveSmokeRound({
      page,
      chatId: CHAT,
      prompt: 'measure one live round',
      readDaemonState: async () => states.shift() ?? { inFlight: 0, turnsDone: 10 },
      ...clock()
    })
    expect(evaluated[2]).toBe(
      `Promise.resolve(window.api.runEnsembleRound({"chatId":"${CHAT}","prompt":"measure one live round"}))`
    )
    expect(evaluated).toContain(live.roundStateExpression(CHAT))
    expect(live.roundStateExpression(CHAT)).not.toContain('window.api.getChat')
    expect(result).toMatchObject({
      outcome: 'settled',
      status: 'started',
      roundId: 'round-1',
      roundStatus: 'completed',
      turnsFinished: 5,
      d1: {
        before: { deferredAppends: 10, unsyncedAppends: 0, normalSaves: 4 },
        after: { deferredAppends: 17, unsyncedAppends: 0, normalSaves: 11 },
        delta: { deferredAppends: 7, unsyncedAppends: 0, normalSaves: 7 }
      }
    })
    expect(result.settledAtMs).toEqual(expect.any(Number))
  })

  it.each([
    ['queued by a round still live', { status: 'queued', roundId: 'round-0' }, null],
    ['refused', { status: 'busy' }, null],
    [
      'started again under the previous round id',
      { status: 'started', roundId: 'round-1' },
      'round-1'
    ]
  ])(
    'reports a round %s as not started, without waiting',
    async (_label, start, previousRoundId) => {
      const { page, evaluated } = roundPage(start, ['running'])
      const result = await live.runLiveSmokeRound({
        page,
        chatId: CHAT,
        prompt: 'p',
        previousRoundId,
        readDaemonState: idleDaemon([3, 3]),
        ...clock()
      })
      expect(result).toMatchObject({
        outcome: 'not_started',
        status: (start as { status: string }).status,
        roundStatus: null,
        settledAtMs: null
      })
      expect(evaluated).not.toContain(live.roundStateExpression(CHAT))
    }
  )

  it('never settles on an idle daemon, or on another round, while main still runs this one', async () => {
    const reads: Array<{ roundId: string; status: string }> = [
      { roundId: 'round-0', status: 'completed' },
      { roundId: 'round-1', status: 'running' },
      { roundId: 'round-1', status: 'running' },
      { roundId: 'round-1', status: 'completed' }
    ]
    let roundReads = 0
    const page: FakePage = {
      async evaluate(expression) {
        if (expression.includes('function installLaneObserverInPage')) return 'installed'
        if (expression === live.D1_COUNTERS_EXPRESSION)
          return { deferredAppends: 1, normalSaves: 1 }
        if (expression === live.roundStateExpression(CHAT)) {
          roundReads += 1
          return reads.shift() ?? { roundId: 'round-1', status: 'completed' }
        }
        return { status: 'started', roundId: 'round-1' }
      }
    }
    // The daemon is idle between seats the whole time.
    const result = await live.runLiveSmokeRound({
      page,
      chatId: CHAT,
      prompt: 'p',
      readDaemonState: idleDaemon([0, 3]),
      ...clock()
    })
    expect(roundReads).toBe(4)
    expect(result).toMatchObject({ outcome: 'settled', roundStatus: 'completed', turnsFinished: 3 })
  })

  it('times out a round main never finishes', async () => {
    const { page } = roundPage({ status: 'started', roundId: 'round-1' }, ['running'])
    const result = await live.runLiveSmokeRound({
      page,
      chatId: CHAT,
      prompt: 'p',
      readDaemonState: idleDaemon([0, 0]),
      ...clock(),
      timeoutMs: 5_000
    })
    expect(result).toMatchObject({
      outcome: 'timeout',
      roundStatus: 'running',
      settledAtMs: null
    })
  })

  it('bounds every page call', async () => {
    const page: FakePage = {
      async evaluate(expression) {
        if (expression === live.D1_COUNTERS_EXPRESSION)
          return { deferredAppends: 0, normalSaves: 0 }
        return new Promise(() => undefined)
      }
    }
    await expect(
      live.runLiveSmokeRound({
        page,
        chatId: CHAT,
        prompt: 'p',
        readDaemonState: idleDaemon([0]),
        callTimeoutMs: 20
      })
    ).rejects.toMatchObject({
      code: 'T2_LIVE_PAGE_CALL_TIMEOUT',
      message: expect.stringMatching(/remove smoke observer did not settle within 20 ms/)
    })
    const stalledRead: FakePage = {
      async evaluate(expression) {
        if (expression.includes('function installLaneObserverInPage')) return 'installed'
        if (expression === live.D1_COUNTERS_EXPRESSION)
          return { deferredAppends: 0, normalSaves: 0 }
        if (expression === live.roundStateExpression(CHAT)) return new Promise(() => undefined)
        return { status: 'started', roundId: 'round-1' }
      }
    }
    await expect(
      live.runLiveSmokeRound({
        page: stalledRead,
        chatId: CHAT,
        prompt: 'p',
        readDaemonState: idleDaemon([0]),
        callTimeoutMs: 20
      })
    ).rejects.toMatchObject({
      message: expect.stringMatching(/smoke observer read did not settle/)
    })
    const stalledD1: FakePage = { evaluate: () => new Promise(() => undefined) }
    await expect(
      live.runLiveSmokeRound({
        page: stalledD1,
        chatId: CHAT,
        prompt: 'p',
        readDaemonState: idleDaemon([0]),
        callTimeoutMs: 20
      })
    ).rejects.toMatchObject({ code: 'T2_LIVE_PAGE_CALL_TIMEOUT' })
  })
})

describe('the live-round verdict and sequence', () => {
  const settled = (purpose: string, extra: Record<string, unknown> = {}) => ({
    purpose,
    outcome: 'settled',
    status: 'started',
    roundId: `round-${purpose}`,
    roundStatus: 'completed',
    turnsFinished: 6,
    d1: { delta: { deferredAppends: 4, unsyncedAppends: 0, normalSaves: 3 } },
    ...extra
  })
  const OFF = { barrierDurability: 'off' }
  const ON = { barrierDurability: 'on' }
  const smokeWith = (delta: Record<string, unknown>) => [
    settled('warm_up'),
    settled('smoke', { d1: { delta: { normalSaves: 2, ...delta } } })
  ]

  it('passes only when both rounds completed and the smoke moved both D1 counters', () => {
    expect(live.liveRoundsVerdict([settled('warm_up'), settled('smoke')], OFF)).toEqual({
      ok: true,
      reasons: []
    })
    expect(
      live.liveRoundsVerdict(
        [
          settled('warm_up', { d1: { delta: null } }),
          settled('smoke', { roundStatus: 'failed', turnsFinished: 0, d1: { delta: null } })
        ],
        OFF
      )
    ).toEqual({
      ok: false,
      reasons: [
        'smoke: round ended failed',
        'smoke: no scripted turn finished',
        'smoke: D1 counters unavailable'
      ]
    })
    expect(
      live.liveRoundsVerdict(smokeWith({ deferredAppends: 0, unsyncedAppends: 0 }), OFF).reasons
    ).toEqual(['smoke: no deferred journal append'])
    expect(
      live.liveRoundsVerdict(
        [
          settled('warm_up'),
          settled('smoke', {
            d1: { delta: { deferredAppends: 1, unsyncedAppends: 0, normalSaves: 0 } }
          })
        ],
        OFF
      ).reasons
    ).toEqual(['smoke: no normal-boundary save'])
    expect(
      live.liveRoundsVerdict(
        [{ purpose: 'warm_up', outcome: 'not_started', status: 'queued', turnsFinished: 0 }],
        OFF
      ).reasons
    ).toEqual(['warm_up: not started (main answered queued)', 'smoke: not sent'])
    expect(
      live.liveRoundsVerdict([settled('warm_up', { outcome: 'timeout' })], OFF).reasons
    ).toEqual(['warm_up: timeout', 'smoke: not sent'])
  })

  it('judges the smoke on the journal path its run pinned, and on no other', () => {
    // Off: deferred appends, and not one unsynced append.
    expect(
      live.liveRoundsVerdict(smokeWith({ deferredAppends: 3, unsyncedAppends: 1 }), OFF).reasons
    ).toEqual(['smoke: unsynced journal appends with barrier durability off'])
    expect(live.liveRoundsVerdict(smokeWith({ deferredAppends: 3 }), OFF).reasons).toEqual([
      'smoke: unsynced journal appends not counted'
    ])
    // On: unsynced appends, and not one deferred append.
    expect(
      live.liveRoundsVerdict(smokeWith({ deferredAppends: 0, unsyncedAppends: 5 }), ON)
    ).toEqual({ ok: true, reasons: [] })
    expect(
      live.liveRoundsVerdict(smokeWith({ deferredAppends: 0, unsyncedAppends: 0 }), ON).reasons
    ).toEqual(['smoke: no unsynced journal append'])
    expect(
      live.liveRoundsVerdict(smokeWith({ deferredAppends: 2, unsyncedAppends: 5 }), ON).reasons
    ).toEqual(['smoke: deferred journal appends with barrier durability on'])
    expect(live.liveRoundsVerdict(smokeWith({ deferredAppends: 0 }), ON).reasons).toEqual([
      'smoke: unsynced journal appends not counted'
    ])
    // A switch-off smoke is not a switch-on one, nor the other way round.
    expect(
      live.liveRoundsVerdict(smokeWith({ deferredAppends: 4, unsyncedAppends: 0 }), ON).reasons
    ).toEqual([
      'smoke: no unsynced journal append',
      'smoke: deferred journal appends with barrier durability on'
    ])
    // A verdict that does not know the pin is no verdict.
    for (const options of [undefined, {}, { barrierDurability: true }]) {
      expect(() => live.liveRoundsVerdict(smokeWith({}), options)).toThrow(
        "barrier durability must be pinned 'on' or 'off'"
      )
    }
  })

  it('sends the smoke only after the warm-up settled, naming the warm-up round as previous', async () => {
    const calls: Array<Record<string, unknown>> = []
    const roundOptions = { page: 'page', chatId: 'chat-1' }
    const run = (outcomes: string[]) =>
      live.runLiveRoundSequence({
        roundOptions,
        barrierDurability: 'off',
        runRound: async (options: Record<string, unknown>) => {
          calls.push(options)
          const purpose = calls.length === 1 ? 'warm_up' : 'smoke'
          return { ...settled(purpose), outcome: outcomes[calls.length - 1], purpose: undefined }
        }
      })

    const passing = await run(['settled', 'settled'])
    expect(passing.verdict).toEqual({ ok: true, reasons: [] })
    expect(passing.rounds.map((round) => round.purpose)).toEqual(['warm_up', 'smoke'])
    expect(calls).toEqual([
      { ...roundOptions, prompt: 'M1 live warm_up round: answer briefly.', previousRoundId: null },
      {
        ...roundOptions,
        prompt: 'M1 live smoke round: answer briefly.',
        previousRoundId: 'round-warm_up'
      }
    ])

    // Named once, so whoever finds a send again by its text asks for the same.
    expect(calls.map((call) => call.prompt)).toEqual(
      ['warm_up', 'smoke'].map((purpose) => live.liveRoundPrompt(purpose))
    )

    calls.length = 0
    const stuck = await run(['timeout'])
    expect(calls).toHaveLength(1)
    expect(stuck.verdict).toEqual({
      ok: false,
      reasons: ['warm_up: timeout', 'smoke: not sent']
    })

    // Without the run's pin it sends nothing.
    calls.length = 0
    await expect(
      live.runLiveRoundSequence({
        roundOptions,
        runRound: async (options: Record<string, unknown>) => {
          calls.push(options)
          return settled('warm_up')
        }
      })
    ).rejects.toThrow("barrier durability must be pinned 'on' or 'off'")
    expect(calls).toEqual([])
  })
})

describe('the D1 counters a round or window moved', () => {
  it('counts each between two reads, the unsynced appends only where both reads counted them', () => {
    const read = (
      deferredAppends: number,
      unsyncedAppends: number | null,
      normalSaves: number
    ) => ({
      deferredAppends,
      unsyncedAppends,
      normalSaves
    })
    expect(live.d1Delta(read(2, 5, 1), read(9, 8, 4))).toEqual({
      deferredAppends: 7,
      unsyncedAppends: 3,
      normalSaves: 3
    })
    for (const [before, after] of [
      [read(2, null, 1), read(9, 8, 4)],
      [read(2, 5, 1), read(9, null, 4)]
    ]) {
      expect(live.d1Delta(before, after)).toMatchObject({ unsyncedAppends: null })
    }
    expect(live.d1Delta(null, read(9, 8, 4))).toBeNull()
  })
})

describe('a measured window’s journal path', () => {
  const section = (enabled: boolean) => ({ ok: true, section: { enabled, ignored: null } })
  const judge = (input: Record<string, unknown>) =>
    live.windowJournalPathReasons({
      d1: { deferredAppends: 9, unsyncedAppends: 0, normalSaves: 3 },
      barrierBefore: section(false),
      barrierAfter: section(false),
      barrierDurability: 'off',
      ...input
    })
  const on = { barrierBefore: section(true), barrierAfter: section(true), barrierDurability: 'on' }

  it('takes the path from main’s barrier section at both fences, as the run pinned it', () => {
    expect(judge({})).toEqual([])
    expect(
      judge({ ...on, d1: { deferredAppends: 0, unsyncedAppends: 7, normalSaves: 3 } })
    ).toEqual([])
    expect(judge({ d1: { deferredAppends: 0, unsyncedAppends: 0, normalSaves: 3 } })).toEqual([
      'd1_no_deferred_append'
    ])
    expect(judge({ d1: { deferredAppends: 9, unsyncedAppends: 2, normalSaves: 3 } })).toEqual([
      'd1_unsynced_append'
    ])
    expect(judge({ d1: { deferredAppends: 9, unsyncedAppends: null, normalSaves: 3 } })).toEqual([
      'd1_unsynced_appends_uncounted'
    ])
    expect(
      judge({ ...on, d1: { deferredAppends: 0, unsyncedAppends: 0, normalSaves: 3 } })
    ).toEqual(['d1_no_unsynced_append'])
    expect(
      judge({ ...on, d1: { deferredAppends: 1, unsyncedAppends: 7, normalSaves: 3 } })
    ).toEqual(['d1_deferred_append'])
    expect(judge({ d1: null })).toEqual(['d1_counters_unavailable'])
  })

  it('fails a window whose section says other than the pin, or cannot say', () => {
    // Pinned on, and main ran with it off: a failed capture, not a skipped gate.
    expect(judge({ barrierDurability: 'on' })).toEqual(['barrier_switch_off_in_main'])
    expect(judge({ barrierBefore: section(true), barrierAfter: section(true) })).toEqual([
      'barrier_switch_on_in_main'
    ])
    for (const [barrierBefore, barrierAfter] of [
      [null, section(false)],
      [section(false), { ok: false, reason: 'read_failed' }],
      [
        { ok: false, reason: 'section_absent' },
        { ok: false, reason: 'section_absent' }
      ],
      [section(false), section(true)],
      [section(false), { ok: true, section: { enabled: 'yes' } }],
      [
        { ok: true, section: { enabled: 'yes' } },
        { ok: true, section: { enabled: 'yes' } }
      ],
      [section(false), { ok: false, section: { enabled: false } }]
    ]) {
      expect(judge({ barrierBefore, barrierAfter })).toEqual(['d1_path_unconfirmed'])
    }
    expect(() => judge({ barrierDurability: undefined })).toThrow(
      "barrier durability must be pinned 'on' or 'off'"
    )
  })
})

describe('the daemon stop', () => {
  it('fails cleanup for a daemon that was killed, crashed, or wrote no summary', () => {
    const summary = { schemaVersion: 1 }
    expect(
      live.daemonStopFailures({ exit: { code: 0, signal: null }, forced: false, summary })
    ).toEqual([])
    expect(
      live.daemonStopFailures({ exit: { code: null, signal: 'SIGKILL' }, forced: true, summary })
    ).toEqual(['scripted Ollama daemon ignored SIGTERM and was killed'])
    expect(
      live.daemonStopFailures({ exit: { code: 1, signal: null }, forced: false, summary: null })
    ).toEqual([
      'scripted Ollama daemon exited with code 1 (signal null)',
      'scripted Ollama daemon wrote no summary'
    ])
    expect(live.daemonStopFailures(undefined)).toEqual([
      'scripted Ollama daemon stop returned nothing'
    ])
  })

  it('fails a passing verdict when the daemon did not stop cleanly', () => {
    const passing = { ok: true, reasons: [] }
    expect(live.withDaemonStopFailures(passing, [])).toBe(passing)
    expect(live.withDaemonStopFailures(undefined, ['x'])).toBeUndefined()
    expect(
      live.withDaemonStopFailures({ ok: false, reasons: ['smoke: timeout'] }, [
        'scripted Ollama daemon wrote no summary'
      ])
    ).toEqual({
      ok: false,
      reasons: ['smoke: timeout', 'daemon: scripted Ollama daemon wrote no summary']
    })
  })
})

describe('the run result', () => {
  it('is not ok only when a live-round verdict failed', () => {
    expect(live.t2RunOk({})).toBe(true)
    expect(live.t2RunOk({ liveRounds: { daemon: {} } })).toBe(true)
    expect(live.t2RunOk({ liveRounds: { verdict: { ok: true, reasons: [] } } })).toBe(true)
    expect(live.t2RunOk({ liveRounds: { verdict: { ok: false, reasons: ['x'] } } })).toBe(false)
  })
})

describe('the scripted daemon as the runner child', () => {
  function fakeChild(pid: number) {
    const child = new EventEmitter() as EventEmitter & {
      pid: number
      stderr: EventEmitter
      killed: string[]
      kill(signal: string): void
    }
    child.pid = pid
    child.stderr = new EventEmitter()
    child.killed = []
    child.kill = (signal: string) => {
      child.killed.push(signal)
      queueMicrotask(() => child.emit('exit', null, signal))
    }
    return child
  }

  it('refuses a ready file that names another process, and kills its child', async () => {
    const dir = temporaryDirectory()
    const child = fakeChild(4242)
    await expect(
      live.startScriptedDaemonChild({
        dir,
        config: { seed: 1 },
        spawn: () => {
          writeFileSync(
            join(dir, 'scripted-ollama-ready.json'),
            JSON.stringify({ pid: 9999, port: 1, baseUrl: 'http://127.0.0.1:1' })
          )
          return child
        }
      })
    ).rejects.toMatchObject({ code: 'T2_LIVE_DAEMON_READY_MISMATCH' })
    expect(child.killed).toEqual(['SIGKILL'])
  })

  it('reports a daemon that exits before it is ready', async () => {
    const child = fakeChild(4243)
    await expect(
      live.startScriptedDaemonChild({
        dir: temporaryDirectory(),
        config: { seed: 1 },
        spawn: () => {
          queueMicrotask(() => child.emit('exit', 1, null))
          return child
        }
      })
    ).rejects.toMatchObject({ code: 'T2_LIVE_DAEMON_EXITED' })
  })

  it('leaves no timer behind once a stopped daemon exits', async () => {
    vi.useFakeTimers()
    try {
      const dir = temporaryDirectory()
      const child = fakeChild(4244)
      const daemon = await live.startScriptedDaemonChild({
        dir,
        config: { seed: 1 },
        spawn: () => {
          writeFileSync(
            join(dir, 'scripted-ollama-ready.json'),
            JSON.stringify({ pid: 4244, port: 1, baseUrl: 'http://127.0.0.1:1' })
          )
          return child
        }
      })
      const stopped = await daemon.stop()
      expect(stopped).toMatchObject({ forced: false, exit: { code: null, signal: 'SIGTERM' } })
      expect(child.killed).toEqual(['SIGTERM'])
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('starts the real daemon, serves its address, and stops it for a summary', async () => {
    const daemon = await live.startScriptedDaemonChild({
      dir: temporaryDirectory(),
      config: { seed: 3 }
    })
    try {
      expect(daemon.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
      expect((await fetch(`${daemon.baseUrl}/api/tags`)).status).toBe(200)
    } finally {
      const stopped = await daemon.stop()
      expect(stopped.exit).toEqual({ code: 0, signal: null })
      expect(stopped.forced).toBe(false)
      expect(stopped.summary?.requestCounts['GET /api/tags']).toBe(1)
    }
  })
})
