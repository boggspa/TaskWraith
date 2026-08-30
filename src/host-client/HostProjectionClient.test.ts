import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { buildHostBootstrapWelcome, type HostCapability } from '../shared/hostProtocol'
import { HOST_LOCAL_TRANSPORT_VERSION } from '../shared/hostProtocolTransport'
import { HostProjectionClient } from './HostProjectionClient'

/**
 * A real unix-socket Host. The welcome is minted with the REAL
 * buildHostBootstrapWelcome, so the capability intersection under test is the
 * production one rather than a hand-written fixture — the difference that
 * decides whether requesting 'workspace-git' actually yields an offer.
 */
interface FakeHost {
  readonly discoveryPath: string
  readonly requests: Array<{ kind: string; params: unknown }>
  close(): Promise<void>
}

const cleanups: Array<() => void> = []
const servers: Server[] = []
const openSockets: Socket[] = []

afterEach(async () => {
  // Destroy live connections first: server.close() waits for them, which
  // otherwise hangs the hook until the suite timeout.
  for (const socket of openSockets.splice(0)) socket.destroy()
  while (cleanups.length) cleanups.pop()?.()
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

function startFakeHost(options: {
  hostOffer: readonly HostCapability[]
  respond?: (kind: string, params: unknown) => unknown
}): Promise<FakeHost> {
  // Short socket path: unix domain sockets cap around 104 bytes, and macOS
  // tmpdir() is long enough to overflow it.
  const unique = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  const socketPath = `/tmp/tw-git-${unique}.sock`
  const dir = mkdtempSync(join(tmpdir(), 'tw-git-client-'))
  const tokenPath = join(dir, 'token')
  const discoveryPath = join(dir, 'discovery.json')
  const requests: Array<{ kind: string; params: unknown }> = []

  writeFileSync(tokenPath, 'test-token', { mode: 0o600 })
  writeFileSync(
    discoveryPath,
    JSON.stringify({
      protocolVersion: 2,
      socketPath,
      tokenPath,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      hostId: 'fake-host',
      hostVersion: '1.9.6',
      payloadVersion: `sha256:${'b'.repeat(64)}`
    }),
    { mode: 0o600 }
  )

  cleanups.push(() => {
    rmSync(dir, { recursive: true, force: true })
    rmSync(socketPath, { force: true })
  })

  const server = createServer((socket: Socket) => {
    openSockets.push(socket)
    socket.setEncoding('utf8')
    let buffer = ''
    socket.on('data', (chunk: string) => {
      buffer += chunk
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        index = buffer.indexOf('\n')
        if (!line.trim()) continue
        const frame = JSON.parse(line) as {
          type: string
          id?: string
          kind?: string
          params?: unknown
          // Capabilities ride the NESTED hello envelope, not the transport frame.
          hello?: { capabilities?: readonly HostCapability[] }
        }
        if (frame.type === 'hello') {
          const welcome = buildHostBootstrapWelcome({
            hostId: 'fake-host',
            hostVersion: '1.9.6',
            sessionId: 'session-1',
            generation: 1,
            cursor: 1,
            authenticatedClient: {
              clientId: 'tui-test',
              clientClass: 'tui',
              clientVersion: '1.9.6'
            },
            hostCapabilityOffer: options.hostOffer,
            clientCapabilityRequest: frame.hello?.capabilities ?? [],
            freshness: 'live'
          })
          if (!welcome.ok) throw new Error(`fake host welcome invalid: ${welcome.error}`)
          socket.write(
            `${JSON.stringify({
              type: 'welcome',
              transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
              welcome: welcome.value
            })}\n`
          )
          continue
        }
        if (frame.type === 'request' && frame.kind) {
          requests.push({ kind: frame.kind, params: frame.params })
          const result = options.respond?.(frame.kind, frame.params)
          socket.write(
            `${JSON.stringify({
              type: 'response',
              transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
              id: frame.id,
              ok: true,
              result
            })}\n`
          )
        }
      }
    })
    socket.on('error', () => {})
  })
  servers.push(server)

  return new Promise<FakeHost>((resolve) => {
    server.listen(socketPath, () =>
      resolve({
        discoveryPath,
        requests,
        close: () => new Promise<void>((done) => server.close(() => done()))
      })
    )
  })
}

function createClient(discoveryPath: string): HostProjectionClient {
  const client = new HostProjectionClient({
    client: { clientId: 'tui-test', clientClass: 'tui', clientVersion: '1.9.6' },
    discoveryPath,
    connectTimeoutMs: 4_000,
    requestTimeoutMs: 4_000
  })
  cleanups.push(() => client.close())
  return client
}

const FULL_OFFER: readonly HostCapability[] = [
  'bootstrap',
  'snapshot',
  'deltas',
  'commands',
  'receipts',
  'health',
  'workspace-git'
]

const NO_GIT_OFFER: readonly HostCapability[] = [
  'bootstrap',
  'snapshot',
  'deltas',
  'commands',
  'receipts',
  'health'
]

describe('discovery readiness', () => {
  it('waits within the connect budget when a command races atomic discovery publication', async () => {
    const host = await startFakeHost({ hostOffer: FULL_OFFER })
    const discovery = readFileSync(host.discoveryPath, 'utf8')
    rmSync(host.discoveryPath)
    const publish = setTimeout(() => {
      writeFileSync(host.discoveryPath, discovery, { mode: 0o600 })
    }, 40)
    cleanups.push(() => clearTimeout(publish))
    const client = new HostProjectionClient({
      client: { clientId: 'tui-test', clientClass: 'tui', clientVersion: '1.9.6' },
      discoveryPath: host.discoveryPath,
      connectTimeoutMs: 1_000,
      requestTimeoutMs: 1_000
    })
    cleanups.push(() => client.close())

    await expect(client.connect()).resolves.toMatchObject({ hostId: 'fake-host' })
    const published = JSON.parse(discovery) as {
      pid: number
      startedAt: string
      hostId: string
      hostVersion: string
      payloadVersion: string
    }
    expect(client.discoveryProcessIdentity).toEqual({
      pid: published.pid,
      startedAt: published.startedAt,
      hostId: published.hostId,
      hostVersion: published.hostVersion,
      payloadVersion: published.payloadVersion
    })
    client.close()
    expect(client.discoveryProcessIdentity).toBeNull()
  })

  it('returns typed host_unavailable after discovery stays absent for the connect budget', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tw-host-missing-discovery-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const client = new HostProjectionClient({
      client: { clientId: 'tui-test', clientClass: 'tui', clientVersion: '1.9.6' },
      discoveryPath: join(dir, 'missing.json'),
      connectTimeoutMs: 25,
      requestTimeoutMs: 1_000
    })
    cleanups.push(() => client.close())

    await expect(client.connect()).rejects.toMatchObject({
      name: 'HostProjectionTransportError',
      code: 'host_unavailable'
    })
  })

  it('cancels a discovery wait when the client closes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tw-host-cancel-discovery-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const client = new HostProjectionClient({
      client: { clientId: 'tui-test', clientClass: 'tui', clientVersion: '1.9.6' },
      discoveryPath: join(dir, 'missing.json'),
      connectTimeoutMs: 1_000,
      requestTimeoutMs: 1_000
    })
    const pending = client.connect()
    setTimeout(() => client.close(), 10)

    await expect(pending).rejects.toThrow(/client closed/)
  })
})

describe('getWorkspaceGitRead capability negotiation', () => {
  it('requests workspace-git and reads when the Host offers it', async () => {
    const host = await startFakeHost({
      hostOffer: FULL_OFFER,
      respond: () => ({
        kind: 'workspace.git.read',
        result: {
          scope: 'status',
          branch: 'main',
          head: '0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          truncated: false,
          files: [
            {
              path: 'a.ts',
              index: 'M',
              workingTree: ' ',
              kind: 'modified',
              staged: true,
              unstaged: false
            }
          ]
        }
      })
    })
    const client = createClient(host.discoveryPath)
    const welcome = await client.connect()

    // The REAL intersection put it in the welcome, which is what makes the
    // default capability request meaningful rather than decorative.
    expect(welcome.capabilities).toContain('workspace-git')

    const outcome = await client.getWorkspaceGitRead({ workspaceId: 'ws-1', scope: 'status' })

    expect(outcome.available).toBe(true)
    if (!outcome.available) throw new Error('expected an available outcome')
    expect(outcome.result.scope).toBe('status')
    expect(outcome.result.branch).toBe('main')
    expect(host.requests).toEqual([
      { kind: 'workspace.git.read', params: { workspaceId: 'ws-1', scope: 'status' } }
    ])
  })

  it('reports UNAVAILABLE — not an error — when the Host does not offer git', async () => {
    const host = await startFakeHost({ hostOffer: NO_GIT_OFFER })
    const client = createClient(host.discoveryPath)
    const welcome = await client.connect()
    expect(welcome.capabilities).not.toContain('workspace-git')

    const outcome = await client.getWorkspaceGitRead({ workspaceId: 'ws-1', scope: 'status' })

    expect(outcome).toEqual({ available: false, reason: 'capability-unavailable' })
    // A Host without git must never be asked; the refusal is client-side.
    expect(host.requests).toEqual([])
  })

  it('THROWS rather than reporting unavailable when never connected', async () => {
    // The conflation trap: supports() is false with no welcome at all, so a
    // naive capability-only check would diagnose a dead connection as "git is
    // unavailable here" — wrong, and sticky in the UI.
    const client = new HostProjectionClient({
      client: { clientId: 'tui-test', clientClass: 'tui', clientVersion: '1.9.6' },
      discoveryPath: '/tmp/does-not-exist.json'
    })

    await expect(
      client.getWorkspaceGitRead({ workspaceId: 'ws-1', scope: 'status' })
    ).rejects.toThrow(/not connected/)
  })

  it('THROWS rather than reporting unavailable after the connection closes', async () => {
    const host = await startFakeHost({ hostOffer: FULL_OFFER })
    const client = createClient(host.discoveryPath)
    await client.connect()
    client.close()

    await expect(
      client.getWorkspaceGitRead({ workspaceId: 'ws-1', scope: 'status' })
    ).rejects.toThrow(/not connected/)
  })
})

describe('truncation fidelity', () => {
  it('surfaces truncated=true to the caller instead of projecting it away', async () => {
    const host = await startFakeHost({
      hostOffer: FULL_OFFER,
      respond: () => ({
        kind: 'workspace.git.read',
        result: {
          scope: 'diff',
          branch: 'main',
          head: '0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          truncated: true,
          text: 'diff --git a/a.ts b/a.ts\n'
        }
      })
    })
    const client = createClient(host.discoveryPath)
    await client.connect()

    const outcome = await client.getWorkspaceGitRead({ workspaceId: 'ws-1', scope: 'diff' })

    if (!outcome.available) throw new Error('expected an available outcome')
    // A truncated diff arriving in the UI looking complete is the exact failure
    // the 128KiB cap exists to prevent.
    expect(outcome.result.truncated).toBe(true)
    expect(outcome.result.scope).toBe('diff')
  })

  it('preserves truncated=false for a complete payload', async () => {
    const host = await startFakeHost({
      hostOffer: FULL_OFFER,
      respond: () => ({
        kind: 'workspace.git.read',
        result: {
          scope: 'log',
          branch: 'main',
          head: '0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          truncated: false,
          text: 'abc123\t2026-08-28\tsubject\n'
        }
      })
    })
    const client = createClient(host.discoveryPath)
    await client.connect()

    const outcome = await client.getWorkspaceGitRead({ threadId: 'thread-1', scope: 'log' })

    if (!outcome.available) throw new Error('expected an available outcome')
    expect(outcome.result.truncated).toBe(false)
  })
})

describe('request shaping', () => {
  it('rejects a history response correlated to a different thread', async () => {
    const host = await startFakeHost({
      hostOffer: [...FULL_OFFER, 'history'],
      respond: () => ({
        kind: 'history.since',
        result: {
          kind: 'deltas',
          threadId: 'thread-other',
          generation: 1,
          fromCursor: 1,
          toCursor: 1,
          deltas: []
        }
      })
    })
    const client = new HostProjectionClient({
      client: { clientId: 'tui-test', clientClass: 'tui', clientVersion: '1.9.6' },
      capabilities: ['bootstrap', 'history'],
      discoveryPath: host.discoveryPath,
      connectTimeoutMs: 4_000,
      requestTimeoutMs: 4_000
    })
    cleanups.push(() => client.close())
    await client.connect()

    await expect(
      client.getHistorySince({
        threadId: 'thread-1',
        since: { generation: 1, cursor: 1 }
      })
    ).rejects.toThrow(/different thread/)
  })

  it('passes a thread-scoped request through unchanged', async () => {
    const host = await startFakeHost({
      hostOffer: FULL_OFFER,
      respond: () => ({
        kind: 'workspace.git.read',
        result: { scope: 'diff', branch: null, head: null, truncated: false, text: '' }
      })
    })
    const client = createClient(host.discoveryPath)
    await client.connect()

    await client.getWorkspaceGitRead({ threadId: 'thread-1', scope: 'diff', path: 'src/a.ts' })

    expect(host.requests[0]?.params).toEqual({
      threadId: 'thread-1',
      scope: 'diff',
      path: 'src/a.ts'
    })
  })

  it('rejects an unexpected result kind rather than returning it', async () => {
    const host = await startFakeHost({
      hostOffer: FULL_OFFER,
      respond: () => ({ kind: 'health.get', frame: { type: 'host.health' } })
    })
    const client = createClient(host.discoveryPath)
    await client.connect()

    await expect(
      client.getWorkspaceGitRead({ workspaceId: 'ws-1', scope: 'status' })
    ).rejects.toThrow(/unexpected workspace git result kind/)
  })
})
