import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  resolveCanonicalWorkspaceLockPath,
  verifyCanonicalWorkspaceLockPath
} from './CanonicalWorkspaceLockPath'
import { NodeWorkspaceLockPersistence } from './NodeWorkspaceLockPersistence'
import { WorkspaceLockAuthority } from './WorkspaceLockAuthority'
import type {
  WorkspaceLockAuthorityDependencies,
  WorkspaceLockOwner,
  WorkspaceLockProcessObservation,
  WorkspaceLockSnapshot
} from './WorkspaceLockTypes'
import { decodeWorkspaceLockWal } from './WorkspaceLockWal'

/**
 * End-to-end parallel-mission proof for 1.9.3 safe-parallelism:
 * contend from live lock state → survive authority restart/replay →
 * resume after the holder is gone → retain an auditable WAL/onChange trail.
 *
 * Scheduling is deliberately client-driven from `snapshot()` / `onChange`
 * (live lock truth). There is no separate wait-queue product API; inventing
 * one would be a lock-core redesign and is out of this lane's scope.
 */

const temporaryRoots: string[] = []
let globalId = 0
let globalTime = Date.parse('2026-08-02T12:00:00.000Z')

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

function harness(instanceId = 'mission-instance-a') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-parallel-mission-'))
  const userData = path.join(root, 'user-data')
  const workspace = path.join(root, 'workspace')
  fs.mkdirSync(userData)
  fs.mkdirSync(workspace)
  fs.mkdirSync(path.join(workspace, 'src'))
  fs.writeFileSync(path.join(workspace, 'src', 'shared.ts'), 'export const n = 1\n')
  temporaryRoots.push(root)

  const observations = new Map<number, WorkspaceLockProcessObservation>([
    [100, { state: 'live', processBirthIdentity: 'authority-birth' }],
    [201, { state: 'live', processBirthIdentity: 'mission-a-birth' }],
    [202, { state: 'live', processBirthIdentity: 'mission-b-birth' }]
  ])

  const dependencies: WorkspaceLockAuthorityDependencies = {
    nowIso: () => new Date(globalTime++).toISOString(),
    nextId: (kind) => `${kind}-${++globalId}`,
    observeProcess: async (pid) => observations.get(pid) || { state: 'identity_unavailable' },
    canonicalizePath: (input) => {
      try {
        return fs.realpathSync(input)
      } catch {
        return path.resolve(input)
      }
    },
    resolveTargetPath: (targetRoot, targetPath) =>
      resolveCanonicalWorkspaceLockPath({ rootPath: targetRoot, targetPath }),
    verifyTargetPath: (expected) => verifyCanonicalWorkspaceLockPath(expected),
    validateHunkBaseline: async () => true,
    instance: {
      instanceId,
      pid: 100,
      processBirthIdentity: 'authority-birth'
    }
  }

  const persistence = new NodeWorkspaceLockPersistence({ userDataRoot: userData })
  const targetPath = path.join(workspace, 'src', 'shared.ts')
  const request = {
    workspacePath: workspace,
    kind: 'file' as const,
    targetPath
  }

  return { root, userData, workspace, targetPath, request, observations, dependencies, persistence }
}

function owner(
  overrides: Partial<WorkspaceLockOwner> & Pick<WorkspaceLockOwner, 'lockOwnerId' | 'runId'>
): WorkspaceLockOwner {
  return {
    pid: 201,
    processBirthIdentity: 'mission-a-birth',
    ...overrides
  }
}

function missionA(): WorkspaceLockOwner {
  return owner({
    lockOwnerId: 'mission-a',
    runId: 'run-mission-a',
    laneId: 'wave-a',
    displayName: 'Mission A'
  })
}

function missionB(): WorkspaceLockOwner {
  return owner({
    lockOwnerId: 'mission-b',
    runId: 'run-mission-b',
    laneId: 'wave-a',
    pid: 202,
    processBirthIdentity: 'mission-b-birth',
    displayName: 'Mission B'
  })
}

function activeHolders(snapshot: WorkspaceLockSnapshot): WorkspaceLockSnapshot['leases'] {
  return snapshot.leases.filter((lease) => lease.status !== 'recovered')
}

function claimConflictsWithHolders(
  snapshot: WorkspaceLockSnapshot,
  relativeTargetPath: string
): boolean {
  return activeHolders(snapshot).some(
    (lease) =>
      lease.claim.kind === 'workspace' ||
      lease.claim.kind === 'tree' ||
      lease.claim.relativeTargetPath === relativeTargetPath
  )
}

/**
 * Schedule the next acquire attempt from live lock state rather than a guessed
 * delay. Resolves when onChange reports no active conflicting holders.
 */
async function waitUntilClaimFree(input: {
  authority: WorkspaceLockAuthority
  relativeTargetPath: string
  timeoutMs?: number
}): Promise<WorkspaceLockSnapshot> {
  const timeoutMs = input.timeoutMs ?? 2_000
  const immediate = input.authority.snapshot()
  if (!claimConflictsWithHolders(immediate, input.relativeTargetPath)) {
    return immediate
  }

  return await new Promise<WorkspaceLockSnapshot>((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe()
      reject(
        new Error(
          `Timed out waiting for live lock state to free ${input.relativeTargetPath}. ` +
            `Active holders: ${activeHolders(input.authority.snapshot())
              .map((lease) => `${lease.owner.runId}:${lease.status}`)
              .join(', ')}`
        )
      )
    }, timeoutMs)

    const unsubscribe = input.authority.onChange((snapshot) => {
      if (!claimConflictsWithHolders(snapshot, input.relativeTargetPath)) {
        clearTimeout(timer)
        unsubscribe()
        resolve(snapshot)
      }
    })
  })
}

function walKinds(persistence: NodeWorkspaceLockPersistence): string[] {
  return decodeWorkspaceLockWal(persistence.readEvents().raw).events.map((event) => event.kind)
}

describe('WorkspaceLockParallelMission integration', () => {
  it('contends from live lock state, resumes after release, and audits via onChange + WAL', async () => {
    const h = harness()
    const authority = await WorkspaceLockAuthority.open({
      persistence: h.persistence,
      dependencies: h.dependencies
    })

    const audit: Array<{ sequence: number; lastTransitionId: string; holderRunIds: string[] }> = []
    const stopAudit = authority.onChange((snapshot) => {
      audit.push({
        sequence: snapshot.sequence,
        lastTransitionId: snapshot.lastTransitionId,
        holderRunIds: activeHolders(snapshot).map((lease) => lease.owner.runId)
      })
    })

    const held = await authority.acquire(missionA(), h.request, {
      transitionId: 'mission-a-acquire'
    })
    expect(held).toMatchObject({ ok: true, transitionId: 'mission-a-acquire' })

    const contended = await authority.acquire(missionB(), h.request, {
      transitionId: 'mission-b-contend'
    })
    expect(contended).toMatchObject({ ok: false, reason: 'conflict' })
    if (contended.ok || contended.reason !== 'conflict' || !contended.conflict) {
      throw new Error('expected live-state conflict payload')
    }
    expect(contended.conflict.holders.map((lease) => lease.owner.runId)).toEqual(['run-mission-a'])
    expect(contended.conflict.holders[0]?.status).toBe('held')
    // Contender must not invent a lease; only the live holder remains.
    expect(activeHolders(authority.snapshot()).map((lease) => lease.owner.runId)).toEqual([
      'run-mission-a'
    ])

    const resume = (async () => {
      await waitUntilClaimFree({
        authority,
        relativeTargetPath: 'src/shared.ts'
      })
      return authority.acquire(missionB(), h.request, {
        transitionId: 'mission-b-resume'
      })
    })()

    const released = await authority.releaseAllForRun('run-mission-a', {
      transitionId: 'mission-a-release'
    })
    expect(released).toMatchObject({ ok: true, transitionId: 'mission-a-release' })

    const resumed = await resume
    expect(resumed).toMatchObject({ ok: true, transitionId: 'mission-b-resume' })
    expect(activeHolders(authority.snapshot()).map((lease) => lease.owner.runId)).toEqual([
      'run-mission-b'
    ])

    stopAudit()
    expect(audit.some((entry) => entry.holderRunIds.includes('run-mission-a'))).toBe(true)
    expect(audit.some((entry) => entry.holderRunIds.includes('run-mission-b'))).toBe(true)
    expect(walKinds(h.persistence)).toEqual(
      expect.arrayContaining(['boot', 'acquire', 'release_run', 'acquire'])
    )

    await authority.releaseAllForRun('run-mission-b')
    authority.dispose()
  })

  it('survives authority restart/replay while contended, then resumes after recovery release', async () => {
    const h = harness('mission-instance-restart-a')
    let authority = await WorkspaceLockAuthority.open({
      persistence: h.persistence,
      dependencies: h.dependencies
    })

    const held = await authority.acquire(missionA(), h.request, {
      transitionId: 'mission-a-pre-restart'
    })
    expect(held).toMatchObject({ ok: true })

    const beforeRestart = await authority.acquire(missionB(), h.request, {
      transitionId: 'mission-b-pre-restart'
    })
    expect(beforeRestart).toMatchObject({ ok: false, reason: 'conflict' })

    authority.dispose()

    // Restart / WAL replay: live owner remains durable as orphan_live.
    authority = await WorkspaceLockAuthority.open({
      persistence: h.persistence,
      dependencies: {
        ...h.dependencies,
        instance: {
          ...h.dependencies.instance,
          instanceId: 'mission-instance-restart-b'
        }
      }
    })

    const replayed = authority.snapshot().leases
    expect(replayed).toHaveLength(1)
    expect(replayed[0]).toMatchObject({
      owner: { runId: 'run-mission-a' },
      status: 'orphan_live',
      claim: { relativeTargetPath: 'src/shared.ts' }
    })

    const stillContended = await authority.acquire(missionB(), h.request, {
      transitionId: 'mission-b-post-restart'
    })
    expect(stillContended).toMatchObject({ ok: false, reason: 'conflict' })
    if (stillContended.ok || stillContended.reason !== 'conflict' || !stillContended.conflict) {
      throw new Error('expected post-restart conflict from replayed live lock state')
    }
    expect(stillContended.conflict.holders[0]?.status).toBe('orphan_live')

    // Terminal cleanup cannot guess the orphan away while the owner is still live.
    expect(
      await authority.releaseAllForRun('run-mission-a', {
        transitionId: 'mission-a-foreign-cleanup'
      })
    ).toMatchObject({ ok: false, reason: 'foreign_owner' })

    // Recovery release path: owner becomes uninspectable then dead across a
    // fresh authority boot so scheduling always reads replayed live state.
    h.observations.set(201, { state: 'identity_unavailable' })
    authority.dispose()
    authority = await WorkspaceLockAuthority.open({
      persistence: h.persistence,
      dependencies: {
        ...h.dependencies,
        instance: {
          ...h.dependencies.instance,
          instanceId: 'mission-instance-restart-c'
        }
      }
    })
    expect(authority.snapshot().leases[0]?.status).toBe('recovery_blocked')

    const resumeAfterRecovery = (async () => {
      await waitUntilClaimFree({
        authority,
        relativeTargetPath: 'src/shared.ts'
      })
      return authority.acquire(missionB(), h.request, {
        transitionId: 'mission-b-after-recovery'
      })
    })()

    h.observations.set(201, { state: 'dead' })
    const recovered = await authority.recoverStaleClaims()
    expect(recovered.decisions.length).toBeGreaterThan(0)
    expect(authority.snapshot().leases[0]).toMatchObject({
      status: 'recovered',
      recoveryReason: 'owner_dead'
    })

    const resumed = await resumeAfterRecovery
    expect(resumed).toMatchObject({ ok: true, transitionId: 'mission-b-after-recovery' })
    expect(activeHolders(authority.snapshot()).map((lease) => lease.owner.runId)).toEqual([
      'run-mission-b'
    ])

    const kinds = walKinds(h.persistence)
    expect(kinds.filter((kind) => kind === 'boot').length).toBeGreaterThanOrEqual(3)
    expect(kinds).toEqual(expect.arrayContaining(['acquire', 'recover', 'acquire']))

    await authority.releaseAllForRun('run-mission-b')
    authority.dispose()
  })
})
