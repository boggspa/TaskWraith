'use strict'

/**
 * CLI entry for T1 perf harness dry-runs and fixture materialization (hardened).
 *
 * Examples:
 *   node scripts/perf/runBaseline.cjs --workload=30seat --dry-run
 *   node scripts/perf/runBaseline.cjs --workload=50seat --out-dir=/tmp/tw-perf-50 --mode=legacy_v1
 *
 * Does NOT launch Electron or touch live userData.
 * --launch is reserved and currently refused until Boss unlocks T2 attach.
 */

const fs = require('fs')
const path = require('path')
const os = require('os')
const {
  SCHEMA_VERSION,
  WORKLOADS,
  FX_POSTURES,
  MATERIALIZE_MODES,
  createEmptyPerfMetrics,
  createPerfReport,
  validatePerfEnvironment,
  evaluatePerfGates
} = require('./schema.cjs')
const { generatePerfFixture, fixtureFingerprint } = require('./fixtureGenerator.cjs')
const { materializePerfUserData } = require('./materializeUserData.cjs')
const { buildIsolatedLaunchPlan } = require('./isolatedLaunch.cjs')
const { collectRepoProvenance, detectAppVersion } = require('./repoProvenance.cjs')

function parseArgs(argv) {
  /** @type {Record<string, string | boolean>} */
  const out = {
    dryRun: false,
    launch: false,
    pretty: false,
    help: false,
    lean: false
  }
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') out.help = true
    else if (arg === '--dry-run') out.dryRun = true
    else if (arg === '--launch') out.launch = true
    else if (arg === '--pretty') out.pretty = true
    else if (arg === '--lean') out.lean = true
    else if (arg.startsWith('--workload=')) out.workload = arg.slice('--workload='.length)
    else if (arg.startsWith('--seed=')) out.seed = arg.slice('--seed='.length)
    else if (arg.startsWith('--out-dir=')) out.outDir = arg.slice('--out-dir='.length)
    else if (arg.startsWith('--instance-id=')) out.instanceId = arg.slice('--instance-id='.length)
    else if (arg.startsWith('--port=')) out.port = arg.slice('--port='.length)
    else if (arg.startsWith('--fx-posture=')) out.fxPosture = arg.slice('--fx-posture='.length)
    else if (arg.startsWith('--git-sha=')) out.gitSha = arg.slice('--git-sha='.length)
    else if (arg.startsWith('--app-version=')) out.appVersion = arg.slice('--app-version='.length)
    else if (arg.startsWith('--mode=')) out.mode = arg.slice('--mode='.length)
    else if (arg.startsWith('--scale-down=')) out.scaleDown = arg.slice('--scale-down='.length)
    else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  return out
}

function printHelp() {
  const text = `
TaskWraith perf harness (T1 hardened) — deterministic fixtures + isolated launch plans

Usage:
  node scripts/perf/runBaseline.cjs --workload=<name> [options]

Workloads: ${WORKLOADS.join(', ')}
FX postures: ${FX_POSTURES.join(', ')}
Modes: ${MATERIALIZE_MODES.join(', ')}

Options:
  --dry-run              Generate fixture + report skeleton; no userData writes
  --out-dir=<path>       Materialize chats into isolated dir (required unless --dry-run)
  --mode=<name>          legacy_v1 (fat index+508 ckpts) | future_v2 (default legacy_v1)
  --seed=<n>             PRNG seed (default 42)
  --instance-id=<id>     Isolated TASKWRAITH_INSTANCE_ID (default perf-<workload>-<seed>)
  --port=<n>             CDP port
  --fx-posture=<name>    including reduce_motion
  --lean                 Tiny tool blobs (fast smoke; not size-accurate)
  --scale-down=<n>       Divide turn targets (test-only)
  --pretty               Pretty-print chat JSON (slower; matches production writeJson style)
  --launch               Currently refused (T2 attach unlock required)
  --help

Safety:
  Never targets live TaskWraith userData. Never kills running apps.
  authoritativeBaseline=false unless clean isolated worktree.
`.trim()
  console.log(text)
}

function runBaselineCli(argv = process.argv.slice(2), options = {}) {
  const args = parseArgs(argv)
  if (args.help) {
    printHelp()
    return { ok: true, helped: true }
  }

  const workload = args.workload
  if (!workload || !WORKLOADS.includes(workload)) {
    throw new Error(`--workload required (${WORKLOADS.join('|')})`)
  }
  if (args.launch) {
    throw new Error(
      '--launch is reserved for T2 (Boss unlock). Print the launch plan only; do not spawn Electron from this CLI yet.'
    )
  }

  const seed = args.seed == null ? 42 : Number(args.seed)
  if (!Number.isFinite(seed)) throw new Error('--seed must be a number')

  const mode = args.mode || 'legacy_v1'
  if (!MATERIALIZE_MODES.includes(mode)) {
    throw new Error(`--mode must be one of ${MATERIALIZE_MODES.join('|')}`)
  }

  const scaleDown = args.scaleDown == null ? undefined : Number(args.scaleDown)
  if (scaleDown != null && (!Number.isFinite(scaleDown) || scaleDown < 1)) {
    throw new Error('--scale-down must be >= 1')
  }

  const repoRoot = options.repoRoot || path.resolve(__dirname, '..', '..')
  const provenance =
    options.provenance ||
    collectRepoProvenance({
      repoRoot,
      forceIsolated: options.forceIsolated
    })
  const gitSha = args.gitSha || provenance.gitSha
  const appVersion = args.appVersion || detectAppVersion(repoRoot)
  const instanceId = args.instanceId || `perf-${workload.replace(/_/g, '-')}-${String(seed)}`
  const fxPosture = args.fxPosture || 'cinematic_default'
  const port = args.port == null ? undefined : Number(args.port)

  const fixture = generatePerfFixture({
    workload,
    seed,
    lean: Boolean(args.lean),
    scaleDown
  })
  const fingerprint = fixtureFingerprint(fixture)
  const launchPlan = buildIsolatedLaunchPlan({
    instanceId,
    workload,
    fxPosture,
    remoteDebuggingPort: port,
    repoRoot
  })

  let materializeResult = null
  let userDataDir = args.outDir ? path.resolve(String(args.outDir)) : null

  if (args.dryRun) {
    if (!userDataDir) {
      userDataDir = path.join(os.tmpdir(), `taskwraith-perf-dry-${instanceId}`)
    }
  } else {
    if (!userDataDir) {
      throw new Error('--out-dir is required unless --dry-run')
    }
    materializeResult = materializePerfUserData({
      workload,
      seed,
      userDataDir,
      fixture,
      pretty: Boolean(args.pretty),
      mode,
      lean: Boolean(args.lean),
      scaleDown
    })
  }

  const startedAt = new Date().toISOString()
  const env = {
    schemaVersion: SCHEMA_VERSION,
    runId: `perf-${workload}-${seed}-${fingerprint.slice(0, 12)}`,
    gitSha,
    appVersion,
    instanceId,
    userDataDir: userDataDir,
    remoteDebuggingPort: launchPlan.remoteDebuggingPort,
    iosRemote: false,
    fxPosture,
    workload,
    seed,
    startedAt,
    endedAt: null,
    authoritativeBaseline: provenance.authoritativeBaseline,
    repoProvenance: {
      gitSha: provenance.gitSha,
      dirty: provenance.dirty,
      dirtyTreeFingerprint: provenance.dirtyTreeFingerprint,
      dirtyPaths: provenance.dirtyPaths,
      isolatedWorktree: provenance.isolatedWorktree
    }
  }
  const envCheck = validatePerfEnvironment(env)
  if (!envCheck.ok) {
    throw new Error(`Environment invalid: ${envCheck.errors.join('; ')}`)
  }

  const report = createPerfReport(env, createEmptyPerfMetrics())
  report.fixture = {
    fingerprint,
    totals: fixture.totals,
    shape: fixture.shape,
    replayEventCount: fixture.replaySchedule.length,
    mode
  }
  report.launchPlan = {
    shellCommand: launchPlan.shellCommand,
    cdpVersionUrl: launchPlan.cdpVersionUrl,
    safety: launchPlan.safety
  }
  const gateProbe = evaluatePerfGates({
    report,
    claimMetricsCollected: false
  })
  report.gates = gateProbe.gates
  report.status = {
    phase: 'T1-harness-hardened',
    dryRun: Boolean(args.dryRun),
    materialized: Boolean(materializeResult),
    metricsCollected: false,
    authoritativeBaseline: provenance.authoritativeBaseline,
    note: provenance.authoritativeBaseline
      ? 'Clean isolated worktree — eligible for official baseline once T2 profiles exist'
      : 'authoritativeBaseline=false (dirty tree and/or not isolated worktree). Official HEAD baseline blocked.'
  }

  const artifactDir = materializeResult
    ? materializeResult.userDataDir
    : path.join(os.tmpdir(), `taskwraith-perf-report-${instanceId}`)
  fs.mkdirSync(artifactDir, { recursive: true })
  const reportPath = path.join(artifactDir, 'perf-report.json')
  const launchPath = path.join(artifactDir, 'perf-launch-plan.json')
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  fs.writeFileSync(launchPath, `${JSON.stringify(launchPlan, null, 2)}\n`, 'utf8')

  if (args.dryRun) {
    const replayPath = path.join(artifactDir, 'perf-replay-schedule.json')
    fs.writeFileSync(
      replayPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          kind: 'taskwraith-perf-replay-schedule',
          workload: fixture.workload,
          seed: fixture.seed,
          fingerprint,
          eventCount: fixture.replaySchedule.length,
          events: fixture.replaySchedule
        },
        null,
        2
      )}\n`,
      'utf8'
    )
  }

  return {
    ok: true,
    dryRun: Boolean(args.dryRun),
    fingerprint,
    totals: fixture.totals,
    reportPath,
    launchPath,
    launchPlan,
    materializeResult,
    report,
    provenance,
    gateProbe
  }
}

if (require.main === module) {
  try {
    const result = runBaselineCli()
    if (result.helped) process.exit(0)
    console.log(
      JSON.stringify(
        {
          ok: true,
          dryRun: result.dryRun,
          fingerprint: result.fingerprint,
          totals: result.totals,
          authoritativeBaseline: result.provenance.authoritativeBaseline,
          gitSha: result.provenance.gitSha,
          dirtyPathCount: result.provenance.dirtyPaths.length,
          gatesEvaluated: result.gateProbe.gates && result.gateProbe.gates.evaluated,
          reportPath: result.reportPath,
          launchPath: result.launchPath,
          shellCommand: result.launchPlan.shellCommand,
          sizes: result.materializeResult ? result.materializeResult.sizes : null
        },
        null,
        2
      )
    )
  } catch (error) {
    console.error(String(error && error.message ? error.message : error))
    process.exit(1)
  }
}

module.exports = {
  parseArgs,
  runBaselineCli
}
