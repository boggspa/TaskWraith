'use strict'

/**
 * Honest unsupported / partial metric annotations for T2 reports.
 * Never invent zeros for unobservable signals; mark them explicitly.
 */

/**
 * Fields that T2 cannot observe without production instrumentation / GPU counters.
 * @returns {object}
 */
function createUnsupportedObservationLedger() {
  return {
    checkpointIntegratedPath: {
      status: 'unsupported',
      reason:
        'SessionCheckpointStore rewrite bytes are not exposed on the renderer getChat/saveChat surface; require main probe or fs watch on exact instance userData'
    },
    integratedOrchestratorSignals: {
      status: 'unsupported',
      reason:
        'EnsembleOrchestrator live fan-out ticks are not driven by fixture replay; do not invent orchestrator lag/CPU'
    },
    compositorLayerCountP95: {
      status: 'unsupported',
      reason:
        'Compositor layer counts require Chromium tracing / GPU process counters not attached in source-independent T2 adapters'
    },
    animatedLayerCountP95: {
      status: 'unsupported',
      reason: 'Animated layer counts unobservable without compositor tracing'
    },
    occludedUtilPctP95: {
      status: 'partial',
      reason:
        'occluded GPU util requires occlude schedule + sampleGpuUtilPct adapter during attach; unmarked until collected'
    },
    spawnMsP95: {
      status: 'unsupported',
      reason:
        'Production has no spawn timing instrument yet; report unsupported rather than invent 0 (matches T1b fail-closed)'
    },
    stringifyMs: {
      status: 'unsupported',
      reason:
        'stringify duration requires PERF_PRELOAD_PROBE=1 production probe; default stringifyMsUnsupported=true'
    },
    mainEventLoopLagFromInspector: {
      status: 'partial',
      reason: 'Lag samples require attach-time OS/perf probe JSONL; empty until collectors run'
    }
  }
}

/**
 * Apply unsupported annotations onto empty metrics without inventing success.
 * Leaves numeric zeros from createEmptyPerfMetrics as schema placeholders but
 * records observation ledger so gates refuse false completeness claims.
 * @param {object} metrics — createEmptyPerfMetrics()
 * @param {object} [ledger]
 */
function applyUnsupportedAnnotations(metrics, ledger = createUnsupportedObservationLedger()) {
  const next = metrics
  next.main.saveChat.stringifyMsUnsupported = true
  // Do not claim spawnMsP95=0 is measured
  if (!next.main.spawnReapObservations) {
    next.main.spawnReapObservations = {
      spawnMsP95: ledger.spawnMsP95,
      zombieOver500msCount: {
        status: 'partial',
        reason: 'Requires listZombies adapter during attach sampling windows'
      }
    }
  }
  next.gpuObservations = {
    utilPctP95: { status: 'partial', reason: 'Requires sampleGpuUtilPct during attach' },
    compositorLayerCountP95: ledger.compositorLayerCountP95,
    animatedLayerCountP95: ledger.animatedLayerCountP95,
    occludedUtilPctP95: ledger.occludedUtilPctP95
  }
  next.observationLedger = ledger
  return next
}

/**
 * Mark report as metricsCollected=false when required profiles missing.
 * @param {object} report
 * @param {object} [extra]
 */
function finalizePartialT2Report(report, extra = {}) {
  report.observationLedger =
    (report.metrics && report.metrics.observationLedger) || createUnsupportedObservationLedger()
  report.status = {
    ...(report.status || {}),
    phase: extra.phase || 'T2-runner',
    metricsCollected: false,
    profilesCaptured: Boolean(extra.profilesCaptured),
    electronLaunched: Boolean(extra.electronLaunched),
    note:
      extra.note ||
      'T2 runner emitted explicit unsupported/partial fields for unobservable signals; refuse metricsCollected until attach artifacts + digests exist'
  }
  return report
}

module.exports = {
  createUnsupportedObservationLedger,
  applyUnsupportedAnnotations,
  finalizePartialT2Report
}
