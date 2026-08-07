'use strict'
/* eslint-disable no-irregular-whitespace -- preserve the diagnostic prose's typography. */

/**
 * Frame-cadence triage harness — correlates renderer frame misses with
 * main-process event-loop lag during live ensemble fan-out.
 *
 * Produces the single decision number that gates Phase 2 GPU/compositing vs
 * main-process work:
 *
 *   Of frames that miss 60 Hz budget (>20 ms), what % overlap a main
 *   event-loop lag spike (>10 ms lag) or a renderer long-task (>50 ms)
 *   within ±50 ms?
 *
 *   >60%  → main-first   (Path A)
 *   <30%  with paint/composite high → compositor-first (Path B)
 *   between → mixed      (Path C)
 *
 * Guarded behind TASKWRAITH_FRAME_CADENCE_TRIAGE=1 so CI never runs it.
 *
 * Reuses the existing CDP session infrastructure (cdpWebSocketSession.cjs)
 * and the event-ingestion schema (eventIngestion.cjs).
 *
 * TWO THINGS THAT WILL BITE (per @SolBoss):
 *   1. V8 CPU profiles DO NOT SEE fsync or compositor wait. Measure LAG,
 *      not CPU, or you will conclude main is idle while the app stutters.
 *   2. Report the INSTRUMENT'S OWN overhead separately. A rAF logger that
 *      costs 3 ms a frame invents the very jank it claims to find.
 */

// ---------------------------------------------------------------------------
// Gate: disabled by default so CI never runs this (and never accidentally
// attaches CDP to a build agent).
// ---------------------------------------------------------------------------

const TRIAGE_ENV_FLAG = 'TASKWRAITH_FRAME_CADENCE_TRIAGE'

/**
 * @param {object} [env]
 * @returns {boolean}
 */
function isFrameCadenceTriageEnabled(env = process.env) {
  const raw = env && env[TRIAGE_ENV_FLAG]
  if (raw == null || raw === '') return false
  return raw === '1' || raw === 'true'
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Frame budget at 60 Hz, in milliseconds. */
const FRAME_BUDGET_MS = 16.667

/** Frames taking longer than this are counted as a miss. */
const DEFAULT_MISS_THRESHOLD_MS = 20

/** Correlation window: ± this many ms around a frame miss. */
const DEFAULT_CORRELATION_WINDOW_MS = 50

/** Main event-loop lag above this is a spike. */
const DEFAULT_MAIN_LAG_SPIKE_THRESHOLD_MS = 10

/** Renderer long-task above this is significant. */
const DEFAULT_LONG_TASK_THRESHOLD_MS = 50

/** Default collection window (seconds). */
const DEFAULT_COLLECTION_WINDOW_S = 30

/** Maximum ring-buffer entries per probe before culling oldest. */
const MAX_RING_ENTRIES = 20_000

// ---------------------------------------------------------------------------
// Renderer-side probe (injected via CDP Runtime.evaluate)
// ---------------------------------------------------------------------------

/**
 * Expression that installs the renderer frame-cadence probe into
 * `window.__TASKWRAITH_FRAME_PROBE__`.
 *
 * Idempotent — re-evaluating starts a fresh probe and discards the old one.
 */
const RENDERER_PROBE_INSTALL_EXPR = `
(function() {
  const existing = window.__TASKWRAITH_FRAME_PROBE__;
  if (existing && existing.stop) existing.stop();

  const MAX_RING = ${MAX_RING_ENTRIES};
  const probe = {
    frameDeltas: [],
    longTasks: [],
    running: false,
    rafId: null,
    observer: null,
    overheadUs: 0,
    startedAtWallMs: 0,
    startedAtPerfMs: 0,

    start() {
      if (this.running) return;
      this.running = true;
      this.startedAtWallMs = Date.now();
      this.startedAtPerfMs = performance.now();
      let lastRaf = performance.now();

      const tick = (now) => {
        if (!this.running) return;
        const t0 = performance.now();
        const deltaMs = now - lastRaf;
        lastRaf = now;
        this.frameDeltas.push({ ts: now, deltaMs: Math.max(0, deltaMs) });
        if (this.frameDeltas.length > MAX_RING) this.frameDeltas.shift();
        this.overheadUs += Math.max(0, (performance.now() - t0) * 1000);
        this.rafId = requestAnimationFrame(tick);
      };
      this.rafId = requestAnimationFrame(tick);

      // longtask observer (Chromium only; supported in Electron >= 28)
      try {
        this.observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            this.longTasks.push({ ts: entry.startTime, durationMs: entry.duration });
            if (this.longTasks.length > MAX_RING) this.longTasks.shift();
          }
        });
        this.observer.observe({ type: 'longtask', buffered: true });
      } catch (_) {
        // longtask not supported in this renderer
      }
    },

    stop() {
      this.running = false;
      if (this.rafId != null) { cancelAnimationFrame(this.rafId); this.rafId = null; }
      if (this.observer) { this.observer.disconnect(); this.observer = null; }
    },

    snapshot() {
      return {
        frameDeltas: this.frameDeltas.slice(),
        longTasks: this.longTasks.slice(),
        overheadUs: this.overheadUs,
        frameCount: this.frameDeltas.length,
        longTaskCount: this.longTasks.length,
        startedAtWallMs: this.startedAtWallMs,
        startedAtPerfMs: this.startedAtPerfMs,
        running: this.running
      };
    },

    reset() {
      this.frameDeltas.length = 0;
      this.longTasks.length = 0;
      this.overheadUs = 0;
    }
  };

  window.__TASKWRAITH_FRAME_PROBE__ = probe;
  return { installed: true, probeExists: true };
})()
`

/** Expression to sample (but not reset) the renderer probe. */
const RENDERER_PROBE_SAMPLE_EXPR = `
(function() {
  const probe = window.__TASKWRAITH_FRAME_PROBE__;
  if (!probe) return { ok: false, reason: 'renderer probe not installed' };
  return { ok: true, ...probe.snapshot() };
})()
`

/** Expression to stop and sample the renderer probe. */
const RENDERER_PROBE_STOP_EXPR = `
(function() {
  const probe = window.__TASKWRAITH_FRAME_PROBE__;
  if (!probe) return { ok: false, reason: 'renderer probe not installed' };
  probe.stop();
  return { ok: true, ...probe.snapshot() };
})()
`

/** Expression to reset accumulated data (keeps the probe running). */
const RENDERER_PROBE_RESET_EXPR = `
(function() {
  const probe = window.__TASKWRAITH_FRAME_PROBE__;
  if (!probe) return { ok: false, reason: 'renderer probe not installed' };
  probe.reset();
  return { ok: true, reset: true };
})()
`

// ---------------------------------------------------------------------------
// Main-side probe (installed via Node inspector Runtime.evaluate)
// ---------------------------------------------------------------------------

/**
 * Expression that installs the main-process event-loop lag probe into
 * `globalThis.__TASKWRAITH_MAIN_LAG_PROBE__`.
 *
 * Uses a 10 ms setInterval that measures how much the callback was delayed
 * vs the expected schedule. This directly measures event-loop lag in
 * wall-clock time — the thing CPU profiles cannot see.
 *
 * Idempotent — re-evaluating starts a fresh probe.
 */
const MAIN_PROBE_INSTALL_EXPR = `
(function() {
  const existing = globalThis.__TASKWRAITH_MAIN_LAG_PROBE__;
  if (existing && existing.stop) existing.stop();

  const MAX_RING = ${MAX_RING_ENTRIES};
  const probe = {
    samples: [],
    running: false,
    intervalId: null,
    overheadNs: 0n,
    pollIntervalMs: 10,
    startedAt: 0,
    /** total # of intervals that fired since start (survives reset) */
    totalIntervals: 0,

    start() {
      if (this.running) return;
      this.running = true;
      this.startedAt = Date.now();
      this.totalIntervals = 0;
      let expectedNext = Date.now() + this.pollIntervalMs;

      this.intervalId = setInterval(() => {
        const t0 = process.hrtime.bigint();
        const now = Date.now();
        const lagMs = Math.max(0, now - expectedNext);
        expectedNext = now + this.pollIntervalMs;
        this.samples.push({ ts: now, lagMs });
        if (this.samples.length > MAX_RING) this.samples.shift();
        this.totalIntervals++;
        this.overheadNs += process.hrtime.bigint() - t0;
      }, this.pollIntervalMs);
    },

    stop() {
      if (this.intervalId != null) { clearInterval(this.intervalId); this.intervalId = null; }
      this.running = false;
    },

    snapshot() {
      return {
        samples: this.samples.slice(),
        overheadNs: Number(this.overheadNs),
        count: this.samples.length,
        totalIntervals: this.totalIntervals,
        startedAt: this.startedAt,
        running: this.running
      };
    },

    reset() {
      this.samples.length = 0;
      this.overheadNs = 0n;
    }
  };

  globalThis.__TASKWRAITH_MAIN_LAG_PROBE__ = probe;
  return { installed: true, probeExists: true };
})()
`

/** Expression to sample (but not reset) the main probe. */
const MAIN_PROBE_SAMPLE_EXPR = `
(function() {
  const probe = globalThis.__TASKWRAITH_MAIN_LAG_PROBE__;
  if (!probe) return { ok: false, reason: 'main probe not installed' };
  return { ok: true, ...probe.snapshot() };
})()
`

/** Expression to stop and sample the main probe. */
const MAIN_PROBE_STOP_EXPR = `
(function() {
  const probe = globalThis.__TASKWRAITH_MAIN_LAG_PROBE__;
  if (!probe) return { ok: false, reason: 'main probe not installed' };
  probe.stop();
  return { ok: true, ...probe.snapshot() };
})()
`

/** Expression to reset accumulated data (keeps the probe running). */
const MAIN_PROBE_RESET_EXPR = `
(function() {
  const probe = globalThis.__TASKWRAITH_MAIN_LAG_PROBE__;
  if (!probe) return { ok: false, reason: 'main probe not installed' };
  probe.reset();
  return { ok: true, reset: true };
})()
`

// ---------------------------------------------------------------------------
// Injection helpers
// ---------------------------------------------------------------------------

/**
 * Evaluate an expression in the renderer via CDP.
 * @param {{ send: (method: string, params?: object) => Promise<unknown> }} rendererSession
 * @param {string} expression
 * @returns {Promise<unknown>}
 */
async function evaluateInRenderer(rendererSession, expression) {
  const result = await rendererSession.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: false,
    userGesture: false
  })
  if (result && result.exceptionDetails) {
    const details = result.exceptionDetails
    const desc =
      (details.exception &&
        (details.exception.description ||
          (details.exception.value != null ? String(details.exception.value) : ''))) ||
      details.text ||
      'unknown renderer exception'
    const error = new Error(`Frame-cadence triage — renderer evaluation failed: ${String(desc).slice(0, 500)}`)
    error.code = 'FRAME_CADENCE_RENDERER_EXCEPTION'
    throw error
  }
  if (!result || !result.result) return null
  if (Object.prototype.hasOwnProperty.call(result.result, 'value')) {
    return result.result.value
  }
  return null
}

/**
 * Evaluate an expression in the main process via Node inspector.
 * @param {{ post: (method: string, params?: object) => Promise<unknown> }} mainInspector
 * @param {string} expression
 * @returns {Promise<unknown>}
 */
async function evaluateInMain(mainInspector, expression) {
  const result = await mainInspector.post('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: false
  })
  if (result && result.exceptionDetails) {
    const details = result.exceptionDetails
    const desc =
      (details.exception &&
        (details.exception.description ||
          (details.exception.value != null ? String(details.exception.value) : ''))) ||
      details.text ||
      'unknown main exception'
    const error = new Error(`Frame-cadence triage — main evaluation failed: ${String(desc).slice(0, 500)}`)
    error.code = 'FRAME_CADENCE_MAIN_EXCEPTION'
    throw error
  }
  if (!result || !result.result) return null
  if (Object.prototype.hasOwnProperty.call(result.result, 'value')) {
    return result.result.value
  }
  return null
}

// ---------------------------------------------------------------------------
// Public API — install / sample / stop / reset
// ---------------------------------------------------------------------------

/**
 * Install the frame-cadence probe in the renderer.
 *
 * Idempotent: re-calling stops any existing probe and starts a fresh one.
 * Call this ONCE before a collection window. The probe starts collecting
 * immediately.
 *
 * @param {{ send: (method: string, params?: object) => Promise<unknown> }} rendererSession
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 */
async function installRendererProbe(rendererSession) {
  if (!isFrameCadenceTriageEnabled()) {
    return { ok: false, reason: `${TRIAGE_ENV_FLAG} not set` }
  }
  const result = await evaluateInRenderer(rendererSession, RENDERER_PROBE_INSTALL_EXPR)
  if (result && result.installed) return { ok: true }
  return { ok: false, reason: 'renderer probe installation returned unexpected value' }
}

/**
 * Install the event-loop lag probe in the main process.
 *
 * Idempotent: re-calling stops any existing probe and starts a fresh one.
 *
 * @param {{ post: (method: string, params?: object) => Promise<unknown> }} mainInspector
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 */
async function installMainProbe(mainInspector) {
  if (!isFrameCadenceTriageEnabled()) {
    return { ok: false, reason: `${TRIAGE_ENV_FLAG} not set` }
  }
  const result = await evaluateInMain(mainInspector, MAIN_PROBE_INSTALL_EXPR)
  if (result && result.installed) return { ok: true }
  return { ok: false, reason: 'main probe installation returned unexpected value' }
}

/**
 * Sample the renderer probe WITHOUT stopping it.
 * @param {{ send: (method: string, params?: object) => Promise<unknown> }} rendererSession
 * @returns {Promise<{ ok: boolean, frameDeltas?: Array<{ts:number,deltaMs:number}>, longTasks?: Array<{ts:number,durationMs:number}>, overheadUs?: number, frameCount?: number, longTaskCount?: number, startedAtWallMs?: number, startedAtPerfMs?: number, running?: boolean, reason?: string }>}
 */
async function sampleRendererProbe(rendererSession) {
  const result = await evaluateInRenderer(rendererSession, RENDERER_PROBE_SAMPLE_EXPR)
  return result || { ok: false, reason: 'null result' }
}

/**
 * Sample the main probe WITHOUT stopping it.
 * @param {{ post: (method: string, params?: object) => Promise<unknown> }} mainInspector
 * @returns {Promise<{ ok: boolean, samples?: Array<{ts:number,lagMs:number}>, overheadNs?: number, count?: number, totalIntervals?: number, startedAt?: number, running?: boolean, reason?: string }>}
 */
async function sampleMainProbe(mainInspector) {
  const result = await evaluateInMain(mainInspector, MAIN_PROBE_SAMPLE_EXPR)
  return result || { ok: false, reason: 'null result' }
}

/**
 * Stop and sample the renderer probe.
 * @param {{ send: (method: string, params?: object) => Promise<unknown> }} rendererSession
 * @returns {Promise<object>}
 */
async function stopRendererProbe(rendererSession) {
  const result = await evaluateInRenderer(rendererSession, RENDERER_PROBE_STOP_EXPR)
  return result || { ok: false, reason: 'null result' }
}

/**
 * Stop and sample the main probe.
 * @param {{ post: (method: string, params?: object) => Promise<unknown> }} mainInspector
 * @returns {Promise<object>}
 */
async function stopMainProbe(mainInspector) {
  const result = await evaluateInMain(mainInspector, MAIN_PROBE_STOP_EXPR)
  return result || { ok: false, reason: 'null result' }
}

/**
 * Reset accumulated data on both probes (keeps them running).
 */
async function resetProbes(rendererSession, mainInspector) {
  const rendererResult = await evaluateInRenderer(rendererSession, RENDERER_PROBE_RESET_EXPR)
  const mainResult = await evaluateInMain(mainInspector, MAIN_PROBE_RESET_EXPR)
  return {
    ok: rendererResult && rendererResult.ok && mainResult && mainResult.ok,
    renderer: rendererResult,
    main: mainResult
  }
}

// ---------------------------------------------------------------------------
// Correlation engine
// ---------------------------------------------------------------------------

/**
 * Core triage: correlate frame misses with main event-loop lag spikes.
 *
 * Clock domains:
 *   - Renderer frameDeltas[i].ts is in renderer `performance.now()` (monotonic,
 *     origin = renderer process start).
 *   - Renderer longTasks[i].ts is in the same `performance.now()` domain.
 *   - Main samples[i].ts is in `Date.now()` (wall clock).
 *
 * To correlate, we map renderer performance timestamps to wall clock via:
 *   wallMs = startedAtWallMs + (perfTs - startedAtPerfMs)
 *
 * @param {object} options
 * @param {Array<{ts:number,deltaMs:number}>} options.frameDeltas
 * @param {number} options.startedAtWallMs  — Date.now() when renderer probe started
 * @param {number} options.startedAtPerfMs  — performance.now() when renderer probe started
 * @param {Array<{ts:number,durationMs:number}>} options.longTasks — renderer long tasks
 * @param {Array<{ts:number,lagMs:number}>} options.mainLagSamples
 * @param {number} [options.missThresholdMs=20]
 * @param {number} [options.correlationWindowMs=50]
 * @param {number} [options.mainLagSpikeThresholdMs=10]
 * @param {number} [options.longTaskThresholdMs=50]
 * @returns {{
 *   decision: 'main-first' | 'compositor-first' | 'mixed' | 'insufficient-data',
 *   overlapPercent: number,
 *   totalFrameMisses: number,
 *   overlappingMisses: number,
 *   frameMisses: Array<{wallTs: number, deltaMs: number, overlapped: boolean}>,
 *   frameDeltasP50: number,
 *   frameDeltasP95: number,
 *   frameDeltasP99: number,
 *   mainLagP50: number,
 *   mainLagP95: number,
 *   mainLagP99: number,
 *   rendererLongTaskCount: number,
 *   note: string | null
 * }}
 */
function correlateFrameMissesToMainLag(options) {
  const {
    frameDeltas,
    startedAtWallMs,
    startedAtPerfMs,
    longTasks,
    mainLagSamples,
    missThresholdMs = DEFAULT_MISS_THRESHOLD_MS,
    correlationWindowMs = DEFAULT_CORRELATION_WINDOW_MS,
    mainLagSpikeThresholdMs = DEFAULT_MAIN_LAG_SPIKE_THRESHOLD_MS,
    longTaskThresholdMs = DEFAULT_LONG_TASK_THRESHOLD_MS
  } = options

  if (!Array.isArray(frameDeltas) || frameDeltas.length === 0) {
    return {
      decision: 'insufficient-data',
      overlapPercent: 0,
      totalFrameMisses: 0,
      overlappingMisses: 0,
      frameMisses: [],
      frameDeltasP50: 0,
      frameDeltasP95: 0,
      frameDeltasP99: 0,
      mainLagP50: 0,
      mainLagP95: 0,
      mainLagP99: 0,
      rendererLongTaskCount: Array.isArray(longTasks) ? longTasks.length : 0,
      note: 'no frame deltas — was the collection window long enough?'
    }
  }

  // Convert renderer performance.now() timestamps to wall clock.
  const perfToWall = (perfTs) => startedAtWallMs + (perfTs - startedAtPerfMs)

  // Identify frame misses with wall-clock timestamps.
  /** @type {Array<{wallTs: number, deltaMs: number, overlapped: boolean}>} */
  const frameMisses = []
  for (const f of frameDeltas) {
    if (f.deltaMs > missThresholdMs) {
      frameMisses.push({
        wallTs: perfToWall(f.ts),
        deltaMs: f.deltaMs,
        overlapped: false
      })
    }
  }
  const totalFrameMisses = frameMisses.length
  if (totalFrameMisses === 0) {
    return {
      decision: 'insufficient-data',
      overlapPercent: 0,
      totalFrameMisses: 0,
      overlappingMisses: 0,
      frameMisses: [],
      frameDeltasP50: percentile(frameDeltas.map((f) => f.deltaMs), 50),
      frameDeltasP95: percentile(frameDeltas.map((f) => f.deltaMs), 95),
      frameDeltasP99: percentile(frameDeltas.map((f) => f.deltaMs), 99),
      mainLagP50: percentile((mainLagSamples || []).map((s) => s.lagMs), 50),
      mainLagP95: percentile((mainLagSamples || []).map((s) => s.lagMs), 95),
      mainLagP99: percentile((mainLagSamples || []).map((s) => s.lagMs), 99),
      rendererLongTaskCount: Array.isArray(longTasks) ? longTasks.length : 0,
      note: 'zero frame misses — no jank detected during collection window; re-run under active fan-out load'
    }
  }

  // Build a set of "bad main event" wall-clock timestamps for fast overlap checks.
  // A bad event is either a main lag spike or a renderer long task (mapped to wall).
  /** @type {number[]} */
  const badEventWallTsList = []

  if (Array.isArray(mainLagSamples)) {
    for (const s of mainLagSamples) {
      if (s.lagMs >= mainLagSpikeThresholdMs) {
        badEventWallTsList.push(s.ts)
      }
    }
  }

  if (Array.isArray(longTasks)) {
    for (const lt of longTasks) {
      if (lt.durationMs >= longTaskThresholdMs) {
        badEventWallTsList.push(perfToWall(lt.ts))
      }
    }
  }

  // Sort for binary search.
  badEventWallTsList.sort((a, b) => a - b)

  /**
   * True when any bad event falls within ±correlationWindowMs of wallTs.
   * @param {number} wallTs
   * @returns {boolean}
   */
  function hasOverlappingBadEvent(wallTs) {
    const lo = wallTs - correlationWindowMs
    const hi = wallTs + correlationWindowMs
    // Linear scan is fine for typical collection windows; badEventWallTsList
    // is at most a few thousand entries.
    let left = 0
    let right = badEventWallTsList.length - 1
    while (left <= right) {
      const mid = (left + right) >>> 1
      const val = badEventWallTsList[mid]
      if (val >= lo && val <= hi) return true
      if (val < lo) left = mid + 1
      else right = mid - 1
    }
    return false
  }

  let overlappingMisses = 0
  for (const miss of frameMisses) {
    if (hasOverlappingBadEvent(miss.wallTs)) {
      miss.overlapped = true
      overlappingMisses++
    }
  }

  const overlapPercent = totalFrameMisses > 0
    ? (overlappingMisses / totalFrameMisses) * 100
    : 0

  const frameDeltaValues = frameDeltas.map((f) => f.deltaMs)
  const mainLagValues = (mainLagSamples || []).map((s) => s.lagMs)
  const frameDeltasP50 = percentile(frameDeltaValues, 50)
  const frameDeltasP95 = percentile(frameDeltaValues, 95)
  const frameDeltasP99 = percentile(frameDeltaValues, 99)
  const mainLagP50 = percentile(mainLagValues, 50)
  const mainLagP95 = percentile(mainLagValues, 95)
  const mainLagP99 = percentile(mainLagValues, 99)

  // Decision gate (per @CursorScout):
  let decision = 'mixed'
  let note = null
  if (overlapPercent > 60) {
    decision = 'main-first'
    note = `${overlapPercent.toFixed(1)}% of frame misses overlap main lag / long-task spikes (>${mainLagSpikeThresholdMs} ms lag / >${longTaskThresholdMs} ms long-task within ±${correlationWindowMs} ms) — main-process event-loop starvation is the dominant source of jank`
  } else if (overlapPercent < 30) {
    decision = 'compositor-first'
    note = `${overlapPercent.toFixed(1)}% overlap — main event loop is mostly quiet while frames miss budget; compositor / paint is the likely bottleneck. CAVEAT: this gate uses low main-lag overlap as evidence of compositor dominance, but does not independently measure paint/composite cost. Corroborate with a DevTools Performance trace (paint/composite event timing) before committing to a compositor-only fix path.`
  } else {
    note = `${overlapPercent.toFixed(1)}% overlap — both main lag and compositor contribute; split into parallel work lanes`
  }

  return {
    decision,
    overlapPercent,
    totalFrameMisses,
    overlappingMisses,
    frameMisses,
    frameDeltasP50,
    frameDeltasP95,
    frameDeltasP99,
    mainLagP50,
    mainLagP95,
    mainLagP99,
    rendererLongTaskCount: Array.isArray(longTasks) ? longTasks.length : 0,
    note
  }
}

/**
 * Compute the p-th percentile of a numeric array.
 * @param {number[]} values
 * @param {number} p — 0–100
 * @returns {number}
 */
function percentile(values, p) {
  if (!values || !values.length) return 0
  const sorted = values.slice().sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[idx]
}

// ---------------------------------------------------------------------------
// Orchestrated collection window
// ---------------------------------------------------------------------------

/**
 * Run a full triage window: install probes, collect for `windowSeconds`,
 * stop, correlate, and return the decision.
 *
 * @param {object} options
 * @param {{ send: (method: string, params?: object) => Promise<unknown> }} options.rendererSession
 * @param {{ post: (method: string, params?: object) => Promise<unknown> }} options.mainInspector
 * @param {number} [options.windowSeconds=30]
 * @param {number} [options.missThresholdMs=20]
 * @param {number} [options.correlationWindowMs=50]
 * @param {number} [options.mainLagSpikeThresholdMs=10]
 * @param {number} [options.longTaskThresholdMs=50]
 * @param {(phase: string, info: object) => void} [options.onProgress]
 * @param {() => number} [options.nowMs]
 * @returns {Promise<object>}
 */
async function runTriageWindow(options) {
  if (!isFrameCadenceTriageEnabled()) {
    return {
      ok: false,
      reason: `${TRIAGE_ENV_FLAG} not set — frame-cadence triage is disabled by default. Set ${TRIAGE_ENV_FLAG}=1 to enable.`,
      decision: 'insufficient-data'
    }
  }

  const {
    rendererSession,
    mainInspector,
    windowSeconds = DEFAULT_COLLECTION_WINDOW_S,
    missThresholdMs = DEFAULT_MISS_THRESHOLD_MS,
    correlationWindowMs = DEFAULT_CORRELATION_WINDOW_MS,
    mainLagSpikeThresholdMs = DEFAULT_MAIN_LAG_SPIKE_THRESHOLD_MS,
    longTaskThresholdMs = DEFAULT_LONG_TASK_THRESHOLD_MS,
    onProgress,
    nowMs: nowMsOpt
  } = options
  const nowMs = typeof nowMsOpt === 'function' ? nowMsOpt : Date.now

  if (!rendererSession || typeof rendererSession.send !== 'function') {
    return { ok: false, reason: 'rendererSession with send() required', decision: 'insufficient-data' }
  }
  if (!mainInspector || typeof mainInspector.post !== 'function') {
    return { ok: false, reason: 'mainInspector with post() required', decision: 'insufficient-data' }
  }

  const startedAt = nowMs()
  const deadlineMs = startedAt + windowSeconds * 1000

  if (typeof onProgress === 'function') {
    onProgress('installing', { startedAt, windowSeconds })
  }

  // Install probes (idempotent — starts fresh collection).
  const rendererInstall = await installRendererProbe(rendererSession)
  if (!rendererInstall.ok) {
    return { ok: false, reason: `renderer probe install failed: ${rendererInstall.reason}`, decision: 'insufficient-data' }
  }

  const mainInstall = await installMainProbe(mainInspector)
  if (!mainInstall.ok) {
    return { ok: false, reason: `main probe install failed: ${mainInstall.reason}`, decision: 'insufficient-data' }
  }

  if (typeof onProgress === 'function') {
    onProgress('collecting', { deadlineMs, remainingMs: deadlineMs - nowMs() })
  }

  // Collect for the window duration.
  let lastLogMs = startedAt
  while (nowMs() < deadlineMs) {
    await sleep(Math.min(500, deadlineMs - nowMs()))
    if (typeof onProgress === 'function' && nowMs() - lastLogMs >= 2000) {
      lastLogMs = nowMs()
      onProgress('collecting', { deadlineMs, remainingMs: Math.max(0, deadlineMs - nowMs()) })
    }
  }

  if (typeof onProgress === 'function') {
    onProgress('sampling', { elapsedMs: nowMs() - startedAt })
  }

  // Stop and sample both probes.
  const rendererSnapshot = await stopRendererProbe(rendererSession)
  const mainSnapshot = await stopMainProbe(mainInspector)

  // Validate snapshots.
  if (!rendererSnapshot || !rendererSnapshot.ok) {
    return {
      ok: false,
      reason: `renderer snapshot failed: ${rendererSnapshot && rendererSnapshot.reason ? rendererSnapshot.reason : 'null result'}`,
      decision: 'insufficient-data'
    }
  }
  if (!mainSnapshot || !mainSnapshot.ok) {
    return {
      ok: false,
      reason: `main snapshot failed: ${mainSnapshot && mainSnapshot.reason ? mainSnapshot.reason : 'null result'}`,
      decision: 'insufficient-data'
    }
  }

  // Compute instrument overhead.
  const instrumentOverhead = {
    renderer: {
      overheadUs: typeof rendererSnapshot.overheadUs === 'number' ? rendererSnapshot.overheadUs : 0,
      frameCount: typeof rendererSnapshot.frameCount === 'number' ? rendererSnapshot.frameCount : 0,
      overheadUsPerFrame:
        rendererSnapshot.frameCount > 0
          ? (rendererSnapshot.overheadUs || 0) / rendererSnapshot.frameCount
          : 0
    },
    main: {
      overheadNs: typeof mainSnapshot.overheadNs === 'number' ? mainSnapshot.overheadNs : 0,
      sampleCount: typeof mainSnapshot.count === 'number' ? mainSnapshot.count : 0,
      overheadNsPerSample:
        mainSnapshot.count > 0
          ? (mainSnapshot.overheadNs || 0) / mainSnapshot.count
          : 0
    }
  }

  // Run the correlation.
  const correlation = correlateFrameMissesToMainLag({
    frameDeltas: rendererSnapshot.frameDeltas || [],
    startedAtWallMs: rendererSnapshot.startedAtWallMs || 0,
    startedAtPerfMs: rendererSnapshot.startedAtPerfMs || 0,
    longTasks: rendererSnapshot.longTasks || [],
    mainLagSamples: mainSnapshot.samples || [],
    missThresholdMs,
    correlationWindowMs,
    mainLagSpikeThresholdMs,
    longTaskThresholdMs
  })

  const elapsedMs = nowMs() - startedAt

  return {
    ok: true,
    elapsedMs,
    windowSeconds,
    correlation,
    instrumentOverhead,
    rendererFrameCount: rendererSnapshot.frameCount || 0,
    rendererLongTaskCount: rendererSnapshot.longTaskCount || 0,
    mainSampleCount: mainSnapshot.count || 0,
    mainTotalIntervals: mainSnapshot.totalIntervals || 0,
    rendererStartedAtWallMs: rendererSnapshot.startedAtWallMs || 0,
    mainStartedAt: mainSnapshot.startedAt || 0,
    thresholds: {
      missThresholdMs,
      correlationWindowMs,
      mainLagSpikeThresholdMs,
      longTaskThresholdMs,
      frameBudgetMs: FRAME_BUDGET_MS
    }
  }
}

/**
 * Minimal async sleep.
 * @param {number} ms
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  TRIAGE_ENV_FLAG,
  isFrameCadenceTriageEnabled,

  // Constants
  FRAME_BUDGET_MS,
  DEFAULT_MISS_THRESHOLD_MS,
  DEFAULT_CORRELATION_WINDOW_MS,
  DEFAULT_MAIN_LAG_SPIKE_THRESHOLD_MS,
  DEFAULT_LONG_TASK_THRESHOLD_MS,
  DEFAULT_COLLECTION_WINDOW_S,

  // Probe installation / sampling
  installRendererProbe,
  installMainProbe,
  sampleRendererProbe,
  sampleMainProbe,
  stopRendererProbe,
  stopMainProbe,
  resetProbes,

  // Raw evaluation (for advanced use)
  evaluateInRenderer,
  evaluateInMain,

  // Correlation engine
  correlateFrameMissesToMainLag,
  percentile,

  // Orchestrated window
  runTriageWindow,

  // Probe expressions (exported for testing / inspection)
  RENDERER_PROBE_INSTALL_EXPR,
  RENDERER_PROBE_SAMPLE_EXPR,
  RENDERER_PROBE_STOP_EXPR,
  MAIN_PROBE_INSTALL_EXPR,
  MAIN_PROBE_SAMPLE_EXPR,
  MAIN_PROBE_STOP_EXPR
}
