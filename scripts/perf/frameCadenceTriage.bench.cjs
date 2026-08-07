'use strict'

/**
 * frameCadenceTriage.bench.cjs — pure-logic validation of the correlation
 * engine and gating.  No Electron required; runs under plain Node.
 *
 * Usage:  node scripts/perf/frameCadenceTriage.bench.cjs
 *
 * Keep in sync with frameCadenceTriage.cjs exports.
 */

const assert = require('assert')

const harness = require('./frameCadenceTriage.cjs')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let passed = 0
let failed = 0

function test(name, fn) {
  try {
    fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    failed++
    console.log(`  ✗ ${name}`)
    console.log(`    ${e.message}`)
  }
}

// ---------------------------------------------------------------------------
// 1. Gate
// ---------------------------------------------------------------------------

test('gate defaults off', () => {
  assert.strictEqual(harness.isFrameCadenceTriageEnabled({}), false)
  assert.strictEqual(
    harness.isFrameCadenceTriageEnabled({ TASKWRAITH_FRAME_CADENCE_TRIAGE: '' }),
    false
  )
  assert.strictEqual(
    harness.isFrameCadenceTriageEnabled({ TASKWRAITH_FRAME_CADENCE_TRIAGE: '0' }),
    false
  )
})

test('gate enabled by flag', () => {
  assert.strictEqual(
    harness.isFrameCadenceTriageEnabled({ TASKWRAITH_FRAME_CADENCE_TRIAGE: '1' }),
    true
  )
  assert.strictEqual(
    harness.isFrameCadenceTriageEnabled({ TASKWRAITH_FRAME_CADENCE_TRIAGE: 'true' }),
    true
  )
})

// ---------------------------------------------------------------------------
// 2. Decision paths — insufficient-data
// ---------------------------------------------------------------------------

test('insufficient-data: empty frame deltas', () => {
  const result = harness.correlateFrameMissesToMainLag({
    frameDeltas: [],
    startedAtWallMs: 10000,
    startedAtPerfMs: 5000,
    longTasks: [],
    mainLagSamples: []
  })
  assert.strictEqual(result.decision, 'insufficient-data')
  assert.strictEqual(result.totalFrameMisses, 0)
})

test('insufficient-data: zero frame misses (clean window)', () => {
  // All frames under the miss threshold.
  const frameDeltas = [
    { ts: 100, deltaMs: 16 },
    { ts: 116, deltaMs: 17 },
    { ts: 133, deltaMs: 15 }
  ]
  const result = harness.correlateFrameMissesToMainLag({
    frameDeltas,
    startedAtWallMs: 10000,
    startedAtPerfMs: 0,
    longTasks: [],
    mainLagSamples: [{ ts: 10100, lagMs: 5 }]
  })
  assert.strictEqual(result.decision, 'insufficient-data')
  assert.strictEqual(result.totalFrameMisses, 0)
  assert.ok(result.note.includes('zero frame misses'))
})

// ---------------------------------------------------------------------------
// 3. Decision paths — main-first (>60%)
// ---------------------------------------------------------------------------

test('main-first: high overlap with main lag spikes', () => {
  const frameDeltas = []
  const mainLagSamples = []
  // 10 frames, all over threshold, with nearby lag spikes.
  for (let i = 0; i < 10; i++) {
    const perfTs = 100 + i * 16
    frameDeltas.push({ ts: perfTs, deltaMs: 25 }) // miss
    mainLagSamples.push({ ts: 10100 + i * 16, lagMs: 15 }) // spike nearby
  }
  const result = harness.correlateFrameMissesToMainLag({
    frameDeltas,
    startedAtWallMs: 10000,
    startedAtPerfMs: 0,
    longTasks: [],
    mainLagSamples
  })
  assert.strictEqual(result.decision, 'main-first')
  assert.strictEqual(result.totalFrameMisses, 10)
  assert.strictEqual(result.overlappingMisses, 10)
  assert.strictEqual(result.overlapPercent, 100)
})

// ---------------------------------------------------------------------------
// 4. Decision paths — compositor-first (<30%)
// ---------------------------------------------------------------------------

test('compositor-first: low overlap — frames miss but main is quiet', () => {
  const frameDeltas = []
  // 10 frames spread across 2 seconds, only 1 has a nearby spike.
  for (let i = 0; i < 10; i++) {
    frameDeltas.push({ ts: 100 + i * 200, deltaMs: 30 })
  }
  // One spike near the first miss only.
  const mainLagSamples = [{ ts: 10100, lagMs: 15 }]
  const result = harness.correlateFrameMissesToMainLag({
    frameDeltas,
    startedAtWallMs: 10000,
    startedAtPerfMs: 0,
    longTasks: [],
    mainLagSamples
  })
  assert.strictEqual(result.decision, 'compositor-first')
  assert.strictEqual(result.totalFrameMisses, 10)
  assert.strictEqual(result.overlappingMisses, 1)
  assert.ok(result.overlapPercent < 30, `expected <30%, got ${result.overlapPercent}`)
})

// ---------------------------------------------------------------------------
// 5. Decision paths — mixed (30–60%)
// ---------------------------------------------------------------------------

test('mixed: moderate overlap', () => {
  const frameDeltas = []
  // 10 misses spread across 2 seconds.
  for (let i = 0; i < 10; i++) {
    frameDeltas.push({ ts: 100 + i * 200, deltaMs: 25 })
  }
  // 5 spikes, each near a different miss → 5/10 = 50%.
  const mainLagSamples = []
  for (let i = 0; i < 5; i++) {
    mainLagSamples.push({ ts: 10100 + i * 200, lagMs: 12 })
  }
  const result = harness.correlateFrameMissesToMainLag({
    frameDeltas,
    startedAtWallMs: 10000,
    startedAtPerfMs: 0,
    longTasks: [],
    mainLagSamples
  })
  assert.strictEqual(result.decision, 'mixed')
  assert.ok(result.overlapPercent >= 30 && result.overlapPercent <= 60,
    `expected 30–60%, got ${result.overlapPercent}`)
})

// ---------------------------------------------------------------------------
// 6. Clock-domain mapping
// ---------------------------------------------------------------------------

test('clock domain: renderer perfTs → wall clock via anchor', () => {
  const frameDeltas = [
    { ts: 6000, deltaMs: 30 } // perfTs=6000 → wall=10000+(6000-5000)=11000
  ]
  const mainLagSamples = [
    { ts: 11050, lagMs: 15 } // within ±50ms of wall 11000
  ]
  const result = harness.correlateFrameMissesToMainLag({
    frameDeltas,
    startedAtWallMs: 10000,
    startedAtPerfMs: 5000,
    longTasks: [],
    mainLagSamples
  })
  assert.strictEqual(result.totalFrameMisses, 1)
  assert.strictEqual(result.overlappingMisses, 1)
})

test('clock domain: far main event does NOT overlap', () => {
  const frameDeltas = [
    { ts: 6000, deltaMs: 30 } // wall=11000
  ]
  const mainLagSamples = [
    { ts: 12000, lagMs: 15 } // 1000ms away → no overlap
  ]
  const result = harness.correlateFrameMissesToMainLag({
    frameDeltas,
    startedAtWallMs: 10000,
    startedAtPerfMs: 5000,
    longTasks: [],
    mainLagSamples
  })
  assert.strictEqual(result.totalFrameMisses, 1)
  assert.strictEqual(result.overlappingMisses, 0)
})

// ---------------------------------------------------------------------------
// 7. Thresholds respected
// ---------------------------------------------------------------------------

test('threshold: sub-threshold main lag does not count as spike', () => {
  const frameDeltas = [
    { ts: 100, deltaMs: 25 } // miss
  ]
  const mainLagSamples = [
    { ts: 10100, lagMs: 5 } // below 10ms default spike threshold
  ]
  const result = harness.correlateFrameMissesToMainLag({
    frameDeltas,
    startedAtWallMs: 10000,
    startedAtPerfMs: 0,
    longTasks: [],
    mainLagSamples
  })
  assert.strictEqual(result.totalFrameMisses, 1)
  assert.strictEqual(result.overlappingMisses, 0)
})

test('threshold: sub-threshold long task does not count', () => {
  const frameDeltas = [
    { ts: 100, deltaMs: 25 } // miss
  ]
  const longTasks = [
    { ts: 100, durationMs: 30 } // below 50ms default long-task threshold
  ]
  const result = harness.correlateFrameMissesToMainLag({
    frameDeltas,
    startedAtWallMs: 10000,
    startedAtPerfMs: 0,
    longTasks,
    mainLagSamples: []
  })
  assert.strictEqual(result.totalFrameMisses, 1)
  assert.strictEqual(result.overlappingMisses, 0)
})

test('threshold: long task above threshold DOES count', () => {
  const frameDeltas = [
    { ts: 100, deltaMs: 25 }
  ]
  const longTasks = [
    { ts: 100, durationMs: 60 } // above 50ms threshold
  ]
  const result = harness.correlateFrameMissesToMainLag({
    frameDeltas,
    startedAtWallMs: 10000,
    startedAtPerfMs: 0,
    longTasks,
    mainLagSamples: []
  })
  assert.strictEqual(result.totalFrameMisses, 1)
  assert.strictEqual(result.overlappingMisses, 1)
})

test('threshold: sub-threshold frame delta does NOT count as miss', () => {
  const frameDeltas = [
    { ts: 100, deltaMs: 18 } // under default 20ms threshold
  ]
  const result = harness.correlateFrameMissesToMainLag({
    frameDeltas,
    startedAtWallMs: 10000,
    startedAtPerfMs: 0,
    longTasks: [],
    mainLagSamples: []
  })
  assert.strictEqual(result.totalFrameMisses, 0)
  assert.strictEqual(result.decision, 'insufficient-data')
})

// ---------------------------------------------------------------------------
// 8. Edge cases
// ---------------------------------------------------------------------------

test('edge: single miss with no bad events', () => {
  const frameDeltas = [
    { ts: 100, deltaMs: 25 }
  ]
  const result = harness.correlateFrameMissesToMainLag({
    frameDeltas,
    startedAtWallMs: 10000,
    startedAtPerfMs: 0,
    longTasks: [],
    mainLagSamples: []
  })
  assert.strictEqual(result.totalFrameMisses, 1)
  assert.strictEqual(result.overlappingMisses, 0)
  assert.strictEqual(result.decision, 'compositor-first')
})

test('edge: null/undefined optional arrays handled', () => {
  const frameDeltas = [
    { ts: 100, deltaMs: 25 }
  ]
  // longTasks undefined, mainLagSamples null — should not throw.
  const result = harness.correlateFrameMissesToMainLag({
    frameDeltas,
    startedAtWallMs: 10000,
    startedAtPerfMs: 0,
    longTasks: undefined,
    mainLagSamples: null
  })
  assert.strictEqual(result.totalFrameMisses, 1)
  assert.strictEqual(result.overlappingMisses, 0)
})

// ---------------------------------------------------------------------------
// 9. Probe expressions parse cleanly
// ---------------------------------------------------------------------------

test('probe expression: RENDERER_PROBE_INSTALL_EXPR is non-empty', () => {
  assert.ok(harness.RENDERER_PROBE_INSTALL_EXPR.length > 100)
  assert.ok(harness.RENDERER_PROBE_INSTALL_EXPR.includes('__TASKWRAITH_FRAME_PROBE__'))
})

test('probe expression: MAIN_PROBE_INSTALL_EXPR is non-empty', () => {
  assert.ok(harness.MAIN_PROBE_INSTALL_EXPR.length > 100)
  assert.ok(harness.MAIN_PROBE_INSTALL_EXPR.includes('__TASKWRAITH_MAIN_LAG_PROBE__'))
})

test('probe expression: all 6 expressions are strings', () => {
  const exprNames = [
    'RENDERER_PROBE_INSTALL_EXPR',
    'RENDERER_PROBE_SAMPLE_EXPR',
    'RENDERER_PROBE_STOP_EXPR',
    'MAIN_PROBE_INSTALL_EXPR',
    'MAIN_PROBE_SAMPLE_EXPR',
    'MAIN_PROBE_STOP_EXPR'
  ]
  for (const name of exprNames) {
    assert.strictEqual(typeof harness[name], 'string', `${name} should be a string`)
    assert.ok(harness[name].length > 10, `${name} should be non-trivial`)
  }
})

// ---------------------------------------------------------------------------
// 10. Percentile helper
// ---------------------------------------------------------------------------

test('percentile: basic p50, p95, p99', () => {
  const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
  assert.strictEqual(harness.percentile(values, 50), 5)
  assert.strictEqual(harness.percentile(values, 95), 10)
  assert.strictEqual(harness.percentile(values, 0), 1)
})

test('percentile: empty array returns 0', () => {
  assert.strictEqual(harness.percentile([], 50), 0)
})

test('percentile: null/undefined returns 0', () => {
  assert.strictEqual(harness.percentile(null, 50), 0)
  assert.strictEqual(harness.percentile(undefined, 50), 0)
})

// ---------------------------------------------------------------------------
// 11. runTriageWindow gate behaves without live CDP
// ---------------------------------------------------------------------------

test('runTriageWindow: returns insufficient-data when gate off', async () => {
  const result = await harness.runTriageWindow({
    rendererSession: { send: async () => ({}) },
    mainInspector: { post: async () => ({}) },
    windowSeconds: 0.01
  })
  assert.strictEqual(result.ok, false)
  assert.strictEqual(result.decision, 'insufficient-data')
  assert.ok(result.reason.includes('not set'))
})

// ---------------------------------------------------------------------------
// 12. Attach runner wiring (parse / dry-run — no Electron)
// ---------------------------------------------------------------------------

const runner = require('./runFrameCadenceTriage.cjs')

test('runner parseArgs: defaults + attach flags', () => {
  const args = runner.parseArgs(['--attach', '--cdp-port=9315', '--inspect-port=9320', '--window-seconds=15'])
  assert.strictEqual(args.attach, true)
  assert.strictEqual(args.cdpPort, 9315)
  assert.strictEqual(args.inspectPort, 9320)
  assert.strictEqual(args.windowSeconds, 15)
  assert.strictEqual(args.dryRun, false)
})

test('runner parseArgs: rejects unknown args', () => {
  assert.throws(() => runner.parseArgs(['--launch']), /Unknown argument/)
})

test('runner dry-run plan: documents attach-only + load caveat', () => {
  const plan = runner.buildDryRunPlan(
    runner.parseArgs(['--dry-run', '--cdp-port=9222', '--inspect-port=9229'])
  )
  assert.strictEqual(plan.ok, true)
  assert.strictEqual(plan.mode, 'dry-run')
  assert.strictEqual(plan.attach.cdpPort, 9222)
  assert.strictEqual(plan.attach.inspectPort, 9229)
  assert.ok(plan.spawnHint.includes('runT2Baseline.cjs'))
  assert.ok(plan.loadCaveat.includes('insufficient-data'))
  assert.strictEqual(plan.gate.flag, harness.TRIAGE_ENV_FLAG)
})

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed, ${passed + failed} total\n`)

if (failed > 0) {
  process.exit(1)
}
