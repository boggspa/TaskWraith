/**
 * `thread.owner` through the real local server, over its socket: a Host with
 * the thread log authority switch off refuses every claim in a way the app
 * reads as "this Host takes no claims"; with it on, claims, `advanced` and
 * `release` go through the Host's owner table.
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createConnection } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ThreadAuthorityFiles } from '../host-shared/thread-log/ThreadAuthorityFile'
import { THREAD_LOG_AUTHORITY_ENV } from '../host-shared/thread-log/ThreadLogAuthoritySwitch'
import {
  HOST_PROTOCOL_VERSION,
  HOST_PROJECTION_VERSION,
  type HostCapability,
  type HostClientClass
} from '../shared/hostProtocol'
import {
  HOST_LOCAL_TRANSPORT_VERSION,
  type HostLocalTransportHostFrame,
  type HostLocalTransportThreadOwnerParams
} from '../shared/hostProtocolTransport'
import type { HostAuthority } from './HostAuthority'
import { HostLocalServer } from './HostLocalServer'
import type { HostSession, HostSessionBinding } from './HostSession'
import { HostThreadOwnerService } from './HostThreadOwnerService'

const TEMPORARY_PREFIX = 'host-thread-owner-server-'
const INCARNATION = 'b'.repeat(64)
const ON = { [THREAD_LOG_AUTHORITY_ENV]: '1' }

/** Remove, with all it holds, a folder made here by `mkdtempSync` with TEMPORARY_PREFIX. */
function removeTemporaryDirectory(directory: string): void {
  const temporary = os.tmpdir()
  if (
    directory === temporary ||
    path.dirname(directory) !== temporary ||
    !path.basename(directory).startsWith(TEMPORARY_PREFIX) ||
    path.basename(directory).length <= TEMPORARY_PREFIX.length
  ) {
    throw new Error(`Refusing to remove ${directory}: not a folder this file made`)
  }
  rmSync(directory, { recursive: true, force: true })
}

/** A session that binds whoever says hello, with the capabilities it asked for. */
function session(): HostSession {
  return {
    bind: (request: {
      authenticatedClient: { clientId: string; clientClass: HostClientClass; clientVersion: string }
      clientCapabilityRequest: readonly HostCapability[]
    }) => {
      const sessionId = randomUUID()
      const client = request.authenticatedClient
      const binding: HostSessionBinding = {
        sessionId,
        actor: {
          actorId: client.clientId,
          clientId: client.clientId,
          clientClass: client.clientClass
        },
        authenticatedClient: client,
        welcome: {
          type: 'host.welcome',
          protocolVersion: HOST_PROTOCOL_VERSION,
          controlProtocolCompat: 1,
          projectionVersion: HOST_PROJECTION_VERSION,
          hostId: 'test-host',
          hostVersion: '0.0.0-test',
          sessionId,
          generation: 0,
          cursor: 1,
          authenticatedClient: client,
          capabilities: [...request.clientCapabilityRequest],
          freshness: 'live'
        },
        boundGeneration: 0,
        boundCursor: 1
      }
      return { ok: true, value: binding }
    },
    lookup: () => null,
    size: () => 1
  } as unknown as HostSession
}

interface Client {
  request(
    params: HostLocalTransportThreadOwnerParams | Record<string, unknown>
  ): Promise<HostLocalTransportHostFrame>
  close(): Promise<void>
}

const profiles: string[] = []
const servers: HostLocalServer[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop()
  for (const profile of profiles.splice(0)) removeTemporaryDirectory(profile)
})

/**
 * A real server for a fresh profile, its owner service built from `environment`
 * as the production Host builds it. The Host's full copies and runs are maps
 * the test sets.
 */
async function host(environment: Record<string, string> = {}) {
  const profile = mkdtempSync(path.join(os.tmpdir(), TEMPORARY_PREFIX))
  profiles.push(profile)
  const copies = new Map<string, number>()
  const runs = new Set<string>()
  const owners = new HostThreadOwnerService({
    environment,
    transactionalPersist: environment.TASKWRAITH_HOST_TXN_PERSIST === '1',
    profilePath: profile,
    incarnation: INCARNATION,
    fullCopyRevision: (threadId) => copies.get(threadId) ?? null,
    hostRunActive: (threadId) => runs.has(threadId),
    log: () => {}
  })
  await owners.start()
  const server = new HostLocalServer({
    userDataPath: profile,
    hostId: 'test-host',
    hostVersion: '0.0.0-test',
    session: session(),
    authority: {} as HostAuthority,
    threadOwners: owners
  })
  servers.push(server)
  await server.start()
  let ids = 0
  const connect = async (clientClass: HostClientClass = 'desktop'): Promise<Client> => {
    const socket = createConnection(server.socketPath)
    socket.setEncoding('utf8')
    let buffer = ''
    const waiting: Array<(frame: HostLocalTransportHostFrame) => void> = []
    socket.on('data', (chunk: string) => {
      buffer += chunk
      for (let newline = buffer.indexOf('\n'); newline >= 0; newline = buffer.indexOf('\n')) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        waiting.shift()?.(JSON.parse(line) as HostLocalTransportHostFrame)
      }
    })
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve)
      socket.once('error', reject)
    })
    const next = (): Promise<HostLocalTransportHostFrame> =>
      new Promise((resolve) => waiting.push(resolve))
    const send = (frame: unknown): void => {
      socket.write(`${JSON.stringify(frame)}\n`)
    }
    const welcome = next()
    send({
      type: 'hello',
      transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
      token: readFileSync(server.tokenPath, 'utf8').trim(),
      hello: {
        type: 'host.hello',
        protocolVersion: HOST_PROTOCOL_VERSION,
        projectionVersion: HOST_PROJECTION_VERSION,
        client: { clientId: `client-${clientClass}`, clientClass, clientVersion: '1.0.0' },
        capabilities: ['bootstrap', 'snapshot', 'commands']
      }
    })
    expect((await welcome).type).toBe('welcome')
    return {
      request: (params) => {
        const answer = next()
        send({
          type: 'request',
          transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
          id: `request-${(ids += 1)}`,
          kind: 'thread.owner',
          params
        })
        return answer
      },
      close: () =>
        new Promise<void>((resolve) => {
          socket.once('close', () => resolve())
          socket.destroy()
        })
    }
  }
  return { profile, copies, runs, owners, server, connect }
}

const claim = (threadId: string, writerId: string, revisions: [number, number], claimId = 1) => ({
  action: 'claim' as const,
  threadId,
  writerId,
  claimId,
  baseRevision: revisions[0],
  headRevision: revisions[1]
})

function resultOf(frame: HostLocalTransportHostFrame): unknown {
  if (frame.type !== 'response') throw new Error(`expected a response, got ${frame.type}`)
  return frame.ok ? frame.result : { error: frame.error.code }
}

/** Waits until the server has handled a client's close. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) await new Promise((resolve) => setImmediate(resolve))
}

describe('thread.owner over the local server', () => {
  describe('with the thread log authority switch off', () => {
    it('refuses every claim as a Host that takes none, and records nothing', async () => {
      const { profile, copies, connect } = await host({})
      copies.set('thread-1', 5)
      const app = await connect()
      expect(resultOf(await app.request(claim('thread-1', 'desk-1', [5, 5])))).toEqual({
        kind: 'thread.owner',
        action: 'claim',
        reply: {
          threadId: 'thread-1',
          claimId: 1,
          granted: false,
          reason: 'disabled',
          revision: null
        }
      })
      const epoch = { host: INCARNATION, grant: 1 }
      expect(
        resultOf(
          await app.request({ action: 'advanced', threadId: 'thread-1', epoch, revision: 6 })
        )
      ).toEqual({ kind: 'thread.owner', action: 'advanced', recorded: false })
      expect(
        resultOf(await app.request({ action: 'release', threadId: 'thread-1', epoch, revision: 6 }))
      ).toEqual({ kind: 'thread.owner', action: 'release', released: false })
      // No authority file was looked for.
      expect(existsSync(path.join(profile, 'thread-authority'))).toBe(false)
      await app.close()
    })

    it('also refuses them on a Host started with transactional persists', async () => {
      const { copies, connect, owners } = await host({ ...ON, TASKWRAITH_HOST_TXN_PERSIST: '1' })
      expect(owners.mode).toBe('off-txn-persist')
      copies.set('thread-1', 5)
      const app = await connect()
      expect(resultOf(await app.request(claim('thread-1', 'desk-1', [5, 5])))).toMatchObject({
        reply: { granted: false, reason: 'disabled', revision: null }
      })
      await app.close()
    })
  })

  describe('with the switch on', () => {
    it('grants a claim on the Host’s copy, follows it, and takes the thread back', async () => {
      const { copies, connect, owners } = await host(ON)
      expect(owners.mode).toBe('on')
      copies.set('thread-1', 5)
      const app = await connect()
      expect(resultOf(await app.request(claim('thread-1', 'desk-1', [5, 5])))).toEqual({
        kind: 'thread.owner',
        action: 'claim',
        reply: {
          threadId: 'thread-1',
          claimId: 1,
          granted: true,
          epoch: { host: INCARNATION, grant: 1 }
        }
      })
      const epoch = { host: INCARNATION, grant: 1 }
      expect(
        resultOf(
          await app.request({ action: 'advanced', threadId: 'thread-1', epoch, revision: 9 })
        )
      ).toEqual({ kind: 'thread.owner', action: 'advanced', recorded: true })
      expect(owners.snapshot().table!.threads).toEqual([
        expect.objectContaining({ threadId: 'thread-1', writerId: 'desk-1', revision: 9 })
      ])
      expect(
        resultOf(await app.request({ action: 'release', threadId: 'thread-1', epoch, revision: 9 }))
      ).toEqual({ kind: 'thread.owner', action: 'release', released: true })
      expect(owners.snapshot().table!.threads).toEqual([])
      await app.close()
    })

    it('refuses a claim the Host cannot grant, with the reason', async () => {
      const { profile, copies, runs, connect } = await host(ON)
      copies.set('thread-1', 5)
      copies.set('thread-2', 7)
      copies.set('thread-3', 2)
      copies.set('thread-4', 4)
      runs.add('thread-3')
      // A live app process's authority file holds thread-4 for it.
      await new ThreadAuthorityFiles(profile).write({
        threadId: 'thread-4',
        writer: { writerId: 'desk-old', pid: process.pid },
        epoch: { host: 'c'.repeat(64), grant: 3 },
        grantedAtRevision: 4,
        grantedAt: Date.now()
      })
      const first = await connect()
      const second = await connect()
      await first.request(claim('thread-1', 'desk-1', [5, 5]))
      expect(resultOf(await second.request(claim('thread-1', 'desk-2', [5, 5])))).toMatchObject({
        reply: { granted: false, reason: 'owned_by_other_writer', revision: 5 }
      })
      expect(resultOf(await second.request(claim('thread-2', 'desk-2', [5, 5], 2)))).toMatchObject({
        reply: { granted: false, reason: 'host_ahead', revision: 7 }
      })
      expect(resultOf(await second.request(claim('thread-3', 'desk-2', [2, 2], 3)))).toMatchObject({
        reply: { granted: false, reason: 'host_run_active', revision: 2 }
      })
      expect(resultOf(await second.request(claim('thread-4', 'desk-2', [4, 4], 4)))).toMatchObject({
        reply: { granted: false, reason: 'owned_by_other_writer' }
      })
      expect(resultOf(await second.request(claim('thread-9', 'desk-2', [0, 0], 5)))).toMatchObject({
        reply: { granted: false, reason: 'host_behind', revision: null }
      })
      await first.close()
      await second.close()
    })

    it('gives a writer’s threads back when its last connection to the Host closes', async () => {
      const { copies, connect, owners } = await host(ON)
      copies.set('thread-1', 5)
      const first = await connect()
      const again = await connect()
      await first.request(claim('thread-1', 'desk-1', [5, 5]))
      // The same app process on a second connection keeps its grant.
      await again.request(claim('thread-1', 'desk-1', [5, 5], 2))
      await first.close()
      await settle()
      expect(owners.snapshot().table!.threads).toHaveLength(1)
      await again.close()
      await settle()
      expect(owners.snapshot().table!.threads).toEqual([])
      const next = await connect()
      expect(resultOf(await next.request(claim('thread-1', 'desk-2', [5, 5])))).toMatchObject({
        reply: { granted: true, epoch: { host: INCARNATION, grant: 2 } }
      })
      await next.close()
    })

    it('answers only the desktop app, and only ids a thread can have', async () => {
      const { copies, connect } = await host(ON)
      copies.set('thread-1', 5)
      const terminal = await connect('tui')
      expect(resultOf(await terminal.request(claim('thread-1', 'tui-1', [5, 5])))).toEqual({
        error: 'unauthorized'
      })
      await terminal.close()
      const app = await connect()
      expect(resultOf(await app.request(claim('..', 'desk-1', [5, 5])))).toEqual({
        error: 'invalid_payload'
      })
      // A connection speaks for one app process.
      await app.request(claim('thread-1', 'desk-1', [5, 5], 2))
      expect(resultOf(await app.request(claim('thread-1', 'desk-2', [5, 5], 3)))).toEqual({
        error: 'invalid_payload'
      })
      await app.close()
    })
  })

  it('leaves a server built without an owner service as it was', async () => {
    const profile = mkdtempSync(path.join(os.tmpdir(), TEMPORARY_PREFIX))
    profiles.push(profile)
    const server = new HostLocalServer({
      userDataPath: profile,
      hostId: 'test-host',
      hostVersion: '0.0.0-test',
      session: session(),
      authority: {} as HostAuthority
    })
    servers.push(server)
    await server.start()
    const socket = createConnection(server.socketPath)
    socket.setEncoding('utf8')
    const lines: string[] = []
    socket.on('data', (chunk: string) => lines.push(...chunk.split('\n').filter(Boolean)))
    await new Promise((resolve) => socket.once('connect', resolve))
    socket.write(
      `${JSON.stringify({
        type: 'hello',
        transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
        token: readFileSync(server.tokenPath, 'utf8').trim(),
        hello: {
          type: 'host.hello',
          protocolVersion: HOST_PROTOCOL_VERSION,
          projectionVersion: HOST_PROJECTION_VERSION,
          client: { clientId: 'client-desktop', clientClass: 'desktop', clientVersion: '1.0.0' },
          capabilities: ['bootstrap']
        }
      })}\n${JSON.stringify({
        type: 'request',
        transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
        id: 'request-1',
        kind: 'thread.owner',
        params: claim('thread-1', 'desk-1', [5, 5])
      })}\n`
    )
    await vi.waitFor(() => expect(lines).toHaveLength(2))
    expect(JSON.parse(lines[1])).toMatchObject({
      ok: false,
      error: { code: 'unknown_request_kind' }
    })
    socket.destroy()
  })
})
