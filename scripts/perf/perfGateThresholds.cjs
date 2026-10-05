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
 * The rewrite's phase exits, judged per measured live window on the baseline
 * workload (`phaseExits.cjs`). A share is a fraction of the main thread's
 * time inside the window.
 */
const PHASE_EXIT_THRESHOLDS = Object.freeze({
  /**
   * "No sync on the main thread." Not zero: the profile is sampled about
   * every 2 ms, so one stray sync would fail a phase. A thousandth of a
   * 120 s window is 120 ms, about ten syncs at the 10 to 14 ms each holds the
   * thread on the reference machine. The smallest store that syncs per save
   * or per event costs over ten times that (run events, 1.3%); all of them
   * together cost 23 to 25%.
   */
  maxMainSyncShare: 0.001,
  /**
   * "No whole-thread reads on the main thread." The same thousandth: about
   * four reads at the 30 ms one holds the thread on average there (a read of
   * the 31 MiB record takes up to 90 ms), against 24 to 26% today.
   */
  maxMainWholeThreadReadShare: 0.001,
  /** The main thread is busy for less than this share of the window. */
  maxMainBusyShare: 0.25,
  /** Bytes written for the heavy thread, as a fraction of the baseline's. */
  maxHeavyThreadBytesOfBaseline: 0.01,
  /** Main-loop delay p95 stays under this (ms): the gate above, per window. */
  maxMainLoopDelayP95Ms: PERF_GATE_THRESHOLDS.maxEventLoopLagP95Ms
})

/**
 * Barrier durability's exits (`durabilityExits.cjs`), judged per measured
 * window of the captures of an off-against-on pair that had the switch on.
 */
const DURABILITY_EXIT_THRESHOLDS = Object.freeze({
  /**
   * Syncs of the thread's stores on the main thread (the journal's appends,
   * run events, tool detail, catalogue publication): the phase exits' "no
   * sync" tolerance, a few stray samples. The journal's checkpoints are not
   * in it: barrier durability leaves them synced where they are written.
   */
  maxThreadStoreSyncShare: PHASE_EXIT_THRESHOLDS.maxMainSyncShare,
  /** Syncs on the main thread that no owner is named for: none. */
  maxUnnamedSyncShare: 0,
  /** The main thread held in `Atomics.wait` (a synchronous wait on a sync off it): none. */
  maxSynchronousWaitShare: 0,
  /** A user message, an approval or answer, a destructive change: p95 of its barrier wait (ms). */
  maxUserFacingBarrierWaitP95Ms: 50,
  /** A run's final record: p95 of its barrier wait (ms). */
  maxRunFinalBarrierWaitP95Ms: 250
})

/**
 * PROPOSED, UNRATIFIED cross-thread bounds: no gate consumes these before
 * Boss ratification at M1 exit. The seven acceptance rows have eight fields
 * because the async-writer row specifies both byte capacity and fallbacks.
 *
 * Enumeration and JSON expose the eight canonical fields below. Legacy names
 * remain available through non-enumerable readonly aliases for property access;
 * their old JSON shape is intentionally not preserved.
 */
const proposedCrossThreadBounds = {
  roundStartDeltaMs: 250,
  persistBarrierDeltaMs: 300,
  controlResponseMs: 300,
  hostQueueWaitUnrelatedMs: 50,
  hostEventLoopLagP95Ms: 25,
  mainEventLoopLagP95Ms: PERF_GATE_THRESHOLDS.maxEventLoopLagP95Ms,
  asyncWriterQueueBytesCap: 'configured',
  fallbackCounterMax: 0
}

// Preserve the names used by the first M1 harness without adding extra bounds.
for (const [legacy, canonical] of Object.entries({
  maxRoundStartLatencyOverLightAloneP95Ms: 'roundStartDeltaMs',
  maxPersistenceBarrierOverLightAloneP95Ms: 'persistBarrierDeltaMs',
  maxControlResponseEndToEndP95Ms: 'controlResponseMs',
  maxHostQueueWaitUnrelatedCommandP95Ms: 'hostQueueWaitUnrelatedMs',
  maxHostEventLoopLagP95Ms: 'hostEventLoopLagP95Ms',
  maxAsyncWriterFallbackCount: 'fallbackCounterMax'
})) {
  Object.defineProperty(proposedCrossThreadBounds, legacy, {
    enumerable: false,
    get: () => proposedCrossThreadBounds[canonical]
  })
}
Object.defineProperty(proposedCrossThreadBounds, 'requireAsyncWriterQueueBytesWithinCap', {
  enumerable: false,
  get: () => proposedCrossThreadBounds.asyncWriterQueueBytesCap === 'configured'
})

const PROPOSED_CROSS_THREAD_BOUNDS = Object.freeze(proposedCrossThreadBounds)

module.exports = {
  BYTES_1_5_GIB,
  BYTES_20_GIB,
  DURABILITY_EXIT_THRESHOLDS,
  MIN_PROFILE_BYTES,
  PERF_GATE_THRESHOLDS,
  PHASE_EXIT_THRESHOLDS,
  PROPOSED_CROSS_THREAD_BOUNDS
}
