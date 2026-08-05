'use strict'

/**
 * ADR §7 measurement schema for the TaskWraith performance epic (T1b).
 * Pure validators + empty report factories + gate evaluation — no Electron, no live userData.
 */

const crypto = require('crypto')
const { PERF_GATE_THRESHOLDS, MIN_PROFILE_BYTES } = require('./perfGateThresholds.cjs')

const WORKLOADS = Object.freeze(['30seat', '50seat', 'dual_run', '455_soak', '50_chat_switch'])

const FX_POSTURES = Object.freeze([
  'cinematic_default',
  'fx_off_refraction_on',
  'solid_reduce_transparency',
  'reduce_motion'
])

const MATERIALIZE_MODES = Object.freeze(['legacy_v1', 'future_v2'])

/**
 * T4b: the save-coalescer / chat-journal reporting seam. These names mirror
 * `SaveCoalescerStats` and `ChatJournalStats` in src/main/store exactly — if
 * either shape changes, this list must change with it or the harness will
 * validate a stale contract.
 */
const FLUSH_REASONS = Object.freeze([
  'normal',
  'terminal',
  'approval',
  'history-deletion',
  'shutdown'
])

const COALESCER_STAT_FIELDS = Object.freeze([
  'scheduled',
  'coalesced',
  'flushed',
  'pending',
  'urgentFlushes',
  'ceilingFlushes',
  'discarded'
])

const CHAT_JOURNAL_STAT_FIELDS = Object.freeze([
  'appends',
  'linesWritten',
  'bytesWritten',
  'snapshotsWritten',
  'chatsDeleted',
  'tombstoneRejects',
  'tornLinesRecovered'
])

const SCHEMA_VERSION = 1

const CORRECTNESS_BOOL_KEYS = Object.freeze([
  'transcriptOrderOk',
  'identityOk',
  'terminalStateOk',
  'exportParityOk',
  'approvalsLedgerOk',
  'historyDeletionOk',
  'crashBarrierRecoveredOk'
])

const CAPABILITY_BOOL_KEYS = Object.freeze([
  'fiftySeatRosterOk',
  'cinematicSelectableOk',
  'reduceMotionHonoredOk',
  'toolExpandLazyOk',
  'exportFullTranscriptOk',
  'popoutPinHydrationOk',
  'sideMultiviewPinOk',
  'composerFocusRetainedOk',
  'desktopExportCapOk',
  'bridgeExportCapOk',
  'exportFullAssemblyOk',
  'iosProjectionBoundedOk',
  'iosScrollAnchorOk',
  'rawDetailRecoverableOk'
])

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0
}

function percentileShape(label, value, errors) {
  if (!isPlainObject(value)) {
    errors.push(`${label} must be an object`)
    return
  }
  for (const key of ['p50', 'p95', 'p99', 'max']) {
    if (!(key in value)) continue
    if (!isFiniteNumber(value[key])) {
      errors.push(`${label}.${key} must be a finite number`)
    }
  }
}

function dualStatShape(label, value, errors) {
  if (!isPlainObject(value)) {
    errors.push(`${label} must be an object`)
    return
  }
  for (const key of ['p50', 'p95']) {
    if (!(key in value)) continue
    if (!isFiniteNumber(value[key])) {
      errors.push(`${label}.${key} must be a finite number`)
    }
  }
}

/**
 * @param {unknown} env
 * @returns {{ ok: true, value: object } | { ok: false, errors: string[] }}
 */
function validatePerfEnvironment(env) {
  const errors = []
  if (!isPlainObject(env)) {
    return { ok: false, errors: ['environment must be an object'] }
  }
  if (env.schemaVersion !== SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${SCHEMA_VERSION}`)
  }
  if (!isNonEmptyString(env.runId)) errors.push('runId required')
  if (!isNonEmptyString(env.gitSha)) errors.push('gitSha required')
  if (!isNonEmptyString(env.appVersion)) errors.push('appVersion required')
  if (!isNonEmptyString(env.instanceId)) errors.push('instanceId required')
  if (!isNonEmptyString(env.userDataDir)) errors.push('userDataDir required')
  if (!isFiniteNumber(env.remoteDebuggingPort)) {
    errors.push('remoteDebuggingPort must be a finite number')
  }
  if (env.iosRemote !== false) {
    errors.push('iosRemote must be false (never touch live remote bridge)')
  }
  if (!FX_POSTURES.includes(env.fxPosture)) {
    errors.push(`fxPosture must be one of ${FX_POSTURES.join(', ')}`)
  }
  if (!WORKLOADS.includes(env.workload)) {
    errors.push(`workload must be one of ${WORKLOADS.join(', ')}`)
  }
  if (!isFiniteNumber(env.seed)) errors.push('seed must be a finite number')
  if (!isNonEmptyString(env.startedAt)) errors.push('startedAt required')
  if (env.endedAt != null && !isNonEmptyString(env.endedAt)) {
    errors.push('endedAt must be an ISO-8601 string when present')
  }
  if (typeof env.authoritativeBaseline !== 'boolean') {
    errors.push('authoritativeBaseline must be boolean')
  }
  if (!isPlainObject(env.repoProvenance)) {
    errors.push('repoProvenance required')
  } else {
    const rp = env.repoProvenance
    if (!isNonEmptyString(rp.gitSha)) errors.push('repoProvenance.gitSha required')
    if (typeof rp.dirty !== 'boolean') errors.push('repoProvenance.dirty must be boolean')
    if (!isNonEmptyString(rp.dirtyTreeFingerprint)) {
      errors.push('repoProvenance.dirtyTreeFingerprint required')
    }
    if (!Array.isArray(rp.dirtyPaths)) {
      errors.push('repoProvenance.dirtyPaths must be an array')
    }
    if (typeof rp.isolatedWorktree !== 'boolean') {
      errors.push('repoProvenance.isolatedWorktree must be boolean')
    }
  }
  return errors.length === 0 ? { ok: true, value: env } : { ok: false, errors }
}

/**
 * @param {unknown} metrics
 * @returns {{ ok: true, value: object } | { ok: false, errors: string[] }}
 */
function validatePerfMetrics(metrics) {
  const errors = []
  if (!isPlainObject(metrics)) {
    return { ok: false, errors: ['metrics must be an object'] }
  }

  if (!isPlainObject(metrics.main)) {
    errors.push('main required')
  } else {
    percentileShape('main.eventLoopLagMs', metrics.main.eventLoopLagMs, errors)
    if (!Array.isArray(metrics.main.longTasks)) {
      errors.push('main.longTasks must be an array')
    }
    if (!isPlainObject(metrics.main.saveChat)) {
      errors.push('main.saveChat required')
    } else {
      const sc = metrics.main.saveChat
      if (!isFiniteNumber(sc.count)) errors.push('main.saveChat.count must be finite')
      if (!isFiniteNumber(sc.coalescedCount)) {
        errors.push('main.saveChat.coalescedCount must be finite')
      }
      dualStatShape('main.saveChat.stringifyMs', sc.stringifyMs, errors)
      if (!isPlainObject(sc.writeBytes)) {
        errors.push('main.saveChat.writeBytes required')
      } else {
        if (!isFiniteNumber(sc.writeBytes.total)) {
          errors.push('main.saveChat.writeBytes.total must be finite')
        }
        if (sc.writeBytes.p95 != null && !isFiniteNumber(sc.writeBytes.p95)) {
          errors.push('main.saveChat.writeBytes.p95 must be finite')
        }
      }
      dualStatShape('main.saveChat.fsyncMs', sc.fsyncMs, errors)
      if (sc.stringifyMsUnsupported != null && typeof sc.stringifyMsUnsupported !== 'boolean') {
        errors.push('main.saveChat.stringifyMsUnsupported must be boolean when present')
      }
      // T4b reporting seam. Optional-when-absent on purpose: the frozen T2
      // baseline predates these probes and must keep validating, or the
      // comparison it is the denominator for could never run. Present-but-
      // malformed is an error, so a partially wired sampler fails loudly
      // instead of silently reporting an unattributable run.
      if (sc.coalescing != null) {
        if (!isPlainObject(sc.coalescing)) {
          errors.push('main.saveChat.coalescing must be an object when present')
        } else {
          const co = sc.coalescing
          for (const field of COALESCER_STAT_FIELDS) {
            if (!isFiniteNumber(co[field])) {
              errors.push(`main.saveChat.coalescing.${field} must be finite`)
            }
          }
          if (!isPlainObject(co.reasonMix)) {
            errors.push('main.saveChat.coalescing.reasonMix required')
          } else {
            for (const reason of FLUSH_REASONS) {
              if (!isFiniteNumber(co.reasonMix[reason])) {
                errors.push(`main.saveChat.coalescing.reasonMix.${reason} must be finite`)
              }
            }
          }
        }
      }
      if (sc.journal != null) {
        if (!isPlainObject(sc.journal)) {
          errors.push('main.saveChat.journal must be an object when present')
        } else {
          for (const field of CHAT_JOURNAL_STAT_FIELDS) {
            if (!isFiniteNumber(sc.journal[field])) {
              errors.push(`main.saveChat.journal.${field} must be finite`)
            }
          }
        }
      }
    }
    if (!isPlainObject(metrics.main.checkpointWriteBytes)) {
      errors.push('main.checkpointWriteBytes required')
    } else if (!isFiniteNumber(metrics.main.checkpointWriteBytes.total)) {
      errors.push('main.checkpointWriteBytes.total must be finite')
    }
    if (!isPlainObject(metrics.main.indexWriteBytes)) {
      errors.push('main.indexWriteBytes required')
    } else if (!isFiniteNumber(metrics.main.indexWriteBytes.total)) {
      errors.push('main.indexWriteBytes.total must be finite')
    }
    if (metrics.main.cpuTimeMs != null && !isFiniteNumber(metrics.main.cpuTimeMs)) {
      errors.push('main.cpuTimeMs must be finite when present')
    }
    if (
      metrics.main.persistenceSyncOver16msCount != null &&
      !isFiniteNumber(metrics.main.persistenceSyncOver16msCount)
    ) {
      errors.push('main.persistenceSyncOver16msCount must be finite when present')
    }
  }

  if (!isPlainObject(metrics.ipc)) {
    errors.push('ipc required')
  } else {
    for (const key of ['bytesTotal', 'bytesPerSecP95', 'snapshotRatio', 'rejectCount']) {
      if (!isFiniteNumber(metrics.ipc[key])) {
        errors.push(`ipc.${key} must be finite`)
      }
    }
    dualStatShape('ipc.ackLagMs', metrics.ipc.ackLagMs, errors)
  }

  if (!isPlainObject(metrics.renderer)) {
    errors.push('renderer required')
  } else {
    const r = metrics.renderer
    if (!isPlainObject(r.reactCommitMs) || !isFiniteNumber(r.reactCommitMs.p95)) {
      errors.push('renderer.reactCommitMs.p95 must be finite')
    }
    if (!isPlainObject(r.inputToPaintMs) || !isFiniteNumber(r.inputToPaintMs.p95)) {
      errors.push('renderer.inputToPaintMs.p95 must be finite')
    }
    if (!Array.isArray(r.longTasks)) errors.push('renderer.longTasks must be an array')
    if (!isFiniteNumber(r.hydratedFullChatCount)) {
      errors.push('renderer.hydratedFullChatCount must be finite')
    }
    if (!isFiniteNumber(r.hydratedMessageBytes)) {
      errors.push('renderer.hydratedMessageBytes must be finite')
    }
    if (r.cpuTimeMs != null && !isFiniteNumber(r.cpuTimeMs)) {
      errors.push('renderer.cpuTimeMs must be finite when present')
    }
    if (r.soakGrowthFraction != null && !isFiniteNumber(r.soakGrowthFraction)) {
      errors.push('renderer.soakGrowthFraction must be finite when present')
    }
    if (
      r.soakStartHydratedMessageBytes != null &&
      !isFiniteNumber(r.soakStartHydratedMessageBytes)
    ) {
      errors.push('renderer.soakStartHydratedMessageBytes must be finite when present')
    }
    if (r.soakEndHydratedMessageBytes != null && !isFiniteNumber(r.soakEndHydratedMessageBytes)) {
      errors.push('renderer.soakEndHydratedMessageBytes must be finite when present')
    }
  }

  if (!isPlainObject(metrics.gpu)) {
    errors.push('gpu required')
  } else {
    for (const key of ['utilPctP95', 'compositorLayerCountP95', 'animatedLayerCountP95']) {
      if (!isFiniteNumber(metrics.gpu[key])) {
        errors.push(`gpu.${key} must be finite`)
      }
    }
    if (metrics.gpu.occludedUtilPctP95 != null && !isFiniteNumber(metrics.gpu.occludedUtilPctP95)) {
      errors.push('gpu.occludedUtilPctP95 must be finite when present')
    }
  }

  if (!isPlainObject(metrics.correctness)) {
    errors.push('correctness required')
  } else {
    const c = metrics.correctness
    for (const key of CORRECTNESS_BOOL_KEYS) {
      if (typeof c[key] !== 'boolean') errors.push(`correctness.${key} must be boolean`)
    }
    if (!isFiniteNumber(c.dupCount)) errors.push('correctness.dupCount must be finite')
    if (!isFiniteNumber(c.missingCount)) errors.push('correctness.missingCount must be finite')
    if (!isFiniteNumber(c.durableAckClassMismatchCount)) {
      errors.push('correctness.durableAckClassMismatchCount must be finite')
    }
  }

  if (!isPlainObject(metrics.capabilities)) {
    errors.push('capabilities required')
  } else {
    for (const key of CAPABILITY_BOOL_KEYS) {
      if (typeof metrics.capabilities[key] !== 'boolean') {
        errors.push(`capabilities.${key} must be boolean`)
      }
    }
  }

  if (!isPlainObject(metrics.profiles)) {
    errors.push('profiles required')
  }

  return errors.length === 0 ? { ok: true, value: metrics } : { ok: false, errors }
}

function emptyPercentiles() {
  return { p50: 0, p95: 0, p99: 0, max: 0 }
}

function emptyDual() {
  return { p50: 0, p95: 0 }
}

function createEmptyCorrectness() {
  return {
    transcriptOrderOk: false,
    identityOk: false,
    terminalStateOk: false,
    dupCount: 0,
    missingCount: 0,
    exportParityOk: false,
    approvalsLedgerOk: false,
    historyDeletionOk: false,
    crashBarrierRecoveredOk: false,
    durableAckClassMismatchCount: 0
  }
}

function createEmptyCapabilities() {
  /** @type {Record<string, boolean>} */
  const caps = {}
  for (const key of CAPABILITY_BOOL_KEYS) caps[key] = false
  return caps
}

function createEmptyPerfMetrics() {
  return {
    main: {
      eventLoopLagMs: emptyPercentiles(),
      longTasks: [],
      saveChat: {
        count: 0,
        coalescedCount: 0,
        stringifyMs: emptyDual(),
        /** True when stringify duration cannot be observed externally (preload probe off / unsupported). */
        stringifyMsUnsupported: true,
        writeBytes: { total: 0, p95: 0 },
        fsyncMs: emptyDual()
      },
      checkpointWriteBytes: { total: 0 },
      indexWriteBytes: { total: 0 },
      heapRssBytes: { p95: 0, max: 0 },
      spawnReap: { spawnMsP95: 0, zombieOver500msCount: 0 },
      cpuTimeMs: 0,
      persistenceSyncOver16msCount: 0
    },
    ipc: {
      bytesTotal: 0,
      bytesPerSecP95: 0,
      ackLagMs: emptyDual(),
      snapshotRatio: 0,
      rejectCount: 0
    },
    renderer: {
      reactCommitMs: { p95: 0 },
      inputToPaintMs: { p95: 0 },
      longTasks: [],
      jsHeapUsedBytes: { p95: 0, max: 0 },
      rssBytes: { p95: 0, max: 0 },
      gc: { major: 0, minor: 0 },
      hydratedFullChatCount: 0,
      hydratedMessageBytes: 0,
      cpuTimeMs: 0,
      soakGrowthFraction: 0,
      soakStartHydratedMessageBytes: 0,
      soakEndHydratedMessageBytes: 0
    },
    gpu: {
      utilPctP95: 0,
      compositorLayerCountP95: 0,
      animatedLayerCountP95: 0,
      occludedUtilPctP95: 0
    },
    correctness: createEmptyCorrectness(),
    capabilities: createEmptyCapabilities(),
    profiles: {
      mainCpuProfilePath: null,
      rendererCpuProfilePath: null,
      heapSnapshotPaths: [],
      digests: null
    }
  }
}

/**
 * Path-string completeness only. Prefer validateProfileEvidenceArtifacts for truth claims.
 * @param {object} profiles
 */
function profilesEvidenceComplete(profiles) {
  if (!isPlainObject(profiles)) return false
  if (!isNonEmptyString(profiles.mainCpuProfilePath)) return false
  if (!isNonEmptyString(profiles.rendererCpuProfilePath)) return false
  if (!Array.isArray(profiles.heapSnapshotPaths) || profiles.heapSnapshotPaths.length < 1) {
    return false
  }
  return profiles.heapSnapshotPaths.every((p) => isNonEmptyString(p))
}

/**
 * Stat + SHA-256 profile artifacts. Path strings alone are insufficient.
 * @param {object} profiles
 * @param {{ statSync?: Function, readFileSync?: Function, createHash?: Function }} [fsAdapter]
 * @returns {{ ok: boolean, errors: string[], digests: object | null }}
 */
function validateProfileEvidenceArtifacts(profiles, fsAdapter = {}) {
  const errors = []
  if (!profilesEvidenceComplete(profiles)) {
    return {
      ok: false,
      errors: [
        'Refuse profile evidence: nonempty mainCpuProfilePath, rendererCpuProfilePath, and ≥1 heapSnapshotPaths required'
      ],
      digests: null
    }
  }

  const statSync = fsAdapter.statSync
  const readFileSync = fsAdapter.readFileSync
  const createHash = fsAdapter.createHash || ((algo) => crypto.createHash(algo))

  if (typeof statSync !== 'function' || typeof readFileSync !== 'function') {
    // Already-recorded digests (from a prior validated attach) may satisfy evaluation.
    if (
      isPlainObject(profiles.digests) &&
      isNonEmptyString(profiles.digests.mainCpuSha256) &&
      isNonEmptyString(profiles.digests.rendererCpuSha256) &&
      Array.isArray(profiles.digests.heapSha256) &&
      profiles.digests.heapSha256.length >= 1 &&
      profiles.digests.heapSha256.every((h) => isNonEmptyString(h)) &&
      isFiniteNumber(profiles.digests.mainCpuBytes) &&
      profiles.digests.mainCpuBytes >= MIN_PROFILE_BYTES &&
      isFiniteNumber(profiles.digests.rendererCpuBytes) &&
      profiles.digests.rendererCpuBytes >= MIN_PROFILE_BYTES &&
      Array.isArray(profiles.digests.heapBytes) &&
      profiles.digests.heapBytes.every((n) => isFiniteNumber(n) && n >= MIN_PROFILE_BYTES)
    ) {
      return { ok: true, errors: [], digests: profiles.digests }
    }
    return {
      ok: false,
      errors: [
        'Refuse profile evidence: fs adapters required to stat/hash artifacts, or profiles.digests must already record nontrivial SHA-256 + byte sizes'
      ],
      digests: null
    }
  }

  /**
   * @param {string} filePath
   * @param {string} label
   */
  function digestOne(filePath, label) {
    let st
    try {
      st = statSync(filePath)
    } catch (err) {
      errors.push(`${label} missing or unreadable: ${filePath}`)
      return null
    }
    const size = st && typeof st.size === 'number' ? st.size : 0
    if (size < MIN_PROFILE_BYTES) {
      errors.push(`${label} too small (${size} bytes; need ≥${MIN_PROFILE_BYTES}): ${filePath}`)
      return null
    }
    let buf
    try {
      buf = readFileSync(filePath)
    } catch (err) {
      errors.push(`${label} read failed: ${filePath}`)
      return null
    }
    const sha256 = createHash('sha256').update(buf).digest('hex')
    return { bytes: size, sha256 }
  }

  const main = digestOne(profiles.mainCpuProfilePath, 'mainCpuProfile')
  const renderer = digestOne(profiles.rendererCpuProfilePath, 'rendererCpuProfile')
  /** @type {{ bytes: number, sha256: string }[]} */
  const heaps = []
  for (let i = 0; i < profiles.heapSnapshotPaths.length; i++) {
    const h = digestOne(profiles.heapSnapshotPaths[i], `heapSnapshot[${i}]`)
    if (h) heaps.push(h)
  }

  if (errors.length > 0 || !main || !renderer || heaps.length < 1) {
    return { ok: false, errors, digests: null }
  }

  const digests = {
    mainCpuSha256: main.sha256,
    mainCpuBytes: main.bytes,
    rendererCpuSha256: renderer.sha256,
    rendererCpuBytes: renderer.bytes,
    heapSha256: heaps.map((h) => h.sha256),
    heapBytes: heaps.map((h) => h.bytes)
  }
  return { ok: true, errors: [], digests }
}

/**
 * Hot write bytes = chat + checkpoint + index write totals (mission amplifiers).
 * @param {object} metrics
 */
function hotWriteBytesTotal(metrics) {
  if (!isPlainObject(metrics) || !isPlainObject(metrics.main)) return 0
  const chat =
    metrics.main.saveChat && metrics.main.saveChat.writeBytes
      ? Number(metrics.main.saveChat.writeBytes.total) || 0
      : 0
  const ckpt =
    metrics.main.checkpointWriteBytes && isFiniteNumber(metrics.main.checkpointWriteBytes.total)
      ? metrics.main.checkpointWriteBytes.total
      : 0
  const index =
    metrics.main.indexWriteBytes && isFiniteNumber(metrics.main.indexWriteBytes.total)
      ? metrics.main.indexWriteBytes.total
      : 0
  return chat + ckpt + index
}

/**
 * Combined main + renderer CPU time (ms) for the identical-duration before/after gate.
 * @param {object} metrics
 */
function combinedCpuTimeMs(metrics) {
  if (!isPlainObject(metrics)) return 0
  const main = metrics.main && isFiniteNumber(metrics.main.cpuTimeMs) ? metrics.main.cpuTimeMs : 0
  const renderer =
    metrics.renderer && isFiniteNumber(metrics.renderer.cpuTimeMs) ? metrics.renderer.cpuTimeMs : 0
  return main + renderer
}

/**
 * Peak heap candidate: max of renderer RSS p95 and JS heap used p95.
 * @param {object} metrics
 */
function rendererHeapCandidateBytes(metrics) {
  if (!isPlainObject(metrics) || !isPlainObject(metrics.renderer)) return 0
  const rss =
    metrics.renderer.rssBytes && isFiniteNumber(metrics.renderer.rssBytes.p95)
      ? metrics.renderer.rssBytes.p95
      : 0
  const js =
    metrics.renderer.jsHeapUsedBytes && isFiniteNumber(metrics.renderer.jsHeapUsedBytes.p95)
      ? metrics.renderer.jsHeapUsedBytes.p95
      : 0
  return Math.max(rss, js)
}

/**
 * Numeric G-perf evaluation. Requires authoritative baselines on both reports.
 * @param {object} report
 * @param {object} baselineReport
 * @returns {{ gPerf: boolean, details: object, refuseReasons: string[] }}
 */
function evaluateNumericPerfGates(report, baselineReport) {
  const T = PERF_GATE_THRESHOLDS
  /** @type {string[]} */
  const refuseReasons = []
  /** @type {Record<string, unknown>} */
  const details = {}

  if (!isPlainObject(report) || !isPlainObject(baselineReport)) {
    return {
      gPerf: false,
      details,
      refuseReasons: ['report and baselineReport required for numeric gPerf']
    }
  }
  if (!report.environment || report.environment.authoritativeBaseline !== true) {
    refuseReasons.push('after report must have authoritativeBaseline=true')
  }
  if (!baselineReport.environment || baselineReport.environment.authoritativeBaseline !== true) {
    refuseReasons.push('baseline report must have authoritativeBaseline=true')
  }
  if (refuseReasons.length > 0) {
    return { gPerf: false, details, refuseReasons }
  }

  const after = report.metrics
  const before = baselineReport.metrics
  if (!isPlainObject(after) || !isPlainObject(before)) {
    return { gPerf: false, details, refuseReasons: ['metrics required on both reports'] }
  }

  // T9a — CLOSE THE SATISFIABLE-BY-OMISSION HAZARD.
  //
  // `main.saveChat.coalescing` is optional at VALIDATION time so the frozen T2
  // baseline — captured before these probes existed, and the denominator for
  // every comparison — keeps validating. But optional-everywhere means a
  // comparison run whose sampler silently failed would ship an absent block,
  // validate cleanly, and still be read as evidence. So the AFTER side of a
  // comparison must CARRY the block. The baseline side stays exempt by design:
  // requiring it there would retroactively invalidate the only denominator we
  // have.
  const afterCoalescing =
    isPlainObject(after.main) && isPlainObject(after.main.saveChat)
      ? after.main.saveChat.coalescing
      : undefined
  if (!isPlainObject(afterCoalescing)) {
    refuseReasons.push(
      'after report must carry measured main.saveChat.coalescing — an absent block means the sampler did not run, not that coalescing did nothing'
    )
  } else if (!isPlainObject(afterCoalescing.reasonMix)) {
    refuseReasons.push('after report main.saveChat.coalescing.reasonMix required for attribution')
  }
  // Deliberately NOT an early return: a run can be refused for several
  // independent reasons at once, and reporting only the first would send the
  // next lane round the loop fixing them one at a time.

  // stringify timing: if unsupported on either side, refuse rather than invent numbers
  if (after.main && after.main.saveChat && after.main.saveChat.stringifyMsUnsupported === true) {
    refuseReasons.push(
      'main.saveChat.stringifyMsUnsupported=true — T2 must capture stringify timing or leave gate failed; do not invent values'
    )
  }

  const beforeWrite = hotWriteBytesTotal(before)
  const afterWrite = hotWriteBytesTotal(after)
  details.beforeHotWriteBytes = beforeWrite
  details.afterHotWriteBytes = afterWrite
  const writeReduction = beforeWrite > 0 ? 1 - afterWrite / beforeWrite : afterWrite === 0 ? 1 : 0
  details.hotWriteByteReduction = writeReduction
  const writeOk = beforeWrite > 0 && writeReduction >= T.minHotWriteByteReduction
  details.hotWriteByteReductionOk = writeOk
  if (!writeOk) {
    refuseReasons.push(
      `hot write-byte reduction ${writeReduction.toFixed(4)} < ${T.minHotWriteByteReduction}`
    )
  }

  const beforeCpu = combinedCpuTimeMs(before)
  const afterCpu = combinedCpuTimeMs(after)
  details.beforeCombinedCpuTimeMs = beforeCpu
  details.afterCombinedCpuTimeMs = afterCpu
  const cpuSpeedup = afterCpu > 0 ? beforeCpu / afterCpu : beforeCpu > 0 ? Infinity : 0
  details.combinedCpuSpeedup = cpuSpeedup
  const cpuOk = beforeCpu > 0 && afterCpu > 0 && cpuSpeedup >= T.minCombinedCpuSpeedup
  details.combinedCpuSpeedupOk = cpuOk
  if (!cpuOk) {
    refuseReasons.push(
      `combined CPU speedup ${cpuSpeedup === Infinity ? 'inf' : cpuSpeedup.toFixed(4)} < ${T.minCombinedCpuSpeedup} (need identical-duration filled cpuTimeMs)`
    )
  }

  const syncOver =
    after.main && isFiniteNumber(after.main.persistenceSyncOver16msCount)
      ? after.main.persistenceSyncOver16msCount
      : null
  details.persistenceSyncOver16msCount = syncOver
  const syncOk = syncOver === 0
  details.persistenceSyncOk = syncOk
  if (!syncOk) {
    refuseReasons.push(
      `persistence sync tasks >${T.maxPersistenceSyncTaskMs}ms must be 0 (got ${syncOver})`
    )
  }

  const lagP95 =
    after.main && after.main.eventLoopLagMs && isFiniteNumber(after.main.eventLoopLagMs.p95)
      ? after.main.eventLoopLagMs.p95
      : null
  details.eventLoopLagP95Ms = lagP95
  const lagOk = lagP95 != null && lagP95 < T.maxEventLoopLagP95Ms
  details.eventLoopLagOk = lagOk
  if (!lagOk) {
    refuseReasons.push(`eventLoopLagMs.p95 ${lagP95} must be < ${T.maxEventLoopLagP95Ms}`)
  }

  const paintP95 =
    after.renderer &&
    after.renderer.inputToPaintMs &&
    isFiniteNumber(after.renderer.inputToPaintMs.p95)
      ? after.renderer.inputToPaintMs.p95
      : null
  details.inputToPaintP95Ms = paintP95
  const paintOk = paintP95 != null && paintP95 < T.maxInputToPaintP95Ms
  details.inputToPaintOk = paintOk
  if (!paintOk) {
    refuseReasons.push(`inputToPaintMs.p95 ${paintP95} must be < ${T.maxInputToPaintP95Ms}`)
  }

  const afterHeap = rendererHeapCandidateBytes(after)
  const beforeHeap = rendererHeapCandidateBytes(before)
  details.afterHeapBytes = afterHeap
  details.beforeHeapBytes = beforeHeap
  const heapReduction = beforeHeap > 0 ? 1 - afterHeap / beforeHeap : 0
  details.heapReduction = heapReduction
  const heapAbsOk = afterHeap > 0 && afterHeap <= T.maxHeapBytes
  const heapRelOk = beforeHeap > 0 && heapReduction >= T.minHeapReduction
  const heapOk = heapAbsOk || heapRelOk
  details.heapOk = heapOk
  if (!heapOk) {
    refuseReasons.push(
      `heap ${afterHeap} must be ≤${T.maxHeapBytes} OR reduction ≥${T.minHeapReduction} (got ${heapReduction.toFixed(4)})`
    )
  }

  const growth =
    after.renderer && isFiniteNumber(after.renderer.soakGrowthFraction)
      ? after.renderer.soakGrowthFraction
      : null
  details.soakGrowthFraction = growth
  const growthOk = growth != null && growth < T.maxSoakGrowthFraction
  details.soakGrowthOk = growthOk
  if (!growthOk) {
    refuseReasons.push(`soakGrowthFraction ${growth} must be < ${T.maxSoakGrowthFraction}`)
  }

  const occluded =
    after.gpu && isFiniteNumber(after.gpu.occludedUtilPctP95) ? after.gpu.occludedUtilPctP95 : null
  details.occludedUtilPctP95 = occluded
  const occludedOk = occluded != null && occluded <= T.maxOccludedGpuUtilPct
  details.occludedGpuOk = occludedOk
  if (!occludedOk) {
    refuseReasons.push(`occluded GPU util p95 ${occluded} must be ≤ ${T.maxOccludedGpuUtilPct}`)
  }

  const zombies =
    after.main && after.main.spawnReap && isFiniteNumber(after.main.spawnReap.zombieOver500msCount)
      ? after.main.spawnReap.zombieOver500msCount
      : null
  details.zombieOver500msCount = zombies
  const zombieOk = zombies === T.maxZombieOver500msCount
  details.zombieOk = zombieOk
  if (!zombieOk) {
    refuseReasons.push(`zombieOver500msCount must be 0 (got ${zombies})`)
  }

  // gCorrect / gCap must also hold on the after report for an overall gPerf pass
  const c = after.correctness
  const caps = after.capabilities
  const correctOk =
    isPlainObject(c) &&
    CORRECTNESS_BOOL_KEYS.every((k) => c[k] === true) &&
    c.dupCount === 0 &&
    c.missingCount === 0 &&
    c.durableAckClassMismatchCount === 0
  const capOk = isPlainObject(caps) && CAPABILITY_BOOL_KEYS.every((k) => caps[k] === true)
  details.gCorrectRequiredOk = correctOk
  details.gCapRequiredOk = capOk
  if (!correctOk)
    refuseReasons.push(
      'gPerf requires gCorrect booleans all true with zero dups/missing/ack mismatch'
    )
  if (!capOk) refuseReasons.push('gPerf requires gCap capability booleans all true')

  const gPerf =
    refuseReasons.length === 0 &&
    writeOk &&
    cpuOk &&
    syncOk &&
    lagOk &&
    paintOk &&
    heapOk &&
    growthOk &&
    occludedOk &&
    zombieOk &&
    correctOk &&
    capOk

  return { gPerf, details, refuseReasons }
}

/**
 * Evaluate gates. Refuses any pass / metricsCollected claim without verified profile
 * artifacts (stat + SHA-256 or pre-recorded digests) and matching fixture fingerprints.
 * Numeric gPerf requires authoritativeBaseline=true on both reports.
 * @param {object} input
 */
function evaluatePerfGates(input) {
  const errors = []
  const report = input && input.report
  const baseline = input && input.baselineReport
  if (!isPlainObject(report)) {
    return { ok: false, errors: ['report required'], gates: null }
  }
  if (!isPlainObject(report.metrics) || !isPlainObject(report.environment)) {
    return { ok: false, errors: ['report.metrics and report.environment required'], gates: null }
  }

  const fsAdapter = input && input.fsAdapter ? input.fsAdapter : {}
  const profileCheck = validateProfileEvidenceArtifacts(report.metrics.profiles, fsAdapter)
  const profilesOk = profileCheck.ok
  if (!profilesOk) {
    errors.push(...profileCheck.errors)
  } else if (profileCheck.digests && isPlainObject(report.metrics.profiles)) {
    report.metrics.profiles.digests = profileCheck.digests
  }

  const fixtureFp =
    report.fixture && isNonEmptyString(report.fixture.fingerprint)
      ? report.fixture.fingerprint
      : null
  if (!fixtureFp) errors.push('report.fixture.fingerprint required for gate evaluation')

  if (baseline) {
    const baseFp =
      baseline.fixture && isNonEmptyString(baseline.fixture.fingerprint)
        ? baseline.fixture.fingerprint
        : null
    if (!baseFp || baseFp !== fixtureFp) {
      errors.push('before/after fixture fingerprints must be identical')
    }
    if (
      baseline.environment &&
      report.environment &&
      baseline.environment.workload !== report.environment.workload
    ) {
      errors.push('before/after workloads must match')
    }
    if (
      baseline.environment &&
      report.environment &&
      baseline.environment.seed !== report.environment.seed
    ) {
      errors.push('before/after seeds must match')
    }
    if (baseline.environment && baseline.environment.authoritativeBaseline !== true) {
      errors.push('baseline authoritativeBaseline must be true for gate comparison')
    }
    if (report.environment.authoritativeBaseline !== true) {
      errors.push('after authoritativeBaseline must be true for gate comparison')
    }
    if (isPlainObject(baseline.metrics) && isPlainObject(baseline.metrics.profiles)) {
      const baseProfiles = validateProfileEvidenceArtifacts(baseline.metrics.profiles, fsAdapter)
      if (!baseProfiles.ok) {
        errors.push(...baseProfiles.errors.map((e) => `baseline: ${e}`))
      } else if (baseProfiles.digests) {
        baseline.metrics.profiles.digests = baseProfiles.digests
      }
    }
  }

  const metricsCollectedClaim = Boolean(input.claimMetricsCollected)
  if (metricsCollectedClaim && !profilesOk) {
    errors.push('metricsCollected=true refused without verified profile/heap evidence')
  }

  const gates = {
    evaluated: errors.length === 0,
    profilesEvidenceOk: profilesOk,
    fixtureFingerprintOk: Boolean(fixtureFp),
    baselineFingerprintMatch:
      !baseline ||
      (Boolean(fixtureFp) &&
        Boolean(baseline.fixture && baseline.fixture.fingerprint === fixtureFp)),
    authoritativeBaseline: Boolean(report.environment.authoritativeBaseline),
    metricsCollectedAllowed: profilesOk && errors.length === 0,
    gCorrect: null,
    gCap: null,
    gPerf: null,
    gPerfDetails: null,
    refuseReasons: errors.slice()
  }

  if (errors.length > 0) {
    return { ok: false, errors, gates }
  }

  const c = report.metrics.correctness
  gates.gCorrect =
    CORRECTNESS_BOOL_KEYS.every((k) => c[k] === true) &&
    c.dupCount === 0 &&
    c.missingCount === 0 &&
    c.durableAckClassMismatchCount === 0

  const caps = report.metrics.capabilities
  gates.gCap = CAPABILITY_BOOL_KEYS.every((k) => caps[k] === true)

  if (baseline && isPlainObject(baseline.metrics)) {
    const numeric = evaluateNumericPerfGates(report, baseline)
    gates.gPerf = numeric.gPerf
    gates.gPerfDetails = numeric.details
    if (numeric.refuseReasons.length > 0) {
      gates.refuseReasons = gates.refuseReasons.concat(numeric.refuseReasons)
    }
  } else {
    // null until a named authoritative baseline comparison is supplied
    gates.gPerf = null
  }

  return { ok: true, errors: [], gates }
}

/**
 * @param {object} env
 * @param {object} [metrics]
 */
function createPerfReport(env, metrics = createEmptyPerfMetrics()) {
  const envCheck = validatePerfEnvironment(env)
  if (!envCheck.ok) {
    const err = new Error(`Invalid perf environment: ${envCheck.errors.join('; ')}`)
    err.errors = envCheck.errors
    throw err
  }
  const metricsCheck = validatePerfMetrics(metrics)
  if (!metricsCheck.ok) {
    const err = new Error(`Invalid perf metrics: ${metricsCheck.errors.join('; ')}`)
    err.errors = metricsCheck.errors
    throw err
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    environment: env,
    metrics,
    gates: null
  }
}

module.exports = {
  SCHEMA_VERSION,
  WORKLOADS,
  FX_POSTURES,
  MATERIALIZE_MODES,
  CORRECTNESS_BOOL_KEYS,
  CAPABILITY_BOOL_KEYS,
  PERF_GATE_THRESHOLDS,
  MIN_PROFILE_BYTES,
  validatePerfEnvironment,
  validatePerfMetrics,
  createEmptyPerfMetrics,
  createEmptyCorrectness,
  createEmptyCapabilities,
  createPerfReport,
  profilesEvidenceComplete,
  validateProfileEvidenceArtifacts,
  hotWriteBytesTotal,
  combinedCpuTimeMs,
  rendererHeapCandidateBytes,
  evaluateNumericPerfGates,
  evaluatePerfGates
}
