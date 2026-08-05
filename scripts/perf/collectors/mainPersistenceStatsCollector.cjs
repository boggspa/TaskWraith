'use strict'

/**
 * T9a — main-process persistence statistics collector.
 *
 * Reads the harness-gated `__TASKWRAITH_PERF_STATS__` handle out of the
 * running Electron main process over the Node inspector, and folds it into the
 * `metrics.main.saveChat` block the report schema validates.
 *
 * WHY THIS EXISTS: before this collector, `runT2Baseline` produced its metrics
 * from `applyUnsupportedAnnotations(createEmptyPerfMetrics())`, so every
 * `main.saveChat` value in a T2 report was a zero DEFAULT SEED rather than a
 * measurement — which is exactly why T2 could only honestly report
 * `metricsCollected: false`. Nothing in `scripts/perf` had ever read the
 * production counters.
 *
 * WHY Runtime.evaluate RATHER THAN A JSONL SIDE-CHANNEL: streaming probe lines
 * out of the child during the replay would add write+fsync traffic to the very
 * I/O path being measured. Sampling one pre-aggregated object AFTER the replay
 * perturbs nothing.
 *
 * FAIL-CLOSED: every failure mode — missing handle, disabled probe flag,
 * thrown evaluation, malformed payload — returns `{ ok: false, reason }` and
 * NEVER a partially-populated block. A half-filled stats block is worse than
 * none: the schema treats a present block as a measurement claim.
 */

/** Must stay in lockstep with `PERF_STATS_GLOBAL` in src/main/store/perfStatsHandle.ts. */
const PERF_STATS_GLOBAL = '__TASKWRAITH_PERF_STATS__'

const COALESCER_STAT_FIELDS = [
  'scheduled',
  'coalesced',
  'flushed',
  'pending',
  'urgentFlushes',
  'ceilingFlushes',
  'discarded'
]

const FLUSH_REASONS = ['normal', 'terminal', 'approval', 'history-deletion', 'shutdown']

const CHAT_JOURNAL_STAT_FIELDS = [
  'appends',
  'linesWritten',
  'bytesWritten',
  'snapshotsWritten',
  'chatsDeleted',
  'tombstoneRejects',
  'tornLinesRecovered'
]

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * Validate the sampled payload before anyone can treat it as evidence.
 * @returns {{ ok: true, coalescer: object, journal: object, config: object, probes: object }
 *          | { ok: false, reason: string }}
 */
function normalizePerfStatsPayload(payload) {
  if (!isPlainObject(payload)) return { ok: false, reason: 'payload is not an object' }
  const coalescing = payload.coalescing
  if (!isPlainObject(coalescing)) return { ok: false, reason: 'payload.coalescing missing' }

  const coalescer = coalescing.coalescer
  if (!isPlainObject(coalescer)) return { ok: false, reason: 'coalescing.coalescer missing' }
  for (const field of COALESCER_STAT_FIELDS) {
    if (!isFiniteNumber(coalescer[field])) {
      return { ok: false, reason: `coalescer.${field} is not finite` }
    }
  }
  if (!isPlainObject(coalescer.reasonMix)) {
    return { ok: false, reason: 'coalescer.reasonMix missing' }
  }
  for (const reason of FLUSH_REASONS) {
    if (!isFiniteNumber(coalescer.reasonMix[reason])) {
      return { ok: false, reason: `coalescer.reasonMix.${reason} is not finite` }
    }
  }

  const journal = coalescing.journal
  if (!isPlainObject(journal)) return { ok: false, reason: 'coalescing.journal missing' }
  for (const field of CHAT_JOURNAL_STAT_FIELDS) {
    if (!isFiniteNumber(journal[field])) {
      return { ok: false, reason: `journal.${field} is not finite` }
    }
  }

  const probes = isPlainObject(payload.probes) ? payload.probes : null
  if (!probes) return { ok: false, reason: 'payload.probes missing' }
  if (!Array.isArray(probes.targets)) return { ok: false, reason: 'probes.targets missing' }

  return {
    ok: true,
    coalescer,
    journal,
    config: isPlainObject(coalescing.config) ? coalescing.config : {},
    probes
  }
}

/**
 * Sample the handle from the running main process.
 *
 * @param {{ post: (method: string, params?: object) => Promise<unknown>|unknown }} session
 * @returns {Promise<{ ok: true, stats: object } | { ok: false, reason: string }>}
 */
async function sampleMainPersistenceStats(session) {
  if (!session || typeof session.post !== 'function') {
    return { ok: false, reason: 'inspector session adapter with post() required' }
  }
  // `typeof` guard first so a missing handle is a clean refusal rather than a
  // ReferenceError that reads like a harness crash.
  const expression = `(() => {
    if (typeof globalThis[${JSON.stringify(PERF_STATS_GLOBAL)}] !== 'function') return null
    try { return globalThis[${JSON.stringify(PERF_STATS_GLOBAL)}]() } catch (e) { return { error: String(e) } }
  })()`

  let result
  try {
    result = await Promise.resolve(
      session.post('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: false })
    )
  } catch (error) {
    return { ok: false, reason: `Runtime.evaluate failed: ${String(error)}` }
  }

  if (isPlainObject(result) && result.exceptionDetails) {
    return { ok: false, reason: 'Runtime.evaluate reported an exception in the main context' }
  }
  const value =
    isPlainObject(result) && isPlainObject(result.result) ? result.result.value : undefined
  if (value === null || value === undefined) {
    return {
      ok: false,
      reason: `${PERF_STATS_GLOBAL} not installed in main (PERF_PRELOAD_PROBE=1 required)`
    }
  }
  if (isPlainObject(value) && typeof value.error === 'string') {
    return { ok: false, reason: `handle threw in main: ${value.error}` }
  }

  const normalized = normalizePerfStatsPayload(value)
  if (!normalized.ok) return normalized
  return { ok: true, stats: normalized }
}

/**
 * Fold a validated sample into `metrics.main.saveChat`.
 *
 * Legacy chat bytes and journal bytes are deliberately kept in SEPARATE target
 * buckets: dual-write means the journal ADDS whole-record bytes this tranche,
 * so summing them into one number would read as a regression and hide which
 * half moved.
 *
 * Mutates and returns `metrics` so the caller keeps one object identity.
 */
function applyPersistenceStatsToMetrics(metrics, stats) {
  if (!isPlainObject(metrics) || !isPlainObject(metrics.main)) {
    throw new Error('metrics.main required')
  }
  if (!isPlainObject(stats) || !isPlainObject(stats.coalescer)) {
    throw new Error('validated stats required')
  }
  const saveChat = isPlainObject(metrics.main.saveChat) ? metrics.main.saveChat : {}
  metrics.main.saveChat = saveChat

  saveChat.coalescing = {
    scheduled: stats.coalescer.scheduled,
    coalesced: stats.coalescer.coalesced,
    flushed: stats.coalescer.flushed,
    pending: stats.coalescer.pending,
    urgentFlushes: stats.coalescer.urgentFlushes,
    ceilingFlushes: stats.coalescer.ceilingFlushes,
    discarded: stats.coalescer.discarded,
    reasonMix: { ...stats.coalescer.reasonMix }
  }
  saveChat.journal = { ...stats.journal }

  // `count` is every save the store scheduled; `coalescedCount` is the
  // superseded-before-write reduction. These were zero seeds before T9a.
  saveChat.count = stats.coalescer.scheduled
  saveChat.coalescedCount = stats.coalescer.coalesced

  const targets = Array.isArray(stats.probes && stats.probes.targets) ? stats.probes.targets : []
  const byTarget = (name) => targets.find((t) => isPlainObject(t) && t.target === name) || null
  const chat = byTarget('chat')
  const journalTarget = byTarget('chat-journal')

  if (chat && isFiniteNumber(chat.bytes)) {
    saveChat.writeBytes = {
      ...(isPlainObject(saveChat.writeBytes) ? saveChat.writeBytes : {}),
      total: chat.bytes
    }
  }
  saveChat.journalWriteBytes = {
    total: journalTarget && isFiniteNumber(journalTarget.bytes) ? journalTarget.bytes : 0
  }

  // The probe accumulates fsync WALL TIME as a running total; it does not keep
  // per-write samples, so it cannot yield p50/p95. `saveChat.fsyncMs` is a
  // percentile pair, so filling it from a cumulative total would be exactly the
  // invented value the runner contract forbids. Report the measured cumulative
  // under its own unambiguous name and leave the percentile field alone.
  saveChat.fsyncMsTotal = {
    chat: chat && isFiniteNumber(chat.fsyncMs) ? chat.fsyncMs : 0,
    chatJournal: journalTarget && isFiniteNumber(journalTarget.fsyncMs) ? journalTarget.fsyncMs : 0
  }

  // STRINGIFY: the probe genuinely measures serialize wall time per write
  // (`PersistenceWriteSample.serializeMs`), which is exactly what the
  // `stringifyMs` unsupported annotation was waiting for — its own reason
  // string says "requires PERF_PRELOAD_PROBE=1 production probe". Fold the
  // measured cumulative under an unambiguous name (same shape as fsyncMsTotal;
  // the probe keeps no per-write samples, so p50/p95 remain impossible and are
  // NOT invented) and clear the unsupported flag.
  //
  // The flag flips ONLY when a real `chat` measurement exists. With probes
  // disabled there are no targets, the flag stays true, and the comparison gate
  // refuses the run honestly rather than passing on a fabricated value.
  if (chat && isFiniteNumber(chat.serializeMs)) {
    saveChat.stringifyMsTotal = {
      chat: chat.serializeMs,
      chatJournal:
        journalTarget && isFiniteNumber(journalTarget.serializeMs) ? journalTarget.serializeMs : 0
    }
    saveChat.stringifyMsUnsupported = false
  }
  return metrics
}

module.exports = {
  PERF_STATS_GLOBAL,
  normalizePerfStatsPayload,
  sampleMainPersistenceStats,
  applyPersistenceStatsToMetrics
}
