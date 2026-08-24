#!/usr/bin/env node

/**
 * smoke-packaged-tui.cjs — Developer Preview packaging checks for the tw sidecar.
 *
 * Two layers:
 *   1. Layout (always): launchers present under build/tui-launcher, electron-builder
 *      ships out/tui + tui-runtime outside app.asar via extraResources, package.json
 *      bins/scripts, prepare:tui-runtime wired, RunAsNode remains fused off.
 *   2. Packaged (when a package root is found under dist/dist-debug or argv[2]):
 *      - tui/tui/cli.js exists under Resources (outside app.asar)
 *      - bin/tw (+ taskwraith, Windows siblings) exist
 *      - tui-runtime/<platform>-<arch>/node[.exe] exists
 *      - launcher can print --help / --version via the bundled Node runtime
 *        (NOT ELECTRON_RUN_AS_NODE — FuseV1 RunAsNode is disabled)
 *      - direct production Host child + authenticated `tw --snapshot --no-start-host`
 *        against a disposable profile. Help smoke never starts an App GUI.
 *
 * Usage:
 *   node scripts/smoke-packaged-tui.cjs              # layout + package if present
 *   node scripts/smoke-packaged-tui.cjs dist         # layout + specific package tree
 *   node scripts/smoke-packaged-tui.cjs --layout-only
 *   TASKWRAITH_TUI_REQUIRE_PACKAGE=1 node scripts/smoke-packaged-tui.cjs
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { createWindowsCmdInvocation } = require('./windows-cmd-invocation.cjs')
const { assertNodeRuntimeLicense } = require('./node-runtime-license.cjs')

const repoRoot = process.cwd()
const argv = process.argv.slice(2)
const layoutOnly = argv.includes('--layout-only')
const pathArgs = argv.filter((arg) => arg !== '--layout-only')
const searchArg = pathArgs[0]
const searchRoots = searchArg
  ? [path.resolve(repoRoot, searchArg)]
  : ['dist', 'dist-debug'].map((dir) => path.join(repoRoot, dir))
const requirePackage = process.env.TASKWRAITH_TUI_REQUIRE_PACKAGE === '1'
const helpTimeoutMs = readIntegerEnv('TASKWRAITH_TUI_SMOKE_TIMEOUT_MS', 15000)
const liveTimeoutMs = readIntegerEnv('TASKWRAITH_TUI_LIVE_SMOKE_TIMEOUT_MS', 40000)

main().catch((error) => {
  const message =
    error instanceof Error
      ? error.name === 'SmokeFailure'
        ? error.message
        : error.stack || error.message
      : String(error)
  console.error(message)
  process.exit(1)
})

async function main() {
  validateSourceLayout()
  if (layoutOnly) {
    console.log('packaged TUI layout smoke ok (layout-only)')
    return
  }

  const packageRoot = findPackagedApp(searchRoots)
  if (!packageRoot) {
    if (requirePackage) {
      fail(
        `No packaged Electron app was found under ${searchRoots.join(', ')}. ` +
          'Build a package first (e.g. npm run build:unpack) or pass --layout-only.'
      )
    }
    console.log(
      `packaged TUI package checks skipped: no app under ${searchRoots.join(', ')} ` +
        '(layout checks passed; set TASKWRAITH_TUI_REQUIRE_PACKAGE=1 to fail closed)'
    )
    return
  }

  await validatePackagedTui(packageRoot)
  console.log(`packaged TUI smoke ok: ${path.relative(repoRoot, packageRoot) || packageRoot}`)
}

function validateSourceLayout() {
  const launcherDir = path.join(repoRoot, 'build/tui-launcher')
  assertDir(launcherDir, 'build/tui-launcher')

  const requiredLaunchers = [
    'tw',
    'taskwraith',
    'tw.cmd',
    'taskwraith.cmd',
    'tw.ps1',
    'taskwraith.ps1'
  ]
  for (const name of requiredLaunchers) {
    assertFile(path.join(launcherDir, name), `launcher ${name}`)
  }

  // POSIX launchers must be executable in the source tree so electron-builder
  // preserves the bit into the package on macOS/Linux.
  if (process.platform !== 'win32') {
    for (const name of ['tw', 'taskwraith']) {
      assertExecutable(path.join(launcherDir, name), `launcher ${name}`)
    }
  }

  // Launchers must NOT depend on ELECTRON_RUN_AS_NODE for the packaged path.
  for (const name of ['tw', 'taskwraith', 'tw.cmd', 'taskwraith.cmd', 'tw.ps1', 'taskwraith.ps1']) {
    const body = fs.readFileSync(path.join(launcherDir, name), 'utf8')
    if (
      /export ELECTRON_RUN_AS_NODE=1|set "ELECTRON_RUN_AS_NODE=1"|\$env:ELECTRON_RUN_AS_NODE\s*=/.test(
        body
      )
    ) {
      fail(
        `launcher ${name} must not set ELECTRON_RUN_AS_NODE=1 ` +
          '(RunAsNode fuse is disabled; use tui-runtime Node instead)'
      )
    }
    if (!/tui-runtime/.test(body)) {
      fail(`launcher ${name} must resolve the packaged tui-runtime Node binary`)
    }
  }

  const ymlPath = path.join(repoRoot, 'electron-builder.yml')
  assertFile(ymlPath, 'electron-builder.yml')
  const yml = fs.readFileSync(ymlPath, 'utf8')
  if (!yml.includes('from: out/tui') || !yml.includes('to: tui')) {
    fail('electron-builder.yml must ship out/tui as extraResources → tui')
  }
  if (!yml.includes('from: build/tui-launcher') || !yml.includes('to: bin')) {
    fail('electron-builder.yml must ship build/tui-launcher as extraResources → bin')
  }
  if (!yml.includes('from: build/tui-runtime') || !yml.includes('to: tui-runtime')) {
    fail('electron-builder.yml must ship build/tui-runtime as extraResources → tui-runtime')
  }
  if (!yml.includes('!out/tui/**')) {
    fail('electron-builder.yml must exclude out/tui/** from app.asar files')
  }
  if (!yml.includes('!build/tui-runtime/**')) {
    fail('electron-builder.yml must exclude build/tui-runtime/** from app.asar files')
  }

  // Security invariant: afterPack still hardens RunAsNode=false.
  const fusePath = path.join(repoRoot, 'build/validate-native-modules.cjs')
  assertFile(fusePath, 'build/validate-native-modules.cjs')
  const fuseSrc = fs.readFileSync(fusePath, 'utf8')
  if (!/FuseV1Options\.RunAsNode\]:\s*false/.test(fuseSrc)) {
    fail(
      'build/validate-native-modules.cjs must keep FuseV1Options.RunAsNode=false ' +
        '(do not re-enable RunAsNode for the TUI; use tui-runtime instead)'
    )
  }

  const packageJsonPath = path.join(repoRoot, 'package.json')
  assertFile(packageJsonPath, 'package.json')
  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'))
  if (pkg.bin?.tw !== './out/tui/tui/cli.js' || pkg.bin?.taskwraith !== './out/tui/tui/cli.js') {
    fail('package.json#bin must point tw/taskwraith at ./out/tui/tui/cli.js for dev/npm link')
  }
  if (!pkg.scripts?.['tui:build'] || !pkg.scripts?.['smoke:tui-package']) {
    fail('package.json must define tui:build and smoke:tui-package scripts')
  }
  const tuiBuild = pkg.scripts['tui:build']
  const cleanTuiOutputCommand = 'node scripts/clean-tui-output.cjs'
  const tuiCompilerCommand = 'tsc -p src/tui/tsconfig.json'
  if (
    !tuiBuild.includes(cleanTuiOutputCommand) ||
    !tuiBuild.includes(tuiCompilerCommand) ||
    tuiBuild.indexOf(cleanTuiOutputCommand) > tuiBuild.indexOf(tuiCompilerCommand)
  ) {
    fail('package.json#scripts.tui:build must clear generated out/tui before compiling')
  }
  if (!pkg.scripts?.['prepare:tui-runtime'] || !pkg.scripts?.['prepare:tui-runtime:mac']) {
    fail('package.json must define prepare:tui-runtime and prepare:tui-runtime:mac')
  }
  if (!pkg.scripts?.['prepare:tui-runtime:win']?.includes('--targets=win32-x64,win32-arm64')) {
    fail('package.json must prepare both win32-x64 and win32-arm64 TUI runtimes')
  }
  for (const scriptName of ['build:win:compile', 'build:win:unpack']) {
    if (!pkg.scripts?.[scriptName]?.includes('prepare:tui-runtime:win')) {
      fail(`package.json#scripts.${scriptName} must use prepare:tui-runtime:win`)
    }
  }

  assertFile(
    path.join(repoRoot, 'scripts/prepare-tui-runtime.cjs'),
    'scripts/prepare-tui-runtime.cjs'
  )
  assertFile(path.join(repoRoot, 'scripts/clean-tui-output.cjs'), 'scripts/clean-tui-output.cjs')
  assertFile(path.join(repoRoot, 'build/tui-runtime/README.md'), 'build/tui-runtime/README.md')

  // Compiled payload is required before packaging; warn-only if missing so a
  // pure-layout check can still run on a clean tree after tui:build.
  const compiledTuiRoot = path.join(repoRoot, 'out/tui')
  const cliJs = path.join(compiledTuiRoot, 'tui', 'cli.js')
  if (!fs.existsSync(cliJs)) {
    console.log('note: out/tui/tui/cli.js missing — run npm run tui:build before electron-builder')
  } else {
    assertTuiPayloadBoundary(compiledTuiRoot, 'compiled TUI payload')
  }

  // Runtime binaries are prepared on demand; warn-only when absent at layout time.
  const runtimeMeta = path.join(repoRoot, 'build/tui-runtime/RUNTIME.json')
  if (!fs.existsSync(runtimeMeta)) {
    console.log(
      'note: build/tui-runtime not prepared — run npm run prepare:tui-runtime before electron-builder'
    )
  } else {
    assertFile(runtimeMeta, 'prepared TUI runtime metadata')
  }

  console.log('packaged TUI source layout ok')
}

async function validatePackagedTui(packageRoot) {
  const resourcesDir = resolveResourcesDir(packageRoot)
  const appAsarPath = path.join(resourcesDir, 'app.asar')
  assertDir(resourcesDir, 'Electron resources directory')
  assertFile(appAsarPath, 'packaged app.asar')

  const packagedTuiRoot = path.join(resourcesDir, 'tui')
  const cliJs = path.join(packagedTuiRoot, 'tui', 'cli.js')
  assertTuiPayloadBoundary(packagedTuiRoot, 'packaged TUI payload')

  // Hard invariant: the TUI must not only live inside the asar.
  if (!cliJs.startsWith(resourcesDir) || cliJs.includes(`${path.sep}app.asar${path.sep}`)) {
    fail(`packaged TUI entry must live outside app.asar: ${cliJs}`)
  }

  const binDir = path.join(resourcesDir, 'bin')
  assertDir(binDir, 'packaged bin/ launcher directory')

  const packageTarget = inferPackageTarget(packageRoot)
  if (packageTarget.platform === 'win32') {
    assertFile(path.join(binDir, 'tw.cmd'), 'packaged tw.cmd')
    assertFile(path.join(binDir, 'taskwraith.cmd'), 'packaged taskwraith.cmd')
  } else {
    assertExecutable(path.join(binDir, 'tw'), 'packaged tw launcher')
    assertExecutable(path.join(binDir, 'taskwraith'), 'packaged taskwraith launcher')
  }

  const nodeBin = resolvePackagedNodeRuntime(resourcesDir, packageTarget)
  assertExecutable(nodeBin, 'packaged TUI Node runtime')

  // Structural help smoke via bundled Node runtime — no system Node, no App,
  // no ELECTRON_RUN_AS_NODE.
  runBundledTuiHelp(nodeBin, cliJs, packageRoot, packageTarget)
  await runLiveControlRoundTrip(packageRoot, packageTarget)
}

function resolvePackagedNodeRuntime(resourcesDir, packageTarget) {
  const runtimeRoot = path.join(resourcesDir, 'tui-runtime')
  assertDir(runtimeRoot, 'packaged tui-runtime directory')

  const binaryName = packageTarget.platform === 'win32' ? 'node.exe' : 'node'
  if (packageTarget.arch === 'universal') {
    const universalRuntimes = ['arm64', 'x64'].map((arch) =>
      path.join(runtimeRoot, `${packageTarget.platform}-${arch}`, binaryName)
    )
    for (const runtime of universalRuntimes) {
      assertExecutable(
        runtime,
        `packaged universal TUI Node runtime ${path.basename(path.dirname(runtime))}`
      )
      assertNodeRuntimeLicense(path.dirname(runtime))
    }
    return universalRuntimes[process.arch === 'arm64' ? 0 : 1]
  }

  const exactRuntime = path.join(
    runtimeRoot,
    `${packageTarget.platform}-${packageTarget.arch}`,
    binaryName
  )
  assertExecutable(
    exactRuntime,
    `packaged TUI Node runtime ${packageTarget.platform}-${packageTarget.arch}`
  )
  assertNodeRuntimeLicense(path.dirname(exactRuntime))
  return exactRuntime
}

function runBundledTuiHelp(nodeBin, cliJs, packageRoot, packageTarget) {
  if (process.env.TASKWRAITH_SKIP_TUI_HELP_SMOKE === '1') {
    console.log('packaged TUI help smoke skipped via TASKWRAITH_SKIP_TUI_HELP_SMOKE=1')
    return
  }

  // Prefer invoking the real launcher when host can exec the package arch —
  // that is the user-facing path under Resources/bin/tw.
  const launcher = resolvePackagedLauncher(packageRoot, packageTarget)
  if (launcher && canLikelyExecPackage(packageTarget)) {
    const launcherResult = spawnPackagedLauncherSync(launcher, ['--help'], packageTarget, {
      encoding: 'utf8',
      timeout: helpTimeoutMs,
      env: {
        ...process.env,
        // Explicitly prove we do not need / use RunAsNode.
        ELECTRON_RUN_AS_NODE: ''
      }
    })
    if (launcherResult.error) {
      if (
        launcherResult.error.code === 'UNKNOWN' ||
        /bad CPU|Exec format|UNKNOWN/i.test(launcherResult.error.message)
      ) {
        console.log(
          `packaged TUI launcher help smoke skipped: cannot exec ${launcher} on this host (${launcherResult.error.message})`
        )
      } else {
        fail(`packaged TUI launcher --help failed to spawn: ${launcherResult.error.message}`)
      }
    } else if (launcherResult.status !== 0) {
      const detail = [launcherResult.stdout, launcherResult.stderr]
        .filter(Boolean)
        .join('\n')
        .trim()
      // Detect the old broken path: App single-instance lock means launcher still
      // hits the Electron binary without RunAsNode.
      if (/another TaskWraith instance holds the lock/i.test(detail)) {
        fail(
          'packaged TUI launcher still starts the App (single-instance lock). ' +
            'It must exec tui-runtime Node, not the Electron binary.\n' +
            detail
        )
      }
      fail(
        `packaged TUI launcher --help exited ${launcherResult.status}${
          detail ? `:\n${detail}` : ''
        }`
      )
    } else {
      const out = `${launcherResult.stdout || ''}${launcherResult.stderr || ''}`
      if (!/TaskWraith TUI/i.test(out) && !/--snapshot/.test(out)) {
        fail(
          `packaged TUI launcher --help output missing expected usage text:\n${out.slice(0, 500)}`
        )
      }
      console.log('packaged TUI help smoke ok (launcher → tui-runtime Node + --help)')
      return
    }
  }

  // Direct runtime smoke (also used when launcher path skipped for arch mismatch).
  const result = spawnSync(nodeBin, [cliJs, '--help'], {
    encoding: 'utf8',
    timeout: helpTimeoutMs,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: ''
    }
  })

  if (result.error) {
    if (
      result.error.code === 'UNKNOWN' ||
      /bad CPU|Exec format|UNKNOWN/i.test(result.error.message)
    ) {
      console.log(
        `packaged TUI help smoke skipped: cannot exec ${nodeBin} on this host (${result.error.message})`
      )
      return
    }
    fail(`packaged TUI help smoke failed to spawn: ${result.error.message}`)
  }

  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
    fail(`packaged TUI --help exited ${result.status}${detail ? `:\n${detail}` : ''}`)
  }

  const out = `${result.stdout || ''}${result.stderr || ''}`
  if (!/TaskWraith TUI/i.test(out) && !/--snapshot/.test(out)) {
    fail(`packaged TUI --help output missing expected usage text:\n${out.slice(0, 500)}`)
  }

  console.log('packaged TUI help smoke ok (tui-runtime Node + --help)')
}

function spawnPackagedLauncherSync(launcher, args, packageTarget, options) {
  if (packageTarget.platform !== 'win32') {
    return spawnSync(launcher, args, options)
  }
  const invocation = createWindowsCmdInvocation(launcher, args)
  return spawnSync(invocation.command, invocation.arguments, {
    ...options,
    windowsHide: true,
    shell: false,
    ...invocation.spawnOptions
  })
}

function resolvePackagedLauncher(packageRoot, packageTarget) {
  const resourcesDir = resolveResourcesDir(packageRoot)
  const binDir = path.join(resourcesDir, 'bin')
  if (packageTarget.platform === 'win32') {
    const cmd = path.join(binDir, 'tw.cmd')
    return fs.existsSync(cmd) ? cmd : null
  }
  const tw = path.join(binDir, 'tw')
  return fs.existsSync(tw) ? tw : null
}

function canLikelyExecPackage(packageTarget) {
  if (packageTarget.platform !== process.platform) return false
  if (packageTarget.arch === 'universal') return true
  const hostArch = process.arch === 'arm64' ? 'arm64' : 'x64'
  return packageTarget.arch === hostArch
}

async function runLiveControlRoundTrip(packageRoot, packageTarget) {
  if (process.env.TASKWRAITH_SKIP_TUI_LIVE_SMOKE === '1') {
    console.log('packaged TUI live control smoke skipped via TASKWRAITH_SKIP_TUI_LIVE_SMOKE=1')
    return
  }
  if (!canLikelyExecPackage(packageTarget)) {
    fail(`packaged TUI live control smoke cannot execute ${packageTarget.platform}-${packageTarget.arch} on ${process.platform}-${process.arch}`)
  }
  const resourcesDir = resolveResourcesDir(packageRoot)
  const launcher = resolvePackagedLauncher(packageRoot, packageTarget)
  const hostLauncher = resolvePackagedHostLauncher(resourcesDir, packageTarget)
  if (!launcher || !hostLauncher) fail('packaged TUI/production Host launcher is missing')
  const userDataPath = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-tui-package-smoke-'))
  )
  const museBinary = path.join(userDataPath, 'muse')
  const discoveryPath = path.join(userDataPath, 'taskwraith-host-v2.json')
  const tokenPath = path.join(userDataPath, 'taskwraith-host-v2.token')
  if (packageTarget.platform !== 'win32') {
    fs.writeFileSync(museBinary, '#!/bin/sh\nexit 0\n')
    fs.chmodSync(museBinary, 0o700)
  }
  const hostArgs = [
    '--profile',
    userDataPath,
    ...(packageTarget.platform === 'win32' ? [] : ['--muse-binary', museBinary])
  ]
  const spawned = spawnPackagedLauncher(hostLauncher, hostArgs, packageTarget, {
    cwd: resourcesDir,
    env: { ...process.env, META_API_KEY: 'packaged-tui-smoke-key', ELECTRON_RUN_AS_NODE: '' },
    stdio: 'ignore',
    detached: false
  })
  let discovery = null
  try {
    await waitForFiles([discoveryPath, tokenPath], liveTimeoutMs, 'packaged production Host readiness')
    discovery = JSON.parse(fs.readFileSync(discoveryPath, 'utf8'))
    const snapshot = spawnPackagedLauncherSync(
      launcher,
      ['--snapshot', '--no-start-host', '--user-data', userDataPath, '--no-color', '--ascii', '--width', '80', '--height', '24'],
      packageTarget,
      { cwd: packageRoot, encoding: 'utf8', timeout: liveTimeoutMs, windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } }
    )
    if (snapshot.error || snapshot.status !== 0) fail(`packaged tw snapshot against direct Host failed: ${snapshot.error?.message || snapshot.stderr || snapshot.status}`)
    assertOwnerOnlyFile(discoveryPath, 'control discovery')
    assertOwnerOnlyFile(tokenPath, 'control token')
  } finally {
    try {
      const graceful = spawnPackagedLauncherSync(
        hostLauncher,
        ['stop', '--profile', userDataPath],
        packageTarget,
        {
          cwd: resourcesDir,
          encoding: 'utf8',
          timeout: 10_000,
          windowsHide: true,
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '' }
        }
      )
      if (
        graceful.status !== 0 &&
        spawned.exitCode === null &&
        spawned.signalCode === null
      ) {
        spawned.kill('SIGTERM')
      }
      await waitForChildExit(spawned, 10_000)
      if (graceful.status !== 0) {
        fail(`packaged authenticated Host stop failed: ${graceful.stderr || graceful.status}`)
      }
      if (spawned.exitCode !== 0) {
        fail(`direct packaged Host exited ${String(spawned.exitCode)} after graceful stop`)
      }
      if (
        fs.existsSync(discoveryPath) ||
        fs.existsSync(tokenPath) ||
        (discovery?.socketPath && fs.existsSync(discovery.socketPath)) ||
        fs.existsSync(path.join(userDataPath, 'taskwraith-host-authority-v1.json'))
      ) {
        fail('direct packaged Host did not clean control artifacts/lease')
      }
      if (!fs.existsSync(path.join(userDataPath, 'host-runtime', 'host-install-identity.json'))) {
        fail('direct packaged Host did not retain identity')
      }
    } finally {
      removeSmokeTree(userDataPath)
    }
  }
  console.log('packaged TUI live control smoke ok (direct production Host + packaged tw --no-start-host)')
}

function resolvePackagedHostLauncher(resourcesDir, packageTarget) {
  const root = path.join(resourcesDir, 'host-bin')
  return packageTarget.platform === 'win32' ? path.join(root, 'taskwraith-host.cmd') : path.join(root, 'taskwraith-host')
}

function spawnPackagedLauncher(launcher, args, packageTarget, options) {
  if (packageTarget.platform !== 'win32') return require('node:child_process').spawn(launcher, args, options)
  const invocation = createWindowsCmdInvocation(launcher, args)
  return require('node:child_process').spawn(invocation.command, invocation.arguments, { ...options, shell: false, ...invocation.spawnOptions })
}

function waitForFiles(files, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs
    const timer = setInterval(() => {
      if (files.every((file) => fs.existsSync(file))) { clearInterval(timer); resolve() }
      else if (Date.now() >= deadline) { clearInterval(timer); reject(new Error(`timed out waiting for ${label}`)) }
    }, 50)
  })
}

function waitForChildExit(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null) return resolve()
    const timer = setTimeout(() => reject(new Error('direct packaged Host did not exit')), timeoutMs)
    child.once('exit', () => { clearTimeout(timer); resolve() })
  })
}


function removeSmokeTree(targetPath) {
  // Windows can briefly retain child-process profile files after shutdown.
  fs.rmSync(targetPath, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100
  })
}

/**
 * Resolve a relative emitted-module path without escaping the packaged payload.
 */
function isPathWithin(parentPath, candidatePath) {
  const relation = path.relative(parentPath, candidatePath)
  return (
    relation === '' ||
    (relation !== '..' && !relation.startsWith(`..${path.sep}`) && !path.isAbsolute(relation))
  )
}

function compiledModuleSpecifiers(source) {
  const specifiers = []
  const pattern =
    /(?:\b(?:require|import)\s*\(\s*(['"])([^'"]+)\1\s*\)|\b(?:from|import)\s+(['"])([^'"]+)\3)/g
  let match
  while ((match = pattern.exec(source))) {
    specifiers.push(match[2] || match[4])
  }
  return specifiers
}

function compiledJavaScriptFiles(root) {
  const files = []
  const walk = (directory) => {
    for (const entry of safeReadDir(directory)) {
      const entryPath = path.join(directory, entry.name)
      if (entry.isDirectory()) walk(entryPath)
      else if (entry.isFile() && entry.name.endsWith('.js')) files.push(entryPath)
    }
  }
  walk(root)
  return files
}

/**
 * The standalone `tw` payload may contain shared protocol and Host-client
 * code, but never Electron-main modules. A stale `main/**` directory would be
 * copied by electron-builder's `out/tui` extraResource filter even if no live
 * TUI source imports it, so inspect both the tree and emitted JS specifiers.
 */
function assertTuiPayloadBoundary(tuiRoot, label) {
  assertDir(tuiRoot, label)
  const mainRoot = path.join(tuiRoot, 'main')
  if (fs.existsSync(mainRoot)) {
    fail(`${label} must not contain an emitted main subtree: ${mainRoot}`)
  }

  for (const [segments, requiredLabel] of [
    [['tui', 'cli.js'], 'TUI entry'],
    [['tui', 'hostProcessManager.js'], 'TUI Host process manager'],
    [['host-client', 'HostProjectionClient.js'], 'Host projection client'],
    [['host-shared', 'HostCommandIdentity.js'], 'Host command identity'],
    [['host-shared', 'twmission', 'index.js'], 'TwMission codec surface']
  ]) {
    assertFile(path.join(tuiRoot, ...segments), `${label} ${requiredLabel}`)
  }

  for (const filePath of compiledJavaScriptFiles(tuiRoot)) {
    const source = fs.readFileSync(filePath, 'utf8')
    for (const specifier of compiledModuleSpecifiers(source)) {
      if (!specifier.startsWith('.')) continue
      const resolved = path.resolve(path.dirname(filePath), specifier)
      if (isPathWithin(mainRoot, resolved)) {
        fail(
          `${label} must not resolve a production require/import into main: ` +
            `${path.relative(tuiRoot, filePath)} -> ${specifier}`
        )
      }
    }
  }
}

function readIntegerEnv(name, fallback) {
  const raw = process.env[name]
  if (raw == null || raw === '') return fallback
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return n
}

function fail(message) {
  // main().catch prints and exits non-zero for direct Host smoke failures.
  const error = new Error(message)
  error.name = 'SmokeFailure'
  throw error
}

function assertFile(filePath, label) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) fail(`Missing ${label}: ${filePath}`)
}

function assertExecutable(filePath, label) {
  assertFile(filePath, label)
  if (process.platform !== 'win32') {
    try { fs.accessSync(filePath, fs.constants.X_OK) } catch { fail(`${label} is not executable: ${filePath}`) }
  }
}

function assertDir(dirPath, label) {
  if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) fail(`Missing ${label}: ${dirPath}`)
}

function safeReadDir(dirPath) {
  try { return fs.readdirSync(dirPath, { withFileTypes: true }) } catch { return [] }
}

function findPackagedApp(roots) {
  for (const root of roots) {
    if (isPackagedRoot(root)) return root
    const found = findDirectories(root, 5).find(isPackagedRoot)
    if (found) return found
  }
  return null
}

function isPackagedRoot(candidate) {
  return (
    fs.existsSync(path.join(candidate, 'resources', 'app.asar')) ||
    fs.existsSync(path.join(candidate, 'Contents', 'Resources', 'app.asar'))
  )
}

function findDirectories(root, maxDepth) {
  const results = []
  const walk = (directory, depth) => {
    if (depth > maxDepth) return
    for (const entry of safeReadDir(directory)) {
      if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name === '.git') continue
      const next = path.join(directory, entry.name)
      results.push(next)
      walk(next, depth + 1)
    }
  }
  walk(root, 0)
  return results
}

function resolveResourcesDir(packageRoot) {
  return packageRoot.endsWith('.app')
    ? path.join(packageRoot, 'Contents', 'Resources')
    : path.join(packageRoot, 'resources')
}

function assertOwnerOnlyFile(filePath, label) {
  const stat = fs.statSync(filePath)
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    fail(`${label} is not owner-only: ${filePath}`)
  }
}

function inferPackageTarget(packageRoot) {
  const name = path.basename(packageRoot).toLowerCase()
  if (packageRoot.endsWith('.app')) {
    const parent = path.basename(path.dirname(packageRoot)).toLowerCase()
    if (parent.includes('arm64')) return { platform: 'darwin', arch: 'arm64' }
    if (parent.includes('x64') || parent.includes('x86_64')) return { platform: 'darwin', arch: 'x64' }
    return { platform: 'darwin', arch: 'universal' }
  }
  if (name.includes('win')) return { platform: 'win32', arch: name.includes('arm64') ? 'arm64' : 'x64' }
  const parent = path.basename(path.dirname(packageRoot)).toLowerCase()
  const identity = `${name}-${parent}`
  if (/arm64|aarch64/.test(identity)) return { platform: 'linux', arch: 'arm64' }
  if (/x64|x86_64/.test(identity)) return { platform: 'linux', arch: 'x64' }
  return { platform: 'linux', arch: process.arch === 'arm64' ? 'arm64' : 'x64' }
}
