import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { runOllamaProvider, type OllamaProviderDeps } from '../../src/main/ollama/OllamaProvider'
import type { AgentRunPayload, AgentRunRoute } from '../../src/main/run/AgentRunTypes'

const require = createRequire(import.meta.url)
const daemonModule = require('./scriptedOllamaDaemon.cjs') as {
  DEFAULT_MODEL: { name: string }
  MIN_TURN_CHARS: number
  createScriptedOllamaDaemon: (options: Record<string, unknown>) => ScriptedDaemon
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
const temporaryPaths: string[] = []

async function openDaemon(options: Record<string, unknown> = {}) {
  const daemon = daemonModule.createScriptedOllamaDaemon({ seed: 7, shape: SHAPE, ...options })
  opened.push(daemon)
  return { daemon, ...(await daemon.listen()) }
}

afterEach(async () => {
  vi.restoreAllMocks()
  while (opened.length > 0) await opened.pop()!.close()
  while (temporaryPaths.length > 0) rmSync(temporaryPaths.pop()!, { recursive: true, force: true })
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
  it('publishes its address when ready and writes its turn record on SIGTERM', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'scripted-ollama-'))
    temporaryPaths.push(dir)
    const config = join(dir, 'config.json')
    const ready = join(dir, 'ready.json')
    const summaryFile = join(dir, 'summary.json')
    writeFileSync(config, JSON.stringify({ seed: 3, shape: SHAPE }))
    const child = spawn(
      process.execPath,
      [DAEMON_PATH, `--config=${config}`, `--ready-file=${ready}`, `--summary-file=${summaryFile}`],
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
  })

  it('stops for its summary when its stdin closes, as when its runner dies', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'scripted-ollama-'))
    temporaryPaths.push(dir)
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
