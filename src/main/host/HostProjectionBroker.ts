import type {
  HostCommand,
  HostCommandReceipt,
  HostCursorPosition,
  HostDeltasSinceResult,
  HostSnapshot
} from '../../shared/hostProtocol'
import {
  TASKWRAITH_DESKTOP_HOST_ACTOR,
  TASKWRAITH_DESKTOP_HOST_CLIENT_ID
} from '../../shared/hostProtocol'
import { HostProjectionClient } from './HostProjectionClient'

const DESKTOP_HOST_CAPABILITIES = [
  'bootstrap',
  'snapshot',
  'deltas',
  'health',
  'commands',
  'receipts',
  'channels'
] as const

export type HostProjectionSnapshotResult =
  | { readonly ok: true; readonly snapshot: HostSnapshot }
  | { readonly ok: false; readonly error: string }

export type HostProjectionDeltasResult =
  | { readonly ok: true; readonly result: HostDeltasSinceResult }
  | { readonly ok: false; readonly error: string }

export type HostProjectionCommandResult =
  | { readonly ok: true; readonly receipt: HostCommandReceipt }
  | { readonly ok: false; readonly error: string }

export type HostProjectionReceiptLookupResult =
  | { readonly ok: true; readonly receipt: HostCommandReceipt }
  | { readonly ok: false; readonly error: string }

/** The narrow slice of HostProjectionClient used by the Desktop broker. */
export interface HostProjectionClientPort {
  connect(): Promise<unknown>
  getSnapshot(): Promise<{ snapshot: HostSnapshot }>
  getDeltasSince(position: HostCursorPosition): Promise<{ result: HostDeltasSinceResult }>
  submitCommand(command: HostCommand): Promise<HostCommandReceipt>
  lookupReceipt(params: { commandId: string }): Promise<HostCommandReceipt>
  close(): void
}

export interface HostProjectionBroker {
  snapshot(): Promise<HostProjectionSnapshotResult>
  deltasSince(position: HostCursorPosition): Promise<HostProjectionDeltasResult>
  submitCommand(command: HostCommand): Promise<HostProjectionCommandResult>
  lookupReceipt(commandId: string): Promise<HostProjectionReceiptLookupResult>
  close(): void
}

export interface HostProjectionBrokerOptions {
  readonly userDataPath: string
  readonly appVersion: string
  readonly createClient?: () => HostProjectionClientPort
}

function errorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  const value = String(error)
  return value.length > 0 ? value : 'unknown host projection failure'
}

/** One authenticated Desktop Host session shared by every main-process consumer. */
export function createHostProjectionBroker(
  options: HostProjectionBrokerOptions
): HostProjectionBroker {
  if (!options || typeof options.userDataPath !== 'string' || !options.userDataPath) {
    throw new Error('HostProjectionBroker requires userDataPath')
  }
  if (typeof options.appVersion !== 'string' || !options.appVersion) {
    throw new Error('HostProjectionBroker requires appVersion')
  }

  const createClient =
    options.createClient ??
    ((): HostProjectionClientPort =>
      new HostProjectionClient({
        client: {
          clientId: TASKWRAITH_DESKTOP_HOST_CLIENT_ID,
          clientClass: 'desktop',
          clientVersion: options.appVersion
        },
        capabilities: [...DESKTOP_HOST_CAPABILITIES],
        userDataPath: options.userDataPath
      }) as unknown as HostProjectionClientPort)

  let client: HostProjectionClientPort | null = null
  let connecting: Promise<HostProjectionClientPort> | null = null
  let connectingClient: HostProjectionClientPort | null = null
  let connectionEpoch = 0

  const closeClient = (candidate: HostProjectionClientPort | null): void => {
    if (!candidate) return
    try {
      candidate.close()
    } catch {
      // Best-effort teardown must not mask the operation failure.
    }
  }

  const discardClient = (): void => {
    const previous = client
    const pending = connectingClient
    connectionEpoch += 1
    client = null
    connecting = null
    connectingClient = null
    closeClient(previous)
    if (pending !== previous) closeClient(pending)
  }

  const ensureClient = async (): Promise<HostProjectionClientPort> => {
    if (client) return client
    if (connecting) return connecting
    const next = createClient()
    const epoch = connectionEpoch
    const work = (async (): Promise<HostProjectionClientPort> => {
      try {
        await next.connect()
        if (epoch !== connectionEpoch) {
          closeClient(next)
          throw new Error('Host projection connection was superseded')
        }
        client = next
        return next
      } catch (error) {
        if (client !== next) closeClient(next)
        throw error
      }
    })()
    connecting = work
    connectingClient = next
    try {
      return await work
    } finally {
      if (connecting === work) {
        connecting = null
        connectingClient = null
      }
    }
  }

  const withClient = async <T>(
    run: (active: HostProjectionClientPort) => Promise<T>
  ): Promise<{ ok: true; value: T } | { ok: false; error: string }> => {
    try {
      const active = await ensureClient()
      return { ok: true, value: await run(active) }
    } catch (error) {
      discardClient()
      return { ok: false, error: errorText(error) }
    }
  }

  return {
    async snapshot() {
      const outcome = await withClient((active) => active.getSnapshot())
      return outcome.ok
        ? { ok: true, snapshot: outcome.value.snapshot }
        : { ok: false, error: outcome.error }
    },

    async deltasSince(position) {
      const outcome = await withClient((active) => active.getDeltasSince(position))
      return outcome.ok
        ? { ok: true, result: outcome.value.result }
        : { ok: false, error: outcome.error }
    },

    async submitCommand(command) {
      const authenticatedCommand: HostCommand = {
        ...command,
        actor: { ...TASKWRAITH_DESKTOP_HOST_ACTOR }
      }
      const outcome = await withClient((active) => active.submitCommand(authenticatedCommand))
      return outcome.ok ? { ok: true, receipt: outcome.value } : { ok: false, error: outcome.error }
    },

    async lookupReceipt(commandId) {
      const outcome = await withClient((active) => active.lookupReceipt({ commandId }))
      return outcome.ok ? { ok: true, receipt: outcome.value } : { ok: false, error: outcome.error }
    },

    close: discardClient
  }
}
