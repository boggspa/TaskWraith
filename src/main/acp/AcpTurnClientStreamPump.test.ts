import { beforeEach, describe, expect, it } from 'vitest'
import { runAcpTurn, type AcpChildProcess, type AcpTurnOptions } from './AcpTurnClient'
import {
  COOPERATIVE_STREAM_TURN_BUDGET_MS,
  ORDERED_STREAM_PUMP_HIGH_WATER_ITEMS,
  orderedStreamPumpCounters,
  resetOrderedStreamPumpCountersForTest,
  setOrderedStreamPumpPacingForTest
} from '../providers/CooperativeStreamPump'

/** A provider process whose stdout is a pipe the client can stop reading. */
class FakeAcpChild implements AcpChildProcess {
  writes: string[] = []
  stdoutPaused = false
  stopRequests: string[] = []
  private dataListeners: ((chunk: string) => void)[] = []
  private closeListener?: (code: number | null) => void

  stdin = {
    write: (data: string, cb?: (err?: Error | null) => void): void => {
      this.writes.push(data)
      cb?.(null)
    }
  }
  stdout = {
    on: (_event: 'data', listener: (chunk: string) => void): void => {
      this.dataListeners.push(listener)
    },
    pause: (): void => {
      this.stdoutPaused = true
    },
    resume: (): void => {
      this.stdoutPaused = false
    }
  }
  stderr = { on: (): void => {} }

  on(event: 'error' | 'close', listener: (arg: never) => void): void {
    if (event === 'close') this.closeListener = listener as (code: number | null) => void
  }
  /** The test decides when the provider is gone; a stop request closes nothing. */
  kill(signal?: string): void {
    this.stopRequests.push(signal || 'SIGTERM')
  }

  /** One stdout chunk, exactly as the pipe would deliver it. */
  chunk(text: string): void {
    this.dataListeners.forEach((listener) => listener(text))
  }
  finish(code: number | null): void {
    this.closeListener?.(code)
  }
}

const frame = (message: unknown): string => `${JSON.stringify(message)}\n`
const content = (text: string): string =>
  frame({
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      sessionId: 's-1',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }
    }
  })
const promptResult = frame({ jsonrpc: '2.0', id: 3, result: { stopReason: 'end_turn' } })

/** Holds the turn for longer than the pump's budget, the way a slow handler does. */
function outrunTheTurnBudget(): void {
  const until = Date.now() + COOPERATIVE_STREAM_TURN_BUDGET_MS + 10
  while (Date.now() < until) {
    /* busy */
  }
}

/**
 * A turn that has reached its prompt, over a child whose stdout the test
 * writes. Content starting with `slow` costs more than a turn's budget.
 */
function promptedTurn(overrides: Partial<AcpTurnOptions> = {}) {
  const child = new FakeAcpChild()
  const seen: string[] = []
  const closes: Array<{ turnComplete: boolean; seenAtClose: string[] }> = []
  const handle = runAcpTurn({
    prompt: 'hi',
    cwdLifetime: 'run',
    cwd: '/tmp/ws',
    spawnProcess: () => child,
    initializeParams: { protocolVersion: 1 },
    onEvent: (event) => {
      if (event.type !== 'content' || !event.text) return
      seen.push(event.text)
      if (event.text.startsWith('slow')) outrunTheTurnBudget()
    },
    onClose: (_code, turnComplete) => {
      closes.push({ turnComplete, seenAtClose: [...seen] })
    },
    ...overrides
  })
  child.chunk(frame({ jsonrpc: '2.0', id: 1, result: {} }))
  child.chunk(frame({ jsonrpc: '2.0', id: 2, result: { sessionId: 's-1' } }))
  const untilSeen = (count: number): Promise<void> =>
    new Promise((resolve) => {
      const check = (): void => {
        if (seen.length >= count) resolve()
        else setImmediate(check)
      }
      check()
    })
  return { child, handle, seen, closes, untilSeen }
}

/** Lines taken off the pipe and not yet handled, under one counter label. */
function linesWaiting(label: string): number {
  const { pushed, visited } = orderedStreamPumpCounters()[label]
  return pushed - visited
}

beforeEach(() => {
  resetOrderedStreamPumpCountersForTest()
  // Pumps handle output on arrival under test unless a test asks for pacing.
  setOrderedStreamPumpPacingForTest(true)
})

describe('ACP provider stdout is handled through one ordered pump', () => {
  it('defers the rest of a burst behind a slow message and keeps arrival order', async () => {
    const { child, handle, seen, untilSeen } = promptedTurn()

    child.chunk(content('slow-1') + content('b') + content('c'))
    child.chunk(content('d') + content('e'))
    // The slow message spent the turn. Everything behind it — including the
    // whole second chunk — is waiting, not handled ahead of a deferred line.
    expect(seen).toEqual(['slow-1'])
    expect(linesWaiting('acp')).toBe(4)

    await untilSeen(5)
    expect(seen).toEqual(['slow-1', 'b', 'c', 'd', 'e'])
    expect(orderedStreamPumpCounters().acp.yields).toBeGreaterThan(0)
    handle.cancel()
  })

  it('keeps a message split across two chunks whole', () => {
    const { child, handle, seen } = promptedTurn()
    const whole = content('split across the pipe')

    child.chunk(whole.slice(0, 40))
    expect(seen).toEqual([])
    child.chunk(whole.slice(40) + content('next'))

    expect(seen).toEqual(['split across the pipe', 'next'])
    handle.cancel()
  })

  it('handles what is still queued, terminal included, before it closes the turn', async () => {
    const { child, handle, seen, closes } = promptedTurn()

    child.chunk(content('slow-1') + content('tail') + promptResult)
    // Guard: the tail and the turn's terminal really are behind a deferred turn.
    expect(seen).toEqual(['slow-1'])
    expect(linesWaiting('acp')).toBe(2)
    child.finish(0)
    await handle.closed

    expect(closes).toEqual([{ turnComplete: true, seenAtClose: ['slow-1', 'tail'] }])
  })

  it('stops reading the pipe while a deep backlog waits and reads again once it drains', async () => {
    const { child, handle, seen, untilSeen } = promptedTurn()
    const burst = ORDERED_STREAM_PUMP_HIGH_WATER_ITEMS + 50

    child.chunk(
      content('slow-1') + Array.from({ length: burst }, (_, index) => content(`m${index}`)).join('')
    )
    expect(seen).toEqual(['slow-1'])
    expect(child.stdoutPaused).toBe(true)

    await untilSeen(burst + 1)
    expect(child.stdoutPaused).toBe(false)
    expect(seen.at(-1)).toBe(`m${burst - 1}`)
    handle.cancel()
  })

  it('counts under the provider the caller names', () => {
    const { child, handle } = promptedTurn({ diagnosticsLabel: 'kimi' })

    child.chunk(content('a'))

    const counters = orderedStreamPumpCounters()
    expect(Object.keys(counters)).toEqual(['kimi'])
    // initialize result, session/new result, one content line.
    expect(counters.kimi).toMatchObject({ pumps: 1, pushed: 3, visited: 3 })
    handle.cancel()
  })
})
