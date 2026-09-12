import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import {
  ThreadCatalogueRequestError,
  threadCatalogueRequestError
} from '../../shared/threadCatalogueRequestError'
import { ThreadCatalogueDecoderClient } from './ThreadCatalogueDecoderClient'
import { flushThreadCatalogueSources } from './ThreadCatalogueDiskReader'
import { classifyThreadDecodeError } from './ThreadCatalogueWorkerProtocol'
import { ThreadCatalogueWorkerService, type IndexedThread } from './ThreadCatalogueWorkerService'

const profiles: string[] = []
let decoderDirectory = ''
let decoderPath = ''

beforeAll(async () => {
  decoderDirectory = fs.mkdtempSync(join(tmpdir(), 'catalogue-contention-decoder-'))
  decoderPath = join(decoderDirectory, 'decoder.cjs')
  await build({
    entryPoints: ['src/main/workers/threadCatalogueDecoder.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: decoderPath,
    logLevel: 'silent'
  })
})

afterAll(() => fs.rmSync(decoderDirectory, { recursive: true, force: true }))

afterEach(() => {
  for (const profile of profiles.splice(0)) fs.rmSync(profile, { recursive: true, force: true })
})

function service(): ThreadCatalogueWorkerService {
  const profilePath = fs.mkdtempSync(join(tmpdir(), 'catalogue-contention-'))
  profiles.push(profilePath)
  return new ThreadCatalogueWorkerService({
    reader: { profilePath, runtimeInstanceId: 'contention-test', segmented: false },
    decoderPath: join(profilePath, 'decoder-is-not-needed.cjs'),
    writer: 'host',
    writerId: 'contention-test',
    writerLifecycle: (writer, writerId) =>
      writer === 'host' && writerId === 'contention-test' ? 'active' : 'unknown'
  })
}

function writeChat(profilePath: string, chatId: string, revision = 1): void {
  fs.mkdirSync(join(profilePath, 'chats'), { recursive: true })
  fs.writeFileSync(
    join(profilePath, 'chats', `${chatId}.json`),
    JSON.stringify({
      appChatId: chatId,
      title: `${chatId} revision ${revision}`,
      provider: 'codex',
      scope: 'global',
      createdAt: 1,
      updatedAt: revision,
      persistenceRevision: revision,
      messages: [],
      runs: []
    }),
    { mode: 0o600 }
  )
}

function realService(profilePath: string): ThreadCatalogueWorkerService {
  return new ThreadCatalogueWorkerService({
    reader: { profilePath, runtimeInstanceId: 'real-contention-test', segmented: false },
    decoderPath,
    writer: 'host',
    writerId: 'real-contention-test',
    writerLifecycle: (writer, writerId) =>
      writer === 'host' && writerId === 'real-contention-test' ? 'active' : 'unknown'
  })
}

describe('ThreadCatalogueWorkerService request-local contention', () => {
  it('retains the decoder changed reason as a closed error and leaves unreadable failures generic', async () => {
    const decode = async (reason: 'changed' | 'unreadable') => {
      let rejected: Error | undefined
      const timeout = setTimeout(() => undefined, 10_000)
      const worker = {}
      const client = Object.create(
        ThreadCatalogueDecoderClient.prototype
      ) as ThreadCatalogueDecoderClient
      Object.assign(client, {
        worker,
        active: {
          requestId: 1,
          sequence: 0,
          onMessage: () => undefined,
          resolve: () => undefined,
          reject: (error: Error) => {
            rejected = error
          },
          timeout
        }
      })
      await (
        client as unknown as {
          handle(worker: object, message: object): Promise<void>
        }
      ).handle(worker, {
        type: 'error',
        requestId: 1,
        reason,
        message:
          reason === 'changed' ? 'untrusted changed prose' : 'History indexing did not complete'
      })
      return rejected
    }

    expect(await decode('changed')).toMatchObject({
      name: 'ThreadCatalogueRequestError',
      code: 'source_changed',
      message: 'History changed during indexing.'
    })
    const unreadable = await decode('unreadable')
    expect(unreadable).toEqual(new Error('History indexing did not complete'))
    expect(threadCatalogueRequestError(unreadable)).toBeNull()
    expect(
      classifyThreadDecodeError(new Error('filesystem changed ownership unexpectedly'))
    ).toEqual({
      reason: 'unreadable',
      message: 'History indexing did not complete'
    })
  })

  it('types only an exact witness change during the durability flush', async () => {
    const profilePath = fs.mkdtempSync(join(tmpdir(), 'catalogue-flush-change-'))
    profiles.push(profilePath)
    writeChat(profilePath, 'chat')
    let authorityChecks = 0

    await expect(
      flushThreadCatalogueSources(
        { profilePath, runtimeInstanceId: 'flush-test', segmented: false },
        'chat',
        () => {
          authorityChecks += 1
          if (authorityChecks === 2) writeChat(profilePath, 'chat', 2)
        }
      )
    ).rejects.toMatchObject({
      name: 'ThreadCatalogueRequestError',
      code: 'source_changed'
    })
  })

  it('classifies an active pending publication without entering the decoder', async () => {
    const worker = service()
    const ticket = worker.catalogue.beginPublication('chat-active')
    try {
      await expect(worker.ensureIndexed('chat-active', 'metadata')).rejects.toMatchObject({
        name: 'ThreadCatalogueRequestError',
        code: 'source_unsettled',
        message: 'History source is not yet verified for indexing.'
      })
    } finally {
      worker.catalogue.failPublication(ticket, { source: 'unchanged' })
      await worker.dispose()
    }
  })

  it('does not claim that a persistent unreadable source head belongs to an active writer', async () => {
    const worker = service()
    const head = join(worker.catalogue.directory, 'host', 'chat-unreadable.json')
    fs.mkdirSync(join(worker.catalogue.directory, 'host'), { recursive: true })
    fs.writeFileSync(head, '{', { mode: 0o600 })
    try {
      await expect(worker.ensureIndexed('chat-unreadable', 'metadata')).rejects.toMatchObject({
        code: 'source_unsettled',
        message: 'History source is not yet verified for indexing.'
      })
    } finally {
      await worker.dispose()
    }
  })

  it('separates incomplete source evidence from exact generation supersession', () => {
    const chatId = 'chat-lease'
    const entry = {
      chatId,
      generation: 'generation-1',
      epoch: { global: 'initial', chat: 'initial' },
      projection: { sourceComplete: false }
    } as unknown as IndexedThread
    const worker = Object.create(
      ThreadCatalogueWorkerService.prototype
    ) as ThreadCatalogueWorkerService
    Object.assign(worker, {
      leases: new Map([['lease', { entry, expires: Date.now() + 10_000 }]]),
      catalogue: {
        epoch: () => entry.epoch,
        read: () => ({ status: 'ready' })
      },
      database: { current: () => entry }
    })
    const readLease = (
      worker as unknown as { readLease(id: string, operational: boolean): IndexedThread }
    ).readLease.bind(worker)

    expect(() => readLease('lease', true)).toThrow('History recovery requires a complete source')
    try {
      readLease('lease', true)
    } catch (error) {
      expect(threadCatalogueRequestError(error)).toBeNull()
    }

    delete (entry.projection as { sourceComplete?: false }).sourceComplete
    ;(worker as unknown as { database: { current(): { generation: string } } }).database.current =
      () => ({ generation: 'generation-2' })
    expect(() => readLease('lease', true)).toThrow(ThreadCatalogueRequestError)
    try {
      readLease('lease', true)
    } catch (error) {
      expect(threadCatalogueRequestError(error)?.code).toBe('lease_superseded')
    }
  })

  it('keeps a quiet thread readable while another publication is pending, then converges when it settles', async () => {
    const profilePath = fs.mkdtempSync(join(tmpdir(), 'catalogue-real-contention-'))
    profiles.push(profilePath)
    writeChat(profilePath, 'hot')
    writeChat(profilePath, 'quiet')
    const worker = realService(profilePath)
    const pending = worker.catalogue.beginPublication('hot')
    try {
      await expect(worker.ensureIndexed('hot', 'metadata')).rejects.toMatchObject({
        code: 'source_unsettled'
      })
      await expect(worker.ensureIndexed('quiet', 'metadata')).resolves.toMatchObject({
        projection: { summary: { chatId: 'quiet', title: 'quiet revision 1' } },
        snapshot: false
      })

      worker.catalogue.failPublication(pending, { source: 'unchanged' })
      await expect(worker.ensureIndexed('hot', 'metadata')).resolves.toMatchObject({
        projection: { summary: { chatId: 'hot', title: 'hot revision 1' } },
        snapshot: false
      })
    } finally {
      await worker.dispose()
    }
  })

  it('invalidates only an old recovery lease after a source revision and serves a new stable lease', async () => {
    const profilePath = fs.mkdtempSync(join(tmpdir(), 'catalogue-real-lease-'))
    profiles.push(profilePath)
    writeChat(profilePath, 'chat')
    const worker = realService(profilePath)
    try {
      const first = (await worker.query({
        method: 'open',
        chatId: 'chat',
        mode: 'metadata'
      })) as { leaseId: string; entry: IndexedThread }
      writeChat(profilePath, 'chat', 2)
      worker.notifyChanged('chat')
      await worker.ensureIndexed('chat', 'metadata')

      await expect(
        worker.query({ method: 'objects', leaseId: first.leaseId, kind: 'recovery' })
      ).rejects.toMatchObject({ code: 'lease_superseded' })

      const second = (await worker.query({
        method: 'open',
        chatId: 'chat',
        mode: 'metadata'
      })) as { leaseId: string; entry: IndexedThread }
      await expect(
        worker.query({ method: 'objects', leaseId: second.leaseId, kind: 'recovery' })
      ).resolves.toEqual([])
      expect(second.entry.projection.summary.title).toBe('chat revision 2')
      await worker.query({ method: 'release', leaseId: first.leaseId })
      await worker.query({ method: 'release', leaseId: second.leaseId })
    } finally {
      await worker.dispose()
    }
  })
})
