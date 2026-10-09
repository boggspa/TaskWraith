/**
 * The async run-events query, read without holding the whole result set.
 *
 * `filterRunEvents` filters every event it is handed, sorts the survivors and
 * keeps the newest `limit`. Fed by a reader that first parsed every event in
 * every file, a `{workspaceId, limit}` query over a multi-GB run-events folder
 * held every parsed record on the main process at once. This keeps the exact
 * answer and changes only what is held while it is computed:
 *
 * - The filter's predicate is applied as each line is parsed, so an event the
 *   filter rejects is never retained.
 * - With a limit, the first pass keeps only each accepted event's sort key and
 *   where it lives (file, line). The keys are sorted with the same comparator,
 *   in the same input order, as `filterRunEvents` sorts records, so the sort
 *   makes the same comparisons and returns the same permutation. Only the
 *   newest `limit` positions are then read again and parsed in full.
 *
 * Why keys rather than a newest-N heap: the comparator orders one run's events
 * by sequence and different runs' events by timestamp. Timestamps have
 * millisecond resolution, so a run's consecutive events often share one, and
 * the comparator is then not a consistent order: the sort's result depends on
 * input order, which a heap would not reproduce. Holding keys costs a few
 * dozen bytes per accepted event, not one parsed record each, but it is not
 * O(limit).
 *
 * Each key also carries its line's length and a 32-bit digest. A selected line
 * that no longer matches on the second pass (the file was rewritten or removed
 * between the passes) makes the query fall back to one full pass, as before
 * this module. Lines appended between the passes are not seen, exactly
 * as if the first pass had been the only read.
 *
 * Lines are split as `String#split(/\r?\n/)` splits them, the sync reader's
 * rule. A file that fails to read contributes none of its events, as in the
 * sync reader.
 */
import fs from 'fs'
import type { FileHandle } from 'fs/promises'

import { filterRunEvents, parseRunEventLine, runEventFilterPredicate } from '../RunEventStore'
import type { RunEventFilter, RunEventRecord } from './types'

/** Bytes read from a run-event file's tail to learn its newest timestamp. */
const RUN_EVENT_TAIL_PROBE_BYTES = 64 * 1024

export interface RunEventQueryReader {
  /** The file's lines, split as `String#split(/\r?\n/)` would split its text. */
  lines(filePath: string): AsyncIterable<string>
  /** The newest event timestamp in the file's tail, or null when unknown. */
  newestTimestampMs(filePath: string): Promise<number | null>
}

/** What one query held and read; for tests and diagnostics only. */
export interface RunEventQueryStats {
  filesRead: number
  filesSkipped: number
  /** Sort keys held at the end of the first pass. */
  keysHeld: number
  /** Parsed records retained for the answer. */
  recordsRetained: number
  /** True when the second pass found a file changed and one full pass ran. */
  fellBack: boolean
}

export interface RunEventQueryOptions {
  /**
   * The literal-substring line test for the filter's kinds, a superset of what
   * the predicate keeps; lines it rejects are never parsed.
   */
  prefilter?: ((line: string) => boolean) | null
  reader?: RunEventQueryReader
  stats?: RunEventQueryStats
  onReadError?: (filePath: string, error: unknown) => void
}

/** Splits decoded text chunks into lines exactly as `split(/\r?\n/)` would. */
export async function* splitRunEventLines(chunks: AsyncIterable<string>): AsyncIterable<string> {
  let carry = ''
  for await (const chunk of chunks) {
    const parts = (carry + chunk).split('\n')
    carry = parts.pop() ?? ''
    for (const part of parts) yield part.endsWith('\r') ? part.slice(0, -1) : part
  }
  yield carry
}

export const nodeRunEventQueryReader: RunEventQueryReader = {
  lines: (filePath) =>
    splitRunEventLines(
      fs.createReadStream(filePath, { encoding: 'utf-8' }) as AsyncIterable<string>
    ),
  async newestTimestampMs(filePath) {
    let handle: FileHandle | undefined
    try {
      handle = await fs.promises.open(filePath, 'r')
      const { size } = await handle.stat()
      if (size <= 0) return null
      const length = Math.min(size, RUN_EVENT_TAIL_PROBE_BYTES)
      const buffer = Buffer.alloc(length)
      await handle.read(buffer, 0, length, size - length)
      let newest: number | null = null
      // The first line of a mid-file chunk may be cut; parseRunEventLine rejects it.
      for (const line of buffer.toString('utf-8').split(/\r?\n/)) {
        const event = parseRunEventLine(line)
        if (!event) continue
        const ms = new Date(event.timestamp).getTime()
        if (!Number.isFinite(ms)) continue
        if (newest === null || ms > newest) newest = ms
      }
      return newest
    } catch {
      return null
    } finally {
      await handle?.close().catch(() => {})
    }
  }
}

/** The number of newest events `filterRunEvents` keeps, or null when it keeps all. */
function effectiveLimit(filter: RunEventFilter): number | null {
  // The same test and the same rounding as `filterRunEvents`: a limit that
  // floors to zero slices nothing off, so it keeps everything.
  if (!(filter.limit && filter.limit > 0)) return null
  const limit = Math.floor(filter.limit)
  return limit > 0 && Number.isFinite(limit) ? limit : null
}

/** FNV-1a over the line's UTF-16 code units: has the line changed since pass one? */
function lineDigest(text: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/**
 * Whether files may be skipped once the newest `limit` accepted events are
 * known: only for a `{chatId, kinds?, limit}` query, whose files are given
 * newest run first. A file whose newest event is strictly older than the
 * oldest of those cannot rank, however the runs interleave. Equal timestamps
 * are never skipped. Unchanged from the reader this replaces.
 */
function newestBoundApplies(filter: RunEventFilter): boolean {
  if (!filter.chatId || effectiveLimit(filter) === null) return false
  if (filter.runId || filter.workspaceId || filter.provider || filter.approvalId) return false
  if (filter.phases?.length || Number.isFinite(filter.fromSequence)) return false
  return true
}

/** One file's accepted events, as full records or as keys; all or nothing. */
interface FileSink {
  accept(event: RunEventRecord, line: number, text: string): void
  /** The file failed to read: forget what it contributed. */
  discard(): void
}

async function scanFile(
  filePath: string,
  reader: RunEventQueryReader,
  prefilter: ((line: string) => boolean) | null | undefined,
  accepts: (event: RunEventRecord) => boolean,
  sink: FileSink,
  onReadError: RunEventQueryOptions['onReadError']
): Promise<void> {
  let line = -1
  try {
    for await (const text of reader.lines(filePath)) {
      line += 1
      if (prefilter && !prefilter(text)) continue
      const event = parseRunEventLine(text)
      if (event && accepts(event)) sink.accept(event, line, text)
    }
  } catch (error) {
    sink.discard()
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') onReadError?.(filePath, error)
  }
}

/** One pass that retains every accepted record; the answer when nothing is sliced off. */
async function fullPass(
  paths: readonly string[],
  filter: RunEventFilter,
  options: RunEventQueryOptions,
  accepts: (event: RunEventRecord) => boolean
): Promise<RunEventRecord[]> {
  const reader = options.reader ?? nodeRunEventQueryReader
  const kept: RunEventRecord[] = []
  for (const filePath of paths) {
    const start = kept.length
    if (options.stats) options.stats.filesRead += 1
    await scanFile(
      filePath,
      reader,
      options.prefilter,
      accepts,
      { accept: (event) => kept.push(event), discard: () => (kept.length = start) },
      options.onReadError
    )
  }
  if (options.stats) options.stats.recordsRetained = kept.length
  // Every kept event already passes the predicate, so this only sorts and slices.
  return filterRunEvents(kept, filter)
}

/**
 * The events `filterRunEvents(<every event in paths, in order>, filter)`
 * returns, in the same order, without holding every event at once.
 */
export async function queryRunEventFilesAsync(
  paths: readonly string[],
  filter: RunEventFilter,
  options: RunEventQueryOptions = {}
): Promise<RunEventRecord[]> {
  const accepts = runEventFilterPredicate(filter)
  const limit = effectiveLimit(filter)
  if (limit === null) return fullPass(paths, filter, options, accepts)

  const reader = options.reader ?? nodeRunEventQueryReader
  const stats = options.stats
  // Columns of the first pass, one entry per accepted event, in input order.
  // The run is interned so the comparator's `===` on runIds is an index test.
  const runIds: unknown[] = []
  const runIndex = new Map<unknown, number>()
  const run: number[] = []
  const sequence: number[] = []
  const time: number[] = []
  const file: number[] = []
  const line: number[] = []
  const textLength: number[] = []
  const digest: number[] = []
  const truncateTo = (length: number): void => {
    run.length = sequence.length = time.length = file.length = line.length = length
    textLength.length = digest.length = length
  }

  const bound = newestBoundApplies(filter)
  const acceptedMs: number[] = []
  let oldestKeptMs: number | null = null
  for (let index = 0; index < paths.length; index += 1) {
    const filePath = paths[index]
    if (bound && oldestKeptMs !== null) {
      const newest = await reader.newestTimestampMs(filePath)
      if (newest !== null && newest < oldestKeptMs) {
        if (stats) stats.filesSkipped += 1
        continue
      }
    }
    if (stats) stats.filesRead += 1
    const start = run.length
    const startAccepted = acceptedMs.length
    await scanFile(
      filePath,
      reader,
      options.prefilter,
      accepts,
      {
        accept(event, at, text) {
          let interned = runIndex.get(event.runId)
          if (interned === undefined) {
            interned = runIds.length
            runIds.push(event.runId)
            runIndex.set(event.runId, interned)
          }
          const ms = new Date(event.timestamp).getTime()
          run.push(interned)
          // `a.sequence - b.sequence` converts both with ToNumber, as Number() does.
          sequence.push(Number(event.sequence))
          time.push(ms)
          file.push(index)
          line.push(at)
          textLength.push(text.length)
          digest.push(lineDigest(text))
          if (bound && Number.isFinite(ms)) acceptedMs.push(ms)
        },
        discard() {
          truncateTo(start)
          acceptedMs.length = startAccepted
        }
      },
      options.onReadError
    )
    if (bound && acceptedMs.length >= limit) {
      acceptedMs.sort((a, b) => b - a)
      acceptedMs.length = limit
      oldestKeptMs = acceptedMs[limit - 1]
    }
  }

  const count = run.length
  if (stats) stats.keysHeld = count
  // The comparator of `filterRunEvents` over the key columns: same results for
  // the same pairs, so `sort` takes the same steps and the same permutation.
  const order = Array.from({ length: count }, (_, position) => position)
  order.sort((a, b) => (run[a] === run[b] ? sequence[a] - sequence[b] : time[a] - time[b]))
  const selected = order.slice(-limit)

  // Second pass: parse only the selected lines, file by file.
  const wanted = new Map<number, Map<number, number>>()
  selected.forEach((position, slot) => {
    let lines = wanted.get(file[position])
    if (!lines) wanted.set(file[position], (lines = new Map()))
    lines.set(line[position], slot)
  })
  const result: Array<RunEventRecord | undefined> = new Array(selected.length)
  let changed = false
  for (const [index, lines] of [...wanted].sort((a, b) => a[0] - b[0])) {
    let at = -1
    let found = 0
    try {
      for await (const text of reader.lines(paths[index])) {
        at += 1
        const slot = lines.get(at)
        if (slot === undefined) continue
        const position = selected[slot]
        const event =
          text.length === textLength[position] && lineDigest(text) === digest[position]
            ? parseRunEventLine(text)
            : null
        if (
          !event ||
          !accepts(event) ||
          event.runId !== runIds[run[position]] ||
          !Object.is(Number(event.sequence), sequence[position]) ||
          !Object.is(new Date(event.timestamp).getTime(), time[position])
        ) {
          changed = true
          break
        }
        result[slot] = event
        found += 1
        if (found === lines.size) break
      }
    } catch {
      changed = true
    }
    if (changed || found !== lines.size) {
      changed = true
      break
    }
  }
  if (changed) {
    if (stats) {
      stats.fellBack = true
      stats.filesRead = 0
      stats.filesSkipped = 0
    }
    return fullPass(paths, filter, options, accepts)
  }
  if (stats) stats.recordsRetained = result.length
  return result as RunEventRecord[]
}
