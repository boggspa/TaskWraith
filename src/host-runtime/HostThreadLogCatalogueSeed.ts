/**
 * Seeds for the Host's thread log followers, through the thread catalogue's
 * decoder. The decoder reads the thread off the Host loop, in its worker, the
 * way the app's own load builds the record (the checkpoint and the longest
 * chain of lines from it, or the full copy where that is newer), and the
 * record comes back in chunks. Only the parse of those bytes runs on the Host
 * loop, as the parse of a full copy does today.
 *
 * The catalogue hands back the record it decoded last until it has imported
 * a change to the thread's files, which it puts off while they keep changing.
 * A record behind the log's checkpoint did not come from the log as it is
 * now: the follower would refuse it and wait for the next compaction. So it is
 * refused here instead, the catalogue is told that the thread changed, and the
 * follower asks again at its next poll.
 */
import { createHash } from 'node:crypto'

import type {
  ThreadCatalogueOpenResult,
  ThreadCatalogueQuery,
  ThreadIndexedObject,
  ThreadIndexedObjectRef
} from '../shared/threadCatalogueTypes'
import type {
  HostThreadLogRecord,
  HostThreadLogSeedPort,
  HostThreadLogSeedRequest
} from './HostThreadLogFollower'
import { readThreadLogCheckpoint } from './HostThreadLogHead'

/** The part of the thread catalogue's client a seed reads through. */
export interface HostThreadLogSeedCatalogue {
  readonly available: boolean
  query<T>(query: ThreadCatalogueQuery): Promise<T>
}

export interface HostThreadLogCatalogueSeedOptions {
  readonly catalogue: HostThreadLogSeedCatalogue
  /** The journal's directory: `<profile>/chat-journal-v2`. */
  readonly directory: string
}

export interface HostThreadLogCatalogueSeedStats {
  readonly asked: number
  readonly records: number
  /** Threads with no checkpoint, and so no log to follow. */
  readonly noLog: number
  /** Records refused because they were behind the log's checkpoint. */
  readonly behindCheckpoint: number
  readonly failures: number
  /** Bytes of the records that came back in chunks. */
  readonly chunkedBytes: number
}

function revisionOf(record: { readonly persistenceRevision?: unknown }): number {
  const revision = record.persistenceRevision
  return Number.isSafeInteger(revision) && (revision as number) >= 0 ? (revision as number) : 0
}

function isRecordOf(value: unknown, chatId: string): value is HostThreadLogRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return record.appChatId === chatId && Array.isArray(record.messages) && Array.isArray(record.runs)
}

export class HostThreadLogCatalogueSeed implements HostThreadLogSeedPort {
  private asked = 0
  private records = 0
  private noLog = 0
  private behindCheckpoint = 0
  private failures = 0
  private chunkedBytes = 0

  constructor(private readonly options: HostThreadLogCatalogueSeedOptions) {}

  async seed(request: HostThreadLogSeedRequest): Promise<HostThreadLogRecord | null> {
    this.asked += 1
    try {
      return await this.load(request.chatId)
    } catch (error) {
      this.failures += 1
      throw error
    }
  }

  stats(): HostThreadLogCatalogueSeedStats {
    return {
      asked: this.asked,
      records: this.records,
      noLog: this.noLog,
      behindCheckpoint: this.behindCheckpoint,
      failures: this.failures,
      chunkedBytes: this.chunkedBytes
    }
  }

  private async load(chatId: string): Promise<HostThreadLogRecord | null> {
    // Read before the record, so that a record at least this new is one the
    // follower, which read the checkpoint before it asked, will take.
    const checkpoint = await readThreadLogCheckpoint(this.options.directory, chatId)
    if (checkpoint.kind === 'none') {
      this.noLog += 1
      return null
    }
    if (checkpoint.kind === 'unreadable') {
      throw new Error(`The thread log's checkpoint is unreadable: ${checkpoint.reason}`)
    }
    const catalogue = this.options.catalogue
    if (!catalogue.available) throw new Error('The thread catalogue is unavailable')
    const opened = await catalogue.query<ThreadCatalogueOpenResult | null>({
      method: 'open',
      chatId,
      mode: 'record'
    })
    if (!opened) throw new Error('The thread catalogue has no record of this thread')
    let value: unknown
    try {
      const objects = await catalogue.query<ThreadIndexedObject[] | null>({
        method: 'objects',
        leaseId: opened.leaseId,
        kind: 'record',
        before: 1,
        maxObjects: 1
      })
      const item = objects?.[0]
      if (!item) throw new Error('The thread catalogue holds no record of this thread')
      value =
        item.kind === 'inline' ? item.value : await this.chunked(opened.leaseId, item.reference)
    } finally {
      // The catalogue lets a lease go on its own in time; this only saves it the wait.
      void catalogue.query({ method: 'release', leaseId: opened.leaseId }).catch(() => undefined)
    }
    if (!isRecordOf(value, chatId)) {
      throw new Error('The thread catalogue returned something other than this thread')
    }
    if (revisionOf(value) < checkpoint.revision) {
      this.behindCheckpoint += 1
      void catalogue.query({ method: 'changed', chatId }).catch(() => undefined)
      throw new Error("The thread catalogue's record is behind the log's checkpoint; ask again")
    }
    this.records += 1
    return value
  }

  private async chunked(leaseId: string, reference: ThreadIndexedObjectRef): Promise<unknown> {
    const bytes = Buffer.alloc(reference.byteLength)
    const digest = createHash('sha256')
    let offset = 0
    while (offset < reference.byteLength) {
      const chunk = await this.options.catalogue.query<Uint8Array | null>({
        method: 'chunk',
        leaseId,
        reference,
        offset
      })
      if (!chunk?.byteLength || offset + chunk.byteLength > reference.byteLength) {
        throw new Error("The thread catalogue's record is incomplete")
      }
      bytes.set(chunk, offset)
      digest.update(chunk)
      offset += chunk.byteLength
    }
    if (digest.digest('hex') !== reference.sha256) {
      throw new Error("The thread catalogue's record changed while it was read")
    }
    this.chunkedBytes += reference.byteLength
    return JSON.parse(bytes.toString('utf8')) as unknown
  }
}
