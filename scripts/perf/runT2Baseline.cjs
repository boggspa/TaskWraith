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
  verifyArtifactFile,
  sampleMainPersistenceStats,
  applyPersistenceStatsToMetrics,
  sampleHostSpans,
  applyCrossThreadToMetrics
} = require('./collectors/index.cjs')
const { probeHostBootstrapIdentity } = require('./hostWelcomeProbe.cjs')
const {
  parseCellName,
  checkFixtureSatisfiesHistory,
  PAIRING_ROLES,
  MATRIX_SAMPLING,
  cellReachability,
  createInterferenceReport,
  environmentRecord
} = require('./interferenceMatrix.cjs')
const { buildT2RunEvidence } = require('./t2RunEvidence.cjs')
const { runT2WindowedReplay } = require('./t2WindowOrchestration.cjs')
const { runT2PairedReplay } = require('./t2PairedRuns.cjs')
const { awaitWithTimeout } = require('./boundedAwait.cjs')
const {
  runDeterministicReplay,
  createCdpPageApiAdapter,
  createCdpEvaluateAdapter
} = require('./replayDriver.cjs')
const { applyUnsupportedAnnotations, finalizePartialT2Report } = require('./unsupportedMetrics.cjs')
const { buildT2SmokePlan, summarizeT2SmokePlan } = require('./t2SmokePlan.cjs')

const { PERF_GATE_THRESHOLDS } = require('./perfGateThresholds.cjs')

const DEFAULT_REPLAY_STALL_TIMEOUT_MS = 5 * 60 * 1000
const DEFAULT_REPLAY_PROGRESS_EVENT_INTERVAL = 100
const DEFAULT_REPLAY_PROGRESS_INTERVAL_MS = 10 * 1000
const DEFAULT_WINDOWED_RATE_WINDOW_MS = PERF_GATE_THRESHOLDS.windowedRateWindowMs
const DEFAULT_MIN_FREE_DISK_BYTES = PERF_GATE_THRESHOLDS.minFreeDiskBytes
const DEFAULT_MAX_CAPTURE_PHASE_MS = PERF_GATE_THRESHOLDS.maxCapturePhaseMs

// ---------------------------------------------------------------------------
// Host bundle freshness preflight (wave-8 ruling P2)
// ---------------------------------------------------------------------------
// runIsolatedBuild covers the Swift bridge daemon and the Electron build —
// NOT the external Host bundle (`npm run host:build` → out/host/host-runtime/
// cli.js). A stale bundle would launch a pre-contract Host whose welcome
// carries no boot epoch, silently degrading every crossThread cell to the
// legacy path. The runner HARD-FAILS before launch with an actionable
// message naming the exact rebuild command; it NEVER rebuilds implicitly,
// because an implicit rebuild papers over exactly the staleness this
// preflight exists to detect.
const HOST_BUNDLE_PATH_SEGMENTS = Object.freeze(['out', 'host', 'host-runtime', 'cli.js'])
// Each emitted artifact's OWN sourcemap is the authority on what produced it.
// `npm run host:build` runs two different producers into this one tree — tsc
// for the Host itself, then esbuild for two bundled worker entrypoints — so
// no naming convention maps output back to input for all of it. A sourcemap
// records its real inputs either way.
const HOST_BUNDLE_OUTPUT_SEGMENTS = Object.freeze(['out', 'host'])
const HOST_BUNDLE_SOURCE_ROOT = 'src'
// The tsconfig lives in src/host-runtime and its include is './**\/*.ts', so
// THIS tree is the compilation's root set: a new file here is a build input
// with zero imports and therefore has no emitted output to be derived from.
// Every other compiled tree is reached through the import graph, so a new
// input there always arrives with an edit to a file that is already emitted.
const HOST_BUNDLE_INCLUDE_ROOT_SEGMENTS = Object.freeze(['src', 'host-runtime'])
// DECLARED vs EMITTED. The derivation above recovers inputs only through
// artifacts that exist, so an output that was never emitted — a PARTIAL
// build that ran tsc but not the esbuild worker stage — silently unwatches
// that artifact's whole bundled closure: all of src/main/workers/* is
// reachable through no other output and has no importer route in, so neither
// the importer argument nor the include-root walk covers it. The build
// DECLARES these renamed entry artifacts (scripts/build-history-workers.cjs
// `entryPoints` keys under its default outdir); a declared artifact that is
// absent is an incomplete bundle, not a fresh one. This list is reconciled
// against the real build script by the pipeline pin in perfHarness.test.ts,
// and a FUTURE stage that emits differently is caught by that pin's exact
// stage list — not by anything here.
const HOST_BUNDLE_DECLARED_ENTRY_SEGMENTS = Object.freeze([
  Object.freeze(['out', 'host', 'host-node', 'ThreadCatalogueWorkerEntry.js']),
  Object.freeze(['out', 'host', 'host-node', 'ThreadCatalogueDecoderEntry.js'])
])
const HOST_BUNDLE_REBUILD_COMMAND = 'npm run host:build'
const HOST_PERF_SNAPSHOT_FILE_NAME = 'host-perf-snapshot.json'

/**
 * Compare the Host bundle mtime against the newest build-input source file.
 *
 * The build-input set is DERIVED FROM THE EMITTED SOURCEMAPS rather than
 * declared as a directory list or guessed from output filenames. Every
 * `out/host/**\/*.js` has a `.js.map` whose `sources` array names the exact
 * files that produced it, resolved relative to the map. Keeping the entries
 * that land inside `src/` recovers the closure the LAST BUILD read — and it
 * tracks the build automatically instead of drifting from a hand-kept list.
 *
 * Reading provenance rather than inferring it is load-bearing, not tidiness.
 * `npm run host:build` is `clean-host-output && tsc -p
 * src/host-runtime/tsconfig.json && node scripts/build-history-workers.cjs`,
 * and that last step ESBUILD-BUNDLES two worker entrypoints into the same
 * `out/host/host-node/` tree under RENAMED outputs:
 *   ThreadCatalogueWorkerEntry.js  <- src/main/workers/threadCatalogueWorker.ts
 *   ThreadCatalogueDecoderEntry.js <- src/main/workers/threadCatalogueDecoder.ts
 * So `out/host/<rel>.js` does NOT correspond to `src/<rel>.ts` for all of this
 * tree; inverting the name declares those two outputs orphaned and refuses a
 * valid bundle. Their maps also carry the whole bundled closure (147 and 31
 * entries), which name inversion could never have reached at all.
 *
 * By construction that set cannot contain a source ADDED since the build: it
 * appears in no map. Two things close the gap, and neither is a promise about
 * the future.
 *   1. The tsconfig's include root (`src/host-runtime`, include `./**\/*.ts`
 *      EXCLUDING `./**\/*.test.ts`) is walked directly. It is the
 *      compilation's ROOT SET, so a file added there is a build input even
 *      with nothing importing it.
 *   2. Every other tree is reached ONLY through the import graph, so a new
 *      file there is not an input until something imports it — and writing
 *      that import edits a file which IS in the derived set and bumps its
 *      mtime. Such an addition is caught through its importer, not directly.
 * The residual is an added file that nothing imports, which no producer reads
 * either. This is the exact claim an earlier comment got wrong: the tsconfig
 * `include` covers only src/host-runtime, and host-shared, main, shared,
 * host-node and host-client arrive through the import graph — so a directory
 * list could never have "mirrored the build-input set".
 *
 * WHAT THIS COSTS, so the growth is not a surprise: 329 inputs against the
 * 218 a name inversion reached, and `src/main` goes 24 -> 103. Those 111 are
 * the two bundles' transitive closures — every one a file the bundler really
 * read — and 103 is nothing like the 1464-file wholesale walk of `src/main`
 * that this preflight deliberately refuses. Nothing is watched that no
 * producer reads.
 *
 * A newer test file cannot fail the preflight, and any newer compiled source
 * must. Symlinked entries are never followed (a symlink cannot escape into
 * unbounded trees), which is also why an out/host reached through one derives
 * zero inputs and fails closed instead of passing vacuously. Every I/O
 * failure fails closed, as do a missing bundle, an emitted artifact whose
 * sourcemap is absent, unparseable or missing its `sources` array, and a
 * mapped source that no longer exists. A DECLARED entry artifact that is
 * absent fails closed too (`host_bundle_incomplete_output`): a partial build
 * that skipped the esbuild stage is not a launchable Host, and without the
 * check its bundled closure — 111 inputs, all of src/main/workers/* — would
 * be silently unwatched. Provenance that cannot be READ is never assumed:
 * there is deliberately no fallback to guessing the source from the output
 * name, because that guess is what this replaced. A directory entry that is
 * neither a regular file nor a directory — a symlink, a socket — refuses as
 * unproven output rather than being skipped: the walk cannot see through it,
 * so anything behind it would be silently unwatched.
 *
 * That makes the preflight depend on the host tsconfig keeping
 * `sourceMap: true`. Turning it off strips every map and this then refuses
 * every launch — the safe direction, loudly, rather than a silent pass — and
 * the tsconfig contract assertion in perfHarness.test.ts reds first. Parsing
 * all 220 maps costs ~16 ms, negligible against the launch it guards.
 *
 * @param {string} repoRoot
 * @param {{ fs?: { statSync: Function, readdirSync: Function, readFileSync: Function } }} [adapters]
 * @returns {{ ok: boolean, reason: string|null, bundlePath: string, rebuildCommand: string,
 *             bundleMtimeMs: number|null, newestSourceMtimeMs: number|null,
 *             newestSourcePath: string|null, checkedFileCount: number }}
 */
function checkHostBundleFreshness(repoRoot, adapters = {}) {
  const fsImpl = adapters.fs === undefined ? fs : adapters.fs
  const bundlePath = path.join(repoRoot, ...HOST_BUNDLE_PATH_SEGMENTS)
  const base = { bundlePath, rebuildCommand: HOST_BUNDLE_REBUILD_COMMAND }
  if (
    !fsImpl ||
    typeof fsImpl.statSync !== 'function' ||
    typeof fsImpl.readdirSync !== 'function' ||
    typeof fsImpl.readFileSync !== 'function'
  ) {
    return {
      ...base,
      ok: false,
      reason: 'host_bundle_preflight_io: fs_contract',
      bundleMtimeMs: null,
      newestSourceMtimeMs: null,
      newestSourcePath: null,
      checkedFileCount: 0
    }
  }
  let bundleStat
  try {
    bundleStat = fsImpl.statSync(bundlePath)
  } catch (error) {
    const code = error && typeof error.code === 'string' ? error.code : 'io_error'
    return {
      ...base,
      ok: false,
      reason: code === 'ENOENT' ? 'host_bundle_missing' : `host_bundle_preflight_io: ${code}`,
      bundleMtimeMs: null,
      newestSourceMtimeMs: null,
      newestSourcePath: null,
      checkedFileCount: 0
    }
  }
  if (!bundleStat.isFile()) {
    return {
      ...base,
      ok: false,
      reason: 'host_bundle_missing',
      bundleMtimeMs: null,
      newestSourceMtimeMs: null,
      newestSourcePath: null,
      checkedFileCount: 0
    }
  }
  let newestSourceMtimeMs = -1
  let newestSourcePath = null
  let checkedFileCount = 0
  // Build-input set, derived rather than declared. A hand-maintained list of
  // directories silently drifts from what the compiler actually reads: the
  // previous list named three trees while the bundle is emitted from six, so
  // 74 real inputs — including the Host's own span recorder — were invisible
  // and a genuinely stale bundle read as fresh.
  const inputRelPaths = new Set()
  const outputRoot = path.join(repoRoot, ...HOST_BUNDLE_OUTPUT_SEGMENTS)
  const sourceRootPrefix = path.join(repoRoot, HOST_BUNDLE_SOURCE_ROOT) + path.sep
  let unprovenOutputRelPath = null
  const collectEmittedInputs = (dir) => {
    const entries = fsImpl.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (unprovenOutputRelPath !== null) return
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        collectEmittedInputs(full)
        continue
      }
      // Neither a directory nor a regular file — a symlink, a socket — where
      // an artifact's map should be readable. The walk cannot see through it,
      // so anything behind it would be silently unwatched: unproven, not skipped.
      if (!entry.isFile()) {
        unprovenOutputRelPath = path.relative(repoRoot, full)
        return
      }
      // The maps are read through their artifacts, never walked as inputs.
      if (!entry.name.endsWith('.js')) continue
      let sources
      let sourceRoot
      try {
        const map = JSON.parse(String(fsImpl.readFileSync(`${full}.map`, 'utf8')))
        sources = map === null || typeof map !== 'object' ? null : map.sources
        sourceRoot = map === null || typeof map !== 'object' ? null : map.sourceRoot
      } catch {
        sources = null
      }
      // A sourceRoot prefixes every mapped source, and this derivation does
      // not resolve it — honouring it wrongly would misresolve every entry
      // outside src/, silently under-watching the bundle. An EMPTY sources
      // array is no provenance at all. Both are unreadable provenance.
      if (
        !Array.isArray(sources) ||
        sources.length === 0 ||
        (sourceRoot !== undefined && sourceRoot !== null && sourceRoot !== '')
      ) {
        // An artifact whose provenance cannot be read cannot be proven fresh.
        unprovenOutputRelPath = path.relative(repoRoot, full)
        return
      }
      for (const source of sources) {
        if (typeof source !== 'string' || source === '') {
          unprovenOutputRelPath = path.relative(repoRoot, full)
          return
        }
        // Bundled artifacts also name node_modules inputs; only first-party
        // TypeScript under src/ is a source this repo can make stale.
        const absolute = path.resolve(path.dirname(full), source)
        if (!absolute.startsWith(sourceRootPrefix)) continue
        if (!absolute.endsWith('.ts') || absolute.endsWith('.test.ts')) continue
        inputRelPaths.add(path.relative(repoRoot, absolute))
      }
    }
  }
  // The include root additionally catches an ADDED source that has never been
  // compiled, which by definition has no emitted output to derive from.
  const collectIncludeRootInputs = (dir) => {
    const entries = fsImpl.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (unprovenOutputRelPath !== null) return
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        collectIncludeRootInputs(full)
        continue
      }
      // Same fail-closed rule as the emitted walk: a non-regular entry where
      // a source should be watched cannot be proven fresh.
      if (!entry.isFile()) {
        unprovenOutputRelPath = path.relative(repoRoot, full)
        return
      }
      if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue
      inputRelPaths.add(path.relative(repoRoot, full))
    }
  }
  let orphanOutputRelPath = null
  let incompleteOutputRelPath = null
  try {
    collectEmittedInputs(outputRoot)
    if (unprovenOutputRelPath === null) {
      collectIncludeRootInputs(path.join(repoRoot, ...HOST_BUNDLE_INCLUDE_ROOT_SEGMENTS))
    }
    for (const relPath of unprovenOutputRelPath === null ? [...inputRelPaths].sort() : []) {
      let stat
      try {
        stat = fsImpl.statSync(path.join(repoRoot, relPath))
      } catch (error) {
        const code = error && typeof error.code === 'string' ? error.code : 'io_error'
        if (code !== 'ENOENT') throw error
        // The bundle carries output compiled from a source that no longer
        // exists, so it cannot correspond to this working tree.
        orphanOutputRelPath = relPath
        break
      }
      if (!stat.isFile()) {
        // A derived input that is not a regular file cannot be mtime-proven.
        unprovenOutputRelPath = relPath
        break
      }
      checkedFileCount += 1
      if (stat.mtimeMs > newestSourceMtimeMs) {
        newestSourceMtimeMs = stat.mtimeMs
        newestSourcePath = relPath
      }
    }
    if (unprovenOutputRelPath === null && orphanOutputRelPath === null) {
      // A declared entry artifact that was never emitted removes its own
      // inputs from the derived set above — they appear in no map because the
      // artifact holding the map does not exist. Check the DECLARED side so a
      // partial build refuses instead of passing with that closure invisible.
      for (const segments of HOST_BUNDLE_DECLARED_ENTRY_SEGMENTS) {
        const declaredRelPath = path.join(...segments)
        let declaredStat
        try {
          declaredStat = fsImpl.statSync(path.join(repoRoot, ...segments))
        } catch (error) {
          const code = error && typeof error.code === 'string' ? error.code : 'io_error'
          if (code !== 'ENOENT') throw error
          declaredStat = null
        }
        if (declaredStat === null || !declaredStat.isFile()) {
          incompleteOutputRelPath = declaredRelPath
          break
        }
      }
    }
  } catch (error) {
    const code = error && typeof error.code === 'string' ? error.code : 'io_error'
    return {
      ...base,
      ok: false,
      reason: `host_bundle_preflight_io: ${code}`,
      bundleMtimeMs: bundleStat.mtimeMs,
      newestSourceMtimeMs: null,
      newestSourcePath: null,
      checkedFileCount
    }
  }
  if (unprovenOutputRelPath !== null) {
    return {
      ...base,
      ok: false,
      reason: `host_bundle_preflight_unproven_output: ${unprovenOutputRelPath}`,
      bundleMtimeMs: bundleStat.mtimeMs,
      newestSourceMtimeMs: null,
      newestSourcePath: unprovenOutputRelPath,
      checkedFileCount
    }
  }
  if (orphanOutputRelPath !== null) {
    return {
      ...base,
      ok: false,
      reason: `host_bundle_orphan_output: ${orphanOutputRelPath}`,
      bundleMtimeMs: bundleStat.mtimeMs,
      newestSourceMtimeMs: null,
      newestSourcePath: orphanOutputRelPath,
      checkedFileCount
    }
  }
  if (checkedFileCount === 0) {
    // The compiled trees are absent entirely — not a bundle this repo built.
    return {
      ...base,
      ok: false,
      reason: 'host_bundle_preflight_no_sources',
      bundleMtimeMs: bundleStat.mtimeMs,
      newestSourceMtimeMs: null,
      newestSourcePath: null,
      checkedFileCount: 0
    }
  }
  if (incompleteOutputRelPath !== null) {
    // A declared worker bundle is absent: the build ran without its esbuild
    // stage, so this is not a launchable Host — and its bundled closure is
    // invisible to the derivation, so freshness cannot be proven either.
    return {
      ...base,
      ok: false,
      reason: `host_bundle_incomplete_output: ${incompleteOutputRelPath}`,
      bundleMtimeMs: bundleStat.mtimeMs,
      newestSourceMtimeMs: null,
      newestSourcePath: incompleteOutputRelPath,
      checkedFileCount
    }
  }
  const stale = bundleStat.mtimeMs < newestSourceMtimeMs
  return {
    ...base,
    ok: !stale,
    reason: stale ? 'host_bundle_stale' : null,
    bundleMtimeMs: bundleStat.mtimeMs,
    newestSourceMtimeMs,
    newestSourcePath,
    checkedFileCount
  }
}

/**
 * T9b — Host span evidence collection and the runner-side QUALIFICATION CALL
 * (wave-8 ruling P4).
 *
 * The collector stays legacy-tolerant at its layer and cannot make this call;
 * the runner makes it. A cell is QUALIFIED only when ALL of:
 *   1. the live authenticated welcome + discovery supplied the pin
 *      (probeHostBootstrapIdentity — out-of-band, never the snapshot file);
 *   2. the snapshot read was accepted whole (any refusal marker disqualifies);
 *   3. the snapshot identity CARRIES a bootEpoch and it is verified against
 *      the pin (identityVerified) — a legacy epoch-free run is recorded and
 *      left UNQUALIFIED, never green;
 *   4. attribution is 'available' for the designated chat population;
 *   5. the main-process section sampled validly (cross-thread evidence needs
 *      both sides);
 *   6. a canonical matrix cell was specified (--cell) and the fold through
 *      applyCrossThreadToMetrics({ requireHostAttribution: true }) succeeded.
 * Every other outcome records an explicit NAMED marker in report.hostSpans
 * and leaves the cell unqualified. A report carrying zero qualified host
 * evidence is visibly unqualified.
 *
 * TOKEN CONTAINMENT: the discovery tokenPath/token never enter the record —
 * the probe result is already token-free and only bounded identity fields
 * are copied here. Named tests pin this at both layers.
 *
 * @param {object} options
 * @param {string} options.userDataPath — inspector-observed when available
 * @param {string} options.hostPerfSnapshotPath — the armed artifact path
 * @param {string[]} options.requiredChatIds — the fixture's designated chats
 * @param {string|null} options.cell — canonical matrix cell name or null
 * @param {object|null} options.renderer — renderer CDP session (.post)
 * @param {object} options.metrics — report.metrics, folded in place when qualified
 * @param {Function} [options.probe] — DI override for probeHostBootstrapIdentity
 * @param {Function} [options.sampler] — DI override for sampleHostSpans
 * @param {object} [options.fs] — discovery fs DI
 * @param {object} [options.snapshotFs] — collector fs DI (lstat/open/fstat/read/closeSync contract)
 * @param {Function} [options.connect] — socket factory DI for the welcome probe
 * @param {Function} [options.sleep] — discovery poll sleep DI
 * @param {number} [options.maxWaitMs] / @param {number} [options.intervalMs] — discovery poll bounds
 * @param {number} [options.welcomeTimeoutMs]
 * @param {Function} [options.now] — Date-returning clock for freshness + capturedAt
 * @param {number} [options.maxAgeMs]
 * @returns {Promise<{ ok: boolean, record: object }>}
 */
async function collectT2HostSpanEvidence(options) {
  const metrics = options.metrics
  const cell = options.cell == null ? null : String(options.cell)
  const requiredChatIds = Array.isArray(options.requiredChatIds) ? options.requiredChatIds : []
  const probe = typeof options.probe === 'function' ? options.probe : probeHostBootstrapIdentity
  const sampler = typeof options.sampler === 'function' ? options.sampler : sampleHostSpans
  const record = {
    qualified: false,
    marker: null,
    cell,
    folded: false,
    discoveryPid: null,
    welcome: null,
    expectedIdentity: null,
    identity: null,
    attribution: null,
    ageMs: null,
    sequence: null
  }
  const fail = (marker) => {
    // Bounded marker: reasons come from enumerated code sets (probe/collector),
    // but the runner never lets an upstream string of unbounded length into
    // the report.
    record.marker = String(marker).slice(0, 200)
    return { ok: false, record }
  }
  const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

  // 1. Live pin: discovery + ONE authenticated hello → welcome → disconnect.
  const probed = await probe({
    userDataPath: options.userDataPath,
    ...(options.fs === undefined ? {} : { fs: options.fs }),
    ...(options.connect === undefined ? {} : { connect: options.connect }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    ...(options.nowMs === undefined ? {} : { nowMs: options.nowMs }),
    ...(options.maxWaitMs === undefined ? {} : { maxWaitMs: options.maxWaitMs }),
    ...(options.intervalMs === undefined ? {} : { intervalMs: options.intervalMs }),
    ...(options.welcomeTimeoutMs === undefined ? {} : { timeoutMs: options.welcomeTimeoutMs })
  })
  if (!isObject(probed) || probed.ok !== true || !isObject(probed.expectedIdentity)) {
    const stage = isObject(probed) && probed.stage === 'welcome' ? 'welcome' : 'discovery'
    const reason =
      isObject(probed) && typeof probed.reason === 'string' ? probed.reason : 'probe_invalid_result'
    return fail(`host_${stage}_unavailable: ${reason}`)
  }
  record.discoveryPid = isObject(probed.discovery) ? probed.discovery.pid : null
  // Bounded copies (token containment is STRUCTURAL, not contractual): only
  // the identity fields the collector pin needs may enter the report. A
  // probe result carrying anything else — token, tokenPath, socketPath,
  // unknown keys — is dropped here, never forwarded.
  const probedWelcome = isObject(probed.welcome) ? probed.welcome : null
  record.welcome = probedWelcome
    ? {
        hostId: typeof probedWelcome.hostId === 'string' ? probedWelcome.hostId : null,
        generation: Number.isSafeInteger(probedWelcome.generation)
          ? probedWelcome.generation
          : null,
        ...(typeof probedWelcome.hostVersion === 'string'
          ? { hostVersion: probedWelcome.hostVersion }
          : {}),
        ...(typeof probedWelcome.bootEpoch === 'string'
          ? { bootEpoch: probedWelcome.bootEpoch }
          : {})
      }
    : null
  const pin = probed.expectedIdentity
  record.expectedIdentity = {
    instanceId: pin.instanceId,
    generation: pin.generation,
    pid: pin.pid,
    ...(pin.bootEpoch === undefined ? {} : { bootEpoch: pin.bootEpoch })
  }

  // 2. Sample: the main section rides the renderer session; the Host file
  //    read rides along independently (session-independence is pinned by the
  //    transport tests).
  const sampled = await sampler(options.renderer == null ? null : options.renderer, {
    ...(options.hostPerfSnapshotPath === undefined
      ? {}
      : { hostPerfSnapshotPath: options.hostPerfSnapshotPath }),
    expectedIdentity: probed.expectedIdentity,
    requiredChatIds,
    ...(options.snapshotFs === undefined ? {} : { fs: options.snapshotFs }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.maxAgeMs === undefined ? {} : { maxAgeMs: options.maxAgeMs })
  })
  const hostPerf = isObject(sampled) && isObject(sampled.hostPerf) ? sampled.hostPerf : null
  if (!hostPerf) return fail('host_snapshot_refused: sampler_invalid_result')
  if (typeof hostPerf.unsupported === 'string') {
    return fail(`host_snapshot_refused: ${hostPerf.unsupported}`)
  }
  const hostSection = hostPerf.workSpans
  const meta = isObject(hostSection) ? hostSection.hostSnapshot : null
  if (!isObject(meta)) return fail('host_snapshot_refused: host_snapshot_metadata_missing')
  record.identity = meta.identity
  record.attribution = meta.attribution
  record.ageMs = typeof meta.ageMs === 'number' ? meta.ageMs : null
  record.sequence = Number.isSafeInteger(meta.sequence) ? meta.sequence : null

  // 3. Qualification (ruling P4): epoch present AND verified. The reader
  //    gate already refuses a pinned epoch that is missing or different
  //    (whole-read identity_mismatch), and coverage 'unpinned' forces
  //    identityVerified false — so these checks re-derive the qualification
  //    from the committed metadata without needing the collector's internal
  //    bootEpochCoverage (which is not exported).
  if (!isObject(meta.identity) || meta.identity.bootEpoch === undefined) {
    return fail('host_evidence_unqualified: boot_epoch_absent')
  }
  if (meta.identityVerified !== true) {
    return fail('host_evidence_unqualified: identity_unverified')
  }
  // Defence in depth for future callers (unreachable through today's reader
  // gate, per Review2's M5 note): the identity epoch must equal the pin.
  if (
    isObject(probed.expectedIdentity) &&
    probed.expectedIdentity.bootEpoch !== undefined &&
    meta.identity.bootEpoch !== probed.expectedIdentity.bootEpoch
  ) {
    return fail('host_evidence_unqualified: boot_epoch_mismatch')
  }
  if (!isObject(meta.attribution) || meta.attribution.status !== 'available') {
    const reason =
      isObject(meta.attribution) && typeof meta.attribution.reason === 'string'
        ? meta.attribution.reason
        : 'unavailable'
    return fail(`host_evidence_unqualified: attribution_${reason}`)
  }

  // 4. Cross-thread evidence needs BOTH sides: a degraded main section is
  //    recorded, never folded.
  const mainSection = isObject(sampled) && isObject(sampled.workSpans) ? sampled.workSpans : null
  if (!mainSection || typeof mainSection.unsupported === 'string') {
    const reason =
      mainSection && typeof mainSection.unsupported === 'string'
        ? mainSection.unsupported
        : 'sampler_invalid_result'
    return fail(`main_perf_section_unavailable: ${reason}`)
  }

  // 5. Fold — only through applyCrossThreadToMetrics with the strict host
  //    attribution requirement, and only into a canonical cell.
  if (cell === null) return fail('cross_thread_cell_unspecified')
  if (parseCellName(cell) === null) return fail(`cross_thread_cell_invalid: ${cell}`)
  if (!isObject(metrics)) return fail('cross_thread_fold_failed: metrics_required')
  try {
    applyCrossThreadToMetrics(
      metrics,
      cell,
      { main: mainSection, host: hostSection },
      { requireHostAttribution: true, ...(options.now === undefined ? {} : { now: options.now }) }
    )
  } catch (error) {
    const message = String(error && error.message ? error.message : error).slice(0, 200)
    return fail(`cross_thread_fold_failed: ${message}`)
  }
  record.qualified = true
  record.folded = true
  return { ok: true, record }
}

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

/** The line bootstrap prints when it abandons the default external Host. */
const HOST_LANE_FALLBACK_MARKER = '[main-bootstrap] external Host unavailable'

/**
 * Can the app launch the DEFAULT external Host from this checkout?
 *
 * `TASKWRAITH_DESKTOP_EXTERNAL_HOST` defaults ON, so the external Host is what
 * users run and what the cross-thread taxonomy models. But bootstrap falls back
 * to the in-process Host — logging, and continuing — whenever
 * `resolveHostExternalLaunch` returns null, and it returns null when EITHER the
 * Host CLI or the development Node is missing.
 *
 * The CLI half is already covered: `checkHostBundleFreshness` stats
 * out/host/host-runtime/cli.js and refuses a stale or missing bundle. The
 * development Node was covered by nothing, and it is the half that bit:
 * `build/tui-runtime/**` is gitignored and `npm run host:build` does not
 * produce it, so a fresh `git worktree add` carries the README and nothing
 * else. Five attempts measured an architecture nobody ships because a 113 MB
 * ignored binary did not come along.
 *
 * Mirrors developmentNodeExecutable (src/main/bootstrap.ts) — env first, then
 * the vendored runtime — and must move if that does.
 */
function checkExternalHostNodeExecutable(repoRoot, options = {}) {
  const env = options.env || process.env
  const platform = options.platform || process.platform
  const arch = options.arch || process.arch
  const exists = typeof options.exists === 'function' ? options.exists : (at) => fs.existsSync(at)
  let source = 'vendored'
  let nodeExecutable = null
  for (const [name, value] of [
    ['npm_node_execpath', env.npm_node_execpath],
    ['NODE', env.NODE]
  ]) {
    if (typeof value === 'string' && value.trim() === value && path.isAbsolute(value)) {
      nodeExecutable = path.resolve(value)
      source = name
      break
    }
  }
  if (nodeExecutable === null) {
    nodeExecutable = path.resolve(
      repoRoot,
      'build',
      'tui-runtime',
      `${platform}-${arch}`,
      platform === 'win32' ? 'node.exe' : 'node'
    )
  }
  const present = exists(nodeExecutable)
  return {
    ok: present,
    nodeExecutable,
    source,
    reason: present ? null : 'development_node_missing'
  }
}

/**
 * The lane the app actually took, from positive evidence only.
 *
 * The bootstrap marker is the app saying it fell back, which is proof. A
 * discovery pid that differs from the launched child is proof of a separate
 * Host process. Neither present means `unknown` — pid EQUALITY is corroboration
 * for in-process, never proof, and this run has been burned once already by
 * treating an inference as a finding.
 */
function resolveObservedHostLane(input) {
  if (typeof input.fallbackLine === 'string' && input.fallbackLine) {
    return {
      observed: 'in_process',
      evidence: 'child_stderr_bootstrap_marker',
      reason: input.fallbackLine
    }
  }
  if (
    Number.isInteger(input.discoveryPid) &&
    Number.isInteger(input.childPid) &&
    input.discoveryPid !== input.childPid
  ) {
    return { observed: 'external', evidence: 'discovery_pid_differs_from_child', reason: null }
  }
  return { observed: 'unknown', evidence: null, reason: null }
}

/** Bytes of stderr held in memory for lane detection, independent of file flush. */
const CHILD_STDERR_HEAD_BYTES = 256 * 1024

/** Bytes of child output kept per stream before the capture truncates. */
const DEFAULT_CHILD_STDIO_MAX_BYTES = 8 * 1024 * 1024

/**
 * Drain and record the child's stdout and stderr.
 *
 * The spawn opens both pipes (`stdio: ['ignore', 'pipe', 'pipe']`) and until now
 * nothing read either one. Two consequences, the second worse than the first:
 *
 * - Everything the app said about itself was discarded. `bootstrap.ts` prints
 *   `[main-bootstrap] external Host unavailable; using in-process Host: …` when
 *   it falls back, and five attempts measured the wrong architecture without
 *   that line ever reaching an artifact — it took a code trace to recover a
 *   sentence the child had already printed.
 * - An unread pipe fills, and a child blocked writing to a full stdout stops
 *   making progress while its workers keep spinning. That is a candidate, not a
 *   finding, for attempt 4's stall; draining is both the fix and the experiment.
 *
 * Bounded by bytes and ALWAYS drained: past the cap the overflow is counted and
 * dropped rather than left in the pipe, because leaving it there is the defect.
 *
 * @param {object} session — the spawned child
 * @param {{ write: Function, maxBytes?: number }} options
 * @returns {{ bytes: number, droppedBytes: number, truncated: boolean, streams: string[],
 *            stderrHead: string }}
 */
function captureChildStdio(session, options) {
  const maxBytes =
    options && options.maxBytes != null ? options.maxBytes : DEFAULT_CHILD_STDIO_MAX_BYTES
  const write = options && typeof options.write === 'function' ? options.write : () => {}
  // A bounded, in-memory head of stderr. The lane marker is read from HERE and
  // not from the log file: the file sinks are still open when the report is
  // assembled, and a write stream that has not drained would make an unflushed
  // marker read as `unknown` — an absence of evidence presenting as evidence.
  const record = { bytes: 0, droppedBytes: 0, truncated: false, streams: [], stderrHead: '' }
  const attach = (stream, name) => {
    if (!stream || typeof stream.on !== 'function') return
    record.streams.push(name)
    stream.on('data', (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8')
      const room = Math.max(0, maxBytes - record.bytes)
      const kept = room === 0 ? null : buffer.subarray(0, room)
      const keptLength = kept === null ? 0 : kept.length
      if (buffer.length > keptLength) {
        record.droppedBytes += buffer.length - keptLength
        record.truncated = true
      }
      if (keptLength === 0) return
      record.bytes += keptLength
      if (name === 'stderr' && record.stderrHead.length < CHILD_STDERR_HEAD_BYTES) {
        record.stderrHead += kept
          .subarray(0, CHILD_STDERR_HEAD_BYTES - record.stderrHead.length)
          .toString('utf8')
      }
      try {
        write(name, kept)
      } catch {
        // A diagnostic sink must never fail the run it is describing.
      }
    })
    stream.on('error', () => {
      // A pipe closing under teardown is not a run failure.
    })
  }
  attach(session.stdout, 'stdout')
  attach(session.stderr, 'stderr')
  return record
}

/**
 * The exit code an externally terminated run must leave with.
 *
 * Installing a signal listener suppresses Node's default disposition, so the
 * runner left through the ordinary drain with code 0 and read as success to any
 * operator or CI checking `$?`. Attempt 4 reported T2_EXIT 0 after an 18-minute
 * stall that wrote no report; attempt 3, before the listener existed, exited 143
 * and was honest about it. The signal's own conventional code is the honest one,
 * and the one thing it is never is 0.
 *
 * @param {string|null} signalName
 * @returns {number}
 */
function abortExitCode(signalName) {
  return signalName === 'SIGINT' ? 130 : 143
}

/**
 * One half of a paired run, in the shape the report carries it.
 *
 * `pairRuns` refuses the pair receipt for ANY ineligible run, and that receipt
 * was the only artifact carrying the light-alone half: `report.runEvidence` is
 * built from the beside run, and `report.pairedRuns` carried roles and booleans
 * only. So a censored run kept beside's coverage and signals and lost alone's
 * entirely — and with it the light-alone vs light-beside delta, which is the
 * whole point of pairing. Both halves are recorded here whatever pairRuns
 * decides; `report.pairs` still means qualified, and nothing reads this as
 * evidence.
 *
 * @param {object|null} result — a runConcurrentReplayLanes result
 * @returns {object|null}
 */
function pairedRunRecord(result) {
  if (!result || typeof result !== 'object' || !result.run) return null
  const run = result.run
  const evidence = run.evidence && typeof run.evidence === 'object' ? run.evidence : null
  return {
    pairingRole: run.role == null ? null : run.role,
    windowMs: run.windowMs == null ? null : run.windowMs,
    repetitions: run.repetitions == null ? null : run.repetitions,
    status: evidence && evidence.status != null ? evidence.status : null,
    failed: run.failed === true,
    censored: run.censored === true,
    incomplete: run.incomplete === true,
    unsupported: run.unsupported === true,
    evidenceEligible: result.evidenceEligible === true,
    signals: run.signals && typeof run.signals === 'object' ? run.signals : null,
    windows: evidence && Array.isArray(evidence.windows) ? evidence.windows : []
  }
}

/**
 * The force/reap facts `terminateExactChild` returns, in the shape the report
 * and the progress journal carry them.
 *
 * `strayKills` names processes this run SIGKILLed but never spawned directly —
 * the port and userData-path reap. Both call sites dropped the return value, so
 * a forced ejection left no trace in any artifact: the run read as a clean
 * shutdown. Recorded unconditionally, because "nothing failed" is exactly the
 * case where a silent SIGKILL is invisible.
 *
 * @param {object|null} termination
 * @returns {{ usedForce: boolean, killedProcessGroup: boolean, strayKills: Array<object> }|null}
 */
function childTerminationRecord(termination) {
  if (!termination || typeof termination !== 'object') return null
  return {
    usedForce: termination.usedForce === true,
    killedProcessGroup: termination.killedProcessGroup === true,
    strayKills: Array.isArray(termination.strayKills) ? termination.strayKills : [],
    // null, never true, when the terminate did not say: the absence of a claim
    // is not a claim of support, and an empty strayKills means nothing without
    // it — on win32 the probes cannot run at all.
    strayReapSupported:
      typeof termination.strayReapSupported === 'boolean' ? termination.strayReapSupported : null
  }
}

/**
 * Check free disk space on the volume containing `dirPath`. Fails closed
 * when statfs is unavailable or free space is below minFreeBytes.
 *
 * @param {string} dirPath
 * @param {number} minFreeBytes
 * @param {{ statfsSync?: Function }} [adapters]
 * @returns {{ ok: boolean, freeBytes: number, minFreeBytes: number, note: string | null }}
 */
function checkDiskHeadroom(dirPath, minFreeBytes, adapters = {}) {
  const statfsSync = 'statfsSync' in adapters ? adapters.statfsSync : fs.statfsSync
  if (typeof statfsSync !== 'function') {
    return {
      ok: false,
      freeBytes: 0,
      minFreeBytes,
      note: 'statfsSync unavailable — cannot verify disk headroom'
    }
  }
  let stat
  try {
    stat = statfsSync(dirPath)
  } catch (error) {
    return {
      ok: false,
      freeBytes: 0,
      minFreeBytes,
      note: `statfsSync failed: ${String(error && error.message ? error.message : error)}`
    }
  }
  if (!stat || typeof stat.bsize !== 'number' || typeof stat.bavail !== 'number') {
    return {
      ok: false,
      freeBytes: 0,
      minFreeBytes,
      note: 'statfs returned incomplete data'
    }
  }
  const freeBytes = stat.bsize * stat.bavail
  const freeGib = (freeBytes / (1024 * 1024 * 1024)).toFixed(1)
  const needGib = (minFreeBytes / (1024 * 1024 * 1024)).toFixed(0)
  if (freeBytes < minFreeBytes) {
    return {
      ok: false,
      freeBytes,
      minFreeBytes,
      note: `only ${freeGib} GiB free on artifact volume; need ≥${needGib} GiB`
    }
  }
  return {
    ok: true,
    freeBytes,
    minFreeBytes,
    note: `${freeGib} GiB free (≥${needGib} GiB required)`
  }
}

/**
 * Sliding-window rate tracker — computes evt/s over the last windowMs.
 *
 * @param {number} windowMs
 * @param {{ nowMs?: Function }} [options]
 */
function createWindowedRateTracker(windowMs, options = {}) {
  const nowMs = options.nowMs || Date.now
  /** @type {{ ts: number, completed: number }[]} */
  let window = []
  let lastCumulativeRate = 0

  /** @param {number} completedEvents */
  function push(completedEvents) {
    const ts = nowMs()
    window.push({ ts, completed: completedEvents })
    // Trim entries older than windowMs
    const cutoff = ts - windowMs
    while (window.length > 1 && window[0].ts < cutoff) {
      window.shift()
    }
    // Compute windowed rate
    if (window.length >= 2) {
      const first = window[0]
      const last = window[window.length - 1]
      const deltaMs = last.ts - first.ts
      const deltaEvents = last.completed - first.completed
      lastCumulativeRate = deltaMs > 0 ? (deltaEvents * 1000) / deltaMs : 0
    }
    return lastCumulativeRate
  }

  function snapshot() {
    return {
      windowedRateEvtPerSec: lastCumulativeRate,
      windowSizeMs: windowMs,
      windowPointCount: window.length
    }
  }

  return { push, snapshot }
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
    skipBuild: false,
    windowedReplay: false,
    pairedRuns: false
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
    else if (arg === '--windowed-replay') out.windowedReplay = true
    else if (arg === '--accept-in-process-host') out.acceptInProcessHost = true
    else if (arg === '--accept-unfolded-cross-thread') out.acceptUnfoldedCrossThread = true
    else if (arg === '--paired-runs') out.pairedRuns = true
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
    else if (arg.startsWith('--cell=')) out.cell = arg.slice('--cell='.length)
    else if (arg.startsWith('--role=')) out.role = arg.slice('--role='.length)
    else if (arg.startsWith('--build-id=')) out.buildId = arg.slice('--build-id='.length)
    else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  return out
}

/**
 * Windowed-replay journal/report totals. The lanes driver owns the observed
 * windows; this only sums its per-window lane counters for progress UX and
 * the report block. Evidence eligibility always comes from the descriptor.
 */
function summarizeWindowedReplay(result) {
  const windows = result?.run?.evidence?.windows || []
  let completedEvents = 0
  let failedEvents = 0
  for (const window of windows) {
    for (const lane of window?.lanes || []) {
      completedEvents += lane.completedEvents || 0
      failedEvents += lane.failedEvents || 0
    }
  }
  return {
    windows: windows.length,
    completedEvents,
    failedEvents,
    // Why the replay stopped where it did. Attempt 4 reported replayWindows: 1
    // against repetitions: 3 and left the cause to be inferred from an event
    // count; the outcome and fence reason of each window say it outright.
    outcomes: windows.map((window) => ({
      outcome: window?.outcome ?? null,
      reason: window?.reason ?? null
    })),
    unsupported: Array.isArray(result?.unsupported) ? result.unsupported : []
  }
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
  --cell=<canonical>                Canonical matrix cell (<history>/<chats>/<path>/<mix>/<saturation>) for the
                                    crossThread host-span fold and the run-evidence descriptor; --launch
                                    REFUSES without it (see --accept-unfolded-cross-thread)
  --role=<light-alone|light-beside> Pairing role this run measures; omitted → run identity left undeclared
  --build-id=<id>                   Operator-named build identity for pairing; omitted → left undeclared
  --accept-in-process-host        Measure the in-process Host deliberately when the external Host
                                  cannot resolve. Without it the launch refuses rather than
                                  silently measuring an architecture users do not run.
  --accept-unfolded-cross-thread  Record host-span evidence deliberately WITHOUT folding it, when no
                                  --cell is given. Without it the launch refuses rather than spending
                                  a full run to produce metrics.crossThread: null.
  --windowed-replay               Replay as fenced 120 s × 3 concurrent lanes (default: sequential);
                                  runs ≥6 min, refuses --max-replay-events, feeds observed windows to runEvidence
  --paired-runs                   Run light-alone then light-beside and emit report.pairs (implies
                                  --windowed-replay; ≥12 min). Requires --cell and --build-id; refuses
                                  --role and --max-replay-events; a single-chat fixture cannot pair
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

  // Optional canonical matrix cell for the crossThread fold (T9b). Validated
  // BEFORE the smoke-plan return below, not after: --smoke-plan used to exit 0
  // on a cell parseCellName rejects, so the one mode whose entire purpose is to
  // print what a run would do did not check the argument it was printing.
  const crossThreadCell = args.cell == null ? null : String(args.cell)
  if (crossThreadCell !== null && parseCellName(crossThreadCell) === null) {
    throw new Error(
      `--cell must be a canonical matrix cell name (<history>/<chats>/<path>/<mix>/<saturation>): ${crossThreadCell}`
    )
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

  // Declared run identity for the run-evidence descriptor (Wall 2a). Like
  // --cell, validated here so a typo fails before any I/O, never at fold time.
  const pairingRole = args.role == null ? null : String(args.role)
  if (pairingRole !== null && !PAIRING_ROLES.includes(pairingRole)) {
    throw new Error(`--role must be one of ${PAIRING_ROLES.join('|')}: ${pairingRole}`)
  }
  const buildId = args.buildId == null ? null : String(args.buildId)
  if (buildId !== null && buildId.trim().length === 0) {
    throw new Error('--build-id must be a non-empty build identity when declared')
  }

  // Paired runs are a layer on windowed replay: two lane configurations of the
  // same fixture, then pairRuns. Identity must be declared up front — pairRuns
  // cannot qualify an undeclared cell or build, and a single --role contradicts
  // producing both roles.
  if (args.pairedRuns) {
    if (pairingRole !== null) {
      throw new Error('--paired-runs produces both pairing roles; refuse --role with it')
    }
    if (crossThreadCell === null) {
      throw new Error('--paired-runs requires --cell so the pair names a canonical matrix cell')
    }
    if (buildId === null) {
      throw new Error('--paired-runs requires --build-id so the pair shares a named build')
    }
    if (args.maxReplayEvents != null) {
      throw new Error(
        '--max-replay-events applies to sequential replay only; refuse --paired-runs with it'
      )
    }
    args.windowedReplay = true
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

  // Resolved before the spawn plan so the launch env can carry the armed
  // Host perf snapshot artifact path (M1 host span transport). mkdir stays
  // at its original position below.
  const artifactDir = path.resolve(
    String(
      args.artifactDir ||
        args.outDir ||
        path.join(os.tmpdir(), `taskwraith-perf-t2-${userDataResolved.sanitizedInstanceId}`)
    )
  )
  // Absolute artifact path handed to the app via TASKWRAITH_PERF_HOST_SNAPSHOT_PATH;
  // main's bootstrap forwards process.env to the external Host launch, and
  // HostNodeProductionServer arms the snapshot writer with it (absolute used
  // as-is). Only set for a real launch — dry runs must not arm anything.
  const hostSnapshotPath = path.join(artifactDir, HOST_PERF_SNAPSHOT_FILE_NAME)

  const spawnPlan = buildElectronSpawnPlan({
    instanceId: userDataResolved.sanitizedInstanceId,
    repoRoot,
    remoteDebuggingPort: args.port == null ? undefined : Number(args.port),
    mainInspectorPort: args.inspectPort == null ? undefined : Number(args.inspectPort),
    workload,
    fxPosture,
    userDataPath: userDataResolved.userDataPath,
    home,
    platform: options.platform || process.platform,
    extraEnv: willLaunch ? { TASKWRAITH_PERF_HOST_SNAPSHOT_PATH: hostSnapshotPath } : undefined
  })

  const fixture = generatePerfFixture({
    workload,
    seed,
    lean: Boolean(args.lean),
    scaleDown
  })
  const fingerprint = fixtureFingerprint(fixture)

  // Does the fixture support the history label its cell claims? Nothing
  // compared them before: --cell was checked for SYNTAX and --workload for
  // MEMBERSHIP, so `--workload=dual_run --cell=large/...` returned ok and wrote
  // `history: "large"` into a report over an 18-message fixture. Both numbers
  // were in hand the whole time and were never held up against each other.
  //
  // Checked HERE rather than at parse time because the answer depends on
  // --scale-down and --lean, not on the workload name: light_beside_large meets
  // the large pin at --scale-down=1 (27,042 messages, 45.17 MiB) and misses it
  // by 40x at the default 40 (696, 1.18 MiB). A workload-name check would pass
  // the mislabelled run and refuse nothing.
  if (crossThreadCell !== null) {
    const cellShape = parseCellName(crossThreadCell)
    const fixtureShape = {
      messages: fixture.chats.reduce((total, chat) => total + chat.messages.length, 0),
      bytes: Buffer.byteLength(JSON.stringify(fixture.chats))
    }
    const satisfies = checkFixtureSatisfiesHistory(cellShape.history, fixtureShape)
    if (!satisfies.ok) {
      const shapeErr = new Error(
        `Refusing --cell=${crossThreadCell}: ${satisfies.reason}. The report would carry history: "${cellShape.history}" over a fixture that is not that size, and read as authoritative. Use a workload and --scale-down that produce the pinned shape, or a cell whose history matches this fixture.`
      )
      shapeErr.code = 'T2_CELL_FIXTURE_SHAPE_MISMATCH'
      throw shapeErr
    }
  }

  if (args.pairedRuns && fixture.chats.length < 2) {
    throw new Error(
      '--paired-runs requires a fixture with a heavy chat; a single-chat workload cannot pair'
    )
  }

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
    // Provenance of the armed Host perf snapshot transport (null unless a
    // real launch carries TASKWRAITH_PERF_HOST_SNAPSHOT_PATH into the child).
    hostPerfSnapshotPath: willLaunch ? hostSnapshotPath : null,
    safety: spawnPlan.safety
  }
  report.isolation = isolationVerification
  report.diskHeadroom = null
  report.captureDeadline = null
  report.replayWindowedRate = null
  // Wave-8 M1 seams; populated only on a real launch (preflight hard-fails a
  // stale Host bundle; hostSpans carries the qualification call, ruling P4).
  report.hostBundlePreflight = null
  report.hostSpans = null

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
  // Sticky: an abort that arrives before the spawn has no child to kill, and
  // the listener is `{ once: true }`, so without this the signal is consumed
  // and forgotten and the launch proceeds as if it never happened.
  let launchAborted = false
  const abortOwnedLaunch = () => {
    launchAborted = true
    // Terminalise straight away. An aborted run that never unwinds leaves the
    // journal saying `running` forever — attempt 4 sat there for 18 minutes
    // after its SIGTERM, which reads as a run still in flight. The phase it died
    // in is already in the record and the merge preserves it.
    try {
      updateProgress({ status: 'aborted' }, { log: false })
    } catch {
      /* nothing to escalate to during an abort */
    }
    const session = childSession
    if (!session) return
    Promise.resolve(
      terminateExactChild(session, {
        ...(options.terminateOptions || {}),
        userDataPath: userDataResolved.userDataPath
      })
    )
      .then((termination) => {
        const record = childTerminationRecord(termination)
        if (!record) return
        // The cleanup block usually DOES run on an abort and writes its own
        // childTermination — but from a SECOND terminateExactChild, whose live
        // port and command-needle probes find the strays this call already
        // killed, so it records none (measured: first call reports both strays,
        // second reports []). This is therefore the only record of what an abort
        // actually killed, and the only record at all when the run is wedged
        // badly enough that cleanup never completes. Best effort either way: a
        // failed journal write must not mask the abort it is describing.
        try {
          updateProgress({ abortTermination: record }, { log: false })
        } catch {
          /* nothing to escalate to during an abort */
        }
      })
      .catch(() => {})
  }
  if (options.signal) {
    if (options.signal.aborted) abortOwnedLaunch()
    else options.signal.addEventListener('abort', abortOwnedLaunch, { once: true })
  }
  /** @type {object|null} */
  let replayResult = null
  /** @type {object|null} — lanes-driver result when --windowed-replay selects windowed replay */
  let windowedReplayResult = null
  /** @type {object|null} — paired-run adapter result when --paired-runs selects both roles */
  let pairedReplayResult = null

  /**
   * Shared windowed / paired replay options. Sequential replay keeps its own
   * progress callbacks; this only selects the lanes-driver path.
   */
  async function runWindowedOrPairedReplay(api, extra = {}) {
    const shared = {
      fixture,
      api,
      ...(crossThreadCell == null ? {} : { cellName: crossThreadCell }),
      workload,
      seed,
      fixtureFingerprint: fingerprint,
      ...(buildId == null ? {} : { buildId }),
      ...extra
    }
    if (args.pairedRuns) {
      pairedReplayResult = await runT2PairedReplay(shared)
      windowedReplayResult = pairedReplayResult.beside
      return
    }
    windowedReplayResult = await runT2WindowedReplay({
      ...shared,
      ...(pairingRole == null ? {} : { pairingRole })
    })
  }
  let profilesCaptured = false
  // T9a: true only when the main-process persistence counters were genuinely
  // sampled. Gates `claimMetricsCollected` — a run that could not sample must
  // never claim measured metrics.
  let persistenceStatsOk = false
  /** @type {object|null} */
  let buildResult = null
  /** @type {Error|null} */
  let launchError = null
  /** @type {{ stdout: object, stderr: object }|null} — child log sinks, closed in teardown */
  let childStdioSinks = null
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

      setCapturePhase('disk_headroom_preflight', {}, { log: true })
      const minFreeBytes =
        options.minFreeDiskBytes == null ? DEFAULT_MIN_FREE_DISK_BYTES : options.minFreeDiskBytes
      const headroomResult = checkDiskHeadroom(artifactDir, minFreeBytes, options.diskAdapters)
      report.diskHeadroom = {
        preflight: headroomResult,
        preCapture: null,
        minFreeBytes
      }
      if (!headroomResult.ok) {
        const headroomErr = new Error(
          `Disk headroom preflight failed: ${headroomResult.note || 'unknown'}`
        )
        headroomErr.code = 'T2_DISK_HEADROOM_PREFLIGHT'
        throw headroomErr
      }
      updateProgress(
        { diskHeadroomGib: (headroomResult.freeBytes / (1024 * 1024 * 1024)).toFixed(1) },
        { log: true }
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

      // Ruling P2 (wave-8): the external Host bundle is NOT part of
      // runIsolatedBuild. Hard-fail BEFORE launch when out/host/host-runtime/
      // cli.js is missing, or older than the newest source in the bundle's
      // own compilation closure — read from the emitted sourcemaps rather
      // than a hand-kept directory list, so it tracks the build. See
      // checkHostBundleFreshness for the derivation and its residual. Emit
      // the exact rebuild command; never rebuild implicitly. Runs on every
      // launch path, including --skip-build (which never builds anything).
      setCapturePhase('host_bundle_preflight', {}, { log: true })
      const hostBundleCheck = checkHostBundleFreshness(repoRoot, options.hostBundleAdapters || {})
      report.hostBundlePreflight = hostBundleCheck
      if (!hostBundleCheck.ok) {
        const detail =
          hostBundleCheck.reason === 'host_bundle_missing'
            ? 'Host bundle out/host/host-runtime/cli.js is missing'
            : hostBundleCheck.reason === 'host_bundle_stale'
              ? `Host bundle out/host/host-runtime/cli.js is older than ${hostBundleCheck.newestSourcePath}`
              : `Host bundle preflight could not prove freshness (${hostBundleCheck.reason})`
        const bundleErr = new Error(
          `Refusing launch: ${detail}. Run \`${HOST_BUNDLE_REBUILD_COMMAND}\` and retry — this runner never rebuilds the Host bundle implicitly.`
        )
        bundleErr.code = 'T2_HOST_BUNDLE_STALE'
        throw bundleErr
      }

      // The other half of the same launch. The bundle check above proves the
      // Host CLI; this proves the Node that would run it.
      const hostNodeCheck = checkExternalHostNodeExecutable(
        repoRoot,
        options.externalHostAdapters || {}
      )
      report.hostLane = {
        expected: 'external',
        acceptedInProcess: Boolean(args.acceptInProcessHost),
        nodeExecutable: hostNodeCheck,
        observed: 'unknown',
        evidence: null,
        reason: null
      }
      if (!hostNodeCheck.ok && !args.acceptInProcessHost) {
        const laneErr = new Error(
          `Refusing --launch: the external Host cannot resolve from this checkout (${hostNodeCheck.reason}: ${hostNodeCheck.nodeExecutable}), so the app would log a fallback and measure the IN-PROCESS Host — an architecture users do not run. Provide the development Node (\`npm run tui:build\` in this checkout, or an absolute NODE/npm_node_execpath), or pass --accept-in-process-host to measure the fallback deliberately.`
        )
        laneErr.code = 'T2_EXTERNAL_HOST_UNRESOLVABLE'
        throw laneErr
      }

      // The fold needs a canonical cell as much as a paired run does, and
      // nothing required one for a single-role launch: --cell was checked for
      // CANONICALITY when present and never for PRESENCE. A run without it
      // spends its full length, records host evidence, and reports
      // `metrics.crossThread: null` with `cross_thread_cell_unspecified` —
      // discoverable only after the run, and only by an operator who reads the
      // marker. Attempt 6 carried a cell because the operator kept it "for
      // provenance" after dropping --paired-runs; a preflight exists to remove
      // exactly that dependency on remembering. Ordered after the lane refusal
      // above: measuring the wrong architecture is the more fundamental
      // failure, and a new check must not reorder an existing one.
      report.crossThreadFold = {
        cell: crossThreadCell,
        acceptedUnfolded: Boolean(args.acceptUnfoldedCrossThread)
      }
      if (crossThreadCell === null && !args.acceptUnfoldedCrossThread) {
        const cellErr = new Error(
          'Refusing --launch: no --cell was given, so host-span evidence would be recorded and never folded — metrics.crossThread stays null and the run cannot answer the cross-thread question it spent its whole length measuring. Pass a canonical --cell (<history>/<chats>/<path>/<mix>/<saturation>), or --accept-unfolded-cross-thread to record host evidence deliberately without folding it.'
        )
        cellErr.code = 'T2_CROSS_THREAD_CELL_ABSENT'
        throw cellErr
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
      // A SIGTERM during fixture build or preflight fired the abort listener
      // while childSession was still null; `{ once: true }` then consumed it and
      // the launch went ahead. Worse than a no-op: `process.once('SIGINT')` means
      // the operator's SECOND Ctrl-C gets the default handler and hard-kills the
      // runner, stranding the very Electron instance the reap exists to collect.
      if (launchAborted) {
        throw new Error('Refusing --launch: aborted before spawn (SIGINT/SIGTERM)')
      }
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

      // Drain both pipes from the moment the child exists. Anything the app
      // says about itself now survives into an artifact instead of into a
      // closed pipe.
      const childStdoutPath = path.join(artifactDir, 'perf-t2-child-stdout.log')
      const childStderrPath = path.join(artifactDir, 'perf-t2-child-stderr.log')
      childStdioSinks = {
        stdout: fs.createWriteStream(childStdoutPath),
        stderr: fs.createWriteStream(childStderrPath)
      }
      const childStdio = captureChildStdio(childSession, {
        write: (name, chunk) => childStdioSinks[name].write(chunk)
      })
      report.childStdio = {
        stdoutPath: childStdoutPath,
        stderrPath: childStderrPath,
        maxBytesPerStream: DEFAULT_CHILD_STDIO_MAX_BYTES,
        // Read at report time; the record is mutated as the child writes.
        get bytes() {
          return childStdio.bytes
        },
        get droppedBytes() {
          return childStdio.droppedBytes
        },
        get truncated() {
          return childStdio.truncated
        },
        streams: childStdio.streams
      }

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
      const windowedRateMs =
        options.windowedRateWindowMs == null
          ? DEFAULT_WINDOWED_RATE_WINDOW_MS
          : options.windowedRateWindowMs
      const windowedRate = createWindowedRateTracker(windowedRateMs, {
        nowMs: replayNowMs
      })
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
      if (args.windowedReplay) {
        if (args.maxReplayEvents != null) {
          throw new Error(
            '--max-replay-events applies to sequential replay only; refuse --windowed-replay with it'
          )
        }
        await runWindowedOrPairedReplay(api, {
          eventTimeoutMs: replayStallTimeoutMs,
          nowMs: replayNowMs,
          // Assert the 120 s x 3 contract at the call site rather than leaning
          // on the driver's default: MATRIX_SAMPLING is the single source of
          // truth that validateRunEvidence checks the run back against.
          // --replay-window-ms stays a deliberately ineligible test-only seam,
          // and there is no repetitions seam because three is the contract.
          windowMs:
            options.replayWindowMs == null ? MATRIX_SAMPLING.windowMs : options.replayWindowMs,
          repetitions: MATRIX_SAMPLING.repetitions
        })
        const windowedTotals = summarizeWindowedReplay(windowedReplayResult)
        const aloneTotals = args.pairedRuns
          ? summarizeWindowedReplay(pairedReplayResult && pairedReplayResult.alone)
          : null
        updateProgress(
          {
            completedEvents: windowedTotals.completedEvents,
            currentEvent: null,
            windowedReplay: true,
            pairedRuns: Boolean(args.pairedRuns),
            replayWindows: windowedTotals.windows,
            replayRepetitions: MATRIX_SAMPLING.repetitions,
            replayWindowOutcomes: windowedTotals.outcomes,
            ...(aloneTotals == null
              ? {}
              : {
                  aloneReplayWindows: aloneTotals.windows,
                  aloneReplayWindowOutcomes: aloneTotals.outcomes
                })
          },
          { log: true }
        )
      } else {
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
            // Always push to windowed-rate tracker (not just on publish cadence)
            const win = windowedRate.push(info.completedEvents)
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
            // Windowed ETA uses the short-window rate for a more realistic projection
            const windowedEtaMs = win > 0 ? Math.round((remainingEvents / win) * 1000) : null
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
                etaMs,
                windowedRateEvtPerSec: win,
                windowedEtaMs,
                windowedRateWindowMs: windowedRateMs
              },
              { log: true }
            )
          }
        })
      }

      setCapturePhase(
        'replay_complete',
        {
          completedEvents:
            replayResult != null
              ? replayResult.eventCount
              : summarizeWindowedReplay(windowedReplayResult).completedEvents,
          currentEvent: null,
          replayCompletedAt: new Date(replayNowMs()).toISOString()
        },
        { log: true }
      )

      // Re-check disk headroom before heavy capture I/O (profiles + heap may push near limit)
      const preCaptureHeadroom = checkDiskHeadroom(artifactDir, minFreeBytes, options.diskAdapters)
      report.diskHeadroom.preCapture = preCaptureHeadroom
      if (!preCaptureHeadroom.ok) {
        // Record but do not abort — we already launched; capture what we can
        updateProgress(
          {
            diskHeadroomWarning: preCaptureHeadroom.note
          },
          { log: true }
        )
      }

      // Capture-phase deadline: abort further capture steps if total exceeds maxCapturePhaseMs
      const maxCapturePhaseMs =
        options.maxCapturePhaseMs == null ? DEFAULT_MAX_CAPTURE_PHASE_MS : options.maxCapturePhaseMs
      const captureStartedAtMs = replayNowMs()
      let captureDeadlineExceeded = false
      /** @type {string[]} */
      const captureSkippedSteps = []

      // NOT a pure predicate: asking LATCHES `captureDeadlineExceeded` once the
      // budget is gone, and that latch is what keeps the journal entry, the
      // report record and the skip list telling the same story. Making this a
      // pure read would let the three disagree about whether the same phase
      // overran.
      function hasCaptureDeadlineExpired() {
        if (captureDeadlineExceeded) return true
        const elapsed = replayNowMs() - captureStartedAtMs
        if (elapsed >= maxCapturePhaseMs) {
          captureDeadlineExceeded = true
          return true
        }
        return false
      }

      function remainingCaptureBudgetMs() {
        if (captureDeadlineExceeded) return 0
        return Math.max(0, maxCapturePhaseMs - (replayNowMs() - captureStartedAtMs))
      }

      // maxCapturePhaseMs is a CHECKPOINT, not a deadline. Nothing polls it: it
      // takes effect only where a step asks hasCaptureDeadlineExpired() before
      // starting, or threads remainingCaptureBudgetMs() into a bounded await.
      // An await that does neither sits outside the budget entirely, which is
      // how a five-minute budget failed to bound an eighteen-minute phase
      // (attempt 4, stuck in heap_snapshot with the runner at 0% CPU and the
      // app's node utility spinning at 100%). Every capture await goes through
      // here so the budget cannot be silently opted out of.
      const withinCaptureBudget = (promise, label) =>
        awaitWithTimeout(promise, remainingCaptureBudgetMs(), label)

      setCapturePhase('profiles_stop', {}, { log: true })
      /** @type {{ path?: string } | null} */
      let rendererStopped = null
      /** @type {{ path?: string } | null} */
      let mainStopped = null
      if (!hasCaptureDeadlineExpired()) {
        const stopBudget = remainingCaptureBudgetMs()
        rendererStopped = await awaitWithTimeout(
          rendererCpu.stop(),
          stopBudget,
          'capture:profiles_stop.renderer'
        )
        mainStopped = await awaitWithTimeout(
          mainCpu.stop(),
          remainingCaptureBudgetMs(),
          'capture:profiles_stop.main'
        )
      } else {
        captureSkippedSteps.push('profiles_stop')
      }

      setCapturePhase('heap_snapshot', {}, { log: true })
      /** @type {{ chunkCount: number } | null} */
      let heapResult = null
      if (!hasCaptureDeadlineExpired()) {
        heapResult = await collectRendererHeapSnapshot(renderer, {
          heapSnapshotPath: heapPath,
          fs,
          timeoutMs: remainingCaptureBudgetMs()
        })
      } else {
        captureSkippedSteps.push('heap_snapshot')
      }

      /** @type {{ sha256?: string, bytes?: number } | null} */
      let rendererCpuDigest = null
      /** @type {{ sha256?: string, bytes?: number } | null} */
      let mainCpuDigest = null
      /** @type {{ sha256?: string, bytes?: number, chunkCount?: number } | null} */
      let heapDigest = null

      if (!captureDeadlineExceeded) {
        rendererCpuDigest = verifyArtifactFile(rendererCpuPath, { fs, minBytes: 32 })
        mainCpuDigest = verifyArtifactFile(mainCpuPath, { fs, minBytes: 32 })
        heapDigest = verifyArtifactFile(heapPath, {
          fs,
          minBytes: 64
        })
      } else {
        // Capture partial digests for whatever files exist
        try {
          rendererCpuDigest = verifyArtifactFile(rendererCpuPath, { fs, minBytes: 32 })
        } catch (_) {
          /* partial — ok under deadline */
        }
        try {
          mainCpuDigest = verifyArtifactFile(mainCpuPath, { fs, minBytes: 32 })
        } catch (_) {
          /* partial */
        }
        try {
          heapDigest = verifyArtifactFile(heapPath, { fs, minBytes: 64 })
        } catch (_) {
          /* partial */
        }
      }

      if (options.osAdapters) {
        sampleOsBundle(options.osAdapters, { occluded: false })
      }

      report.metrics.profiles = {
        mainCpuProfilePath: mainStopped && mainStopped.path ? mainStopped.path : mainCpuPath,
        rendererCpuProfilePath:
          rendererStopped && rendererStopped.path ? rendererStopped.path : rendererCpuPath,
        heapSnapshotPaths: [heapPath],
        digests: {
          mainCpu: mainCpuDigest,
          rendererCpu: rendererCpuDigest,
          heap: heapDigest
            ? { ...heapDigest, chunkCount: heapResult ? heapResult.chunkCount : 0 }
            : null
        }
      }
      report.captureDeadline = {
        maxCapturePhaseMs,
        captureStartedAt: new Date(captureStartedAtMs).toISOString(),
        captureEndedAt: new Date(replayNowMs()).toISOString(),
        captureElapsedMs: replayNowMs() - captureStartedAtMs,
        captureDeadlineExceeded,
        captureSkippedSteps,
        note: captureDeadlineExceeded
          ? `Capture phase exceeded ${maxCapturePhaseMs}ms deadline — partial digests recorded; skipped: ${captureSkippedSteps.join(', ') || 'none'}`
          : null
      }
      profilesCaptured = !captureDeadlineExceeded

      // T9a — THE PRODUCER. Everything else in this tranche built the seam;
      // this is the only place that actually reads it. Sample here, while the
      // main inspector is still attached (it is closed in the `finally` below)
      // and AFTER the replay, so the counters describe the measured window.
      //
      // Sampling is a single in-memory read over an already-open inspector
      // session: it adds no write/fsync traffic to the I/O path under
      // measurement, which is why this route was chosen over streaming probe
      // JSONL out of the child during the replay.
      if (!mainInspector) {
        report.persistenceStatsFailure = { reason: 'main inspector session unavailable' }
      } else if (captureDeadlineExceeded) {
        report.persistenceStatsFailure = {
          reason: 'capture deadline exceeded before persistence sampling'
        }
      } else {
        // Runtime.evaluate against the main inspector, unbounded until now and
        // the exact await attempt 4 died on: the phase label never advanced
        // past heap_snapshot because this sits between the two setCapturePhase
        // calls. A timeout is recorded as an honest sampling failure, never
        // thrown — this block has always refused to turn a missed sample into
        // evidence, and a missed sample is not a failed run.
        const statsResult = await withinCaptureBudget(
          sampleMainPersistenceStats(mainInspector),
          'capture:persistence_stats'
        ).catch((error) => ({
          ok: false,
          reason: String(error && error.message ? error.message : error)
        }))
        if (statsResult.ok) {
          applyPersistenceStatsToMetrics(report.metrics, statsResult.stats)
          persistenceStatsOk = true
        } else {
          // Honest failure record. A partially-populated block would be read as
          // evidence, so the collector returns all-or-nothing and we surface why.
          report.persistenceStatsFailure = { reason: statsResult.reason }
        }
      }

      // T9b — HOST SPAN BINDING (M1). The spawn env armed the writer
      // (TASKWRAITH_PERF_HOST_SNAPSHOT_PATH → external Host → snapshot file);
      // this block is the ONLY production consumer. The live pin comes from
      // the authenticated welcome (out-of-band — never the snapshot file
      // itself), the runner makes the qualification call (ruling P4), and the
      // fold goes only through applyCrossThreadToMetrics with
      // requireHostAttribution. Failures here never throw: they record a
      // NAMED marker and leave the cell visibly unqualified. Sampled while
      // the renderer session is still attached, after the replay, so the
      // counters describe the measured window (same posture as T9a).
      setCapturePhase('host_span_sample', {}, { log: true })
      const hostSpanEvidence = await collectT2HostSpanEvidence({
        userDataPath: isolationVerification.observedUserDataPath || userDataResolved.userDataPath,
        hostPerfSnapshotPath: hostSnapshotPath,
        requiredChatIds: fixture.chats.map((chat) => chat.appChatId),
        cell: crossThreadCell,
        renderer,
        metrics: report.metrics,
        probe: options.hostWelcomeProbe,
        sampler: options.hostSpansSampler,
        fs: options.hostDiscoveryFs,
        snapshotFs: options.hostSnapshotFs,
        connect: options.hostSocketConnect,
        sleep: options.hostDiscoverySleep,
        nowMs: options.hostDiscoveryNowMs,
        maxWaitMs: options.hostDiscoveryMaxWaitMs,
        intervalMs: options.hostDiscoveryIntervalMs,
        welcomeTimeoutMs: options.hostWelcomeTimeoutMs,
        now: options.hostNow,
        maxAgeMs: options.hostSnapshotMaxAgeMs
      })
      report.hostSpans = hostSpanEvidence.record

      // Which architecture did this run actually measure? Recorded always, so
      // no future artifact has to be cross-examined for it the way attempt 5
      // was.
      const fallbackLine =
        childStdio.stderrHead
          .split('\n')
          .find((line) => line.includes(HOST_LANE_FALLBACK_MARKER))
          ?.trim() ?? null
      Object.assign(
        report.hostLane,
        resolveObservedHostLane({
          fallbackLine,
          discoveryPid: hostSpanEvidence.record ? hostSpanEvidence.record.discoveryPid : null,
          childPid: childSession ? childSession.pid : null
        })
      )

      report.replayWindowedRate = windowedRate ? windowedRate.snapshot() : null

      // Re-stamp before reporting. The first write happens 30-odd lines above,
      // BEFORE the persistence and host-span samples — the two most expensive
      // awaits in the phase. Attempt 5 recorded captureElapsedMs: 1554 for a
      // capture that spent 298,446 ms inside one of them and still said
      // captureDeadlineExceeded: false, so the artifact understated its own
      // cost by two orders of magnitude and denied the overrun that produced
      // it. hasCaptureDeadlineExpired() re-reads the clock, so a budget
      // exhausted by a bounded await now flips the flag it was measured
      // against. profilesCaptured is deliberately left as it was: the profiles
      // genuinely were captured before the overrun, and a late sample does not
      // retract them.
      const captureOverran = hasCaptureDeadlineExpired()
      report.captureDeadline.captureEndedAt = new Date(replayNowMs()).toISOString()
      report.captureDeadline.captureElapsedMs = replayNowMs() - captureStartedAtMs
      report.captureDeadline.captureDeadlineExceeded = captureOverran
      report.captureDeadline.note = captureOverran
        ? `Capture phase exceeded ${maxCapturePhaseMs}ms deadline — partial digests recorded; skipped: ${captureSkippedSteps.join(', ') || 'none'}`
        : null
      setCapturePhase(
        'capture_complete',
        { captureDeadlineExceeded, captureElapsedMs: report.captureDeadline.captureElapsedMs },
        { log: true }
      )
    } catch (error) {
      launchError = error instanceof Error ? error : new Error(String(error))
      recordProgressFailure(launchError)
      throw launchError
    } finally {
      // C: always close sessions + terminate exact owned tree; preserve primary error.
      let childTerminationSucceeded = childSession == null
      /** @type {object|null} — force/reap facts, journaled even when nothing failed */
      let childTermination = null
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
      if (childStdioSinks) {
        for (const sink of Object.values(childStdioSinks)) {
          try {
            sink.end()
          } catch {
            // Closing a diagnostic sink must not mask the primary error.
          }
        }
        childStdioSinks = null
      }
      if (childSession) {
        try {
          childTermination = childTerminationRecord(
            await terminateExactChild(childSession, {
              ...(options.terminateOptions || {}),
              userDataPath: userDataResolved.userDataPath
            })
          )
          childTerminationSucceeded = true
        } catch (error) {
          cleanupFailures.push({
            phase: 'terminateExactChild',
            error: String(error && error.message ? error.message : error)
          })
        }
      }
      if (childTermination) report.childTermination = childTermination
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
                ...(childTermination == null ? {} : { childTermination }),
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
            // Preserve cleanup failures when there is no earlier launch error.
            // eslint-disable-next-line no-unsafe-finally
            throw progressError
          }
        }
      }
      // never auto-delete artifacts
    }
  } else if (!args.dryRun && options.replayApi) {
    // Unit-test path: exercise replay without Electron
    if (args.windowedReplay) {
      if (args.maxReplayEvents != null) {
        throw new Error(
          '--max-replay-events applies to sequential replay only; refuse --windowed-replay with it'
        )
      }
      // Test-only seam: short windows stay validator-ineligible by design,
      // so this can prove the wiring without manufacturing a measurement.
      await runWindowedOrPairedReplay(options.replayApi, {
        ...(options.replayWindowMs == null ? {} : { windowMs: options.replayWindowMs })
      })
    } else {
      replayResult = await runDeterministicReplay({
        fixture,
        api: options.replayApi,
        maxEvents: args.maxReplayEvents == null ? 32 : Number(args.maxReplayEvents)
      })
    }
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
  if (windowedReplayResult) {
    const windowedTotals = summarizeWindowedReplay(windowedReplayResult)
    report.windowedReplay = {
      windowed: true,
      pairingRole: windowedReplayResult.pairingRole,
      windows: windowedTotals.windows,
      // The durable copy of why the replay stopped where it did; the progress
      // journal carries the same thing for a run that never reaches a report.
      windowOutcomes: windowedTotals.outcomes,
      completedEvents: windowedTotals.completedEvents,
      failedEvents: windowedTotals.failedEvents,
      stallTimeoutMs: replayStallTimeoutMs,
      progressIsAuthoritativeEvidence: false,
      evidenceEligible: windowedReplayResult.evidenceEligible,
      evidenceErrors: windowedReplayResult.evidenceErrors,
      unsupportedCount: windowedTotals.unsupported.length,
      unsupported: windowedTotals.unsupported.slice(0, 50)
    }
  }
  if (pairedReplayResult) {
    const pairing = pairedReplayResult.pairing
    const pairs = pairing.ok ? [pairing.pair] : []
    report.pairedRuns = {
      paired: true,
      pairingOk: pairing.ok === true,
      reasons: pairing.ok ? [] : pairing.reasons,
      lightAloneRole: pairedReplayResult.alone.pairingRole,
      lightBesideRole: pairedReplayResult.beside.pairingRole,
      aloneEvidenceEligible: pairedReplayResult.alone.evidenceEligible,
      besideEvidenceEligible: pairedReplayResult.beside.evidenceEligible,
      // Recorded whatever pairRuns decided: `pairs` is empty for any ineligible
      // run, and it was the only artifact that carried the alone half.
      lightAlone: pairedRunRecord(pairedReplayResult.alone),
      lightBeside: pairedRunRecord(pairedReplayResult.beside)
    }
    report.pairs = pairs
    const cell = parseCellName(crossThreadCell)
    const cells = [{ ...cell, name: crossThreadCell, ...cellReachability(cell) }]
    const interferenceEnvironment =
      options.interferenceEnvironment ||
      environmentRecord({
        repoRoot,
        collectRepoProvenance: () => provenance
      })
    try {
      report.interferenceReport = createInterferenceReport({
        environment: interferenceEnvironment,
        cells,
        pairs
      })
    } catch (error) {
      report.interferenceReport = null
      report.interferenceReportError = String(error && error.message ? error.message : error)
    }
  }

  report.environment.endedAt = new Date().toISOString()
  const gateProbe = evaluatePerfGates({
    report,
    // T9a: was hardcoded false because nothing produced measured metrics. It is
    // now a genuine claim — true only when the persistence counters were
    // sampled AND the profile evidence is complete.
    claimMetricsCollected: persistenceStatsOk && profilesCaptured,
    fsAdapter: {
      statSync: fs.statSync,
      readFileSync: fs.readFileSync
    }
  })
  report.gates = gateProbe.gates

  // Wall 2a — run-evidence descriptor. Additive: the existing report shape is
  // untouched; this block is what the matrix validators read. Identity comes
  // from declared flags plus observed fixture values; coverage is the T2
  // attempt's own (no fixed sampling windows yet), so the descriptor carries
  // its gaps explicitly via validateRunEvidence.
  report.runEvidence = buildT2RunEvidence({
    cell: crossThreadCell,
    role: pairedReplayResult ? 'light-beside' : pairingRole,
    workload,
    seed,
    fixtureFingerprint: fingerprint,
    fixtureChatIds: fixture.chats.map((chat) => chat.appChatId),
    buildId,
    ...(windowedReplayResult == null
      ? {}
      : {
          windows: windowedReplayResult.run.evidence.windows,
          signals: windowedReplayResult.run.signals
        }),
    launched: willLaunch
  }).run

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
  const launchAbort = new AbortController()
  // Long enough for the abort to terminate the child, reap and journal; short
  // enough that a phase which has already proved it can hang does not hold the
  // runner open indefinitely after the operator asked it to stop.
  const ABORT_GRACE_MS = 20_000
  /** @type {string|null} */
  let abortedBy = null
  const stopLaunch = (signalName) => {
    abortedBy = signalName
    process.exitCode = abortExitCode(signalName)
    try {
      launchAbort.abort()
    } catch {
      // already aborted
    }
    // unref'd: if the run unwinds first the process leaves at once, still
    // carrying the signal's code rather than draining to 0.
    const leave = setTimeout(() => process.exit(abortExitCode(signalName)), ABORT_GRACE_MS)
    if (typeof leave.unref === 'function') leave.unref()
  }
  process.once('SIGINT', () => stopLaunch('SIGINT'))
  process.once('SIGTERM', () => stopLaunch('SIGTERM'))
  runT2BaselineCli(process.argv.slice(2), { signal: launchAbort.signal })
    .then((result) => {
      if (abortedBy) {
        console.error(
          JSON.stringify(
            { ok: false, aborted: abortedBy, progressPath: result && result.progressPath },
            null,
            2
          )
        )
        process.exit(abortExitCode(abortedBy))
      }
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
      process.exit(abortedBy ? abortExitCode(abortedBy) : 1)
    })
    .finally(() => {
      process.removeListener('SIGINT', stopLaunch)
      process.removeListener('SIGTERM', stopLaunch)
    })
}

module.exports = {
  DEFAULT_REPLAY_STALL_TIMEOUT_MS,
  DEFAULT_REPLAY_PROGRESS_EVENT_INTERVAL,
  DEFAULT_REPLAY_PROGRESS_INTERVAL_MS,
  DEFAULT_WINDOWED_RATE_WINDOW_MS,
  DEFAULT_MIN_FREE_DISK_BYTES,
  DEFAULT_MAX_CAPTURE_PHASE_MS,
  HOST_BUNDLE_REBUILD_COMMAND,
  HOST_BUNDLE_DECLARED_ENTRY_SEGMENTS,
  createT2ProgressJournal,
  checkDiskHeadroom,
  checkHostBundleFreshness,
  collectT2HostSpanEvidence,
  createWindowedRateTracker,
  captureChildStdio,
  checkExternalHostNodeExecutable,
  resolveObservedHostLane,
  DEFAULT_CHILD_STDIO_MAX_BYTES,
  abortExitCode,
  childTerminationRecord,
  pairedRunRecord,
  parseArgs,
  runT2BaselineCli
}
