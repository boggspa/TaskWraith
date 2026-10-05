/**
 * How far a thread's log has got, read from its files without following it:
 * the last whole line of the newest segment, else the checkpoint's header.
 *
 * The app writes a batch as one line and a line without its newline is a
 * write still under way, or one a crash cut short, so it does not count. The
 * active segment is read before the sealed one: rotation renames the active
 * segment to the sealed name, so a segment renamed between the two reads is
 * seen at one of them. A segment begun after the read was made is missed,
 * which leaves the answer behind the log, never ahead of it.
 *
 * A file that is there and cannot be read answers `unreadable`, never a
 * smaller revision: a caller that decides who owns a thread from this must not
 * take a log it cannot read for one that has nothing above the full copy.
 */
import { constants } from 'node:fs'
import { open, type FileHandle } from 'node:fs/promises'
import * as path from 'node:path'

import { isSafeChatId } from '../shared/ChatPath'
import { THREAD_LOG_BATCH_FORMAT } from '../host-shared/thread-log/ThreadLogBatch'
import { THREAD_LOG_SEGMENT_MAX_LINE_BYTES } from '../host-shared/thread-log/ThreadLogSegmentReader'

/** The format the app's journal writes at the head of each checkpoint. */
const CHECKPOINT_FORMAT = 'taskwraith-chat-checkpoint'
/** The checkpoint's fields come before its record, within this many bytes. */
const CHECKPOINT_HEADER_BYTES = 4096
const TAIL_CHUNK_BYTES = 64 * 1024

export type ThreadLogHead =
  | { readonly kind: 'head'; readonly revision: number; readonly savedAt: string | null }
  /** No segment holds a whole line, and there is no checkpoint. */
  | { readonly kind: 'none' }
  | { readonly kind: 'unreadable'; readonly reason: string }

/** The thread's log files, in the order they are read. */
export function threadLogFiles(
  directory: string,
  chatId: string
): { active: string; sealed: string; checkpoint: string } {
  if (!isSafeChatId(chatId)) throw new Error('Invalid thread id')
  return {
    active: path.join(directory, `${chatId}.mutations.jsonl`),
    sealed: path.join(directory, `${chatId}.sealed.mutations.jsonl`),
    checkpoint: path.join(directory, `${chatId}.checkpoint.json`)
  }
}

/** The head of the log of `chatId` in `directory`, the journal's directory (`<profile>/chat-journal-v2`). */
export async function readThreadLogHead(directory: string, chatId: string): Promise<ThreadLogHead> {
  const files = threadLogFiles(directory, chatId)
  for (const file of [files.active, files.sealed]) {
    const line = await lastLine(file, chatId)
    if (line.kind !== 'none') return line
  }
  return checkpointHead(files.checkpoint, chatId)
}

/** The log's checkpoint alone: a record behind it did not come from the log as it is now. */
export async function readThreadLogCheckpoint(
  directory: string,
  chatId: string
): Promise<ThreadLogHead> {
  return checkpointHead(threadLogFiles(directory, chatId).checkpoint, chatId)
}

function errorCode(error: unknown): string | undefined {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return typeof code === 'string' ? code : undefined
}

/**
 * Never through a link, and never waiting: a pipe left at a log's name opens
 * at once, and is then refused as not a file.
 */
const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)

async function openForReading(file: string): Promise<FileHandle | 'absent' | ThreadLogHead> {
  try {
    return await open(file, READ_FLAGS)
  } catch (error) {
    const code = errorCode(error)
    return code === 'ENOENT'
      ? 'absent'
      : { kind: 'unreadable', reason: `${path.basename(file)}: ${code}` }
  }
}

async function readExactly(handle: FileHandle, length: number, position: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length)
  let read = 0
  while (read < length) {
    const { bytesRead } = await handle.read(buffer, read, length - read, position + read)
    if (bytesRead === 0) break
    read += bytesRead
  }
  return buffer.subarray(0, read)
}

/** The segment's last whole line, as a head; `none` when there is no segment or no whole line. */
async function lastLine(file: string, chatId: string): Promise<ThreadLogHead> {
  const handle = await openForReading(file)
  if (handle === 'absent') return { kind: 'none' }
  if (!('read' in handle)) return handle
  const unreadable = (why: string): ThreadLogHead => ({
    kind: 'unreadable',
    reason: `${path.basename(file)}: ${why}`
  })
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) return unreadable('not a file')
    const size = stat.size
    // Scanned back a piece at a time for the last newline (`end`) and the one
    // before it; only the line between them is then read whole. A cut-short
    // write after the last newline is at most one line long.
    let position = size
    let end = -1
    let start = -1
    while (position > 0 && start < 0) {
      if (size - position > 2 * THREAD_LOG_SEGMENT_MAX_LINE_BYTES) {
        return unreadable('last line too long')
      }
      const length = Math.min(TAIL_CHUNK_BYTES, position)
      position -= length
      const piece = await readExactly(handle, length, position)
      if (piece.length !== length) return unreadable('shorter than its size')
      let from = length - 1
      if (end < 0) {
        const at = piece.lastIndexOf(0x0a)
        if (at < 0) continue
        end = position + at
        from = at - 1
      }
      if (from < 0) continue
      const before = piece.lastIndexOf(0x0a, from)
      if (before >= 0) start = position + before + 1
    }
    if (end < 0) return { kind: 'none' }
    if (start < 0) start = 0
    if (end - start > THREAD_LOG_SEGMENT_MAX_LINE_BYTES) return unreadable('last line too long')
    const line = await readExactly(handle, end - start, start)
    if (line.length !== end - start) return unreadable('shorter than its size')
    return batchHead(line.toString('utf8'), chatId, unreadable)
  } catch (error) {
    return unreadable(errorCode(error) ?? 'read failed')
  } finally {
    await handle.close()
  }
}

function batchHead(
  text: string,
  chatId: string,
  unreadable: (why: string) => ThreadLogHead
): ThreadLogHead {
  let batch: unknown
  try {
    batch = JSON.parse(text)
  } catch {
    return unreadable('last line is not a batch')
  }
  const fields = batch as Record<string, unknown> | null
  if (
    !fields ||
    typeof fields !== 'object' ||
    fields.format !== THREAD_LOG_BATCH_FORMAT ||
    fields.chatId !== chatId ||
    !Number.isSafeInteger(fields.revision) ||
    (fields.revision as number) < 0
  ) {
    return unreadable('last line is not a batch of this thread')
  }
  return {
    kind: 'head',
    revision: fields.revision as number,
    savedAt: typeof fields.savedAt === 'string' ? fields.savedAt : null
  }
}

async function checkpointHead(file: string, chatId: string): Promise<ThreadLogHead> {
  const handle = await openForReading(file)
  if (handle === 'absent') return { kind: 'none' }
  if (!('read' in handle)) return handle
  const unreadable = (why: string): ThreadLogHead => ({
    kind: 'unreadable',
    reason: `${path.basename(file)}: ${why}`
  })
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) return unreadable('not a file')
    const text = (await readExactly(handle, CHECKPOINT_HEADER_BYTES, 0)).toString('utf8')
    // The journal writes the record last, after the fields read here.
    const recordAt = text.indexOf(',"record":')
    if (recordAt < 0) return unreadable('no header')
    let header: unknown
    try {
      header = JSON.parse(`${text.slice(0, recordAt)}}`)
    } catch {
      return unreadable('header is not JSON')
    }
    const fields = header as Record<string, unknown> | null
    if (
      !fields ||
      typeof fields !== 'object' ||
      fields.format !== CHECKPOINT_FORMAT ||
      fields.chatId !== chatId ||
      !Number.isSafeInteger(fields.revision) ||
      (fields.revision as number) < 0
    ) {
      return unreadable('not a checkpoint of this thread')
    }
    return {
      kind: 'head',
      revision: fields.revision as number,
      savedAt: typeof fields.savedAt === 'string' ? fields.savedAt : null
    }
  } catch (error) {
    return unreadable(errorCode(error) ?? 'read failed')
  } finally {
    await handle.close()
  }
}
