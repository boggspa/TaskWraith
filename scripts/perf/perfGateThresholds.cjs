'use strict'

/**
 * Named numeric G-perf thresholds (Boss / mission freeze).
 * Pure constants — evaluatePerfGates consumes these; collectors fill metrics.
 */

const BYTES_1_5_GIB = 1.5 * 1024 * 1024 * 1024
const BYTES_20_GIB = 20 * 1024 * 1024 * 1024

/** Minimum nontrivial profile / heap artifact size (bytes). */
const MIN_PROFILE_BYTES = 256

const PERF_GATE_THRESHOLDS = Object.freeze({
  /** Hot write-byte reduction vs authoritative baseline (fraction). */
  minHotWriteByteReduction: 0.95,
  /** Combined main+renderer CPU-time speedup vs baseline (ratio). */
  minCombinedCpuSpeedup: 3,
  /** Persistence sync tasks longer than this fail the gate. */
  maxPersistenceSyncTaskMs: 16,
  /** Main event-loop lag p95 ceiling (ms). */
  maxEventLoopLagP95Ms: 25,
  /** Renderer input-to-paint p95 ceiling (ms). */
  maxInputToPaintP95Ms: 100,
  /** Absolute renderer RSS / JS heap ceiling (bytes). */
  maxHeapBytes: BYTES_1_5_GIB,
  /** Alternate heap pass: reduction vs baseline (fraction). */
  minHeapReduction: 0.65,
  /** Max hydrated-message-byte growth over the 60-minute soak (fraction). */
  maxSoakGrowthFraction: 0.1,
  /** Occluded GPU util p95 ceiling (percent). */
  maxOccludedGpuUtilPct: 20,
  /** Zombie children over 500ms must be zero. */
  maxZombieOver500msCount: 0,
  minProfileBytes: MIN_PROFILE_BYTES,
  /** Free disk space required on artifact volume before launch (bytes). */
  minFreeDiskBytes: BYTES_20_GIB,
  /** Max total wall-clock ms for the post-replay capture phase (profile stop + heap snapshot). */
  maxCapturePhaseMs: 5 * 60 * 1000,
  /** Sliding-window duration for windowed evt/s rate (ms). */
  windowedRateWindowMs: 60 * 1000
})

module.exports = {
  BYTES_1_5_GIB,
  BYTES_20_GIB,
  MIN_PROFILE_BYTES,
  PERF_GATE_THRESHOLDS
}
