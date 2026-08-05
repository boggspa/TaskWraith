/**
 * HostProjectionClient tests (Wave 4.1).
 *
 * In-process fake Host over real unix sockets / named pipes, discovery + token
 * files, and Host local transport frames. Covers hello/welcome, incompatible
 * discovery version, request/response kinds, body-free transport errors,
 * event fan-out (including unknown-event skip), generation fence, duplicate
 * sequence skip, cache-stale-on-disconnect, and clean client close.
 */

import { mkdtemp, writeFile } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  HOST_PROTOCOL_VERSION,
  HOST_PROJECTION_VERSION,
  type HostBootstrapWelcome,
  type HostCommand,
  type HostCommandReceipt,
  type HostDeltasFrame,
  type HostHealthFrame,
  type HostSnapshot,
  type HostSnapshotFrame
} from '../../shared/hostProtocol'
import {
  HOST_LOCAL_TRANSPORT_VERSION,
  type HostLocalTransportHostFrame
} from '../../shared/hostProtocolTransport'
import {
  HOST_PROJECTION_CLIENT_MAX_LINE_BYTES,
  HostProjectionClient,
  HostProjectionIncompatibleProtocolError,
  HostProjectionTransportError
} from './HostProjectionClient'

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
  userDataPath: string
  nextClient(): Promise<Socket>
}

async function startFakeHost(overrides?: {
  protocolVersion?: number
  token?: string
}): Promise<FakeHost> {
  const userDataPath = await mkdtemp(join(tmpdir(), 'host-projection-client-'))
  // Seatbelt sandboxes refuse unix-domain listen(); production Host still
  // advertises a sock/pipe path. Tests use loopback TCP via `127.0.0.1:<port>`
  // which HostProjectionClient accepts as an explicit escape.
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
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Fake Host failed to bind a TCP loopback port.')
  }
  const socketPath = `127.0.0.1:${address.port}`

  const discoveryPath = join(userDataPath, 'taskwraith-host-v2.json')
  const tokenPath = join(userDataPath, 'taskwraith-host-v2.token')
  const token = overrides?.token ?? 'test-host-token-0123456789abcdef'
  await writeFile(tokenPath, `${token}\n`, 'utf8')
  await writeFile(
    discoveryPath,
    JSON.stringify({
      protocolVersion: overrides?.protocolVersion ?? 2,
      socketPath,
      tokenPath,
      pid: process.pid,
      startedAt: new Date(0).toISOString()
    }),
    'utf8'
  )

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
    userDataPath,
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

function writeFrame(socket: Socket, frame: HostLocalTransportHostFrame): void {
  socket.write(`${JSON.stringify(frame)}\n`)
}

function makeWelcome(overrides?: Partial<HostBootstrapWelcome>): HostBootstrapWelcome {
  return {
    type: 'host.welcome',
    protocolVersion: HOST_PROTOCOL_VERSION,
    controlProtocolCompat: 1,
    projectionVersion: HOST_PROJECTION_VERSION,
    hostId: 'test-host',
    hostVersion: '0.0.0-test',
    sessionId: 'session-1',
    generation: 3,
    cursor: 42,
    authenticatedClient: {
      clientId: 'desktop-1',
      clientClass: 'desktop',
      clientVersion: '1.0.0-test'
    },
    capabilities: ['bootstrap', 'snapshot', 'deltas', 'health'],
    freshness: 'live',
    ...overrides
  }
}

function sendWelcome(socket: Socket, welcome = makeWelcome()): void {
  writeFrame(socket, {
    type: 'welcome',
    transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
    welcome
  })
}

function makeEmptySnapshot(generation = 3, cursor = 42): HostSnapshot {
  return {
    protocolVersion: HOST_PROTOCOL_VERSION,
    projectionVersion: HOST_PROJECTION_VERSION,
    generatedAt: '2026-08-05T00:00:00.000Z',
    generation,
    cursor,
    freshness: 'live',
    health: {
      hostStatus: 'ok',
      connectionPhase: 'live',
      supervised: false,
      freshness: 'live'
    },
    workspaces: [],
    threads: [],
    runs: [],
    missions: [],
    rounds: [],
    participants: [],
    providers: [],
    questions: [],
    approvals: [],
    schedules: [],
    usage: { availability: 'unavailable' },
    artifacts: [],
    warnings: [],
    recovery: { reopenStatus: 'unknown' }
  }
}

function makeClient(host: FakeHost): HostProjectionClient {
  const client = new HostProjectionClient({
    client: {
      clientId: 'desktop-1',
      clientClass: 'desktop',
      clientVersion: '1.0.0-test'
    },
    userDataPath: host.userDataPath,
    discoveryPath: host.discoveryPath,
    connectTimeoutMs: 500,
    requestTimeoutMs: 500
  })
  cleanup.push(() => client.close())
  return client
}

async function connectedPair(): Promise<{
  host: FakeHost
  hostSocket: Socket
  client: HostProjectionClient
}> {
  const host = await startFakeHost()
  const client = makeClient(host)
  const clientPromise = client.connect()
  const hostSocket = await host.nextClient()
  await readLine(hostSocket)
  sendWelcome(hostSocket)
  await clientPromise
  return { host, hostSocket, client }
}

describe('HostProjectionClient', () => {
  it('reads discovery + token, sends transport hello, resolves on welcome', async () => {
    const host = await startFakeHost()
    const client = makeClient(host)
    const connectPromise = client.connect()
    const socket = await host.nextClient()
    const hello = await readLine(socket)
    expect(hello.type).toBe('hello')
    expect(hello.transportVersion).toBe(HOST_LOCAL_TRANSPORT_VERSION)
    expect(hello.token).toBe(host.token)
    expect((hello.hello as { type: string }).type).toBe('host.hello')
    expect((hello.hello as { protocolVersion: number }).protocolVersion).toBe(HOST_PROTOCOL_VERSION)
    sendWelcome(socket)
    const welcome = await connectPromise
    expect(welcome.hostId).toBe('test-host')
    expect(welcome.generation).toBe(3)
    expect(welcome.cursor).toBe(42)
    expect(client.connected).toBe(true)
    expect(client.generation).toBe(3)
    expect(client.cursor).toBe(42)
  })

  it('rejects with a distinct error when discovery advertises a non-v2 protocol', async () => {
    const host = await startFakeHost({ protocolVersion: 999 })
    const client = makeClient(host)
    await expect(client.connect()).rejects.toBeInstanceOf(HostProjectionIncompatibleProtocolError)
  })

  it('rejects connect() when the socket closes before welcome (auth failure)', async () => {
    const host = await startFakeHost()
    const client = makeClient(host)
    const connectPromise = client.connect()
    const socket = await host.nextClient()
    await readLine(socket)
    socket.destroy()
    await expect(connectPromise).rejects.toThrow()
    expect(client.connected).toBe(false)
  })

  it('rejects connect() once the connect timeout elapses with no welcome', async () => {
    const host = await startFakeHost()
    const client = makeClient(host)
    const connectPromise = client.connect()
    await host.nextClient()
    await expect(connectPromise).rejects.toThrow(/timed out/i)
  })

  it('returns snapshot.get and retains a live cached snapshot', async () => {
    const { hostSocket, client } = await connectedPair()
    const pending = client.getSnapshot()
    const request = await readLine(hostSocket)
    expect(request.type).toBe('request')
    expect(request.kind).toBe('snapshot.get')
    const snapshot = makeEmptySnapshot()
    const frame: HostSnapshotFrame = {
      type: 'host.snapshot',
      protocolVersion: HOST_PROTOCOL_VERSION,
      snapshot
    }
    writeFrame(hostSocket, {
      type: 'response',
      transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
      id: String(request.id),
      ok: true,
      result: { kind: 'snapshot.get', frame }
    })
    const got = await pending
    expect(got.snapshot.generation).toBe(3)
    expect(client.cachedSnapshot?.freshness).toBe('live')
    expect(client.cachedSnapshot?.snapshot.cursor).toBe(42)
  })

  it('maps body-free transport error codes to HostProjectionTransportError', async () => {
    const { hostSocket, client } = await connectedPair()
    const pending = client.getHealth()
    const request = await readLine(hostSocket)
    writeFrame(hostSocket, {
      type: 'response',
      transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
      id: String(request.id),
      ok: false,
      error: { code: 'host_unavailable' }
    })
    await expect(pending).rejects.toBeInstanceOf(HostProjectionTransportError)
    await expect(pending).rejects.toMatchObject({ code: 'host_unavailable' })
  })

  it('routes deltas.since / receipt.lookup / health.get / command.submit', async () => {
    const { hostSocket, client } = await connectedPair()

    const deltasPending = client.getDeltasSince({ generation: 3, cursor: 10 })
    const deltasReq = await readLine(hostSocket)
    expect(deltasReq.kind).toBe('deltas.since')
    const deltasFrame: HostDeltasFrame = {
      type: 'host.deltas',
      protocolVersion: HOST_PROTOCOL_VERSION,
      result: {
        kind: 'deltas',
        generation: 3,
        fromCursor: 10,
        toCursor: 12,
        deltas: []
      }
    }
    writeFrame(hostSocket, {
      type: 'response',
      transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
      id: String(deltasReq.id),
      ok: true,
      result: { kind: 'deltas.since', frame: deltasFrame }
    })
    const deltasGot = await deltasPending
    expect(deltasGot.result.kind).toBe('deltas')
    if (deltasGot.result.kind === 'deltas') {
      expect(deltasGot.result.toCursor).toBe(12)
    }

    const receiptPending = client.lookupReceipt({ commandId: 'cmd-1' })
    const receiptReq = await readLine(hostSocket)
    expect(receiptReq.kind).toBe('receipt.lookup')
    const receipt: HostCommandReceipt = {
      type: 'host.receipt',
      protocolVersion: HOST_PROTOCOL_VERSION,
      commandId: 'cmd-1',
      idempotencyKey: 'key-1',
      name: 'ping',
      actor: { actorId: 'desktop-1', clientId: 'desktop-1', clientClass: 'desktop' },
      authority: { decision: 'allow' },
      status: 'pending',
      commandFingerprint: 'a'.repeat(64),
      generation: 3,
      cursor: 42,
      createdAt: '2026-08-05T00:00:00.000Z',
      updatedAt: '2026-08-05T00:00:00.000Z'
    }
    writeFrame(hostSocket, {
      type: 'response',
      transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
      id: String(receiptReq.id),
      ok: true,
      result: { kind: 'receipt.lookup', receipt }
    })
    expect((await receiptPending).commandId).toBe('cmd-1')

    const healthPending = client.getHealth()
    const healthReq = await readLine(hostSocket)
    expect(healthReq.kind).toBe('health.get')
    const healthFrame: HostHealthFrame = {
      type: 'host.health',
      protocolVersion: HOST_PROTOCOL_VERSION,
      health: {
        hostStatus: 'ok',
        connectionPhase: 'live',
        supervised: true,
        freshness: 'live'
      }
    }
    writeFrame(hostSocket, {
      type: 'response',
      transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
      id: String(healthReq.id),
      ok: true,
      result: { kind: 'health.get', frame: healthFrame }
    })
    expect((await healthPending).health.supervised).toBe(true)

    const command: HostCommand = {
      type: 'host.command',
      protocolVersion: HOST_PROTOCOL_VERSION,
      commandId: 'cmd-2',
      idempotencyKey: 'key-2',
      name: 'ping',
      actor: { actorId: 'desktop-1', clientId: 'desktop-1', clientClass: 'desktop' },
      target: {},
      issuedAt: '2026-08-05T00:00:00.000Z',
      arguments: {}
    }
    const commandPending = client.submitCommand(command)
    const commandReq = await readLine(hostSocket)
    expect(commandReq.kind).toBe('command.submit')
    writeFrame(hostSocket, {
      type: 'response',
      transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
      id: String(commandReq.id),
      ok: true,
      result: { kind: 'command.submit', receipt }
    })
    expect((await commandPending).commandId).toBe('cmd-1')
  })

  it('emits deltas/health events and ends the socket on host.closing', async () => {
    const { hostSocket, client } = await connectedPair()
    const deltasSeen = new Promise<number>((resolve) =>
      client.once('deltas', (_frame, sequence) => resolve(sequence))
    )
    const healthSeen = new Promise<number>((resolve) =>
      client.once('health', (_frame, sequence) => resolve(sequence))
    )
    const closingSeen = new Promise<number>((resolve) =>
      client.once('hostClosing', (sequence) => resolve(sequence))
    )

    writeFrame(hostSocket, {
      type: 'event',
      transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
      event: 'deltas',
      sequence: 1,
      payload: {
        type: 'host.deltas',
        protocolVersion: HOST_PROTOCOL_VERSION,
        result: {
          kind: 'deltas',
          generation: 3,
          fromCursor: 40,
          toCursor: 41,
          deltas: []
        }
      }
    })
    writeFrame(hostSocket, {
      type: 'event',
      transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
      event: 'health',
      sequence: 2,
      payload: {
        type: 'host.health',
        protocolVersion: HOST_PROTOCOL_VERSION,
        health: {
          hostStatus: 'ok',
          connectionPhase: 'live',
          supervised: false,
          freshness: 'live'
        }
      }
    })
    writeFrame(hostSocket, {
      type: 'event',
      transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
      event: 'host.closing',
      sequence: 3
    })

    expect(await deltasSeen).toBe(1)
    expect(await healthSeen).toBe(2)
    expect(await closingSeen).toBe(3)
  })

  it('skips unknown event kinds without disconnecting (forward compat)', async () => {
    const { hostSocket, client } = await connectedPair()
    let disconnected = false
    client.on('disconnected', () => {
      disconnected = true
    })
    hostSocket.write(
      `${JSON.stringify({
        type: 'event',
        transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
        event: 'future.kind',
        sequence: 9,
        payload: { anything: true }
      })}\n`
    )
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(client.connected).toBe(true)
    expect(disconnected).toBe(false)
  })

  it('skips duplicate/late event sequences idempotently', async () => {
    const { hostSocket, client } = await connectedPair()
    const sequences: number[] = []
    client.on('health', (_frame, sequence) => {
      sequences.push(sequence)
    })
    const healthPayload = {
      type: 'host.health' as const,
      protocolVersion: HOST_PROTOCOL_VERSION,
      health: {
        hostStatus: 'ok' as const,
        connectionPhase: 'live' as const,
        supervised: false,
        freshness: 'live' as const
      }
    }
    writeFrame(hostSocket, {
      type: 'event',
      transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
      event: 'health',
      sequence: 5,
      payload: healthPayload
    })
    writeFrame(hostSocket, {
      type: 'event',
      transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
      event: 'health',
      sequence: 5,
      payload: healthPayload
    })
    writeFrame(hostSocket, {
      type: 'event',
      transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
      event: 'health',
      sequence: 4,
      payload: healthPayload
    })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(sequences).toEqual([5])
  })

  it('marks cached snapshot stale and emits disconnected when the host drops', async () => {
    const { hostSocket, client } = await connectedPair()
    const pending = client.getSnapshot()
    const request = await readLine(hostSocket)
    writeFrame(hostSocket, {
      type: 'response',
      transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
      id: String(request.id),
      ok: true,
      result: {
        kind: 'snapshot.get',
        frame: {
          type: 'host.snapshot',
          protocolVersion: HOST_PROTOCOL_VERSION,
          snapshot: makeEmptySnapshot()
        }
      }
    })
    await pending
    expect(client.cachedSnapshot?.freshness).toBe('live')

    const disconnected = new Promise<Error | null>((resolve) =>
      client.once('disconnected', resolve)
    )
    hostSocket.destroy()
    await disconnected
    expect(client.connected).toBe(false)
    expect(client.cachedSnapshot?.freshness).toBe('stale')
    expect(client.welcome).toBeNull()
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

  it('rejects a request immediately when not connected', async () => {
    const host = await startFakeHost()
    const client = makeClient(host)
    await expect(client.getSnapshot()).rejects.toThrow(/not connected/i)
  })

  it('rejects connect() while a connection attempt is already in flight', async () => {
    const host = await startFakeHost()
    const client = makeClient(host)
    void client.connect().catch(() => {})
    await host.nextClient()
    await expect(client.connect()).rejects.toThrow(/already starting/i)
  })

  it('destroys the socket on malformed JSON from the host', async () => {
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
    const huge = 'x'.repeat(HOST_PROJECTION_CLIENT_MAX_LINE_BYTES + 10)
    hostSocket.write(`${huge}\n`)
    await disconnected
    expect(client.connected).toBe(false)
  })

  it('generation-fences deltas events from a foreign generation (marks cache stale)', async () => {
    const { hostSocket, client } = await connectedPair()
    const snapPending = client.getSnapshot()
    const snapReq = await readLine(hostSocket)
    writeFrame(hostSocket, {
      type: 'response',
      transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
      id: String(snapReq.id),
      ok: true,
      result: {
        kind: 'snapshot.get',
        frame: {
          type: 'host.snapshot',
          protocolVersion: HOST_PROTOCOL_VERSION,
          snapshot: makeEmptySnapshot()
        }
      }
    })
    await snapPending
    expect(client.cachedSnapshot?.freshness).toBe('live')

    let deltasEmitted = false
    client.on('deltas', () => {
      deltasEmitted = true
    })
    writeFrame(hostSocket, {
      type: 'event',
      transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
      event: 'deltas',
      sequence: 1,
      payload: {
        type: 'host.deltas',
        protocolVersion: HOST_PROTOCOL_VERSION,
        result: {
          kind: 'deltas',
          generation: 99,
          fromCursor: 0,
          toCursor: 1,
          deltas: []
        }
      }
    })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(deltasEmitted).toBe(false)
    expect(client.cachedSnapshot?.freshness).toBe('stale')
    expect(client.connected).toBe(true)
  })
})
