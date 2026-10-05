'use strict'

/**
 * Main's own window probe, as the live windows judge it (`getMainPerfSnapshot`
 * with a `window` request; main's side is `MainWindowPerfProbes.ts`).
 *
 * A window's loop figures are main's only when main began the window it was
 * asked to, and, asked for its end, answered with a complete receipt for that
 * same window: one that covers the whole window and carries a sampled lag
 * reading. Each condition has a name. A window keeps main's answers as they
 * came, beside the names of the conditions they failed, so a window refused
 * on main's evidence says what main said and why it was refused.
 */

/** The lag figures a receipt must give, each finite and not negative. */
const MAIN_PROBE_LAG_FIELDS = Object.freeze([
  'p50Ms',
  'p95Ms',
  'p99Ms',
  'maxMs',
  'meanMs',
  'observedForMs'
])
/** How much of a failed read's message a window keeps. */
const ERROR_MESSAGE_CHARS = 300

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function finiteNonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/**
 * The conditions a window's two answers fail, by name, in the order the
 * verdict reads them; none for a window main measured. The end is only asked
 * for once main says it started the window: until then the verdict reads the
 * start's answer in its place, so a start main refused fails that alone. A
 * condition that reads a part the answer lacks is not named beside the one
 * that says it is missing.
 *
 * @param {{ begin: unknown, end: unknown, windowId: string, windowMs: number }} answers
 * @returns {string[]}
 */
function failedMainProbeChecks({ begin, end, windowId, windowMs }) {
  const started = isPlainObject(begin) ? begin : {}
  if (started.status !== 'started') return ['begin_not_started']
  const failed = []
  if (started.id !== windowId) failed.push('begin_other_window')
  const receipt = isPlainObject(end) ? end : {}
  if (receipt.status !== 'complete') return [...failed, 'end_not_complete']
  if (receipt.id !== windowId) failed.push('end_other_window')
  const startTimed = finiteNonNegative(receipt.startedAtMs)
  const endTimed = finiteNonNegative(receipt.endedAtMs)
  if (!startTimed) failed.push('end_started_at_invalid')
  if (!endTimed) failed.push('end_ended_at_invalid')
  if (startTimed && endTimed && !(receipt.endedAtMs - receipt.startedAtMs >= windowMs)) {
    failed.push('end_short_of_window')
  }
  const lag = receipt.eventLoopLag
  if (!isPlainObject(lag)) return [...failed, 'lag_missing']
  if (lag.sampling !== true) failed.push('lag_not_sampling')
  if (!(lag.observedForMs > 0)) failed.push('lag_observed_nothing')
  for (const name of MAIN_PROBE_LAG_FIELDS) {
    if (!finiteNonNegative(lag[name])) failed.push(`lag_figure_invalid:${name}`)
  }
  return failed
}

/**
 * Ask main once through `read`, and keep what came back as it came: when the
 * harness asked, when the read settled, and main's answer, or in its place
 * the error the read failed with (its `code` and the start of its message).
 * A read that resolves with nothing keeps `null`.
 *
 * @param {() => unknown} read
 * @param {() => number} nowMs
 */
async function askMainProbe(read, nowMs) {
  const askedAtMs = nowMs()
  try {
    const answer = await read()
    return { askedAtMs, answeredAtMs: nowMs(), answer: answer === undefined ? null : answer }
  } catch (error) {
    return {
      askedAtMs,
      answeredAtMs: nowMs(),
      error: {
        code: typeof error?.code === 'string' ? error.code : null,
        message: String(typeof error?.message === 'string' ? error.message : error).slice(
          0,
          ERROR_MESSAGE_CHARS
        )
      }
    }
  }
}

/**
 * The answer the verdict reads from one ask: main's own when it is an
 * object, otherwise an unavailable one naming why there is none. Unavailable
 * lag evidence never reads as zero lag.
 */
function mainProbeAnswer(asked) {
  if (asked.error) {
    return {
      status: 'unavailable',
      reason: asked.error.code === 'CAPTURE_TIMEOUT' ? 'main_unresponsive' : 'main_probe_failed'
    }
  }
  return isPlainObject(asked.answer)
    ? asked.answer
    : { status: 'unavailable', reason: 'main_probe_invalid' }
}

module.exports = {
  MAIN_PROBE_LAG_FIELDS,
  askMainProbe,
  failedMainProbeChecks,
  mainProbeAnswer
}
