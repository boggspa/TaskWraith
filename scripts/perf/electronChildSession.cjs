'use strict'

/**
 * Exact-child Electron session for T2: build / spawn / attach / terminate.
 *
 * Safety invariants:
 * - Authoritative launch builds via real `npx electron-vite build` (fail-closed)
 * - Spawn resolves local `require('electron')` binary directly (never npx wrapper PID)
 * - Attach only to the spawned child's pid/tree + ports
 * - Terminate only that owned process group / tree
 * - Never pgrep / kill broad targets
 * - Never auto-delete artifacts
 * - All side effects go through injected adapters for unit tests
 */

const path = require('path')
const { buildIsolatedLaunchPlan } = require('./isolatedLaunch.cjs')

const DEFAULT_BUILD_COMMAND = 'npx electron-vite build'
const DEFAULT_BUILD_ARGV = ['electron-vite', 'build']

/**
 * @typedef {object} ChildHandle
 * @property {number} pid
 * @property {number} [pgid]
 * @property {string} [electronBinary]
 * @property {number[]} [ownedPids]
 * @property {NodeJS.EventEmitter} [stdout]
 * @property {NodeJS.EventEmitter} [stderr]
 * @property {(signal?: string) => boolean} [kill]
 * @property {(event: string, handler: Function) => void} [on]
 * @property {number|null} [exitCode]
 * @property {boolean} [killed]
 */

/**
 * Resolve the local Electron binary path (not an npx wrapper).
 * @param {object} [options]
 * @param {string} [options.repoRoot]
 * @param {{ resolveElectronPath?: Function, requireElectron?: Function }} [options.adapters]
 * @returns {string}
 */
function resolveElectronBinary(options = {}) {
  if (options.adapters && typeof options.adapters.resolveElectronPath === 'function') {
    const resolved = options.adapters.resolveElectronPath(options.repoRoot)
    if (typeof resolved !== 'string' || !resolved.trim()) {
      throw new Error('resolveElectronPath adapter returned empty path')
    }
    return path.resolve(resolved)
  }
  const requireElectron =
    (options.adapters && options.adapters.requireElectron) ||
    (() => {
      // eslint-disable-next-line import/no-extraneous-dependencies
      return require('electron')
    })
  let electronPath
  try {
    electronPath = requireElectron()
  } catch (error) {
    const err = new Error(
      `Failed to resolve local Electron binary via require('electron'): ${
        error && error.message ? error.message : error
      }`
    )
    err.cause = error
    throw err
  }
  if (typeof electronPath !== 'string' || !electronPath.trim()) {
    throw new Error(
      "require('electron') did not return a binary path string — refuse npx-wrapper spawn"
    )
  }
  return path.resolve(electronPath)
}

/**
 * Build command plan for unpackaged Electron with unique CDP + inspect ports.
 * @param {object} options
 * @param {string} options.instanceId
 * @param {string} options.repoRoot
 * @param {number} options.remoteDebuggingPort
 * @param {number} options.mainInspectorPort
 * @param {string} [options.workload]
 * @param {string} [options.fxPosture]
 * @param {string} [options.userDataPath] — recorded for provenance; Electron derives via INSTANCE_ID
 * @param {{ resolveElectronPath?: Function, requireElectron?: Function }} [options.adapters]
 */
function buildElectronSpawnPlan(options) {
  const base = buildIsolatedLaunchPlan({
    instanceId: options.instanceId,
    remoteDebuggingPort: options.remoteDebuggingPort,
    mainInspectorPort: options.mainInspectorPort,
    workload: options.workload,
    fxPosture: options.fxPosture,
    repoRoot: options.repoRoot
  })
  const mainInspectorPort = base.mainInspectorPort
  if (
    !Number.isInteger(mainInspectorPort) ||
    mainInspectorPort < 1024 ||
    mainInspectorPort > 65535
  ) {
    throw new Error('mainInspectorPort must be an integer 1024–65535')
  }
  if (mainInspectorPort === base.remoteDebuggingPort) {
    throw new Error('mainInspectorPort must differ from remoteDebuggingPort')
  }

  const env = {
    ...base.env,
    IOS_REMOTE_TRUE: '0',
    ELECTRON_ENABLE_LOGGING: '1'
  }

  let electronBinary = null
  try {
    electronBinary = resolveElectronBinary({
      repoRoot: options.repoRoot || base.repoRoot,
      adapters: options.adapters
    })
  } catch {
    // Plan-only paths may lack Electron; spawnExactElectronChild resolves fail-closed.
    electronBinary = null
  }
  const entry = base.electronEntry || '.'
  // Direct Electron argv (binary is the spawn command — never `npx`).
  const argv = [
    entry,
    `--remote-debugging-port=${base.remoteDebuggingPort}`,
    `--inspect=${mainInspectorPort}`
  ]

  const binaryForShell = electronBinary || '<resolve-require-electron-at-spawn>'
  const shellCommand = [
    `TASKWRAITH_INSTANCE_ID=${shellQuote(env.TASKWRAITH_INSTANCE_ID)}`,
    'IOS_REMOTE_TRUE=0',
    `${shellQuote(binaryForShell)} ${shellQuote(entry)} --remote-debugging-port=${base.remoteDebuggingPort} --inspect=${mainInspectorPort}`
  ].join(' ')

  return {
    ...base,
    mainInspectorPort,
    env,
    argv,
    electronBinary,
    spawnCommand: electronBinary || binaryForShell,
    shellCommand,
    userDataPath: options.userDataPath || null,
    buildCommand: DEFAULT_BUILD_COMMAND,
    safety: {
      ...base.safety,
      electronLaunchDisabledUntilT2: false,
      attachOnlyExactChild: true,
      terminateOnlyExactChild: true,
      neverPgrepKillBroad: true,
      neverAutoDeleteArtifacts: true,
      spawnDirectElectronBinary: true,
      neverSpawnViaNpxWrapper: true,
      notes: [
        'Build from this clean isolated worktree first: npx electron-vite build',
        'Materialize legacy_v1 fixture into exact TaskWraith Dev <sanitizedId> before launch so chats/ skips legacy migration',
        'Spawn resolve(require("electron")) directly — never npx (wrapper PID ≠ Electron)',
        'Attach CDP/inspector only to the ports owned by the spawned Electron pid/tree',
        'Terminate only the recorded owned process group; never pgrep/kill TaskWraith broadly',
        'Never auto-delete artifact dirs or userData'
      ]
    }
  }
}

/**
 * Default build adapter: run `npx electron-vite build` and fail closed on nonzero.
 * @param {string} repoRoot
 * @param {{ spawn?: Function, spawnSync?: Function }} [adapters]
 */
function createDirectCliBuildAdapter(adapters = {}) {
  return async function directCliBuild(repoRoot) {
    const cwd = path.resolve(repoRoot || '.')
    if (typeof adapters.spawnSync === 'function') {
      const result = adapters.spawnSync('npx', DEFAULT_BUILD_ARGV, {
        cwd,
        encoding: 'utf8',
        env: process.env
      })
      const code = result && typeof result.status === 'number' ? result.status : 1
      if (code !== 0) {
        const err = new Error(
          `npx electron-vite build failed with code ${code}${
            result && result.stderr ? `: ${String(result.stderr).slice(0, 400)}` : ''
          }`
        )
        err.code = code
        throw err
      }
      return { code: 0, command: DEFAULT_BUILD_COMMAND, cwd, stdout: result.stdout || '' }
    }

    const spawn =
      adapters.spawn ||
      ((cmd, args, opts) => {
        const { spawn: nodeSpawn } = require('child_process')
        return nodeSpawn(cmd, args, opts)
      })

    return await new Promise((resolve, reject) => {
      const child = spawn('npx', DEFAULT_BUILD_ARGV, {
        cwd,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      if (!child) {
        reject(new Error('npx electron-vite build failed to spawn'))
        return
      }
      let stdout = ''
      let stderr = ''
      if (child.stdout && typeof child.stdout.on === 'function') {
        child.stdout.on('data', (chunk) => {
          stdout += String(chunk)
        })
      }
      if (child.stderr && typeof child.stderr.on === 'function') {
        child.stderr.on('data', (chunk) => {
          stderr += String(chunk)
        })
      }
      child.on('error', (error) => {
        reject(
          new Error(
            `npx electron-vite build missing/failed to execute: ${
              error && error.message ? error.message : error
            }`
          )
        )
      })
      child.on('exit', (code, signal) => {
        const exitCode = typeof code === 'number' ? code : 1
        if (exitCode !== 0) {
          const err = new Error(
            `npx electron-vite build failed with code ${exitCode}${
              signal ? ` signal=${signal}` : ''
            }${stderr ? `: ${stderr.slice(0, 400)}` : ''}`
          )
          err.code = exitCode
          reject(err)
          return
        }
        resolve({ code: 0, command: DEFAULT_BUILD_COMMAND, cwd, stdout, stderr })
      })
    })
  }
}

/**
 * @param {object} options
 * @param {object} options.spawnPlan — from buildElectronSpawnPlan
 * @param {{ spawn?: Function, whichNpx?: Function, resolveElectronPath?: Function, requireElectron?: Function }} [options.adapters]
 * @returns {ChildHandle & { spawnPlan: object }}
 */
function spawnExactElectronChild(options) {
  const spawnPlan = options.spawnPlan
  if (!spawnPlan || !spawnPlan.env || !spawnPlan.argv) {
    throw new Error('spawnPlan required')
  }
  const spawn =
    (options.adapters && options.adapters.spawn) ||
    ((cmd, args, opts) => {
      const { spawn: nodeSpawn } = require('child_process')
      return nodeSpawn(cmd, args, opts)
    })

  const electronBinary =
    (typeof spawnPlan.electronBinary === 'string' && spawnPlan.electronBinary.trim()
      ? spawnPlan.electronBinary
      : null) ||
    resolveElectronBinary({
      repoRoot: spawnPlan.repoRoot,
      adapters: options.adapters
    })
  if (typeof electronBinary !== 'string' || !electronBinary.trim()) {
    throw new Error('electronBinary missing — refuse spawn')
  }
  if (
    path.basename(electronBinary) === 'npx' ||
    electronBinary === 'npx' ||
    electronBinary.includes('<resolve-')
  ) {
    throw new Error('Refuse spawn via npx wrapper — resolve local Electron binary instead')
  }

  const args = spawnPlan.argv
  const useProcessGroup = process.platform !== 'win32'
  /** @type {ChildHandle} */
  const child = spawn(electronBinary, args, {
    cwd: spawnPlan.repoRoot,
    env: { ...process.env, ...spawnPlan.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    // Dedicated process group on POSIX so teardown owns the Electron tree, not a wrapper.
    detached: useProcessGroup
  })

  if (!child || typeof child.pid !== 'number' || child.pid <= 0) {
    throw new Error('spawnExactElectronChild: child pid missing — refuse attach')
  }

  const wrapped = wrapChild(child)
  return {
    ...wrapped,
    pgid: useProcessGroup ? child.pid : undefined,
    electronBinary,
    ownedPids: [child.pid],
    spawnPlan,
    remoteDebuggingPort: spawnPlan.remoteDebuggingPort,
    mainInspectorPort: spawnPlan.mainInspectorPort,
    instanceId: spawnPlan.instanceId,
    spawnCommand: electronBinary
  }
}

/**
 * @param {ChildHandle} child
 */
function wrapChild(child) {
  return {
    pid: child.pid,
    stdout: child.stdout,
    stderr: child.stderr,
    kill: (signal) => {
      if (typeof child.kill === 'function') return child.kill(signal || 'SIGTERM')
      return false
    },
    on: (event, handler) => {
      if (typeof child.on === 'function') child.on(event, handler)
    },
    exitCode: child.exitCode != null ? child.exitCode : null,
    killed: Boolean(child.killed)
  }
}

/**
 * Terminate only the exact recorded child / process group. Never broad process search.
 * @param {object} session
 * @param {{ signal?: string, waitMs?: number, forceSignal?: string, sleep?: Function, killProcessGroup?: Function }} [options]
 */
async function terminateExactChild(session, options = {}) {
  if (!session || typeof session.pid !== 'number' || session.pid <= 0) {
    throw new Error('terminateExactChild requires session.pid from spawnExactElectronChild')
  }
  const signal = options.signal || 'SIGTERM'
  const forceSignal = options.forceSignal || 'SIGKILL'
  const waitMs = options.waitMs == null ? 8000 : options.waitMs
  const sleep =
    options.sleep ||
    ((ms) =>
      new Promise((r) => {
        setTimeout(r, ms)
      }))

  let exited = false
  const exitPromise = new Promise((resolve) => {
    if (typeof session.on === 'function') {
      session.on('exit', (code, sig) => {
        exited = true
        resolve({ code, signal: sig })
      })
    } else {
      resolve({ code: null, signal: null })
    }
  })

  const killTree = (sig) => {
    if (typeof options.killProcessGroup === 'function' && session.pgid) {
      options.killProcessGroup(session.pgid, sig)
      return
    }
    if (session.pgid && process.platform !== 'win32') {
      try {
        process.kill(-session.pgid, sig)
        return
      } catch {
        // Fall through to direct pid kill
      }
    }
    session.kill(sig)
  }

  killTree(signal)
  const raced = await Promise.race([exitPromise, sleep(waitMs).then(() => ({ timeout: true }))])

  if (!exited && raced && raced.timeout) {
    killTree(forceSignal)
    await sleep(500)
  }

  return {
    pid: session.pid,
    pgid: session.pgid || null,
    terminated: true,
    neverAutoDeletedArtifacts: true,
    usedForce: Boolean(raced && raced.timeout),
    killedProcessGroup: Boolean(session.pgid)
  }
}

/**
 * Assert an attach target refers to the exact child session (pid + ports).
 * @param {object} session — spawned session
 * @param {object} attachClaim — { pid?, remoteDebuggingPort?, mainInspectorPort? }
 */
function assertExactChildAttach(session, attachClaim) {
  if (!session || typeof session.pid !== 'number') {
    throw new Error('spawned session required')
  }
  if (attachClaim.pid != null && attachClaim.pid !== session.pid) {
    throw new Error(`Refuse attach: claimed pid ${attachClaim.pid} !== spawned pid ${session.pid}`)
  }
  if (
    attachClaim.remoteDebuggingPort != null &&
    attachClaim.remoteDebuggingPort !== session.remoteDebuggingPort
  ) {
    throw new Error('Refuse attach: CDP port does not match spawned child')
  }
  if (
    attachClaim.mainInspectorPort != null &&
    attachClaim.mainInspectorPort !== session.mainInspectorPort
  ) {
    throw new Error('Refuse attach: inspector port does not match spawned child')
  }
  return true
}

/**
 * After free-port preflight + spawn, verify CDP/inspector listeners belong to owned Electron tree.
 * @param {object} session
 * @param {{ listPortPids?: (port: number) => Promise<number[]>|number[] }} [adapters]
 */
async function assertExactChildOwnsDebugPorts(session, adapters = {}) {
  if (!session || typeof session.pid !== 'number') {
    throw new Error('spawned session required for port ownership check')
  }
  const listPortPids =
    adapters.listPortPids ||
    (async () => {
      // Default: no OS probe in unit tests — caller must inject for live attach.
      return []
    })
  const allowed = new Set(
    [session.pid, ...(Array.isArray(session.ownedPids) ? session.ownedPids : [])].filter(
      (n) => typeof n === 'number' && n > 0
    )
  )
  const ports = [session.remoteDebuggingPort, session.mainInspectorPort].filter((p) =>
    Number.isInteger(p)
  )
  for (const port of ports) {
    const pids = await listPortPids(port)
    if (!Array.isArray(pids) || pids.length === 0) continue
    const owned = pids.some((pid) => allowed.has(pid))
    if (!owned) {
      throw new Error(
        `Refuse attach: port ${port} listeners ${pids.join(',')} are not in owned Electron tree (pid=${session.pid})`
      )
    }
  }
  return true
}

/**
 * Run isolated build. Authoritative path uses a real direct-CLI adapter and fail-closes.
 * Soft-skip is never returned for authoritative launch — callers must pass allowSkip explicitly.
 *
 * @param {object} options
 * @param {string} options.repoRoot
 * @param {{ build?: Function, spawn?: Function, spawnSync?: Function }} [options.adapters]
 * @param {boolean} [options.allowSkip=false] — only for non-authoritative / unit paths
 * @param {boolean} [options.authoritative=true]
 */
async function runIsolatedBuild(options = {}) {
  const repoRoot = path.resolve(options.repoRoot || '.')
  const authoritative = options.authoritative !== false
  const allowSkip = Boolean(options.allowSkip)

  if (options.adapters && typeof options.adapters.build === 'function') {
    const result = await options.adapters.build(repoRoot)
    if (result && result.skipped) {
      if (authoritative && !allowSkip) {
        throw new Error(
          'Refusing launch: build adapter skipped — would allow stale out/. Provide a real build or pass --skip-build (non-authoritative).'
        )
      }
      return {
        skipped: true,
        authoritative: false,
        reason: result.reason || 'build adapter skipped',
        command: DEFAULT_BUILD_COMMAND,
        cwd: repoRoot,
        result
      }
    }
    if (result && typeof result.code === 'number' && result.code !== 0) {
      throw new Error(`Build failed with code ${result.code}`)
    }
    return {
      skipped: false,
      authoritative: true,
      command: DEFAULT_BUILD_COMMAND,
      cwd: repoRoot,
      result: result || { code: 0 }
    }
  }

  if (allowSkip || !authoritative) {
    return {
      skipped: true,
      authoritative: false,
      reason:
        'build adapter not provided — non-authoritative skip; official baseline path requires real build',
      command: DEFAULT_BUILD_COMMAND,
      cwd: repoRoot
    }
  }

  // Authoritative default: real direct-CLI adapter (npx electron-vite build).
  const build = createDirectCliBuildAdapter(options.adapters || {})
  const result = await build(repoRoot)
  return {
    skipped: false,
    authoritative: true,
    command: DEFAULT_BUILD_COMMAND,
    cwd: repoRoot,
    result
  }
}

function shellQuote(value) {
  if (/^[a-zA-Z0-9_./-]+$/.test(value)) return value
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

module.exports = {
  DEFAULT_BUILD_COMMAND,
  buildElectronSpawnPlan,
  resolveElectronBinary,
  createDirectCliBuildAdapter,
  spawnExactElectronChild,
  terminateExactChild,
  assertExactChildAttach,
  assertExactChildOwnsDebugPorts,
  runIsolatedBuild
}
