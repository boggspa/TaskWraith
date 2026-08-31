#!/usr/bin/env node

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { packCliPackage } = require('./prepare-cli-package.cjs')
const { resolvePlatformCommandInvocation } = require('./windows-cmd-invocation.cjs')

const REPO_ROOT = path.resolve(__dirname, '..')

function run(command, args, options = {}) {
  const invocation = resolvePlatformCommandInvocation(command, args, process.platform, options.env)
  return spawnSync(invocation.command, invocation.arguments, {
    cwd: options.cwd || REPO_ROOT,
    env: options.env || process.env,
    encoding: 'utf8',
    timeout: options.timeout || 120_000,
    ...invocation.spawnOptions
  })
}

function requireSuccess(result, label) {
  if (result.error || result.status !== 0) {
    throw new Error(
      `${label} failed${result.status === null ? '' : ` with exit ${result.status}`}\n${
        result.stderr || result.stdout || result.error || ''
      }`
    )
  }
  return String(result.stdout || '')
}

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm'
}

function installedBin(prefix, name) {
  return process.platform === 'win32'
    ? path.join(prefix, `${name}.cmd`)
    : path.join(prefix, 'bin', name)
}

function smokeProfile(home) {
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'taskwraith')
  }
  if (process.platform === 'win32') return path.join(home, 'AppData', 'Roaming', 'taskwraith')
  return path.join(home, '.config', 'taskwraith')
}

function canonicalSmokeProfile(home) {
  const profile = smokeProfile(home)
  try {
    return fs.realpathSync(profile)
  } catch {
    return profile
  }
}

function isolatedEnvironment(home) {
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: path.join(home, '.config')
  }
  delete env.TASKWRAITH_USER_DATA
  delete env.TASKWRAITH_INSTANCE_ID
  delete env.TASKWRAITH_TUI_PACKAGE_SMOKE
  return env
}

function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-cli-smoke-'))
  const packDirectory = path.join(root, 'pack')
  const prefix = path.join(root, 'prefix')
  const home = path.join(root, 'home')
  fs.mkdirSync(packDirectory, { recursive: true })
  fs.mkdirSync(home, { recursive: true })
  const env = isolatedEnvironment(home)
  let hostBin = ''
  try {
    const tarball = packCliPackage({ destination: packDirectory })
    requireSuccess(
      run(
        npmCommand(),
        ['install', '--global', '--prefix', prefix, '--ignore-scripts', '--omit=optional', tarball],
        { env, timeout: 180_000 }
      ),
      'temporary global npm install'
    )

    const taskwraith = installedBin(prefix, 'taskwraith')
    const tw = installedBin(prefix, 'tw')
    hostBin = installedBin(prefix, 'taskwraith-host')
    for (const binary of [taskwraith, tw, hostBin]) {
      if (!fs.existsSync(binary)) throw new Error(`installed CLI binary is missing: ${binary}`)
    }

    const version = requireSuccess(run(taskwraith, ['--version'], { env }), 'taskwraith --version')
    if (!/^\d+\.\d+\.\d+\s*$/.test(version)) {
      throw new Error(`taskwraith --version returned an unexpected value: ${version}`)
    }
    requireSuccess(run(tw, ['--help'], { env }), 'tw --help')
    const demo = requireSuccess(
      run(taskwraith, ['--demo', '--snapshot', '--ascii', '--no-color'], { env }),
      'taskwraith demo snapshot'
    )
    if (!demo.includes('Ask TaskWraith')) throw new Error('packaged TUI demo did not render')

    const live = requireSuccess(
      run(taskwraith, ['--snapshot', '--ascii', '--no-color'], { env, timeout: 180_000 }),
      'taskwraith live Host snapshot'
    )
    if (!/CONNECTED/i.test(live)) throw new Error('packaged TUI did not connect to its Node Host')

    requireSuccess(
      run(hostBin, ['stop', '--profile', canonicalSmokeProfile(home)], { env }),
      'taskwraith-host stop'
    )
    hostBin = ''

    const installedRoot = path.join(prefix, 'lib', 'node_modules', 'taskwraith')
    if (!fs.existsSync(path.join(installedRoot, 'dist', 'host', 'host-runtime', 'cli.js'))) {
      throw new Error('installed package is missing the Host payload')
    }
    const maps = []
    const walk = (directory) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const item = path.join(directory, entry.name)
        if (entry.isDirectory()) walk(item)
        else if (entry.name.endsWith('.map')) maps.push(item)
      }
    }
    walk(path.join(installedRoot, 'dist'))
    if (maps.length > 0)
      throw new Error(`installed package contains source maps: ${maps.join(', ')}`)
    console.log(`npm CLI package smoke ok: ${path.basename(tarball)}`)
  } finally {
    if (hostBin && fs.existsSync(hostBin)) {
      run(hostBin, ['stop', '--profile', canonicalSmokeProfile(home)], {
        env,
        timeout: 15_000
      })
    }
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

try {
  main()
} catch (error) {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exitCode = 1
}
