import { describe, expect, it, vi } from 'vitest'

import {
  TASKWRAITH_DESKTOP_HOST_ACTOR,
  TASKWRAITH_DESKTOP_HOST_CAPABILITIES,
  TASKWRAITH_DESKTOP_HOST_CLIENT_ID,
  createEmptyHostSnapshot,
  type HostCommand
} from '../../shared/hostProtocol'
import { createHostProjectionBroker, type HostProjectionClientPort } from './HostProjectionBroker'
import { HostProjectionTransportError } from './HostProjectionClient'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function deferredResult<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: Error) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

describe('HostProjectionBroker', () => {
  it('requires a dedicated broker actor to match its authenticated client identity', () => {
    expect(() =>
      createHostProjectionBroker({
        userDataPath: '/tmp/taskwraith-host-broker-test',
        appVersion: 'test',
        client: {
          clientId: 'thread-kind-client',
          clientClass: 'desktop',
          clientVersion: 'test'
        },
        actor: TASKWRAITH_DESKTOP_HOST_ACTOR,
        createClient: vi.fn()
      })
    ).toThrow('actor must match')
  })

  /**
   * The regression this guard exists for: three main-process consumers share
   * TASKWRAITH_DESKTOP_HOST_ACTOR, so they share ONE Host session, and
   * HostSession.bind only retains/narrows an existing grant. A consumer asking
   * for less silently stripped `history` from the desktop's own session, so
   * every thread.catalogue read failed `unauthorized` until the Host restarted.
   */
  it('refuses a narrowed capability request under the shared Desktop identity', () => {
    expect(() =>
      createHostProjectionBroker({
        userDataPath: '/tmp/taskwraith-host-broker-test',
        appVersion: 'test',
        client: {
          clientId: TASKWRAITH_DESKTOP_HOST_CLIENT_ID,
          clientClass: 'desktop',
          clientVersion: 'test'
        },
        actor: TASKWRAITH_DESKTOP_HOST_ACTOR,
        capabilities: ['bootstrap', 'commands', 'receipts'],
        createClient: vi.fn()
      })
    ).toThrow('narrows the shared session')
  })

  it('admits a narrow grant for a consumer that mints its own client id', () => {
    expect(() =>
      createHostProjectionBroker({
        userDataPath: '/tmp/taskwraith-host-broker-test',
        appVersion: 'test',
        client: { clientId: 'thread-kind-client', clientClass: 'desktop', clientVersion: 'test' },
        actor: {
          actorId: 'thread-kind-client',
          clientId: 'thread-kind-client',
          clientClass: 'desktop'
        },
        capabilities: ['bootstrap', 'commands', 'receipts', 'setup'],
        createClient: vi.fn()
      })
    ).not.toThrow()
  })

  it('defaults the shared Desktop identity to the canonical grant', () => {
    const createClient = vi.fn()
    createHostProjectionBroker({
      userDataPath: '/tmp/taskwraith-host-broker-test',
      appVersion: 'test',
      createClient
    })
    // Non-vacuous: the canonical set must actually carry what the app reads.
    expect([...TASKWRAITH_DESKTOP_HOST_CAPABILITIES]).toEqual(
      expect.arrayContaining(['history', 'snapshot', 'deltas'])
    )
  })

  it('single-flights one authenticated Desktop session across concurrent consumers', async () => {
    const gate = deferred()
    const snapshot = createEmptyHostSnapshot({ generation: 1, cursor: 0 })
    const client: HostProjectionClientPort = {
      connect: vi.fn(() => gate.promise),
      getSnapshot: vi.fn(async () => ({ snapshot })),
      getDeltasSince: vi.fn(async () => ({
        result: {
          kind: 'deltas' as const,
          generation: 1,
          fromCursor: 0,
          toCursor: 0,
          deltas: []
        }
      })),
      submitCommand: vi.fn(),
      lookupReceipt: vi.fn(),
      close: vi.fn()
    }
    const createClient = vi.fn(() => client)
    const broker = createHostProjectionBroker({
      userDataPath: '/tmp/taskwraith-host-broker-test',
      appVersion: 'test',
      createClient
    })

    const snapshotWork = broker.snapshot()
    const deltaWork = broker.deltasSince({ generation: 1, cursor: 0 })
    expect(createClient).toHaveBeenCalledTimes(1)
    gate.resolve()

    await expect(snapshotWork).resolves.toEqual({ ok: true, snapshot })
    await expect(deltaWork).resolves.toMatchObject({ ok: true })
    expect(client.connect).toHaveBeenCalledTimes(1)

    broker.close()
    expect(client.close).toHaveBeenCalledTimes(1)
  })

  it('replaces renderer-supplied actor identity before command submission', async () => {
    const submitCommand = vi.fn(async (_command: HostCommand) => {
      throw new Error('stop after actor observation')
    })
    const client = {
      connect: vi.fn(async () => undefined),
      getSnapshot: vi.fn(),
      getDeltasSince: vi.fn(),
      submitCommand,
      lookupReceipt: vi.fn(),
      close: vi.fn()
    } satisfies HostProjectionClientPort
    const broker = createHostProjectionBroker({
      userDataPath: '/tmp/taskwraith-host-broker-test',
      appVersion: 'test',
      createClient: () => client
    })
    const command: HostCommand = {
      type: 'host.command',
      protocolVersion: 2,
      commandId: '1b8ca3b7-f2cd-4997-9a5a-65ec35178ea4',
      idempotencyKey: 'actor-test',
      actor: { actorId: 'renderer', clientId: 'renderer', clientClass: 'test' },
      name: 'ping',
      target: {},
      arguments: {},
      issuedAt: '2026-08-12T00:00:00.000Z'
    }

    await expect(broker.submitCommand(command)).resolves.toMatchObject({ ok: false })
    expect(submitCommand).toHaveBeenCalledWith(
      expect.objectContaining({ actor: TASKWRAITH_DESKTOP_HOST_ACTOR })
    )
  })

  it('does not let a late failure from an old client close its connected replacement', async () => {
    const snapshot = createEmptyHostSnapshot({ generation: 1, cursor: 0 })
    const firstFailure = deferredResult<{ snapshot: typeof snapshot }>()
    const lateFailure = deferredResult<{ snapshot: typeof snapshot }>()
    let oldConnected = true
    const oldClient = {
      get connected() {
        return oldConnected
      },
      connect: vi.fn(async () => undefined),
      getSnapshot: vi
        .fn<() => Promise<{ snapshot: typeof snapshot }>>()
        .mockImplementationOnce(() => firstFailure.promise)
        .mockImplementationOnce(() => lateFailure.promise),
      getDeltasSince: vi.fn(),
      submitCommand: vi.fn(),
      lookupReceipt: vi.fn(),
      close: vi.fn(() => {
        oldConnected = false
      })
    } satisfies HostProjectionClientPort & { readonly connected: boolean }
    let replacementConnected = true
    const replacement = {
      get connected() {
        return replacementConnected
      },
      connect: vi.fn(async () => {
        replacementConnected = true
      }),
      getSnapshot: vi.fn(async () => ({ snapshot })),
      getDeltasSince: vi.fn(),
      submitCommand: vi.fn(),
      lookupReceipt: vi.fn(),
      close: vi.fn(() => {
        replacementConnected = false
      })
    } satisfies HostProjectionClientPort & { readonly connected: boolean }
    const createClient = vi
      .fn<() => HostProjectionClientPort>()
      .mockReturnValueOnce(oldClient)
      .mockReturnValue(replacement)
    const broker = createHostProjectionBroker({
      userDataPath: '/tmp/taskwraith-host-broker-test',
      appVersion: 'test',
      createClient
    })

    const failedRequest = broker.snapshot()
    const lateRequest = broker.snapshot()
    await vi.waitFor(() => expect(oldClient.getSnapshot).toHaveBeenCalledTimes(2))
    oldConnected = false
    firstFailure.reject(new Error('old transport disconnected'))
    await expect(failedRequest).resolves.toMatchObject({ ok: false })

    await expect(broker.snapshot()).resolves.toEqual({ ok: true, snapshot })
    expect(createClient).toHaveBeenCalledTimes(2)
    lateFailure.reject(new Error('late old-client sibling failure'))
    await expect(lateRequest).resolves.toMatchObject({ ok: false })

    expect(replacement.close).not.toHaveBeenCalled()
    await expect(broker.snapshot()).resolves.toEqual({ ok: true, snapshot })
    expect(createClient).toHaveBeenCalledTimes(2)
  })

  it.each(['unauthorized', 'host_unavailable'] as const)(
    'retains a connected client after the typed request-level Host error %s',
    async (errorCode) => {
      const snapshot = createEmptyHostSnapshot({ generation: 1, cursor: 0 })
      let connected = true
      const client = {
        get connected() {
          return connected
        },
        connect: vi.fn(async () => {
          connected = true
        }),
        getSnapshot: vi.fn(async () => ({ snapshot })),
        getDeltasSince: vi.fn(),
        submitCommand: vi.fn(),
        lookupReceipt: vi.fn(),
        maintainThreadCatalogue: vi.fn(async () => {
          throw new HostProjectionTransportError(errorCode)
        }),
        close: vi.fn(() => {
          connected = false
        })
      } satisfies HostProjectionClientPort & { readonly connected: boolean }
      const createClient = vi.fn(() => client)
      const broker = createHostProjectionBroker({
        userDataPath: '/tmp/taskwraith-host-broker-test',
        appVersion: 'test',
        createClient
      })

      await expect(
        broker.maintainThreadCatalogue?.({ method: 'repair-source', chatId: 'chat-1' })
      ).rejects.toThrow(errorCode)
      expect(client.close).not.toHaveBeenCalled()
      await expect(broker.snapshot()).resolves.toEqual({ ok: true, snapshot })
      expect(createClient).toHaveBeenCalledTimes(1)
    }
  )
})
