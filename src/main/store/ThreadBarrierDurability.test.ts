import { afterEach, describe, expect, it, vi } from 'vitest'

import { ChatDurabilityTickets } from './ChatDurabilityTickets'
import { deriveChatRecordMutationWithProjection } from './ChatRecordMutation'
import { MainCatalogueUnsyncedDurability } from './MainCatalogueUnsyncedDurability'
import { barriersForSaveMoments, createThreadBarrierDurability } from './ThreadBarrierDurability'
import type {
  ThreadDurabilityBarrierOptions,
  ThreadDurabilityPort,
  ThreadDurabilitySyncOutcome
} from './ThreadDurabilityDebt'
import type { ChatRecord } from './types'

function recordingPort(): ThreadDurabilityPort & { paid: string[] } {
  const paid: string[] = []
  const pay = async (target: string): Promise<ThreadDurabilitySyncOutcome> => {
    paid.push(target)
    return 'synced'
  }
  return {
    paid,
    syncFile: (target) => pay(`file:${target}`),
    syncDirectory: (target) => pay(`directory:${target}`)
  }
}

describe('the barrier durability layer', () => {
  it('hands the thread stores one note, and pays what they noted at a thread barrier', async () => {
    const port = recordingPort()
    const layer = createThreadBarrierDurability({ port })

    layer.note('chat-1', { file: '/p/chat-journal-v2/chat-1.mutations.jsonl', owner: 'journal' })
    layer.note('chat-1', { directory: '/p/chat-journal-v2' })
    layer.note('chat-2', { file: '/p/run-events/run-9.jsonl', owner: 'run-events', run: 'run-9' })
    expect(port.paid).toEqual([])

    await layer.debt.barrier('chat-1')

    expect(port.paid).toEqual([
      'file:/p/chat-journal-v2/chat-1.mutations.jsonl',
      'directory:/p/chat-journal-v2'
    ])
    expect(layer.debt.snapshot().owed).toEqual({ threads: 1, files: 1, directories: 0 })
  })

  it('gives the journal the note, and the repair of a torn tail before its next append', () => {
    const layer = createThreadBarrierDurability({ port: recordingPort() })

    expect(layer.journal).toEqual({
      noteDurabilityDebt: layer.note,
      repairTornTailBeforeAppend: true
    })
  })

  it("gives a save's tool-detail writer the note for that save's thread", () => {
    const layer = createThreadBarrierDurability({ port: recordingPort() })

    expect(layer.detail('chat-1')).toEqual({ chatId: 'chat-1', note: layer.note })
  })

  it('gives the catalogue the seam that writes heads and tickets owed to no barrier', async () => {
    const layer = createThreadBarrierDurability({ port: recordingPort() })

    const seam = layer.catalogue('/profile')

    expect(seam).toBeInstanceOf(MainCatalogueUnsyncedDurability)
    await expect(seam.awaitDurable()).resolves.toBeUndefined()
  })

  it('keeps one set of tickets, timed by its clock', () => {
    let now = 1_000
    const layer = createThreadBarrierDurability({ port: recordingPort(), now: () => now })

    expect(layer.tickets).toBeInstanceOf(ChatDurabilityTickets)
    layer.tickets.note('chat-1', 3, 'user_message', Promise.resolve())
    now += 5
    expect(layer.tickets.snapshot().moments.user_message.noted).toBe(1)
  })

  it('reports the debt, the tickets, the threads owing and, for the port it built, the port', () => {
    const built = createThreadBarrierDurability()
    // The fields this layer promises; the debt and the port may report more.
    expect(built.snapshot()).toMatchObject({
      debt: built.debt.snapshot(),
      port: { started: 0, inFlight: 0, queued: 0, joined: 0, peakInFlight: 0 },
      tickets: built.tickets.snapshot(),
      threads: { owing: 0, idleBarriers: 0, idleFailed: 0, quitThreads: 0, quitUnpaid: 0 }
    })
    // A port supplied from outside has no counters of its own to report.
    expect(createThreadBarrierDurability({ port: recordingPort() }).snapshot().port).toBeNull()
  })
})

const AT = '2026-10-05T00:00:00.000Z'

function thread(overrides: Partial<ChatRecord> = {}): ChatRecord {
  return {
    appChatId: 'chat-1',
    scope: 'global',
    chatKind: 'single',
    provider: 'codex',
    title: 'Thread',
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    persistenceRevision: 7,
    messages: [{ id: 'user-1', role: 'user', content: 'First question', timestamp: AT }],
    runs: [{ runId: 'run-1', startedAt: AT, status: 'running' }],
    ...overrides
  }
}

/** The save from `previous` to `next`, as the journal append returns it. */
function appended(previous: ChatRecord, next: ChatRecord) {
  return { derived: deriveChatRecordMutationWithProjection(previous, next) }
}

/** A port whose syncs wait until released. */
function heldPort(): ThreadDurabilityPort & { release(): void; asked: string[] } {
  const asked: string[] = []
  let release!: () => void
  const released = new Promise<void>((resolve) => (release = resolve))
  const hold = async (target: string): Promise<ThreadDurabilitySyncOutcome> => {
    asked.push(target)
    await released
    return 'synced'
  }
  return { asked, release, syncFile: hold, syncDirectory: hold }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('the tickets a save takes', () => {
  it("takes one for each moment at the revision its batch wrote: the user's on an urgent barrier, a run's end on one of its run", async () => {
    const port = heldPort()
    const layer = createThreadBarrierDurability({ port })
    const previous = thread()
    const next = {
      ...previous,
      persistenceRevision: 8,
      messages: [
        ...previous.messages,
        { id: 'user-2', role: 'user' as const, content: 'Stop there', timestamp: AT }
      ],
      runs: [{ runId: 'run-1', startedAt: AT, status: 'cancelled' }]
    }
    layer.note('chat-1', { file: '/p/chat-journal-v2/chat-1.mutations.jsonl', owner: 'journal' })
    // What another run of the thread wrote: neither barrier of this save pays it.
    layer.note('chat-1', { file: '/p/run-events/run-2.jsonl', owner: 'run-events', run: 'run-2' })

    expect(layer.noteSave(previous, next, appended(previous, next), 'normal')).toEqual([
      { moment: 'user_message' },
      { moment: 'run_final', runId: 'run-1' }
    ])

    const tickets = layer.tickets.snapshot().moments
    expect([tickets.user_message.pending, tickets.run_final.pending]).toEqual([1, 1])
    expect(layer.debt.snapshot().barriers).toMatchObject({
      raised: 2,
      urgent: 1,
      threadOnly: 1,
      scoped: 1
    })
    let settled = false
    const waited = layer.tickets.awaitChat('chat-1').then(() => (settled = true))
    await Promise.resolve()
    // The user's barrier took the journal; the run's, owed nothing else, joined it.
    expect(port.asked).toEqual(['/p/chat-journal-v2/chat-1.mutations.jsonl'])
    expect(settled).toBe(false)
    port.release()
    await waited
    expect(layer.tickets.snapshot().moments.user_message.covered).toBe(1)
    expect(layer.debt.snapshot().owed.files).toBe(1)
  })

  it("asks the port for the journal's two paths only, on a thread where runs owe files", async () => {
    const port = recordingPort()
    const layer = createThreadBarrierDurability({ port })
    const previous = thread()
    const next = {
      ...previous,
      persistenceRevision: 8,
      messages: [
        ...previous.messages,
        { id: 'user-2', role: 'user' as const, content: 'One more thing', timestamp: AT }
      ]
    }
    layer.note('chat-1', { file: '/p/chat-journal-v2/chat-1.mutations.jsonl', owner: 'journal' })
    layer.note('chat-1', { directory: '/p/chat-journal-v2' })
    layer.note('chat-1', { file: '/p/run-events/run-1.jsonl', owner: 'run-events', run: 'run-1' })
    layer.note('chat-1', { directory: '/p/run-artifacts/run-1', run: 'run-1' })
    layer.note('chat-1', {
      file: '/p/run-artifacts/run-2/tool-activity-details.jsonl',
      owner: 'detail',
      run: 'run-2'
    })

    layer.noteSave(previous, next, appended(previous, next), 'normal')
    await layer.tickets.awaitChat('chat-1')
    expect(port.paid).toEqual([
      'file:/p/chat-journal-v2/chat-1.mutations.jsonl',
      'directory:/p/chat-journal-v2'
    ])

    // A dispatch's barrier is the same: what the runs owe stays theirs.
    layer.note('chat-1', { file: '/p/chat-journal-v2/chat-1.mutations.jsonl', owner: 'journal' })
    await layer.awaitDurable('chat-1')
    expect(port.paid.slice(2)).toEqual(['file:/p/chat-journal-v2/chat-1.mutations.jsonl'])
    expect(layer.debt.snapshot().owed).toMatchObject({ files: 2, directories: 1 })
  })

  it('takes none, and raises no barrier, for a save with no moment', () => {
    const layer = createThreadBarrierDurability({ port: recordingPort() })
    const previous = thread()
    const next = { ...previous, persistenceRevision: 8, title: 'Renamed' }

    expect(layer.noteSave(previous, next, appended(previous, next), 'normal')).toEqual([])
    expect(layer.tickets.snapshot().moments.user_message.noted).toBe(0)
    expect(layer.debt.snapshot().barriers.raised).toBe(0)
  })

  it('takes none for a save that created the thread or whose append failed', () => {
    const layer = createThreadBarrierDurability({ port: recordingPort() })
    const created = thread({ persistenceRevision: 0 })

    expect(layer.noteSave(null, created, { derived: null }, 'terminal')).toEqual([])
    // Without the record before it there is nothing to read a batch against.
    expect(
      layer.noteSave(
        null,
        created,
        appended(thread({ messages: [], persistenceRevision: 6 }), thread()),
        'normal'
      )
    ).toEqual([])
    expect(layer.noteSave(thread(), thread({ persistenceRevision: 8 }), null, 'normal')).toEqual([])
    expect(layer.debt.snapshot().barriers.raised).toBe(0)
  })

  it('never fails a save it cannot read: pays it at once instead, and says so once', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const port = recordingPort()
    const layer = createThreadBarrierDurability({ port })
    const previous = thread()
    const next = { ...previous, persistenceRevision: 8, messages: [] }
    const unreadable = { ...previous, messages: undefined as never }
    layer.note('chat-1', { file: '/p/chat-journal-v2/chat-1.mutations.jsonl', owner: 'journal' })

    expect(layer.noteSave(unreadable, next, appended(previous, next), 'normal')).toEqual([])
    expect(layer.noteSave(unreadable, next, appended(previous, next), 'normal')).toEqual([])

    expect(error).toHaveBeenCalledTimes(1)
    expect(layer.tickets.snapshot().moments.destructive.noted).toBe(0)
    expect(layer.debt.snapshot().barriers.raised).toBe(2)
    await layer.debt.barrier('chat-1')
    expect(port.paid).toEqual(['file:/p/chat-journal-v2/chat-1.mutations.jsonl'])
  })
})

describe('the barriers for the moments of one save', () => {
  it("gives the user's moments one urgent barrier of the thread, and each run's end one of its run", () => {
    const raised: Array<[string, ThreadDurabilityBarrierOptions | undefined]> = []
    const debt = {
      barrier: (chatId: string, options?: ThreadDurabilityBarrierOptions) => {
        raised.push([chatId, options])
        return Promise.resolve()
      }
    }
    const barrierFor = barriersForSaveMoments(debt, 'chat-1')

    const urgent = barrierFor({ moment: 'user_message' })
    expect(barrierFor({ moment: 'decision' })).toBe(urgent)
    expect(barrierFor({ moment: 'destructive' })).toBe(urgent)
    const first = barrierFor({ moment: 'run_final', runId: 'run-1' })
    expect(first).not.toBe(urgent)
    expect(barrierFor({ moment: 'run_final', runId: 'run-1' })).toBe(first)
    expect(barrierFor({ moment: 'run_final', runId: 'run-2' })).not.toBe(first)
    expect(raised).toEqual([
      ['chat-1', { threadOnly: true, urgent: true }],
      ['chat-1', { run: 'run-1' }],
      ['chat-1', { run: 'run-2' }]
    ])
  })

  it("raises the user's barrier first, so the user never waits behind the ending run's files", async () => {
    const port = heldPort()
    const layer = createThreadBarrierDurability({ port })
    const previous = thread({
      messages: [
        { id: 'user-1', role: 'user', content: 'First question', timestamp: AT },
        { id: 'reply-1', role: 'assistant', content: 'An answer', timestamp: AT, runId: 'run-1' }
      ]
    })
    // The run ends in the same save that removes a row: classified run end first.
    const next = {
      ...previous,
      persistenceRevision: 8,
      messages: previous.messages.slice(0, 1),
      runs: [{ runId: 'run-1', startedAt: AT, status: 'completed' }]
    }
    layer.note('chat-1', { file: '/p/chat-journal-v2/chat-1.mutations.jsonl', owner: 'journal' })
    layer.note('chat-1', { file: '/p/run-events/run-1.jsonl', owner: 'run-events', run: 'run-1' })

    expect(layer.noteSave(previous, next, appended(previous, next), 'normal')).toEqual([
      { moment: 'run_final', runId: 'run-1' },
      { moment: 'destructive' }
    ])
    await Promise.resolve()

    // The user's barrier went first with the journal alone; the run's files follow it.
    expect(port.asked).toEqual(['/p/chat-journal-v2/chat-1.mutations.jsonl'])
    port.release()
    await layer.tickets.awaitChat('chat-1')
    expect(port.asked).toEqual([
      '/p/chat-journal-v2/chat-1.mutations.jsonl',
      '/p/run-events/run-1.jsonl'
    ])
  })

  it("pays a run's end with the thread's own debt and that run's, and leaves another run's owed", async () => {
    const port = recordingPort()
    const layer = createThreadBarrierDurability({ port })
    const running = { startedAt: AT, status: 'running' }
    const previous = thread({
      runs: [
        { runId: 'run-1', ...running },
        { runId: 'run-2', ...running }
      ]
    })
    const next = {
      ...previous,
      persistenceRevision: 8,
      runs: [{ runId: 'run-1', startedAt: AT, status: 'completed' }, previous.runs![1]]
    }
    layer.note('chat-1', { file: '/p/chat-journal-v2/chat-1.mutations.jsonl', owner: 'journal' })
    layer.note('chat-1', { file: '/p/run-events/run-1.jsonl', owner: 'run-events', run: 'run-1' })
    layer.note('chat-1', { file: '/p/run-events/run-2.jsonl', owner: 'run-events', run: 'run-2' })

    expect(layer.noteSave(previous, next, appended(previous, next), 'normal')).toEqual([
      { moment: 'run_final', runId: 'run-1' }
    ])
    await layer.tickets.awaitChat('chat-1')

    expect([...port.paid].sort()).toEqual([
      'file:/p/chat-journal-v2/chat-1.mutations.jsonl',
      'file:/p/run-events/run-1.jsonl'
    ])
    expect(layer.debt.snapshot().barriers).toMatchObject({ urgent: 0, scoped: 1 })
    expect(layer.debt.snapshot().owed.files).toBe(1)
    // Still owing, for its idle barrier to pay.
    expect(layer.snapshot().threads.owing).toBe(1)
  })
})

describe('what a dispatch waits for', () => {
  it("waits for an urgent barrier of the thread and the tickets of the user's moments", async () => {
    const port = heldPort()
    const layer = createThreadBarrierDurability({ port })
    const previous = thread()
    const next = {
      ...previous,
      persistenceRevision: 8,
      messages: [
        ...previous.messages,
        { id: 'user-2', role: 'user' as const, content: 'Go on', timestamp: AT }
      ]
    }
    layer.note('chat-1', { file: '/p/chat-journal-v2/chat-1.mutations.jsonl', owner: 'journal' })
    layer.noteSave(previous, next, appended(previous, next), 'normal')

    let settled = false
    const waiting = layer.awaitDurable('chat-1').then(() => (settled = true))
    await Promise.resolve()
    expect(layer.debt.snapshot().barriers).toMatchObject({ urgent: 2, threadOnly: 2, scoped: 0 })
    expect(settled).toBe(false)

    port.release()
    await waiting
    expect(layer.tickets.snapshot().moments.user_message.covered).toBe(1)
  })

  it("never waits for a run's final record, whose own barrier pays it", async () => {
    const layer = createThreadBarrierDurability({ port: recordingPort() })
    layer.tickets.note('chat-1', 9, 'run_final', new Promise<void>(() => {}))

    await expect(layer.awaitDurable('chat-1')).resolves.toBeUndefined()
    expect(layer.tickets.snapshot().moments.run_final).toMatchObject({ pending: 1, covered: 0 })
  })

  it('rejects when the disk refused a sync the dispatch depends on', async () => {
    const failure = new Error('EIO: the disk refused')
    const layer = createThreadBarrierDurability({
      port: {
        syncFile: () => Promise.reject(failure),
        syncDirectory: () => Promise.reject(failure)
      }
    })
    layer.note('chat-1', { file: '/p/chat-journal-v2/chat-1.mutations.jsonl', owner: 'journal' })

    await expect(layer.awaitDurable('chat-1')).rejects.toBe(failure)
  })
})

describe('what pays the debt no moment pays', () => {
  it("gives a thread the stores wrote for its idle barrier on one unref'd timer", async () => {
    const port = recordingPort()
    const timers: Array<{ callback: () => void; ms: number; unref: () => void }> = []
    const layer = createThreadBarrierDurability({
      port,
      now: () => 0,
      setTimer: (callback, ms) => {
        const timer = { callback, ms, unref: vi.fn() }
        timers.push(timer)
        return timer
      },
      clearTimer: () => {}
    })

    layer.journal.noteDurabilityDebt('chat-1', {
      file: '/p/chat-journal-v2/chat-1.mutations.jsonl',
      owner: 'journal'
    })
    layer
      .detail('chat-1')
      .note('chat-1', { file: '/p/run-artifacts/run-1/detail', owner: 'detail' })

    expect(timers).toHaveLength(1)
    expect(timers[0].ms).toBe(15_000)
    expect(timers[0].unref).toHaveBeenCalled()
    expect(layer.snapshot().threads.owing).toBe(1)
  })

  it("keeps a moment's thread owing after the user's barrier, and forgets it after one of the whole thread", async () => {
    const layer = createThreadBarrierDurability({ port: recordingPort() })
    const previous = thread()
    const next = {
      ...previous,
      persistenceRevision: 8,
      messages: [
        ...previous.messages,
        { id: 'user-2', role: 'user' as const, content: 'Next', timestamp: AT }
      ]
    }
    layer.note('chat-1', { file: '/p/chat-journal-v2/chat-1.mutations.jsonl', owner: 'journal' })

    layer.noteSave(previous, next, appended(previous, next), 'normal')
    await layer.tickets.awaitChat('chat-1')
    // It paid the thread's own debt alone: a run may still owe.
    expect(layer.snapshot().threads.owing).toBe(1)

    await layer.barrier('chat-1')
    expect(layer.snapshot().threads.owing).toBe(0)
  })

  it('drops an erased thread unpaid, and every thread at a global clear', () => {
    const layer = createThreadBarrierDurability({ port: recordingPort() })
    layer.note('chat-1', { file: '/p/a', owner: 'journal' })
    layer.note('chat-2', { file: '/p/b', owner: 'journal' })

    layer.forget('chat-1')
    expect(layer.debt.snapshot().owed.threads).toBe(1)
    layer.forgetAll()
    expect(layer.debt.snapshot().owed.threads).toBe(0)
    expect(layer.snapshot().threads.owing).toBe(0)
  })

  it("counts an erased thread's tickets as covered: the erasure reports it gone", async () => {
    const layer = createThreadBarrierDurability({ port: recordingPort() })
    const failure = new Error('EIO: the disk refused')
    layer.tickets.note('chat-1', 3, 'destructive', new Promise<void>(() => {}))
    layer.tickets.note('chat-1', 4, 'run_final', Promise.reject(failure))
    layer.tickets.note('chat-2', 5, 'user_message', Promise.resolve())
    layer.tickets.note('chat-3', 6, 'decision', Promise.resolve())
    await new Promise((resolve) => setImmediate(resolve))

    layer.forget('chat-1')
    let moments = layer.tickets.snapshot().moments
    expect([moments.destructive.covered, moments.run_final.covered]).toEqual([1, 1])
    expect([moments.user_message.covered, moments.decision.covered]).toEqual([0, 0])

    layer.forgetAll()
    moments = layer.tickets.snapshot().moments
    expect([moments.user_message.covered, moments.decision.covered]).toEqual([1, 1])
    // Only the erased thread's ticket still running is left, for its barrier to settle.
    expect(layer.tickets.chatIds()).toEqual(['chat-1'])
  })

  it('pays every thread at quit', async () => {
    const port = recordingPort()
    const layer = createThreadBarrierDurability({ port })
    layer.note('chat-1', { file: '/p/a', owner: 'journal' })
    layer.note('chat-2', { file: '/p/b', owner: 'run-events', run: 'run-1' })

    expect(await layer.payAll(1_000)).toEqual({ threads: 2, unpaid: 0 })
    expect([...port.paid].sort()).toEqual(['file:/p/a', 'file:/p/b'])
  })
})
