/**
 * The debt ledger is driven here through a port whose syncs settle only when
 * the test says so, which is what lets a note, a second barrier or a failure
 * be placed at an exact point of a barrier.
 */
import { beforeEach, describe, expect, it } from 'vitest'

import {
  createThreadDurabilityDebt,
  type ThreadDurabilityDebt,
  type ThreadDurabilityPort,
  type ThreadDurabilitySyncOutcome
} from './ThreadDurabilityDebt'

interface PendingSync {
  kind: 'file' | 'directory'
  path: string
  resolve(outcome: ThreadDurabilitySyncOutcome): void
  reject(error: Error): void
}

class HeldPort implements ThreadDurabilityPort {
  /** Every sync asked for, in order, as `file <path>` or `directory <path>`. */
  calls: string[] = []
  private pending: PendingSync[] = []

  private ask(kind: PendingSync['kind'], path: string): Promise<ThreadDurabilitySyncOutcome> {
    this.calls.push(`${kind} ${path}`)
    return new Promise((resolve, reject) => {
      this.pending.push({ kind, path, resolve, reject })
    })
  }

  syncFile(path: string): Promise<ThreadDurabilitySyncOutcome> {
    return this.ask('file', path)
  }

  syncDirectory(path: string): Promise<ThreadDurabilitySyncOutcome> {
    return this.ask('directory', path)
  }

  waiting(): string[] {
    return this.pending.map((sync) => `${sync.kind} ${sync.path}`)
  }

  private take(path: string): PendingSync {
    const index = this.pending.findIndex((sync) => sync.path === path)
    if (index < 0) throw new Error(`no sync of ${path} is waiting`)
    return this.pending.splice(index, 1)[0]
  }

  finish(path: string, outcome: ThreadDurabilitySyncOutcome = 'synced'): void {
    this.take(path).resolve(outcome)
  }

  fail(path: string, message = 'EIO: i/o error, fsync'): void {
    this.take(path).reject(Object.assign(new Error(message), { code: 'EIO' }))
  }

  finishAll(): void {
    for (const sync of this.pending.splice(0)) sync.resolve('synced')
  }
}

/** Lets every promise callback that is ready run. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

/** How a promise stands right now: `waiting`, `resolved`, or the message it rejected with. */
function watch(promise: Promise<void>): { state: string } {
  const seen = { state: 'waiting' }
  promise.then(
    () => {
      seen.state = 'resolved'
    },
    (error: Error) => {
      seen.state = error.message
    }
  )
  return seen
}

describe('thread durability debt', () => {
  let port: HeldPort
  let clock: number
  let debt: ThreadDurabilityDebt

  beforeEach(() => {
    port = new HeldPort()
    clock = 1_000
    debt = createThreadDurabilityDebt({ port, now: () => clock })
  })

  const journal = '/p/chat-journal-v2/chat-1.mutations.jsonl'
  const events = '/p/run-events/chat-1/run-1.jsonl'
  const detail = '/p/tool-detail/chat-1/call-1.json'
  const journalDirectory = '/p/chat-journal-v2'
  const eventsDirectory = '/p/run-events/chat-1'

  describe('noting', () => {
    it('never calls the port, however much is noted', async () => {
      debt.note('chat-1', { file: journal, owner: 'journal' })
      debt.note('chat-1', { directory: journalDirectory })
      expect(port.calls).toEqual([])
      await settle()
      expect(port.calls).toEqual([])
    })

    it('keeps one entry for a path however often it is noted: 100,000 notes over 500 threads', () => {
      const threads = 500
      const perThread = 200
      for (let round = 0; round < perThread; round += 1) {
        for (let thread = 0; thread < threads; thread += 1) {
          const chatId = `chat-${thread}`
          switch (round % 5) {
            case 0:
              debt.note(chatId, { file: `/p/journal/${chatId}.jsonl`, owner: 'journal' })
              break
            case 1:
              debt.note(chatId, { file: `/p/events/${chatId}.jsonl`, owner: 'run-events' })
              break
            case 2:
              debt.note(chatId, { file: `/p/detail/${chatId}/${round % 15}.json`, owner: 'detail' })
              break
            case 3:
              debt.note(chatId, { file: `/p/catalogue/${chatId}.head.json`, owner: 'catalogue' })
              break
            default:
              debt.note(chatId, { directory: `/p/detail/${chatId}` })
          }
        }
      }

      expect(port.calls).toEqual([])
      const snapshot = debt.snapshot()
      expect(Object.values(snapshot.owners).reduce((sum, owner) => sum + owner.noted, 0)).toBe(
        threads * perThread
      )
      expect(snapshot.owners.detail.noted).toBe(threads * (perThread / 5))
      // Journal, run events, catalogue head, three detail files; one directory.
      expect(snapshot.owed).toEqual({ threads, files: threads * 6, directories: threads })
    })
  })

  describe('a barrier', () => {
    it('resolves at once for a thread that owes nothing, without calling the port', async () => {
      await expect(debt.barrier('chat-1')).resolves.toBeUndefined()
      expect(port.calls).toEqual([])
      expect(debt.snapshot().barriers).toMatchObject({ raised: 1, idle: 1, rounds: 0 })
    })

    it('syncs each owed file once, and the directories only after every file is done', async () => {
      debt.note('chat-1', { directory: journalDirectory })
      debt.note('chat-1', { file: journal, owner: 'journal' })
      debt.note('chat-1', { file: journal, owner: 'journal' })
      debt.note('chat-1', { file: events, owner: 'run-events' })
      debt.note('chat-1', { directory: eventsDirectory })
      debt.note('chat-1', { file: detail, owner: 'detail' })

      const barrier = watch(debt.barrier('chat-1'))
      expect(port.calls).toEqual([`file ${journal}`, `file ${events}`, `file ${detail}`])

      port.finish(journal)
      port.finish(events)
      await settle()
      expect(port.calls).toHaveLength(3)
      expect(barrier.state).toBe('waiting')

      port.finish(detail)
      await settle()
      expect(port.calls.slice(3)).toEqual([
        `directory ${journalDirectory}`,
        `directory ${eventsDirectory}`
      ])
      expect(barrier.state).toBe('waiting')

      port.finishAll()
      await settle()
      expect(barrier.state).toBe('resolved')
      expect(port.calls).toHaveLength(5)
    })

    it('drops the thread when everything it owed is paid', async () => {
      debt.note('chat-1', { file: journal, owner: 'journal' })
      const barrier = debt.barrier('chat-1')
      expect(debt.snapshot().owed).toEqual({ threads: 1, files: 0, directories: 0 })
      port.finishAll()
      await barrier
      expect(debt.snapshot().owed).toEqual({ threads: 0, files: 0, directories: 0 })
    })

    it('leaves what is noted while it runs to the next barrier', async () => {
      debt.note('chat-1', { file: journal, owner: 'journal' })
      const first = watch(debt.barrier('chat-1'))
      debt.note('chat-1', { file: events, owner: 'run-events' })
      debt.note('chat-1', { directory: eventsDirectory })

      port.finishAll()
      await settle()
      expect(first.state).toBe('resolved')
      expect(port.calls).toEqual([`file ${journal}`])
      expect(debt.snapshot().owed).toEqual({ threads: 1, files: 1, directories: 1 })

      const second = watch(debt.barrier('chat-1'))
      port.finishAll()
      await settle()
      port.finishAll()
      await settle()
      expect(second.state).toBe('resolved')
      expect(port.calls.slice(1)).toEqual([`file ${events}`, `directory ${eventsDirectory}`])
    })

    it('syncs a file again when it was noted again while its sync was in flight', async () => {
      debt.note('chat-1', { file: journal, owner: 'journal' })
      const first = watch(debt.barrier('chat-1'))
      // Written again after the sync was asked for: that sync may not cover it.
      debt.note('chat-1', { file: journal, owner: 'journal' })
      port.finish(journal)
      await settle()
      expect(first.state).toBe('resolved')

      const second = watch(debt.barrier('chat-1'))
      expect(port.calls).toEqual([`file ${journal}`, `file ${journal}`])
      port.finishAll()
      await settle()
      expect(second.state).toBe('resolved')
    })
  })

  describe('barriers on one thread', () => {
    it('share the barrier that is running when nothing has been noted since it began', async () => {
      debt.note('chat-1', { file: journal, owner: 'journal' })
      const first = watch(debt.barrier('chat-1'))
      const second = watch(debt.barrier('chat-1'))
      const third = watch(debt.barrier('chat-1'))
      expect(port.calls).toEqual([`file ${journal}`])

      port.finishAll()
      await settle()
      expect([first.state, second.state, third.state]).toEqual(['resolved', 'resolved', 'resolved'])
      expect(port.calls).toHaveLength(1)
      expect(debt.snapshot().barriers).toMatchObject({ raised: 3, shared: 2, rounds: 1 })
    })

    it('share one following barrier for what was noted after the running one began', async () => {
      debt.note('chat-1', { file: journal, owner: 'journal' })
      const first = watch(debt.barrier('chat-1'))
      debt.note('chat-1', { file: events, owner: 'run-events' })
      const second = watch(debt.barrier('chat-1'))
      debt.note('chat-1', { file: detail, owner: 'detail' })
      const third = watch(debt.barrier('chat-1'))
      // Nothing more is asked of the port until the running barrier is done.
      expect(port.calls).toEqual([`file ${journal}`])

      port.finish(journal)
      await settle()
      expect(first.state).toBe('resolved')
      expect([second.state, third.state]).toEqual(['waiting', 'waiting'])
      expect(port.calls.slice(1)).toEqual([`file ${events}`, `file ${detail}`])

      port.finishAll()
      await settle()
      expect([second.state, third.state]).toEqual(['resolved', 'resolved'])
      expect(debt.snapshot().barriers).toMatchObject({ raised: 3, shared: 1, rounds: 2 })
    })
  })

  describe('a barrier raised in the moment between one ending and the next beginning', () => {
    it('pays for the queued one too, and what it fails to sync stays owed', async () => {
      debt.note('chat-1', { file: journal, owner: 'journal' })
      const first = debt.barrier('chat-1')
      // The first caller is told before the queued barrier starts, and raises
      // another straight away.
      let inTheGap = { state: 'not raised' }
      void first.then(() => {
        debt.note('chat-1', { file: detail, owner: 'detail' })
        inTheGap = watch(debt.barrier('chat-1'))
      })
      debt.note('chat-1', { file: events, owner: 'run-events' })
      const queued = watch(debt.barrier('chat-1'))

      port.finish(journal)
      await settle()
      expect(port.calls.slice(1)).toEqual([`file ${events}`, `file ${detail}`])
      expect(debt.snapshot().barriers).toMatchObject({ raised: 3, rounds: 2 })

      port.finish(detail)
      port.fail(events)
      await settle()
      expect([queued.state, inTheGap.state]).toEqual([
        'EIO: i/o error, fsync',
        'EIO: i/o error, fsync'
      ])
      expect(debt.snapshot().owed).toEqual({ threads: 1, files: 1, directories: 0 })
      expect(debt.snapshot().barriers).toMatchObject({ rounds: 2, failed: 1 })
    })
  })

  describe('barriers on different threads', () => {
    it('do not wait for each other', async () => {
      debt.note('chat-1', { file: journal, owner: 'journal' })
      debt.note('chat-2', { file: '/p/chat-journal-v2/chat-2.mutations.jsonl', owner: 'journal' })
      const one = watch(debt.barrier('chat-1'))
      const two = watch(debt.barrier('chat-2'))
      // Both are with the port at once: how many run together is the port's rule.
      expect(port.waiting()).toHaveLength(2)

      port.finish('/p/chat-journal-v2/chat-2.mutations.jsonl')
      await settle()
      expect([one.state, two.state]).toEqual(['waiting', 'resolved'])
      port.finishAll()
      await settle()
      expect(one.state).toBe('resolved')
    })
  })

  describe('a sync that fails', () => {
    it('rejects the barrier, keeps what failed owed, and leaves the directories for later', async () => {
      debt.note('chat-1', { file: journal, owner: 'journal' })
      debt.note('chat-1', { file: events, owner: 'run-events' })
      debt.note('chat-1', { directory: journalDirectory })
      const barrier = watch(debt.barrier('chat-1'))

      port.finish(events)
      port.fail(journal)
      await settle()

      expect(barrier.state).toBe('EIO: i/o error, fsync')
      // A name is not made durable before the data it names.
      expect(port.calls).toEqual([`file ${journal}`, `file ${events}`])
      expect(debt.snapshot().owed).toEqual({ threads: 1, files: 1, directories: 1 })
      expect(debt.snapshot().owners.journal).toMatchObject({ synced: 0, failed: 1 })
      expect(debt.snapshot().owners['run-events']).toMatchObject({ synced: 1, failed: 0 })
    })

    it('is tried again by the next barrier, which does not repeat what succeeded', async () => {
      debt.note('chat-1', { file: journal, owner: 'journal' })
      debt.note('chat-1', { file: events, owner: 'run-events' })
      debt.note('chat-1', { directory: journalDirectory })
      const failed = watch(debt.barrier('chat-1'))
      port.finish(events)
      port.fail(journal)
      await settle()
      expect(failed.state).not.toBe('resolved')

      const retry = watch(debt.barrier('chat-1'))
      expect(port.calls.slice(2)).toEqual([`file ${journal}`])
      port.finishAll()
      await settle()
      expect(port.calls.slice(3)).toEqual([`directory ${journalDirectory}`])
      port.finishAll()
      await settle()
      expect(retry.state).toBe('resolved')
      expect(debt.snapshot().owed).toEqual({ threads: 0, files: 0, directories: 0 })
    })

    it('keeps a directory owed when its own sync fails', async () => {
      debt.note('chat-1', { file: journal, owner: 'journal' })
      debt.note('chat-1', { directory: journalDirectory })
      const barrier = watch(debt.barrier('chat-1'))
      port.finish(journal)
      await settle()
      port.fail(journalDirectory)
      await settle()

      expect(barrier.state).toBe('EIO: i/o error, fsync')
      expect(debt.snapshot().owed).toEqual({ threads: 1, files: 0, directories: 1 })
      expect(debt.snapshot().owners.directory).toMatchObject({ synced: 0, failed: 1 })
    })

    it('rejects everyone waiting on that barrier and nobody waiting on another', async () => {
      debt.note('chat-1', { file: journal, owner: 'journal' })
      debt.note('chat-2', { file: '/p/chat-journal-v2/chat-2.mutations.jsonl', owner: 'journal' })
      const first = watch(debt.barrier('chat-1'))
      const sharing = watch(debt.barrier('chat-1'))
      const other = watch(debt.barrier('chat-2'))
      debt.note('chat-1', { file: events, owner: 'run-events' })
      const following = watch(debt.barrier('chat-1'))

      port.fail(journal)
      await settle()
      expect([first.state, sharing.state]).toEqual([
        'EIO: i/o error, fsync',
        'EIO: i/o error, fsync'
      ])
      expect([other.state, following.state]).toEqual(['waiting', 'waiting'])

      // The following barrier pays what the failed one left as well as its own.
      expect(port.calls.slice(2).sort()).toEqual([`file ${events}`, `file ${journal}`].sort())
      port.finishAll()
      await settle()
      expect([other.state, following.state]).toEqual(['resolved', 'resolved'])
      expect(debt.snapshot().barriers).toMatchObject({ rounds: 3, failed: 1 })
    })
  })

  describe('a path that is gone', () => {
    it('is settled, not an error: the directory that lost the name is what is owed', async () => {
      debt.note('chat-1', { file: journal, owner: 'journal' })
      debt.note('chat-1', { directory: journalDirectory })
      const barrier = watch(debt.barrier('chat-1'))

      port.finish(journal, 'missing')
      await settle()
      expect(port.calls.slice(1)).toEqual([`directory ${journalDirectory}`])
      port.finish(journalDirectory, 'missing')
      await settle()

      expect(barrier.state).toBe('resolved')
      expect(debt.snapshot().owed).toEqual({ threads: 0, files: 0, directories: 0 })
      expect(debt.snapshot().owners.journal).toMatchObject({ synced: 0, missing: 1, failed: 0 })
      expect(debt.snapshot().owners.directory).toMatchObject({ synced: 0, missing: 1, failed: 0 })
    })
  })

  describe('a file renamed while a barrier runs', () => {
    const sealed = '/p/chat-journal-v2/chat-1.sealed.mutations.jsonl'
    const renamed = { file: sealed, owner: 'journal', renamedFrom: journal } as const

    it('is synced under its new name before the barrier settles, when the barrier was asked for the old one', async () => {
      debt.note('chat-1', { file: journal, owner: 'journal' })
      debt.note('chat-1', { directory: journalDirectory })
      const barrier = watch(debt.barrier('chat-1'))
      expect(port.calls).toEqual([`file ${journal}`])

      // The sync asked for may reach the old name only now, and find nothing
      // there, or the file that was made under it since.
      debt.note('chat-1', renamed)
      port.finish(journal, 'missing')
      await settle()

      expect(port.calls).toEqual([`file ${journal}`, `file ${sealed}`])
      expect(barrier.state).toBe('waiting')
      port.finish(sealed)
      await settle()
      expect(port.calls.slice(2)).toEqual([`directory ${journalDirectory}`])
      expect(barrier.state).toBe('waiting')
      port.finish(journalDirectory)
      await settle()
      expect(barrier.state).toBe('resolved')
      expect(debt.snapshot().barriers).toMatchObject({ rounds: 1, renamedUnderway: 1 })
      expect(debt.snapshot().owners.journal).toMatchObject({ noted: 2, synced: 1, missing: 1 })
    })

    it('is owed to the next barrier as well, like anything else noted while one runs', async () => {
      debt.note('chat-1', { file: journal, owner: 'journal' })
      const first = watch(debt.barrier('chat-1'))
      debt.note('chat-1', renamed)
      expect(debt.snapshot().owed).toEqual({ threads: 1, files: 1, directories: 0 })
      port.finishAll()
      await settle()
      port.finishAll()
      await settle()
      expect(first.state).toBe('resolved')
      expect(debt.snapshot().owed).toEqual({ threads: 1, files: 1, directories: 0 })

      const second = watch(debt.barrier('chat-1'))
      expect(port.calls).toEqual([`file ${journal}`, `file ${sealed}`, `file ${sealed}`])
      port.finishAll()
      await settle()
      expect(second.state).toBe('resolved')
    })

    it('is left to the next barrier when the running one was not asked for the old name', async () => {
      debt.note('chat-1', { file: events, owner: 'run-events' })
      const barrier = watch(debt.barrier('chat-1'))

      debt.note('chat-1', renamed)
      port.finish(events)
      await settle()

      expect(barrier.state).toBe('resolved')
      expect(port.calls).toEqual([`file ${events}`])
      expect(debt.snapshot().barriers.renamedUnderway).toBe(0)
      expect(debt.snapshot().owed).toEqual({ threads: 1, files: 1, directories: 0 })
    })

    it('is left to the next barrier once the running one has finished its files: that sync ran before the rename', async () => {
      debt.note('chat-1', { file: journal, owner: 'journal' })
      debt.note('chat-1', { directory: journalDirectory })
      const barrier = watch(debt.barrier('chat-1'))
      port.finish(journal)
      await settle()
      expect(port.waiting()).toEqual([`directory ${journalDirectory}`])

      debt.note('chat-1', renamed)
      port.finish(journalDirectory)
      await settle()

      expect(barrier.state).toBe('resolved')
      expect(port.calls).toEqual([`file ${journal}`, `directory ${journalDirectory}`])
      expect(debt.snapshot().barriers.renamedUnderway).toBe(0)
      expect(debt.snapshot().owed).toEqual({ threads: 1, files: 1, directories: 0 })
    })

    it('is an ordinary debt when no barrier is running', async () => {
      debt.note('chat-1', renamed)
      expect(debt.snapshot().barriers.renamedUnderway).toBe(0)

      const barrier = watch(debt.barrier('chat-1'))
      expect(port.calls).toEqual([`file ${sealed}`])
      port.finishAll()
      await settle()
      expect(barrier.state).toBe('resolved')
    })

    it('is followed through a second rename, and one made while the first new name was being synced', async () => {
      const second = '/p/chat-journal-v2/chat-1.second'
      const third = '/p/chat-journal-v2/chat-1.third'
      debt.note('chat-1', { file: journal, owner: 'journal' })
      const barrier = watch(debt.barrier('chat-1'))

      debt.note('chat-1', { file: second, owner: 'journal', renamedFrom: journal })
      port.finish(journal, 'missing')
      await settle()
      expect(port.waiting()).toEqual([`file ${second}`])
      debt.note('chat-1', { file: third, owner: 'journal', renamedFrom: second })
      port.finish(second, 'missing')
      await settle()

      expect(port.calls).toEqual([`file ${journal}`, `file ${second}`, `file ${third}`])
      expect(barrier.state).toBe('waiting')
      port.finish(third)
      await settle()
      expect(barrier.state).toBe('resolved')
      expect(debt.snapshot().barriers.renamedUnderway).toBe(2)
    })

    it('rejects the barrier when the sync under the new name fails, and no directory is reached', async () => {
      debt.note('chat-1', { file: journal, owner: 'journal' })
      debt.note('chat-1', { directory: journalDirectory })
      const barrier = watch(debt.barrier('chat-1'))
      debt.note('chat-1', renamed)
      port.finish(journal, 'missing')
      await settle()

      port.fail(sealed, 'EIO: the sealed segment')
      await settle()

      expect(barrier.state).toBe('EIO: the sealed segment')
      expect(port.calls).toEqual([`file ${journal}`, `file ${sealed}`])
      expect(debt.snapshot().owed).toEqual({ threads: 1, files: 1, directories: 1 })
      expect(debt.snapshot().owners.journal).toMatchObject({ failed: 1 })
      expect(debt.snapshot().barriers).toMatchObject({ rounds: 1, failed: 1 })
    })

    it('is not followed by a barrier whose own file sync has already failed', async () => {
      debt.note('chat-1', { file: journal, owner: 'journal' })
      debt.note('chat-1', { file: events, owner: 'run-events' })
      const barrier = watch(debt.barrier('chat-1'))
      debt.note('chat-1', renamed)
      port.fail(events, 'EIO: run events')
      port.finish(journal, 'missing')
      await settle()

      expect(barrier.state).toBe('EIO: run events')
      expect(port.calls).toEqual([`file ${journal}`, `file ${events}`])
      // The new name and the file that failed are both owed to the next barrier.
      expect(debt.snapshot().owed).toEqual({ threads: 1, files: 2, directories: 0 })
    })

    it('is dropped with the rest when the thread is forgotten while the barrier runs', async () => {
      debt.note('chat-1', { file: journal, owner: 'journal' })
      const barrier = watch(debt.barrier('chat-1'))
      debt.note('chat-1', renamed)
      debt.forget('chat-1')

      port.finish(journal, 'missing')
      await settle()
      port.finishAll()
      await settle()

      expect(barrier.state).toBe('resolved')
      expect(debt.snapshot().owed).toEqual({ threads: 0, files: 0, directories: 0 })
    })
  })

  describe('forget', () => {
    it('drops what a thread owes without a sync', async () => {
      debt.note('chat-1', { file: journal, owner: 'journal' })
      debt.note('chat-1', { directory: journalDirectory })
      debt.note('chat-2', { file: events, owner: 'run-events' })

      debt.forget('chat-1')

      expect(debt.snapshot().owed).toEqual({ threads: 1, files: 1, directories: 0 })
      await expect(debt.barrier('chat-1')).resolves.toBeUndefined()
      expect(port.calls).toEqual([])
    })

    it('does not take back what a running barrier fails to sync, nor run the one queued behind it', async () => {
      debt.note('chat-1', { file: journal, owner: 'journal' })
      const running = watch(debt.barrier('chat-1'))
      debt.note('chat-1', { file: events, owner: 'run-events' })
      const queued = watch(debt.barrier('chat-1'))

      debt.forget('chat-1')
      port.fail(journal)
      await settle()

      expect(running.state).toBe('EIO: i/o error, fsync')
      expect(queued.state).toBe('resolved')
      expect(port.calls).toEqual([`file ${journal}`])
      expect(debt.snapshot().owed).toEqual({ threads: 0, files: 0, directories: 0 })
    })

    it('leaves what is noted afterwards to a barrier of its own', async () => {
      debt.note('chat-1', { file: journal, owner: 'journal' })
      const running = watch(debt.barrier('chat-1'))
      debt.forget('chat-1')
      debt.note('chat-1', { file: events, owner: 'run-events' })

      // The barrier from before the erasure ends without touching what came after it.
      port.finish(journal)
      await settle()
      expect(running.state).toBe('resolved')
      expect(debt.snapshot().owed).toEqual({ threads: 1, files: 1, directories: 0 })

      const later = watch(debt.barrier('chat-1'))
      expect(port.calls).toEqual([`file ${journal}`, `file ${events}`])
      port.finishAll()
      await settle()
      expect(later.state).toBe('resolved')
      expect(debt.snapshot().owed).toEqual({ threads: 0, files: 0, directories: 0 })
    })
  })

  describe('a port that throws instead of rejecting', () => {
    it('has failed that sync, and the next barrier tries again', async () => {
      let broken = true
      const throwing: ThreadDurabilityPort = {
        syncFile: (path) => {
          if (broken) throw new Error(`cannot start a sync of ${path}`)
          return Promise.resolve('synced')
        },
        syncDirectory: () => Promise.resolve('synced')
      }
      const local = createThreadDurabilityDebt({ port: throwing, now: () => clock })
      local.note('chat-1', { file: journal, owner: 'journal' })

      await expect(local.barrier('chat-1')).rejects.toThrow(`cannot start a sync of ${journal}`)
      expect(local.snapshot().owed).toEqual({ threads: 1, files: 1, directories: 0 })

      broken = false
      await expect(local.barrier('chat-1')).resolves.toBeUndefined()
      expect(local.snapshot().owed).toEqual({ threads: 0, files: 0, directories: 0 })
      expect(local.snapshot().owners.journal).toMatchObject({ synced: 1, failed: 1 })
    })
  })

  describe('counters', () => {
    it('count by owner what was noted, synced, found gone and failed', async () => {
      debt.note('chat-1', { file: journal, owner: 'journal' })
      debt.note('chat-1', { file: journal, owner: 'journal' })
      debt.note('chat-1', { file: events, owner: 'run-events' })
      debt.note('chat-1', { file: detail, owner: 'detail' })
      debt.note('chat-1', { file: '/p/catalogue/chat-1.head.json', owner: 'catalogue' })
      debt.note('chat-1', { directory: journalDirectory })
      const barrier = debt.barrier('chat-1')
      port.finish(journal)
      port.finish(events, 'missing')
      port.finish(detail)
      port.finish('/p/catalogue/chat-1.head.json')
      await settle()
      port.finishAll()
      await barrier

      const counted = debt.snapshot()
      debt.note('chat-1', { file: journal, owner: 'journal' })
      // A snapshot is a copy: it does not move with the counters afterwards.
      expect(counted.owners).toEqual({
        journal: { noted: 2, synced: 1, missing: 0, failed: 0 },
        'run-events': { noted: 1, synced: 0, missing: 1, failed: 0 },
        detail: { noted: 1, synced: 1, missing: 0, failed: 0 },
        catalogue: { noted: 1, synced: 1, missing: 0, failed: 0 },
        directory: { noted: 1, synced: 1, missing: 0, failed: 0 }
      })
    })

    it('time each barrier from when it was raised to when it settled', async () => {
      debt.note('chat-1', { file: journal, owner: 'journal' })
      const first = debt.barrier('chat-1')
      clock += 4
      const sharing = debt.barrier('chat-1')
      clock += 6
      port.finishAll()
      await Promise.all([first, sharing])
      await settle()

      // Ten for the first, six for the one that joined it four later.
      expect(debt.snapshot().barriers).toMatchObject({
        raised: 2,
        waitMsTotal: 16,
        longestWaitMs: 10
      })
    })

    it('report no sync on the calling thread: the port has no call that could make one', () => {
      debt.note('chat-1', { file: journal, owner: 'journal' })
      void debt.barrier('chat-1')
      expect(debt.snapshot().syncsOnCallingThread).toBe(0)
    })
  })
})
