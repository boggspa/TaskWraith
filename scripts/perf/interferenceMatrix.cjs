'use strict'

/**
 * M1 cross-thread interference workload matrix (Independent Threads
 * Programme, Appendix A of docs/performance/independent-threads-programme.md).
 *
 * This module is the machine-readable contract for G-X: the cell axes, the
 * cell naming scheme, the light-alone/light-beside pairing rule, and the
 * fixed sampling window every cell must be measured under. It is pure data
 * plus validators — no launch, no replay, no fixtures. Drivers that can
 * actually REACH every cell are landing piecemeal (concurrent per-chat
 * replay lanes: scripts/perf/concurrentReplayLanes.cjs, M1 A1.2; control
 * actions: scripts/perf/controlActionReplay.cjs, M1 Wall 1; deterministic
 * provider turns: scripts/perf/deterministicReplayProvider.cjs, M1 P1).
 * Saturation drivers are still later milestone work.
 * A cell existing here is a scenario definition. Every enumerated cell
 * explicitly lists today's missing drivers.
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
 * History-size pins (Appendix A, reconciled — see the programme doc
 * provenance note). `approx` values are targets for the fixture generator,
 * not gates. `approxBytes` is the serialized large chat; tool bytes are a
 * subset of it (measured seed 42: 44.14 MiB chat incl. 35.06 MiB tools), so
 * the former 65 MiB "chat + tool" sum was planning arithmetic, never a disk
 * footprint. `approxRuns` is retained as-stated and unverified (no
 * generator axis mints runs).
 */
const HISTORY_SIZES = Object.freeze(['small', 'large'])
const HISTORY_SIZE_PINS = Object.freeze({
  small: Object.freeze({ approxMessages: 200, maxBytes: 1024 * 1024 }),
  large: Object.freeze({ approxMessages: 27000, approxBytes: 45 * 1024 * 1024, approxRuns: 1000 })
})

/**
 * How far below a pinned `approx` target a fixture may sit and still honestly
 * carry that history label. The pins are TARGETS, not gates — the comment above
 * says so and `small`'s only hard value is `maxBytes` — so this must be loose
 * enough to honour that and still catch a mismatch of ORDER, which is the only
 * kind that has ever occurred: `light_beside_large` generates 27,042 messages
 * at `--scale-down=1` and 696 at the default 40, against a 27,000 pin. One of
 * those is the large history; the other is the same workload scaled past the
 * point where the label is true.
 */
const HISTORY_PIN_MIN_FRACTION = 0.5

/**
 * Does a generated fixture's shape support the history label its cell claims?
 *
 * Nothing compared these before: `--cell` was validated for SYNTAX and
 * `--workload` for MEMBERSHIP, so `--workload=dual_run --cell=large/...`
 * returned ok and wrote `history: "large"` into a report beside an 18-message
 * fixture. The two numbers were both in hand and never held up against each
 * other.
 *
 * The floor applies ONLY to a pin with no hard bound of its own. `small`
 * declares `maxBytes` and is gated on exactly that; adding a message floor
 * there would invent a gate the schema deliberately does not declare and refuse
 * every run the programme has made (`dual_run --scale-down=40` is 18 messages
 * against a 200 target, and is legitimately small). `large` declares no hard
 * bound at all, which is why it was ungated — so it gets the floor, on both
 * message count and bytes, since either alone admits the other's shape: a
 * 642-message fixture reaches 7.76 MiB, 17% of large's byte pin but 2.4% of its
 * messages.
 *
 * @param {string} history — the cell's history segment
 * @param {{ messages: number, bytes: number }} shape — the GENERATED fixture
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
function checkFixtureSatisfiesHistory(history, shape) {
  const pin = HISTORY_SIZE_PINS[history]
  if (!pin) return { ok: false, reason: `unknown history size: ${history}` }
  if (
    !shape ||
    !Number.isFinite(shape.messages) ||
    !Number.isFinite(shape.bytes) ||
    shape.messages < 0 ||
    shape.bytes < 0
  ) {
    return { ok: false, reason: 'fixture shape requires finite non-negative messages and bytes' }
  }
  if (pin.maxBytes !== undefined && shape.bytes > pin.maxBytes) {
    return {
      ok: false,
      reason: `fixture is ${(shape.bytes / 1048576).toFixed(2)} MiB, over the ${history} pin's hard maxBytes of ${(pin.maxBytes / 1048576).toFixed(2)} MiB`
    }
  }
  // A pin that declares a hard bound is gated on that and nothing else.
  if (pin.maxBytes !== undefined) return { ok: true }
  if (pin.approxMessages !== undefined) {
    const floor = pin.approxMessages * HISTORY_PIN_MIN_FRACTION
    if (shape.messages < floor) {
      return {
        ok: false,
        reason: `fixture has ${shape.messages} messages, under the ${history} pin's floor of ${Math.ceil(floor)} (${HISTORY_PIN_MIN_FRACTION}× its ${pin.approxMessages} target)`
      }
    }
  }
  if (pin.approxBytes !== undefined) {
    const floor = pin.approxBytes * HISTORY_PIN_MIN_FRACTION
    if (shape.bytes < floor) {
      return {
        ok: false,
        reason: `fixture is ${(shape.bytes / 1048576).toFixed(2)} MiB, under the ${history} pin's floor of ${(floor / 1048576).toFixed(2)} MiB (${HISTORY_PIN_MIN_FRACTION}× its ${(pin.approxBytes / 1048576).toFixed(2)} MiB target)`
      }
    }
  }
  return { ok: true }
}

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
 * Only CANONICAL spellings parse: `Number()` alone would accept alternate
 * spellings like `02` that never round-trip, so the name must re-encode to
 * itself byte-for-byte.
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
  if (!check.ok) return null
  return cellName(check.cell) === name ? check.cell : null
}

/** Every cell in the Appendix A cross product, in stable axis order. */
function enumerateMatrixCells() {
  const cells = []
  for (const history of HISTORY_SIZES) {
    for (const chats of CHAT_COUNTS) {
      for (const path of PATH_STATES) {
        for (const mix of PROVIDER_MIXES) {
          for (const saturation of SATURATION_MODES) {
            const cell = { history, chats, path, mix, saturation }
            cells.push({ ...cell, name: cellName(cell), ...cellReachability(cell) })
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
    reasons.push(`cell name is not a valid canonical matrix cell: ${alone.cellName}`)
  }
  if (
    typeof alone.fixtureFingerprint !== 'string' ||
    alone.fixtureFingerprint.length === 0 ||
    alone.fixtureFingerprint !== beside.fixtureFingerprint
  ) {
    reasons.push('fixture fingerprints differ — paired runs must use identical fixtures')
  }
  // Presence AND type, not just equality: two descriptors that both omit
  // workload or seed would otherwise "agree" on undefined and pass.
  if (typeof alone.workload !== 'string' || alone.workload.length === 0) {
    reasons.push('alone workload must be a non-empty string')
  }
  if (typeof beside.workload !== 'string' || beside.workload.length === 0) {
    reasons.push('beside workload must be a non-empty string')
  }
  if (alone.workload !== beside.workload) {
    reasons.push(`workload mismatch: ${alone.workload} vs ${beside.workload}`)
  }
  if (!Number.isSafeInteger(alone.seed)) {
    reasons.push('alone seed must be a safe integer')
  }
  if (!Number.isSafeInteger(beside.seed)) {
    reasons.push('beside seed must be a safe integer')
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

/**
 * Missing drivers are current harness facts, not measurements or new limits.
 * All Wall 1 capability drivers have landed (lanes, control-action,
 * provider-turn, host-native and ensemble-pool saturation), so no cell claims
 * a missing driver today. The list stays exported: a future capability gap
 * re-lands here, not in a comment.
 */
const MISSING_DRIVER_CAPABILITIES = Object.freeze([])

function cellReachability(cell) {
  const check = validateMatrixCell(cell)
  if (!check.ok) throw new Error(check.errors.join('; '))
  // The host-native saturation driver LANDED with
  // scripts/perf/hostNativeSaturation.cjs and the ensemble-pool saturation
  // driver with scripts/perf/ensemblePoolSaturation.cjs (M1 Wall 1): no
  // saturation mode claims a missing driver.
  const missingCapability = []
  // Reachable means every capability driver the cell needs exists. It does
  // NOT mean a runner can execute the cell today: pairing is opt-in on the
  // T2 runner (`--paired-runs`), windowed replay stays opt-in, production
  // binding is still owed, and reports still declare not-run.
  return { reachable: missingCapability.length === 0, missingCapability }
}

function fixtureVersionsKey(value) {
  if (!isPlainObject(value) || Object.keys(value).length === 0) return null
  const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
  if (
    entries.some(
      ([key, version]) =>
        !key ||
        !(
          (typeof version === 'string' && version.trim()) ||
          (Number.isSafeInteger(version) && version > 0)
        )
    )
  )
    return null
  return JSON.stringify(entries)
}

function validPercentiles(value) {
  return (
    isPlainObject(value) &&
    MATRIX_SAMPLING.percentiles.every(
      (key) => typeof value[key] === 'number' && Number.isFinite(value[key]) && value[key] >= 0
    ) &&
    value.p50 <= value.p95 &&
    value.p95 <= value.p99
  )
}

const RUN_EVIDENCE_VERSION = 1
const INTERFERENCE_REPORT_SCHEMA_VERSION = 2

/**
 * Eligibility is separate from legacy metadata compatibility. The coverage
 * record describes observed windows and populations; a claimed status alone
 * cannot turn missing, failed or censored work into a measurement.
 */
function validateRunEvidence(run) {
  const errors = []
  if (!isPlainObject(run)) return ['run descriptor required']
  if (
    run.windowMs !== MATRIX_SAMPLING.windowMs ||
    run.repetitions !== MATRIX_SAMPLING.repetitions
  ) {
    errors.push('qualified evidence requires the 120-second, three-repetition sampling contract')
  }
  if (
    !PAIRING_ROLES.includes(run.role) ||
    parseCellName(run.cellName) === null ||
    typeof run.fixtureFingerprint !== 'string' ||
    !run.fixtureFingerprint.trim() ||
    fixtureVersionsKey(run.fixtureVersions) === null ||
    typeof run.workload !== 'string' ||
    !run.workload.trim() ||
    typeof run.buildId !== 'string' ||
    !run.buildId.trim() ||
    !Number.isSafeInteger(run.seed)
  ) {
    errors.push('qualified evidence requires complete run identity and fixture metadata')
  }
  if (
    !isPlainObject(run.signals) ||
    Object.keys(run.signals).length === 0 ||
    Object.values(run.signals).some((summary) => !validPercentiles(summary))
  ) {
    errors.push('qualified evidence requires measured percentile signals')
  }
  const evidence = run.evidence
  if (!isPlainObject(evidence) || evidence.schemaVersion !== RUN_EVIDENCE_VERSION) {
    return ['versioned run evidence required; legacy descriptors are diagnostic only']
  }
  if (evidence.status !== 'complete' || evidence.diagnosticOnly !== false) {
    errors.push('run evidence is not a completed measurement')
  }
  for (const flag of ['censored', 'failed', 'unsupported', 'incomplete', 'diagnosticOnly']) {
    if (run[flag] === true) errors.push('run is ' + flag)
  }
  const populations = evidence.populations
  if (!Array.isArray(populations) || populations.length === 0) {
    return [...errors, 'measured populations required']
  }
  const ids = new Set()
  let light = null
  let heavyCount = 0
  for (const population of populations) {
    if (
      !isPlainObject(population) ||
      typeof population.chatId !== 'string' ||
      !population.chatId.trim() ||
      ids.has(population.chatId) ||
      !['light', 'heavy'].includes(population.role)
    ) {
      errors.push('invalid or duplicate measured population')
      continue
    }
    ids.add(population.chatId)
    if (population.role === 'light') {
      if (light !== null) errors.push('exactly one light population required')
      light = population.chatId
    } else heavyCount += 1
  }
  if (light === null || evidence.lightChatId !== light) {
    errors.push('exactly identified light population required')
  }
  if (
    (run.role === 'light-alone' && (heavyCount !== 0 || populations.length !== 1)) ||
    (run.role === 'light-beside' && heavyCount === 0)
  ) {
    errors.push('pairing role contradicts measured populations')
  }
  if (!Array.isArray(evidence.windows) || evidence.windows.length !== run.repetitions) {
    return [...errors, 'coverage for every repetition required']
  }
  let lightSamples = 0
  let previousEnd = null
  const nonnegative = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0
  const count = (value) => Number.isSafeInteger(value) && value >= 0
  for (const [index, window] of evidence.windows.entries()) {
    if (!isPlainObject(window)) {
      errors.push('invalid observed window')
      continue
    }
    if (
      window.repetition !== index ||
      window.outcome !== 'complete' ||
      window.reason !== 'deadline' ||
      ['failed', 'censored', 'unsupported', 'incomplete'].some((flag) => window[flag] === true) ||
      !nonnegative(window.startedAtMs) ||
      !nonnegative(window.endedAtMs) ||
      !nonnegative(window.elapsedMs) ||
      window.elapsedMs !== window.endedAtMs - window.startedAtMs ||
      window.elapsedMs < run.windowMs ||
      (previousEnd !== null && window.startedAtMs < previousEnd)
    ) {
      errors.push('incomplete, overlapping or invalid observed window')
    }
    previousEnd = window.endedAtMs
    if (!Array.isArray(window.lanes) || window.lanes.length !== populations.length) {
      errors.push('window population coverage required')
      continue
    }
    const seen = new Set()
    for (const lane of window.lanes) {
      const population = populations.find((item) => item?.chatId === lane?.chatId)
      if (!isPlainObject(lane) || !population || seen.has(lane.chatId)) {
        errors.push('invalid window population')
        continue
      }
      seen.add(lane.chatId)
      if (lane.role !== population.role) errors.push('window population role mismatch')
      const fields = [
        'plannedEvents',
        'startedEvents',
        'completedEvents',
        'failedEvents',
        'unsupportedEvents',
        'pendingEvents',
        'lateEvents',
        'measuredSamples',
        'overlappedLightSamples'
      ]
      if (fields.some((field) => !count(lane[field]))) {
        errors.push('invalid window coverage counters')
        continue
      }
      if (
        lane.plannedEvents === 0 ||
        lane.startedEvents !== lane.plannedEvents ||
        lane.completedEvents !== lane.plannedEvents ||
        lane.failedEvents !== 0 ||
        lane.unsupportedEvents !== 0 ||
        lane.pendingEvents !== 0 ||
        lane.lateEvents !== 0 ||
        lane.measuredSamples === 0 ||
        lane.measuredSamples > lane.completedEvents ||
        lane.overlappedLightSamples > lane.measuredSamples
      ) {
        errors.push('empty, failed, unsupported or censored population')
      }
      if (lane.chatId === light) {
        lightSamples += lane.measuredSamples
        if (run.role === 'light-beside' && lane.overlappedLightSamples === 0) {
          errors.push('no observed light/heavy overlap in repetition ' + index)
        }
      }
    }
  }
  for (const summary of Object.values(run.signals || {})) {
    if (
      !isPlainObject(summary) ||
      !count(summary.count) ||
      summary.count === 0 ||
      summary.count !== lightSamples
    ) {
      errors.push('signal count does not match observed light coverage')
    }
  }
  return errors
}

/**
 * Compare measured percentile summaries; never derive p99 from p95 aggregates.
 * The older assertPairedRunCompatibility helper remains available for its
 * legacy descriptors. This evidence-producing boundary additionally requires
 * fixture versions, build identity, three repetitions and actual signal data.
 */
function pairRuns(lightAlone, lightBeside) {
  const compatibility = assertPairedRunCompatibility(lightAlone, lightBeside)
  if (!compatibility.ok) return compatibility
  const reasons = []
  const versions = fixtureVersionsKey(lightAlone.fixtureVersions)
  if (versions === null || versions !== fixtureVersionsKey(lightBeside.fixtureVersions)) {
    reasons.push('fixture versions missing or different')
  }
  for (const [label, run] of [
    ['light-alone', lightAlone],
    ['light-beside', lightBeside]
  ]) {
    reasons.push(...validateRunEvidence(run).map((reason) => label + ': ' + reason))
    if (run.repetitions !== MATRIX_SAMPLING.repetitions) {
      reasons.push(label + ' repetitions must be 3')
    }
    if (typeof run.workload !== 'string' || !run.workload.trim()) {
      reasons.push(label + ' workload required')
    }
    if (!Number.isSafeInteger(run.seed)) reasons.push(label + ' seed must be an integer')
    if (typeof run.buildId !== 'string' || !run.buildId.trim()) {
      reasons.push(label + ' buildId required')
    }
    if (!isPlainObject(run.signals) || Object.keys(run.signals).length === 0) {
      reasons.push(label + ' measured signals required')
    } else {
      for (const [name, summary] of Object.entries(run.signals)) {
        if (!name.trim() || !validPercentiles(summary)) {
          reasons.push(label + ' invalid p50/p95/p99 for signal ' + name)
        }
      }
    }
  }
  if (lightAlone.evidence?.lightChatId !== lightBeside.evidence?.lightChatId) {
    reasons.push('paired runs must measure the same identified light population')
  }
  const aloneWindows = lightAlone.evidence?.windows
  const besideWindows = lightBeside.evidence?.windows
  if (
    Array.isArray(aloneWindows) &&
    Array.isArray(besideWindows) &&
    aloneWindows.length === besideWindows.length
  ) {
    for (let index = 0; index < aloneWindows.length; index += 1) {
      const aloneLanes = aloneWindows[index]?.lanes
      const besideLanes = besideWindows[index]?.lanes
      const aloneLight = Array.isArray(aloneLanes)
        ? aloneLanes.find((lane) => lane?.role === 'light')
        : null
      const besideLight = Array.isArray(besideLanes)
        ? besideLanes.find((lane) => lane?.role === 'light')
        : null
      if (
        aloneLight?.plannedEvents !== besideLight?.plannedEvents ||
        aloneLight?.measuredSamples !== besideLight?.measuredSamples
      ) {
        reasons.push('paired light coverage differs in repetition ' + index)
      }
    }
  }
  if (lightAlone.buildId !== lightBeside.buildId) reasons.push('build identities differ')
  const aloneNames = Object.keys(lightAlone.signals || {}).sort()
  const besideNames = Object.keys(lightBeside.signals || {}).sort()
  if (JSON.stringify(aloneNames) !== JSON.stringify(besideNames)) {
    reasons.push('measured signal sets differ')
  }
  if (reasons.length) return { ok: false, reasons }
  const deltas = Object.fromEntries(
    aloneNames.map((name) => [
      name,
      Object.fromEntries(
        MATRIX_SAMPLING.percentiles.map((percentile) => [
          percentile,
          lightBeside.signals[name][percentile] - lightAlone.signals[name][percentile]
        ])
      )
    ])
  )
  return {
    ok: true,
    pair: {
      cellName: lightAlone.cellName,
      // Detach the receipt from mutable caller-owned samples.
      lightAlone: JSON.parse(JSON.stringify(lightAlone)),
      lightBeside: JSON.parse(JSON.stringify(lightBeside)),
      deltas
    }
  }
}

/**
 * Read provenance only when called; importing this module never launches or
 * attaches anything. Boolean/numeric flag values are retained. Other injected
 * context and credential values are represented by presence, never copied.
 */
function environmentRecord(options = {}) {
  const os = require('node:os')
  const fs = require('node:fs')
  const { collectRepoProvenance, detectAppVersion } = require('./repoProvenance.cjs')
  const repoRoot = options.repoRoot || process.cwd()
  const env = options.env || process.env
  const collect = options.collectRepoProvenance || collectRepoProvenance
  const now = options.now || (() => new Date())
  let electronVersion
  try {
    const packagePath = require.resolve('electron/package.json', { paths: [repoRoot] })
    electronVersion = JSON.parse(fs.readFileSync(packagePath, 'utf8')).version
  } catch {
    electronVersion = { unsupported: 'resolved_electron_version_unavailable' }
  }
  const taskwraithFlags = Object.fromEntries(
    Object.keys(env)
      .filter((key) => /^TASKWRAITH_[A-Z0-9_]+$/.test(key) && env[key] !== undefined)
      .sort()
      .map((key) => [
        key,
        /SECRET|TOKEN|PASSWORD|CREDENTIAL|KEY/.test(key)
          ? '<redacted>'
          : /^(?:true|false|yes|no|on|off|[0-9]+(?:\.[0-9]+)?)$/i.test(String(env[key]))
            ? String(env[key])
            : '<present>'
      ])
  )
  const ceiling = Number(env.OLLAMA_MAX_LOADED_MODELS)
  const cpus = os.cpus()
  return {
    capturedAt: now().toISOString(),
    repoProvenance: collect({ repoRoot }),
    appVersion: detectAppVersion(repoRoot),
    nodeVersion: process.version,
    electronVersion,
    machine: {
      platform: os.platform(),
      arch: os.arch(),
      release: os.release(),
      cpuModel: cpus[0]?.model || 'unknown',
      cpuCount: cpus.length,
      totalMemoryBytes: os.totalmem()
    },
    ollamaMaxLoadedModels: Number.isSafeInteger(ceiling) && ceiling > 0 ? ceiling : null,
    taskwraithFlags
  }
}

function validateInterferenceEnvironment(environment) {
  if (!isPlainObject(environment)) return ['environment required']
  const errors = []
  for (const name of ['capturedAt', 'appVersion', 'nodeVersion']) {
    if (typeof environment[name] !== 'string' || !environment[name].trim()) {
      errors.push('environment.' + name + ' required')
    }
  }
  if (
    typeof environment.capturedAt !== 'string' ||
    !Number.isFinite(Date.parse(environment.capturedAt))
  ) {
    errors.push('environment.capturedAt must be a timestamp')
  }
  const electron = environment.electronVersion
  if (
    !(typeof electron === 'string' && electron.trim()) &&
    !(isPlainObject(electron) && typeof electron.unsupported === 'string' && electron.unsupported)
  )
    errors.push('environment.electronVersion or unsupported reason required')
  const provenance = environment.repoProvenance
  if (
    !isPlainObject(provenance) ||
    typeof provenance.gitSha !== 'string' ||
    !provenance.gitSha ||
    typeof provenance.dirty !== 'boolean' ||
    !Array.isArray(provenance.dirtyPaths) ||
    !provenance.dirtyPaths.every((entry) => typeof entry === 'string') ||
    typeof provenance.dirtyTreeFingerprint !== 'string' ||
    typeof provenance.isolatedWorktree !== 'boolean' ||
    typeof provenance.authoritativeBaseline !== 'boolean'
  ) {
    errors.push('environment.repoProvenance invalid')
  } else if (
    provenance.authoritativeBaseline &&
    (provenance.dirty || !provenance.isolatedWorktree)
  ) {
    errors.push('dirty or non-isolated provenance cannot be authoritative')
  }
  const machine = environment.machine
  if (
    !isPlainObject(machine) ||
    ['platform', 'arch', 'release', 'cpuModel'].some(
      (name) => typeof machine[name] !== 'string' || !machine[name]
    ) ||
    !Number.isSafeInteger(machine.cpuCount) ||
    machine.cpuCount < 0 ||
    !Number.isSafeInteger(machine.totalMemoryBytes) ||
    machine.totalMemoryBytes <= 0
  )
    errors.push('environment.machine invalid')
  const ceiling = environment.ollamaMaxLoadedModels
  if (ceiling !== null && !(Number.isSafeInteger(ceiling) && ceiling > 0)) {
    errors.push('environment.ollamaMaxLoadedModels must be a positive integer or null')
  }
  if (
    !isPlainObject(environment.taskwraithFlags) ||
    Object.entries(environment.taskwraithFlags).some(
      ([key, value]) => !/^TASKWRAITH_[A-Z0-9_]+$/.test(key) || typeof value !== 'string'
    )
  )
    errors.push('environment.taskwraithFlags invalid')
  return errors
}

/** Independent document schema; does not change the existing perf report. */
function validateInterferenceReport(report) {
  if (!isPlainObject(report)) return { ok: false, errors: ['report required'] }
  const errors = validateInterferenceEnvironment(report.environment)
  if (report.schemaVersion !== INTERFERENCE_REPORT_SCHEMA_VERSION) {
    errors.push('schemaVersion 2 required for qualified pairs; legacy reports are diagnostic only')
  }
  if (!Array.isArray(report.cells) || report.cells.length === 0) {
    errors.push('nonempty cells required')
  }
  const names = new Set()
  for (const cell of Array.isArray(report.cells) ? report.cells : []) {
    const check = validateMatrixCell(cell)
    if (!check.ok) {
      errors.push(...check.errors)
      continue
    }
    const name = cellName(cell)
    if (cell.name !== name || names.has(name)) errors.push('invalid or duplicate cell name')
    names.add(name)
    const reachability = cellReachability(cell)
    if (
      cell.reachable !== reachability.reachable ||
      JSON.stringify(cell.missingCapability) !== JSON.stringify(reachability.missingCapability)
    )
      errors.push('cell ' + name + ' must disclose current missing drivers')
  }
  if (!Array.isArray(report.pairs)) errors.push('pairs must be an array')
  const pairedNames = new Set()
  for (const pair of Array.isArray(report.pairs) ? report.pairs : []) {
    if (!isPlainObject(pair)) {
      errors.push('invalid pair')
      continue
    }
    const checked = pairRuns(pair.lightAlone, pair.lightBeside)
    if (
      !checked.ok ||
      pair.cellName !== checked.pair.cellName ||
      !names.has(pair.cellName) ||
      pairedNames.has(pair.cellName) ||
      JSON.stringify(pair.deltas) !== JSON.stringify(checked.pair.deltas)
    )
      errors.push('invalid or inconsistent pair for ' + pair.cellName)
    pairedNames.add(pair.cellName)
  }
  return { ok: errors.length === 0, errors }
}

function createInterferenceReport({ environment, cells = enumerateMatrixCells(), pairs = [] }) {
  const report = { schemaVersion: INTERFERENCE_REPORT_SCHEMA_VERSION, environment, cells, pairs }
  const check = validateInterferenceReport(report)
  if (!check.ok) throw new Error('invalid interferenceReport: ' + check.errors.join('; '))
  return JSON.parse(JSON.stringify(report))
}

module.exports = {
  MATRIX_SCHEMA_VERSION,
  RUN_EVIDENCE_VERSION,
  INTERFERENCE_REPORT_SCHEMA_VERSION,
  validateRunEvidence,
  MATRIX_SAMPLING,
  HISTORY_SIZES,
  HISTORY_SIZE_PINS,
  HISTORY_PIN_MIN_FRACTION,
  checkFixtureSatisfiesHistory,
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
  assertPairedRunCompatibility,
  MISSING_DRIVER_CAPABILITIES,
  cellReachability,
  pairRuns,
  environmentRecord,
  validateInterferenceReport,
  createInterferenceReport
}
