/**
 * A thread loaded from its log for a seed, off the Host loop: the seed worker
 * runs this, and a test may run it on its own thread.
 *
 * The checkpoint is opened once and read whole through that descriptor. The
 * journal puts a new checkpoint in place by renaming it over the old one and
 * never writes one in place, so the descriptor holds one checkpoint from its
 * first byte to its last however the app compacts meanwhile. The lines after
 * it are found by a follower that holds no rows, so they are found as the
 * Host's followers find them, and a checkpoint that moves on during the read
 * is met as they meet it: a fold that passes the lines read reseeds from the
 * new one. The load ends when that follower has read to the end of the log;
 * the lines it took since its last seed are then applied to that seed's
 * record with the shared apply code, as the app's own load applies them, so
 * the record is the thread at the head of its log, as that load builds it.
 *
 * Asked for a follower's window, the load cuts the record as that follower
 * would (`HostThreadLogFollower.windowOf`), works out what the rows before the
 * window show for its history, and says where it read each segment to, so the
 * follower reads on from there. Only that window goes back to the Host loop.
 *
 * It reads the journal's own files with the shared segment reader and apply
 * code, and never writes.
 */
import * as nodeFs from 'node:fs'
import * as path from 'node:path'

import { applyThreadLogBatches } from '../host-shared/thread-log/ThreadLogApply'
import type { ThreadLogSegmentReaderFs } from '../host-shared/thread-log/ThreadLogSegmentReader'
import {
  HostThreadLogFollower,
  isFollowableThreadId,
  type HostThreadLogRecord,
  type HostThreadLogWindowBounds,
  type HostThreadLogWindowSeed
} from './HostThreadLogFollower'
import { hostThreadLogEntriesBefore } from './HostThreadLogHistory'

const CHECKPOINT_FORMAT = 'taskwraith-chat-checkpoint'
const CHECKPOINT_VERSION = 1
/** Why the journal writes a checkpoint; a file naming another reason is not one of its checkpoints. */
const CHECKPOINT_REASONS: ReadonlySet<string> = new Set([
  'initial',
  'terminal',
  'idle',
  'bounded',
  'shutdown',
  'manual',
  'recovery'
])
/**
 * Bytes of log a load's follower reads before a poll hands back. Off the Host
 * loop nothing waits on it, so one poll reads the log to its end.
 */
const LOAD_MAX_POLL_BYTES = 256 * 1024 * 1024
/** As much as a load's follower may keep: every line since its seed. */
const UNBOUNDED = Number.MAX_SAFE_INTEGER
/**
 * The longest line a load reads. The journal refuses a checkpoint over 128 MiB
 * and a line holds less than its record, so the load reads every line the app
 * keeps, where a Host follower would seed past one over its own limit.
 */
const LOAD_MAX_LINE_BYTES = 128 * 1024 * 1024
/**
 * Polls a load makes before it gives up on reaching the end of the log. A poll
 * hands back early only after three reseeds or many files, each a sign the app
 * is compacting under the read; the next seed is asked for again later.
 */
const MAX_LOAD_POLLS = 16

export interface HostThreadLogLoadRequest {
  /** The journal's directory: `<profile>/chat-journal-v2`. */
  readonly directory: string
  readonly chatId: string
  /** A follower's bounds, to cut the record to; the whole record when absent. */
  readonly window?: HostThreadLogWindowBounds
}

export interface HostThreadLogLoadTimings {
  /** Milliseconds reading and parsing checkpoints, and how many were read. */
  readonly checkpointMs: number
  readonly checkpoints: number
  /** Bytes of the last checkpoint read. */
  readonly checkpointBytes: number
  /** Milliseconds finding and reading the lines after the checkpoint. */
  readonly followMs: number
  /** Milliseconds applying them to the checkpoint's record, and how many there were. */
  readonly applyMs: number
  readonly batches: number
  /** Milliseconds cutting the window and working out the rows before it. */
  readonly cutMs: number
  readonly totalMs: number
}

export type HostThreadLogLoadResult =
  /** No checkpoint the app's load would take, or the thread is being erased. */
  | { readonly kind: 'absent' }
  | {
      readonly kind: 'record'
      readonly record: HostThreadLogRecord
      readonly timings: HostThreadLogLoadTimings
    }
  | {
      readonly kind: 'window'
      readonly seed: HostThreadLogWindowSeed
      readonly timings: HostThreadLogLoadTimings
    }

export interface HostThreadLogLoadOptions {
  /** Fault-injection seam; production reads through `node:fs`. None of its calls can change a file. */
  readonly fs?: ThreadLogSegmentReaderFs
  /** Milliseconds, for timings. */
  readonly now?: () => number
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function revisionOf(record: Record<string, unknown>): number {
  const revision = record.persistenceRevision
  return Number.isSafeInteger(revision) && (revision as number) >= 0 ? (revision as number) : 0
}

/** The record in a checkpoint the journal wrote for this thread, as its own check takes it. */
function checkpointRecord(value: unknown, chatId: string): HostThreadLogRecord | null {
  if (!isPlainObject(value)) return null
  const record = value.record
  if (
    value.format !== CHECKPOINT_FORMAT ||
    value.version !== CHECKPOINT_VERSION ||
    value.chatId !== chatId ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0 ||
    typeof value.savedAt !== 'string' ||
    typeof value.reason !== 'string' ||
    !CHECKPOINT_REASONS.has(value.reason) ||
    !isPlainObject(record) ||
    record.appChatId !== chatId ||
    !Array.isArray(record.messages) ||
    !Array.isArray(record.runs) ||
    revisionOf(record) !== value.revision
  ) {
    return null
  }
  return record as HostThreadLogRecord
}

/**
 * The checkpoint's record, read whole through one descriptor. Null when there
 * is no checkpoint, or one that does not parse or is not this thread's, which
 * the Host's followers read as no checkpoint too.
 */
function readCheckpoint(
  fs: ThreadLogSegmentReaderFs,
  filePath: string,
  chatId: string
): { readonly record: HostThreadLogRecord; readonly bytes: number } | null {
  let fd: number
  try {
    fd = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0)
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return null
    throw error
  }
  try {
    const stat = fs.fstatSync(fd, { bigint: true })
    if (!stat.isFile()) return null
    const size = Number(stat.size)
    const buffer = Buffer.allocUnsafe(size)
    let length = 0
    while (length < size) {
      const count = fs.readSync(fd, buffer, length, size - length, length)
      if (count === 0) break
      length += count
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(buffer.toString('utf8', 0, length))
    } catch {
      return null
    }
    const record = checkpointRecord(parsed, chatId)
    return record ? { record, bytes: length } : null
  } finally {
    fs.closeSync(fd)
  }
}

/** Load a thread from its log: the whole record at the head of the log, or a follower's window of it. */
export async function loadThreadLog(
  request: HostThreadLogLoadRequest,
  options: HostThreadLogLoadOptions = {}
): Promise<HostThreadLogLoadResult> {
  const { chatId } = request
  if (!isFollowableThreadId(chatId)) throw new Error('Thread log load: unsafe chat id')
  const fs = options.fs ?? nodeFs
  const clock = options.now ?? (() => performance.now())
  const started = clock()
  const checkpointPath = path.join(path.resolve(request.directory), `${chatId}.checkpoint.json`)
  let checkpointMs = 0
  let checkpoints = 0
  let checkpointBytes = 0
  let seeded: HostThreadLogRecord | null = null
  const follower = new HostThreadLogFollower({
    chatId,
    directory: request.directory,
    fs,
    maxPollBytes: LOAD_MAX_POLL_BYTES,
    maxLineBytes: LOAD_MAX_LINE_BYTES,
    // It holds no rows, so a line costs it what the line changes; it keeps every line since its seed.
    windowMessages: 0,
    windowRuns: 0,
    maxViewBytes: UNBOUNDED,
    maxRetainedBytes: UNBOUNDED,
    maxRetainedBatches: UNBOUNDED,
    observer: {
      seeded: (record) => {
        seeded = record
      }
    },
    seedPort: {
      seed: async () => {
        const at = clock()
        const read = readCheckpoint(fs, checkpointPath, chatId)
        checkpointMs += clock() - at
        checkpoints += 1
        if (!read) return null
        checkpointBytes = read.bytes
        return read.record
      }
    }
  })
  try {
    let caughtUp = false
    for (let polls = 0; polls < MAX_LOAD_POLLS && !caughtUp; polls += 1) {
      const result = await follower.poll()
      if (result.status === 'absent') return { kind: 'absent' }
      if (result.status === 'unfollowable') throw new Error(`Thread log load: ${result.why}`)
      caughtUp = result.caughtUp
    }
    if (!caughtUp) throw new Error('Thread log load: the log moved on under every read of it')
    const followed = clock()
    const base: HostThreadLogRecord | null = seeded
    const head = follower.headRevision
    const since = base && head !== null ? follower.appliedSince(revisionOf(base)) : null
    if (!base || !since) throw new Error('Thread log load: the lines since the seed were not kept')
    const batches = since.map((applied) => applied.batch)
    const record = applyThreadLogBatches(base, batches)
    if (revisionOf(record) !== head)
      throw new Error('Thread log load: the record is not at the head')
    const applied = clock()
    const timings = (): HostThreadLogLoadTimings => ({
      checkpointMs,
      checkpoints,
      checkpointBytes,
      followMs: followed - started - checkpointMs,
      applyMs: applied - followed,
      batches: batches.length,
      cutMs: clock() - applied,
      totalMs: clock() - started
    })
    if (!request.window) return { kind: 'record', record, timings: timings() }
    const cut = HostThreadLogFollower.windowOf(record, request.window)
    const seed: HostThreadLogWindowSeed = {
      kind: 'window',
      ...cut,
      readFrom: follower.readPositions(),
      entriesBefore: hostThreadLogEntriesBefore(record, cut)
    }
    return { kind: 'window', seed, timings: timings() }
  } finally {
    follower.close()
  }
}

/** A load asked of the seed worker. */
export interface HostThreadLogLoadMessage extends HostThreadLogLoadRequest {
  readonly id: number
}

export type HostThreadLogLoadReply =
  | { readonly id: number; readonly ok: true; readonly result: HostThreadLogLoadResult }
  | { readonly id: number; readonly ok: false; readonly message: string }

/** The worker's side of its channel to the Host. */
export interface HostThreadLogLoadChannel {
  on(event: 'message', listener: (message: unknown) => void): unknown
  postMessage(message: HostThreadLogLoadReply): void
}

function isWindowBounds(value: unknown): value is HostThreadLogWindowBounds {
  return (
    isPlainObject(value) &&
    Number.isSafeInteger(value.messages) &&
    (value.messages as number) >= 0 &&
    Number.isSafeInteger(value.runs) &&
    (value.runs as number) >= 0 &&
    Number.isSafeInteger(value.maxViewBytes) &&
    (value.maxViewBytes as number) >= 1
  )
}

/**
 * Answer the loads the Host asks for, one at a time, so a worker holds one
 * record at once.
 */
export function serveHostThreadLogLoads(channel: HostThreadLogLoadChannel): void {
  let queue = Promise.resolve()
  channel.on('message', (message) => {
    queue = queue.then(async () => {
      const request = message as Partial<HostThreadLogLoadMessage> | null
      const id = Number.isSafeInteger(request?.id) ? (request!.id as number) : -1
      try {
        if (
          id < 0 ||
          typeof request?.directory !== 'string' ||
          typeof request.chatId !== 'string' ||
          (request.window !== undefined && !isWindowBounds(request.window))
        ) {
          throw new Error('Thread log load: not a load request')
        }
        const result = await loadThreadLog({
          directory: request.directory,
          chatId: request.chatId,
          ...(request.window ? { window: request.window } : {})
        })
        channel.postMessage({ id, ok: true, result })
      } catch (error) {
        channel.postMessage({
          id,
          ok: false,
          message: error instanceof Error ? error.message : String(error)
        })
      }
    })
  })
}
