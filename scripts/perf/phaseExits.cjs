'use strict'

/**
 * The rewrite's phase exits, judged for each measured live window of a
 * capture of the baseline workload.
 *
 * Phase 1 (the log is the authority): no disk syncs and no whole-thread reads
 * on the app's main thread while a round runs, the main thread busy for under
 * a quarter of the window, and the bytes written for the heavy thread under a
 * hundredth of the baseline's. Phase 2 (producers state the change):
 * main-loop delay p95 under 25 ms. The limits are `PHASE_EXIT_THRESHOLDS`.
 *
 * The syncs, the reads and the busy share come from the main-thread shares of
 * the window (`collectors/mainWindowProfileShares.cjs`); the loop delay, the
 * saves, the bytes staged and the light thread's round starts are what the
 * live lanes already record per window.
 *
 * An exit is `pass`, `fail` or `not_measured`, per window and overall, with
 * its reasons. It is `not_measured` whenever the capture cannot settle it: a
 * window the lanes ruled out, shares the profile could not give, a function
 * the build no longer has (a renamed function reads as an absence), or a
 * window placed by an estimated clock, which can show a failure and never a
 * pass. Overall an exit passes only when every window passes.
 *
 * Two exits speak about syncs. `mainThreadSyncs` is every sync on the main
 * thread. `threadStoreSyncs` is the part owned by the thread's own stores
 * (the journal, run events, tool detail, catalogue publication), which is
 * what phase 1 moves; the run queue, the usage ledger and the workspace lock
 * files sync on the main thread too and count only in the first.
 *
 * Bytes written for the heavy thread: the app counts only the whole-thread
 * bytes it stages for the Host (`checkpoint_prepare` spans), not what the
 * journal, run events, tool detail, the catalogue or the Host's own copy
 * write. Staged bytes alone can therefore fail the exit; they cannot pass it.
 */

const fs = require('node:fs')
const path = require('node:path')
const { PHASE_EXIT_THRESHOLDS } = require('./perfGateThresholds.cjs')
const {
  mainWindowProfileSharesForCapture,
  mainWindowProfileSharesForReport
} = require('./collectors/mainWindowProfileShares.cjs')

const SCHEMA_VERSION = 1
/** The sync owners that are a thread's own stores. */
const THREAD_STORE_OWNERS = Object.freeze([
  'toolDetail',
  'cataloguePublication',
  'journal',
  'runEvents'
])
/** The span whose bytes are a whole thread record staged for the Host. */
const STAGED_BYTES_KIND = 'checkpoint_prepare'
const USAGE =
  'usage: node scripts/perf/phaseExits.cjs <capture dir>... [--baseline=<perf-t2-report.json>]... [--json]'

/**
 * Each exit: its phase, the threshold that limits it, and whether a value
 * equal to the limit passes (a tolerance) or must stay under it.
 */
const EXITS = Object.freeze([
  {
    id: 'mainThreadSyncs',
    phase: 1,
    threshold: 'maxMainSyncShare',
    passes: 'at_most_limit',
    measure: 'share of the window the main thread spent in disk syncs'
  },
  {
    id: 'threadStoreSyncs',
    phase: 1,
    threshold: 'maxMainSyncShare',
    passes: 'at_most_limit',
    measure:
      'share of the window the main thread spent in syncs owned by the journal, run events, tool detail or catalogue publication'
  },
  {
    id: 'mainWholeThreadReads',
    phase: 1,
    threshold: 'maxMainWholeThreadReadShare',
    passes: 'at_most_limit',
    measure: 'share of the window the main thread spent reading a whole thread record'
  },
  {
    id: 'mainThreadBusy',
    phase: 1,
    threshold: 'maxMainBusyShare',
    passes: 'under_limit',
    measure: 'share of the window the main thread was busy'
  },
  {
    id: 'heavyThreadBytes',
    phase: 1,
    threshold: 'maxHeavyThreadBytesOfBaseline',
    passes: 'under_limit',
    measure:
      "whole-thread bytes staged for the heavy thread per second, over the baseline's; a lower bound, the other files written for it are not counted"
  },
  {
    id: 'mainLoopDelayP95',
    phase: 2,
    threshold: 'maxMainLoopDelayP95Ms',
    passes: 'under_limit',
    measure: 'main-loop delay p95 in the window (ms)'
  }
])

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function round(value, digits) {
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
}

function within(passes, value, limit) {
  return passes === 'under_limit' ? value < limit : value <= limit
}

function isBounds(value) {
  return Array.isArray(value) && value.length === 2 && value.every(Number.isFinite)
}

function readJsonFile(fsApi, file) {
  try {
    return JSON.parse(String(fsApi.readFileSync(file, 'utf8')))
  } catch {
    return null
  }
}

function laneWindowsOf(report) {
  const lanes =
    isPlainObject(report) && isPlainObject(report.liveRounds) ? report.liveRounds.lanes : null
  return isPlainObject(lanes) && Array.isArray(lanes.windows) ? lanes.windows : []
}

function isEligible(lane) {
  return Array.isArray(lane.reasons) && lane.reasons.length === 0
}

/** Whole-thread bytes a lane staged in the window; no staging span is zero. */
function stagedBytes(lane, label) {
  const spans =
    isPlainObject(lane.main) && isPlainObject(lane.main.lanes) ? lane.main.lanes[label] : null
  if (!isPlainObject(spans)) return null
  if (spans[STAGED_BYTES_KIND] === undefined) return 0
  const bytes = isPlainObject(spans[STAGED_BYTES_KIND]) ? spans[STAGED_BYTES_KIND].bytes : null
  return Number.isFinite(bytes) ? bytes : null
}

/** The heavy thread's staged bytes and the seconds they were staged over. */
function heavyStaged(lane) {
  const bytes = stagedBytes(lane, 'heavy')
  const seconds = (lane.endedAtMs - lane.startedAtMs) / 1000
  return bytes !== null && seconds > 0 ? { bytes, seconds } : null
}

/**
 * The baseline's figure for the bytes exit: the heavy thread's staged bytes
 * per second over every eligible window of the baseline reports given.
 *
 * @param {unknown[] | undefined} reports parsed reports; an unreadable one is not an object
 * @param {{ workload?: string | null }} [capture] the workload being judged
 */
function readPhaseBaseline(reports, capture = {}) {
  if (!Array.isArray(reports) || reports.length === 0) return { given: false }
  const unusable = (reason) => ({ given: true, usable: false, reason })
  let bytes = 0
  let seconds = 0
  let windows = 0
  for (const report of reports) {
    if (!isPlainObject(report)) return unusable('baseline_report_unreadable')
    const workload = isPlainObject(report.environment) ? report.environment.workload : undefined
    if ((workload ?? null) !== (capture.workload ?? null)) {
      return unusable('baseline_workload_differs')
    }
    for (const lane of laneWindowsOf(report)) {
      const staged = isPlainObject(lane) && isEligible(lane) ? heavyStaged(lane) : null
      if (staged === null) continue
      bytes += staged.bytes
      seconds += staged.seconds
      windows += 1
    }
  }
  if (windows === 0) return unusable('baseline_has_no_eligible_window')
  if (bytes === 0) return unusable('baseline_staged_no_bytes')
  return {
    given: true,
    usable: true,
    reports: reports.length,
    windows,
    heavyThreadBytesPerSecond: bytes / seconds
  }
}

/** The baseline figure of the reports at these paths, read for a capture of `workload`. */
function readPhaseBaselineFiles(baselineReportPaths, workload, fsApi = fs) {
  const paths = Array.isArray(baselineReportPaths) ? baselineReportPaths : []
  return readPhaseBaseline(
    paths.map((file) => readJsonFile(fsApi, file)),
    { workload }
  )
}

/** The four thread-store owners together, or null when one has no figure. */
function threadStoreSum(owners, pick) {
  if (!isPlainObject(owners)) return null
  let sum = 0
  for (const owner of THREAD_STORE_OWNERS) {
    const value = pick(owners[owner])
    if (!Number.isFinite(value)) return null
    sum += value
  }
  return round(sum, 5)
}

/** What one window says about each exit, and what it is read against. */
function judgeWindow(lane, share, { buildVerified, baseline, thresholds }) {
  const repetition = lane.repetition ?? null
  const eligible = isEligible(lane)
  const measured = share !== null && share.measured === true
  const basis = measured && isPlainObject(share.clock) ? share.clock.basis : null
  const limitOf = (exit) => thresholds[exit.threshold]
  const row = (verdict, value, reasons, extra) => ({
    repetition,
    verdict,
    value,
    reasons,
    ...extra
  })
  const unmeasured = (reason, value = null, extra) => row('not_measured', value, [reason], extra)

  // An exit read from the window's main-thread shares. `named` says the
  // figure depends on app functions the build must still have.
  const shareRow = (exit, value, bounds, named) => {
    if (!eligible) return unmeasured('window_ineligible')
    if (share === null) return unmeasured('shares_absent_for_window')
    if (!measured) return unmeasured(String(share.reason))
    if (value === null) return unmeasured('function_not_in_build')
    const limit = limitOf(exit)
    const extra = isBounds(bounds) ? { bounds } : undefined
    if (basis !== 'markers') {
      // Placed by an estimate: a failure only if no placement could pass.
      return extra !== undefined && !within(exit.passes, bounds[0], limit)
        ? row('fail', value, ['over_limit'], extra)
        : unmeasured('profile_clock_estimated', value, extra)
    }
    if (!within(exit.passes, value, limit)) return row('fail', value, ['over_limit'])
    if (named && !buildVerified) return unmeasured('build_names_unverified', value)
    return row('pass', value, [])
  }
  const shares = measured && isPlainObject(share.shares) ? share.shares : {}
  const shareBounds = measured && isPlainObject(share.shareBounds) ? share.shareBounds : {}
  const shareValue = (name) => (Number.isFinite(shares[name]) ? shares[name] : null)
  const ownerBounds = measured
    ? [
        threadStoreSum(share.syncOwnerBounds, (bounds) => (isBounds(bounds) ? bounds[0] : NaN)),
        threadStoreSum(share.syncOwnerBounds, (bounds) => (isBounds(bounds) ? bounds[1] : NaN))
      ]
    : null

  const byId = Object.fromEntries(EXITS.map((exit) => [exit.id, exit]))
  const rows = {
    mainThreadSyncs: shareRow(byId.mainThreadSyncs, shareValue('sync'), shareBounds.sync, false),
    threadStoreSyncs: shareRow(
      byId.threadStoreSyncs,
      measured ? threadStoreSum(share.syncOwners, (value) => value) : null,
      ownerBounds,
      true
    ),
    mainWholeThreadReads: shareRow(
      byId.mainWholeThreadReads,
      shareValue('wholeThreadRead'),
      shareBounds.wholeThreadRead,
      true
    ),
    mainThreadBusy: shareRow(byId.mainThreadBusy, shareValue('busy'), shareBounds.busy, false)
  }

  // The heavy thread's bytes, against the baseline's.
  const staged = heavyStaged(lane)
  const stagedExtra = { stagedBytes: staged === null ? null : staged.bytes }
  if (!eligible) rows.heavyThreadBytes = unmeasured('window_ineligible', null, stagedExtra)
  else if (staged === null) {
    rows.heavyThreadBytes = unmeasured('bytes_staged_not_recorded', null, stagedExtra)
  } else if (baseline.given !== true) {
    rows.heavyThreadBytes = unmeasured('baseline_not_given', null, stagedExtra)
  } else if (baseline.usable !== true) {
    rows.heavyThreadBytes = unmeasured(String(baseline.reason), null, stagedExtra)
  } else {
    const ofBaseline = round(staged.bytes / staged.seconds / baseline.heavyThreadBytesPerSecond, 5)
    rows.heavyThreadBytes = within(
      byId.heavyThreadBytes.passes,
      ofBaseline,
      limitOf(byId.heavyThreadBytes)
    )
      ? unmeasured('bytes_by_file_family_not_counted', ofBaseline, stagedExtra)
      : row('fail', ofBaseline, ['over_limit'], stagedExtra)
  }

  // The loop delay main itself measured over the window.
  const lag = isPlainObject(lane.mainWindow) ? lane.mainWindow.eventLoopLag : null
  const p95Ms = isPlainObject(lag) && Number.isFinite(lag.p95Ms) ? lag.p95Ms : null
  if (!eligible) rows.mainLoopDelayP95 = unmeasured('window_ineligible')
  else if (p95Ms === null) rows.mainLoopDelayP95 = unmeasured('main_loop_delay_not_recorded')
  else {
    rows.mainLoopDelayP95 = within(
      byId.mainLoopDelayP95.passes,
      p95Ms,
      limitOf(byId.mainLoopDelayP95)
    )
      ? row('pass', p95Ms, [])
      : row('fail', p95Ms, ['over_limit'])
  }

  const settled = isPlainObject(lane.laneSettledAtMs)
    ? Object.values(lane.laneSettledAtMs).filter(Number.isFinite)
    : []
  const roundStart = isPlainObject(lane.light) ? lane.light.roundStartPage : null
  return {
    rows,
    context: {
      repetition,
      eligible,
      reasons: Array.isArray(lane.reasons) ? [...lane.reasons] : ['reasons_absent'],
      clock: typeof basis === 'string' ? basis : null,
      mainLoopDelay:
        p95Ms === null
          ? null
          : { p50Ms: lag.p50Ms, p95Ms: lag.p95Ms, p99Ms: lag.p99Ms, maxMs: lag.maxMs },
      // The save counters are read at the window's start and once the last
      // lane has settled (and a fence after), not at the window's end.
      saves: isPlainObject(lane.d1)
        ? {
            deferredAppends: lane.d1.deferredAppends,
            normalSaves: lane.d1.normalSaves,
            countedForMs: settled.length > 0 ? Math.max(...settled) - lane.startedAtMs : null
          }
        : null,
      bytesStaged:
        isPlainObject(lane.main) && isPlainObject(lane.main.lanes)
          ? { light: stagedBytes(lane, 'light'), heavy: stagedBytes(lane, 'heavy') }
          : null,
      lightRoundStart: isPlainObject(roundStart)
        ? { count: roundStart.count, p50Ms: roundStart.p50Ms, p95Ms: roundStart.p95Ms }
        : null
    }
  }
}

/**
 * Judge every exit over a capture's live-lane windows.
 *
 * @param {{
 *   windows: object[] | undefined,   the report's live-lane window records
 *   shares: object | undefined,      their main-thread shares, in the same order
 *   baseline?: object,               `readPhaseBaseline`'s result
 *   thresholds?: object
 * }} input
 */
function evaluatePhaseExits(input) {
  const thresholds = isPlainObject(input.thresholds) ? input.thresholds : PHASE_EXIT_THRESHOLDS
  const shares = isPlainObject(input.shares) ? input.shares : {}
  const shareWindows = Array.isArray(shares.windows) ? shares.windows : []
  const buildVerified = isPlainObject(shares.build) && shares.build.unavailable === undefined
  const baseline = isPlainObject(input.baseline) ? input.baseline : { given: false }

  const exits = {}
  for (const exit of EXITS) {
    exits[exit.id] = {
      phase: exit.phase,
      measure: exit.measure,
      limit: thresholds[exit.threshold],
      passes: exit.passes,
      verdict: 'not_measured',
      reasons: ['no_measured_window'],
      windows: []
    }
  }
  const windows = []
  ;(Array.isArray(input.windows) ? input.windows : []).forEach((window, index) => {
    const lane = isPlainObject(window) ? window : {}
    // Shares are matched by place and must name the same window.
    const candidate = shareWindows[index]
    const share =
      isPlainObject(candidate) && candidate.repetition === lane.repetition ? candidate : null
    const judged = judgeWindow(lane, share, { buildVerified, baseline, thresholds })
    windows.push(judged.context)
    for (const exit of EXITS) exits[exit.id].windows.push(judged.rows[exit.id])
  })
  for (const exit of Object.values(exits)) {
    if (exit.windows.length === 0) continue
    exit.verdict = exit.windows.some((row) => row.verdict === 'fail')
      ? 'fail'
      : exit.windows.every((row) => row.verdict === 'pass')
        ? 'pass'
        : 'not_measured'
    exit.reasons = exit.windows.flatMap((row) =>
      row.reasons.map((reason) => `window ${row.repetition}: ${reason}`)
    )
  }

  const phases = {}
  for (const phase of new Set(EXITS.map((exit) => exit.phase))) {
    const own = EXITS.filter((exit) => exit.phase === phase).map((exit) => exit.id)
    const failed = own.filter((id) => exits[id].verdict === 'fail')
    const notMeasured = own.filter((id) => exits[id].verdict === 'not_measured')
    phases[`phase${phase}`] = {
      verdict: failed.length > 0 ? 'fail' : notMeasured.length > 0 ? 'not_measured' : 'pass',
      failed,
      notMeasured
    }
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    thresholds: { ...thresholds },
    baseline,
    windows,
    exits,
    phases
  }
}

/** The exits of one report, its baseline read from the reports named. */
function judgeReport(report, shares, baselineReportPaths, fsApi) {
  const workload =
    isPlainObject(report) &&
    isPlainObject(report.environment) &&
    typeof report.environment.workload === 'string'
      ? report.environment.workload
      : null
  return {
    ...evaluatePhaseExits({
      windows: laneWindowsOf(report),
      shares,
      baseline: readPhaseBaselineFiles(baselineReportPaths, workload, fsApi)
    }),
    workload
  }
}

/**
 * The runner's two sections for a capture it has just taken: the main-thread
 * shares of each live-lane window and the phase exits judged from them. The
 * profile is read from disk; the markers are the ones the runner still holds.
 * Never throws: a capture keeps its report whatever happens here.
 *
 * @param {{
 *   report: object, profilePath: string, calibrationMarkers?: object[],
 *   baselineReportPaths?: string[], fsApi?: { readFileSync: Function, readdirSync: Function }
 * }} input
 */
function collectPhaseExits({
  report,
  profilePath,
  calibrationMarkers,
  baselineReportPaths,
  fsApi = fs
}) {
  let mainThreadShares = null
  try {
    mainThreadShares = mainWindowProfileSharesForReport({
      report,
      profilePath,
      calibrationMarkers,
      fsApi
    })
    return {
      mainThreadShares,
      phaseExits: judgeReport(report, mainThreadShares, baselineReportPaths, fsApi)
    }
  } catch (error) {
    return {
      mainThreadShares,
      phaseExits: {
        schemaVersion: SCHEMA_VERSION,
        unavailable: 'evaluation_failed',
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }
}

/**
 * The same two sections for a finished capture on disk.
 *
 * @param {string} captureDir
 * @param {{ baselineReportPaths?: string[], fs?: { readFileSync: Function, readdirSync: Function } }} [options]
 */
function phaseExitsForCapture(captureDir, options = {}) {
  const fsApi = options.fs || fs
  const mainThreadShares = mainWindowProfileSharesForCapture(captureDir, { fs: fsApi })
  const report = readJsonFile(fsApi, path.join(captureDir, 'perf-t2-report.json'))
  return {
    mainThreadShares,
    phaseExits: judgeReport(report, mainThreadShares, options.baselineReportPaths, fsApi)
  }
}

function summaryLines({ capture, phaseExits }) {
  const phases = Object.entries(phaseExits.phases).map(
    ([phase, { verdict }]) => `${phase} ${verdict}`
  )
  const lines = [capture, `  ${phases.join('   ')}`]
  for (const [id, exit] of Object.entries(phaseExits.exits)) {
    const windows = exit.windows.map(
      (row) =>
        `window ${row.repetition}: ${row.value ?? 'n/a'}${row.reasons.length > 0 ? ` ${row.reasons.join(',')}` : ''}`
    )
    lines.push(
      `  ${id.padEnd(22)}${exit.verdict.padEnd(14)}limit ${String(exit.limit).padEnd(7)}${
        windows.length > 0 ? windows.join('; ') : exit.reasons.join(',')
      }`
    )
  }
  return lines
}

/**
 * Judge finished captures from the command line. Returns the exit code.
 *
 * @param {string[]} argv
 * @param {{ fs?: object, write?: (line: string) => void }} [options]
 */
function runPhaseExitsCli(argv, options = {}) {
  const write = options.write || ((line) => process.stdout.write(`${line}\n`))
  const captures = []
  const baselineReportPaths = []
  let json = false
  let understood = true
  for (const arg of argv) {
    if (arg === '--json') json = true
    else if (arg.startsWith('--baseline='))
      baselineReportPaths.push(arg.slice('--baseline='.length))
    else if (arg.startsWith('--')) understood = false
    else captures.push(arg)
  }
  if (!understood || captures.length === 0) {
    write(USAGE)
    return 2
  }
  const results = captures.map((capture) => ({
    capture,
    ...phaseExitsForCapture(capture, { baselineReportPaths, fs: options.fs })
  }))
  if (json) write(JSON.stringify(results))
  else for (const result of results) for (const line of summaryLines(result)) write(line)
  return 0
}

if (require.main === module) process.exitCode = runPhaseExitsCli(process.argv.slice(2))

module.exports = {
  collectPhaseExits,
  evaluatePhaseExits,
  phaseExitsForCapture,
  readPhaseBaseline,
  readPhaseBaselineFiles,
  runPhaseExitsCli
}
