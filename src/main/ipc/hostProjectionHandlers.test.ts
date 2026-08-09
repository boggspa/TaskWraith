/**
 * Host Arc Wave 4.3a-wire + 4.3b — Desktop Host projection bridge tests.
 *
 * The load-bearing pins are the ones that stop the bridge lying to the
 * renderer: a failure must be reported as a failure, never as an empty
 * snapshot; pending receipts must never be rewritten as success; and the
 * command surface must ride the same client as snapshot (no parallel socket).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'

import type { HostCommand, HostCommandReceipt } from '../../shared/hostProtocol'
import { HOST_PROTOCOL_VERSION } from '../../shared/hostProtocol'
import {
  HOST_PROJECTION_COMMAND_SUBMIT_CHANNEL,
  HOST_PROJECTION_DELTAS_SINCE_CHANNEL,
  HOST_PROJECTION_RECEIPT_LOOKUP_CHANNEL,
  HOST_PROJECTION_SNAPSHOT_CHANNEL,
  registerHostProjectionHandlers,
  type HostProjectionClientPort,
  type HostProjectionCommandResult,
  type HostProjectionDeltasResult,
  type HostProjectionReceiptLookupResult,
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

function receipt(overrides: Partial<HostCommandReceipt> = {}): HostCommandReceipt {
  return {
    type: 'host.receipt',
    protocolVersion: HOST_PROTOCOL_VERSION,
    commandId: 'cmd-1',
    idempotencyKey: 'key-1',
    name: 'composer.send',
    actor: { actorId: 'desktop-1', clientId: 'desktop-1', clientClass: 'desktop' },
    authority: { decision: 'ask' },
    status: 'pending',
    commandFingerprint: 'a'.repeat(64),
    generation: 1,
    cursor: 1,
    createdAt: '2026-08-06T00:00:00.000Z',
    updatedAt: '2026-08-06T00:00:00.000Z',
    ...overrides
  }
}

function command(overrides: Partial<HostCommand> = {}): HostCommand {
  return {
    type: 'host.command',
    protocolVersion: HOST_PROTOCOL_VERSION,
    commandId: 'cmd-1',
    idempotencyKey: 'key-1',
    actor: { actorId: 'desktop-1', clientId: 'desktop-1', clientClass: 'desktop' },
    name: 'composer.send',
    target: { threadId: 'thread-1' },
    arguments: { text: 'hello' },
    issuedAt: '2026-08-06T00:00:00.000Z',
    ...overrides
  }
}

function clientPort(overrides: Partial<HostProjectionClientPort> = {}): HostProjectionClientPort {
  return {
    connect: vi.fn(async () => ({})),
    getSnapshot: vi.fn(async () => ({ snapshot: SNAPSHOT })),
    getDeltasSince: vi.fn(async ({ generation, cursor }) => ({
      result: {
        kind: 'deltas' as const,
        generation,
        fromCursor: cursor,
        toCursor: cursor,
        deltas: []
      }
    })),
    submitCommand: vi.fn(async () => receipt()),
    lookupReceipt: vi.fn(async () =>
      receipt({ status: 'succeeded', authority: { decision: 'allow' } })
    ),
    close: vi.fn(),
    ...overrides
  }
}

function register(createClient: () => HostProjectionClientPort): {
  snapshot: RegisteredHandler
  deltas: RegisteredHandler
  submit: RegisteredHandler
  lookup: RegisteredHandler
} {
  registerHostProjectionHandlers({
    userDataPath: '/tmp/userData',
    appVersion: '1.9.2',
    createClient
  })
  return {
    snapshot: handlerFor(HOST_PROJECTION_SNAPSHOT_CHANNEL),
    deltas: handlerFor(HOST_PROJECTION_DELTAS_SINCE_CHANNEL),
    submit: handlerFor(HOST_PROJECTION_COMMAND_SUBMIT_CHANNEL),
    lookup: handlerFor(HOST_PROJECTION_RECEIPT_LOOKUP_CHANNEL)
  }
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

  it('registers snapshot + delta catch-up + command.submit + receipt.lookup', () => {
    register(() => clientPort())

    const channels = mockedHandle.mock.calls.map(([channel]) => channel)
    expect(channels).toEqual([
      HOST_PROJECTION_SNAPSHOT_CHANNEL,
      HOST_PROJECTION_DELTAS_SINCE_CHANNEL,
      HOST_PROJECTION_COMMAND_SUBMIT_CHANNEL,
      HOST_PROJECTION_RECEIPT_LOOKUP_CHANNEL
    ])
  })

  it('is idempotent — removes before handling so a re-init cannot throw', () => {
    register(() => clientPort())
    // Electron throws on a duplicate handle(); that throw would abort whatever
    // startup step registers us.
    expect(mockedRemoveHandler).toHaveBeenCalledWith(HOST_PROJECTION_SNAPSHOT_CHANNEL)
    expect(mockedRemoveHandler).toHaveBeenCalledWith(HOST_PROJECTION_DELTAS_SINCE_CHANNEL)
    expect(mockedRemoveHandler).toHaveBeenCalledWith(HOST_PROJECTION_COMMAND_SUBMIT_CHANNEL)
    expect(mockedRemoveHandler).toHaveBeenCalledWith(HOST_PROJECTION_RECEIPT_LOOKUP_CHANNEL)
  })

  it('does not connect at registration time', () => {
    const connect = vi.fn(async () => ({}))
    register(() => clientPort({ connect }))
    expect(connect).not.toHaveBeenCalled()
  })
})

/* ------------------------------------------------------------------ */
/*  Delta catch-up                                                     */
/* ------------------------------------------------------------------ */

describe('registerHostProjectionHandlers · deltas', () => {
  it('passes the exact renderer position to the shared Host client', async () => {
    const getDeltasSince = vi.fn(async () => ({
      result: {
        kind: 'deltas' as const,
        generation: 3,
        fromCursor: 42,
        toCursor: 42,
        deltas: []
      }
    }))
    const { deltas } = register(() => clientPort({ getDeltasSince }))

    const result = (await deltas({}, { generation: 3, cursor: 42 })) as HostProjectionDeltasResult
    expect(result.ok).toBe(true)
    expect(getDeltasSince).toHaveBeenCalledWith({ generation: 3, cursor: 42 })
  })

  it('rejects malformed positions before touching Host', async () => {
    const getDeltasSince = vi.fn(async () => ({
      result: {
        kind: 'deltas' as const,
        generation: 1,
        fromCursor: 0,
        toCursor: 0,
        deltas: []
      }
    }))
    const { deltas } = register(() => clientPort({ getDeltasSince }))

    const result = (await deltas({}, { generation: 1, cursor: -1 })) as HostProjectionDeltasResult
    expect(result.ok).toBe(false)
    expect(getDeltasSince).not.toHaveBeenCalled()
  })
})

/* ------------------------------------------------------------------ */
/*  Snapshot fetch                                                    */
/* ------------------------------------------------------------------ */

describe('registerHostProjectionHandlers · snapshot', () => {
  it('returns the snapshot Host actually served', async () => {
    const { snapshot } = register(() => clientPort())
    const result = (await snapshot({})) as HostProjectionSnapshotResult

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.snapshot).toBe(SNAPSHOT)
  })

  it('connects once and reuses the client across requests', async () => {
    const connect = vi.fn(async () => ({}))
    const port = clientPort({ connect })
    const { snapshot } = register(() => port)

    await snapshot({})
    await snapshot({})
    expect(connect).toHaveBeenCalledTimes(1)
  })

  it('returns ok:false with the error text — never an empty snapshot', async () => {
    const { snapshot } = register(() =>
      clientPort({
        getSnapshot: vi.fn(async () => {
          throw new Error('snapshot timed out')
        })
      })
    )

    const result = (await snapshot({})) as HostProjectionSnapshotResult
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('snapshot timed out')
  })

  it('never throws across the IPC boundary', async () => {
    // A thrown Error loses its type on the wire and arrives as a generic
    // "Error invoking remote method" string, which the renderer cannot report
    // honestly.
    const { snapshot } = register(() =>
      clientPort({
        connect: vi.fn(async () => {
          throw new Error('boom')
        })
      })
    )

    await expect(snapshot({})).resolves.toBeDefined()
  })

  it('discards the failed client so the next call reconnects', async () => {
    let attempt = 0
    const close = vi.fn()
    const ports: HostProjectionClientPort[] = []

    const { snapshot } = register(() => {
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

    const first = (await snapshot({})) as HostProjectionSnapshotResult
    expect(first.ok).toBe(false)
    expect(close).toHaveBeenCalledTimes(1)

    // A transient Host restart must heal on the next fetch rather than pinning
    // a dead socket forever.
    const second = (await snapshot({})) as HostProjectionSnapshotResult
    expect(second.ok).toBe(true)
    expect(ports).toHaveLength(2)
  })

  it('survives a close() that throws while discarding', async () => {
    let attempt = 0
    const { snapshot } = register(() => {
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
    const first = (await snapshot({})) as HostProjectionSnapshotResult
    expect(first.ok).toBe(false)
    if (!first.ok) expect(first.error).toBe('dropped')

    const second = (await snapshot({})) as HostProjectionSnapshotResult
    expect(second.ok).toBe(true)
  })
})

/* ------------------------------------------------------------------ */
/*  Wave 4.3b — command.submit + receipt.lookup                       */
/* ------------------------------------------------------------------ */

describe('registerHostProjectionHandlers · Wave 4.3b commands', () => {
  it('submits a HostCommand and returns the receipt Host served — pending stays pending', async () => {
    const pending = receipt({ status: 'pending', authority: { decision: 'ask' } })
    const submitCommand = vi.fn(async () => pending)
    const { submit } = register(() => clientPort({ submitCommand }))

    const result = (await submit({}, command())) as HostProjectionCommandResult
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.receipt.status).toBe('pending')
      expect(result.receipt.authority.decision).toBe('ask')
      expect(result.receipt.status).not.toBe('succeeded')
    }
    expect(submitCommand).toHaveBeenCalledTimes(1)
  })

  it('rejects a malformed command payload without calling Host', async () => {
    const submitCommand = vi.fn(async () => receipt())
    const { submit } = register(() => clientPort({ submitCommand }))

    const result = (await submit({}, { commandId: 'only-id' })) as HostProjectionCommandResult
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/invalid/i)
    expect(submitCommand).not.toHaveBeenCalled()
  })

  it('looks up a receipt by commandId', async () => {
    const lookupReceipt = vi.fn(async () =>
      receipt({ status: 'succeeded', authority: { decision: 'allow' } })
    )
    const { lookup } = register(() => clientPort({ lookupReceipt }))

    const result = (await lookup({}, { commandId: 'cmd-1' })) as HostProjectionReceiptLookupResult
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.receipt.status).toBe('succeeded')
    expect(lookupReceipt).toHaveBeenCalledWith({ commandId: 'cmd-1' })
  })

  it('rejects receipt lookup without commandId', async () => {
    const lookupReceipt = vi.fn(async () => receipt())
    const { lookup } = register(() => clientPort({ lookupReceipt }))

    const result = (await lookup({}, {})) as HostProjectionReceiptLookupResult
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/commandId/i)
    expect(lookupReceipt).not.toHaveBeenCalled()
  })

  it('reuses one client across snapshot + submit + lookup (no parallel mutation socket)', async () => {
    const connect = vi.fn(async () => ({}))
    const port = clientPort({ connect })
    const handlers = register(() => port)

    await handlers.snapshot({})
    await handlers.submit({}, command())
    await handlers.lookup({}, { commandId: 'cmd-1' })
    expect(connect).toHaveBeenCalledTimes(1)
  })

  it('returns ok:false for submit failures — never throws across IPC', async () => {
    const { submit } = register(() =>
      clientPort({
        submitCommand: vi.fn(async () => {
          throw new Error('authority denied')
        })
      })
    )

    const result = (await submit({}, command())) as HostProjectionCommandResult
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('authority denied')
  })
})
