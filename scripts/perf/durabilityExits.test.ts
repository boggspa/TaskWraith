import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)

type Dict = Record<string, any>
type Row = {
  capture: string
  state: string
  repetition: number
  verdict: string
  value: any
  reasons: string[]
} & Dict
type Exit = {
  verdict: string
  reasons: string[]
  limit?: number
  windows: Row[]
  offWindows?: Row[]
} & Dict
type Result = {
  schemaVersion: number
  thresholds: Dict
  pair: { qualified: boolean; reasons: string[] }
  exits: Record<string, Exit>
  verdict: string
}
const { evaluateDurabilityExits, runDurabilityExitsCli } = require('./durabilityExits.cjs') as {
  evaluateDurabilityExits: (input: { captures: unknown[]; thresholds?: Dict }) => Result
  runDurabilityExitsCli: (
    argv: string[],
    options: { readCapture?: (dir: string) => unknown; write?: (line: string) => void }
  ) => number
}
const { DURABILITY_EXIT_THRESHOLDS, PHASE_EXIT_THRESHOLDS } =
  require('./perfGateThresholds.cjs') as {
    DURABILITY_EXIT_THRESHOLDS: Dict
    PHASE_EXIT_THRESHOLDS: Dict
  }
const { DURABILITY_SWITCH } = require('./durabilityPair.cjs') as { DURABILITY_SWITCH: string }
const { resolveRolloutFlags } = require('./rolloutFlags.cjs') as {
  resolveRolloutFlags: (options: { declared?: string[] }) => { record: Dict }
}

const SHA = 'a'.repeat(40)
const ORDER = ['off-0', 'on-0', 'off-1', 'on-1', 'off-2', 'on-2']
const TURNS = 40
const SAMPLED_MS = 30_000

const moment = (noted: number, longest: number, extra: Dict = {}) => ({
  noted,
  covered: noted,
  uncovered: 0,
  failed: 0,
  pending: { before: 0, after: 0 },
  undecided: { before: 0, after: 0 },
  longestWaitMs: { atMost: longest, exact: true },
  ...extra
})

/** What the section says changed in a window with the switch on: all well. */
function changeOn(overrides: Dict = {}) {
  return {
    enabled: true,
    ignored: null,
    debt: {
      owners: {
        journal: { noted: 400, synced: 380, missing: 0, failed: 0 },
        'run-events': { noted: 300, synced: 290, missing: 0, failed: 0 },
        detail: { noted: 50, synced: 50, missing: 0, failed: 0 },
        catalogue: { noted: 0, synced: 0, missing: 0, failed: 0 },
        directory: { noted: 30, synced: 30, missing: 0, failed: 0 }
      },
      barriers: {
        raised: 120,
        idle: 4,
        shared: 10,
        rounds: 100,
        renamedUnderway: 0,
        failed: 0,
        waitMsTotal: 900,
        longestWaitMs: { atMost: 70, exact: true },
        scoped: 36,
        threadOnly: 0,
        urgent: 8,
        hastened: 2
      },
      waits: {
        urgent: {
          count: 8,
          totalMs: 96,
          longestMs: { atMost: 29, exact: true },
          aheadTotal: 16,
          aheadMost: { atMost: 5, exact: true }
        },
        normal: {
          count: 112,
          totalMs: 804,
          longestMs: { atMost: 70, exact: true },
          aheadTotal: 560,
          aheadMost: { atMost: 14, exact: true }
        }
      },
      owed: {
        threads: { before: 0, after: 1 },
        files: { before: 0, after: 2 },
        directories: { before: 0, after: 0 }
      },
      syncsOnCallingThread: 0
    },
    port: {
      started: 750,
      inFlight: { before: 0, after: 1 },
      queued: { before: 0, after: 3 },
      joined: 12,
      peakInFlight: { atMost: 2, exact: true },
      queuedUrgent: { before: 0, after: 0 },
      queuedNormal: { before: 0, after: 3 },
      startedUrgent: 30,
      promoted: 4,
      fairStarts: 1,
      urgencies: { before: 0, after: 0 }
    },
    tickets: {
      moments: {
        user_message: moment(6, 18),
        decision: moment(2, 30),
        run_final: moment(36, 120),
        destructive: moment(0, 0, { longestWaitMs: { atMost: 0, exact: false } })
      },
      missingGates: 0,
      uncoveredRunFinals: 4,
      lastMissingGate: null,
      awaits: 44,
      awaitsRejected: 0,
      awaitsWaiting: { before: 0, after: 0 },
      longestAwaitMs: { atMost: 31, exact: true },
      chats: { before: 3, after: 3 }
    },
    gates: {
      waits: 8,
      overdue: 0,
      rejected: 0,
      waitMsTotal: 96,
      longestWaitMs: { atMost: 30, exact: true }
    },
    threads: null,
    checkpoints: {
      initial: { count: 0, bytes: 0, mainMs: 0 },
      terminal: { count: 36, bytes: 360_000, mainMs: 540 },
      bounded: { count: 2, bytes: 90_000, mainMs: 40 },
      idle: { count: 0, bytes: 0, mainMs: 0 },
      other: { count: 0, bytes: 0, mainMs: 0 }
    },
    tornTailsRepaired: 0,
    unread: [],
    ...overrides
  }
}

/** With the switch off the layer's parts are null; checkpoints are still counted. */
function changeOff() {
  return {
    ...changeOn(),
    enabled: false,
    debt: null,
    port: null,
    tickets: null,
    gates: null,
    checkpoints: {
      terminal: { count: 36, bytes: 360_000, mainMs: 520 },
      bounded: { count: 2, bytes: 90_000, mainMs: 40 }
    }
  }
}

/** A window's main-thread shares: the switch on unless the owners say otherwise. */
function shareWindow(state: 'off' | 'on', overrides: Dict = {}) {
  const on = state === 'on'
  return {
    id: 'many_agents_0',
    repetition: 0,
    measured: true,
    clock: { basis: 'markers', uncertaintyMs: 0.5 },
    windowMs: SAMPLED_MS,
    sampledMs: SAMPLED_MS,
    shares: { idle: 0.2, busy: 0.8, sync: on ? 0.07 : 0.65, atomicsWait: 0 },
    syncOwners: {
      toolDetail: 0,
      cataloguePublication: on ? 0 : 0.2,
      journalCheckpoint: 0.06,
      journal: on ? 0.0002 : 0.06,
      runEvents: on ? 0.0001 : 0.02,
      runQueue: 0.008,
      usageLedger: 0.0017,
      workspaceLock: 0,
      sessionCheckpoint: 0,
      catalogueChecks: 0,
      chatAuthority: 0,
      other: 0
    },
    syncOtherCallers: [],
    modelTurns: TURNS,
    perModelTurn: {
      mainBusyMs: on ? 300 : 600,
      syncMs: on ? 52.5 : 487.5,
      plainFileCallMs: 100,
      atomicsWaitMs: 0,
      restMs: on ? 147.5 : 12.5
    },
    ...overrides
  }
}

type CaptureOptions = {
  change?: Dict | null
  unavailable?: string
  share?: Dict
  reasons?: string[]
  main?: Dict | null
}

/** One capture of the pair: its report, as the runner wrote it, and its window's shares. */
function capture(state: 'off' | 'on', index: number, options: CaptureOptions = {}) {
  const change =
    options.change === undefined ? (state === 'on' ? changeOn() : changeOff()) : options.change
  const main =
    options.main === undefined ? { enabled: state === 'on', ignored: null } : options.main
  const id = `bd-agents-${ORDER[index]}`
  return {
    id,
    report: {
      environment: {
        workload: 'many_agents_live',
        gitSha: SHA,
        seed: 42,
        startedAt: new Date(Date.UTC(2026, 9, 5, 4, 10 * index)).toISOString(),
        instanceId: id,
        rolloutFlags: JSON.parse(
          JSON.stringify(
            resolveRolloutFlags({ declared: state === 'on' ? [DURABILITY_SWITCH] : [] }).record
          )
        )
      },
      runEvidence: { buildId: SHA, fixtureFingerprint: 'f'.repeat(64) },
      liveRounds: {
        agents: {
          asked: { threads: 3, seats: 2, seatMode: 'parallel' },
          options: { windowMs: SAMPLED_MS },
          windows: [
            {
              repetition: 0,
              reasons: options.reasons ?? [],
              barrierDurability: {
                before: main,
                after: main,
                change,
                unavailable: change === null ? (options.unavailable ?? 'section_absent') : null
              }
            }
          ]
        }
      }
    },
    shares: {
      build: { scripts: 56, missingNames: [] },
      windows: [shareWindow(state, options.share)]
    }
  }
}

/** The six captures, each made as `make` says (all well by default). */
function pair(make: (state: 'off' | 'on', index: number) => CaptureOptions = () => ({})) {
  return ORDER.map((name, index) => {
    const state = index % 2 ? 'on' : 'off'
    return capture(state, index, make(state, index))
  })
}

function evaluate(captures = pair(), thresholds?: Dict) {
  return evaluateDurabilityExits({ captures, ...(thresholds ? { thresholds } : {}) })
}

const JUDGED = [
  'threadStoreSyncs',
  'mainSyncsNamed',
  'synchronousWait',
  'ticketGates',
  'barrierWaitUserFacing',
  'barrierWaitRunFinal'
]
const verdicts = (result: Result) =>
  Object.fromEntries(Object.entries(result.exits).map(([id, exit]) => [id, exit.verdict]))

describe('the thresholds', () => {
  it('holds the layer’s limits as parameters, the store syncs at the phase exits’ tolerance', () => {
    expect(DURABILITY_EXIT_THRESHOLDS).toEqual({
      maxThreadStoreSyncShare: PHASE_EXIT_THRESHOLDS.maxMainSyncShare,
      maxUnnamedSyncShare: 0,
      maxSynchronousWaitShare: 0,
      maxUserFacingBarrierWaitP95Ms: 50,
      maxRunFinalBarrierWaitP95Ms: 250
    })
    expect(Object.isFrozen(DURABILITY_EXIT_THRESHOLDS)).toBe(true)
  })
})

describe('barrier durability’s exits over an off-against-on pair', () => {
  it('passes a pair that meets every limit, judging only the captures with the switch on', () => {
    const result = evaluate()
    expect(result.pair.qualified).toBe(true)
    expect(verdicts(result)).toEqual({
      threadStoreSyncs: 'pass',
      mainSyncsNamed: 'pass',
      synchronousWait: 'pass',
      ticketGates: 'pass',
      barrierWaitUserFacing: 'pass',
      barrierWaitRunFinal: 'pass',
      checkpointsOnMain: 'measured',
      portSyncs: 'measured',
      mainBusyMsPerModelTurn: 'measured'
    })
    expect(result.verdict).toBe('pass')
    for (const id of JUDGED) {
      expect(result.exits[id].windows.map((row) => row.capture)).toEqual([
        'bd-agents-on-0',
        'bd-agents-on-1',
        'bd-agents-on-2'
      ])
    }
    expect(result.thresholds).toEqual(DURABILITY_EXIT_THRESHOLDS)
  })

  it('counts the thread stores’ syncs without the journal’s checkpoints, and shows them with the switch off', () => {
    const result = evaluate()
    const exit = result.exits.threadStoreSyncs
    expect(exit.limit).toBe(0.001)
    expect(exit.windows[0]).toMatchObject({ verdict: 'pass', value: 0.0003 })
    // Off, the same figure, beside: not judged.
    expect(exit.offWindows!.map((row) => row.value)).toEqual([0.28, 0.28, 0.28])
    const failing = evaluate(
      pair((state, index) =>
        index === 3
          ? { share: { syncOwners: { ...shareWindow('on').syncOwners, runEvents: 0.002 } } }
          : {}
      )
    )
    expect(failing.exits.threadStoreSyncs.verdict).toBe('fail')
    expect(failing.exits.threadStoreSyncs.windows[1]).toMatchObject({
      verdict: 'fail',
      value: 0.0022,
      reasons: ['over_limit']
    })
    expect(failing.verdict).toBe('fail')
  })

  it('names every sync still on the main thread, and fails one it cannot name', () => {
    const result = evaluate()
    const row = result.exits.mainSyncsNamed.windows[0]
    expect(row).toMatchObject({ verdict: 'pass', value: 0 })
    // Each owner still syncing, by its share and its milliseconds per model turn.
    expect(row.stillSyncing).toEqual([
      { owner: 'journalCheckpoint', share: 0.06, msPerModelTurn: 45 },
      { owner: 'runQueue', share: 0.008, msPerModelTurn: 6 },
      { owner: 'usageLedger', share: 0.0017, msPerModelTurn: 1.275 },
      { owner: 'journal', share: 0.0002, msPerModelTurn: 0.15 },
      { owner: 'runEvents', share: 0.0001, msPerModelTurn: 0.075 }
    ])
    const callers = [{ callers: 'writeJsonAdmitted <- writeJson <- updateSettings', share: 0.0004 }]
    const unnamed = evaluate(
      pair((state, index) =>
        index === 1
          ? {
              share: {
                syncOwners: { ...shareWindow('on').syncOwners, other: 0.0004 },
                syncOtherCallers: callers
              }
            }
          : {}
      )
    )
    expect(unnamed.exits.mainSyncsNamed.windows[0]).toMatchObject({
      verdict: 'fail',
      value: 0.0004,
      reasons: ['over_limit'],
      unnamedCallers: callers
    })
    // Unnamed time is the callers', not an owner's.
    expect(
      unnamed.exits.mainSyncsNamed.windows[0].stillSyncing.map((each: Dict) => each.owner)
    ).not.toContain('other')
  })

  it('fails a window that held the main thread in a synchronous wait', () => {
    const waited = evaluate(
      pair((state, index) =>
        index === 5
          ? { share: { shares: { ...shareWindow('on').shares, atomicsWait: 0.003 } } }
          : {}
      )
    )
    expect(waited.exits.synchronousWait.windows[2]).toMatchObject({
      verdict: 'fail',
      value: 0.003,
      msPerModelTurn: 2.25
    })
    const unmeasurable = evaluate(
      pair((state, index) =>
        index === 5 ? { share: { shares: { ...shareWindow('on').shares, atomicsWait: null } } } : {}
      )
    )
    expect(unmeasurable.exits.synchronousWait.windows[2]).toMatchObject({
      verdict: 'not_measured',
      reasons: ['wait_not_measurable']
    })
    expect(unmeasurable.exits.synchronousWait.verdict).toBe('not_measured')
  })

  it('judges a share placed by loose markers across their bounds, and never passes an estimated one', () => {
    const loose = (bounds: [number, number]) =>
      pair((state, index) =>
        index === 1
          ? {
              share: {
                clock: { basis: 'loose_markers', uncertaintyMs: 1.4 },
                syncOwnerBounds: {
                  toolDetail: [0, 0],
                  cataloguePublication: [0, 0],
                  journal: bounds,
                  runEvents: [0.0001, 0.0001]
                }
              }
            }
          : {}
      )
    expect(evaluate(loose([0.0002, 0.0002])).exits.threadStoreSyncs.windows[0]).toMatchObject({
      verdict: 'pass',
      bounds: [0.0003, 0.0003]
    })
    expect(evaluate(loose([0.0002, 0.0012])).exits.threadStoreSyncs.windows[0]).toMatchObject({
      verdict: 'not_measured',
      reasons: ['profile_clock_loose']
    })
    expect(evaluate(loose([0.0011, 0.0012])).exits.threadStoreSyncs.windows[0]).toMatchObject({
      verdict: 'fail'
    })
    const estimated = evaluate(
      pair((state, index) =>
        index === 1 ? { share: { clock: { basis: 'estimated_profile_end' } } } : {}
      )
    )
    expect(estimated.exits.threadStoreSyncs.windows[0]).toMatchObject({
      verdict: 'not_measured',
      reasons: ['profile_clock_estimated']
    })
  })

  it('needs a window the runner kept, shares the profile gave, and main’s word that the switch was on', () => {
    const rowOf = (options: CaptureOptions) =>
      evaluate(pair((state, index) => (index === 1 ? options : {}))).exits.threadStoreSyncs
        .windows[0]
    expect(rowOf({ reasons: ['rounds_missing'] })).toMatchObject({
      verdict: 'not_measured',
      reasons: ['window_ineligible']
    })
    // Shares are matched to a window by place, and must name the same window.
    expect(rowOf({ share: { repetition: 1 } })).toMatchObject({
      verdict: 'not_measured',
      reasons: ['shares_absent_for_window']
    })
    expect(rowOf({ share: { measured: false, reason: 'loose_clock_moves_share' } })).toMatchObject({
      verdict: 'not_measured',
      reasons: ['loose_clock_moves_share']
    })
    expect(rowOf({ main: { enabled: false, ignored: 'a flusher is on' } })).toMatchObject({
      verdict: 'not_measured',
      reasons: ['switch_not_on_in_main:ignored']
    })
    expect(rowOf({ change: null, main: null, unavailable: 'section_absent' })).toMatchObject({
      verdict: 'not_measured',
      reasons: ['switch_unconfirmed:section_absent']
    })
    // A build that cannot vouch for the store owners' names.
    const unvouched = evaluate(
      pair((state, index) =>
        index === 1
          ? { share: { syncOwners: { ...shareWindow('on').syncOwners, journal: null } } }
          : {}
      )
    ).exits.threadStoreSyncs.windows[0]
    expect(unvouched).toMatchObject({ verdict: 'not_measured', reasons: ['function_not_in_build'] })
  })

  it('fails a missing or overdue gate, and gives the gates’ waits as far as the section counts them', () => {
    const result = evaluate()
    const row = result.exits.ticketGates.windows[0]
    expect(row).toMatchObject({
      verdict: 'pass',
      value: { missingGates: 0, overdue: 0 },
      waits: {
        count: 8,
        meanMs: 12,
        longestMs: { atMost: 30, exact: true },
        p50Ms: null,
        p95Ms: null,
        spread:
          'not_measured: the section counts the waits, their total and the longest, not their spread'
      },
      awaits: { count: 44, rejected: 0, longestMs: { atMost: 31, exact: true } }
    })
    const missed = { chatId: 'chat-2', revision: 9, moment: 'decision' }
    const missing = evaluate(
      pair((state, index) =>
        index === 3
          ? {
              change: changeOn({
                tickets: { ...changeOn().tickets, missingGates: 2, lastMissingGate: missed }
              })
            }
          : {}
      )
    ).exits.ticketGates.windows[1]
    expect(missing).toMatchObject({
      verdict: 'fail',
      value: { missingGates: 2, overdue: 0 },
      reasons: ['missing_gate'],
      lastMissingGate: missed
    })
    const overdue = evaluate(
      pair((state, index) =>
        index === 3 ? { change: changeOn({ gates: { ...changeOn().gates, overdue: 1 } }) } : {}
      )
    ).exits.ticketGates.windows[1]
    expect(overdue).toMatchObject({ verdict: 'fail', reasons: ['overdue_gate'] })
  })

  it('cannot pass the gates without them, or while a user-facing ticket is still undecided', () => {
    const noGates = evaluate(
      pair((state, index) => (index === 1 ? { change: changeOn({ gates: null }) } : {}))
    ).exits.ticketGates.windows[0]
    expect(noGates).toMatchObject({ verdict: 'not_measured', reasons: ['gates_not_reported'] })
    const tickets = changeOn().tickets
    const undecided = evaluate(
      pair((state, index) =>
        index === 1
          ? {
              change: changeOn({
                tickets: {
                  ...tickets,
                  moments: {
                    ...tickets.moments,
                    decision: moment(2, 30, { undecided: { before: 0, after: 1 } })
                  }
                }
              })
            }
          : {}
      )
    ).exits.ticketGates.windows[0]
    expect(undecided).toMatchObject({
      verdict: 'not_measured',
      reasons: ['tickets_undecided_at_second_fence']
    })
    const pending = evaluate(
      pair((state, index) =>
        index === 1
          ? {
              change: changeOn({
                tickets: {
                  ...tickets,
                  moments: {
                    ...tickets.moments,
                    user_message: moment(6, 18, { pending: { before: 0, after: 2 } })
                  }
                }
              })
            }
          : {}
      )
    ).exits.ticketGates.windows[0]
    expect(pending).toMatchObject({
      verdict: 'not_measured',
      reasons: ['tickets_pending_at_second_fence'],
      pendingAtSecondFence: 2
    })
    const absent = evaluate(
      pair((state, index) => (index === 1 ? { change: null, unavailable: 'section_absent' } : {}))
    ).exits.ticketGates.windows[0]
    expect(absent).toMatchObject({ verdict: 'not_measured', reasons: ['section_absent'] })
  })

  it('passes a barrier wait class whose longest wait is under its limit: no p95 can be over it', () => {
    const result = evaluate()
    expect(result.exits.barrierWaitUserFacing.limit).toBe(50)
    expect(result.exits.barrierWaitUserFacing.windows[0]).toMatchObject({
      verdict: 'pass',
      value: 30,
      valueIs: 'upper_bound',
      tickets: 8,
      moments: ['user_message', 'decision', 'destructive'],
      // Beside it, the urgent barriers themselves: what the user's waits queued behind.
      barriers: {
        class: 'urgent',
        count: 8,
        meanMs: 12,
        longestMs: { atMost: 29, exact: true },
        syncsAheadMean: 2,
        syncsAheadMost: { atMost: 5, exact: true }
      }
    })
    expect(result.exits.barrierWaitRunFinal.limit).toBe(250)
    expect(result.exits.barrierWaitRunFinal.windows[0]).toMatchObject({
      verdict: 'pass',
      value: 120,
      tickets: 36,
      // Every barrier that is not urgent: a run's own, idle and quit ones alike.
      barriers: { class: 'normal', count: 112, meanMs: 7.179, syncsAheadMean: 5 }
    })
  })

  it('fails a class only when its p95 is known to be over: fewer than twenty waits, all inside the window', () => {
    const withUserWaits = (decision: Dict) => {
      const tickets = changeOn().tickets
      return pair((state, index) =>
        index === 1
          ? {
              change: changeOn({
                tickets: { ...tickets, moments: { ...tickets.moments, decision } }
              })
            }
          : {}
      )
    }
    // Eight waits, the longest 80 ms and seen inside the window: by nearest
    // rank the p95 of fewer than twenty is the longest.
    expect(
      evaluate(withUserWaits(moment(2, 80))).exits.barrierWaitUserFacing.windows[0]
    ).toMatchObject({
      verdict: 'fail',
      value: 80,
      valueIs: 'exact',
      reasons: ['over_limit']
    })
    // The longest is from before the window: only a bound, and over the limit.
    expect(
      evaluate(withUserWaits(moment(2, 80, { longestWaitMs: { atMost: 80, exact: false } }))).exits
        .barrierWaitUserFacing.windows[0]
    ).toMatchObject({ verdict: 'not_measured', reasons: ['p95_unknown_longest_over_limit'] })
    // Twenty or more waits: the longest says nothing of the p95.
    expect(
      evaluate(withUserWaits(moment(14, 80))).exits.barrierWaitUserFacing.windows[0]
    ).toMatchObject({ verdict: 'not_measured', reasons: ['p95_unknown_longest_over_limit'] })
    // A ticket still waiting at the second fence has no wait yet.
    expect(
      evaluate(withUserWaits(moment(2, 10, { pending: { before: 0, after: 1 } }))).exits
        .barrierWaitUserFacing.windows[0]
    ).toMatchObject({ verdict: 'not_measured', reasons: ['tickets_pending_at_second_fence'] })
    // One that started before the window may have settled in it.
    expect(
      evaluate(withUserWaits(moment(2, 80, { pending: { before: 1, after: 0 } }))).exits
        .barrierWaitUserFacing.windows[0]
    ).toMatchObject({ verdict: 'not_measured', reasons: ['p95_unknown_longest_over_limit'] })
  })

  it('says a class had nothing to wait for rather than passing it', () => {
    const tickets = changeOn().tickets
    const none = changeOn({
      tickets: {
        ...tickets,
        moments: {
          ...tickets.moments,
          user_message: moment(0, 0, { longestWaitMs: { atMost: 0, exact: false } }),
          decision: moment(0, 0, { longestWaitMs: { atMost: 0, exact: false } })
        }
      }
    })
    const result = evaluate(pair((state, index) => (index === 1 ? { change: none } : {})))
    expect(result.exits.barrierWaitUserFacing.windows[0]).toMatchObject({
      verdict: 'not_measured',
      reasons: ['no_tickets_in_window']
    })
    expect(result.exits.barrierWaitUserFacing.verdict).toBe('not_measured')
    expect(result.verdict).toBe('not_measured')
  })

  it('reports the whole-record checkpoints by trigger, off and on, with their main-thread time per turn', () => {
    const exit = evaluate().exits.checkpointsOnMain
    expect(exit.windows.map((row) => `${row.state}:${row.capture}`)).toEqual(
      ORDER.map((name) => `${name.split('-')[0]}:bd-agents-${name}`)
    )
    expect(exit.windows[1]).toMatchObject({
      verdict: 'measured',
      byTrigger: {
        terminal: { count: 36, bytes: 360_000, mainMs: 540 },
        bounded: { count: 2, bytes: 90_000, mainMs: 40 }
      },
      total: { count: 38, bytes: 450_000, mainMs: 580 },
      mainMsPerModelTurn: 14.5,
      syncShare: 0.06
    })
    expect(exit.windows[0].total).toEqual({ count: 38, bytes: 450_000, mainMs: 560 })
    // Only a window the runner kept.
    const ruledOut = evaluate(
      pair((state, index) => (index === 2 ? { reasons: ['rounds_missing'] } : {}))
    )
    expect(ruledOut.exits.checkpointsOnMain.windows[2]).toMatchObject({
      verdict: 'not_measured',
      reasons: ['window_ineligible']
    })
  })

  it('reports the port’s syncs: started, at most in flight, queued, and what each owner had synced', () => {
    const exit = evaluate().exits.portSyncs
    expect(exit.windows.map((row) => row.capture)).toEqual([
      'bd-agents-on-0',
      'bd-agents-on-1',
      'bd-agents-on-2'
    ])
    expect(exit.windows[0]).toMatchObject({
      verdict: 'measured',
      started: 750,
      joined: 12,
      peakInFlight: { atMost: 2, exact: true },
      queued: { before: 0, after: 3 },
      inFlight: { before: 0, after: 1 },
      syncedByOwner: { journal: 380, 'run-events': 290, detail: 50, catalogue: 0, directory: 30 },
      queuedByClass: {
        urgent: { before: 0, after: 0 },
        normal: { before: 0, after: 3 }
      },
      startedUrgent: 30,
      promoted: 4,
      fairStarts: 1,
      barrierRounds: 100,
      syncsOnCallingThread: 0,
      unread: []
    })
    const portless = evaluate(
      pair((state, index) => (index === 1 ? { change: changeOn({ port: null }) } : {}))
    ).exits.portSyncs.windows[0]
    expect(portless).toMatchObject({ verdict: 'not_measured', reasons: ['port_not_reported'] })
    // Queue figures the section gains later are named, not lost.
    const later = evaluate(
      pair((state, index) =>
        index === 1 ? { change: changeOn({ unread: ['port.laterFigure', 'tickets.x'] }) } : {}
      )
    ).exits.portSyncs.windows[0]
    expect(later.unread).toEqual(['port.laterFigure'])
  })

  it('compares main-thread time per model turn off against on, by the median of each', () => {
    const exit = evaluate(
      pair((state, index) =>
        index === 4
          ? { share: { perModelTurn: { ...shareWindow('off').perModelTurn, mainBusyMs: 900 } } }
          : {}
      )
    ).exits.mainBusyMsPerModelTurn
    expect(exit).toMatchObject({
      verdict: 'measured',
      off: { windows: 3, medianMs: 600 },
      on: { windows: 3, medianMs: 300 },
      onOverOff: 0.5
    })
    expect(exit.windows.map((row) => row.value)).toEqual([600, 300, 600, 300, 900, 300])
    expect(exit.windows[1].perModelTurn).toEqual(shareWindow('on').perModelTurn)
    // A pair that is not one compares nothing.
    const unpaired = evaluate(pair().slice(0, 5)).exits.mainBusyMsPerModelTurn
    expect(unpaired).toMatchObject({ verdict: 'not_measured', reasons: ['pair_unqualified'] })
    // A window placed by an estimated clock is left out of the medians.
    const estimated = evaluate(
      pair((state, index) =>
        index === 4 ? { share: { clock: { basis: 'estimated_profile_end' } } } : {}
      )
    ).exits.mainBusyMsPerModelTurn
    expect(estimated.off).toEqual({ windows: 2, medianMs: 600 })
    expect(estimated.windows[4]).toMatchObject({
      verdict: 'not_measured',
      reasons: ['profile_clock_estimated']
    })
    // Nor does one whose windows have no figure per turn on one side.
    const turnless = evaluate(
      pair((state) => (state === 'on' ? { share: { perModelTurn: null } } : {}))
    ).exits.mainBusyMsPerModelTurn
    expect(turnless).toMatchObject({ verdict: 'not_measured', reasons: ['no_figure_per_turn_on'] })
  })

  it('judges nothing without a capture whose switch was on', () => {
    const offOnly = evaluate(pair().filter((_, index) => index % 2 === 0))
    for (const id of JUDGED) {
      expect(offOnly.exits[id]).toMatchObject({
        verdict: 'not_measured',
        reasons: ['no_capture_with_the_switch_on']
      })
    }
    expect(offOnly.verdict).toBe('not_measured')
    // Captures that record no switch state at all, as those from before it existed.
    const unrecorded = pair().map((made) => {
      delete made.report.environment.rolloutFlags.effective[DURABILITY_SWITCH]
      return made
    })
    expect(evaluate(unrecorded).exits.checkpointsOnMain).toMatchObject({
      verdict: 'not_measured',
      reasons: ['no_capture_with_a_known_switch_state'],
      windows: []
    })
  })
})

describe('the command line', () => {
  it('reads each capture and prints a line per exit, or the whole result as JSON', () => {
    const captures = Object.fromEntries(pair().map((made) => [`/captures/${made.id}`, made]))
    const lines: string[] = []
    const code = runDurabilityExitsCli(Object.keys(captures), {
      readCapture: (dir) => captures[dir],
      write: (line) => lines.push(line)
    })
    expect(code).toBe(0)
    expect(lines[0]).toBe('pair qualified (6 captures, many_agents_live)   verdict pass')
    expect(lines.find((line) => line.trim().startsWith('threadStoreSyncs'))).toMatch(
      /threadStoreSyncs\s+pass\s+limit 0\.001\s+bd-agents-on-0: 0\.0003; bd-agents-on-1: 0\.0003; bd-agents-on-2: 0\.0003/
    )
    expect(lines.find((line) => line.trim().startsWith('mainBusyMsPerModelTurn'))).toMatch(
      /mainBusyMsPerModelTurn\s+measured\s+off 600 ms, on 300 ms \(0\.5 of off\)/
    )
    const json: string[] = []
    runDurabilityExitsCli([...Object.keys(captures), '--json'], {
      readCapture: (dir) => captures[dir],
      write: (line) => json.push(line)
    })
    expect(JSON.parse(json[0]).verdict).toBe('pass')
    const usage: string[] = []
    expect(runDurabilityExitsCli([], { write: (line) => usage.push(line) })).toBe(2)
    expect(runDurabilityExitsCli(['--nope', '/x'], { write: (line) => usage.push(line) })).toBe(2)
    expect(usage[0]).toMatch(/^usage: node scripts\/perf\/durabilityExits\.cjs/)
  })
})

describe('per-moment p95 from bounded ticket wait histograms', () => {
  const names = [
    'under1Ms',
    'from1To5Ms',
    'from5To10Ms',
    'from10To20Ms',
    'from20To50Ms',
    'from50To100Ms',
    'from100To250Ms',
    'from250To500Ms',
    'from500To1000Ms',
    'from1000Ms'
  ]
  const histogram = (counts: Dict = {}, extra: Dict = {}) =>
    moment(
      Object.values(counts).reduce((sum: number, value) => sum + Number(value), 0),
      2000,
      {
        waitBuckets: Object.fromEntries(names.map((name) => [name, counts[name] ?? 0])),
        invalidWaits: 0,
        longestWaitMs: { atMost: 2000, exact: false },
        ...extra
      }
    )
  const judged = (moments: Dict) => {
    const changed = changeOn()
    changed.tickets.moments = Object.fromEntries(
      ['user_message', 'decision', 'destructive', 'run_final'].map((name) => [
        name,
        moments[name] ?? histogram()
      ])
    ) as typeof changed.tickets.moments
    return evaluate(pair((_state, index) => (index === 1 ? { change: changed } : {}))).exits
  }

  it('merges user moments and ignores normal-class idle/quit waits when judging run-final tickets', () => {
    const exits = judged({
      user_message: histogram({ under1Ms: 15 }),
      decision: histogram({ from20To50Ms: 4 }),
      destructive: histogram({ from1000Ms: 1 }),
      run_final: histogram({ from100To250Ms: 19, from1000Ms: 1 })
    })
    expect(exits.barrierWaitUserFacing.windows[0]).toMatchObject({
      verdict: 'pass',
      value: null,
      valueIs: 'interval',
      p95Ms: { lowerInclusive: 20, upperExclusive: 50 },
      settledTickets: 20,
      percentileRank: 19
    })
    expect(exits.barrierWaitRunFinal.windows[0]).toMatchObject({
      verdict: 'pass',
      valueIs: 'interval',
      p95Ms: { lowerInclusive: 100, upperExclusive: 250 },
      settledTickets: 20,
      percentileRank: 19
    })
  })

  it.each([
    ['user_message', 'from50To100Ms', 'barrierWaitUserFacing', 50],
    ['run_final', 'from250To500Ms', 'barrierWaitRunFinal', 250]
  ])(
    'fails the exact strict threshold for %s, even when the old maximum did not rise',
    (momentName, bucket, exit, lower) => {
      expect(judged({ [momentName]: histogram({ [bucket]: 1 }) })[exit].windows[0]).toMatchObject({
        verdict: 'fail',
        reasons: ['over_limit'],
        valueIs: 'interval',
        p95Ms: { lowerInclusive: lower },
        percentileRank: 1
      })
    }
  )

  it('uses nearest rank rather than the maximum for twenty samples and a long overflow tail', () => {
    expect(
      judged({ run_final: histogram({ under1Ms: 19, from1000Ms: 1 }) }).barrierWaitRunFinal
        .windows[0]
    ).toMatchObject({ verdict: 'pass', p95Ms: { lowerInclusive: 0, upperExclusive: 1 } })
    expect(
      judged({ run_final: histogram({ under1Ms: 18, from1000Ms: 2 }) }).barrierWaitRunFinal
        .windows[0]
    ).toMatchObject({ verdict: 'fail', p95Ms: { lowerInclusive: 1000, upperExclusive: null } })
  })

  it('rounds a fractional percentile rank upward', () => {
    expect(
      judged({ run_final: histogram({ under1Ms: 19, from1000Ms: 2 }) }).barrierWaitRunFinal
        .windows[0]
    ).toMatchObject({ verdict: 'fail', percentileRank: 20, settledTickets: 21 })
  })

  it.each([
    [{ pending: { before: 1, after: 0 } }, 'tickets_pending_at_first_fence'],
    [{ pending: { before: 0, after: 1 } }, 'tickets_pending_at_second_fence'],
    [{ failed: 1 }, 'failed_tickets_in_window'],
    [{ invalidWaits: 1 }, 'invalid_wait_durations'],
    [{ noted: 2 }, 'wait_histogram_count_mismatch'],
    [{ waitBuckets: { under1Ms: -1 } }, 'wait_histogram_invalid'],
    [{ waitBuckets: null }, 'wait_histogram_missing']
  ])('keeps incomplete or invalid distributions unmeasured: %s', (extra, reason) => {
    const row = judged({
      user_message: histogram({ under1Ms: 1 }, extra),
      decision: histogram({ under1Ms: 1 })
    }).barrierWaitUserFacing.windows[0]
    expect(row).toMatchObject({ verdict: 'not_measured', reasons: [reason] })
  })

  it('does not fall back to a legacy maximum when a new run-final histogram is missing', () => {
    expect(
      judged({ run_final: histogram({ under1Ms: 1 }, { waitBuckets: null }) }).barrierWaitRunFinal
        .windows[0]
    ).toMatchObject({ verdict: 'not_measured', reasons: ['wait_histogram_missing'] })
  })

  it('prints a percentile interval rather than a fabricated point value', () => {
    const changed = changeOn()
    changed.tickets.moments = {
      user_message: histogram({ from20To50Ms: 20 }),
      decision: histogram(),
      destructive: histogram(),
      run_final: histogram({ from100To250Ms: 20 })
    } as typeof changed.tickets.moments
    const captures = Object.fromEntries(
      pair((state) => (state === 'on' ? { change: changed } : {})).map((capture) => [
        capture.id,
        capture
      ])
    )
    const lines: string[] = []
    runDurabilityExitsCli(Object.keys(captures), {
      readCapture: (id) => captures[id],
      write: (line) => lines.push(line)
    })
    expect(lines.find((line) => line.includes('barrierWaitUserFacing'))).toContain('[20, 50) ms')
    expect(lines.find((line) => line.includes('barrierWaitRunFinal'))).toContain('[100, 250) ms')
  })

  it('keeps an empty cohort and an old capture without buckets honest', () => {
    expect(judged({}).barrierWaitUserFacing.windows[0]).toMatchObject({
      verdict: 'not_measured',
      reasons: ['no_tickets_in_window']
    })
    const old = changeOn()
    old.tickets.moments.user_message.longestWaitMs = { atMost: 2000, exact: false }
    expect(
      evaluate(pair((_state, index) => (index === 1 ? { change: old } : {}))).exits
        .barrierWaitUserFacing.windows[0]
    ).toMatchObject({ verdict: 'not_measured', reasons: ['p95_unknown_longest_over_limit'] })
  })
})
