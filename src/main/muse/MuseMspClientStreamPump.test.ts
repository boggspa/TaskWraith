import { beforeEach, describe, expect, it } from 'vitest'
import type { AcpChildProcess } from '../acp/AcpTurnClient'
import { runMuseMspTurn, type MuseMspWireStats } from './MuseMspClient'
import {
  COOPERATIVE_STREAM_TURN_BUDGET_MS,
  ORDERED_STREAM_PUMP_HIGH_WATER_ITEMS,
  orderedStreamPumpCounters,
  resetOrderedStreamPumpCountersForTest,
  setOrderedStreamPumpPacingForTest
} from '../providers/CooperativeStreamPump'

/** A Muse session host whose stdout is a pipe the client can stop reading. */
class FakeMspChild implements AcpChildProcess {
  writes: string[] = []
  stdoutPaused = false
  stopRequests: string[] = []
  private dataListeners: ((chunk: string) => void)[] = []
  private closeListener?: (code: number | null) => void

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
  /** The test decides when the host is gone; a stop request alone closes nothing. */
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

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
const frame = (message: unknown): string => `${JSON.stringify(message)}\n`
const delta = (text: string): string =>
  frame({
    jsonrpc: '2.0',
    method: 'item/delta',
    params: { sessionId: 'sess-1', itemId: 'i1', field: 'text', delta: text }
  })
const turnCompleted = frame({
  jsonrpc: '2.0',
  method: 'turn/completed',
  params: { sessionId: 'sess-1', turnId: 'turn-1', terminal: 'completed', durationMs: 12 }
})

/** Holds the turn for longer than the pump's budget, the way a slow handler does. */
function outrunTheTurnBudget(): void {
  const until = Date.now() + COOPERATIVE_STREAM_TURN_BUDGET_MS + 10
  while (Date.now() < until) {
    /* busy */
  }
}

/**
 * A turn the host has accepted, over a child whose stdout the test writes.
 * Content starting with `slow` costs more than a turn's budget.
 */
async function turnInFlight() {
  const child = new FakeMspChild()
  const seen: string[] = []
  const closes: Array<{ terminal: string | null; seenAtClose: string[] }> = []
  const warnings: string[] = []
  const wireStats: MuseMspWireStats[] = []
  const handle = runMuseMspTurn({
    spawnProcess: () => child,
    clientVersion: '1.9.7',
    workspaceRoot: '/ws',
    input: [{ type: 'text', text: 'hello' }],
    providerId: 'meta',
    modelId: 'muse-spark-1.3',
    endProcessGraceMs: 20,
    onEvent: (event) => {
      if (event.type !== 'content' || !event.text) return
      seen.push(event.text)
      if (event.text.startsWith('slow')) outrunTheTurnBudget()
    },
    onClose: (_code, terminal) => {
      closes.push({ terminal, seenAtClose: [...seen] })
    },
    onWarning: (message) => warnings.push(message),
    onWireObservation: (observation) => {
      if (observation.type === 'stats') wireStats.push(observation.stats)
    }
  })
  await tick()
  child.chunk(frame({ jsonrpc: '2.0', id: 1, result: { serverInfo: { name: 'muse' } } }))
  await tick()
  child.chunk(frame({ jsonrpc: '2.0', id: 2, result: { session: { sessionId: 'sess-1' } } }))
  await tick()
  child.chunk(frame({ jsonrpc: '2.0', id: 3, result: { turnId: 'turn-1', status: 'accepted' } }))
  await tick()
  const untilSeen = (count: number): Promise<void> =>
    new Promise((resolve) => {
      const check = (): void => {
        if (seen.length >= count) resolve()
        else setImmediate(check)
      }
      check()
    })
  /** The id the client assigned to the last request it wrote for `method`. */
  const requestId = (method: string): number | string => {
    const request = child.writes
      .map((write) => JSON.parse(write) as { id?: number | string; method?: string })
      .reverse()
      .find((message) => message.method === method)
    if (request?.id === undefined) throw new Error(`no ${method} request was written`)
    return request.id
  }
  return { child, handle, seen, closes, warnings, wireStats, requestId, untilSeen }
}

/** Lines taken off the pipe and not yet handled. */
function linesWaiting(): number {
  const { pushed, visited } = orderedStreamPumpCounters().muse
  return pushed - visited
}

beforeEach(() => {
  resetOrderedStreamPumpCountersForTest()
  // Pumps handle output on arrival under test unless a test asks for pacing.
  setOrderedStreamPumpPacingForTest(true)
})

describe('Muse session-host stdout is handled through one ordered pump', () => {
  it('defers the rest of a burst behind a slow frame and keeps arrival order', async () => {
    const { child, seen, untilSeen } = await turnInFlight()

    child.chunk(delta('slow-1') + delta('b') + delta('c'))
    child.chunk(delta('d') + delta('e'))
    // The slow frame spent the turn. Everything behind it — including the whole
    // second chunk — is waiting, not handled ahead of a deferred line.
    expect(seen).toEqual(['slow-1'])
    expect(linesWaiting()).toBe(4)

    await untilSeen(5)
    expect(seen).toEqual(['slow-1', 'b', 'c', 'd', 'e'])
    expect(orderedStreamPumpCounters().muse.yields).toBeGreaterThan(0)
    child.finish(0)
  })

  it('keeps a frame split across two chunks whole', async () => {
    const { child, seen } = await turnInFlight()
    const whole = delta('split across the pipe')

    child.chunk(whole.slice(0, 40))
    expect(seen).toEqual([])
    child.chunk(whole.slice(40) + delta('next'))

    expect(seen).toEqual(['split across the pipe', 'next'])
    child.finish(0)
  })

  it('handles what is still queued, terminal included, before it closes the turn', async () => {
    const { child, handle, seen, closes, wireStats } = await turnInFlight()

    child.chunk(delta('slow-1') + delta('tail') + turnCompleted)
    // Guard: the tail and the turn's terminal really are behind a deferred turn.
    expect(seen).toEqual(['slow-1'])
    expect(linesWaiting()).toBe(2)
    child.finish(0)
    await handle.closed

    expect(closes).toEqual([{ terminal: 'completed', seenAtClose: ['slow-1', 'tail'] }])
    // The closing wire summary counts every frame the host wrote, queued or not.
    expect(wireStats).toHaveLength(1)
    expect(wireStats[0]).toMatchObject({ inboundResponses: 3, inboundNotifications: 3 })
  })

  it('answers a call whose response is still queued when the host closes', async () => {
    const { child, handle, warnings, requestId } = await turnInFlight()
    expect(handle.steer([{ type: 'text', text: 'one more thing' }])).toBe(true)

    child.chunk(
      delta('slow-1') + frame({ jsonrpc: '2.0', id: requestId('turn/steer'), result: {} })
    )
    expect(linesWaiting()).toBe(1)
    child.finish(0)
    await handle.closed

    // Rejected as unanswered, the steer would have been reported as declined.
    expect(warnings.filter((warning) => warning.includes('steer'))).toEqual([])
  })

  it('stops reading the pipe while a deep backlog waits and reads again once it drains', async () => {
    const { child, seen, untilSeen } = await turnInFlight()
    const burst = ORDERED_STREAM_PUMP_HIGH_WATER_ITEMS + 50

    child.chunk(
      delta('slow-1') + Array.from({ length: burst }, (_, index) => delta(`m${index}`)).join('')
    )
    expect(seen).toEqual(['slow-1'])
    expect(child.stdoutPaused).toBe(true)

    await untilSeen(burst + 1)
    expect(child.stdoutPaused).toBe(false)
    expect(seen.at(-1)).toBe(`m${burst - 1}`)
    child.finish(0)
  })
})
