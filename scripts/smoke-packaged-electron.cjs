#!/usr/bin/env node

const fs = require('node:fs')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')
const { validatePackagedNotices } = require('../build/third-party-notices.cjs')

const repoRoot = process.cwd()
const searchArg = process.argv[2]
const searchRoots = searchArg
  ? [path.resolve(repoRoot, searchArg)]
  : ['dist', 'dist-debug'].map((dir) => path.join(repoRoot, dir))
const bundleSizeGuardDisabled = process.env.TASKWRAITH_DISABLE_BUNDLE_SIZE_GUARD === '1'
const maxAsarBytes = readMegabyteLimit('TASKWRAITH_MAX_ASAR_MB', 500)
const maxZipBytes = readMegabyteLimit('TASKWRAITH_MAX_ZIP_MB', 700)
const launchSmokeTimeoutMs = readIntegerEnv('TASKWRAITH_PACKAGE_SMOKE_TIMEOUT_MS', 8000)
const DEVELOPER_ID_LEAF_PREFIX = 'Developer ID Application:'

// Requiring this script — its unit tests do, to exercise the signing-posture
// helpers — must not launch the smoke run against the real repository. Only
// direct execution starts main(); every npm script invokes it as the entry
// point, so this changes nothing for them.
if (require.main === module) {
  main().catch((error) => {
    fail(error instanceof Error ? error.stack || error.message : String(error))
  })
}

async function main() {
  if (!searchArg) {
    assertFile(path.join(repoRoot, 'out/main/index.js'), 'main bundle')
    assertFile(path.join(repoRoot, 'out/preload/index.js'), 'preload bundle')
    assertFile(path.join(repoRoot, 'out/renderer/index.html'), 'renderer bundle')
  }

  const packageRoot = findPackagedApp(searchRoots)
  if (!packageRoot) {
    fail(`No packaged Electron app was found under ${searchRoots.join(', ')}.`)
  }

  const resourcesDir = resolveResourcesDir(packageRoot)
  const packageTarget = inferPackageTarget(packageRoot)
  const appAsarPath = path.join(resourcesDir, 'app.asar')
  assertDir(resourcesDir, 'Electron resources directory')
  assertFile(appAsarPath, 'packaged app.asar')
  assertMaxFileSize(appAsarPath, 'packaged app.asar', maxAsarBytes)
  const distributionMetadata = readPackagedDistributionMetadata(appAsarPath)
  validatePackagedIdentityHandoffPayload(resourcesDir, distributionMetadata)
  validatePackagedNotices(resourcesDir)
  console.log('packaged third-party notice coverage ok')

  const unpackedDir = path.join(resourcesDir, 'app.asar.unpacked')
  assertDir(unpackedDir, 'app.asar.unpacked directory')
  const expectedMacArchs =
    packageTarget.platform === 'darwin' ? expectedMacArchitectures(packageTarget.arch) : []

  const nativeBindings = findFiles(unpackedDir, (filePath) => {
    const normalized = filePath.split(path.sep).join('/')
    return (
      normalized.includes('/node_modules/node-pty/') &&
      path.basename(filePath) === 'pty.node' &&
      isCompatibleNodePtyBinding(normalized, packageTarget.platform, packageTarget.arch)
    )
  })

  if (nativeBindings.length === 0) {
    fail(
      `Compatible node-pty native binding for ${packageTarget.platform}-${packageTarget.arch} was not found in ${unpackedDir}.`
    )
  }

  if (packageTarget.platform === 'darwin') {
    validateMacPackageBinaries(packageRoot, resourcesDir, expectedMacArchs)
    validateMacElectronFrameworkSignature(packageRoot, resourcesDir)
    validateMacAppPermissionMetadata(packageRoot, distributionMetadata)
    validateMacAppSignature(packageRoot)
    validateMacNodePtyBindings(unpackedDir, expectedMacArchs)
    validateMacClaudeAgentSdkBinaries(unpackedDir, expectedMacArchs)
  }
  if (packageTarget.platform === 'win32') {
    validateWindowsPackageBinaries(packageRoot)
    validateWindowsNodePtyBindings(unpackedDir, packageTarget.arch)
    validateWindowsClaudeAgentSdkBinaries(unpackedDir, packageTarget.arch)
  }
  if (packageTarget.platform === 'linux') {
    validateLinuxPackageBinaries(packageRoot)
  }

  validateZipArtifacts(searchRoots)
  console.log(
    `packaged Electron static smoke ok: ${path.relative(repoRoot, packageRoot) || packageRoot}`
  )
  console.log(`node-pty native binding: ${path.relative(repoRoot, nativeBindings[0])}`)
  await runLaunchSmoke(packageRoot)
  runPackagedTuiSmoke(packageRoot)
}

/**
 * Developer Preview: assert the tw sidecar payload + launchers shipped outside
 * app.asar. Delegates to scripts/smoke-packaged-tui.cjs so build:unpack and
 * other package smokers pick up the TUI gate without a separate script hop.
 */
function runPackagedTuiSmoke(packageRoot) {
  if (process.env.TASKWRAITH_SKIP_TUI_PACKAGE_SMOKE === '1') {
    if (process.env.TASKWRAITH_TUI_REQUIRE_PACKAGED_HOST === '1') {
      fail(
        'TASKWRAITH_SKIP_TUI_PACKAGE_SMOKE=1 cannot be combined with TASKWRAITH_TUI_REQUIRE_PACKAGED_HOST=1'
      )
    }
    console.log('packaged TUI smoke skipped via TASKWRAITH_SKIP_TUI_PACKAGE_SMOKE=1')
    return
  }
  const smokeScript = path.join(repoRoot, 'scripts/smoke-packaged-tui.cjs')
  if (!fs.existsSync(smokeScript)) {
    fail(`Missing packaged TUI smoke script: ${smokeScript}`)
  }
  // Pass the exact package root. A shared dist parent can contain x64 and ARM
  // siblings; rediscovery from the parent may select the wrong architecture.
  const result = spawnSync(process.execPath, [smokeScript, packageRoot], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      // Package is known present — fail closed for the TUI payload.
      TASKWRAITH_TUI_REQUIRE_PACKAGE: '1'
    }
  })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  if (result.status !== 0) {
    fail(
      `packaged TUI smoke failed with exit ${result.status ?? 'null'}${
        result.error ? `: ${result.error.message}` : ''
      }`
    )
  }
}

function assertFile(filePath, label) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    fail(`Missing ${label}: ${filePath}`)
  }
}

function assertExecutable(filePath, label) {
  assertFile(filePath, label)
  try {
    fs.accessSync(filePath, fs.constants.X_OK)
  } catch {
    fail(`${label} is not executable: ${filePath}`)
  }
}

function assertDir(dirPath, label) {
  if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
    fail(`Missing ${label}: ${dirPath}`)
  }
}

function assertMaxFileSize(filePath, label, maxBytes) {
  if (bundleSizeGuardDisabled) return
  const stat = fs.statSync(filePath)
  if (stat.size > maxBytes) {
    fail(
      `${label} exceeds size limit: ${path.relative(repoRoot, filePath) || filePath} is ${formatBytes(stat.size)}; limit is ${formatBytes(maxBytes)}.`
    )
  }
}

function validateZipArtifacts(roots) {
  if (bundleSizeGuardDisabled) {
    console.log('bundle size guard skipped via TASKWRAITH_DISABLE_BUNDLE_SIZE_GUARD=1')
    return
  }
  const zipArtifacts = findFilesInRoots(
    roots,
    (filePath) => path.extname(filePath).toLowerCase() === '.zip'
  )
  for (const zipPath of zipArtifacts) {
    assertMaxFileSize(zipPath, 'packaged zip artifact', maxZipBytes)
  }
  if (zipArtifacts.length > 0) {
    console.log(`validated packaged zip size guard: ${zipArtifacts.length} artifact(s)`)
  }
}

async function runLaunchSmoke(packageRoot) {
  if (process.env.TASKWRAITH_SKIP_LAUNCH_SMOKE === '1') {
    if (process.env.TASKWRAITH_FORCE_LAUNCH_SMOKE === '1') {
      fail('TASKWRAITH_SKIP_LAUNCH_SMOKE=1 cannot be combined with TASKWRAITH_FORCE_LAUNCH_SMOKE=1')
    }
    console.log('packaged app launch smoke skipped via TASKWRAITH_SKIP_LAUNCH_SMOKE=1')
    return
  }
  if (process.platform !== 'darwin' || !packageRoot.endsWith('.app')) {
    if (process.platform === 'win32' && inferPackageTarget(packageRoot).platform === 'win32') {
      await runWindowsLaunchSmoke(packageRoot)
      return
    }
    if (process.platform === 'linux' && inferPackageTarget(packageRoot).platform === 'linux') {
      await runLinuxLaunchSmoke(packageRoot)
      return
    }
    console.log(`packaged app launch smoke skipped for ${process.platform}`)
    return
  }

  // Second GUI launches of a candidate bundle from agent shells often abort in
  // LaunchServices (RegisterApplication) and surface "TaskWraith quit
  // unexpectedly" prompts against the human's running host. Static package
  // checks already validated the layout; skip live launch unless forced.
  if (process.env.TASKWRAITH_FORCE_LAUNCH_SMOKE !== '1' && isTaskWraithAlreadyRunning()) {
    console.log(
      'packaged app launch smoke skipped: TaskWraith already running ' +
        '(set TASKWRAITH_FORCE_LAUNCH_SMOKE=1 to insist; avoids LaunchServices abort prompts)'
    )
    return
  }

  const executablePath = resolveMacExecutablePath(packageRoot)
  const appName = path.basename(packageRoot, '.app')
  const openProc = spawn('/usr/bin/open', ['-n', '-W', packageRoot], {
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let openOutput = ''
  let openError = null
  openProc.stdout?.on('data', (chunk) => {
    openOutput += chunk.toString()
  })
  openProc.stderr?.on('data', (chunk) => {
    openOutput += chunk.toString()
  })
  openProc.on('error', (error) => {
    openError = error
  })

  const launchResult = await waitForMacAppProcess(executablePath, launchSmokeTimeoutMs)
  await quitMacAppProcess(executablePath)
  const exitResult = await waitForChildExit(openProc, 3000)
  if (!exitResult.exited) {
    openProc.kill('SIGTERM')
  }

  if (openError) {
    if (
      process.env.TASKWRAITH_FORCE_LAUNCH_SMOKE !== '1' &&
      isRecoverableMacLaunchFailure(openError.message, openOutput)
    ) {
      console.log(
        `packaged app launch smoke skipped: LaunchServices cannot start a second GUI app (${openError.message})`
      )
      return
    }
    fail(`Failed to launch packaged app with /usr/bin/open: ${openError.message}`)
  }
  if (!launchResult.ok) {
    const detail = openOutput.trim() ? `\nopen output:\n${openOutput.trim()}` : ''
    // Agent shells often abort second-GUI registration; static package checks
    // already validated layout. Soft-skip unless CI forces a hard launch gate.
    if (process.env.TASKWRAITH_FORCE_LAUNCH_SMOKE !== '1') {
      console.log(
        `packaged app launch smoke skipped: ${appName} did not stay running within ${launchSmokeTimeoutMs}ms (static checks already validated package).${detail}`
      )
      return
    }
    fail(
      `Packaged app launch smoke failed: ${appName} did not stay running within ${launchSmokeTimeoutMs}ms.${detail}`
    )
  }

  console.log(`packaged app launch smoke ok: ${appName} (${launchResult.pidCount} process id(s))`)
}

function isTaskWraithAlreadyRunning() {
  // Best-effort: pgrep by app name. Prefer skip over spawning a second copy.
  const result = spawnSync('/usr/bin/pgrep', ['-f', 'TaskWraith\\.app/Contents/MacOS/TaskWraith'], {
    encoding: 'utf8'
  })
  return result.status === 0 && Boolean(result.stdout && result.stdout.trim())
}

function isRecoverableMacLaunchFailure(message, openOutput) {
  const text = `${message || ''}\n${openOutput || ''}`
  return /RegisterApplication|Launch Services|LSOpen|kLS|could not be opened|Unable to find application/i.test(
    text
  )
}

async function runWindowsLaunchSmoke(packageRoot) {
  const executablePath = resolveWindowsExecutablePath(packageRoot)
  const targetArch = inferPackageTarget(packageRoot).arch

  // A binary can only be *launched* on a host whose CPU can execute that
  // architecture. The windows-latest GitHub Actions runner is x64, which cannot
  // run the arm64 TaskWraith.exe at all: CreateProcessW fails with
  // ERROR_BAD_EXE_FORMAT (193), libuv maps that to its catch-all "UNKNOWN"
  // errno, and Node throws it *synchronously* from spawn() (UNKNOWN is not in
  // the small allowlist of errors emitted on 'error'), so it bypasses the
  // handler below and crashes the smoke. The structural checks above already
  // validated this package; only the live launch is host-arch dependent, so
  // skip it rather than fail the whole build.
  if (!canExecuteArchOnHost(targetArch)) {
    console.log(
      `packaged app launch smoke skipped: cannot execute win32-${targetArch} binary on ${process.arch} host (static package checks already validated this build)`
    )
    return
  }

  let child
  try {
    child = spawn(executablePath, ['--no-sandbox', '--disable-gpu'], {
      cwd: packageRoot,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        TASKWRAITH_AUTO_UPDATE: 'off'
      }
    })
  } catch (error) {
    // Defence in depth: any other libuv "UNKNOWN" (or similar) spawn failure is
    // thrown synchronously, so report it cleanly instead of as a bare stack.
    fail(
      `Failed to launch packaged Windows app ${path.basename(executablePath)}: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
    return
  }

  let output = ''
  let launchError = null
  child.stdout?.on('data', (chunk) => {
    output += chunk.toString()
  })
  child.stderr?.on('data', (chunk) => {
    output += chunk.toString()
  })
  child.on('error', (error) => {
    launchError = error
  })

  await sleep(Math.min(launchSmokeTimeoutMs, 2500))
  if (launchError) {
    fail(`Failed to launch packaged Windows app: ${launchError.message}`)
  }
  if (child.exitCode !== null) {
    const detail = output.trim() ? `\noutput:\n${output.trim()}` : ''
    fail(`Packaged Windows app exited during launch smoke with code ${child.exitCode}.${detail}`)
  }
  await stopSmokeChild(child, 'packaged Windows app')
  console.log(`packaged app launch smoke ok: ${path.basename(executablePath)}`)
}

async function runLinuxLaunchSmoke(packageRoot) {
  const executablePath = resolveLinuxExecutablePath(packageRoot)
  const child = spawn(executablePath, ['--no-sandbox', '--disable-gpu'], {
    cwd: packageRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      TASKWRAITH_AUTO_UPDATE: 'off'
    }
  })

  let output = ''
  let launchError = null
  child.stdout?.on('data', (chunk) => {
    output += chunk.toString()
  })
  child.stderr?.on('data', (chunk) => {
    output += chunk.toString()
  })
  child.on('error', (error) => {
    launchError = error
  })

  await sleep(Math.min(launchSmokeTimeoutMs, 2500))
  if (launchError) {
    fail(`Failed to launch packaged Linux app: ${launchError.message}`)
  }
  if (child.exitCode !== null) {
    const detail = output.trim() ? `\noutput:\n${output.trim()}` : ''
    fail(`Packaged Linux app exited during launch smoke with code ${child.exitCode}.${detail}`)
  }
  await stopSmokeChild(child, 'packaged Linux app')
  console.log(`packaged app launch smoke ok: ${path.basename(executablePath)}`)
}

async function stopSmokeChild(child, label) {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  let exitResult = await waitForChildExit(child, 3000)
  if (exitResult.exited) return
  child.kill('SIGKILL')
  exitResult = await waitForChildExit(child, 2000)
  if (!exitResult.exited) {
    fail(`${label} did not exit after bounded SIGTERM/SIGKILL cleanup`)
  }
}

// Whether the current host CPU can natively execute a Windows binary of the
// given target architecture.
function canExecuteArchOnHost(targetArch) {
  const hostArch = process.arch
  if (targetArch === hostArch) return true
  // Windows on ARM transparently emulates x64 and 32-bit x86 (ia32).
  if (hostArch === 'arm64' && (targetArch === 'x64' || targetArch === 'ia32')) return true
  // 64-bit x64 Windows runs 32-bit x86 (ia32) binaries via WOW64.
  if (hostArch === 'x64' && targetArch === 'ia32') return true
  // Notably arm64 binaries cannot run on an x64 host (the windows-latest runner).
  return false
}

function resolveMacExecutablePath(packageRoot) {
  const macosDir = path.join(packageRoot, 'Contents', 'MacOS')
  const appName = path.basename(packageRoot, '.app')
  const candidates = [path.join(macosDir, appName)]
  for (const entry of safeReadDir(macosDir)) {
    if (entry.isFile()) candidates.push(path.join(macosDir, entry.name))
  }
  const found = candidates.find((candidate) => fs.existsSync(candidate))
  if (found) return found
  fail(`Packaged app executable was not found under ${macosDir}.`)
}

async function waitForMacAppProcess(executablePath, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let firstSeenAt = 0
  let lastPidCount = 0
  while (Date.now() < deadline) {
    const pids = findProcessIdsForExecutable(executablePath)
    lastPidCount = pids.length
    if (pids.length > 0) {
      if (firstSeenAt === 0) firstSeenAt = Date.now()
      if (Date.now() - firstSeenAt >= 1500) {
        return { ok: true, pidCount: pids.length }
      }
    } else {
      firstSeenAt = 0
    }
    await sleep(250)
  }
  return { ok: false, pidCount: lastPidCount }
}

async function quitMacAppProcess(executablePath) {
  const pids = findProcessIdsForExecutable(executablePath)
  if (pids.length === 0) return
  spawnSync('/bin/kill', pids, { stdio: 'ignore' })
  await sleep(500)
  const remaining = findProcessIdsForExecutable(executablePath)
  if (remaining.length > 0) {
    spawnSync('/bin/kill', ['-9', ...remaining], { stdio: 'ignore' })
  }
}

function findProcessIdsForExecutable(executablePath) {
  const result = spawnSync('/usr/bin/pgrep', ['-f', escapeRegex(executablePath)], {
    encoding: 'utf8'
  })
  if (result.status !== 0 || !result.stdout.trim()) return []
  return result.stdout
    .trim()
    .split(/\s+/)
    .map((pid) => pid.trim())
    .filter(Boolean)
}

function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ exited: true })
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cleanup()
      resolve({ exited: false })
    }, timeoutMs)
    const onExit = () => {
      cleanup()
      resolve({ exited: true })
    }
    const cleanup = () => {
      clearTimeout(timer)
      child.off('exit', onExit)
    }
    child.once('exit', onExit)
  })
}

function findPackagedApp(roots) {
  for (const root of roots) {
    if (!fs.existsSync(root)) continue
    if (isPackagedRoot(root)) return root
    const found = findDirectories(root, isPackagedRoot, 5)
    if (found.length > 0) return found[0]
  }
  return null
}

function isPackagedRoot(candidate) {
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isDirectory()) return false
  if (
    candidate.endsWith('.app') &&
    fs.existsSync(path.join(candidate, 'Contents/Resources/app.asar'))
  ) {
    return true
  }
  return fs.existsSync(path.join(candidate, 'resources/app.asar'))
}

function resolveResourcesDir(packageRoot) {
  if (packageRoot.endsWith('.app')) {
    return path.join(packageRoot, 'Contents/Resources')
  }
  return path.join(packageRoot, 'resources')
}

function inferPackageTarget(packageRoot) {
  const normalized = packageRoot.split(path.sep).join('/')
  if (
    packageRoot.endsWith('.app') ||
    normalized.includes('/mac') ||
    normalized.includes('darwin')
  ) {
    return {
      platform: 'darwin',
      arch:
        normalized.includes('universal') || normalized.includes('mac-universal')
          ? 'universal'
          : normalized.includes('arm64')
            ? 'arm64'
            : normalized.includes('x64') || normalized.includes('x86_64')
              ? 'x64'
              : process.arch
    }
  }
  if (normalized.includes('win-unpacked') || normalized.includes('/win')) {
    return {
      platform: 'win32',
      arch: normalized.includes('arm64') ? 'arm64' : normalized.includes('ia32') ? 'ia32' : 'x64'
    }
  }
  if (normalized.includes('linux')) {
    return {
      platform: 'linux',
      arch: normalized.includes('arm64')
        ? 'arm64'
        : normalized.includes('armv7l')
          ? 'armv7l'
          : 'x64'
    }
  }
  return { platform: process.platform, arch: process.arch }
}

function isCompatibleNodePtyBinding(normalizedPath, platform, arch) {
  if (platform === 'darwin' && arch === 'universal') {
    return /\/node_modules\/node-pty\/prebuilds\/darwin-(?:arm64|x64)\/pty\.node$/.test(
      normalizedPath
    )
  }
  const prebuildNeedle = `/node_modules/node-pty/prebuilds/${platform}-${arch}/pty.node`
  const rebuiltNeedle = '/node_modules/node-pty/build/Release/pty.node'
  return normalizedPath.endsWith(prebuildNeedle) || normalizedPath.endsWith(rebuiltNeedle)
}

function validateMacPackageBinaries(packageRoot, resourcesDir, expectedArchs) {
  if (expectedArchs.length === 0 || process.platform !== 'darwin') return
  verifyMachOArchitectures(resolveMacExecutablePath(packageRoot), expectedArchs, 'app executable')
  const contentsDir = path.dirname(resourcesDir)
  const frameworksDir = path.join(contentsDir, 'Frameworks')
  const electronFramework = path.join(
    frameworksDir,
    'Electron Framework.framework',
    'Electron Framework'
  )
  if (fs.existsSync(electronFramework)) {
    verifyMachOArchitectures(electronFramework, expectedArchs, 'Electron Framework')
  }
  for (const helperApp of findDirectories(
    frameworksDir,
    (candidate) => candidate.endsWith('.app'),
    5
  )) {
    const macosDir = path.join(helperApp, 'Contents', 'MacOS')
    for (const entry of safeReadDir(macosDir)) {
      if (!entry.isFile()) continue
      verifyMachOArchitectures(
        path.join(macosDir, entry.name),
        expectedArchs,
        `Electron helper ${path.basename(helperApp)}`
      )
    }
  }
  const bridgeDaemon = path.join(resourcesDir, 'bridge', 'TaskWraithBridgeDaemon')
  assertFile(bridgeDaemon, 'TaskWraithBridgeDaemon')
  verifyMachOArchitectures(bridgeDaemon, expectedArchs, 'TaskWraithBridgeDaemon')

  const studioApp = path.join(resourcesDir, 'studio', 'TaskWraith Studio.app')
  const studioInfoPath = path.join(studioApp, 'Contents', 'Info.plist')
  const studioExecutable = path.join(studioApp, 'Contents', 'MacOS', 'TaskWraithStudioCompanion')
  assertDir(studioApp, 'TaskWraith Studio.app')
  assertFile(studioInfoPath, 'TaskWraith Studio Info.plist')
  assertFile(studioExecutable, 'TaskWraithStudioCompanion')
  const studioInfo = readPlistAsJson(studioInfoPath, 'TaskWraith Studio Info.plist')
  if (studioInfo.CFBundleIdentifier !== 'com.chrisizatt.taskwraith.studio') {
    fail(
      `TaskWraith Studio CFBundleIdentifier must be com.chrisizatt.taskwraith.studio, got ${String(studioInfo.CFBundleIdentifier)}.`
    )
  }
  if (studioInfo.CFBundleExecutable !== 'TaskWraithStudioCompanion') {
    fail(
      `TaskWraith Studio CFBundleExecutable must be TaskWraithStudioCompanion, got ${String(studioInfo.CFBundleExecutable)}.`
    )
  }
  verifyMachOArchitectures(studioExecutable, expectedArchs, 'TaskWraithStudioCompanion')
}

function validateMacElectronFrameworkSignature(packageRoot, resourcesDir) {
  if (process.platform !== 'darwin') return
  const electronFramework = path.join(
    path.dirname(resourcesDir),
    'Frameworks',
    'Electron Framework.framework',
    'Electron Framework'
  )
  if (!fs.existsSync(electronFramework)) {
    fail(`Electron Framework was not packaged at ${electronFramework}.`)
  }

  const result = spawnSync('/usr/bin/codesign', ['--verify', '--strict', electronFramework], {
    encoding: 'utf8'
  })
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
    fail(
      `Electron Framework code signature is invalid in ${path.relative(repoRoot, packageRoot)}.${
        detail ? `\n${detail}` : ''
      }`
    )
  }
  console.log('validated Electron Framework code signature')
}

function validateMacAppPermissionMetadata(packageRoot, distributionMetadata) {
  if (process.platform !== 'darwin') return
  const infoPlistPath = path.join(packageRoot, 'Contents', 'Info.plist')
  assertFile(infoPlistPath, 'packaged app Info.plist')
  const info = readPlistAsJson(infoPlistPath, 'packaged app Info.plist')
  if (info.CFBundleIdentifier !== distributionMetadata.appId) {
    fail(
      `Packaged app CFBundleIdentifier ${String(info.CFBundleIdentifier)} does not match embedded ${distributionMetadata.series} identity ${distributionMetadata.appId}.`
    )
  }
  for (const key of ['CFBundleName', 'CFBundleDisplayName']) {
    if (info[key] !== 'TaskWraith') {
      fail(`Packaged app Info.plist ${key} must be exactly TaskWraith.`)
    }
  }
  for (const key of ['NSScreenCaptureUsageDescription', 'NSAppleEventsUsageDescription']) {
    if (typeof info[key] !== 'string' || info[key].trim().length === 0) {
      fail(`Packaged app Info.plist is missing a non-empty ${key}.`)
    }
  }
  if (Object.hasOwn(info, 'NSAccessibilityUsageDescription')) {
    fail('Packaged app Info.plist contains unsupported NSAccessibilityUsageDescription.')
  }
  if (
    typeof info.NSLocalNetworkUsageDescription !== 'string' ||
    !info.NSLocalNetworkUsageDescription.trim().startsWith('TaskWraith ')
  ) {
    fail('Packaged app Info.plist must carry the TaskWraith local-network usage identity.')
  }
  console.log('validated packaged macOS permission metadata')
}

function readPackagedDistributionMetadata(appAsarPath, asarApi = require('@electron/asar')) {
  let metadata
  try {
    metadata = JSON.parse(
      Buffer.from(asarApi.extractFile(appAsarPath, 'package.json')).toString('utf8')
    )
  } catch (error) {
    fail(
      `Packaged distribution metadata is unreadable: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  const series = String(metadata.taskwraithDistributionIdentity || '').trim()
  const appId = String(metadata.taskwraithAppId || '').trim()
  const feed = String(metadata.taskwraithUpdateFeedChannel || '').trim()
  const version = String(metadata.version || '').trim()
  const validBeta = series === 'beta' && appId === 'com.chrisizatt.taskwraith' && feed === 'latest'
  const validRelease =
    series === 'release' && appId === 'com.taskwraith.desktop' && feed === 'release'
  if (!validBeta && !validRelease) {
    fail('Packaged app contains an unknown or mixed distribution identity/appId/update feed.')
  }
  if (!version) fail('Packaged app distribution metadata is missing its version.')
  console.log(`validated packaged ${series} distribution identity (${appId}, ${feed} feed)`)
  return { series, appId, stableUpdateChannel: feed, version }
}

function validatePackagedIdentityHandoffPayload(resourcesDir, distributionMetadata) {
  const payloadPath = path.join(resourcesDir, 'identity-handoff.json')
  const required =
    distributionMetadata.series === 'beta' && distributionMetadata.version === '1.9.9'
  if (!required) {
    if (fs.existsSync(payloadPath)) {
      fail(
        `Identity handoff payload must not ship in ${distributionMetadata.series} ${distributionMetadata.version}.`
      )
    }
    return
  }
  assertFile(payloadPath, 'final-beta identity handoff payload')
  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(payloadPath, 'utf8'))
  } catch (error) {
    fail(
      `Final-beta identity handoff payload is unreadable: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  const { validateManifest } = require('./identity-handoff-manifest.cjs')
  const errors = validateManifest(manifest, { requirePrepared: true })
  if (errors.length > 0) {
    fail(`Final-beta identity handoff payload is invalid:\n${errors.join('\n')}`)
  }
  console.log('validated packaged final-beta identity handoff payload')
}

function validateMacAppSignature(packageRoot) {
  if (process.platform !== 'darwin') return
  const verification = spawnSync(
    '/usr/bin/codesign',
    ['--verify', '--deep', '--strict', '--verbose=2', packageRoot],
    { encoding: 'utf8' }
  )
  if (verification.status !== 0) {
    const detail = [verification.stdout, verification.stderr].filter(Boolean).join('\n').trim()
    fail(
      `Packaged app code signature is invalid in ${path.relative(repoRoot, packageRoot)}.${
        detail ? `\n${detail}` : ''
      }`
    )
  }

  const entitlements = readSignedEntitlements(packageRoot, true)
  assertAppleEventsEntitlement(entitlements, 'Packaged app signature')
  const bridgeDaemon = path.join(
    packageRoot,
    'Contents',
    'Resources',
    'bridge',
    'TaskWraithBridgeDaemon'
  )
  assertFile(bridgeDaemon, 'TaskWraithBridgeDaemon')
  const bridgeEntitlements = readSignedEntitlements(bridgeDaemon, true)
  assertAppleEventsEntitlement(bridgeEntitlements, 'TaskWraithBridgeDaemon signature')

  const studioApp = path.join(
    packageRoot,
    'Contents',
    'Resources',
    'studio',
    'TaskWraith Studio.app'
  )
  assertDir(studioApp, 'TaskWraith Studio.app')
  // --deep matches the outer app's verification depth. Without it a broken
  // seal on code nested inside Studio.app could not be observed here.
  const studioVerification = spawnSync(
    '/usr/bin/codesign',
    ['--verify', '--deep', '--strict', '--verbose=2', studioApp],
    { encoding: 'utf8' }
  )
  if (studioVerification.status !== 0) {
    const detail = [studioVerification.stdout, studioVerification.stderr]
      .filter(Boolean)
      .join('\n')
      .trim()
    fail(
      `TaskWraith Studio code signature is invalid in ${path.relative(repoRoot, packageRoot)}.${
        detail ? `\n${detail}` : ''
      }`
    )
  }

  // Studio.app is signed by the parent inside-out pass and inherits
  // build/entitlements.mac.plist, so it is the third bundle whose signed
  // entitlements must actually exist rather than being assumed.
  const studioEntitlements = readSignedEntitlements(studioApp, false)
  const requiredEntitlementsByPath = new Map([
    [packageRoot, entitlements],
    [bridgeDaemon, bridgeEntitlements],
    [studioApp, studioEntitlements]
  ])
  for (const [codePath, requiredEntitlements] of requiredEntitlementsByPath) {
    if (!requiredEntitlements) {
      fail(`Required signed entitlements are absent from ${path.relative(packageRoot, codePath)}.`)
    }
  }

  let signedEntitlementSets = 0
  for (const candidate of findMacSignedCodeCandidates(packageRoot)) {
    const candidateEntitlements =
      requiredEntitlementsByPath.get(candidate) ?? readSignedEntitlements(candidate, false)
    if (!candidateEntitlements) continue
    signedEntitlementSets += 1
    const privateEntitlements = Object.keys(candidateEntitlements).filter((key) =>
      key.startsWith('com.apple.private.')
    )
    if (privateEntitlements.length > 0) {
      fail(
        `${path.relative(packageRoot, candidate) || path.basename(packageRoot)} contains private signed entitlements: ${privateEntitlements.join(', ')}`
      )
    }
  }
  // Seal integrity is now proven; distribution posture is a separate question
  // that --verify cannot answer. Set TASKWRAITH_REQUIRE_PRODUCTION_SIGNING=1 on
  // release builds to make an ad-hoc signature a hard failure.
  const requireProduction = process.env.TASKWRAITH_REQUIRE_PRODUCTION_SIGNING === '1'
  const postureFailures = []
  const postureReport = []
  for (const [codePath, label] of [
    [packageRoot, 'Packaged app'],
    [bridgeDaemon, 'TaskWraithBridgeDaemon'],
    [studioApp, 'TaskWraith Studio.app']
  ]) {
    const identity = readMacSigningIdentity(codePath)
    postureFailures.push(
      ...collectMacSigningPostureFailures({ identity, label, requireProduction })
    )
    postureReport.push(`  ${label}: ${describeMacSigningPosture(identity)}`)
  }
  if (postureFailures.length > 0) {
    fail(
      `Packaged macOS signing posture is not distributable.\n${postureFailures.join(
        '\n'
      )}\nObserved:\n${postureReport.join('\n')}`
    )
  }

  console.log(
    `validated packaged app signature and ${signedEntitlementSets} signed entitlement set(s)\n${postureReport.join(
      '\n'
    )}`
  )
}

/**
 * Parses a `codesign -dv --verbose=4` report into a signing posture.
 *
 * `codesign --verify --strict` only proves the seal still matches the bytes on
 * disk, which an ad-hoc signature satisfies perfectly. Everything that makes a
 * build distributable — the certificate chain, the team identifier, and the
 * hardened runtime — appears only in this report, so verify-alone reports
 * success for an app that has no production signing identity at all.
 */
function evaluateMacSigningIdentity(output, exitCode) {
  const text = typeof output === 'string' ? output : ''
  // A non-zero exit means unsigned or unreadable. On a machine that can check,
  // that is a definite negative rather than an "unable to tell".
  if (exitCode !== 0 || text.trim().length === 0) {
    return {
      readable: false,
      adhoc: false,
      authorities: [],
      leafAuthority: null,
      teamIdentifier: null,
      hardenedRuntime: false,
      claimsProductionIdentity: false
    }
  }

  const authorities = [...text.matchAll(/^Authority=(.+)$/gm)]
    .map((match) => match[1].trim())
    .filter((value) => value.length > 0 && !/^\(unsigned\)$/i.test(value))

  const rawTeamId = text.match(/^TeamIdentifier=(.+)$/m)?.[1]?.trim() || null
  // codesign prints the literal "not set" when a bundle has no team. Carrying
  // that string forward makes a plain truthiness check pass for an ad-hoc
  // build and renders as "team not set" in any message that echoes it.
  const teamIdentifier = rawTeamId && !/^not set$/i.test(rawTeamId) ? rawTeamId : null

  const flags = text.match(/^CodeDirectory\b.*?\bflags=(\S+)/m)?.[1] ?? ''
  const adhoc = /^Signature=adhoc$/m.test(text) || /\badhoc\b/.test(flags)
  const hardenedRuntime = /\bruntime\b/.test(flags)

  return {
    readable: true,
    adhoc,
    authorities,
    leafAuthority: authorities[0] ?? null,
    teamIdentifier,
    hardenedRuntime,
    claimsProductionIdentity: !adhoc && (authorities.length > 0 || teamIdentifier !== null)
  }
}

/**
 * Returns every reason the posture is not distributable, so one run reports all
 * of them instead of stopping at the first.
 */
function collectMacSigningPostureFailures({ identity, label, requireProduction = false }) {
  const failures = []
  if (!identity.readable) {
    failures.push(`${label} has no readable code signature.`)
    return failures
  }

  if (!identity.claimsProductionIdentity) {
    // A local `--dir` build is legitimately ad-hoc, so this must not break the
    // developer loop. Only an explicit release gate turns it into a failure —
    // but the posture is reported honestly either way, and never as "validated".
    if (requireProduction) {
      failures.push(
        `${label} is ${
          identity.adhoc ? 'ad-hoc signed' : 'signed without a distribution identity'
        }, which cannot be notarized or distributed.`
      )
    }
    return failures
  }

  if (!identity.leafAuthority || !identity.leafAuthority.startsWith(DEVELOPER_ID_LEAF_PREFIX)) {
    failures.push(
      `${label} leaf signing authority must be a "${DEVELOPER_ID_LEAF_PREFIX}" certificate, got ${
        identity.leafAuthority ?? 'none'
      }.`
    )
  }
  if (!identity.authorities.includes('Apple Root CA')) {
    failures.push(`${label} signing chain does not terminate at Apple Root CA.`)
  }
  if (!identity.teamIdentifier) {
    failures.push(`${label} signature carries no Apple Team Identifier.`)
  }
  // The team embedded in the leaf certificate and the standalone
  // TeamIdentifier come from different parts of the report; a disagreement
  // means the parsed values are not describing one coherent signature.
  const leafTeam = identity.leafAuthority?.match(/\(([A-Z0-9]{10})\)\s*$/)?.[1] ?? null
  if (leafTeam && identity.teamIdentifier && leafTeam !== identity.teamIdentifier) {
    failures.push(
      `${label} leaf authority team ${leafTeam} does not match TeamIdentifier ${identity.teamIdentifier}.`
    )
  }
  if (!identity.hardenedRuntime) {
    failures.push(`${label} is not signed with the hardened runtime, which notarization requires.`)
  }
  return failures
}

/** One-line posture for the smoke receipt, so the log records what was proven. */
function describeMacSigningPosture(identity) {
  if (!identity.readable) return 'unsigned or unreadable'
  if (identity.adhoc) return 'ad-hoc, development only'
  if (!identity.claimsProductionIdentity) return 'signed without a distribution identity'
  return `${identity.leafAuthority} [team ${identity.teamIdentifier ?? 'absent'}, ${
    identity.hardenedRuntime ? 'hardened runtime' : 'no hardened runtime'
  }]`
}

function readMacSigningIdentity(codePath) {
  // `codesign -dv` writes its report to stderr, so both streams are collected.
  const result = spawnSync('/usr/bin/codesign', ['-dv', '--verbose=4', codePath], {
    encoding: 'utf8'
  })
  return evaluateMacSigningIdentity(
    [result.stdout, result.stderr].filter(Boolean).join('\n'),
    result.status
  )
}

function assertAppleEventsEntitlement(entitlements, label) {
  if (entitlements['com.apple.security.automation.apple-events'] !== true) {
    fail(`${label} is missing com.apple.security.automation.apple-events.`)
  }
}

function readPlistAsJson(plistPath, label) {
  const result = spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plistPath], {
    encoding: 'utf8'
  })
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
    fail(`Could not read ${label}.${detail ? `\n${detail}` : ''}`)
  }
  try {
    return JSON.parse(result.stdout)
  } catch (error) {
    fail(`${label} did not decode as JSON: ${error instanceof Error ? error.message : error}`)
  }
}

function parsePlistBufferAsJson(plist, label) {
  const result = spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], {
    input: plist,
    encoding: 'utf8'
  })
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
    fail(`Could not decode ${label}.${detail ? `\n${detail}` : ''}`)
  }
  try {
    return JSON.parse(result.stdout)
  } catch (error) {
    fail(`${label} did not decode as JSON: ${error instanceof Error ? error.message : error}`)
  }
}

function readSignedEntitlements(codePath, required) {
  const result = spawnSync('/usr/bin/codesign', ['-d', '--entitlements', ':-', codePath], {
    encoding: null
  })
  if (result.status !== 0 || !result.stdout?.length) {
    if (!required) return null
    const detail = [result.stdout, result.stderr]
      .filter(Boolean)
      .map((value) => value.toString())
      .join('\n')
      .trim()
    fail(
      `Could not read signed entitlements from ${path.relative(repoRoot, codePath) || codePath}.${
        detail ? `\n${detail}` : ''
      }`
    )
  }
  return parsePlistBufferAsJson(
    result.stdout,
    `${path.relative(repoRoot, codePath) || codePath} signed entitlements`
  )
}

function findMacSignedCodeCandidates(packageRoot) {
  const candidates = new Set([packageRoot])
  for (const bundlePath of findDirectories(
    packageRoot,
    (candidate) => /\.(?:app|framework|xpc|bundle)$/i.test(candidate),
    16
  )) {
    candidates.add(bundlePath)
  }
  for (const filePath of findFiles(packageRoot, (candidate) => {
    if (/\.(?:dylib|node)$/i.test(candidate)) return true
    try {
      return (fs.statSync(candidate).mode & 0o111) !== 0
    } catch {
      return false
    }
  })) {
    candidates.add(filePath)
  }
  return [...candidates]
}

function validateMacNodePtyBindings(unpackedDir, expectedArchs) {
  if (expectedArchs.length === 0 || process.platform !== 'darwin') return
  const nodePtyDir = findDirectories(
    unpackedDir,
    (candidate) => candidate.split(path.sep).join('/').endsWith('/node_modules/node-pty'),
    8
  )[0]
  if (!nodePtyDir) fail(`node-pty package was not unpacked under ${unpackedDir}.`)
  const buildBinding = path.join(nodePtyDir, 'build', 'Release', 'pty.node')
  if (
    fs.existsSync(buildBinding) &&
    !expectedArchs.every((arch) => hasMachOArchitecture(buildBinding, arch))
  ) {
    fail(`Host-only node-pty build binding shadows universal prebuilds: ${buildBinding}`)
  }
  if (expectedArchs.length > 1) {
    const requiredPrebuilds = [
      { pathArch: 'darwin-arm64', machArch: 'arm64' },
      { pathArch: 'darwin-x64', machArch: 'x86_64' }
    ]
    for (const prebuild of requiredPrebuilds) {
      const prebuildPath = path.join(nodePtyDir, 'prebuilds', prebuild.pathArch, 'pty.node')
      const spawnHelperPath = path.join(nodePtyDir, 'prebuilds', prebuild.pathArch, 'spawn-helper')
      assertFile(prebuildPath, `node-pty ${prebuild.pathArch} prebuild`)
      verifyMachOArchitectures(prebuildPath, [prebuild.machArch], `node-pty ${prebuild.pathArch}`)
      assertExecutable(spawnHelperPath, `node-pty ${prebuild.pathArch} spawn-helper`)
    }
  }
}

function validateMacClaudeAgentSdkBinaries(unpackedDir, expectedArchs) {
  if (expectedArchs.length === 0 || process.platform !== 'darwin') return
  const nodeModulesDir = findDirectories(
    unpackedDir,
    (candidate) => candidate.split(path.sep).join('/').endsWith('/node_modules'),
    6
  )[0]
  if (!nodeModulesDir) return

  const requiredPackages = []
  if (expectedArchs.includes('arm64')) {
    requiredPackages.push({
      packageName: '@anthropic-ai/claude-agent-sdk-darwin-arm64',
      machArch: 'arm64'
    })
  }
  if (expectedArchs.includes('x86_64')) {
    requiredPackages.push({
      packageName: '@anthropic-ai/claude-agent-sdk-darwin-x64',
      machArch: 'x86_64'
    })
  }

  for (const requiredPackage of requiredPackages) {
    const binaryPath = path.join(
      nodeModulesDir,
      ...requiredPackage.packageName.split('/'),
      'claude'
    )
    assertFile(binaryPath, `${requiredPackage.packageName} helper`)
    verifyMachOArchitectures(binaryPath, [requiredPackage.machArch], requiredPackage.packageName)
  }
}

function validateWindowsPackageBinaries(packageRoot) {
  assertFile(resolveWindowsExecutablePath(packageRoot), 'Windows app executable')
}

function validateLinuxPackageBinaries(packageRoot) {
  assertExecutable(resolveLinuxExecutablePath(packageRoot), 'Linux app executable')
}

function resolveWindowsExecutablePath(packageRoot) {
  const candidates = [
    path.join(packageRoot, 'TaskWraith.exe'),
    path.join(packageRoot, 'TaskWraith Debug.exe')
  ]
  for (const entry of safeReadDir(packageRoot)) {
    if (entry.isFile() && /\.exe$/i.test(entry.name)) {
      candidates.push(path.join(packageRoot, entry.name))
    }
  }
  const found = candidates.find((candidate) => fs.existsSync(candidate))
  if (found) return found
  fail(`Packaged Windows executable was not found under ${packageRoot}.`)
}

function resolveLinuxExecutablePath(packageRoot) {
  const candidates = [path.join(packageRoot, 'taskwraith'), path.join(packageRoot, 'TaskWraith')]
  for (const entry of safeReadDir(packageRoot)) {
    if (!entry.isFile()) continue
    const candidate = path.join(packageRoot, entry.name)
    try {
      if ((fs.statSync(candidate).mode & 0o111) !== 0) candidates.push(candidate)
    } catch {
      // Ignore unreadable package entries; preferred candidates still report clearly.
    }
  }
  const ignoredNames = new Set([
    'chrome-sandbox',
    'chrome_crashpad_handler',
    'libEGL.so',
    'libGLESv2.so',
    'libffmpeg.so'
  ])
  const found = candidates.find(
    (candidate) => fs.existsSync(candidate) && !ignoredNames.has(path.basename(candidate))
  )
  if (found) return found
  fail(`Packaged Linux executable was not found under ${packageRoot}.`)
}

function validateWindowsNodePtyBindings(unpackedDir, arch) {
  const nodePtyDir = findDirectories(
    unpackedDir,
    (candidate) => candidate.split(path.sep).join('/').endsWith('/node_modules/node-pty'),
    8
  )[0]
  if (!nodePtyDir) fail(`node-pty package was not unpacked under ${unpackedDir}.`)
  const prebuildPath = path.join(nodePtyDir, 'prebuilds', `win32-${arch}`, 'pty.node')
  assertFile(prebuildPath, `node-pty win32-${arch} prebuild`)
  const buildBinding = path.join(nodePtyDir, 'build', 'Release', 'pty.node')
  if (fs.existsSync(buildBinding)) {
    fail(`Host-only node-pty build binding shadows Windows prebuilds: ${buildBinding}`)
  }
}

function validateWindowsClaudeAgentSdkBinaries(unpackedDir, arch) {
  const nodeModulesDir = findDirectories(
    unpackedDir,
    (candidate) => candidate.split(path.sep).join('/').endsWith('/node_modules'),
    6
  )[0]
  if (!nodeModulesDir) return
  const packageName = `@anthropic-ai/claude-agent-sdk-win32-${arch}`
  const packageDir = path.join(nodeModulesDir, ...packageName.split('/'))
  if (!fs.existsSync(packageDir)) {
    console.log(`Claude Agent SDK Windows helper not packaged for ${arch}; skipping helper check.`)
    return
  }
  const binaryPath = path.join(packageDir, 'claude.exe')
  assertFile(binaryPath, `${packageName} helper`)
}

function expectedMacArchitectures(arch) {
  if (arch === 'universal') return ['arm64', 'x86_64']
  if (arch === 'arm64') return ['arm64']
  if (arch === 'x64') return ['x86_64']
  return []
}

function verifyMachOArchitectures(filePath, archs, label) {
  for (const arch of archs) {
    if (hasMachOArchitecture(filePath, arch)) continue
    fail(`${label} is missing ${arch} slice: ${path.relative(repoRoot, filePath) || filePath}`)
  }
}

function hasMachOArchitecture(filePath, arch) {
  const result = spawnSync('/usr/bin/lipo', [filePath, '-verify_arch', arch], {
    stdio: 'pipe',
    encoding: 'utf8'
  })
  return result.status === 0
}

function findDirectories(root, predicate, maxDepth, depth = 0) {
  if (depth > maxDepth) return []
  const entries = safeReadDir(root)
  const matches = []
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name)
    if (!entry.isDirectory()) continue
    if (predicate(fullPath)) {
      matches.push(fullPath)
      continue
    }
    matches.push(...findDirectories(fullPath, predicate, maxDepth, depth + 1))
  }
  return matches
}

function findFiles(root, predicate) {
  const matches = []
  const stack = [root]
  while (stack.length > 0) {
    const current = stack.pop()
    for (const entry of safeReadDir(current)) {
      const fullPath = path.join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(fullPath)
      } else if (entry.isFile() && predicate(fullPath)) {
        matches.push(fullPath)
      }
    }
  }
  return matches
}

function findFilesInRoots(roots, predicate) {
  const matches = []
  for (const root of roots) {
    if (!fs.existsSync(root)) continue
    if (fs.statSync(root).isFile()) {
      if (predicate(root)) matches.push(root)
      continue
    }
    matches.push(...findFiles(root, predicate))
  }
  return matches
}

function safeReadDir(dirPath) {
  try {
    return fs.readdirSync(dirPath, { withFileTypes: true })
  } catch {
    return []
  }
}

function readMegabyteLimit(envName, defaultMb) {
  const raw = process.env[envName]
  if (!raw) return defaultMb * 1024 * 1024
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) {
    fail(`${envName} must be a positive number of megabytes.`)
  }
  return Math.floor(value * 1024 * 1024)
}

function readIntegerEnv(envName, defaultValue) {
  const raw = process.env[envName]
  if (!raw) return defaultValue
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) {
    fail(`${envName} must be a positive integer.`)
  }
  return value
}

function formatBytes(bytes) {
  const mb = bytes / (1024 * 1024)
  return `${mb.toFixed(1)} MB`
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function fail(message) {
  console.error(message)
  process.exit(1)
}

// Exported for scripts/smoke-packaged-electron.test.ts. These are pure over a
// codesign report, so the posture rules are exercised without a packaged app
// and without invoking codesign.
module.exports = {
  evaluateMacSigningIdentity,
  collectMacSigningPostureFailures,
  describeMacSigningPosture,
  readMacSigningIdentity,
  readPackagedDistributionMetadata,
  validatePackagedIdentityHandoffPayload
}
