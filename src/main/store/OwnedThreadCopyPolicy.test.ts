import { describe, expect, it } from 'vitest'
import {
  OWNED_THREAD_COMPACT_BYTES,
  OWNED_THREAD_IDLE_PUBLISH_MS,
  OWNED_THREAD_PUBLISH_RETRY_MS,
  OWNED_THREAD_STREAM_CAP_MS,
  OwnedThreadCopyPolicy,
  type OwnedThreadCopyDecision,
  type OwnedThreadCopyStep
} from './OwnedThreadCopyPolicy'

const THREAD = 'thread-1'
const MIB = 1024 * 1024

/** An owned thread whose last full copy is at `revision`, with nothing unpublished. */
function ownedAt(revision: number, now = 0): OwnedThreadCopyPolicy {
  const policy = new OwnedThreadCopyPolicy()
  policy.adopted(THREAD, { publishedRevision: revision, headRevision: revision, logBytes: 0 }, now)
  return policy
}

function publish(reason: string, revision: number, threadId = THREAD): OwnedThreadCopyDecision {
  return { kind: 'publish', threadId, reason, revision } as OwnedThreadCopyDecision
}

/**
 * Plays the caller: one timer at most, armed for whatever the policy last said,
 * every decision handed to `carryOut`, and work that reports back later.
 */
class Caller {
  readonly decisions: { at: number; decision: OwnedThreadCopyDecision }[] = []
  timerAt: number | null = null
  wakes = 0
  now = 0
  private readonly work: { at: number; report: () => OwnedThreadCopyStep }[] = []

  constructor(
    readonly policy: OwnedThreadCopyPolicy,
    private readonly carryOut: (
      decision: OwnedThreadCopyDecision,
      caller: Caller
    ) => void = () => {}
  ) {}

  take(step: OwnedThreadCopyStep): void {
    this.timerAt = step.nextAt
    for (const decision of step.decisions) {
      this.decisions.push({ at: this.now, decision })
      this.carryOut(decision, this)
    }
  }

  /** Work off the main thread that tells the policy how it went at `at`. */
  finishAt(at: number, report: () => OwnedThreadCopyStep): void {
    this.work.push({ at, report })
    this.work.sort((a, b) => a.at - b.at)
  }

  /** Moves the clock to `time`, finishing work and firing the timer as they come due on the way. */
  advanceTo(time: number): void {
    for (;;) {
      const workAt = this.work.length > 0 ? this.work[0].at : null
      const first =
        workAt !== null && (this.timerAt === null || workAt <= this.timerAt) ? workAt : this.timerAt
      if (first === null || first > time) break
      this.now = Math.max(this.now, first)
      if (first === workAt) {
        this.take(this.work.shift()!.report())
      } else {
        this.wakes++
        this.take(this.policy.poll(this.now))
        // A poll settles everything due at its time, or one timer would spin.
        if (this.timerAt !== null && this.timerAt <= this.now) {
          throw new Error(`poll at ${this.now} left something due at ${this.timerAt}`)
        }
      }
    }
    this.now = time
  }
}

describe('owned thread copy policy', () => {
  it('keeps every threshold in one place', () => {
    expect(OWNED_THREAD_IDLE_PUBLISH_MS).toBe(15_000)
    expect(OWNED_THREAD_STREAM_CAP_MS).toBe(30 * 60_000)
    expect(OWNED_THREAD_COMPACT_BYTES).toBe(16 * MIB)
    expect(OWNED_THREAD_PUBLISH_RETRY_MS).toBe(15_000)
  })

  it('publishes a full copy when a thread is created', () => {
    const policy = new OwnedThreadCopyPolicy()
    expect(policy.created(THREAD, 0, 100)).toEqual({
      decisions: [publish('creation', 0)],
      nextAt: null
    })
    expect(policy.isAhead(THREAD)).toBe(true)
    expect(policy.published(THREAD, 0, 120)).toEqual({ decisions: [], nextAt: null })
    expect(policy.isAhead(THREAD)).toBe(false)
    expect(policy.snapshot().decided.creation).toBe(1)
  })

  it('never publishes because a save happened', () => {
    const policy = ownedAt(4)
    for (let revision = 5; revision < 200; revision++) {
      const step = policy.saved(THREAD, { revision, appendedBytes: 2_000 }, revision * 200)
      expect(step.decisions).toEqual([])
    }
    expect(policy.isAhead(THREAD)).toBe(true)
  })

  it('streams for eleven minutes at three to six saves a second with no copy, then publishes once at idle', () => {
    const policy = ownedAt(4)
    const caller = new Caller(policy, (decision, self) => {
      // The caller publishes off the main thread; here every copy takes two seconds.
      if (decision.kind === 'publish') {
        self.finishAt(self.now + 2_000, () =>
          policy.published(decision.threadId, decision.revision, self.now)
        )
      }
    })
    caller.take(policy.runStarted(THREAD, 'run-1'))
    const streamedUntil = 11 * 60_000
    let revision = 4
    let appended = 0
    let saves = 0
    for (let now = 0; now < streamedUntil; ) {
      // The rate drifts between three and six saves a second, second by second.
      const rate = 3 + (Math.floor(now / 1_000) % 4)
      now += Math.round(1_000 / rate)
      caller.advanceTo(now)
      const bytes = 600 + ((saves * 37) % 1_900)
      appended += bytes
      saves++
      caller.take(policy.saved(THREAD, { revision: ++revision, appendedBytes: bytes }, now))
    }
    expect(saves).toBeGreaterThan(3 * 11 * 60)
    expect(saves).toBeLessThan(6 * 11 * 60)
    expect(appended).toBeLessThan(OWNED_THREAD_COMPACT_BYTES)
    // While it streamed: no copy, no compaction, and the one timer never fired.
    expect(caller.decisions).toEqual([])
    expect(caller.wakes).toBe(0)

    caller.take(policy.runEnded(THREAD, 'run-1', caller.now))
    const endedAt = caller.now
    caller.advanceTo(endedAt + 60 * 60_000)
    expect(caller.decisions).toEqual([
      { at: endedAt + OWNED_THREAD_IDLE_PUBLISH_MS, decision: publish('idle', revision) }
    ])
    expect(policy.isAhead(THREAD)).toBe(false)
    expect(caller.timerAt).toBeNull()
    expect(policy.snapshot()).toMatchObject({
      decided: {
        creation: 0,
        idle: 1,
        stream_cap: 0,
        quit: 0,
        handoff: 0,
        journal_failure: 0,
        log_bytes: 0
      },
      published: 1
    })
    // One timer, and it fired once: nothing was due while the run was live.
    expect(caller.wakes).toBe(1)
  })

  it('waits for the run to end, however long the thread has been quiet', () => {
    const policy = ownedAt(4)
    const caller = new Caller(policy)
    caller.take(policy.runStarted(THREAD, 'run-1'))
    caller.take(policy.saved(THREAD, { revision: 5, appendedBytes: 100 }, 1_000))
    caller.advanceTo(10 * 60_000)
    expect(caller.decisions).toEqual([])
    // The run ends long after the last append: the copy is due at once.
    expect(policy.runEnded(THREAD, 'run-1', 10 * 60_000).decisions).toEqual([publish('idle', 5)])
  })

  it('counts runs by id, so a repeated start or end changes nothing', () => {
    const policy = ownedAt(4)
    policy.saved(THREAD, { revision: 5, appendedBytes: 100 }, 0)
    policy.runStarted(THREAD, 'run-1')
    policy.runStarted(THREAD, 'run-1')
    policy.runStarted(THREAD, 'run-2')
    policy.runEnded(THREAD, 'run-1', 0)
    // run-2 is still live, so the quiet thread is not idle.
    expect(policy.poll(OWNED_THREAD_IDLE_PUBLISH_MS).decisions).toEqual([])
    expect(policy.runEnded(THREAD, 'run-2', 20_000).decisions).toEqual([publish('idle', 5)])
    expect(policy.runEnded(THREAD, 'run-2', 20_000).decisions).toEqual([])
  })

  it('remembers a live run when the thread changes hands and comes back', () => {
    const policy = new OwnedThreadCopyPolicy()
    // The run starts before this app is the thread's writer: nothing is followed yet.
    expect(policy.runStarted(THREAD, 'run-1')).toEqual({ decisions: [], nextAt: null })
    expect(policy.snapshot()).toMatchObject({ threads: 0, runningThreads: 1 })
    const log = { publishedRevision: 4, headRevision: 6, logBytes: 0 }
    expect(policy.adopted(THREAD, log, 0).nextAt).toBe(OWNED_THREAD_STREAM_CAP_MS)
    expect(policy.poll(OWNED_THREAD_IDLE_PUBLISH_MS).decisions).toEqual([])
    policy.released(THREAD)
    policy.adopted(THREAD, log, 20_000)
    expect(policy.poll(60_000).decisions).toEqual([])
    expect(policy.runEnded(THREAD, 'run-1', 61_000).decisions).toEqual([publish('idle', 6)])
    expect(policy.snapshot().runningThreads).toBe(0)
  })

  it('does not publish when a thread goes idle and resumes inside the fifteen seconds', () => {
    const policy = ownedAt(4)
    const caller = new Caller(policy)
    caller.take(policy.saved(THREAD, { revision: 5, appendedBytes: 100 }, 0))
    expect(caller.timerAt).toBe(OWNED_THREAD_IDLE_PUBLISH_MS)
    caller.advanceTo(OWNED_THREAD_IDLE_PUBLISH_MS - 1)
    // It resumes one millisecond before the copy would have been due.
    caller.take(policy.saved(THREAD, { revision: 6, appendedBytes: 100 }, caller.now))
    caller.advanceTo(2 * OWNED_THREAD_IDLE_PUBLISH_MS - 2)
    expect(caller.decisions).toEqual([])
    caller.advanceTo(2 * OWNED_THREAD_IDLE_PUBLISH_MS - 1)
    expect(caller.decisions).toEqual([
      { at: 2 * OWNED_THREAD_IDLE_PUBLISH_MS - 1, decision: publish('idle', 6) }
    ])
  })

  it('does not publish a quiet thread whose last copy is already current', () => {
    const policy = ownedAt(4)
    expect(policy.poll(60 * 60_000)).toEqual({ decisions: [], nextAt: null })
    expect(policy.isAhead(THREAD)).toBe(false)
  })

  it('asks once and waits for the answer, then follows new saves again', () => {
    const policy = ownedAt(4)
    policy.saved(THREAD, { revision: 5, appendedBytes: 100 }, 0)
    expect(policy.poll(15_000).decisions).toEqual([publish('idle', 5)])
    // Nothing more is asked while that copy is being written.
    expect(policy.poll(16_000)).toEqual({ decisions: [], nextAt: null })
    expect(policy.poll(10 * 60_000).decisions).toEqual([])
    // A save lands while it is: the copy at 5 will not cover it.
    policy.saved(THREAD, { revision: 6, appendedBytes: 100 }, 20_000)
    expect(policy.published(THREAD, 5, 21_000)).toEqual({
      decisions: [],
      nextAt: 20_000 + OWNED_THREAD_IDLE_PUBLISH_MS
    })
    expect(policy.isAhead(THREAD)).toBe(true)
    expect(policy.poll(35_000).decisions).toEqual([publish('idle', 6)])
    policy.published(THREAD, 6, 36_000)
    expect(policy.isAhead(THREAD)).toBe(false)
    expect(policy.snapshot()).toMatchObject({ published: 2, publishFailures: 0 })
  })

  it('asks for the next copy as soon as one lands on a thread that saved meanwhile and went quiet', () => {
    const policy = ownedAt(4)
    policy.saved(THREAD, { revision: 5, appendedBytes: 100 }, 0)
    expect(policy.poll(15_000).decisions).toEqual([publish('idle', 5)])
    policy.saved(THREAD, { revision: 6, appendedBytes: 100 }, 16_000)
    // The copy at 5 takes a minute; the thread has been quiet for longer than the idle period.
    expect(policy.published(THREAD, 5, 76_000)).toEqual({
      decisions: [publish('idle', 6)],
      nextAt: null
    })
  })

  it('takes a copy that holds more than it asked for as the answer, and a failure likewise', () => {
    const policy = ownedAt(4)
    policy.saved(THREAD, { revision: 5, appendedBytes: 100 }, 0)
    expect(policy.poll(15_000).decisions).toEqual([publish('idle', 5)])
    policy.saved(THREAD, { revision: 6, appendedBytes: 100 }, 15_500)
    // The copy was taken after the second save, so it holds revision 6.
    expect(policy.published(THREAD, 6, 16_000)).toEqual({ decisions: [], nextAt: null })
    expect(policy.isAhead(THREAD)).toBe(false)
    policy.saved(THREAD, { revision: 7, appendedBytes: 100 }, 20_000)
    expect(policy.poll(35_000).decisions).toEqual([publish('idle', 7)])
    policy.saved(THREAD, { revision: 8, appendedBytes: 100 }, 35_500)
    expect(policy.publishFailed(THREAD, 8, 36_000).nextAt).toBe(
      36_000 + OWNED_THREAD_PUBLISH_RETRY_MS
    )
    expect(policy.poll(36_000 + OWNED_THREAD_PUBLISH_RETRY_MS).decisions).toEqual([
      publish('idle', 8)
    ])
  })

  it('never moves the head of a thread backwards', () => {
    const policy = ownedAt(4)
    policy.saved(THREAD, { revision: 6, appendedBytes: 100 }, 0)
    // Told of an older save afterwards, it still asks for a copy that holds the newest.
    policy.saved(THREAD, { revision: 5, appendedBytes: 100 }, 1)
    expect(policy.poll(15_001).decisions).toEqual([publish('idle', 6)])
  })

  it('tries again after the retry interval when a publish fails', () => {
    const policy = ownedAt(4)
    policy.saved(THREAD, { revision: 5, appendedBytes: 100 }, 0)
    expect(policy.poll(15_000).decisions).toEqual([publish('idle', 5)])
    expect(policy.publishFailed(THREAD, 5, 16_000)).toEqual({
      decisions: [],
      nextAt: 16_000 + OWNED_THREAD_PUBLISH_RETRY_MS
    })
    expect(policy.poll(16_000 + OWNED_THREAD_PUBLISH_RETRY_MS - 1).decisions).toEqual([])
    expect(policy.poll(16_000 + OWNED_THREAD_PUBLISH_RETRY_MS).decisions).toEqual([
      publish('idle', 5)
    ])
    expect(policy.snapshot()).toMatchObject({ publishFailures: 1, decided: { idle: 2 } })
  })

  it('leaves a newer copy alone when an older one fails', () => {
    const policy = ownedAt(4)
    policy.saved(THREAD, { revision: 5, appendedBytes: 100 }, 0)
    expect(policy.poll(15_000).decisions).toEqual([publish('idle', 5)])
    policy.saved(THREAD, { revision: 6, appendedBytes: 100 }, 15_500)
    expect(policy.handoffRequested(THREAD).decisions).toEqual([publish('handoff', 6)])
    // The copy at 5 fails while the one at 6 is still being written: nothing is owed for it.
    expect(policy.publishFailed(THREAD, 5, 16_000)).toEqual({ decisions: [], nextAt: null })
    expect(policy.poll(10 * 60_000).decisions).toEqual([])
    expect(policy.published(THREAD, 6, 10 * 60_000 + 1)).toEqual({ decisions: [], nextAt: null })
    expect(policy.snapshot()).toMatchObject({ publishFailures: 1, published: 1 })
  })

  it('publishes a thread that has streamed for thirty minutes without a copy', () => {
    const policy = ownedAt(4)
    const caller = new Caller(policy)
    caller.take(policy.runStarted(THREAD, 'run-1'))
    let revision = 4
    // The first unpublished save is at one second; the thread then never rests.
    for (let now = 1_000; now <= 31 * 60_000; now += 250) {
      caller.advanceTo(now)
      caller.take(policy.saved(THREAD, { revision: ++revision, appendedBytes: 300 }, now))
    }
    expect(caller.decisions).toHaveLength(1)
    expect(caller.decisions[0].at).toBe(1_000 + OWNED_THREAD_STREAM_CAP_MS)
    expect(caller.decisions[0].decision).toMatchObject({ kind: 'publish', reason: 'stream_cap' })
    // The cap is a copy and nothing more: no compaction rides on it.
    expect(policy.snapshot().decided).toMatchObject({ stream_cap: 1, idle: 0, log_bytes: 0 })
    expect(caller.wakes).toBe(1)
  })

  it('applies the cap to a thread that keeps saving with no run, too', () => {
    const policy = ownedAt(4)
    const caller = new Caller(policy)
    let revision = 4
    // A save every ten seconds: never idle for fifteen, and no run to wait for.
    for (let now = 0; now <= OWNED_THREAD_STREAM_CAP_MS; now += 10_000) {
      caller.advanceTo(now)
      caller.take(policy.saved(THREAD, { revision: ++revision, appendedBytes: 300 }, now))
    }
    expect(caller.decisions).toEqual([
      { at: OWNED_THREAD_STREAM_CAP_MS, decision: publish('stream_cap', revision - 1) }
    ])
  })

  it('measures the cap from the copy the log has been ahead of, not from the first save ever', () => {
    const policy = ownedAt(4)
    policy.runStarted(THREAD, 'run-1')
    policy.saved(THREAD, { revision: 5, appendedBytes: 100 }, 1_000)
    const capAt = 1_000 + OWNED_THREAD_STREAM_CAP_MS
    expect(policy.poll(capAt).decisions).toEqual([publish('stream_cap', 5)])
    policy.saved(THREAD, { revision: 6, appendedBytes: 100 }, capAt + 500)
    // The copy lands at revision 5 while 6 is already in the log: ahead again from now.
    const landed = capAt + 4_000
    expect(policy.published(THREAD, 5, landed).nextAt).toBe(landed + OWNED_THREAD_STREAM_CAP_MS)
    // Told of the same copy again, it does not start the cap over.
    policy.published(THREAD, 5, landed + 60_000)
    expect(policy.poll(landed + OWNED_THREAD_STREAM_CAP_MS - 1).decisions).toEqual([])
    expect(policy.poll(landed + OWNED_THREAD_STREAM_CAP_MS).decisions).toEqual([
      publish('stream_cap', 6)
    ])
  })

  it('starts the cap afresh after a copy caught the log up', () => {
    const policy = ownedAt(4)
    policy.saved(THREAD, { revision: 5, appendedBytes: 100 }, 0)
    policy.poll(15_000)
    policy.published(THREAD, 5, 16_000)
    // Twenty minutes of rest, then a new stream: the cap counts from its first save.
    policy.runStarted(THREAD, 'run-2')
    expect(policy.saved(THREAD, { revision: 6, appendedBytes: 100 }, 20 * 60_000).nextAt).toBe(
      20 * 60_000 + OWNED_THREAD_STREAM_CAP_MS
    )
  })

  it('compacts on appended bytes alone: sixteen mebibytes since the last checkpoint', () => {
    const policy = ownedAt(4)
    policy.runStarted(THREAD, 'run-1')
    let revision = 4
    const save = (bytes: number, now: number): OwnedThreadCopyStep =>
      policy.saved(THREAD, { revision: ++revision, appendedBytes: bytes }, now)
    expect(save(OWNED_THREAD_COMPACT_BYTES - 1, 0).decisions).toEqual([])
    expect(save(1, 1).decisions).toEqual([
      {
        kind: 'compact',
        threadId: THREAD,
        reason: 'log_bytes',
        revision: 6,
        appendedBytes: OWNED_THREAD_COMPACT_BYTES
      }
    ])
    // One request at a time, however much more arrives while the worker runs.
    expect(save(3 * MIB, 2).decisions).toEqual([])
    // The checkpoint covers the log up to revision 6: three mebibytes came after it.
    expect(policy.checkpointed(THREAD, 6).decisions).toEqual([])
    expect(save(13 * MIB - 1, 4).decisions).toEqual([])
    expect(save(1, 5).decisions).toMatchObject([{ kind: 'compact', revision: 9 }])
    expect(policy.snapshot()).toMatchObject({ checkpointed: 1, decided: { log_bytes: 2 } })
  })

  it('has no time trigger and no entry-count trigger for compaction', () => {
    const policy = ownedAt(0)
    const caller = new Caller(policy, (decision, self) => {
      if (decision.kind === 'publish') {
        self.finishAt(self.now + 500, () =>
          policy.published(decision.threadId, decision.revision, self.now)
        )
      }
    })
    // Five thousand small saves over ten hours: far past two minutes and a thousand entries.
    for (let index = 1; index <= 5_000; index++) {
      caller.advanceTo(index * 7_200)
      caller.take(policy.saved(THREAD, { revision: index, appendedBytes: 1_000 }, caller.now))
    }
    caller.advanceTo(11 * 60 * 60_000)
    expect(caller.decisions.filter((entry) => entry.decision.kind === 'compact')).toEqual([])
    expect(caller.decisions.length).toBeGreaterThan(0)
    expect(policy.snapshot().decided.log_bytes).toBe(0)
  })

  it('counts the bytes already in the log when it adopts a thread', () => {
    const policy = new OwnedThreadCopyPolicy()
    const log = { publishedRevision: 4, headRevision: 9, logBytes: 15 * MIB }
    expect(policy.adopted(THREAD, log, 0).decisions).toEqual([])
    expect(
      policy.saved(THREAD, { revision: 10, appendedBytes: MIB }, 1_000).decisions
    ).toMatchObject([{ kind: 'compact', revision: 10, appendedBytes: 16 * MIB }])
    // A log that is already over the threshold is compacted as soon as the thread is adopted.
    expect(
      policy.adopted('thread-2', { ...log, logBytes: OWNED_THREAD_COMPACT_BYTES }, 0).decisions
    ).toEqual([
      {
        kind: 'compact',
        threadId: 'thread-2',
        reason: 'log_bytes',
        revision: 9,
        appendedBytes: OWNED_THREAD_COMPACT_BYTES
      }
    ])
  })

  it('asks for the next compaction as soon as a checkpoint lands on a log that kept growing', () => {
    const policy = ownedAt(4)
    policy.saved(THREAD, { revision: 5, appendedBytes: OWNED_THREAD_COMPACT_BYTES }, 0)
    policy.saved(THREAD, { revision: 6, appendedBytes: OWNED_THREAD_COMPACT_BYTES + 5 }, 1)
    expect(policy.checkpointed(THREAD, 5).decisions).toEqual([
      {
        kind: 'compact',
        threadId: THREAD,
        reason: 'log_bytes',
        revision: 6,
        appendedBytes: OWNED_THREAD_COMPACT_BYTES + 5
      }
    ])
  })

  it('asks again on the next save when a compaction fails, never on a timer', () => {
    const policy = ownedAt(4)
    policy.runStarted(THREAD, 'run-1')
    policy.saved(THREAD, { revision: 5, appendedBytes: OWNED_THREAD_COMPACT_BYTES }, 0)
    expect(policy.compactionFailed(THREAD)).toEqual({
      decisions: [],
      nextAt: OWNED_THREAD_STREAM_CAP_MS
    })
    expect(policy.poll(60_000).decisions).toEqual([])
    expect(
      policy.saved(THREAD, { revision: 6, appendedBytes: 10 }, 61_000).decisions
    ).toMatchObject([
      { kind: 'compact', revision: 6, appendedBytes: OWNED_THREAD_COMPACT_BYTES + 10 }
    ])
    expect(policy.snapshot()).toMatchObject({ compactionFailures: 1, decided: { log_bytes: 2 } })
  })

  it('counts a checkpoint written at the head for any other reason as covering the whole log', () => {
    const policy = ownedAt(4)
    policy.saved(THREAD, { revision: 5, appendedBytes: 10 * MIB }, 0)
    policy.checkpointed(THREAD, 5)
    expect(policy.saved(THREAD, { revision: 6, appendedBytes: 10 * MIB }, 2).decisions).toEqual([])
    // A checkpoint behind the head, which nobody asked for, changes no count.
    policy.checkpointed(THREAD, 5)
    expect(
      policy.saved(THREAD, { revision: 7, appendedBytes: 6 * MIB }, 4).decisions
    ).toMatchObject([{ kind: 'compact', appendedBytes: 16 * MIB }])
  })

  it('does not take a checkpoint older than the one it asked for as the answer', () => {
    const policy = ownedAt(4)
    policy.saved(THREAD, { revision: 5, appendedBytes: 100 }, 0)
    expect(
      policy.saved(THREAD, { revision: 6, appendedBytes: OWNED_THREAD_COMPACT_BYTES }, 1).decisions
    ).toMatchObject([{ kind: 'compact', revision: 6 }])
    policy.saved(THREAD, { revision: 7, appendedBytes: 3 * MIB }, 2)
    expect(policy.checkpointed(THREAD, 5).decisions).toEqual([])
    // The compaction asked for then fails: everything since the last real checkpoint still counts.
    policy.compactionFailed(THREAD)
    expect(policy.saved(THREAD, { revision: 8, appendedBytes: 1 }, 3).decisions).toMatchObject([
      { kind: 'compact', revision: 8, appendedBytes: OWNED_THREAD_COMPACT_BYTES + 3 * MIB + 101 }
    ])
  })

  it('at quit publishes every thread whose log is ahead, most recently active first', () => {
    const policy = new OwnedThreadCopyPolicy()
    for (const [threadId, lastSave] of [
      ['thread-a', 5_000],
      ['thread-b', 9_000],
      ['thread-c', 1_000],
      ['thread-d', 7_000]
    ] as const) {
      policy.adopted(threadId, { publishedRevision: 1, headRevision: 1, logBytes: 0 }, 0)
      // thread-c has nothing unpublished; the others do.
      if (threadId !== 'thread-c')
        policy.saved(threadId, { revision: 2, appendedBytes: 10 }, lastSave)
    }
    // A live run does not hold a thread back at quit.
    policy.runStarted('thread-d', 'run-1')
    expect(policy.quit(10_000, 10_000)).toEqual({
      decisions: [
        publish('quit', 2, 'thread-b'),
        publish('quit', 2, 'thread-d'),
        publish('quit', 2, 'thread-a')
      ],
      nextAt: 20_000
    })
    expect(policy.snapshot().decided.quit).toBe(3)
  })

  it('stops asking at quit once the time budget is spent, and says what is left for the Host', () => {
    const policy = new OwnedThreadCopyPolicy()
    for (const [threadId, lastSave] of [
      ['thread-a', 1_000],
      ['thread-b', 2_000],
      ['thread-c', 3_000]
    ] as const) {
      policy.adopted(threadId, { publishedRevision: 1, headRevision: 1, logBytes: 0 }, 0)
      policy.saved(threadId, { revision: 2, appendedBytes: 10 }, lastSave)
    }
    policy.quit(5_000, 10_000)
    // The caller writes them one at a time and asks what is still worth starting.
    policy.published('thread-c', 2, 11_000)
    expect(policy.poll(11_000)).toEqual({
      decisions: [publish('quit', 2, 'thread-b'), publish('quit', 2, 'thread-a')],
      nextAt: 15_000
    })
    policy.published('thread-b', 2, 15_000)
    expect(policy.poll(15_000)).toEqual({ decisions: [], nextAt: null })
    expect(policy.snapshot()).toMatchObject({
      decided: { quit: 3 },
      published: 2,
      leftAtQuit: ['thread-a']
    })
  })

  it('does not ask twice at quit for a copy that is already being written', () => {
    const policy = ownedAt(4)
    policy.saved(THREAD, { revision: 5, appendedBytes: 10 }, 0)
    expect(policy.poll(15_000).decisions).toEqual([publish('idle', 5)])
    expect(policy.quit(16_000, 10_000)).toEqual({ decisions: [], nextAt: 26_000 })
    // That copy fails: now quit asks for it, without waiting out the retry interval.
    policy.publishFailed(THREAD, 5, 17_000)
    expect(policy.poll(17_000).decisions).toEqual([publish('quit', 5)])
    // It fails again and is listed again; the copy just listed is the one being written.
    policy.publishFailed(THREAD, 5, 17_500)
    expect(policy.poll(17_600).decisions).toEqual([publish('quit', 5)])
    expect(policy.handoffRequested(THREAD).decisions).toEqual([])
    expect(policy.snapshot().decided).toMatchObject({ idle: 1, quit: 1, handoff: 0 })
    // A save during quit moves the head: the copy asked for no longer holds it.
    policy.saved(THREAD, { revision: 6, appendedBytes: 10 }, 18_000)
    expect(policy.poll(18_000).decisions).toEqual([publish('quit', 6)])
    expect(policy.snapshot().decided).toMatchObject({ idle: 1, quit: 2 })
    // Nothing is due on a timer while quitting except the end of the budget.
    policy.publishFailed(THREAD, 6, 19_000)
    expect(policy.poll(19_000 + OWNED_THREAD_PUBLISH_RETRY_MS)).toEqual({
      decisions: [],
      nextAt: null
    })
    expect(policy.snapshot().leftAtQuit).toEqual([THREAD])
  })

  it('leaves every copy to the quit list once the app is quitting', () => {
    const policy = ownedAt(4)
    policy.runStarted(THREAD, 'run-1')
    // Nothing is ahead, so there is nothing to write and no timer to keep.
    expect(policy.quit(60_000, 60_000)).toEqual({ decisions: [], nextAt: null })
    // A save lands and its run ends while the app is on its way out.
    policy.saved(THREAD, { revision: 5, appendedBytes: 10 }, 61_000)
    expect(policy.runEnded(THREAD, 'run-1', 90_000)).toEqual({ decisions: [], nextAt: null })
    expect(policy.poll(90_000)).toEqual({ decisions: [publish('quit', 5)], nextAt: 120_000 })
    expect(policy.snapshot().decided).toMatchObject({ quit: 1, idle: 0 })
  })

  it('publishes before a hand-off to the Host only when the log is ahead', () => {
    const policy = ownedAt(4)
    expect(policy.handoffRequested(THREAD).decisions).toEqual([])
    policy.saved(THREAD, { revision: 5, appendedBytes: 10 }, 1_000)
    expect(policy.handoffRequested(THREAD).decisions).toEqual([publish('handoff', 5)])
    // The Host asks again while that copy is being written: the same copy answers it.
    expect(policy.handoffRequested(THREAD).decisions).toEqual([])
    policy.published(THREAD, 5, 4_000)
    expect(policy.isAhead(THREAD)).toBe(false)
    expect(policy.snapshot().decided).toMatchObject({ handoff: 1, idle: 0 })
  })

  it('does not publish for a hand-off while an idle copy of the same revision is being written', () => {
    const policy = ownedAt(4)
    policy.saved(THREAD, { revision: 5, appendedBytes: 10 }, 0)
    expect(policy.poll(15_000).decisions).toEqual([publish('idle', 5)])
    expect(policy.handoffRequested(THREAD).decisions).toEqual([])
    // A save that the copy in flight will not hold needs its own.
    policy.saved(THREAD, { revision: 6, appendedBytes: 10 }, 16_500)
    expect(policy.handoffRequested(THREAD).decisions).toEqual([publish('handoff', 6)])
  })

  it('publishes for a hand-off even while a run is live and the thread has just saved', () => {
    const policy = ownedAt(4)
    policy.runStarted(THREAD, 'run-1')
    policy.saved(THREAD, { revision: 5, appendedBytes: 10 }, 1_000)
    expect(policy.handoffRequested(THREAD).decisions).toEqual([publish('handoff', 5)])
  })

  it('publishes at once as the fallback when the journal cannot take a save', () => {
    const policy = ownedAt(4)
    policy.runStarted(THREAD, 'run-1')
    expect(policy.journalFailed(THREAD, 5, 1_000).decisions).toEqual([
      publish('journal_failure', 5)
    ])
    // Each failed save needs its own copy: the one in flight was taken before it.
    expect(policy.journalFailed(THREAD, 6, 1_200).decisions).toEqual([
      publish('journal_failure', 6)
    ])
    // The first copy lands. It does not hold the second save, whose own copy is still on its way.
    expect(policy.published(THREAD, 5, 1_500)).toEqual({ decisions: [], nextAt: null })
    expect(policy.poll(60_000).decisions).toEqual([])
    policy.published(THREAD, 6, 61_000)
    expect(policy.isAhead(THREAD)).toBe(false)
    expect(policy.snapshot().decided.journal_failure).toBe(2)
  })

  it('retries a failed fallback copy after the retry interval, whatever the thread is doing', () => {
    const policy = ownedAt(4)
    // A run is live and the thread keeps saving: neither idle nor near the cap.
    policy.runStarted(THREAD, 'run-1')
    policy.journalFailed(THREAD, 5, 1_000)
    expect(policy.publishFailed(THREAD, 5, 2_000)).toEqual({
      decisions: [],
      nextAt: 2_000 + OWNED_THREAD_PUBLISH_RETRY_MS
    })
    policy.saved(THREAD, { revision: 6, appendedBytes: 10 }, 3_000)
    expect(policy.poll(2_000 + OWNED_THREAD_PUBLISH_RETRY_MS - 1).decisions).toEqual([])
    // The copy is the only record of the save the log refused, so it is asked for again.
    expect(policy.poll(2_000 + OWNED_THREAD_PUBLISH_RETRY_MS)).toEqual({
      decisions: [publish('journal_failure', 6)],
      nextAt: null
    })
    // Once a copy holds that save, the thread goes back to waiting for idle or the cap.
    expect(policy.published(THREAD, 6, 20_000).nextAt).toBeNull()
    expect(policy.saved(THREAD, { revision: 7, appendedBytes: 10 }, 21_000).nextAt).toBe(
      21_000 + OWNED_THREAD_STREAM_CAP_MS
    )
    expect(policy.snapshot().decided.journal_failure).toBe(2)
  })

  it('asks for nothing synchronous, whatever happens', () => {
    const policy = new OwnedThreadCopyPolicy()
    const steps = [
      policy.created(THREAD, 0, 0),
      policy.runStarted(THREAD, 'run-1'),
      policy.saved(THREAD, { revision: 1, appendedBytes: 17 * MIB }, 2),
      // A run's last save is a save like any other: no checkpoint rides on the run ending.
      policy.runEnded(THREAD, 'run-1', 3),
      policy.journalFailed(THREAD, 2, 4),
      policy.saved('thread-2', { revision: 1, appendedBytes: 5 }, 5),
      policy.handoffRequested('thread-2'),
      policy.saved('thread-3', { revision: 1, appendedBytes: 5 }, 5),
      policy.quit(6, 10_000)
    ]
    const decisions = steps.flatMap((step) => step.decisions)
    expect(decisions.map((decision) => `${decision.kind}: ${decision.reason}`)).toEqual([
      'publish: creation',
      'compact: log_bytes',
      'publish: journal_failure',
      'publish: handoff',
      'publish: quit'
    ])
    for (const decision of decisions) {
      expect(Object.keys(decision).sort()).toEqual(
        decision.kind === 'publish'
          ? ['kind', 'reason', 'revision', 'threadId']
          : ['appendedBytes', 'kind', 'reason', 'revision', 'threadId']
      )
    }
    expect(policy.runEnded(THREAD, 'run-1', 7).decisions).toEqual([])
  })

  it('tells the caller the earliest time anything falls due, across threads', () => {
    const policy = new OwnedThreadCopyPolicy()
    policy.adopted('thread-a', { publishedRevision: 1, headRevision: 1, logBytes: 0 }, 0)
    policy.adopted('thread-b', { publishedRevision: 1, headRevision: 1, logBytes: 0 }, 0)
    expect(policy.saved('thread-a', { revision: 2, appendedBytes: 10 }, 4_000).nextAt).toBe(19_000)
    expect(policy.saved('thread-b', { revision: 2, appendedBytes: 10 }, 9_000).nextAt).toBe(19_000)
    // thread-a saves again, so nothing is due at 19 s after all; the wake-up finds the real time.
    expect(policy.saved('thread-a', { revision: 3, appendedBytes: 10 }, 12_000).nextAt).toBe(19_000)
    expect(policy.poll(19_000)).toEqual({ decisions: [], nextAt: 24_000 })
    expect(policy.poll(24_000)).toEqual({
      decisions: [publish('idle', 2, 'thread-b')],
      nextAt: 27_000
    })
    expect(policy.poll(27_000)).toEqual({
      decisions: [publish('idle', 3, 'thread-a')],
      nextAt: null
    })
  })

  it('adopts a thread whose log is already ahead and publishes it once it is idle', () => {
    const policy = new OwnedThreadCopyPolicy()
    expect(
      policy.adopted(THREAD, { publishedRevision: 4, headRevision: 9, logBytes: 0 }, 1_000).nextAt
    ).toBe(1_000 + OWNED_THREAD_IDLE_PUBLISH_MS)
    expect(policy.isAhead(THREAD)).toBe(true)
    expect(policy.poll(16_000).decisions).toEqual([publish('idle', 9)])
  })

  it('follows a thread it was not told about from its first save', () => {
    const policy = new OwnedThreadCopyPolicy()
    expect(policy.saved(THREAD, { revision: 12, appendedBytes: 10 }, 0)).toEqual({
      decisions: [],
      nextAt: OWNED_THREAD_IDLE_PUBLISH_MS
    })
    expect(policy.poll(15_000).decisions).toEqual([publish('idle', 12)])
    // The same goes for a save the log refused: the copy is owed whoever announced the thread.
    expect(policy.journalFailed('thread-2', 3, 16_000).decisions).toEqual([
      publish('journal_failure', 3, 'thread-2')
    ])
    expect(policy.snapshot().threads).toBe(2)
  })

  it('does not start following a thread because of a report about it', () => {
    const policy = new OwnedThreadCopyPolicy()
    const nothing = { decisions: [], nextAt: null }
    expect(policy.published(THREAD, 7, 0)).toEqual(nothing)
    expect(policy.publishFailed(THREAD, 7, 0)).toEqual(nothing)
    expect(policy.checkpointed(THREAD, 7)).toEqual(nothing)
    expect(policy.compactionFailed(THREAD)).toEqual(nothing)
    expect(policy.handoffRequested(THREAD)).toEqual(nothing)
    expect(policy.runStarted(THREAD, 'run-1')).toEqual(nothing)
    expect(policy.runEnded(THREAD, 'run-1', 0)).toEqual(nothing)
    expect(policy.snapshot()).toMatchObject({ threads: 0, published: 0, checkpointed: 0 })
  })

  it('forgets a thread it no longer owns', () => {
    const policy = ownedAt(4)
    policy.saved(THREAD, { revision: 5, appendedBytes: 10 }, 0)
    expect(policy.snapshot().threads).toBe(1)
    policy.released(THREAD)
    expect(policy.snapshot().threads).toBe(0)
    expect(policy.isAhead(THREAD)).toBe(false)
    expect(policy.poll(60_000)).toEqual({ decisions: [], nextAt: null })
  })

  it('counts decisions by reason', () => {
    const policy = new OwnedThreadCopyPolicy()
    expect(policy.snapshot()).toEqual({
      decided: {
        creation: 0,
        idle: 0,
        stream_cap: 0,
        quit: 0,
        handoff: 0,
        journal_failure: 0,
        log_bytes: 0
      },
      published: 0,
      publishFailures: 0,
      checkpointed: 0,
      compactionFailures: 0,
      leftAtQuit: [],
      threads: 0,
      runningThreads: 0
    })
    policy.created('thread-a', 0, 0)
    policy.published('thread-a', 0, 1)
    policy.saved('thread-a', { revision: 1, appendedBytes: OWNED_THREAD_COMPACT_BYTES }, 2)
    policy.compactionFailed('thread-a')
    policy.poll(2 + OWNED_THREAD_IDLE_PUBLISH_MS)
    policy.publishFailed('thread-a', 1, 20_000)
    policy.journalFailed('thread-a', 2, 21_000)
    policy.handoffRequested('thread-a')
    policy.checkpointed('thread-a', 2)
    policy.quit(23_000, 5_000)
    expect(policy.snapshot()).toEqual({
      decided: {
        creation: 1,
        idle: 1,
        stream_cap: 0,
        quit: 0,
        handoff: 0,
        journal_failure: 1,
        log_bytes: 1
      },
      published: 1,
      publishFailures: 1,
      checkpointed: 1,
      compactionFailures: 1,
      leftAtQuit: [],
      threads: 1,
      runningThreads: 0
    })
  })

  it('rejects malformed input instead of guessing', () => {
    const policy = new OwnedThreadCopyPolicy()
    expect(() => policy.saved('', { revision: 1, appendedBytes: 1 }, 0)).toThrow(
      'Invalid thread id'
    )
    expect(() => policy.saved(THREAD, { revision: -1, appendedBytes: 1 }, 0)).toThrow(
      'Invalid revision'
    )
    expect(() => policy.saved(THREAD, { revision: 1, appendedBytes: -1 }, 0)).toThrow(
      'Invalid byte count'
    )
    expect(() =>
      policy.adopted(THREAD, { publishedRevision: 1, headRevision: 1, logBytes: 0.5 }, 0)
    ).toThrow('Invalid byte count')
    // The head of the log a writer continues is never behind the full copy it is built on.
    expect(() =>
      policy.adopted(THREAD, { publishedRevision: 2, headRevision: 1, logBytes: 0 }, 0)
    ).toThrow('Invalid revisions')
    expect(() => policy.created(THREAD, 1.5, 0)).toThrow('Invalid revision')
    expect(() => policy.runStarted(THREAD, '')).toThrow('Invalid run id')
    expect(() => policy.quit(0, -1)).toThrow('Invalid quit budget')
    expect(policy.snapshot().threads).toBe(0)
  })
})
