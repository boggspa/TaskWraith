/**
 * Host Arc Wave 4.1 — reusable authenticated v2 projection client.
 *
 * Speaks the Host local transport (Wave 3.2) against HostLocalServer (Wave 3.3):
 * discovery → token → socket/pipe → hello/welcome → request/response + events.
 *
 * Mirrors the shipped v1 TUI control client shape (`TaskWraithControlClient`)
 * but binds the DISTINCT v2 host path/token/discovery namespace and the
 * body-free Host transport codecs. Electron-free; zero AppStore / Bridge /
 * provider / store imports. Presentation cutovers (Desktop/TUI/iOS) consume
 * this module later — this slice owns the wire client only.
 *
 * Cached snapshot bytes are presentation aids only: they never become
 * authority. Unavailable telemetry stays unavailable (never fabricated zero).
 */

import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { lstat, realpath } from 'node:fs/promises'
import { createConnection, type Socket } from 'node:net'

import {
  HOST_PROTOCOL_VERSION,
  HOST_PROJECTION_VERSION,
  type HostBootstrapHello,
  type HostBootstrapWelcome,
  type HostCapability,
  type HostClientClass,
  type HostCommand,
  type HostCommandReceipt,
  type HostCursorPosition,
  type HostDeltasFrame,
  type HostHealthFrame,
  type HostProjectionFreshness,
  type HostSnapshot,
  type HostSnapshotFrame
} from '../shared/hostProtocol'
import type { TaskWraithControlThreadOffers } from '../shared/taskWraithControlProtocol'
import type {
  HostHistoryDeltasFrame,
  HostHistorySinceRequest,
  HostHistorySinceResult,
  HostThreadHistoryPage,
  HostThreadHistoryRequest
} from '../shared/hostHistoryProtocol'
import type {
  HostProviderAuthFlowProjection,
  HostProviderAuthStatusProjection,
  HostProviderOffersProjection,
  HostProviderStatusProjection
} from '../shared/hostSetupProtocol'
import {
  HOST_LOCAL_TRANSPORT_VERSION,
  decodeHostLocalTransportHostFrame,
  encodeHostLocalTransportClientFrame,
  type HostLocalTransportErrorCode,
  type HostLocalTransportEvent,
  type HostLocalTransportReceiptLookupParams,
  type HostLocalTransportRequest,
  type HostLocalTransportSuccessResult,
  type HostWorkspaceGitReadParams,
  type HostWorkspaceGitReadResult
} from '../shared/hostProtocolTransport'
import {
  decodeTaskWraithHostDiscovery,
  taskWraithHostDiscoveryPath,
  taskWraithHostSocketPath,
  taskWraithHostTokenPath,
  type TaskWraithHostDiscovery
} from '../shared/taskWraithHostPaths.node'
import {
  HOST_LOCAL_CONTROL_MAX_DISCOVERY_BYTES,
  HOST_LOCAL_CONTROL_MAX_TOKEN_BYTES,
  readPrivateLocalControlArtifact
} from '../shared/hostLocalControlArtifacts.node'
import {
  TW_MISSION_MAX_BUNDLE_BYTES,
  encodeTwMissionBundle,
  importTwMissionBundleBytes,
  type TwMissionBundle
} from '../host-shared/twmission'

/** Bounded compact export plus its transport envelope. */
export const HOST_PROJECTION_CLIENT_MAX_LINE_BYTES = TW_MISSION_MAX_BUNDLE_BYTES + 65_536

const DEFAULT_CLIENT_CAPABILITIES: readonly HostCapability[] = [
  'bootstrap',
  'snapshot',
  'deltas',
  'model-offers',
  'commands',
  'receipts',
  'health',
  'recovery',
  // Requested, not assumed. The Host advertises workspace-git only when a git
  // binary actually resolves, and the welcome is an INTERSECTION of request and
  // offer, so asking for it on a Host without git simply leaves it unoffered.
  'workspace-git'
]

/**
 * Result of a workspace git read.
 *
 * `available: false` is a first-class state, not an error: a Host with no git
 * binary never offers the capability, and the TUI must render that as "git is
 * not available here" rather than as a failure.
 */
export type HostWorkspaceGitReadOutcome =
  | { readonly available: true; readonly result: HostWorkspaceGitReadResult }
  | { readonly available: false; readonly reason: 'capability-unavailable' }

export interface HostProjectionClientIdentity {
  clientId: string
  clientClass: HostClientClass
  clientVersion: string
  subjectId?: string
  displayName?: string
}

export interface HostProjectionClientOptions {
  /** Authenticated client identity presented in the hello frame. */
  client: HostProjectionClientIdentity
  /** Capability request; Host intersects with its offer. */
  capabilities?: readonly HostCapability[]
  /** Best-effort extensions requested only on the first hello. */
  optionalCapabilities?: readonly HostCapability[]
  /** Injected userData path; defaults require an explicit discoveryPath. */
  userDataPath?: string
  /** Override discovery JSON path (tests). */
  discoveryPath?: string
  connectTimeoutMs?: number
  requestTimeoutMs?: number
}

export interface HostProjectionCachedSnapshot {
  snapshot: HostSnapshot
  /** How this cache relates to the live Host generation/cursor. */
  freshness: HostProjectionFreshness
  /** Generation observed when the snapshot was last received live. */
  generation: number
  /** Cursor observed when the snapshot was last received live. */
  cursor: number
  receivedAt: string
}

export interface HostProjectionTwMissionExport {
  readonly bundle: TwMissionBundle
  readonly bytes: Uint8Array
}

export interface HostProjectionClientEvents {
  welcome: [HostBootstrapWelcome]
  deltas: [HostDeltasFrame, sequence: number]
  health: [HostHealthFrame, sequence: number]
  history: [HostHistoryDeltasFrame, sequence: number]
  hostClosing: [sequence: number]
  /**
   * Fired when the socket drops after a successful welcome, and the close was
   * not client-initiated. Cached snapshot (if any) is retained as `stale`.
   */
  disconnected: [Error | null]
}

type PendingRequest = {
  resolve: (value: HostLocalTransportSuccessResult) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * Distinct from a generic connection failure so UIs can say "update the App"
 * rather than "retrying" when discovery advertises an unsupported version.
 */
export class HostProjectionIncompatibleProtocolError extends Error {
  constructor(message = 'TaskWraith Host protocol version is not supported.') {
    super(message)
    this.name = 'HostProjectionIncompatibleProtocolError'
  }
}

/**
 * Body-free transport / request failure. Carries the closed wire `code` only —
 * never host prose (Host frames are body-free by contract).
 */
export class HostProjectionTransportError extends Error {
  readonly code: HostLocalTransportErrorCode

  constructor(code: HostLocalTransportErrorCode) {
    super(`Host projection transport error: ${code}`)
    this.name = 'HostProjectionTransportError'
    this.code = code
  }
}

/** Internal retry sentinel: TCP accepted then closed without a welcome frame. */
class HostProjectionHandshakeClosedBeforeWelcomeError extends Error {
  constructor() {
    super('TaskWraith Host closed before welcome.')
    this.name = 'HostProjectionHandshakeClosedBeforeWelcomeError'
  }
}

function stableDedupCapabilities(capabilities: readonly HostCapability[]): HostCapability[] {
  const seen = new Set<HostCapability>()
  const output: HostCapability[] = []
  for (const capability of capabilities) {
    if (seen.has(capability)) continue
    seen.add(capability)
    output.push(capability)
  }
  return output
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function parseDiscovery(raw: string): TaskWraithHostDiscovery {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error('TaskWraith Host discovery is malformed.')
  }
  const decoded = decodeTaskWraithHostDiscovery(value)
  if (!decoded.ok) {
    if (isRecord(value) && value.protocolVersion !== 2) {
      throw new HostProjectionIncompatibleProtocolError()
    }
    throw new Error(`TaskWraith Host discovery is invalid: ${decoded.error}`)
  }
  return decoded.discovery
}

async function canonicalProfileDirectory(path: string): Promise<string> {
  const canonical = await realpath(path)
  const stat = await lstat(canonical)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('TaskWraith Host profile directory is unsafe.')
  }
  return canonical
}

/**
 * Production discovery always carries a unix-socket / named-pipe path.
 * Tests under sandboxes that refuse `listen(path)` may advertise
 * `127.0.0.1:<port>` instead — accepted only as an explicit loopback TCP form.
 */
function connectDiscoverySocket(socketPath: string): Socket {
  const loopback = /^127\.0\.0\.1:(\d+)$/.exec(socketPath)
  if (loopback) {
    return createConnection({ host: '127.0.0.1', port: Number(loopback[1]) })
  }
  return createConnection(socketPath)
}

/**
 * Authenticated Host v2 projection client for Desktop / TUI / paired iOS
 * cutovers. Connection is explicit; reconnect is a fresh `connect()` that
 * must re-read discovery (token rotates per Host instance).
 */
export class HostProjectionClient extends EventEmitter<HostProjectionClientEvents> {
  private readonly options: {
    client: HostProjectionClientIdentity
    capabilities: readonly HostCapability[]
    optionalCapabilities: readonly HostCapability[]
    userDataPath?: string
    discoveryPath?: string
    connectTimeoutMs: number
    requestTimeoutMs: number
  }
  private socket: Socket | null = null
  private buffer = ''
  private pending = new Map<string, PendingRequest>()
  private connectResolve: ((welcome: HostBootstrapWelcome) => void) | null = null
  private connectReject: ((error: Error) => void) | null = null
  private connectTimer: ReturnType<typeof setTimeout> | null = null
  private closedByClient = false
  private eventSequenceSeen = -1
  private connectAccepted = false
  private discoveryIdentity: Pick<TaskWraithHostDiscovery, 'hostId' | 'hostVersion'> | null = null

  welcome: HostBootstrapWelcome | null = null
  /**
   * Last coherent snapshot retained for presentation. Marked `stale` on
   * disconnect. Never invents empty families as live telemetry.
   */
  cachedSnapshot: HostProjectionCachedSnapshot | null = null

  constructor(options: HostProjectionClientOptions) {
    super()
    this.options = {
      client: options.client,
      capabilities: stableDedupCapabilities(options.capabilities ?? DEFAULT_CLIENT_CAPABILITIES),
      optionalCapabilities: stableDedupCapabilities(options.optionalCapabilities ?? []),
      userDataPath: options.userDataPath,
      discoveryPath: options.discoveryPath,
      connectTimeoutMs: options.connectTimeoutMs ?? 6_250,
      requestTimeoutMs: options.requestTimeoutMs ?? 30_000
    }
  }

  get connected(): boolean {
    return Boolean(this.socket && !this.socket.destroyed && this.welcome)
  }

  /** Bound Host generation from the last welcome, or null when disconnected. */
  get generation(): number | null {
    return this.welcome?.generation ?? null
  }

  /** Bound Host cursor from the last welcome, or null when disconnected. */
  get cursor(): number | null {
    return this.welcome?.cursor ?? null
  }

  /** Capability support is authoritative only after Host welcome intersection. */
  supports(capability: HostCapability): boolean {
    return Boolean(this.welcome?.capabilities.includes(capability))
  }

  async connect(): Promise<HostBootstrapWelcome> {
    if (this.connected && this.welcome) return this.welcome
    if (this.socket && !this.socket.destroyed) {
      throw new Error('TaskWraith Host projection connection is already starting.')
    }
    this.closedByClient = false
    this.eventSequenceSeen = -1

    try {
      return await this.connectOnce(false)
    } catch (error) {
      if (!(error instanceof HostProjectionHandshakeClosedBeforeWelcomeError)) throw error
      if (this.options.optionalCapabilities.length === 0) throw error
      return this.connectOnce(true)
    }
  }

  private async connectOnce(baseOnly: boolean): Promise<HostBootstrapWelcome> {
    const explicitDiscoveryPath = this.options.discoveryPath
    let canonicalUserDataPath: string | null = null
    if (!explicitDiscoveryPath && this.options.userDataPath) {
      canonicalUserDataPath = await canonicalProfileDirectory(this.options.userDataPath)
    }
    const discoveryPath =
      explicitDiscoveryPath ??
      (canonicalUserDataPath ? taskWraithHostDiscoveryPath(canonicalUserDataPath) : null)
    if (!discoveryPath) {
      throw new Error('TaskWraith Host discovery path is required (userDataPath or discoveryPath).')
    }

    const discovery = parseDiscovery(
      readPrivateLocalControlArtifact(discoveryPath, HOST_LOCAL_CONTROL_MAX_DISCOVERY_BYTES)
    )
    if (canonicalUserDataPath) {
      if (
        discovery.tokenPath !== taskWraithHostTokenPath(canonicalUserDataPath) ||
        discovery.socketPath !== taskWraithHostSocketPath(canonicalUserDataPath)
      ) {
        throw new Error('TaskWraith Host discovery paths do not match the configured profile.')
      }
    }
    const token = readPrivateLocalControlArtifact(
      discovery.tokenPath,
      HOST_LOCAL_CONTROL_MAX_TOKEN_BYTES
    ).trim()
    if (!token) throw new Error('TaskWraith Host token is unavailable.')
    this.discoveryIdentity = {
      ...(discovery.hostId ? { hostId: discovery.hostId } : {}),
      ...(discovery.hostVersion ? { hostVersion: discovery.hostVersion } : {})
    }

    const hello = this.buildHello(token, baseOnly)
    const encoded = encodeHostLocalTransportClientFrame(hello)
    if (!encoded.ok) {
      throw new HostProjectionTransportError(encoded.error.code)
    }

    return new Promise<HostBootstrapWelcome>((resolve, reject) => {
      this.connectResolve = resolve
      this.connectReject = reject
      const socket = connectDiscoverySocket(discovery.socketPath)
      this.socket = socket
      this.connectAccepted = false
      socket.setEncoding('utf8')
      socket.setNoDelay(true)
      socket.once('connect', () => {
        this.connectAccepted = true
        socket.write(`${JSON.stringify(encoded.value)}\n`)
      })
      socket.on('data', (chunk: string) => this.onData(chunk))
      socket.once('error', (error) => this.onDisconnect(error))
      socket.once('close', () => this.onDisconnect(null))
      this.connectTimer = setTimeout(() => {
        const error = new Error('Timed out connecting to the TaskWraith Host.')
        this.failConnect(error)
        socket.destroy()
      }, this.options.connectTimeoutMs)
      this.connectTimer.unref?.()
    })
  }

  close(): void {
    this.closedByClient = true
    this.socket?.destroy()
    this.socket = null
    this.welcome = null
    this.rejectPending(new Error('TaskWraith Host projection client closed.'))
  }

  async getSnapshot(): Promise<HostSnapshotFrame> {
    const result = await this.request('snapshot.get', {})
    if (result.kind !== 'snapshot.get') {
      throw new Error('TaskWraith Host returned an unexpected snapshot result kind.')
    }
    this.retainSnapshot(result.frame.snapshot, 'live')
    return result.frame
  }

  async getDeltasSince(position: HostCursorPosition): Promise<HostDeltasFrame> {
    const result = await this.request('deltas.since', position)
    if (result.kind !== 'deltas.since') {
      throw new Error('TaskWraith Host returned an unexpected deltas result kind.')
    }
    return result.frame
  }

  async getThreadOffers(threadId: string): Promise<TaskWraithControlThreadOffers> {
    const result = await this.request('thread.offers', { threadId })
    if (result.kind !== 'thread.offers') {
      throw new Error('TaskWraith Host returned an unexpected thread offers result kind.')
    }
    return result.offers
  }

  async getProviderStatuses(): Promise<readonly HostProviderStatusProjection[]> {
    const result = await this.request('provider.status', {})
    if (result.kind !== 'provider.status') {
      throw new Error('TaskWraith Host returned an unexpected provider status result kind.')
    }
    return result.statuses
  }

  async getProviderOffers(providerId: string): Promise<HostProviderOffersProjection> {
    const result = await this.request('provider.offers', { providerId })
    if (result.kind !== 'provider.offers') {
      throw new Error('TaskWraith Host returned an unexpected provider offers result kind.')
    }
    return result.offers
  }

  async getProviderAuthFlows(
    providerId: string
  ): Promise<readonly HostProviderAuthFlowProjection[]> {
    const result = await this.request('provider.auth.flows', { providerId })
    if (result.kind !== 'provider.auth.flows') {
      throw new Error('TaskWraith Host returned an unexpected provider auth flow result kind.')
    }
    return result.flows
  }

  async getProviderAuthStatus(providerId: string): Promise<HostProviderAuthStatusProjection> {
    const result = await this.request('provider.auth.status', { providerId })
    if (result.kind !== 'provider.auth.status') {
      throw new Error('TaskWraith Host returned an unexpected provider auth status result kind.')
    }
    return result.status
  }

  async getThreadHistory(request: HostThreadHistoryRequest): Promise<HostThreadHistoryPage> {
    const result = await this.request('thread.history', request)
    if (result.kind !== 'thread.history') {
      throw new Error('TaskWraith Host returned an unexpected thread history result kind.')
    }
    return result.page
  }

  /**
   * Read git state for a workspace or thread.
   *
   * Returns an OUTCOME UNION rather than throwing on absence, unlike the other
   * read methods. That is deliberate: every other read is always available on a
   * connected Host, but workspace-git is advertised only when a git binary
   * resolves, so "this Host has no git" is a routine, expected state — not a
   * failure. The TUI has to render those two differently, and a thrown error
   * would force it to pattern-match on message text to tell them apart.
   *
   * NOT CONNECTED IS NOT THE SAME AS UNAVAILABLE. supports() returns false when
   * there is no welcome at all, so checking it alone would report a dropped
   * connection as "git unavailable here" — a wrong and sticky diagnosis. The
   * connection is therefore checked first and still throws.
   */
  async getWorkspaceGitRead(
    params: HostWorkspaceGitReadParams
  ): Promise<HostWorkspaceGitReadOutcome> {
    if (!this.welcome) {
      throw new Error('TaskWraith Host is not connected.')
    }
    if (!this.welcome.capabilities.includes('workspace-git')) {
      return { available: false, reason: 'capability-unavailable' }
    }
    const result = await this.request('workspace.git.read', params)
    if (result.kind !== 'workspace.git.read') {
      throw new Error('TaskWraith Host returned an unexpected workspace git result kind.')
    }
    // The whole result is returned, so `truncated` reaches the caller intact. A
    // truncated diff that arrives looking complete is the exact failure the
    // 128KiB cap exists to prevent, so this must never be projected away.
    return { available: true, result: result.result }
  }

  async getHistorySince(request: HostHistorySinceRequest): Promise<HostHistorySinceResult> {
    const result = await this.request('history.since', request)
    if (result.kind !== 'history.since') {
      throw new Error('TaskWraith Host returned an unexpected history since result kind.')
    }
    return result.result
  }

  async lookupReceipt(params: HostLocalTransportReceiptLookupParams): Promise<HostCommandReceipt> {
    const result = await this.request('receipt.lookup', params)
    if (result.kind !== 'receipt.lookup') {
      throw new Error('TaskWraith Host returned an unexpected receipt result kind.')
    }
    return result.receipt
  }

  async getHealth(): Promise<HostHealthFrame> {
    const result = await this.request('health.get', {})
    if (result.kind !== 'health.get') {
      throw new Error('TaskWraith Host returned an unexpected health result kind.')
    }
    return result.frame
  }

  async submitCommand(command: HostCommand): Promise<HostCommandReceipt> {
    const result = await this.request('command.submit', command)
    if (result.kind !== 'command.submit') {
      throw new Error('TaskWraith Host returned an unexpected command result kind.')
    }
    return result.receipt
  }

  /** Export one integrity-verified, detached `.twmission` bundle. */
  async exportTwMission(): Promise<HostProjectionTwMissionExport> {
    const result = await this.request('twmission.export', {})
    if (result.kind !== 'twmission.export') {
      throw new Error('TaskWraith Host returned an unexpected twmission export result kind.')
    }
    const encoded = encodeTwMissionBundle(result.result.bundle as TwMissionBundle)
    if (!encoded.ok) {
      throw new Error(`TaskWraith Host returned an invalid twmission bundle: ${encoded.error}`)
    }
    const imported = importTwMissionBundleBytes(encoded.bytes)
    if (!imported.ok) {
      throw new Error(`TaskWraith Host returned an invalid twmission bundle: ${imported.error}`)
    }
    return {
      bundle: {
        manifest: imported.replay.manifest,
        snapshot: imported.replay.snapshot
      },
      bytes: encoded.bytes
    }
  }

  private buildHello(token: string, baseOnly: boolean) {
    const client = this.options.client
    const hello: HostBootstrapHello = {
      type: 'host.hello',
      protocolVersion: HOST_PROTOCOL_VERSION,
      projectionVersion: HOST_PROJECTION_VERSION,
      client: {
        clientId: client.clientId,
        clientClass: client.clientClass,
        clientVersion: client.clientVersion,
        ...(client.subjectId !== undefined ? { subjectId: client.subjectId } : {}),
        ...(client.displayName !== undefined ? { displayName: client.displayName } : {})
      },
      capabilities: baseOnly
        ? [...this.options.capabilities]
        : stableDedupCapabilities([
            ...this.options.capabilities,
            ...this.options.optionalCapabilities
          ])
    }
    return {
      type: 'hello' as const,
      transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
      token,
      hello
    }
  }

  private async request(
    kind: HostLocalTransportRequest['kind'],
    params: HostLocalTransportRequest['params']
  ): Promise<HostLocalTransportSuccessResult> {
    const socket = this.socket
    if (!socket || socket.destroyed || !this.welcome) {
      throw new Error('TaskWraith Host is not connected.')
    }
    const id = randomUUID()
    const frame = {
      type: 'request',
      transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
      id,
      kind,
      params
    } as HostLocalTransportRequest
    const encoded = encodeHostLocalTransportClientFrame(frame)
    if (!encoded.ok) {
      throw new HostProjectionTransportError(encoded.error.code)
    }

    return new Promise<HostLocalTransportSuccessResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`TaskWraith Host request timed out: ${kind}`))
      }, this.options.requestTimeoutMs)
      timer.unref?.()
      this.pending.set(id, { resolve, reject, timer })
      socket.write(`${JSON.stringify(encoded.value)}\n`)
    })
  }

  private retainSnapshot(snapshot: HostSnapshot, freshness: HostProjectionFreshness): void {
    this.cachedSnapshot = {
      snapshot,
      freshness,
      generation: snapshot.generation,
      cursor: snapshot.cursor,
      receivedAt: new Date().toISOString()
    }
  }

  private markCacheStale(): void {
    if (!this.cachedSnapshot) return
    this.cachedSnapshot = {
      ...this.cachedSnapshot,
      freshness: 'stale'
    }
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    if (Buffer.byteLength(this.buffer, 'utf8') > HOST_PROJECTION_CLIENT_MAX_LINE_BYTES) {
      this.socket?.destroy(new Error('TaskWraith Host sent an oversized message.'))
      return
    }
    let newline = this.buffer.indexOf('\n')
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (line) this.onLine(line)
      newline = this.buffer.indexOf('\n')
    }
  }

  private onLine(line: string): void {
    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch {
      this.socket?.destroy(new Error('TaskWraith Host sent malformed JSON.'))
      return
    }

    const decoded = decodeHostLocalTransportHostFrame(raw)
    if (!decoded.ok) {
      this.socket?.destroy(new HostProjectionTransportError(decoded.error.code))
      return
    }
    // Forward-compat: unknown event kinds are skipped by codec contract.
    if ('skipped' in decoded) {
      return
    }

    const frame = decoded.value
    if (frame.type === 'welcome') {
      if (
        (this.discoveryIdentity?.hostId &&
          frame.welcome.hostId !== this.discoveryIdentity.hostId) ||
        (this.discoveryIdentity?.hostVersion &&
          frame.welcome.hostVersion !== this.discoveryIdentity.hostVersion)
      ) {
        this.failConnect(new Error('TaskWraith Host welcome identity does not match discovery.'))
        this.socket?.destroy()
        return
      }
      this.welcome = frame.welcome
      if (this.connectTimer) clearTimeout(this.connectTimer)
      this.connectTimer = null
      this.connectResolve?.(frame.welcome)
      this.connectResolve = null
      this.connectReject = null
      this.emit('welcome', frame.welcome)
      return
    }

    if (frame.type === 'response') {
      const pending = this.pending.get(frame.id)
      if (!pending) return
      clearTimeout(pending.timer)
      this.pending.delete(frame.id)
      if (frame.ok) pending.resolve(frame.result)
      else pending.reject(new HostProjectionTransportError(frame.error.code))
      return
    }

    if (frame.type === 'event') {
      this.onEvent(frame)
    }
  }

  private onEvent(event: HostLocalTransportEvent): void {
    // Generation fence: events from a different generation than the bound
    // welcome are not applied to the cache (reconnect / Host restart).
    if (this.welcome && 'payload' in event) {
      const payloadGeneration =
        event.event === 'deltas' || event.event === 'history'
          ? event.payload.result.generation
          : undefined
      if (typeof payloadGeneration === 'number' && payloadGeneration !== this.welcome.generation) {
        this.markCacheStale()
        return
      }
    }

    if (event.sequence <= this.eventSequenceSeen) {
      // Duplicate / late event — idempotent skip.
      return
    }
    this.eventSequenceSeen = event.sequence

    if (event.event === 'deltas') {
      this.emit('deltas', event.payload, event.sequence)
      return
    }
    if (event.event === 'health') {
      this.emit('health', event.payload, event.sequence)
      return
    }
    if (event.event === 'history') {
      this.emit('history', event.payload, event.sequence)
      return
    }
    if (event.event === 'host.closing') {
      this.emit('hostClosing', event.sequence)
      this.socket?.end()
    }
  }

  private failConnect(error: Error): void {
    if (this.connectTimer) clearTimeout(this.connectTimer)
    this.connectTimer = null
    this.connectReject?.(error)
    this.connectResolve = null
    this.connectReject = null
  }

  private onDisconnect(error: Error | null): void {
    const wasConnected = Boolean(this.welcome)
    const preWelcomeClose =
      !wasConnected &&
      this.connectAccepted &&
      error === null &&
      Boolean(this.connectReject || this.connectResolve)
    this.connectAccepted = false
    this.failConnect(
      preWelcomeClose
        ? new HostProjectionHandshakeClosedBeforeWelcomeError()
        : (error ?? new Error('TaskWraith Host disconnected.'))
    )
    this.socket = null
    this.welcome = null
    this.buffer = ''
    this.markCacheStale()
    this.rejectPending(error ?? new Error('TaskWraith Host disconnected.'))
    if (wasConnected && !this.closedByClient) this.emit('disconnected', error)
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }
}
