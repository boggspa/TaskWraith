import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { PHASE_EXIT_THRESHOLDS } = require('./perfGateThresholds.cjs')
const {
  collectPhaseExits,
  evaluatePhaseExits,
  phaseExitsForCapture,
  readPhaseBaseline,
  runPhaseExitsCli
} = require('./phaseExits.cjs')

type Dict = Record<string, any>

// One measured window of the default path as it is today: about a quarter of
// the main thread in syncs, another quarter re-reading the thread.
const SHARES_TODAY = {
  idle: 0.0715,
  busy: 0.9285,
  sync: 0.2442,
  wholeThreadRead: 0.2449,
  allJsonRead: 0.2555,
  wholeThreadCopy: 0.1441,
  prepareForSave: 0.0154,
  garbageCollection: 0.0394,
  transcriptHashing: 0.0211,
  flusherBookkeeping: 0
}
const OWNERS_TODAY = {
  toolDetail: 0,
  cataloguePublication: 0.1686,
  journal: 0.0365,
  runEvents: 0.0133,
  runQueue: 0.0135,
  other: 0.0123
}
// A window that meets every limit.
const SHARES_QUIET = {
  ...SHARES_TODAY,
  idle: 0.8,
  busy: 0.2,
  sync: 0.0006,
  wholeThreadRead: 0.0004,
  allJsonRead: 0.003
}
const OWNERS_QUIET = {
  toolDetail: 0,
  cataloguePublication: 0.0001,
  journal: 0.0002,
  runEvents: 0.0001,
  runQueue: 0.0001,
  other: 0.0001
}
const BUILD = { scripts: 55, missingNames: [], classes: {} }
// The exits read from the main-thread shares of a window.
const SHARE_EXITS = [
  'mainThreadSyncs',
  'threadStoreSyncs',
  'mainWholeThreadReads',
  'mainThreadBusy'
]

/** A live-lane window record as the report holds it. */
function laneWindow(overrides: Dict = {}): Dict {
  return {
    role: 'light-beside',
    repetition: 0,
    startedAtMs: 1_000_000,
    endedAtMs: 1_120_000,
    laneSettledAtMs: { light: 1_165_000, heavy: 1_150_000 },
    reasons: [],
    light: {
      rounds: 4,
      roundStartPage: { count: 4, p50Ms: 218, p95Ms: 326, p99Ms: 326, maxMs: 326 }
    },
    d1: { deferredAppends: 370, normalSaves: 723 },
    main: {
      lanes: {
        light: { checkpoint_prepare: { count: 103, bytes: 24_000_000 } },
        heavy: { checkpoint_prepare: { count: 79, bytes: 2_400_000_000 } }
      }
    },
    mainWindow: {
      id: 'light_beside_0',
      startedAtMs: 400_000,
      endedAtMs: 520_000,
      eventLoopLag: { p50Ms: 11, p95Ms: 418, p99Ms: 694, maxMs: 1137, meanMs: 81 }
    },
    mainWindowCensored: false,
    ...overrides
  }
}

/** The same window as the main-thread shares report it. */
function shareWindow(overrides: Dict = {}): Dict {
  return {
    id: 'light_beside_0',
    repetition: 0,
    measured: true,
    clock: { basis: 'markers', uncertaintyMs: 0.9 },
    windowMs: 120_000,
    sampledMs: 120_000,
    shares: SHARES_TODAY,
    syncOwners: OWNERS_TODAY,
    ...overrides
  }
}

function sharesOf(windows: Dict[], build: Dict = BUILD): Dict {
  return { schemaVersion: 1, build, windows }
}

const QUIET_LAG = { p50Ms: 2, p95Ms: 12, p99Ms: 20, maxMs: 40, meanMs: 3 }
const quietLane = (overrides: Dict = {}) =>
  laneWindow({
    mainWindow: { ...laneWindow().mainWindow, eventLoopLag: QUIET_LAG },
    ...overrides
  })
const quietShares = (overrides: Dict = {}) =>
  shareWindow({ shares: SHARES_QUIET, syncOwners: OWNERS_QUIET, ...overrides })

function evaluate(lane: Dict[], share: Dict[], extra: Dict = {}) {
  return evaluatePhaseExits({ windows: lane, shares: sharesOf(share), ...extra })
}
const verdicts = (result: Dict) =>
  Object.fromEntries(
    Object.entries(result.exits).map(([id, exit]: [string, any]) => [id, exit.verdict])
  )
const rowOf = (result: Dict, id: string, index = 0) => result.exits[id].windows[index]

describe('phase exits of a live capture', () => {
  it('fails the default path on every exit it can measure, with the value beside its limit', () => {
    const result = evaluate([laneWindow()], [shareWindow()])
    expect(result.schemaVersion).toBe(1)
    expect(result.thresholds).toEqual(PHASE_EXIT_THRESHOLDS)
    expect(result.exits.mainThreadSyncs).toEqual({
      phase: 1,
      measure: 'share of the window the main thread spent in disk syncs',
      limit: 0.001,
      passes: 'at_most_limit',
      verdict: 'fail',
      reasons: ['window 0: over_limit'],
      windows: [{ repetition: 0, verdict: 'fail', value: 0.2442, reasons: ['over_limit'] }]
    })
    expect(rowOf(result, 'threadStoreSyncs')).toEqual({
      repetition: 0,
      verdict: 'fail',
      // Tool detail, catalogue publication, the journal and run events.
      value: 0.2184,
      reasons: ['over_limit']
    })
    expect(rowOf(result, 'mainWholeThreadReads')).toMatchObject({ verdict: 'fail', value: 0.2449 })
    expect(result.exits.mainThreadBusy).toMatchObject({
      phase: 1,
      limit: 0.25,
      passes: 'under_limit',
      verdict: 'fail'
    })
    expect(rowOf(result, 'mainThreadBusy')).toMatchObject({ verdict: 'fail', value: 0.9285 })
    expect(result.exits.mainLoopDelayP95).toMatchObject({
      phase: 2,
      limit: 25,
      passes: 'under_limit',
      verdict: 'fail',
      reasons: ['window 0: over_limit'],
      windows: [{ repetition: 0, verdict: 'fail', value: 418, reasons: ['over_limit'] }]
    })
    // No baseline was given to compare the heavy thread's bytes with.
    expect(result.baseline).toEqual({ given: false })
    expect(rowOf(result, 'heavyThreadBytes')).toEqual({
      repetition: 0,
      verdict: 'not_measured',
      value: null,
      reasons: ['baseline_not_given'],
      stagedBytes: 2_400_000_000
    })
    expect(result.phases).toEqual({
      phase1: {
        verdict: 'fail',
        failed: ['mainThreadSyncs', 'threadStoreSyncs', 'mainWholeThreadReads', 'mainThreadBusy'],
        notMeasured: ['heavyThreadBytes']
      },
      phase2: { verdict: 'fail', failed: ['mainLoopDelayP95'], notMeasured: [] }
    })
  })

  it('passes a window that meets a limit, and never a phase with an exit it could not measure', () => {
    const result = evaluate([quietLane()], [quietShares()])
    expect(verdicts(result)).toEqual({
      mainThreadSyncs: 'pass',
      threadStoreSyncs: 'pass',
      mainWholeThreadReads: 'pass',
      mainThreadBusy: 'pass',
      heavyThreadBytes: 'not_measured',
      mainLoopDelayP95: 'pass'
    })
    expect(result.exits.mainThreadSyncs).toMatchObject({
      reasons: [],
      windows: [{ repetition: 0, verdict: 'pass', value: 0.0006, reasons: [] }]
    })
    expect(result.phases).toEqual({
      phase1: { verdict: 'not_measured', failed: [], notMeasured: ['heavyThreadBytes'] },
      phase2: { verdict: 'pass', failed: [], notMeasured: [] }
    })
  })

  it('allows a tolerance up to its limit and holds an "under" exit strictly below it', () => {
    const at = (shares: Dict, lagP95Ms: number) =>
      verdicts(
        evaluate(
          [quietLane({ mainWindow: { eventLoopLag: { ...QUIET_LAG, p95Ms: lagP95Ms } } })],
          [quietShares({ shares: { ...SHARES_QUIET, ...shares } })]
        )
      )
    expect(at({ sync: 0.001, wholeThreadRead: 0.001, busy: 0.24999 }, 24.9)).toMatchObject({
      mainThreadSyncs: 'pass',
      mainWholeThreadReads: 'pass',
      mainThreadBusy: 'pass',
      mainLoopDelayP95: 'pass'
    })
    expect(at({ sync: 0.00101, wholeThreadRead: 0.00101, busy: 0.25 }, 25)).toMatchObject({
      mainThreadSyncs: 'fail',
      mainWholeThreadReads: 'fail',
      mainThreadBusy: 'fail',
      mainLoopDelayP95: 'fail'
    })
  })

  it('judges the thread stores on their four owners together, and the rest only in the total', () => {
    // Each owner is under the tolerance; together they are over it.
    const together = evaluate(
      [quietLane()],
      [
        quietShares({
          syncOwners: {
            toolDetail: 0.0002,
            cataloguePublication: 0.0003,
            journal: 0.0003,
            runEvents: 0.0003,
            runQueue: 0,
            other: 0
          }
        })
      ]
    )
    expect(rowOf(together, 'threadStoreSyncs')).toMatchObject({ verdict: 'fail', value: 0.0011 })
    // The run queue and unlisted callers fail the total, not the thread stores.
    const elsewhere = evaluate(
      [quietLane()],
      [
        quietShares({
          shares: { ...SHARES_QUIET, sync: 0.02 },
          syncOwners: { ...OWNERS_QUIET, runQueue: 0.01, other: 0.0095 }
        })
      ]
    )
    expect(rowOf(elsewhere, 'threadStoreSyncs')).toMatchObject({ verdict: 'pass', value: 0.0004 })
    expect(rowOf(elsewhere, 'mainThreadSyncs')).toMatchObject({ verdict: 'fail', value: 0.02 })
  })

  it('takes a custom set of thresholds', () => {
    const result = evaluate([laneWindow()], [shareWindow()], {
      thresholds: { ...PHASE_EXIT_THRESHOLDS, maxMainBusyShare: 0.95, maxMainLoopDelayP95Ms: 500 }
    })
    expect(result.thresholds.maxMainBusyShare).toBe(0.95)
    expect(verdicts(result)).toMatchObject({ mainThreadBusy: 'pass', mainLoopDelayP95: 'pass' })
  })
})

describe('an exit that cannot be computed is not measured, never passed', () => {
  it('does not judge a window the lanes ruled out, whatever its figures', () => {
    const result = evaluate(
      [quietLane({ reasons: ['heavy_lane_idle'] }), laneWindow({ repetition: 1, reasons: ['x'] })],
      [quietShares(), shareWindow({ repetition: 1 })]
    )
    for (const exit of Object.values(result.exits) as Dict[]) {
      expect(exit.verdict).toBe('not_measured')
      expect(exit.reasons).toEqual(['window 0: window_ineligible', 'window 1: window_ineligible'])
      expect(exit.windows.map((row: Dict) => row.verdict)).toEqual(['not_measured', 'not_measured'])
    }
    expect(result.windows[0]).toMatchObject({ eligible: false, reasons: ['heavy_lane_idle'] })
  })

  it('does not judge a window whose reasons the report lost', () => {
    const result = evaluate([quietLane({ reasons: undefined })], [quietShares()])
    expect(rowOf(result, 'mainThreadBusy')).toMatchObject({
      verdict: 'not_measured',
      reasons: ['window_ineligible']
    })
    expect(result.windows[0]).toMatchObject({ eligible: false, reasons: ['reasons_absent'] })
  })

  it('reports no measured window when the lanes ran none', () => {
    const result = evaluate([], [])
    for (const exit of Object.values(result.exits) as Dict[]) {
      expect(exit).toMatchObject({
        verdict: 'not_measured',
        reasons: ['no_measured_window'],
        windows: []
      })
    }
    expect(result.phases.phase1.verdict).toBe('not_measured')
    expect(result.phases.phase2).toEqual({
      verdict: 'not_measured',
      failed: [],
      notMeasured: ['mainLoopDelayP95']
    })
    expect(
      evaluatePhaseExits({ windows: undefined, shares: undefined }).exits.mainThreadBusy
    ).toMatchObject({ verdict: 'not_measured', reasons: ['no_measured_window'] })
    // A window with no shares result at all.
    expect(
      rowOf(evaluatePhaseExits({ windows: [quietLane()], shares: undefined }), 'mainThreadBusy')
    ).toMatchObject({ verdict: 'not_measured', reasons: ['shares_absent_for_window'] })
    // A window record that is not one is ruled out, not walked.
    const hollow = evaluatePhaseExits({ windows: [null], shares: sharesOf([]) })
    expect(hollow.windows[0]).toMatchObject({
      repetition: null,
      eligible: false,
      reasons: ['reasons_absent']
    })
    expect(hollow.exits.mainThreadBusy.reasons).toEqual(['window null: window_ineligible'])
  })

  it('carries the reason a window has no shares, and still judges what needs none', () => {
    const unmeasured = {
      id: 'light_beside_0',
      repetition: 0,
      measured: false,
      reason: 'profile_calibration_unqualified:marker_count'
    }
    const result = evaluate([quietLane()], [unmeasured])
    for (const id of SHARE_EXITS) {
      expect(rowOf(result, id)).toEqual({
        repetition: 0,
        verdict: 'not_measured',
        value: null,
        reasons: ['profile_calibration_unqualified:marker_count']
      })
    }
    expect(rowOf(result, 'mainLoopDelayP95')).toMatchObject({ verdict: 'pass', value: 12 })
  })

  it('does not take another window’s shares for a window that has none', () => {
    const missing = evaluate([quietLane({ repetition: 1 })], [])
    expect(rowOf(missing, 'mainThreadBusy')).toMatchObject({
      verdict: 'not_measured',
      value: null,
      reasons: ['shares_absent_for_window']
    })
    const misplaced = evaluate([quietLane({ repetition: 1 })], [quietShares({ repetition: 0 })])
    expect(rowOf(misplaced, 'mainThreadSyncs')).toMatchObject({
      verdict: 'not_measured',
      reasons: ['shares_absent_for_window']
    })
  })

  it('does not pass an absence the build no longer vouches for', () => {
    // The function a share matches left the build: the share is null.
    const renamed = evaluate(
      [quietLane()],
      [quietShares({ shares: { ...SHARES_QUIET, wholeThreadRead: null }, syncOwners: null })]
    )
    expect(rowOf(renamed, 'mainWholeThreadReads')).toEqual({
      repetition: 0,
      verdict: 'not_measured',
      value: null,
      reasons: ['function_not_in_build']
    })
    expect(rowOf(renamed, 'threadStoreSyncs')).toMatchObject({
      verdict: 'not_measured',
      value: null,
      reasons: ['function_not_in_build']
    })
    // The runtime's own frames need no build to be recognised.
    expect(verdicts(renamed)).toMatchObject({ mainThreadSyncs: 'pass', mainThreadBusy: 'pass' })
    // A share the window does not hold at all is no figure either.
    const sparse = evaluate([quietLane()], [quietShares({ shares: { sync: 0.0006 } })])
    expect(verdicts(sparse)).toMatchObject({
      mainThreadSyncs: 'pass',
      mainWholeThreadReads: 'not_measured',
      mainThreadBusy: 'not_measured'
    })
    expect(rowOf(sparse, 'mainThreadBusy')).toMatchObject({ value: null })
    // An owner without a figure leaves the four unsummed, not a sum of the rest.
    const partial = evaluate(
      [quietLane()],
      [quietShares({ syncOwners: { toolDetail: 0, cataloguePublication: 0.5 } })]
    )
    expect(rowOf(partial, 'threadStoreSyncs')).toMatchObject({
      verdict: 'not_measured',
      value: null
    })
  })

  it('does not pass an absence when the build could not be read, but still fails a presence', () => {
    const unread = { scripts: 0, unavailable: 'build_scripts_unreadable' }
    const quiet = evaluatePhaseExits({
      windows: [quietLane()],
      shares: sharesOf([quietShares()], unread)
    })
    expect(rowOf(quiet, 'mainWholeThreadReads')).toEqual({
      repetition: 0,
      verdict: 'not_measured',
      value: 0.0004,
      reasons: ['build_names_unverified']
    })
    expect(rowOf(quiet, 'threadStoreSyncs')).toMatchObject({
      verdict: 'not_measured',
      value: 0.0004,
      reasons: ['build_names_unverified']
    })
    expect(verdicts(quiet)).toMatchObject({ mainThreadSyncs: 'pass', mainThreadBusy: 'pass' })
    const busy = evaluatePhaseExits({
      windows: [laneWindow()],
      shares: sharesOf([shareWindow()], unread)
    })
    expect(verdicts(busy)).toMatchObject({
      mainWholeThreadReads: 'fail',
      threadStoreSyncs: 'fail'
    })
    // A shares result without a build block vouches for nothing either.
    const { build: _build, ...noBuild } = sharesOf([quietShares()])
    expect(
      rowOf(evaluatePhaseExits({ windows: [quietLane()], shares: noBuild }), 'mainWholeThreadReads')
    ).toMatchObject({ verdict: 'not_measured', reasons: ['build_names_unverified'] })
  })

  it('does not judge the loop delay of a window main did not time', () => {
    const result = evaluate(
      [quietLane({ mainWindow: null })],
      [{ id: null, repetition: 0, measured: false, reason: 'main_window_receipt_absent' }]
    )
    expect(rowOf(result, 'mainLoopDelayP95')).toEqual({
      repetition: 0,
      verdict: 'not_measured',
      value: null,
      reasons: ['main_loop_delay_not_recorded']
    })
    expect(rowOf(result, 'mainThreadBusy').reasons).toEqual(['main_window_receipt_absent'])
    expect(result.windows[0].mainLoopDelay).toBeNull()
  })
})

describe('a window placed by an estimated clock', () => {
  const estimated = (overrides: Dict = {}) =>
    shareWindow({
      clock: { basis: 'estimated_profile_end', assumedLagMs: 500, lagBoundsMs: [0, 3000] },
      shareBounds: {
        ...Object.fromEntries(Object.keys(SHARES_TODAY).map((name) => [name, [0, 1]])),
        sync: [0.2297, 0.245],
        wholeThreadRead: [0.2375, 0.245],
        busy: [0.9285, 0.9325]
      },
      syncOwnerBounds: {
        toolDetail: [0, 0],
        cataloguePublication: [0.15, 0.16],
        journal: [0.03, 0.04],
        runEvents: [0.01, 0.02],
        runQueue: [0.01, 0.02],
        other: [0.01, 0.02]
      },
      ...overrides
    })

  it('fails an exit that is over its limit wherever the estimate could place the window', () => {
    const result = evaluate([laneWindow()], [estimated()])
    expect(rowOf(result, 'mainThreadSyncs')).toEqual({
      repetition: 0,
      verdict: 'fail',
      value: 0.2442,
      reasons: ['over_limit'],
      bounds: [0.2297, 0.245]
    })
    // The least each of the four owners could be, together.
    expect(rowOf(result, 'threadStoreSyncs')).toMatchObject({
      verdict: 'fail',
      value: 0.2184,
      bounds: [0.19, 0.22]
    })
    expect(rowOf(result, 'mainWholeThreadReads')).toMatchObject({
      verdict: 'fail',
      bounds: [0.2375, 0.245]
    })
    expect(rowOf(result, 'mainThreadBusy')).toMatchObject({
      verdict: 'fail',
      bounds: [0.9285, 0.9325]
    })
    expect(result.windows[0].clock).toBe('estimated_profile_end')
  })

  it('never passes on an estimate, and does not fail unless every placement does', () => {
    const quiet = evaluate(
      [quietLane()],
      [
        estimated({
          shares: SHARES_QUIET,
          syncOwners: OWNERS_QUIET,
          shareBounds: {
            sync: [0.0005, 0.0007],
            wholeThreadRead: [0.0003, 0.0005],
            busy: [0.19, 0.21]
          },
          syncOwnerBounds: Object.fromEntries(
            Object.keys(OWNERS_QUIET).map((name) => [name, [0, 0.0001]])
          )
        })
      ]
    )
    for (const id of SHARE_EXITS) {
      expect(rowOf(quiet, id)).toMatchObject({
        verdict: 'not_measured',
        reasons: ['profile_clock_estimated']
      })
    }
    // Over the limit where the estimate puts it, under it at one end of the bounds.
    const straddling = evaluate(
      [laneWindow()],
      [
        estimated({
          shareBounds: {
            sync: [0.0009, 0.3],
            wholeThreadRead: [0.001, 0.3],
            busy: [0.2, 0.95]
          },
          syncOwnerBounds: Object.fromEntries(
            Object.keys(OWNERS_TODAY).map((name) => [name, [0.0002, 0.2]])
          )
        })
      ]
    )
    for (const id of SHARE_EXITS) {
      expect(rowOf(straddling, id)).toMatchObject({
        verdict: 'not_measured',
        reasons: ['profile_clock_estimated']
      })
    }
    // The loop delay comes from main's own receipt, not from the profile.
    expect(rowOf(straddling, 'mainLoopDelayP95').verdict).toBe('fail')
  })

  it('does not fail an estimated window whose bounds it was not given', () => {
    const result = evaluate(
      [laneWindow()],
      [estimated({ shareBounds: undefined, syncOwnerBounds: null })]
    )
    for (const id of SHARE_EXITS) {
      expect(rowOf(result, id)).toMatchObject({
        verdict: 'not_measured',
        reasons: ['profile_clock_estimated']
      })
      expect(rowOf(result, id)).not.toHaveProperty('bounds')
    }
    // Nor one whose bounds are not a pair of numbers.
    const malformed = evaluate(
      [laneWindow()],
      [
        estimated({
          shareBounds: { sync: [], wholeThreadRead: [0.5], busy: ['a', 'b'] },
          syncOwnerBounds: {
            toolDetail: [0.5, 0.6],
            cataloguePublication: null,
            journal: [0.5, 0.6],
            runEvents: [0.5, 0.6]
          }
        })
      ]
    )
    for (const id of SHARE_EXITS) {
      expect(rowOf(malformed, id)).toMatchObject({
        verdict: 'not_measured',
        reasons: ['profile_clock_estimated']
      })
      expect(rowOf(malformed, id)).not.toHaveProperty('bounds')
    }
  })
})

describe('a window placed within loose markers', () => {
  /** A window measured at these shares and owners, each the same at both ends unless bounded. */
  const loose = (shares: Dict, owners: Dict, shareBounds: Dict = {}, ownerBounds: Dict = {}) =>
    shareWindow({
      clock: { basis: 'loose_markers', uncertaintyMs: 1.4, markerUncertaintyMs: [2.6, 2.8] },
      shares,
      syncOwners: owners,
      shareBounds: {
        ...Object.fromEntries(
          Object.entries(shares).map(([name, value]) => [name, [value, value]])
        ),
        ...shareBounds
      },
      syncOwnerBounds: {
        ...Object.fromEntries(
          Object.entries(owners).map(([name, value]) => [name, [value, value]])
        ),
        ...ownerBounds
      }
    })
  // Under every limit wherever the markers allow the window to be placed.
  const quietLoose = () =>
    loose(
      SHARES_QUIET,
      OWNERS_QUIET,
      { sync: [0.0005, 0.0007], wholeThreadRead: [0.0003, 0.0005], busy: [0.19, 0.21] },
      { journal: [0.0001, 0.0003] }
    )
  const unread = { scripts: 0, unavailable: 'build_scripts_unreadable' }

  it('fails an exit only where every placement fails, and names the bounds', () => {
    const result = evaluate(
      [laneWindow()],
      [
        loose(SHARES_TODAY, OWNERS_TODAY, {
          sync: [0.2441, 0.2443],
          wholeThreadRead: [0.2448, 0.245],
          busy: [0.9284, 0.9286]
        })
      ]
    )
    expect(rowOf(result, 'mainThreadSyncs')).toEqual({
      repetition: 0,
      verdict: 'fail',
      value: 0.2442,
      reasons: ['over_limit'],
      bounds: [0.2441, 0.2443]
    })
    expect(rowOf(result, 'threadStoreSyncs')).toMatchObject({
      verdict: 'fail',
      value: 0.2184,
      bounds: [0.2184, 0.2184]
    })
    expect(rowOf(result, 'mainWholeThreadReads')).toMatchObject({ verdict: 'fail' })
    expect(rowOf(result, 'mainThreadBusy')).toMatchObject({ verdict: 'fail' })
    expect(result.windows[0].clock).toBe('loose_markers')
  })

  it('passes an exit only where every placement passes', () => {
    const quiet = evaluate([quietLane()], [quietLoose()])
    for (const id of SHARE_EXITS) expect(rowOf(quiet, id).verdict).toBe('pass')
    expect(rowOf(quiet, 'mainThreadSyncs')).toEqual({
      repetition: 0,
      verdict: 'pass',
      value: 0.0006,
      reasons: [],
      bounds: [0.0005, 0.0007]
    })
    // The four thread stores at their least together, and at their most.
    expect(rowOf(quiet, 'threadStoreSyncs')).toMatchObject({
      value: 0.0004,
      bounds: [0.0003, 0.0005]
    })
    expect(verdicts(quiet)).toMatchObject({ mainThreadSyncs: 'pass', mainThreadBusy: 'pass' })
  })

  it('cannot settle an exit whose limit lies inside the bounds', () => {
    // At each limit where it was measured, and over it at one end of the bounds.
    const straddling = evaluate(
      [quietLane()],
      [
        loose(
          { ...SHARES_QUIET, sync: 0.001, wholeThreadRead: 0.001, busy: 0.25 },
          { ...OWNERS_QUIET, journal: 0.0008 },
          { sync: [0.0009, 0.0011], wholeThreadRead: [0.0009, 0.0011], busy: [0.2499, 0.2501] },
          { journal: [0.0007, 0.0009] }
        )
      ]
    )
    for (const id of SHARE_EXITS) {
      expect(rowOf(straddling, id)).toMatchObject({
        verdict: 'not_measured',
        reasons: ['profile_clock_loose']
      })
      expect(rowOf(straddling, id)).toHaveProperty('bounds')
    }
    // Bounds it was not given cannot settle anything either.
    const unbounded = evaluate(
      [quietLane()],
      [{ ...quietLoose(), shareBounds: undefined, syncOwnerBounds: null }]
    )
    for (const id of SHARE_EXITS) {
      expect(rowOf(unbounded, id)).toMatchObject({
        verdict: 'not_measured',
        reasons: ['profile_clock_loose']
      })
      expect(rowOf(unbounded, id)).not.toHaveProperty('bounds')
    }
  })

  it('still needs a build that vouches for the names before it passes an absence', () => {
    const quiet = evaluatePhaseExits({
      windows: [quietLane()],
      shares: sharesOf([quietLoose()], unread)
    })
    expect(rowOf(quiet, 'mainWholeThreadReads')).toEqual({
      repetition: 0,
      verdict: 'not_measured',
      value: 0.0004,
      reasons: ['build_names_unverified'],
      bounds: [0.0003, 0.0005]
    })
    expect(rowOf(quiet, 'threadStoreSyncs')).toMatchObject({
      verdict: 'not_measured',
      reasons: ['build_names_unverified']
    })
    expect(verdicts(quiet)).toMatchObject({ mainThreadSyncs: 'pass', mainThreadBusy: 'pass' })
    // A presence fails all the same.
    const busy = evaluatePhaseExits({
      windows: [laneWindow()],
      shares: sharesOf([loose(SHARES_TODAY, OWNERS_TODAY)], unread)
    })
    expect(verdicts(busy)).toMatchObject({
      mainWholeThreadReads: 'fail',
      threadStoreSyncs: 'fail'
    })
  })
})

describe('bytes written for the heavy thread against a baseline', () => {
  const baseline = {
    given: true,
    usable: true,
    reports: 1,
    windows: 1,
    heavyThreadBytesPerSecond: 20_000_000
  }

  it('fails when the whole-thread bytes staged alone reach the limit', () => {
    // 2.4 GB in 120 s is the baseline's own rate.
    const same = evaluate([laneWindow()], [shareWindow()], { baseline })
    expect(same.baseline).toEqual(baseline)
    expect(same.exits.heavyThreadBytes).toMatchObject({
      phase: 1,
      limit: 0.01,
      passes: 'under_limit',
      verdict: 'fail',
      reasons: ['window 0: over_limit']
    })
    expect(rowOf(same, 'heavyThreadBytes')).toEqual({
      repetition: 0,
      verdict: 'fail',
      value: 1,
      reasons: ['over_limit'],
      stagedBytes: 2_400_000_000
    })
    // The same bytes over a window twice as long are half the rate.
    const longer = evaluate([laneWindow({ endedAtMs: 1_240_000 })], [shareWindow()], { baseline })
    expect(rowOf(longer, 'heavyThreadBytes')).toMatchObject({ verdict: 'fail', value: 0.5 })
    // Exactly 1% is not under 1%.
    const atLimit = evaluate([laneWindow({ main: staged(24_000_000) })], [shareWindow()], {
      baseline
    })
    expect(rowOf(atLimit, 'heavyThreadBytes')).toMatchObject({ verdict: 'fail', value: 0.01 })
  })

  it('does not pass on staged bytes alone: the other files it wrote are not counted', () => {
    const result = evaluate([laneWindow({ main: staged(12_000_000) })], [shareWindow()], {
      baseline
    })
    expect(rowOf(result, 'heavyThreadBytes')).toEqual({
      repetition: 0,
      verdict: 'not_measured',
      value: 0.005,
      reasons: ['bytes_by_file_family_not_counted'],
      stagedBytes: 12_000_000
    })
    // No staging span in the window is zero bytes staged, not an unknown.
    const none = evaluate(
      [laneWindow({ main: { lanes: { light: {}, heavy: {} } } })],
      [shareWindow()],
      { baseline }
    )
    expect(rowOf(none, 'heavyThreadBytes')).toMatchObject({
      verdict: 'not_measured',
      value: 0,
      reasons: ['bytes_by_file_family_not_counted'],
      stagedBytes: 0
    })
  })

  it('says why when the window or the baseline holds no figure', () => {
    const noSpans = evaluate([laneWindow({ main: null })], [shareWindow()], { baseline })
    expect(rowOf(noSpans, 'heavyThreadBytes')).toEqual({
      repetition: 0,
      verdict: 'not_measured',
      value: null,
      reasons: ['bytes_staged_not_recorded'],
      stagedBytes: null
    })
    expect(noSpans.windows[0].bytesStaged).toBeNull()
    // A span whose bytes are not a number, or a window without its times.
    const garbled = evaluate(
      [
        laneWindow({
          main: { lanes: { light: {}, heavy: { checkpoint_prepare: { bytes: 'many' } } } }
        })
      ],
      [shareWindow()],
      { baseline }
    )
    expect(rowOf(garbled, 'heavyThreadBytes')).toMatchObject({
      verdict: 'not_measured',
      reasons: ['bytes_staged_not_recorded'],
      stagedBytes: null
    })
    expect(garbled.windows[0].bytesStaged).toEqual({ light: 0, heavy: null })
    const untimed = evaluate([laneWindow({ endedAtMs: undefined })], [shareWindow()], { baseline })
    expect(rowOf(untimed, 'heavyThreadBytes')).toMatchObject({
      verdict: 'not_measured',
      value: null,
      reasons: ['bytes_staged_not_recorded']
    })
    const backwards = evaluate([laneWindow({ endedAtMs: 999_000 })], [shareWindow()], { baseline })
    expect(rowOf(backwards, 'heavyThreadBytes').reasons).toEqual(['bytes_staged_not_recorded'])
    const unusable = { given: true, usable: false, reason: 'baseline_has_no_eligible_window' }
    const result = evaluate([laneWindow()], [shareWindow()], { baseline: unusable })
    expect(result.baseline).toEqual(unusable)
    expect(rowOf(result, 'heavyThreadBytes')).toMatchObject({
      verdict: 'not_measured',
      value: null,
      reasons: ['baseline_has_no_eligible_window']
    })
  })

  function staged(heavyBytes: number) {
    return {
      lanes: { light: {}, heavy: { checkpoint_prepare: { count: 1, bytes: heavyBytes } } }
    }
  }
})

describe('several windows', () => {
  it('fails an exit one window fails, and names each window that did not pass', () => {
    const result = evaluate(
      [quietLane(), laneWindow({ repetition: 1 }), quietLane({ repetition: 2, reasons: ['x'] })],
      [quietShares(), shareWindow({ repetition: 1 }), quietShares({ repetition: 2 })]
    )
    expect(result.exits.mainThreadBusy).toMatchObject({
      verdict: 'fail',
      reasons: ['window 1: over_limit', 'window 2: window_ineligible']
    })
    expect(result.exits.mainThreadBusy.windows.map((row: Dict) => row.verdict)).toEqual([
      'pass',
      'fail',
      'not_measured'
    ])
  })

  it('does not pass an exit while one of its windows is not measured', () => {
    const result = evaluate(
      [quietLane(), quietLane({ repetition: 1, reasons: ['light_rounds_missing'] })],
      [quietShares(), quietShares({ repetition: 1 })]
    )
    expect(result.exits.mainThreadBusy).toMatchObject({
      verdict: 'not_measured',
      reasons: ['window 1: window_ineligible']
    })
    expect(result.phases.phase2).toEqual({
      verdict: 'not_measured',
      failed: [],
      notMeasured: ['mainLoopDelayP95']
    })
  })
})

describe('what each window is read against', () => {
  it('carries the loop delay, saves, bytes staged and light round start beside the exits', () => {
    const [window] = evaluate([laneWindow()], [shareWindow()]).windows
    expect(window).toEqual({
      repetition: 0,
      eligible: true,
      reasons: [],
      clock: 'markers',
      mainLoopDelay: { p50Ms: 11, p95Ms: 418, p99Ms: 694, maxMs: 1137 },
      // Counted from the window's start until the last lane settled.
      saves: { deferredAppends: 370, normalSaves: 723, countedForMs: 165_000 },
      bytesStaged: { light: 24_000_000, heavy: 2_400_000_000 },
      lightRoundStart: { count: 4, p50Ms: 218, p95Ms: 326 }
    })
  })

  it('leaves out what a window did not record', () => {
    const [window] = evaluate(
      [
        laneWindow({
          d1: null,
          light: { rounds: 0, roundStartPage: null },
          laneSettledAtMs: { light: null, heavy: 1_150_000 }
        })
      ],
      [{ repetition: 0, measured: false, reason: 'profile_unreadable:malformed' }]
    ).windows
    expect(window).toMatchObject({ clock: null, saves: null, lightRoundStart: null })
    const [settled] = evaluate(
      [laneWindow({ laneSettledAtMs: { light: null, heavy: 1_150_000 } })],
      [shareWindow()]
    ).windows
    expect(settled.saves).toEqual({ deferredAppends: 370, normalSaves: 723, countedForMs: 150_000 })
    for (const laneSettledAtMs of [undefined, { light: null, heavy: null }]) {
      const [unsettled] = evaluate([laneWindow({ laneSettledAtMs })], [shareWindow()]).windows
      expect(unsettled.saves).toEqual({
        deferredAppends: 370,
        normalSaves: 723,
        countedForMs: null
      })
    }
  })
})

describe('the baseline’s figure', () => {
  const report = (windows: Dict[], workload = 'light_beside_large_live') => ({
    environment: { workload },
    liveRounds: { lanes: { windows } }
  })

  it('is the heavy thread’s staged bytes per second over the baseline’s eligible windows', () => {
    const baseline = readPhaseBaseline(
      [
        report([
          laneWindow(),
          // Twice as long, a third of the rate.
          laneWindow({ repetition: 1, endedAtMs: 1_240_000, main: staged(1_600_000_000) }),
          laneWindow({ repetition: 2, reasons: ['heavy_lane_idle'], main: staged(9e12) })
        ]),
        report([laneWindow({ main: staged(800_000_000) })])
      ],
      { workload: 'light_beside_large_live' }
    )
    // 4.8 GB over 480 s.
    expect(baseline).toEqual({
      given: true,
      usable: true,
      reports: 2,
      windows: 3,
      heavyThreadBytesPerSecond: 10_000_000
    })
  })

  it('is not given without a baseline report', () => {
    expect(readPhaseBaseline([], { workload: 'w' })).toEqual({ given: false })
    expect(readPhaseBaseline(undefined, {})).toEqual({ given: false })
  })

  it('is unusable, with the reason, when a report cannot serve as one', () => {
    const unusable = (reports: unknown[], workload = 'light_beside_large_live') =>
      readPhaseBaseline(reports, { workload })
    expect(unusable([null])).toEqual({
      given: true,
      usable: false,
      reason: 'baseline_report_unreadable'
    })
    expect(unusable([report([laneWindow()]), 'text'])).toMatchObject({
      usable: false,
      reason: 'baseline_report_unreadable'
    })
    expect(unusable([report([laneWindow()], 'another_workload')])).toMatchObject({
      usable: false,
      reason: 'baseline_workload_differs'
    })
    expect(unusable([report([laneWindow({ reasons: ['x'] })])])).toMatchObject({
      usable: false,
      reason: 'baseline_has_no_eligible_window'
    })
    expect(unusable([{ environment: { workload: 'light_beside_large_live' } }])).toMatchObject({
      usable: false,
      reason: 'baseline_has_no_eligible_window'
    })
    expect(unusable([report([laneWindow({ main: null })])])).toMatchObject({
      usable: false,
      reason: 'baseline_has_no_eligible_window'
    })
    expect(unusable([report([laneWindow({ main: staged(0) })])])).toMatchObject({
      usable: false,
      reason: 'baseline_staged_no_bytes'
    })
    // Reports of other shapes: no environment, lanes that never ran, a window lost.
    expect(unusable([{}])).toMatchObject({ usable: false, reason: 'baseline_workload_differs' })
    for (const lanes of [null, {}, { windows: [null] }]) {
      expect(
        unusable([{ environment: { workload: 'light_beside_large_live' }, liveRounds: { lanes } }])
      ).toMatchObject({ usable: false, reason: 'baseline_has_no_eligible_window' })
    }
  })

  function staged(heavyBytes: number) {
    return {
      lanes: { light: {}, heavy: { checkpoint_prepare: { count: 1, bytes: heavyBytes } } }
    }
  }
})

// A capture on a fake disk: a 150 ms profile whose window is 30..130 ms, with
// 20 ms of syncs and 30 ms idle inside it.
const BUNDLE_URL = 'file:///build/out/main/index-AbCd1234.js'
const frame = (functionName: string, url = BUNDLE_URL) => ({
  functionName,
  url,
  lineNumber: 50,
  columnNumber: 0
})
function captureProfile() {
  const nodes = [
    { id: 1, callFrame: frame('(root)', ''), children: [2, 3, 4, 5, 8] },
    { id: 2, callFrame: frame('start', 'taskwraith-calibration-start.js') },
    { id: 3, callFrame: frame('end', 'taskwraith-calibration-end.js') },
    { id: 4, callFrame: frame('(idle)', '') },
    { id: 5, callFrame: frame('appendRunEvent'), children: [6] },
    { id: 6, callFrame: frame('fsyncSync', 'node:fs'), children: [7] },
    { id: 7, callFrame: frame('fsync', '') },
    { id: 8, callFrame: frame('streamTurn') }
  ]
  // Sample ends, ms into the profile: 11, 17 (start marker), 30, 60 (idle),
  // 80 (sync), 130 (busy), 141, 147 (end marker).
  return {
    nodes,
    samples: [2, 2, 4, 4, 7, 8, 3, 3],
    timeDeltas: [11_000, 6_000, 13_000, 30_000, 20_000, 50_000, 11_000, 6_000],
    startTime: 1_000_000,
    endTime: 1_150_000
  }
}
const captureMarker = (tag: string, beforeMs: number, afterMs: number) => ({
  tag,
  beforeMs,
  afterMs,
  pid: 42,
  timeOrigin: 5000,
  identity: 'main:42:performance.timeOrigin:5000',
  clockId: 'node.performance.now',
  windowId: 'light_beside_0',
  source: `source of ${tag}`,
  sourceSha256: require('node:crypto').createHash('sha256').update(`source of ${tag}`).digest('hex')
})
const CAPTURE_MARKERS = [captureMarker('start', 10, 18), captureMarker('end', 140, 148)]
const BUNDLE_TEXT = [
  'function readJson(file) {}',
  'function getChat(id) { return readChatRecordCached(id) }',
  'function publishHostThreadRecordTransferOffLoop(input) { canCloneRecord(input) }',
  'function prepareChatForPersistence(input) { persistDetailCheckpoint(input) }',
  'function saveChat(chat) { beginPublication(chat); finishPublication(chat); settleBurst(chat) }',
  'function persistIncrementalChatForHostSave(chat) { appendRunEvent(chat); writeRunQueueJobs(chat) }',
  'const checkpointChat = (chatId) => computeChatSubRevisions(chatId)',
  'function recordUsage(entry) { commitUnderFence(entry); acquireInstanceFence(entry) }',
  'function releaseInstanceFence(fence) { persistOrThrow(fence); rememberChatRecord(fence) }',
  'function assertSourceMutationAllowed(id) { assertRecoveryHoldAllows(id) }',
  'function captureThreadCatalogueWitness(id) { getCurrentChatAuthorityMetadata(id) }'
].join('\n')
function captureReport(windowOverrides: Dict = {}) {
  return {
    environment: { workload: 'light_beside_large_live' },
    liveRounds: {
      lanes: {
        windows: [
          laneWindow({
            mainWindow: {
              id: 'light_beside_0',
              startedAtMs: 30,
              endedAtMs: 130,
              clock: {
                clockId: 'node.performance.now',
                identity: 'main:42:performance.timeOrigin:5000',
                provenance: 'node-performance-now'
              },
              eventLoopLag: { p50Ms: 11, p95Ms: 418, p99Ms: 694, maxMs: 1137, meanMs: 81 }
            },
            ...windowOverrides
          })
        ]
      }
    }
  }
}
function fakeFs(files: Record<string, string>) {
  const reads: string[] = []
  return {
    reads,
    readFileSync(file: string) {
      reads.push(file)
      if (files[file] === undefined)
        throw Object.assign(new Error(`ENOENT: ${file}`), { code: 'ENOENT' })
      return files[file]
    },
    readdirSync(directory: string) {
      const names = Object.keys(files)
        .filter(
          (file) =>
            file.startsWith(`${directory}/`) && !file.slice(directory.length + 1).includes('/')
        )
        .map((file) => file.slice(directory.length + 1))
      if (names.length === 0)
        throw Object.assign(new Error(`ENOENT: ${directory}`), { code: 'ENOENT' })
      return names
    }
  }
}
const BASELINE_REPORT = JSON.stringify({
  environment: { workload: 'light_beside_large_live' },
  liveRounds: { lanes: { windows: [laneWindow()] } }
})

describe('the runner’s section for a capture it just took', () => {
  const files = () => ({
    '/artifacts/profiles/main.cpuprofile': JSON.stringify(captureProfile()),
    '/build/out/main/index-AbCd1234.js': BUNDLE_TEXT,
    '/baselines/off.json': BASELINE_REPORT
  })

  it('measures the shares from the profile and the markers in hand, then judges the exits', () => {
    const fs = fakeFs(files())
    const { mainThreadShares, phaseExits } = collectPhaseExits({
      report: captureReport(),
      profilePath: '/artifacts/profiles/main.cpuprofile',
      calibrationMarkers: CAPTURE_MARKERS,
      // The model's turns as the runner read them: two begun in the window.
      modelTurns: [
        {
          model: 'scripted-llama:latest',
          startedAtMs: 1_000_000,
          endedAtMs: 1_001_600,
          outcome: 'done'
        },
        {
          model: 'scripted-llama:heavy',
          startedAtMs: 1_119_999,
          endedAtMs: null,
          outcome: 'streaming'
        },
        {
          model: 'scripted-llama:heavy',
          startedAtMs: 1_120_000,
          endedAtMs: null,
          outcome: 'streaming'
        }
      ],
      baselineReportPaths: ['/baselines/off.json'],
      fsApi: fs
    })
    expect(mainThreadShares.modelTurns).toEqual({
      counted: 'began_streaming_in_the_runner_window',
      from: 'daemon_read'
    })
    expect(mainThreadShares.windows[0]).toMatchObject({
      modelTurns: 2,
      perModelTurn: { mainBusyMs: 35, syncMs: 10 }
    })
    expect(mainThreadShares.windows[0]).toMatchObject({
      id: 'light_beside_0',
      measured: true,
      clock: { basis: 'markers' },
      shares: { idle: 0.3, busy: 0.7, sync: 0.2, wholeThreadRead: 0 },
      syncOwners: { runEvents: 0.2 }
    })
    expect(mainThreadShares.build).toMatchObject({ scripts: 1, missingNames: [] })
    expect(phaseExits.workload).toBe('light_beside_large_live')
    expect(verdicts(phaseExits)).toEqual({
      mainThreadSyncs: 'fail',
      threadStoreSyncs: 'fail',
      mainWholeThreadReads: 'pass',
      mainThreadBusy: 'fail',
      heavyThreadBytes: 'fail',
      mainLoopDelayP95: 'fail'
    })
    expect(phaseExits.baseline).toEqual({
      given: true,
      usable: true,
      reports: 1,
      windows: 1,
      heavyThreadBytesPerSecond: 20_000_000
    })
  })

  it('reports the exits unmeasured when the profile cannot be read', () => {
    const { mainThreadShares, phaseExits } = collectPhaseExits({
      report: captureReport(),
      profilePath: '/artifacts/profiles/missing.cpuprofile',
      calibrationMarkers: CAPTURE_MARKERS,
      fsApi: fakeFs(files())
    })
    expect(mainThreadShares).toMatchObject({ unavailable: 'cpu_profile_unreadable' })
    expect(mainThreadShares.windows[0]).toMatchObject({
      measured: false,
      reason: 'profile_unreadable:malformed'
    })
    expect(verdicts(phaseExits)).toEqual({
      mainThreadSyncs: 'not_measured',
      threadStoreSyncs: 'not_measured',
      mainWholeThreadReads: 'not_measured',
      mainThreadBusy: 'not_measured',
      heavyThreadBytes: 'not_measured',
      mainLoopDelayP95: 'fail'
    })
    expect(phaseExits.baseline).toEqual({ given: false })
  })

  it('says why it could not check the names against the build', () => {
    const { '/build/out/main/index-AbCd1234.js': _bundle, ...withoutBuild } = files()
    const { mainThreadShares, phaseExits } = collectPhaseExits({
      report: captureReport(),
      profilePath: '/artifacts/profiles/main.cpuprofile',
      calibrationMarkers: CAPTURE_MARKERS,
      fsApi: fakeFs(withoutBuild)
    })
    expect(mainThreadShares.build).toEqual({ scripts: 0, unavailable: 'build_scripts_unreadable' })
    expect(phaseExits.exits.mainWholeThreadReads.reasons).toEqual([
      'window 0: build_names_unverified'
    ])
  })

  it('reports a baseline it cannot read as unusable', () => {
    const { phaseExits } = collectPhaseExits({
      report: captureReport(),
      profilePath: '/artifacts/profiles/main.cpuprofile',
      calibrationMarkers: CAPTURE_MARKERS,
      baselineReportPaths: ['/baselines/gone.json'],
      fsApi: fakeFs(files())
    })
    expect(phaseExits.baseline).toEqual({
      given: true,
      usable: false,
      reason: 'baseline_report_unreadable'
    })
  })

  it('never costs the capture its report: a fault is reported in the section', () => {
    const hostile = captureReport()
    Object.defineProperty(hostile.liveRounds.lanes.windows[0], 'd1', {
      enumerable: true,
      get() {
        throw new Error('counter read failed')
      }
    })
    const result = collectPhaseExits({
      report: hostile,
      profilePath: '/artifacts/profiles/main.cpuprofile',
      calibrationMarkers: CAPTURE_MARKERS,
      fsApi: fakeFs(files())
    })
    expect(result.phaseExits).toEqual({
      schemaVersion: 1,
      unavailable: 'evaluation_failed',
      error: 'counter read failed'
    })
    expect(result.mainThreadShares.windows[0]).toMatchObject({ measured: true })
    // A window list the shares cannot even walk leaves both sections saying so.
    const unwalkable = collectPhaseExits({
      report: { liveRounds: { lanes: { windows: [null] } } },
      profilePath: '/artifacts/profiles/main.cpuprofile',
      calibrationMarkers: CAPTURE_MARKERS,
      fsApi: fakeFs(files())
    })
    expect(unwalkable.mainThreadShares).toBeNull()
    expect(unwalkable.phaseExits).toMatchObject({
      schemaVersion: 1,
      unavailable: 'evaluation_failed'
    })
  })
})

describe('reading a finished capture offline', () => {
  const files = (report: Dict = captureReport()) => ({
    '/captures/a/perf-t2-report.json': JSON.stringify(report),
    '/captures/a/profiles/main.cpuprofile': JSON.stringify(captureProfile()),
    '/captures/a/main-profile-calibration.json': JSON.stringify({
      calibration: { markers: CAPTURE_MARKERS }
    }),
    '/build/out/main/index-AbCd1234.js': BUNDLE_TEXT,
    '/baselines/off.json': BASELINE_REPORT
  })

  it('judges the capture from its own report, profile and markers', () => {
    const { mainThreadShares, phaseExits } = phaseExitsForCapture('/captures/a', {
      baselineReportPaths: ['/baselines/off.json'],
      fs: fakeFs(files())
    })
    expect(mainThreadShares.windows[0]).toMatchObject({ measured: true, shares: { sync: 0.2 } })
    expect(verdicts(phaseExits)).toMatchObject({
      mainThreadSyncs: 'fail',
      heavyThreadBytes: 'fail'
    })
    expect(phaseExits.workload).toBe('light_beside_large_live')
  })

  it('leaves the workload unnamed when the report does not name one', () => {
    const { environment: _environment, ...anonymous } = captureReport()
    const { phaseExits } = phaseExitsForCapture('/captures/a', { fs: fakeFs(files(anonymous)) })
    expect(phaseExits.workload).toBeNull()
    expect(phaseExits.exits.mainThreadSyncs.verdict).toBe('fail')
    const unnamed = phaseExitsForCapture('/captures/a', {
      fs: fakeFs(files({ ...anonymous, environment: {} }))
    })
    expect(unnamed.phaseExits.workload).toBeNull()
  })

  it('says a capture is unreadable instead of throwing', () => {
    const result = phaseExitsForCapture('/captures/missing', { fs: fakeFs(files()) })
    expect(result.mainThreadShares).toMatchObject({ unavailable: 'report_unreadable', windows: [] })
    expect(result.phaseExits.exits.mainThreadBusy).toMatchObject({
      verdict: 'not_measured',
      reasons: ['no_measured_window']
    })
    expect(result.phaseExits.workload).toBeNull()
  })

  it('prints one line per exit, with each window’s value and why it is not a pass', () => {
    const lines: string[] = []
    const code = runPhaseExitsCli(['/captures/a', '--baseline=/baselines/off.json'], {
      fs: fakeFs(files()),
      write: (line: string) => lines.push(line)
    })
    expect(code).toBe(0)
    expect(lines).toEqual([
      '/captures/a',
      '  phase1 fail   phase2 fail',
      '  mainThreadSyncs       fail          limit 0.001  window 0: 0.2 over_limit',
      '  threadStoreSyncs      fail          limit 0.001  window 0: 0.2 over_limit',
      '  mainWholeThreadReads  pass          limit 0.001  window 0: 0',
      '  mainThreadBusy        fail          limit 0.25   window 0: 0.7 over_limit',
      '  heavyThreadBytes      fail          limit 0.01   window 0: 1 over_limit',
      '  mainLoopDelayP95      fail          limit 25     window 0: 418 over_limit'
    ])
  })

  it('prints every window of an exit on its line, and what stands in for a missing value', () => {
    const report = captureReport()
    report.liveRounds.lanes.windows.push(
      laneWindow({ repetition: 1, reasons: ['heavy_lane_idle'] })
    )
    const lines: string[] = []
    runPhaseExitsCli(['/captures/a', '/captures/missing'], {
      fs: fakeFs(files(report)),
      write: (line: string) => lines.push(line)
    })
    expect(lines).toContain(
      '  mainThreadBusy        fail          limit 0.25   window 0: 0.7 over_limit; window 1: n/a window_ineligible'
    )
    expect(lines).toContain(
      '  heavyThreadBytes      not_measured  limit 0.01   window 0: n/a baseline_not_given; window 1: n/a window_ineligible'
    )
    // A capture with no window says why on the exit's line.
    expect(lines.slice(lines.indexOf('/captures/missing'))).toContain(
      '  mainLoopDelayP95      not_measured  limit 25     no_measured_window'
    )
  })

  it('prints the whole section as JSON when asked', () => {
    const lines: string[] = []
    const code = runPhaseExitsCli(['--json', '/captures/a'], {
      fs: fakeFs(files()),
      write: (line: string) => lines.push(line)
    })
    expect(code).toBe(0)
    expect(lines).toHaveLength(1)
    const [entry] = JSON.parse(lines[0])
    expect(entry.capture).toBe('/captures/a')
    expect(entry.phaseExits.exits.heavyThreadBytes.windows[0].reasons).toEqual([
      'baseline_not_given'
    ])
    expect(entry.mainThreadShares.windows[0].shares.sync).toBe(0.2)
  })

  it('refuses a call it does not understand, and exits non-zero', () => {
    const lines: string[] = []
    const write = (line: string) => lines.push(line)
    expect(runPhaseExitsCli([], { fs: fakeFs(files()), write })).toBe(2)
    expect(runPhaseExitsCli(['--nope', '/captures/a'], { fs: fakeFs(files()), write })).toBe(2)
    expect(lines).toEqual([
      'usage: node scripts/perf/phaseExits.cjs <capture dir>... [--baseline=<perf-t2-report.json>]... [--json]',
      'usage: node scripts/perf/phaseExits.cjs <capture dir>... [--baseline=<perf-t2-report.json>]... [--json]'
    ])
  })
})
