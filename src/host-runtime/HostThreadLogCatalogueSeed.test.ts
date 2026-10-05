/**
 * Seeds through the thread catalogue: the protocol against a catalogue that
 * answers as the worker does, then the real worker service and decoder over a
 * journal the app's own code wrote.
 */
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { buildSync } from 'esbuild'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  THREAD_LOG_BATCH_FORMAT,
  THREAD_LOG_BATCH_VERSION
} from '../host-shared/thread-log/ThreadLogBatch'
import { deriveChatRecordMutation } from '../main/store/ChatRecordMutation'
import { createIncrementalChatJournal } from '../main/store/IncrementalChatJournal'
import { ThreadCatalogueWorkerService } from '../main/store/ThreadCatalogueWorkerService'
import type { ChatRecord } from '../main/store/types'
import type { ThreadCatalogueQuery, ThreadIndexedObjectRef } from '../shared/threadCatalogueTypes'
import {
  HostThreadLogCatalogueSeed,
  type HostThreadLogSeedCatalogue
} from './HostThreadLogCatalogueSeed'
import { HostThreadLogFollower } from './HostThreadLogFollower'

/**
 * The prefix of every folder this file makes in the system's temporary folder.
 * A folder is removed only through the function below, which refuses anything
 * that is not one of them.
 */
const TEMPORARY_PREFIX = 'host-log-catalogue-seed-'

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
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}

const CHAT = 'chat-1'
const AT = '2026-10-05T00:00:00.000Z'

let root = ''
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), TEMPORARY_PREFIX))
})
afterEach(() => {
  removeTemporaryDirectory(root)
})

function record(revision: number, extra: Partial<ChatRecord> = {}): ChatRecord {
  return {
    appChatId: CHAT,
    title: 'Thread',
    createdAt: 1,
    updatedAt: revision,
    archived: false,
    persistenceRevision: revision,
    messages: [{ id: 'm1', role: 'user', content: 'hello', timestamp: AT }],
    runs: [],
    ...extra
  }
}

/** A checkpoint file as the journal writes one: its fields, then its record. */
function writeCheckpoint(directory: string, revision: number): void {
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(
    path.join(directory, `${CHAT}.checkpoint.json`),
    JSON.stringify({
      format: 'taskwraith-chat-checkpoint',
      version: 1,
      chatId: CHAT,
      revision,
      savedAt: AT,
      reason: 'compaction',
      record: record(revision)
    })
  )
}

/** A catalogue that answers as the worker does, and keeps every query. */
function catalogueOf(
  answers: Partial<Record<ThreadCatalogueQuery['method'], (query: never) => unknown>>,
  available = true
): HostThreadLogSeedCatalogue & { readonly queries: ThreadCatalogueQuery[] } {
  const queries: ThreadCatalogueQuery[] = []
  return {
    queries,
    available,
    async query<T>(query: ThreadCatalogueQuery): Promise<T> {
      // A seed that never stops asking fails here rather than running forever.
      if (queries.length >= 10_000) throw new Error('asked too often')
      queries.push(query)
      const answer = answers[query.method]
      if (!answer) throw new Error(`unexpected ${query.method}`)
      return (await answer(query as never)) as T
    }
  }
}

const opened = { leaseId: 'lease-1', entry: {} }
const methods = (catalogue: { queries: ThreadCatalogueQuery[] }): string[] =>
  catalogue.queries.map((query) => query.method)

/** A record as the catalogue keeps a large one: in pieces, with a digest of the whole. */
function chunkedOf(value: unknown, size: number, digest?: string) {
  const bytes = Buffer.from(JSON.stringify(value), 'utf8')
  const reference: ThreadIndexedObjectRef = {
    chatId: CHAT,
    generation: 'g1',
    kind: 'record',
    ordinal: 0,
    byteLength: bytes.byteLength,
    sha256: digest ?? createHash('sha256').update(bytes).digest('hex')
  }
  return {
    item: { kind: 'chunked' as const, ordinal: 0, reference, preview: null },
    chunk: (query: { offset: number }) =>
      new Uint8Array(bytes.subarray(query.offset, query.offset + size))
  }
}

describe('a thread log seed from the thread catalogue', () => {
  it('is null, and asks the catalogue nothing, for a thread with no log', async () => {
    const catalogue = catalogueOf({})
    const seed = new HostThreadLogCatalogueSeed({ catalogue, directory: root })
    expect(await seed.seed({ chatId: CHAT, reason: 'cold' })).toBeNull()
    expect(catalogue.queries).toEqual([])
    expect(seed.stats()).toMatchObject({ asked: 1, noLog: 1, records: 0 })
  })

  it('is the record the catalogue decoded, at or past the checkpoint, with its lease let go', async () => {
    writeCheckpoint(root, 5)
    const value = record(5)
    const catalogue = catalogueOf({
      open: () => opened,
      objects: () => [{ kind: 'inline', ordinal: 0, value, byteLength: 1, sha256: '' }],
      release: () => true
    })
    const seed = new HostThreadLogCatalogueSeed({ catalogue, directory: root })
    expect(await seed.seed({ chatId: CHAT, reason: 'cold' })).toEqual(value)
    expect(catalogue.queries).toEqual([
      { method: 'open', chatId: CHAT, mode: 'record' },
      { method: 'objects', leaseId: 'lease-1', kind: 'record', before: 1, maxObjects: 1 },
      { method: 'release', leaseId: 'lease-1' }
    ])
    expect(seed.stats()).toMatchObject({ asked: 1, records: 1, failures: 0 })
  })

  it('puts a record that came in pieces back together, and checks it whole', async () => {
    writeCheckpoint(root, 5)
    const value = record(6, {
      messages: [{ id: 'm1', role: 'user', content: 'é😀'.repeat(50), timestamp: AT }]
    })
    const whole = chunkedOf(value, 7)
    const catalogue = catalogueOf({
      open: () => opened,
      objects: () => [whole.item],
      chunk: whole.chunk,
      release: () => true
    })
    const seed = new HostThreadLogCatalogueSeed({ catalogue, directory: root })
    expect(await seed.seed({ chatId: CHAT, reason: 'requested' })).toEqual(value)
    expect(seed.stats().chunkedBytes).toBe(whole.item.reference.byteLength)
    expect(methods(catalogue).filter((method) => method === 'chunk').length).toBe(
      Math.ceil(whole.item.reference.byteLength / 7)
    )
    expect(methods(catalogue).at(-1)).toBe('release')
  })

  it('refuses pieces that do not add up to the record, and still lets the lease go', async () => {
    writeCheckpoint(root, 5)
    const value = record(6)
    const cases: Array<[string, Record<string, (query: never) => unknown>, RegExp]> = [
      [
        'changed',
        (() => {
          const whole = chunkedOf(value, 9, 'f'.repeat(64))
          return { objects: () => [whole.item], chunk: whole.chunk }
        })(),
        /changed while it was read/
      ],
      [
        'empty piece',
        (() => {
          const whole = chunkedOf(value, 9)
          return { objects: () => [whole.item], chunk: () => new Uint8Array(0) }
        })(),
        /incomplete/
      ],
      [
        'piece past the end',
        (() => {
          const whole = chunkedOf(value, 9)
          return {
            objects: () => [whole.item],
            chunk: () => new Uint8Array(whole.item.reference.byteLength + 1)
          }
        })(),
        /incomplete/
      ],
      ['no record', { objects: () => [] }, /holds no record/],
      [
        'another thread',
        {
          objects: () => [
            {
              kind: 'inline',
              ordinal: 0,
              value: { ...value, appChatId: 'chat-2' },
              byteLength: 1,
              sha256: ''
            }
          ]
        },
        /other than this thread/
      ]
    ]
    for (const [name, answers, error] of cases) {
      const catalogue = catalogueOf({ open: () => opened, release: () => true, ...answers })
      const seed = new HostThreadLogCatalogueSeed({ catalogue, directory: root })
      await expect(seed.seed({ chatId: CHAT, reason: 'cold' }), name).rejects.toThrow(error)
      expect(methods(catalogue).at(-1), name).toBe('release')
      expect(seed.stats(), name).toMatchObject({ failures: 1, records: 0 })
    }
  })

  it('takes a record behind the log’s newest line, which the follower brings up to date', async () => {
    writeCheckpoint(root, 5)
    // The active segment's last line is at 9; the catalogue decoded the log at 7.
    fs.writeFileSync(
      path.join(root, `${CHAT}.mutations.jsonl`),
      [6, 7, 8, 9]
        .map(
          (revision) =>
            `${JSON.stringify({
              format: THREAD_LOG_BATCH_FORMAT,
              version: THREAD_LOG_BATCH_VERSION,
              chatId: CHAT,
              baseRevision: revision - 1,
              revision,
              savedAt: AT,
              operations: []
            })}\n`
        )
        .join('')
    )
    const catalogue = catalogueOf({
      open: () => opened,
      objects: () => [{ kind: 'inline', ordinal: 0, value: record(7), byteLength: 1, sha256: '' }],
      release: () => true
    })
    const seed = new HostThreadLogCatalogueSeed({ catalogue, directory: root })
    expect(await seed.seed({ chatId: CHAT, reason: 'cold' })).toEqual(record(7))
    expect(seed.stats()).toMatchObject({ records: 1, behindCheckpoint: 0 })
  })

  it('refuses a record behind the checkpoint, and tells the catalogue the thread changed', async () => {
    writeCheckpoint(root, 9)
    const catalogue = catalogueOf({
      open: () => opened,
      objects: () => [{ kind: 'inline', ordinal: 0, value: record(8), byteLength: 1, sha256: '' }],
      release: () => true,
      changed: () => true
    })
    const seed = new HostThreadLogCatalogueSeed({ catalogue, directory: root })
    await expect(seed.seed({ chatId: CHAT, reason: 'checkpoint-passed' })).rejects.toThrow(
      /behind the log's checkpoint; ask again/
    )
    expect(catalogue.queries).toContainEqual({ method: 'changed', chatId: CHAT })
    expect(seed.stats()).toMatchObject({ behindCheckpoint: 1, failures: 1, records: 0 })
  })

  it('fails, for the follower to ask again, when the catalogue or the log cannot answer', async () => {
    writeCheckpoint(root, 5)
    const closed = catalogueOf({}, false)
    await expect(
      new HostThreadLogCatalogueSeed({ catalogue: closed, directory: root }).seed({
        chatId: CHAT,
        reason: 'cold'
      })
    ).rejects.toThrow(/unavailable/)
    expect(closed.queries).toEqual([])
    const missing = catalogueOf({ open: () => null })
    await expect(
      new HostThreadLogCatalogueSeed({ catalogue: missing, directory: root }).seed({
        chatId: CHAT,
        reason: 'cold'
      })
    ).rejects.toThrow(/no record of this thread/)
    // A checkpoint that is there and cannot be read is not "no log".
    fs.writeFileSync(path.join(root, `${CHAT}.checkpoint.json`), '{"format":"other"')
    const unread = catalogueOf({})
    await expect(
      new HostThreadLogCatalogueSeed({ catalogue: unread, directory: root }).seed({
        chatId: CHAT,
        reason: 'cold'
      })
    ).rejects.toThrow(/checkpoint is unreadable/)
    expect(unread.queries).toEqual([])
  })
})

describe('a thread log seed through the real catalogue worker and decoder', () => {
  /** The journal as the app writes it, and the Host's full copy at the grant. */
  function writeThread(profile: string, last: number, size: number): ChatRecord {
    const directory = path.join(profile, 'chat-journal-v2')
    fs.mkdirSync(path.join(profile, 'chats'), { recursive: true })
    let current = record(1, { messages: [] })
    fs.writeFileSync(path.join(profile, 'chats', `${CHAT}.json`), JSON.stringify(current))
    const journal = createIncrementalChatJournal(directory, {
      noteDurabilityDebt: () => {},
      syncDirectory: () => Promise.resolve(),
      canRepairOnRead: () => false,
      repairTornTailBeforeAppend: true
    })
    journal.initialize(CHAT, current)
    for (let revision = 2; revision <= last; revision += 1) {
      const next: ChatRecord = {
        ...current,
        updatedAt: revision,
        persistenceRevision: revision,
        messages: [
          ...current.messages,
          {
            id: `m${revision}`,
            role: revision % 2 === 0 ? 'user' : 'assistant',
            content: `${revision} `.padEnd(size, '.'),
            timestamp: AT
          }
        ]
      }
      journal.append(
        deriveChatRecordMutation(current, next, {
          savedAt: new Date(Date.parse(AT) + revision * 1000).toISOString()
        })
      )
      current = next
    }
    return current
  }

  async function throughDecoder(last: number, size: number, chunked: boolean): Promise<void> {
    const decoderPath = path.join(root, 'decoder.cjs')
    buildSync({
      entryPoints: [path.join(__dirname, '..', 'main', 'workers', 'threadCatalogueDecoder.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: decoderPath,
      logLevel: 'silent'
    })
    const profile = path.join(root, 'profile')
    const written = writeThread(profile, last, size)
    const directory = path.join(profile, 'chat-journal-v2')
    const service = new ThreadCatalogueWorkerService({
      reader: { profilePath: profile, runtimeInstanceId: 'runtime', segmented: false },
      decoderPath,
      writer: 'host',
      writerId: 'host-1',
      writerLifecycle: () => 'active'
    })
    try {
      const catalogue: HostThreadLogSeedCatalogue = {
        available: true,
        query: <T>(query: ThreadCatalogueQuery) => service.query(query) as Promise<T>
      }
      const seed = new HostThreadLogCatalogueSeed({ catalogue, directory })
      const seeded = (await seed.seed({ chatId: CHAT, reason: 'cold' }))!
      // The app's own load at the head of the log, past the full copy's revision.
      const load = createIncrementalChatJournal(directory, {
        noteDurabilityDebt: () => {},
        canWrite: () => false
      }).replay(CHAT).record!
      expect(load.persistenceRevision).toBe(last)
      expect(seeded.persistenceRevision).toBe(last)
      expect(seeded.messages).toEqual(load.messages)
      expect(seeded.messages).toEqual(written.messages)
      expect(seeded.runs).toEqual(load.runs)
      expect(seed.stats().chunkedBytes > 0).toBe(chunked)

      // A follower takes it as its view, and passes the lines it already holds.
      const follower = new HostThreadLogFollower({ chatId: CHAT, directory, seedPort: seed })
      try {
        let result = await follower.poll()
        for (let polls = 1; result.status === 'following' && !result.caughtUp; polls += 1) {
          if (polls > 20) throw new Error('the follower never caught up')
          result = await follower.poll()
        }
        expect(result).toMatchObject({ status: 'following', revision: last, caughtUp: true })
        expect(follower.stats()).toMatchObject({ seeds: { cold: 1 }, batchesApplied: 0 })
        expect(follower.view()!.messages.at(-1)).toEqual(written.messages.at(-1))
      } finally {
        follower.close()
      }
    } finally {
      await service.dispose()
    }
  }

  it('is the app’s own load at the head of the log, for a record that comes back whole', async () => {
    await throughDecoder(40, 200, false)
  }, 60_000)

  it('is the app’s own load at the head of the log, for a record that comes back in pieces', async () => {
    await throughDecoder(30, 96 * 1024, true)
  }, 60_000)
})
