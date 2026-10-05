import { createRequire } from 'node:module'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)

type Read = { ok: true; section: Record<string, unknown> } | { ok: false; reason: string }
const durability = require('./barrierDurability.cjs') as {
  BARRIER_DURABILITY_EXPRESSION: string
  readBarrierDurability: (
    page: { evaluate(expression: string): Promise<unknown> },
    options?: { timeoutMs?: number }
  ) => Promise<Read>
  barrierDurabilityChange: (
    before: unknown,
    after: unknown
  ) => { ok: true; change: any } | { ok: false; reason: string; at?: string[] }
  barrierDurabilityAtFences: (
    before: Read | null,
    after: Read | null
  ) => { before: unknown; after: unknown; change: any; unavailable: string | null }
}
const {
  BARRIER_DURABILITY_EXPRESSION,
  readBarrierDurability,
  barrierDurabilityChange,
  barrierDurabilityAtFences
} = durability

const OWNERS = ['journal', 'run-events', 'detail', 'catalogue', 'directory']
const MOMENTS = ['user_message', 'decision', 'run_final', 'destructive']
const TRIGGERS = [
  'initial',
  'terminal',
  'idle',
  'bounded',
  'shutdown',
  'manual',
  'recovery',
  'other'
]

/** One kind of sync time at a fence: `5n` syncs, their total, the longest and the bands. */
function syncTimes(n: number, scale: number) {
  return {
    count: 5 * n,
    totalMs: 12.5 * n * scale,
    longestMs: 40 * scale + n,
    under10Ms: 2 * n,
    from10To50Ms: n,
    from50To200Ms: n,
    from200To1000Ms: n,
    from1000Ms: 0
  }
}

/**
 * The section as the contract gives it with the switch on, every figure
 * derived from `n` so that two fences differ in each of them.
 */
function sectionOn(n: number) {
  return {
    enabled: true,
    ignored: null,
    debt: {
      owners: Object.fromEntries(
        OWNERS.map((owner, place) => [
          owner,
          { noted: 10 * n + place, synced: 8 * n + place, missing: n, failed: 0 }
        ])
      ),
      barriers: {
        raised: 4 * n,
        idle: n,
        shared: 2 * n,
        rounds: 3 * n,
        renamedUnderway: 0,
        failed: 0,
        waitMsTotal: 12.5 * n,
        longestWaitMs: 20 + n,
        scoped: n,
        threadOnly: n,
        urgent: 2 * n,
        hastened: 0,
        beside: n,
        besideFailed: 0,
        runRounds: n,
        runPathsTotal: 4 * n,
        runPathsMost: 3 + n
      },
      trickle: {
        rounds: 2 * n,
        started: 5 * n,
        paid: 3 * n,
        notedSince: n,
        takenOver: n,
        failed: 0,
        inFlight: n % 2
      },
      waits: {
        urgent: {
          count: 2 * n,
          totalMs: 6.5 * n,
          longestMs: 9 + n,
          aheadTotal: 3 * n,
          aheadMost: 3,
          waitedBehind: n,
          behindTotalMs: 2.5 * n,
          behindLongestMs: 4 + n,
          ownSyncsTotalMs: 4 * n,
          ownSyncsLongestMs: 6
        },
        normal: {
          count: 2 * n,
          totalMs: 6 * n,
          longestMs: 30,
          aheadTotal: 5 * n,
          aheadMost: 7,
          waitedBehind: 0,
          behindTotalMs: 0,
          behindLongestMs: 0,
          ownSyncsTotalMs: 6 * n,
          ownSyncsLongestMs: 30
        }
      },
      owed: { threads: n, files: 2 * n, directories: 1 },
      owingRuns: n % 4,
      syncsOnCallingThread: 0
    },
    port: {
      started: 9 * n,
      inFlight: n % 3,
      queued: n % 2,
      joined: n,
      peakInFlight: 4,
      queuedUrgent: 0,
      queuedNormal: n % 2,
      startedUrgent: 3 * n,
      promoted: n,
      fairStarts: 0,
      urgencies: 0,
      queuedBackground: n % 5,
      startedBackground: 7 * n,
      backgroundFairStarts: n,
      extraUrgentStarts: n,
      timing: {
        urgent: { requestToStart: syncTimes(n, 1), startToSettle: syncTimes(n, 2) },
        normal: { requestToStart: syncTimes(n, 3), startToSettle: syncTimes(n, 4) },
        background: { requestToStart: syncTimes(n, 5), startToSettle: syncTimes(n, 6) }
      }
    },
    tickets: {
      moments: Object.fromEntries(
        MOMENTS.map((moment, place) => [
          moment,
          {
            noted: 5 * n + place,
            covered: 5 * n,
            uncovered: 0,
            failed: 0,
            pending: n % 2,
            undecided: 0,
            longestWaitMs: 30 + place
          }
        ])
      ),
      missingGates: 0,
      uncoveredRunFinals: n,
      lastMissingGate: null,
      awaits: 6 * n,
      awaitsRejected: 0,
      awaitsWaiting: n % 2,
      longestAwaitMs: 41,
      chats: 3
    },
    gates: { waits: 6 * n, overdue: 0, rejected: 0, waitMsTotal: 7.25 * n, longestWaitMs: 33 },
    starts: { waits: 2 * n, overdue: 0, rejected: 0, waitMsTotal: 3.5 * n, longestWaitMs: 10 + n },
    staging: {
      threads: n % 3,
      outstanding: n % 4,
      readyRefs: 2 * n,
      batches: { committed: 5 * n, durable: 4 * n, failed: 0, dropped: n },
      rows: { swapped: 20 * n, staged: 25 * n, passedOver: n },
      syncs: { files: 8 * n, directories: 2 * n },
      checkpointEvents: 3 * n
    },
    checkpoints: Object.fromEntries(
      TRIGGERS.map((trigger, place) => [
        trigger,
        { count: n + place, bytes: 1_000 * n + place, mainMs: 1.5 * n }
      ])
    ),
    tornTailsRepaired: 0
  }
}

/** With the switch off: the layer is not built, and checkpoints are still counted. */
function sectionOff(n: number) {
  const on = sectionOn(n)
  return {
    ...on,
    enabled: false,
    debt: null,
    port: null,
    tickets: null,
    gates: null,
    starts: null,
    staging: null
  }
}

/** A page whose main answers the snapshot `answer` gives. */
function pageAnswering(answer: () => unknown) {
  return {
    evaluate: async (expression: string) =>
      vm.runInNewContext(expression, {
        window: { api: { getMainPerfSnapshot: async () => answer() } }
      })
  }
}

describe('reading barrier durability from main', () => {
  it('reads the section from the snapshot main gives the page', async () => {
    const section = sectionOn(2)
    const read = await readBarrierDurability(
      pageAnswering(() => ({ sections: { other: { x: 1 }, threadBarrierDurability: section } }))
    )
    expect(read).toEqual({ ok: true, section })
  })

  it('says why there is no section to read', async () => {
    const answers: Array<[unknown, string]> = [
      [{ sections: {} }, 'section_absent'],
      [{}, 'section_absent'],
      [null, 'section_absent'],
      // Main's snapshot puts a provider's failure in place of its section.
      [{ sections: { threadBarrierDurability: { error: 'boom' } } }, 'section_failed'],
      [{ sections: { threadBarrierDurability: null } }, 'section_invalid'],
      [
        { sections: { threadBarrierDurability: { ...sectionOn(1), enabled: 'yes' } } },
        'section_invalid'
      ],
      [{ sections: { threadBarrierDurability: [1] } }, 'section_invalid']
    ]
    for (const [answer, reason] of answers) {
      expect(await readBarrierDurability(pageAnswering(() => answer))).toEqual({
        ok: false,
        reason
      })
    }
  })

  it('gives up on a page that fails or does not answer, without throwing', async () => {
    const failing = { evaluate: async () => Promise.reject(new Error('renderer went away')) }
    expect(await readBarrierDurability(failing)).toEqual({ ok: false, reason: 'read_failed' })
    const silent = { evaluate: () => new Promise(() => {}) }
    expect(await readBarrierDurability(silent, { timeoutMs: 5 })).toEqual({
      ok: false,
      reason: 'read_timed_out'
    })
  })

  it('reads through the expression it exports', () => {
    expect(BARRIER_DURABILITY_EXPRESSION).toContain('getMainPerfSnapshot')
    expect(BARRIER_DURABILITY_EXPRESSION).toContain('threadBarrierDurability')
  })
})

describe('what changed between the two fences', () => {
  it('differences every counter of the section', () => {
    const result = barrierDurabilityChange(sectionOn(2), sectionOn(5))
    expect(result.ok).toBe(true)
    const change = (result as { change: any }).change
    expect(change.enabled).toBe(true)
    expect(change.ignored).toBeNull()
    expect(change.debt.owners.journal).toEqual({ noted: 30, synced: 24, missing: 3, failed: 0 })
    expect(change.debt.owners['run-events'].noted).toBe(30)
    expect(change.debt.barriers).toMatchObject({
      raised: 12,
      idle: 3,
      shared: 6,
      rounds: 9,
      renamedUnderway: 0,
      failed: 0,
      waitMsTotal: 37.5
    })
    expect(change.debt.syncsOnCallingThread).toBe(0)
    expect(change.port).toMatchObject({ started: 27, joined: 3 })
    expect(change.tickets.moments.run_final).toMatchObject({
      noted: 15,
      covered: 15,
      uncovered: 0,
      failed: 0
    })
    expect(change.tickets).toMatchObject({
      missingGates: 0,
      uncoveredRunFinals: 3,
      awaits: 18,
      awaitsRejected: 0
    })
    expect(change.gates).toMatchObject({ waits: 18, overdue: 0, rejected: 0, waitMsTotal: 21.75 })
    expect(change.checkpoints.terminal).toEqual({ count: 3, bytes: 3_000, mainMs: 4.5 })
    expect(Object.keys(change.checkpoints)).toEqual(TRIGGERS)
    expect(change.tornTailsRepaired).toBe(0)
    expect(change.unread).toEqual([])
  })

  it("reads the urgent and scoped barriers, their waits by class and the port's queues by class", () => {
    const change = (barrierDurabilityChange(sectionOn(2), sectionOn(5)) as { change: any }).change
    expect(change.debt.barriers).toMatchObject({ scoped: 3, threadOnly: 3, urgent: 6, hastened: 0 })
    expect(change.debt.waits).toEqual({
      urgent: {
        count: 6,
        totalMs: 19.5,
        longestMs: { atMost: 14, exact: true },
        aheadTotal: 9,
        aheadMost: { atMost: 3, exact: false },
        waitedBehind: 3,
        behindTotalMs: 7.5,
        behindLongestMs: { atMost: 9, exact: true },
        ownSyncsTotalMs: 12,
        ownSyncsLongestMs: { atMost: 6, exact: false }
      },
      normal: {
        count: 6,
        totalMs: 18,
        longestMs: { atMost: 30, exact: false },
        aheadTotal: 15,
        aheadMost: { atMost: 7, exact: false },
        waitedBehind: 0,
        behindTotalMs: 0,
        behindLongestMs: { atMost: 0, exact: false },
        ownSyncsTotalMs: 18,
        ownSyncsLongestMs: { atMost: 30, exact: false }
      }
    })
    expect(change.debt.owingRuns).toEqual({ before: 2, after: 1 })
    expect(change.port).toMatchObject({
      queuedUrgent: { before: 0, after: 0 },
      queuedNormal: { before: 0, after: 1 },
      startedUrgent: 9,
      promoted: 3,
      fairStarts: 0,
      urgencies: { before: 0, after: 0 }
    })
    expect(change.unread).toEqual([])
  })

  it("reads the port's background class: what waits at it, and what it started", () => {
    const change = (barrierDurabilityChange(sectionOn(2), sectionOn(5)) as { change: any }).change
    expect(change.port).toMatchObject({
      queuedBackground: { before: 2, after: 0 },
      startedBackground: 21,
      backgroundFairStarts: 3
    })
    expect(change.unread).toEqual([])
  })

  it("reads the port's sync times by class: each band and the total between the fences, and the longest", () => {
    const change = (barrierDurabilityChange(sectionOn(2), sectionOn(5)) as { change: any }).change
    const between = (scale: number) => ({
      count: 15,
      totalMs: 37.5 * scale,
      longestMs: { atMost: 40 * scale + 5, exact: true },
      under10Ms: 6,
      from10To50Ms: 3,
      from50To200Ms: 3,
      from200To1000Ms: 3,
      from1000Ms: 0
    })
    expect(change.port.timing).toEqual({
      urgent: { requestToStart: between(1), startToSettle: between(2) },
      normal: { requestToStart: between(3), startToSettle: between(4) },
      background: { requestToStart: between(5), startToSettle: between(6) }
    })
    expect(change.unread).toEqual([])
  })

  it('splits each class of wait into the time behind another barrier and the time on its own syncs', () => {
    const change = (barrierDurabilityChange(sectionOn(2), sectionOn(5)) as { change: any }).change
    expect(change.debt.waits.urgent).toMatchObject({
      waitedBehind: 3,
      behindTotalMs: 7.5,
      behindLongestMs: { atMost: 9, exact: true },
      ownSyncsTotalMs: 12,
      ownSyncsLongestMs: { atMost: 6, exact: false }
    })
    expect(change.debt.waits.normal).toMatchObject({ waitedBehind: 0, ownSyncsTotalMs: 18 })
  })

  it('counts the barriers that synced beside a running one, and those of them that failed', () => {
    const after = sectionOn(5)
    after.debt.barriers.besideFailed = 2
    const change = (barrierDurabilityChange(sectionOn(2), after) as { change: any }).change
    expect(change.debt.barriers).toMatchObject({ beside: 3, besideFailed: 2 })
  })

  it("reads the queued starts' bounded barriers as it reads the gates", () => {
    const change = (barrierDurabilityChange(sectionOn(2), sectionOn(5)) as { change: any }).change
    expect(change.starts).toEqual({
      waits: 6,
      overdue: 0,
      rejected: 0,
      waitMsTotal: 10.5,
      longestWaitMs: { atMost: 15, exact: true }
    })
  })

  it('reads the reserved urgent place and the stores saved beside the threads', () => {
    const extended = (n: number) => ({
      ...sectionOn(n),
      usageLog: {
        appends: 10 * n,
        spills: n,
        background: {
          owed: { files: n, directories: 1 },
          rounds: 2 * n,
          failedRounds: 0,
          syncs: { files: 3 * n, directories: n },
          quitRounds: 0,
          quitUnpaid: 0
        },
        compactions: { started: n, completed: n, stopped: 0, failed: 0 }
      },
      runQueue: {
        changes: 7 * n,
        writes: 2 * n,
        coalesced: 5 * n,
        failed: 0,
        superseded: n,
        inlineWrites: 0,
        syncs: { files: 2 * n, directories: 2 * n },
        writing: n % 2 === 0,
        unwrittenChanges: n,
        quitUnwritten: 0,
        userWaits: {
          waits: 2 * n,
          overdue: n,
          rejected: 0,
          waitMsTotal: 5 * n,
          longestWaitMs: 10 + n
        },
        startWaits: {
          waits: n,
          overdue: 0,
          rejected: 0,
          waitMsTotal: 4 * n,
          longestWaitMs: 8 + n
        }
      }
    })
    const change = (barrierDurabilityChange(extended(2), extended(5)) as { change: any }).change
    expect(change.port.extraUrgentStarts).toBe(3)
    expect(change.usageLog).toEqual({
      appends: 30,
      spills: 3,
      background: {
        owed: { files: { before: 2, after: 5 }, directories: { before: 1, after: 1 } },
        rounds: 6,
        failedRounds: 0,
        syncs: { files: 9, directories: 3 },
        quitRounds: 0,
        quitUnpaid: 0
      },
      compactions: { started: 3, completed: 3, stopped: 0, failed: 0 }
    })
    expect(change.runQueue).toEqual({
      changes: 21,
      writes: 6,
      coalesced: 15,
      failed: 0,
      superseded: 3,
      inlineWrites: 0,
      syncs: { files: 6, directories: 6 },
      writing: { before: true, after: false },
      unwrittenChanges: { before: 2, after: 5 },
      quitUnwritten: 0,
      userWaits: {
        waits: 6,
        overdue: 3,
        rejected: 0,
        waitMsTotal: 15,
        longestWaitMs: { atMost: 15, exact: true }
      },
      startWaits: {
        waits: 3,
        overdue: 0,
        rejected: 0,
        waitMsTotal: 12,
        longestWaitMs: { atMost: 13, exact: true }
      }
    })
    expect(change.unread).toEqual([])
  })

  it('reads the staging of tool detail: its levels at both fences and its counters between them', () => {
    const change = (barrierDurabilityChange(sectionOn(2), sectionOn(5)) as { change: any }).change
    expect(change.staging).toEqual({
      threads: { before: 2, after: 2 },
      outstanding: { before: 2, after: 1 },
      readyRefs: { before: 4, after: 10 },
      batches: { committed: 15, durable: 12, failed: 0, dropped: 3 },
      rows: { swapped: 60, staged: 75, passedOver: 3 },
      syncs: { files: 24, directories: 6 },
      checkpointEvents: 9
    })
    expect(change.unread).toEqual([])
  })

  it('counts a failed staging batch between the fences', () => {
    const after = sectionOn(5)
    after.staging.batches.failed = 2
    const change = (barrierDurabilityChange(sectionOn(2), after) as { change: any }).change
    expect(change.staging.batches.failed).toBe(2)
  })

  it('reads background debt syncs and the paths paid by run barriers', () => {
    const after = sectionOn(5)
    after.debt.trickle.failed = 2
    const change = (barrierDurabilityChange(sectionOn(2), after) as { change: any }).change
    expect(change.debt.trickle).toEqual({
      rounds: 6,
      started: 15,
      paid: 9,
      notedSince: 3,
      takenOver: 3,
      failed: 2,
      inFlight: { before: 0, after: 1 }
    })
    expect(change.debt.barriers).toMatchObject({
      runRounds: 3,
      runPathsTotal: 12,
      runPathsMost: { atMost: 8, exact: true }
    })
    expect(change.unread).toEqual([])
  })

  it('reads what an older build does not report as null, and still differences the rest', () => {
    // No staging, no starts and no sync times; a port without its background
    // class, no beside barriers, and waits that are not split.
    const SPLIT = [
      'waitedBehind',
      'behindTotalMs',
      'behindLongestMs',
      'ownSyncsTotalMs',
      'ownSyncsLongestMs'
    ]
    const older = (n: number) => {
      const section = sectionOn(n) as any
      delete section.staging
      delete section.starts
      delete section.port.timing
      delete section.port.queuedBackground
      delete section.port.startedBackground
      delete section.port.backgroundFairStarts
      delete section.port.extraUrgentStarts
      delete section.debt.barriers.beside
      delete section.debt.barriers.besideFailed
      delete section.debt.barriers.runRounds
      delete section.debt.barriers.runPathsTotal
      delete section.debt.barriers.runPathsMost
      delete section.debt.trickle
      for (const kind of ['urgent', 'normal']) {
        for (const figure of SPLIT) delete section.debt.waits[kind][figure]
      }
      return section
    }
    const result = barrierDurabilityChange(older(2), older(5))
    expect(result.ok).toBe(true)
    const change = (result as { change: any }).change
    expect(change.staging).toBeNull()
    expect(change.starts).toBeNull()
    expect(change.usageLog).toBeNull()
    expect(change.runQueue).toBeNull()
    expect(change.debt.trickle).toBeNull()
    expect(change.port).toMatchObject({
      started: 27,
      queuedBackground: null,
      startedBackground: null,
      backgroundFairStarts: null,
      timing: null
    })
    expect(change.debt.barriers).toMatchObject({ raised: 12, beside: null, besideFailed: null })
    expect(change.debt.waits.urgent).toMatchObject({
      count: 6,
      ...Object.fromEntries(SPLIT.map((figure) => [figure, null]))
    })
    // Named, as is every figure a section does not give, and nothing refused.
    expect(change.unread).toEqual([
      'debt.barriers.beside',
      'debt.barriers.besideFailed',
      'debt.barriers.runPathsMost',
      'debt.barriers.runPathsTotal',
      'debt.barriers.runRounds',
      ...['normal', 'urgent'].flatMap((kind) =>
        [...SPLIT].sort().map((figure) => `debt.waits.${kind}.${figure}`)
      ),
      'port.backgroundFairStarts',
      'port.extraUrgentStarts',
      'port.queuedBackground',
      'port.startedBackground'
    ])
    const record = barrierDurabilityAtFences(
      { ok: true, section: older(2) },
      { ok: true, section: older(5) }
    )
    expect(record.unavailable).toBeNull()
    expect(record.change.debt.barriers.raised).toBe(12)
  })

  it('keeps a summed time to the microsecond, without the float error of subtracting it', () => {
    const before = sectionOn(1)
    const after = sectionOn(1)
    before.debt.barriers.waitMsTotal = 0.1
    after.debt.barriers.waitMsTotal = 0.4
    const change = (barrierDurabilityChange(before, after) as { change: any }).change
    expect(change.debt.barriers.waitMsTotal).toBe(0.3)
  })

  it('gives a level at both fences: what is owed, in flight, queued or waiting then', () => {
    const change = (barrierDurabilityChange(sectionOn(2), sectionOn(5)) as { change: any }).change
    expect(change.debt.owed).toEqual({
      threads: { before: 2, after: 5 },
      files: { before: 4, after: 10 },
      directories: { before: 1, after: 1 }
    })
    expect(change.port.inFlight).toEqual({ before: 2, after: 2 })
    expect(change.port.queued).toEqual({ before: 0, after: 1 })
    expect(change.tickets.moments.decision.pending).toEqual({ before: 0, after: 1 })
    expect(change.tickets.awaitsWaiting).toEqual({ before: 0, after: 1 })
    expect(change.tickets.chats).toEqual({ before: 3, after: 3 })
  })

  it("says a longest or a peak is the window's own only when it rose between the fences", () => {
    const change = (barrierDurabilityChange(sectionOn(2), sectionOn(5)) as { change: any }).change
    // Rose: some wait that settled between the fences was this long.
    expect(change.debt.barriers.longestWaitMs).toEqual({ atMost: 25, exact: true })
    // Did not: every wait between the fences was at most this long.
    expect(change.tickets.moments.user_message.longestWaitMs).toEqual({ atMost: 30, exact: false })
    expect(change.tickets.longestAwaitMs).toEqual({ atMost: 41, exact: false })
    expect(change.gates.longestWaitMs).toEqual({ atMost: 33, exact: false })
    expect(change.port.peakInFlight).toEqual({ atMost: 4, exact: false })
  })

  it('keeps the parts of a switched-off layer null and still differences its checkpoints', () => {
    const result = barrierDurabilityChange(sectionOff(1), sectionOff(4))
    expect(result.ok).toBe(true)
    const change = (result as { change: any }).change
    expect(change).toMatchObject({
      enabled: false,
      debt: null,
      port: null,
      tickets: null,
      gates: null,
      starts: null,
      threads: null,
      staging: null
    })
    expect(change.checkpoints.initial).toEqual({ count: 3, bytes: 3_000, mainMs: 4.5 })
    expect(change.unread).toEqual([])
  })

  it('says when the switch was ignored, and differences the counters as they are', () => {
    const ignored = (n: number) => ({ ...sectionOff(n), ignored: 'a flusher is on' })
    const change = (barrierDurabilityChange(ignored(1), ignored(2)) as { change: any }).change
    expect(change.enabled).toBe(false)
    expect(change.ignored).toBe('a flusher is on')
  })

  it("reads the quiet threads' figures when the section has them", () => {
    const withThreads = (n: number) => ({
      ...sectionOn(n),
      threads: {
        owing: n,
        idleBarriers: 2 * n,
        idleFailed: 0,
        quitThreads: 0,
        quitUnpaid: 0,
        trickles: 2 * n
      }
    })
    const change = (barrierDurabilityChange(withThreads(1), withThreads(3)) as { change: any })
      .change
    expect(change.threads).toEqual({
      owing: { before: 1, after: 3 },
      idleBarriers: 4,
      idleFailed: 0,
      quitThreads: 0,
      quitUnpaid: 0,
      trickles: 4
    })
  })

  it('keeps the most recent missing gate, to find the place that did not wait', () => {
    const missing = { chatId: 'chat-1', revision: 7, moment: 'decision' }
    const after = sectionOn(3)
    after.tickets.lastMissingGate = missing as never
    after.tickets.missingGates = 1
    const change = (barrierDurabilityChange(sectionOn(1), after) as { change: any }).change
    expect(change.tickets.missingGates).toBe(1)
    expect(change.tickets.lastMissingGate).toEqual(missing)
  })

  it('names the figures it does not know or could not read, and differences the rest', () => {
    const before = sectionOn(1) as any
    const after = sectionOn(2) as any
    before.debt.barriers.byClass = { userFacing: { p95Ms: 3 } }
    after.debt.barriers.byClass = { userFacing: { p95Ms: 4 } }
    after.port.queueDepthPeak = 5
    delete before.gates.overdue
    after.tickets.moments.run_final.covered = 'many'
    const result = barrierDurabilityChange(before, after)
    expect(result.ok).toBe(true)
    const change = (result as { change: any }).change
    expect(change.unread).toEqual([
      'debt.barriers.byClass',
      'gates.overdue',
      'port.queueDepthPeak',
      'tickets.moments.run_final.covered'
    ])
    expect(change.gates.overdue).toBeNull()
    expect(change.tickets.moments.run_final.covered).toBeNull()
    expect(change.gates.waits).toBe(6)
  })

  it('refuses two fences that disagree about the switch', () => {
    expect(barrierDurabilityChange(sectionOff(1), sectionOn(2))).toMatchObject({
      ok: false,
      reason: 'switch_differs_between_fences'
    })
    const ignored = { ...sectionOff(2), ignored: 'a flusher is on' }
    expect(barrierDurabilityChange(sectionOff(1), ignored)).toMatchObject({
      ok: false,
      reason: 'switch_differs_between_fences'
    })
  })

  it('refuses a counter that went back: main is not the process it was at the first fence', () => {
    expect(barrierDurabilityChange(sectionOn(5), sectionOn(2))).toMatchObject({
      ok: false,
      reason: 'counter_went_back'
    })
    const after = sectionOn(5)
    after.checkpoints.idle.bytes = 0
    const refused = barrierDurabilityChange(sectionOn(2), after)
    expect(refused).toEqual({
      ok: false,
      reason: 'counter_went_back',
      at: ['checkpoints.idle.bytes']
    })
  })

  it('refuses a part present at one fence and not the other', () => {
    expect(barrierDurabilityChange(sectionOn(1), { ...sectionOn(2), debt: null })).toMatchObject({
      ok: false,
      reason: 'part_differs_between_fences'
    })
  })
})

describe("a window's record of barrier durability", () => {
  it('keeps both fences and what changed between them', () => {
    const before = sectionOn(1)
    const after = sectionOn(2)
    const record = barrierDurabilityAtFences(
      { ok: true, section: before },
      { ok: true, section: after }
    )
    expect(record.before).toEqual(before)
    expect(record.after).toEqual(after)
    expect(record.unavailable).toBeNull()
    expect(record.change.debt.barriers.raised).toBe(4)
  })

  it('says why it has no change, keeping the fence that was read', () => {
    const section = sectionOn(1)
    expect(
      barrierDurabilityAtFences(
        { ok: false, reason: 'section_absent' },
        {
          ok: false,
          reason: 'section_absent'
        }
      )
    ).toEqual({ before: null, after: null, change: null, unavailable: 'section_absent' })
    expect(
      barrierDurabilityAtFences({ ok: true, section }, { ok: false, reason: 'read_timed_out' })
    ).toEqual({ before: section, after: null, change: null, unavailable: 'read_timed_out' })
    expect(barrierDurabilityAtFences(null, null)).toEqual({
      before: null,
      after: null,
      change: null,
      unavailable: 'reader_absent'
    })
    expect(
      barrierDurabilityAtFences({ ok: true, section: sectionOn(3) }, { ok: true, section })
    ).toMatchObject({ change: null, unavailable: 'counter_went_back' })
  })
})
