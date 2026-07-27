import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import { createConnection, type Socket } from 'node:net'
import {
  TASKWRAITH_CONTROL_CLIENT_NAME,
  TASKWRAITH_CONTROL_MAX_LINE_BYTES,
  TASKWRAITH_CONTROL_PROTOCOL_VERSION,
  type TaskWraithControlCapability,
  type TaskWraithControlDiscovery,
  type TaskWraithControlEvent,
  type TaskWraithControlHostMessage,
  type TaskWraithControlRequest,
  type TaskWraithControlSnapshot,
  type TaskWraithControlThreadSnapshot,
  type TaskWraithControlWelcome
} from '../../shared/taskWraithControlProtocol'
import {
  defaultTaskWraithUserDataPath,
  taskWraithControlDiscoveryPath
} from '../../shared/taskWraithControlPaths.node'

export interface TaskWraithControlClientOptions {
  clientVersion: string
  userDataPath?: string
  discoveryPath?: string
  connectTimeoutMs?: number
  requestTimeoutMs?: number
}

type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export interface TaskWraithControlClientEvents {
  welcome: [TaskWraithControlWelcome]
  snapshot: [TaskWraithControlSnapshot]
  thread: [TaskWraithControlThreadSnapshot]
  disconnected: [Error | null]
}

const CLIENT_CAPABILITIES: TaskWraithControlCapability[] = [
  'snapshot',
  'transcript',
  'compose',
  'cancel',
  'ensemble',
  'provider-presentation'
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function parseDiscovery(raw: string): TaskWraithControlDiscovery {
  const value: unknown = JSON.parse(raw)
  if (!isRecord(value)) throw new Error('TaskWraith control discovery is malformed.')
  if (value.protocolVersion !== TASKWRAITH_CONTROL_PROTOCOL_VERSION) {
    throw new Error('TaskWraith control protocol version is not supported.')
  }
  if (
    typeof value.socketPath !== 'string' ||
    !value.socketPath ||
    typeof value.tokenPath !== 'string' ||
    !value.tokenPath
  ) {
    throw new Error('TaskWraith control discovery is incomplete.')
  }
  return value as unknown as TaskWraithControlDiscovery
}

export class TaskWraithControlClient extends EventEmitter<TaskWraithControlClientEvents> {
  private readonly options: Required<
    Pick<TaskWraithControlClientOptions, 'clientVersion' | 'connectTimeoutMs' | 'requestTimeoutMs'>
  > &
    Omit<TaskWraithControlClientOptions, 'clientVersion' | 'connectTimeoutMs' | 'requestTimeoutMs'>
  private socket: Socket | null = null
  private buffer = ''
  private pending = new Map<string, PendingRequest>()
  private connectResolve: ((welcome: TaskWraithControlWelcome) => void) | null = null
  private connectReject: ((error: Error) => void) | null = null
  private connectTimer: ReturnType<typeof setTimeout> | null = null
  private closedByClient = false

  welcome: TaskWraithControlWelcome | null = null

  constructor(options: TaskWraithControlClientOptions) {
    super()
    this.options = {
      ...options,
      connectTimeoutMs: options.connectTimeoutMs ?? 2_500,
      requestTimeoutMs: options.requestTimeoutMs ?? 12_000
    }
  }

  get connected(): boolean {
    return Boolean(this.socket && !this.socket.destroyed && this.welcome)
  }

  async connect(): Promise<TaskWraithControlWelcome> {
    if (this.connected && this.welcome) return this.welcome
    if (this.socket && !this.socket.destroyed) {
      throw new Error('TaskWraith control connection is already starting.')
    }
    this.closedByClient = false
    const userDataPath = this.options.userDataPath ?? defaultTaskWraithUserDataPath()
    const discoveryPath = this.options.discoveryPath ?? taskWraithControlDiscoveryPath(userDataPath)
    const discovery = parseDiscovery(await readFile(discoveryPath, 'utf8'))
    const token = (await readFile(discovery.tokenPath, 'utf8')).trim()
    if (!token) throw new Error('TaskWraith control token is unavailable.')

    return new Promise<TaskWraithControlWelcome>((resolve, reject) => {
      this.connectResolve = resolve
      this.connectReject = reject
      const socket = createConnection(discovery.socketPath)
      this.socket = socket
      socket.setEncoding('utf8')
      socket.setNoDelay(true)
      socket.once('connect', () => {
        socket.write(
          `${JSON.stringify({
            type: 'hello',
            protocolVersion: TASKWRAITH_CONTROL_PROTOCOL_VERSION,
            client: TASKWRAITH_CONTROL_CLIENT_NAME,
            clientVersion: this.options.clientVersion,
            token,
            capabilities: CLIENT_CAPABILITIES
          })}\n`
        )
      })
      socket.on('data', (chunk: string) => this.onData(chunk))
      socket.once('error', (error) => this.onDisconnect(error))
      socket.once('close', () => this.onDisconnect(null))
      this.connectTimer = setTimeout(() => {
        const error = new Error('Timed out connecting to the TaskWraith host.')
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
    this.rejectPending(new Error('TaskWraith control client closed.'))
  }

  async getSnapshot(): Promise<TaskWraithControlSnapshot> {
    return this.request<TaskWraithControlSnapshot>('snapshot.get')
  }

  async selectThread(threadId: string, limit = 80): Promise<TaskWraithControlThreadSnapshot> {
    return this.request<TaskWraithControlThreadSnapshot>('thread.select', { threadId, limit })
  }

  async sendPrompt(
    threadId: string,
    text: string
  ): Promise<{ dispatched: boolean; message: string }> {
    return this.request('composer.send', { threadId, text })
  }

  async cancelRun(threadId: string): Promise<{ cancelled: boolean; message: string }> {
    return this.request('run.cancel', { threadId })
  }

  async ping(): Promise<{ now: number }> {
    return this.request('ping')
  }

  private async request<T>(
    method: TaskWraithControlRequest['method'],
    params?: Record<string, unknown>
  ): Promise<T> {
    const socket = this.socket
    if (!socket || socket.destroyed || !this.welcome) {
      throw new Error('TaskWraith host is not connected.')
    }
    const id = randomUUID()
    const message = {
      type: 'request',
      id,
      method,
      ...(params ? { params } : {})
    }
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`TaskWraith host request timed out: ${method}`))
      }, this.options.requestTimeoutMs)
      timer.unref?.()
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer
      })
      socket.write(`${JSON.stringify(message)}\n`)
    })
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    if (Buffer.byteLength(this.buffer, 'utf8') > TASKWRAITH_CONTROL_MAX_LINE_BYTES) {
      this.socket?.destroy(new Error('TaskWraith host sent an oversized message.'))
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
    let message: TaskWraithControlHostMessage
    try {
      message = JSON.parse(line) as TaskWraithControlHostMessage
    } catch {
      this.socket?.destroy(new Error('TaskWraith host sent malformed JSON.'))
      return
    }
    if (message.type === 'welcome') {
      this.welcome = message
      if (this.connectTimer) clearTimeout(this.connectTimer)
      this.connectTimer = null
      this.connectResolve?.(message)
      this.connectResolve = null
      this.connectReject = null
      this.emit('welcome', message)
      return
    }
    if (message.type === 'response') {
      const pending = this.pending.get(message.id)
      if (!pending) return
      clearTimeout(pending.timer)
      this.pending.delete(message.id)
      if (message.ok) pending.resolve(message.result)
      else pending.reject(new Error(message.error.message))
      return
    }
    if (message.type !== 'event') return
    this.onEvent(message)
  }

  private onEvent(event: TaskWraithControlEvent): void {
    if (event.event === 'snapshot.changed' && isRecord(event.payload)) {
      this.emit('snapshot', event.payload as unknown as TaskWraithControlSnapshot)
    }
    if (event.event === 'thread.changed' && isRecord(event.payload)) {
      this.emit('thread', event.payload as unknown as TaskWraithControlThreadSnapshot)
    }
    if (event.event === 'host.closing') {
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
    this.failConnect(error ?? new Error('TaskWraith host disconnected.'))
    this.socket = null
    this.welcome = null
    this.buffer = ''
    this.rejectPending(error ?? new Error('TaskWraith host disconnected.'))
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
