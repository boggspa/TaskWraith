'use strict'

/**
 * Barrier durability's exits, judged over the captures of an off-against-on
 * pair (`durabilityPair.cjs`): one build and workload launched with
 * `TASKWRAITH_THREAD_BARRIER_DURABILITY` off and on in turn.
 *
 * Judged on each measured window of a capture that had the switch on, as
 * main itself says (the `threadBarrierDurability` section at the window's
 * fences); the same figures with the switch off are given beside, unjudged:
 * - threadStoreSyncs: syncs on the main thread owned by the thread's stores
 *   (the journal's appends, run events, tool detail, catalogue publication),
 *   at most the phase exits' "no sync" tolerance. The journal's checkpoints
 *   are not among them: the layer leaves them synced where they are written,
 *   and they are reported on their own.
 * - mainSyncsNamed: no sync on the main thread without a named owner, with
 *   every owner still syncing there, by share and by milliseconds a turn.
 * - synchronousWait: the main thread never held in `Atomics.wait`.
 * - ticketGates: no missing gate (a user message, decision or destructive
 *   change reported done with nobody waiting for its sync) and no overdue
 *   one. A ticket is judged missing its gate some time after it is noted, so
 *   the exit passes only when every user-facing ticket had been judged by the
 *   second fence. With the gates' waits as far as the section counts them:
 *   their number, mean and longest. The section keeps no spread, so their p50
 *   and p95 are not measured.
 * - barrierWaitUserFacing, barrierWaitRunFinal: the p95 of the wait from a
 *   ticket to its barrier, by class, under its limit. The section keeps only
 *   the longest wait since main started, so a class passes when that longest
 *   is under its limit (no p95 can be over it), and fails only when its p95
 *   is known: fewer than twenty waits, all begun and ended between the
 *   fences, and the longest seen between them, which by nearest rank is then
 *   the p95. Anything else is not measured. Beside each class, the debt's own
 *   record of its barriers: the urgent ones for the user's moments, the rest
 *   for a run's final record (idle and quit barriers among them), with the
 *   syncs each found running or queued ahead of it.
 * Reported, not judged:
 * - checkpointsOnMain: the journal's whole-record checkpoints by trigger
 *   (count, bytes, the main thread's milliseconds), off and on.
 * - portSyncs: the syncs the port started, the most in flight, the queue at
 *   each fence (urgent and not), the urgent syncs started and those moved
 *   ahead, and each owner's syncs paid; figures the section has that are not
 *   read yet are named.
 * - mainBusyMsPerModelTurn: the main thread's busy time a model turn, off
 *   against on, by the median of each half of a qualified pair.
 *
 * A share is judged as the phase exits judge one: a window placed by its
 * markers is judged; one placed within loose markers passes only when the
 * most its bounds allow does and fails only when the least does; one placed
 * by an estimated clock can fail and never pass.
 */

const fs = require('node:fs')
const path = require('node:path')
const { DURABILITY_EXIT_THRESHOLDS } = require('./perfGateThresholds.cjs')
const { qualifyDurabilityPair, switchInWindow } = require('./durabilityPair.cjs')
const { mainWindowProfileSharesForCapture } = require('./collectors/mainWindowProfileShares.cjs')

const SCHEMA_VERSION = 1
/** The sync owners that are a thread's own stores, its journal's checkpoints apart. */
const STORE_OWNERS = Object.freeze(['toolDetail', 'cataloguePublication', 'journal', 'runEvents'])
const USER_FACING = Object.freeze(['user_message', 'decision', 'destructive'])
const RUN_FINAL = Object.freeze(['run_final'])
/** Below this many waits the p95 by nearest rank is the longest. */
const P95_IS_LONGEST_BELOW = 20
const SPREAD_UNMEASURED =
  'not_measured: the section counts the waits, their total and the longest, not their spread'
const USAGE = 'usage: node scripts/perf/durabilityExits.cjs <capture dir>... [--json]'

/** Each exit judged with the switch on: its limit, and how a value meets it. */
const JUDGED = Object.freeze([
  {
    id: 'threadStoreSyncs',
    threshold: 'maxThreadStoreSyncShare',
    passes: 'at_most_limit',
    measure:
      "share of the window the main thread spent in syncs of the journal's appends, run events, tool detail or catalogue publication"
  },
  {
    id: 'mainSyncsNamed',
    threshold: 'maxUnnamedSyncShare',
    passes: 'at_most_limit',
    measure: 'share of the window the main thread spent in syncs no owner is named for'
  },
  {
    id: 'synchronousWait',
    threshold: 'maxSynchronousWaitShare',
    passes: 'at_most_limit',
    measure: 'share of the window the main thread was held in Atomics.wait'
  },
  {
    id: 'ticketGates',
    threshold: null,
    passes: 'none_missing_none_overdue',
    measure:
      'tickets for a user message, decision or destructive change no gate awaited; gates over their time'
  },
  {
    id: 'barrierWaitUserFacing',
    threshold: 'maxUserFacingBarrierWaitP95Ms',
    passes: 'under_limit',
    measure: 'p95 of the barrier wait of a user message, decision or destructive change (ms)'
  },
  {
    id: 'barrierWaitRunFinal',
    threshold: 'maxRunFinalBarrierWaitP95Ms',
    passes: 'under_limit',
    measure: "p95 of the barrier wait of a run's final record (ms)"
  }
])

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function round(value, digits) {
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
}

function isBounds(value) {
  return Array.isArray(value) && value.length === 2 && value.every(Number.isFinite)
}

function within(passes, value, limit) {
  return passes === 'under_limit' ? value < limit : value <= limit
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

/** The live phase a report's windows are in. */
function phaseWindowsOf(report) {
  const live = isPlainObject(report) && isPlainObject(report.liveRounds) ? report.liveRounds : {}
  const phase = [live.lanes, live.agents].find(
    (candidate) => isPlainObject(candidate) && Array.isArray(candidate.windows)
  )
  return phase ? phase.windows : []
}

/** The store owners together, or null when one has no figure. */
function storeSum(owners, pick) {
  if (!isPlainObject(owners)) return null
  let sum = 0
  for (const owner of STORE_OWNERS) {
    const value = pick(owners[owner])
    if (!Number.isFinite(value)) return null
    sum += value
  }
  return round(sum, 5)
}

/**
 * A share's verdict, by the clock that placed its window: settled by
 * markers, by loose markers only where every placement agrees, and by an
 * estimate only as a failure.
 */
function shareVerdict({ value, bounds, basis, limit, passes, nullReason }) {
  if (value === null) return { verdict: 'not_measured', reasons: [nullReason] }
  const extra = isBounds(bounds) ? { bounds } : {}
  if (basis === 'loose_markers') {
    if (!isBounds(bounds))
      return { verdict: 'not_measured', reasons: ['profile_clock_loose'], ...extra }
    if (!within(passes, bounds[0], limit))
      return { verdict: 'fail', reasons: ['over_limit'], ...extra }
    if (!within(passes, bounds[1], limit))
      return { verdict: 'not_measured', reasons: ['profile_clock_loose'], ...extra }
    return { verdict: 'pass', reasons: [], ...extra }
  }
  if (basis !== 'markers') {
    return isBounds(bounds) && !within(passes, bounds[0], limit)
      ? { verdict: 'fail', reasons: ['over_limit'], ...extra }
      : { verdict: 'not_measured', reasons: ['profile_clock_estimated'], ...extra }
  }
  return within(passes, value, limit)
    ? { verdict: 'pass', reasons: [] }
    : { verdict: 'fail', reasons: ['over_limit'] }
}

/** Milliseconds a model turn of a window's share, or null without turns. */
function msPerTurn(share, window) {
  return Number.isFinite(share) && window.modelTurns > 0 && Number.isFinite(window.sampledMs)
    ? round((share * window.sampledMs) / window.modelTurns, 3)
    : null
}

/** One window of one capture: the runner's record and its shares, and what holds them back. */
function windowContext(capture, index) {
  const window = capture.windows[index]
  const candidate = capture.shareWindows[index]
  const share =
    isPlainObject(candidate) && candidate.repetition === window.repetition ? candidate : null
  const record = isPlainObject(window.barrierDurability) ? window.barrierDurability : null
  const inMain = switchInWindow(window)
  return {
    capture: capture.id,
    state: capture.state,
    repetition: window.repetition ?? null,
    eligible: Array.isArray(window.reasons) && window.reasons.length === 0,
    share,
    measured: share !== null && share.measured === true,
    change: record && isPlainObject(record.change) ? record.change : null,
    unavailable: record ? (record.unavailable ?? null) : 'not_read',
    inMain
  }
}

/** Why a window with the switch on cannot be judged at all, or null. */
function heldBack(context) {
  if (!context.eligible) return 'window_ineligible'
  if (context.inMain.startsWith('unconfirmed:')) {
    return `switch_unconfirmed:${context.inMain.slice('unconfirmed:'.length)}`
  }
  if (context.inMain !== 'on') return `switch_not_on_in_main:${context.inMain}`
  return null
}

function row(context, verdict, value, reasons, extra = {}) {
  return {
    capture: context.capture,
    state: context.state,
    repetition: context.repetition,
    verdict,
    value,
    reasons,
    ...extra
  }
}

/** The three exits read from the window's main-thread shares. */
function shareRows(context, thresholds, judge) {
  const unmeasured = (reason) => row(context, 'not_measured', null, [reason])
  const held = judge ? heldBack(context) : null
  if (held !== null)
    return Object.fromEntries(JUDGED.slice(0, 3).map(({ id }) => [id, unmeasured(held)]))
  if (context.share === null) {
    return Object.fromEntries(
      JUDGED.slice(0, 3).map(({ id }) => [id, unmeasured('shares_absent_for_window')])
    )
  }
  if (!context.measured) {
    return Object.fromEntries(
      JUDGED.slice(0, 3).map(({ id }) => [id, unmeasured(String(context.share.reason))])
    )
  }
  const share = context.share
  const basis = isPlainObject(share.clock) ? share.clock.basis : null
  const owners = isPlainObject(share.syncOwners) ? share.syncOwners : {}
  const ownerBounds = isPlainObject(share.syncOwnerBounds) ? share.syncOwnerBounds : null
  const judged = (exit, value, bounds, nullReason, extra) => {
    if (!judge) return row(context, 'context', value, [], extra)
    const { verdict, reasons, ...more } = shareVerdict({
      value,
      bounds,
      basis,
      limit: thresholds[exit.threshold],
      passes: exit.passes,
      nullReason
    })
    return row(context, verdict, value, reasons, { ...more, ...extra })
  }
  const stores = storeSum(owners, (value) => value)
  const storeBounds =
    ownerBounds === null
      ? null
      : [0, 1].map((end) =>
          storeSum(ownerBounds, (bounds) => (isBounds(bounds) ? bounds[end] : NaN))
        )
  const stillSyncing = Object.entries(owners)
    .filter(([owner, value]) => owner !== 'other' && Number.isFinite(value) && value > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([owner, value]) => ({ owner, share: value, msPerModelTurn: msPerTurn(value, share) }))
  const other = Number.isFinite(owners.other) ? owners.other : null
  const otherBounds = ownerBounds !== null && isBounds(ownerBounds.other) ? ownerBounds.other : null
  const wait =
    share.shares && Number.isFinite(share.shares.atomicsWait) ? share.shares.atomicsWait : null
  const waitBounds =
    isPlainObject(share.shareBounds) && isBounds(share.shareBounds.atomicsWait)
      ? share.shareBounds.atomicsWait
      : null
  return {
    threadStoreSyncs: judged(
      JUDGED[0],
      stores,
      storeBounds !== null && storeBounds.every(Number.isFinite) ? storeBounds : null,
      'function_not_in_build',
      { owners: Object.fromEntries(STORE_OWNERS.map((owner) => [owner, owners[owner] ?? null])) }
    ),
    mainSyncsNamed: judged(JUDGED[1], other, otherBounds, 'function_not_in_build', {
      stillSyncing,
      unnamedCallers: Array.isArray(share.syncOtherCallers) ? share.syncOtherCallers : null
    }),
    synchronousWait: judged(JUDGED[2], wait, waitBounds, 'wait_not_measurable', {
      msPerModelTurn: msPerTurn(wait, share)
    })
  }
}

/** Why the section cannot speak for a window with the switch on, or null. */
function sectionHeldBack(context) {
  if (context.change === null) return context.unavailable ?? 'section_not_read'
  if (context.change.enabled !== true) return 'switch_off_in_section'
  return null
}

/** The tickets' gates in one window. */
function ticketRow(context, judge) {
  const held = (judge ? heldBack(context) : null) ?? sectionHeldBack(context)
  if (held !== null)
    return row(context, judge ? 'not_measured' : 'context', null, judge ? [held] : [])
  const { tickets, gates } = context.change
  if (!isPlainObject(tickets)) return row(context, 'not_measured', null, ['tickets_not_reported'])
  const missingGates = tickets.missingGates
  const overdue = isPlainObject(gates) ? gates.overdue : null
  // A user-facing ticket still syncing or not yet judged at the second fence
  // may yet turn out to have had no gate.
  const atSecondFence = (field) =>
    USER_FACING.reduce((sum, name) => {
      const counters = isPlainObject(tickets.moments) ? tickets.moments[name] : null
      return sum + (counters && isPlainObject(counters[field]) ? counters[field].after : 0)
    }, 0)
  const undecided = atSecondFence('undecided')
  const pending = atSecondFence('pending')
  const evidence = {
    lastMissingGate: tickets.lastMissingGate ?? null,
    undecidedAtSecondFence: undecided,
    pendingAtSecondFence: pending,
    waits: isPlainObject(gates)
      ? {
          count: gates.waits,
          meanMs: gates.waits > 0 ? round(gates.waitMsTotal / gates.waits, 3) : null,
          longestMs: gates.longestWaitMs,
          p50Ms: null,
          p95Ms: null,
          spread: SPREAD_UNMEASURED
        }
      : null,
    awaits: {
      count: tickets.awaits,
      rejected: tickets.awaitsRejected,
      longestMs: tickets.longestAwaitMs
    }
  }
  const value = { missingGates, overdue }
  if (!judge) return row(context, 'context', value, [], evidence)
  if (missingGates > 0) return row(context, 'fail', value, ['missing_gate'], evidence)
  if (overdue > 0) return row(context, 'fail', value, ['overdue_gate'], evidence)
  if (!isPlainObject(gates))
    return row(context, 'not_measured', value, ['gates_not_reported'], evidence)
  if (pending > 0) {
    return row(context, 'not_measured', value, ['tickets_pending_at_second_fence'], evidence)
  }
  if (undecided > 0) {
    return row(context, 'not_measured', value, ['tickets_undecided_at_second_fence'], evidence)
  }
  return row(context, 'pass', value, [], evidence)
}

/**
 * The debt's own record of one class of settled barriers: the urgent ones a
 * user sat in, or the rest (a run's own, idle and quit barriers alike).
 */
function barriersOfClass(debt, name) {
  const waits = isPlainObject(debt) && isPlainObject(debt.waits) ? debt.waits[name] : null
  if (!isPlainObject(waits) || !Number.isFinite(waits.count)) return null
  const mean = (total) =>
    waits.count > 0 && Number.isFinite(total) ? round(total / waits.count, 3) : null
  return {
    class: name,
    count: waits.count,
    meanMs: mean(waits.totalMs),
    longestMs: waits.longestMs ?? null,
    syncsAheadMean: mean(waits.aheadTotal),
    syncsAheadMost: waits.aheadMost ?? null
  }
}

/** One class of barrier wait in one window, against its limit. */
function barrierWaitRow(context, moments, limit, barrierClass) {
  const held = heldBack(context) ?? sectionHeldBack(context)
  if (held !== null) return row(context, 'not_measured', null, [held])
  const tickets = context.change.tickets
  if (!isPlainObject(tickets) || !isPlainObject(tickets.moments)) {
    return row(context, 'not_measured', null, ['tickets_not_reported'])
  }
  const counters = moments.map((name) => tickets.moments[name])
  const missing = moments.filter((_, index) => !isPlainObject(counters[index]))
  if (missing.length > 0) {
    return row(context, 'not_measured', null, [`moment_not_reported:${missing[0]}`])
  }
  const sum = (pick) => counters.reduce((total, each) => total + pick(each), 0)
  const noted = sum((each) => each.noted)
  const pendingAtStart = sum((each) => each.pending.before)
  const pendingAtEnd = sum((each) => each.pending.after)
  const longest = Math.max(...counters.map((each) => each.longestWaitMs.atMost))
  const exact = counters.some(
    (each) => each.longestWaitMs.exact && each.longestWaitMs.atMost === longest
  )
  const evidence = {
    moments: [...moments],
    tickets: noted,
    pendingAtStart,
    pendingAtEnd,
    barriers: barriersOfClass(context.change.debt, barrierClass)
  }
  if (noted === 0 && pendingAtStart === 0) {
    return row(context, 'not_measured', null, ['no_tickets_in_window'], evidence)
  }
  if (pendingAtEnd > 0) {
    return row(context, 'not_measured', null, ['tickets_pending_at_second_fence'], evidence)
  }
  if (longest < limit) {
    return row(context, 'pass', longest, [], { ...evidence, valueIs: 'upper_bound' })
  }
  if (exact && pendingAtStart === 0 && noted < P95_IS_LONGEST_BELOW) {
    return row(context, 'fail', longest, ['over_limit'], { ...evidence, valueIs: 'exact' })
  }
  return row(context, 'not_measured', null, ['p95_unknown_longest_over_limit'], {
    ...evidence,
    longestMs: { atMost: longest, exact }
  })
}

/** The journal's checkpoints in one window, by trigger. */
function checkpointRow(context) {
  if (!context.eligible) return row(context, 'not_measured', null, ['window_ineligible'])
  if (context.change === null) {
    return row(context, 'not_measured', null, [context.unavailable ?? 'section_not_read'])
  }
  const byTrigger = context.change.checkpoints
  if (!isPlainObject(byTrigger))
    return row(context, 'not_measured', null, ['checkpoints_not_reported'])
  const total = { count: 0, bytes: 0, mainMs: 0 }
  for (const counts of Object.values(byTrigger)) {
    if (!isPlainObject(counts)) continue
    for (const field of Object.keys(total)) {
      if (Number.isFinite(counts[field])) total[field] += counts[field]
    }
  }
  total.mainMs = round(total.mainMs, 3)
  const share = context.measured ? context.share : null
  return row(context, 'measured', total.count, [], {
    byTrigger,
    total,
    mainMsPerModelTurn:
      share !== null && share.modelTurns > 0 ? round(total.mainMs / share.modelTurns, 3) : null,
    syncShare:
      share !== null &&
      isPlainObject(share.syncOwners) &&
      Number.isFinite(share.syncOwners.journalCheckpoint)
        ? share.syncOwners.journalCheckpoint
        : null
  })
}

/** The port's syncs in one window. */
function portRow(context) {
  const held = heldBack(context) ?? sectionHeldBack(context)
  if (held !== null) return row(context, 'not_measured', null, [held])
  const { port, debt, unread } = context.change
  if (!isPlainObject(port)) return row(context, 'not_measured', null, ['port_not_reported'])
  const owners = isPlainObject(debt) && isPlainObject(debt.owners) ? debt.owners : {}
  return row(context, 'measured', port.started, [], {
    started: port.started,
    joined: port.joined,
    peakInFlight: port.peakInFlight,
    queued: port.queued,
    inFlight: port.inFlight,
    queuedByClass: { urgent: port.queuedUrgent ?? null, normal: port.queuedNormal ?? null },
    startedUrgent: port.startedUrgent ?? null,
    promoted: port.promoted ?? null,
    fairStarts: port.fairStarts ?? null,
    syncedByOwner: Object.fromEntries(
      Object.entries(owners).map(([owner, counters]) => [
        owner,
        isPlainObject(counters) ? counters.synced : null
      ])
    ),
    barrierRounds:
      isPlainObject(debt) && isPlainObject(debt.barriers) ? debt.barriers.rounds : null,
    syncsOnCallingThread: isPlainObject(debt) ? debt.syncsOnCallingThread : null,
    unread: (Array.isArray(unread) ? unread : []).filter(
      (name) => name.startsWith('port.') || name.startsWith('debt.')
    )
  })
}

/** Main-thread time a model turn in one window, with the switch either way. */
function perTurnRow(context) {
  if (!context.eligible) return row(context, 'not_measured', null, ['window_ineligible'])
  if (!context.measured) {
    return row(context, 'not_measured', null, [
      context.share === null ? 'shares_absent_for_window' : String(context.share.reason)
    ])
  }
  const basis = isPlainObject(context.share.clock) ? context.share.clock.basis : null
  if (basis !== 'markers' && basis !== 'loose_markers') {
    return row(context, 'not_measured', null, ['profile_clock_estimated'])
  }
  const perModelTurn = context.share.perModelTurn
  if (!isPlainObject(perModelTurn) || !Number.isFinite(perModelTurn.mainBusyMs)) {
    return row(context, 'not_measured', null, [
      context.share.perModelTurnUnavailable ?? 'no_figure_per_turn'
    ])
  }
  return row(context, 'measured', perModelTurn.mainBusyMs, [], {
    perModelTurn,
    modelTurns: context.share.modelTurns,
    clock: basis
  })
}

function overall(rows, emptyReason) {
  if (rows.length === 0) return { verdict: 'not_measured', reasons: [emptyReason] }
  return {
    verdict: rows.some((each) => each.verdict === 'fail')
      ? 'fail'
      : rows.every((each) => each.verdict === 'pass')
        ? 'pass'
        : 'not_measured',
    reasons: rows.flatMap((each) => each.reasons.map((reason) => `${each.capture}: ${reason}`))
  }
}

/**
 * Judge the exits over a pair's captures.
 *
 * @param {{
 *   captures: Array<{ id: string, report: object, shares: object }>,
 *   thresholds?: object
 * }} input
 */
function evaluateDurabilityExits(input) {
  const thresholds = isPlainObject(input.thresholds) ? input.thresholds : DURABILITY_EXIT_THRESHOLDS
  const given = Array.isArray(input.captures) ? input.captures : []
  const pair = qualifyDurabilityPair(given.map(({ id, report }) => ({ id, report })))
  // In the order they ran, each with the state the pair read for it.
  const byId = new Map(given.map((capture) => [capture.id, capture]))
  const captures = pair.captures
    .filter((summary) => summary.state !== null && byId.has(summary.id))
    .map((summary) => {
      const { report, shares } = byId.get(summary.id)
      return {
        id: summary.id,
        state: summary.state,
        windows: phaseWindowsOf(report),
        shareWindows: isPlainObject(shares) && Array.isArray(shares.windows) ? shares.windows : []
      }
    })
  const contexts = captures.flatMap((capture) =>
    capture.windows.map((_, index) => windowContext(capture, index))
  )
  const on = contexts.filter((context) => context.state === 'on')
  const off = contexts.filter((context) => context.state === 'off')

  const exits = {}
  const judgedRows = Object.fromEntries(JUDGED.map(({ id }) => [id, []]))
  const offRows = Object.fromEntries(JUDGED.map(({ id }) => [id, []]))
  for (const context of on) {
    Object.entries(shareRows(context, thresholds, true)).forEach(([id, each]) =>
      judgedRows[id].push(each)
    )
    judgedRows.ticketGates.push(ticketRow(context, true))
    judgedRows.barrierWaitUserFacing.push(
      barrierWaitRow(context, USER_FACING, thresholds.maxUserFacingBarrierWaitP95Ms, 'urgent')
    )
    judgedRows.barrierWaitRunFinal.push(
      barrierWaitRow(context, RUN_FINAL, thresholds.maxRunFinalBarrierWaitP95Ms, 'normal')
    )
  }
  for (const context of off) {
    Object.entries(shareRows(context, thresholds, false)).forEach(([id, each]) =>
      offRows[id].push(each)
    )
    offRows.ticketGates.push(ticketRow(context, false))
  }
  for (const exit of JUDGED) {
    exits[exit.id] = {
      measure: exit.measure,
      limit: exit.threshold === null ? null : thresholds[exit.threshold],
      passes: exit.passes,
      ...overall(judgedRows[exit.id], 'no_capture_with_the_switch_on'),
      windows: judgedRows[exit.id],
      offWindows: offRows[exit.id]
    }
  }

  const checkpointRows = contexts.map(checkpointRow)
  exits.checkpointsOnMain = {
    measure: "the journal's whole-record checkpoints by trigger: count, bytes, main-thread ms",
    verdict: checkpointRows.some((each) => each.verdict === 'measured')
      ? 'measured'
      : 'not_measured',
    reasons:
      checkpointRows.length === 0
        ? ['no_capture_with_a_known_switch_state']
        : checkpointRows.flatMap((each) =>
            each.reasons.map((reason) => `${each.capture}: ${reason}`)
          ),
    windows: checkpointRows
  }
  const portRows = on.map(portRow)
  exits.portSyncs = {
    measure: "the port's syncs: started, the most in flight, the queue at each fence",
    verdict: portRows.some((each) => each.verdict === 'measured') ? 'measured' : 'not_measured',
    reasons:
      portRows.length === 0
        ? ['no_capture_with_the_switch_on']
        : portRows.flatMap((each) => each.reasons.map((reason) => `${each.capture}: ${reason}`)),
    windows: portRows
  }
  const turnRows = contexts.map(perTurnRow)
  const halves = Object.fromEntries(
    ['off', 'on'].map((state) => {
      const values = turnRows
        .filter((each) => each.state === state && each.verdict === 'measured')
        .map((each) => each.value)
      return [
        state,
        { windows: values.length, medianMs: values.length > 0 ? median(values) : null }
      ]
    })
  )
  const turnReasons = !pair.qualified
    ? ['pair_unqualified']
    : ['off', 'on']
        .filter((state) => halves[state].windows === 0)
        .map((state) => `no_figure_per_turn_${state}`)
  exits.mainBusyMsPerModelTurn = {
    measure: "the main thread's busy milliseconds a model turn, off against on (medians)",
    verdict: turnReasons.length === 0 ? 'measured' : 'not_measured',
    reasons: turnReasons,
    off: halves.off,
    on: halves.on,
    onOverOff:
      turnReasons.length === 0 && halves.off.medianMs > 0
        ? round(halves.on.medianMs / halves.off.medianMs, 3)
        : null,
    windows: turnRows
  }

  const judged = JUDGED.map(({ id }) => exits[id].verdict)
  return {
    schemaVersion: SCHEMA_VERSION,
    thresholds: { ...thresholds },
    pair,
    exits,
    verdict: judged.includes('fail')
      ? 'fail'
      : judged.every((verdict) => verdict === 'pass')
        ? 'pass'
        : 'not_measured'
  }
}

/** A capture on disk: its report, and its shares measured again with this checkout's code. */
function readCaptureFromDisk(captureDir) {
  let report = null
  try {
    report = JSON.parse(fs.readFileSync(path.join(captureDir, 'perf-t2-report.json'), 'utf8'))
  } catch {
    report = null
  }
  const id =
    isPlainObject(report) &&
    isPlainObject(report.environment) &&
    typeof report.environment.instanceId === 'string'
      ? report.environment.instanceId
      : path.basename(captureDir)
  return { id, report, shares: mainWindowProfileSharesForCapture(captureDir) }
}

function summaryLines(result) {
  const { pair } = result
  const lines = [
    `pair ${pair.qualified ? 'qualified' : `not qualified (${pair.reasons.join(', ')})`} (${pair.captures.length} captures, ${pair.workload ?? 'no workload'})   verdict ${result.verdict}`
  ]
  for (const [id, exit] of Object.entries(result.exits)) {
    let detail
    if (id === 'mainBusyMsPerModelTurn') {
      detail =
        exit.verdict === 'measured'
          ? `off ${exit.off.medianMs} ms, on ${exit.on.medianMs} ms (${exit.onOverOff} of off)`
          : exit.reasons.join(',')
    } else {
      const rows = exit.windows.map(
        (each) =>
          `${each.capture}: ${typeof each.value === 'object' && each.value !== null ? JSON.stringify(each.value) : (each.value ?? 'n/a')}${each.reasons.length > 0 ? ` ${each.reasons.join(',')}` : ''}`
      )
      detail = rows.length > 0 ? rows.join('; ') : exit.reasons.join(',')
    }
    const limit = exit.limit === undefined || exit.limit === null ? '' : `limit ${exit.limit}`
    lines.push(`  ${id.padEnd(24)}${exit.verdict.padEnd(14)}${limit.padEnd(12)}${detail}`)
  }
  return lines
}

/**
 * Judge a pair's captures from the command line. Returns the exit code.
 *
 * @param {string[]} argv
 * @param {{ readCapture?: (dir: string) => object, write?: (line: string) => void }} [options]
 */
function runDurabilityExitsCli(argv, options = {}) {
  const write = options.write || ((line) => process.stdout.write(`${line}\n`))
  const readCapture = options.readCapture || readCaptureFromDisk
  const dirs = []
  let json = false
  let understood = true
  for (const arg of argv) {
    if (arg === '--json') json = true
    else if (arg.startsWith('--')) understood = false
    else dirs.push(arg)
  }
  if (!understood || dirs.length === 0) {
    write(USAGE)
    return 2
  }
  const result = evaluateDurabilityExits({ captures: dirs.map((dir) => readCapture(dir)) })
  if (json) write(JSON.stringify(result))
  else for (const line of summaryLines(result)) write(line)
  return 0
}

if (require.main === module) process.exitCode = runDurabilityExitsCli(process.argv.slice(2))

module.exports = { evaluateDurabilityExits, runDurabilityExitsCli }
