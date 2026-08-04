'use strict'

/**
 * Exact-child Electron session for T2: build / spawn / attach / terminate.
 *
 * Safety invariants:
 * - Authoritative launch builds the required Swift daemon and Electron bundle (fail-closed)
 * - Spawn resolves local `require('electron')` binary directly (never npx wrapper PID)
 * - Attach only to the spawned child's pid/tree + ports
 * - Terminate only that owned process group / tree
 * - Never pgrep / kill broad targets
 * - Never auto-delete artifacts
 * - All side effects go through injected adapters for unit tests
 */

const path = require('path')
const { buildIsolatedLaunchPlan } = require('./isolatedLaunch.cjs')
const { listListeningPidsForPort, getProcessIdentity } = require('./portGuard.cjs')

const DEFAULT_BRIDGE_BUILD_COMMAND = 'npm run prebuild:bridge-daemon'
const DEFAULT_BRIDGE_BUILD_ARGV = ['run', 'prebuild:bridge-daemon']
const DEFAULT_ELECTRON_BUILD_COMMAND = 'npx electron-vite build'
const DEFAULT_BUILD_ARGV = ['electron-vite', 'build']
const DEFAULT_BUILD_COMMAND = `${DEFAULT_BRIDGE_BUILD_COMMAND} && ${DEFAULT_ELECTRON_BUILD_COMMAND}`

/** Bounded wait for CDP + inspector listeners after spawn (fail closed). */
const DEFAULT_PORT_OWNERSHIP_TIMEOUT_MS = 15_000
const DEFAULT_PORT_OWNERSHIP_INITIAL_DELAY_MS = 50
const DEFAULT_PORT_OWNERSHIP_MAX_DELAY_MS = 500

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
 * @param {string} [options.userDataPath] — recorded for provenance; Electron derives via INSTANCE_ID + HOME
 * @param {string} [options.home] — synthetic isolated HOME propagated into child env (blocker F)
 * @param {NodeJS.Platform} [options.platform=process.platform]
 * @param {{ resolveElectronPath?: Function, requireElectron?: Function }} [options.adapters]
 */
function buildElectronSpawnPlan(options) {
  const base = buildIsolatedLaunchPlan({
    instanceId: options.instanceId,
    remoteDebuggingPort: options.remoteDebuggingPort,
    mainInspectorPort: options.mainInspectorPort,
    workload: options.workload,
    fxPosture: options.fxPosture,
    repoRoot: options.repoRoot,
    home: options.home
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
  if (base.home) {
    env.HOME = base.home
    // Electron's macOS appData path is derived through CoreFoundation, which
    // deliberately ignores HOME. Keep the disposable perf child inside the
    // same proven home without using --user-data-dir (which bypasses the app's
    // own userData authority and would make the inspector proof meaningless).
    if ((options.platform || process.platform) === 'darwin') {
      env.CFFIXED_USER_HOME = base.home
    }
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
  const platform = options.platform || process.platform
  const usesMockKeychain = platform === 'darwin'
  // Direct Electron argv (binary is the spawn command — never `npx`).
  const argv = [
    ...(usesMockKeychain ? ['--use-mock-keychain'] : []),
    entry,
    `--remote-debugging-port=${base.remoteDebuggingPort}`,
    `--inspect=${mainInspectorPort}`
  ]

  const binaryForShell = electronBinary || '<resolve-require-electron-at-spawn>'
  const shellCommand = [
    `TASKWRAITH_INSTANCE_ID=${shellQuote(env.TASKWRAITH_INSTANCE_ID)}`,
    'IOS_REMOTE_TRUE=0',
    ...(env.HOME ? [`HOME=${shellQuote(env.HOME)}`] : []),
    ...(env.CFFIXED_USER_HOME ? [`CFFIXED_USER_HOME=${shellQuote(env.CFFIXED_USER_HOME)}`] : []),
    `${shellQuote(binaryForShell)}${usesMockKeychain ? ' --use-mock-keychain' : ''} ${shellQuote(entry)} --remote-debugging-port=${base.remoteDebuggingPort} --inspect=${mainInspectorPort}`
  ].join(' ')

  return {
    ...base,
    mainInspectorPort,
    env,
    argv,
    electronBinary,
    spawnCommand: electronBinary || binaryForShell,
    shellCommand,
    home: base.home || null,
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
      neverUserDataDirArgv: true,
      isolatedHomePropagated: Boolean(env.HOME),
      coreFoundationHomePropagated: Boolean(env.CFFIXED_USER_HOME),
      disposableMockKeychain: usesMockKeychain,
      notes: [
        `Build from this clean isolated worktree first: ${DEFAULT_BUILD_COMMAND}`,
        'Materialize legacy_v1 fixture into exact TaskWraith Dev <sanitizedId> under isolated HOME before launch',
        'Propagate identical HOME into Electron child env — never --user-data-dir',
        ...(env.CFFIXED_USER_HOME
          ? [
              'Propagate the same isolated CFFIXED_USER_HOME on macOS so app.getPath(userData) cannot escape HOME through CoreFoundation'
            ]
          : []),
        ...(usesMockKeychain
          ? [
              'Use Electron mock Keychain only for this disposable macOS perf child so isolated HOME cannot prompt for or mutate the user login Keychain'
            ]
          : []),
        'Spawn resolve(require("electron")) directly — never npx (wrapper PID ≠ Electron)',
        'Attach CDP/inspector only to the ports owned by the spawned Electron pid/tree',
        'Before replay, main inspector must prove HOME + app.getPath(userData) match expected paths',
        'Terminate only the recorded owned process group; never pgrep/kill TaskWraith broadly',
        'Never auto-delete artifact dirs or userData'
      ]
    }
  }
}

/**
 * Default build adapter: compile the required Swift daemon, then build Electron.
 * Both steps execute directly and fail closed on nonzero.
 * @param {string} repoRoot
 * @param {{ spawn?: Function, spawnSync?: Function }} [adapters]
 */
function createDirectCliBuildAdapter(adapters = {}) {
  return async function directCliBuild(repoRoot) {
    const cwd = path.resolve(repoRoot || '.')
    const steps = [
      {
        command: 'npm',
        argv: DEFAULT_BRIDGE_BUILD_ARGV,
        label: DEFAULT_BRIDGE_BUILD_COMMAND
      },
      { command: 'npx', argv: DEFAULT_BUILD_ARGV, label: DEFAULT_ELECTRON_BUILD_COMMAND }
    ]
    if (typeof adapters.spawnSync === 'function') {
      let stdout = ''
      let stderr = ''
      for (const step of steps) {
        const result = adapters.spawnSync(step.command, step.argv, {
          cwd,
          encoding: 'utf8',
          env: process.env
        })
        const code = result && typeof result.status === 'number' ? result.status : 1
        stdout += result && result.stdout ? String(result.stdout) : ''
        stderr += result && result.stderr ? String(result.stderr) : ''
        if (code !== 0) {
          const err = new Error(
            `${step.label} failed with code ${code}${
              result && result.stderr ? `: ${String(result.stderr).slice(0, 400)}` : ''
            }`
          )
          err.code = code
          throw err
        }
      }
      return { code: 0, command: DEFAULT_BUILD_COMMAND, cwd, stdout, stderr }
    }

    const spawn =
      adapters.spawn ||
      ((cmd, args, opts) => {
        const { spawn: nodeSpawn } = require('child_process')
        return nodeSpawn(cmd, args, opts)
      })

    const runStep = (step) =>
      new Promise((resolve, reject) => {
        const child = spawn(step.command, step.argv, {
          cwd,
          env: process.env,
          stdio: ['ignore', 'pipe', 'pipe']
        })
        if (!child) {
          reject(new Error(`${step.label} failed to spawn`))
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
              `${step.label} missing/failed to execute: ${
                error && error.message ? error.message : error
              }`
            )
          )
        })
        child.on('exit', (code, signal) => {
          const exitCode = typeof code === 'number' ? code : 1
          if (exitCode !== 0) {
            const err = new Error(
              `${step.label} failed with code ${exitCode}${
                signal ? ` signal=${signal}` : ''
              }${stderr ? `: ${stderr.slice(0, 400)}` : ''}`
            )
            err.code = exitCode
            reject(err)
            return
          }
          resolve({ stdout, stderr })
        })
      })

    let stdout = ''
    let stderr = ''
    for (const step of steps) {
      const result = await runStep(step)
      stdout += result.stdout
      stderr += result.stderr
    }
    return { code: 0, command: DEFAULT_BUILD_COMMAND, cwd, stdout, stderr }
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
 * Whether a listener PID is the spawned Electron pid, an explicit owned pid,
 * shares the recorded process group, or is a descendant of the owned tree.
 *
 * @param {number} listenerPid
 * @param {object} session
 * @param {{ getProcessIdentity?: Function, maxAncestorHops?: number }} [adapters]
 * @returns {Promise<boolean>}
 */
async function isPidInOwnedElectronTree(listenerPid, session, adapters = {}) {
  if (!Number.isInteger(listenerPid) || listenerPid <= 0) return false
  if (listenerPid === session.pid) return true
  const ownedPids = Array.isArray(session.ownedPids) ? session.ownedPids : []
  if (ownedPids.includes(listenerPid)) return true

  const resolveIdentity =
    typeof adapters.getProcessIdentity === 'function'
      ? adapters.getProcessIdentity
      : (pid) => getProcessIdentity(pid, adapters)
  const maxHops = adapters.maxAncestorHops == null ? 32 : adapters.maxAncestorHops

  if (session.pgid) {
    const self = await resolveIdentity(listenerPid)
    if (self && self.pgid === session.pgid) return true
  }

  let current = listenerPid
  const seen = new Set()
  for (let hop = 0; hop < maxHops; hop++) {
    if (seen.has(current)) break
    seen.add(current)
    if (current === session.pid || ownedPids.includes(current)) return true
    const identity = await resolveIdentity(current)
    if (!identity) break
    if (session.pgid && identity.pgid === session.pgid) return true
    if (!Number.isInteger(identity.ppid) || identity.ppid <= 0) break
    current = identity.ppid
  }
  return false
}

/**
 * After free-port preflight + spawn, verify BOTH CDP and inspector listeners
 * belong exclusively to the owned Electron pid/process-group/tree.
 *
 * Production default uses an exact-port lsof probe (execFile argv). Empty
 * listener lists never soft-pass — bounded retry/backoff until both ports
 * report listeners, then fail closed on timeout / unsupported probe / foreign PID.
 *
 * @param {object} session
 * @param {{
 *   listPortPids?: (port: number) => Promise<number[]>|number[],
 *   getProcessIdentity?: (pid: number) => Promise<{pid:number,ppid:number,pgid:number}|null>,
 *   sleep?: (ms: number) => Promise<void>,
 *   now?: () => number,
 *   timeoutMs?: number,
 *   initialDelayMs?: number,
 *   maxDelayMs?: number,
 *   probeSupported?: boolean,
 *   execFile?: Function,
 *   lsofPath?: string,
 *   psPath?: string,
 *   platform?: string
 * }} [adapters]
 */
async function assertExactChildOwnsDebugPorts(session, adapters = {}) {
  if (!session || typeof session.pid !== 'number') {
    throw new Error('spawned session required for port ownership check')
  }
  if (adapters.probeSupported === false) {
    throw new Error('Refuse attach: exact-port ownership probe unsupported — refuse attach')
  }

  const listPortPids =
    typeof adapters.listPortPids === 'function'
      ? adapters.listPortPids
      : (port) => listListeningPidsForPort(port, adapters)

  const timeoutMs =
    adapters.timeoutMs == null ? DEFAULT_PORT_OWNERSHIP_TIMEOUT_MS : adapters.timeoutMs
  const initialDelayMs =
    adapters.initialDelayMs == null
      ? DEFAULT_PORT_OWNERSHIP_INITIAL_DELAY_MS
      : adapters.initialDelayMs
  const maxDelayMs =
    adapters.maxDelayMs == null ? DEFAULT_PORT_OWNERSHIP_MAX_DELAY_MS : adapters.maxDelayMs
  const sleep =
    adapters.sleep ||
    ((ms) =>
      new Promise((resolve) => {
        setTimeout(resolve, ms)
      }))
  const now = adapters.now || (() => Date.now())

  const ports = [session.remoteDebuggingPort, session.mainInspectorPort].filter((p) =>
    Number.isInteger(p)
  )
  if (ports.length < 2) {
    throw new Error(
      'Refuse attach: CDP and inspector ports required for exact-child ownership check'
    )
  }
  if (ports[0] === ports[1]) {
    throw new Error('Refuse attach: CDP and inspector ports must be distinct')
  }

  const startedAt = now()
  let delayMs = Math.max(0, initialDelayMs)
  let attempts = 0
  /** @type {Record<number, number[]>} */
  let lastListeners = {}

  while (true) {
    attempts += 1
    lastListeners = {}
    let allPresent = true

    for (const port of ports) {
      let pids
      try {
        pids = await listPortPids(port)
      } catch (error) {
        const message = error && error.message ? error.message : String(error)
        throw new Error(
          `Refuse attach: exact-port ownership probe failed for port ${port}: ${message}`
        )
      }
      if (!Array.isArray(pids)) {
        throw new Error(
          `Refuse attach: exact-port ownership probe returned non-array for port ${port}`
        )
      }
      const unique = [...new Set(pids.filter((pid) => Number.isInteger(pid) && pid > 0))].sort(
        (a, b) => a - b
      )
      lastListeners[port] = unique
      if (unique.length === 0) {
        allPresent = false
        continue
      }
      for (const listenerPid of unique) {
        const owned = await isPidInOwnedElectronTree(listenerPid, session, adapters)
        if (!owned) {
          throw new Error(
            `Refuse attach: port ${port} listener ${listenerPid} is not in owned Electron tree (pid=${session.pid}, pgid=${session.pgid || 'none'}, listeners=${unique.join(',')})`
          )
        }
      }
    }

    if (allPresent) {
      return {
        ok: true,
        attempts,
        elapsedMs: Math.max(0, now() - startedAt),
        listeners: lastListeners
      }
    }

    const elapsed = Math.max(0, now() - startedAt)
    if (elapsed >= timeoutMs) {
      const detail = ports
        .map((port) => `${port}=[${(lastListeners[port] || []).join(',') || 'none'}]`)
        .join(' ')
      throw new Error(
        `Refuse attach: timed out after ${elapsed}ms waiting for CDP+inspector listeners owned by Electron tree (pid=${session.pid}); last ${detail}`
      )
    }

    await sleep(delayMs)
    delayMs = Math.min(maxDelayMs, Math.max(1, Math.ceil(delayMs * 1.5)) || maxDelayMs)
  }
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

  // Authoritative default: real Swift-daemon + Electron direct-CLI build.
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
  DEFAULT_PORT_OWNERSHIP_TIMEOUT_MS,
  DEFAULT_PORT_OWNERSHIP_INITIAL_DELAY_MS,
  DEFAULT_PORT_OWNERSHIP_MAX_DELAY_MS,
  buildElectronSpawnPlan,
  resolveElectronBinary,
  createDirectCliBuildAdapter,
  spawnExactElectronChild,
  terminateExactChild,
  assertExactChildAttach,
  assertExactChildOwnsDebugPorts,
  isPidInOwnedElectronTree,
  runIsolatedBuild
}
