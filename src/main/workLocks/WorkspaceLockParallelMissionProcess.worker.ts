/**
 * Cross-process worker for WorkspaceLockParallelMission.process.integration.test.
 *
 * Runnable via `child_process.fork` with argv:
 *   --role=holder|contender|lease-holder|reclaimer
 *   --userDataRoot=...
 *   --workspacePath=...
 *   --targetPath=...
 *   --runId=...
 *   --lockOwnerId=...
 *   --holdMs=200          (holder only; fail-closed parent-signal deadline)
 *   --retryTimeoutMs=5000 (contender and reclaimer)
 *   --identity=registry|production (default registry)
 *   --identityRegistry=...  shared JSON map pid → processBirthIdentity (registry only)
 *   --heartbeatIntervalMs, --heartbeatTtlMs, --reclaimGraceMs, --scanIntervalMs,
 *   --suspendGapMs        (lease-holder and reclaimer: holder-lease timings)
 *   --holdCommitFence=1   (lease-holder only: also take the claim's commit-fence
 *                          partition, as an executor mid-commit would)
 *
 * `holder`/`contender` use production WorkspaceLockAuthority +
 * NodeWorkspaceLockPersistence with a registry stand-in for process-birth
 * observation: exact birth identities are published to a shared JSON file.
 * Unknown live PIDs remain identity_unavailable; ESRCH is dead.
 *
 * `lease-holder`/`reclaimer` observe processes through the production
 * WorkspaceLockProcessIdentityService (the Swift bridge's proc_bsdinfo on
 * darwin, boot id + /proc start ticks on linux), so a holder the parent
 * SIGKILLs or SIGSTOPs is dead or lapsed by the operating system's account,
 * not by an injected observation. Both read the real commit fence through the
 * runtime's own port. The reclaimer boots first and never reopens: the
 * holder's lease is then `held` by the holder's own incarnation (no boot
 * relabel ever touches it), and only the periodic reclaim-only pass can free it.
 *
 * IPC (worker → parent): ready | opened | acquired | conflict | released | verified |
 *   scanned | error | done
 * IPC (parent → lease-holder): verify | exit;  (parent → reclaimer): contend | scan | exit
 */

import { randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

import {
  resolveCanonicalWorkspaceLockPath,
  verifyCanonicalWorkspaceLockPath
} from './CanonicalWorkspaceLockPath'
import { WorkspaceLockProcessIdentityService } from '../WorkspaceLockProcessIdentity'
import { mutationFencePartitionKeys, readCommitFenceOwnerForClaim } from '../WorkspaceLockRuntime'
import { NodeWorkspaceLockPersistence } from './NodeWorkspaceLockPersistence'
import {
  WorkspaceLockAuthority,
  type WorkspaceLockHolderLeaseOptions,
  type WorkspaceLockPeriodicRecoveryOutcome
} from './WorkspaceLockAuthority'
import { WorkspaceMutationCommitFence } from './WorkspaceMutationCommitFence'
import type {
  WorkspaceLockAcquireResult,
  WorkspaceLockAuthorityDependencies,
  WorkspaceLockOwner,
  WorkspaceLockProcessObservation,
  WorkspaceLockSnapshot
} from './WorkspaceLockTypes'

type Role = 'holder' | 'contender' | 'lease-holder' | 'reclaimer'

interface WorkerArgs {
  role: Role
  userDataRoot: string
  workspacePath: string
  targetPath: string
  runId: string
  lockOwnerId: string
  holdMs: number
  retryTimeoutMs: number
  laneId: string
  displayName: string
  identity: 'registry' | 'production'
  identityRegistry: string
  holderLease: WorkspaceLockHolderLeaseOptions
  holdCommitFence: boolean
}

interface WorkerMessage {
  type:
    | 'ready'
    | 'opened'
    | 'acquired'
    | 'conflict'
    | 'released'
    | 'verified'
    | 'scanned'
    | 'error'
    | 'done'
  role?: Role
  runId?: string
  pid?: number
  ok?: boolean
  reason?: string
  holderRunIds?: string[]
  transitionId?: string
  instanceId?: string
  leaseId?: string
  fenceHeld?: boolean
  /** Worker wall clock when the reported event happened. */
  atMs?: number
  /** One periodic pass run on request (the timer runs the same pass). */
  outcome?: WorkspaceLockPeriodicRecoveryOutcome
  holderLiveness?: WorkspaceLockSnapshot['holderLiveness']
  leases?: Array<{ leaseId: string; status: string }>
  message?: string
  status?: 'ok' | 'failed'
}

const HOLDER_LEASE_ARGS = [
  'heartbeatIntervalMs',
  'heartbeatTtlMs',
  'reclaimGraceMs',
  'scanIntervalMs',
  'suspendGapMs'
] as const

function parseArgs(argv: string[]): WorkerArgs {
  const map = new Map<string, string>()
  for (const token of argv) {
    if (!token.startsWith('--')) continue
    const eq = token.indexOf('=')
    if (eq <= 2) continue
    map.set(token.slice(2, eq), token.slice(eq + 1))
  }
  const role = map.get('role')
  if (
    role !== 'holder' &&
    role !== 'contender' &&
    role !== 'lease-holder' &&
    role !== 'reclaimer'
  ) {
    throw new Error(
      `Worker requires --role=holder|contender|lease-holder|reclaimer (got ${role ?? 'missing'})`
    )
  }
  const identity = map.get('identity') || 'registry'
  if (identity !== 'registry' && identity !== 'production') {
    throw new Error(`Worker requires --identity=registry|production (got ${identity})`)
  }
  const required = ['userDataRoot', 'workspacePath', 'targetPath', 'runId', 'lockOwnerId'] as const
  for (const key of required) {
    if (!map.get(key)) throw new Error(`Worker requires --${key}=...`)
  }
  if (identity === 'registry' && !map.get('identityRegistry')) {
    throw new Error('Worker requires --identityRegistry=... for registry identity')
  }
  const holderLease: WorkspaceLockHolderLeaseOptions = {}
  for (const key of HOLDER_LEASE_ARGS) {
    const raw = map.get(key)
    if (raw !== undefined) holderLease[key] = Number(raw)
  }
  return {
    role,
    userDataRoot: map.get('userDataRoot')!,
    workspacePath: map.get('workspacePath')!,
    targetPath: map.get('targetPath')!,
    runId: map.get('runId')!,
    lockOwnerId: map.get('lockOwnerId')!,
    holdMs: Number(map.get('holdMs') || '150'),
    retryTimeoutMs: Number(map.get('retryTimeoutMs') || '8000'),
    laneId: map.get('laneId') || `lane-${role}`,
    displayName: map.get('displayName') || `process-${role}`,
    identity,
    identityRegistry: map.get('identityRegistry') || '',
    holderLease,
    holdCommitFence: map.get('holdCommitFence') === '1'
  }
}

function readIdentityRegistry(registryPath: string): Record<string, string> {
  try {
    const raw = fs.readFileSync(registryPath, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string' && value.length > 0) out[key] = value
    }
    return out
  } catch {
    return {}
  }
}

function publishIdentity(registryPath: string, pid: number, processBirthIdentity: string): void {
  const dir = path.dirname(registryPath)
  fs.mkdirSync(dir, { recursive: true })
  // Best-effort merge; tests use one writer at a time per pid key.
  const current = readIdentityRegistry(registryPath)
  current[String(pid)] = processBirthIdentity
  fs.writeFileSync(registryPath, `${JSON.stringify(current)}\n`, 'utf8')
}

function send(message: WorkerMessage): void {
  if (typeof process.send === 'function') {
    process.send(message)
  } else {
    // Allow direct CLI debug runs without an IPC parent.
    process.stdout.write(`${JSON.stringify(message)}\n`)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function waitForParentRelease(holdMs: number): Promise<void> {
  return waitForParentSignal('holder', 'release', holdMs)
}

function waitForParentSignal(role: Role, type: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => {
        cleanup()
        reject(new Error(`${role} timed out waiting for parent ${type} signal (${timeoutMs}ms)`))
      },
      Math.max(50, timeoutMs)
    )

    const onMessage = (raw: unknown) => {
      const message = raw as { type?: string }
      if (message && message.type === type) {
        cleanup()
        resolve()
      }
    }

    const cleanup = () => {
      clearTimeout(timer)
      process.off('message', onMessage)
    }

    process.on('message', onMessage)
  })
}

/**
 * Production-equivalent process observation for a forked worker:
 * - exact birth identity for this process (published to shared registry)
 * - peer identities resolved from the registry when the OS still reports live
 * - never invents a birth identity for an unregistered live PID
 * - reports dead only on conclusive ESRCH
 */
function createProcessDependencies(
  instanceId: string,
  processBirthIdentity: string,
  identityRegistry: string
): WorkspaceLockAuthorityDependencies {
  let idSeq = 0
  return {
    nowIso: () => new Date().toISOString(),
    nextId: (kind) => `${kind}-${process.pid}-${++idSeq}-${randomBytes(4).toString('hex')}`,
    observeProcess: async (pid): Promise<WorkspaceLockProcessObservation> => {
      if (pid === process.pid) {
        return { state: 'live', processBirthIdentity }
      }
      try {
        process.kill(pid, 0)
        const registry = readIdentityRegistry(identityRegistry)
        const known = registry[String(pid)]
        if (known) return { state: 'live', processBirthIdentity: known }
        // Live but birth-identity unknown — fail closed (no PID-only steal).
        return { state: 'identity_unavailable' }
      } catch (error) {
        const code =
          error && typeof error === 'object' && 'code' in error
            ? (error as { code?: unknown }).code
            : undefined
        return code === 'ESRCH' ? { state: 'dead' } : { state: 'identity_unavailable' }
      }
    },
    canonicalizePath: (input) => {
      try {
        return fs.realpathSync(input)
      } catch {
        return path.resolve(input)
      }
    },
    resolveTargetPath: (rootPath, targetPath) =>
      resolveCanonicalWorkspaceLockPath({ rootPath, targetPath }),
    verifyTargetPath: (expected) => verifyCanonicalWorkspaceLockPath(expected),
    validateHunkBaseline: async () => true,
    instance: {
      instanceId,
      pid: process.pid,
      processBirthIdentity
    }
  }
}

/**
 * Production process-birth observation and the runtime's own read-only fence
 * port, over the same root the authority uses: no registry, no injected verdict.
 */
function createProductionDependencies(
  instanceId: string,
  processBirthIdentity: string,
  identity: WorkspaceLockProcessIdentityService,
  fence: WorkspaceMutationCommitFence
): WorkspaceLockAuthorityDependencies {
  return {
    // The registry path is never read: observeProcess is replaced below.
    ...createProcessDependencies(instanceId, processBirthIdentity, ''),
    observeProcess: (pid) => identity.observe(pid),
    readCommitFenceOwner: (claim) => readCommitFenceOwnerForClaim(fence, claim)
  }
}

/** What a production-identity worker must let go of, newest first. */
const disposers: Array<() => void> = []

function disposeAll(): void {
  for (const dispose of disposers.splice(0).reverse()) dispose()
}

/**
 * A lease-holder or reclaimer outlives nothing: when its parent goes away
 * (crash, timeout, a missed cleanup) the IPC channel closes and it exits, so
 * the Swift identity daemon it owns cannot keep it running as an orphan.
 */
function exitWithParent(): void {
  process.once('disconnect', () => {
    try {
      disposeAll()
    } finally {
      process.exit(0)
    }
  })
}

function createCommitFence(
  args: WorkerArgs,
  identity: WorkspaceLockProcessIdentityService
): WorkspaceMutationCommitFence {
  return new WorkspaceMutationCommitFence({
    userDataRoot: args.userDataRoot,
    observeProcess: (pid) => identity.observe(pid)
  })
}

function ownerFromArgs(args: WorkerArgs, processBirthIdentity: string): WorkspaceLockOwner {
  return {
    lockOwnerId: args.lockOwnerId,
    runId: args.runId,
    laneId: args.laneId,
    displayName: args.displayName,
    pid: process.pid,
    processBirthIdentity
  }
}

function conflictHolderRunIds(result: WorkspaceLockAcquireResult): string[] {
  if (result.ok || result.reason !== 'conflict' || !result.conflict) return []
  return result.conflict.holders.map((lease) => lease.owner.runId)
}

async function runHolder(args: WorkerArgs, processBirthIdentity: string): Promise<void> {
  const persistence = new NodeWorkspaceLockPersistence({ userDataRoot: args.userDataRoot })
  const authority = await WorkspaceLockAuthority.open({
    persistence,
    dependencies: createProcessDependencies(
      `holder-instance-${process.pid}`,
      processBirthIdentity,
      args.identityRegistry
    )
  })

  try {
    const acquired = await authority.acquire(
      ownerFromArgs(args, processBirthIdentity),
      {
        workspacePath: args.workspacePath,
        kind: 'file',
        targetPath: args.targetPath
      },
      { transitionId: `holder-acquire-${args.runId}` }
    )

    if (!acquired.ok) {
      send({
        type: 'error',
        role: 'holder',
        runId: args.runId,
        pid: process.pid,
        message: `holder acquire failed: ${acquired.reason} ${acquired.message}`
      })
      process.exitCode = 1
      return
    }

    send({
      type: 'acquired',
      role: 'holder',
      runId: args.runId,
      pid: process.pid,
      ok: true,
      transitionId: acquired.transitionId
    })

    // Fail closed unless the parent explicitly signals after observing the
    // contender conflict. The issuing authority releases its own exact token;
    // no human-only orphan-force path is exercised by this smoke.
    await waitForParentRelease(args.holdMs)
    const released = await authority.release(acquired.tokens[0], {
      transitionId: `holder-release-${args.runId}`
    })
    if (!released.ok) {
      send({
        type: 'error',
        role: 'holder',
        runId: args.runId,
        pid: process.pid,
        message: `holder release failed: ${released.reason} ${released.message}`
      })
      process.exitCode = 1
      return
    }

    send({
      type: 'released',
      role: 'holder',
      runId: args.runId,
      pid: process.pid,
      ok: true,
      transitionId: released.transitionId
    })
    send({ type: 'done', role: 'holder', runId: args.runId, status: 'ok' })
  } finally {
    authority.dispose()
  }
}

async function runContender(args: WorkerArgs, processBirthIdentity: string): Promise<void> {
  const persistence = new NodeWorkspaceLockPersistence({ userDataRoot: args.userDataRoot })
  const authority = await WorkspaceLockAuthority.open({
    persistence,
    dependencies: createProcessDependencies(
      `contender-instance-${process.pid}`,
      processBirthIdentity,
      args.identityRegistry
    )
  })

  try {
    const request = {
      workspacePath: args.workspacePath,
      kind: 'file' as const,
      targetPath: args.targetPath
    }
    const owner = ownerFromArgs(args, processBirthIdentity)

    const first = await authority.acquire(owner, request, {
      transitionId: `contender-first-${args.runId}`
    })

    if (first.ok) {
      send({
        type: 'error',
        role: 'contender',
        runId: args.runId,
        pid: process.pid,
        message: 'contender first acquire unexpectedly succeeded; holder was not contending'
      })
      await authority.releaseAllForRun(args.runId)
      process.exitCode = 1
      return
    }

    if (first.reason !== 'conflict') {
      send({
        type: 'error',
        role: 'contender',
        runId: args.runId,
        pid: process.pid,
        message: `contender first acquire expected conflict, got ${first.reason}: ${first.message}`
      })
      process.exitCode = 1
      return
    }

    send({
      type: 'conflict',
      role: 'contender',
      runId: args.runId,
      pid: process.pid,
      ok: false,
      reason: 'conflict',
      holderRunIds: conflictHolderRunIds(first),
      message: first.message
    })

    const deadline = Date.now() + Math.max(500, args.retryTimeoutMs)
    let holderReleased = false
    while (Date.now() < deadline) {
      const snapshot = authority.snapshot()
      if (!snapshot.leases.some((lease) => lease.owner.runId !== args.runId)) {
        holderReleased = true
        break
      }
      await sleep(25)
    }

    if (!holderReleased) {
      send({
        type: 'error',
        role: 'contender',
        runId: args.runId,
        pid: process.pid,
        message: `contender timed out waiting for live lock state to become free (${args.retryTimeoutMs}ms)`
      })
      process.exitCode = 1
      return
    }

    let attempt = 0
    let resumed: WorkspaceLockAcquireResult | null = null
    while (Date.now() < deadline) {
      attempt += 1
      const result = await authority.acquire(owner, request, {
        transitionId: `contender-resume-${args.runId}-${attempt}`
      })
      if (result.ok) {
        resumed = result
        break
      }
      if (result.reason !== 'authority_busy') {
        send({
          type: 'error',
          role: 'contender',
          runId: args.runId,
          pid: process.pid,
          message: `contender resume failed: ${result.reason} ${result.message}`
        })
        process.exitCode = 1
        return
      }
      await sleep(25)
    }

    if (!resumed || !resumed.ok) {
      send({
        type: 'error',
        role: 'contender',
        runId: args.runId,
        pid: process.pid,
        message: `contender timed out acquiring after live state became free (${args.retryTimeoutMs}ms)`
      })
      process.exitCode = 1
      return
    }

    send({
      type: 'acquired',
      role: 'contender',
      runId: args.runId,
      pid: process.pid,
      ok: true,
      transitionId: resumed.transitionId
    })

    await authority.releaseAllForRun(args.runId, {
      transitionId: `contender-release-${args.runId}`
    })
    send({ type: 'done', role: 'contender', runId: args.runId, status: 'ok' })
  } finally {
    authority.dispose()
  }
}

/**
 * Acquires one lease and keeps it, heartbeating, until the parent kills,
 * stops, or dismisses the process. `verify` answers with the owner's own
 * mutation verification, which is how a resumed holder learns its lease went.
 */
async function runLeaseHolder(
  args: WorkerArgs,
  processBirthIdentity: string,
  identity: WorkspaceLockProcessIdentityService
): Promise<void> {
  const persistence = new NodeWorkspaceLockPersistence({ userDataRoot: args.userDataRoot })
  const instanceId = `lease-holder-instance-${process.pid}`
  const fence = createCommitFence(args, identity)
  const authority = await WorkspaceLockAuthority.open({
    persistence,
    dependencies: createProductionDependencies(instanceId, processBirthIdentity, identity, fence),
    holderLease: args.holderLease
  })
  disposers.push(() => authority.dispose())
  const owner = ownerFromArgs(args, processBirthIdentity)
  const acquired = await authority.acquire(
    owner,
    { workspacePath: args.workspacePath, kind: 'file', targetPath: args.targetPath },
    { transitionId: `lease-holder-acquire-${args.runId}` }
  )
  if (!acquired.ok) {
    throw new Error(`lease-holder acquire failed: ${acquired.reason} ${acquired.message}`)
  }
  if (args.holdCommitFence) {
    // The executor's order: lease first, then the partition of the exact
    // claim it is about to commit, held across the whole mutation.
    await fence.acquire(
      {
        lockOwnerId: owner.lockOwnerId,
        runId: owner.runId,
        pid: owner.pid,
        processBirthIdentity
      },
      mutationFencePartitionKeys([acquired.leases[0].claim])[0]
    )
  }
  process.on('message', (raw: unknown) => {
    const message = raw as { type?: string }
    if (message?.type === 'verify') {
      void authority.verifyAcquisitionForMutation(owner, acquired.transitionId).then(
        (verified) => {
          send({
            type: 'verified',
            role: 'lease-holder',
            runId: args.runId,
            pid: process.pid,
            ok: verified.ok,
            reason: verified.ok ? 'ok' : verified.reason,
            atMs: Date.now()
          })
        },
        (error: unknown) => {
          send({ type: 'error', role: 'lease-holder', message: String(error), status: 'failed' })
        }
      )
    }
    if (message?.type === 'exit') process.disconnect?.()
  })
  send({
    type: 'acquired',
    role: 'lease-holder',
    runId: args.runId,
    pid: process.pid,
    ok: true,
    transitionId: acquired.transitionId,
    instanceId,
    leaseId: acquired.leases[0].leaseId,
    fenceHeld: args.holdCommitFence,
    atMs: Date.now()
  })
}

/**
 * Opens its authority exactly once, waits for the parent to say the holder
 * has its lease, proves it contends, then retries the same claim until the
 * periodic pass frees it. It never reopens: a boot-time recovery would be a
 * second, unrelated path to the lease.
 */
async function runReclaimer(
  args: WorkerArgs,
  processBirthIdentity: string,
  identity: WorkspaceLockProcessIdentityService
): Promise<void> {
  const persistence = new NodeWorkspaceLockPersistence({ userDataRoot: args.userDataRoot })
  const instanceId = `reclaimer-instance-${process.pid}`
  const authority = await WorkspaceLockAuthority.open({
    persistence,
    dependencies: createProductionDependencies(
      instanceId,
      processBirthIdentity,
      identity,
      createCommitFence(args, identity)
    ),
    holderLease: args.holderLease
  })
  disposers.push(() => authority.dispose())
  process.on('message', (raw: unknown) => {
    const message = raw as { type?: string }
    if (message?.type === 'scan') {
      void authority.runPeriodicRecovery().then(
        (outcome) => {
          const snapshot = authority.snapshot()
          send({
            type: 'scanned',
            role: 'reclaimer',
            pid: process.pid,
            outcome,
            holderLiveness: snapshot.holderLiveness,
            leases: snapshot.leases.map((lease) => ({
              leaseId: lease.leaseId,
              status: lease.status
            })),
            atMs: Date.now()
          })
        },
        (error: unknown) => {
          send({ type: 'error', role: 'reclaimer', message: String(error), status: 'failed' })
        }
      )
    }
    if (message?.type === 'exit') process.disconnect?.()
  })
  send({ type: 'opened', role: 'reclaimer', pid: process.pid, instanceId, atMs: Date.now() })
  await waitForParentSignal('reclaimer', 'contend', args.retryTimeoutMs)
  const owner = ownerFromArgs(args, processBirthIdentity)
  const request = {
    workspacePath: args.workspacePath,
    kind: 'file' as const,
    targetPath: args.targetPath
  }
  const deadline = Date.now() + Math.max(500, args.retryTimeoutMs)
  let reportedConflict = false
  for (let attempt = 1; Date.now() < deadline; attempt += 1) {
    const result = await authority.acquire(owner, request, {
      transitionId: `reclaimer-acquire-${args.runId}-${attempt}`
    })
    if (result.ok) {
      if (!reportedConflict) {
        throw new Error('reclaimer acquired without ever seeing the holder contend')
      }
      send({
        type: 'acquired',
        role: 'reclaimer',
        runId: args.runId,
        pid: process.pid,
        ok: true,
        transitionId: result.transitionId,
        instanceId,
        atMs: Date.now()
      })
      return
    }
    if (result.reason === 'conflict' && !reportedConflict) {
      reportedConflict = true
      send({
        type: 'conflict',
        role: 'reclaimer',
        runId: args.runId,
        pid: process.pid,
        ok: false,
        reason: 'conflict',
        holderRunIds: conflictHolderRunIds(result),
        instanceId,
        atMs: Date.now()
      })
    } else if (result.reason !== 'conflict' && result.reason !== 'authority_busy') {
      throw new Error(`reclaimer acquire failed: ${result.reason} ${result.message}`)
    }
    await sleep(25)
  }
  throw new Error(`reclaimer timed out after ${args.retryTimeoutMs}ms without the lease`)
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.identity === 'production') {
    exitWithParent()
    const identity = new WorkspaceLockProcessIdentityService()
    disposers.push(() => identity.dispose())
    try {
      const processBirthIdentity = await identity.initialize()
      send({ type: 'ready', role: args.role, runId: args.runId, pid: process.pid })
      if (args.role === 'lease-holder') {
        await runLeaseHolder(args, processBirthIdentity, identity)
      } else if (args.role === 'reclaimer') {
        await runReclaimer(args, processBirthIdentity, identity)
      } else {
        throw new Error(`role ${args.role} does not support production identity`)
      }
    } catch (error) {
      disposeAll()
      throw error
    }
    return
  }

  const processBirthIdentity = randomBytes(32).toString('hex')
  // Publish before authority open so peer recover/observe sees exact live identity.
  publishIdentity(args.identityRegistry, process.pid, processBirthIdentity)

  send({
    type: 'ready',
    role: args.role,
    runId: args.runId,
    pid: process.pid
  })

  if (args.role === 'holder') {
    await runHolder(args, processBirthIdentity)
  } else if (args.role === 'contender') {
    await runContender(args, processBirthIdentity)
  } else {
    throw new Error(`role ${args.role} requires --identity=production`)
  }
}

void main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error)
  send({ type: 'error', message, status: 'failed' })
  process.exitCode = 1
})
