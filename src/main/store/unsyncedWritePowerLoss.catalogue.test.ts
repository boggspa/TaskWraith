/**
 * Whether a thread's barrier needs to pay for the thread's catalogue files.
 *
 * Suppose a barrier paid only a thread's sources, and never its catalogue head
 * or tickets. Then a power loss after the barrier could leave each catalogue
 * file in any state a file written without a sync can be left in, while the
 * sources the barrier paid stay as they are: the head gone, an older head, a
 * pending one, or a name without its bytes; a ticket gone, still there, or a
 * name without its bytes. Those states, in which the catalogue is older than
 * the sources, are the ones that paying the catalogue at barriers rules out.
 * Every other state a power loss leaves, it leaves whether the catalogue is
 * paid or not: a barrier pays the sources and the catalogue together, and
 * between barriers neither is paid.
 *
 * For each of those states, and for each row the resolver may have written
 * last before the power loss, this checks, with the real witness over the
 * thread's real source file and the real reader:
 * - a row the catalogue reads as ready describes the sources as they are;
 * - one import by the worker that starts after the power loss brings the
 *   thread back to ready, derived from its sources, with nothing left to
 *   repair.
 * It does the same where the last source write did not reach the disk while
 * the publication made for it did.
 *
 * Each state is lived through in a profile of its own, and the catalogue's
 * files are then put in that state directly. A power loss that rewrote the
 * source file would change its witness whatever it held, so every row would
 * read as stale and nothing here would be tested; the source file is never
 * touched once it is written.
 */
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ThreadCatalogue } from '../../host-shared/thread-catalogue/ThreadCatalogue'
import {
  ThreadCatalogueDiskReader,
  captureThreadCatalogueWitness,
  projectThreadCatalogueRecord
} from './ThreadCatalogueDiskReader'
import type { ChatRecord } from './types'

/**
 * The prefix of every folder this file makes in the system's temporary folder.
 * A folder is removed only through the function below, which refuses anything
 * that is not one of them.
 */
const TEMPORARY_PREFIX = 'log-catalogue-unpaid-'

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
const READER = { runtimeInstanceId: 'reader', segmented: false }

/** Where the source writer's head is, and every head it wrote, by name. */
const HEADS = [
  'gone',
  'first',
  'second, pending',
  'second',
  'third, pending',
  'third',
  'empty',
  'zeros',
  'torn'
] as const
type HeadState = (typeof HEADS)[number]
type Written = Extract<
  HeadState,
  'first' | 'second, pending' | 'second' | 'third, pending' | 'third'
>

const TICKETS = ['gone', 'whole', 'empty'] as const
type TicketState = (typeof TICKETS)[number]

/** Whether the third revision's write of the source file reached the disk. */
type Sources = 'kept' | 'lost'
/** The last row the resolver wrote before the power loss. */
type Row = 'first' | 'second' | 'third'

function record(revision: number): ChatRecord {
  return {
    appChatId: CHAT,
    title: `History at ${revision}`,
    scope: 'global',
    chatKind: 'single',
    provider: 'claude',
    createdAt: 1,
    updatedAt: revision,
    archived: false,
    persistenceRevision: revision,
    messages: [],
    runs: []
  } as ChatRecord
}

/** One profile, and what the catalogue held in it as the thread was lived through. */
class Profile {
  readonly proven = new Set<string>()
  readonly heads: Partial<Record<Written, Buffer>> = {}
  readonly tickets: Partial<Record<'second' | 'third', { file: string; bytes: Buffer }>> = {}
  readonly directory: string

  constructor(readonly location: string) {
    this.directory = `${location}/thread-catalogue-v1`
    fs.mkdirSync(`${location}/chats`, { recursive: true })
  }

  reader(): typeof READER & { profilePath: string } {
    return { profilePath: this.location, ...READER }
  }

  /** The source file, put in place by a rename as the app writes it. */
  writeSource(revision: number): void {
    const target = `${this.location}/chats/${CHAT}.json`
    fs.writeFileSync(`${target}.tmp`, JSON.stringify(record(revision)))
    fs.renameSync(`${target}.tmp`, target)
  }

  catalogue(writerId: string, retired: readonly string[] = []): ThreadCatalogue {
    return new ThreadCatalogue({
      profilePath: this.location,
      writer: 'desktop',
      writerId,
      canWrite: () => true,
      writerLifecycle: (_writer, id) => (retired.includes(id) ? 'retired' : 'active'),
      canPublishResolution: () => true,
      canErase: () => true,
      isSourceDurabilityProven: (_chatId, _epoch, debt) => this.proven.has(debt),
      isSourceWitnessCurrent: (chatId, witness) =>
        captureThreadCatalogueWitness(this.reader(), chatId).witness === witness,
      isIndexedGenerationCommitted: () => true
    })
  }

  /**
   * The history worker's import of the thread, in catalogue calls: prove
   * the debts it is shown by flushing the sources, give up while a
   * publication is live, and otherwise decode the sources, resolve and
   * acknowledge.
   */
  index(resolver: ThreadCatalogue): 'ready' | string {
    for (const debt of resolver.sourceDurabilityDebts(CHAT)) this.proven.add(debt)
    if (resolver.publicationPending(CHAT)) return 'source_unsettled'
    const heads = resolver.sourceHeads(CHAT)
    const epoch = resolver.epoch(CHAT)
    const decoded = new ThreadCatalogueDiskReader(this.reader()).read(CHAT)!
    const projection = projectThreadCatalogueRecord(decoded.persisted)
    const published = resolver.publishResolution({
      chatId: CHAT,
      epoch,
      heads,
      sourceWitness: decoded.source.witness,
      indexReference: { databaseId: 'database', generation: `g-${projection.revision}` },
      projection
    })
    const row = resolver.read(CHAT)
    if (!published || row.status !== 'ready') return `refused (${row.status})`
    if (!resolver.acknowledgeResolution(CHAT, row.publicationId)) return 'unacknowledged'
    return 'ready'
  }

  /**
   * The thread before the power loss: three publications by a running
   * writer, each after a write of the source file unless the third one's
   * was lost, and the resolver's rows up to `row`. Every head and ticket is
   * kept as it was written.
   */
  live(sources: Sources, row: Row): void {
    const writer = this.catalogue('desktop-1')
    const resolver = this.catalogue('desktop-1')
    writer.registerWriter()
    const head = `${this.directory}/desktop/${CHAT}.json`
    const publish = (revision: number, name: 'second' | 'third' | null): void => {
      const ticket = writer.beginPublication(CHAT)
      if (name) {
        this.heads[`${name}, pending`] = fs.readFileSync(head)
        const file = `${this.directory}/pending/desktop/${CHAT}/${ticket.operationId}.json`
        this.tickets[name] = { file, bytes: fs.readFileSync(file) }
      }
      expect(
        writer.finishPublication(
          ticket,
          {
            operationId: ticket.operationId,
            sequence: ticket.sequence,
            revision,
            sourceWitness: captureThreadCatalogueWitness(this.reader(), CHAT).witness
          },
          projectThreadCatalogueRecord(record(revision))
        )
      ).toBe(true)
    }

    this.writeSource(1)
    publish(1, null)
    this.heads.first = fs.readFileSync(head)
    expect(this.index(resolver)).toBe('ready')

    this.writeSource(2)
    publish(2, 'second')
    this.heads.second = fs.readFileSync(head)
    if (row !== 'first') expect(this.index(resolver)).toBe('ready')

    if (sources === 'kept') this.writeSource(3)
    publish(3, 'third')
    this.heads.third = fs.readFileSync(head)
    if (row === 'third') expect(this.index(resolver)).toBe('ready')
  }

  /** The catalogue as the power loss left it, one file at a time. */
  leave(head: HeadState, second: TicketState, third: TicketState): void {
    const slot = `${this.directory}/desktop/${CHAT}.json`
    const latest = this.heads.third!
    if (head === 'gone') fs.rmSync(slot, { force: true })
    else if (head === 'empty') fs.writeFileSync(slot, '')
    else if (head === 'zeros') fs.writeFileSync(slot, Buffer.alloc(latest.length))
    else if (head === 'torn') fs.writeFileSync(slot, latest.subarray(0, latest.length >> 1))
    else fs.writeFileSync(slot, this.heads[head]!)
    for (const [ticket, state] of [
      [this.tickets.second!, second],
      [this.tickets.third!, third]
    ] as const) {
      fs.rmSync(ticket.file, { force: true })
      if (state === 'gone') continue
      fs.mkdirSync(path.dirname(ticket.file), { recursive: true })
      fs.writeFileSync(ticket.file, state === 'whole' ? ticket.bytes : '')
    }
  }
}

describe.skipIf(process.platform === 'win32')(
  'catalogue files no barrier pays, after a power loss that kept what the barrier paid',
  () => {
    let root: string

    beforeAll(() => {
      // What is synced is not under test here: every state is put in place directly.
      for (const name of ['fsyncSync', 'fdatasyncSync'] as const)
        vi.spyOn(fs, name).mockImplementation(() => {})
      syncBuiltinESMExports()
    })

    afterAll(() => {
      vi.restoreAllMocks()
      syncBuiltinESMExports()
    })

    beforeEach(() => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), TEMPORARY_PREFIX))
    })

    afterEach(() => {
      removeTemporaryDirectory(root)
    })

    it.each<[Sources, Row, number]>([
      ['kept', 'first', 0],
      ['kept', 'second', 0],
      ['kept', 'third', 4],
      ['lost', 'first', 0],
      ['lost', 'second', 2]
    ])(
      'reads no row as ready that the sources disagree with, and settles the thread in one import (third source write %s, last row the %s)',
      (sources, row, readyAtOnce) => {
        const revision = sources === 'kept' ? 3 : 2
        const wrong: string[] = []
        const unsettled: string[] = []
        const ready: string[] = []
        let made = 0

        for (const head of HEADS) {
          for (const second of TICKETS) {
            for (const third of TICKETS) {
              const state = `head ${head}, second ticket ${second}, third ticket ${third}`
              const profile = new Profile(`${root}/state-${++made}`)
              profile.live(sources, row)
              profile.leave(head, second, third)
              // The machine is back: the writer that was running is gone.
              const resolver = profile.catalogue('desktop-2', ['desktop-1'])

              const before = resolver.read(CHAT)
              if (before.status === 'ready') {
                ready.push(state)
                if (before.projection.revision !== revision) wrong.push(state)
              }
              const result = profile.index(resolver)
              const after = resolver.read(CHAT)
              if (
                result !== 'ready' ||
                after.status !== 'ready' ||
                after.projection.revision !== revision ||
                after.projection.summary.title !== `History at ${revision}` ||
                resolver.repairChatIds().length > 0
              )
                unsettled.push(`${state}: ${result}`)
            }
          }
        }

        expect(made).toBe(HEADS.length * TICKETS.length * TICKETS.length)
        expect(wrong).toEqual([])
        expect(unsettled).toEqual([])
        // Rows that are ready at once are checked above, so the check is not empty.
        expect(ready).toHaveLength(readyAtOnce)
      }
    )
  }
)
