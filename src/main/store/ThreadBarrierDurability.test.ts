import { afterEach, describe, expect, it, vi } from 'vitest'

import { ChatDurabilityTickets } from './ChatDurabilityTickets'
import { deriveChatRecordMutationWithProjection } from './ChatRecordMutation'
import { barrierForSaveMoments, createThreadBarrierDurability } from './ThreadBarrierDurability'
import type { ThreadDurabilityPort, ThreadDurabilitySyncOutcome } from './ThreadDurabilityDebt'
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

  it('keeps one set of tickets, timed by its clock', () => {
    let now = 1_000
    const layer = createThreadBarrierDurability({ port: recordingPort(), now: () => now })

    expect(layer.tickets).toBeInstanceOf(ChatDurabilityTickets)
    layer.tickets.note('chat-1', 3, 'user_message', Promise.resolve())
    now += 5
    expect(layer.tickets.snapshot().moments.user_message.noted).toBe(1)
  })

  it('reports the debt, the tickets and, for the port it built, the port', () => {
    const built = createThreadBarrierDurability()
    expect(built.snapshot()).toEqual({
      debt: built.debt.snapshot(),
      port: { started: 0, inFlight: 0, queued: 0, joined: 0, peakInFlight: 0 },
      tickets: built.tickets.snapshot()
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
  it('takes one for each moment, at the revision its batch wrote, all waiting for one barrier', async () => {
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

    expect(layer.noteSave(previous, next, appended(previous, next), 'normal')).toEqual([
      { moment: 'user_message' },
      { moment: 'run_final', runId: 'run-1' }
    ])

    const tickets = layer.tickets.snapshot().moments
    expect([tickets.user_message.pending, tickets.run_final.pending]).toEqual([1, 1])
    expect(layer.debt.snapshot().barriers.raised).toBe(1)
    let settled = false
    const waited = layer.tickets.awaitChat('chat-1').then(() => (settled = true))
    await Promise.resolve()
    expect(port.asked).toEqual(['/p/chat-journal-v2/chat-1.mutations.jsonl'])
    expect(settled).toBe(false)
    port.release()
    await waited
    expect(layer.tickets.snapshot().moments.user_message.covered).toBe(1)
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

describe('the barrier for the moments of one save', () => {
  it('until scoped and urgent barriers land, is one barrier of the whole thread', () => {
    const raised: string[] = []
    const debt = {
      barrier: (chatId: string) => {
        raised.push(chatId)
        return Promise.resolve()
      }
    }
    const barrierFor = barrierForSaveMoments(debt, 'chat-1')

    const first = barrierFor({ moment: 'user_message' })
    expect(barrierFor({ moment: 'run_final', runId: 'run-1' })).toBe(first)
    expect(barrierFor({ moment: 'destructive' })).toBe(first)
    expect(raised).toEqual(['chat-1'])
  })
})
