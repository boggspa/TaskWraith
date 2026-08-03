'use strict'

/**
 * ADR §7 measurement schema for the TaskWraith performance epic (T1 hardened).
 * Pure validators + empty report factories + gate evaluation — no Electron, no live userData.
 */

const WORKLOADS = Object.freeze(['30seat', '50seat', 'dual_run', '455_soak', '50_chat_switch'])

const FX_POSTURES = Object.freeze([
  'cinematic_default',
  'fx_off_refraction_on',
  'solid_reduce_transparency',
  'reduce_motion'
])

const MATERIALIZE_MODES = Object.freeze(['legacy_v1', 'future_v2'])

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
  }

  if (!isPlainObject(metrics.gpu)) {
    errors.push('gpu required')
  } else {
    for (const key of ['utilPctP95', 'compositorLayerCountP95', 'animatedLayerCountP95']) {
      if (!isFiniteNumber(metrics.gpu[key])) {
        errors.push(`gpu.${key} must be finite`)
      }
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
        writeBytes: { total: 0, p95: 0 },
        fsyncMs: emptyDual()
      },
      checkpointWriteBytes: { total: 0 },
      indexWriteBytes: { total: 0 },
      heapRssBytes: { p95: 0, max: 0 },
      spawnReap: { spawnMsP95: 0, zombieOver500msCount: 0 }
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
      hydratedMessageBytes: 0
    },
    gpu: {
      utilPctP95: 0,
      compositorLayerCountP95: 0,
      animatedLayerCountP95: 0
    },
    correctness: createEmptyCorrectness(),
    capabilities: createEmptyCapabilities(),
    profiles: {
      mainCpuProfilePath: null,
      rendererCpuProfilePath: null,
      heapSnapshotPaths: []
    }
  }
}

/**
 * Profiles must be non-empty main+renderer JS CPU profiles plus ≥1 heap snapshot
 * before metricsCollected / gate evaluation may claim truth.
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
 * Evaluate gates. Refuses any pass / metricsCollected claim without profile evidence
 * and matching fixture fingerprints when a baseline is supplied.
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

  const profilesOk = profilesEvidenceComplete(report.metrics.profiles)
  if (!profilesOk) {
    errors.push(
      'Refuse gate claims: nonempty mainCpuProfilePath, rendererCpuProfilePath, and ≥1 heapSnapshotPaths required'
    )
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
  }

  const metricsCollectedClaim = Boolean(input.claimMetricsCollected)
  if (metricsCollectedClaim && !profilesOk) {
    errors.push('metricsCollected=true refused without profile/heap evidence')
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

  // Perf numeric gates stay null until a named baseline comparison is supplied with filled metrics.
  gates.gPerf = baseline && isPlainObject(baseline.metrics) ? false : null

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
  validatePerfEnvironment,
  validatePerfMetrics,
  createEmptyPerfMetrics,
  createEmptyCorrectness,
  createEmptyCapabilities,
  createPerfReport,
  profilesEvidenceComplete,
  evaluatePerfGates
}
