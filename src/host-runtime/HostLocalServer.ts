/**
 * Host Arc v2 authenticated local server (Wave 3.3).
 *
 * Purpose: the authenticated v2 listener per PIN W3-P1/P3.  The SAME module
 * must run unchanged in main during migration and in the dedicated Host child
 * later, so imports are ONLY the listed dependencies — zero AppStore, Bridge,
 * provider, store, resolver, or pipeline imports (W3-P3 seam).
 *
 * Auth reuses the shipped v1 pattern VERBATIM (PIN W3-P1):
 *   - randomBytes(32) hex token
 *   - 0700 private directory, 0600 socket / token / discovery
 *   - timingSafeEqual token comparison
 *   - 5s handshake timer
 *   - discovery file { protocolVersion, socketPath, tokenPath, pid, startedAt }
 *
 * Transport: JSON-line frames validated through the 3.2 transport codecs
 * (hostProtocolTransport).  This matches the v1 line-delimited pattern;
 * Host Local Transport Version 1 is carried in every frame envelope.
 *
 * Worker only — staging refused in-lane.  Captain serial adoption after
 * validated handoff (evidence table + live marker with adopter-window expiry).
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { realpathSync, unlinkSync } from 'node:fs'
import { chmod, mkdir, rm, rmdir } from 'node:fs/promises'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { dirname } from 'node:path'

import {
  taskWraithHostDiscoveryPath,
  taskWraithHostSocketPath,
  taskWraithHostTokenPath,
  type TaskWraithHostDiscovery
} from '../shared/taskWraithHostPaths.node'
import {
  publishPrivateLocalControlArtifact,
  removeOwnedPrivateLocalControlArtifact,
  type HostLocalControlArtifactOwnership
} from '../shared/hostLocalControlArtifacts.node'
import {
  HOST_LOCAL_TRANSPORT_VERSION,
  decodeHostLocalTransportClientFrame,
  type HostLocalTransportClientFrame,
  type HostLocalTransportError,
  type HostLocalTransportHostFrame,
  type HostLocalTransportReceiptLookupParams,
  type HostLocalTransportSuccessResult,
  type HostWorkspaceGitReadParams
} from '../shared/hostProtocolTransport'
import {
  HOST_PROTOCOL_VERSION,
  type HostCommand,
  type HostCursorPosition,
  type HostDeltaEnvelope
} from '../shared/hostProtocol'
import type {
  HostHistorySinceRequest,
  HostThreadHistoryRequest
} from '../shared/hostHistoryProtocol'
import type { HostCapability } from '../shared/hostProtocol'
import type { HostLocalTransportRequestKind } from '../shared/hostProtocolTransport'
import type { HostSession, HostSessionBindRequest, HostSessionBinding } from './HostSession'
import {
  type HostAuthority,
  type HostAuthorityCallContext,
  parseHostAuthorityReceiptLookup
} from './HostAuthority'
import { parseSetupMutationCommandName } from './HostCommandRouting'
import { TW_MISSION_MAX_BUNDLE_BYTES } from '../host-shared/twmission'

const REQUIRED_READ_CAPABILITY: Partial<Record<HostLocalTransportRequestKind, HostCapability>> = {
  'thread.offers': 'model-offers',
  'provider.status': 'provider-catalog',
  'provider.offers': 'provider-catalog',
  'provider.auth.flows': 'provider-auth',
  'provider.auth.status': 'provider-auth',
  'thread.history': 'history',
  'workspace.git.read': 'workspace-git',
  'history.since': 'history'
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HANDSHAKE_TIMEOUT_MS = 5_000
const MAX_CLIENTS_DEFAULT = 6
const SHUTDOWN_DRAIN_TIMEOUT_MS_DEFAULT = 1_000
const MAX_LINE_BYTES = 256_000
const MAX_COMPACT_EXPORT_LINE_BYTES = TW_MISSION_MAX_BUNDLE_BYTES + 65_536

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface HostLocalServerOptions {
  /** Injected base directory for path construction (testable). */
  userDataPath: string
  /** Host identity — carried into the welcome frame via HostSession. */
  hostId: string
  /** Host version string — carried into the welcome frame via HostSession. */
  hostVersion: string
  /** Authenticated session binder. */
  session: HostSession
  /** Transport-neutral Authority facade for request routing.
   *  HostMainComposition extends HostAuthority with optional exportTwMission
   *  (Wave 5 AC9); the server gates on typeof === 'function'. */
  authority: HostAuthority & {
    exportTwMission?: (
      context: HostAuthorityCallContext,
      options?: { readonly exportedAt?: string; readonly redactionNotes?: readonly string[] }
    ) => Promise<{ ok: boolean; error?: string; bundle?: unknown; bytes?: Uint8Array }>
  }
  /** Platform for path construction; defaults to process.platform. */
  platform?: NodeJS.Platform
  /** Maximum concurrent client connections; defaults to 6. */
  maxClients?: number
  /** Bounded grace for in-flight dispatch and client socket drain during stop. */
  shutdownDrainTimeoutMs?: number
  /** Optional diagnostic logger. */
  log?: (line: string) => void
  /** Injectable clock for tests. */
  now?: () => number
  /**
   * Optional post-commit feed from the sole Host delta journal. The server
   * owns subscription lifetime and exposes only protocol envelopes, never the
   * store itself.
   */
  subscribeDeltas?: (listener: (delta: HostDeltaEnvelope) => void) => () => void
  onAuthenticatedShutdown?: () => Promise<void> | void
}

// ---------------------------------------------------------------------------
// Per-connection state
// ---------------------------------------------------------------------------

interface ClientState {
  socket: Socket
  authenticated: boolean
  binding: HostSessionBinding | null
  buffer: string
  handshakeTimer: ReturnType<typeof setTimeout>
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeTokenEquals(expected: string, received: string): boolean {
  const a = Buffer.from(expected)
  const b = Buffer.from(received)
  return a.length === b.length && timingSafeEqual(a, b)
}

function socketWrite(
  socket: Socket,
  frame: HostLocalTransportHostFrame,
  callback?: (error?: Error | null) => void
): boolean {
  if (socket.destroyed || !socket.writable) return false
  let line = `${JSON.stringify(frame)}\n`
  let bytes = Buffer.byteLength(line, 'utf8')
  const lineBudget =
    frame.type === 'response' && frame.ok && frame.result.kind === 'twmission.export'
      ? MAX_COMPACT_EXPORT_LINE_BYTES
      : MAX_LINE_BYTES
  if (bytes > lineBudget) {
    // Response too large for the transport.  Send a body-free error frame
    // with the same id when the frame carried one, then destroy.
    if (frame.type === 'response' && frame.ok === true) {
      line = `${JSON.stringify({
        type: 'response' as const,
        transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
        id: frame.id,
        ok: false,
        error: { code: 'host_unavailable' as const }
      })}\n`
      bytes = Buffer.byteLength(line, 'utf8')
    } else {
      return false
    }
  }
  if (socket.writableLength + bytes > lineBudget * 2) {
    socket.destroy(new Error('Host local client is not draining responses.'))
    return false
  }
  socket.write(line, callback)
  return true
}

async function socketIsLive(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(socketPath)
    let deadline: ReturnType<typeof setTimeout> | null = null
    const settle = (value: boolean) => {
      if (deadline) clearTimeout(deadline)
      socket.removeAllListeners()
      socket.destroy()
      resolve(value)
    }
    deadline = setTimeout(() => settle(false), 350)
    deadline.unref?.()
    socket.once('connect', () => settle(true))
    socket.once('error', () => settle(false))
  })
}

function errorFrame(id: string, error: HostLocalTransportError): HostLocalTransportHostFrame {
  return {
    type: 'response',
    transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
    id,
    ok: false,
    error
  }
}

async function settleCleanup(tasks: readonly (() => Promise<unknown> | unknown)[]): Promise<void> {
  const results = await Promise.allSettled(tasks.map((task) => Promise.resolve().then(task)))
  const failure = results.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected'
  )
  if (failure) throw failure.reason
}

async function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    void promise.then(
      () => finish(true),
      () => finish(true)
    )
  })
}

/** Map HostAuthority operational error codes to closed transport error codes. */
function authorityErrorToTransportCode(
  code: 'host_unavailable' | 'shutting_down' | 'invalid_lookup'
): HostLocalTransportError['code'] {
  switch (code) {
    case 'host_unavailable':
      return 'host_unavailable'
    case 'shutting_down':
      return 'shutting_down'
    case 'invalid_lookup':
      return 'invalid_payload'
  }
}

// ---------------------------------------------------------------------------
// HostLocalServer
// ---------------------------------------------------------------------------

export class HostLocalServer {
  private readonly options: Required<
    Pick<HostLocalServerOptions, 'maxClients' | 'now' | 'platform' | 'shutdownDrainTimeoutMs'>
  > &
    Omit<HostLocalServerOptions, 'maxClients' | 'now' | 'platform' | 'shutdownDrainTimeoutMs'>
  private readonly token: string
  private readonly clients = new Set<ClientState>()
  private server: Server | null = null
  private ownsSocket = false
  private stopPromise: Promise<void> | null = null
  private readonly inFlightDispatches = new Set<Promise<void>>()
  private started = false
  private eventSequence = 0
  private deltaUnsubscribe: (() => void) | null = null
  private shutdownState: 'running' | 'stopping' | 'stopped' = 'running'
  private tokenArtifact: HostLocalControlArtifactOwnership | null = null
  private discoveryArtifact: HostLocalControlArtifactOwnership | null = null

  readonly socketPath: string
  readonly tokenPath: string
  readonly discoveryPath: string

  constructor(options: HostLocalServerOptions) {
    this.options = {
      ...options,
      platform: options.platform ?? process.platform,
      maxClients: options.maxClients ?? MAX_CLIENTS_DEFAULT,
      shutdownDrainTimeoutMs: options.shutdownDrainTimeoutMs ?? SHUTDOWN_DRAIN_TIMEOUT_MS_DEFAULT,
      now: options.now ?? (() => Date.now())
    }
    if (
      !Number.isSafeInteger(this.options.shutdownDrainTimeoutMs) ||
      this.options.shutdownDrainTimeoutMs < 1
    ) {
      throw new Error('Host local shutdown drain timeout is invalid.')
    }
    this.token = randomBytes(32).toString('hex')
    const canonicalUserDataPath = realpathSync(options.userDataPath)
    this.socketPath = taskWraithHostSocketPath(canonicalUserDataPath, this.options.platform)
    this.tokenPath = taskWraithHostTokenPath(canonicalUserDataPath)
    this.discoveryPath = taskWraithHostDiscoveryPath(canonicalUserDataPath)
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  /**
   * Start the authenticated v2 listener.
   *
   * Creates the private directory + socket with 0700 / 0600 permissions,
   * writes the token + discovery files, and begins accepting connections.
   * Refuses to start when a LIVE socket already exists at the target path
   * (v1 "already owned" guard semantics).
   */
  async start(): Promise<void> {
    if (this.server) return
    if (this.shutdownState !== 'running' || this.stopPromise) {
      throw new Error('Host local server is one-shot after shutdown.')
    }

    await mkdir(this.options.userDataPath, { recursive: true, mode: 0o700 })
    if (this.options.platform !== 'win32') {
      await mkdir(dirname(this.socketPath), { recursive: true, mode: 0o700 })
      await chmod(dirname(this.socketPath), 0o700).catch(() => {})
      const live = await socketIsLive(this.socketPath)
      if (live) {
        throw new Error('Host local-control socket is already owned by a live host.')
      }
      await rm(this.socketPath, { force: true })
    }

    const server = createServer((socket) => this.accept(socket))
    this.server = server
    let ownsSocket = false
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          server.off('listening', onListening)
          reject(error)
        }
        const onListening = () => {
          server.off('error', onError)
          resolve()
        }
        server.once('error', onError)
        server.once('listening', onListening)
        server.listen(this.socketPath)
      })
      ownsSocket = true
      this.ownsSocket = true
      if (this.options.platform !== 'win32') {
        await chmod(this.socketPath, 0o600)
      }

      this.tokenArtifact = publishPrivateLocalControlArtifact(
        this.tokenPath,
        `${this.token}\n`,
        4_096
      )

      const discovery: TaskWraithHostDiscovery = {
        protocolVersion: 2,
        socketPath: this.socketPath,
        tokenPath: this.tokenPath,
        pid: process.pid,
        startedAt: new Date(this.options.now()).toISOString(),
        hostId: this.options.hostId,
        hostVersion: this.options.hostVersion
      }
      // Discovery is the readiness flag and is published only after token.
      this.discoveryArtifact = publishPrivateLocalControlArtifact(
        this.discoveryPath,
        `${JSON.stringify(discovery)}\n`,
        16 * 1024
      )

      if (this.options.subscribeDeltas) {
        this.deltaUnsubscribe = this.options.subscribeDeltas((delta) => {
          this.broadcastDelta(delta)
        })
      }

      this.started = true
      this.options.log?.(`[host-local-server] listening at ${this.socketPath}`)
    } catch (error) {
      this.server = null
      this.clearDeltaSubscription()
      for (const client of this.clients) {
        clearTimeout(client.handshakeTimer)
        client.socket.destroy()
      }
      this.clients.clear()
      if (server.listening) {
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
      if (ownsSocket) {
        await settleCleanup([
          () => removeOwnedPrivateLocalControlArtifact(this.discoveryArtifact),
          () => removeOwnedPrivateLocalControlArtifact(this.tokenArtifact),
          () =>
            this.options.platform === 'win32' ? undefined : rm(this.socketPath, { force: true })
        ])
        if (this.options.platform !== 'win32') {
          await rmdir(dirname(this.socketPath)).catch(() => {})
        }
      }
      this.ownsSocket = false
      throw error
    }
  }

  /**
   * Graceful async stop.  Emits host.closing to every connected client,
   * closes the listener, and unlinks socket / token / discovery artifacts.
   * Idempotent when already stopped.
   */
  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise
    this.shutdownState = 'stopping'
    const operation = this.stopOnce()
    this.stopPromise = operation
    try {
      await operation
    } catch (error) {
      if (this.stopPromise === operation) this.stopPromise = null
      throw error
    }
  }

  private async stopOnce(): Promise<void> {
    const server = this.server
    this.server = null
    const closePromise = server?.listening
      ? new Promise<void>((resolve) => server.close(() => resolve()))
      : Promise.resolve()
    // Register the listener close callback before closing active clients. This
    // ordering matters for Windows named pipes, where closing the last
    // connection can otherwise race the close callback and leave stop() pending.
    this.clearDeltaSubscription()
    await this.drainInFlightDispatches()
    await this.disconnectClients()
    await closePromise
    await settleCleanup([
      () => removeOwnedPrivateLocalControlArtifact(this.discoveryArtifact),
      () => removeOwnedPrivateLocalControlArtifact(this.tokenArtifact),
      () =>
        this.options.platform === 'win32' || !this.ownsSocket
          ? undefined
          : rm(this.socketPath, { force: true })
    ])
    if (this.options.platform !== 'win32' && this.ownsSocket) {
      await rmdir(dirname(this.socketPath)).catch(() => {})
    }
    this.started = false
    this.shutdownState = 'stopped'
    this.ownsSocket = false
    this.discoveryArtifact = null
    this.tokenArtifact = null
  }

  /**
   * Synchronous stop safe for `will-quit` / `exit` hooks (v1 pattern verbatim).
   *
   * Electron cannot await work from `will-quit`, so this variant removes only
   * the three exact control artifacts synchronously after disconnecting clients
   * and closing the listener.  Idempotent; missing/stale artifacts are already
   * the desired state and do not throw.
   */
  stopSync(): void {
    this.shutdownState = 'stopping'
    this.clearDeltaSubscription()
    this.disconnectClientsSync()
    const server = this.server
    this.server = null
    if (server?.listening) server.close()
    try {
      removeOwnedPrivateLocalControlArtifact(this.discoveryArtifact)
      removeOwnedPrivateLocalControlArtifact(this.tokenArtifact)
    } catch (error) {
      this.options.log?.(
        `[host-local-server] synchronous artifact cleanup failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }
    for (const path of this.options.platform === 'win32' || !this.ownsSocket
      ? []
      : [this.socketPath]) {
      try {
        unlinkSync(path)
      } catch {
        // Missing/stale artifacts are already the desired state.
      }
    }
    if (this.options.platform !== 'win32' && this.ownsSocket) {
      try {
        unlinkSync(dirname(this.socketPath))
      } catch {
        // Leave a non-empty or concurrently recreated private directory alone.
      }
    }
    this.started = false
    this.shutdownState = 'stopped'
    this.ownsSocket = false
    this.discoveryArtifact = null
    this.tokenArtifact = null
  }

  /** True after start() succeeds and before stop()/stopSync(). */
  get isStarted(): boolean {
    return this.started
  }

  /** Number of live connections (test / diagnostics only). */
  clientCount(): number {
    return this.clients.size
  }

  // -----------------------------------------------------------------------
  // Connection handling
  // -----------------------------------------------------------------------

  private async drainInFlightDispatches(): Promise<void> {
    if (this.inFlightDispatches.size === 0) return
    const drained = await settlesWithin(
      Promise.allSettled([...this.inFlightDispatches]),
      this.options.shutdownDrainTimeoutMs
    )
    if (!drained) {
      this.options.log?.('[host-local-server] timed out draining in-flight requests')
    }
  }

  private async disconnectClients(): Promise<void> {
    const clients = [...this.clients]
    const sequence = this.nextEventSequence()
    const closed = clients.map(
      (client) =>
        new Promise<void>((resolve) => {
          if (client.socket.destroyed) resolve()
          else client.socket.once('close', () => resolve())
        })
    )
    for (const client of clients) {
      const event: HostLocalTransportHostFrame = {
        type: 'event',
        transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
        event: 'host.closing',
        sequence
      }
      const wroteClosingEvent = socketWrite(client.socket, event)
      clearTimeout(client.handshakeTimer)
      if (wroteClosingEvent) client.socket.end()
      else client.socket.destroy()
    }
    if (!(await settlesWithin(Promise.all(closed), this.options.shutdownDrainTimeoutMs))) {
      for (const client of clients) {
        if (!client.socket.destroyed) client.socket.destroy()
      }
      await settlesWithin(Promise.all(closed), this.options.shutdownDrainTimeoutMs)
    }
    this.clients.clear()
  }

  private disconnectClientsSync(): void {
    const sequence = this.nextEventSequence()
    for (const client of this.clients) {
      const event: HostLocalTransportHostFrame = {
        type: 'event',
        transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
        event: 'host.closing',
        sequence
      }
      socketWrite(client.socket, event)
      clearTimeout(client.handshakeTimer)
      client.socket.destroy()
    }
    this.clients.clear()
  }

  private clearDeltaSubscription(): void {
    const unsubscribe = this.deltaUnsubscribe
    this.deltaUnsubscribe = null
    if (!unsubscribe) return
    try {
      unsubscribe()
    } catch (error) {
      this.options.log?.(`[host-local-server] delta unsubscribe failed: ${String(error)}`)
    }
  }

  private nextEventSequence(): number {
    this.eventSequence += 1
    return this.eventSequence
  }

  /** Broadcast one already-durable envelope to delta-capable clients only. */
  private broadcastDelta(delta: HostDeltaEnvelope): void {
    const sequence = this.nextEventSequence()
    const frame: HostLocalTransportHostFrame = {
      type: 'event',
      transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
      event: 'deltas',
      sequence,
      payload: {
        type: 'host.deltas',
        protocolVersion: HOST_PROTOCOL_VERSION,
        result: {
          kind: 'deltas',
          generation: delta.generation,
          fromCursor: delta.previousCursor,
          toCursor: delta.cursor,
          deltas: [delta]
        }
      }
    }

    for (const client of this.clients) {
      if (!client.authenticated || !client.binding?.welcome.capabilities.includes('deltas')) {
        continue
      }
      if (!socketWrite(client.socket, frame)) {
        client.socket.destroy()
      }
    }
  }

  private accept(socket: Socket): void {
    if (this.clients.size >= this.options.maxClients) {
      socket.end()
      return
    }
    socket.setEncoding('utf8')
    socket.setNoDelay(true)
    const state: ClientState = {
      socket,
      authenticated: false,
      binding: null,
      buffer: '',
      handshakeTimer: setTimeout(() => {
        socketWrite(socket, errorFrame('', { code: 'unauthorized' }))
        socket.destroy()
      }, HANDSHAKE_TIMEOUT_MS)
    }
    state.handshakeTimer.unref?.()
    this.clients.add(state)
    socket.on('data', (chunk: string) => this.onData(state, chunk))
    socket.on('error', () => this.drop(state))
    socket.on('close', () => this.drop(state))
  }

  private drop(state: ClientState): void {
    clearTimeout(state.handshakeTimer)
    this.clients.delete(state)
  }

  private onData(state: ClientState, chunk: string): void {
    state.buffer += chunk
    if (Buffer.byteLength(state.buffer, 'utf8') > MAX_LINE_BYTES) {
      state.socket.destroy()
      return
    }
    let newline = state.buffer.indexOf('\n')
    while (newline >= 0) {
      const line = state.buffer.slice(0, newline).trim()
      state.buffer = state.buffer.slice(newline + 1)
      if (line) void this.onLine(state, line)
      newline = state.buffer.indexOf('\n')
    }
  }

  private async onLine(state: ClientState, line: string): Promise<void> {
    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch {
      state.socket.destroy()
      return
    }

    const decoded = decodeHostLocalTransportClientFrame(raw)
    if (!decoded.ok) {
      if (state.authenticated && raw && typeof raw === 'object' && 'id' in raw) {
        socketWrite(
          state.socket,
          errorFrame(String((raw as { id?: unknown }).id ?? ''), decoded.error)
        )
      } else {
        state.socket.destroy()
      }
      return
    }

    if (!state.authenticated) {
      this.authenticate(state, decoded.value)
      return
    }

    if (decoded.value.type === 'hello') {
      // Already authenticated — second hello is a protocol error.
      socketWrite(state.socket, errorFrame('', { code: 'unauthorized' }))
      state.socket.destroy()
      return
    }

    if (decoded.value.kind === 'host.shutdown') {
      const client = state.binding?.authenticatedClient
      if (
        client?.clientClass !== 'host-cli' ||
        client.clientId !== 'taskwraith-host-cli' ||
        !state.binding?.welcome.capabilities.includes('host-lifecycle') ||
        typeof this.options.onAuthenticatedShutdown !== 'function'
      ) {
        socketWrite(state.socket, errorFrame(decoded.value.id, { code: 'unauthorized' }))
        return
      }
      const stateName = this.shutdownState === 'running' ? 'stopping' : 'already_stopping'
      this.shutdownState = 'stopping'
      const wrote = socketWrite(
        state.socket,
        {
          type: 'response',
          transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
          id: decoded.value.id,
          ok: true,
          result: { kind: 'host.shutdown', state: stateName }
        },
        (error) => {
          if (stateName !== 'stopping') return
          if (error) {
            this.shutdownState = 'running'
            this.options.log?.(
              `[host-local-server] shutdown acknowledgement failed: ${String(error)}`
            )
            return
          }
          void Promise.resolve()
            .then(() => this.options.onAuthenticatedShutdown?.())
            .catch((error) => {
              this.options.log?.(
                `[host-local-server] authenticated shutdown failed: ${String(error)}`
              )
            })
        }
      )
      if (!wrote && stateName === 'stopping') this.shutdownState = 'running'
      return
    }
    if (this.shutdownState !== 'running') {
      socketWrite(state.socket, errorFrame(decoded.value.id, { code: 'shutting_down' }))
      return
    }

    const operation = this.dispatch(state, decoded.value)
    this.inFlightDispatches.add(operation)
    try {
      await operation
    } finally {
      this.inFlightDispatches.delete(operation)
    }
  }

  // -----------------------------------------------------------------------
  // Authentication
  // -----------------------------------------------------------------------

  /**
   * Authenticate the first client frame.  Must be a hello with a valid token.
   * On success constructs a HostTransportVerifiedClientContext from the
   * VERIFIED transport identity only, binds through HostSession, and sends
   * the welcome frame.
   */
  private authenticate(state: ClientState, frame: HostLocalTransportClientFrame): void {
    if (frame.type !== 'hello' || !safeTokenEquals(this.token, frame.token)) {
      socketWrite(
        state.socket,
        errorFrame('', { code: frame.type === 'hello' ? 'unauthorized' : 'invalid_frame' })
      )
      state.socket.destroy()
      return
    }

    state.authenticated = true
    clearTimeout(state.handshakeTimer)

    const hello = frame.hello
    const verifiedContext = {
      clientClass: hello.client.clientClass,
      clientId: hello.client.clientId,
      actorId: hello.client.clientId,
      ...(hello.client.subjectId !== undefined ? { subjectId: hello.client.subjectId } : {})
    }

    const bindRequest: HostSessionBindRequest = {
      verifiedContext,
      authenticatedClient: hello.client,
      clientCapabilityRequest: hello.capabilities
    }

    const bindResult = this.options.session.bind(bindRequest)
    if (!bindResult.ok) {
      socketWrite(state.socket, errorFrame('', { code: 'unauthorized' }))
      state.socket.destroy()
      return
    }

    state.binding = bindResult.value

    const welcome: HostLocalTransportHostFrame = {
      type: 'welcome',
      transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
      welcome: bindResult.value.welcome
    }
    socketWrite(state.socket, welcome)
  }

  // -----------------------------------------------------------------------
  // Request dispatch
  // -----------------------------------------------------------------------

  /**
   * Route an authenticated client request to the HostAuthority facade.
   * The call context is built from the session binding, never from the wire.
   * Unknown request kinds reject with a closed error frame.
   */
  private async dispatch(
    state: ClientState,
    frame: Extract<HostLocalTransportClientFrame, { type: 'request' }>
  ): Promise<void> {
    const binding = state.binding
    if (!binding) {
      socketWrite(state.socket, errorFrame(frame.id, { code: 'unauthorized' }))
      return
    }

    const context: HostAuthorityCallContext = {
      actor: binding.actor,
      client: binding.authenticatedClient
    }

    const requiredCapability = REQUIRED_READ_CAPABILITY[frame.kind]
    if (requiredCapability && !binding.welcome.capabilities.includes(requiredCapability)) {
      socketWrite(state.socket, errorFrame(frame.id, { code: 'unauthorized' }))
      return
    }
    if (
      frame.kind === 'command.submit' &&
      parseSetupMutationCommandName(frame.params.name) !== null &&
      (!binding.welcome.capabilities.includes('commands') ||
        !binding.welcome.capabilities.includes('setup'))
    ) {
      socketWrite(state.socket, errorFrame(frame.id, { code: 'unauthorized' }))
      return
    }

    try {
      const result = await this.executeRequest(context, frame)
      if (result === null) {
        socketWrite(state.socket, errorFrame(frame.id, { code: 'unknown_request_kind' }))
        return
      }
      socketWrite(state.socket, result)
    } catch {
      socketWrite(state.socket, errorFrame(frame.id, { code: 'host_unavailable' }))
    }
  }

  private async executeRequest(
    context: HostAuthorityCallContext,
    frame: Extract<HostLocalTransportClientFrame, { type: 'request' }>
  ): Promise<HostLocalTransportHostFrame | null> {
    switch (frame.kind) {
      case 'snapshot.get':
        return this.handleSnapshot(context, frame.id)
      case 'deltas.since':
        return this.handleDeltas(context, frame.id, frame.params)
      case 'thread.offers':
        return this.handleThreadOffers(context, frame.id, frame.params.threadId)
      case 'provider.status':
        return this.handleProviderStatuses(context, frame.id)
      case 'provider.offers':
        return this.handleProviderOffers(context, frame.id, frame.params.providerId)
      case 'provider.auth.flows':
        return this.handleProviderAuthFlows(context, frame.id, frame.params.providerId)
      case 'provider.auth.status':
        return this.handleProviderAuthStatus(context, frame.id, frame.params.providerId)
      case 'thread.history':
        return this.handleThreadHistory(context, frame.id, frame.params)
      case 'workspace.git.read':
        return this.handleWorkspaceGitRead(context, frame.id, frame.params)
      case 'history.since':
        return this.handleHistorySince(context, frame.id, frame.params)
      case 'receipt.lookup':
        return this.handleReceiptLookup(context, frame.id, frame.params)
      case 'health.get':
        return this.handleHealth(context, frame.id)
      case 'command.submit':
        return this.handleCommand(context, frame.id, frame.params)
      case 'twmission.export':
        return this.handleTwMissionExport(context, frame.id)
      default:
        return null
    }
  }

  private async handleSnapshot(
    context: HostAuthorityCallContext,
    id: string
  ): Promise<HostLocalTransportHostFrame> {
    const result = await this.options.authority.snapshot(context)
    if (!result.ok) {
      return errorFrame(id, { code: authorityErrorToTransportCode(result.error) })
    }
    const success: HostLocalTransportSuccessResult = {
      kind: 'snapshot.get',
      frame: {
        type: 'host.snapshot',
        protocolVersion: 2,
        snapshot: result.value
      }
    }
    return {
      type: 'response',
      transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
      id,
      ok: true,
      result: success
    }
  }

  private async handleDeltas(
    context: HostAuthorityCallContext,
    id: string,
    params: HostCursorPosition
  ): Promise<HostLocalTransportHostFrame> {
    const result = await this.options.authority.deltas(context, params)
    if (!result.ok) {
      return errorFrame(id, { code: authorityErrorToTransportCode(result.error) })
    }
    const success: HostLocalTransportSuccessResult = {
      kind: 'deltas.since',
      frame: {
        type: 'host.deltas',
        protocolVersion: 2,
        result: result.value
      }
    }
    return {
      type: 'response',
      transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
      id,
      ok: true,
      result: success
    }
  }

  private async handleReceiptLookup(
    context: HostAuthorityCallContext,
    id: string,
    params: HostLocalTransportReceiptLookupParams
  ): Promise<HostLocalTransportHostFrame> {
    const lookup = parseHostAuthorityReceiptLookup(params)
    if (!lookup) {
      return errorFrame(id, { code: authorityErrorToTransportCode('invalid_lookup') })
    }
    const result = await this.options.authority.receipt(context, lookup)
    if (!result.ok) {
      return errorFrame(id, { code: authorityErrorToTransportCode(result.error) })
    }
    if (result.outcome === 'found') {
      const success: HostLocalTransportSuccessResult = {
        kind: 'receipt.lookup',
        receipt: result.receipt
      }
      return {
        type: 'response',
        transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
        id,
        ok: true,
        result: success
      }
    }
    // not_found / actor_mismatch / incomplete → body-free error
    return errorFrame(id, { code: authorityErrorToTransportCode('invalid_lookup') })
  }

  private async handleThreadOffers(
    context: HostAuthorityCallContext,
    id: string,
    threadId: string
  ): Promise<HostLocalTransportHostFrame> {
    const provider = this.options.authority.threadOffers
    if (typeof provider !== 'function') {
      return errorFrame(id, { code: 'host_unavailable' })
    }
    const result = await provider.call(this.options.authority, context, threadId)
    if (!result.ok) {
      return errorFrame(id, { code: authorityErrorToTransportCode(result.error) })
    }
    const success: HostLocalTransportSuccessResult = {
      kind: 'thread.offers',
      offers: result.value
    }
    return {
      type: 'response',
      transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
      id,
      ok: true,
      result: success
    }
  }

  private async handleHealth(
    context: HostAuthorityCallContext,
    id: string
  ): Promise<HostLocalTransportHostFrame> {
    const result = await this.options.authority.health(context)
    if (!result.ok) {
      return errorFrame(id, { code: authorityErrorToTransportCode(result.error) })
    }
    const success: HostLocalTransportSuccessResult = {
      kind: 'health.get',
      frame: {
        type: 'host.health',
        protocolVersion: 2,
        health: result.value
      }
    }
    return {
      type: 'response',
      transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
      id,
      ok: true,
      result: success
    }
  }

  private async handleProviderStatuses(
    context: HostAuthorityCallContext,
    id: string
  ): Promise<HostLocalTransportHostFrame> {
    const provider = this.options.authority.providerStatuses
    if (typeof provider !== 'function') return errorFrame(id, { code: 'host_unavailable' })
    const result = await provider.call(this.options.authority, context)
    if (!result.ok) return errorFrame(id, { code: authorityErrorToTransportCode(result.error) })
    return this.success(id, { kind: 'provider.status', statuses: result.value })
  }

  private async handleProviderOffers(
    context: HostAuthorityCallContext,
    id: string,
    providerId: string
  ): Promise<HostLocalTransportHostFrame> {
    const provider = this.options.authority.providerOffers
    if (typeof provider !== 'function') return errorFrame(id, { code: 'host_unavailable' })
    const result = await provider.call(this.options.authority, context, providerId)
    if (!result.ok) return errorFrame(id, { code: authorityErrorToTransportCode(result.error) })
    return this.success(id, { kind: 'provider.offers', offers: result.value })
  }

  private async handleProviderAuthFlows(
    context: HostAuthorityCallContext,
    id: string,
    providerId: string
  ): Promise<HostLocalTransportHostFrame> {
    const provider = this.options.authority.providerAuthFlows
    if (typeof provider !== 'function') return errorFrame(id, { code: 'host_unavailable' })
    const result = await provider.call(this.options.authority, context, providerId)
    if (!result.ok) return errorFrame(id, { code: authorityErrorToTransportCode(result.error) })
    return this.success(id, { kind: 'provider.auth.flows', flows: result.value })
  }

  private async handleProviderAuthStatus(
    context: HostAuthorityCallContext,
    id: string,
    providerId: string
  ): Promise<HostLocalTransportHostFrame> {
    const provider = this.options.authority.providerAuthStatus
    if (typeof provider !== 'function') return errorFrame(id, { code: 'host_unavailable' })
    const result = await provider.call(this.options.authority, context, providerId)
    if (!result.ok) return errorFrame(id, { code: authorityErrorToTransportCode(result.error) })
    return this.success(id, { kind: 'provider.auth.status', status: result.value })
  }

  private async handleThreadHistory(
    context: HostAuthorityCallContext,
    id: string,
    request: HostThreadHistoryRequest
  ): Promise<HostLocalTransportHostFrame> {
    const provider = this.options.authority.threadHistory
    if (typeof provider !== 'function') return errorFrame(id, { code: 'host_unavailable' })
    const result = await provider.call(this.options.authority, context, request)
    if (!result.ok) return errorFrame(id, { code: authorityErrorToTransportCode(result.error) })
    return this.success(id, { kind: 'thread.history', page: result.value })
  }

  private async handleWorkspaceGitRead(
    context: HostAuthorityCallContext,
    id: string,
    request: HostWorkspaceGitReadParams
  ): Promise<HostLocalTransportHostFrame> {
    const provider = this.options.authority.gitRead
    if (typeof provider !== 'function') return errorFrame(id, { code: 'host_unavailable' })
    const result = await provider.call(this.options.authority, context, request)
    if (!result.ok) return errorFrame(id, { code: authorityErrorToTransportCode(result.error) })
    return this.success(id, { kind: 'workspace.git.read', result: result.value })
  }

  private async handleHistorySince(
    context: HostAuthorityCallContext,
    id: string,
    request: HostHistorySinceRequest
  ): Promise<HostLocalTransportHostFrame> {
    const provider = this.options.authority.historySince
    if (typeof provider !== 'function') return errorFrame(id, { code: 'host_unavailable' })
    const result = await provider.call(this.options.authority, context, request)
    if (!result.ok) return errorFrame(id, { code: authorityErrorToTransportCode(result.error) })
    return this.success(id, { kind: 'history.since', result: result.value })
  }

  private success(
    id: string,
    result: HostLocalTransportSuccessResult
  ): HostLocalTransportHostFrame {
    return {
      type: 'response',
      transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
      id,
      ok: true,
      result
    }
  }

  private async handleCommand(
    context: HostAuthorityCallContext,
    id: string,
    params: HostCommand
  ): Promise<HostLocalTransportHostFrame> {
    const result = await this.options.authority.command(context, params)
    if (!result.ok) {
      return errorFrame(id, { code: authorityErrorToTransportCode(result.error) })
    }
    const success: HostLocalTransportSuccessResult = {
      kind: 'command.submit',
      receipt: result.value
    }
    return {
      type: 'response',
      transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
      id,
      ok: true,
      result: success
    }
  }

  private async handleTwMissionExport(
    context: HostAuthorityCallContext,
    id: string
  ): Promise<HostLocalTransportHostFrame> {
    const exportTwMission = this.options.authority.exportTwMission as
      | ((
          ctx: HostAuthorityCallContext,
          opts?: { readonly exportedAt?: string; readonly redactionNotes?: readonly string[] }
        ) => Promise<{ ok: boolean; error?: unknown; bundle?: unknown; bytes?: unknown }>)
      | undefined
    if (typeof exportTwMission !== 'function') {
      return errorFrame(id, { code: 'host_unavailable' })
    }
    const result = await exportTwMission(context)
    if (!result.ok) {
      return errorFrame(id, {
        code: authorityErrorToTransportCode(
          typeof result.error === 'string' ? 'host_unavailable' : 'host_unavailable'
        )
      })
    }
    const success: HostLocalTransportSuccessResult = {
      kind: 'twmission.export',
      // Bytes are deterministically reconstructed and integrity-verified by
      // the client. Sending both bundle and Uint8Array would double the wire
      // payload and JSON-encode bytes as an object with numeric keys.
      result: { bundle: result.bundle }
    }
    return {
      type: 'response',
      transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
      id,
      ok: true,
      result: success
    }
  }
}
