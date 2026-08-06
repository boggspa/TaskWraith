#!/usr/bin/env node
'use strict'

/**
 * Wave 4.5 — OBSERVE HOST UNDER ELECTRON.
 *
 * `scripts/smoke-packaged-electron.cjs` already launches the packaged app and
 * asserts the process stays up. It never asserts anything about Host, so a Host
 * that never started passes it. This sibling closes that hole. It is additive:
 * it does not modify that script and is not wired into `ci` — wiring is a
 * separate decision once it has demonstrably worked.
 *
 * ============================ READ THIS FIRST ============================
 * THE PRECONDITION GATE IS THE POINT, NOT A FORMALITY.
 *
 * Measured 2026-08-06: the packaged bundle (mtime 11:38) predated the R4' Host
 * wiring commit (14:01). Run against that artifact, an unguarded version of
 * this script would go RED — and that RED would be read as "Host is broken
 * under Electron", a P0 that does not exist. It would in fact be the same
 * stale binary already diagnosed for the running app.
 *
 * ONE CORRECTION TO THE ORIGINAL REASONING, so nobody inherits it:
 * this header used to cite `out/main/index.js` having ZERO Host symbols as
 * evidence of staleness alongside its mtime. Only the MTIME was ever valid.
 * That file is a code-split entry stub and reads zero Host symbols on a fresh
 * CORRECT bundle too, so the symbol count proved nothing about freshness.
 * Two independent claims were fused into one; the conclusion happened to be
 * right and half the reasoning was not. See `bundleHostWiringReport` for how
 * to choose a bundle path that can actually fail honestly.
 *
 * So this script REFUSES TO DRAW ANY HOST CONCLUSION from a bundle that does
 * not contain the wiring. A stale bundle exits with its own distinct message
 * that says, in words, that it is NOT a Host defect. Only once the bundle is
 * proven to carry the wiring does a missing discovery record become a real,
 * hard failure.
 *
 * ============================== SAFETY ==================================
 * This script launches with the PACKAGE-SMOKE posture, never production:
 *   --taskwraith-package-smoke
 *   --taskwraith-package-smoke-user-data=<tmpdir>/taskwraith-tui-package-smoke-*
 *
 * `resolvePackagedSmokeUserDataPath` (InstanceLaunchPosture.ts L149-166) will
 * REJECT that profile unless it is a strict descendant of os.tmpdir() AND its
 * basename carries the reserved prefix. That is a structural guarantee the
 * launch cannot land on the user's real profile — not merely a convention we
 * are honouring.
 *
 * The existing smoke passes NO argv at all (`open -n -W <app>`), which is why
 * it can only launch in production posture. Passing argv is the difference
 * between observing Host and colliding with the user's session.
 */

const { spawn, spawnSync } = require('node:child_process')
const { randomUUID } = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const REPO_ROOT = path.resolve(__dirname, '..')

/** Symbols that only exist in a bundle built AFTER the R4' Host wiring. */
const HOST_WIRING_SYMBOLS = ['createHostProductionBootstrap', 'registerHostProjectionHandlers']

/** Mirrors InstanceLaunchPosture.ts — the posture rejects any other basename. */
const PACKAGE_SMOKE_ARG = '--taskwraith-package-smoke'
const PACKAGE_SMOKE_USER_DATA_ARG = '--taskwraith-package-smoke-user-data='
const PACKAGE_SMOKE_USER_DATA_BASENAME_PREFIX = 'taskwraith-tui-package-smoke-'

const DISCOVERY_FILE = 'taskwraith-host-v2.json'

/** Distinct exit codes so a caller can tell the failures apart. */
const EXIT_STALE_BUNDLE = 20
const EXIT_UNSAFE_TO_LAUNCH = 21
const EXIT_HOST_DID_NOT_BOOT = 1

/**
 * A discovery record that never appeared is NOT proof that Host failed.
 *
 * This is the goal's own invariant — unavailable telemetry is not zero. A cold
 * profile, a first-run migration, or a loaded machine all produce a silence
 * that is byte-identical to a real defect. Reporting that silence as
 * EXIT_HOST_DID_NOT_BOOT manufactures a P0 that may not exist, and this arc
 * has already lost passes to exactly that class of misattribution.
 */
const EXIT_INCONCLUSIVE = 22

/**
 * Discovery-poll ceiling. MEASURED 2026-08-06 against a real dev launch:
 *   WARM profile: discovery appeared in ~5s.
 *   COLD profile: ~70s — and that cost was the app's first-run userData
 *                 migration, NOT Host. Do not record it as a Host property.
 * CI is always cold, so the ceiling is sized for the cold case with headroom.
 * The previous default was 30s, which would have timed out on every cold run
 * and reported it as a Host failure.
 */
const DEFAULT_DISCOVERY_TIMEOUT_MS = 120_000

/* ------------------------------------------------------------------ */
/*  1. PRECONDITION — does this bundle even contain Host?              */
/* ------------------------------------------------------------------ */

/**
 * Search a bundle for the Host wiring symbols.
 *
 * Read as latin1 rather than utf8 so the same code path works for a packaged
 * `app.asar` — a binary container with embedded JS text — as for a plain .js
 * file.
 *
 * CHOOSING `bundlePath` — READ BEFORE POINTING THIS AT ANYTHING:
 * The unpackaged main build is CODE-SPLIT. `out/main/index.js` is a ~69KB
 * CommonJS ENTRY STUB that dynamically requires the real graph, and it
 * contains ZERO Host symbols even when the build is completely correct.
 * Pointing this function at that stub therefore reports `stale` on a perfectly
 * fresh bundle — a false negative, MEASURED 2026-08-06.
 *
 * The real chunk is `out/main/index-<hash>.js`. That hash is CONTENT-ADDRESSED
 * and rotates on every main-process source change (observed across four
 * consecutive builds), so it can never be hardcoded here or anywhere else.
 * For an unpackaged run, resolve the chunk the stub actually requires, or scan
 * the whole `out/main/` directory. For a packaged run, use the `app.asar`,
 * which embeds every chunk and needs no resolution.
 */
function bundleHostWiringReport(bundlePath) {
  if (!fs.existsSync(bundlePath)) {
    return { ok: false, reason: 'missing', bundlePath, found: [], missing: HOST_WIRING_SYMBOLS }
  }
  const contents = fs.readFileSync(bundlePath, 'latin1')
  const found = HOST_WIRING_SYMBOLS.filter((symbol) => contents.includes(symbol))
  const missing = HOST_WIRING_SYMBOLS.filter((symbol) => !contents.includes(symbol))
  return {
    ok: missing.length === 0,
    reason: missing.length === 0 ? 'ok' : 'stale',
    bundlePath,
    found,
    missing
  }
}

/**
 * The message a stale bundle prints. Kept as a function so a test can assert
 * the exact words: the next fresh context must not be able to read this as a
 * Host defect.
 */
function staleBundleMessage(report) {
  return [
    'STALE BUNDLE — NOT A HOST DEFECT. Refusing to draw any conclusion about Host.',
    `  bundle:  ${report.bundlePath}`,
    `  missing: ${report.missing.join(', ')}`,
    '  This bundle was built BEFORE the Host wiring landed, so it cannot start',
    '  Host no matter how healthy Host is. A red here would be an artifact of',
    '  the build, not evidence about the product. Rebuild, then re-run.'
  ].join('\n')
}

/* ------------------------------------------------------------------ */
/*  2. ISOLATION — argv the existing harness never passes              */
/* ------------------------------------------------------------------ */

/**
 * Mirror the app's own strict-descendant test EXACTLY.
 *
 * `InstanceLaunchPosture.isStrictDescendant` uses `path.relative` on
 * UNRESOLVED paths — it is purely lexical and does not follow symlinks. Any
 * check here that differs from it (string prefix, or a realpath on either
 * side) can pass locally and still be rejected by the app.
 */
function isStrictDescendant(parentPath, candidatePath) {
  const relation = path.relative(parentPath, candidatePath)
  return (
    Boolean(relation) &&
    relation !== '..' &&
    !relation.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relation)
  )
}

/**
 * A profile path the package-smoke posture will actually accept.
 *
 * DO NOT realpath the temporary root. On macOS `os.tmpdir()` is
 * `/var/folders/...`, a symlink to `/private/var/folders/...`. The app builds
 * its comparison root from a RAW `tmpdir()` (`devAppName.ts` L156) and
 * compares lexically, so a realpathed profile is NOT a descendant of the root
 * the app is holding, and the posture is rejected.
 *
 * `scripts/smoke-packaged-tui.cjs` L509 is the shape that works, and it uses
 * the raw value for exactly this reason.
 */
function createSmokeUserDataPath(temporaryRoot = os.tmpdir()) {
  const unique = `${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`
  return path.join(temporaryRoot, `${PACKAGE_SMOKE_USER_DATA_BASENAME_PREFIX}${unique}`)
}

/**
 * Build the launch argv, and refuse to build an unsafe one.
 *
 * WHAT A REJECTED PROFILE ACTUALLY DOES — measured, because the earlier note
 * here was wrong and the difference matters. A profile the posture refuses
 * yields `invalid(true, 'invalid-package-smoke-profile')`, and `devAppName.ts`
 * L159 THROWS on an invalid posture ('TaskWraith refused an invalid private
 * launch posture'). `InstanceResourceIdentity` L91 throws as well.
 *
 * So the app FAILS CLOSED: it refuses to start rather than falling back to
 * production. A bad profile here cannot reach the user's real userData. What
 * it does instead is guarantee the harness never produces evidence, silently,
 * which is why this still throws early rather than letting a launch proceed.
 */
function buildSmokeLaunchArgv(smokeUserDataPath, temporaryRoot = os.tmpdir()) {
  if (typeof smokeUserDataPath !== 'string' || !path.isAbsolute(smokeUserDataPath)) {
    throw new Error('smoke userData path must be absolute')
  }
  if (!isStrictDescendant(temporaryRoot, smokeUserDataPath)) {
    throw new Error('smoke userData path must be a strict descendant of the temporary directory')
  }
  const candidate = path.resolve(smokeUserDataPath)
  if (!path.basename(candidate).startsWith(PACKAGE_SMOKE_USER_DATA_BASENAME_PREFIX)) {
    throw new Error(
      `smoke userData basename must start with ${PACKAGE_SMOKE_USER_DATA_BASENAME_PREFIX}`
    )
  }
  return [PACKAGE_SMOKE_ARG, `${PACKAGE_SMOKE_USER_DATA_ARG}${candidate}`]
}

/**
 * Prove the argv we are about to hand to `open` really carries isolation.
 *
 * The failure this guards is silent: `open -n -W <app>` with the `--args`
 * omitted launches production posture and looks identical at the call site.
 */
function argvCarriesIsolation(argv) {
  if (!Array.isArray(argv)) return false
  const hasIntent = argv.includes(PACKAGE_SMOKE_ARG)
  const profile = argv.find(
    (entry) => typeof entry === 'string' && entry.startsWith(PACKAGE_SMOKE_USER_DATA_ARG)
  )
  if (!hasIntent || !profile) return false
  const value = profile.slice(PACKAGE_SMOKE_USER_DATA_ARG.length)
  return value.length > 0 && path.isAbsolute(value)
}

/**
 * Is a real TaskWraith already running?
 *
 * The existing smoke uses `pgrep -f` on the executable path and trusts any hit.
 * MEASURED 2026-08-06: that returns SIX hits on this machine and THREE of them
 * are `claude` agent processes — `-f` matches the whole command line, and an
 * agent whose argv happens to carry the pattern text (which any agent
 * discussing this guard inevitably does) matches itself.
 *
 * The direction of that failure is safe — it over-reports, so the worst case is
 * refusing a launch that would have been fine. But "TaskWraith is running" then
 * stops being evidence, and inside an agent session it is permanently true,
 * which would make the concurrency refusal unconditional. So each candidate pid
 * is confirmed by its actual executable name before it counts.
 */
function isTaskWraithAlreadyRunning() {
  const result = spawnSync('/usr/bin/pgrep', ['-f', 'TaskWraith\\.app/Contents/MacOS/TaskWraith'], {
    encoding: 'utf8'
  })
  if (result.status !== 0 || !result.stdout) return false
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .some((pid) => {
      const comm = spawnSync('/bin/ps', ['-o', 'comm=', '-p', pid], { encoding: 'utf8' })
      return comm.status === 0 && comm.stdout.includes('TaskWraith.app/Contents/MacOS/TaskWraith')
    })
}

/* ------------------------------------------------------------------ */
/*  3. DISCOVERY — decoded by the SHIPPING decoder, not a copy         */
/* ------------------------------------------------------------------ */

/**
 * Load `decodeTaskWraithHostDiscovery` from the real source module.
 *
 * A hand-rolled shape check here would be a SECOND decoder, and the one that
 * matters is the one clients actually use — a record this script accepted but
 * a real client rejected would be worse than no check. The module imports only
 * node builtins, so a single-file esbuild transform is sufficient; esbuild is
 * already a repo dependency.
 */
function loadShippingDiscoveryDecoder() {
  const source = path.join(REPO_ROOT, 'src/shared/taskWraithHostPaths.node.ts')
  const { transformSync } = require('esbuild')
  const transformed = transformSync(fs.readFileSync(source, 'utf8'), {
    loader: 'ts',
    format: 'cjs',
    target: 'node20'
  })
  const module = { exports: {} }
  // eslint-disable-next-line no-new-func
  new Function('exports', 'require', 'module', '__filename', '__dirname', transformed.code)(
    module.exports,
    require,
    module,
    source,
    path.dirname(source)
  )
  const decode = module.exports.decodeTaskWraithHostDiscovery
  if (typeof decode !== 'function') {
    throw new Error(
      'shipping decodeTaskWraithHostDiscovery not found — refusing to substitute a local check'
    )
  }
  return decode
}

/** Poll for the discovery record. Returns null on timeout — never throws. */
async function waitForDiscoveryRecord(userDataPath, timeoutMs, pollMs = 250) {
  const target = path.join(userDataPath, DISCOVERY_FILE)
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (fs.existsSync(target)) {
      try {
        return { path: target, raw: JSON.parse(fs.readFileSync(target, 'utf8')) }
      } catch {
        // Mid-write. Keep polling rather than calling a torn read a defect.
      }
    }
    if (Date.now() >= deadline) return null
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
}

/* ------------------------------------------------------------------ */
/*  Launch path — authored, deliberately NOT executed by any test      */
/* ------------------------------------------------------------------ */

function fail(code, message) {
  console.error(message)
  process.exitCode = code
}

async function main() {
  const bundle = process.env.TASKWRAITH_HOST_SMOKE_BUNDLE
  const appRoot = process.env.TASKWRAITH_HOST_SMOKE_APP
  if (!bundle || !appRoot) {
    fail(
      EXIT_UNSAFE_TO_LAUNCH,
      'Refusing to guess: set TASKWRAITH_HOST_SMOKE_BUNDLE (asar or main bundle) and TASKWRAITH_HOST_SMOKE_APP (.app root).'
    )
    return
  }

  // GATE 1 — stale bundles never reach a Host conclusion.
  const report = bundleHostWiringReport(bundle)
  if (!report.ok) {
    fail(EXIT_STALE_BUNDLE, staleBundleMessage(report))
    return
  }
  console.log(`host wiring present in bundle: ${report.found.join(', ')}`)

  // GATE 2 — isolation must be real, and proven, before anything launches.
  const smokeUserDataPath = createSmokeUserDataPath()
  let launchArgs
  try {
    launchArgs = buildSmokeLaunchArgv(smokeUserDataPath)
  } catch (error) {
    fail(EXIT_UNSAFE_TO_LAUNCH, `Refusing to launch: ${error.message}`)
    return
  }
  if (!argvCarriesIsolation(launchArgs)) {
    fail(EXIT_UNSAFE_TO_LAUNCH, 'Refusing to launch: argv does not carry package-smoke isolation.')
    return
  }
  if (isTaskWraithAlreadyRunning() && process.env.TASKWRAITH_HOST_SMOKE_ALLOW_CONCURRENT !== '1') {
    fail(
      EXIT_UNSAFE_TO_LAUNCH,
      'Refusing to launch: a TaskWraith is already running. A second GUI launch of the same bundle id can\n' +
        "abort in LaunchServices and crash-prompt the user's session. Set\n" +
        'TASKWRAITH_HOST_SMOKE_ALLOW_CONCURRENT=1 only if you own that risk.'
    )
    return
  }

  fs.mkdirSync(smokeUserDataPath, { recursive: true })
  const timeoutMs = Number(
    process.env.TASKWRAITH_HOST_SMOKE_TIMEOUT_MS || DEFAULT_DISCOVERY_TIMEOUT_MS
  )
  let launched = null
  try {
    launched = spawn('/usr/bin/open', ['-n', '-W', appRoot, '--args', ...launchArgs], {
      stdio: ['ignore', 'pipe', 'pipe']
    })

    const record = await waitForDiscoveryRecord(smokeUserDataPath, timeoutMs)

    // GATE 3/4 — silence is NOT a Host verdict.
    //
    // This still exits NON-ZERO, deliberately: the existing smoke soft-skips
    // here, and a soft skip would let a genuinely dead Host present as a pass.
    // What changed is the CLAIM. An absent record proves only that we did not
    // observe one within the window — it does not prove Host failed to boot.
    // Timing is the reason: discovery was measured at ~5s warm and ~70s cold,
    // where the cold cost was first-run migration rather than Host. A caller
    // that needs a verdict must re-run against a WARM profile before treating
    // this as a defect.
    if (!record) {
      fail(
        EXIT_INCONCLUSIVE,
        `INCONCLUSIVE — NOT A PROVEN HOST DEFECT. The bundle carries the Host wiring and isolation\n` +
          `was verified, but no ${DISCOVERY_FILE} appeared in ${smokeUserDataPath} within ${timeoutMs}ms.\n` +
          'A cold profile, a first-run migration or a loaded machine produce this same silence.\n' +
          'Do NOT report this as "Host failed to boot". Re-run against a warm profile, or raise\n' +
          'TASKWRAITH_HOST_SMOKE_TIMEOUT_MS, before drawing any conclusion about Host.'
      )
      return
    }

    const decoded = loadShippingDiscoveryDecoder()(record.raw)
    if (!decoded.ok) {
      fail(
        EXIT_HOST_DID_NOT_BOOT,
        `HOST DISCOVERY RECORD IS UNDECODABLE: ${decoded.error}\n` +
          `  path: ${record.path}\n` +
          'A record a real client would reject is worse than no record.'
      )
      return
    }
    console.log(
      `host boot observed under Electron: protocolVersion=${decoded.discovery.protocolVersion} pid=${decoded.discovery.pid}`
    )
  } finally {
    if (launched && launched.exitCode === null) launched.kill('SIGTERM')
    fs.rmSync(smokeUserDataPath, { recursive: true, force: true })
  }
}

module.exports = {
  HOST_WIRING_SYMBOLS,
  PACKAGE_SMOKE_ARG,
  PACKAGE_SMOKE_USER_DATA_ARG,
  PACKAGE_SMOKE_USER_DATA_BASENAME_PREFIX,
  EXIT_STALE_BUNDLE,
  EXIT_UNSAFE_TO_LAUNCH,
  EXIT_HOST_DID_NOT_BOOT,
  EXIT_INCONCLUSIVE,
  DEFAULT_DISCOVERY_TIMEOUT_MS,
  bundleHostWiringReport,
  staleBundleMessage,
  isStrictDescendant,
  createSmokeUserDataPath,
  buildSmokeLaunchArgv,
  argvCarriesIsolation,
  isTaskWraithAlreadyRunning,
  loadShippingDiscoveryDecoder,
  waitForDiscoveryRecord
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`smoke-host-boot-electron crashed: ${error && error.stack ? error.stack : error}`)
    process.exitCode = EXIT_HOST_DID_NOT_BOOT
  })
}
