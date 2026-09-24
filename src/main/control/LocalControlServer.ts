import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { rmdirSync, unlinkSync } from 'node:fs'
import { chmod, mkdir, readFile, rm, rmdir, writeFile } from 'node:fs/promises'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { dirname } from 'node:path'
import {
  TASKWRAITH_CONTROL_MAX_LINE_BYTES,
  TASKWRAITH_CONTROL_PROTOCOL_VERSION,
  decodeTaskWraithControlClientMessage,
  type TaskWraithControlCapability,
  type TaskWraithControlClientMessage,
  type TaskWraithControlDiscovery,
  type TaskWraithControlEvent,
  type TaskWraithControlHostMessage,
  type TaskWraithControlRequest,
  type TaskWraithControlSnapshot,
  type TaskWraithControlThreadFindParams,
  type TaskWraithControlThreadFindResult,
  type TaskWraithControlThreadOffers,
  type TaskWraithControlThreadSnapshot,
  type TaskWraithControlWelcome
} from '../../shared/taskWraithControlProtocol'
import {
  taskWraithControlDiscoveryPath,
  taskWraithControlSocketPath,
  taskWraithControlTokenPath
} from '../../shared/taskWraithControlPaths.node'
import type { ChatMessageOrigin } from '../../shared/messageOrigin'

export interface TaskWraithLocalControlFacade {
  snapshot(): TaskWraithControlSnapshot | Promise<TaskWraithControlSnapshot>
  selectThread(
    threadId: string,
    limit: number
  ): TaskWraithControlThreadSnapshot | Promise<TaskWraithControlThreadSnapshot>
  sendPrompt(
    threadId: string,
    text: string,
    selection?: { model?: string; reasoningEffort?: string },
    /** What the host observed at hello; stamped on the prompt, never trusted from its text. */
    origin?: ChatMessageOrigin
  ): Promise<{ dispatched: boolean; message: string }>
  cancelRun(threadId: string): Promise<{ cancelled: boolean; message: string }>
  threadOffers(
    threadId: string
  ): TaskWraithControlThreadOffers | Promise<TaskWraithControlThreadOffers>
  /** Slim, filtered thread rows for senders that never need the snapshot. */
  findThreads(
    params: TaskWraithControlThreadFindParams
  ): TaskWraithControlThreadFindResult | Promise<TaskWraithControlThreadFindResult>
  toggleEnsembleSeat(
    threadId: string,
    participantId: string,
    enabled: boolean
  ): Promise<{ updated: boolean; message: string }>
}

export interface LocalControlServerOptions {
  userDataPath: string
  hostVersion: string
  facade: TaskWraithLocalControlFacade
  platform?: NodeJS.Platform
  pollIntervalMs?: number
  maxClients?: number
  log?: (line: string) => void
  now?: () => number
}

interface ClientState {
  socket: Socket
  authenticated: boolean
  buffer: string
  /** What the client asked to be pushed. Projection work is owed only for these. */
  capabilities: Set<TaskWraithControlCapability>
  /** Who is on the other end, as observed at hello; stamped onto every prompt it sends. */
  origin: ChatMessageOrigin | null
  selectedThreadId: string | null
  selectedThreadLimit: number
  /** Digest of the last snapshot this client received; per client, so a skipped push is retried. */
  lastSnapshotDigest: string
  lastThreadDigest: string
  handshakeTimer: ReturnType<typeof setTimeout>
}

const SERVER_CAPABILITIES = [
  'snapshot',
  'transcript',
  'compose',
  'cancel',
  'ensemble',
  'provider-presentation',
  'configure'
] as const

const KNOWN_CAPABILITIES: ReadonlySet<string> = new Set(SERVER_CAPABILITIES)

function stableDigest(value: unknown): string {
  return JSON.stringify(value, (key, entry) =>
    key === 'generatedAt' || key === 'sequence' ? undefined : entry
  )
}

function safeTokenEquals(expected: string, received: string): boolean {
  const a = Buffer.from(expected)
  const b = Buffer.from(received)
  return a.length === b.length && timingSafeEqual(a, b)
}

type SocketWriteResult = 'written' | 'too-large' | 'unwritable'

function socketWrite(socket: Socket, message: TaskWraithControlHostMessage): SocketWriteResult {
  if (socket.destroyed || !socket.writable) return 'unwritable'
  let line = `${JSON.stringify(message)}\n`
  let bytes = Buffer.byteLength(line, 'utf8')
  if (bytes > TASKWRAITH_CONTROL_MAX_LINE_BYTES) {
    if (message.type !== 'response') return 'too-large'
    line = `${JSON.stringify({
      type: 'response',
      id: message.id,
      ok: false,
      error: {
        code: 'response_too_large',
        message: 'TaskWraith projection is too large for the local-control transport.'
      }
    })}\n`
    bytes = Buffer.byteLength(line, 'utf8')
  }
  if (socket.writableLength + bytes > TASKWRAITH_CONTROL_MAX_LINE_BYTES * 2) {
    socket.destroy(new Error('TaskWraith local-control client is not draining responses.'))
    return 'unwritable'
  }
  socket.write(line)
  return 'written'
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

export class LocalControlServer {
  private readonly options: Required<
    Pick<LocalControlServerOptions, 'pollIntervalMs' | 'maxClients' | 'now' | 'platform'>
  > &
    Omit<LocalControlServerOptions, 'pollIntervalMs' | 'maxClients' | 'now' | 'platform'>
  private readonly sessionId = randomUUID()
  private readonly token = randomBytes(32).toString('base64url')
  private readonly clients = new Set<ClientState>()
  private server: Server | null = null
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private snapshotSequence = 0
  private lastSnapshotDigest = ''
  private polling = false

  readonly socketPath: string
  readonly tokenPath: string
  readonly discoveryPath: string

  constructor(options: LocalControlServerOptions) {
    this.options = {
      ...options,
      platform: options.platform ?? process.platform,
      pollIntervalMs: options.pollIntervalMs ?? 450,
      maxClients: options.maxClients ?? 6,
      now: options.now ?? (() => Date.now())
    }
    this.socketPath = taskWraithControlSocketPath(options.userDataPath, this.options.platform)
    this.tokenPath = taskWraithControlTokenPath(options.userDataPath)
    this.discoveryPath = taskWraithControlDiscoveryPath(options.userDataPath)
  }

  async start(): Promise<void> {
    if (this.server) return
    await mkdir(this.options.userDataPath, { recursive: true, mode: 0o700 })
    if (this.options.platform !== 'win32') {
      await mkdir(dirname(this.socketPath), { recursive: true, mode: 0o700 })
      await chmod(dirname(this.socketPath), 0o700).catch(() => {})
      const live = await socketIsLive(this.socketPath)
      if (live) throw new Error('TaskWraith local-control socket is already owned by a live host.')
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
      if (this.options.platform !== 'win32') {
        await chmod(this.socketPath, 0o600)
      }

      await writeFile(this.tokenPath, `${this.token}\n`, { encoding: 'utf8', mode: 0o600 })
      await chmod(this.tokenPath, 0o600).catch(() => {})

      const discovery: TaskWraithControlDiscovery = {
        protocolVersion: TASKWRAITH_CONTROL_PROTOCOL_VERSION,
        socketPath: this.socketPath,
        tokenPath: this.tokenPath,
        pid: process.pid,
        startedAt: new Date(this.options.now()).toISOString()
      }
      await writeFile(this.discoveryPath, `${JSON.stringify(discovery, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600
      })
      await chmod(this.discoveryPath, 0o600).catch(() => {})

      await this.poll()
      this.pollTimer = setInterval(() => void this.poll(), this.options.pollIntervalMs)
      this.pollTimer.unref?.()
      this.options.log?.(`[local-control] listening at ${this.socketPath}`)
    } catch (error) {
      this.server = null
      for (const client of this.clients) {
        clearTimeout(client.handshakeTimer)
        client.socket.destroy()
      }
      this.clients.clear()
      if (server.listening) {
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
      if (ownsSocket) {
        await Promise.all([
          rm(this.discoveryPath, { force: true }),
          rm(this.tokenPath, { force: true }),
          this.options.platform === 'win32'
            ? Promise.resolve()
            : rm(this.socketPath, { force: true })
        ])
        if (this.options.platform !== 'win32') {
          await rmdir(dirname(this.socketPath)).catch(() => {})
        }
      }
      throw error
    }
  }

  async stop(): Promise<void> {
    this.stopPolling()
    this.disconnectClients()
    const server = this.server
    this.server = null
    if (server?.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
    await Promise.all([
      rm(this.discoveryPath, { force: true }),
      rm(this.tokenPath, { force: true }),
      this.options.platform === 'win32' ? Promise.resolve() : rm(this.socketPath, { force: true })
    ])
    if (this.options.platform !== 'win32') {
      await rmdir(dirname(this.socketPath)).catch(() => {})
    }
  }

  /**
   * Electron cannot await work from `will-quit`/`exit`. This synchronous,
   * idempotent variant removes only the three exact control artifacts after
   * closing sockets, so an ordinary app exit does not leave stale discovery.
   */
  stopSync(): void {
    this.stopPolling()
    this.disconnectClients()
    const server = this.server
    this.server = null
    if (server?.listening) server.close()
    for (const path of [
      this.discoveryPath,
      this.tokenPath,
      ...(this.options.platform === 'win32' ? [] : [this.socketPath])
    ]) {
      try {
        unlinkSync(path)
      } catch {
        // Missing/stale artifacts are already the desired state.
      }
    }
    if (this.options.platform !== 'win32') {
      try {
        rmdirSync(dirname(this.socketPath))
      } catch {
        // Leave a non-empty or concurrently recreated private directory alone.
      }
    }
  }

  private stopPolling(): void {
    if (!this.pollTimer) return
    clearInterval(this.pollTimer)
    this.pollTimer = null
  }

  private disconnectClients(): void {
    for (const client of this.clients) {
      const event: TaskWraithControlEvent = {
        type: 'event',
        event: 'host.closing',
        sequence: ++this.snapshotSequence
      }
      socketWrite(client.socket, event)
      clearTimeout(client.handshakeTimer)
      client.socket.destroy()
    }
    this.clients.clear()
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
      buffer: '',
      capabilities: new Set(),
      origin: null,
      selectedThreadId: null,
      selectedThreadLimit: 80,
      lastSnapshotDigest: '',
      lastThreadDigest: '',
      handshakeTimer: setTimeout(() => socket.destroy(), 5_000)
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
    if (Buffer.byteLength(state.buffer, 'utf8') > TASKWRAITH_CONTROL_MAX_LINE_BYTES) {
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
    const decoded = decodeTaskWraithControlClientMessage(raw)
    if (!decoded.ok) {
      if (state.authenticated && raw && typeof raw === 'object' && 'id' in raw) {
        socketWrite(state.socket, {
          type: 'response',
          id: String((raw as { id?: unknown }).id ?? '?'),
          ok: false,
          error: { code: 'invalid_request', message: decoded.error }
        })
      } else {
        state.socket.destroy()
      }
      return
    }
    if (!state.authenticated) {
      this.authenticate(state, decoded.message)
      return
    }
    if (decoded.message.type === 'hello') {
      state.socket.destroy()
      return
    }
    await this.dispatch(state, decoded.message)
  }

  private authenticate(state: ClientState, message: TaskWraithControlClientMessage): void {
    if (message.type !== 'hello' || !safeTokenEquals(this.token, message.token)) {
      state.socket.destroy()
      return
    }
    state.authenticated = true
    state.capabilities = new Set(
      message.capabilities.filter((capability): capability is TaskWraithControlCapability =>
        KNOWN_CAPABILITIES.has(capability)
      )
    )
    state.origin = {
      channel: 'local-control',
      ...(message.clientPid !== undefined ? { pid: message.clientPid } : {}),
      ...(message.clientLabel ? { label: message.clientLabel } : {}),
      clientVersion: message.clientVersion
    }
    // Start from the projection the host last published: a fresh subscriber
    // pulls its first snapshot itself rather than being pushed one it did not
    // ask for, exactly as before per-client digests existed.
    state.lastSnapshotDigest = this.lastSnapshotDigest
    clearTimeout(state.handshakeTimer)
    const welcome: TaskWraithControlWelcome = {
      type: 'welcome',
      protocolVersion: TASKWRAITH_CONTROL_PROTOCOL_VERSION,
      hostVersion: this.options.hostVersion,
      sessionId: this.sessionId,
      capabilities: [...SERVER_CAPABILITIES]
    }
    socketWrite(state.socket, welcome)
  }

  private async dispatch(state: ClientState, request: TaskWraithControlRequest): Promise<void> {
    try {
      let result: unknown
      switch (request.method) {
        case 'ping':
          result = { now: this.options.now() }
          break
        case 'snapshot.get':
          result = await this.options.facade.snapshot()
          break
        case 'thread.select': {
          state.selectedThreadId = request.params.threadId
          state.selectedThreadLimit = request.params.limit ?? 80
          const snapshot = await this.options.facade.selectThread(
            state.selectedThreadId,
            state.selectedThreadLimit
          )
          state.lastThreadDigest = stableDigest(snapshot)
          result = snapshot
          break
        }
        case 'composer.send': {
          const { model, reasoningEffort } = request.params
          const selection =
            model || reasoningEffort
              ? { ...(model ? { model } : {}), ...(reasoningEffort ? { reasoningEffort } : {}) }
              : undefined
          // The host stamps what it observed at hello onto the prompt, so the
          // text a sender writes never has to attribute itself.
          result = await this.options.facade.sendPrompt(
            request.params.threadId,
            request.params.text,
            selection,
            state.origin ?? undefined
          )
          break
        }
        case 'run.cancel':
          result = await this.options.facade.cancelRun(request.params.threadId)
          break
        case 'thread.offers':
          result = await this.options.facade.threadOffers(request.params.threadId)
          break
        case 'thread.find':
          result = await this.options.facade.findThreads(request.params ?? {})
          break
        case 'ensemble.seat.toggle':
          result = await this.options.facade.toggleEnsembleSeat(
            request.params.threadId,
            request.params.participantId,
            request.params.enabled
          )
          break
      }
      socketWrite(state.socket, { type: 'response', id: request.id, ok: true, result })
      if (
        request.method === 'composer.send' ||
        request.method === 'run.cancel' ||
        request.method === 'ensemble.seat.toggle'
      ) {
        void this.poll()
      }
    } catch (error) {
      socketWrite(state.socket, {
        type: 'response',
        id: request.id,
        ok: false,
        error: {
          code: 'request_failed',
          message: error instanceof Error ? error.message : String(error)
        }
      })
    }
  }

  /** A push is queued only when the client's previous one has fully flushed. */
  private static canPush(client: ClientState): boolean {
    return !client.socket.destroyed && client.socket.writable && client.socket.writableLength === 0
  }

  /**
   * Projection work is owed only to clients that subscribed to it: a
   * compose-only client (a shell steer, an outside agent) costs the host
   * nothing per tick, while the TUI advertises every capability and is served
   * exactly as before. A client whose previous push has not flushed is
   * skipped, never queued behind — when the host's own loop is the slow side,
   * stacking pushes is what tripped the not-draining guard — and the next
   * tick retries with whatever is newest, so a skipped intermediate is never
   * owed.
   */
  private async poll(): Promise<void> {
    const subscribers: ClientState[] = []
    const watchers: ClientState[] = []
    for (const client of this.clients) {
      if (!client.authenticated) continue
      if (client.capabilities.has('snapshot')) subscribers.push(client)
      if (client.capabilities.has('transcript') && client.selectedThreadId) watchers.push(client)
    }
    if (subscribers.length === 0 && watchers.length === 0) return
    if (this.polling) return
    this.polling = true
    try {
      if (subscribers.length > 0) {
        const snapshot = await this.options.facade.snapshot()
        const digest = stableDigest(snapshot)
        this.lastSnapshotDigest = digest
        let event: TaskWraithControlEvent | null = null
        for (const client of subscribers) {
          if (client.lastSnapshotDigest === digest || !LocalControlServer.canPush(client)) continue
          if (!event) {
            event = {
              type: 'event',
              event: 'snapshot.changed',
              sequence: ++this.snapshotSequence,
              payload: snapshot
            }
          }
          // A projection too large for the transport is not retried every
          // tick: the client cannot receive it, and its own snapshot.get
          // reports the same bounded error.
          if (socketWrite(client.socket, event) !== 'unwritable') {
            client.lastSnapshotDigest = digest
          }
        }
      }

      for (const client of watchers) {
        const threadId = client.selectedThreadId
        if (!threadId || !LocalControlServer.canPush(client)) continue
        try {
          const thread = await this.options.facade.selectThread(
            threadId,
            client.selectedThreadLimit
          )
          const threadDigest = stableDigest(thread)
          if (threadDigest === client.lastThreadDigest) continue
          const outcome = socketWrite(client.socket, {
            type: 'event',
            event: 'thread.changed',
            sequence: ++this.snapshotSequence,
            payload: thread
          })
          if (outcome !== 'unwritable') client.lastThreadDigest = threadDigest
        } catch {
          client.selectedThreadId = null
          client.lastThreadDigest = ''
        }
      }
    } catch (error) {
      this.options.log?.(
        `[local-control] projection poll failed: ${error instanceof Error ? error.message : String(error)}`
      )
    } finally {
      this.polling = false
    }
  }
}

export async function readLocalControlToken(path: string): Promise<string> {
  return (await readFile(path, 'utf8')).trim()
}
