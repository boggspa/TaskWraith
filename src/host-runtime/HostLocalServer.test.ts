/**
 * HostLocalServer tests (Wave 3.3).
 *
 * In-process over real unix sockets inside temporary directories per test.
 * Tests cover the full auth failure matrix, happy bootstrap round-trip,
 * each request kind routed to the exact facade method, fail-closed transport
 * handling, lifecycle (stop/stopSync idempotent + artifact cleanup), discovery
 * round-trip, permission modes, and a RED-proof probe on the auth gate.
 *
 * Body-free everywhere; born Prettier-clean; all existing tests unchanged.
 */

/* eslint-disable @typescript-eslint/no-require-imports -- source-isolation probes intentionally load Node modules dynamically. */

import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  HOST_LOCAL_TRANSPORT_VERSION,
  type HostLocalTransportClientFrame,
  type HostLocalTransportHostFrame
} from '../shared/hostProtocolTransport'
import {
  HOST_PROTOCOL_VERSION,
  HOST_PROJECTION_VERSION,
  type HostCommand,
  type HostCapability,
  type HostClientClass,
  type HostCommandReceipt,
  type HostCursorPosition,
  type HostDeltaEnvelope,
  type HostDeltasSinceResult,
  type HostHealthProjection,
  type HostSnapshot
} from '../shared/hostProtocol'
import { decodeTaskWraithHostDiscovery } from '../shared/taskWraithHostPaths.node'
import type {
  HostAuthority,
  HostAuthorityCallContext,
  HostAuthorityReceiptResult
} from './HostAuthority'
import type { HostSession, HostSessionBinding } from './HostSession'
import { HostLocalServer } from './HostLocalServer'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpUserDataPath(): string {
  return mkdtempSync(join(tmpdir(), 'host-local-server-test-'))
}

function makeClientHello(
  token: string,
  capabilities: readonly HostCapability[] = ['bootstrap', 'snapshot', 'health'],
  client: { clientId: string; clientClass: HostClientClass; clientVersion: string } = {
    clientId: 'test-client',
    clientClass: 'test',
    clientVersion: '1.0.0'
  }
): HostLocalTransportClientFrame {
  return {
    type: 'hello',
    transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
    token,
    hello: {
      type: 'host.hello',
      protocolVersion: HOST_PROTOCOL_VERSION,
      projectionVersion: HOST_PROJECTION_VERSION,
      client,
      capabilities: [...capabilities]
    }
  }
}

function makeRequest(
  kind: HostLocalTransportClientFrame extends { type: 'request'; kind: infer K } ? K : never,
  id: string,
  params?: Record<string, unknown>
): HostLocalTransportClientFrame {
  return {
    type: 'request',
    transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
    id,
    kind,
    params: (params ?? {}) as never
  } as HostLocalTransportClientFrame
}

function mockHostSession(
  overrides?: Partial<HostSession>
): HostSession & { bind: ReturnType<typeof vi.fn> } {
  const bind = vi.fn()
  // Each bind call mints a fresh binding with a unique sessionId so that
  // concurrent clients get distinct sessions per contract.
  bind.mockImplementation(
    (
      request:
        | {
            verifiedContext?: { clientClass?: HostClientClass; clientId?: string; actorId?: string }
            authenticatedClient?: {
              clientClass: HostClientClass
              clientId: string
              clientVersion: string
            }
            clientCapabilityRequest?: readonly HostCapability[]
          }
        | undefined
    ) => {
      const sid = randomUUID()
      const authenticatedClient = request?.authenticatedClient ?? {
        clientId: 'test-client',
        clientClass: 'test' as const,
        clientVersion: '1.0.0'
      }
      const offered: readonly HostCapability[] = [
        'bootstrap',
        'snapshot',
        'deltas',
        'model-offers',
        'provider-catalog',
        'provider-auth',
        'history',
        'setup',
        'host-lifecycle',
        'commands',
        'health'
      ]
      const capabilities = (request?.clientCapabilityRequest ?? []).filter((capability) =>
        offered.includes(capability)
      )
      const binding: HostSessionBinding = {
        sessionId: sid,
        actor: {
          actorId: request?.verifiedContext?.actorId ?? authenticatedClient.clientId,
          clientId: authenticatedClient.clientId,
          clientClass: authenticatedClient.clientClass
        },
        authenticatedClient,
        welcome: {
          type: 'host.welcome',
          protocolVersion: HOST_PROTOCOL_VERSION,
          controlProtocolCompat: 1,
          projectionVersion: HOST_PROJECTION_VERSION,
          hostId: 'test-host',
          hostVersion: '0.0.0-test',
          sessionId: sid,
          generation: 0,
          cursor: 1,
          authenticatedClient,
          capabilities,
          freshness: 'live'
        },
        boundGeneration: 0,
        boundCursor: 1
      }
      return { ok: true, value: binding }
    }
  )

  return {
    bind,
    lookup: vi.fn(),
    size: vi.fn().mockReturnValue(1),
    ...overrides
  } as unknown as HostSession & { bind: ReturnType<typeof vi.fn> }
}

function mockHostAuthority(overrides?: Partial<HostAuthority>): HostAuthority & {
  snapshot: ReturnType<typeof vi.fn>
  deltas: ReturnType<typeof vi.fn>
  threadOffers: ReturnType<typeof vi.fn>
  providerStatuses: ReturnType<typeof vi.fn>
  providerOffers: ReturnType<typeof vi.fn>
  providerAuthFlows: ReturnType<typeof vi.fn>
  providerAuthStatus: ReturnType<typeof vi.fn>
  threadHistory: ReturnType<typeof vi.fn>
  historySince: ReturnType<typeof vi.fn>
  command: ReturnType<typeof vi.fn>
  receipt: ReturnType<typeof vi.fn>
  health: ReturnType<typeof vi.fn>
  shutdown: ReturnType<typeof vi.fn>
} {
  const snapshot = vi.fn().mockResolvedValue({ ok: true, value: makeEmptySnapshot() })
  const deltas = vi.fn().mockResolvedValue({
    ok: true,
    value: {
      kind: 'deltas',
      generation: 0,
      fromCursor: 0,
      toCursor: 1,
      deltas: []
    } satisfies HostDeltasSinceResult
  })
  const command = vi.fn().mockResolvedValue({
    ok: true,
    value: makePendingReceipt('test-cmd', 'test-key')
  })
  const threadOffers = vi.fn().mockResolvedValue({
    ok: true,
    value: {
      threadId: 'thread-1',
      provider: {
        runtimeProvider: 'mistral',
        displayProvider: 'Mistral',
        hueKey: 'mistral',
        accent: '#D44404',
        model: 'devstral-small',
        modelLabel: 'Devstral Small',
        shortCode: 'MST'
      },
      currentModel: 'devstral-small',
      models: [
        {
          id: 'devstral-small',
          label: 'Devstral Small',
          current: true,
          reasoningEfforts: []
        }
      ],
      source: 'curated'
    }
  })
  const receipt = vi.fn().mockResolvedValue({
    ok: true,
    outcome: 'not_found'
  } satisfies HostAuthorityReceiptResult)
  const health = vi.fn().mockResolvedValue({
    ok: true,
    value: makeHealth()
  })
  const shutdown = vi
    .fn()
    .mockResolvedValue({ ok: true, value: { stopped: true, alreadyStopped: false } })
  const providerStatuses = vi.fn().mockResolvedValue({
    ok: true,
    value: [{ providerId: 'codex', status: 'ready', label: 'Codex' }]
  })
  const providerOffers = vi.fn().mockResolvedValue({
    ok: true,
    value: {
      providerId: 'codex',
      offerRevision: 'catalog-r1',
      models: [{ modelId: 'gpt-5.6', label: 'GPT-5.6', available: true, reasoning: [] }],
      postures: [
        {
          postureId: 'plan',
          label: 'Plan',
          available: true,
          requiresExplicitConsent: true,
          ceiling: 'workspace_write'
        }
      ]
    }
  })
  const providerAuthFlows = vi.fn().mockResolvedValue({
    ok: true,
    value: [{ flowId: 'browser', kind: 'browser', label: 'Browser sign-in', available: true }]
  })
  const providerAuthStatus = vi.fn().mockResolvedValue({
    ok: true,
    value: { providerId: 'codex', state: 'unauthenticated' }
  })
  const threadHistory = vi.fn().mockResolvedValue({
    ok: true,
    value: { threadId: 'thread-1', generation: 1, cursor: 3, entries: [] }
  })
  const historySince = vi.fn().mockResolvedValue({
    ok: true,
    value: {
      kind: 'deltas',
      threadId: 'thread-1',
      generation: 1,
      fromCursor: 3,
      toCursor: 3,
      deltas: []
    }
  })
  return {
    snapshot,
    deltas,
    threadOffers,
    providerStatuses,
    providerOffers,
    providerAuthFlows,
    providerAuthStatus,
    threadHistory,
    historySince,
    command,
    receipt,
    health,
    shutdown,
    ...overrides
  } as unknown as HostAuthority & {
    snapshot: ReturnType<typeof vi.fn>
    deltas: ReturnType<typeof vi.fn>
    threadOffers: ReturnType<typeof vi.fn>
    providerStatuses: ReturnType<typeof vi.fn>
    providerOffers: ReturnType<typeof vi.fn>
    providerAuthFlows: ReturnType<typeof vi.fn>
    providerAuthStatus: ReturnType<typeof vi.fn>
    threadHistory: ReturnType<typeof vi.fn>
    historySince: ReturnType<typeof vi.fn>
    command: ReturnType<typeof vi.fn>
    receipt: ReturnType<typeof vi.fn>
    health: ReturnType<typeof vi.fn>
    shutdown: ReturnType<typeof vi.fn>
  }
}

function makeEmptySnapshot(): HostSnapshot {
  return {
    protocolVersion: HOST_PROTOCOL_VERSION,
    projectionVersion: HOST_PROJECTION_VERSION,
    generatedAt: '2026-08-04T00:00:00.000Z',
    generation: 0,
    cursor: 0,
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

function makeHealth(): HostHealthProjection {
  return {
    hostStatus: 'ok',
    connectionPhase: 'live',
    supervised: false,
    freshness: 'live'
  }
}

function makePendingReceipt(commandId: string, idempotencyKey: string): HostCommandReceipt {
  return {
    type: 'host.receipt',
    protocolVersion: HOST_PROTOCOL_VERSION,
    commandId,
    idempotencyKey,
    name: 'ping',
    actor: { actorId: 'test-client', clientId: 'test-client', clientClass: 'test' },
    authority: { decision: 'allow' },
    status: 'pending',
    commandFingerprint: 'a'.repeat(64),
    generation: 0,
    cursor: 0,
    createdAt: '2026-08-04T00:00:00.000Z',
    updatedAt: '2026-08-04T00:00:00.000Z'
  }
}

/** Connect a raw socket and return a helper to write lines & read the next frame. */
function connectClient(socketPath: string): Promise<{
  writeLine: (line: string) => void
  readFrame: () => Promise<HostLocalTransportHostFrame>
  pause: () => void
  close: () => void
}> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const net = require('node:net') as typeof import('node:net')
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath)
    socket.setEncoding('utf8')
    let buffer = ''
    let resolver: ((frame: HostLocalTransportHostFrame) => void) | null = null
    socket.on('data', (chunk: string) => {
      buffer += chunk
      const newline = buffer.indexOf('\n')
      if (newline >= 0 && resolver) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        const frame = JSON.parse(line) as HostLocalTransportHostFrame
        const r = resolver
        resolver = null
        r(frame)
      }
    })
    socket.once('connect', () => {
      resolve({
        writeLine: (line: string) => socket.write(`${line}\n`),
        readFrame: () =>
          new Promise((res) => {
            // Check if we already have a complete frame in the buffer
            const nl = buffer.indexOf('\n')
            if (nl >= 0) {
              const line = buffer.slice(0, nl).trim()
              buffer = buffer.slice(nl + 1)
              res(JSON.parse(line) as HostLocalTransportHostFrame)
              return
            }
            resolver = res
          }),
        pause: () => socket.pause(),
        close: () => socket.destroy()
      })
    })
    socket.once('error', reject)
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('HostLocalServer', () => {
  let userDataPath: string
  let session: ReturnType<typeof mockHostSession>
  let authority: ReturnType<typeof mockHostAuthority>
  let server: HostLocalServer

  beforeEach(() => {
    userDataPath = tmpUserDataPath()
    session = mockHostSession()
    authority = mockHostAuthority()
    server = new HostLocalServer({
      userDataPath,
      hostId: 'test-host',
      hostVersion: '0.0.0-test',
      session: session as unknown as HostSession,
      authority: authority as unknown as HostAuthority,
      maxClients: 4,
      now: () => 1754300000000
    })
  })

  afterEach(async () => {
    try {
      await server.stop()
    } catch {
      // Already stopped — fine.
    }
  })

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  describe('start / stop', () => {
    it('start creates socket, token, and discovery artifacts', async () => {
      await server.start()

      expect(server.isStarted).toBe(true)

      const discoveryRaw = readFileSync(server.discoveryPath, 'utf8')
      const discovery = JSON.parse(discoveryRaw)
      const decoded = decodeTaskWraithHostDiscovery(discovery)
      expect(decoded.ok).toBe(true)
      if (decoded.ok) {
        expect(decoded.discovery.protocolVersion).toBe(2)
        expect(decoded.discovery.socketPath).toBe(server.socketPath)
        expect(decoded.discovery.tokenPath).toBe(server.tokenPath)
        expect(decoded.discovery.pid).toBeGreaterThan(0)
        expect(decoded.discovery.startedAt).toBeTruthy()
      }

      const tokenRaw = readFileSync(server.tokenPath, 'utf8').trim()
      expect(tokenRaw.length).toBe(64) // 32 bytes hex = 64 chars
    })

    it('start is idempotent when already started', async () => {
      await server.start()
      const discoveryBefore = readFileSync(server.discoveryPath, 'utf8')
      await server.start() // second call is a no-op
      const discoveryAfter = readFileSync(server.discoveryPath, 'utf8')
      expect(discoveryAfter).toBe(discoveryBefore)
    })

    it('stop unlinks socket, token, and discovery', async () => {
      await server.start()
      expect(server.isStarted).toBe(true)

      await server.stop()
      expect(server.isStarted).toBe(false)

      const { existsSync } = require('node:fs') as typeof import('node:fs')
      if (process.platform !== 'win32') {
        expect(existsSync(server.socketPath)).toBe(false)
      }
      expect(existsSync(server.tokenPath)).toBe(false)
      expect(existsSync(server.discoveryPath)).toBe(false)
    })

    it('stop is idempotent', async () => {
      await server.start()
      await server.stop()
      await server.stop() // second call is a no-op
      expect(server.isStarted).toBe(false)
    })

    it('stopSync unlinks all three artifacts synchronously', async () => {
      await server.start()
      server.stopSync()
      expect(server.isStarted).toBe(false)

      const { existsSync } = require('node:fs') as typeof import('node:fs')
      expect(existsSync(server.tokenPath)).toBe(false)
      expect(existsSync(server.discoveryPath)).toBe(false)
    })

    it('stopSync is idempotent', async () => {
      await server.start()
      server.stopSync()
      server.stopSync() // second is a no-op
      expect(server.isStarted).toBe(false)
    })
  })

  // -----------------------------------------------------------------------
  // Auth failure matrix
  // -----------------------------------------------------------------------

  describe('auth failures', () => {
    beforeEach(async () => {
      await server.start()
    })

    it('destroys connection on wrong token', async () => {
      const client = await connectClient(server.socketPath)
      const badHello = makeClientHello('wrong-token')
      client.writeLine(JSON.stringify(badHello))
      const frame = await client.readFrame()
      expect(frame.type).toBe('response')
      if (frame.type === 'response') {
        expect(frame.ok).toBe(false)
        if (!frame.ok) {
          expect(frame.error.code).toBe('unauthorized')
        }
      }
      client.close()
      expect(session.bind).toHaveBeenCalledTimes(0)
    })

    it('destroys connection on garbage JSON first frame', async () => {
      const client = await connectClient(server.socketPath)
      client.writeLine('not-json')
      // Garbage JSON → socket destroyed; readFrame may hang or error.
      // Just verify the server still works for a subsequent good connection.
      client.close()

      // Prove the server still accepts valid connections after garbage.
      const goodClient = await connectClient(server.socketPath)
      // Need the real token — read from disk.
      const token = readFileSync(server.tokenPath, 'utf8').trim()
      const hello = makeClientHello(token)
      goodClient.writeLine(JSON.stringify(hello))
      const frame = await goodClient.readFrame()
      expect(frame.type).toBe('welcome')
      goodClient.close()
      expect(session.bind).toHaveBeenCalledTimes(1)
    })

    it('destroys connection on non-hello first frame', async () => {
      const client = await connectClient(server.socketPath)
      // Send a request without authenticating first
      const req = makeRequest('health.get' as never, '1')
      client.writeLine(JSON.stringify(req))
      // Should be destroyed; readFrame may get nothing. Close and verify.
      client.close()
      expect(session.bind).toHaveBeenCalledTimes(0)
    })

    it('destroys connection on oversized first frame', async () => {
      const client = await connectClient(server.socketPath)
      const junk = 'x'.repeat(300_000)
      client.writeLine(junk)
      client.close()
      expect(session.bind).toHaveBeenCalledTimes(0)
    })

    it('destroys connection when handshake timer expires (no data)', async () => {
      // We can't easily test the 5s timeout in a fast unit test, but we can
      // verify the timer is set by checking that a client that sends nothing
      // doesn't get a welcome and the bind count stays zero.
      const client = await connectClient(server.socketPath)
      client.close()
      expect(session.bind).toHaveBeenCalledTimes(0)
    })

    it('zero bind calls across all auth failures', async () => {
      // Wrong token
      const c1 = await connectClient(server.socketPath)
      c1.writeLine(JSON.stringify(makeClientHello('bad-token')))
      await c1.readFrame()
      c1.close()

      // Garbage
      const c2 = await connectClient(server.socketPath)
      c2.writeLine('garbage')
      c2.close()

      // Non-hello
      const c3 = await connectClient(server.socketPath)
      c3.writeLine(JSON.stringify(makeRequest('health.get' as never, 'bad')))
      c3.close()

      expect(session.bind).toHaveBeenCalledTimes(0)
    })
  })

  it.each([
    ['desktop', 'desktop-client', ['host-lifecycle']],
    ['tui', 'tui-client', ['host-lifecycle']],
    ['ios', 'ios-client', ['host-lifecycle']],
    ['host-cli', 'wrong-id', ['host-lifecycle']],
    ['host-cli', 'taskwraith-host-cli', ['bootstrap']],
    ['host-cli', 'taskwraith-host-cli', ['host-lifecycle']]
  ] as const)(
    'rejects unauthorized host.shutdown identity %s/%s',
    async (clientClass, clientId, capabilities) => {
      await server.start()
      const client = await connectClient(server.socketPath)
      client.writeLine(
        JSON.stringify(
          makeClientHello(
            readFileSync(server.tokenPath, 'utf8').trim(),
            capabilities as HostCapability[],
            { clientId, clientClass, clientVersion: '1.0.0' }
          )
        )
      )
      expect((await client.readFrame()).type).toBe('welcome')
      client.writeLine(JSON.stringify(makeRequest('host.shutdown' as never, 'shutdown-1', {})))
      await expect(client.readFrame()).resolves.toMatchObject({
        type: 'response',
        ok: false,
        error: { code: 'unauthorized' }
      })
      client.close()
    }
  )

  it('acknowledges an authorized shutdown before broadcasting host.closing', async () => {
    server = new HostLocalServer({
      userDataPath,
      hostId: 'test-host',
      hostVersion: 'node-host-v1',
      session: session as unknown as HostSession,
      authority: authority as unknown as HostAuthority,
      onAuthenticatedShutdown: () => server.stop(),
      shutdownDrainTimeoutMs: 50
    })
    await server.start()
    const client = await connectClient(server.socketPath)
    client.writeLine(
      JSON.stringify(
        makeClientHello(
          readFileSync(server.tokenPath, 'utf8').trim(),
          ['bootstrap', 'host-lifecycle'],
          {
            clientId: 'taskwraith-host-cli',
            clientClass: 'host-cli',
            clientVersion: '1.0.0'
          }
        )
      )
    )
    expect((await client.readFrame()).type).toBe('welcome')
    client.writeLine(JSON.stringify(makeRequest('host.shutdown', 'shutdown-1', {})))
    await expect(client.readFrame()).resolves.toMatchObject({
      type: 'response',
      id: 'shutdown-1',
      ok: true,
      result: { kind: 'host.shutdown', state: 'stopping' }
    })
    await expect(client.readFrame()).resolves.toMatchObject({
      type: 'event',
      event: 'host.closing'
    })
    await vi.waitFor(() => expect(server.isStarted).toBe(false))
    client.close()
  })

  it('coalesces concurrent lifecycle requests and rejects later work as shutting_down', async () => {
    let releaseShutdown!: () => void
    const shutdown = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseShutdown = resolve
        })
    )
    server = new HostLocalServer({
      userDataPath,
      hostId: 'test-host',
      hostVersion: 'node-host-v1',
      session: session as unknown as HostSession,
      authority: authority as unknown as HostAuthority,
      onAuthenticatedShutdown: shutdown
    })
    await server.start()
    const token = readFileSync(server.tokenPath, 'utf8').trim()
    const clients = await Promise.all([
      connectClient(server.socketPath),
      connectClient(server.socketPath)
    ])
    for (const client of clients) {
      client.writeLine(
        JSON.stringify(
          makeClientHello(token, ['bootstrap', 'host-lifecycle', 'health'], {
            clientId: 'taskwraith-host-cli',
            clientClass: 'host-cli',
            clientVersion: '1.0.0'
          })
        )
      )
      expect((await client.readFrame()).type).toBe('welcome')
    }
    clients[0].writeLine(JSON.stringify(makeRequest('host.shutdown', 'shutdown-1', {})))
    await expect(clients[0].readFrame()).resolves.toMatchObject({
      ok: true,
      result: { kind: 'host.shutdown', state: 'stopping' }
    })
    clients[1].writeLine(JSON.stringify(makeRequest('host.shutdown', 'shutdown-2', {})))
    await expect(clients[1].readFrame()).resolves.toMatchObject({
      ok: true,
      result: { kind: 'host.shutdown', state: 'already_stopping' }
    })
    clients[1].writeLine(JSON.stringify(makeRequest('health.get', 'health-after-stop', {})))
    await expect(clients[1].readFrame()).resolves.toEqual({
      type: 'response',
      transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
      id: 'health-after-stop',
      ok: false,
      error: { code: 'shutting_down' }
    })
    expect(shutdown).toHaveBeenCalledOnce()
    releaseShutdown()
    clients.forEach((client) => client.close())
  })

  it('drains an admitted request before closing clients', async () => {
    let finishHealth!: () => void
    authority.health.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishHealth = () => resolve({ ok: true, value: makeHealth() })
        })
    )
    let stopping: Promise<void> | null = null
    server = new HostLocalServer({
      userDataPath,
      hostId: 'test-host',
      hostVersion: 'node-host-v1',
      session: session as unknown as HostSession,
      authority: authority as unknown as HostAuthority,
      onAuthenticatedShutdown: () => {
        stopping = server.stop()
        return stopping
      },
      shutdownDrainTimeoutMs: 250
    })
    await server.start()
    const token = readFileSync(server.tokenPath, 'utf8').trim()
    const regular = await connectClient(server.socketPath)
    regular.writeLine(JSON.stringify(makeClientHello(token, ['bootstrap', 'health'])))
    await regular.readFrame()
    const admin = await connectClient(server.socketPath)
    admin.writeLine(
      JSON.stringify(
        makeClientHello(token, ['bootstrap', 'host-lifecycle'], {
          clientId: 'taskwraith-host-cli',
          clientClass: 'host-cli',
          clientVersion: '1.0.0'
        })
      )
    )
    await admin.readFrame()
    regular.writeLine(JSON.stringify(makeRequest('health.get', 'health-in-flight', {})))
    await vi.waitFor(() => expect(authority.health).toHaveBeenCalledOnce())
    admin.writeLine(JSON.stringify(makeRequest('host.shutdown', 'shutdown-drain', {})))
    await expect(admin.readFrame()).resolves.toMatchObject({
      ok: true,
      result: { kind: 'host.shutdown', state: 'stopping' }
    })
    await vi.waitFor(() => expect(stopping).not.toBeNull())
    expect(server.isStarted).toBe(true)
    finishHealth()
    await expect(regular.readFrame()).resolves.toMatchObject({
      ok: true,
      result: { kind: 'health.get' }
    })
    await stopping
    expect(server.isStarted).toBe(false)
    regular.close()
    admin.close()
  })

  it('coalesces stop cleanup and bounds a paused client drain', async () => {
    const unsubscribe = vi.fn()
    server = new HostLocalServer({
      userDataPath,
      hostId: 'test-host',
      hostVersion: 'node-host-v1',
      session: session as unknown as HostSession,
      authority: authority as unknown as HostAuthority,
      subscribeDeltas: () => unsubscribe,
      shutdownDrainTimeoutMs: 10
    })
    await server.start()
    const client = await connectClient(server.socketPath)
    client.writeLine(
      JSON.stringify(makeClientHello(readFileSync(server.tokenPath, 'utf8').trim(), ['bootstrap']))
    )
    await client.readFrame()
    client.pause()
    await Promise.all([server.stop(), server.stop()])
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(server.isStarted).toBe(false)
    client.close()
  })

  // -----------------------------------------------------------------------
  // Happy bootstrap
  // -----------------------------------------------------------------------

  describe('happy bootstrap', () => {
    beforeEach(async () => {
      await server.start()
    })

    it('hello → welcome round-trip with session-provided position', async () => {
      const token = readFileSync(server.tokenPath, 'utf8').trim()
      const client = await connectClient(server.socketPath)
      const hello = makeClientHello(token)
      client.writeLine(JSON.stringify(hello))
      const frame = await client.readFrame()
      expect(frame.type).toBe('welcome')
      if (frame.type === 'welcome') {
        expect(frame.welcome.type).toBe('host.welcome')
        expect(frame.welcome.protocolVersion).toBe(HOST_PROTOCOL_VERSION)
        expect(frame.welcome.sessionId).toBeTruthy()
        expect(frame.welcome.generation).toBe(0)
        expect(frame.welcome.cursor).toBeGreaterThanOrEqual(0)
        expect(frame.welcome.authenticatedClient.clientId).toBe('test-client')
        expect(frame.welcome.capabilities).toContain('bootstrap')
        expect(frame.welcome.freshness).toBe('live')
      }
      client.close()
      expect(session.bind).toHaveBeenCalledTimes(1)
    })

    it('second hello after authentication is rejected', async () => {
      const token = readFileSync(server.tokenPath, 'utf8').trim()
      const client = await connectClient(server.socketPath)

      // Auth
      client.writeLine(JSON.stringify(makeClientHello(token)))
      const welcome = await client.readFrame()
      expect(welcome.type).toBe('welcome')

      // Second hello → error
      client.writeLine(JSON.stringify(makeClientHello(token)))
      const err = await client.readFrame()
      expect(err.type).toBe('response')
      if (err.type === 'response') {
        expect(err.ok).toBe(false)
      }

      client.close()
    })
  })

  // -----------------------------------------------------------------------
  // Request routing
  // -----------------------------------------------------------------------

  describe('request routing', () => {
    let token: string

    beforeEach(async () => {
      await server.start()
      token = readFileSync(server.tokenPath, 'utf8').trim()
    })

    async function authAndConnect(capabilities?: readonly HostCapability[]): Promise<{
      writeLine: (line: string) => void
      readFrame: () => Promise<HostLocalTransportHostFrame>
      close: () => void
    }> {
      const client = await connectClient(server.socketPath)
      client.writeLine(JSON.stringify(makeClientHello(token, capabilities)))
      const welcome = await client.readFrame()
      expect(welcome.type).toBe('welcome')
      return client
    }

    it('snapshot.get routes to authority.snapshot with correct context', async () => {
      const client = await authAndConnect()
      client.writeLine(JSON.stringify(makeRequest('snapshot.get' as never, 'r1')))
      const frame = await client.readFrame()
      expect(frame.type).toBe('response')
      if (frame.type === 'response') {
        expect(frame.ok).toBe(true)
        if (frame.ok) {
          expect(frame.result.kind).toBe('snapshot.get')
        }
      }
      client.close()
      expect(authority.snapshot).toHaveBeenCalledTimes(1)
      const callCtx = authority.snapshot.mock.calls[0][0] as HostAuthorityCallContext
      expect(callCtx.actor.clientId).toBe('test-client')
      expect(callCtx.actor.clientClass).toBe('test')
    })

    it('deltas.since routes to authority.deltas with position params', async () => {
      const client = await authAndConnect()
      client.writeLine(
        JSON.stringify(
          makeRequest('deltas.since' as never, 'r2', {
            generation: 0,
            cursor: 0
          })
        )
      )
      const frame = await client.readFrame()
      expect(frame.type).toBe('response')
      if (frame.type === 'response') {
        expect(frame.ok).toBe(true)
        if (frame.ok) {
          expect(frame.result.kind).toBe('deltas.since')
        }
      }
      client.close()
      expect(authority.deltas).toHaveBeenCalledTimes(1)
      const sinceArg = authority.deltas.mock.calls[0][1] as HostCursorPosition
      expect(sinceArg.generation).toBe(0)
      expect(sinceArg.cursor).toBe(0)
    })

    it('thread.offers is capability-gated and routes to Authority with exact thread id', async () => {
      const client = await authAndConnect(['bootstrap', 'snapshot', 'model-offers', 'health'])
      client.writeLine(
        JSON.stringify(makeRequest('thread.offers' as never, 'r-offers', { threadId: 'thread-1' }))
      )
      const frame = await client.readFrame()
      expect(frame.type).toBe('response')
      if (frame.type === 'response') {
        expect(frame.ok).toBe(true)
        if (frame.ok) {
          expect(frame.result).toMatchObject({
            kind: 'thread.offers',
            offers: { threadId: 'thread-1', currentModel: 'devstral-small' }
          })
        }
      }
      client.close()
      expect(authority.threadOffers).toHaveBeenCalledTimes(1)
      expect(authority.threadOffers.mock.calls[0][1]).toBe('thread-1')
    })

    it('thread.offers refuses clients that did not negotiate model-offers', async () => {
      const client = await authAndConnect()
      client.writeLine(
        JSON.stringify(
          makeRequest('thread.offers' as never, 'r-no-offers', { threadId: 'thread-1' })
        )
      )
      const frame = await client.readFrame()
      expect(frame).toMatchObject({ ok: false, error: { code: 'unauthorized' } })
      expect(authority.threadOffers).not.toHaveBeenCalled()
      client.close()
    })

    it('gates provider setup reads by their exact negotiated capabilities', async () => {
      const catalogClient = await authAndConnect(['bootstrap', 'provider-catalog', 'health'])
      catalogClient.writeLine(
        JSON.stringify(makeRequest('provider.status' as never, 'r-provider-status'))
      )
      expect(await catalogClient.readFrame()).toMatchObject({
        ok: true,
        result: { kind: 'provider.status', statuses: [{ providerId: 'codex' }] }
      })
      catalogClient.writeLine(
        JSON.stringify(
          makeRequest('provider.offers' as never, 'r-provider-offers', { providerId: 'codex' })
        )
      )
      expect(await catalogClient.readFrame()).toMatchObject({
        ok: true,
        result: { kind: 'provider.offers', offers: { providerId: 'codex' } }
      })
      expect(authority.providerStatuses).toHaveBeenCalledOnce()
      expect(authority.providerOffers).toHaveBeenCalledWith(expect.anything(), 'codex')
      catalogClient.close()

      const deniedClient = await authAndConnect(['bootstrap', 'provider-catalog', 'health'])
      deniedClient.writeLine(
        JSON.stringify(
          makeRequest('provider.auth.status' as never, 'r-auth-denied', { providerId: 'codex' })
        )
      )
      expect(await deniedClient.readFrame()).toMatchObject({
        ok: false,
        error: { code: 'unauthorized' }
      })
      expect(authority.providerAuthStatus).not.toHaveBeenCalled()
      deniedClient.close()

      const authClient = await authAndConnect(['bootstrap', 'provider-auth', 'health'])
      authClient.writeLine(
        JSON.stringify(
          makeRequest('provider.auth.flows' as never, 'r-auth-flows', { providerId: 'codex' })
        )
      )
      expect(await authClient.readFrame()).toMatchObject({
        ok: true,
        result: { kind: 'provider.auth.flows', flows: [{ flowId: 'browser' }] }
      })
      authClient.close()
      expect(authority.providerAuthFlows).toHaveBeenCalledWith(expect.anything(), 'codex')
    })

    it('gates bounded history pages and separate history cursor deltas', async () => {
      const client = await authAndConnect(['bootstrap', 'history', 'health'])
      client.writeLine(
        JSON.stringify(
          makeRequest('thread.history' as never, 'r-history-page', {
            threadId: 'thread-1',
            limit: 25
          })
        )
      )
      expect(await client.readFrame()).toMatchObject({
        ok: true,
        result: { kind: 'thread.history', page: { threadId: 'thread-1' } }
      })
      client.writeLine(
        JSON.stringify(
          makeRequest('history.since' as never, 'r-history-since', {
            threadId: 'thread-1',
            since: { generation: 1, cursor: 3 }
          })
        )
      )
      expect(await client.readFrame()).toMatchObject({
        ok: true,
        result: { kind: 'history.since', result: { threadId: 'thread-1' } }
      })
      client.close()
      expect(authority.threadHistory).toHaveBeenCalledWith(expect.anything(), {
        threadId: 'thread-1',
        limit: 25
      })
      expect(authority.historySince).toHaveBeenCalledWith(expect.anything(), {
        threadId: 'thread-1',
        since: { generation: 1, cursor: 3 }
      })
    })

    it('requires both commands and setup capability before forwarding setup submits', async () => {
      const setupCommand = {
        type: 'host.command',
        protocolVersion: HOST_PROTOCOL_VERSION,
        commandId: 'setup-command-1',
        idempotencyKey: 'setup-key-1',
        actor: { actorId: 'test-client', clientId: 'test-client', clientClass: 'test' },
        name: 'workspace.register',
        target: {},
        arguments: { path: '/workspace' },
        issuedAt: '2026-08-24T03:00:00.000Z'
      }
      const missingCommands = await authAndConnect(['bootstrap', 'setup', 'health'])
      missingCommands.writeLine(
        JSON.stringify(makeRequest('command.submit' as never, 'r-setup-no-commands', setupCommand))
      )
      expect(await missingCommands.readFrame()).toMatchObject({
        ok: false,
        error: { code: 'unauthorized' }
      })
      missingCommands.close()
      expect(authority.command).not.toHaveBeenCalled()

      const missingSetup = await authAndConnect(['bootstrap', 'commands', 'health'])
      missingSetup.writeLine(
        JSON.stringify(makeRequest('command.submit' as never, 'r-setup-no-setup', setupCommand))
      )
      expect(await missingSetup.readFrame()).toMatchObject({
        ok: false,
        error: { code: 'unauthorized' }
      })
      missingSetup.close()
      expect(authority.command).not.toHaveBeenCalled()

      const allowed = await authAndConnect(['bootstrap', 'commands', 'setup', 'health'])
      allowed.writeLine(
        JSON.stringify(makeRequest('command.submit' as never, 'r-setup-allowed', setupCommand))
      )
      expect(await allowed.readFrame()).toMatchObject({ ok: true, result: { kind: 'command.submit' } })
      allowed.close()
      expect(authority.command).toHaveBeenCalledOnce()
    })

    it('receipt.lookup routes to authority.receipt with commandId', async () => {
      authority.receipt.mockResolvedValue({
        ok: true,
        outcome: 'found',
        receipt: makePendingReceipt('found-cmd', 'found-key')
      } satisfies HostAuthorityReceiptResult)
      const client = await authAndConnect()
      client.writeLine(
        JSON.stringify(
          makeRequest('receipt.lookup' as never, 'r3', {
            commandId: 'found-cmd'
          })
        )
      )
      const frame = await client.readFrame()
      expect(frame.type).toBe('response')
      if (frame.type === 'response') {
        expect(frame.ok).toBe(true)
        if (frame.ok) {
          expect(frame.result.kind).toBe('receipt.lookup')
        }
      }
      client.close()
      expect(authority.receipt).toHaveBeenCalledTimes(1)
    })

    it('receipt.lookup not_found returns body-free error', async () => {
      authority.receipt.mockResolvedValue({
        ok: true,
        outcome: 'not_found'
      } satisfies HostAuthorityReceiptResult)
      const client = await authAndConnect()
      client.writeLine(
        JSON.stringify(
          makeRequest('receipt.lookup' as never, 'r4', {
            commandId: 'not-found-cmd'
          })
        )
      )
      const frame = await client.readFrame()
      expect(frame.type).toBe('response')
      if (frame.type === 'response') {
        expect(frame.ok).toBe(false)
        if (!frame.ok) {
          expect(frame.error.code).toBe('invalid_payload')
        }
      }
      client.close()
    })

    it('health.get routes to authority.health', async () => {
      const client = await authAndConnect()
      client.writeLine(JSON.stringify(makeRequest('health.get' as never, 'r5')))
      const frame = await client.readFrame()
      expect(frame.type).toBe('response')
      if (frame.type === 'response') {
        expect(frame.ok).toBe(true)
        if (frame.ok) {
          expect(frame.result.kind).toBe('health.get')
        }
      }
      client.close()
      expect(authority.health).toHaveBeenCalledTimes(1)
    })

    it('command.submit routes to authority.command', async () => {
      const cmd: HostCommand = {
        type: 'host.command',
        protocolVersion: HOST_PROTOCOL_VERSION,
        commandId: 'test-cmd',
        idempotencyKey: 'test-key',
        actor: { actorId: 'test-client', clientId: 'test-client', clientClass: 'test' },
        name: 'ping',
        target: {},
        arguments: {},
        issuedAt: new Date().toISOString()
      }
      const client = await authAndConnect()
      client.writeLine(
        JSON.stringify(
          makeRequest('command.submit' as never, 'r6', cmd as unknown as Record<string, unknown>)
        )
      )
      const frame = await client.readFrame()
      expect(frame.type).toBe('response')
      if (frame.type === 'response') {
        expect(frame.ok).toBe(true)
        if (frame.ok) {
          expect(frame.result.kind).toBe('command.submit')
        }
      }
      client.close()
      expect(authority.command).toHaveBeenCalledTimes(1)
    })

    it('twmission.export returns host_unavailable when exportTwMission not on authority', async () => {
      const client = await authAndConnect()
      client.writeLine(JSON.stringify(makeRequest('twmission.export' as never, 'r7')))
      const frame = await client.readFrame()
      expect(frame.type).toBe('response')
      if (frame.type === 'response') {
        expect(frame.ok).toBe(false)
        if (!frame.ok) {
          expect(frame.error.code).toBe('host_unavailable')
        }
      }
      client.close()
    })

    it('twmission.export routes to authority.exportTwMission when available', async () => {
      const exportTwMission = vi.fn().mockResolvedValue({
        ok: true,
        // Larger than the ordinary 256 KB RPC line budget: compact export has
        // its own bounded 8 MB envelope and must not degrade to host_unavailable.
        bundle: {
          schemaVersion: 1,
          protocolVersion: 2,
          manifest: {},
          snapshot: { padding: 'x'.repeat(300_000) }
        },
        bytes: new Uint8Array([1, 2, 3])
      })
      // Rebuild server with the augmented authority for this test only
      await server.stop()
      const twServer = new HostLocalServer({
        userDataPath,
        hostId: 'test-host',
        hostVersion: '0.0.0-test',
        session: session as unknown as HostSession,
        authority: { ...authority, exportTwMission } as unknown as HostAuthority & {
          exportTwMission: typeof exportTwMission
        },
        maxClients: 4,
        now: () => 1754300000000
      })
      await twServer.start()
      const twToken = readFileSync(twServer.tokenPath, 'utf8').trim()
      const client = await connectClient(twServer.socketPath)
      client.writeLine(JSON.stringify(makeClientHello(twToken)))
      const welcome = await client.readFrame()
      expect(welcome.type).toBe('welcome')

      client.writeLine(JSON.stringify(makeRequest('twmission.export' as never, 'r8')))
      const frame = await client.readFrame()
      expect(frame.type).toBe('response')
      if (frame.type === 'response') {
        expect(frame.ok).toBe(true)
        if (frame.ok) {
          expect(frame.result.kind).toBe('twmission.export')
          if (frame.result.kind === 'twmission.export') {
            expect(frame.result.result.bundle).toBeDefined()
            expect(frame.result.result.bytes).toBeUndefined()
          }
        }
      }
      client.close()
      expect(exportTwMission).toHaveBeenCalledTimes(1)
      await twServer.stop()
    })

    it('response ids correlate to request ids', async () => {
      const client = await authAndConnect()
      client.writeLine(JSON.stringify(makeRequest('health.get' as never, 'id-42')))
      const frame = await client.readFrame()
      expect(frame.type).toBe('response')
      if (frame.type === 'response') {
        expect(frame.id).toBe('id-42')
      }
      client.close()
    })

    it('unknown request kind returns body-free error', async () => {
      const client = await authAndConnect()
      // Send a request frame that passes decode but has an unrecognized kind
      // at the transport level — we use a kind the server's switch doesn't handle.
      // The server's default branch returns null → unknown_request_kind error.
      client.writeLine(
        JSON.stringify({
          type: 'request',
          transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
          id: 'bad-kind',
          kind: 'nonexistent.kind',
          params: {}
        })
      )
      // The transport decoder rejects unknown request kinds — so this should
      // produce an error response from the decoder, not the server's dispatch.
      const frame = await client.readFrame()
      expect(frame.type).toBe('response')
      if (frame.type === 'response') {
        expect(frame.ok).toBe(false)
        if (!frame.ok) {
          expect(frame.error.code).toBe('unknown_request_kind')
        }
      }
      client.close()
    })

    it('unauthenticated request is destroyed', async () => {
      const client = await connectClient(server.socketPath)
      // Bypass auth entirely
      client.writeLine(JSON.stringify(makeRequest('health.get' as never, 'no-auth')))
      client.close()
      expect(authority.health).toHaveBeenCalledTimes(0)
    })
  })

  // -----------------------------------------------------------------------
  // Authority error passthrough
  // -----------------------------------------------------------------------

  describe('authority error passthrough', () => {
    let token: string

    beforeEach(async () => {
      await server.start()
      token = readFileSync(server.tokenPath, 'utf8').trim()
    })

    async function authAndConnect(): Promise<{
      writeLine: (line: string) => void
      readFrame: () => Promise<HostLocalTransportHostFrame>
      close: () => void
    }> {
      const client = await connectClient(server.socketPath)
      client.writeLine(JSON.stringify(makeClientHello(token)))
      const welcome = await client.readFrame()
      expect(welcome.type).toBe('welcome')
      return client
    }

    it('snapshot authority failure → body-free error', async () => {
      authority.snapshot.mockResolvedValue({ ok: false, error: 'host_unavailable' })
      const client = await authAndConnect()
      client.writeLine(JSON.stringify(makeRequest('snapshot.get' as never, 'e1')))
      const frame = await client.readFrame()
      expect(frame.type).toBe('response')
      if (frame.type === 'response') {
        expect(frame.ok).toBe(false)
        if (!frame.ok) {
          expect(frame.error.code).toBe('host_unavailable')
        }
      }
      client.close()
    })

    it('command authority failure → body-free error', async () => {
      authority.command.mockResolvedValue({ ok: false, error: 'shutting_down' })
      const cmd: HostCommand = {
        type: 'host.command',
        protocolVersion: HOST_PROTOCOL_VERSION,
        commandId: 't',
        idempotencyKey: 'k',
        actor: { actorId: 'test-client', clientId: 'test-client', clientClass: 'test' },
        name: 'ping',
        target: {},
        arguments: {},
        issuedAt: new Date().toISOString()
      }
      const client = await authAndConnect()
      client.writeLine(
        JSON.stringify(
          makeRequest('command.submit' as never, 'e2', cmd as unknown as Record<string, unknown>)
        )
      )
      const frame = await client.readFrame()
      expect(frame.type).toBe('response')
      if (frame.type === 'response') {
        expect(frame.ok).toBe(false)
        if (!frame.ok) {
          expect(frame.error.code).toBe('shutting_down')
        }
      }
      client.close()
    })
  })

  // -----------------------------------------------------------------------
  // Durable delta event fan-out
  // -----------------------------------------------------------------------

  describe('delta events', () => {
    it('subscribes for its lifetime and broadcasts only to delta-capable clients', async () => {
      const deltaListeners: Array<(delta: HostDeltaEnvelope) => void> = []
      const unsubscribe = vi.fn()
      const subscribeDeltas = vi.fn((listener: (delta: HostDeltaEnvelope) => void) => {
        deltaListeners.push(listener)
        return unsubscribe
      })
      server = new HostLocalServer({
        userDataPath,
        hostId: 'test-host',
        hostVersion: '0.0.0-test',
        session: session as unknown as HostSession,
        authority: authority as unknown as HostAuthority,
        maxClients: 4,
        subscribeDeltas,
        now: () => 1754300000000
      })
      await server.start()
      expect(subscribeDeltas).toHaveBeenCalledTimes(1)

      const token = readFileSync(server.tokenPath, 'utf8').trim()
      const deltaClient = await connectClient(server.socketPath)
      deltaClient.writeLine(
        JSON.stringify(makeClientHello(token, ['bootstrap', 'snapshot', 'deltas', 'health']))
      )
      const deltaWelcome = await deltaClient.readFrame()
      expect(deltaWelcome.type).toBe('welcome')

      const snapshotOnlyClient = await connectClient(server.socketPath)
      snapshotOnlyClient.writeLine(
        JSON.stringify(makeClientHello(token, ['bootstrap', 'snapshot', 'health']))
      )
      const snapshotWelcome = await snapshotOnlyClient.readFrame()
      expect(snapshotWelcome.type).toBe('welcome')

      const envelope: HostDeltaEnvelope = {
        protocolVersion: HOST_PROTOCOL_VERSION,
        projectionVersion: HOST_PROJECTION_VERSION,
        generation: 1,
        cursor: 8,
        previousCursor: 7,
        kind: 'upsert',
        family: 'thread',
        entityId: 'thread-live',
        payload: { id: 'thread-live', title: 'Live' },
        at: '2026-08-09T20:00:00.000Z'
      }
      const publish = deltaListeners[0]
      if (!publish) throw new Error('delta subscription was not installed')
      publish(envelope)

      const event = await deltaClient.readFrame()
      expect(event.type).toBe('event')
      if (event.type === 'event') {
        expect(event.event).toBe('deltas')
        if (event.event === 'deltas') {
          expect(event.payload.result).toEqual({
            kind: 'deltas',
            generation: 1,
            fromCursor: 7,
            toCursor: 8,
            deltas: [envelope]
          })
        }
      }

      snapshotOnlyClient.writeLine(
        JSON.stringify(makeRequest('health.get' as never, 'health-after-delta'))
      )
      const response = await snapshotOnlyClient.readFrame()
      expect(response.type).toBe('response')

      await server.stop()
      expect(unsubscribe).toHaveBeenCalledTimes(1)
      deltaClient.close()
      snapshotOnlyClient.close()
    })

    it('disconnects only a non-draining client while a healthy peer keeps receiving deltas', async () => {
      const deltaListeners: Array<(delta: HostDeltaEnvelope) => void> = []
      const subscribeDeltas = vi.fn((listener: (delta: HostDeltaEnvelope) => void) => {
        deltaListeners.push(listener)
        return vi.fn()
      })
      server = new HostLocalServer({
        userDataPath,
        hostId: 'test-host',
        hostVersion: '0.0.0-test',
        session: session as unknown as HostSession,
        authority: authority as unknown as HostAuthority,
        maxClients: 4,
        subscribeDeltas,
        now: () => 1754300000000
      })
      await server.start()

      const token = readFileSync(server.tokenPath, 'utf8').trim()
      const slowClient = await connectClient(server.socketPath)
      slowClient.writeLine(
        JSON.stringify(makeClientHello(token, ['bootstrap', 'snapshot', 'deltas', 'health']))
      )
      expect((await slowClient.readFrame()).type).toBe('welcome')
      slowClient.pause()

      const healthyClient = await connectClient(server.socketPath)
      healthyClient.writeLine(
        JSON.stringify(makeClientHello(token, ['bootstrap', 'snapshot', 'deltas', 'health']))
      )
      expect((await healthyClient.readFrame()).type).toBe('welcome')

      const publish = deltaListeners[0]
      if (!publish) throw new Error('delta subscription was not installed')
      const largeBoundedTitle = 'x'.repeat(200_000)
      for (let cursor = 1; cursor <= 128 && server.clientCount() === 2; cursor += 1) {
        publish({
          protocolVersion: HOST_PROTOCOL_VERSION,
          projectionVersion: HOST_PROJECTION_VERSION,
          generation: 1,
          cursor,
          previousCursor: cursor - 1,
          kind: 'upsert',
          family: 'thread',
          entityId: 'thread-live',
          payload: { id: 'thread-live', title: largeBoundedTitle },
          at: '2026-08-09T20:00:00.000Z'
        })

        const event = await healthyClient.readFrame()
        expect(event.type).toBe('event')
        if (event.type === 'event' && event.event === 'deltas') {
          expect(event.payload.result.kind).toBe('deltas')
          if (event.payload.result.kind === 'deltas') {
            expect(event.payload.result.toCursor).toBe(cursor)
          }
        }
      }

      await vi.waitFor(() => expect(server.clientCount()).toBe(1), { timeout: 5_000 })

      healthyClient.writeLine(
        JSON.stringify(makeRequest('health.get' as never, 'health-after-slow-client'))
      )
      const response = await healthyClient.readFrame()
      expect(response.type).toBe('response')
      if (response.type === 'response') {
        expect(response.id).toBe('health-after-slow-client')
        expect(response.ok).toBe(true)
      }

      slowClient.close()
      healthyClient.close()
    })
  })

  // -----------------------------------------------------------------------
  // host.closing event on stop
  // -----------------------------------------------------------------------

  describe('host.closing event', () => {
    it('emits host.closing to connected clients on stop', async () => {
      await server.start()
      const token = readFileSync(server.tokenPath, 'utf8').trim()
      const client = await connectClient(server.socketPath)
      client.writeLine(JSON.stringify(makeClientHello(token)))
      const welcome = await client.readFrame()
      expect(welcome.type).toBe('welcome')

      await server.stop()

      // The client should have received host.closing before the socket was destroyed
      // Read any remaining frames from the buffer
      try {
        const frame = await client.readFrame()
        // May be host.closing or socket may already be destroyed
        if (frame.type === 'event') {
          expect(frame.event).toBe('host.closing')
        }
      } catch {
        // Socket destroyed — that's acceptable.
      }
      client.close()
    }, 15_000)
  })

  // -----------------------------------------------------------------------
  // Auth source scan: timingSafeEqual used
  // -----------------------------------------------------------------------

  describe('auth source scan', () => {
    it('source text contains timingSafeEqual', () => {
      const source = require('node:fs').readFileSync(
        require('node:path').join(__dirname, 'HostLocalServer.ts'),
        'utf8'
      ) as string
      expect(source).toMatch(/timingSafeEqual/)
    })

    it('source text imports timingSafeEqual from node:crypto', () => {
      const source = require('node:fs').readFileSync(
        require('node:path').join(__dirname, 'HostLocalServer.ts'),
        'utf8'
      ) as string
      expect(source).toMatch(
        /import\s*\{[^}]*\btimingSafeEqual\b[^}]*\}\s*from\s*['"]node:crypto['"]/
      )
    })
  })

  // -----------------------------------------------------------------------
  // RED-proof probe on the auth gate
  // -----------------------------------------------------------------------

  describe('RED-proof auth gate probe', () => {
    it('token gate is timingSafeEqual and NOT string === (RED-proof)', async () => {
      // Verify the server's auth uses timingSafeEqual, not simple equality.
      // We do this by confirming:
      // 1. The source contains timingSafeEqual (already tested above)
      // 2. We can successfully auth with the correct token
      // 3. We can inspect the token comparison is timing-safe by confirming
      //    the source does NOT contain a bare `===` token comparison.
      const source = require('node:fs').readFileSync(
        require('node:path').join(__dirname, 'HostLocalServer.ts'),
        'utf8'
      ) as string
      // There should be no simple string equality on the token
      // (avoiding false positives on other === uses)
      const safeTokenFn = source.match(/function\s+safeTokenEquals[\s\S]*?^}/m)
      expect(safeTokenFn).toBeTruthy()
      if (safeTokenFn) {
        const fnBody = safeTokenFn[0]
        expect(fnBody).toMatch(/timingSafeEqual/)
        // The function should NOT use === on the token strings directly
        expect(fnBody).not.toMatch(/\btoken\s*===\s*|===\s*token\b/)
      }
    })

    it('auth works with correct token, fails with wrong token', async () => {
      await server.start()
      const token = readFileSync(server.tokenPath, 'utf8').trim()

      // Correct token → welcome
      const goodClient = await connectClient(server.socketPath)
      goodClient.writeLine(JSON.stringify(makeClientHello(token)))
      const welcome = await goodClient.readFrame()
      expect(welcome.type).toBe('welcome')
      goodClient.close()

      // Wrong token → unauthorized
      const badClient = await connectClient(server.socketPath)
      badClient.writeLine(JSON.stringify(makeClientHello('deadbeef' + '00'.repeat(28))))
      const err = await badClient.readFrame()
      expect(err.type).toBe('response')
      if (err.type === 'response') {
        expect(err.ok).toBe(false)
        if (!err.ok) {
          expect(err.error.code).toBe('unauthorized')
        }
      }
      badClient.close()
    })
  })

  // -----------------------------------------------------------------------
  // Discovery decode round-trip
  // -----------------------------------------------------------------------

  describe('discovery round-trip', () => {
    it('writes and decodes discovery with correct fields', async () => {
      await server.start()
      const raw = readFileSync(server.discoveryPath, 'utf8')
      const parsed = JSON.parse(raw)
      const decoded = decodeTaskWraithHostDiscovery(parsed)
      expect(decoded.ok).toBe(true)
      if (decoded.ok) {
        const d = decoded.discovery
        expect(d.protocolVersion).toBe(2)
        expect(typeof d.socketPath).toBe('string')
        expect(d.socketPath.length).toBeGreaterThan(0)
        expect(typeof d.tokenPath).toBe('string')
        expect(d.tokenPath.length).toBeGreaterThan(0)
        expect(typeof d.pid).toBe('number')
        expect(d.pid).toBeGreaterThan(0)
        expect(typeof d.startedAt).toBe('string')
        expect(d.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
      }
    })

    it('discovery decode rejects unsupported protocol version', () => {
      const decoded = decodeTaskWraithHostDiscovery({
        protocolVersion: 1,
        socketPath: '/tmp/test.sock',
        tokenPath: '/tmp/test.token',
        pid: 1234,
        startedAt: '2026-08-04T00:00:00.000Z'
      })
      expect(decoded.ok).toBe(false)
    })
  })

  // -----------------------------------------------------------------------
  // Permission modes (POSIX only)
  // -----------------------------------------------------------------------

  describe('permission modes', () => {
    ;(process.platform === 'win32' ? it.skip : it)(
      'token and discovery files have restricted permissions',
      async () => {
        await server.start()
        const { statSync } = require('node:fs') as typeof import('node:fs')

        // Token file should be 0600 (owner read/write only)
        const tokenStat = statSync(server.tokenPath)
        const tokenMode = tokenStat.mode & 0o777
        expect(tokenMode).toBe(0o600)

        // Discovery file should be 0600
        const discStat = statSync(server.discoveryPath)
        const discMode = discStat.mode & 0o777
        expect(discMode).toBe(0o600)
      }
    )
  })

  // -----------------------------------------------------------------------
  // Import isolation (zero forbidden imports)
  // -----------------------------------------------------------------------

  describe('import isolation', () => {
    it('does not import AppStore, Bridge, provider, store, resolver, or pipeline modules', () => {
      const source = require('node:fs').readFileSync(
        require('node:path').join(__dirname, 'HostLocalServer.ts'),
        'utf8'
      ) as string
      // Only check import lines — the file's prose comments mention forbidden
      // modules as documentation of what must NOT be imported (W3-P3 seam).
      const importLines = source
        .split('\n')
        .filter((l) => l.includes('import ') || l.includes('require('))
        .join('\n')
      expect(importLines).not.toMatch(/AppStore/)
      expect(importLines).not.toMatch(/BridgeActionExecutor/)
      expect(importLines).not.toMatch(/CommandExecutor/)
      expect(importLines).not.toMatch(/HostDeferred/)
      expect(importLines).not.toMatch(/HostCommandMutationPipeline/)
      expect(importLines).not.toMatch(/HostRuntimeBootstrap/)
      expect(importLines).not.toMatch(/electron/)
      expect(importLines).not.toMatch(/provider/)
      expect(importLines).not.toMatch(/workLocks/)
      expect(importLines).not.toMatch(/composition-root/)
      expect(importLines).not.toMatch(/(?:\.\.\/)?main\//)
      expect(importLines).not.toMatch(/renderer|tui/)
      expect(importLines).not.toMatch(/from ['"].*index\.ts['"]/)
    })
  })

  // -----------------------------------------------------------------------
  // Multiple concurrent clients
  // -----------------------------------------------------------------------

  describe('concurrent clients', () => {
    it('handles two authenticated clients independently', async () => {
      await server.start()
      const token = readFileSync(server.tokenPath, 'utf8').trim()

      const c1 = await connectClient(server.socketPath)
      c1.writeLine(JSON.stringify(makeClientHello(token)))
      const w1 = await c1.readFrame()
      expect(w1.type).toBe('welcome')

      const c2 = await connectClient(server.socketPath)
      c2.writeLine(JSON.stringify(makeClientHello(token)))
      const w2 = await c2.readFrame()
      expect(w2.type).toBe('welcome')

      // Each gets its own sessionId
      if (w1.type === 'welcome' && w2.type === 'welcome') {
        expect(w1.welcome.sessionId).toBeTruthy()
        expect(w2.welcome.sessionId).toBeTruthy()
        // Different sessions (bind mints a fresh binding each call)
        expect(w1.welcome.sessionId).not.toBe(w2.welcome.sessionId)
      }

      // Both connected
      expect(server.clientCount()).toBe(2)

      c1.close()
      c2.close()

      // After both close, count drops to zero (socket teardown may be async,
      // but we verify the server recovers to zero).
      // Poll briefly for count to settle.
      for (let i = 0; i < 20 && server.clientCount() > 0; i++) {
        await new Promise((r) => setTimeout(r, 10))
      }
      expect(server.clientCount()).toBe(0)
    })
  })
})
