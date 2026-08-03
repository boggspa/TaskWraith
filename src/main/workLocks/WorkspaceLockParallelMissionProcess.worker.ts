/**
 * Cross-process worker for WorkspaceLockParallelMission.process.integration.test.
 *
 * Runnable via `child_process.fork` with argv:
 *   --role=holder|contender
 *   --userDataRoot=...
 *   --workspacePath=...
 *   --targetPath=...
 *   --runId=...
 *   --lockOwnerId=...
 *   --holdMs=200          (holder only; safety cap before releaseAllForRun)
 *   --retryTimeoutMs=5000 (contender only)
 *   --identityRegistry=...  shared JSON map pid → processBirthIdentity
 *
 * Uses production WorkspaceLockAuthority + NodeWorkspaceLockPersistence and a
 * production-equivalent observeProcess: exact birth identities are published to
 * a shared registry (stand-in for OS-level process-birth observation across
 * processes). Unknown live PIDs remain identity_unavailable; ESRCH is dead.
 *
 * IPC (worker → parent): ready | acquired | conflict | released | error | done
 */

import { randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

import {
  resolveCanonicalWorkspaceLockPath,
  verifyCanonicalWorkspaceLockPath
} from './CanonicalWorkspaceLockPath'
import { NodeWorkspaceLockPersistence } from './NodeWorkspaceLockPersistence'
import { WorkspaceLockAuthority } from './WorkspaceLockAuthority'
import type {
  WorkspaceLockAcquireResult,
  WorkspaceLockAuthorityDependencies,
  WorkspaceLockOwner,
  WorkspaceLockProcessObservation
} from './WorkspaceLockTypes'

type Role = 'holder' | 'contender'

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
  identityRegistry: string
}

interface WorkerMessage {
  type: 'ready' | 'acquired' | 'conflict' | 'released' | 'error' | 'done'
  role?: Role
  runId?: string
  pid?: number
  ok?: boolean
  reason?: string
  holderRunIds?: string[]
  transitionId?: string
  message?: string
  status?: 'ok' | 'failed'
}

function parseArgs(argv: string[]): WorkerArgs {
  const map = new Map<string, string>()
  for (const token of argv) {
    if (!token.startsWith('--')) continue
    const eq = token.indexOf('=')
    if (eq <= 2) continue
    map.set(token.slice(2, eq), token.slice(eq + 1))
  }
  const role = map.get('role')
  if (role !== 'holder' && role !== 'contender') {
    throw new Error(`Worker requires --role=holder|contender (got ${role ?? 'missing'})`)
  }
  const required = [
    'userDataRoot',
    'workspacePath',
    'targetPath',
    'runId',
    'lockOwnerId',
    'identityRegistry'
  ] as const
  for (const key of required) {
    if (!map.get(key)) throw new Error(`Worker requires --${key}=...`)
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
    identityRegistry: map.get('identityRegistry')!
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

function waitForParentReleaseOrTimeout(holdMs: number): Promise<'signal' | 'timeout'> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cleanup()
      resolve('timeout')
    }, Math.max(50, holdMs))

    const onMessage = (raw: unknown) => {
      const message = raw as { type?: string }
      if (message && message.type === 'release') {
        cleanup()
        resolve('signal')
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

    // Hold until parent signals release after contender conflict, or holdMs safety cap.
    await waitForParentReleaseOrTimeout(args.holdMs)

    // Peer contender open reclassifies the still-live lease as orphan_live. The
    // issuing authority can still release by exact token (production path),
    // which appends kind=release. releaseAllForRun without forceOrphaned is
    // intentionally blocked while status !== held and the owner is still live.
    // For the audit contract we prefer release_run via forceOrphaned — same as
    // multi-instance terminal cleanup of a live orphan for this runId.
    const released = await authority.releaseAllForRun(args.runId, {
      transitionId: `holder-release-${args.runId}`,
      forceOrphaned: true
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
      if (result.reason !== 'conflict' && result.reason !== 'authority_busy') {
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
        message: `contender timed out waiting to resume after holder release (${args.retryTimeoutMs}ms)`
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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
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
  } else {
    await runContender(args, processBirthIdentity)
  }
}

void main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error)
  send({ type: 'error', message, status: 'failed' })
  process.exitCode = 1
})
