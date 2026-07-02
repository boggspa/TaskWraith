import { describe, it, expect } from 'vitest'
import {
  GrokSeatSession,
  GrokSeatSessionRegistry,
  GROK_SEAT_SESSION_IDLE_MS,
  type GrokSeatTurnOptions
} from './GrokSeatSession'
import type { AcpChildProcess } from './GrokAcpClient'
import type { NormalizedGrokRunEvent } from './GrokAcpProtocol'

class FakeAcpChild implements AcpChildProcess {
  writes: string[] = []
  killed = false
  private dataListeners: ((chunk: string) => void)[] = []
  private closeListener?: (code: number | null) => void

  stdin = {
    write: (data: string, cb?: (err?: Error | null) => void): void => {
      this.writes.push(data)
      cb?.(null)
    },
    on: (_event: 'error', _listener: (err: Error) => void): void => {}
  }
  stdout = {
    on: (_event: 'data', listener: (chunk: string) => void): void => {
      this.dataListeners.push(listener)
    }
  }
  stderr = {
    on: (_event: 'data', _listener: (chunk: string) => void): void => {}
  }

  on(event: 'error' | 'close', listener: (arg: never) => void): void {
    if (event === 'close') this.closeListener = listener as (code: number | null) => void
  }

  kill(): void {
    this.killed = true
    this.closeListener?.(0)
  }

  emit(message: unknown): void {
    const line = `${JSON.stringify(message)}\n`
    this.dataListeners.forEach((cb) => cb(line))
  }

  sent(): Record<string, unknown>[] {
    return this.writes.map((w) => JSON.parse(w.trim()))
  }
}

function makeTurn(): {
  turn: GrokSeatTurnOptions
  events: NormalizedGrokRunEvent[]
  ends: { turnComplete: boolean; terminalStatus?: string; processExited: boolean }[]
} {
  const events: NormalizedGrokRunEvent[] = []
  const ends: { turnComplete: boolean; terminalStatus?: string; processExited: boolean }[] = []
  return {
    events,
    ends,
    turn: {
      prompt: 'turn prompt',
      onEvent: (event) => events.push(event),
      onTurnEnd: (turnComplete, terminalStatus, processExited) =>
        ends.push({ turnComplete, terminalStatus, processExited })
    }
  }
}

function completeHandshake(child: FakeAcpChild): void {
  child.emit({ jsonrpc: '2.0', id: 1, result: {} })
  child.emit({ jsonrpc: '2.0', id: 2, result: { sessionId: 'sess-1' } })
}

describe('GrokSeatSession', () => {
  it('runs two sequential turns on ONE session without killing the process', () => {
    const child = new FakeAcpChild()
    const session = new GrokSeatSession({ cwd: '/repo', spawnProcess: () => child })

    const first = makeTurn()
    session.runTurn(first.turn)
    completeHandshake(child)
    // First prompt rides rpc id 3 on the freshly created session.
    const firstPrompt = child.sent().find((m) => m.method === 'session/prompt')
    expect(firstPrompt).toMatchObject({ id: 3, params: { sessionId: 'sess-1' } })
    // Terminal stopReason ends the turn — process stays ALIVE.
    child.emit({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId: 'sess-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'answer one' } } }
    })
    child.emit({ jsonrpc: '2.0', id: 3, result: { stopReason: 'end_turn' } })
    expect(first.ends).toEqual([
      { turnComplete: true, terminalStatus: 'end_turn', processExited: false }
    ])
    expect(child.killed).toBe(false)
    expect(session.isAlive()).toBe(true)
    expect(session.isBusy()).toBe(false)

    // Second turn: NO new initialize / session/new — a fresh session/prompt
    // with the next rpc id on the SAME sessionId.
    const second = makeTurn()
    session.runTurn(second.turn)
    const prompts = child.sent().filter((m) => m.method === 'session/prompt')
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toMatchObject({ id: 4, params: { sessionId: 'sess-1' } })
    expect(child.sent().filter((m) => m.method === 'session/new')).toHaveLength(1)
    child.emit({ jsonrpc: '2.0', id: 4, result: { stopReason: 'end_turn' } })
    expect(second.ends).toEqual([
      { turnComplete: true, terminalStatus: 'end_turn', processExited: false }
    ])
  })

  it('parks a turn accepted before the handshake and sends it when the session resolves', () => {
    const child = new FakeAcpChild()
    const session = new GrokSeatSession({ cwd: '/repo', spawnProcess: () => child })
    const first = makeTurn()
    session.runTurn(first.turn)
    expect(child.sent().some((m) => m.method === 'session/prompt')).toBe(false)
    completeHandshake(child)
    expect(child.sent().some((m) => m.method === 'session/prompt')).toBe(true)
    expect(first.events.some((event) => event.type === 'init')).toBe(true)
  })

  it('fails the active turn closed and dies on a prompt RPC error', () => {
    const child = new FakeAcpChild()
    const session = new GrokSeatSession({ cwd: '/repo', spawnProcess: () => child })
    const first = makeTurn()
    session.runTurn(first.turn)
    completeHandshake(child)
    child.emit({ jsonrpc: '2.0', id: 3, error: { message: 'second prompt rejected' } })
    // Error → warn + kill → close → the turn ends as processExited.
    expect(first.events.some((event) => event.type === 'provider_warning')).toBe(true)
    expect(child.killed).toBe(true)
    expect(session.isAlive()).toBe(false)
    expect(first.ends).toEqual([
      { turnComplete: false, terminalStatus: 'seat-session-exited', processExited: true }
    ])
  })

  it('rejects a concurrent turn without disturbing the in-flight one', () => {
    const child = new FakeAcpChild()
    const session = new GrokSeatSession({ cwd: '/repo', spawnProcess: () => child })
    const first = makeTurn()
    session.runTurn(first.turn)
    completeHandshake(child)
    const second = makeTurn()
    session.runTurn(second.turn)
    expect(second.ends).toEqual([
      { turnComplete: false, terminalStatus: 'seat-session-busy', processExited: false }
    ])
    child.emit({ jsonrpc: '2.0', id: 3, result: { stopReason: 'end_turn' } })
    expect(first.ends).toHaveLength(1)
    expect(first.ends[0].turnComplete).toBe(true)
  })

  it('denies permission requests that arrive with no active turn', () => {
    const child = new FakeAcpChild()
    new GrokSeatSession({ cwd: '/repo', spawnProcess: () => child })
    completeHandshake(child)
    child.emit({
      jsonrpc: '2.0',
      id: 77,
      method: 'session/request_permission',
      params: {
        sessionId: 'sess-1',
        toolCall: { title: 'shell', kind: 'execute' },
        options: [
          { optionId: 'allow-once', kind: 'allow_once' },
          { optionId: 'reject-once', kind: 'reject_once' }
        ]
      }
    })
    const reply = child.sent().find((m) => m.id === 77 && m.result)
    expect(reply).toBeTruthy()
    expect(JSON.stringify(reply)).not.toContain('allow-once')
  })

  it('cancel kills the process (persistence deliberately dropped)', () => {
    const child = new FakeAcpChild()
    const session = new GrokSeatSession({ cwd: '/repo', spawnProcess: () => child })
    const first = makeTurn()
    const handle = session.runTurn(first.turn)
    completeHandshake(child)
    handle.cancel()
    expect(child.killed).toBe(true)
    expect(child.sent().some((m) => m.method === 'session/cancel')).toBe(true)
    expect(session.isAlive()).toBe(false)
    expect(first.ends[0]).toMatchObject({ turnComplete: false, processExited: true })
  })
})

describe('GrokSeatSessionRegistry', () => {
  it('reuses a live matching session and replaces on fingerprint change or death', () => {
    let clock = 1_000
    const registry = new GrokSeatSessionRegistry(() => clock)
    const children: FakeAcpChild[] = []
    const factory = () => ({
      cwd: '/repo',
      spawnProcess: () => {
        const child = new FakeAcpChild()
        children.push(child)
        return child
      }
    })

    const first = registry.acquire('chat:seat', 'fp-a', factory)
    expect(first.reused).toBe(false)
    const again = registry.acquire('chat:seat', 'fp-a', factory)
    expect(again.reused).toBe(true)
    expect(again.session).toBe(first.session)
    expect(children).toHaveLength(1)

    // Posture/argv fingerprint change → dispose + fresh spawn.
    const changed = registry.acquire('chat:seat', 'fp-b', factory)
    expect(changed.reused).toBe(false)
    expect(children).toHaveLength(2)
    expect(children[0].killed).toBe(true)

    // Idle past the TTL → reaped on the next acquire.
    clock += GROK_SEAT_SESSION_IDLE_MS + 1
    const afterIdle = registry.acquire('chat:seat', 'fp-b', factory)
    expect(afterIdle.reused).toBe(false)
    expect(children).toHaveLength(3)

    registry.disposeAll()
    expect(children[2].killed).toBe(true)
  })
})

describe('session/new hardening (review P2)', () => {
  it('fails closed when session/new returns no sessionId instead of parking turns forever', () => {
    const child = new FakeAcpChild()
    const session = new GrokSeatSession({ cwd: '/repo', spawnProcess: () => child })
    const first = makeTurn()
    session.runTurn(first.turn)
    child.emit({ jsonrpc: '2.0', id: 1, result: {} })
    child.emit({ jsonrpc: '2.0', id: 2, result: {} }) // no sessionId
    expect(child.killed).toBe(true)
    expect(session.isAlive()).toBe(false)
    expect(first.ends).toEqual([
      { turnComplete: false, terminalStatus: 'seat-session-exited', processExited: true }
    ])
    expect(
      first.events.some(
        (event) => event.type === 'provider_warning' && String(event.text).includes('no sessionId')
      )
    ).toBe(true)
  })
})
