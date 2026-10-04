import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/taskwraith-codex-app-server-stream-pump-test',
    getVersion: () => 'test'
  }
}))

import {
  CodexAppServerClient,
  type CodexAppServerStartupDependencies
} from './CodexAppServerClient'
import type { CodexAppServerProcessLaunchPlan } from './codex/CodexAppServerProcessLaunchPlan'
import {
  COOPERATIVE_STREAM_TURN_BUDGET_MS,
  ORDERED_STREAM_PUMP_HIGH_WATER_ITEMS,
  orderedStreamPumpCounters,
  resetOrderedStreamPumpCountersForTest,
  setOrderedStreamPumpPacingForTest
} from './providers/CooperativeStreamPump'

const launchPlan: CodexAppServerProcessLaunchPlan = {
  transport: 'app-server',
  startupCompatibility: 'configured',
  command: '/opt/codex',
  args: Object.freeze(['app-server']),
  shell: false,
  env: Object.freeze({ CODEX_HOME: '/tmp/taskwraith-codex-home' })
}

/** An app-server whose pipes the test holds both ends of. */
type FakeAppServer = EventEmitter & {
  stdin: PassThrough
  stdout: PassThrough
  stderr: PassThrough
  killed: boolean
  pid: number
  exitCode: number | null
  signalCode: NodeJS.Signals | null
  kill: ReturnType<typeof vi.fn>
}

function fakeAppServer(): FakeAppServer {
  const proc = new EventEmitter() as FakeAppServer
  proc.stdin = new PassThrough()
  proc.stdout = new PassThrough()
  proc.stderr = new PassThrough()
  proc.killed = false
  proc.pid = 4242
  proc.exitCode = null
  proc.signalCode = null
  proc.kill = vi.fn(() => {
    proc.killed = true
    return true
  })
  return proc
}

/** Holds the turn for longer than the pump's budget, the way a slow handler does. */
function outrunTheTurnBudget(): void {
  const until = Date.now() + COOPERATIVE_STREAM_TURN_BUDGET_MS + 10
  while (Date.now() < until) {
    /* busy */
  }
}

const notification = (method: string): string => `${JSON.stringify({ method, params: {} })}\n`

/**
 * A started client over a fake app-server whose stdout the test writes to.
 * Nothing is mocked between the pipe and `handleLine`: lines travel through
 * readline and the ordered pump exactly as they do in production.
 */
async function startedClient() {
  const proc = fakeAppServer()
  const sent: Array<{ id?: number; method?: string }> = []
  proc.stdin.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString().split('\n')) {
      if (!line.trim()) continue
      const message = JSON.parse(line) as { id?: number; method?: string }
      sent.push(message)
      if (message.method === 'initialize') {
        proc.stdout.write(`${JSON.stringify({ id: message.id, result: { capabilities: {} } })}\n`)
      }
    }
  })
  const dependencies: CodexAppServerStartupDependencies = {
    ensureHomeForLaunch: async () => {},
    resolveBinary: async () => ({
      provider: 'codex' as const,
      binaryPath: '/opt/codex',
      source: 'path' as const
    }),
    buildProcessLaunchPlan: async () => launchPlan,
    spawnProcess: vi.fn(
      () => proc as unknown as ChildProcessWithoutNullStreams
    ) as unknown as typeof spawn,
    acquireCredentialLease: async () => null
  }
  const client = new CodexAppServerClient('/tmp/taskwraith-codex-home', () => [], dependencies)
  await client.ensureStarted('test')

  const handled: string[] = []
  client.setNotificationHandler((message: { method: string }) => {
    handled.push(message.method)
    if (message.method.startsWith('slow')) outrunTheTurnBudget()
  })
  /** The id the client assigned to the last request it wrote for `method`. */
  const requestId = (method: string): number => {
    const request = [...sent].reverse().find((message) => message.method === method)
    if (typeof request?.id !== 'number') throw new Error(`no ${method} request was written`)
    return request.id
  }
  const untilHandled = (count: number): Promise<void> =>
    new Promise((resolve) => {
      const check = (): void => {
        if (handled.length >= count) resolve()
        else setImmediate(check)
      }
      check()
    })
  return { client, proc, handled, requestId, untilHandled }
}

beforeEach(() => {
  resetOrderedStreamPumpCountersForTest()
  // Pumps handle output on arrival under test unless a test asks for pacing.
  setOrderedStreamPumpPacingForTest(true)
})

/** Lines the pump has taken off the pipe and not yet handed to `handleLine`. */
function linesWaiting(): number {
  const { pushed, visited } = orderedStreamPumpCounters().codex
  return pushed - visited
}

describe('Codex app-server stdout is handled through one ordered pump', () => {
  it('defers the rest of a burst behind a slow line and keeps arrival order', async () => {
    const { client, proc, handled, untilHandled } = await startedClient()

    proc.stdout.write(notification('slow/1') + notification('fast/2') + notification('fast/3'))
    proc.stdout.write(notification('fast/4') + notification('fast/5'))
    // The slow line spent the turn. Everything behind it — including the whole
    // second chunk — is waiting, not handled inline ahead of a deferred line.
    expect(handled).toEqual(['slow/1'])
    expect(linesWaiting()).toBe(4)

    await untilHandled(5)
    expect(handled).toEqual(['slow/1', 'fast/2', 'fast/3', 'fast/4', 'fast/5'])
    expect(orderedStreamPumpCounters().codex.yields).toBeGreaterThan(0)
    client.dispose()
  })

  it('answers a request whose response is still queued when the process closes', async () => {
    const { client, proc, requestId } = await startedClient()
    const answer = client.request('thread/read', { threadId: 't1' })
    await Promise.resolve()

    proc.stdout.write(
      notification('slow/1') +
        `${JSON.stringify({ id: requestId('thread/read'), result: { ok: true } })}\n`
    )
    // Guard: the response really is behind a deferred turn when close arrives.
    expect(linesWaiting()).toBe(1)
    proc.emit('close', 0, null)

    expect(linesWaiting()).toBe(0)
    await expect(answer).resolves.toEqual({ ok: true })
  })

  it('answers a request whose response is still queued when the process errors', async () => {
    const { client, proc, requestId } = await startedClient()
    const answer = client.request('thread/read', { threadId: 't1' })
    await Promise.resolve()

    proc.stdout.write(
      notification('slow/1') +
        `${JSON.stringify({ id: requestId('thread/read'), result: { ok: true } })}\n`
    )
    expect(linesWaiting()).toBe(1)
    proc.emit('error', new Error('kill EPERM'))

    await expect(answer).resolves.toEqual({ ok: true })
    client.dispose()
  })

  it('answers a request whose response is still queued when the client is disposed', async () => {
    const { client, proc, requestId } = await startedClient()
    const answer = client.request('thread/read', { threadId: 't1' })
    await Promise.resolve()

    proc.stdout.write(
      notification('slow/1') +
        `${JSON.stringify({ id: requestId('thread/read'), result: { ok: true } })}\n`
    )
    expect(linesWaiting()).toBe(1)
    client.dispose()

    await expect(answer).resolves.toEqual({ ok: true })
  })

  it('still rejects a request the app-server never answered before it closed', async () => {
    const { client, proc } = await startedClient()
    const answer = client.request('thread/read', { threadId: 't1' })
    await Promise.resolve()

    proc.stdout.write(notification('fast/1'))
    proc.emit('close', 0, null)

    await expect(answer).rejects.toThrow('Codex app-server exited.')
  })

  it('stops reading the pipe while a deep backlog waits and reads again once it drains', async () => {
    const { client, proc, handled, untilHandled } = await startedClient()
    const burst = ORDERED_STREAM_PUMP_HIGH_WATER_ITEMS + 50

    proc.stdout.write(
      notification('slow/1') +
        Array.from({ length: burst }, (_, index) => notification(`fast/${index}`)).join('')
    )
    expect(handled).toEqual(['slow/1'])
    expect(proc.stdout.isPaused()).toBe(true)
    expect(orderedStreamPumpCounters().codex.pauses).toBe(1)

    await untilHandled(burst + 1)
    expect(proc.stdout.isPaused()).toBe(false)
    expect(handled.at(-1)).toBe(`fast/${burst - 1}`)
    client.dispose()
  })
})
