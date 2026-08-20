/**
 * Take the directory fsync off the thread `writeJson` runs on.
 *
 * `writeJson` performs TWO fsyncs per call and they are, together, 92% of its
 * cost — measured 2026-08-20 on a 2 MB payload: file fsync 7.2 ms (56%),
 * directory fsync 4.7 ms (36%), everything else (mkdir/open/write/close/
 * rename/chmod) 0.9 ms combined.
 *
 * Only the DIRECTORY fsync can move, and the distinction is load-bearing:
 *
 *  - The FILE fsync must stay synchronous and must stay BEFORE the rename. It
 *    is what guarantees the bytes are on disk by the time the name points at
 *    them. Deferring it past the rename converts a crash from "old contents"
 *    into "new name, unflushed contents" — corruption, not staleness. It is the
 *    bigger half and it is not available.
 *  - The DIRECTORY fsync only makes the RENAME durable. Losing it costs a crash
 *    window in which the directory entry still names the previous file — a
 *    consistent earlier state, never a torn one. The call site has always
 *    treated it as best effort (it was wrapped in a bare try/catch, comment
 *    "Directory fsync is best effort on some filesystems"), so moving it off
 *    the thread does not widen the failure model at all: an fsync that has not
 *    run yet and an fsync that threw are the same outcome.
 *
 * COALESCING IS LEADING-AND-TRAILING, and that matters. Dropping a request
 * because one is already in flight would be wrong: the in-flight fsync may have
 * started before the newer rename, so that rename would never be covered by
 * any fsync. A request arriving during a flush therefore marks the directory
 * dirty and re-runs afterwards. The queue collapses N writes into at most 2
 * fsyncs per directory per flush cycle rather than N — which is a second win,
 * since a hot store writes the same directory repeatedly.
 */
import * as fs from 'fs'

export interface DirectoryFsyncQueue {
  /** Request that `directory`'s entries be flushed. Never throws, never blocks. */
  schedule(directory: string): void
  /** Resolves once nothing is in flight or waiting. For tests and shutdown. */
  drain(): Promise<void>
  /** Directories currently in flight or waiting. */
  pending(): number
}

export interface DirectoryFsyncQueueAdapters {
  open?: (dir: string, cb: (error: NodeJS.ErrnoException | null, fd: number) => void) => void
  fsync?: (fd: number, cb: (error: NodeJS.ErrnoException | null) => void) => void
  close?: (fd: number, cb: (error: NodeJS.ErrnoException | null) => void) => void
}

export function createDirectoryFsyncQueue(
  adapters: DirectoryFsyncQueueAdapters = {}
): DirectoryFsyncQueue {
  const open = adapters.open ?? ((dir, cb) => fs.open(dir, 'r', cb))
  const fsync = adapters.fsync ?? ((fd, cb) => fs.fsync(fd, cb))
  const close = adapters.close ?? ((fd, cb) => fs.close(fd, cb))

  const inFlight = new Set<string>()
  const dirty = new Set<string>()
  let waiters: Array<() => void> = []

  const settleIfIdle = (): void => {
    if (inFlight.size > 0 || dirty.size > 0) return
    const pendingWaiters = waiters
    waiters = []
    for (const resolve of pendingWaiters) resolve()
  }

  const run = (directory: string): void => {
    inFlight.add(directory)
    const finish = (): void => {
      inFlight.delete(directory)
      // Re-run for anything that landed while this flush was in progress; that
      // rename is not covered by the fsync which had already started.
      if (dirty.delete(directory)) {
        run(directory)
        return
      }
      settleIfIdle()
    }
    let opened: number | null = null
    try {
      open(directory, (openError, fd) => {
        // Every failure here is tolerated by design — see the header.
        if (openError) {
          finish()
          return
        }
        opened = fd
        try {
          fsync(fd, () => {
            try {
              close(fd, () => finish())
            } catch {
              finish()
            }
          })
        } catch {
          try {
            close(fd, () => finish())
          } catch {
            finish()
          }
        }
      })
    } catch {
      if (opened !== null) {
        try {
          close(opened, () => finish())
          return
        } catch {
          // fall through
        }
      }
      finish()
    }
  }

  return {
    schedule(directory: string): void {
      if (!directory) return
      if (inFlight.has(directory)) {
        dirty.add(directory)
        return
      }
      run(directory)
    },
    drain(): Promise<void> {
      if (inFlight.size === 0 && dirty.size === 0) return Promise.resolve()
      return new Promise<void>((resolve) => {
        waiters.push(resolve)
      })
    },
    pending(): number {
      return inFlight.size + dirty.size
    }
  }
}
