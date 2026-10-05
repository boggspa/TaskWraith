/**
 * The catalogue's publication writes made without a sync and owed to no
 * barrier: a thread's head and the tickets of its operations. Each is written
 * and renamed into place as before. The second half runs a real catalogue over
 * a model of a power loss, read back by a resolver that makes the catalogue
 * calls the history worker makes when it indexes a thread: what nothing made
 * safe is lost, or left without its bytes, and the thread is derived again
 * from its sources.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ThreadCatalogue,
  type ThreadCatalogueProjection,
  type ThreadCatalogueTicket
} from '../../host-shared/thread-catalogue/ThreadCatalogue'
import { MainCatalogueUnsyncedDurability } from './MainCatalogueUnsyncedDurability'
import {
  countSyncs,
  watchCrashDisk,
  type CrashDisk,
  type SyncCount
} from './unsyncedWriteCrashDisk.testutil'

/**
 * The prefix of every folder this file makes in the system's temporary folder.
 * A folder is removed only through the function below, which refuses anything
 * that is not one of them.
 */
const TEMPORARY_PREFIX = 'log-catalogue-unsynced-'

/** Remove, with all it holds, a folder made here by `mkdtempSync` with TEMPORARY_PREFIX. */
function removeTemporaryDirectory(directory: string): void {
  const temporary = os.tmpdir()
  const made = temporary + path.sep + TEMPORARY_PREFIX
  if (
    directory === temporary ||
    !directory.startsWith(made) ||
    directory.length <= made.length ||
    path.dirname(directory) !== temporary
  )
    throw new Error(`Refusing to remove ${directory}: not a folder this file made`)
  fs.rmSync(directory, { recursive: true, force: true })
}

const CHAT = 'chat-1'
const OTHER = 'chat-2'
const WITNESS = 'legacy:1;journal:1'

function projection(revision: number, chatId = CHAT): ThreadCatalogueProjection {
  return {
    revision,
    summary: {
      chatId,
      title: `History at ${revision}`,
      provider: 'claude',
      chatKind: 'single',
      scope: 'global',
      createdAt: 1,
      updatedAt: revision,
      archived: false,
      messageCount: revision,
      runCount: 0
    },
    recovery: {
      unsettledRuns: 0,
      ensembleWakeups: 0,
      soloWakeups: 0,
      workerEvents: 0,
      joinPolicies: 0,
      nextBlackboardExpiryAt: null
    }
  }
}

interface Resolver {
  catalogue: ThreadCatalogue
  /** Durability debts the resolver has proven by flushing the thread's sources. */
  proven: Set<string>
}

/**
 * A desktop source writer, and a resolver that reads what it publishes. The
 * resolver takes the writers it is told are retired as gone, as the history
 * worker does for a writer whose process has died.
 */
function catalogues(
  profile: string,
  unsynced: MainCatalogueUnsyncedDurability | undefined,
  options: { writerId?: string; retired?: readonly string[] } = {}
): { source: ThreadCatalogue; resolver: Resolver } {
  const writerId = options.writerId ?? 'desktop-1'
  const proven = new Set<string>()
  const make = (
    deferredDurability: MainCatalogueUnsyncedDurability | undefined,
    lifecycle: (writerId: string) => 'active' | 'retired'
  ): ThreadCatalogue =>
    new ThreadCatalogue({
      profilePath: profile,
      writer: 'desktop',
      writerId,
      canWrite: () => true,
      writerLifecycle: (_writer, id) => lifecycle(id),
      canPublishResolution: () => true,
      canErase: () => true,
      canManageRecoveryHolds: () => true,
      isSourceDurabilityProven: (_chatId, _epoch, debtId) => proven.has(debtId),
      isSourceWitnessCurrent: (_chatId, witness) => witness === WITNESS,
      isIndexedGenerationCommitted: () => true,
      deferredDurability
    })
  return {
    source: make(unsynced, () => 'active'),
    resolver: {
      catalogue: make(undefined, (id) => (options.retired?.includes(id) ? 'retired' : 'active')),
      proven
    }
  }
}

function finish(source: ThreadCatalogue, ticket: ThreadCatalogueTicket, revision: number): boolean {
  return source.finishPublication(
    ticket,
    {
      operationId: ticket.operationId,
      sequence: ticket.sequence,
      revision,
      sourceWitness: WITNESS
    },
    projection(revision, ticket.chatId)
  )
}

/** One publication by the source writer, begun and finished. */
function publish(source: ThreadCatalogue, revision: number, chatId = CHAT): ThreadCatalogueTicket {
  const ticket = source.beginPublication(chatId)
  expect(finish(source, ticket, revision)).toBe(true)
  return ticket
}

function resolve({ catalogue }: Resolver, revision: number, chatId = CHAT): boolean {
  return catalogue.publishResolution({
    chatId,
    epoch: catalogue.epoch(chatId),
    heads: catalogue.sourceHeads(chatId),
    sourceWitness: WITNESS,
    indexReference: { databaseId: 'database', generation: `generation-${revision}` },
    projection: projection(revision, chatId)
  })
}

/**
 * What the history worker's import makes of a thread, in the catalogue's
 * terms (`ThreadCatalogueWorkerService.importChat`): it flushes the thread's
 * sources to prove any durability debt it finds, gives up with
 * `source_unsettled` while a publication is still live (and tries again
 * after a wait that doubles from 100 ms to 5 s), and otherwise publishes a
 * resolution and acknowledges it, which removes the tickets it covers.
 */
function index(
  resolver: Resolver,
  revision: number,
  chatId = CHAT
): 'ready' | 'source_unsettled' | 'refused' | 'repair-pending' | 'erasing' {
  const { catalogue, proven } = resolver
  for (const debt of catalogue.sourceDurabilityDebts(chatId)) proven.add(debt)
  if (catalogue.publicationPending(chatId)) return 'source_unsettled'
  if (!resolve(resolver, revision, chatId)) return 'refused'
  const row = catalogue.read(chatId)
  if (row.status !== 'ready') return row.status
  expect(catalogue.acknowledgeResolution(chatId, row.publicationId)).toBe(true)
  return 'ready'
}

describe('catalogue publication that owes nothing to any barrier', () => {
  let profile: string
  let directory: string
  let syncs: SyncCount

  beforeEach(() => {
    profile = fs.mkdtempSync(path.join(os.tmpdir(), TEMPORARY_PREFIX))
    directory = path.join(profile, 'thread-catalogue-v1')
    syncs = countSyncs()
  })

  afterEach(() => {
    syncs.dispose()
    vi.restoreAllMocks()
    removeTemporaryDirectory(profile)
  })

  const unsynced = (): MainCatalogueUnsyncedDurability =>
    new MainCatalogueUnsyncedDurability({ profilePath: profile })
  const head = (chatId = CHAT): string => path.join(directory, 'desktop', `${chatId}.json`)
  const ticketOf = (operationId: string, chatId = CHAT): string =>
    path.join(directory, 'pending', 'desktop', chatId, `${operationId}.json`)

  describe('one write', () => {
    beforeEach(() => {
      fs.mkdirSync(path.join(directory, 'desktop'), { recursive: true })
      fs.mkdirSync(path.join(directory, 'pending', 'desktop', CHAT), { recursive: true })
      fs.mkdirSync(path.join(directory, 'resolved'), { recursive: true })
    })

    it('puts a head in place by a rename, without a sync', () => {
      const order: string[] = []

      unsynced().write(
        head(),
        '{"phase":"pending"}',
        () => order.push('before'),
        () => order.push('after')
      )

      expect(fs.readFileSync(head(), 'utf8')).toBe('{"phase":"pending"}')
      expect(fs.readdirSync(path.join(directory, 'desktop'))).toEqual([`${CHAT}.json`])
      expect(syncs.issued).toEqual([])
      expect(order).toEqual(['before', 'after'])
    })

    it('puts a ticket in place without a sync', () => {
      unsynced().write(ticketOf('operation-1'), '{"sequence":1}')

      expect(fs.readFileSync(ticketOf('operation-1'), 'utf8')).toBe('{"sequence":1}')
      expect(syncs.issued).toEqual([])
    })

    it('replaces a head by a rename, so a reader sees the old one or the new one and never neither', () => {
      const writer = unsynced()
      writer.write(head(), '{"phase":"pending"}')
      const seen: string[] = []

      writer.write(head(), '{"phase":"durable"}', () => seen.push(fs.readFileSync(head(), 'utf8')))

      expect(seen).toEqual(['{"phase":"pending"}'])
      expect(fs.readFileSync(head(), 'utf8')).toBe('{"phase":"durable"}')
      expect(fs.readdirSync(path.join(directory, 'desktop'))).toEqual([`${CHAT}.json`])
      expect(syncs.issued).toEqual([])
      expect(writer.snapshot()).toEqual({ writes: 2, strictWrites: 0 })
    })

    it('writes a file that is not a head or a ticket the strict way, synced', () => {
      const writer = unsynced()
      const hold = path.join(profile, 'thread-history-control-v1', 'recovery-holds', `${CHAT}.json`)
      fs.mkdirSync(path.dirname(hold), { recursive: true })

      writer.write(path.join(directory, 'resolved', `${CHAT}.json`), '{"resolved":true}')
      writer.write(hold, '{"held":true}')

      expect(fs.readFileSync(path.join(directory, 'resolved', `${CHAT}.json`), 'utf8')).toBe(
        '{"resolved":true}'
      )
      expect(fs.readFileSync(hold, 'utf8')).toBe('{"held":true}')
      // The file before its rename, and its directory after it, for each.
      expect(syncs.issued).toEqual(['fsyncSync', 'fsyncSync', 'fsyncSync', 'fsyncSync'])
      expect(writer.snapshot()).toEqual({ writes: 2, strictWrites: 2 })
    })

    it('writes a file in those directories that does not name a thread the strict way', () => {
      const writer = unsynced()

      writer.write(path.join(directory, 'desktop', '.json'), '{}')
      writer.write(path.join(directory, 'pending', 'desktop', CHAT, 'operation-1.txt'), '{}')

      expect(syncs.issued).toHaveLength(4)
      expect(writer.snapshot()).toEqual({ writes: 2, strictWrites: 2 })
    })

    it('leaves nothing behind when the rename is refused', () => {
      const writer = unsynced()

      expect(() =>
        writer.write(head(), '{}', () => {
          throw new Error('rename refused')
        })
      ).toThrow('rename refused')

      expect(fs.readdirSync(path.join(directory, 'desktop'))).toEqual([])
      expect(writer.snapshot()).toEqual({ writes: 0, strictWrites: 0 })
      // The next write is not held back by the last one.
      writer.write(head(), '{"phase":"pending"}')
      expect(fs.readFileSync(head(), 'utf8')).toBe('{"phase":"pending"}')
    })

    it('leaves the head in place when the callback after the rename throws', () => {
      const writer = unsynced()
      const failure = new Error('callback failed')

      expect(() =>
        writer.write(head(), '{"phase":"pending"}', undefined, () => {
          throw failure
        })
      ).toThrow(failure)

      expect(fs.readFileSync(head(), 'utf8')).toBe('{"phase":"pending"}')
      expect(fs.readdirSync(path.join(directory, 'desktop'))).toEqual([`${CHAT}.json`])
    })

    it('has nothing of its own to wait for', async () => {
      const writer = unsynced()
      writer.write(head(), '{"phase":"pending"}')

      await expect(writer.awaitDurable()).resolves.toBeUndefined()
      expect(syncs.issued).toEqual([])
    })
  })

  describe('under a real catalogue', () => {
    it('publishes a head and its ticket with no sync beyond the ones that make new directories', () => {
      const { source } = catalogues(profile, unsynced())
      source.registerWriter()
      publish(source, 1)
      const before = syncs.issued.length

      const ticket = publish(source, 2)

      expect(syncs.issued).toHaveLength(before)
      expect(fs.existsSync(ticketOf(ticket.operationId))).toBe(true)
    })

    it('a catalogue that syncs pays two syncs for each of the same three writes', () => {
      const { source } = catalogues(profile, undefined)
      source.registerWriter()
      publish(source, 1)
      const before = syncs.issued.length

      publish(source, 2)

      expect(syncs.issued).toHaveLength(before + 6)
    })

    it('publishes a long run on many threads without one sync once their directories are made', () => {
      const threads = Array.from({ length: 10 }, (_unused, index) => `chat-${index + 1}`)
      const { source } = catalogues(profile, unsynced())
      source.registerWriter()
      for (const chatId of threads) publish(source, 1, chatId)
      const before = syncs.issued.length

      for (let revision = 2; revision <= 31; revision += 1) {
        for (const chatId of threads) publish(source, revision, chatId)
      }

      // Neither a head nor a ticket, nor the heads' directory every thread shares.
      expect(syncs.issued).toHaveLength(before)
    })

    it('still syncs once on the calling thread when the resolver removed the thread’s ticket directory since the last publication', () => {
      const { source, resolver } = catalogues(profile, unsynced())
      source.registerWriter()
      publish(source, 1)
      expect(index(resolver, 1)).toBe('ready')
      expect(fs.existsSync(path.join(directory, 'pending', 'desktop', CHAT))).toBe(false)
      const before = syncs.issued.length

      publish(source, 2)

      // The catalogue makes the directory again, and syncs its parent itself,
      // before it hands the ticket to the seam.
      expect(syncs.issued).toHaveLength(before + 1)
    })

    it('keeps the controls, the resolution and the erasure fence on the strict route', () => {
      const { source, resolver } = catalogues(profile, unsynced())
      source.registerWriter()
      publish(source, 1)
      const before = syncs.issued.length

      expect(resolve(resolver, 1)).toBe(true)
      source.holdRecovery({ chatId: 'held', token: 'token', hostIncarnation: 'incarnation' })
      const generation = source.beginErasure('erased')
      expect(source.finishErasure(generation, 'erased')).toBe(true)

      // Each strict write syncs its file and its directory, and each new
      // directory on the way is synced in its parent.
      expect(syncs.issued.length).toBeGreaterThanOrEqual(before + 8)
      expect(resolver.catalogue.read(CHAT)).toMatchObject({ status: 'ready' })
    })
  })
})

describe.skipIf(process.platform === 'win32')(
  'what a power loss leaves of a catalogue that does not sync',
  () => {
    let profile: string
    let disk: CrashDisk
    let source: ThreadCatalogue
    let resolver: Resolver

    beforeEach(() => {
      profile = fs.mkdtempSync(path.join(os.tmpdir(), TEMPORARY_PREFIX))
      disk = watchCrashDisk(profile)
      ;({ source, resolver } = catalogues(
        profile,
        new MainCatalogueUnsyncedDurability({ profilePath: profile })
      ))
      source.registerWriter()
    })

    afterEach(() => {
      disk.dispose()
      removeTemporaryDirectory(profile)
    })

    const slot = (chatId = CHAT): string => path.join(source.directory, 'desktop', `${chatId}.json`)
    const heads = (): string => path.join(source.directory, 'desktop')
    const ticketDirectory = (chatId = CHAT): string =>
      path.join(source.directory, 'pending', 'desktop', chatId)

    /**
     * The machine comes back: the old writer's process is gone, a new one
     * writes with a new id, and the resolver takes the old writer as retired,
     * as the history worker does.
     */
    const restart = (): void => {
      disk.powerLoss()
      ;({ source, resolver } = catalogues(
        profile,
        new MainCatalogueUnsyncedDurability({ profilePath: profile }),
        { writerId: 'desktop-2', retired: ['desktop-1'] }
      ))
      source.registerWriter()
    }

    it('loses the heads and tickets nothing made safe, and the worker derives each thread again from its sources', () => {
      for (const chatId of [CHAT, OTHER]) {
        publish(source, 1, chatId)
        expect(index(resolver, 1, chatId)).toBe('ready')
      }
      publish(source, 2, OTHER)
      publish(source, 2)

      restart()

      // Nothing synced the heads' directory on any thread's behalf, so no
      // head's name was kept without its bytes.
      expect(fs.existsSync(slot())).toBe(false)
      expect(fs.existsSync(slot(OTHER))).toBe(false)
      expect(resolver.catalogue.read(CHAT)).toMatchObject({
        status: 'repair-pending',
        summary: { title: 'History at 1' }
      })
      expect(resolver.catalogue.repairChatIds()).toEqual([])
      expect(index(resolver, 2)).toBe('ready')
      expect(index(resolver, 2, OTHER)).toBe('ready')
    })

    it('keeps a head the system wrote out by itself, and reads the row resolved from it as ready again', () => {
      publish(source, 1)
      expect(index(resolver, 1)).toBe('ready')
      disk.flushedAnyway(slot())
      disk.flushedAnyway(heads())

      restart()

      expect(resolver.catalogue.read(CHAT)).toMatchObject({ status: 'ready' })
      expect(resolver.catalogue.repairChatIds()).toEqual([])
    })

    it('resolves a pending head left by a writer that died, once the worker has flushed the sources', () => {
      publish(source, 1)
      expect(index(resolver, 1)).toBe('ready')
      // A publication begins, the system writes out its head and its ticket by
      // itself, and the process dies before it finishes.
      const ticket = source.beginPublication(CHAT)
      for (const target of [
        slot(),
        heads(),
        path.join(ticketDirectory(), `${ticket.operationId}.json`),
        ticketDirectory()
      ])
        disk.flushedAnyway(target)

      restart()

      expect(resolver.catalogue.read(CHAT)).toMatchObject({ status: 'repair-pending' })
      expect(resolver.catalogue.sourceDurabilityDebts(CHAT)).toEqual([
        `pending:desktop-1:${ticket.operationId}`
      ])
      expect(resolver.catalogue.repairChatIds()).toEqual([CHAT])
      expect(index(resolver, 1)).toBe('ready')
      // The dead writer's ticket is acknowledged away.
      expect(resolver.catalogue.repairChatIds()).toEqual([])
    })

    it('settles a head whose name the system wrote out without its bytes', () => {
      publish(source, 1)
      expect(index(resolver, 1)).toBe('ready')
      publish(source, 2)
      disk.flushedAnyway(heads())

      restart()

      expect(fs.readFileSync(slot())).toHaveLength(0)
      expect(resolver.catalogue.read(CHAT)).toMatchObject({ status: 'repair-pending' })
      // The damaged head is a debt the worker proves by flushing the sources.
      expect(resolver.catalogue.sourceDurabilityDebts(CHAT)).toHaveLength(1)
      expect(index(resolver, 2)).toBe('ready')
      expect(resolver.catalogue.repairChatIds()).toEqual([])
    })

    it('settles a ticket whose name reached the disk without its bytes, and removes it', () => {
      publish(source, 1)
      expect(index(resolver, 1)).toBe('ready')
      const ticket = source.beginPublication(CHAT)
      // A sync of the ticket's directory by someone else before its bytes
      // reached the disk: the resolver's acknowledgement syncs that
      // directory, for one.
      disk.flushedAnyway(ticketDirectory())
      expect(finish(source, ticket, 2)).toBe(true)

      restart()

      const file = path.join(ticketDirectory(), `${ticket.operationId}.json`)
      expect(fs.readFileSync(file)).toHaveLength(0)
      expect(resolver.catalogue.read(CHAT)).toMatchObject({ status: 'repair-pending' })
      expect(resolver.catalogue.repairChatIds()).toEqual([CHAT])
      expect(index(resolver, 1)).toBe('ready')
      expect(fs.existsSync(file)).toBe(false)
      expect(resolver.catalogue.repairChatIds()).toEqual([])
    })
  }
)
