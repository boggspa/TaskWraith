import { describe, expect, it } from 'vitest'
import type {
  ThreadDurabilityPort,
  ThreadDurabilitySyncOptions,
  ThreadDurabilitySyncOutcome
} from './ThreadDurabilityDebt'
import { UsageJournalBackgroundSync } from './UsageJournalBackgroundSync'

interface Call {
  name: string
  options: ThreadDurabilitySyncOptions | undefined
  settle(): void
  fail(): void
}

function heldPort(): Pick<ThreadDurabilityPort, 'syncFile' | 'syncDirectory'> & { calls: Call[] } {
  const calls: Call[] = []
  const ask = (name: string, options?: ThreadDurabilitySyncOptions) =>
    new Promise<ThreadDurabilitySyncOutcome>((resolve, reject) => {
      calls.push({
        name,
        options,
        settle: () => resolve('synced'),
        fail: () => reject(Object.assign(new Error('EIO'), { code: 'EIO' }))
      })
    })
  return {
    calls,
    syncFile: (target, options) => ask(`file:${target}`, options),
    syncDirectory: (target, options) => ask(`directory:${target}`, options)
  }
}

function manualTime() {
  let now = 0
  const timers = new Map<number, { at: number; callback: () => void }>()
  let next = 1
  return {
    now: () => now,
    setTimer: (callback: () => void, ms: number) => {
      const id = next++
      timers.set(id, { at: now + ms, callback })
      return id
    },
    clearTimer: (handle: unknown) => {
      timers.delete(handle as number)
    },
    advance(ms: number) {
      now += ms
      for (const [id, timer] of [...timers]) {
        if (timer.at > now) continue
        timers.delete(id)
        timer.callback()
      }
    }
  }
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setImmediate(resolve))
}

describe('the usage log background sync', () => {
  it('never syncs a folder in a round whose file sync failed, and owes both again for the next round', async () => {
    const port = heldPort()
    const time = manualTime()
    const warnings: string[] = []
    const sync = new UsageJournalBackgroundSync({
      port,
      ...time,
      warn: (message) => warnings.push(message)
    })

    sync.owe({ files: ['journal'], directories: ['folder'] })
    await settle()
    expect(port.calls.map((call) => call.name)).toEqual(['file:journal'])
    port.calls[0].fail()
    await settle()
    expect(port.calls).toHaveLength(1)
    expect(sync.snapshot()).toMatchObject({
      owed: { files: 1, directories: 1 },
      rounds: 1,
      failedRounds: 1
    })
    expect(warnings).toHaveLength(1)

    time.advance(1_000)
    await settle()
    port.calls[1].settle()
    await settle()
    expect(port.calls.map((call) => call.name)).toEqual([
      'file:journal',
      'file:journal',
      'directory:folder'
    ])
    port.calls[2].settle()
    await settle()
    expect(sync.snapshot()).toMatchObject({ owed: { files: 0, directories: 0 }, rounds: 2 })
  })

  it('owes a folder again when its sync fails', async () => {
    const port = heldPort()
    const time = manualTime()
    const sync = new UsageJournalBackgroundSync({ port, ...time, warn: () => {} })

    sync.owe({ directories: ['folder'] })
    await settle()
    port.calls[0].fail()
    await settle()
    expect(sync.snapshot()).toMatchObject({ owed: { directories: 1 }, failedRounds: 1 })
    time.advance(1_000)
    await settle()
    expect(port.calls.map((call) => call.name)).toEqual(['directory:folder', 'directory:folder'])
  })

  it('at quit with nothing owed, raises no round', async () => {
    const port = heldPort()
    const sync = new UsageJournalBackgroundSync({ port, ...manualTime() })

    await expect(sync.settle(100)).resolves.toEqual({ unpaid: false })

    expect(port.calls).toHaveLength(0)
    expect(sync.snapshot()).toMatchObject({ quitRounds: 0, quitUnpaid: 0 })
  })

  it('starts no round once disposed, and keeps what is owed', async () => {
    const port = heldPort()
    const sync = new UsageJournalBackgroundSync({ port, ...manualTime() })

    sync.dispose()
    sync.owe({ files: ['journal'] })
    await settle()

    expect(port.calls).toHaveLength(0)
    expect(sync.snapshot().owed).toEqual({ files: 1, directories: 0 })
  })
})
