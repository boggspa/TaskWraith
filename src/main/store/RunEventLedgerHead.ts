import * as fs from 'fs'
import { parseRunEventLine } from '../RunEventStore'

/**
 * Bytes read from the end of a ledger on the first attempt. A run event is a
 * few hundred bytes to the 80 KB payload cap, so one window normally covers
 * several records.
 */
export const RUN_EVENT_HEAD_WINDOW_BYTES = 64 * 1024

/**
 * Ceiling on the backward window before giving up on seeking and streaming the
 * whole file forward instead. Bounds the peak allocation of the fast path.
 */
export const RUN_EVENT_HEAD_MAX_WINDOW_BYTES = 8 * 1024 * 1024

/** Fixed buffer for the streamed fallback, so its peak is independent of size. */
const STREAM_CHUNK_BYTES = 256 * 1024

export interface RunEventLedgerHead {
  /** Highest sequence observed. Callers append at `sequence + 1`. */
  sequence: number
  /** Chain head — the newest record carrying a hash, or null if none does. */
  hash: string | null
}

function foldLine(line: string, head: RunEventLedgerHead | null): RunEventLedgerHead | null {
  const event = parseRunEventLine(line)
  if (!event) return head
  const sequence = Number(event.sequence) || 0
  return {
    sequence: Math.max(sequence, head?.sequence ?? 0),
    // Ledgers are append-only and written in sequence order by a single
    // writer, so the last hash seen is the chain head.
    hash: event.hash || head?.hash || null
  }
}

/**
 * Derive the head from a window taken from the end of the file. `atFileStart`
 * says whether the window begins at offset 0; when it does not, the first
 * fragment is the tail of a record the window cut in half and is discarded.
 * A torn final line — a crash between `write` and the next append — simply
 * fails to parse and is skipped.
 */
function headFromWindow(buffer: Buffer, atFileStart: boolean): RunEventLedgerHead | null {
  const lines = buffer.toString('utf-8').split(/\r?\n/)
  if (!atFileStart) lines.shift()
  let head: RunEventLedgerHead | null = null
  for (const line of lines) head = foldLine(line, head)
  return head
}

/**
 * Last resort for a ledger whose final {@link RUN_EVENT_HEAD_MAX_WINDOW_BYTES}
 * hold no parseable record. Reads forward through a fixed buffer so a ledger of
 * any size costs the same memory. Slow and effectively unreachable in practice
 * — but the alternative, reporting "no head", would restart the hash chain at
 * sequence 1 inside a ledger that already has thousands of records.
 */
function streamedHead(fd: number, size: number): RunEventLedgerHead | null {
  const buffer = Buffer.allocUnsafe(STREAM_CHUNK_BYTES)
  let head: RunEventLedgerHead | null = null
  let carry = ''
  let position = 0
  while (position < size) {
    const read = fs.readSync(fd, buffer, 0, Math.min(STREAM_CHUNK_BYTES, size - position), position)
    if (read <= 0) break
    position += read
    const lines = (carry + buffer.toString('utf-8', 0, read)).split(/\r?\n/)
    carry = lines.pop() ?? ''
    for (const line of lines) head = foldLine(line, head)
  }
  return foldLine(carry, head)
}

/**
 * The `{sequence, hash}` an append needs, WITHOUT materializing the ledger.
 *
 * The whole-file read this replaces was the main-process OOM of 2026-08-20:
 * one `saveChat` made 520 cold appends, each slurping its run's ledger
 * (4.81 GiB in total) purely to learn two scalars. Worse, a ledger above
 * `MAX_STRING_LENGTH` (536,870,888) made `readFileSync(utf-8)` throw, the
 * failure was swallowed, and the append restarted the hash chain at sequence 1
 * in the middle of a gigabyte-scale file. Seeking to the end fixes both: peak
 * cost is one window, and size is irrelevant to it.
 *
 * Returns null only when the ledger genuinely has no record — absent, empty, or
 * holding nothing parseable — where starting at sequence 1 is correct. An I/O
 * failure throws rather than reporting an empty ledger, so a transient read
 * error can never be mistaken for a fresh run.
 */
export function readRunEventLedgerHead(filePath: string): RunEventLedgerHead | null {
  let fd: number
  try {
    fd = fs.openSync(filePath, 'r')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  try {
    const size = fs.fstatSync(fd).size
    if (size <= 0) return null
    let window = Math.min(RUN_EVENT_HEAD_WINDOW_BYTES, size)
    for (;;) {
      const start = size - window
      const buffer = Buffer.allocUnsafe(window)
      const read = fs.readSync(fd, buffer, 0, window, start)
      const head = headFromWindow(buffer.subarray(0, read), start === 0)
      if (head) return head
      if (start === 0) return null
      if (window >= RUN_EVENT_HEAD_MAX_WINDOW_BYTES) return streamedHead(fd, size)
      window = Math.min(window * 8, RUN_EVENT_HEAD_MAX_WINDOW_BYTES, size)
    }
  } finally {
    fs.closeSync(fd)
  }
}
