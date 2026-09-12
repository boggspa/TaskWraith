import type {
  ThreadCatalogueReadQuery,
  ThreadCatalogueMaintenanceQuery
} from '../../shared/threadCatalogueProtocol'
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
  queryThreadCatalogue?<T = unknown>(request: ThreadCatalogueReadQuery): Promise<T>
  maintainThreadCatalogue?<T = unknown>(request: ThreadCatalogueMaintenanceQuery): Promise<T>
}

export interface HostProjectionBroker {
  maintainThreadCatalogue?<T = unknown>(request: ThreadCatalogueMaintenanceQuery): Promise<T>
  queryThreadCatalogue?<T = unknown>(request: ThreadCatalogueReadQuery): Promise<T>
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
      const reusableRequestFailure =
        lease?.client.connected === true && error instanceof HostProjectionTransportError
      if (lease && !reusableRequestFailure) discardClient(lease)
      return { ok: false, error: errorText(error) }
    }
  }

  const broker: HostProjectionBroker = {
    async maintainThreadCatalogue<T>(request: ThreadCatalogueMaintenanceQuery): Promise<T> {
      const outcome = await withClient(async (active) => {
        if (!active.maintainThreadCatalogue) throw new Error('History maintenance is unavailable')
        return active.maintainThreadCatalogue<T>(request)
      })
      if (!outcome.ok) throw new Error(outcome.error)
      return outcome.value
    },
    async queryThreadCatalogue<T>(request: ThreadCatalogueReadQuery): Promise<T> {
      const outcome = await withClient(async (active) => {
        if (!active.queryThreadCatalogue) throw new Error('History catalogue is unavailable')
        return active.queryThreadCatalogue<T>(request)
      })
      if (!outcome.ok) throw new Error(outcome.error)
      return outcome.value
    },
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
        actor: { ...actorIdentity }
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
  return broker
}
