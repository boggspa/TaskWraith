import { describe, expect, it } from 'vitest'
import type { AcpChildProcess } from '../acp/AcpTurnClient'
import { runMuseMspTurn } from './MuseMspClient'
import type { MuseMspWireObservation } from './MuseMspClient'
import type { MuseExecNormalizedEvent } from './MuseExecJson'

/** The ACP suites' fake child, reused verbatim — plus emitRaw for bytes that
 * are not valid JSON, which is exactly the drop class under test. */
class FakeMspChild implements AcpChildProcess {
  writes: string[] = []
  killed: string[] = []
  autoCloseOnKill = true
  private dataListeners: ((chunk: string) => void)[] = []
  private closeListener?: (code: number | null) => void
  private errorListener?: (err: Error) => void

  stdin = {
    write: (data: string, cb?: (err?: Error | null) => void): void => {
      this.writes.push(data)
      cb?.(null)
    },
    on: (): void => {},
    end: (): void => {}
  }
  stdout = {
    on: (_event: 'data', listener: (chunk: string) => void): void => {
      this.dataListeners.push(listener)
    }
  }
  stderr = { on: (): void => {} }

  on(event: 'error' | 'close', listener: (arg: never) => void): void {
    if (event === 'close') this.closeListener = listener as (code: number | null) => void
    else this.errorListener = listener as (err: Error) => void
  }
  kill(signal?: string): void {
    this.killed.push(signal || 'SIGTERM')
    if (this.autoCloseOnKill) this.closeListener?.(0)
  }
  emit(message: unknown): void {
    const line = `${JSON.stringify(message)}\n`
    this.dataListeners.forEach((cb) => cb(line))
  }
  emitRaw(line: string): void {
    this.dataListeners.forEach((cb) => cb(line))
  }
  sent(): Record<string, any>[] {
    return this.writes.map((w) => JSON.parse(w.trim()))
  }
  sentMethod(method: string): Record<string, any> | undefined {
    return this.sent().find((frame) => frame.method === method)
  }
  fail(err: Error): void {
    this.errorListener?.(err)
  }
  finish(code: number | null): void {
    this.closeListener?.(code)
  }
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const bytes = (size: number): Uint8Array => Uint8Array.from({ length: size }, (_, i) => i)

type StatsObservation = Extract<MuseMspWireObservation, { type: 'stats' }>

function start(overrides: Record<string, unknown> = {}): {
  child: FakeMspChild
  events: MuseExecNormalizedEvent[]
  warnings: string[]
  observations: MuseMspWireObservation[]
  handle: ReturnType<typeof runMuseMspTurn>
} {
  const child = new FakeMspChild()
  const events: MuseExecNormalizedEvent[] = []
  const warnings: string[] = []
  const observations: MuseMspWireObservation[] = []
  const handle = runMuseMspTurn({
    onWarning: (message: string) => warnings.push(message),
    spawnProcess: () => child,
    clientVersion: '1.9.7',
    workspaceRoot: '/ws',
    input: [{ type: 'text', text: 'hello' }],
    onEvent: (event) => events.push(event),
    onWireObservation: (observation) => observations.push(observation),
    now: () => 1_700_000_000_000,
    randomBytes: bytes,
    endProcessGraceMs: 20,
    ...overrides
  } as never)
  return { child, events, warnings, observations, handle }
}

/** Drive the handshake to an accepted turn with no turn/started yet. */
async function driveToTurn(child: FakeMspChild, sessionId = 'sess-1'): Promise<void> {
  await flush()
  child.emit({ jsonrpc: '2.0', id: 1, result: { serverInfo: { name: 'muse', version: '1.2.1' } } })
  await flush()
  child.emit({
    jsonrpc: '2.0',
    id: 2,
    result: { session: { sessionId, turnCount: 0, workspaceRoot: '/ws', modelId: 'm' } }
  })
  await flush()
  child.emit({ jsonrpc: '2.0', id: 3, result: { turnId: 'turn-1', status: 'accepted' } })
  await flush()
}

/** Initialize and session/start only — the turn has not been offered yet. */
async function driveToSession(child: FakeMspChild, sessionId = 'sess-1'): Promise<void> {
  await flush()
  child.emit({ jsonrpc: '2.0', id: 1, result: { serverInfo: { name: 'muse', version: '1.2.1' } } })
  await flush()
  child.emit({
    jsonrpc: '2.0',
    id: 2,
    result: { session: { sessionId, turnCount: 0, workspaceRoot: '/ws', modelId: 'm' } }
  })
  await flush()
}

const turnStarted = {
  jsonrpc: '2.0',
  method: 'turn/started',
  params: { sessionId: 'sess-1', turnId: 'turn-1' }
}

describe('runMuseMspTurn — push-blackout tripwire', () => {
  it('warns once when turn/started never arrives after the turn/start ack', async () => {
    const { child, warnings, observations, handle } = start({ turnStartedTripwireMs: 40 })
    await driveToTurn(child)
    await sleep(120)
    expect(
      warnings.some((w) =>
        w.includes('Muse acknowledged turn/start but sent no turn/started notification')
      )
    ).toBe(true)
    expect(observations.filter((o) => o.type === 'tripwire')).toHaveLength(1)
    child.finish(0)
    await handle.closed
  })

  it('clears when turn/started arrives within the window', async () => {
    const { child, warnings, observations, handle } = start({ turnStartedTripwireMs: 60 })
    await driveToTurn(child)
    child.emit(turnStarted)
    await flush()
    await sleep(150)
    expect(observations.filter((o) => o.type === 'tripwire')).toHaveLength(0)
    expect(warnings.join('\n')).not.toContain('turn/started')
    child.finish(0)
    await handle.closed
  })

  it('does not arm when turn/started was buffered before the ack', async () => {
    const { child, observations, handle } = start({ turnStartedTripwireMs: 40 })
    await driveToSession(child)
    // Arrives while turn/start is still in flight: buffered, replayed after
    // the ack — a buffered frame is not a lost one and must not flag.
    child.emit(turnStarted)
    await flush()
    child.emit({ jsonrpc: '2.0', id: 3, result: { turnId: 'turn-1', status: 'accepted' } })
    await flush()
    await sleep(120)
    expect(observations.filter((o) => o.type === 'tripwire')).toHaveLength(0)
    child.finish(0)
    await handle.closed
  })

  it('never arms when the tripwire is disabled', async () => {
    const { child, observations, handle } = start({ turnStartedTripwireMs: 0 })
    await driveToTurn(child)
    await sleep(80)
    expect(observations.filter((o) => o.type === 'tripwire')).toHaveLength(0)
    child.finish(0)
    await handle.closed
  })
})

describe('runMuseMspTurn — wire drop classes', () => {
  it('counts and observes unparsable lines', async () => {
    const { child, observations, handle } = start()
    await driveToTurn(child)
    child.emitRaw('this is not json\n')
    await flush()
    const unparsable = observations.filter((o) => o.type === 'unparsable')
    expect(unparsable).toHaveLength(1)
    expect(unparsable[0]).toMatchObject({ line: 'this is not json' })
    child.finish(0)
    await handle.closed
    const stats = (observations.find((o) => o.type === 'stats') as StatsObservation).stats
    expect(stats.inboundUnparsable).toBe(1)
  })

  it('treats unparsable bytes as no proof of life — the inactivity watchdog still fires', async () => {
    const { child, warnings, handle } = start({ inactivityTimeoutMs: 60 })
    await driveToTurn(child)
    const garbage = setInterval(() => child.emitRaw('garbage\n'), 15)
    try {
      await sleep(400)
    } finally {
      clearInterval(garbage)
    }
    expect(warnings.some((w) => w.includes('The Muse session host stopped responding'))).toBe(true)
    await handle.closed
  })

  it('counts unknown methods per occurrence but observes once per distinct method', async () => {
    const { child, observations, handle } = start()
    await driveToTurn(child)
    const future = { jsonrpc: '2.0', method: 'zz/future', params: {} }
    child.emit(future)
    child.emit(future)
    await flush()
    child.finish(0)
    await handle.closed
    expect(observations.filter((o) => o.type === 'unknownMethod')).toHaveLength(1)
    const stats = (observations.find((o) => o.type === 'stats') as StatsObservation).stats
    expect(stats.inboundUnknownMethods).toBe(2)
    expect(stats.unknownMethods).toEqual(['zz/future'])
  })

  it('does not count schema-published unadopted notifications as unknown-method drift', async () => {
    const { child, observations, handle } = start()
    await driveToTurn(child)
    child.emit({ jsonrpc: '2.0', method: 'session/modelChanged', params: { sessionId: 'sess-1' } })
    child.emit({
      jsonrpc: '2.0',
      method: 'turn/retryScheduled',
      params: { sessionId: 'sess-1', turnId: 'turn-1' }
    })
    child.emit({
      jsonrpc: '2.0',
      method: 'turn/retracted',
      params: { sessionId: 'sess-1', turnId: 'turn-1' }
    })
    await flush()
    child.finish(0)
    await handle.closed
    expect(observations.filter((o) => o.type === 'unknownMethod')).toHaveLength(0)
    const stats = (observations.find((o) => o.type === 'stats') as StatsObservation).stats
    expect(stats.inboundUnknownMethods).toBe(0)
    expect(stats.inboundNotifications).toBe(3)
  })

  it('reports a close-time stats payload reflecting the whole run', async () => {
    const { child, observations, handle } = start()
    await driveToTurn(child)
    child.emit(turnStarted)
    child.emit({
      jsonrpc: '2.0',
      method: 'item/started',
      params: {
        sessionId: 'sess-1',
        item: { itemId: 'r1', kind: 'reasoning', revision: 1, status: 'inProgress' }
      }
    })
    child.emit({ jsonrpc: '2.0', method: 'zz/future', params: {} })
    child.emitRaw('not json\n')
    await flush()
    child.finish(0)
    await handle.closed
    const statsObservations = observations.filter((o) => o.type === 'stats')
    expect(statsObservations).toHaveLength(1)
    const stats = (statsObservations[0] as StatsObservation).stats
    expect(stats).toMatchObject({
      inboundResponses: 3,
      inboundRequests: 0,
      inboundNotifications: 3,
      inboundUnparsable: 1,
      inboundUnknownMethods: 1
    })
    expect(stats.unknownMethods).toEqual(['zz/future'])
  })
})
