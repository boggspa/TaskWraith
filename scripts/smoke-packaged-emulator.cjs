#!/usr/bin/env node

/**
 * Opt-in real packaged emulator smoke.
 *
 * This launch is deliberately isolated from a user's TaskWraith profile, uses
 * the product's private package-smoke posture, and asks the packaged main
 * process to run the fixed `homebrew-demo` factory/bridge/WASM probe. It does
 * not drive renderer controls or depend on browser selectors.
 * Receipts survive under .local-only/emulator-smoke; optionally select a fresh
 * absolute TASKWRAITH_EMULATOR_SMOKE_EVIDENCE_ROOT. No child output is retained.
 */

const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { validatePackagedNotices } = require('../build/third-party-notices.cjs')
const {
  argvCarriesIsolation,
  buildSmokeLaunchArgv,
  createSmokeUserDataPath,
  isTaskWraithAlreadyRunning
} = require('./smoke-host-boot-electron.cjs')

const REPO_ROOT = path.resolve(__dirname, '..')
const PACKAGE_EMULATOR_SMOKE_ARG = '--taskwraith-package-emulator-smoke'
const PACKAGE_EMULATOR_SMOKE_RESULT_ARG = '--taskwraith-package-emulator-smoke-result='
const PACKAGE_EMULATOR_SMOKE_RESULT_FILE = 'emulator-package-smoke.json'
const DEFAULT_TIMEOUT_MS = 30_000
const MAX_RECEIPT_BYTES = 16_384
const EXIT_STALE_BUNDLE = 20
const EXIT_UNSAFE_TO_LAUNCH = 21
const MAX_FAILURE_OUTPUT_CHARS = 4000
/** HostRegistry.ts HOST_REGISTRY_ROOT_ENV; the test pins the two together. */
const HOST_REGISTRY_ROOT_ENV = 'TASKWRAITH_HOST_REGISTRY_ROOT'

if (require.main === module) {
  main().catch((error) => {
    const message = error instanceof Error ? error.stack || error.message : String(error)
    console.error(message)
    process.exitCode = smokeExitCode(error)
  })
}

async function main() {
  const packageRootArg = process.argv[2]
  if (!packageRootArg) {
    throw new Error('Pass the exact packaged app root to smoke-packaged-emulator.cjs.')
  }
  const packageRoot = path.resolve(REPO_ROOT, packageRootArg)
  const resourcesDir = resolveResourcesDir(packageRoot)
  const appAsarPath = path.join(resourcesDir, 'app.asar')
  assertDir(resourcesDir, 'packaged Electron resources directory')
  assertFile(appAsarPath, 'packaged app.asar')
  validatePackagedNotices(resourcesDir)
  validateEmulatorPackageLayout(resourcesDir)
  assertEmulatorSmokeWiring(appAsarPath)

  if (
    isTaskWraithAlreadyRunning() &&
    process.env.TASKWRAITH_ALLOW_CONCURRENT_EMULATOR_PACKAGE_SMOKE !== '1'
  ) {
    throw smokeError(
      'Refusing to launch: TaskWraith is already running. Set ' +
        'TASKWRAITH_ALLOW_CONCURRENT_EMULATOR_PACKAGE_SMOKE=1 only if you own the GUI-launch risk.',
      EXIT_UNSAFE_TO_LAUNCH
    )
  }

  const smokeUserDataPath = createSmokeUserDataPath(os.tmpdir())
  const resultPath = path.join(smokeUserDataPath, PACKAGE_EMULATOR_SMOKE_RESULT_FILE)
  const launchArgs = [
    ...buildSmokeLaunchArgv(smokeUserDataPath, os.tmpdir()),
    PACKAGE_EMULATOR_SMOKE_ARG,
    `${PACKAGE_EMULATOR_SMOKE_RESULT_ARG}${resultPath}`
  ]
  if (!argvCarriesIsolation(launchArgs)) {
    throw smokeError(
      'Refusing to launch: package-smoke isolation argv is absent.',
      EXIT_UNSAFE_TO_LAUNCH
    )
  }

  const evidenceParent = path.join(REPO_ROOT, '.local-only', 'emulator-smoke')
  const requestedEvidenceRoot = process.env.TASKWRAITH_EMULATOR_SMOKE_EVIDENCE_ROOT
  if (requestedEvidenceRoot && !path.isAbsolute(requestedEvidenceRoot)) {
    throw new Error('emulator smoke evidence root must be absolute')
  }
  fs.mkdirSync(evidenceParent, { recursive: true })
  const evidenceRoot =
    requestedEvidenceRoot || path.join(evidenceParent, path.basename(smokeUserDataPath))
  // Refuse to consume or overwrite evidence from a previous run.
  fs.mkdirSync(evidenceRoot, { mode: 0o700 })
  console.log(`packaged emulator smoke evidence: ${evidenceRoot}`)
  let registryRoot = null
  let child = null
  let primaryError = null
  let receipt = null
  try {
    fs.mkdirSync(smokeUserDataPath, { mode: 0o700 })
    // The app's Host publishes here, never into the caller's ~/.taskwraith/hosts.
    registryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-emulator-smoke-registry-'))
    fs.mkdirSync(path.join(registryRoot, 'home'), { mode: 0o700 })
    child = launchPackagedApp(packageRoot, launchArgs, registryRoot)
    fs.writeFileSync(
      path.join(evidenceRoot, 'launch.json'),
      JSON.stringify({
        schemaVersion: 1,
        packageRoot,
        userDataPath: smokeUserDataPath,
        home: path.join(registryRoot, 'home'),
        hostRegistryRoot: registryRoot,
        mockKeychain: process.platform === 'darwin',
        childPid: child.pid,
        launchedAt: new Date().toISOString()
      }) + '\n',
      { flag: 'wx', mode: 0o600 }
    )
    const { result: rawResult, output } = await waitForResult(
      resultPath,
      child,
      readIntegerEnv('TASKWRAITH_EMULATOR_PACKAGE_SMOKE_TIMEOUT_MS', DEFAULT_TIMEOUT_MS)
    )
    persistSmokeEvidence(path.join(evidenceRoot, 'result'), rawResult)
    receipt = validatePackagedEmulatorSmokeResult(rawResult, output)
  } catch (error) {
    primaryError = error
    // Retain a bounded classification, never child output, pixels or memory.
    fs.writeFileSync(
      path.join(evidenceRoot, 'failure.json'),
      JSON.stringify({ schemaVersion: 1, ok: false, exitCode: smokeExitCode(error) }) + '\n',
      { flag: 'wx', mode: 0o600 }
    )
    throw error
  } finally {
    await finalizeSmokeCleanup({
      child,
      smokeUserDataPath,
      registryRoot,
      evidenceRoot,
      primaryError
    })
  }
  console.log(
    'packaged emulator runtime smoke ok: ' +
      `frame ${receipt.before.frameId}->${receipt.after.frameId}, ` +
      `x ${receipt.before.x}->${receipt.after.x}, ` +
      `counter ${receipt.before.frameCounter}->${receipt.after.frameCounter}`
  )
}

function validateEmulatorPackageLayout(resourcesDir) {
  const bundleRoot = path.join(resourcesDir, 'emulator', 'homebrew-demo')
  for (const filename of [
    'manifest.json',
    'emulator-package.json',
    'bootstrap.mjs',
    'twgb.mjs',
    'twgb.wasm'
  ]) {
    assertFile(path.join(bundleRoot, filename), `packaged emulator asset ${filename}`)
  }
}

/** A package built before the opt-in main hook must not produce a timeout-shaped defect. */
function assertEmulatorSmokeWiring(appAsarPath) {
  const contents = fs.readFileSync(appAsarPath, 'latin1')
  if (!contents.includes(PACKAGE_EMULATOR_SMOKE_ARG)) {
    throw smokeError(
      'STALE BUNDLE — NOT AN EMULATOR RUNTIME DEFECT. The package does not contain the ' +
        'packaged-emulator smoke hook. Rebuild after the hook registration lands, then re-run.',
      EXIT_STALE_BUNDLE
    )
  }
}

function smokeError(message, exitCode) {
  const error = new Error(message)
  error.exitCode = exitCode
  return error
}

function smokeExitCode(error) {
  const candidate =
    typeof error === 'object' && error && Number.isSafeInteger(error.exitCode)
      ? error.exitCode
      : null
  return candidate !== null && candidate >= 1 && candidate <= 125 ? candidate : 1
}

function resolveResourcesDir(packageRoot) {
  return packageRoot.endsWith('.app')
    ? path.join(packageRoot, 'Contents', 'Resources')
    : path.join(packageRoot, 'resources')
}

function resolveMacExecutablePath(packageRoot) {
  const macosDir = path.join(packageRoot, 'Contents', 'MacOS')
  const appName = path.basename(packageRoot, '.app')
  const candidates = [path.join(macosDir, appName)]
  for (const entry of safeReadDir(macosDir)) {
    if (entry.isFile()) candidates.push(path.join(macosDir, entry.name))
  }
  const executable = candidates.find((candidate) => fs.existsSync(candidate))
  if (!executable) throw new Error(`Packaged macOS executable was not found under ${macosDir}.`)
  return executable
}

function resolveWindowsExecutablePath(packageRoot) {
  const candidates = [
    path.join(packageRoot, 'TaskWraith.exe'),
    path.join(packageRoot, 'TaskWraith Debug.exe')
  ]
  for (const entry of safeReadDir(packageRoot)) {
    if (entry.isFile() && /\.exe$/i.test(entry.name))
      candidates.push(path.join(packageRoot, entry.name))
  }
  const executable = candidates.find((candidate) => fs.existsSync(candidate))
  if (!executable)
    throw new Error(`Packaged Windows executable was not found under ${packageRoot}.`)
  return executable
}

function resolveLinuxExecutablePath(packageRoot) {
  const candidates = [path.join(packageRoot, 'taskwraith'), path.join(packageRoot, 'TaskWraith')]
  for (const entry of safeReadDir(packageRoot)) {
    if (!entry.isFile()) continue
    const candidate = path.join(packageRoot, entry.name)
    try {
      if ((fs.statSync(candidate).mode & 0o111) !== 0) candidates.push(candidate)
    } catch {
      // Preferred candidates below produce the useful error if this entry cannot be read.
    }
  }
  const ignored = new Set([
    'chrome-sandbox',
    'chrome_crashpad_handler',
    'libEGL.so',
    'libGLESv2.so'
  ])
  const executable = candidates.find(
    (candidate) => fs.existsSync(candidate) && !ignored.has(path.basename(candidate))
  )
  if (!executable) throw new Error(`Packaged Linux executable was not found under ${packageRoot}.`)
  return executable
}

/**
 * The packaged app's environment: auto-update off, and the smoke's own Host
 * registry root. The app's external Host inherits the app's environment (its
 * launcher spreads process.env), so without the root that Host would publish
 * into the caller's machine-wide ~/.taskwraith/hosts for the smoke's duration.
 */
function packagedAppEnvironment(registryRoot, env = process.env) {
  if (typeof registryRoot !== 'string' || !path.isAbsolute(registryRoot)) {
    throw new Error('smoke Host registry root must be absolute')
  }
  const home = path.join(registryRoot, 'home')
  return {
    ...env,
    HOME: home,
    CFFIXED_USER_HOME: home,
    TASKWRAITH_AUTO_UPDATE: 'off',
    [HOST_REGISTRY_ROOT_ENV]: registryRoot
  }
}

function launchPackagedApp(packageRoot, launchArgs, registryRoot, spawnProcess = spawn) {
  const isolatedArgs =
    process.platform === 'darwin' && !launchArgs.includes('--use-mock-keychain')
      ? [...launchArgs, '--use-mock-keychain']
      : launchArgs
  const options = {
    cwd: packageRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: packagedAppEnvironment(registryRoot)
  }
  if (process.platform === 'darwin' && packageRoot.endsWith('.app')) {
    // Directly own the spawned app process so a failed private smoke can be
    // terminated without routing a GUI quit through the user's real instance.
    return spawnProcess(resolveMacExecutablePath(packageRoot), isolatedArgs, options)
  }
  if (process.platform === 'win32') {
    return spawnProcess(resolveWindowsExecutablePath(packageRoot), isolatedArgs, options)
  }
  return spawnProcess(
    resolveLinuxExecutablePath(packageRoot),
    ['--no-sandbox', ...isolatedArgs],
    options
  )
}

async function waitForResult(resultPath, child, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let output = ''
  child?.stdout?.on('data', (chunk) => {
    output = appendBoundedOutput(output, chunk)
  })
  child?.stderr?.on('data', (chunk) => {
    output = appendBoundedOutput(output, chunk)
  })
  let launchError = null
  child?.on('error', (error) => {
    launchError = error
  })
  for (;;) {
    if (launchError)
      throw new Error(`Failed to launch packaged emulator smoke: ${launchError.message}`)
    if (fs.existsSync(resultPath)) {
      const stat = fs.lstatSync(resultPath)
      if (!stat.isFile() || stat.size > MAX_RECEIPT_BYTES) {
        throw new Error('Packaged emulator smoke receipt is not a bounded regular file.')
      }
      try {
        return { result: JSON.parse(fs.readFileSync(resultPath, 'utf8')), output }
      } catch {
        // The main process may be between write and rename. Poll the exact same private path.
      }
    }
    if (child?.exitCode !== null && child?.exitCode !== undefined) {
      const detail = output.trim() ? `\noutput:\n${output.trim()}` : ''
      throw new Error(`Packaged emulator smoke exited before writing its receipt.${detail}`)
    }
    if (Date.now() >= deadline) {
      const detail = output.trim() ? `\noutput:\n${output.trim()}` : ''
      throw new Error(
        `Timed out waiting for packaged emulator smoke receipt after ${timeoutMs}ms.${detail}`
      )
    }
    await sleep(100)
  }
}

function appendBoundedOutput(output, chunk) {
  const next = `${output}${String(chunk)}`
  return next.length <= 16_384 ? next : next.slice(-16_384)
}

async function stopSmokeChild(child, wait = waitForChildExit) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  if (await wait(child, 3_000)) return
  child.kill('SIGKILL')
  if (!(await wait(child, 2_000))) {
    throw new Error('Packaged emulator smoke child termination is unconfirmed.')
  }
}

async function finalizeSmokeCleanup(input, stop = stopSmokeChild, remove = fs.rmSync) {
  const cleanupErrors = []
  try {
    await stop(input.child)
  } catch (cleanupError) {
    cleanupErrors.push(cleanupError)
  }
  // Never remove a root while child termination remains uncertain.
  if (cleanupErrors.length === 0) {
    for (const root of [input.smokeUserDataPath, input.registryRoot].filter(Boolean)) {
      try {
        remove(root, { recursive: true, force: true })
      } catch (removalError) {
        cleanupErrors.push(removalError)
      }
    }
  }
  if (cleanupErrors.length > 0) {
    const errors = input.primaryError ? [input.primaryError, ...cleanupErrors] : cleanupErrors
    const rootsRemaining = {
      userData: fs.existsSync(input.smokeUserDataPath),
      registry: Boolean(input.registryRoot && fs.existsSync(input.registryRoot))
    }
    try {
      fs.writeFileSync(
        path.join(input.evidenceRoot, 'cleanup-failure.json'),
        JSON.stringify({
          schemaVersion: 1,
          ok: false,
          rootsPreserved: rootsRemaining.userData || rootsRemaining.registry,
          rootsRemaining,
          primaryFailurePresent: Boolean(input.primaryError),
          childPid: input.child?.pid ?? null,
          userDataPath: input.smokeUserDataPath,
          hostRegistryRoot: input.registryRoot
        }) + '\n',
        { flag: 'wx', mode: 0o600 }
      )
    } catch (evidenceError) {
      errors.push(evidenceError)
    }
    throw new AggregateError(
      errors,
      'Packaged emulator smoke cleanup failed; launch roots preserved.'
    )
  }
}

function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}

function readIntegerEnv(name, fallback) {
  const value = process.env[name]
  if (value === undefined || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`)
  }
  return parsed
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function requireInteger(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`Packaged emulator smoke receipt has invalid ${label}.`)
  }
  return value
}

function validateFrame(value, label) {
  if (!isRecord(value)) throw new Error(`Packaged emulator smoke receipt has no ${label} frame.`)
  if (value.mimeType !== 'image/png' || value.width !== 160 || value.height !== 144) {
    throw new Error(`Packaged emulator smoke receipt ${label} frame is not a 160x144 PNG.`)
  }
  requireInteger(value.byteLength, `${label}.frame.byteLength`, 25)
  if (typeof value.hash !== 'string' || !/^[a-f0-9]{64}$/.test(value.hash)) {
    throw new Error(`Packaged emulator smoke receipt has invalid ${label} PNG hash.`)
  }
  if ('data' in value || 'abiWindow' in value) {
    throw new Error('Packaged emulator smoke receipt must not persist PNG bytes or raw ABI data.')
  }
  return value
}

function assertExactEvidenceKeys(value, keys) {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== keys.length ||
    Object.keys(value).some((key) => !keys.includes(key))
  ) {
    throw new Error('Packaged emulator smoke evidence contains unexpected fields.')
  }
}

function persistSmokeEvidence(root, raw) {
  if (!path.isAbsolute(root)) throw new Error('emulator smoke evidence root must be absolute')
  if (isRecord(raw) && raw.ok === false) {
    assertExactEvidenceKeys(raw, ['ok', 'error'])
    if (!['emulator_smoke_failed', 'emulator_smoke_unavailable'].includes(raw.error)) {
      throw new Error('Packaged emulator smoke evidence contains an unexpected failure code.')
    }
  } else {
    assertExactEvidenceKeys(raw, ['ok', 'receipt'])
    assertExactEvidenceKeys(raw.receipt, [
      'schemaVersion',
      'sessionId',
      'entryUrl',
      'resourceReleased',
      'before',
      'after'
    ])
    if (
      raw.ok !== true ||
      raw.receipt.schemaVersion !== 1 ||
      raw.receipt.sessionId !== 'package-emulator-smoke' ||
      raw.receipt.entryUrl !== 'twemu://app/homebrew-demo/index.html' ||
      typeof raw.receipt.resourceReleased !== 'boolean'
    ) {
      throw new Error('Packaged emulator smoke evidence has an unexpected identity.')
    }
    for (const observation of [raw.receipt.before, raw.receipt.after]) {
      assertExactEvidenceKeys(observation, [
        'frameId',
        'emulationGeneration',
        'inputEpoch',
        'x',
        'y',
        'input',
        'frameCounter',
        'frame'
      ])
      assertExactEvidenceKeys(observation.frame, [
        'mimeType',
        'width',
        'height',
        'byteLength',
        'hash'
      ])
      validateObservation(observation, 'retained')
    }
  }
  const bytes = JSON.stringify(raw) + '\n'
  if (Buffer.byteLength(bytes) > MAX_RECEIPT_BYTES) {
    throw new Error('Packaged emulator smoke evidence exceeds its receipt bound.')
  }
  fs.mkdirSync(root, { mode: 0o700 })
  const target = path.join(root, PACKAGE_EMULATOR_SMOKE_RESULT_FILE)
  fs.writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 })
  return target
}

function validateObservation(value, label) {
  if (!isRecord(value))
    throw new Error(`Packaged emulator smoke receipt has no ${label} observation.`)
  const frame = validateFrame(value.frame, label)
  return {
    frameId: requireInteger(value.frameId, `${label}.frameId`, 1),
    emulationGeneration: requireInteger(
      value.emulationGeneration,
      `${label}.emulationGeneration`,
      1
    ),
    inputEpoch: requireInteger(value.inputEpoch, `${label}.inputEpoch`),
    x: requireInteger(value.x, `${label}.x`),
    y: requireInteger(value.y, `${label}.y`),
    input: requireInteger(value.input, `${label}.input`),
    frameCounter: requireInteger(value.frameCounter, `${label}.frameCounter`, 1),
    frame
  }
}

function appendBoundedFailureOutput(output) {
  const bounded = String(output ?? '')
    .trim()
    .slice(0, MAX_FAILURE_OUTPUT_CHARS)
  return bounded ? `\nchild output:\n${bounded}` : ''
}

/** Parse only the public, disk-safe evidence the index hook writes after close. */
function validatePackagedEmulatorSmokeResult(value, output = '') {
  if (!isRecord(value) || value.ok !== true || !isRecord(value.receipt)) {
    const detail = isRecord(value) && typeof value.error === 'string' ? `: ${value.error}` : ''
    const failureOutput = appendBoundedFailureOutput(output)
    throw new Error(`Packaged emulator smoke did not report success${detail}${failureOutput}`)
  }
  const receipt = value.receipt
  if (
    receipt.schemaVersion !== 1 ||
    receipt.sessionId !== 'package-emulator-smoke' ||
    receipt.entryUrl !== 'twemu://app/homebrew-demo/index.html' ||
    receipt.resourceReleased !== true
  ) {
    throw new Error('Packaged emulator smoke receipt does not describe the fixed reviewed session.')
  }
  const before = validateObservation(receipt.before, 'before')
  const after = validateObservation(receipt.after, 'after')
  if (
    before.x !== 80 ||
    before.y !== 72 ||
    before.input !== 0 ||
    after.x !== 81 ||
    after.y !== 72 ||
    after.input !== 0x10 ||
    after.emulationGeneration !== before.emulationGeneration ||
    after.inputEpoch !== before.inputEpoch ||
    after.frameId !== before.frameId + 1 ||
    after.frameCounter !== before.frameCounter + 1 ||
    after.frame.hash === before.frame.hash
  ) {
    throw new Error('Packaged emulator smoke receipt did not prove one bounded Right frame.')
  }
  return { before, after }
}

function assertFile(filePath, label) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error(`Missing ${label}: ${filePath}`)
  }
}

function assertDir(dirPath, label) {
  if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
    throw new Error(`Missing ${label}: ${dirPath}`)
  }
}

function safeReadDir(dirPath) {
  try {
    return fs.readdirSync(dirPath, { withFileTypes: true })
  } catch {
    return []
  }
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

module.exports = {
  PACKAGE_EMULATOR_SMOKE_ARG,
  PACKAGE_EMULATOR_SMOKE_RESULT_ARG,
  PACKAGE_EMULATOR_SMOKE_RESULT_FILE,
  EXIT_STALE_BUNDLE,
  EXIT_UNSAFE_TO_LAUNCH,
  HOST_REGISTRY_ROOT_ENV,
  launchPackagedApp,
  packagedAppEnvironment,
  persistSmokeEvidence,
  stopSmokeChild,
  finalizeSmokeCleanup,
  smokeExitCode,
  validateEmulatorPackageLayout,
  validatePackagedEmulatorSmokeResult,
  resolveResourcesDir
}
