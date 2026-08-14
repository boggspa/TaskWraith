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
const { spawn, spawnSync } = require('node:child_process')

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
const PROCESS_TABLE_MAX_BYTES = 2 * 1024 * 1024
const PROCESS_TABLE_TIMEOUT_MS = 2_000
const INSTALLED_TASKWRAITH_EXECUTABLE = '/Applications/TaskWraith.app/Contents/MacOS/TaskWraith'
const INSTALLED_STUDIO_EXECUTABLE =
  '/Applications/TaskWraith.app/Contents/Resources/studio/TaskWraith Studio.app/Contents/MacOS/TaskWraithStudioCompanion'

let child = null
let spec = null
let childPgid = null
let stderrTail = ''
let stdoutTail = ''
let reapingReason = null
let forceTimer = null
let forceKillSentAt = null
let deadlineTimer = null
let groupExitTimer = null
let terminal = false
let artifactHome = null
let artifactHomeAliases = []
let baselineRows = []
let artifactScanError = null
let lastProcessRows = []
let detachedSafetyState = {
  lostOwnershipGroups: [],
  mixedOwnershipGroups: [],
  protectedInstalledGroups: []
}
const detachedProcessGroups = new Map()

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

function parseProcessRows(stdout) {
  const rows = []
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line)
    if (!match) continue
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      command: match[4]
    })
  }
  return rows
}

function sampleProcessRows() {
  const result = spawnSync('/bin/ps', ['-axww', '-o', 'pid=,ppid=,pgid=,command='], {
    encoding: 'utf8',
    timeout: PROCESS_TABLE_TIMEOUT_MS,
    maxBuffer: PROCESS_TABLE_MAX_BYTES
  })
  if (result.error || result.status !== 0 || typeof result.stdout !== 'string') {
    artifactScanError = String(
      result.error?.message || result.stderr || `ps exited with status ${String(result.status)}`
    ).slice(0, 1000)
    return null
  }
  artifactScanError = null
  lastProcessRows = parseProcessRows(result.stdout)
  return lastProcessRows
}

function commandContainsBoundedPath(command, boundedPath) {
  let offset = 0
  while (offset <= command.length) {
    const index = command.indexOf(boundedPath, offset)
    if (index < 0) return false
    const before = index === 0 ? '' : command[index - 1]
    const afterIndex = index + boundedPath.length
    const after = afterIndex >= command.length ? '' : command[afterIndex]
    const beforeIsBoundary = index === 0 || /[\s="'(,]/.test(before)
    const afterIsBoundary = after === '' || after === path.sep || /[\s"'),:]/.test(after)
    if (beforeIsBoundary && afterIsBoundary) return true
    offset = index + boundedPath.length
  }
  return false
}

function commandReferencesAnyArtifactHome(command, aliases) {
  return aliases.some((home) => commandContainsBoundedPath(command, home))
}

function processRowIdentity(row) {
  return JSON.stringify([row.pid, row.ppid, row.pgid, row.command])
}

function commandRunsExactExecutable(command, executable) {
  return command === executable || command.startsWith(`${executable} `)
}

function classifyDetachedArtifactGroups({
  rows,
  artifactHomeAliases: aliases,
  baselineRows: initialRows,
  childPgid: primaryPgid,
  knownPgids
}) {
  const baselineIdentities = new Set(initialRows.map(processRowIdentity))
  const known = new Set(knownPgids)
  const candidatePgids = new Set(known)
  for (const row of rows) {
    if (
      Number.isSafeInteger(row.pgid) &&
      row.pgid > 0 &&
      row.pgid !== primaryPgid &&
      commandReferencesAnyArtifactHome(row.command, aliases)
    ) {
      candidatePgids.add(row.pgid)
    }
  }

  const groups = new Map()
  for (const row of rows) {
    if (!candidatePgids.has(row.pgid) || row.pgid === primaryPgid) continue
    const members = groups.get(row.pgid) || []
    members.push(row)
    groups.set(row.pgid, members)
  }

  const authorizedGroups = []
  const lostOwnershipGroups = []
  const mixedOwnershipGroups = []
  const protectedInstalledGroups = []
  for (const [pgid, unsortedMembers] of [...groups.entries()].sort(
    ([left], [right]) => left - right
  )) {
    const members = [...unsortedMembers].sort((left, right) => left.pid - right.pid)
    const memberPids = members.map((member) => member.pid)
    const evidencePids = members
      .filter((member) => commandReferencesAnyArtifactHome(member.command, aliases))
      .map((member) => member.pid)
    const baselinePids = members
      .filter((member) => baselineIdentities.has(processRowIdentity(member)))
      .map((member) => member.pid)
    const containsInstalledExecutable = members.some(
      (member) =>
        commandRunsExactExecutable(member.command, INSTALLED_TASKWRAITH_EXECUTABLE) ||
        commandRunsExactExecutable(member.command, INSTALLED_STUDIO_EXECUTABLE)
    )

    if (containsInstalledExecutable) {
      protectedInstalledGroups.push({ pgid, memberPids })
    } else if (baselinePids.length > 0) {
      mixedOwnershipGroups.push({ pgid, memberPids, baselinePids })
    } else if (evidencePids.length > 0) {
      authorizedGroups.push({ pgid, evidencePids, members })
    } else if (known.has(pgid)) {
      lostOwnershipGroups.push({ pgid, memberPids })
    }
  }

  return {
    authorizedGroups,
    lostOwnershipGroups,
    mixedOwnershipGroups,
    protectedInstalledGroups
  }
}

function rememberArtifactBoundGroups(rows) {
  const candidates = new Map()
  for (const row of rows) {
    if (
      !Number.isSafeInteger(row.pgid) ||
      row.pgid <= 0 ||
      row.pgid === childPgid ||
      !commandReferencesAnyArtifactHome(row.command, artifactHomeAliases)
    ) {
      continue
    }
    const evidencePids = candidates.get(row.pgid) || []
    evidencePids.push(row.pid)
    candidates.set(row.pgid, evidencePids)
  }

  for (const [pgid, evidencePids] of candidates.entries()) {
    const members = rows.filter((row) => row.pgid === pgid)
    const known = detachedProcessGroups.get(pgid) || {
      pgid,
      evidencePids: new Set(),
      memberPids: new Set(),
      requiredForceKill: false
    }
    for (const pid of evidencePids) known.evidencePids.add(pid)
    for (const member of members) known.memberPids.add(member.pid)
    detachedProcessGroups.set(pgid, known)
  }
}

function refreshDetachedSafetyState() {
  if (!artifactHome || process.platform === 'win32') {
    detachedSafetyState = {
      lostOwnershipGroups: [],
      mixedOwnershipGroups: [],
      protectedInstalledGroups: []
    }
    return {
      authorizedGroups: [],
      ...detachedSafetyState
    }
  }
  const rows = sampleProcessRows()
  if (!rows) return null
  rememberArtifactBoundGroups(rows)
  const classification = classifyDetachedArtifactGroups({
    rows,
    artifactHomeAliases,
    baselineRows,
    childPgid,
    knownPgids: [...detachedProcessGroups.keys()]
  })
  detachedSafetyState = {
    lostOwnershipGroups: classification.lostOwnershipGroups,
    mixedOwnershipGroups: classification.mixedOwnershipGroups,
    protectedInstalledGroups: classification.protectedInstalledGroups
  }
  return classification
}

function detachedGroupsHaveMembers() {
  const classification = refreshDetachedSafetyState()
  if (!classification) return true
  return (
    classification.authorizedGroups.length > 0 ||
    classification.lostOwnershipGroups.length > 0 ||
    classification.mixedOwnershipGroups.length > 0 ||
    classification.protectedInstalledGroups.length > 0
  )
}

function signalDetachedProcessGroups(signal) {
  const classification = refreshDetachedSafetyState()
  if (!classification) return false
  for (const group of classification.authorizedGroups) {
    try {
      process.kill(-group.pgid, signal)
      if (signal === 'SIGKILL') {
        const known = detachedProcessGroups.get(group.pgid)
        if (known) known.requiredForceKill = true
      }
    } catch {
      // ESRCH means the exact freshly-authorized group is already gone. The poll proves it.
    }
  }
  return true
}

function detachedManualAdjudicationError() {
  const parts = []
  if (detachedSafetyState.lostOwnershipGroups.length > 0) {
    parts.push(
      `lost ownership pgids=${detachedSafetyState.lostOwnershipGroups
        .map((group) => group.pgid)
        .join(',')}`
    )
  }
  if (detachedSafetyState.mixedOwnershipGroups.length > 0) {
    parts.push(
      `mixed baseline pgids=${detachedSafetyState.mixedOwnershipGroups
        .map((group) => group.pgid)
        .join(',')}`
    )
  }
  if (detachedSafetyState.protectedInstalledGroups.length > 0) {
    parts.push(
      `installed-app pgids=${detachedSafetyState.protectedInstalledGroups
        .map((group) => group.pgid)
        .join(',')}`
    )
  }
  return parts.length > 0
    ? `detached process groups require manual adjudication: ${parts.join('; ')}`
    : null
}

function detachedProcessGroupReceipt() {
  return [...detachedProcessGroups.values()]
    .sort((left, right) => left.pgid - right.pgid)
    .map((group) => ({
      pgid: group.pgid,
      evidencePids: [...group.evidencePids].sort((left, right) => left - right),
      memberPids: [...group.memberPids].sort((left, right) => left - right),
      ...(group.requiredForceKill ? { requiredForceKill: true } : {})
    }))
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
    artifactHome,
    artifactHomeAliases,
    baselineProcessCount: baselineRows.length,
    detachedProcessGroups: detachedProcessGroupReceipt(),
    lostOwnershipGroups: detachedSafetyState.lostOwnershipGroups,
    mixedOwnershipGroups: detachedSafetyState.mixedOwnershipGroups,
    protectedInstalledGroups: detachedSafetyState.protectedInstalledGroups,
    ...(artifactScanError ? { artifactScanError } : {}),
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
  if (process.platform !== 'win32' && childPgid) {
    try {
      process.kill(-childPgid, 'SIGKILL')
    } catch {
      // ESRCH only means the group is already gone; the poll below confirms it.
    }
  }
  signalDetachedProcessGroups('SIGKILL')
}

function scheduleForceKill(reason) {
  if (terminal || forceTimer || forceKillSentAt !== null) return
  forceTimer = setTimeout(() => {
    forceTimer = null
    forceKillSentAt = Date.now()
    forceKillOwnedGroup()
    receipt('force_kill_sent', { reason })
  }, spec.forceAfterMs)
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
    detachedGroupExitVerified: extra.detachedGroupExitVerified === true,
    detachedProcessGroups: detachedProcessGroupReceipt(),
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
  const groupsHaveMembers = () => ({
    primary: ownedGroupHasMembers(),
    detached: detachedGroupsHaveMembers()
  })
  const first = groupsHaveMembers()
  if (!first.primary && !first.detached) {
    complete(status, {
      ...extra,
      groupExitVerified: true,
      detachedGroupExitVerified: true,
      ...(forceKillSentAt !== null ? { groupRequiredForceKill: true } : {})
    })
    return
  }

  receipt('group_survived_leader', {
    ...extra,
    primaryGroupSurvived: first.primary,
    detachedGroupSurvived: first.detached
  })
  if (!reapingReason) {
    signalOwnedGroup('SIGTERM')
    signalDetachedProcessGroups('SIGTERM')
    scheduleForceKill(extra.reason || 'child_exit')
  }
  const poll = () => {
    if (terminal) return
    const remaining = groupsHaveMembers()
    if (!remaining.primary && !remaining.detached) {
      complete(status, {
        ...extra,
        groupExitVerified: true,
        detachedGroupExitVerified: true,
        ...(forceKillSentAt !== null ? { groupRequiredForceKill: true } : {})
      })
      return
    }
    if (forceKillSentAt !== null && Date.now() >= forceKillSentAt + GROUP_EXIT_GRACE_MS) {
      complete('reap_incomplete', {
        ...extra,
        groupExitVerified: !remaining.primary,
        detachedGroupExitVerified: !remaining.detached,
        error: artifactScanError
          ? `artifact-bound process scan failed during cleanup: ${artifactScanError}`
          : detachedManualAdjudicationError() ||
            `owned process groups still had members ${GROUP_EXIT_GRACE_MS}ms after cleanup (primary=${String(
              remaining.primary
            )}, detached=${String(remaining.detached)})`
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
  signalDetachedProcessGroups('SIGTERM')
  scheduleForceKill(reason)
}

function launch(candidate) {
  if (spec || child) throw new Error('controller accepts exactly one launch')
  spec = validateSpec(candidate)
  if (!process.connected) {
    throw new Error('owner IPC disconnected before launch')
  }

  if (typeof spec.env.HOME === 'string') {
    const configuredHome = requireAbsolutePath(spec.env.HOME, 'env.HOME')
    artifactHome = fs.realpathSync(configuredHome)
    artifactHomeAliases = [...new Set([configuredHome, artifactHome])]
    if (artifactHome === path.parse(artifactHome).root) {
      throw new Error('env.HOME must identify a bounded disposable acceptance directory')
    }
    const capturedBaselineRows = sampleProcessRows()
    if (!capturedBaselineRows) {
      throw new Error(`could not capture pre-launch process baseline: ${artifactScanError}`)
    }
    baselineRows = capturedBaselineRows
  } else if (spec.kind === 'electron') {
    throw new Error('Electron launch requires an absolute disposable env.HOME')
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

function installControllerHandlers() {
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
}

if (require.main === module) installControllerHandlers()

module.exports = {
  classifyDetachedArtifactGroups
}
