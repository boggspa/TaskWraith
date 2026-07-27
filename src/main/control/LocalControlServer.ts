import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { rmdirSync, unlinkSync } from 'node:fs'
import { chmod, mkdir, readFile, rm, rmdir, writeFile } from 'node:fs/promises'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { dirname } from 'node:path'
import {
  TASKWRAITH_CONTROL_MAX_LINE_BYTES,
  TASKWRAITH_CONTROL_PROTOCOL_VERSION,
  decodeTaskWraithControlClientMessage,
  type TaskWraithControlClientMessage,
  type TaskWraithControlDiscovery,
  type TaskWraithControlEvent,
  type TaskWraithControlHostMessage,
  type TaskWraithControlRequest,
  type TaskWraithControlSnapshot,
  type TaskWraithControlThreadSnapshot,
  type TaskWraithControlWelcome
} from '../../shared/taskWraithControlProtocol'
import {
  taskWraithControlDiscoveryPath,
  taskWraithControlSocketPath,
  taskWraithControlTokenPath
} from '../../shared/taskWraithControlPaths.node'

export interface TaskWraithLocalControlFacade {
  snapshot(): TaskWraithControlSnapshot | Promise<TaskWraithControlSnapshot>
  selectThread(
    threadId: string,
    limit: number
  ): TaskWraithControlThreadSnapshot | Promise<TaskWraithControlThreadSnapshot>
  sendPrompt(threadId: string, text: string): Promise<{ dispatched: boolean; message: string }>
  cancelRun(threadId: string): Promise<{ cancelled: boolean; message: string }>
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
  selectedThreadId: string | null
  selectedThreadLimit: number
  lastThreadDigest: string
  handshakeTimer: ReturnType<typeof setTimeout>
}

const SERVER_CAPABILITIES = [
  'snapshot',
  'transcript',
  'compose',
  'cancel',
  'ensemble',
  'provider-presentation'
] as const

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

function socketWrite(socket: Socket, message: TaskWraithControlHostMessage): boolean {
  if (socket.destroyed || !socket.writable) return false
  let line = `${JSON.stringify(message)}\n`
  let bytes = Buffer.byteLength(line, 'utf8')
  if (bytes > TASKWRAITH_CONTROL_MAX_LINE_BYTES) {
    if (message.type !== 'response') return false
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
    return false
  }
  socket.write(line)
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
      selectedThreadId: null,
      selectedThreadLimit: 80,
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
        case 'composer.send':
          result = await this.options.facade.sendPrompt(
            request.params.threadId,
            request.params.text
          )
          break
        case 'run.cancel':
          result = await this.options.facade.cancelRun(request.params.threadId)
          break
      }
      socketWrite(state.socket, { type: 'response', id: request.id, ok: true, result })
      if (request.method === 'composer.send' || request.method === 'run.cancel') {
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

  private async poll(): Promise<void> {
    if (![...this.clients].some((client) => client.authenticated)) return
    if (this.polling) return
    this.polling = true
    try {
      const snapshot = await this.options.facade.snapshot()
      const digest = stableDigest(snapshot)
      if (digest !== this.lastSnapshotDigest) {
        this.lastSnapshotDigest = digest
        const event: TaskWraithControlEvent = {
          type: 'event',
          event: 'snapshot.changed',
          sequence: ++this.snapshotSequence,
          payload: snapshot
        }
        for (const client of this.clients) {
          if (client.authenticated) socketWrite(client.socket, event)
        }
      }

      for (const client of this.clients) {
        if (!client.authenticated || !client.selectedThreadId) continue
        try {
          const thread = await this.options.facade.selectThread(
            client.selectedThreadId,
            client.selectedThreadLimit
          )
          const threadDigest = stableDigest(thread)
          if (threadDigest === client.lastThreadDigest) continue
          client.lastThreadDigest = threadDigest
          socketWrite(client.socket, {
            type: 'event',
            event: 'thread.changed',
            sequence: ++this.snapshotSequence,
            payload: thread
          })
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
