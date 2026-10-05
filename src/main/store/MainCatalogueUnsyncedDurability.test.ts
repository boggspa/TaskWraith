/**
 * The catalogue's publication writes made without a sync: a thread's head and
 * the tickets of its operations. Each is written and renamed into place as
 * before, and what the disk is owed is noted against the thread the file is
 * about. The second half runs a real catalogue over a model of a power loss,
 * read back by a resolver that makes the catalogue calls the history worker
 * makes when it indexes a thread.
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
  createThreadDurabilityDebt,
  type NoteThreadDurabilityDebt,
  type ThreadDurabilityDebt,
  type ThreadDurabilityDebtNote,
  type ThreadDurabilityPort
} from './ThreadDurabilityDebt'
import {
  countSyncs,
  watchCrashDisk,
  type CrashDisk,
  type SyncCount
} from './unsyncedWriteCrashDisk.testutil'

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

describe('catalogue publication that leaves syncing to the thread barrier', () => {
  let profile: string
  let directory: string
  let syncs: SyncCount
  let notes: Array<[string, ThreadDurabilityDebtNote]>
  const note: NoteThreadDurabilityDebt = (chatId, debt) => {
    notes.push([chatId, debt])
  }

  beforeEach(() => {
    profile = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-catalogue-unsynced-'))
    directory = path.join(profile, 'thread-catalogue-v1')
    syncs = countSyncs()
    notes = []
  })

  afterEach(() => {
    syncs.dispose()
    vi.restoreAllMocks()
    fs.rmSync(profile, { recursive: true, force: true })
  })

  const unsynced = (): MainCatalogueUnsyncedDurability =>
    new MainCatalogueUnsyncedDurability({ profilePath: profile, note })
  const head = (chatId = CHAT): string => path.join(directory, 'desktop', `${chatId}.json`)
  const ticketOf = (operationId: string, chatId = CHAT): string =>
    path.join(directory, 'pending', 'desktop', chatId, `${operationId}.json`)
  const owedHead = (chatId = CHAT): Array<[string, ThreadDurabilityDebtNote]> => [
    [chatId, { file: head(chatId), owner: 'catalogue' }],
    [chatId, { directory: path.join(directory, 'desktop') }]
  ]
  const owedTicket = (
    operationId: string,
    chatId = CHAT
  ): Array<[string, ThreadDurabilityDebtNote]> => [
    [chatId, { file: ticketOf(operationId, chatId), owner: 'catalogue' }],
    [chatId, { directory: path.join(directory, 'pending', 'desktop', chatId) }]
  ]

  describe('one write', () => {
    beforeEach(() => {
      fs.mkdirSync(path.join(directory, 'desktop'), { recursive: true })
      fs.mkdirSync(path.join(directory, 'pending', 'desktop', CHAT), { recursive: true })
      fs.mkdirSync(path.join(directory, 'resolved'), { recursive: true })
    })

    it('puts a head in place without a sync and notes it against its thread', () => {
      const order: string[] = []

      unsynced().write(
        head(),
        '{"phase":"pending"}',
        () => order.push('before'),
        () => order.push(`after:${notes.length}`)
      )

      expect(fs.readFileSync(head(), 'utf8')).toBe('{"phase":"pending"}')
      expect(fs.readdirSync(path.join(directory, 'desktop'))).toEqual([`${CHAT}.json`])
      expect(syncs.issued).toEqual([])
      expect(notes).toEqual(owedHead())
      // The bytes are visible and owed before any caller's callback runs after them.
      expect(order).toEqual(['before', 'after:2'])
    })

    it('notes a ticket against the thread whose directory holds it', () => {
      unsynced().write(ticketOf('operation-1'), '{"sequence":1}')

      expect(fs.readFileSync(ticketOf('operation-1'), 'utf8')).toBe('{"sequence":1}')
      expect(syncs.issued).toEqual([])
      expect(notes).toEqual(owedTicket('operation-1'))
    })

    it('replaces a head by a rename, so a reader sees the old one or the new one and never neither', () => {
      const writer = unsynced()
      writer.write(head(), '{"phase":"pending"}')
      const seen: string[] = []

      writer.write(head(), '{"phase":"durable"}', () => seen.push(fs.readFileSync(head(), 'utf8')))

      expect(seen).toEqual(['{"phase":"pending"}'])
      expect(fs.readFileSync(head(), 'utf8')).toBe('{"phase":"durable"}')
      expect(fs.readdirSync(path.join(directory, 'desktop'))).toEqual([`${CHAT}.json`])
      expect(notes).toEqual([...owedHead(), ...owedHead()])
      expect(writer.snapshot()).toEqual({ writes: 2, strictWrites: 0 })
    })

    it('writes a file that is not a head or a ticket the strict way, synced and not owed', () => {
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
      expect(notes).toEqual([])
      expect(writer.snapshot()).toEqual({ writes: 2, strictWrites: 2 })
    })

    it('writes a file in those directories that does not name a thread the strict way', () => {
      const writer = unsynced()

      writer.write(path.join(directory, 'desktop', '.json'), '{}')
      writer.write(path.join(directory, 'pending', 'desktop', CHAT, 'operation-1.txt'), '{}')

      expect(syncs.issued).toHaveLength(4)
      expect(notes).toEqual([])
      expect(writer.snapshot()).toEqual({ writes: 2, strictWrites: 2 })
    })

    it('leaves nothing behind, and owes nothing, when the rename is refused', () => {
      const writer = unsynced()

      expect(() =>
        writer.write(head(), '{}', () => {
          throw new Error('rename refused')
        })
      ).toThrow('rename refused')

      expect(fs.readdirSync(path.join(directory, 'desktop'))).toEqual([])
      expect(notes).toEqual([])
      expect(writer.snapshot()).toEqual({ writes: 0, strictWrites: 0 })
      // The next write is not held back by the last one.
      writer.write(head(), '{"phase":"pending"}')
      expect(notes).toEqual(owedHead())
    })

    it('owes the head even when the callback after the rename throws', () => {
      const writer = unsynced()
      const failure = new Error('callback failed')

      expect(() =>
        writer.write(head(), '{"phase":"pending"}', undefined, () => {
          throw failure
        })
      ).toThrow(failure)

      expect(fs.readFileSync(head(), 'utf8')).toBe('{"phase":"pending"}')
      expect(notes).toEqual(owedHead())
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
      notes.length = 0

      const ticket = publish(source, 2)

      expect(syncs.issued).toHaveLength(before)
      expect(notes).toEqual([...owedTicket(ticket.operationId), ...owedHead(), ...owedHead()])
      expect(fs.existsSync(ticketOf(ticket.operationId))).toBe(true)
    })

    it('a catalogue that syncs pays two syncs for each of the same three writes', () => {
      const { source } = catalogues(profile, undefined)
      source.registerWriter()
      publish(source, 1)
      const before = syncs.issued.length

      publish(source, 2)

      expect(syncs.issued).toHaveLength(before + 6)
      expect(notes).toEqual([])
    })

    it('publishes a long run on many threads without one sync once their directories are made', () => {
      const threads = Array.from({ length: 10 }, (_unused, index) => `chat-${index + 1}`)
      const { source } = catalogues(profile, unsynced())
      source.registerWriter()
      for (const chatId of threads) publish(source, 1, chatId)
      const before = syncs.issued.length
      notes.length = 0

      for (let revision = 2; revision <= 31; revision += 1) {
        for (const chatId of threads) publish(source, revision, chatId)
      }

      expect(syncs.issued).toHaveLength(before)
      // A ticket, a pending head and a settled head: each a file and a directory.
      expect(notes).toHaveLength(30 * threads.length * 6)
      // Each owed against the thread the file is about; the heads' directory
      // is the one every thread shares.
      for (const [chatId, debt] of notes) {
        const tickets = path.join(directory, 'pending', 'desktop', chatId)
        if ('file' in debt) {
          expect(debt.file === head(chatId) || path.dirname(debt.file) === tickets).toBe(true)
        } else {
          expect([path.join(directory, 'desktop'), tickets]).toContain(debt.directory)
        }
      }
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
      notes.length = 0
      const before = syncs.issued.length

      expect(resolve(resolver, 1)).toBe(true)
      source.holdRecovery({ chatId: 'held', token: 'token', hostIncarnation: 'incarnation' })
      const generation = source.beginErasure('erased')
      expect(source.finishErasure(generation, 'erased')).toBe(true)

      expect(notes).toEqual([])
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
    let debt: ThreadDurabilityDebt
    let source: ThreadCatalogue
    let resolver: Resolver
    /** Directory syncs paid through the ledger wait while this is set. */
    let directoriesHeld: Array<() => void> | null

    /** The disk's port, with a gate in front of its directory syncs. */
    const gatedPort = (): ThreadDurabilityPort => ({
      syncFile: (target) => disk.port.syncFile(target),
      syncDirectory: async (target) => {
        const held = directoriesHeld
        if (held) await new Promise<void>((resolve) => held.push(resolve))
        return disk.port.syncDirectory(target)
      }
    })

    beforeEach(() => {
      profile = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-catalogue-power-loss-'))
      disk = watchCrashDisk(profile)
      directoriesHeld = null
      debt = createThreadDurabilityDebt({ port: gatedPort() })
      ;({ source, resolver } = catalogues(
        profile,
        new MainCatalogueUnsyncedDurability({ profilePath: profile, note: debt.note })
      ))
      source.registerWriter()
    })

    afterEach(() => {
      disk.dispose()
      fs.rmSync(profile, { recursive: true, force: true })
    })

    const slot = (chatId = CHAT): string => path.join(source.directory, 'desktop', `${chatId}.json`)
    const ticketDirectory = (chatId = CHAT): string =>
      path.join(source.directory, 'pending', 'desktop', chatId)

    /**
     * The machine comes back: the old writer's process is gone, a new one
     * writes with a new id and a new ledger, and the resolver takes the old
     * writer as retired, as the history worker does.
     */
    const restart = (): void => {
      disk.powerLoss()
      debt = createThreadDurabilityDebt({ port: gatedPort() })
      ;({ source, resolver } = catalogues(
        profile,
        new MainCatalogueUnsyncedDurability({ profilePath: profile, note: debt.note }),
        { writerId: 'desktop-2', retired: ['desktop-1'] }
      ))
      source.registerWriter()
    }

    it('shows the resolved row again after a power loss once a barrier covered the head it resolved', async () => {
      publish(source, 1)
      await debt.barrier(CHAT)
      expect(index(resolver, 1)).toBe('ready')

      restart()

      expect(resolver.catalogue.read(CHAT)).toMatchObject({ status: 'ready' })
      expect(resolver.catalogue.repairChatIds()).toEqual([])
    })

    it('loses a head no barrier covered: the row resolved from the head before it is read again', async () => {
      publish(source, 1)
      await debt.barrier(CHAT)
      expect(index(resolver, 1)).toBe('ready')
      // A second publication, finished, with its barrier still to come.
      publish(source, 2)
      expect(resolver.catalogue.read(CHAT)).toMatchObject({ status: 'repair-pending' })

      restart()

      // The head is the one the barrier covered, and the row still names it.
      expect(resolver.catalogue.read(CHAT)).toMatchObject({
        status: 'ready',
        projection: { summary: { title: 'History at 1' } }
      })
      // The unsynced ticket is gone with its name; nothing is left to repair.
      expect(resolver.catalogue.repairChatIds()).toEqual([])

      // The next publication of the thread goes through as if nothing happened.
      publish(source, 3)
      await debt.barrier(CHAT)
      expect(index(resolver, 3)).toBe('ready')
      restart()
      expect(resolver.catalogue.read(CHAT)).toMatchObject({
        status: 'ready',
        projection: { summary: { title: 'History at 3' } }
      })
    })

    it('reports repair when the first head of a thread is lost, and the worker derives the row again at once', () => {
      publish(source, 1)
      // Resolved before any barrier: the resolution is written synced, the
      // head it names is not.
      expect(index(resolver, 1)).toBe('ready')

      restart()

      expect(fs.existsSync(slot())).toBe(false)
      expect(resolver.catalogue.read(CHAT)).toMatchObject({
        status: 'repair-pending',
        summary: { title: 'History at 1' }
      })
      // Nothing is pending: the worker's next import resolves the thread from its sources.
      expect(index(resolver, 1)).toBe('ready')
    })

    it('resolves a pending head left by a writer that died, once the worker has flushed the sources', async () => {
      publish(source, 1)
      await debt.barrier(CHAT)
      expect(index(resolver, 1)).toBe('ready')
      // A publication begins, and its head and ticket are paid; the process
      // dies before it finishes.
      const ticket = source.beginPublication(CHAT)
      await debt.barrier(CHAT)

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

    it('settles a head whose name another thread’s barrier made safe without its bytes, without waiting for that thread to be published again', async () => {
      for (const chatId of [CHAT, OTHER]) {
        publish(source, 1, chatId)
        await debt.barrier(chatId)
        expect(index(resolver, 1, chatId)).toBe('ready')
      }
      // The other thread publishes and is not paid; then this thread's
      // barrier syncs the heads' directory, which every thread shares.
      publish(source, 2, OTHER)
      publish(source, 2)
      await debt.barrier(CHAT)

      restart()

      expect(fs.readFileSync(slot(OTHER))).toHaveLength(0)
      expect(resolver.catalogue.read(OTHER)).toMatchObject({
        status: 'repair-pending',
        summary: { title: 'History at 1' }
      })
      // The damaged head is a debt the worker proves by flushing the sources.
      expect(resolver.catalogue.sourceDurabilityDebts(OTHER)).toHaveLength(1)
      expect(index(resolver, 1, OTHER)).toBe('ready')
      expect(index(resolver, 2)).toBe('ready')
    })

    it('loses a head replaced while the barrier that covered the one before it was syncing directories, and derives the thread again from its sources', async () => {
      publish(source, 1)
      await debt.barrier(CHAT)
      expect(index(resolver, 1)).toBe('ready')
      publish(source, 2)
      directoriesHeld = []
      let resolved = false
      const barrier = debt.barrier(CHAT).then(() => {
        resolved = true
      })
      await new Promise((resolve) => setImmediate(resolve))
      // The files are synced and the directories are not yet; the next
      // publication replaces the head and adds a ticket meanwhile.
      expect(directoriesHeld).toHaveLength(2)
      publish(source, 3)
      for (const release of directoriesHeld) release()
      directoriesHeld = null
      await barrier
      expect(resolved).toBe(true)

      restart()

      // The barrier resolved for the head at revision 2; the directory it
      // synced names the one at revision 3, whose bytes nobody synced.
      expect(fs.readFileSync(slot())).toHaveLength(0)
      const tickets = fs.readdirSync(ticketDirectory())
      expect(tickets).toHaveLength(1)
      expect(fs.readFileSync(path.join(ticketDirectory(), tickets[0]))).toHaveLength(0)
      expect(index(resolver, 3)).toBe('ready')
      expect(resolver.catalogue.repairChatIds()).toEqual([])
    })

    it('settles a ticket whose name reached the disk without its bytes, and removes it', async () => {
      publish(source, 1)
      await debt.barrier(CHAT)
      expect(index(resolver, 1)).toBe('ready')
      const ticket = source.beginPublication(CHAT)
      // A sync of the ticket's directory by someone else after its rename and
      // before the barrier that would have synced its bytes first: the
      // resolver's acknowledgement syncs that directory, for one.
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
