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
 *      - live control smoke (packaged-host-first, running-host fallback):
 *          a) try a disposable packaged App + authenticated `tw --snapshot`
 *          b) on macOS LaunchServices / second-GUI registration aborts (or when
 *             TASKWRAITH_TUI_SKIP_PACKAGED_HOST=1), use the already-running
 *             authoritative host's userData with the packaged launcher only
 *          c) TASKWRAITH_TUI_REQUIRE_PACKAGED_HOST=1 fails closed without (b)
 *        Help smoke never starts the App GUI.
 *
 * Usage:
 *   node scripts/smoke-packaged-tui.cjs              # layout + package if present
 *   node scripts/smoke-packaged-tui.cjs dist         # layout + specific package tree
 *   node scripts/smoke-packaged-tui.cjs --layout-only
 *   TASKWRAITH_TUI_REQUIRE_PACKAGE=1 node scripts/smoke-packaged-tui.cjs
 *   TASKWRAITH_TUI_SKIP_PACKAGED_HOST=1 node scripts/smoke-packaged-tui.cjs
 *   TASKWRAITH_TUI_REQUIRE_PACKAGED_HOST=1 node scripts/smoke-packaged-tui.cjs
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')
const { createServer } = require('node:net')
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
// Prefer packaged-host live smoke; allow running-host fallback unless strict.
const requirePackagedHost = process.env.TASKWRAITH_TUI_REQUIRE_PACKAGED_HOST === '1'
// Skip GUI packaged App launch entirely (agent envs that crash LaunchServices).
const skipPackagedHost = process.env.TASKWRAITH_TUI_SKIP_PACKAGED_HOST === '1'
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
  if (
    requirePackagedHost &&
    (process.env.TASKWRAITH_SKIP_TUI_HELP_SMOKE === '1' ||
      process.env.TASKWRAITH_SKIP_TUI_LIVE_SMOKE === '1' ||
      skipPackagedHost)
  ) {
    fail('TASKWRAITH_TUI_REQUIRE_PACKAGED_HOST=1 cannot be combined with packaged TUI skip flags')
  }
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
  assertFile(path.join(repoRoot, 'build/tui-runtime/README.md'), 'build/tui-runtime/README.md')

  // Compiled payload is required before packaging; warn-only if missing so a
  // pure-layout check can still run on a clean tree after tui:build.
  const cliJs = path.join(repoRoot, 'out/tui/tui/cli.js')
  if (!fs.existsSync(cliJs)) {
    console.log('note: out/tui/tui/cli.js missing — run npm run tui:build before electron-builder')
  } else {
    assertFile(cliJs, 'compiled TUI entry')
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

  const cliJs = path.join(resourcesDir, 'tui', 'tui', 'cli.js')
  assertFile(cliJs, 'packaged TUI entry (outside app.asar)')

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
        if (requirePackagedHost) {
          fail(
            `packaged TUI launcher help smoke cannot execute the candidate launcher: ${launcherResult.error.message}`
          )
        }
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
      if (requirePackagedHost) {
        fail(
          `packaged TUI help smoke cannot execute the candidate runtime: ${result.error.message}`
        )
      }
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
    shell: false
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
    if (requirePackagedHost) {
      fail(
        `packaged TUI live control smoke cannot execute ${packageTarget.platform}-${packageTarget.arch} on ${process.platform}-${process.arch}`
      )
    }
    console.log(
      `packaged TUI live control smoke skipped: cannot execute ${packageTarget.platform}-${packageTarget.arch} on ${process.platform}-${process.arch}`
    )
    return
  }

  const launcher = resolvePackagedLauncher(packageRoot, packageTarget)
  if (!launcher) fail(`packaged TUI launcher missing for live smoke: ${packageRoot}`)

  if (requirePackagedHost && skipPackagedHost) {
    fail(
      'TASKWRAITH_TUI_REQUIRE_PACKAGED_HOST=1 and TASKWRAITH_TUI_SKIP_PACKAGED_HOST=1 cannot both be set'
    )
  }

  // Prefer packaged-host-first, but do not spawn a second GUI candidate while a
  // human's TaskWraith is already live — that path triggers LaunchServices
  // aborts and "quit unexpectedly" prompts. REQUIRE_PACKAGED_HOST opts into the
  // disposable App path for clean CI machines.
  const hostAlreadyRunning = process.platform === 'darwin' && isTaskWraithAlreadyRunning()
  const avoidPackagedGui = skipPackagedHost || (hostAlreadyRunning && !requirePackagedHost)

  if (!avoidPackagedGui) {
    try {
      await runPackagedHostLiveRoundTrip(packageRoot, packageTarget, launcher)
      return
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (requirePackagedHost || !isRecoverablePackagedHostFailure(message)) {
        fail(message)
      }
      console.log(
        `packaged App live smoke unavailable (${summarizeFailure(message)}); ` +
          'falling back to packaged tw against the already-running authoritative host'
      )
    }
  } else if (skipPackagedHost) {
    console.log(
      'packaged App live smoke skipped via TASKWRAITH_TUI_SKIP_PACKAGED_HOST=1; ' +
        'using running authoritative host'
    )
  } else if (hostAlreadyRunning) {
    console.log(
      'packaged App live smoke skipped: TaskWraith already running ' +
        '(avoids LaunchServices second-GUI aborts; set TASKWRAITH_TUI_REQUIRE_PACKAGED_HOST=1 for disposable App gate)'
    )
  }

  await runRunningHostLiveRoundTrip(packageRoot, packageTarget, launcher)
}

function isTaskWraithAlreadyRunning() {
  try {
    const result = spawnSync(
      '/usr/bin/pgrep',
      ['-f', 'TaskWraith\\.app/Contents/MacOS/TaskWraith'],
      { encoding: 'utf8' }
    )
    return result.status === 0 && Boolean(result.stdout && result.stdout.trim())
  } catch {
    return false
  }
}

/**
 * Disposable packaged App → owner-only discovery/token → authenticated snapshot.
 * Stops only the smoke App process; never touches a human's production host.
 */
async function runPackagedHostLiveRoundTrip(packageRoot, packageTarget, launcher) {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-tui-package-smoke-'))
  const discoveryPath = path.join(userDataPath, 'taskwraith-control-v1.json')
  const tokenPath = path.join(userDataPath, 'taskwraith-control-v1.token')
  const outputChunks = []
  let app
  let appPid
  let smokePackageRoot = packageRoot

  try {
    if (packageTarget.platform === 'darwin') {
      smokePackageRoot = prepareDarwinSmokeBundle(packageRoot, userDataPath)
    }
    const relayPort = await findAvailableLoopbackPort()
    const smokeUserDataArgument = `--taskwraith-package-smoke-user-data=${userDataPath}`
    const appArguments = [
      '--taskwraith-package-smoke',
      smokeUserDataArgument,
      ...(packageTarget.platform === 'darwin' ? ['--use-mock-keychain'] : []),
      ...(packageTarget.platform === 'linux' ? ['--no-sandbox', '--disable-gpu'] : [])
    ]
    const appLaunch = resolvePackagedAppLaunch(smokePackageRoot, packageTarget, appArguments)
    app = spawn(appLaunch.command, appLaunch.arguments, {
      cwd: packageRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        ...process.env,
        TASKWRAITH_PACKAGE_SMOKE: '1',
        TASKWRAITH_AUTO_UPDATE: 'off',
        TASKWRAITH_RELAY_PORT: String(relayPort),
        ELECTRON_RUN_AS_NODE: ''
      }
    })
    app.stdout?.on('data', (chunk) => appendBoundedOutput(outputChunks, chunk))
    app.stderr?.on('data', (chunk) => appendBoundedOutput(outputChunks, chunk))

    await waitForControlFiles(app, discoveryPath, tokenPath, liveTimeoutMs, outputChunks)
    const discovery = JSON.parse(fs.readFileSync(discoveryPath, 'utf8'))
    appPid = Number(discovery.pid)
    if (!Number.isInteger(appPid) || appPid <= 0 || appPid === process.pid) {
      throw new Error(`packaged App discovery contained an invalid pid: ${String(discovery.pid)}`)
    }
    assertOwnerOnlyFile(discoveryPath, 'control discovery')
    assertOwnerOnlyFile(tokenPath, 'control token')

    const snapshot = await runLiveSnapshotWithRetry(
      launcher,
      userDataPath,
      packageRoot,
      packageTarget,
      app,
      outputChunks
    )
    const frame = `${snapshot.stdout || ''}${snapshot.stderr || ''}`
    if (!/TaskWraith|Threads|App/.test(frame)) {
      throw new Error(
        `packaged TUI live snapshot did not contain projection markers (${Buffer.byteLength(
          frame,
          'utf8'
        )} bytes)`
      )
    }
    console.log(
      `packaged TUI live control smoke ok (packaged App → owner-only discovery/token → authenticated launcher snapshot, ${Buffer.byteLength(
        frame,
        'utf8'
      )} bytes)`
    )
  } catch (error) {
    // Re-throw as Error with child output attached when available.
    const base = error instanceof Error ? error.message : String(error)
    const detail = formatChildOutput(outputChunks)
    throw new Error(detail && !base.includes(detail.trim()) ? `${base}${detail}` : base)
  } finally {
    if (appPid) await stopProcess(appPid)
    if (app) await stopChild(app)
    fs.rmSync(userDataPath, { recursive: true, force: true })
    if (smokePackageRoot !== packageRoot) {
      fs.rmSync(smokePackageRoot, { recursive: true, force: true })
    }
  }
}

/**
 * Running authoritative host fallback: packaged tw only (no GUI launch, no kill).
 * Proves reconnect + projection against whatever TaskWraith is already live.
 */
async function runRunningHostLiveRoundTrip(packageRoot, packageTarget, launcher) {
  const host = resolveRunningHostUserData()
  if (!host) {
    // Production/pre-sidecar Apps often have no control discovery yet — layout +
    // help smoke already validated the package. Fail closed only when CI
    // requires a packaged host (which we already skipped) or an explicit host.
    const detail =
      'running-host live smoke: no TaskWraith control discovery/token under default userData paths ' +
      '(authoritative App may predate the sidecar control server, or local control is not listening). ' +
      'Layout + launcher --help already passed. ' +
      'Set TASKWRAITH_USER_DATA to a host with control files, or run on a clean machine with ' +
      'TASKWRAITH_TUI_REQUIRE_PACKAGED_HOST=1 for the disposable packaged App gate.'
    if (requirePackagedHost) {
      fail(detail)
    }
    console.log(`${detail} Soft-skipping live control smoke.`)
    return
  }

  const discoveryPath = path.join(host.userDataPath, 'taskwraith-control-v1.json')
  const tokenPath = path.join(host.userDataPath, 'taskwraith-control-v1.token')
  assertOwnerOnlyFile(discoveryPath, 'running-host control discovery')
  assertOwnerOnlyFile(tokenPath, 'running-host control token')

  // Sanity: discovery pid should still be alive (best-effort; do not kill it).
  try {
    const discovery = JSON.parse(fs.readFileSync(discoveryPath, 'utf8'))
    const pid = Number(discovery.pid)
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
      try {
        process.kill(pid, 0)
      } catch {
        fail(
          `running-host live smoke: discovery pid ${pid} is not running under ${host.userDataPath}`
        )
      }
    }
  } catch (error) {
    if (error && typeof error === 'object' && error.message?.includes('discovery pid')) throw error
    // Malformed discovery still fails the snapshot path with a clearer client error.
  }

  const snapshot = await runLiveSnapshotWithRetry(
    launcher,
    host.userDataPath,
    packageRoot,
    packageTarget,
    null,
    []
  )
  const frame = `${snapshot.stdout || ''}${snapshot.stderr || ''}`
  if (!/TaskWraith|Threads|App/.test(frame)) {
    fail(
      `running-host live snapshot did not contain projection markers (${Buffer.byteLength(
        frame,
        'utf8'
      )} bytes; userData=${host.userDataPath})`
    )
  }
  console.log(
    `packaged TUI live control smoke ok (running host fallback → ${host.label} → authenticated launcher snapshot, ${Buffer.byteLength(
      frame,
      'utf8'
    )} bytes)`
  )
}

function resolveRunningHostUserData() {
  const home = os.homedir()
  const candidates = []

  const explicit = String(process.env.TASKWRAITH_USER_DATA || '').trim()
  if (explicit) candidates.push({ userDataPath: explicit, label: 'TASKWRAITH_USER_DATA' })

  if (process.platform === 'darwin') {
    const support = path.join(home, 'Library', 'Application Support')
    candidates.push({
      userDataPath: path.join(support, 'taskwraith'),
      label: 'default packaged userData'
    })
    candidates.push({
      userDataPath: path.join(support, 'TaskWraith'),
      label: 'legacy TaskWraith userData'
    })
    // Dev / multi-instance seats: TaskWraith Dev, TaskWraith Dev <id>
    try {
      for (const entry of fs.readdirSync(support, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        if (!/^TaskWraith Dev(?:\s|$)/i.test(entry.name) && entry.name !== 'TaskWraith Dev') {
          continue
        }
        candidates.push({
          userDataPath: path.join(support, entry.name),
          label: `dev userData (${entry.name})`
        })
      }
    } catch {
      // Support dir may be unreadable in some sandboxes.
    }
  } else if (process.platform === 'win32') {
    const appData =
      String(process.env.APPDATA || '').trim() || path.join(home, 'AppData', 'Roaming')
    candidates.push({
      userDataPath: path.join(appData, 'taskwraith'),
      label: 'default packaged userData'
    })
    candidates.push({
      userDataPath: path.join(appData, 'TaskWraith'),
      label: 'legacy TaskWraith userData'
    })
  } else {
    const configHome =
      String(process.env.XDG_CONFIG_HOME || '').trim() || path.join(home, '.config')
    candidates.push({
      userDataPath: path.join(configHome, 'taskwraith'),
      label: 'default packaged userData'
    })
  }

  const seen = new Set()
  const abandoned = []
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate.userDataPath)
    if (seen.has(resolved)) continue
    seen.add(resolved)
    const discoveryPath = path.join(resolved, 'taskwraith-control-v1.json')
    const tokenPath = path.join(resolved, 'taskwraith-control-v1.token')
    if (!fs.existsSync(discoveryPath) || !fs.existsSync(tokenPath)) continue
    // An explicitly named host is the caller's assertion that it is live: keep
    // selecting it so a dead pid there fails loudly downstream rather than
    // silently degrading to another seat.
    if (candidate.label !== 'TASKWRAITH_USER_DATA' && !discoveryPidIsAlive(discoveryPath)) {
      abandoned.push(candidate.label)
      continue
    }
    return { userDataPath: resolved, label: candidate.label }
  }
  if (abandoned.length > 0) {
    console.log(
      `running-host live smoke: skipped ${abandoned.length} abandoned control record(s) ` +
        `(${abandoned.join(', ')}) whose owning process is gone.`
    )
  }
  return null
}

/**
 * A control discovery file outlives the App that wrote it: a crashed or killed
 * seat leaves the record behind with a dead pid. Auto-discovery must treat that
 * as "no host", not as a host — otherwise the FIRST candidate holding a stale
 * record shadows every live seat behind it and hard-fails the release gate.
 *
 * Hit on 2026-07-29 during the 1.9.1 ship: three dev seats (`tuiqa0728`,
 * `tuiqa2`, `verify-composer-`) had left records from processes dead for a day,
 * so `validate:release` failed with "discovery pid 986 is not running" while the
 * authoritative App — a pre-sidecar 1.9.0 release with no control server at all —
 * was exactly the documented soft-skip case. Whether the gate passed depended on
 * whether an unrelated seat had crashed days earlier.
 *
 * Unreadable or malformed records stay selectable: the liveness claim is only
 * refuted by a pid we can positively prove is gone. Everything else keeps the
 * existing downstream error paths, which report far better than this function can.
 */
function discoveryPidIsAlive(discoveryPath) {
  let pid
  try {
    pid = Number(JSON.parse(fs.readFileSync(discoveryPath, 'utf8')).pid)
  } catch {
    return true
  }
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the process exists under another uid — alive, just not ours.
    return error && error.code === 'EPERM'
  }
}

function isRecoverablePackagedHostFailure(message) {
  const text = String(message || '')
  // macOS LaunchServices / second-GUI registration aborts from agent shells.
  if (/RegisterApplication|Launch Services|LSOpen|kLS|open -n|open exited/i.test(text)) {
    return true
  }
  // open(1) / agent environment cannot start another GUI app instance.
  if (/could not be opened|Unable to find application|Failed to launch|spawn.*open/i.test(text)) {
    return true
  }
  // Packaged App never reached control readiness (modal hang, registration abort, etc.).
  if (
    /timed out waiting for packaged App local control|exited before local control|clone packaged App|ad-hoc sign packaged App/i.test(
      text
    )
  ) {
    return true
  }
  // Keychain / single-instance residual from prior smoke work.
  if (/keychain|single-instance|holds the lock/i.test(text)) {
    return true
  }
  return false
}

function summarizeFailure(message) {
  const firstLine = String(message || '')
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean)
  if (!firstLine) return 'unknown error'
  return firstLine.length > 160 ? `${firstLine.slice(0, 157)}…` : firstLine
}

function prepareDarwinSmokeBundle(packageRoot, userDataPath) {
  // A second running copy with the release bundle identifier can collide in
  // Launch Services before Electron reaches our disposable-profile flags.
  // Clone the package, give only the clone a smoke identity, and ad-hoc sign
  // it. That unique signed clone is safe to launch through its inner binary;
  // the verified release artifact remains byte-for-byte untouched.
  const smokePackageRoot = `${userDataPath}.app`
  runChecked('/bin/cp', ['-cR', packageRoot, smokePackageRoot], 'clone packaged App for smoke')
  const infoPlist = path.join(smokePackageRoot, 'Contents', 'Info.plist')
  const smokeBundleIdentifier = `com.chrisizatt.taskwraith.package-smoke.${process.pid}.${Date.now()}`
  runChecked(
    '/usr/bin/plutil',
    ['-replace', 'CFBundleIdentifier', '-string', smokeBundleIdentifier, infoPlist],
    'set packaged App smoke bundle identifier'
  )
  runChecked(
    '/usr/bin/codesign',
    ['--force', '--deep', '--sign', '-', smokePackageRoot],
    'ad-hoc sign packaged App smoke clone'
  )
  return smokePackageRoot
}

function runChecked(command, commandArgs, label) {
  const result = spawnSync(command, commandArgs, {
    encoding: 'utf8',
    timeout: helpTimeoutMs
  })
  if (result.error) fail(`${label} failed to spawn: ${result.error.message}`)
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
    fail(`${label} exited ${result.status}${detail ? `:\n${detail.slice(0, 2000)}` : ''}`)
  }
}

async function findAvailableLoopbackPort() {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  const port = address && typeof address === 'object' ? address.port : 0
  await new Promise((resolve) => server.close(resolve))
  if (!Number.isInteger(port) || port <= 0) fail('could not reserve an ephemeral relay port')
  return port
}

async function runLiveSnapshotWithRetry(
  launcher,
  userDataPath,
  packageRoot,
  packageTarget,
  app,
  outputChunks
) {
  const deadline = Date.now() + liveTimeoutMs
  let lastDetail = ''
  while (Date.now() < deadline) {
    const snapshot = spawnPackagedLauncherSync(
      launcher,
      [
        '--snapshot',
        '--user-data',
        userDataPath,
        '--no-color',
        '--ascii',
        '--width',
        '80',
        '--height',
        '24'
      ],
      packageTarget,
      {
        cwd: packageRoot,
        encoding: 'utf8',
        timeout: helpTimeoutMs,
        windowsHide: true,
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: ''
        }
      }
    )
    if (snapshot.error) {
      fail(`packaged TUI live snapshot failed to spawn: ${snapshot.error.message}`)
    }
    if (snapshot.status === 0) return snapshot

    lastDetail = [snapshot.stdout, snapshot.stderr].filter(Boolean).join('\n').trim()
    const appGone = app != null && (app.exitCode !== null || app.signalCode !== null)
    if (
      !/timed out connecting|host disconnected|ECONNREFUSED|ENOENT|not running|no control/i.test(
        lastDetail
      ) ||
      appGone
    ) {
      fail(
        `packaged TUI live snapshot exited ${snapshot.status ?? 'null'}${
          lastDetail ? `:\n${lastDetail.slice(0, 1000)}` : ''
        }${formatChildOutput(outputChunks)}`
      )
    }
    await delay(250)
  }
  fail(
    `packaged TUI live snapshot did not connect before the ${liveTimeoutMs}ms deadline${
      lastDetail ? `:\n${lastDetail.slice(0, 1000)}` : ''
    }${formatChildOutput(outputChunks)}`
  )
}

function resolvePackagedAppLaunch(packageRoot, packageTarget, appArguments) {
  return {
    command: resolvePackagedAppExecutable(packageRoot, packageTarget),
    arguments: appArguments
  }
}

function resolvePackagedAppExecutable(packageRoot, packageTarget) {
  if (packageTarget.platform === 'darwin') {
    const macosDir = path.join(packageRoot, 'Contents', 'MacOS')
    const candidates = [
      path.join(macosDir, 'TaskWraith'),
      ...safeReadDir(macosDir)
        .filter((entry) => entry.isFile())
        .map((entry) => path.join(macosDir, entry.name))
    ]
    const found = candidates.find((candidate) => fs.existsSync(candidate))
    if (found) {
      assertExecutable(found, 'packaged macOS App executable')
      return found
    }
  } else if (packageTarget.platform === 'win32') {
    const preferred = path.join(packageRoot, 'TaskWraith.exe')
    if (fs.existsSync(preferred)) return preferred
    const executable = fs
      .readdirSync(packageRoot)
      .find((name) => name.toLowerCase().endsWith('.exe'))
    if (executable) return path.join(packageRoot, executable)
  } else {
    for (const name of ['taskwraith', 'TaskWraith']) {
      const candidate = path.join(packageRoot, name)
      if (fs.existsSync(candidate)) return candidate
    }
  }
  fail(`packaged App executable not found for live smoke: ${packageRoot}`)
}

async function waitForControlFiles(app, discoveryPath, tokenPath, timeoutMs, outputChunks) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (fs.existsSync(discoveryPath) && fs.existsSync(tokenPath)) return
    if (app.exitCode !== null || app.signalCode !== null) {
      fail(
        `packaged App exited before local control became ready (exit=${
          app.exitCode ?? app.signalCode
        })${formatChildOutput(outputChunks)}`
      )
    }
    await delay(100)
  }
  fail(`timed out waiting for packaged App local control${formatChildOutput(outputChunks)}`)
}

function assertOwnerOnlyFile(filePath, label) {
  const stat = fs.statSync(filePath)
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    fail(`${label} is not owner-only: ${filePath} mode=${(stat.mode & 0o777).toString(8)}`)
  }
  if (
    process.platform !== 'win32' &&
    typeof process.getuid === 'function' &&
    stat.uid !== process.getuid()
  ) {
    fail(`${label} is not owned by the current user: ${filePath}`)
  }
}

function appendBoundedOutput(chunks, chunk) {
  if (Buffer.byteLength(chunks.join(''), 'utf8') >= 16000) return
  chunks.push(String(chunk))
}

function formatChildOutput(chunks) {
  const detail = chunks.join('').trim()
  return detail ? `:\n${detail.slice(0, 16000)}` : ''
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) return
    await delay(50)
  }
  child.kill('SIGKILL')
}

async function stopProcess(pid) {
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    return
  }
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
    } catch {
      return
    }
    await delay(50)
  }
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // Process exited between the final probe and escalation.
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function resolveResourcesDir(packageRoot) {
  if (packageRoot.endsWith('.app')) {
    return path.join(packageRoot, 'Contents', 'Resources')
  }
  return path.join(packageRoot, 'resources')
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
  if (fs.existsSync(path.join(candidate, 'resources/app.asar'))) {
    return true
  }
  return false
}

function inferPackageTarget(packageRoot) {
  if (packageRoot.endsWith('.app')) {
    const base = path.basename(path.dirname(packageRoot)).toLowerCase()
    if (base.includes('arm64')) return { platform: 'darwin', arch: 'arm64' }
    if (base.includes('x64') || base.includes('x86_64')) return { platform: 'darwin', arch: 'x64' }
    // mac-universal or bare .app
    return { platform: 'darwin', arch: 'universal' }
  }
  const base = path.basename(packageRoot).toLowerCase()
  if (base.includes('win') || fs.existsSync(path.join(packageRoot, 'TaskWraith.exe'))) {
    const arch = base.includes('arm64') ? 'arm64' : 'x64'
    return { platform: 'win32', arch }
  }
  return { platform: 'linux', arch: process.arch === 'arm64' ? 'arm64' : 'x64' }
}

function findDirectories(root, predicate, maxDepth) {
  const results = []
  function walk(dir, depth) {
    if (depth > maxDepth) return
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      const full = path.join(dir, entry.name)
      if (predicate(full)) results.push(full)
      else walk(full, depth + 1)
    }
  }
  walk(root, 0)
  return results
}

function safeReadDir(dirPath) {
  try {
    return fs.readdirSync(dirPath, { withFileTypes: true })
  } catch {
    return []
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

function readIntegerEnv(name, fallback) {
  const raw = process.env[name]
  if (raw == null || raw === '') return fallback
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return n
}

function fail(message) {
  // Throw so packaged-host failures can fall back to the running host.
  // main().catch prints and exits non-zero for uncaught smoke failures.
  const error = new Error(message)
  error.name = 'SmokeFailure'
  throw error
}
