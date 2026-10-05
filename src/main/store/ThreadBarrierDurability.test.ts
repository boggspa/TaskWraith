import { describe, expect, it } from 'vitest'

import { ChatDurabilityTickets } from './ChatDurabilityTickets'
import { createThreadBarrierDurability } from './ThreadBarrierDurability'
import type { ThreadDurabilityPort, ThreadDurabilitySyncOutcome } from './ThreadDurabilityDebt'

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
