/**
 * Barriers for one run, and barriers the user is sitting in, driven through a
 * port whose syncs settle only when the test says so. Everything here is
 * counted in syncs asked for, never in time.
 */
import { beforeEach, describe, expect, it } from 'vitest'

import {
  createThreadDurabilityDebt,
  type ThreadDurabilityDebt,
  type ThreadDurabilityPort,
  type ThreadDurabilitySyncOptions,
  type ThreadDurabilitySyncOutcome,
  type ThreadDurabilityUrgency
} from './ThreadDurabilityDebt'

interface Asked {
  kind: 'file' | 'directory'
  path: string
  urgent: boolean
  /** When it was asked for, and when it was synced, on the test's own count. */
  askedAt: number
  doneAt: number | null
  resolve(outcome: ThreadDurabilitySyncOutcome): void
  reject(error: Error): void
}

/** Counts events, so that notes, syncs and barriers can be put in order. */
let clock = 0
const tick = (): number => (clock += 1)

class HeldPort implements ThreadDurabilityPort {
  asked: Asked[] = []
  /** What urgencies did, in order: `open`, `raise <paths>`, `end`. */
  urgencies: string[] = []

  private ask(
    kind: Asked['kind'],
    path: string,
    options?: ThreadDurabilitySyncOptions
  ): Promise<ThreadDurabilitySyncOutcome> {
    return new Promise((resolve, reject) => {
      this.asked.push({
        kind,
        path,
        urgent: options?.urgent === true,
        askedAt: tick(),
        doneAt: null,
        resolve,
        reject
      })
    })
  }

  syncFile(
    path: string,
    options?: ThreadDurabilitySyncOptions
  ): Promise<ThreadDurabilitySyncOutcome> {
    return this.ask('file', path, options)
  }

  syncDirectory(
    path: string,
    options?: ThreadDurabilitySyncOptions
  ): Promise<ThreadDurabilitySyncOutcome> {
    return this.ask('directory', path, options)
  }

  urgent(): ThreadDurabilityUrgency {
    this.urgencies.push('open')
    return {
      raise: (files, directories) => {
        this.urgencies.push(`raise ${[...files, ...directories].join(' ')}`.trimEnd())
      },
      end: () => {
        this.urgencies.push('end')
      }
    }
  }

  /** Paths asked for and not synced yet. */
  waiting(): string[] {
    return this.asked.filter((each) => each.doneAt === null).map((each) => each.path)
  }

  /** Sync everything asked for so far, then let every callback that is ready run. */
  async release(): Promise<void> {
    for (const each of this.asked) {
      if (each.doneAt !== null) continue
      each.doneAt = tick()
      each.resolve('synced')
    }
    await settle()
  }

  /** Fail the waiting sync of a path, as a sync that fails does. */
  async fail(path: string): Promise<void> {
    const asked = this.asked.find((each) => each.path === path && each.doneAt === null)!
    asked.doneAt = tick()
    asked.reject(Object.assign(new Error('EIO: injected'), { code: 'EIO' }))
    await settle()
  }

  /** Release until nothing more is asked for. */
  async drain(): Promise<void> {
    while (this.waiting().length > 0) await this.release()
  }
}

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

const CHAT = 'chat-1'
const journal = '/p/chat-journal-v2/chat-1.mutations.jsonl'
const journalDirectory = '/p/chat-journal-v2'
const events = (run: string): string => `/p/run-events/${run}.jsonl`
const detail = (run: string): string => `/p/run-artifacts/${run}/tool-activity-details.jsonl`
const runFolder = (run: string): string => `/p/run-artifacts/${run}`

describe('a barrier for one run', () => {
  let port: HeldPort
  let debt: ThreadDurabilityDebt

  beforeEach(() => {
    clock = 0
    port = new HeldPort()
    debt = createThreadDurabilityDebt({ port })
  })

  /** What thirty runs of one thread leave owing, beside the thread's journal. */
  const thirtyRuns = (): string[] => {
    const runs = Array.from({ length: 30 }, (_unused, index) => `run-${index + 1}`)
    debt.note(CHAT, { file: journal, owner: 'journal' })
    debt.note(CHAT, { directory: journalDirectory })
    for (const run of runs) {
      debt.note(CHAT, { file: events(run), owner: 'run-events', run })
      debt.note(CHAT, { file: detail(run), owner: 'detail', run })
      debt.note(CHAT, { directory: runFolder(run), run })
    }
    return runs
  }

  it('asks for that run’s paths and the thread’s own, and for no other run’s', async () => {
    thirtyRuns()

    const barrier = debt.barrier(CHAT, { run: 'run-7' })
    await settle()
    expect(port.waiting()).toEqual([journal, events('run-7'), detail('run-7')])
    await port.release()
    expect(port.waiting()).toEqual([journalDirectory, runFolder('run-7')])
    await port.release()
    await barrier

    expect(port.asked).toHaveLength(5)
    expect(debt.snapshot().owed).toEqual({ threads: 1, files: 58, directories: 29 })
    expect(debt.snapshot().owingRuns).toBe(29)
    expect(debt.snapshot().barriers).toMatchObject({ raised: 1, scoped: 1, rounds: 1 })
  })

  it('leaves the rest to a later barrier without a run, which pays all of it', async () => {
    const runs = thirtyRuns()
    const scoped = debt.barrier(CHAT, { run: 'run-7' })
    await port.drain()
    await scoped
    const before = port.asked.length

    const everything = debt.barrier(CHAT)
    await port.drain()
    await everything

    const paid = port.asked.slice(before).map((each) => each.path)
    const others = runs.filter((run) => run !== 'run-7')
    expect(paid.sort()).toEqual(
      others.flatMap((run) => [events(run), detail(run), runFolder(run)]).sort()
    )
    expect(debt.snapshot().owed).toEqual({ threads: 0, files: 0, directories: 0 })
    expect(debt.snapshot().owingRuns).toBe(0)
  })

  it('resolves at once, without the port, when neither its run nor the thread owes anything', async () => {
    debt.note(CHAT, { file: events('run-2'), owner: 'run-events', run: 'run-2' })

    await expect(debt.barrier(CHAT, { run: 'run-1' })).resolves.toBeUndefined()

    expect(port.asked).toEqual([])
    expect(debt.snapshot().barriers).toMatchObject({ raised: 1, idle: 1, rounds: 0 })
    expect(debt.snapshot().owed).toEqual({ threads: 1, files: 1, directories: 0 })
  })

  it('syncs a path two runs noted once, for both, and the second run’s barrier does not ask for it again', async () => {
    const shared = '/p/run-events'
    debt.note(CHAT, { directory: shared, run: 'run-1' })
    debt.note(CHAT, { directory: shared, run: 'run-2' })
    debt.note(CHAT, { file: events('run-2'), owner: 'run-events', run: 'run-2' })

    const first = debt.barrier(CHAT, { run: 'run-1' })
    await port.drain()
    await first
    expect(port.asked.map((each) => each.path)).toEqual([shared])

    const second = debt.barrier(CHAT, { run: 'run-2' })
    await port.drain()
    await second
    expect(port.asked.map((each) => each.path)).toEqual([shared, events('run-2')])
  })

  it('owes a run’s file again to that run when its sync fails', async () => {
    debt.note(CHAT, { file: events('run-1'), owner: 'run-events', run: 'run-1' })
    const failing = debt.barrier(CHAT, { run: 'run-1' })
    const failed = expect(failing).rejects.toThrow('EIO')
    await settle()
    await port.fail(events('run-1'))
    await failed

    expect(debt.snapshot().owingRuns).toBe(1)
    // Another run's barrier does not take it; that run's next one does.
    await expect(debt.barrier(CHAT, { run: 'run-2' })).resolves.toBeUndefined()
    const again = debt.barrier(CHAT, { run: 'run-1' })
    await port.drain()
    await again
    expect(port.asked.map((each) => each.path)).toEqual([events('run-1'), events('run-1')])
  })
})

describe('a barrier for the thread’s own debt only', () => {
  let port: HeldPort
  let debt: ThreadDurabilityDebt

  beforeEach(() => {
    clock = 0
    port = new HeldPort()
    debt = createThreadDurabilityDebt({ port })
  })

  /** What thirty runs of one thread leave owing, beside the thread's journal. */
  const thirtyRuns = (): string[] => {
    const runs = Array.from({ length: 30 }, (_unused, index) => `run-${index + 1}`)
    debt.note(CHAT, { file: journal, owner: 'journal' })
    debt.note(CHAT, { directory: journalDirectory })
    for (const run of runs) {
      debt.note(CHAT, { file: events(run), owner: 'run-events', run })
      debt.note(CHAT, { file: detail(run), owner: 'detail', run })
      debt.note(CHAT, { directory: runFolder(run), run })
    }
    return runs
  }

  it('asks the port for the journal’s paths only, urgently, on a thread where thirty runs owe files', async () => {
    thirtyRuns()

    const barrier = debt.barrier(CHAT, { threadOnly: true, urgent: true })
    await settle()
    expect(port.waiting()).toEqual([journal])
    await port.release()
    expect(port.waiting()).toEqual([journalDirectory])
    await port.release()
    await barrier

    expect(port.asked.map((each) => [each.path, each.urgent])).toEqual([
      [journal, true],
      [journalDirectory, true]
    ])
    expect(debt.snapshot().owed).toEqual({ threads: 1, files: 60, directories: 30 })
    expect(debt.snapshot().owingRuns).toBe(30)
    expect(debt.snapshot().barriers).toMatchObject({
      raised: 1,
      threadOnly: 1,
      urgent: 1,
      scoped: 0,
      rounds: 1
    })
  })

  it('leaves every run’s debt to a later barrier without a run, which pays all of it', async () => {
    const runs = thirtyRuns()
    const own = debt.barrier(CHAT, { threadOnly: true, urgent: true })
    await port.drain()
    await own
    const before = port.asked.length

    const everything = debt.barrier(CHAT)
    await port.drain()
    await everything

    const paid = port.asked.slice(before).map((each) => each.path)
    expect(paid.sort()).toEqual(
      runs.flatMap((run) => [events(run), detail(run), runFolder(run)]).sort()
    )
    expect(port.asked.slice(before).every((each) => !each.urgent)).toBe(true)
    expect(debt.snapshot().owed).toEqual({ threads: 0, files: 0, directories: 0 })
    expect(debt.snapshot().owingRuns).toBe(0)
  })

  it('resolves at once, without the port, when the thread owes nothing of its own, whatever its runs owe', async () => {
    debt.note(CHAT, { file: events('run-1'), owner: 'run-events', run: 'run-1' })
    debt.note(CHAT, { directory: runFolder('run-1'), run: 'run-1' })

    await expect(debt.barrier(CHAT, { threadOnly: true, urgent: true })).resolves.toBeUndefined()

    expect(port.asked).toEqual([])
    expect(debt.snapshot().barriers).toMatchObject({ raised: 1, idle: 1, rounds: 0 })
    expect(debt.snapshot().owed).toEqual({ threads: 1, files: 1, directories: 1 })
  })

  it('cannot name a run as well', async () => {
    debt.note(CHAT, { file: journal, owner: 'journal' })
    debt.note(CHAT, { file: events('run-1'), owner: 'run-events', run: 'run-1' })

    await expect(debt.barrier(CHAT, { threadOnly: true, run: 'run-1' } as never)).rejects.toThrow(
      TypeError
    )

    await settle()
    expect(port.asked).toEqual([])
    expect(debt.snapshot().owed).toEqual({ threads: 1, files: 2, directories: 0 })
    expect(debt.snapshot().barriers).toMatchObject({ raised: 0, threadOnly: 0 })
  })

  it('joins a running barrier that took everything the thread owed of its own, and asks for nothing more', async () => {
    debt.note(CHAT, { file: journal, owner: 'journal' })
    debt.note(CHAT, { file: events('run-1'), owner: 'run-events', run: 'run-1' })
    debt.note(CHAT, { file: events('run-2'), owner: 'run-events', run: 'run-2' })
    const running = debt.barrier(CHAT, { run: 'run-1' })
    await settle()

    const own = debt.barrier(CHAT, { threadOnly: true, urgent: true })
    await port.drain()
    await Promise.all([running, own])

    expect(port.asked.map((each) => each.path)).toEqual([journal, events('run-1')])
    expect(debt.snapshot().barriers).toMatchObject({ shared: 1, rounds: 1 })
    expect(debt.snapshot().owed).toEqual({ threads: 1, files: 1, directories: 0 })
  })

  it('waits behind a running barrier for one of its own when the thread wrote since, and that one takes no run’s debt', async () => {
    debt.note(CHAT, { file: journal, owner: 'journal' })
    debt.note(CHAT, { file: events('run-1'), owner: 'run-events', run: 'run-1' })
    const running = debt.barrier(CHAT, { run: 'run-1' })
    await settle()
    // The user's message: a journal line, written while the run's barrier syncs.
    debt.note(CHAT, { file: journal, owner: 'journal' })
    debt.note(CHAT, { file: events('run-2'), owner: 'run-events', run: 'run-2' })

    const own = debt.barrier(CHAT, { threadOnly: true, urgent: true })
    await port.drain()
    await Promise.all([running, own])

    expect(port.asked.map((each) => [each.path, each.urgent])).toEqual([
      [journal, false],
      [events('run-1'), false],
      [journal, true]
    ])
    expect(debt.snapshot().owed).toEqual({ threads: 1, files: 1, directories: 0 })
    expect(debt.snapshot().owingRuns).toBe(1)
  })
})

describe('barriers for runs, a barrier for the thread and a note, in every order', () => {
  type Step = 'barrier A' | 'barrier B' | 'barrier' | 'barrier own' | 'note'
  const STEPS: Step[] = ['barrier A', 'barrier B', 'barrier', 'barrier own', 'note']

  const orders = (items: Step[]): Step[][] =>
    items.length === 0
      ? [[]]
      : items.flatMap((item, index) =>
          orders([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [
            item,
            ...rest
          ])
        )

  const own = [journal, journalDirectory]
  const shared = '/p/run-events'
  const ofRun = (run: 'A' | 'B'): string[] => [events(run), runFolder(run), shared]
  /** The note between the barriers writes the journal again and a new file of run A. */
  const later = detail('A')

  it.each([false, true])(
    'covers, for each barrier, everything it needed that was noted before it, the urgent one of the thread’s own debt alone included (run A urgent: %s)',
    async (urgentA) => {
      let cases = 0
      for (const order of orders(STEPS)) {
        // After each step but the last, the port syncs what it was asked, or does not.
        for (let releases = 0; releases < 2 ** (STEPS.length - 1); releases += 1) {
          cases += 1
          clock = 0
          const port = new HeldPort()
          const debt = createThreadDurabilityDebt({ port })
          /** For each path, when each note of it was made. */
          const noted = new Map<string, number[]>()
          const write = (path: string, run?: 'A' | 'B'): void => {
            noted.set(path, [...(noted.get(path) ?? []), tick()])
            if (path.endsWith('.jsonl'))
              debt.note(CHAT, { file: path, owner: 'run-events', ...(run ? { run } : {}) })
            else debt.note(CHAT, { directory: path, ...(run ? { run } : {}) })
          }
          for (const path of own) write(path)
          for (const run of ['A', 'B'] as const) for (const path of ofRun(run)) write(path, run)

          const raised: Array<{
            step: Step
            at: number
            needs: string[]
            settledAt: number | null
          }> = []
          for (const [index, step] of order.entries()) {
            if (step === 'note') {
              write(journal)
              write(later, 'A')
            } else {
              const needs =
                step === 'barrier'
                  ? [...noted.keys()]
                  : step === 'barrier own'
                    ? [...own]
                    : [
                        ...own,
                        ...ofRun(step === 'barrier A' ? 'A' : 'B'),
                        ...(step === 'barrier A' && noted.has(later) ? [later] : [])
                      ]
              const entry = { step, at: tick(), needs, settledAt: null as number | null }
              raised.push(entry)
              const options =
                step === 'barrier'
                  ? undefined
                  : step === 'barrier own'
                    ? ({ threadOnly: true, urgent: true } as const)
                    : {
                        run: step === 'barrier A' ? 'A' : 'B',
                        urgent: step === 'barrier A' && urgentA
                      }
              debt.barrier(CHAT, options).then(() => {
                entry.settledAt = tick()
              })
            }
            if (index < order.length - 1 && releases & (1 << index)) await port.release()
            else await settle()
          }
          await port.drain()

          const label = `${order.join(', ')} / releases ${releases.toString(2)}`
          for (const barrier of raised) {
            expect(barrier.settledAt, `${label}: ${barrier.step} settled`).not.toBeNull()
            for (const path of barrier.needs) {
              const last = Math.max(...noted.get(path)!.filter((at) => at < barrier.at))
              const covered = port.asked.some(
                (each) =>
                  each.path === path &&
                  each.askedAt > last &&
                  each.doneAt !== null &&
                  each.doneAt < barrier.settledAt!
              )
              expect(covered, `${label}: ${barrier.step} needs ${path}`).toBe(true)
            }
          }
          // An urgent barrier never depends only on a sync asked for at the
          // ordinary priority after it was raised: what it waits for was
          // either asked before (the port moves it ahead) or asked as urgent.
          const urgentSteps: Step[] = urgentA ? ['barrier own', 'barrier A'] : ['barrier own']
          for (const urgent of raised.filter((each) => urgentSteps.includes(each.step))) {
            for (const path of urgent.needs) {
              const last = Math.max(...noted.get(path)!.filter((at) => at < urgent.at))
              const covering = port.asked.filter(
                (each) =>
                  each.path === path &&
                  each.askedAt > last &&
                  each.doneAt !== null &&
                  each.doneAt < urgent.settledAt!
              )
              expect(
                covering.some((each) => each.askedAt < urgent.at || each.urgent),
                `${label}: ${urgent.step} waits for ${path} at the ordinary priority`
              ).toBe(true)
            }
          }
        }
      }
      expect(cases).toBe(120 * 16)
    }
  )
})

describe('an urgent barrier', () => {
  let port: HeldPort
  let debt: ThreadDurabilityDebt

  beforeEach(() => {
    clock = 0
    port = new HeldPort()
    debt = createThreadDurabilityDebt({ port })
  })

  it('asks for its syncs as urgent, and keeps an urgency open until it settles', async () => {
    debt.note(CHAT, { file: journal, owner: 'journal' })
    debt.note(CHAT, { directory: journalDirectory })

    const barrier = debt.barrier(CHAT, { urgent: true })
    await port.drain()
    await barrier
    await settle()

    expect(port.asked.map((each) => [each.path, each.urgent])).toEqual([
      [journal, true],
      [journalDirectory, true]
    ])
    expect(port.urgencies).toEqual(['open', 'end'])
    expect(debt.snapshot().barriers).toMatchObject({ raised: 1, urgent: 1, hastened: 0 })
    expect(debt.snapshot().waits.urgent).toMatchObject({ count: 1 })
    expect(debt.snapshot().waits.normal).toMatchObject({ count: 0 })
  })

  it('raises a running barrier it has to wait for: the waiting syncs move ahead, and the rest are asked as urgent', async () => {
    debt.note(CHAT, { file: journal, owner: 'journal' })
    debt.note(CHAT, { directory: journalDirectory })
    const ordinary = debt.barrier(CHAT)
    await settle()
    expect(port.asked.map((each) => each.urgent)).toEqual([false])

    // Nothing new is owed, so it joins the running barrier, and raises it.
    const urgent = debt.barrier(CHAT, { urgent: true })
    await settle()
    expect(port.urgencies).toEqual(['open', `raise ${journal}`])
    await port.release()

    expect(port.asked.map((each) => [each.path, each.urgent])).toEqual([
      [journal, false],
      [journalDirectory, true]
    ])
    await port.drain()
    await Promise.all([ordinary, urgent])
    expect(debt.snapshot().barriers).toMatchObject({ shared: 1, hastened: 1 })
  })

  it('raises the barrier queued behind a running one, which asks for its syncs as urgent when it starts', async () => {
    debt.note(CHAT, { file: journal, owner: 'journal' })
    const ordinary = debt.barrier(CHAT)
    await settle()
    debt.note(CHAT, { file: events('run-1'), owner: 'run-events', run: 'run-1' })
    const queued = debt.barrier(CHAT)
    const urgent = debt.barrier(CHAT, { run: 'run-1', urgent: true })
    await settle()

    await port.release()
    expect(port.asked.map((each) => [each.path, each.urgent])).toEqual([
      [journal, false],
      [events('run-1'), true]
    ])
    await port.drain()
    await Promise.all([ordinary, queued, urgent])
    // The running one was raised as well, since the queued one starts only after it.
    expect(debt.snapshot().barriers).toMatchObject({ shared: 1, hastened: 2 })
  })

  it('keeps a queued urgent barrier urgent when a caller arrives just as the running one ends', async () => {
    debt.note(CHAT, { file: journal, owner: 'journal' })
    const first = debt.barrier(CHAT)
    // This runs as soon as the running barrier ends, before the one queued
    // behind it starts.
    let late: Promise<void> | null = null
    first.then(() => {
      late = debt.barrier(CHAT)
    })
    await settle()
    debt.note(CHAT, { file: events('run-1'), owner: 'run-events', run: 'run-1' })
    const urgent = debt.barrier(CHAT, { run: 'run-1', urgent: true })

    await port.release()
    expect(late).not.toBeNull()
    expect(port.asked.map((each) => [each.path, each.urgent])).toEqual([
      [journal, false],
      [events('run-1'), true]
    ])
    await port.drain()
    await Promise.all([first, urgent, late])
  })

  it('counts how many syncs were ahead when it was raised, from a port that says', async () => {
    const counted: ThreadDurabilityPort = {
      syncFile: (path, options) => port.syncFile(path, options),
      syncDirectory: (path, options) => port.syncDirectory(path, options),
      ahead: (urgent) => (urgent ? 2 : 9)
    }
    const ledger = createThreadDurabilityDebt({ port: counted })
    ledger.note(CHAT, { file: journal, owner: 'journal' })
    const first = ledger.barrier(CHAT, { urgent: true })
    const second = ledger.barrier(CHAT)
    const third = ledger.barrier('chat-2')
    await port.drain()
    await Promise.all([first, second, third])

    expect(ledger.snapshot().waits).toMatchObject({
      urgent: { count: 1, aheadTotal: 2, aheadMost: 2 },
      normal: { count: 2, aheadTotal: 18, aheadMost: 9 }
    })
  })
})
