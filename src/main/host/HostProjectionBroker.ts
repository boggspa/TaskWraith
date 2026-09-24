import type {
  ThreadCatalogueRequestOptions,
  ThreadCatalogueReadQuery,
  ThreadCatalogueMaintenanceQuery
} from '../../shared/threadCatalogueProtocol'
import {
  threadCatalogueRequestError,
  ThreadCatalogueRequestError
} from '../../shared/threadCatalogueRequestError'
import type {
  HostActorIdentity,
  HostAuthenticatedClientIdentity,
  HostCapability,
  HostCommand,
  HostCommandReceipt,
  HostCursorPosition,
  HostDeltasSinceResult,
  HostSnapshot
} from '../../shared/hostProtocol'
import {
  TASKWRAITH_DESKTOP_HOST_ACTOR,
  TASKWRAITH_DESKTOP_HOST_CAPABILITIES,
  TASKWRAITH_DESKTOP_HOST_CLIENT_ID
} from '../../shared/hostProtocol'
import { HostProjectionClient, HostProjectionTransportError } from './HostProjectionClient'

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
  /** Authenticated socket liveness after connect; absent legacy fakes fail closed. */
  readonly connected?: boolean
  connect(): Promise<unknown>
  getSnapshot(): Promise<{ snapshot: HostSnapshot }>
  getDeltasSince(position: HostCursorPosition): Promise<{ result: HostDeltasSinceResult }>
  submitCommand(command: HostCommand): Promise<HostCommandReceipt>
  lookupReceipt(params: { commandId: string }): Promise<HostCommandReceipt>
  close(): void
  queryThreadCatalogue?<T = unknown>(
    request: ThreadCatalogueReadQuery,
    options?: ThreadCatalogueRequestOptions
  ): Promise<T>
  maintainThreadCatalogue?<T = unknown>(request: ThreadCatalogueMaintenanceQuery): Promise<T>
  /** Say this socket is not a holder of the Host (`host.lease` decline). */
  declineHostLease?(): Promise<void>
}

/** What a broker request was doing when the Host answered a typed error. */
export type HostProjectionBrokerOperation =
  | 'snapshot'
  | 'deltas'
  | 'command'
  | 'receipt'
  | 'catalogue'
  | 'catalogue-maintenance'

/** One body-free Host error, reported for diagnosis (the poison detector). */
export interface HostProjectionTransportErrorReport {
  readonly code: HostProjectionTransportError['code']
  readonly operation: HostProjectionBrokerOperation
  /** The authenticated identity the failing socket bound as. */
  readonly clientId: string
  /** Whether the failing socket was still connected (a request-scoped refusal). */
  readonly connected: boolean
}

export interface HostProjectionBroker {
  maintainThreadCatalogue?<T = unknown>(request: ThreadCatalogueMaintenanceQuery): Promise<T>
  queryThreadCatalogue?<T = unknown>(
    request: ThreadCatalogueReadQuery,
    options?: ThreadCatalogueRequestOptions
  ): Promise<T>
  snapshot(): Promise<HostProjectionSnapshotResult>
  deltasSince(position: HostCursorPosition): Promise<HostProjectionDeltasResult>
  submitCommand(command: HostCommand): Promise<HostProjectionCommandResult>
  lookupReceipt(commandId: string): Promise<HostProjectionReceiptLookupResult>
  close(): void
}

export interface HostProjectionBrokerOptions {
  readonly userDataPath: string
  readonly appVersion: string
  readonly client?: HostAuthenticatedClientIdentity
  readonly actor?: HostActorIdentity
  readonly capabilities?: readonly HostCapability[]
  readonly createClient?: () => HostProjectionClientPort
  /**
   * Every typed Host error a request met, with the operation it failed and
   * the identity it ran under. Called synchronously; must not throw.
   */
  readonly onTransportError?: (report: HostProjectionTransportErrorReport) => void
}

function errorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  const value = String(error)
  return value.length > 0 ? value : 'unknown host projection failure'
}

/** Order-insensitive set comparison; the wire dedupes but does not sort. */
function sameCapabilitySet(
  left: readonly HostCapability[],
  right: readonly HostCapability[]
): boolean {
  const wanted = new Set(right)
  const got = new Set(left)
  return wanted.size === got.size && [...wanted].every((capability) => got.has(capability))
}

/**
 * A broker socket is a per-request connection, never a reason for the Host to
 * stay up: main's lease socket (`HostLeaseReasons`) is. A Host that predates
 * leases answers `unknown_request_kind` and has nothing to decline.
 */
async function declineLease(candidate: HostProjectionClientPort): Promise<void> {
  if (typeof candidate.declineHostLease !== 'function') return
  try {
    await candidate.declineHostLease()
  } catch (error) {
    if (error instanceof HostProjectionTransportError && error.code === 'unknown_request_kind') {
      return
    }
    throw error
  }
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

  const clientIdentity: HostAuthenticatedClientIdentity = options.client ?? {
    clientId: TASKWRAITH_DESKTOP_HOST_CLIENT_ID,
    clientClass: 'desktop',
    clientVersion: options.appVersion
  }
  const actorIdentity: HostActorIdentity = options.actor ?? {
    ...TASKWRAITH_DESKTOP_HOST_ACTOR
  }
  if (
    actorIdentity.clientId !== clientIdentity.clientId ||
    actorIdentity.clientClass !== clientIdentity.clientClass
  ) {
    throw new Error('HostProjectionBroker actor must match its authenticated client')
  }
  const capabilities = options.capabilities ?? TASKWRAITH_DESKTOP_HOST_CAPABILITIES
  // Consumers sharing the Desktop identity share ONE Host session, and
  // HostSession.bind only retains/narrows an existing grant. A consumer that
  // asks for less would silently strip the difference from every other
  // consumer for the life of the Host process, so refuse it loudly instead.
  // A consumer that genuinely needs a narrower grant needs its OWN client id.
  if (
    clientIdentity.clientId === TASKWRAITH_DESKTOP_HOST_CLIENT_ID &&
    !sameCapabilitySet(capabilities, TASKWRAITH_DESKTOP_HOST_CAPABILITIES)
  ) {
    throw new Error(
      'HostProjectionBroker consumers sharing the Desktop identity must request ' +
        'TASKWRAITH_DESKTOP_HOST_CAPABILITIES; a narrower request narrows the shared session'
    )
  }

  const createClient =
    options.createClient ??
    ((): HostProjectionClientPort =>
      new HostProjectionClient({
        client: clientIdentity,
        capabilities: [...capabilities],
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

  const discardClient = (expected?: {
    readonly client: HostProjectionClientPort
    readonly epoch: number
  }): void => {
    if (
      expected &&
      (expected.epoch !== connectionEpoch ||
        (client !== expected.client && connectingClient !== expected.client))
    ) {
      return
    }
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
        // Declined before any request can use the socket: a broker socket
        // never counts as a holder of the Host, only main's lease does.
        await declineLease(next)
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

  const reportTransportError = (
    operation: HostProjectionBrokerOperation,
    error: unknown,
    connected: boolean
  ): void => {
    if (!options.onTransportError || !(error instanceof HostProjectionTransportError)) return
    try {
      options.onTransportError({
        code: error.code,
        operation,
        clientId: clientIdentity.clientId,
        connected
      })
    } catch {
      // Diagnosis must never change the request's own outcome.
    }
  }

  const withClient = async <T>(
    operation: HostProjectionBrokerOperation,
    run: (active: HostProjectionClientPort) => Promise<T>
  ): Promise<{ ok: true; value: T } | { ok: false; error: string; errorCause: unknown }> => {
    let lease: { readonly client: HostProjectionClientPort; readonly epoch: number } | undefined
    try {
      const active = await ensureClient()
      lease = { client: active, epoch: connectionEpoch }
      return { ok: true, value: await run(active) }
    } catch (error) {
      // A body-free Host error is scoped to one request. When the exact
      // authenticated client remains connected, closing it would reject every
      // unrelated sibling and turn one valid refusal into connection churn.
      // Generic errors and typed errors observed after disconnect still evict
      // this exact lease. The epoch/client guard prevents a late rejection
      // from an older client from closing a replacement that already connected.
      const connected = lease?.client.connected === true
      const reusableRequestFailure =
        connected &&
        (error instanceof HostProjectionTransportError ||
          error instanceof ThreadCatalogueRequestError)
      reportTransportError(operation, error, connected)
      if (lease && !reusableRequestFailure) discardClient(lease)
      return { ok: false, error: errorText(error), errorCause: error }
    }
  }

  const broker: HostProjectionBroker = {
    async maintainThreadCatalogue<T>(request: ThreadCatalogueMaintenanceQuery): Promise<T> {
      const outcome = await withClient('catalogue-maintenance', async (active) => {
        if (!active.maintainThreadCatalogue) throw new Error('History maintenance is unavailable')
        return active.maintainThreadCatalogue<T>(request)
      })
      if (!outcome.ok) {
        const requestError = threadCatalogueRequestError(outcome.errorCause)
        if (requestError) throw requestError
        throw new Error(outcome.error)
      }
      return outcome.value
    },
    async queryThreadCatalogue<T>(
      request: ThreadCatalogueReadQuery,
      options: ThreadCatalogueRequestOptions = {}
    ): Promise<T> {
      const outcome = await withClient('catalogue', async (active) => {
        if (!active.queryThreadCatalogue) throw new Error('History catalogue is unavailable')
        return active.queryThreadCatalogue<T>(request, options)
      })
      if (!outcome.ok) {
        const requestError = threadCatalogueRequestError(outcome.errorCause)
        if (requestError) throw requestError
        throw new Error(outcome.error)
      }
      return outcome.value
    },
    async snapshot() {
      const outcome = await withClient('snapshot', (active) => active.getSnapshot())
      return outcome.ok
        ? { ok: true, snapshot: outcome.value.snapshot }
        : { ok: false, error: outcome.error }
    },

    async deltasSince(position) {
      const outcome = await withClient('deltas', (active) => active.getDeltasSince(position))
      return outcome.ok
        ? { ok: true, result: outcome.value.result }
        : { ok: false, error: outcome.error }
    },

    async submitCommand(command) {
      const authenticatedCommand: HostCommand = {
        ...command,
        actor: { ...actorIdentity }
      }
      const outcome = await withClient('command', (active) =>
        active.submitCommand(authenticatedCommand)
      )
      return outcome.ok ? { ok: true, receipt: outcome.value } : { ok: false, error: outcome.error }
    },

    async lookupReceipt(commandId) {
      const outcome = await withClient('receipt', (active) => active.lookupReceipt({ commandId }))
      return outcome.ok ? { ok: true, receipt: outcome.value } : { ok: false, error: outcome.error }
    },

    close: discardClient
  }
  return broker
}
