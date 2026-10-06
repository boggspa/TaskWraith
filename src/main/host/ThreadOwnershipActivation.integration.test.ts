/**
 * Desktop ownership activation end to end, over the real local server's
 * socket: the production suppliers (dedicated desktop connection, negotiation
 * client, claim facts from durably recorded receipts, owned journal read as
 * the Host reads it) behind the real activation coordinator, against the
 * Host's real owner service and the profile's real authority files. Covers the
 * confirmed-receipt trigger, the claim, the mark, owned saves, a lost socket,
 * the erasure join, a refused claim handing saves back, and a restart over the
 * same receipt file.
 */
import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createConnection } from 'node:net'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/thread-ownership-activation-integration',
    getVersion: () => '0.0.0-test'
  }
}))

import { HostProjectionClient } from '../../host-client/HostProjectionClient'
import type { HostAuthority } from '../../host-runtime/HostAuthority'
import { HostLocalServer } from '../../host-runtime/HostLocalServer'
import type { HostSession, HostSessionBinding } from '../../host-runtime/HostSession'
import { HostThreadOwnerService } from '../../host-runtime/HostThreadOwnerService'
import { ThreadAuthorityFiles } from '../../host-shared/thread-log/ThreadAuthorityFile'
import { THREAD_LOG_BATCH_FORMAT } from '../../host-shared/thread-log/ThreadLogBatch'
import { THREAD_LOG_AUTHORITY_ENV } from '../../host-shared/thread-log/ThreadLogAuthoritySwitch'
import {
  PerChatSaveIntentQueue,
  persistIdempotencyKeyFor,
  type ChatSaveIntent
} from '../../shared/chatSaveIntentQueue'
import {
  HOST_PROJECTION_VERSION,
  HOST_PROTOCOL_VERSION,
  type HostCapability,
  type HostClientClass
} from '../../shared/hostProtocol'
import {
  HOST_LOCAL_TRANSPORT_VERSION,
  type HostLocalTransportHostFrame,
  type HostLocalTransportThreadOwnerParams
} from '../../shared/hostProtocolTransport'
import { installThreadOwnership } from '../startup/installThreadOwnership'
import type { ChatRecord } from '../store/types'
import { DESKTOP_THREAD_OWNER_CLIENT_ID } from './DesktopThreadOwnerConnection'
import type { ThreadOwnershipReceiptEvidence } from './ThreadOwnershipReceiptEvidence'

const TEMPORARY_PREFIX = 'thread-ownership-activation-'
const INCARNATION = 'b'.repeat(64)
const CHAT = 'chat-owned'
const SHA = 'd'.repeat(64)

const profiles: string[] = []
const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
  for (const profile of profiles.splice(0)) {
    const temporary = os.tmpdir()
    if (
      path.dirname(profile) !== temporary ||
      !path.basename(profile).startsWith(TEMPORARY_PREFIX) ||
      path.basename(profile).length <= TEMPORARY_PREFIX.length
    )
      throw new Error(`Refusing to remove ${profile}: not a folder this file made`)
    rmSync(profile, { recursive: true, force: true })
  }
})

/** Binds whoever says hello, with the capabilities it asked for. */
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

/** A real Host owner service behind a real local server, for a fresh profile. */
async function host() {
  const profile = mkdtempSync(path.join(os.tmpdir(), TEMPORARY_PREFIX))
  profiles.push(profile)
  const copies = new Map<string, number>()
  const runs = new Set<string>()
  const owners = new HostThreadOwnerService({
    environment: { [THREAD_LOG_AUTHORITY_ENV]: '1' },
    transactionalPersist: false,
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
    threadOwners: owners,
    bootEpoch: INCARNATION
  })
  await server.start()
  cleanups.push(() => server.stop())
  return { profile, copies, runs, owners, server }
}

/** Another desktop's raw socket, to ask the Host what it now answers for the thread. */
async function otherDesktop(server: HostLocalServer) {
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
  cleanups.push(() => void socket.destroy())
  const next = () => new Promise<HostLocalTransportHostFrame>((resolve) => waiting.push(resolve))
  const send = (frame: unknown) => socket.write(`${JSON.stringify(frame)}\n`)
  const welcome = next()
  send({
    type: 'hello',
    transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
    token: readFileSync(server.tokenPath, 'utf8').trim(),
    hello: {
      type: 'host.hello',
      protocolVersion: HOST_PROTOCOL_VERSION,
      projectionVersion: HOST_PROJECTION_VERSION,
      client: { clientId: 'other-desktop', clientClass: 'desktop', clientVersion: '1.0.0' },
      capabilities: ['bootstrap']
    }
  })
  expect((await welcome).type).toBe('welcome')
  let ids = 0
  return async (params: HostLocalTransportThreadOwnerParams): Promise<unknown> => {
    const answer = next()
    send({
      type: 'request',
      transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
      id: `other-${(ids += 1)}`,
      kind: 'thread.owner',
      params
    })
    const frame = await answer
    if (frame.type !== 'response') throw new Error(`expected a response, got ${frame.type}`)
    return frame.ok ? frame.result : { error: frame.error.code }
  }
}

function intent(revision: number): ChatSaveIntent {
  const commandId = `intent-${revision}-${randomUUID()}`
  return {
    chatId: CHAT,
    record: { appChatId: CHAT, persistenceRevision: revision, messages: [] } as never as ChatRecord,
    authoredAt: revision,
    commandId,
    idempotencyKey: persistIdempotencyKeyFor(commandId)
  }
}

const exact = (revision: number): ThreadOwnershipReceiptEvidence => ({
  kind: 'exact',
  threadId: CHAT,
  commandId: `host-${revision}-${randomUUID()}`,
  revision,
  sha256: SHA
})

/** The journal line the store's incremental journal writes for a save, as the Host reads it. */
function journal(profile: string, revision: number): void {
  const directory = path.join(profile, 'chat-journal-v2')
  mkdirSync(directory, { recursive: true })
  appendFileSync(
    path.join(directory, `${CHAT}.mutations.jsonl`),
    `${JSON.stringify({ format: THREAD_LOG_BATCH_FORMAT, chatId: CHAT, revision, savedAt: null })}\n`
  )
}

/** One app process: the production wiring over its own desktop connection. */
function desktop(profile: string, server: HostLocalServer, writerId = `desk-${randomUUID()}`) {
  const queue = new PerChatSaveIntentQueue()
  const transport = new HostProjectionClient({
    discoveryPath: server.discoveryPath,
    client: {
      clientId: DESKTOP_THREAD_OWNER_CLIENT_ID,
      clientClass: 'desktop',
      clientVersion: '0.0.0-test'
    },
    capabilities: ['bootstrap'],
    connectTimeoutMs: 2_000,
    requestTimeoutMs: 2_000
  })
  const barriers: string[] = []
  const paid: string[] = []
  const errors: unknown[] = []
  const wiring = installThreadOwnership({
    saveIntentQueue: queue,
    evidenceFile: path.join(profile, 'thread-ownership-receipts.json'),
    logAuthority: true,
    onError: (error) => errors.push(error),
    production: {
      journalBarrier: async (chatId) => void barriers.push(chatId),
      journalPaid: async (chatId) => void paid.push(chatId),
      userDataPath: profile,
      transport,
      writer: { writerId, pid: process.pid }
    }
  })
  cleanups.push(() => wiring.dispose())
  /** saveChat's admission, the save, then the Host's exact receipt for it. */
  const saveConfirmedByHost = async (revision: number) => {
    const saved = intent(revision)
    queue.enqueue(saved)
    journal(profile, revision)
    await wiring.persistedEvidenceSink(
      { chatId: CHAT, ownershipIntentId: saved.commandId },
      exact(revision)
    )
    await wiring.trigger!.idle()
    return saved
  }
  return { queue, transport, wiring, barriers, paid, errors, writerId, saveConfirmedByHost }
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) await new Promise((resolve) => setImmediate(resolve))
}

describe('desktop ownership activation over the real Host socket', () => {
  it('activates on the confirmed head: claim on its own socket, durable mark, owned saves', async () => {
    const { profile, copies, owners, server } = await host()
    copies.set(CHAT, 3)
    const app = desktop(profile, server)
    await app.wiring.loadEvidence()
    expect(app.wiring.production).not.toBeNull()

    await app.saveConfirmedByHost(3)

    expect(app.errors).toEqual([])
    expect(app.wiring.port.isActive(CHAT)).toBe(true)
    expect(app.transport.connected).toBe(true)
    // The mark is on disk, naming this process and the confirmed base.
    const mark = await new ThreadAuthorityFiles(profile).read(CHAT)
    expect(mark).toMatchObject({
      kind: 'held',
      record: {
        threadId: CHAT,
        writer: { writerId: app.writerId, pid: process.pid },
        epoch: { host: INCARNATION },
        grantedAtRevision: 3
      }
    })
    // The Host now holds the thread for this writer: another desktop is
    // refused and the Host may not write it itself.
    const other = await otherDesktop(server)
    expect(
      await other({
        action: 'claim',
        threadId: CHAT,
        writerId: 'someone-else',
        claimId: 1,
        baseRevision: 3,
        headRevision: 3
      })
    ).toMatchObject({ reply: { granted: false, reason: 'owned_by_other_writer' } })
    expect((await owners.requestHostWrite(CHAT)).kind).not.toBe('write')

    // An owned save is confirmed by the owned journal, not by a Host receipt.
    // It waits for barriers the app raises anyway: it raises none of its own.
    const barriersBefore = app.barriers.length
    journal(profile, 4)
    await expect(app.wiring.port.confirmOwnedSave!(CHAT, 4)).resolves.toBe(true)
    await expect(app.wiring.port.confirmOwnedSave!(CHAT, 5)).resolves.toBe(false)
    expect(app.paid).toEqual([CHAT, CHAT])
    expect(app.barriers).toHaveLength(barriersBefore)
  })

  it('keeps the mark over a lost socket; the erasure join removes it, then releases', async () => {
    const { profile, copies, server } = await host()
    copies.set(CHAT, 3)
    const app = desktop(profile, server)
    await app.wiring.loadEvidence()
    await app.saveConfirmedByHost(3)
    expect(app.wiring.port.isActive(CHAT)).toBe(true)

    // The socket goes: the grant with it, but the durable mark still names a
    // live writer, so another desktop is still refused.
    app.wiring.production!.connection.close()
    await settle()
    expect((await new ThreadAuthorityFiles(profile).read(CHAT)).kind).toBe('held')
    const other = await otherDesktop(server)
    const ask = (claimId: number) =>
      other({
        action: 'claim',
        threadId: CHAT,
        writerId: 'someone-else',
        claimId,
        baseRevision: 3,
        headRevision: 3
      })
    expect(await ask(1)).toMatchObject({
      reply: { granted: false, reason: 'owned_by_other_writer' }
    })

    // Erasure: the coordinator drops the chat, removes the mark it no longer
    // needs, and its release meets a socket already gone.
    await app.wiring.erasureJoins.coordinator!.deactivate(CHAT)
    expect(app.wiring.port.isActive(CHAT)).toBe(false)
    expect(await new ThreadAuthorityFiles(profile).read(CHAT)).toEqual({ kind: 'none' })
    expect(await ask(2)).toMatchObject({ reply: { granted: true } })
  })

  it('retries a refused claim after the hold ends, on the head the Host already confirmed', async () => {
    const { profile, copies, runs, server } = await host()
    copies.set(CHAT, 3)
    runs.add(CHAT)
    const app = desktop(profile, server)
    await app.wiring.loadEvidence()
    await app.saveConfirmedByHost(3)
    expect(app.wiring.port.isActive(CHAT)).toBe(false)

    // The Host stops working on the thread (its hold was taken over): the
    // retry needs no new save, because the rollback kept the head's join.
    runs.delete(CHAT)
    const retried = await app.wiring.trigger!.retry(CHAT)
    expect(retried).toMatchObject({ kind: 'activated' })
    expect(app.wiring.port.isActive(CHAT)).toBe(true)
    expect((await new ThreadAuthorityFiles(profile).read(CHAT)).kind).toBe('held')
  })

  it('stops treating a lost grant as ownership: later saves wait for Host storage', async () => {
    const { profile, copies, server } = await host()
    copies.set(CHAT, 3)
    const app = desktop(profile, server)
    await app.wiring.loadEvidence()
    await app.saveConfirmedByHost(3)
    expect(app.wiring.port.isActive(CHAT)).toBe(true)

    app.wiring.production!.connection.close()
    await settle()
    expect(app.wiring.port.isActive(CHAT)).toBe(false)
    // A save the journal holds is not acknowledged on the journal's word alone.
    journal(profile, 4)
    await expect(app.wiring.port.confirmOwnedSave!(CHAT, 4)).resolves.toBe(false)
    // The mark still names this live writer, so nobody else takes the thread.
    expect((await new ThreadAuthorityFiles(profile).read(CHAT)).kind).toBe('held')
  })

  it('hands the saves back when the Host refuses the claim, and writes no mark', async () => {
    const { profile, copies, runs, server } = await host()
    copies.set(CHAT, 3)
    runs.add(CHAT)
    const app = desktop(profile, server)
    await app.wiring.loadEvidence()
    const outcomes: string[] = []
    const saved = intent(3)
    app.queue.enqueue(saved)
    journal(profile, 3)
    // A newer save is authored while the head's receipt is being recorded.
    const newer = intent(4)
    await app.wiring.persistedEvidenceSink(
      { chatId: CHAT, ownershipIntentId: saved.commandId },
      exact(3)
    )
    app.queue.enqueue(newer)
    await app.wiring.trigger!.idle()
    outcomes.push(app.wiring.port.isActive(CHAT) ? 'active' : 'inactive')

    expect(outcomes).toEqual(['inactive'])
    expect(await new ThreadAuthorityFiles(profile).read(CHAT)).toEqual({ kind: 'none' })
    // Not owned, and not confirmed by any Host: still pending.
    expect(app.queue.peek(CHAT).map((item) => item.commandId)).toEqual([newer.commandId])
    expect(app.queue.isFrozen(CHAT)).toBe(false)
  })

  it('lets an erasure that lands mid-activation win: no mark, no grant left behind', async () => {
    const { profile, copies, server } = await host()
    copies.set(CHAT, 3)
    const app = desktop(profile, server)
    await app.wiring.loadEvidence()
    const saved = intent(3)
    app.queue.enqueue(saved)
    journal(profile, 3)
    const recorded = app.wiring.persistedEvidenceSink(
      { chatId: CHAT, ownershipIntentId: saved.commandId },
      exact(3)
    )
    await recorded
    // Activation is now in flight; erasure begins before it settles.
    await app.wiring.erasureJoins.coordinator!.deactivate(CHAT)
    await app.wiring.trigger!.idle()

    expect(app.wiring.port.isActive(CHAT)).toBe(false)
    expect(await new ThreadAuthorityFiles(profile).read(CHAT)).toEqual({ kind: 'none' })
    const other = await otherDesktop(server)
    expect(
      await other({
        action: 'claim',
        threadId: CHAT,
        writerId: 'someone-else',
        claimId: 1,
        baseRevision: 3,
        headRevision: 3
      })
    ).toMatchObject({ reply: { granted: true } })
  })

  it('survives a restart: the receipt is durable, and a new process can take the thread again', async () => {
    const { profile, copies, server } = await host()
    copies.set(CHAT, 3)
    const first = desktop(profile, server)
    await first.wiring.loadEvidence()
    await first.saveConfirmedByHost(3)
    expect(first.wiring.port.isActive(CHAT)).toBe(true)
    // The process stops after removing its mark (an orderly erasure of
    // ownership); its socket closes with it.
    await first.wiring.erasureJoins.coordinator!.deactivate(CHAT)
    first.wiring.dispose()
    await settle()

    const second = desktop(profile, server)
    await second.wiring.loadEvidence()
    // Hydrated before any save is admitted: the first process's receipt.
    expect(second.wiring.port.receiptsFor(CHAT)).toEqual([
      expect.objectContaining({ kind: 'exact', revision: 3 })
    ])
    copies.set(CHAT, 5)
    await second.saveConfirmedByHost(5)
    expect(second.errors).toEqual([])
    expect(second.wiring.port.isActive(CHAT)).toBe(true)
    expect(await new ThreadAuthorityFiles(profile).read(CHAT)).toMatchObject({
      kind: 'held',
      record: { writer: { writerId: second.writerId }, grantedAtRevision: 5 }
    })
  })
})
