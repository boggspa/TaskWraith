/**
 * Reads the batches a dead writer's log holds above the Host's full copy, for
 * the `fold-owned-log` wire. Nothing here writes or repairs: the segment
 * readers hold read-only descriptors and every batch is validated with
 * `isThreadLogBatch` before it is allowed onto the wire, so a torn or foreign
 * line refuses the fold instead of crossing it.
 *
 * A log that cannot be read is left unresolved: `corrupt`, `gap` and
 * `unreadable` outcomes never produce a batch list. A log longer than one
 * request carries is handed back as its oldest whole prefix with `complete:
 * false`: the caller folds and adopts that prefix, which moves the full copy,
 * and reads again from there. Only a single batch larger than the budget is
 * `oversize` — the caller must never truncate a batch to make it fit.
 */
import { isThreadLogBatch } from '../thread-log/ThreadLogBatch'
import {
  openThreadLogSegmentReader,
  type ThreadLogSegmentReader
} from '../thread-log/ThreadLogSegmentReader'
import { threadLogFiles } from '../thread-log/ThreadLogFiles'
import type { ThreadFoldLogBatch } from '../../shared/threadCatalogueTypes'

export type ThreadFoldLogRead =
  | {
      kind: 'log'
      /** Batches above `fullCopyRevision`, oldest first; every link was checked by the reader. */
      batches: ThreadFoldLogBatch[]
      /** The log's head: the last batch's revision, which the folded record must carry. */
      headRevision: number
      /** The log's own timestamp: the last batch's `savedAt`, preserved by the fold. */
      updatedAt: string
      /** False when more batches follow this prefix: fold it, then read again. */
      complete: boolean
    }
  | { kind: 'none' }
  | { kind: 'unreadable'; reason: string }
  | { kind: 'oversize'; bytes: number; limit: number }
  | { kind: 'corrupt' | 'gap' }

export interface ThreadFoldLogSourceOptions {
  /** The journal's directory (`<profile>/chat-journal-v2`). */
  directory: string
  chatId: string
  /** Revision of the full copy the log is folded onto; earlier batches are passed over. */
  fullCopyRevision: number
  /** Serialized-byte ceiling for the whole request; defaults to the wire maximum. */
  maxFoldBytes?: number
  /** Batch ceiling for one request; defaults to unbounded. */
  maxBatches?: number
}

/** Reads the log above the full copy. Never throws for a damaged log: it reports. */
export function readThreadFoldLog(options: ThreadFoldLogSourceOptions): ThreadFoldLogRead {
  const { directory, chatId, fullCopyRevision } = options
  const maxFoldBytes = options.maxFoldBytes ?? Number.MAX_SAFE_INTEGER
  const maxBatches = options.maxBatches ?? Number.MAX_SAFE_INTEGER
  let headRevision = fullCopyRevision
  const batches: ThreadFoldLogBatch[] = []
  let bytes = 0
  let complete = true
  segments: for (const segment of ['sealed', 'active'] as const) {
    const filePath = threadLogFiles(directory, chatId)[segment]
    let reader: ThreadLogSegmentReader | null = null
    try {
      reader = openThreadLogSegmentReader({ filePath, chatId, headRevision })
      if (!reader) continue
      for (;;) {
        const read = reader.read()
        for (const batch of read.batches) {
          if (!isThreadLogBatch(batch, chatId)) return { kind: 'corrupt' }
          const wire = batch as ThreadFoldLogBatch
          const size = Buffer.byteLength(JSON.stringify(wire), 'utf8')
          if (size > maxFoldBytes) return { kind: 'oversize', bytes: size, limit: maxFoldBytes }
          if (bytes + size > maxFoldBytes || batches.length >= maxBatches) {
            complete = false
            break segments
          }
          bytes += size
          batches.push(wire)
        }
        headRevision = read.headRevision
        if (read.status === 'ok') {
          if (read.reachedEnd) break
          continue
        }
        if (read.status === 'corrupt' || read.status === 'gap') return { kind: read.status }
        // A writer that has ended cannot be appending: a shrunk, rewritten or
        // oversized segment is damage, and damage refuses the fold.
        return { kind: 'corrupt' }
      }
    } catch {
      return { kind: 'unreadable', reason: `${segment} segment` }
    } finally {
      try {
        reader?.close()
      } catch {
        // The descriptor is best-effort; the batches read still stand.
      }
    }
  }
  if (batches.length === 0) return { kind: 'none' }
  const last = batches[batches.length - 1]
  return {
    kind: 'log',
    batches,
    headRevision: last.revision,
    updatedAt: last.savedAt,
    complete
  }
}
