/**
 * Wave 4.3a-wire — Desktop Host projection bridge tests.
 *
 * The load-bearing pins are the ones that stop the bridge lying to the
 * renderer: a failure must be reported as a failure, never as an empty
 * snapshot, and the read-only surface must stay read-only so Desktop command
 * cutover cannot be un-gated by accident.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'

import {
  HOST_PROJECTION_SNAPSHOT_CHANNEL,
  registerHostProjectionHandlers,
  type HostProjectionClientPort,
  type HostProjectionSnapshotResult
} from './hostProjectionHandlers'

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
    removeHandler: vi.fn()
  }
}))

const mockedHandle = vi.mocked(ipcMain.handle)
const mockedRemoveHandler = vi.mocked(ipcMain.removeHandler)

beforeEach(() => {
  mockedHandle.mockReset()
  mockedRemoveHandler.mockReset()
})

type RegisteredHandler = (event: unknown, ...args: unknown[]) => unknown

function handlerFor(channel: string): RegisteredHandler {
  const handler = mockedHandle.mock.calls.find(([registered]) => registered === channel)?.[1] as
    | RegisteredHandler
    | undefined
  expect(handler).toBeTypeOf('function')
  if (!handler) throw new Error(`Handler not registered: ${channel}`)
  return handler
}

const SNAPSHOT = { generation: 3, cursor: 42 } as never

function clientPort(overrides: Partial<HostProjectionClientPort> = {}): HostProjectionClientPort {
  return {
    connect: vi.fn(async () => ({})),
    getSnapshot: vi.fn(async () => ({ snapshot: SNAPSHOT })),
    close: vi.fn(),
    ...overrides
  }
}

function register(createClient: () => HostProjectionClientPort): RegisteredHandler {
  registerHostProjectionHandlers({
    userDataPath: '/tmp/userData',
    appVersion: '1.9.2',
    createClient
  })
  return handlerFor(HOST_PROJECTION_SNAPSHOT_CHANNEL)
}

/* ------------------------------------------------------------------ */
/*  Registration                                                      */
/* ------------------------------------------------------------------ */

describe('registerHostProjectionHandlers · registration', () => {
  it('validates deps', () => {
    expect(() => registerHostProjectionHandlers(undefined as never)).toThrow(/requires deps/)
    expect(() =>
      registerHostProjectionHandlers({ userDataPath: '', appVersion: '1' } as never)
    ).toThrow(/userDataPath/)
  })

  it('registers exactly one channel — no command surface', () => {
    register(() => clientPort())

    const channels = mockedHandle.mock.calls.map(([channel]) => channel)
    expect(channels).toEqual([HOST_PROJECTION_SNAPSHOT_CHANNEL])
    // Desktop command cutover is 4.3b and hard-gated on 4.2c. A command
    // channel added here would silently un-gate it.
    expect(channels.some((c) => String(c).includes('command'))).toBe(false)
    expect(channels.some((c) => String(c).includes('submit'))).toBe(false)
  })

  it('is idempotent — removes before handling so a re-init cannot throw', () => {
    register(() => clientPort())
    // Electron throws on a duplicate handle(); that throw would abort whatever
    // startup step registers us.
    expect(mockedRemoveHandler).toHaveBeenCalledWith(HOST_PROJECTION_SNAPSHOT_CHANNEL)
  })

  it('does not connect at registration time', () => {
    const connect = vi.fn(async () => ({}))
    register(() => clientPort({ connect }))
    expect(connect).not.toHaveBeenCalled()
  })
})

/* ------------------------------------------------------------------ */
/*  Snapshot fetch                                                    */
/* ------------------------------------------------------------------ */

describe('registerHostProjectionHandlers · snapshot', () => {
  it('returns the snapshot Host actually served', async () => {
    const handler = register(() => clientPort())
    const result = (await handler({})) as HostProjectionSnapshotResult

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.snapshot).toBe(SNAPSHOT)
  })

  it('connects once and reuses the client across requests', async () => {
    const connect = vi.fn(async () => ({}))
    const port = clientPort({ connect })
    const handler = register(() => port)

    await handler({})
    await handler({})

    expect(connect).toHaveBeenCalledTimes(1)
    expect(port.getSnapshot).toHaveBeenCalledTimes(2)
  })
})

/* ------------------------------------------------------------------ */
/*  Failure is reported, never fabricated                             */
/* ------------------------------------------------------------------ */

describe('registerHostProjectionHandlers · failure honesty', () => {
  it('reports a connect failure instead of returning an empty snapshot', async () => {
    const handler = register(() =>
      clientPort({
        connect: vi.fn(async () => {
          throw new Error('host socket refused')
        })
      })
    )

    const result = (await handler({})) as HostProjectionSnapshotResult

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('host socket refused')
    // An empty snapshot would assert "there are no chats" — a fabricated
    // claim, not a neutral default.
    expect('snapshot' in result).toBe(false)
  })

  it('reports a fetch failure the same way', async () => {
    const handler = register(() =>
      clientPort({
        getSnapshot: vi.fn(async () => {
          throw new Error('snapshot timed out')
        })
      })
    )

    const result = (await handler({})) as HostProjectionSnapshotResult
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('snapshot timed out')
  })

  it('never throws across the IPC boundary', async () => {
    // A thrown Error loses its type on the wire and arrives as a generic
    // "Error invoking remote method" string, which the renderer cannot report
    // honestly.
    const handler = register(() =>
      clientPort({
        connect: vi.fn(async () => {
          throw new Error('boom')
        })
      })
    )

    await expect(handler({})).resolves.toBeDefined()
  })

  it('discards the failed client so the next call reconnects', async () => {
    let attempt = 0
    const close = vi.fn()
    const ports: HostProjectionClientPort[] = []

    const handler = register(() => {
      attempt += 1
      const failing = attempt === 1
      const port = clientPort({
        close,
        getSnapshot: vi.fn(async () => {
          if (failing) throw new Error('dropped')
          return { snapshot: SNAPSHOT }
        })
      })
      ports.push(port)
      return port
    })

    const first = (await handler({})) as HostProjectionSnapshotResult
    expect(first.ok).toBe(false)
    expect(close).toHaveBeenCalledTimes(1)

    // A transient Host restart must heal on the next fetch rather than pinning
    // a dead socket forever.
    const second = (await handler({})) as HostProjectionSnapshotResult
    expect(second.ok).toBe(true)
    expect(ports).toHaveLength(2)
  })

  it('survives a close() that throws while discarding', async () => {
    let attempt = 0
    const handler = register(() => {
      attempt += 1
      const failing = attempt === 1
      return clientPort({
        close: vi.fn(() => {
          throw new Error('close exploded')
        }),
        getSnapshot: vi.fn(async () => {
          if (failing) throw new Error('dropped')
          return { snapshot: SNAPSHOT }
        })
      })
    })

    // A throwing close() must not mask the original fetch failure.
    const first = (await handler({})) as HostProjectionSnapshotResult
    expect(first.ok).toBe(false)
    if (!first.ok) expect(first.error).toBe('dropped')

    const second = (await handler({})) as HostProjectionSnapshotResult
    expect(second.ok).toBe(true)
  })
})
