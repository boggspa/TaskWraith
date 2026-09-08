'use strict'

/**
 * M1 cross-thread work-span collector (Independent Threads Programme,
 * Appendix B of docs/performance/independent-threads-programme.md).
 *
 * Folds per-process WorkSpanRecorder aggregates into the report's
 * `metrics.crossThread` block, keyed by interference-matrix cell. The block
 * is what §1.1's paired light-alone/light-beside comparisons read: WHICH
 * span kind, on WHICH shared resource, cost the light thread how much,
 * while the heavy thread ran.
 *
 * ATTRIBUTION (Amendment A1, Review2 R2-M1-1/2): process-wide byKind /
 * byResource maps CANNOT distinguish a light thread from a heavy one —
 * swapping their durations leaves them byte-identical — so the recorder's
 * per-chat `byChat` map is the acceptance evidence and this collector
 * carries it through validated. Likewise `exact` holds never-sampled
 * offered counters: a zero sampled `fallbackCount` never proves zero
 * fallbacks, `exact.offeredFallbackCount` does. Both are validated when
 * present and absent-tolerated, so pre-attribution reports keep validating
 * while a malformed block still fails closed.
 *
 * HOST POLLING: the Host transport is an opt-in snapshot FILE written by
 * src/host-runtime/HostPerfSnapshotFile.ts. When a `hostPerfSnapshotPath`
 * option or TASKWRAITH_PERF_HOST_SNAPSHOT_PATH env var names that file,
 * readHostPerfSnapshotFile reads it and validates identity, sequence and
 * freshness; ONLY a valid fresh read replaces the unsupported marker.
 * Unconfigured stays { unsupported: 'host_perf_transport_unspecified' };
 * configured-but-wrong reports the specific refusal (stale / identity
 * mismatch / invalid) so a broken transport can never impersonate a
 * pre-transport baseline. Main sampling uses the existing preload
 * getMainPerfSnapshot IPC through a caller-supplied renderer
 * Runtime.evaluate session; absent spans stay unsupported.
 *
 * WIRING STATUS: the legacy section providers are dependency-injected closures.
 * Production wiring (main's `workSpans` snapshot section, Host's
 * HostPerfSnapshot meter) is @IntegrationOwner work gated on the live
 * startup-redesign session releasing index.ts / HostStandaloneComposition.ts.
 * Until then this collector is exercised by tests only.
 *
 * FAIL-CLOSED, two levels — same contract as mainPersistenceStatsCollector:
 * a malformed section is never half-imported (normalize refuses it), and a
 * collection where NO process yields a valid section refuses outright. A
 * single degraded process degrades to an `{ error }` marker (the
 * MainPerfSnapshot section pattern) so one sick process cannot erase the
 * attribution the others captured under the same load.
 */

const { parseCellName } = require('../interferenceMatrix.cjs')

/**
 * Span taxonomy — must stay in lockstep with WORK_SPAN_KINDS /
 * WORK_SPAN_RESOURCES / WORK_SPAN_PROCESSES in src/main/perf/WorkSpanRecorder.ts.
 * If either side changes without the other, the harness will validate a
 * stale contract and attribution silently escapes the report.
 * `round_start` was added by Amendment A1.1 (§1.1 B1: composer send → first
 * participant dispatch); per-kind wait reasons live with the recorder and
 * travel on individual spans, not on these aggregates.
 */
const WORK_SPAN_PROCESSES = Object.freeze(['main', 'host', 'renderer'])
const WORK_SPAN_KINDS = Object.freeze([
  'round_start',
  'admission_wait',
  'provider_config_wait',
  'prompt_build',
  'checkpoint_prepare',
  'host_queue_wait',
  'durable_commit',
  'receipt_delivery',
  'control_response'
])
const WORK_SPAN_RESOURCES = Object.freeze([
  'ensemble_pool',
  'host_chain',
  'codex_daemon',
  'cursor_overlay',
  'ollama_model',
  'workspace_lock',
  'none'
])

/** WorkSpanKeyAggregate fields (WorkSpanRecorder.ts). */
const SPAN_AGGREGATE_FIELDS = Object.freeze([
  'count',
  'totalMs',
  'p50Ms',
  'p95Ms',
  'maxMs',
  'bytes',
  'fallbackCount'
])

/**
 * Fields a newer recorder adds. Validated WHEN PRESENT, never required: a
 * report captured by an older recorder must keep validating, and a silently
 * unvalidated field is exactly how attribution escapes the schema.
 */
const SPAN_AGGREGATE_OPTIONAL_FIELDS = Object.freeze(['p99Ms'])

/** Per-chat attributed aggregate fields (WorkSpanChatAggregate). */
const SPAN_CHAT_AGGREGATE_FIELDS = Object.freeze([
  'count',
  'totalMs',
  'p50Ms',
  'p95Ms',
  'p99Ms',
  'maxMs'
])

/** Exact never-sampled offered counters (WorkSpanOfferedCounters). */
const SPAN_OFFERED_FIELDS = Object.freeze(['offeredCount', 'offeredFallbackCount', 'offeredBytes'])

/** WorkSpanAggregates counters (WorkSpanRecorder.ts). */
const SPAN_COUNTER_FIELDS = Object.freeze(['recorded', 'dropped', 'sampledOut', 'rejected'])

/** Counters a newer recorder adds; validated when present (see above). */
const SPAN_COUNTER_OPTIONAL_FIELDS = Object.freeze(['degraded', 'attributionOverflow'])

/** Schema version of the `metrics.crossThread` block this collector writes. */
const CROSS_THREAD_SCHEMA_VERSION = 1

const PROCESS_SET = new Set(WORK_SPAN_PROCESSES)
const KIND_SET = new Set(WORK_SPAN_KINDS)
const RESOURCE_SET = new Set(WORK_SPAN_RESOURCES)

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

function validateAggregateMap(map, allowedKeys, label, errors) {
  if (!isPlainObject(map)) {
    errors.push(`${label} must be an object`)
    return
  }
  for (const [key, aggregate] of Object.entries(map)) {
    if (!allowedKeys.has(key)) {
      errors.push(`${label}.${key} is not a known span taxonomy member`)
      continue
    }
    if (!isPlainObject(aggregate)) {
      errors.push(`${label}.${key} must be an aggregate object`)
      continue
    }
    for (const field of SPAN_AGGREGATE_FIELDS) {
      if (!isFiniteNumber(aggregate[field])) {
        errors.push(`${label}.${key}.${field} must be finite`)
      }
    }
    for (const field of SPAN_AGGREGATE_OPTIONAL_FIELDS) {
      if (aggregate[field] !== undefined && !isFiniteNumber(aggregate[field])) {
        errors.push(`${label}.${key}.${field} must be finite when present`)
      }
    }
  }
}

/**
 * Exact offered counters: totals plus optional per-kind / per-resource maps.
 * Absent entirely on a pre-attribution recorder; malformed when present is
 * always an error — §1.1 B7 reads these as the authoritative coverage
 * evidence, so they may never be half-imported.
 */
function validateExactCounters(exact, errors) {
  if (exact === undefined) return
  if (!isPlainObject(exact)) {
    errors.push('exact must be an object')
    return
  }
  for (const field of SPAN_OFFERED_FIELDS) {
    if (!isFiniteNumber(exact[field])) errors.push(`exact.${field} must be finite`)
  }
  for (const [label, allowed] of [
    ['byKind', KIND_SET],
    ['byResource', RESOURCE_SET]
  ]) {
    const map = exact[label]
    if (map === undefined) continue
    if (!isPlainObject(map)) {
      errors.push(`exact.${label} must be an object`)
      continue
    }
    for (const [key, counters] of Object.entries(map)) {
      if (!allowed.has(key)) {
        errors.push(`exact.${label}.${key} is not a known span taxonomy member`)
        continue
      }
      if (!isPlainObject(counters)) {
        errors.push(`exact.${label}.${key} must be a counters object`)
        continue
      }
      for (const field of SPAN_OFFERED_FIELDS) {
        if (!isFiniteNumber(counters[field])) {
          errors.push(`exact.${label}.${key}.${field} must be finite`)
        }
      }
    }
  }
}

/**
 * Per-chat attribution: `byChat[chatId][kind] = WorkSpanChatAggregate`. This
 * is the light-vs-heavy evidence a paired G-X comparison reads, so an
 * unknown kind or a non-finite percentile is an error, not a warning.
 */
function validateByChat(byChat, errors) {
  if (byChat === undefined) return
  if (!isPlainObject(byChat)) {
    errors.push('byChat must be an object')
    return
  }
  for (const [chatId, kinds] of Object.entries(byChat)) {
    if (typeof chatId !== 'string' || chatId.length === 0) {
      errors.push('byChat keys must be non-empty chat ids')
      continue
    }
    if (!isPlainObject(kinds)) {
      errors.push(`byChat.${chatId} must be an object`)
      continue
    }
    for (const [kind, aggregate] of Object.entries(kinds)) {
      if (!KIND_SET.has(kind)) {
        errors.push(`byChat.${chatId}.${kind} is not a known span kind`)
        continue
      }
      if (!isPlainObject(aggregate)) {
        errors.push(`byChat.${chatId}.${kind} must be an aggregate object`)
        continue
      }
      for (const field of SPAN_CHAT_AGGREGATE_FIELDS) {
        if (!isFiniteNumber(aggregate[field])) {
          errors.push(`byChat.${chatId}.${kind}.${field} must be finite`)
        }
      }
    }
  }
}

/**
 * Validate one process's WorkSpanAggregates section (the shape
 * `WorkSpanRecorder.section()` emits) before anyone treats it as evidence.
 *
 * @param {unknown} payload
 * @param {string} [processName] when given, the section's `process` must match
 * @returns {{ ok: true, section: object } | { ok: false, reason: string }}
 */
function normalizeWorkSpanSection(payload, processName) {
  const errors = []
  if (!isPlainObject(payload)) return { ok: false, reason: 'section is not an object' }
  if (!PROCESS_SET.has(payload.process)) {
    errors.push(`process must be one of ${WORK_SPAN_PROCESSES.join('|')}`)
  } else if (processName !== undefined && payload.process !== processName) {
    errors.push(`section.process ${payload.process} does not match provider ${processName}`)
  }
  validateAggregateMap(payload.byKind, KIND_SET, 'byKind', errors)
  validateAggregateMap(payload.byResource, RESOURCE_SET, 'byResource', errors)
  for (const field of SPAN_COUNTER_FIELDS) {
    if (!isFiniteNumber(payload[field])) {
      errors.push(`${field} must be finite`)
    }
  }
  for (const field of SPAN_COUNTER_OPTIONAL_FIELDS) {
    if (payload[field] !== undefined && !isFiniteNumber(payload[field])) {
      errors.push(`${field} must be finite when present`)
    }
  }
  validateExactCounters(payload.exact, errors)
  validateByChat(payload.byChat, errors)
  if (errors.length > 0) return { ok: false, reason: errors.join('; ') }
  return { ok: true, section: payload }
}

/**
 * Validate a whole `metrics.crossThread` block. Returns an array of error
 * strings (empty when valid) so schema.cjs can fold it into its own error
 * list — the report schema owns the verdict, this module owns the shape.
 *
 * OPTIONAL-WHEN-ABSENT at the schema level (pre-M1 baselines carry no block
 * and must keep validating); PRESENT-BUT-MALFORMED is always an error.
 */
function validateCrossThreadBlock(block) {
  const errors = []
  if (!isPlainObject(block)) return ['block must be an object']
  if (block.schemaVersion !== CROSS_THREAD_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${CROSS_THREAD_SCHEMA_VERSION}`)
  }
  if (!isPlainObject(block.cells)) {
    errors.push('cells required')
    return errors
  }
  for (const [name, cell] of Object.entries(block.cells)) {
    if (parseCellName(name) === null) {
      errors.push(`cell ${JSON.stringify(name)} is not a valid matrix cell name`)
      continue
    }
    if (!isPlainObject(cell) || !isPlainObject(cell.processes)) {
      errors.push(`cell ${name}.processes required`)
      continue
    }
    const processNames = Object.keys(cell.processes)
    if (processNames.length === 0) {
      errors.push(`cell ${name} carries no process sections`)
    }
    for (const processName of processNames) {
      if (!PROCESS_SET.has(processName)) {
        errors.push(`cell ${name}.processes.${processName} is not a known process`)
        continue
      }
      const section = cell.processes[processName]
      if (isPlainObject(section) && typeof section.error === 'string') continue
      const check = normalizeWorkSpanSection(section, processName)
      if (!check.ok) {
        errors.push(`cell ${name}.${processName}: ${check.reason}`)
      }
    }
  }
  return errors
}

/**
 * Sample every offered process section. Each provider is an injected closure
 * returning (or resolving) one WorkSpanAggregates-shaped object; a throw,
 * an `{ error }` marker, null, or a malformed payload degrades THAT process
 * to an `{ error }` entry. If no process yields a valid section the whole
 * sample refuses — an empty crossThread block reads as "measured, nothing
 * happened", which is a claim this collector never makes.
 *
 * @param {Record<string, () => unknown>} providers keyed by process name
 * @returns {Promise<{ ok: true, sections: object, errors: object }
 *                 | { ok: false, reason: string }>}
 */
async function sampleWorkSpanSections(providers) {
  if (!isPlainObject(providers)) {
    return { ok: false, reason: 'providers map required' }
  }
  const sections = {}
  const errors = {}
  for (const [processName, provider] of Object.entries(providers)) {
    if (!PROCESS_SET.has(processName)) {
      return { ok: false, reason: `unknown process provider ${JSON.stringify(processName)}` }
    }
    if (typeof provider !== 'function') {
      errors[processName] = 'provider is not a function'
      continue
    }
    let value
    try {
      value = await Promise.resolve(provider())
    } catch (error) {
      errors[processName] = error instanceof Error ? error.message : String(error)
      continue
    }
    if (isPlainObject(value) && typeof value.error === 'string') {
      errors[processName] = value.error
      continue
    }
    const check = normalizeWorkSpanSection(value, processName)
    if (!check.ok) {
      errors[processName] = check.reason
      continue
    }
    sections[processName] = check.section
  }
  if (Object.keys(sections).length === 0) {
    const detail = Object.entries(errors)
      .map(([proc, reason]) => `${proc}: ${reason}`)
      .join('; ')
    return {
      ok: false,
      reason: `no process yielded a valid span section${detail ? ` (${detail})` : ''}`
    }
  }
  return { ok: true, sections, errors }
}

/**
 * Fold sampled sections into `metrics.crossThread.cells[cell]`. Mutates and
 * returns `metrics` so the caller keeps one object identity (the
 * applyPersistenceStatsToMetrics pattern). Degraded processes are recorded
 * as `{ error }` markers beside the valid ones.
 *
 * Throws on a bad cell name or an unsampled sections object — the sample
 * step above is the fail-closed boundary; by this point inputs are evidence.
 */
function applyCrossThreadToMetrics(metrics, cell, sections, options = {}) {
  if (!isPlainObject(metrics)) {
    throw new Error('metrics required')
  }
  const name = typeof cell === 'string' ? cell : cellNameSafe(cell)
  if (parseCellName(name) === null) {
    throw new Error(`invalid matrix cell: ${JSON.stringify(name)}`)
  }
  if (!isPlainObject(sections) || Object.keys(sections).length === 0) {
    throw new Error('sampled sections required')
  }
  const now = typeof options.now === 'function' ? options.now : () => new Date()
  if (!isPlainObject(metrics.crossThread)) {
    metrics.crossThread = { schemaVersion: CROSS_THREAD_SCHEMA_VERSION, cells: {} }
  }
  if (!isPlainObject(metrics.crossThread.cells)) {
    metrics.crossThread.cells = {}
  }
  metrics.crossThread.cells[name] = {
    capturedAt: now().toISOString(),
    // Deep copy: sections may be live recorder output (byChat/exact are
    // rebuilt per snapshot), and a stored report must not alias it.
    processes: JSON.parse(JSON.stringify(sections))
  }
  return metrics
}

function cellNameSafe(cell) {
  const { cellName } = require('../interferenceMatrix.cjs')
  return cellName(cell)
}

const HOST_PERF_UNSPECIFIED = 'host_perf_transport_unspecified'

/** Reader freshness bound: outside ±this window the file is not evidence. */
const DEFAULT_HOST_SNAPSHOT_MAX_AGE_MS = 15_000

function resolveHostPerfSnapshotPath(options) {
  if (typeof options.hostPerfSnapshotPath === 'string' && options.hostPerfSnapshotPath.length > 0) {
    return options.hostPerfSnapshotPath
  }
  const env = isPlainObject(options.env) ? options.env : process.env
  const fromEnv = env.TASKWRAITH_PERF_HOST_SNAPSHOT_PATH
  return typeof fromEnv === 'string' && fromEnv.length > 0 ? fromEnv : null
}

/**
 * Read one Host perf snapshot file (HostPerfSnapshotFile.ts writer format:
 * { identity, sequence, capturedAt, truncated?, snapshot }) and validate it
 * into a hostPerf block. Every refusal is a specific `{ unsupported }`
 * marker — never a throw, and never a silent fall-through to the
 * pre-transport 'host_perf_transport_unspecified', which is reserved for
 * the genuinely unconfigured case.
 *
 * options: hostPerfSnapshotPath | env (defaults process.env) picks the
 * file; expectedIdentity { instanceId?, generation?, pid? } pins which Host
 * instance may supply evidence; maxAgeMs bounds freshness both directions
 * (a future-dated artifact is as untrustworthy as a stale one); fs/now are
 * injection seams.
 */
function readHostPerfSnapshotFile(options = {}) {
  const path = resolveHostPerfSnapshotPath(options)
  if (path === null) return { unsupported: HOST_PERF_UNSPECIFIED }
  const fs =
    isPlainObject(options.fs) && typeof options.fs.readFileSync === 'function'
      ? options.fs
      : require('node:fs')
  const now = typeof options.now === 'function' ? options.now : () => new Date()
  const maxAgeMs =
    Number.isFinite(options.maxAgeMs) && options.maxAgeMs > 0
      ? options.maxAgeMs
      : DEFAULT_HOST_SNAPSHOT_MAX_AGE_MS

  let raw
  try {
    raw = fs.readFileSync(path, 'utf8')
  } catch (error) {
    const code = error && typeof error.code === 'string' ? error.code : String(error)
    return { unsupported: 'host_perf_snapshot_unreadable: ' + code }
  }
  let payload
  try {
    payload = JSON.parse(raw)
  } catch {
    return { unsupported: 'host_perf_snapshot_invalid: parse_error' }
  }
  if (!isPlainObject(payload)) {
    return { unsupported: 'host_perf_snapshot_invalid: payload_shape' }
  }
  const identity = payload.identity
  if (
    !isPlainObject(identity) ||
    identity.process !== 'host' ||
    typeof identity.instanceId !== 'string' ||
    identity.instanceId.length === 0 ||
    !Number.isInteger(identity.generation) ||
    identity.generation < 0 ||
    !Number.isInteger(identity.pid) ||
    identity.pid <= 0
  ) {
    return { unsupported: 'host_perf_snapshot_invalid: identity' }
  }

  const expected = isPlainObject(options.expectedIdentity) ? options.expectedIdentity : null
  if (expected) {
    for (const key of ['instanceId', 'generation', 'pid']) {
      if (expected[key] !== undefined && expected[key] !== identity[key]) {
        return { unsupported: 'host_perf_snapshot_identity_mismatch' }
      }
    }
  }
  if (!Number.isInteger(payload.sequence) || payload.sequence <= 0) {
    return { unsupported: 'host_perf_snapshot_invalid: sequence' }
  }
  const capturedAtMs =
    typeof payload.capturedAt === 'string' ? Date.parse(payload.capturedAt) : Number.NaN
  if (!Number.isFinite(capturedAtMs)) {
    return { unsupported: 'host_perf_snapshot_invalid: capturedAt' }
  }
  const ageMs = now().getTime() - capturedAtMs
  if (ageMs > maxAgeMs || ageMs < -maxAgeMs) {
    return { unsupported: 'host_perf_snapshot_stale' }
  }

  const snapshot = payload.snapshot
  if (!isPlainObject(snapshot) || !isPlainObject(snapshot.sections)) {
    return { unsupported: 'host_perf_snapshot_invalid: snapshot_shape' }
  }
  const checked = normalizeWorkSpanSection(snapshot.sections.workSpans, 'host')
  if (!checked.ok) {
    return { unsupported: 'host_perf_snapshot_invalid: ' + checked.reason }
  }
  return {
    identity: {
      process: 'host',
      instanceId: identity.instanceId,
      generation: identity.generation,
      pid: identity.pid
    },
    sequence: payload.sequence,
    capturedAt: payload.capturedAt,
    ...(payload.truncated === true ? { truncated: true } : {}),
    eventLoopLag: isPlainObject(snapshot.eventLoopLag)
      ? JSON.parse(JSON.stringify(snapshot.eventLoopLag))
      : null,
    // Deep copy, same rule as applyCrossThreadToMetrics: a stored report
    // must not alias parsed input a caller may mutate.
    workSpans: JSON.parse(JSON.stringify(checked.section))
  }
}

/**
 * Normalize the main snapshot independently of its polling transport. The
 * snapshot's `host` field is OS load, not Node Host perf, and is never used as
 * a substitute for the unavailable Host snapshot transport.
 */
function normalizeHostSpanSnapshot(snapshot, hostPerf = { unsupported: HOST_PERF_UNSPECIFIED }) {
  if (!isPlainObject(snapshot) || !isPlainObject(snapshot.sections)) {
    return { workSpans: { unsupported: 'main_perf_snapshot_unavailable' }, hostPerf }
  }
  const section = snapshot.sections.workSpans
  if (section === undefined || section === null) {
    return { workSpans: { unsupported: 'main_work_spans_section_unavailable' }, hostPerf }
  }
  const checked = normalizeWorkSpanSection(section, 'main')
  if (!checked.ok) {
    return { workSpans: { unsupported: 'main_work_spans_invalid: ' + checked.reason }, hostPerf }
  }
  return { workSpans: JSON.parse(JSON.stringify(checked.section)), hostPerf }
}

/**
 * Same injected Runtime.evaluate/post seam and return-by-value extraction as
 * mainPersistenceStatsCollector. This sampler uses a renderer CDP session:
 * the existing preload getMainPerfSnapshot IPC supplies the main snapshot.
 * No new global handle, launch or inspector attachment is created here.
 */
async function sampleHostSpans(session, options = {}) {
  // Resolved once per sample: the Host file transport is independent of the
  // renderer session, so a Host read outcome (fresh, stale, mismatched)
  // rides along even when main sampling itself is unsupported.
  const hostPerf = readHostPerfSnapshotFile(options)
  const unsupported = (reason) => ({
    workSpans: { unsupported: reason },
    hostPerf
  })
  if (!session || typeof session.post !== 'function') {
    return unsupported('renderer_runtime_session_required')
  }
  const expression = `(async () => {
    if (!globalThis.api || typeof globalThis.api.getMainPerfSnapshot !== 'function') return null
    return await globalThis.api.getMainPerfSnapshot({ resetLagWindow: false })
  })()`
  let result
  try {
    result = await Promise.resolve(
      session.post('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    )
  } catch (error) {
    return unsupported('main_perf_snapshot_evaluation_failed: ' + String(error))
  }
  if (isPlainObject(result) && result.exceptionDetails) {
    return unsupported('main_perf_snapshot_evaluation_exception')
  }
  const value =
    isPlainObject(result) && isPlainObject(result.result) ? result.result.value : undefined
  return normalizeHostSpanSnapshot(value, hostPerf)
}

module.exports = {
  DEFAULT_HOST_SNAPSHOT_MAX_AGE_MS,
  WORK_SPAN_PROCESSES,
  WORK_SPAN_KINDS,
  WORK_SPAN_RESOURCES,
  SPAN_AGGREGATE_FIELDS,
  SPAN_AGGREGATE_OPTIONAL_FIELDS,
  SPAN_CHAT_AGGREGATE_FIELDS,
  SPAN_OFFERED_FIELDS,
  SPAN_COUNTER_FIELDS,
  SPAN_COUNTER_OPTIONAL_FIELDS,
  CROSS_THREAD_SCHEMA_VERSION,
  normalizeWorkSpanSection,
  validateCrossThreadBlock,
  sampleWorkSpanSections,
  applyCrossThreadToMetrics,
  normalizeHostSpanSnapshot,
  readHostPerfSnapshotFile,
  sampleHostSpans
}
