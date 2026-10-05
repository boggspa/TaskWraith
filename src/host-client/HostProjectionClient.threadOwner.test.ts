import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { HOST_PROJECTION_VERSION, type HostBootstrapWelcome } from '../shared/hostProtocol'
import type {
  HostLocalTransportSuccessResult,
  HostLocalTransportThreadOwnerParams
} from '../shared/hostProtocolTransport'
import { HostProjectionClient, HostProjectionTransportError } from './HostProjectionClient'

const cleanup: Array<() => Promise<void>> = []
const HOST = 'a'.repeat(64)
const PREFIX = 'tw-owner-client-'

afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!()
})

async function fixture(requestTimeoutMs = 2_000) {
  const directory = await mkdtemp(join(tmpdir(), PREFIX))
  cleanup.push(async () => {
    expect(directory).not.toBe(tmpdir())
    expect(directory.startsWith(`${tmpdir()}${sep}${PREFIX}`)).toBe(true)
    await rm(directory, { recursive: true, force: true })
  })
  const sockets = new Set<Socket>()
  const requests: Array<{ kind: string; params: unknown }> = []
  let respond: ((frame: { id: string; kind: string; params: unknown }) => unknown) | null = null
  const welcome: HostBootstrapWelcome = {
    type: 'host.welcome',
    protocolVersion: 2,
    controlProtocolCompat: 1,
    projectionVersion: HOST_PROJECTION_VERSION,
    hostId: 'test-host',
    hostVersion: 'test',
    sessionId: 'test-session',
    generation: 1,
    cursor: 0,
    authenticatedClient: { clientId: 'desktop', clientClass: 'desktop', clientVersion: 'test' },
    capabilities: ['bootstrap'],
    freshness: 'live',
    bootEpoch: HOST
  }
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.once('close', () => sockets.delete(socket))
    socket.setEncoding('utf8')
    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += chunk
      for (let index = buffer.indexOf('\n'); index >= 0; index = buffer.indexOf('\n')) {
        const frame = JSON.parse(buffer.slice(0, index))
        buffer = buffer.slice(index + 1)
        if (frame.type === 'hello') {
          socket.write(`${JSON.stringify({ type: 'welcome', transportVersion: 1, welcome })}\n`)
        } else if (frame.type === 'request') {
          requests.push({ kind: frame.kind, params: frame.params })
          const response = respond?.(frame)
          if (response) socket.write(`${JSON.stringify(response)}\n`)
        }
      }
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  cleanup.push(async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected loopback listener')
  const tokenPath = join(directory, 'token')
  const discoveryPath = join(directory, 'discovery.json')
  await writeFile(tokenPath, 'fixture-token', { mode: 0o600 })
  await writeFile(
    discoveryPath,
    JSON.stringify({
      protocolVersion: 2,
      socketPath: `127.0.0.1:${address.port}`,
      tokenPath,
      pid: process.pid,
      startedAt: new Date(0).toISOString()
    }),
    { mode: 0o600 }
  )
  const client = new HostProjectionClient({
    client: { clientId: 'desktop', clientClass: 'desktop', clientVersion: 'test' },
    discoveryPath,
    requestTimeoutMs,
    connectTimeoutMs: 2_000
  })
  cleanup.push(async () => client.close())
  await client.connect()
  return {
    client,
    requests,
    reply(result: HostLocalTransportSuccessResult | unknown) {
      respond = ({ id }) => ({ type: 'response', transportVersion: 1, id, ok: true, result })
    },
    fail() {
      respond = ({ id }) => ({
        type: 'response',
        transportVersion: 1,
        id,
        ok: false,
        error: { code: 'unknown_request_kind' }
      })
    }
  }
}

const CLAIM: HostLocalTransportThreadOwnerParams = {
  action: 'claim',
  threadId: 'thread',
  writerId: 'writer',
  claimId: 1,
  baseRevision: 2,
  headRevision: 2
}

describe('HostProjectionClient thread ownership request', () => {
  it.each([
    [
      CLAIM,
      {
        kind: 'thread.owner',
        action: 'claim',
        reply: { threadId: 'thread', claimId: 1, granted: true, epoch: { host: HOST, grant: 1 } }
      }
    ],
    [
      { action: 'advanced', threadId: 'thread', epoch: { host: HOST, grant: 1 }, revision: 3 },
      { kind: 'thread.owner', action: 'advanced', recorded: true }
    ],
    [
      { action: 'release', threadId: 'thread', epoch: { host: HOST, grant: 1 }, revision: 3 },
      { kind: 'thread.owner', action: 'release', released: true }
    ]
  ] as const)('round-trips %j over the same authenticated socket', async (params, result) => {
    const f = await fixture()
    f.reply(result)
    await expect(f.client.requestThreadOwner(params)).resolves.toEqual(result)
    expect(f.requests).toEqual([{ kind: 'thread.owner', params }])
    expect(f.client.connected).toBe(true)
  })

  it('rejects a valid result for another action', async () => {
    const f = await fixture()
    f.reply({ kind: 'thread.owner', action: 'release', released: true })
    await expect(f.client.requestThreadOwner(CLAIM)).rejects.toThrow(
      'unexpected thread owner result'
    )
  })

  it('preserves old-Host unknown_request_kind for connection-scoped fallback', async () => {
    const f = await fixture()
    f.fail()
    await expect(f.client.requestThreadOwner(CLAIM)).rejects.toEqual(
      new HostProjectionTransportError('unknown_request_kind')
    )
    expect(f.client.connected).toBe(true)
  })

  it('rejects malformed grants through the existing decoder', async () => {
    const f = await fixture()
    f.reply({
      kind: 'thread.owner',
      action: 'claim',
      reply: { threadId: 'thread', claimId: 1, granted: true, epoch: { host: HOST, grant: -1 } }
    })
    await expect(f.client.requestThreadOwner(CLAIM)).rejects.toThrow()
  })

  it('retains the existing finite timeout for a Host that never answers', async () => {
    const f = await fixture(100)
    await expect(f.client.requestThreadOwner(CLAIM)).rejects.toThrow(
      'request timed out: thread.owner'
    )
  })
})
