/**
 * Two-process parallel-mission smoke for 1.9.3 safe-parallelism.
 *
 * Complements WorkspaceLockParallelMission.integration.test.ts (in-process
 * async closures) with real OS processes sharing one durable WAL:
 *   holder acquire → WAL-visible handshake → contender conflict →
 *   holder release → contender resume acquire → ordered audit trail.
 *
 * Success is state-driven (WAL / IPC results), not sleep-based timing.
 *
 * The holder-lease suite (Host-lifetime S5) kills or stops a real holder
 * process and measures how long a peer that never reopens its authority takes
 * to get the lease, against the designed TTL + grace bounds.
 */

import { fork, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import type { WorkspaceLockPeriodicRecoveryOutcome } from './WorkspaceLockAuthority'
import type { WorkspaceLockHolderHeartbeat } from './WorkspaceLockHolderHeartbeat'
import {
  NodeWorkspaceLockPersistence,
  WORKSPACE_LOCK_RECLAIM_AUDIT_FILENAME
} from './NodeWorkspaceLockPersistence'
import type { WorkspaceLockHolderLiveness } from './WorkspaceLockTypes'
import { decodeWorkspaceLockWal, type WorkspaceLockWalEvent } from './WorkspaceLockWal'

const temporaryRoots: string[] = []
const children: ChildProcess[] = []

afterEach(() => {
  for (const child of children.splice(0)) {
    // `killed` turns true for ANY signal sent, SIGSTOP and SIGCONT included;
    // only a recorded exit proves the child is gone.
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill('SIGKILL')
      } catch {
        // best-effort cleanup
      }
    }
  }
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

type WorkerRole = 'holder' | 'contender' | 'lease-holder' | 'reclaimer'

interface WorkerIpcMessage {
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
  role?: WorkerRole
  runId?: string
  pid?: number
  ok?: boolean
  reason?: string
  holderRunIds?: string[]
  transitionId?: string
  instanceId?: string
  leaseId?: string
  fenceHeld?: boolean
  fencePartition?: string
  leasePartition?: string
  atMs?: number
  outcome?: WorkspaceLockPeriodicRecoveryOutcome
  holderLiveness?: Record<string, WorkspaceLockHolderLiveness>
  leases?: Array<{ leaseId: string; status: string }>
  message?: string
  status?: 'ok' | 'failed'
}

function workerModulePath(): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    'WorkspaceLockParallelMissionProcess.worker.ts'
  )
}

function workerBootstrapPath(): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    'WorkspaceLockParallelMissionProcess.bootstrap.cjs'
  )
}

function makeHarness(): {
  root: string
  userData: string
  workspace: string
  targetPath: string
  identityRegistry: string
  persistence: NodeWorkspaceLockPersistence
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-parallel-process-'))
  const userData = path.join(root, 'user-data')
  const workspace = path.join(root, 'workspace')
  fs.mkdirSync(userData)
  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true })
  const targetPath = path.join(workspace, 'src', 'shared.ts')
  fs.writeFileSync(targetPath, 'export const n = 1\n')
  const identityRegistry = path.join(root, 'identity-registry.json')
  fs.writeFileSync(identityRegistry, '{}\n')
  temporaryRoots.push(root)
  const persistence = new NodeWorkspaceLockPersistence({ userDataRoot: userData })
  return { root, userData, workspace, targetPath, identityRegistry, persistence }
}

function walKinds(persistence: NodeWorkspaceLockPersistence): string[] {
  return decodeWorkspaceLockWal(persistence.readEvents().raw).events.map((event) => event.kind)
}

function walHasAcquireForRun(persistence: NodeWorkspaceLockPersistence, runId: string): boolean {
  const state = decodeWorkspaceLockWal(persistence.readEvents().raw)
  return state.events.some((event) => {
    if (event.kind !== 'acquire') return false
    return event.payload.leases.some((lease) => lease.owner.runId === runId)
  })
}

/** Poll durable WAL until holder acquire is visible — handshake is not sleep. */
async function waitForWalAcquire(
  persistence: NodeWorkspaceLockPersistence,
  runId: string,
  timeoutMs = 8_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if (walHasAcquireForRun(persistence, runId)) return
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('changed size while reading')) {
        throw error
      }
      // The child may append between the persistence layer's two consistency
      // checks. This is a polling handshake, so retry that transient snapshot.
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  const kinds = walKinds(persistence)
  throw new Error(
    `Timed out waiting for durable WAL acquire for runId=${runId}. kinds=${kinds.join(',')}`
  )
}

type ForkedWorker = ReturnType<typeof forkWorker>

function forkWorker(input: {
  role: WorkerRole
  userDataRoot: string
  workspacePath: string
  targetPath: string
  runId: string
  lockOwnerId: string
  /** Registry identity only; production identity asks the operating system. */
  identityRegistry?: string
  identity?: 'registry' | 'production'
  holderLease?: Record<string, number>
  holdCommitFence?: boolean
  holdMs?: number
  retryTimeoutMs?: number
}): {
  child: ChildProcess
  messages: WorkerIpcMessage[]
  /** Resolves with the `count`-th message of `type` this worker ever sent. */
  waitFor: (
    type: WorkerIpcMessage['type'],
    timeoutMs?: number,
    count?: number
  ) => Promise<WorkerIpcMessage>
} {
  const argv = [
    `--role=${input.role}`,
    `--userDataRoot=${input.userDataRoot}`,
    `--workspacePath=${input.workspacePath}`,
    `--targetPath=${input.targetPath}`,
    `--runId=${input.runId}`,
    `--lockOwnerId=${input.lockOwnerId}`,
    ...(input.identityRegistry ? [`--identityRegistry=${input.identityRegistry}`] : []),
    ...(input.identity ? [`--identity=${input.identity}`] : []),
    ...Object.entries(input.holderLease ?? {}).map(([key, value]) => `--${key}=${value}`),
    ...(input.holdCommitFence ? ['--holdCommitFence=1'] : []),
    `--holdMs=${input.holdMs ?? 400}`,
    `--retryTimeoutMs=${input.retryTimeoutMs ?? 8_000}`,
    `--laneId=wave-process-${input.role}`,
    `--displayName=Process ${input.role}`
  ]

  const child = fork(workerBootstrapPath(), argv, {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: {
      ...process.env,
      TASKWRAITH_PROCESS_WORKER_MODULE: workerModulePath()
    }
  })
  children.push(child)

  const messages: WorkerIpcMessage[] = []
  const waiters: Array<{
    type: WorkerIpcMessage['type']
    count: number
    resolve: (message: WorkerIpcMessage) => void
    reject: (error: Error) => void
    timer: ReturnType<typeof setTimeout>
  }> = []

  const stderrChunks: Buffer[] = []
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrChunks.push(Buffer.from(chunk))
  })
  child.stdout?.on('data', () => {
    // IPC is the protocol; swallow stdout noise from loaders.
  })

  child.on('message', (raw: unknown) => {
    const message = raw as WorkerIpcMessage
    messages.push(message)
    const seen = messages.filter((candidate) => candidate.type === message.type).length
    const pending = waiters.filter((waiter) => waiter.type === message.type && seen >= waiter.count)
    for (const waiter of pending) {
      clearTimeout(waiter.timer)
      waiter.resolve(message)
    }
    for (const waiter of pending) {
      const idx = waiters.indexOf(waiter)
      if (idx >= 0) waiters.splice(idx, 1)
    }
    if (message.type === 'error') {
      for (const waiter of waiters.splice(0)) {
        clearTimeout(waiter.timer)
        waiter.reject(new Error(message.message || 'worker error'))
      }
    }
  })

  child.on('exit', (code, signal) => {
    if (code && code !== 0) {
      const errText = Buffer.concat(stderrChunks).toString('utf8').slice(0, 2_000)
      for (const waiter of waiters.splice(0)) {
        clearTimeout(waiter.timer)
        waiter.reject(
          new Error(
            `worker ${input.role} exited code=${code} signal=${signal ?? ''} stderr=${errText}`
          )
        )
      }
    }
  })

  function waitFor(
    type: WorkerIpcMessage['type'],
    timeoutMs = 10_000,
    count = 1
  ): Promise<WorkerIpcMessage> {
    const existing = messages.filter((message) => message.type === type)
    if (existing.length >= count) return Promise.resolve(existing[count - 1])
    return new Promise<WorkerIpcMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = waiters.findIndex((waiter) => waiter.timer === timer)
        if (idx >= 0) waiters.splice(idx, 1)
        reject(
          new Error(
            `Timed out waiting for worker ${input.role} message type=${type}. ` +
              `seen=${messages.map((m) => m.type).join(',')}`
          )
        )
      }, timeoutMs)
      waiters.push({ type, count, resolve, reject, timer })
    })
  }

  return { child, messages, waitFor }
}

/** Sends one request and waits for the reply it causes, not an earlier one. */
function ask(
  worker: ForkedWorker,
  request: { type: string },
  reply: WorkerIpcMessage['type'],
  timeoutMs = 10_000
): Promise<WorkerIpcMessage> {
  const seen = worker.messages.filter((message) => message.type === reply).length
  worker.child.send(request)
  return worker.waitFor(reply, timeoutMs, seen + 1)
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

/**
 * The holder-lease suite needs the production process identity and POSIX job
 * control. macOS CI runs vitest before it builds the Swift bridge, and Windows
 * has no SIGSTOP; both skip rather than fall back to an injected observation.
 */
function productionIdentityUnavailable(): string | null {
  if (process.platform === 'darwin') {
    const built = ['debug', 'release'].some((configuration) =>
      fs.existsSync(
        path.join(
          REPO_ROOT,
          'swift',
          'TaskWraithBridge',
          '.build',
          configuration,
          'TaskWraithBridgeDaemon'
        )
      )
    )
    return built ? null : 'the Swift bridge daemon is not built'
  }
  if (process.platform === 'linux') {
    return fs.existsSync('/proc/sys/kernel/random/boot_id') ? null : 'no /proc boot id'
  }
  return `no SIGSTOP or production process identity on ${process.platform}`
}

/**
 * Linux CI runs this suite on small, shared runners. There every timing and
 * every allowance scales together, so a holder starved of CPU is not misread
 * as lapsed during its live window and a slow scan does not break an upper
 * bound. The ORDER of events and the exact lower bounds never depend on speed.
 */
const TIMING_SCALE = process.env.CI ? 3 : 1
/** The design's 10 s / 90 s / 180 s / 30 s, shortened so one test takes seconds. */
const HOLDER_LEASE = {
  heartbeatIntervalMs: 100 * TIMING_SCALE,
  heartbeatTtlMs: 1_000 * TIMING_SCALE,
  reclaimGraceMs: 1_500 * TIMING_SCALE,
  scanIntervalMs: 250 * TIMING_SCALE,
  suspendGapMs: 5_000 * TIMING_SCALE
}
/** The designed worst case: stale at most one scan late, lapsed one scan after that. */
const DESIGNED_RECLAIM_BOUND_MS =
  HOLDER_LEASE.heartbeatTtlMs + HOLDER_LEASE.reclaimGraceMs + 2 * HOLDER_LEASE.scanIntervalMs
/** Scheduling allowance for a loaded machine. Lower bounds get none. */
const LOAD_SLACK_MS = 2_500 * TIMING_SCALE
/** Worker handshakes: each worker transpiles its imports and starts its identity service. */
const HANDSHAKE_MS = 20_000 * TIMING_SCALE
const HOLDER_LEASE_TEST_TIMEOUT_MS = 60_000 * TIMING_SCALE
/** Integer-millisecond monotonic reads against ISO wall times. */
const CLOCK_TOLERANCE_MS = 5

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function reportTiming(label: string, timings: Record<string, number>): void {
  if (process.env.TASKWRAITH_LOCK_RECLAIM_TIMINGS) {
    process.stdout.write(`[lock-reclaim] ${label} ${JSON.stringify(timings)}\n`)
  }
}

function readWalEvents(persistence: NodeWorkspaceLockPersistence): WorkspaceLockWalEvent[] {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return decodeWorkspaceLockWal(persistence.readEvents().raw).events
    } catch (error) {
      // A live child may append between the reader's two consistency checks.
      if (attempt >= 20 || !String(error).includes('changed size while reading')) throw error
    }
  }
}

function recoverDecisions(events: readonly WorkspaceLockWalEvent[]) {
  return events.flatMap((event) =>
    event.kind === 'recover'
      ? [{ instanceId: event.authority.instanceId, decisions: event.payload.decisions }]
      : []
  )
}

function holderBeat(
  persistence: NodeWorkspaceLockPersistence,
  instanceId: string
): WorkspaceLockHolderHeartbeat | undefined {
  return persistence
    .readHolderHeartbeats()
    .heartbeats.find((heartbeat) => heartbeat.instanceId === instanceId)
}

function readReclaimAudit(persistence: NodeWorkspaceLockPersistence): Record<string, unknown>[] {
  const file = path.join(persistence.holdersDirectory(), WORKSPACE_LOCK_RECLAIM_AUDIT_FILENAME)
  if (!fs.existsSync(file)) return []
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

/** The audit line is appended after the reclaim, asynchronously; poll for it. */
async function waitForReclaimAudit(
  persistence: NodeWorkspaceLockPersistence,
  timeoutMs = 5_000
): Promise<Record<string, unknown>[]> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const records = readReclaimAudit(persistence)
    if (records.length || Date.now() > deadline) return records
    await sleep(20)
  }
}

/**
 * Boots the reclaimer FIRST, then the holder: the holder's lease is `held` by
 * its own incarnation and no boot relabel can touch it, so every change the
 * test sees comes from the reclaimer's periodic pass.
 */
async function startLeaseHolderAndReclaimer(
  h: ReturnType<typeof makeHarness>,
  options: { holdCommitFence?: boolean; targetPath?: string } = {}
) {
  const common = {
    userDataRoot: h.userData,
    workspacePath: h.workspace,
    targetPath: options.targetPath ?? h.targetPath,
    identity: 'production' as const,
    holderLease: HOLDER_LEASE
  }
  const reclaimer = forkWorker({
    ...common,
    role: 'reclaimer',
    runId: 'run-reclaimer',
    lockOwnerId: 'process-reclaimer',
    retryTimeoutMs: 30_000 * TIMING_SCALE
  })
  const opened = await reclaimer.waitFor('opened', HANDSHAKE_MS)
  const holder = forkWorker({
    ...common,
    role: 'lease-holder',
    runId: 'run-lease-holder',
    lockOwnerId: 'process-lease-holder',
    holdCommitFence: options.holdCommitFence
  })
  const acquired = await holder.waitFor('acquired', HANDSHAKE_MS)
  expect(acquired.fenceHeld).toBe(Boolean(options.holdCommitFence))
  expect(await ask(holder, { type: 'verify' }, 'verified')).toMatchObject({ ok: true })
  reclaimer.child.send({ type: 'contend' })
  const conflict = await reclaimer.waitFor('conflict')
  expect(conflict.holderRunIds).toEqual(['run-lease-holder'])
  return {
    reclaimer,
    holder,
    reclaimerInstanceId: opened.instanceId!,
    holderInstanceId: acquired.instanceId!,
    holderPid: acquired.pid!,
    leaseId: acquired.leaseId!,
    fencePartition: acquired.fencePartition,
    leasePartition: acquired.leasePartition
  }
}

describe('WorkspaceLockParallelMission process integration', () => {
  it('forks holder then contender against durable WAL: conflict, release, resume, ordered audit', async () => {
    const h = makeHarness()
    const holderRunId = 'run-process-holder'
    const contenderRunId = 'run-process-contender'

    // 1) Fork holder; handshake = WAL-visible acquire (not sleep).
    const holder = forkWorker({
      role: 'holder',
      userDataRoot: h.userData,
      workspacePath: h.workspace,
      targetPath: h.targetPath,
      runId: holderRunId,
      lockOwnerId: 'process-holder',
      identityRegistry: h.identityRegistry,
      // Safety cap only; parent signals release after contender conflict.
      holdMs: 15_000
    })

    const holderReady = await holder.waitFor('ready')
    await waitForWalAcquire(h.persistence, holderRunId)
    const holderAcquired = await holder.waitFor('acquired')
    expect(holderAcquired.ok).toBe(true)

    // 2) Contender first acquire must conflict with holder runId.
    const contender = forkWorker({
      role: 'contender',
      userDataRoot: h.userData,
      workspacePath: h.workspace,
      targetPath: h.targetPath,
      runId: contenderRunId,
      lockOwnerId: 'process-contender',
      identityRegistry: h.identityRegistry,
      retryTimeoutMs: 8_000
    })

    const contenderReady = await contender.waitFor('ready')
    expect(holderReady.pid).toEqual(expect.any(Number))
    expect(contenderReady.pid).toEqual(expect.any(Number))
    expect(contenderReady.pid).not.toBe(holderReady.pid)
    const conflict = await contender.waitFor('conflict')
    expect(conflict.reason).toBe('conflict')
    expect(conflict.holderRunIds).toEqual(expect.arrayContaining([holderRunId]))

    // 3) Signal holder to release (state-driven; holdMs is only a safety cap).
    holder.child.send({ type: 'release' })
    await holder.waitFor('released')
    const contenderAcquired = await contender.waitFor('acquired')
    expect(contenderAcquired.ok).toBe(true)

    await holder.waitFor('done')
    await contender.waitFor('done')

    // 4) WAL audit: boot + ordered acquire → release → acquire.
    const kinds = walKinds(h.persistence)
    expect(kinds).toEqual(expect.arrayContaining(['boot', 'acquire', 'release']))

    const firstAcquire = kinds.indexOf('acquire')
    const release = kinds.indexOf('release', firstAcquire + 1)
    const secondAcquire = kinds.indexOf('acquire', release + 1)
    expect(firstAcquire).toBeGreaterThanOrEqual(0)
    expect(release).toBeGreaterThan(firstAcquire)
    expect(secondAcquire).toBeGreaterThan(release)

    // Confirm acquire events bind to the expected owners in order.
    const acquireRunIds = decodeWorkspaceLockWal(h.persistence.readEvents().raw)
      .events.filter((event) => event.kind === 'acquire')
      .flatMap((event) => event.payload.leases.map((lease) => lease.owner.runId))
    expect(acquireRunIds[0]).toBe(holderRunId)
    expect(acquireRunIds).toContain(contenderRunId)
  }, 30_000)
})

const HOLDER_LEASE_SKIP = productionIdentityUnavailable()

describe.skipIf(HOLDER_LEASE_SKIP !== null)(
  `WorkspaceLockAuthority holder leases across processes${HOLDER_LEASE_SKIP ? ` (skipped: ${HOLDER_LEASE_SKIP})` : ''}`,
  // Every test in this suite inherits it.
  { timeout: HOLDER_LEASE_TEST_TIMEOUT_MS },
  () => {
    it('frees a SIGKILLed holder at the next scan, without the reclaimer reopening, labelled owner_dead', async () => {
      const h = makeHarness()
      const s = await startLeaseHolderAndReclaimer(h)
      expect(holderBeat(h.persistence, s.holderInstanceId)).toBeDefined()

      const killedAt = Date.now()
      s.holder.child.kill('SIGKILL')
      const acquired = await s.reclaimer.waitFor('acquired', HANDSHAKE_MS)
      const reclaimMs = acquired.atMs! - killedAt
      reportTiming('holder-crash', { reclaimMs })
      expect(reclaimMs).toBeLessThan(DESIGNED_RECLAIM_BOUND_MS + LOAD_SLACK_MS)

      const events = readWalEvents(h.persistence)
      // Two boots, reclaimer first: the lease was freed by the periodic pass
      // of an authority that never reopened, not by a boot recovery.
      expect(
        events.filter((event) => event.kind === 'boot').map((event) => event.authority.instanceId)
      ).toEqual([s.reclaimerInstanceId, s.holderInstanceId])
      expect(recoverDecisions(events)).toEqual([
        {
          instanceId: s.reclaimerInstanceId,
          decisions: [{ leaseId: s.leaseId, status: 'recovered', reason: 'owner_dead' }]
        }
      ])
      expect(await waitForReclaimAudit(h.persistence)).toEqual([
        expect.objectContaining({
          leaseId: s.leaseId,
          ownerRunId: 'run-lease-holder',
          ownerPid: s.holderPid,
          holderInstanceId: s.holderInstanceId,
          reclaimerInstanceId: s.reclaimerInstanceId,
          evidence: 'owner_dead',
          walStatus: 'recovered',
          walReason: 'owner_dead'
        })
      ])
      // A dead holder's sidecar goes with its lease.
      expect(holderBeat(h.persistence, s.holderInstanceId)).toBeUndefined()
    })

    it('frees a SIGSTOPped holder only after the TTL and the grace, and the resumed holder learns it lost the lease', async () => {
      const h = makeHarness()
      const s = await startLeaseHolderAndReclaimer(h)
      const firstBeat = holderBeat(h.persistence, s.holderInstanceId)
      expect(firstBeat).toBeDefined()

      // Alive and beating: however long the reclaimer scans, nothing changes.
      await sleep(DESIGNED_RECLAIM_BOUND_MS)
      expect(await ask(s.reclaimer, { type: 'scan' }, 'scanned')).toMatchObject({
        outcome: { skipped: true, reason: 'no_candidates' },
        leases: [{ leaseId: s.leaseId, status: 'held' }],
        holderLiveness: { [s.leaseId]: { instanceScope: 'other', liveness: 'live' } }
      })
      expect(s.reclaimer.messages.some((message) => message.type === 'acquired')).toBe(false)
      expect(holderBeat(h.persistence, s.holderInstanceId)!.beatSeq).toBeGreaterThan(
        firstBeat!.beatSeq
      )
      expect(await ask(s.holder, { type: 'verify' }, 'verified')).toMatchObject({ ok: true })

      const stoppedAt = Date.now()
      s.holder.child.kill('SIGSTOP')
      const acquired = await s.reclaimer.waitFor('acquired', HANDSHAKE_MS)
      const lastBeat = holderBeat(h.persistence, s.holderInstanceId)!
      const sinceLastBeatMs = acquired.atMs! - Date.parse(lastBeat.beatAt)
      reportTiming('holder-stopped', {
        reclaimAfterStopMs: acquired.atMs! - stoppedAt,
        reclaimAfterLastBeatMs: sinceLastBeatMs
      })
      // Stale needs the TTL on the wall clock, lapsed a further grace on the
      // reclaimer's monotonic clock: this lower bound holds under any load.
      expect(sinceLastBeatMs).toBeGreaterThanOrEqual(
        HOLDER_LEASE.heartbeatTtlMs + HOLDER_LEASE.reclaimGraceMs - CLOCK_TOLERANCE_MS
      )
      expect(sinceLastBeatMs).toBeLessThan(DESIGNED_RECLAIM_BOUND_MS + LOAD_SLACK_MS)

      const events = readWalEvents(h.persistence)
      expect(events.filter((event) => event.kind === 'boot')).toHaveLength(2)
      // The only status any frame ever gave the lease is recovered: the live
      // holder was never relabelled on the way.
      expect(recoverDecisions(events)).toEqual([
        {
          instanceId: s.reclaimerInstanceId,
          decisions: [{ leaseId: s.leaseId, status: 'recovered', reason: 'owner_dead' }]
        }
      ])
      const audit = await waitForReclaimAudit(h.persistence)
      expect(audit).toEqual([
        expect.objectContaining({
          leaseId: s.leaseId,
          ownerPid: s.holderPid,
          holderInstanceId: s.holderInstanceId,
          reclaimerInstanceId: s.reclaimerInstanceId,
          evidence: 'lease_lapsed',
          walStatus: 'recovered',
          walReason: 'owner_dead',
          beatSeq: lastBeat.beatSeq,
          beatAt: lastBeat.beatAt
        })
      ])
      expect(audit[0].graceObservedMs).toBeGreaterThanOrEqual(HOLDER_LEASE.reclaimGraceMs)
      expect(audit[0].heartbeatAgeMs).toBeGreaterThan(HOLDER_LEASE.heartbeatTtlMs)

      s.holder.child.kill('SIGCONT')
      expect(await ask(s.holder, { type: 'verify' }, 'verified')).toMatchObject({
        ok: false,
        reason: 'stale_acquisition'
      })
    })

    it('never frees a SIGSTOPped holder inside its commit fence, even after a replace moved its lease to another partition', async () => {
      const h = makeHarness()
      // Absent at admission, so its planned identity becomes dev:ino once the
      // holder creates it: the executor's same-run sibling case. The holder
      // keeps the fence on the planned partition while its replaced lease
      // names the dev:ino one, which no fence record names.
      const targetPath = path.join(h.workspace, 'src', 'created-mid-commit.ts')
      const s = await startLeaseHolderAndReclaimer(h, { holdCommitFence: true, targetPath })
      expect(s.fencePartition).toMatch(/^mutation-target:[0-9a-f]{64}$/)
      expect(s.leasePartition).toMatch(/^mutation-target:[0-9a-f]{64}$/)
      expect(s.leasePartition).not.toBe(s.fencePartition)

      s.holder.child.kill('SIGSTOP')
      await sleep(DESIGNED_RECLAIM_BOUND_MS)
      // Positive control: a pass must judge the stopped holder lapsed and hold
      // back only because it is inside its commit. Polled, because a loaded
      // machine can delay the scan that starts the grace.
      const deferredLease = (message: WorkerIpcMessage): boolean =>
        message.outcome?.skipped === false && message.outcome.deferred.includes(s.leaseId)
      const deadline = Date.now() + DESIGNED_RECLAIM_BOUND_MS + LOAD_SLACK_MS
      let scanned = await ask(s.reclaimer, { type: 'scan' }, 'scanned')
      while (!deferredLease(scanned) && Date.now() < deadline) {
        await sleep(HOLDER_LEASE.scanIntervalMs)
        scanned = await ask(s.reclaimer, { type: 'scan' }, 'scanned')
      }
      const lastBeat = holderBeat(h.persistence, s.holderInstanceId)!
      expect(scanned.atMs! - Date.parse(lastBeat.beatAt)).toBeGreaterThanOrEqual(
        HOLDER_LEASE.heartbeatTtlMs + HOLDER_LEASE.reclaimGraceMs - CLOCK_TOLERANCE_MS
      )
      expect(scanned).toMatchObject({
        outcome: { skipped: false, decisions: [], deferred: [s.leaseId], reclaimed: [] },
        leases: [{ leaseId: s.leaseId, status: 'held' }],
        holderLiveness: { [s.leaseId]: { instanceScope: 'other', liveness: 'lapsed' } }
      })
      expect(s.reclaimer.messages.some((message) => message.type === 'acquired')).toBe(false)
      expect(recoverDecisions(readWalEvents(h.persistence))).toEqual([])
      expect(readReclaimAudit(h.persistence)).toEqual([])

      s.holder.child.kill('SIGCONT')
      expect(await ask(s.holder, { type: 'verify' }, 'verified')).toMatchObject({ ok: true })
    })
  }
)
