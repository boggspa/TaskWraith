'use strict'

/**
 * Barrier durability as main reports it, the `threadBarrierDurability` section
 * of its perf snapshot, read at a measured window's two fences, and what
 * changed between them.
 *
 * The fences are where the window's save counters are read: before the window
 * starts, and once its rounds have drained and settled. What the section
 * counts between them is the window's own. A counter is differenced. A level
 * (owed now, in flight, queued, waiting) is given as it stood at each fence.
 * A longest or a peak is a maximum since main started: it is the window's own
 * only when it rose between the fences, and otherwise only bounds the
 * window's from above.
 *
 * Only the figures named in `SECTION_FIGURES` are read. Any other field the
 * section has, and a named figure that is missing or not a number, is listed
 * as unread rather than guessed at, so a figure added to the section shows up
 * as one the harness does not read yet.
 *
 * A build without the section, a read that failed, or two fences that cannot
 * be compared leave the window with no change and say why; the window is
 * judged as it was without them.
 */

const SECTION_NAME = 'threadBarrierDurability'
const DEFAULT_TIMEOUT_MS = 60_000

/** Page-evaluated read of the section, telling a missing section from an empty one. */
const BARRIER_DURABILITY_EXPRESSION =
  '(function(){ return Promise.resolve(window.api.getMainPerfSnapshot()).then(function(snapshot){ ' +
  'var sections = snapshot && snapshot.sections; ' +
  `if (!sections || typeof sections !== 'object' || !('${SECTION_NAME}' in sections)) return { absent: true }; ` +
  `return { section: sections.${SECTION_NAME} }; }); })()`

const COUNTER = 'counter'
const LEVEL = 'level'
const MAXIMUM = 'maximum'

/** Each figure read, by how it changes; `each` maps every owner, moment or trigger to its own. */
const SECTION_FIGURES = Object.freeze({
  debt: {
    owners: { each: { noted: COUNTER, synced: COUNTER, missing: COUNTER, failed: COUNTER } },
    barriers: {
      raised: COUNTER,
      idle: COUNTER,
      shared: COUNTER,
      rounds: COUNTER,
      renamedUnderway: COUNTER,
      failed: COUNTER,
      waitMsTotal: COUNTER,
      longestWaitMs: MAXIMUM,
      scoped: COUNTER,
      threadOnly: COUNTER,
      urgent: COUNTER,
      hastened: COUNTER
    },
    // Settled barriers by class: the urgent ones a user sat in, and the rest.
    waits: {
      each: {
        count: COUNTER,
        totalMs: COUNTER,
        longestMs: MAXIMUM,
        aheadTotal: COUNTER,
        aheadMost: MAXIMUM
      }
    },
    owed: { threads: LEVEL, files: LEVEL, directories: LEVEL },
    owingRuns: LEVEL,
    syncsOnCallingThread: COUNTER
  },
  port: {
    started: COUNTER,
    inFlight: LEVEL,
    queued: LEVEL,
    joined: COUNTER,
    peakInFlight: MAXIMUM,
    queuedUrgent: LEVEL,
    queuedNormal: LEVEL,
    startedUrgent: COUNTER,
    promoted: COUNTER,
    fairStarts: COUNTER,
    urgencies: LEVEL
  },
  tickets: {
    moments: {
      each: {
        noted: COUNTER,
        covered: COUNTER,
        uncovered: COUNTER,
        failed: COUNTER,
        pending: LEVEL,
        undecided: LEVEL,
        longestWaitMs: MAXIMUM
      }
    },
    missingGates: COUNTER,
    uncoveredRunFinals: COUNTER,
    awaits: COUNTER,
    awaitsRejected: COUNTER,
    awaitsWaiting: LEVEL,
    longestAwaitMs: MAXIMUM,
    chats: LEVEL
  },
  gates: {
    waits: COUNTER,
    overdue: COUNTER,
    rejected: COUNTER,
    waitMsTotal: COUNTER,
    longestWaitMs: MAXIMUM
  },
  threads: {
    owing: LEVEL,
    idleBarriers: COUNTER,
    idleFailed: COUNTER,
    quitThreads: COUNTER,
    quitUnpaid: COUNTER
  },
  checkpoints: { each: { count: COUNTER, bytes: COUNTER, mainMs: COUNTER } },
  tornTailsRepaired: COUNTER
})

/** Fields that are not figures: the switch, and the one place a gate was missed. */
const NOT_FIGURES = new Set(['enabled', 'ignored', 'tickets.lastMissingGate'])

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function joined(at, key) {
  return at === '' ? key : `${at}.${key}`
}

/**
 * Read the section through the page. Never throws.
 *
 * @param {{ evaluate(expression: string): Promise<unknown> }} page
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<{ ok: true, section: object } | { ok: false, reason: string }>}
 */
async function readBarrierDurability(page, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  let timer = null
  let answer
  try {
    answer = await Promise.race([
      Promise.resolve().then(() => page.evaluate(BARRIER_DURABILITY_EXPRESSION)),
      new Promise((_resolve, reject) => {
        timer = setTimeout(
          () => reject(Object.assign(new Error('timed out'), { timedOut: true })),
          timeoutMs
        )
      })
    ])
  } catch (error) {
    return {
      ok: false,
      reason: error && error.timedOut === true ? 'read_timed_out' : 'read_failed'
    }
  } finally {
    clearTimeout(timer)
  }
  if (!isPlainObject(answer) || answer.absent === true)
    return { ok: false, reason: 'section_absent' }
  const section = answer.section
  // Main's snapshot puts `{ error }` in place of a section whose provider threw.
  if (isPlainObject(section) && typeof section.error === 'string' && !('enabled' in section)) {
    return { ok: false, reason: 'section_failed' }
  }
  if (!isPlainObject(section) || typeof section.enabled !== 'boolean') {
    return { ok: false, reason: 'section_invalid' }
  }
  return { ok: true, section }
}

/** What one figure, or one part of figures, did between the fences. */
function changeOf(figures, before, after, at, found) {
  if (typeof figures === 'string') {
    if (!Number.isFinite(before) || !Number.isFinite(after)) {
      found.unread.push(at)
      return null
    }
    if (figures === LEVEL) return { before, after }
    if (figures === MAXIMUM) return { atMost: after, exact: after > before }
    if (after < before) found.wentBack.push(at)
    // Summed milliseconds are fractional; a microsecond is the finest step kept.
    return Math.round((after - before) * 1_000) / 1_000
  }
  if (before == null && after == null) return null
  if (!isPlainObject(before) || !isPlainObject(after)) {
    found.differs.push(at)
    return null
  }
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])]
  const change = {}
  if (figures.each) {
    for (const key of keys) {
      change[key] = changeOf(figures.each, before[key], after[key], joined(at, key), found)
    }
    return change
  }
  for (const [key, inner] of Object.entries(figures)) {
    change[key] = changeOf(inner, before[key], after[key], joined(at, key), found)
  }
  for (const key of keys) {
    if (!(key in figures) && !NOT_FIGURES.has(joined(at, key))) found.unread.push(joined(at, key))
  }
  return change
}

/**
 * What changed in the section between a window's two fences.
 *
 * @param {object} before the section at the first fence
 * @param {object} after the section at the second
 * @returns {{ ok: true, change: object } | { ok: false, reason: string, at?: string[] }}
 */
function barrierDurabilityChange(before, after) {
  if (!isPlainObject(before) || !isPlainObject(after))
    return { ok: false, reason: 'section_invalid' }
  if (before.enabled !== after.enabled || (before.ignored ?? null) !== (after.ignored ?? null)) {
    return { ok: false, reason: 'switch_differs_between_fences' }
  }
  const found = { unread: [], wentBack: [], differs: [] }
  const change = changeOf(SECTION_FIGURES, before, after, '', found)
  if (found.differs.length > 0) {
    return { ok: false, reason: 'part_differs_between_fences', at: found.differs.sort() }
  }
  // Counters only rise within one process: main restarted between the fences.
  if (found.wentBack.length > 0) {
    return { ok: false, reason: 'counter_went_back', at: found.wentBack.sort() }
  }
  if (isPlainObject(change.tickets)) {
    change.tickets.lastMissingGate = isPlainObject(after.tickets.lastMissingGate)
      ? after.tickets.lastMissingGate
      : null
  }
  return {
    ok: true,
    change: {
      enabled: after.enabled,
      ignored: after.ignored ?? null,
      ...change,
      unread: [...new Set(found.unread)].sort()
    }
  }
}

/**
 * A window's record: the section at both fences and what changed, or why
 * there is no change. `null` reads mean no reader was given.
 *
 * @param {{ ok: boolean, section?: object, reason?: string } | null} before
 * @param {{ ok: boolean, section?: object, reason?: string } | null} after
 */
function barrierDurabilityAtFences(before, after) {
  const sectionOf = (read) => (read && read.ok === true ? read.section : null)
  const record = {
    before: sectionOf(before),
    after: sectionOf(after),
    change: null,
    unavailable: null
  }
  if (before === null || after === null) record.unavailable = 'reader_absent'
  else if (before.ok !== true) record.unavailable = String(before.reason)
  else if (after.ok !== true) record.unavailable = String(after.reason)
  else {
    const result = barrierDurabilityChange(before.section, after.section)
    if (result.ok) record.change = result.change
    else record.unavailable = result.reason
  }
  return record
}

module.exports = {
  BARRIER_DURABILITY_EXPRESSION,
  SECTION_FIGURES,
  barrierDurabilityAtFences,
  barrierDurabilityChange,
  readBarrierDurability
}
