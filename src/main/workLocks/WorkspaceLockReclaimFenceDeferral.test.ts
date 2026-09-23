/**
 * The periodic reclaim against a live holder that is inside its commit fence.
 *
 * The executor fences the partitions of its ADMISSION claims, then replaces
 * its lease with fresh claims, verifies, and writes. A target that comes into
 * existence in between moves the replaced lease from its planned identity to
 * dev:ino, so the lease names another partition than the one the holder sits
 * in. A holder stopped there after its final verification must keep its lease:
 * a peer that took it could enter the free dev:ino partition and write, and
 * the resumed holder would then write over it.
 *
 * Driven in the executor's exact order through the real authority, the real
 * WorkspaceMutationCommitFence, the real partition function and the runtime's
 * real fence port; only process observation and the clocks are injected.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { listCommitFenceOwners, mutationFencePartitionKeys } from '../WorkspaceLockRuntime'
import {
  resolveCanonicalWorkspaceLockPath,
  verifyCanonicalWorkspaceLockPath
} from './CanonicalWorkspaceLockPath'
import { NodeWorkspaceLockPersistence } from './NodeWorkspaceLockPersistence'
import { WorkspaceLockAuthority } from './WorkspaceLockAuthority'
import {
  WorkspaceMutationCommitFence,
  WorkspaceMutationCommitFenceBusyError
} from './WorkspaceMutationCommitFence'
import type {
  WorkspaceLockAuthorityDependencies,
  WorkspaceLockClaimRequest,
  WorkspaceLockOwner,
  WorkspaceLockProcessObservation
} from './WorkspaceLockTypes'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

/** The lapsed but live holder: stopped after its final commit-boundary verification. */
const H = { pid: 101, processBirthIdentity: 'birth-h' }
/** The peer whose periodic pass decides. */
const R = { pid: 202, processBirthIdentity: 'birth-r' }
/** The peer that would write next. */
const C = { pid: 303, processBirthIdentity: 'birth-c' }

async function world() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tw-reclaim-fence-')))
  roots.push(root)
  const userData = path.join(root, 'user-data')
  const workspace = path.join(root, 'workspace')
  fs.mkdirSync(userData)
  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true })
  fs.writeFileSync(path.join(workspace, 'src', 'existing.ts'), 'existing\n')

  let wallMs = Date.parse('2026-09-23T01:00:00.000Z')
  let monoMs = 1_000
  let id = 0
  const observations = new Map<number, WorkspaceLockProcessObservation>([
    [H.pid, { state: 'live', processBirthIdentity: H.processBirthIdentity }],
    [R.pid, { state: 'live', processBirthIdentity: R.processBirthIdentity }],
    [C.pid, { state: 'live', processBirthIdentity: C.processBirthIdentity }]
  ])
  const observeProcess = async (pid: number): Promise<WorkspaceLockProcessObservation> =>
    observations.get(pid) || { state: 'identity_unavailable' }
  const fence = new WorkspaceMutationCommitFence({ userDataRoot: userData, observeProcess })
  const dependencies = (
    instance: typeof H & { instanceId: string }
  ): WorkspaceLockAuthorityDependencies => ({
    nowIso: () => new Date((wallMs += 1)).toISOString(),
    nextId: (kind) => `${kind}-${++id}`,
    observeProcess,
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
    monotonicNowMs: () => monoMs,
    // The production wiring (WorkspaceLockRuntime.open), over the same root.
    readCommitFenceOwners: () => listCommitFenceOwners(userData),
    instance
  })
  // Timers never fire here: each authority beats once at open, and the test
  // runs the reclaimer's pass by hand.
  const manual = {
    heartbeatIntervalMs: 3_600_000,
    scanIntervalMs: 3_600_000,
    heartbeatTtlMs: 90_000,
    reclaimGraceMs: 180_000,
    suspendGapMs: 36_000_000
  }
  const holder = await WorkspaceLockAuthority.open({
    persistence: new NodeWorkspaceLockPersistence({ userDataRoot: userData }),
    dependencies: dependencies({ instanceId: 'instance-h', ...H }),
    holderLease: manual
  })
  const reclaimer = await WorkspaceLockAuthority.open({
    persistence: new NodeWorkspaceLockPersistence({ userDataRoot: userData }),
    dependencies: dependencies({ instanceId: 'instance-r', ...R }),
    holderLease: manual
  })
  const contender = await WorkspaceLockAuthority.open({
    persistence: new NodeWorkspaceLockPersistence({ userDataRoot: userData }),
    dependencies: dependencies({ instanceId: 'instance-c', ...C }),
    holderLease: { enabled: false }
  })
  const owner = (who: typeof H, runId: string): WorkspaceLockOwner => ({
    lockOwnerId: `owner-${runId}`,
    runId,
    pid: who.pid,
    processBirthIdentity: who.processBirthIdentity
  })
  const fenceOwner = (who: typeof H, runId: string) => ({
    lockOwnerId: `owner-${runId}`,
    runId,
    ...who
  })
  const request = (file: string): WorkspaceLockClaimRequest => ({
    workspacePath: workspace,
    kind: 'file',
    targetPath: path.join(workspace, 'src', file)
  })
  /** The holder never beats again: stale after 91 s of wall time, lapsed after 181 s more of grace. */
  const lapseHolder = async () => {
    wallMs += 91_000
    expect(await reclaimer.runPeriodicRecovery()).toEqual({
      skipped: true,
      reason: 'no_candidates'
    })
    wallMs += 181_000
    monoMs += 181_000
    return reclaimer.runPeriodicRecovery()
  }
  const status = (leaseId: string) =>
    reclaimer.snapshot().leases.find((lease) => lease.leaseId === leaseId)?.status
  return {
    workspace,
    userData,
    fence,
    holder,
    reclaimer,
    contender,
    owner,
    fenceOwner,
    request,
    lapseHolder,
    status,
    dispose: () => {
      holder.dispose()
      reclaimer.dispose()
      contender.dispose()
    }
  }
}

describe('periodic reclaim vs a live holder inside its commit fence', () => {
  it('defers a holder whose same-run sibling created the target while it waited on the fence', async () => {
    const w = await world()
    try {
      const ownerH = w.owner(H, 'run-h')
      const request = w.request('sibling.ts')
      // Two write_file calls of one run to one new file: same owner, so no
      // lease conflict, and both admitted with the planned identity.
      const sibling = await w.holder.acquire(ownerH, request, { transitionId: 'sibling-acquire' })
      const call = await w.holder.acquire(ownerH, request, { transitionId: 'call-acquire' })
      if (!sibling.ok || !call.ok) throw new Error('admission failed')
      const [planned] = mutationFencePartitionKeys(call.leases.map((lease) => lease.claim))
      expect(mutationFencePartitionKeys(sibling.leases.map((lease) => lease.claim))).toEqual([
        planned
      ])
      const siblingFence = await w.fence.acquire(w.fenceOwner(H, 'run-h'), planned)
      await expect(w.fence.acquire(w.fenceOwner(H, 'run-h'), planned)).rejects.toBeInstanceOf(
        WorkspaceMutationCommitFenceBusyError
      )
      fs.writeFileSync(request.targetPath!, 'created by the sibling\n')
      w.fence.release(siblingFence)
      const siblingRelease = await w.holder.release(sibling.tokens[0], {
        transitionId: 'sibling-release'
      })
      expect(siblingRelease.ok).toBe(true)

      // The call gets the planned partition, then replaces onto dev:ino.
      const callFence = await w.fence.acquire(w.fenceOwner(H, 'run-h'), planned)
      const replaced = await w.holder.replaceAcquisition(ownerH, call.transitionId, [request])
      if (!replaced.ok) throw new Error('replace failed')
      const [leasePartition] = mutationFencePartitionKeys(replaced.leases.map((l) => l.claim))
      expect(leasePartition).not.toBe(planned)
      expect(w.fence.readFence(leasePartition)).toBeNull()
      expect((await w.holder.verifyAcquisitionForMutation(ownerH, replaced.transitionId)).ok).toBe(
        true
      )

      const pass = await w.lapseHolder()
      expect(pass).toMatchObject({
        skipped: false,
        decisions: [],
        deferred: [replaced.leases[0].leaseId],
        reclaimed: []
      })
      // Reclaim-only: the deferred lease keeps its status, so the resumed
      // holder's verification still passes and a peer still conflicts.
      expect(w.status(replaced.leases[0].leaseId)).toBe('held')
      expect(await w.contender.acquire(w.owner(C, 'run-c'), request)).toMatchObject({
        ok: false,
        reason: 'conflict'
      })
      expect((await w.holder.verifyAcquisitionForMutation(ownerH, replaced.transitionId)).ok).toBe(
        true
      )
      w.fence.release(callFence)
    } finally {
      w.dispose()
    }
  })

  it('defers a holder whose target an outside writer created between admission and replace, and frees it once it leaves every fence', async () => {
    const w = await world()
    try {
      const ownerH = w.owner(H, 'run-h')
      const request = w.request('new.ts')
      const admitted = await w.holder.acquire(ownerH, request)
      if (!admitted.ok) throw new Error('admission failed')
      expect(admitted.leases[0].claim.objectIdentity?.startsWith('planned:')).toBe(true)
      const [admission] = mutationFencePartitionKeys(admitted.leases.map((lease) => lease.claim))
      const holderFence = await w.fence.acquire(w.fenceOwner(H, 'run-h'), admission)

      // A native provider write or an editor's atomic save lands first.
      fs.writeFileSync(request.targetPath!, 'outside writer\n')
      const replaced = await w.holder.replaceAcquisition(ownerH, admitted.transitionId, [request])
      if (!replaced.ok) throw new Error('replace failed')
      const [leasePartition] = mutationFencePartitionKeys(replaced.leases.map((l) => l.claim))
      expect(leasePartition).not.toBe(admission)
      // Final commit-boundary verification passes; the holder stops right after it.
      expect((await w.holder.verifyAcquisitionForMutation(ownerH, replaced.transitionId)).ok).toBe(
        true
      )

      const pass = await w.lapseHolder()
      expect(pass).toMatchObject({
        skipped: false,
        decisions: [],
        deferred: [replaced.leases[0].leaseId],
        reclaimed: []
      })
      // No second writer: the peer cannot take the lease, so it never reaches
      // the dev:ino partition that no fence record names.
      expect(await w.contender.acquire(w.owner(C, 'run-c'), request)).toMatchObject({
        ok: false,
        reason: 'conflict'
      })
      expect(w.fence.readFence(leasePartition)).toBeNull()
      expect((await w.holder.verifyAcquisitionForMutation(ownerH, replaced.transitionId)).ok).toBe(
        true
      )

      // The deferral ends with the commit: out of every fence, the lapse retires it.
      expect(w.fence.release(holderFence)).toBe(true)
      expect(await w.reclaimer.runPeriodicRecovery()).toMatchObject({
        skipped: false,
        decisions: [
          { leaseId: replaced.leases[0].leaseId, status: 'recovered', reason: 'owner_dead' }
        ],
        deferred: [],
        reclaimed: [expect.objectContaining({ evidence: 'lease_lapsed' })]
      })
      const contended = await w.contender.acquire(w.owner(C, 'run-c'), request)
      expect(contended.ok).toBe(true)
    } finally {
      w.dispose()
    }
  })

  it('defers a holder whose partition never moved, and the fence would stop a contender anyway', async () => {
    const w = await world()
    try {
      const ownerH = w.owner(H, 'run-h')
      const request = w.request('existing.ts')
      const admitted = await w.holder.acquire(ownerH, request)
      if (!admitted.ok) throw new Error('admission failed')
      const [admission] = mutationFencePartitionKeys(admitted.leases.map((lease) => lease.claim))
      const holderFence = await w.fence.acquire(w.fenceOwner(H, 'run-h'), admission)
      const replaced = await w.holder.replaceAcquisition(ownerH, admitted.transitionId, [request])
      if (!replaced.ok) throw new Error('replace failed')
      expect(mutationFencePartitionKeys(replaced.leases.map((l) => l.claim))).toEqual([admission])

      const pass = await w.lapseHolder()
      expect(pass).toMatchObject({
        skipped: false,
        deferred: [replaced.leases[0].leaseId],
        reclaimed: []
      })
      expect(await w.contender.acquire(w.owner(C, 'run-c'), request)).toMatchObject({
        ok: false,
        reason: 'conflict'
      })
      // Even with no deferral, the live holder's partition stays Busy.
      await expect(w.fence.acquire(w.fenceOwner(C, 'run-c'), admission)).rejects.toBeInstanceOf(
        WorkspaceMutationCommitFenceBusyError
      )
      w.fence.release(holderFence)
    } finally {
      w.dispose()
    }
  })
})
