import { execFile as nodeExecFile } from 'node:child_process'
import { promisify } from 'node:util'

import { ACTIVE_RUN_QUEUE_STATUSES } from './RunQueue'
import { createWindowsKillController, type KillController } from './localServers/killer'
import type {
  RunProcessOwnershipReceipt,
  RunQueueJob,
  RunRecoveryProcessSnapshot
} from './store/types'
import type { WorkspaceLockProcessObservation } from './workLocks/WorkspaceLockTypes'

const execFileAsync = promisify(nodeExecFile)
const REAPABLE_STATUSES = new Set<RunQueueJob['status']>([
  ...ACTIVE_RUN_QUEUE_STATUSES,
  'paused',
  'failed'
])
type OwnedRunQueueJob = RunQueueJob & {
  processPid: number
  processOwnership: RunProcessOwnershipReceipt
}

export interface RunProcessIdentityObserver {
  observe(pid: number): Promise<WorkspaceLockProcessObservation>
}

export interface RunOrphanProcessReaperDependencies {
  resolvePosixProcessGroupId(pid: number): Promise<number | null>
  createPosixProcessGroupController(processGroupId: number): KillController
  createWindowsProcessTreeController(pid: number): KillController
  wait(ms: number): Promise<void>
}

export interface RunOrphanProcessReaperOptions {
  processIdentity: RunProcessIdentityObserver
  loadJob(runId: string): RunQueueJob | null
  persistJob(runId: string, partial: Partial<RunQueueJob>): void
  platform?: NodeJS.Platform
  now?: () => string
  graceMs?: number
  dependencies?: Partial<RunOrphanProcessReaperDependencies>
  onError?: (message: string, error: unknown) => void
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function resolvePosixProcessGroupId(pid: number): Promise<number | null> {
  try {
    const result = await execFileAsync('/bin/ps', ['-p', String(pid), '-o', 'pgid='], {
      encoding: 'utf8',
      windowsHide: true
    })
    const value = Number.parseInt(String(result.stdout || '').trim(), 10)
    return Number.isSafeInteger(value) && value > 1 ? value : null
  } catch {
    return null
  }
}

function processTargetExists(target: number): boolean {
  try {
    process.kill(target, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'EPERM'
  }
}

function createPosixProcessGroupController(processGroupId: number): KillController {
  const target = -processGroupId
  return {
    signal: (signal) => process.kill(target, signal),
    isAlive: () => processTargetExists(target)
  }
}

const DEFAULT_DEPENDENCIES: RunOrphanProcessReaperDependencies = {
  resolvePosixProcessGroupId,
  createPosixProcessGroupController,
  createWindowsProcessTreeController: createWindowsKillController,
  wait
}

function validPid(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 1
}

function receiptMatchesJob(job: RunQueueJob): job is OwnedRunQueueJob {
  return (
    validPid(job.processPid) &&
    job.processOwnership?.schemaVersion === 1 &&
    job.processOwnership.pid === job.processPid
  )
}

function liveIdentity(
  observation: WorkspaceLockProcessObservation
): observation is Extract<WorkspaceLockProcessObservation, { state: 'live' }> {
  return observation.state === 'live'
}

/**
 * Records an exact process-birth identity plus a tree-kill boundary for every
 * run process. Startup cleanup refuses PID-only evidence: a reused PID must
 * never let TaskWraith signal an unrelated process.
 */
export class RunOrphanProcessReaper {
  private readonly processIdentity: RunProcessIdentityObserver
  private readonly loadJob: RunOrphanProcessReaperOptions['loadJob']
  private readonly persistJob: RunOrphanProcessReaperOptions['persistJob']
  private readonly platform: NodeJS.Platform
  private readonly now: () => string
  private readonly graceMs: number
  private readonly dependencies: RunOrphanProcessReaperDependencies
  private readonly onError: NonNullable<RunOrphanProcessReaperOptions['onError']>
  private readonly captures = new Map<string, Promise<RunProcessOwnershipReceipt | null>>()

  constructor(options: RunOrphanProcessReaperOptions) {
    this.processIdentity = options.processIdentity
    this.loadJob = options.loadJob
    this.persistJob = options.persistJob
    this.platform = options.platform ?? process.platform
    this.now = options.now ?? (() => new Date().toISOString())
    this.graceMs = options.graceMs ?? 2_500
    this.dependencies = { ...DEFAULT_DEPENDENCIES, ...(options.dependencies || {}) }
    this.onError = options.onError ?? (() => undefined)
  }

  capture(runId: string, pid: number): Promise<RunProcessOwnershipReceipt | null> {
    if (!runId || !validPid(pid)) return Promise.resolve(null)
    const current = this.loadJob(runId)
    if (current?.processPid !== pid) return Promise.resolve(null)
    if (current.processOwnership?.pid === pid) return Promise.resolve(current.processOwnership)

    const key = `${runId}:${pid}`
    const pending = this.captures.get(key)
    if (pending) return pending

    const capture = this.captureUncached(runId, pid)
      .catch((error) => {
        this.onError(`Failed to capture process ownership for run ${runId}.`, error)
        return null
      })
      .finally(() => {
        this.captures.delete(key)
      })
    this.captures.set(key, capture)
    return capture
  }

  async reap(jobs: readonly RunQueueJob[]): Promise<Map<string, RunRecoveryProcessSnapshot>> {
    const candidates = jobs.filter(
      (job): job is OwnedRunQueueJob => REAPABLE_STATUSES.has(job.status) && receiptMatchesJob(job)
    )
    const byPid = new Map<number, typeof candidates>()
    for (const job of candidates) {
      const grouped = byPid.get(job.processPid) || []
      grouped.push(job)
      byPid.set(job.processPid, grouped)
    }

    const snapshots = new Map<string, RunRecoveryProcessSnapshot>()
    await Promise.all(
      [...byPid.values()].map(async (group) => {
        const first = group[0]
        const compatible = group.filter(
          (job) =>
            job.processOwnership.processBirthIdentity ===
              first.processOwnership.processBirthIdentity &&
            JSON.stringify(job.processOwnership.containment) ===
              JSON.stringify(first.processOwnership.containment)
        )
        const snapshot = await this.reapOne(first).catch((error) => {
          this.onError(`Failed to reap process ${first.processPid} for run ${first.runId}.`, error)
          return this.snapshot(first, true, 'termination_failed', error)
        })
        if (!snapshot) return
        for (const job of compatible) {
          const current = this.loadJob(job.runId)
          if (!current) continue
          if (
            current.processPid !== job.processPid ||
            current.processOwnership?.processBirthIdentity !==
              job.processOwnership.processBirthIdentity
          ) {
            continue
          }
          this.persistJob(job.runId, { orphanProcess: snapshot })
          snapshots.set(job.runId, snapshot)
        }
      })
    )
    return snapshots
  }

  private async captureUncached(
    runId: string,
    pid: number
  ): Promise<RunProcessOwnershipReceipt | null> {
    const before = await this.processIdentity.observe(pid)
    if (!liveIdentity(before)) return null

    let containment: RunProcessOwnershipReceipt['containment']
    if (this.platform === 'win32') {
      containment = { kind: 'windows_process_tree' }
    } else if (this.platform === 'darwin' || this.platform === 'linux') {
      const processGroupId = await this.dependencies.resolvePosixProcessGroupId(pid)
      if (processGroupId !== pid) return null
      containment = { kind: 'posix_process_group', processGroupId }
    } else {
      return null
    }

    const after = await this.processIdentity.observe(pid)
    if (!liveIdentity(after) || after.processBirthIdentity !== before.processBirthIdentity) {
      return null
    }

    const receipt: RunProcessOwnershipReceipt = {
      schemaVersion: 1,
      pid,
      processBirthIdentity: after.processBirthIdentity,
      capturedAt: this.now(),
      containment
    }
    const current = this.loadJob(runId)
    if (current?.processPid !== pid) return null
    this.persistJob(runId, { processOwnership: receipt })
    return receipt
  }

  private async reapOne(job: OwnedRunQueueJob): Promise<RunRecoveryProcessSnapshot | null> {
    const observation = await this.processIdentity.observe(job.processPid)
    if (observation.state === 'dead') return null
    if (!liveIdentity(observation)) {
      return this.snapshot(job, true, 'identity_unavailable')
    }
    if (observation.processBirthIdentity !== job.processOwnership.processBirthIdentity) {
      return this.snapshot(job, true, 'identity_mismatch')
    }

    let controller: KillController
    if (job.processOwnership.containment.kind === 'posix_process_group') {
      const currentGroup = await this.dependencies.resolvePosixProcessGroupId(job.processPid)
      if (
        currentGroup !== job.processOwnership.containment.processGroupId ||
        currentGroup !== job.processPid
      ) {
        return this.snapshot(job, true, 'containment_mismatch')
      }
      controller = this.dependencies.createPosixProcessGroupController(currentGroup)
    } else if (this.platform === 'win32') {
      controller = this.dependencies.createWindowsProcessTreeController(job.processPid)
    } else {
      return this.snapshot(job, true, 'containment_mismatch')
    }

    try {
      controller.signal('SIGTERM')
    } catch {
      if (!controller.isAlive()) return this.snapshot(job, false, 'terminated')
    }
    await this.dependencies.wait(this.graceMs)
    if (!controller.isAlive()) return this.snapshot(job, false, 'terminated')

    // The graceful signal may have removed the original group and freed its
    // numeric id for reuse. Re-prove the root's birth identity and containment
    // immediately before SIGKILL; group liveness alone is never kill authority.
    const forceKillAuthority = await this.verifyStillOwned(job)
    if (forceKillAuthority) return forceKillAuthority
    try {
      controller.signal('SIGKILL')
    } catch {
      return this.snapshot(job, controller.isAlive(), 'termination_failed')
    }
    await this.dependencies.wait(200)
    return controller.isAlive()
      ? this.snapshot(job, true, 'termination_failed')
      : this.snapshot(job, false, 'force_killed')
  }

  private async verifyStillOwned(
    job: OwnedRunQueueJob
  ): Promise<RunRecoveryProcessSnapshot | null> {
    const observation = await this.processIdentity.observe(job.processPid)
    if (!liveIdentity(observation)) {
      return this.snapshot(
        job,
        true,
        observation.state === 'dead' ? 'termination_failed' : 'identity_unavailable'
      )
    }
    if (observation.processBirthIdentity !== job.processOwnership.processBirthIdentity) {
      return this.snapshot(job, true, 'identity_mismatch')
    }
    if (job.processOwnership.containment.kind === 'posix_process_group') {
      const currentGroup = await this.dependencies.resolvePosixProcessGroupId(job.processPid)
      if (
        currentGroup !== job.processOwnership.containment.processGroupId ||
        currentGroup !== job.processPid
      ) {
        return this.snapshot(job, true, 'containment_mismatch')
      }
    }
    return null
  }

  private snapshot(
    job: Pick<RunQueueJob, 'processPid' | 'processCommand'> & { processPid: number },
    alive: boolean,
    action: RunRecoveryProcessSnapshot['action'],
    error?: unknown
  ): RunRecoveryProcessSnapshot {
    return {
      pid: job.processPid,
      checkedAt: this.now(),
      alive,
      command: job.processCommand,
      ...(error
        ? {
            errorMessage: error instanceof Error ? error.message : String(error)
          }
        : {}),
      detection: 'verified_process_identity',
      action
    }
  }
}

export function isPersistedRunReapSnapshot(
  job: Pick<RunQueueJob, 'processPid' | 'orphanProcess'>
): job is Pick<RunQueueJob, 'processPid' | 'orphanProcess'> & {
  processPid: number
  orphanProcess: RunRecoveryProcessSnapshot
} {
  return (
    validPid(job.processPid) &&
    job.orphanProcess?.pid === job.processPid &&
    job.orphanProcess.detection === 'verified_process_identity'
  )
}
