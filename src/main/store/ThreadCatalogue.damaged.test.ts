/**
 * A head or ticket whose name reached the disk and whose bytes did not: a
 * power loss leaves one when a catalogue file was written without a sync,
 * and disk damage can leave one on the strict path too. Every write puts a
 * whole file in place by a rename, so a file read whole that is not JSON at
 * all was never one a running writer is still writing. The resolver settles
 * it as it settles a dead writer's pending head: it proves the sources
 * durable, resolves, and the resolution removes a damaged ticket. A file it
 * cannot read, or one that parses into a shape it does not know, still holds
 * the thread. Every catalogue here writes the strict way.
 */
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ThreadCatalogue,
  type ThreadCatalogueProjection,
  type ThreadCatalogueTicket
} from './ThreadCatalogue'

const CHAT = 'chat'

function projection(revision = 1): ThreadCatalogueProjection {
  return {
    revision,
    summary: {
      chatId: CHAT,
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

/** What a power loss or the disk can leave in place of a file's bytes. */
type Damage = 'empty' | 'zeros' | 'torn'

function damage(file: string, how: Damage): void {
  const bytes = fs.readFileSync(file)
  fs.writeFileSync(
    file,
    how === 'empty'
      ? Buffer.alloc(0)
      : how === 'zeros'
        ? Buffer.alloc(bytes.length)
        : bytes.subarray(0, Math.floor(bytes.length / 2))
  )
}

describe('a catalogue head or ticket left without its bytes, on the strict path', () => {
  let profile: string
  let retired: Set<string>
  let proven: Set<string>
  /** Runs whenever the catalogue asks whether a debt is proven. */
  let whileProving: (() => void) | undefined
  /** Whether asking for this debt's proof throws, as a flush that failed does. */
  let proofFails: ((debt: string) => boolean) | undefined

  function catalogue(writerId = 'desktop-1'): ThreadCatalogue {
    return new ThreadCatalogue({
      profilePath: profile,
      writer: 'desktop',
      writerId,
      canWrite: () => true,
      writerLifecycle: (_lane, id) => (retired.has(id) ? 'retired' : 'active'),
      canPublishResolution: () => true,
      canErase: () => true,
      isSourceDurabilityProven: (_chatId, _epoch, id) => {
        whileProving?.()
        if (proofFails?.(id)) throw new Error('The thread’s sources could not be flushed')
        return proven.has(id)
      },
      isIndexedGenerationCommitted: () => true,
      isSourceWitnessCurrent: () => true
    })
  }

  function finish(store: ThreadCatalogue, ticket: ThreadCatalogueTicket, revision = 1): boolean {
    return store.finishPublication(
      ticket,
      { operationId: ticket.operationId, sequence: ticket.sequence, revision, sourceWitness: 'w' },
      projection(revision)
    )
  }

  /**
   * What the history worker's import does with the thread, in catalogue calls
   * (`ThreadCatalogueWorkerService.importChat`): flush the sources to prove the
   * durability debts it is shown, give up while a publication is live, and
   * otherwise resolve and acknowledge.
   */
  function index(resolver: ThreadCatalogue, revision = 1): 'ready' | 'source_unsettled' | string {
    for (const debt of resolver.sourceDurabilityDebts(CHAT)) proven.add(debt)
    if (resolver.publicationPending(CHAT)) return 'source_unsettled'
    const published = resolver.publishResolution({
      chatId: CHAT,
      epoch: resolver.epoch(CHAT),
      heads: resolver.sourceHeads(CHAT),
      sourceWitness: 'w',
      indexReference: { databaseId: 'database', generation: `generation-${revision}` },
      projection: projection(revision)
    })
    const row = resolver.read(CHAT)
    if (!published || row.status !== 'ready') return `refused (${row.status})`
    expect(resolver.acknowledgeResolution(CHAT, row.publicationId)).toBe(true)
    return 'ready'
  }

  beforeEach(() => {
    profile = fs.mkdtempSync(join(tmpdir(), 'thread-catalogue-damaged-'))
    retired = new Set()
    proven = new Set()
    whileProving = undefined
    proofFails = undefined
  })

  afterEach(() => {
    fs.rmSync(profile, { recursive: true, force: true })
  })

  const head = (store: ThreadCatalogue): string => join(store.directory, 'desktop', `${CHAT}.json`)
  const ticketFile = (store: ThreadCatalogue, ticket: ThreadCatalogueTicket): string =>
    join(store.directory, 'pending', 'desktop', CHAT, `${ticket.operationId}.json`)

  it.each<Damage>(['empty', 'zeros', 'torn'])(
    'settles a damaged head once the resolver has proven the sources (%s)',
    (how) => {
      const source = catalogue()
      source.registerWriter()
      expect(finish(source, source.beginPublication(CHAT))).toBe(true)
      const resolver = catalogue()
      expect(index(resolver)).toBe('ready')

      damage(head(source), how)

      expect(resolver.read(CHAT)).toMatchObject({ status: 'repair-pending' })
      expect(resolver.sourceHeads(CHAT).desktop).toBe('unreadable')
      expect(resolver.sourceDurabilityDebts(CHAT)).toHaveLength(1)
      expect(index(resolver)).toBe('ready')
      expect(resolver.read(CHAT)).toMatchObject({ status: 'ready' })
    }
  )

  it.each<Damage>(['empty', 'zeros', 'torn'])(
    'settles a damaged ticket, and the resolution removes it (%s)',
    (how) => {
      const source = catalogue()
      source.registerWriter()
      const ticket = source.beginPublication(CHAT)
      expect(finish(source, ticket)).toBe(true)
      const resolver = catalogue()

      damage(ticketFile(source, ticket), how)

      expect(resolver.repairChatIds()).toEqual([CHAT])
      expect(index(resolver)).toBe('ready')
      expect(fs.existsSync(ticketFile(source, ticket))).toBe(false)
      expect(resolver.repairChatIds()).toEqual([])
    }
  )

  it('settles a thread whose ticket and head were both left damaged by a writer that is gone', () => {
    const previous = catalogue()
    previous.registerWriter()
    const ticket = previous.beginPublication(CHAT)
    damage(ticketFile(previous, ticket), 'empty')
    damage(head(previous), 'empty')
    retired.add('desktop-1')
    const next = catalogue('desktop-2')
    next.registerWriter()

    expect(index(next)).toBe('ready')
    expect(next.repairChatIds()).toEqual([])
    // The next publication by the writer now running replaces the damaged head.
    expect(finish(next, next.beginPublication(CHAT), 2)).toBe(true)
    expect(next.sourceHeads(CHAT).desktop).not.toBe('unreadable')
    expect(index(next, 2)).toBe('ready')
  })

  it('keeps a running writer’s publication live while its ticket can be read, though its head is damaged', () => {
    const source = catalogue()
    source.registerWriter()
    const ticket = source.beginPublication(CHAT)
    const resolver = catalogue()

    damage(head(source), 'zeros')

    expect(index(resolver)).toBe('source_unsettled')
    expect(index(resolver)).toBe('source_unsettled')
    // The writer cannot confirm its own operation against a head it cannot
    // read, so its burst ends in repair, which settles the ticket.
    expect(finish(source, ticket)).toBe(false)
    source.settleLocalSource(ticket)
    source.retryPublication(CHAT)
    expect(index(resolver)).toBe('ready')
  })

  it('holds a thread while a running writer’s ticket waits and its head is damaged, until that writer publishes again or is gone', () => {
    const source = catalogue()
    source.registerWriter()
    expect(finish(source, source.beginPublication(CHAT))).toBe(true)
    const resolver = catalogue()

    damage(head(source), 'empty')

    // Nothing says whether that writer's operation is still under way.
    expect(index(resolver)).toBe('source_unsettled')
    retired.add('desktop-1')
    expect(index(resolver)).toBe('ready')
  })

  it('holds the thread, and keeps a damaged ticket, while its proof fails', () => {
    const source = catalogue()
    source.registerWriter()
    const ticket = source.beginPublication(CHAT)
    expect(finish(source, ticket)).toBe(true)
    const resolver = catalogue()
    damage(ticketFile(source, ticket), 'empty')
    proofFails = () => true

    expect(resolver.publicationPending(CHAT)).toBe(true)
    expect(index(resolver)).toBe('source_unsettled')
    expect(fs.existsSync(ticketFile(source, ticket))).toBe(true)

    proofFails = undefined
    expect(index(resolver)).toBe('ready')
    expect(fs.existsSync(ticketFile(source, ticket))).toBe(false)
  })

  it.each(['not proven', 'failing'] as const)(
    'removes with a resolution only the damaged tickets whose debt it proved (the other %s)',
    (other) => {
      const source = catalogue()
      source.registerWriter()
      const ticket = source.beginPublication(CHAT)
      expect(finish(source, ticket)).toBe(true)
      const resolver = catalogue()
      damage(ticketFile(source, ticket), 'empty')
      for (const debt of resolver.sourceDurabilityDebts(CHAT)) proven.add(debt)
      expect(
        resolver.publishResolution({
          chatId: CHAT,
          epoch: resolver.epoch(CHAT),
          heads: resolver.sourceHeads(CHAT),
          sourceWitness: 'w',
          indexReference: { databaseId: 'database', generation: 'generation-1' },
          projection: projection()
        })
      ).toBe(true)
      const row = resolver.read(CHAT)
      expect(row.status).toBe('ready')
      // Another ticket is left damaged after the acknowledgement has found the
      // thread ready and before it removes what that resolution covered.
      const late = join(source.directory, 'pending', 'desktop', CHAT, 'late-operation.json')
      whileProving = () => {
        if (!fs.existsSync(late)) fs.writeFileSync(late, '')
      }
      if (other === 'failing') proofFails = (debt) => !proven.has(debt)

      expect(
        resolver.acknowledgeResolution(CHAT, row.status === 'ready' ? row.publicationId : '')
      ).toBe(true)

      expect(fs.existsSync(ticketFile(source, ticket))).toBe(false)
      expect(fs.existsSync(late)).toBe(true)
      expect(resolver.repairChatIds()).toEqual([CHAT])
    }
  )

  it('needs a proof of its own for each damaged file', () => {
    const source = catalogue()
    source.registerWriter()
    expect(finish(source, source.beginPublication(CHAT))).toBe(true)
    const resolver = catalogue()
    expect(index(resolver)).toBe('ready')
    damage(head(source), 'empty')
    expect(index(resolver)).toBe('ready')
    const first = resolver.sourceDurabilityDebts(CHAT)

    expect(finish(source, source.beginPublication(CHAT), 2)).toBe(true)
    expect(index(resolver, 2)).toBe('ready')
    damage(head(source), 'empty')

    const second = resolver.sourceDurabilityDebts(CHAT)
    expect(second).toHaveLength(1)
    expect(second).not.toEqual(first)
    expect(resolver.publicationPending(CHAT)).toBe(true)
    expect(index(resolver, 2)).toBe('ready')
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'still holds a thread whose head it cannot read at all',
    () => {
      const source = catalogue()
      source.registerWriter()
      expect(finish(source, source.beginPublication(CHAT))).toBe(true)
      const resolver = catalogue()
      expect(index(resolver)).toBe('ready')
      fs.chmodSync(head(source), 0o000)
      try {
        expect(resolver.sourceDurabilityDebts(CHAT)).toEqual([])
        expect(index(resolver)).toBe('source_unsettled')
        expect(resolver.read(CHAT)).toMatchObject({ status: 'repair-pending' })
      } finally {
        fs.chmodSync(head(source), 0o600)
      }
      expect(index(resolver)).toBe('ready')
    }
  )

  it('still holds a thread whose head parses into a shape it does not know', () => {
    const source = catalogue()
    source.registerWriter()
    expect(finish(source, source.beginPublication(CHAT))).toBe(true)
    const resolver = catalogue()
    fs.writeFileSync(head(source), JSON.stringify({ version: 2, phase: 'superseded' }))

    expect(resolver.sourceDurabilityDebts(CHAT)).toEqual([])
    expect(index(resolver)).toBe('source_unsettled')
    expect(index(resolver)).toBe('source_unsettled')
  })

  it('still holds a thread whose ticket parses into a shape it does not know', () => {
    const source = catalogue()
    source.registerWriter()
    const ticket = source.beginPublication(CHAT)
    expect(finish(source, ticket)).toBe(true)
    const resolver = catalogue()
    fs.writeFileSync(ticketFile(source, ticket), JSON.stringify({ operationOrdinal: 'one' }))

    expect(index(resolver)).toBe('source_unsettled')
    expect(fs.existsSync(ticketFile(source, ticket))).toBe(true)
    expect(resolver.repairChatIds()).toEqual([CHAT])
  })
})
