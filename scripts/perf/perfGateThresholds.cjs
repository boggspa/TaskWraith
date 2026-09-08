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

/**
 * §1.1 proposed G-X cross-thread bounds (Independent Threads Programme) —
 * NOT ratified, NOT enforced. They are deliberately kept OUT of
 * PERF_GATE_THRESHOLDS: evaluatePerfGates consumes that map, and an
 * unratified number must never fail a run. Ratification is an M1-exit
 * amendment recorded in the programme doc by the programme owner, after the
 * paired light-alone/light-beside baselines exist.
 *
 * `...OverLightAloneP95Ms` bounds are deltas against the paired light-alone
 * run of the SAME matrix cell (scripts/perf/interferenceMatrix.cjs), not
 * absolutes.
 */
const PROPOSED_CROSS_THREAD_BOUNDS = Object.freeze({
  /** Round start (composer send → first participant dispatch) over light-alone p95 (ms). */
  maxRoundStartLatencyOverLightAloneP95Ms: 250,
  /** Persistence barrier (awaitChatRecordPersisted) over light-alone p95 (ms). */
  maxPersistenceBarrierOverLightAloneP95Ms: 300,
  /** Control response (cancel / approval / answer) end-to-end p95 (ms), Desktop + Host-native. */
  maxControlResponseEndToEndP95Ms: 300,
  /** Host command queue wait p95 for a command on an unrelated thread (ms). */
  maxHostQueueWaitUnrelatedCommandP95Ms: 50,
  /** Host event-loop lag p95 under heavy-thread load (ms); the Host had no meter before M1. */
  maxHostEventLoopLagP95Ms: 25,
  /** Async-writer queue bytes must stay within the configured cap (boolean requirement). */
  requireAsyncWriterQueueBytesWithinCap: true,
  /** Fallback counters at zero — asynchronous accumulation guard. */
  maxAsyncWriterFallbackCount: 0
})

module.exports = {
  BYTES_1_5_GIB,
  BYTES_20_GIB,
  MIN_PROFILE_BYTES,
  PERF_GATE_THRESHOLDS,
  PROPOSED_CROSS_THREAD_BOUNDS
}
