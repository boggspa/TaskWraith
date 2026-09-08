'use strict'

/**
 * M1 cross-thread interference workload matrix (Independent Threads
 * Programme, Appendix A of docs/performance/independent-threads-programme.md).
 *
 * This module is the machine-readable contract for G-X: the cell axes, the
 * cell naming scheme, the light-alone/light-beside pairing rule, and the
 * fixed sampling window every cell must be measured under. It is pure data
 * plus validators — no launch, no replay, no fixtures. Drivers that can
 * actually REACH every cell (multi-chat concurrency, provider saturation,
 * control actions under load) are later milestone work; a cell existing here
 * is a reachability claim about the matrix, not about today's harness.
 *
 * Cell names are `<history>/<chats>/<path>/<mix>/<saturation>` exactly as
 * Appendix A specifies; the pairing role (`light-alone` vs `light-beside`)
 * is a property of the RUN, not the cell, so one cell produces paired
 * reports and the §1.1 deltas are computed between them.
 */

const MATRIX_SCHEMA_VERSION = 1

/**
 * Fixed sampling contract (Appendix A): 120 s windows, three repetitions,
 * p50/p95/p99, CPU profile + heap snapshot per cell. Ratified bounds in
 * §1.1 are p95 over this window and no other.
 */
const MATRIX_SAMPLING = Object.freeze({
  windowMs: 120 * 1000,
  repetitions: 3,
  percentiles: Object.freeze(['p50', 'p95', 'p99']),
  requiresCpuProfile: true,
  requiresHeapSnapshot: true
})

/**
 * History-size pins (Appendix A). The large pin matches the measured worst
 * case; `approx` values are targets for the fixture generator, not gates.
 */
const HISTORY_SIZES = Object.freeze(['small', 'large'])
const HISTORY_SIZE_PINS = Object.freeze({
  small: Object.freeze({ approxMessages: 200, maxBytes: 1024 * 1024 }),
  large: Object.freeze({ approxMessages: 27000, approxBytes: 65 * 1024 * 1024, approxRuns: 1000 })
})

/** Simultaneous chats; 2 is the light + heavy pairing the gates read. */
const CHAT_COUNTS = Object.freeze([1, 2, 4, 8])

const PATH_STATES = Object.freeze(['cold', 'warm'])

/**
 * Provider configuration mixtures (Appendix A, G-P). Token names are the
 * cell-name segments; descriptions are the human contract.
 */
const PROVIDER_MIXES = Object.freeze([
  'codex_profiles_solo_ensemble_mesh',
  'codex_two_runtime_profiles',
  'codex_bridge_disabled',
  'cursor_identical_overlays',
  'cursor_differing_overlays',
  'cursor_differing_descriptors',
  'ollama_same_model_repeated',
  'ollama_distinct_beyond_ceiling',
  'claude_models_repeated_and_distinct',
  'kimi_models_repeated_and_distinct'
])

const PROVIDER_MIX_DESCRIPTIONS = Object.freeze({
  codex_profiles_solo_ensemble_mesh: 'Codex: solo + Ensemble + Mesh profile, same runtime profile',
  codex_two_runtime_profiles: 'Codex: two runtime profiles',
  codex_bridge_disabled: 'Codex: bridge disabled',
  cursor_identical_overlays: 'Cursor: identical overlays across presets',
  cursor_differing_overlays: 'Cursor: differing overlays',
  cursor_differing_descriptors: 'Cursor: differing registration descriptors',
  ollama_same_model_repeated: 'Ollama: same model repeated',
  ollama_distinct_beyond_ceiling: 'Ollama: distinct models beyond the declared ceiling',
  claude_models_repeated_and_distinct: 'Claude: repeated and distinct models',
  kimi_models_repeated_and_distinct: 'Kimi: repeated and distinct models'
})

/** Saturation cases (Appendix A). `none` is the spare-capacity baseline. */
const SATURATION_MODES = Object.freeze([
  'none',
  'ensemble_pool_30_join',
  'host_queue_16_active_1_queued'
])

const SATURATION_DESCRIPTIONS = Object.freeze({
  none: 'Spare capacity — no induced saturation',
  ensemble_pool_30_join: 'Ensemble pool at 30 with a new chat arriving',
  host_queue_16_active_1_queued:
    'Host-native queue at 16 active + 1 queued alongside Desktop persistence'
})

/** Control actions driven during load (Appendix A). */
const CONTROL_ACTIONS = Object.freeze([
  'cancel',
  'approval_decision',
  'question_answer',
  'seat_toggle'
])

/**
 * Pairing roles (G-X): the light thread measured alone vs beside the heavy
 * thread, same fixtures, same build, same window.
 */
const PAIRING_ROLES = Object.freeze(['light-alone', 'light-beside'])

const HISTORY_SET = new Set(HISTORY_SIZES)
const PATH_SET = new Set(PATH_STATES)
const MIX_SET = new Set(PROVIDER_MIXES)
const SATURATION_SET = new Set(SATURATION_MODES)

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Validate one cell descriptor.
 * @param {object} cell
 * @returns {{ ok: true, cell: object } | { ok: false, errors: string[] }}
 */
function validateMatrixCell(cell) {
  const errors = []
  if (!isPlainObject(cell)) return { ok: false, errors: ['cell must be an object'] }
  if (!HISTORY_SET.has(cell.history)) {
    errors.push(`history must be one of ${HISTORY_SIZES.join('|')}`)
  }
  if (!CHAT_COUNTS.includes(cell.chats)) {
    errors.push(`chats must be one of ${CHAT_COUNTS.join('|')}`)
  }
  if (!PATH_SET.has(cell.path)) {
    errors.push(`path must be one of ${PATH_STATES.join('|')}`)
  }
  if (!MIX_SET.has(cell.mix)) {
    errors.push(`mix must be one of ${PROVIDER_MIXES.join('|')}`)
  }
  if (!SATURATION_SET.has(cell.saturation)) {
    errors.push(`saturation must be one of ${SATURATION_MODES.join('|')}`)
  }
  if (errors.length > 0) return { ok: false, errors }
  return {
    ok: true,
    cell: {
      history: cell.history,
      chats: cell.chats,
      path: cell.path,
      mix: cell.mix,
      saturation: cell.saturation
    }
  }
}

/**
 * Canonical cell name: `<history>/<chats>/<path>/<mix>/<saturation>`.
 * Throws on an invalid cell — naming a cell you cannot describe is a bug,
 * not a measurement outcome.
 */
function cellName(cell) {
  const check = validateMatrixCell(cell)
  if (!check.ok) {
    throw new Error(`invalid matrix cell: ${check.errors.join('; ')}`)
  }
  return `${cell.history}/${cell.chats}/${cell.path}/${cell.mix}/${cell.saturation}`
}

/**
 * Parse a canonical cell name back into a cell descriptor.
 * @returns {object | null} the cell, or null when the name is not a cell.
 */
function parseCellName(name) {
  if (typeof name !== 'string') return null
  const parts = name.split('/')
  if (parts.length !== 5) return null
  const chats = Number(parts[1])
  const cell = {
    history: parts[0],
    chats: Number.isInteger(chats) ? chats : NaN,
    path: parts[2],
    mix: parts[3],
    saturation: parts[4]
  }
  const check = validateMatrixCell(cell)
  return check.ok ? check.cell : null
}

/** Every cell in the Appendix A cross product, in stable axis order. */
function enumerateMatrixCells() {
  const cells = []
  for (const history of HISTORY_SIZES) {
    for (const chats of CHAT_COUNTS) {
      for (const path of PATH_STATES) {
        for (const mix of PROVIDER_MIXES) {
          for (const saturation of SATURATION_MODES) {
            cells.push({ history, chats, path, mix, saturation })
          }
        }
      }
    }
  }
  return cells
}

/**
 * The two run names one cell produces. The pairing role is a suffix on the
 * RUN name, never part of the cell name.
 */
function pairedRunNames(cell) {
  const name = cellName(cell)
  return { alone: `${name}::light-alone`, beside: `${name}::light-beside` }
}

/**
 * G-X pairing self-test (M1 automated checks): the light-alone and
 * light-beside runs of one cell must have used IDENTICAL fixtures and
 * windows, or the §1.1 delta between them measures setup drift instead of
 * interference. Each run descriptor carries the evidence the runner
 * recorded:
 *
 *   { cellName, role, fixtureFingerprint, workload, seed, windowMs }
 *
 * @returns {{ ok: true } | { ok: false, reasons: string[] }}
 */
function assertPairedRunCompatibility(alone, beside) {
  const reasons = []
  if (!isPlainObject(alone) || !isPlainObject(beside)) {
    return { ok: false, reasons: ['both run descriptors required'] }
  }
  if (alone.role !== 'light-alone') {
    reasons.push(`alone run role must be light-alone, got ${JSON.stringify(alone.role)}`)
  }
  if (beside.role !== 'light-beside') {
    reasons.push(`beside run role must be light-beside, got ${JSON.stringify(beside.role)}`)
  }
  if (alone.cellName !== beside.cellName) {
    reasons.push(`cell mismatch: ${alone.cellName} vs ${beside.cellName}`)
  } else if (parseCellName(alone.cellName) === null) {
    reasons.push(`cell name is not a valid matrix cell: ${alone.cellName}`)
  }
  if (
    typeof alone.fixtureFingerprint !== 'string' ||
    alone.fixtureFingerprint.length === 0 ||
    alone.fixtureFingerprint !== beside.fixtureFingerprint
  ) {
    reasons.push('fixture fingerprints differ — paired runs must use identical fixtures')
  }
  if (alone.workload !== beside.workload) {
    reasons.push(`workload mismatch: ${alone.workload} vs ${beside.workload}`)
  }
  if (alone.seed !== beside.seed) {
    reasons.push(`seed mismatch: ${alone.seed} vs ${beside.seed}`)
  }
  if (alone.windowMs !== MATRIX_SAMPLING.windowMs) {
    reasons.push(`alone windowMs ${alone.windowMs} != ${MATRIX_SAMPLING.windowMs}`)
  }
  if (beside.windowMs !== MATRIX_SAMPLING.windowMs) {
    reasons.push(`beside windowMs ${beside.windowMs} != ${MATRIX_SAMPLING.windowMs}`)
  }
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons }
}

module.exports = {
  MATRIX_SCHEMA_VERSION,
  MATRIX_SAMPLING,
  HISTORY_SIZES,
  HISTORY_SIZE_PINS,
  CHAT_COUNTS,
  PATH_STATES,
  PROVIDER_MIXES,
  PROVIDER_MIX_DESCRIPTIONS,
  SATURATION_MODES,
  SATURATION_DESCRIPTIONS,
  CONTROL_ACTIONS,
  PAIRING_ROLES,
  validateMatrixCell,
  cellName,
  parseCellName,
  enumerateMatrixCells,
  pairedRunNames,
  assertPairedRunCompatibility
}
