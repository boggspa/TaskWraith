/**
 * PairedHostProjectionGateway — Host v2 over the existing paired E2EE boundary.
 *
 * Each authenticated phone identity receives its own local HostProjectionClient
 * binding (`clientClass: ios`). The gateway never opens a listener, reads Host
 * stores, or fabricates lifecycle state: it connects to the already-supervised
 * local Host, forwards its versioned frames, and sends governed commands back
 * through that same Host authority path.
 */

import {
  decodeHostCommand,
  type HostBootstrapWelcome,
  type HostCapability,
  type HostCommand,
  type HostDeltasFrame,
  type HostHealthFrame,
  type HostSnapshotFrame
} from '../../shared/hostProtocol'
import {
  HOST_LOCAL_TRANSPORT_VERSION,
  decodeHostLocalTransportClientFrame,
  type HostLocalTransportRequest,
  type HostLocalTransportSuccessResult
} from '../../shared/hostProtocolTransport'
import {
  HostProjectionClient,
  type HostProjectionClientOptions
} from '../host/HostProjectionClient'

/** Remote/iOS remains on the existing projection ceiling until it has an explicit setup/history UX. */
const PAIRED_HOST_CAPABILITIES: readonly HostCapability[] = [
  'bootstrap',
  'snapshot',
  'deltas',
  'model-offers',
  'commands',
  'receipts',
  'health'
]

export const PAIRED_HOST_PROJECTION_METHODS = {
  request: 'bridge.requestHost',
  welcome: 'bridge.hostWelcome',
  snapshot: 'bridge.hostSnapshot',
  deltas: 'bridge.hostDeltas',
  health: 'bridge.hostHealth',
  state: 'bridge.hostState'
} as const

export type PairedHostProjectionPhase = 'connecting' | 'live' | 'reconnecting' | 'unavailable'

export interface PairedHostProjectionState {
  readonly phase: PairedHostProjectionPhase
  readonly generation?: number
  readonly cursor?: number
}

export interface PairedHostProjectionAttachment {
  /** Pinned phone identity public key; never supplied by the phone payload. */
  readonly deviceKey: string
  /** Stable pair id derived by the authenticated remote runtime. */
  readonly clientId: string
  readonly displayName?: string
  readonly send: (method: string, params?: unknown) => void
}

export interface PairedHostProjectionRetryHandle {
  cancel(): void
}

export interface PairedHostProjectionGatewayOptions {
  readonly userDataPath: string
  readonly clientVersion: string
  readonly createClient?: (options: HostProjectionClientOptions) => HostProjectionClient
  readonly scheduleRetry?: (
    callback: () => void,
    delayMs: number
  ) => PairedHostProjectionRetryHandle
  readonly retryBaseMs?: number
  readonly retryMaxMs?: number
  readonly log?: (line: string) => void
}

export class PairedHostProjectionRequestError extends Error {
  readonly code: string

  constructor(code: string) {
    super(`Paired Host projection request failed: ${code}`)
    this.name = 'PairedHostProjectionRequestError'
    this.code = code
  }
}

interface PairedHostProjectionSession {
  readonly deviceKey: string
  readonly clientId: string
  readonly client: HostProjectionClient
  displayName?: string
  send: (method: string, params?: unknown) => void
  connecting: Promise<void> | null
  seeded: boolean
  retryAttempt: number
  retryHandle: PairedHostProjectionRetryHandle | null
}

function isSafeIdentity(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 512 &&
    value.trim() === value &&
    !hasAsciiControlCharacter(value)
  )
}

function hasAsciiControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0)
    return code <= 0x1f || code === 0x7f
  })
}

function defaultScheduleRetry(
  callback: () => void,
  delayMs: number
): PairedHostProjectionRetryHandle {
  const timer = setTimeout(callback, delayMs)
  timer.unref?.()
  return { cancel: () => clearTimeout(timer) }
}

function decodePairedHostRequest(value: unknown): HostLocalTransportRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PairedHostProjectionRequestError('invalid_payload')
  }
  const record = value as Record<string, unknown>
  const decoded = decodeHostLocalTransportClientFrame({
    type: 'request',
    transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
    id: 'paired-host-request',
    kind: record.kind,
    params: record.params
  })
  if (!decoded.ok) {
    throw new PairedHostProjectionRequestError(decoded.error.code)
  }
  if (decoded.value.type !== 'request') {
    throw new PairedHostProjectionRequestError('invalid_frame')
  }
  return decoded.value
}

function requireBoundCommandActor(command: HostCommand, clientId: string): void {
  if (
    command.actor.clientClass !== 'ios' ||
    command.actor.clientId !== clientId ||
    command.actor.actorId !== clientId
  ) {
    throw new PairedHostProjectionRequestError('actor_mismatch')
  }
}

/**
 * Owns one local Host client per paired phone identity. A phone reconnect does
 * not create authority: the client rebinds using the same authenticated pair id
 * and receives a fresh authoritative snapshot before deltas continue.
 */
export class PairedHostProjectionGateway {
  private readonly options: Required<
    Pick<
      PairedHostProjectionGatewayOptions,
      'userDataPath' | 'clientVersion' | 'retryBaseMs' | 'retryMaxMs'
    >
  > &
    Pick<PairedHostProjectionGatewayOptions, 'log'>
  private readonly createClient: (options: HostProjectionClientOptions) => HostProjectionClient
  private readonly scheduleRetry: (
    callback: () => void,
    delayMs: number
  ) => PairedHostProjectionRetryHandle
  private readonly sessions = new Map<string, PairedHostProjectionSession>()

  constructor(options: PairedHostProjectionGatewayOptions) {
    if (!options || typeof options !== 'object') {
      throw new Error('PairedHostProjectionGateway requires options')
    }
    if (!options.userDataPath) {
      throw new Error('PairedHostProjectionGateway requires userDataPath')
    }
    if (!options.clientVersion) {
      throw new Error('PairedHostProjectionGateway requires clientVersion')
    }
    this.options = {
      userDataPath: options.userDataPath,
      clientVersion: options.clientVersion,
      retryBaseMs: Math.max(100, options.retryBaseMs ?? 500),
      retryMaxMs: Math.max(100, options.retryMaxMs ?? 30_000),
      ...(options.log ? { log: options.log } : {})
    }
    this.createClient = options.createClient ?? ((input) => new HostProjectionClient(input))
    this.scheduleRetry = options.scheduleRetry ?? defaultScheduleRetry
  }

  async attach(attachment: PairedHostProjectionAttachment): Promise<void> {
    if (!isSafeIdentity(attachment.deviceKey) || !isSafeIdentity(attachment.clientId)) {
      throw new Error('PairedHostProjectionGateway requires bounded authenticated identity')
    }
    if (typeof attachment.send !== 'function') {
      throw new Error('PairedHostProjectionGateway requires a send function')
    }

    const existing = this.sessions.get(attachment.deviceKey)
    if (existing) {
      if (existing.clientId !== attachment.clientId) {
        throw new Error('PairedHostProjectionGateway identity changed for an attached device')
      }
      existing.send = attachment.send
      existing.displayName = attachment.displayName
      await this.connectAndSeed(existing)
      return
    }

    const client = this.createClient({
      userDataPath: this.options.userDataPath,
      client: {
        clientId: attachment.clientId,
        clientClass: 'ios',
        clientVersion: this.options.clientVersion,
        subjectId: attachment.deviceKey,
        ...(attachment.displayName ? { displayName: attachment.displayName } : {})
      },
      capabilities: PAIRED_HOST_CAPABILITIES
    })
    const session: PairedHostProjectionSession = {
      deviceKey: attachment.deviceKey,
      clientId: attachment.clientId,
      client,
      displayName: attachment.displayName,
      send: attachment.send,
      connecting: null,
      seeded: false,
      retryAttempt: 0,
      retryHandle: null
    }
    this.sessions.set(attachment.deviceKey, session)
    this.bindClientEvents(session)
    this.sendState(session, { phase: 'connecting' })
    await this.connectAndSeed(session)
  }

  detach(deviceKey: string): void {
    const session = this.sessions.get(deviceKey)
    if (!session) return
    this.sessions.delete(deviceKey)
    session.retryHandle?.cancel()
    session.retryHandle = null
    session.client.close()
  }

  dispose(): void {
    for (const deviceKey of [...this.sessions.keys()]) this.detach(deviceKey)
  }

  get attachedCount(): number {
    return this.sessions.size
  }

  async request(deviceKey: string, value: unknown): Promise<HostLocalTransportSuccessResult> {
    const session = this.sessions.get(deviceKey)
    if (!session) throw new PairedHostProjectionRequestError('unauthorized')
    await this.connectAndSeed(session)
    const request = decodePairedHostRequest(value)

    switch (request.kind) {
      case 'snapshot.get': {
        const frame = await session.client.getSnapshot()
        session.seeded = true
        return { kind: 'snapshot.get', frame }
      }
      case 'deltas.since':
        return {
          kind: 'deltas.since',
          frame: await session.client.getDeltasSince(request.params)
        }
      case 'thread.offers':
        return {
          kind: 'thread.offers',
          offers: await session.client.getThreadOffers(request.params.threadId)
        }
      case 'provider.status':
      case 'provider.offers':
      case 'provider.auth.flows':
      case 'provider.auth.status':
      case 'thread.history':
      case 'history.since':
        throw new PairedHostProjectionRequestError('unauthorized')
      case 'receipt.lookup':
        return {
          kind: 'receipt.lookup',
          receipt: await session.client.lookupReceipt(request.params)
        }
      case 'health.get':
        return { kind: 'health.get', frame: await session.client.getHealth() }
      case 'command.submit': {
        const decoded = decodeHostCommand(request.params)
        if (!decoded.ok) throw new PairedHostProjectionRequestError('invalid_payload')
        requireBoundCommandActor(decoded.value, session.clientId)
        return {
          kind: 'command.submit',
          receipt: await session.client.submitCommand(decoded.value)
        }
      }
      case 'twmission.export': {
        const exported = await session.client.exportTwMission()
        // The phone can deterministically encode the verified bundle itself;
        // forwarding Uint8Array through JSON would duplicate the same bytes.
        return { kind: 'twmission.export', result: { bundle: exported.bundle } }
      }
    }
  }

  /** Targeted full resnapshot for an E2EE replay gap or explicit client retry. */
  async resync(deviceKey: string): Promise<boolean> {
    const session = this.sessions.get(deviceKey)
    if (!session) return false
    try {
      await this.connectAndSeed(session)
      const frame = await session.client.getSnapshot()
      if (!this.isCurrent(session)) return false
      session.seeded = true
      this.safeSend(session, PAIRED_HOST_PROJECTION_METHODS.snapshot, frame)
      return true
    } catch {
      return false
    }
  }

  private bindClientEvents(session: PairedHostProjectionSession): void {
    session.client.on('deltas', (frame: HostDeltasFrame) => {
      if (!this.isCurrent(session)) return
      this.safeSend(session, PAIRED_HOST_PROJECTION_METHODS.deltas, frame)
    })
    session.client.on('health', (frame: HostHealthFrame) => {
      if (!this.isCurrent(session)) return
      this.safeSend(session, PAIRED_HOST_PROJECTION_METHODS.health, frame)
    })
    session.client.on('hostClosing', () => {
      if (!this.isCurrent(session)) return
      session.seeded = false
      this.sendState(session, { phase: 'reconnecting' })
    })
    session.client.on('disconnected', () => {
      if (!this.isCurrent(session)) return
      session.seeded = false
      this.sendState(session, { phase: 'reconnecting' })
      this.scheduleReconnect(session)
    })
  }

  private async connectAndSeed(session: PairedHostProjectionSession): Promise<void> {
    if (!this.isCurrent(session)) {
      throw new PairedHostProjectionRequestError('unauthorized')
    }
    if (session.client.connected && session.seeded) return
    if (session.connecting) return session.connecting

    session.retryHandle?.cancel()
    session.retryHandle = null
    const work = (async (): Promise<void> => {
      try {
        let welcome: HostBootstrapWelcome | null = session.client.welcome
        if (!session.client.connected) {
          welcome = await session.client.connect()
        }
        if (!this.isCurrent(session)) return
        if (!welcome) throw new PairedHostProjectionRequestError('host_unavailable')
        this.safeSend(session, PAIRED_HOST_PROJECTION_METHODS.welcome, welcome)
        const frame: HostSnapshotFrame = await session.client.getSnapshot()
        if (!this.isCurrent(session)) return
        session.seeded = true
        session.retryAttempt = 0
        this.safeSend(session, PAIRED_HOST_PROJECTION_METHODS.snapshot, frame)
        this.sendState(session, {
          phase: 'live',
          generation: frame.snapshot.generation,
          cursor: frame.snapshot.cursor
        })
      } catch (error) {
        if (this.isCurrent(session)) {
          this.sendState(session, { phase: 'unavailable' })
          this.scheduleReconnect(session)
        }
        throw error
      }
    })()
    session.connecting = work
    try {
      await work
    } finally {
      if (session.connecting === work) session.connecting = null
    }
  }

  private scheduleReconnect(session: PairedHostProjectionSession): void {
    if (!this.isCurrent(session) || session.retryHandle) return
    const delay = Math.min(
      this.options.retryMaxMs,
      this.options.retryBaseMs * 2 ** Math.min(session.retryAttempt, 8)
    )
    session.retryAttempt += 1
    session.retryHandle = this.scheduleRetry(() => {
      session.retryHandle = null
      if (!this.isCurrent(session)) return
      void this.connectAndSeed(session).catch((error: unknown) => {
        this.options.log?.(
          `[paired-host] reconnect failed (${session.clientId}): ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      })
    }, delay)
  }

  private isCurrent(session: PairedHostProjectionSession): boolean {
    return this.sessions.get(session.deviceKey) === session
  }

  private safeSend(session: PairedHostProjectionSession, method: string, params?: unknown): void {
    if (!this.isCurrent(session)) return
    try {
      session.send(method, params)
    } catch (error) {
      this.options.log?.(
        `[paired-host] E2EE send failed (${session.clientId}): ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }
  }

  private sendState(session: PairedHostProjectionSession, state: PairedHostProjectionState): void {
    this.safeSend(session, PAIRED_HOST_PROJECTION_METHODS.state, state)
  }
}
