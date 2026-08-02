#!/usr/bin/env node

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

function resolveMacArtifacts(distDir, version) {
  const dmg = path.join(distDir, `TaskWraith-${version}-universal-mac.dmg`)
  const zip = path.join(distDir, `TaskWraith-${version}-universal-mac.zip`)
  for (const artifact of [dmg, zip]) {
    if (!fs.existsSync(artifact) || !fs.statSync(artifact).isFile()) {
      throw new Error(`Missing exact macOS release artifact: ${artifact}`)
    }
  }
  return { dmg, zip }
}

function findTaskWraithApp(root) {
  const stack = [root]
  while (stack.length > 0) {
    const current = stack.pop()
    for (const entry of safeReadDir(current)) {
      const full = path.join(current, entry.name)
      if (!entry.isDirectory()) continue
      if (entry.name === 'TaskWraith.app') return full
      stack.push(full)
    }
  }
  return null
}

function runChecked(command, args, options, label) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 180_000,
    ...options
  })
  if (result.error) {
    throw new Error(`${label} failed to spawn: ${result.error.message}`)
  }
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
    throw new Error(
      `${label} exited ${result.status}${detail ? `:\n${detail.slice(0, 4000)}` : ''}`
    )
  }
  return result
}

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}

function detachMountedImage(
  mountPoint,
  { maxAttempts = 6, run = spawnSync, wait = sleepSync } = {}
) {
  let result
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    result = run('hdiutil', ['detach', mountPoint], {
      encoding: 'utf8',
      timeout: 30_000
    })
    if (result.status === 0) return result
    if (attempt < maxAttempts) wait(250 * 2 ** (attempt - 1))
  }
  return result
}

function verifyAndSmokeApp(appPath, repoRoot, label) {
  runChecked(
    'codesign',
    ['--verify', '--deep', '--strict', '--verbose=2', appPath],
    {},
    `${label} codesign`
  )
  runChecked(
    'spctl',
    ['--assess', '--type', 'execute', '--verbose=4', appPath],
    {},
    `${label} Gatekeeper`
  )
  runChecked('xcrun', ['stapler', 'validate', appPath], {}, `${label} notarization ticket`)
  runChecked(
    process.execPath,
    [path.join(repoRoot, 'scripts', 'smoke-packaged-electron.cjs'), appPath],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        TASKWRAITH_FORCE_LAUNCH_SMOKE: '1',
        TASKWRAITH_TUI_REQUIRE_PACKAGE: '1',
        TASKWRAITH_TUI_REQUIRE_PACKAGED_HOST: '1'
      }
    },
    `${label} packaged Electron/TUI smoke`
  )
}

function runCli(argv = process.argv.slice(2), repoRoot = process.cwd()) {
  if (process.platform !== 'darwin') {
    throw new Error('macOS artifact smoke must run on macOS')
  }
  const distDir = path.resolve(repoRoot, argv[0] || 'dist')
  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
  const { dmg, zip } = resolveMacArtifacts(distDir, packageJson.version)
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-mac-artifacts-'))
  const zipRoot = path.join(tempRoot, 'zip')
  const mountPoint = path.join(tempRoot, 'dmg')
  let mounted = false
  let cleanupError = null

  try {
    fs.mkdirSync(zipRoot)
    fs.mkdirSync(mountPoint)
    runChecked('unzip', ['-t', zip], {}, 'ZIP integrity')
    runChecked('ditto', ['-x', '-k', zip, zipRoot], {}, 'ZIP extraction')
    const zipApp = findTaskWraithApp(zipRoot)
    if (!zipApp) throw new Error(`${path.basename(zip)} contains no TaskWraith.app`)
    verifyAndSmokeApp(zipApp, repoRoot, 'extracted ZIP app')

    runChecked('hdiutil', ['verify', dmg], {}, 'DMG integrity')
    runChecked(
      'hdiutil',
      ['attach', '-readonly', '-nobrowse', '-mountpoint', mountPoint, dmg],
      {},
      'DMG read-only attach'
    )
    mounted = true
    const dmgApp = findTaskWraithApp(mountPoint)
    if (!dmgApp) throw new Error(`${path.basename(dmg)} contains no TaskWraith.app`)
    verifyAndSmokeApp(dmgApp, repoRoot, 'mounted DMG app')
  } finally {
    if (mounted) {
      const detach = detachMountedImage(mountPoint)
      if (detach.status !== 0) {
        cleanupError = new Error(
          `could not detach ${mountPoint}: ${detach.stderr || detach.stdout || detach.error || 'unknown error'}`
        )
      } else {
        mounted = false
      }
    }
    if (!mounted) {
      try {
        fs.rmSync(tempRoot, { recursive: true, force: true })
      } catch (error) {
        cleanupError ??= error
      }
    }
  }

  if (cleanupError) throw cleanupError

  console.log('[smoke-mac-artifacts] ZIP and DMG containers passed integrity and payload smoke')
  return 0
}

function safeReadDir(dirPath) {
  try {
    return fs.readdirSync(dirPath, { withFileTypes: true })
  } catch {
    return []
  }
}

if (require.main === module) {
  try {
    process.exitCode = runCli()
  } catch (error) {
    console.error(`[smoke-mac-artifacts] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}

module.exports = {
  detachMountedImage,
  findTaskWraithApp,
  resolveMacArtifacts,
  runCli
}
