#!/usr/bin/env node

/**
 * Opt-in real packaged emulator smoke.
 *
 * This launch is deliberately isolated from a user's TaskWraith profile, uses
 * the product's private package-smoke posture, and asks the packaged main
 * process to run the fixed `homebrew-demo` factory/bridge/WASM probe. It does
 * not drive renderer controls or depend on browser selectors.
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
const EXIT_STALE_BUNDLE = 20
const EXIT_UNSAFE_TO_LAUNCH = 21

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

  fs.mkdirSync(smokeUserDataPath, { recursive: true })
  let child = null
  try {
    child = launchPackagedApp(packageRoot, launchArgs)
    const rawResult = await waitForResult(
      resultPath,
      child,
      readIntegerEnv('TASKWRAITH_EMULATOR_PACKAGE_SMOKE_TIMEOUT_MS', DEFAULT_TIMEOUT_MS)
    )
    const receipt = validatePackagedEmulatorSmokeResult(rawResult)
    console.log(
      'packaged emulator runtime smoke ok: ' +
        `frame ${receipt.before.frameId}->${receipt.after.frameId}, ` +
        `x ${receipt.before.x}->${receipt.after.x}, ` +
        `counter ${receipt.before.frameCounter}->${receipt.after.frameCounter}`
    )
  } finally {
    await stopSmokeChild(child)
    fs.rmSync(smokeUserDataPath, { recursive: true, force: true })
  }
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

function launchPackagedApp(packageRoot, launchArgs) {
  const options = {
    cwd: packageRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, TASKWRAITH_AUTO_UPDATE: 'off' }
  }
  if (process.platform === 'darwin' && packageRoot.endsWith('.app')) {
    // Directly own the spawned app process so a failed private smoke can be
    // terminated without routing a GUI quit through the user's real instance.
    return spawn(resolveMacExecutablePath(packageRoot), launchArgs, options)
  }
  if (process.platform === 'win32') {
    return spawn(resolveWindowsExecutablePath(packageRoot), launchArgs, options)
  }
  return spawn(resolveLinuxExecutablePath(packageRoot), ['--no-sandbox', ...launchArgs], options)
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
      try {
        return JSON.parse(fs.readFileSync(resultPath, 'utf8'))
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

async function stopSmokeChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  if (await waitForChildExit(child, 3_000)) return
  child.kill('SIGKILL')
  await waitForChildExit(child, 2_000)
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

/** Parse only the public, disk-safe evidence the index hook writes after close. */
function validatePackagedEmulatorSmokeResult(value) {
  if (!isRecord(value) || value.ok !== true || !isRecord(value.receipt)) {
    const detail = isRecord(value) && typeof value.error === 'string' ? `: ${value.error}` : ''
    throw new Error(`Packaged emulator smoke did not report success${detail}`)
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
  smokeExitCode,
  validateEmulatorPackageLayout,
  validatePackagedEmulatorSmokeResult,
  resolveResourcesDir
}
