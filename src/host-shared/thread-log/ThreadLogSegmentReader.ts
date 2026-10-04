import * as nodeFs from 'node:fs'

import { isThreadLogBatch, type ThreadLogBatch } from './ThreadLogBatch'

const NEWLINE = 0x0a

/** A line longer than this is refused rather than read into memory. */
export const THREAD_LOG_SEGMENT_MAX_LINE_BYTES = 16 * 1024 * 1024
/** About how much log one read consumes before it hands back to its caller. */
export const THREAD_LOG_SEGMENT_MAX_READ_BYTES = 1024 * 1024
/** How much of the file is read at a time unless the caller says otherwise. */
const DEFAULT_CHUNK_BYTES = 64 * 1024
/** How many of the bytes last consumed are checked again before reading on. */
const ANCHOR_BYTES = 64
/** How many times the file may change under one read before the read hands back. */
const STABLE_ATTEMPTS = 3

export interface ThreadLogSegmentFileStat {
  readonly dev: bigint
  readonly ino: bigint
  readonly nlink: bigint
  readonly size: bigint
  readonly mtimeNs: bigint
  isFile(): boolean
}

/** Every file call the reader makes. None of them can change a file. */
export interface ThreadLogSegmentReaderFs {
  readonly constants: {
    readonly O_RDONLY: number
    readonly O_NOFOLLOW?: number
    readonly O_NONBLOCK?: number
  }
  openSync(path: string, flags: number): number
  fstatSync(fd: number, options: { bigint: true }): ThreadLogSegmentFileStat
  lstatSync(path: string, options: { bigint: true }): ThreadLogSegmentFileStat
  readSync(fd: number, buffer: Buffer, offset: number, length: number, position: number): number
  closeSync(fd: number): void
}

export interface ThreadLogSegmentReaderOptions {
  filePath: string
  chatId: string
  /** Revision of the copy the batches will be applied to; the next batch must continue from it. */
  headRevision: number
  /** Byte to start at, which must be the start of a line. Defaults to the start of the file. */
  offset?: number
  /** Defaults to {@link THREAD_LOG_SEGMENT_MAX_LINE_BYTES}. */
  maxLineBytes?: number
  /** Defaults to {@link THREAD_LOG_SEGMENT_MAX_READ_BYTES}. */
  maxReadBytes?: number
  /** How much of the file is read at a time; a longer line costs a second read. */
  chunkBytes?: number
  /** Fault-injection seam; production reads through `node:fs`. */
  fs?: ThreadLogSegmentReaderFs
}

/**
 * Whether the path the reader was opened on still names the file it holds.
 * `moved` is what rotation does to a segment; `unlinked` is a file with no
 * name left. Either way the reader keeps to its own file and never opens the
 * path again: opening what is there now is the caller's decision.
 */
export type ThreadLogSegmentFileState = 'at-path' | 'moved' | 'unlinked'

interface ThreadLogSegmentProgress {
  /** Batches this read consumed, in file order, each continuing the one before. */
  batches: ThreadLogBatch[]
  /** Complete lines this read passed over because the head already covers them. */
  duplicates: number
  /** Bytes consumed so far. When the reader has stopped, the line it stopped at starts here. */
  offset: number
  /** Revision after the last batch consumed. */
  headRevision: number
  /** Bytes after `offset` when the file was last measured: a line still arriving, or lines not read yet. */
  pendingBytes: number
  file: ThreadLogSegmentFileState
}

/** Why a reader stopped for good. */
export type ThreadLogSegmentStop =
  /** A complete line is not a batch of this thread: damage, or a fragment a later line was appended to. */
  | { status: 'corrupt' }
  /** A batch is ahead of the head but does not continue from it. */
  | { status: 'gap'; baseRevision: number; revision: number }
  /** A line, finished or not, is longer than the limit. */
  | { status: 'oversized'; limit: number }
  /** The file is shorter than what was consumed from it. */
  | { status: 'shrunk'; size: number }
  /** The bytes before the offset are not the ones consumed, or not the end of a line. */
  | { status: 'rewritten' }

export type ThreadLogSegmentRead = ThreadLogSegmentProgress &
  (
    | {
        status: 'ok'
        /** False when the read handed back early; read again without waiting for the file to grow. */
        reachedEnd: boolean
      }
    | ThreadLogSegmentStop
  )

export interface ThreadLogSegmentReader {
  /**
   * Consume the complete lines that have arrived. Every status but `ok` is
   * final: later reads return the same report and do not touch the file.
   */
  read(): ThreadLogSegmentRead
  /** Release the descriptor. A stopped reader keeps it until this is called. */
  close(): void
}

/** What one stretch of the file held, worked out without changing the reader. */
interface Stretch {
  size: number
  mtimeNs: bigint
  offset: number
  headRevision: number
  batches: ThreadLogBatch[]
  duplicates: number
  anchor: Buffer | null
  stop: ThreadLogSegmentStop | null
}

function wholeNumber(
  value: number | undefined,
  fallback: number,
  least: number,
  name: string
): number {
  const chosen = value ?? fallback
  if (!Number.isSafeInteger(chosen) || chosen < least) {
    throw new RangeError(
      `Thread log segment reader: ${name} must be a whole number of at least ${least}`
    )
  }
  return chosen
}

/**
 * Follow one segment of a thread's log that another process may be appending
 * to. The reader holds a read-only descriptor, so it follows the file through
 * a rename and an unlink, and it cannot write or repair.
 *
 * A line is consumed only when its newline has arrived and it is a batch of
 * this thread that continues the head; a batch at or below the head is passed
 * over, as the journal's own replay does. Bytes after the last newline are
 * left where they are and read again once the file has changed, so no line is
 * held between reads. Nothing here watches the file or keeps a timer: the
 * caller says when to read.
 *
 * A read holds one piece of the file at a time and, for a line longer than a
 * piece, that one line; it hands back after about `maxReadBytes`. A line
 * longer than `maxLineBytes` stops the reader instead of being read.
 *
 * Returns null when there is no file at the path.
 */
export function openThreadLogSegmentReader(
  options: ThreadLogSegmentReaderOptions
): ThreadLogSegmentReader | null {
  const fs: ThreadLogSegmentReaderFs = options.fs ?? nodeFs
  const { filePath, chatId } = options
  const maxLineBytes = wholeNumber(
    options.maxLineBytes,
    THREAD_LOG_SEGMENT_MAX_LINE_BYTES,
    1,
    'maxLineBytes'
  )
  const maxReadBytes = wholeNumber(
    options.maxReadBytes,
    THREAD_LOG_SEGMENT_MAX_READ_BYTES,
    1,
    'maxReadBytes'
  )
  const chunkBytes = wholeNumber(options.chunkBytes, DEFAULT_CHUNK_BYTES, 1, 'chunkBytes')
  let offset = wholeNumber(options.offset, 0, 0, 'offset')
  let headRevision = wholeNumber(options.headRevision, Number.NaN, 0, 'headRevision')

  let fd: number
  try {
    // Non-blocking so that a pipe put at the path is refused below, not waited on.
    fd = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0)
    )
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  let closed = false
  const close = (): void => {
    if (closed) return
    closed = true
    fs.closeSync(fd)
  }
  try {
    if (!fs.fstatSync(fd, { bigint: true }).isFile()) {
      throw new Error(`Thread log segment is not a regular file: ${filePath}`)
    }
  } catch (error: unknown) {
    close()
    throw error
  }

  /** The last bytes consumed, ending at `offset`; null until a line has been consumed. */
  let anchor: Buffer | null = null
  /** The file as it was when its tail was last found to hold no complete line. */
  let unfinished: { size: number; mtimeNs: bigint } | null = null
  let measuredSize = offset
  let stopped: ThreadLogSegmentRead | null = null

  /** As much of `length` as the file holds from `position`. */
  const readAt = (position: number, length: number): Buffer => {
    const bytes = Buffer.allocUnsafe(length)
    let filled = 0
    while (filled < length) {
      const count = fs.readSync(fd, bytes, filled, length - filled, position + filled)
      if (count === 0) break
      filled += count
    }
    return bytes.subarray(0, filled)
  }

  const fileState = (): ThreadLogSegmentFileState => {
    let named: ThreadLogSegmentFileStat | null = null
    try {
      named = fs.lstatSync(filePath, { bigint: true })
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const held = fs.fstatSync(fd, { bigint: true })
    if (named && named.dev === held.dev && named.ino === held.ino) return 'at-path'
    return held.nlink === 0n ? 'unlinked' : 'moved'
  }

  /** Why the reader must stop at this line, or null when the line was consumed into `stretch`. */
  const consume = (line: Buffer, stretch: Stretch): ThreadLogSegmentStop | null => {
    // The journal's own replay passes over an empty line.
    if (line.length === 0) return null
    if (line.length > maxLineBytes) return { status: 'oversized', limit: maxLineBytes }
    let batch: unknown
    try {
      // Decoded only once the whole line is here: a character is never cut in two.
      batch = JSON.parse(line.toString('utf8'))
    } catch {
      return { status: 'corrupt' }
    }
    if (!isThreadLogBatch(batch, chatId)) return { status: 'corrupt' }
    if (batch.revision <= stretch.headRevision) {
      stretch.duplicates += 1
      return null
    }
    if (batch.baseRevision !== stretch.headRevision) {
      return { status: 'gap', baseRevision: batch.baseRevision, revision: batch.revision }
    }
    stretch.batches.push(batch)
    stretch.headRevision = batch.revision
    return null
  }

  /**
   * Read the next stretch of the file from the offset. Null means the file
   * changed while it was being read, so nothing read from it can be trusted:
   * a writer that cuts a torn fragment and appends in its place would
   * otherwise be read half before and half after. The file is measured before
   * and after for that, and whatever the reads returned in between is only
   * used when the two agree.
   */
  const readStretch = (): Stretch | null => {
    const before = fs.fstatSync(fd, { bigint: true })
    const size = Number(before.size)
    measuredSize = size
    const stretch: Stretch = {
      size,
      mtimeNs: before.mtimeNs,
      offset,
      headRevision,
      batches: [],
      duplicates: 0,
      anchor: null,
      stop: null
    }
    if (size < offset) {
      stretch.stop = { status: 'shrunk', size }
      return stretch
    }
    if (size === offset) return stretch
    // Nothing has been written since the line at the offset was found
    // unfinished, so it is not read again: a torn tail can stay for days.
    if (unfinished && unfinished.size === size && unfinished.mtimeNs === before.mtimeNs) {
      return stretch
    }

    // One read covers the bytes to check again and the first piece of new ones.
    const anchorBytes = anchor ? anchor.length : Math.min(offset, 1)
    const base = offset - anchorBytes
    const wanted = anchorBytes + Math.min(chunkBytes, size - offset)
    const piece = readAt(base, wanted)
    const consumedBefore = piece.subarray(0, anchorBytes)
    if (
      anchor ? !consumedBefore.equals(anchor) : anchorBytes > 0 && consumedBefore[0] !== NEWLINE
    ) {
      stretch.stop = { status: 'rewritten' }
    }

    let cursor = anchorBytes
    while (!stretch.stop) {
      const newline = piece.indexOf(NEWLINE, cursor)
      if (newline < 0) break
      stretch.stop = consume(piece.subarray(cursor, newline), stretch)
      if (!stretch.stop) cursor = newline + 1
    }
    if (cursor > anchorBytes) {
      stretch.offset = base + cursor
      // Copied, so the piece it was read in is not kept alive by it.
      stretch.anchor = Buffer.from(piece.subarray(Math.max(0, cursor - ANCHOR_BYTES), cursor))
    } else if (!stretch.stop) {
      // No line ends in this piece: the line is longer than a piece, or still
      // arriving. Look for its newline a piece at a time, keeping none of them,
      // and no further than it takes to know the line is too long.
      let end = -1
      for (
        let position = base + wanted;
        end < 0 && position < size && position - offset <= maxLineBytes;
        position += chunkBytes
      ) {
        const newline = readAt(position, Math.min(chunkBytes, size - position)).indexOf(NEWLINE)
        if (newline >= 0) end = position + newline
      }
      const lineBytes = (end < 0 ? size : end) - offset
      if (lineBytes > maxLineBytes) {
        stretch.stop = { status: 'oversized', limit: maxLineBytes }
      } else if (end >= 0) {
        const line = readAt(offset, lineBytes + 1)
        stretch.stop = consume(line.subarray(0, lineBytes), stretch)
        if (!stretch.stop) {
          stretch.offset = end + 1
          stretch.anchor = Buffer.from(line.subarray(Math.max(0, line.length - ANCHOR_BYTES)))
        }
      }
    }

    const after = fs.fstatSync(fd, { bigint: true })
    return after.size === before.size && after.mtimeNs === before.mtimeNs ? stretch : null
  }

  const read = (): ThreadLogSegmentRead => {
    if (closed) throw new Error('Thread log segment reader is closed')
    if (stopped) return { ...stopped, batches: [] }
    // The path is looked at before the file is measured. A writer appends and
    // only then renames or unlinks, so a file seen to have left its path is
    // measured, and read, with everything that writer put in it.
    const file = fileState()
    const start = offset
    const batches: ThreadLogBatch[] = []
    let duplicates = 0
    const progress = (): ThreadLogSegmentProgress => ({
      batches,
      duplicates,
      offset,
      headRevision,
      pendingBytes: Math.max(0, measuredSize - offset),
      file
    })
    let unstable = 0
    for (;;) {
      const stretch = readStretch()
      if (!stretch) {
        unstable += 1
        if (unstable < STABLE_ATTEMPTS) continue
        return { status: 'ok', reachedEnd: false, ...progress() }
      }
      const advanced = stretch.offset > offset
      offset = stretch.offset
      headRevision = stretch.headRevision
      anchor = stretch.anchor ?? anchor
      for (const batch of stretch.batches) batches.push(batch)
      duplicates += stretch.duplicates
      if (stretch.stop) {
        // Kept without the batches: they are the caller's now.
        stopped = { ...progress(), ...stretch.stop, batches: [], duplicates: 0 }
        return { ...progress(), ...stretch.stop }
      }
      if (!advanced || offset >= stretch.size) {
        unfinished = offset < stretch.size ? { size: stretch.size, mtimeNs: stretch.mtimeNs } : null
        return { status: 'ok', reachedEnd: true, ...progress() }
      }
      if (offset - start >= maxReadBytes) return { status: 'ok', reachedEnd: false, ...progress() }
    }
  }

  return { read, close }
}
