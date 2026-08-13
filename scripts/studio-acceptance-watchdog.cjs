'use strict'

/**
 * Detached owner for one Studio acceptance child.
 *
 * The acceptance harness never spawns Electron itself. It forks this controller
 * first and sends one launch spec over a private IPC channel. The controller
 * then creates the target's dedicated process group and remains alive until it
 * exits. If the harness dies, the IPC channel closes and this process reaps the
 * exact recorded group. That ordering removes the spawn-before-watchdog race
 * which stranded the original acceptance Electron.
 */

const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')

// v2 receipts carry `groupExitVerified`. A v1 receipt cannot distinguish "the
// whole group is gone" from "the group leader exited and we assumed the rest
// followed", so readers must treat every v1 receipt as unverified.
const RECEIPT_SCHEMA_VERSION = 2
const MAX_TAIL_BYTES = 8 * 1024
const DEFAULT_FORCE_AFTER_MS = 4_000
const GROUP_EXIT_POLL_MS = 50
const GROUP_EXIT_GRACE_MS = 5_000
const MIN_RUN_TIMEOUT_MS = 30_000
const MAX_RUN_TIMEOUT_MS = 30 * 60 * 1_000

let child = null
let spec = null
let childPgid = null
let stderrTail = ''
let stdoutTail = ''
let reapingReason = null
let forceTimer = null
let deadlineTimer = null
let groupExitTimer = null
let terminal = false

function boundedTail(previous, chunk) {
  const next = previous + String(chunk)
  return next.length <= MAX_TAIL_BYTES ? next : next.slice(-MAX_TAIL_BYTES)
}

function send(message) {
  if (!process.connected) return
  try {
    process.send(message)
  } catch {
    // The owner disappearing is handled by the disconnect event.
  }
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function requireAbsolutePath(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path`)
  }
  return path.resolve(value)
}

function validateSpec(candidate) {
  if (!isRecord(candidate)) throw new Error('launch spec must be an object')
  const kind = candidate.kind
  if (kind !== 'electron' && kind !== 'stub') {
    throw new Error('launch spec kind must be electron or stub')
  }
  if (kind === 'stub' && process.env.TASKWRAITH_STUDIO_ACCEPTANCE_TEST !== '1') {
    throw new Error('stub launch is test-only')
  }

  const command = requireAbsolutePath(candidate.command, 'command')
  if (path.basename(command).toLowerCase() === 'npx') {
    throw new Error('refuse wrapper process: command must be the exact executable')
  }
  const cwd = requireAbsolutePath(candidate.cwd, 'cwd')
  const receiptPath = requireAbsolutePath(candidate.receiptPath, 'receiptPath')
  if (!Array.isArray(candidate.args) || !candidate.args.every((arg) => typeof arg === 'string')) {
    throw new Error('args must be an array of strings')
  }
  if (!isRecord(candidate.env)) throw new Error('env must be an object')
  const env = {}
  for (const [key, value] of Object.entries(candidate.env)) {
    if (typeof value !== 'string') throw new Error(`env.${key} must be a string`)
    env[key] = value
  }

  const timeoutMs = Number(candidate.timeoutMs)
  const minimum = kind === 'stub' ? 100 : MIN_RUN_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < minimum || timeoutMs > MAX_RUN_TIMEOUT_MS) {
    throw new Error(`timeoutMs must be an integer ${minimum}–${MAX_RUN_TIMEOUT_MS}`)
  }
  const forceAfterMs =
    candidate.forceAfterMs === undefined ? DEFAULT_FORCE_AFTER_MS : Number(candidate.forceAfterMs)
  if (!Number.isSafeInteger(forceAfterMs) || forceAfterMs < 50 || forceAfterMs > 30_000) {
    throw new Error('forceAfterMs must be an integer 50–30000')
  }

  if (kind === 'electron') {
    const instanceId = env.TASKWRAITH_INSTANCE_ID
    if (typeof instanceId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{1,15}$/.test(instanceId)) {
      throw new Error('Electron launch requires a sanitized 2–16 character TASKWRAITH_INSTANCE_ID')
    }
    if (env.IOS_REMOTE_TRUE !== '0') {
      throw new Error('Electron launch must force IOS_REMOTE_TRUE=0')
    }
    if (env.TASKWRAITH_STUDIO_COMPANION !== '1') {
      throw new Error('Electron launch must explicitly enable the Studio companion')
    }
    if (process.platform === 'darwin' && !candidate.args.includes('--use-mock-keychain')) {
      throw new Error('macOS acceptance launch requires --use-mock-keychain')
    }
    if (candidate.args.some((arg) => arg.startsWith('--user-data-dir'))) {
      throw new Error('refuse --user-data-dir; TASKWRAITH_INSTANCE_ID owns profile isolation')
    }
  }

  return {
    kind,
    command,
    cwd,
    receiptPath,
    args: [...candidate.args],
    env,
    timeoutMs,
    forceAfterMs
  }
}

function receipt(status, extra = {}) {
  if (!spec) return
  const payload = {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    kind: 'taskwraith-studio-acceptance-watchdog',
    status,
    controllerPid: process.pid,
    childPid: child && Number.isInteger(child.pid) ? child.pid : null,
    childPgid,
    instanceId: spec.env.TASKWRAITH_INSTANCE_ID || null,
    command: spec.command,
    startedAt: receipt.startedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    stdoutTail,
    stderrTail,
    ...extra
  }
  receipt.startedAt = payload.startedAt
  const directory = path.dirname(spec.receiptPath)
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const tempPath = `${spec.receiptPath}.tmp-${process.pid}`
  fs.writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  })
  fs.renameSync(tempPath, spec.receiptPath)
}

function signalOwnedGroup(signal) {
  if (!child || !Number.isInteger(child.pid) || child.pid <= 0) return
  if (childPgid && process.platform !== 'win32') {
    try {
      process.kill(-childPgid, signal)
      return
    } catch (error) {
      if (!error || error.code !== 'ESRCH') {
        try {
          child.kill(signal)
        } catch {
          // The force timer and exit observation retain the exact outcome.
        }
        return
      }
    }
  }
  try {
    child.kill(signal)
  } catch {
    // The child may already have exited; its exit event finalizes the receipt.
  }
}

/**
 * Exact process-GROUP liveness. `kill(-pgid, 0)` is the POSIX existence probe
 * for a whole group: ESRCH means every member is gone, EPERM means at least one
 * member survives but is not ours to signal, and success means members remain.
 *
 * This deliberately does not scrape `ps`. A reaper must not depend on spawning
 * and parsing another process while it is trying to prove a group died.
 */
function ownedGroupHasMembers() {
  if (process.platform === 'win32' || !childPgid) return false
  try {
    process.kill(-childPgid, 0)
    return true
  } catch (error) {
    return Boolean(error) && error.code !== 'ESRCH'
  }
}

function forceKillOwnedGroup() {
  if (process.platform === 'win32' || !childPgid) return
  try {
    process.kill(-childPgid, 'SIGKILL')
  } catch {
    // ESRCH only means the group is already gone; the poll below confirms it.
  }
}

function complete(status, extra = {}) {
  if (terminal) return
  terminal = true
  if (forceTimer) clearTimeout(forceTimer)
  if (deadlineTimer) clearTimeout(deadlineTimer)
  if (groupExitTimer) clearTimeout(groupExitTimer)
  receipt(status, extra)
  send({
    type: 'terminal',
    status,
    childPid: child && Number.isInteger(child.pid) ? child.pid : null,
    childPgid,
    groupExitVerified: extra.groupExitVerified === true,
    reason: extra.reason || null,
    receiptPath: spec && spec.receiptPath
  })
  setImmediate(() =>
    process.exit(status === 'spawn_failed' || status === 'reap_incomplete' ? 1 : 0)
  )
}

/**
 * The group leader exiting does NOT mean the group is gone — a descendant that
 * ignores SIGTERM outlives it, which is exactly how a "reaped" receipt used to
 * be written over a surviving process. Terminal status therefore waits for the
 * exact PGID to disappear, escalating to SIGKILL, and records whether that was
 * actually observed. A group that outlives the grace window finalizes as
 * `reap_incomplete` instead of claiming a clean reap.
 */
function finalizeAfterChildExit(status, extra) {
  if (terminal) return
  if (!ownedGroupHasMembers()) {
    complete(status, { ...extra, groupExitVerified: true })
    return
  }

  receipt('group_survived_leader', extra)
  forceKillOwnedGroup()
  const deadline = Date.now() + GROUP_EXIT_GRACE_MS
  const poll = () => {
    if (terminal) return
    if (!ownedGroupHasMembers()) {
      complete(status, { ...extra, groupExitVerified: true, groupRequiredForceKill: true })
      return
    }
    if (Date.now() >= deadline) {
      complete('reap_incomplete', {
        ...extra,
        groupExitVerified: false,
        error: `process group ${childPgid} still had members ${GROUP_EXIT_GRACE_MS}ms after SIGKILL`
      })
      return
    }
    groupExitTimer = setTimeout(poll, GROUP_EXIT_POLL_MS)
  }
  groupExitTimer = setTimeout(poll, GROUP_EXIT_POLL_MS)
}

function beginReap(reason) {
  if (terminal || reapingReason) return
  reapingReason = reason
  receipt('reaping', { reason })
  signalOwnedGroup('SIGTERM')
  forceTimer = setTimeout(() => {
    signalOwnedGroup('SIGKILL')
    receipt('force_kill_sent', { reason })
  }, spec.forceAfterMs)
}

function launch(candidate) {
  if (spec || child) throw new Error('controller accepts exactly one launch')
  spec = validateSpec(candidate)
  if (!process.connected) {
    throw new Error('owner IPC disconnected before launch')
  }

  child = spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env: { ...process.env, ...spec.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32'
  })
  if (!child || !Number.isInteger(child.pid) || child.pid <= 0) {
    throw new Error('target spawn returned no pid')
  }
  childPgid = process.platform === 'win32' ? null : child.pid

  child.stdout?.on('data', (chunk) => {
    stdoutTail = boundedTail(stdoutTail, chunk)
  })
  child.stderr?.on('data', (chunk) => {
    stderrTail = boundedTail(stderrTail, chunk)
  })
  child.once('error', (error) => {
    complete('spawn_failed', {
      reason: 'child_error',
      error: error instanceof Error ? error.message : String(error)
    })
  })
  child.once('exit', (code, signal) => {
    finalizeAfterChildExit(reapingReason ? 'reaped' : 'exited', {
      reason: reapingReason || 'child_exit',
      exitCode: code,
      signal
    })
  })

  receipt('running', { deadlineAt: new Date(Date.now() + spec.timeoutMs).toISOString() })
  send({
    type: 'launched',
    controllerPid: process.pid,
    childPid: child.pid,
    childPgid,
    receiptPath: spec.receiptPath
  })
  deadlineTimer = setTimeout(() => beginReap('deadline_exceeded'), spec.timeoutMs)

  // The owner may have died synchronously after sending the launch message.
  if (!process.connected) beginReap('owner_disconnected')
}

process.on('message', (message) => {
  try {
    if (!isRecord(message)) throw new Error('controller message must be an object')
    if (message.type === 'launch') launch(message.spec)
    else if (message.type === 'stop') beginReap('owner_requested')
    else throw new Error('unknown controller message')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (spec) {
      complete('spawn_failed', { reason: 'invalid_launch', error: message })
    } else {
      send({ type: 'error', error: message })
      setImmediate(() => process.exit(1))
    }
  }
})

process.on('disconnect', () => {
  if (child) beginReap('owner_disconnected')
  else setImmediate(() => process.exit(0))
})

process.on('SIGTERM', () => {
  if (child) beginReap('controller_sigterm')
  else process.exit(0)
})
process.on('SIGINT', () => {
  if (child) beginReap('controller_sigint')
  else process.exit(0)
})
