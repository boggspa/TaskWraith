import { mkdtemp, writeFile } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  TASKWRAITH_CONTROL_MAX_LINE_BYTES,
  TASKWRAITH_CONTROL_PROTOCOL_VERSION
} from '../../shared/taskWraithControlProtocol'
import {
  TaskWraithControlClient,
  TaskWraithControlIncompatibleProtocolError
} from './TaskWraithControlClient'

const cleanup: Array<() => Promise<void> | void> = []

afterEach(async () => {
  while (cleanup.length) await cleanup.pop()?.()
})

interface FakeHost {
  server: Server
  socketPath: string
  discoveryPath: string
  tokenPath: string
  token: string
  /** Resolves with the first socket that connects. */
  nextClient(): Promise<Socket>
}

async function startFakeHost(overrides?: {
  protocolVersion?: number
  discoveryPath?: string
  token?: string
}): Promise<FakeHost> {
  const userDataPath = await mkdtemp(join(tmpdir(), 'taskwraith-tui-client-'))
  const socketPath = join(userDataPath, 'control.sock')
  const discoveryPath = overrides?.discoveryPath ?? join(userDataPath, 'discovery.json')
  const tokenPath = join(userDataPath, 'token.txt')
  const token = overrides?.token ?? 'test-token'
  await writeFile(tokenPath, `${token}\n`, 'utf8')
  await writeFile(
    discoveryPath,
    JSON.stringify({
      protocolVersion: overrides?.protocolVersion ?? TASKWRAITH_CONTROL_PROTOCOL_VERSION,
      socketPath,
      tokenPath,
      pid: process.pid,
      startedAt: new Date(0).toISOString()
    }),
    'utf8'
  )
  const server = createServer()
  const pendingClients: Socket[] = []
  const allSockets = new Set<Socket>()
  const waiters: Array<(socket: Socket) => void> = []
  server.on('connection', (socket) => {
    allSockets.add(socket)
    socket.once('close', () => allSockets.delete(socket))
    const waiter = waiters.shift()
    if (waiter) waiter(socket)
    else pendingClients.push(socket)
  })
  await new Promise<void>((resolve) => server.listen(socketPath, resolve))
  cleanup.push(() => {
    for (const socket of allSockets) socket.destroy()
    return new Promise<void>((resolve) => server.close(() => resolve()))
  })
  return {
    server,
    socketPath,
    discoveryPath,
    tokenPath,
    token,
    nextClient: () =>
      new Promise<Socket>((resolve) => {
        const existing = pendingClients.shift()
        if (existing) resolve(existing)
        else waiters.push(resolve)
      })
  }
}

function readLine(socket: Socket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const onData = (chunk: Buffer | string) => {
      buffer += chunk.toString()
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      socket.off('data', onData)
      try {
        resolve(JSON.parse(buffer.slice(0, newline)))
      } catch (error) {
        reject(error)
      }
    }
    socket.on('data', onData)
  })
}

function sendWelcome(socket: Socket): void {
  socket.write(
    `${JSON.stringify({
      type: 'welcome',
      protocolVersion: TASKWRAITH_CONTROL_PROTOCOL_VERSION,
      hostVersion: '1.9.1-preview',
      sessionId: 'session-1',
      capabilities: ['snapshot', 'transcript', 'compose', 'cancel']
    })}\n`
  )
}

async function connectedPair(): Promise<{
  host: FakeHost
  hostSocket: Socket
  client: TaskWraithControlClient
}> {
  const host = await startFakeHost()
  const client = new TaskWraithControlClient({
    clientVersion: '0.1.0-test',
    discoveryPath: host.discoveryPath,
    connectTimeoutMs: 500,
    requestTimeoutMs: 500
  })
  cleanup.push(() => client.close())
  const clientPromise = client.connect()
  const hostSocket = await host.nextClient()
  await readLine(hostSocket) // hello
  sendWelcome(hostSocket)
  await clientPromise
  return { host, hostSocket, client }
}

describe('TaskWraithControlClient', () => {
  it('sends a hello with the token from the discovered token file and resolves on welcome', async () => {
    const host = await startFakeHost()
    const client = new TaskWraithControlClient({
      clientVersion: '0.1.0-test',
      discoveryPath: host.discoveryPath
    })
    cleanup.push(() => client.close())
    const connectPromise = client.connect()
    const socket = await host.nextClient()
    const hello = await readLine(socket)
    expect(hello.type).toBe('hello')
    expect(hello.token).toBe(host.token)
    expect(hello.protocolVersion).toBe(TASKWRAITH_CONTROL_PROTOCOL_VERSION)
    sendWelcome(socket)
    const welcome = await connectPromise
    expect(welcome.hostVersion).toBe('1.9.1-preview')
    expect(client.connected).toBe(true)
  })

  it('rejects with a distinct error when discovery advertises an incompatible protocol version', async () => {
    const host = await startFakeHost({ protocolVersion: 999 })
    const client = new TaskWraithControlClient({
      clientVersion: '0.1.0-test',
      discoveryPath: host.discoveryPath
    })
    cleanup.push(() => client.close())
    await expect(client.connect()).rejects.toBeInstanceOf(
      TaskWraithControlIncompatibleProtocolError
    )
  })

  it('rejects connect() when the socket closes before a welcome arrives (auth failure)', async () => {
    const host = await startFakeHost()
    const client = new TaskWraithControlClient({
      clientVersion: '0.1.0-test',
      discoveryPath: host.discoveryPath,
      connectTimeoutMs: 2_000
    })
    cleanup.push(() => client.close())
    const connectPromise = client.connect()
    const socket = await host.nextClient()
    await readLine(socket) // hello
    socket.destroy() // simulate the host rejecting a bad token by closing
    await expect(connectPromise).rejects.toThrow()
    expect(client.connected).toBe(false)
  })

  it('rejects connect() once the connect timeout elapses with no welcome', async () => {
    const host = await startFakeHost()
    const client = new TaskWraithControlClient({
      clientVersion: '0.1.0-test',
      discoveryPath: host.discoveryPath,
      connectTimeoutMs: 30
    })
    cleanup.push(() => client.close())
    const connectPromise = client.connect()
    await host.nextClient() // accept, but never reply
    await expect(connectPromise).rejects.toThrow(/timed out/i)
  })

  it('destroys the socket and emits disconnected on malformed JSON from the host', async () => {
    const { hostSocket, client } = await connectedPair()
    const disconnected = new Promise<Error | null>((resolve) =>
      client.once('disconnected', resolve)
    )
    hostSocket.write('not json at all\n')
    await disconnected
    expect(client.connected).toBe(false)
  })

  it('destroys the socket on an oversized line from the host', async () => {
    const { hostSocket, client } = await connectedPair()
    const disconnected = new Promise<Error | null>((resolve) =>
      client.once('disconnected', resolve)
    )
    const huge = 'x'.repeat(TASKWRAITH_CONTROL_MAX_LINE_BYTES + 10)
    hostSocket.write(`${huge}\n`)
    await disconnected
    expect(client.connected).toBe(false)
  })

  it('rejects an in-flight request once the request timeout elapses', async () => {
    const { client } = await connectedPair()
    await expect(client.ping()).rejects.toThrow(/timed out/i)
  })

  it('rejects a request immediately when the socket is not connected', async () => {
    const host = await startFakeHost()
    const client = new TaskWraithControlClient({
      clientVersion: '0.1.0-test',
      discoveryPath: host.discoveryPath
    })
    cleanup.push(() => client.close())
    await expect(client.getSnapshot()).rejects.toThrow(/not connected/i)
  })

  it('emits disconnected and rejects pending requests when the host drops the connection', async () => {
    const { hostSocket, client } = await connectedPair()
    const pending = client.ping()
    const disconnected = new Promise<Error | null>((resolve) =>
      client.once('disconnected', resolve)
    )
    hostSocket.destroy()
    await disconnected
    await expect(pending).rejects.toThrow()
    expect(client.connected).toBe(false)
  })

  it('does not emit disconnected for a clean client-initiated close()', async () => {
    const { client } = await connectedPair()
    let sawDisconnect = false
    client.on('disconnected', () => {
      sawDisconnect = true
    })
    client.close()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(sawDisconnect).toBe(false)
    expect(client.connected).toBe(false)
  })

  it('rejects connect() while a connection attempt is already in flight', async () => {
    const host = await startFakeHost()
    const client = new TaskWraithControlClient({
      clientVersion: '0.1.0-test',
      discoveryPath: host.discoveryPath,
      connectTimeoutMs: 2_000
    })
    cleanup.push(() => client.close())
    void client.connect().catch(() => {})
    await host.nextClient()
    await expect(client.connect()).rejects.toThrow(/already starting/i)
  })

  it('routes snapshot.changed and thread.changed events to their listeners', async () => {
    const { hostSocket, client } = await connectedPair()
    const snapshotEvent = new Promise((resolve) => client.once('snapshot', resolve))
    const threadEvent = new Promise((resolve) => client.once('thread', resolve))
    hostSocket.write(
      `${JSON.stringify({
        type: 'event',
        event: 'snapshot.changed',
        sequence: 1,
        payload: { generatedAt: '', sequence: 1, workspaces: [], threads: [] }
      })}\n`
    )
    hostSocket.write(
      `${JSON.stringify({
        type: 'event',
        event: 'thread.changed',
        sequence: 2,
        payload: { generatedAt: '', sequence: 2, thread: { id: 't' }, rows: [], totalRows: 0 }
      })}\n`
    )
    await expect(snapshotEvent).resolves.toMatchObject({ sequence: 1 })
    await expect(threadEvent).resolves.toMatchObject({ sequence: 2 })
  })

  it('ends the socket when the host announces host.closing', async () => {
    const { hostSocket, client } = await connectedPair()
    const disconnected = new Promise<Error | null>((resolve) =>
      client.once('disconnected', resolve)
    )
    hostSocket.write(`${JSON.stringify({ type: 'event', event: 'host.closing', sequence: 1 })}\n`)
    await disconnected
    expect(client.connected).toBe(false)
  })

  it('rejects a pending request when the host sends an error response', async () => {
    const { hostSocket, client } = await connectedPair()
    const pending = client.getSnapshot()
    const request = await readLine(hostSocket)
    hostSocket.write(
      `${JSON.stringify({
        type: 'response',
        id: request.id,
        ok: false,
        error: { code: 'request_failed', message: 'boom' }
      })}\n`
    )
    await expect(pending).rejects.toThrow('boom')
  })
})
