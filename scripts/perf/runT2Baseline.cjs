'use strict'

/**
 * T2 opt-in isolated baseline runner — separate from T1 runBaseline.cjs dry CLI.
 *
 * Default posture: refuse Electron launch and refuse writing live/shared userData.
 * Launch requires BOTH:
 *   --launch
 *   --i-accept-isolated-launch
 *
 * This lane's unit smoke never launches Electron. Production attach remains
 * operator-driven after Boss unlock + authoritative artifact review.
 *
 * Examples:
 *   node scripts/perf/runT2Baseline.cjs --workload=dual_run --smoke-plan
 *   node scripts/perf/runT2Baseline.cjs --workload=dual_run --dry-run --lean --scale-down=40
 *   node scripts/perf/runT2Baseline.cjs --workload=30seat --launch --i-accept-isolated-launch ...
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
const { collectRepoProvenance, detectAppVersion } = require('./repoProvenance.cjs')
const { resolveUnpackagedDevUserDataPath, sanitizeDevInstanceId } = require('./devUserDataPath.cjs')
const {
  resolveT2Home,
  assertFilesystemIsolatedHomeContainment,
  verifyIsolatedHomeAndUserDataViaMainInspector
} = require('./isolatedHome.cjs')
const { assertLaunchPortsFree } = require('./portGuard.cjs')
const {
  buildElectronSpawnPlan,
  spawnExactElectronChild,
  terminateExactChild,
  assertExactChildAttach,
  assertExactChildOwnsDebugPorts,
  runIsolatedBuild
} = require('./electronChildSession.cjs')
const {
  attachRendererCdpSession,
  attachMainInspectorSession,
  discoverMainInspectorUrl
} = require('./cdpWebSocketSession.cjs')
const {
  collectRendererCpuProfile,
  collectRendererHeapSnapshot,
  collectMainCpuProfile,
  sampleOsBundle,
  verifyArtifactFile
} = require('./collectors/index.cjs')
const {
  runDeterministicReplay,
  createCdpPageApiAdapter,
  createCdpEvaluateAdapter
} = require('./replayDriver.cjs')
const { applyUnsupportedAnnotations, finalizePartialT2Report } = require('./unsupportedMetrics.cjs')
const { buildT2SmokePlan, summarizeT2SmokePlan } = require('./t2SmokePlan.cjs')

const DEFAULT_REPLAY_STALL_TIMEOUT_MS = 5 * 60 * 1000
const DEFAULT_REPLAY_PROGRESS_EVENT_INTERVAL = 100
const DEFAULT_REPLAY_PROGRESS_INTERVAL_MS = 10 * 1000

/**
 * Atomic, explicitly non-authoritative phase/replay heartbeat.
 * Writes through a sibling temp file so readers never observe partial JSON.
 *
 * @param {object} options
 */
function createT2ProgressJournal(options) {
  const fsApi = options.fs || fs
  const nowMs = typeof options.nowMs === 'function' ? options.nowMs : Date.now
  const progressPath = path.join(options.artifactDir, 'perf-t2-progress.json')
  const tempPath = `${progressPath}.tmp-${process.pid}`
  const log = typeof options.log === 'function' ? options.log : null
  let state = {
    schemaVersion: 1,
    kind: 'taskwraith-perf-t2-progress',
    status: 'running',
    phase: 'prepared',
    completedEvents: 0,
    currentEvent: null,
    ...options.initial,
    diagnosticOnly: true,
    authoritativeEvidence: false,
    updatedAt: new Date(nowMs()).toISOString()
  }

  function update(patch, control = {}) {
    const timestampMs = nowMs()
    state = {
      ...state,
      ...patch,
      schemaVersion: 1,
      kind: 'taskwraith-perf-t2-progress',
      diagnosticOnly: true,
      authoritativeEvidence: false,
      updatedAt: new Date(timestampMs).toISOString()
    }
    fsApi.writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    fsApi.renameSync(tempPath, progressPath)
    if (log && control.log !== false) {
      const total = Number(state.totalEvents) || 0
      const completed = Number(state.completedEvents) || 0
      const percent = total > 0 ? ((completed / total) * 100).toFixed(1) : '0.0'
      const event = state.currentEvent
        ? ` seq=${String(state.currentEvent.seq)} kind=${String(state.currentEvent.kind)}`
        : ''
      log(
        `[T2] ${String(state.status)}/${String(state.phase)} ${completed}/${total} (${percent}%)${event}`
      )
    }
    return state
  }

  return {
    path: progressPath,
    update,
    snapshot: () => state
  }
}

function parseArgs(argv) {
  /** @type {Record<string, string | boolean | number>} */
  const out = {
    dryRun: false,
    launch: false,
    acceptIsolatedLaunch: false,
    materializeInstanceUserData: false,
    smokePlan: false,
    pretty: false,
    help: false,
    lean: false,
    skipBuild: false
  }
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') out.help = true
    else if (arg === '--dry-run') out.dryRun = true
    else if (arg === '--launch') out.launch = true
    else if (arg === '--i-accept-isolated-launch') out.acceptIsolatedLaunch = true
    else if (arg === '--materialize-instance-userdata') out.materializeInstanceUserData = true
    else if (arg === '--smoke-plan') out.smokePlan = true
    else if (arg === '--pretty') out.pretty = true
    else if (arg === '--lean') out.lean = true
    else if (arg === '--skip-build') out.skipBuild = true
    else if (arg.startsWith('--workload=')) out.workload = arg.slice('--workload='.length)
    else if (arg.startsWith('--seed=')) out.seed = arg.slice('--seed='.length)
    else if (arg.startsWith('--out-dir=')) out.outDir = arg.slice('--out-dir='.length)
    else if (arg.startsWith('--artifact-dir='))
      out.artifactDir = arg.slice('--artifact-dir='.length)
    else if (arg.startsWith('--instance-id=')) out.instanceId = arg.slice('--instance-id='.length)
    else if (arg.startsWith('--port=')) out.port = arg.slice('--port='.length)
    else if (arg.startsWith('--inspect-port='))
      out.inspectPort = arg.slice('--inspect-port='.length)
    else if (arg.startsWith('--fx-posture=')) out.fxPosture = arg.slice('--fx-posture='.length)
    else if (arg.startsWith('--git-sha=')) out.gitSha = arg.slice('--git-sha='.length)
    else if (arg.startsWith('--app-version=')) out.appVersion = arg.slice('--app-version='.length)
    else if (arg.startsWith('--mode=')) out.mode = arg.slice('--mode='.length)
    else if (arg.startsWith('--scale-down=')) out.scaleDown = arg.slice('--scale-down='.length)
    else if (arg.startsWith('--max-replay-events=')) {
      out.maxReplayEvents = arg.slice('--max-replay-events='.length)
    } else if (arg.startsWith('--replay-stall-timeout-ms=')) {
      out.replayStallTimeoutMs = arg.slice('--replay-stall-timeout-ms='.length)
    } else if (arg.startsWith('--home=')) out.home = arg.slice('--home='.length)
    else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  return out
}

function printHelp() {
  console.log(
    `
TaskWraith T2 isolated baseline runner (opt-in)

Usage:
  node scripts/perf/runT2Baseline.cjs --workload=<name> [options]

Safety defaults:
  • Refuses Electron launch unless BOTH --launch and --i-accept-isolated-launch
  • Authoritative launch requires --home=<absolute> under <worktree>/perf-homes/ (never real os.homedir())
  • Refuses symlink/non-directory components; realpath-bounds HOME + userData under the worktree boundary
  • Propagates that HOME into the Electron child; refuses --user-data-dir
  • Before replay, main inspector must prove lexical + canonical HOME/userData match the materialized sibling
  • Never targets production TaskWraith or shared "TaskWraith Dev"
  • Attaches only to the spawned child pid/ports; terminates only that child
  • Never auto-deletes artifacts
  • IOS_REMOTE_TRUE forced 0

Options:
  --smoke-plan                      Print scale-down smoke plan JSON (no I/O launch)
  --dry-run                         Fixture + report + spawn plan; no Electron; tmp materialize optional
  --out-dir=<path>                  Artifact / materialize dir (required for non-dry materialize to tmp)
  --artifact-dir=<path>             Report/profile output dir (default: out-dir or tmp)
  --home=<absolute>                 Synthetic isolated HOME (required for --launch; must be under worktree/perf-homes/)
  --materialize-instance-userdata   Write legacy_v1 into <home>/…/TaskWraith Dev <id>
  --launch                          Opt-in spawn (still requires --i-accept-isolated-launch)
  --i-accept-isolated-launch        Explicit acceptance of isolated Electron spawn
  --instance-id=<id>                Unique id (sanitized to 16 chars for userData)
  --port=<n>                        Renderer CDP port
  --inspect-port=<n>                Main inspector port (must differ)
  --workload=… --seed=… --mode=… --fx-posture=… --lean --scale-down=… --max-replay-events=…
  --replay-stall-timeout-ms=<n>     Fail closed if one replay event makes no progress (default: 300000)
  --skip-build                      Skip build (NON-AUTHORITATIVE; refuses official-baseline path)
  --help
`.trim()
  )
}

/**
 * @param {string[]} [argv]
 * @param {object} [options] — DI for tests
 */
async function runT2BaselineCli(argv = process.argv.slice(2), options = {}) {
  const args = parseArgs(argv)
  if (args.help) {
    printHelp()
    return { ok: true, helped: true }
  }

  if (args.smokePlan) {
    const plan = buildT2SmokePlan({
      workload: args.workload || 'dual_run',
      seed: args.seed == null ? 42 : Number(args.seed),
      scaleDown: args.scaleDown == null ? 40 : Number(args.scaleDown),
      instanceId: args.instanceId ? String(args.instanceId) : undefined
    })
    return { ok: true, smokePlan: plan, summary: summarizeT2SmokePlan(plan) }
  }

  const workload = args.workload
  if (!workload || !WORKLOADS.includes(workload)) {
    throw new Error(`--workload required (${WORKLOADS.join('|')})`)
  }

  // Default refuse launch
  if (args.launch && !args.acceptIsolatedLaunch) {
    throw new Error(
      'Refusing --launch without --i-accept-isolated-launch (explicit opt-in required)'
    )
  }
  if (!args.launch && args.acceptIsolatedLaunch) {
    throw new Error('--i-accept-isolated-launch without --launch is ignored/refused; pass both')
  }
  const willLaunch = Boolean(args.launch && args.acceptIsolatedLaunch)

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

  const replayStallTimeoutMs = Number(
    args.replayStallTimeoutMs == null
      ? options.replayStallTimeoutMs == null
        ? DEFAULT_REPLAY_STALL_TIMEOUT_MS
        : options.replayStallTimeoutMs
      : args.replayStallTimeoutMs
  )
  if (!Number.isFinite(replayStallTimeoutMs) || replayStallTimeoutMs <= 0) {
    throw new Error('--replay-stall-timeout-ms must be a positive finite number')
  }

  const repoRoot = options.repoRoot || path.resolve(__dirname, '..', '..')
  const provenance =
    options.provenance ||
    collectRepoProvenance({
      repoRoot,
      forceIsolated: options.forceIsolated
    })

  // Authoritative attach refuses dirty trees unless tests forceIsolated+clean
  if (willLaunch && provenance.dirty && !options.allowDirtyLaunch) {
    throw new Error(
      `Refusing launch on dirty worktree (${provenance.dirtyPaths.length} paths). Clean or use T1 dry-run.`
    )
  }
  if (willLaunch && !provenance.isolatedWorktree && !options.allowNonIsolatedLaunch) {
    throw new Error('Refusing launch outside an isolated worktree')
  }

  const gitSha = args.gitSha || provenance.gitSha
  const appVersion = args.appVersion || detectAppVersion(repoRoot)
  const rawInstanceId = args.instanceId || `perf-t2-${workload.replace(/_/g, '-')}-${String(seed)}`
  const sanitizedId = sanitizeDevInstanceId(String(rawInstanceId))
  if (!sanitizedId) throw new Error('instance id sanitizes empty')

  const homeResolved = resolveT2Home({
    homeArg: args.home != null ? String(args.home) : options.home,
    repoRoot,
    willLaunch,
    realHomedir: options.realHomedir,
    fallbackHome: options.home || os.homedir(),
    fs: options.fs
  })
  const home = homeResolved.home
  const userDataResolved = resolveUnpackagedDevUserDataPath({
    instanceId: String(rawInstanceId),
    home,
    platform: options.platform || process.platform,
    env: options.env || process.env
  })

  /** @type {object|null} */
  let homeContainment = homeResolved.containment

  const fxPosture = args.fxPosture || 'cinematic_default'
  if (!FX_POSTURES.includes(fxPosture)) {
    throw new Error(`fxPosture must be one of ${FX_POSTURES.join('|')}`)
  }

  const spawnPlan = buildElectronSpawnPlan({
    instanceId: userDataResolved.sanitizedInstanceId,
    repoRoot,
    remoteDebuggingPort: args.port == null ? undefined : Number(args.port),
    mainInspectorPort: args.inspectPort == null ? undefined : Number(args.inspectPort),
    workload,
    fxPosture,
    userDataPath: userDataResolved.userDataPath,
    home,
    platform: options.platform || process.platform
  })

  const fixture = generatePerfFixture({
    workload,
    seed,
    lean: Boolean(args.lean),
    scaleDown
  })
  const fingerprint = fixtureFingerprint(fixture)

  const artifactDir = path.resolve(
    String(
      args.artifactDir ||
        args.outDir ||
        path.join(os.tmpdir(), `taskwraith-perf-t2-${userDataResolved.sanitizedInstanceId}`)
    )
  )
  fs.mkdirSync(artifactDir, { recursive: true })

  let materializeResult = null
  let materializeDir = null

  if (args.materializeInstanceUserData) {
    materializeDir = userDataResolved.userDataPath
    if (!willLaunch && !options.allowInstanceMaterializeWithoutLaunch) {
      // Still allow materialize for operator pre-seed, but require explicit flag (already have it).
      // Lane rule: do not touch real userData in unit tests — tests inject home=tmpdir.
    }
    materializeResult = materializePerfUserData({
      workload,
      seed,
      userDataDir: materializeDir,
      fixture,
      pretty: Boolean(args.pretty),
      mode,
      lean: Boolean(args.lean),
      scaleDown
    })
    if (willLaunch && homeResolved.authoritativeHome) {
      // Blocker G: re-prove component + canonical containment after materialize.
      homeContainment = assertFilesystemIsolatedHomeContainment({
        home,
        repoRoot,
        realHomedir: options.realHomedir,
        userDataPath: userDataResolved.userDataPath,
        fs: options.fs,
        createMissing: false
      })
    }
  } else if (!args.dryRun && args.outDir) {
    materializeDir = path.resolve(String(args.outDir))
    materializeResult = materializePerfUserData({
      workload,
      seed,
      userDataDir: materializeDir,
      fixture,
      pretty: Boolean(args.pretty),
      mode,
      lean: Boolean(args.lean),
      scaleDown
    })
  } else if (args.dryRun) {
    materializeDir = path.join(artifactDir, 'dry-userdata')
  } else if (willLaunch) {
    throw new Error(
      'Launch requires fixture materialize into exact instance userData. Pass --materialize-instance-userdata (or --out-dir for non-instance dry paths).'
    )
  }

  // --skip-build may remain for operator debugging but never satisfies official baseline.
  // Authoritative flag stays false until main-inspector HOME/userData verification succeeds.
  const skipBuild = Boolean(args.skipBuild)
  let authoritativeBaseline = false
  let isolationVerification = {
    required: willLaunch,
    verified: false,
    authoritativeHome: homeResolved.authoritativeHome,
    expectedHome: home,
    observedHome: null,
    expectedUserDataPath: userDataResolved.userDataPath,
    observedUserDataPath: null,
    expectedHomeRealpath: homeContainment ? homeContainment.canonicalHome : null,
    expectedUserDataRealpath: homeContainment ? homeContainment.canonicalUserData : null,
    observedHomeRealpath: null,
    observedUserDataRealpath: null,
    note: homeResolved.note
  }

  const startedAt = new Date().toISOString()
  const env = {
    schemaVersion: SCHEMA_VERSION,
    runId: `perf-t2-${workload}-${seed}-${fingerprint.slice(0, 12)}`,
    gitSha,
    appVersion,
    instanceId: userDataResolved.sanitizedInstanceId,
    userDataDir: materializeDir || userDataResolved.userDataPath,
    remoteDebuggingPort: spawnPlan.remoteDebuggingPort,
    iosRemote: false,
    fxPosture,
    workload,
    seed,
    startedAt,
    endedAt: null,
    authoritativeBaseline,
    repoProvenance: {
      gitSha: provenance.gitSha,
      dirty: provenance.dirty,
      dirtyTreeFingerprint: provenance.dirtyTreeFingerprint,
      dirtyPaths: provenance.dirtyPaths,
      isolatedWorktree: provenance.isolatedWorktree,
      skipBuild,
      buildAuthoritative: !skipBuild,
      isolatedHome: home,
      authoritativeHomeGate: homeResolved.authoritativeHome
    }
  }
  const envCheck = validatePerfEnvironment(env)
  if (!envCheck.ok) throw new Error(`Environment invalid: ${envCheck.errors.join('; ')}`)

  const metrics = applyUnsupportedAnnotations(createEmptyPerfMetrics())
  const report = createPerfReport(env, metrics)
  report.fixture = {
    fingerprint,
    totals: fixture.totals,
    shape: fixture.shape,
    replayEventCount: fixture.replaySchedule.length,
    mode
  }
  report.launchPlan = {
    shellCommand: spawnPlan.shellCommand,
    cdpVersionUrl: spawnPlan.cdpVersionUrl,
    inspectorJsonUrl: spawnPlan.inspectorJsonUrl,
    mainInspectorPort: spawnPlan.mainInspectorPort,
    userDataPath: userDataResolved.userDataPath,
    home,
    safety: spawnPlan.safety
  }
  report.isolation = isolationVerification

  const progressJournal = willLaunch
    ? createT2ProgressJournal({
        artifactDir,
        fs: options.progressFs,
        nowMs: options.progressNowMs,
        log:
          options.progressLog === undefined
            ? require.main === module
              ? console.error
              : null
            : options.progressLog,
        initial: {
          runId: env.runId,
          gitSha,
          instanceId: userDataResolved.sanitizedInstanceId,
          workload,
          totalEvents: fixture.replaySchedule.length,
          stallTimeoutMs: replayStallTimeoutMs,
          startedAt,
          note: 'Diagnostic progress only; never satisfies authoritativeBaseline or metricsCollected.'
        }
      })
    : null
  const progressPath = progressJournal ? progressJournal.path : null
  let capturePhase = 'prepared'

  function updateProgress(patch, control) {
    if (!progressJournal) return null
    return progressJournal.update(patch, control)
  }

  function setCapturePhase(phase, patch = {}, control = {}) {
    capturePhase = phase
    return updateProgress({ phase, ...patch }, control)
  }

  function recordProgressFailure(error) {
    if (!progressJournal) return
    const replayEvent = error && error.replayEvent ? error.replayEvent : null
    try {
      updateProgress(
        {
          status: 'failed',
          phase: replayEvent ? 'replay_stalled' : capturePhase,
          currentEvent: replayEvent
            ? {
                eventNumber: replayEvent.eventNumber,
                totalEvents: replayEvent.totalEvents,
                seq: replayEvent.seq,
                kind: replayEvent.kind,
                startedAtMs: replayEvent.startedAtMs,
                elapsedMs: Math.max(0, replayEvent.timedOutAtMs - replayEvent.startedAtMs)
              }
            : progressJournal.snapshot().currentEvent,
          error: {
            code: error && error.code ? String(error.code) : null,
            message: String(error && error.message ? error.message : error)
          },
          failedAt: new Date(
            typeof options.progressNowMs === 'function' ? options.progressNowMs() : Date.now()
          ).toISOString()
        },
        { log: true }
      )
    } catch (progressError) {
      if (error && typeof error === 'object') {
        error.progressJournalError = String(
          progressError && progressError.message ? progressError.message : progressError
        )
      }
    }
  }

  if (progressJournal) updateProgress({}, { log: true })

  /** @type {object|null} */
  let childSession = null
  /** @type {object|null} */
  let replayResult = null
  let profilesCaptured = false
  /** @type {object|null} */
  let buildResult = null
  /** @type {Error|null} */
  let launchError = null
  /** @type {Array<{ phase: string, error: string }>} */
  const cleanupFailures = []

  if (willLaunch) {
    /** @type {object|null} */
    let renderer = null
    /** @type {object|null} */
    let mainInspector = null
    try {
      setCapturePhase('preflight', {}, { log: true })
      await assertLaunchPortsFree(
        {
          remoteDebuggingPort: spawnPlan.remoteDebuggingPort,
          mainInspectorPort: spawnPlan.mainInspectorPort,
          instanceId: userDataResolved.sanitizedInstanceId
        },
        options.portAdapters || {}
      )

      if (skipBuild) {
        setCapturePhase('build_skipped', {}, { log: true })
        buildResult = {
          skipped: true,
          authoritative: false,
          reason: '--skip-build requested — report marked non-authoritative'
        }
        report.launchPlan = {
          ...report.launchPlan,
          buildSkipped: true,
          authoritativeBaseline: false
        }
      } else {
        // A: authoritative --launch builds the required Swift daemon and Electron; fail closed.
        setCapturePhase('build', {}, { log: true })
        buildResult = await runIsolatedBuild({
          repoRoot,
          adapters: options.buildAdapters || {},
          authoritative: true,
          allowSkip: false
        })
        if (buildResult.skipped) {
          throw new Error(
            'Refusing --launch: build skipped — would launch stale out/. Remove --skip-build or provide a real build adapter.'
          )
        }
        setCapturePhase('build_complete', {}, { log: true })
      }

      // Blocker G: re-prove containment immediately before Electron spawn.
      setCapturePhase('isolation_pre_spawn', {}, { log: true })
      if (homeResolved.authoritativeHome) {
        homeContainment = assertFilesystemIsolatedHomeContainment({
          home,
          repoRoot,
          realHomedir: options.realHomedir,
          userDataPath: userDataResolved.userDataPath,
          fs: options.fs,
          createMissing: false
        })
        isolationVerification = {
          ...isolationVerification,
          expectedHomeRealpath: homeContainment.canonicalHome,
          expectedUserDataRealpath: homeContainment.canonicalUserData,
          note: 'pre-spawn realpath containment proved; awaiting main-inspector lexical+canonical match'
        }
        report.isolation = isolationVerification
      }

      setCapturePhase('launch', {}, { log: true })
      childSession = spawnExactElectronChild({
        spawnPlan,
        adapters: options.spawnAdapters || {}
      })
      assertExactChildAttach(childSession, {
        pid: childSession.pid,
        remoteDebuggingPort: spawnPlan.remoteDebuggingPort,
        mainInspectorPort: spawnPlan.mainInspectorPort
      })
      updateProgress({ childPid: childSession.pid }, { log: false })
      setCapturePhase('port_ownership', {}, { log: true })
      await assertExactChildOwnsDebugPorts(childSession, options.portOwnershipAdapters || {})

      setCapturePhase('renderer_attach', {}, { log: true })
      renderer = await attachRendererCdpSession({
        port: spawnPlan.remoteDebuggingPort,
        WebSocket: options.WebSocket,
        adapters: options.cdpAdapters || {}
      })
      const inspectorUrl =
        options.mainInspectorUrl ||
        (await discoverMainInspectorUrl({
          port: spawnPlan.mainInspectorPort,
          adapters: options.cdpAdapters || {}
        }))
      setCapturePhase('main_inspector_attach', {}, { log: true })
      mainInspector = await attachMainInspectorSession({
        webSocketDebuggerUrl: inspectorUrl,
        WebSocket: options.WebSocket
      })

      // Blocker F+G: fail closed unless child lexical + canonical HOME/userData match.
      setCapturePhase('isolation_verify', {}, { log: true })
      const expectedHomeRealpath =
        (homeContainment && homeContainment.canonicalHome) ||
        isolationVerification.expectedHomeRealpath
      const expectedUserDataRealpath =
        (homeContainment && homeContainment.canonicalUserData) ||
        isolationVerification.expectedUserDataRealpath
      if (!expectedHomeRealpath || !expectedUserDataRealpath) {
        throw new Error(
          'Refuse replay: canonical HOME/userData realpaths required before inspector verification'
        )
      }
      const pathProbe =
        typeof options.verifyIsolatedHomeAndUserData === 'function'
          ? await options.verifyIsolatedHomeAndUserData(mainInspector, {
              home,
              userDataPath: userDataResolved.userDataPath,
              homeRealpath: expectedHomeRealpath,
              userDataRealpath: expectedUserDataRealpath
            })
          : await verifyIsolatedHomeAndUserDataViaMainInspector(mainInspector, {
              home,
              userDataPath: userDataResolved.userDataPath,
              homeRealpath: expectedHomeRealpath,
              userDataRealpath: expectedUserDataRealpath
            })
      isolationVerification = {
        ...isolationVerification,
        verified: true,
        observedHome: pathProbe.observedHome,
        observedUserDataPath: pathProbe.observedUserDataPath,
        observedHomeRealpath: pathProbe.observedHomeRealpath || null,
        observedUserDataRealpath: pathProbe.observedUserDataRealpath || null,
        expectedHomeRealpath,
        expectedUserDataRealpath,
        expression: pathProbe.expression,
        note: 'main inspector proved lexical + canonical isolated HOME + TaskWraith Dev <id> userData before replay'
      }
      report.isolation = isolationVerification
      if (!skipBuild && provenance.authoritativeBaseline) {
        authoritativeBaseline = true
        report.environment.authoritativeBaseline = true
        env.authoritativeBaseline = true
      }
      setCapturePhase(
        'isolation_verified',
        { authoritativeBaseline: report.environment.authoritativeBaseline === true },
        { log: true }
      )

      const profileDir = path.join(artifactDir, 'profiles')
      fs.mkdirSync(profileDir, { recursive: true })
      const mainCpuPath = path.join(profileDir, 'main.cpuprofile')
      const rendererCpuPath = path.join(profileDir, 'renderer.cpuprofile')
      const heapPath = path.join(profileDir, 'renderer.heapsnapshot')

      setCapturePhase('profiles_start', {}, { log: true })
      const rendererCpu = await collectRendererCpuProfile(renderer, {
        cpuProfilePath: rendererCpuPath,
        fs
      })
      const mainCpu = await collectMainCpuProfile(mainInspector, {
        cpuProfilePath: mainCpuPath,
        fs
      })

      // Deterministic replay through page API
      const page = createCdpEvaluateAdapter(renderer)
      const api = createCdpPageApiAdapter(page)
      const maxReplayEvents =
        args.maxReplayEvents == null ? undefined : Number(args.maxReplayEvents)
      const replayEventTotal =
        maxReplayEvents == null
          ? fixture.replaySchedule.length
          : Math.min(fixture.replaySchedule.length, maxReplayEvents)
      const replayNowMs =
        typeof options.replayNowMs === 'function'
          ? options.replayNowMs
          : typeof options.progressNowMs === 'function'
            ? options.progressNowMs
            : Date.now
      const progressEventInterval = Number(
        options.progressEventInterval == null
          ? DEFAULT_REPLAY_PROGRESS_EVENT_INTERVAL
          : options.progressEventInterval
      )
      const progressIntervalMs = Number(
        options.progressIntervalMs == null
          ? DEFAULT_REPLAY_PROGRESS_INTERVAL_MS
          : options.progressIntervalMs
      )
      if (!Number.isFinite(progressEventInterval) || progressEventInterval < 1) {
        throw new Error('progressEventInterval must be a positive finite number')
      }
      if (!Number.isFinite(progressIntervalMs) || progressIntervalMs < 1) {
        throw new Error('progressIntervalMs must be a positive finite number')
      }
      const replayStartedAtMs = replayNowMs()
      let lastPublishedAtMs = replayStartedAtMs
      setCapturePhase(
        'replay',
        {
          totalEvents: replayEventTotal,
          completedEvents: 0,
          currentEvent: null,
          replayStartedAt: new Date(replayStartedAtMs).toISOString()
        },
        { log: true }
      )
      replayResult = await runDeterministicReplay({
        fixture,
        api,
        maxEvents: maxReplayEvents,
        batchSize: 8,
        eventTimeoutMs: replayStallTimeoutMs,
        nowMs: replayNowMs,
        timers: options.replayTimerAdapters,
        onEventStart(info) {
          if (info.eventNumber !== 1) return
          updateProgress(
            {
              currentEvent: {
                eventNumber: info.eventNumber,
                totalEvents: info.totalEvents,
                seq: info.seq,
                kind: info.kind,
                startedAtMs: info.startedAtMs
              }
            },
            { log: true }
          )
        },
        onProgress(info) {
          const now = info.completedAtMs
          const shouldPublish =
            info.completedEvents === 1 ||
            info.completedEvents === info.totalEvents ||
            info.completedEvents % progressEventInterval === 0 ||
            now - lastPublishedAtMs >= progressIntervalMs
          if (!shouldPublish) return
          const elapsedMs = Math.max(1, now - replayStartedAtMs)
          const eventsPerSecond = (info.completedEvents * 1000) / elapsedMs
          const remainingEvents = Math.max(0, info.totalEvents - info.completedEvents)
          const etaMs =
            eventsPerSecond > 0 ? Math.round((remainingEvents / eventsPerSecond) * 1000) : null
          lastPublishedAtMs = now
          updateProgress(
            {
              completedEvents: info.completedEvents,
              currentEvent: {
                eventNumber: info.eventNumber,
                totalEvents: info.totalEvents,
                seq: info.seq,
                kind: info.kind,
                startedAtMs: info.startedAtMs,
                completedAtMs: info.completedAtMs,
                elapsedMs: info.elapsedMs
              },
              replayElapsedMs: elapsedMs,
              eventsPerSecond,
              etaMs
            },
            { log: true }
          )
        }
      })

      setCapturePhase(
        'replay_complete',
        {
          completedEvents: replayResult.eventCount,
          currentEvent: null,
          replayCompletedAt: new Date(replayNowMs()).toISOString()
        },
        { log: true }
      )
      setCapturePhase('profiles_stop', {}, { log: true })
      const rendererStopped = await rendererCpu.stop()
      const mainStopped = await mainCpu.stop()
      setCapturePhase('heap_snapshot', {}, { log: true })
      const heapResult = await collectRendererHeapSnapshot(renderer, {
        heapSnapshotPath: heapPath,
        fs
      })

      const rendererCpuDigest = verifyArtifactFile(rendererCpuPath, { fs, minBytes: 32 })
      const mainCpuDigest = verifyArtifactFile(mainCpuPath, { fs, minBytes: 32 })
      const heapDigest = verifyArtifactFile(heapPath, {
        fs,
        minBytes: 64
      })

      if (options.osAdapters) {
        sampleOsBundle(options.osAdapters, { occluded: false })
      }

      report.metrics.profiles = {
        mainCpuProfilePath: mainStopped.path || mainCpuPath,
        rendererCpuProfilePath: rendererStopped.path || rendererCpuPath,
        heapSnapshotPaths: [heapPath],
        digests: {
          mainCpu: mainCpuDigest,
          rendererCpu: rendererCpuDigest,
          heap: { ...heapDigest, chunkCount: heapResult.chunkCount }
        }
      }
      profilesCaptured = true
      setCapturePhase('capture_complete', {}, { log: true })
    } catch (error) {
      launchError = error instanceof Error ? error : new Error(String(error))
      recordProgressFailure(launchError)
      throw launchError
    } finally {
      // C: always close sessions + terminate exact owned tree; preserve primary error.
      let childTerminationSucceeded = childSession == null
      if (renderer && typeof renderer.close === 'function') {
        try {
          renderer.close()
        } catch (error) {
          cleanupFailures.push({
            phase: 'renderer.close',
            error: String(error && error.message ? error.message : error)
          })
        }
      }
      if (mainInspector && typeof mainInspector.close === 'function') {
        try {
          mainInspector.close()
        } catch (error) {
          cleanupFailures.push({
            phase: 'mainInspector.close',
            error: String(error && error.message ? error.message : error)
          })
        }
      }
      if (childSession) {
        try {
          await terminateExactChild(childSession, options.terminateOptions || {})
          childTerminationSucceeded = true
        } catch (error) {
          cleanupFailures.push({
            phase: 'terminateExactChild',
            error: String(error && error.message ? error.message : error)
          })
        }
      }
      if (cleanupFailures.length) {
        report.cleanupFailures = cleanupFailures
        if (launchError) {
          launchError.cleanupFailures = cleanupFailures
        }
      }
      if (progressJournal) {
        try {
          updateProgress(
            {
              cleanup: {
                completed: true,
                childTerminationAttempted: Boolean(childSession),
                childTerminationSucceeded,
                failures: cleanupFailures
              }
            },
            { log: false }
          )
        } catch (progressError) {
          if (launchError) {
            launchError.progressJournalCleanupError = String(
              progressError && progressError.message ? progressError.message : progressError
            )
          } else {
            throw progressError
          }
        }
      }
      // never auto-delete artifacts
    }
  } else if (!args.dryRun && options.replayApi) {
    // Unit-test path: exercise replay without Electron
    replayResult = await runDeterministicReplay({
      fixture,
      api: options.replayApi,
      maxEvents: args.maxReplayEvents == null ? 32 : Number(args.maxReplayEvents)
    })
  }

  finalizePartialT2Report(report, {
    phase: willLaunch ? 'T2-attach' : 'T2-runner-plan',
    profilesCaptured,
    electronLaunched: willLaunch,
    note: willLaunch
      ? 'T2 attach completed; gates still require digests + authoritativeBaseline for metricsCollected claims'
      : 'T2 plan/dry path — Electron not launched; unsupported fields explicit'
  })
  if (replayResult) {
    report.replay = {
      eventCount: replayResult.eventCount,
      saveCount: replayResult.saveCount,
      stallTimeoutMs: replayStallTimeoutMs,
      progressPath,
      progressIsAuthoritativeEvidence: false,
      unsupportedCount: replayResult.unsupported.length,
      unsupported: replayResult.unsupported.slice(0, 50)
    }
  }

  report.environment.endedAt = new Date().toISOString()
  const gateProbe = evaluatePerfGates({
    report,
    claimMetricsCollected: false,
    fsAdapter: {
      statSync: fs.statSync,
      readFileSync: fs.readFileSync
    }
  })
  report.gates = gateProbe.gates

  const reportPath = path.join(artifactDir, 'perf-t2-report.json')
  const planPath = path.join(artifactDir, 'perf-t2-launch-plan.json')
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  fs.writeFileSync(planPath, `${JSON.stringify(spawnPlan, null, 2)}\n`, 'utf8')
  if (progressJournal) {
    setCapturePhase(
      'completed',
      {
        status: 'completed',
        completedEvents: replayResult ? replayResult.eventCount : 0,
        currentEvent: null,
        reportPath,
        planPath,
        completedAt: report.environment.endedAt
      },
      { log: true }
    )
  }

  return {
    ok: true,
    dryRun: Boolean(args.dryRun),
    launched: willLaunch,
    fingerprint,
    sanitizedInstanceId: userDataResolved.sanitizedInstanceId,
    userDataPath: userDataResolved.userDataPath,
    home,
    isolation: isolationVerification,
    reportPath,
    planPath,
    progressPath,
    report,
    spawnPlan,
    materializeResult,
    replayResult,
    provenance: {
      ...provenance,
      authoritativeBaseline,
      skipBuild,
      isolatedHome: home,
      authoritativeHomeGate: homeResolved.authoritativeHome
    },
    buildResult,
    gateProbe,
    artifactDir
  }
}

if (require.main === module) {
  runT2BaselineCli()
    .then((result) => {
      if (result.helped) process.exit(0)
      if (result.smokePlan) {
        console.log(
          JSON.stringify({ ok: true, summary: result.summary, plan: result.smokePlan }, null, 2)
        )
        process.exit(0)
      }
      console.log(
        JSON.stringify(
          {
            ok: true,
            dryRun: result.dryRun,
            launched: result.launched,
            fingerprint: result.fingerprint,
            sanitizedInstanceId: result.sanitizedInstanceId,
            userDataPath: result.userDataPath,
            authoritativeBaseline: result.provenance.authoritativeBaseline,
            reportPath: result.reportPath,
            planPath: result.planPath,
            progressPath: result.progressPath,
            shellCommand: result.spawnPlan.shellCommand,
            gatesEvaluated: result.gateProbe.gates && result.gateProbe.gates.evaluated,
            replaySaveCount: result.replayResult ? result.replayResult.saveCount : null
          },
          null,
          2
        )
      )
    })
    .catch((error) => {
      console.error(String(error && error.message ? error.message : error))
      process.exit(1)
    })
}

module.exports = {
  DEFAULT_REPLAY_STALL_TIMEOUT_MS,
  DEFAULT_REPLAY_PROGRESS_EVENT_INTERVAL,
  DEFAULT_REPLAY_PROGRESS_INTERVAL_MS,
  createT2ProgressJournal,
  parseArgs,
  runT2BaselineCli
}
