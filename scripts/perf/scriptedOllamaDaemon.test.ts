import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { runOllamaProvider, type OllamaProviderDeps } from '../../src/main/ollama/OllamaProvider'
import type { AgentRunPayload, AgentRunRoute } from '../../src/main/run/AgentRunTypes'

const require = createRequire(import.meta.url)
const daemonModule = require('./scriptedOllamaDaemon.cjs') as {
  DEFAULT_MODEL: { name: string }
  MIN_TURN_CHARS: number
  createScriptedOllamaDaemon: (options: Record<string, unknown>) => ScriptedDaemon
  scriptedActivity: (
    turns: Array<Record<string, unknown>>,
    model: string,
    fromMs: number,
    toMs: number,
    nowMs: number
  ) => Record<string, unknown>
  scriptedTurnsIn: (
    turns: Array<Record<string, unknown>>,
    fromMs: number,
    toMs: number
  ) => Array<Record<string, unknown>>
  scriptedTurnPaceMs: (shape?: Record<string, unknown>) => number
  scriptedTurnChunks: (options: {
    seed: number
    model: string
    turnIndex: number
    shape: { chunksPerTurn: number; chunkBytes: number; chunkIntervalMs: number }
  }) => string[]
}
const DAEMON_PATH = join(__dirname, 'scriptedOllamaDaemon.cjs')

type ScriptedTurn = {
  model: string
  turnIndex: number
  chunks: number
  contentBytes: number
  sha256: string | null
  endedAtMs: number | null
  outcome: string
}

type ScriptedDaemon = {
  listen(port?: number): Promise<{ port: number; baseUrl: string }>
  close(): Promise<void>
  turns(): ScriptedTurn[]
  requestCounts(): Record<string, number>
  state(): { inFlight: number; turnsDone: number; turnsStarted: number }
}

// 13 x 32 = 416 characters: the shortest turn the daemon scripts.
const SHAPE = { chunksPerTurn: 13, chunkBytes: 32, chunkIntervalMs: 0 }
const SLOW_SHAPE = { chunksPerTurn: 50, chunkBytes: 16, chunkIntervalMs: 20 }
const MODEL = daemonModule.DEFAULT_MODEL.name
const opened: ScriptedDaemon[] = []
/** Every directory this file makes is named so, directly in the temporary folder. */
const MADE_PREFIX = 'harness-scripted-ollama-'
const made: string[] = []

/** A fresh directory of this file's own, removed after the test. */
function makeDirectory(): string {
  const dir = mkdtempSync(join(tmpdir(), MADE_PREFIX))
  made.push(dir)
  return dir
}

/** Removes a directory only when it is one this file made: never the folder above it. */
function removeMade(dir: string) {
  const root = tmpdir()
  if (dir === root || resolve(dir) !== dir || !dir.startsWith(root + sep + MADE_PREFIX)) {
    throw new Error(`refusing to remove ${dir}: not a directory this file made`)
  }
  rmSync(dir, { recursive: true, force: true })
}

async function openDaemon(options: Record<string, unknown> = {}) {
  const daemon = daemonModule.createScriptedOllamaDaemon({ seed: 7, shape: SHAPE, ...options })
  opened.push(daemon)
  return { daemon, ...(await daemon.listen()) }
}

afterEach(async () => {
  vi.restoreAllMocks()
  while (opened.length > 0) await opened.pop()!.close()
  while (made.length > 0) removeMade(made.pop()!)
})

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

describe('scripted Ollama daemon', () => {
  it('binds loopback only and refuses unknown faults', () => {
    expect(() => daemonModule.createScriptedOllamaDaemon({ seed: 1, host: '0.0.0.0' })).toThrow(
      /127\.0\.0\.1 only/
    )
    expect(() => daemonModule.createScriptedOllamaDaemon({ seed: 1, fault: 'slow' })).toThrow(
      /unknown fault/
    )
  })

  it('scripts the same prose for a seed, tag and turn, and different prose per turn', () => {
    const turn = (turnIndex: number, seed = 7) =>
      daemonModule.scriptedTurnChunks({ seed, model: MODEL, turnIndex, shape: SHAPE })
    expect(turn(0)).toEqual(turn(0))
    expect(turn(0)).toHaveLength(SHAPE.chunksPerTurn)
    expect(turn(0).every((chunk) => chunk.length === SHAPE.chunkBytes)).toBe(true)
    expect(turn(0).join('')).toMatch(/^[a-z .]+$/)
    expect(turn(1)).not.toEqual(turn(0))
    expect(turn(0, 8)).not.toEqual(turn(0))
  })

  it('answers the status surface signed out, Cloud disabled, and 404s unknown models', async () => {
    const { baseUrl } = await openDaemon()
    const tags = await (await fetch(`${baseUrl}/api/tags`)).json()
    expect(tags.models).toEqual([
      expect.objectContaining({ name: MODEL, model: MODEL, capabilities: ['completion', 'tools'] })
    ])
    expect(await (await fetch(`${baseUrl}/api/status`)).json()).toEqual({
      cloud: { disabled: true, source: 'config' }
    })
    expect((await fetch(`${baseUrl}/api/me`, { method: 'POST' })).status).toBe(401)
    const show = await fetch(`${baseUrl}/api/show`, {
      method: 'POST',
      body: JSON.stringify({ model: MODEL })
    })
    expect(await show.json()).toMatchObject({
      model_info: { 'llama.context_length': 32768 },
      capabilities: ['completion', 'tools']
    })
    const missing = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      body: JSON.stringify({ model: 'absent:latest', stream: true })
    })
    expect(missing.status).toBe(404)
    expect((await fetch(`${baseUrl}/api/experimental/model-recommendations`)).status).toBe(404)
  })

  it('refuses a turn short enough for main to read as a stub, even once trimmed', () => {
    expect(daemonModule.MIN_TURN_CHARS).toBe(402)
    const shape = (chunksPerTurn: number, chunkBytes: number) => ({
      seed: 1,
      shape: { chunksPerTurn, chunkBytes, chunkIntervalMs: 0 }
    })
    expect(() => daemonModule.createScriptedOllamaDaemon(shape(4, 100))).toThrow(
      /at least 402 characters/
    )
    expect(() => daemonModule.createScriptedOllamaDaemon(shape(1, 401))).toThrow(
      /at least 402 characters/
    )
    expect(() => daemonModule.createScriptedOllamaDaemon(shape(1, 402))).not.toThrow()
  })

  it('records a turn the client abandons mid-stream as aborted, not done', async () => {
    const { daemon, baseUrl } = await openDaemon({ shape: SLOW_SHAPE })
    const controller = new AbortController()
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      body: JSON.stringify({ model: MODEL, stream: true }),
      signal: controller.signal
    })
    const reader = response.body!.getReader()
    await reader.read()
    controller.abort()
    await reader.cancel().catch(() => undefined)
    const deadline = Date.now() + 5_000
    while (daemon.turns()[0]?.outcome === 'streaming' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    const [turn] = daemon.turns()
    expect(turn).toMatchObject({ outcome: 'aborted' })
    expect(turn!.chunks).toBeGreaterThan(0)
    expect(turn!.chunks).toBeLessThan(50)
  })

  it('ends an open stream as aborted, with the hash of what it sent, before close resolves', async () => {
    const { daemon, baseUrl } = await openDaemon({ shape: SLOW_SHAPE })
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      body: JSON.stringify({ model: MODEL, stream: true })
    })
    const reader = response.body!.getReader()
    await reader.read()
    await daemon.close()
    await reader.cancel().catch(() => undefined)
    const [turn] = daemon.turns()
    expect(turn).toMatchObject({ outcome: 'aborted', endedAtMs: expect.any(Number) })
    expect(turn!.chunks).toBeGreaterThan(0)
    expect(turn!.chunks).toBeLessThan(SLOW_SHAPE.chunksPerTurn)
    const sent = daemonModule
      .scriptedTurnChunks({ seed: 7, model: MODEL, turnIndex: 0, shape: SLOW_SHAPE })
      .slice(0, turn!.chunks)
      .join('')
    expect(turn!.sha256).toBe(sha256(sent))
    // An aborted turn never reads as a finished one.
    expect(daemon.state()).toEqual({ inFlight: 0, turnsDone: 0, turnsStarted: 1 })
  })

  it('closes while a request body is still arriving', async () => {
    const { daemon, port } = await openDaemon()
    const socket = connect(port, '127.0.0.1')
    socket.on('error', () => undefined)
    await new Promise((resolve) => socket.once('connect', resolve))
    socket.write('POST /api/chat HTTP/1.1\r\nHost: x\r\nContent-Length: 100\r\n\r\n{"model":')
    const deadline = Date.now() + 5_000
    while (!daemon.requestCounts()['POST /api/chat'] && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    const closed = await Promise.race([
      daemon.close().then(() => 'closed'),
      new Promise((resolve) => setTimeout(() => resolve('still waiting'), 2_000))
    ])
    socket.destroy()
    expect(closed).toBe('closed')
    expect(daemon.turns()).toEqual([])
  })

  it('serves live counts to the harness without counting its own route', async () => {
    const { daemon, baseUrl } = await openDaemon({ shape: SLOW_SHAPE })
    const state = async () => (await fetch(`${baseUrl}/_scripted/state`)).json()
    await expect(state()).resolves.toEqual({ inFlight: 0, turnsDone: 0, turnsStarted: 0 })
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      body: JSON.stringify({ model: MODEL, stream: true })
    })
    const reader = response.body!.getReader()
    await reader.read()
    await expect(state()).resolves.toEqual({ inFlight: 1, turnsDone: 0, turnsStarted: 1 })
    while (!(await reader.read()).done) {
      // Drain the turn.
    }
    await expect(state()).resolves.toEqual({ inFlight: 0, turnsDone: 1, turnsStarted: 1 })
    expect(daemon.requestCounts()).toEqual({ 'POST /api/chat': 1 })
  })
})

describe('scripted Ollama daemon activity per tag', () => {
  const turn = (
    model: string,
    startedAtMs: number,
    endedAtMs: number | null,
    outcome = 'done'
  ) => ({
    model,
    startedAtMs,
    endedAtMs,
    outcome
  })

  it('counts one tag’s turns started in the range, their completions, and the gaps', () => {
    const turns = [
      turn('light:latest', 900, 1_100),
      turn('heavy:latest', 1_000, 1_500),
      turn('heavy:latest', 1_400, 2_000),
      turn('heavy:latest', 2_000, 2_000, 'aborted'),
      turn('heavy:latest', 2_600, 3_100),
      turn('heavy:latest', 3_900, null, 'streaming')
    ]
    expect(daemonModule.scriptedActivity(turns, 'heavy:latest', 1_000, 4_000, 4_200)).toEqual({
      model: 'heavy:latest',
      fromMs: 1_000,
      toMs: 4_000,
      started: 5,
      done: 3,
      // Overlapping turns count once; the one still streaming runs to the end.
      busyMs: 1_000 + 500 + 100,
      maxQuietMs: 800
    })
    // The light tag's turn began before the range: it covers, but did not start, in it.
    expect(daemonModule.scriptedActivity(turns, 'light:latest', 1_000, 4_000, 4_200)).toEqual({
      model: 'light:latest',
      fromMs: 1_000,
      toMs: 4_000,
      started: 0,
      done: 0,
      busyMs: 100,
      maxQuietMs: 2_900
    })
    // The fold does not rely on the turns arriving in start order.
    expect(
      daemonModule.scriptedActivity([...turns].reverse(), 'heavy:latest', 1_000, 4_000, 4_200)
    ).toEqual(daemonModule.scriptedActivity(turns, 'heavy:latest', 1_000, 4_000, 4_200))
  })

  it('takes the range as start-inclusive and end-exclusive, and splits quiet at an instant turn', () => {
    const turns = [
      turn('m:latest', 1_000, 1_000),
      turn('m:latest', 5_000, 6_000),
      turn('m:latest', 999, 999)
    ]
    expect(daemonModule.scriptedActivity(turns, 'm:latest', 1_000, 5_000, 9_000)).toEqual({
      model: 'm:latest',
      fromMs: 1_000,
      toMs: 5_000,
      started: 1,
      done: 1,
      busyMs: 0,
      maxQuietMs: 4_000
    })
    expect(
      daemonModule.scriptedActivity(
        [turn('m:latest', 3_000, 3_000)],
        'm:latest',
        1_000,
        5_000,
        9_000
      )
    ).toMatchObject({ started: 1, busyMs: 0, maxQuietMs: 2_000 })
    expect(daemonModule.scriptedActivity([], 'm:latest', 1_000, 5_000, 9_000)).toMatchObject({
      started: 0,
      done: 0,
      busyMs: 0,
      maxQuietMs: 4_000
    })
  })

  it('answers the harness over its own route, uncounted, and refuses a bad query', async () => {
    const { daemon, baseUrl } = await openDaemon()
    const fromMs = Date.now() - 1_000
    await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      body: JSON.stringify({ model: MODEL, stream: true })
    }).then((response) => response.text())
    // The range is end-exclusive: close it after the turn's start millisecond.
    await new Promise((resolve) => setTimeout(resolve, 5))
    const toMs = Date.now()
    const activity = await fetch(
      `${baseUrl}/_scripted/activity?model=${encodeURIComponent(MODEL)}&from=${fromMs}&to=${toMs}`
    )
    expect(activity.status).toBe(200)
    await expect(activity.json()).resolves.toMatchObject({
      model: MODEL,
      fromMs,
      toMs,
      started: 1,
      done: 1
    })
    const status = async (query: string) =>
      (await fetch(`${baseUrl}/_scripted/activity?${query}`)).status
    expect(await status(`model=other:latest&from=1&to=2`)).toBe(404)
    for (const query of [
      `model=${MODEL}&from=1`,
      `model=${MODEL}&to=2`,
      `model=${MODEL}&from=2&to=2`,
      `model=${MODEL}&from=3&to=2`,
      `model=${MODEL}&from=-1&to=2`,
      `model=${MODEL}&from=1.5&to=2`,
      `model=${MODEL}&from=&to=2`,
      `model=${MODEL}&from=0x10&to=20`,
      // A range that has not closed yet would read its future as quiet.
      `model=${MODEL}&from=1&to=${Date.now() + 60_000}`
    ]) {
      expect(await status(query)).toBe(400)
    }
    expect(daemon.requestCounts()).toEqual({ 'POST /api/chat': 1 })
  })
})

describe('scripted Ollama daemon turns across tags', () => {
  const turn = (
    model: string,
    startedAtMs: number,
    endedAtMs: number | null,
    outcome = 'done'
  ) => ({
    model,
    turnIndex: 0,
    chunks: 13,
    contentBytes: 416,
    sha256: 'not sent',
    startedAtMs,
    endedAtMs,
    outcome
  })

  it('lists every tag’s turns that were streaming inside the range, in start order', () => {
    const turns = [
      turn('b:latest', 3_000, null, 'streaming'),
      turn('a:latest', 500, 999),
      turn('a:latest', 900, 1_000),
      turn('b:latest', 1_200, 2_800),
      turn('a:latest', 2_000, 2_000, 'aborted'),
      turn('a:latest', 3_999, 4_500),
      turn('b:latest', 4_000, 4_100)
    ]
    // Ended before the range, or began at its end or later: not in it.
    expect(daemonModule.scriptedTurnsIn(turns, 1_000, 4_000)).toEqual([
      { model: 'a:latest', startedAtMs: 900, endedAtMs: 1_000, outcome: 'done' },
      { model: 'b:latest', startedAtMs: 1_200, endedAtMs: 2_800, outcome: 'done' },
      { model: 'a:latest', startedAtMs: 2_000, endedAtMs: 2_000, outcome: 'aborted' },
      { model: 'b:latest', startedAtMs: 3_000, endedAtMs: null, outcome: 'streaming' },
      { model: 'a:latest', startedAtMs: 3_999, endedAtMs: 4_500, outcome: 'done' }
    ])
    expect(daemonModule.scriptedTurnsIn([], 1_000, 4_000)).toEqual([])
  })

  it('answers the harness over its own route, uncounted, and refuses a bad query', async () => {
    const { daemon, baseUrl } = await openDaemon({
      models: [{ name: MODEL }, { name: 'scripted-llama:t001' }]
    })
    const fromMs = Date.now() - 1_000
    for (const model of [MODEL, 'scripted-llama:t001']) {
      await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        body: JSON.stringify({ model, stream: true })
      }).then((response) => response.text())
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
    const toMs = Date.now()
    const answer = await fetch(`${baseUrl}/_scripted/turns?from=${fromMs}&to=${toMs}`)
    expect(answer.status).toBe(200)
    const body = (await answer.json()) as { turns: Array<Record<string, unknown>> }
    expect(body).toMatchObject({ fromMs, toMs })
    expect(body.turns.map((entry) => [entry.model, entry.outcome])).toEqual([
      [MODEL, 'done'],
      ['scripted-llama:t001', 'done']
    ])
    // What was streamed stays with the daemon: a turn travels as its times.
    expect(Object.keys(body.turns[0]).sort()).toEqual([
      'endedAtMs',
      'model',
      'outcome',
      'startedAtMs'
    ])
    // A range that begins after both turns had ended has neither.
    const later = await fetch(`${baseUrl}/_scripted/turns?from=${toMs - 2}&to=${toMs}`)
    expect(await later.json()).toEqual({ fromMs: toMs - 2, toMs, turns: [] })
    const status = async (query: string) =>
      (await fetch(`${baseUrl}/_scripted/turns?${query}`)).status
    for (const query of [
      'from=1',
      'to=2',
      'from=2&to=2',
      'from=3&to=2',
      'from=-1&to=2',
      'from=1.5&to=2',
      // A range that has not closed yet is still gaining turns.
      `from=1&to=${Date.now() + 60_000}`
    ]) {
      expect(await status(query)).toBe(400)
    }
    expect(daemon.requestCounts()).toEqual({ 'POST /api/chat': 2 })
  })
})

describe('the scripted model’s own pace', () => {
  it('is a turn’s chunks times the wait after each, by default 1.6 s', () => {
    expect(daemonModule.scriptedTurnPaceMs()).toBe(1_600)
    expect(daemonModule.scriptedTurnPaceMs({ chunksPerTurn: 100, chunkIntervalMs: 10 })).toBe(1_000)
    expect(daemonModule.scriptedTurnPaceMs({ chunkIntervalMs: 40 })).toBe(2_560)
  })

  it('refuses a shape the daemon would refuse', () => {
    expect(() => daemonModule.scriptedTurnPaceMs({ chunksPerTurn: 0 })).toThrow(/chunksPerTurn/)
  })
})

describe('scripted Ollama daemon against the production adapter', () => {
  const route: AgentRunRoute = { appRunId: 'run-scripted-1', appChatId: 'chat-scripted-1' }
  const payload: AgentRunPayload = {
    provider: 'ollama',
    scope: 'global',
    prompt: 'measure one scripted turn',
    model: MODEL,
    appRunId: 'run-scripted-1',
    appChatId: 'chat-scripted-1'
  }
  const event = { sender: { send: () => undefined } } as unknown as Electron.IpcMainInvokeEvent

  function productionDeps(baseUrl: string) {
    const lines: Array<{ payload: { type?: string; text?: string } }> = []
    const errors: string[] = []
    const exits: Array<number | null> = []
    const finishes: string[] = []
    const deps = {
      getSettings: () =>
        ({
          ollamaBaseUrl: baseUrl,
          ollamaDefaultModel: MODEL,
          ollamaModelPreflightAt: {},
          agenticServices: { mcpTools: 'allow' },
          codexSandboxFallback: 'read-only'
        }) as never,
      getTotalMemoryBytes: () => 32 * 1024 ** 3,
      getCloudApiKey: () => null,
      markOllamaModelPreflightComplete: vi.fn(),
      sendAgentCompatLine: (_sender: unknown, _provider: string, line: { type?: string }) => {
        lines.push({ payload: line })
      },
      sendAgentCompatError: (_sender: unknown, _provider: string, error: string) => {
        errors.push(error)
      },
      sendAgentCompatExit: (_sender: unknown, _provider: string, code: number | null) => {
        exits.push(code)
      },
      reportWorkingTokenUsage: () => undefined,
      runManager: {
        attachAbortController: vi.fn(),
        canAdmitTransport: vi.fn(() => true),
        getClaimedTerminalStatus: vi.fn(() => undefined),
        finish: (_runId: string | undefined, status: string) => {
          finishes.push(status)
          return undefined
        },
        confirmTerminalStatus: vi.fn()
      },
      emitProviderCapabilityWarnings: vi.fn(async () => undefined),
      getOllamaSessionMemory: vi.fn(),
      saveOllamaSessionMemory: vi.fn()
    } as unknown as OllamaProviderDeps
    return { deps, lines, errors, exits, finishes }
  }

  it('streams one scripted turn through runOllamaProvider byte for byte', async () => {
    const { daemon, baseUrl } = await openDaemon()
    const { deps, lines, errors, exits } = productionDeps(baseUrl)

    await runOllamaProvider(deps, event, payload, route)

    const received = lines
      .filter((line) => line.payload.type === 'content')
      .map((line) => line.payload.text)
      .join('')
    const expected = daemonModule
      .scriptedTurnChunks({ seed: 7, model: MODEL, turnIndex: 0, shape: SHAPE })
      .join('')
    expect(errors).toEqual([])
    expect(exits.at(-1)).toBe(0)
    expect(received).toBe(expected)
    expect(daemon.turns()).toEqual([
      expect.objectContaining({
        model: MODEL,
        turnIndex: 0,
        chunks: SHAPE.chunksPerTurn,
        contentBytes: expected.length,
        sha256: sha256(received),
        outcome: 'done'
      })
    ])
    // Every route one production turn touches is a known one. Recommendations
    // answer 404, as from a daemon without that experimental endpoint.
    expect(Object.keys(daemon.requestCounts()).sort()).toEqual([
      'GET /api/experimental/model-recommendations',
      'GET /api/status',
      'GET /api/tags',
      'POST /api/chat',
      'POST /api/me',
      'POST /api/show'
    ])
    expect(daemon.requestCounts()['POST /api/chat']).toBe(1)
  })

  it('fails the production turn when the stream ends without its done chunk', async () => {
    const { daemon, baseUrl } = await openDaemon({ fault: 'omit-done' })
    const { deps, errors, exits } = productionDeps(baseUrl)

    await runOllamaProvider(deps, event, payload, route)

    expect(errors.join('\n')).toMatch(/terminal done chunk/)
    expect(exits.at(-1)).not.toBe(0)
    expect(daemon.turns().map((turn) => turn.outcome)).toContain('fault-omit-done')
  })
})

describe('scripted Ollama daemon as a child process', () => {
  it.skipIf(process.platform === 'win32')(
    'publishes its address when ready and writes its turn record on SIGTERM',
    async () => {
      const dir = makeDirectory()
      const config = join(dir, 'config.json')
      const ready = join(dir, 'ready.json')
      const summaryFile = join(dir, 'summary.json')
      writeFileSync(config, JSON.stringify({ seed: 3, shape: SHAPE }))
      const child = spawn(
        process.execPath,
        [
          DAEMON_PATH,
          `--config=${config}`,
          `--ready-file=${ready}`,
          `--summary-file=${summaryFile}`
        ],
        { stdio: ['ignore', 'ignore', 'pipe'] }
      )
      let stderr = ''
      child.stderr.on('data', (part) => {
        stderr += String(part)
      })
      const exited = new Promise<number | null>((resolve) => child.on('exit', resolve))
      try {
        const deadline = Date.now() + 10_000
        while (!existsSync(ready) && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 25))
        }
        const address = JSON.parse(readFileSync(ready, 'utf8'))
        expect(address).toEqual({
          pid: child.pid,
          port: expect.any(Number),
          baseUrl: `http://127.0.0.1:${address.port}`
        })
        expect((await fetch(`${address.baseUrl}/api/tags`)).status).toBe(200)
      } finally {
        child.kill('SIGTERM')
      }
      expect(await exited).toBe(0)
      expect(stderr).toBe('')
      expect(JSON.parse(readFileSync(summaryFile, 'utf8'))).toMatchObject({
        schemaVersion: 1,
        requestCounts: { 'GET /api/tags': 1 },
        turns: []
      })
    }
  )

  it('stops for its summary when its stdin closes, as when its runner dies', async () => {
    const dir = makeDirectory()
    const config = join(dir, 'config.json')
    const ready = join(dir, 'ready.json')
    const summaryFile = join(dir, 'summary.json')
    writeFileSync(config, JSON.stringify({ seed: 3, shape: SHAPE }))
    const child = spawn(
      process.execPath,
      [
        DAEMON_PATH,
        `--config=${config}`,
        `--ready-file=${ready}`,
        `--summary-file=${summaryFile}`,
        '--exit-on-stdin-close'
      ],
      { stdio: ['pipe', 'ignore', 'ignore'] }
    )
    const exited = new Promise<number | null>((resolve) => child.on('exit', resolve))
    try {
      const deadline = Date.now() + 10_000
      while (!existsSync(ready) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      expect(existsSync(ready)).toBe(true)
    } finally {
      child.stdin.end()
    }
    const settled = await Promise.race([
      exited,
      new Promise((resolve) => setTimeout(() => resolve('still running'), 5_000))
    ])
    if (settled === 'still running') child.kill('SIGKILL')
    expect(settled).toBe(0)
    expect(JSON.parse(readFileSync(summaryFile, 'utf8'))).toMatchObject({ turns: [] })
  })
})
