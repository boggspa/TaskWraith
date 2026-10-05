import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  resolveCanonicalWorkspaceLockPath,
  verifyCanonicalWorkspaceLockPath
} from './CanonicalWorkspaceLockPath'
import {
  NodeWorkspaceLockPersistence,
  WORKSPACE_LOCK_AUTHORITY_DIRECTORY,
  WORKSPACE_LOCK_EVENTS_FILENAME,
  WORKSPACE_LOCK_HOLDERS_DIRECTORY,
  WORKSPACE_LOCK_RECLAIM_AUDIT_FILENAME
} from './NodeWorkspaceLockPersistence'
import {
  WorkspaceLockAuthority,
  WorkspaceLockAuthorityBusyError,
  type WorkspaceLockHolderLeaseOptions,
  type WorkspaceLockPeriodicRecoveryOutcome
} from './WorkspaceLockAuthority'
import { WORKSPACE_LOCK_HEARTBEAT_SCHEMA } from './WorkspaceLockHolderHeartbeat'
import { workspaceLockRuntimeMarkerFilename } from './WorkspaceLockMarkerProjection'
import type {
  WorkspaceLockAuthorityDependencies,
  WorkspaceLockCommitFenceOwnerIdentity,
  WorkspaceLockOwner,
  WorkspaceLockProcessObservation
} from './WorkspaceLockTypes'
import { decodeWorkspaceLockWal } from './WorkspaceLockWal'

const temporaryRoots: string[] = []
let globalId = 0
let globalTime = Date.parse('2026-07-29T18:00:00.000Z')

function canonicalRealpath(input: string): string {
  const realpath =
    typeof fs.realpathSync.native === 'function' ? fs.realpathSync.native : fs.realpathSync
  return realpath(input)
}

const authorities = new Set<WorkspaceLockAuthority>()
const authorityOperations = new Set<Promise<unknown>>()

function trackAuthorityOperation<T>(work: () => Promise<T>): () => Promise<T> {
  return () => {
    const pending = work()
    authorityOperations.add(pending)
    void pending.then(
      () => authorityOperations.delete(pending),
      () => authorityOperations.delete(pending)
    )
    return pending
  }
}

async function openAuthority(
  options: Parameters<typeof WorkspaceLockAuthority.open>[0]
): Promise<WorkspaceLockAuthority> {
  const authority = await WorkspaceLockAuthority.open(options)
  authorities.add(authority)
  authority.writeHolderHeartbeat = trackAuthorityOperation(
    authority.writeHolderHeartbeat.bind(authority)
  )
  authority.runPeriodicRecovery = trackAuthorityOperation(
    authority.runPeriodicRecovery.bind(authority)
  )
  authority.renewDerivedMarkers = trackAuthorityOperation(
    authority.renewDerivedMarkers.bind(authority)
  )
  return authority
}

function removeTemporaryRoot(root: string): void {
  const temporary = os.tmpdir()
  expect(root).not.toBe(temporary)
  expect(path.dirname(root)).toBe(temporary)
  expect(root.startsWith(temporary + path.sep + 'taskwraith-lock-authority-')).toBe(true)
  fs.rmSync(root, { recursive: true, force: true })
}

afterEach(async () => {
  // Disposal stops future beats; a write already in flight still needs joining.
  for (const authority of authorities) authority.dispose()
  const errors: unknown[] = []
  while (authorityOperations.size) {
    const settled = await Promise.allSettled([...authorityOperations])
    for (const result of settled) {
      if (result.status === 'rejected') errors.push(result.reason)
    }
  }
  // A renewal finishing during the drain can have rearmed its timer.
  for (const authority of authorities) authority.dispose()
  authorities.clear()
  for (const root of temporaryRoots.splice(0)) removeTemporaryRoot(root)
  if (errors.length) throw new AggregateError(errors, 'Authority fixture work failed during cleanup')
})

function harness(instanceId = 'instance-a') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-lock-authority-'))
  const userData = path.join(root, 'user-data')
  const workspace = path.join(root, 'workspace')
  fs.mkdirSync(userData)
  fs.mkdirSync(workspace)
  fs.mkdirSync(path.join(workspace, 'src'))
  fs.writeFileSync(path.join(workspace, 'src', 'a.ts'), 'a\n')
  fs.writeFileSync(path.join(workspace, 'src', 'b.ts'), 'b\n')
  temporaryRoots.push(root)

  const observations = new Map<number, WorkspaceLockProcessObservation>([
    [100, { state: 'live', processBirthIdentity: 'authority-birth' }],
    [201, { state: 'live', processBirthIdentity: 'owner-a-birth' }],
    [202, { state: 'live', processBirthIdentity: 'owner-b-birth' }],
    [203, { state: 'live', processBirthIdentity: 'spawned-child-birth' }]
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
  return { root, userData, workspace, observations, dependencies, persistence }
}

function owner(
  overrides: Partial<WorkspaceLockOwner> & Pick<WorkspaceLockOwner, 'lockOwnerId' | 'runId'>
): WorkspaceLockOwner {
  return {
    pid: 201,
    processBirthIdentity: 'owner-a-birth',
    ...overrides
  }
}

function runtimeMarkerContents(root: string): string[] {
  return fs
    .readdirSync(root)
    .filter((name) => name.startsWith('.WORK-IN-PROGRESS-taskwraith-runtime-'))
    .map((name) => fs.readFileSync(path.join(root, name), 'utf8'))
}

describe('WorkspaceLockAuthority', () => {
  it('reuses decoded WAL state until an external durable journal append changes its revision', async () => {
    const h = harness()
    const readEvents = vi.spyOn(h.persistence, 'readEvents')
    const authority = await openAuthority({
      persistence: h.persistence,
      dependencies: h.dependencies
    })
    const readsAfterOpen = readEvents.mock.calls.length

    authority.snapshot()
    authority.snapshot()
    expect(readEvents).toHaveBeenCalledTimes(readsAfterOpen)

    const beforeExternalAppend = h.persistence.readEvents()
    const external = await openAuthority({
      persistence: h.persistence,
      dependencies: {
        ...h.dependencies,
        instance: { ...h.dependencies.instance, instanceId: 'external-instance' }
      }
    })
    const afterExternalAppend = h.persistence.readEvents()
    expect(afterExternalAppend.byteLength).toBeGreaterThan(beforeExternalAppend.byteLength)
    expect(afterExternalAppend.revision).not.toBe(beforeExternalAppend.revision)

    const readsBeforeStaleSnapshot = readEvents.mock.calls.length
    expect(authority.snapshot().sequence).toBe(external.snapshot().sequence)
    expect(readEvents).toHaveBeenCalledTimes(readsBeforeStaleSnapshot + 1)
    external.dispose()
    authority.dispose()
  })

  it('does not replay the full WAL for self-authored transitions and verification', async () => {
    const h = harness()
    const readEvents = vi.spyOn(h.persistence, 'readEvents')
    const authority = await openAuthority({
      persistence: h.persistence,
      dependencies: h.dependencies
    })
    const readsAfterOpen = readEvents.mock.calls.length
    const operationOwner = owner({ lockOwnerId: 'cached-owner', runId: 'cached-run' })
    const acquired = await authority.acquire(
      operationOwner,
      {
        workspacePath: h.workspace,
        kind: 'file',
        targetPath: path.join(h.workspace, 'src', 'a.ts')
      },
      { transitionId: 'cached-acquisition' }
    )
    if (!acquired.ok) throw new Error('fixture acquisition failed')

    expect(readEvents).toHaveBeenCalledTimes(readsAfterOpen)
    expect(
      await authority.verifyAcquisitionForMutation(operationOwner, acquired.transitionId)
    ).toMatchObject({ ok: true })
    expect(readEvents).toHaveBeenCalledTimes(readsAfterOpen)
    expect(
      await authority.releaseAcquisition(operationOwner.runId, acquired.transitionId)
    ).toMatchObject({
      ok: true
    })
    expect(readEvents).toHaveBeenCalledTimes(readsAfterOpen)
    authority.dispose()
  }, 30_000)

  it('acquires deterministic batches atomically and permits the exact owner to continue', async () => {
    const h = harness()
    const authority = await openAuthority({
      persistence: h.persistence,
      dependencies: h.dependencies
    })
    const firstOwner = owner({ lockOwnerId: 'owner-a', runId: 'run-a' })
    const acquired = await authority.acquireMany(firstOwner, [
      {
        workspacePath: h.workspace,
        kind: 'file',
        targetPath: path.join(h.workspace, 'src', 'b.ts')
      },
      {
        workspacePath: h.workspace,
        kind: 'file',
        targetPath: path.join(h.workspace, 'src', 'a.ts')
      }
    ])
    expect(acquired.ok && acquired.leases.map((lease) => lease.claim.relativeTargetPath)).toEqual([
      'src/a.ts',
      'src/b.ts'
    ])

    const reentrant = await authority.acquire(firstOwner, {
      workspacePath: h.workspace,
      kind: 'file',
      targetPath: path.join(h.workspace, 'src', 'a.ts')
    })
    expect(reentrant.ok).toBe(true)

    const conflict = await authority.acquireMany(
      owner({
        lockOwnerId: 'owner-b',
        runId: 'run-b',
        pid: 202,
        processBirthIdentity: 'owner-b-birth'
      }),
      [
        {
          workspacePath: h.workspace,
          kind: 'file',
          targetPath: path.join(h.workspace, 'src', 'b.ts')
        },
        {
          workspacePath: h.workspace,
          kind: 'file',
          targetPath: path.join(h.workspace, 'src', 'missing.ts')
        }
      ]
    )
    expect(conflict).toMatchObject({ ok: false, reason: 'conflict' })
    expect(authority.snapshot().leases.filter((lease) => lease.owner.runId === 'run-b')).toEqual([])
    authority.dispose()
  }, 30_000)

  it('contains untrusted presentation before WAL preparation without weakening owner ids', async () => {
    const h = harness()
    const authority = await openAuthority({
      persistence: h.persistence,
      dependencies: h.dependencies
    })
    const acquired = await authority.acquire(
      owner({
        lockOwnerId: 'display-owner',
        runId: 'display-run',
        displayName: 'Sol\n\0Boss',
        chatTitle: '# 1.9.3 bounded work program\n\n...'
      }),
      {
        workspacePath: h.workspace,
        kind: 'file',
        targetPath: path.join(h.workspace, 'src', 'a.ts')
      }
    )

    expect(acquired).toMatchObject({
      ok: true,
      leases: [
        {
          owner: {
            lockOwnerId: 'display-owner',
            runId: 'display-run',
            displayName: 'Sol Boss',
            chatTitle: '# 1.9.3 bounded work program ...'
          }
        }
      ]
    })
    expect(
      decodeWorkspaceLockWal(h.persistence.readEvents().raw).activeLeases[0]?.owner
    ).toMatchObject({
      lockOwnerId: 'display-owner',
      runId: 'display-run',
      displayName: 'Sol Boss',
      chatTitle: '# 1.9.3 bounded work program ...'
    })

    const beforeInvalidIdentity = h.persistence.readEvents().raw
    expect(
      await authority.acquire(
        owner({
          lockOwnerId: 'invalid-identity-owner',
          runId: 'invalid-identity-run',
          chatId: 'chat\nforgery',
          pid: 202,
          processBirthIdentity: 'owner-b-birth'
        }),
        {
          workspacePath: h.workspace,
          kind: 'file',
          targetPath: path.join(h.workspace, 'src', 'b.ts')
        }
      )
    ).toMatchObject({ ok: false, reason: 'invalid_request' })
    expect(h.persistence.readEvents().raw).toBe(beforeInvalidIdentity)

    expect(
      await authority.acquire(
        owner({
          lockOwnerId: 'next-owner',
          runId: 'next-run',
          pid: 202,
          processBirthIdentity: 'owner-b-birth'
        }),
        {
          workspacePath: h.workspace,
          kind: 'file',
          targetPath: path.join(h.workspace, 'src', 'b.ts')
        }
      )
    ).toMatchObject({ ok: true })
    authority.dispose()
  }, 30_000)

  it('allows disjoint same-baseline hunks but rejects overlap and baseline drift', async () => {
    const h = harness()
    const authority = await openAuthority({
      persistence: h.persistence,
      dependencies: h.dependencies
    })
    const target = path.join(h.workspace, 'src', 'a.ts')
    expect(
      await authority.acquire(owner({ lockOwnerId: 'owner-a', runId: 'run-a' }), {
        workspacePath: h.workspace,
        kind: 'hunk',
        targetPath: target,
        hunk: { baseline: 'sha256:a', startLine: 1, endLine: 4 }
      })
    ).toMatchObject({ ok: true })
    expect(
      await authority.acquire(
        owner({
          lockOwnerId: 'owner-b',
          runId: 'run-b',
          pid: 202,
          processBirthIdentity: 'owner-b-birth'
        }),
        {
          workspacePath: h.workspace,
          kind: 'hunk',
          targetPath: target,
          hunk: { baseline: 'sha256:a', startLine: 5, endLine: 7 }
        }
      )
    ).toMatchObject({ ok: true })
    expect(
      await authority.acquire(
        owner({
          lockOwnerId: 'owner-c',
          runId: 'run-c',
          pid: 202,
          processBirthIdentity: 'owner-b-birth'
        }),
        {
          workspacePath: h.workspace,
          kind: 'hunk',
          targetPath: target,
          hunk: { baseline: 'sha256:b', startLine: 9, endLine: 10 }
        }
      )
    ).toMatchObject({ ok: false, reason: 'conflict' })
    authority.dispose()
  })

  it('makes caller-stable acquire replay idempotent and rejects changed or inactive reuse', async () => {
    const h = harness()
    const authority = await openAuthority({
      persistence: h.persistence,
      dependencies: h.dependencies
    })
    const firstOwner = owner({ lockOwnerId: 'owner-a', runId: 'run-a' })
    const request = {
      workspacePath: h.workspace,
      kind: 'file' as const,
      targetPath: path.join(h.workspace, 'src', 'a.ts')
    }
    const first = await authority.acquire(firstOwner, request, { transitionId: 'operation-a' })
    const replay = await authority.acquire(firstOwner, request, { transitionId: 'operation-a' })
    expect(replay).toEqual(first)
    expect(
      await authority.acquire(
        firstOwner,
        { ...request, targetPath: path.join(h.workspace, 'src', 'b.ts') },
        { transitionId: 'operation-a' }
      )
    ).toMatchObject({ ok: false, reason: 'invalid_request' })
    if (!first.ok) throw new Error('fixture acquisition failed')
    expect(await authority.release(first.tokens[0])).toMatchObject({ ok: true })
    expect(
      await authority.acquire(firstOwner, request, { transitionId: 'operation-a' })
    ).toMatchObject({ ok: false, reason: 'invalid_request' })
    authority.dispose()
  })

  it('atomically refreshes and operation-releases an exact acquisition token set', async () => {
    const h = harness()
    const authority = await openAuthority({
      persistence: h.persistence,
      dependencies: h.dependencies
    })
    const operationOwner = owner({ lockOwnerId: 'operation-owner', runId: 'run-a' })
    const first = await authority.acquireMany(
      operationOwner,
      [
        {
          workspacePath: h.workspace,
          kind: 'file',
          targetPath: path.join(h.workspace, 'src', 'a.ts')
        },
        {
          workspacePath: h.workspace,
          kind: 'file',
          targetPath: path.join(h.workspace, 'src', 'b.ts')
        }
      ],
      { transitionId: 'operation-before' }
    )
    if (!first.ok) throw new Error('fixture acquisition failed')

    const refreshed = await authority.replaceAcquisition(
      operationOwner,
      first.transitionId,
      [
        {
          workspacePath: h.workspace,
          kind: 'hunk',
          targetPath: path.join(h.workspace, 'src', 'a.ts'),
          hunk: { baseline: 'sha256:fresh', startLine: 0, endLine: 1 }
        }
      ],
      { transitionId: 'operation-after' }
    )
    if (!refreshed.ok) throw new Error('fixture replacement failed')
    expect(refreshed.leases).toHaveLength(1)
    expect(authority.snapshot().leases.filter((lease) => lease.status === 'held')).toEqual(
      expect.arrayContaining([expect.objectContaining({ acquiredTransitionId: 'operation-after' })])
    )
    expect(
      authority.snapshot().leases.some((lease) => lease.acquiredTransitionId === 'operation-before')
    ).toBe(false)
    expect(await authority.release(first.tokens[0])).toMatchObject({
      ok: false,
      reason: 'stale_token'
    })
    expect(
      await authority.replaceAcquisition(
        operationOwner,
        first.transitionId,
        [
          {
            workspacePath: h.workspace,
            kind: 'hunk',
            targetPath: path.join(h.workspace, 'src', 'a.ts'),
            hunk: { baseline: 'sha256:fresh', startLine: 0, endLine: 1 }
          }
        ],
        { transitionId: 'operation-after' }
      )
    ).toEqual(refreshed)
    expect(await authority.releaseAcquisition('run-a', refreshed.transitionId)).toMatchObject({
      ok: true,
      released: [expect.objectContaining({ acquiredTransitionId: 'operation-after' })]
    })
    expect(authority.snapshot().leases.filter((lease) => lease.status === 'held')).toEqual([])
    authority.dispose()
  }, 30_000)

  it('returns verified exact mutation capabilities and rejects an ancestor symlink swap', async () => {
    const h = harness()
    const first = path.join(h.workspace, 'first')
    const second = path.join(h.workspace, 'second')
    const alias = path.join(h.workspace, 'current')
    fs.mkdirSync(first)
    fs.mkdirSync(second)
    fs.writeFileSync(path.join(first, 'target.ts'), 'first\n')
    fs.writeFileSync(path.join(second, 'target.ts'), 'second\n')
    fs.symlinkSync(first, alias, process.platform === 'win32' ? 'junction' : 'dir')

    const authority = await openAuthority({
      persistence: h.persistence,
      dependencies: h.dependencies
    })
    const operationOwner = owner({ lockOwnerId: 'operation-owner', runId: 'run-a' })
    const acquired = await authority.acquire(
      operationOwner,
      {
        workspacePath: h.workspace,
        kind: 'file',
        targetPath: path.join(alias, 'target.ts')
      },
      { transitionId: 'verified-operation' }
    )
    if (!acquired.ok) throw new Error('fixture acquisition failed')
    const capability = await authority.verifyAcquisitionForMutation(
      operationOwner,
      acquired.transitionId
    )
    expect(capability).toMatchObject({
      ok: true,
      capabilities: [
        {
          executableTargetPath: canonicalRealpath(path.join(first, 'target.ts'))
        }
      ]
    })

    fs.unlinkSync(alias)
    fs.symlinkSync(second, alias, process.platform === 'win32' ? 'junction' : 'dir')
    expect(
      await authority.verifyAcquisitionForMutation(operationOwner, acquired.transitionId)
    ).toMatchObject({ ok: false, reason: 'path_changed' })
    authority.dispose()
  }, 30_000)

  it('atomically transfers a native lease to the exact spawned child incarnation', async () => {
    const h = harness()
    const authority = await openAuthority({
      persistence: h.persistence,
      dependencies: h.dependencies
    })
    const admittingOwner = owner({
      lockOwnerId: 'native-process',
      runId: 'run-native',
      lifecycle: 'launching-child'
    })
    const acquired = await authority.acquire(
      admittingOwner,
      {
        workspacePath: h.workspace,
        kind: 'file',
        targetPath: path.join(h.workspace, 'src', 'a.ts')
      },
      { transitionId: 'native-admission' }
    )
    if (!acquired.ok) throw new Error('fixture acquisition failed')
    const childOwner = {
      ...admittingOwner,
      pid: 203,
      processBirthIdentity: 'spawned-child-birth'
    }
    const transferred = await authority.transferAcquisition(
      admittingOwner,
      acquired.transitionId,
      childOwner,
      { transitionId: 'native-child-transfer' }
    )
    if (!transferred.ok) throw new Error('fixture transfer failed')
    expect(transferred.leases).toEqual([
      expect.objectContaining({
        acquiredTransitionId: 'native-child-transfer',
        owner: expect.objectContaining({
          lockOwnerId: 'native-process',
          runId: 'run-native',
          lifecycle: 'child',
          pid: 203,
          processBirthIdentity: 'spawned-child-birth'
        })
      })
    ])
    expect(
      authority.snapshot().leases.some((lease) => lease.acquiredTransitionId === 'native-admission')
    ).toBe(false)
    expect(await authority.release(acquired.tokens[0])).toMatchObject({
      ok: false,
      reason: 'stale_token'
    })
    const marker = workspaceLockRuntimeMarkerFilename('instance-a', 'native-process')
    expect(fs.readFileSync(path.join(h.workspace, marker), 'utf8')).toContain('pid: 203')
    expect(
      await authority.transferAcquisition(admittingOwner, acquired.transitionId, childOwner, {
        transitionId: 'native-child-transfer'
      })
    ).toEqual(transferred)
    expect(await authority.releaseAllForRun('run-native')).toMatchObject({
      ok: true,
      released: [],
      retainedReason: 'managed_child',
      retained: [expect.objectContaining({ acquiredTransitionId: transferred.transitionId })]
    })
    expect(
      await authority.transferAcquisition(
        childOwner,
        transferred.transitionId,
        { ...admittingOwner, runId: 'different-run' },
        { transitionId: 'invalid-transfer' }
      )
    ).toMatchObject({ ok: false, reason: 'invalid_request' })
    expect(
      await authority.releaseAcquisition('run-native', transferred.transitionId)
    ).toMatchObject({ ok: true })
    authority.dispose()
  })

  it('keeps launching and transferred child leases blocked across guardian/leader death', async () => {
    const h = harness()
    let authority = await openAuthority({
      persistence: h.persistence,
      dependencies: h.dependencies
    })
    const launchingOwner = owner({
      lockOwnerId: 'opaque-child',
      runId: 'opaque-child-run',
      lifecycle: 'launching-child'
    })
    const launching = await authority.acquire(
      launchingOwner,
      {
        workspacePath: h.workspace,
        kind: 'file',
        targetPath: path.join(h.workspace, 'src', 'a.ts')
      },
      { transitionId: 'opaque-launching' }
    )
    if (!launching.ok) throw new Error('fixture launching acquisition failed')
    authority.dispose()

    h.observations.set(201, { state: 'dead' })
    authority = await openAuthority({
      persistence: h.persistence,
      dependencies: h.dependencies
    })
    const blockedLaunch = authority.snapshot().leases
    expect(blockedLaunch).toEqual([
      expect.objectContaining({
        status: 'recovery_blocked',
        owner: expect.objectContaining({ lifecycle: 'launching-child' })
      })
    ])
    expect(
      await authority.releaseAllForRun('opaque-child-run', {
        transitionId: 'retain-launching'
      })
    ).toMatchObject({
      ok: true,
      released: [],
      retainedReason: 'launching_child'
    })
    expect(
      await authority.acquire(
        owner({
          lockOwnerId: 'rival',
          runId: 'rival-run',
          pid: 202,
          processBirthIdentity: 'owner-b-birth'
        }),
        {
          workspacePath: h.workspace,
          kind: 'file',
          targetPath: path.join(h.workspace, 'src', 'a.ts')
        }
      )
    ).toMatchObject({ ok: false, reason: 'conflict' })
    expect(
      await authority.forceReleaseRecoveryBlockedAcquisition(
        'opaque-child-run',
        'opaque-launching',
        [blockedLaunch[0].leaseId],
        'human-approval-launching',
        { transitionId: 'force-launching' }
      )
    ).toMatchObject({ ok: true })

    h.observations.set(201, {
      state: 'live',
      processBirthIdentity: 'owner-a-birth'
    })
    const secondAdmission = await authority.acquire(
      launchingOwner,
      {
        workspacePath: h.workspace,
        kind: 'file',
        targetPath: path.join(h.workspace, 'src', 'a.ts')
      },
      { transitionId: 'opaque-second-launch' }
    )
    if (!secondAdmission.ok) throw new Error('fixture second admission failed')
    expect(
      await authority.transferAcquisition(
        launchingOwner,
        secondAdmission.transitionId,
        {
          ...launchingOwner,
          pid: 203,
          processBirthIdentity: 'spawned-child-birth'
        },
        { transitionId: 'opaque-child-transfer' }
      )
    ).toMatchObject({ ok: true })
    authority.dispose()

    h.observations.set(201, { state: 'dead' })
    h.observations.set(203, { state: 'dead' })
    authority = await openAuthority({
      persistence: h.persistence,
      dependencies: h.dependencies
    })
    const blockedChild = authority.snapshot().leases
    expect(blockedChild).toEqual([
      expect.objectContaining({
        status: 'recovery_blocked',
        owner: expect.objectContaining({ lifecycle: 'child', pid: 203 })
      })
    ])
    expect(
      await authority.releaseAllForRun('opaque-child-run', {
        transitionId: 'retain-managed-child'
      })
    ).toMatchObject({
      ok: true,
      released: [],
      retainedReason: 'managed_child'
    })
    expect(
      await authority.forceReleaseRecoveryBlockedAcquisition(
        'opaque-child-run',
        'opaque-child-transfer',
        [blockedChild[0].leaseId],
        'human-approval-managed-child',
        { transitionId: 'force-managed-child' }
      )
    ).toMatchObject({ ok: true })
    authority.dispose()
  }, 20_000)

  it('durably exposes one exact closed child to recovery without restarting', async () => {
    const h = harness()
    const authority = await openAuthority({
      persistence: h.persistence,
      dependencies: h.dependencies
    })
    const launchingOwner = owner({
      lockOwnerId: 'restartless-child',
      runId: 'restartless-run',
      lifecycle: 'launching-child'
    })
    const admitted = await authority.acquire(
      launchingOwner,
      {
        workspacePath: h.workspace,
        kind: 'file',
        targetPath: path.join(h.workspace, 'src', 'a.ts')
      },
      { transitionId: 'restartless-admission' }
    )
    if (!admitted.ok) throw new Error('fixture admission failed')
    const childOwner = {
      ...launchingOwner,
      lifecycle: 'child' as const,
      pid: 203,
      processBirthIdentity: 'spawned-child-birth'
    }
    const transferred = await authority.transferAcquisition(
      launchingOwner,
      admitted.transitionId,
      childOwner,
      { transitionId: 'restartless-transfer' }
    )
    if (!transferred.ok) throw new Error('fixture transfer failed')
    const nested = await authority.acquire(
      childOwner,
      {
        workspacePath: h.workspace,
        kind: 'file',
        targetPath: path.join(h.workspace, 'src', 'b.ts')
      },
      { transitionId: 'restartless-nested' }
    )
    if (!nested.ok) throw new Error('fixture nested acquisition failed')

    const quarantined = await authority.quarantineChildOwnerAcquisitions(childOwner)

    expect(quarantined.decisions).toHaveLength(2)
    expect(quarantined.decisions).toEqual(
      expect.arrayContaining([
        { leaseId: transferred.leases[0].leaseId, status: 'recovery_blocked' },
        { leaseId: nested.leases[0].leaseId, status: 'recovery_blocked' }
      ])
    )
    const blocked = authority
      .snapshot()
      .leases.find((lease) => lease.acquiredTransitionId === 'restartless-transfer')
    if (!blocked) throw new Error('fixture quarantine lease missing')
    expect(blocked).toMatchObject({
      acquiredTransitionId: 'restartless-transfer',
      status: 'recovery_blocked'
    })
    expect(await authority.quarantineChildOwnerAcquisitions(childOwner)).toEqual({ decisions: [] })
    expect(
      await authority.acquire(
        owner({
          lockOwnerId: 'restartless-rival',
          runId: 'restartless-rival-run',
          pid: 202,
          processBirthIdentity: 'owner-b-birth'
        }),
        {
          workspacePath: h.workspace,
          kind: 'file',
          targetPath: path.join(h.workspace, 'src', 'a.ts')
        }
      )
    ).toMatchObject({ ok: false, reason: 'conflict' })
    expect(
      await authority.forceReleaseRecoveryBlockedAcquisition(
        'restartless-run',
        'restartless-transfer',
        [blocked.leaseId],
        'restartless-human-approval'
      )
    ).toMatchObject({ ok: true })
    const nestedBlocked = authority
      .snapshot()
      .leases.find((lease) => lease.acquiredTransitionId === 'restartless-nested')
    if (!nestedBlocked) throw new Error('fixture nested quarantine lease missing')
    expect(
      await authority.forceReleaseRecoveryBlockedAcquisition(
        'restartless-run',
        'restartless-nested',
        [nestedBlocked.leaseId],
        'restartless-nested-human-approval'
      )
    ).toMatchObject({ ok: true })
    authority.dispose()
  })

  it('releases parent leases while retaining managed children and replays the typed result', async () => {
    const h = harness()
    const authority = await openAuthority({
      persistence: h.persistence,
      dependencies: h.dependencies
    })
    const parent = owner({ lockOwnerId: 'mixed-parent', runId: 'mixed-run' })
    const child = owner({
      lockOwnerId: 'mixed-child',
      runId: 'mixed-run',
      lifecycle: 'child',
      pid: 203,
      processBirthIdentity: 'spawned-child-birth'
    })
    expect(
      await authority.acquire(
        parent,
        {
          workspacePath: h.workspace,
          kind: 'file',
          targetPath: path.join(h.workspace, 'src', 'a.ts')
        },
        { transitionId: 'mixed-parent-acquire' }
      )
    ).toMatchObject({ ok: true })
    expect(
      await authority.acquire(
        child,
        {
          workspacePath: h.workspace,
          kind: 'file',
          targetPath: path.join(h.workspace, 'src', 'b.ts')
        },
        { transitionId: 'mixed-child-acquire' }
      )
    ).toMatchObject({ ok: true })
    const released = await authority.releaseAllForRun('mixed-run', {
      transitionId: 'mixed-terminal-release'
    })
    expect(released).toMatchObject({
      ok: true,
      transitionId: 'mixed-terminal-release',
      released: [expect.objectContaining({ acquiredTransitionId: 'mixed-parent-acquire' })],
      retained: [expect.objectContaining({ acquiredTransitionId: 'mixed-child-acquire' })],
      retainedReason: 'managed_child'
    })
    expect(
      await authority.releaseAllForRun('mixed-run', {
        transitionId: 'mixed-terminal-release'
      })
    ).toEqual(released)
    expect(
      await authority.releaseAllForRun('mixed-run', {
        transitionId: 'mixed-force-release',
        forceOrphaned: true
      })
    ).toMatchObject({ ok: true })
    authority.dispose()
  })

  it('conflicts hard-link aliases across roots, global filesystem scope, and distinct child owners', async () => {
    const h = harness()
    const other = path.join(h.root, 'other-workspace')
    fs.mkdirSync(other)
    fs.mkdirSync(path.join(other, 'src'))
    fs.linkSync(path.join(h.workspace, 'src', 'a.ts'), path.join(other, 'src', 'alias.ts'))
    fs.writeFileSync(path.join(other, 'src', 'independent.ts'), 'independent\n')
    const authority = await openAuthority({
      persistence: h.persistence,
      dependencies: h.dependencies
    })
    const parentOwner = owner({ lockOwnerId: 'parent-owner', runId: 'shared-run' })
    expect(
      await authority.acquire(parentOwner, {
        workspacePath: h.workspace,
        kind: 'file',
        targetPath: path.join(h.workspace, 'src', 'a.ts')
      })
    ).toMatchObject({ ok: true })
    expect(
      await authority.acquire(
        owner({
          lockOwnerId: 'background-child',
          runId: 'shared-run'
        }),
        {
          workspacePath: other,
          kind: 'file',
          targetPath: path.join(other, 'src', 'alias.ts')
        }
      )
    ).toMatchObject({ ok: false, reason: 'conflict' })

    const globalOwner = owner({
      lockOwnerId: 'global-owner',
      runId: 'global-run',
      pid: 202,
      processBirthIdentity: 'owner-b-birth'
    })
    expect(
      await authority.acquire(globalOwner, {
        workspacePath: other,
        kind: 'workspace',
        globalFilesystem: true
      })
    ).toMatchObject({ ok: false, reason: 'conflict' })
    await authority.releaseAllForRun('shared-run')
    expect(
      await authority.acquire(globalOwner, {
        workspacePath: other,
        kind: 'workspace',
        globalFilesystem: true
      })
    ).toMatchObject({ ok: true })
    expect(
      await authority.acquire(parentOwner, {
        workspacePath: h.workspace,
        kind: 'file',
        targetPath: path.join(h.workspace, 'src', 'b.ts')
      })
    ).toMatchObject({ ok: false, reason: 'conflict' })
    authority.dispose()
  })

  it.skipIf(process.platform === 'win32')(
    'round-trips newline and trailing-space path bytes through the durable WAL',
    async () => {
      const h = harness()
      const unusual = path.join(h.workspace, 'src', 'line\nname.ts ')
      fs.writeFileSync(unusual, 'unusual\n')
      const authority = await openAuthority({
        persistence: h.persistence,
        dependencies: h.dependencies
      })
      const acquired = await authority.acquire(
        owner({ lockOwnerId: 'unusual-path-owner', runId: 'unusual-path-run' }),
        {
          workspacePath: h.workspace,
          kind: 'file',
          targetPath: unusual
        }
      )
      if (!acquired.ok) throw new Error('fixture acquisition failed')
      expect(acquired.leases[0].claim.targetCanonicalPath).toBe(fs.realpathSync(unusual))
      expect(acquired.leases[0].claim.relativeTargetPath).toBe('src/line\nname.ts ')
      expect(authority.snapshot().leases[0].claim.relativeTargetPath).toBe('src/line\nname.ts ')
      authority.dispose()
    }
  )

  it('rejects dead, reused, and uninspectable owner acquisition', async () => {
    const h = harness()
    const authority = await openAuthority({
      persistence: h.persistence,
      dependencies: h.dependencies
    })
    const request = {
      workspacePath: h.workspace,
      kind: 'workspace' as const
    }
    h.observations.set(201, { state: 'dead' })
    expect(
      await authority.acquire(owner({ lockOwnerId: 'dead', runId: 'dead' }), request)
    ).toMatchObject({ ok: false, reason: 'owner_not_live' })
    h.observations.set(201, { state: 'live', processBirthIdentity: 'reused-birth' })
    expect(
      await authority.acquire(owner({ lockOwnerId: 'reused', runId: 'reused' }), request)
    ).toMatchObject({ ok: false, reason: 'owner_not_live' })
    h.observations.set(201, { state: 'identity_unavailable' })
    expect(
      await authority.acquire(owner({ lockOwnerId: 'unknown', runId: 'unknown' }), request)
    ).toMatchObject({ ok: false, reason: 'owner_identity_unavailable' })
    authority.dispose()
  })

  it('replays restart recovery as orphan_live, recovery_blocked, and recovered', async () => {
    const h = harness('instance-a')
    const first = await openAuthority({
      persistence: h.persistence,
      dependencies: h.dependencies
    })
    await first.acquire(owner({ lockOwnerId: 'owner-a', runId: 'run-a' }), {
      workspacePath: h.workspace,
      kind: 'file',
      targetPath: path.join(h.workspace, 'src', 'a.ts')
    })
    first.dispose()

    const secondDependencies = {
      ...h.dependencies,
      instance: { ...h.dependencies.instance, instanceId: 'instance-b' }
    }
    const second = await openAuthority({
      persistence: h.persistence,
      dependencies: secondDependencies
    })
    expect(second.snapshot().leases[0].status).toBe('orphan_live')
    expect(await second.releaseAllForRun('run-a')).toMatchObject({
      ok: false,
      reason: 'foreign_owner'
    })
    expect(second.snapshot().leases[0].status).toBe('orphan_live')
    second.dispose()

    h.observations.set(201, { state: 'identity_unavailable' })
    const third = await openAuthority({
      persistence: h.persistence,
      dependencies: {
        ...h.dependencies,
        instance: { ...h.dependencies.instance, instanceId: 'instance-c' }
      }
    })
    expect(third.snapshot().leases[0].status).toBe('recovery_blocked')
    h.observations.set(201, { state: 'dead' })
    await third.recoverStaleClaims()
    expect(third.snapshot().leases[0]).toMatchObject({
      status: 'recovered',
      recoveryReason: 'owner_dead'
    })
    third.dispose()
  })

  it('recovers a dead lease before projecting onto a recreated workspace root', async () => {
    const h = harness('instance-a')
    const first = await openAuthority({
      persistence: h.persistence,
      dependencies: h.dependencies
    })
    const acquired = await first.acquire(owner({ lockOwnerId: 'owner-a', runId: 'run-a' }), {
      workspacePath: h.workspace,
      kind: 'file',
      targetPath: path.join(h.workspace, 'src', 'a.ts')
    })
    if (!acquired.ok) throw new Error('fixture acquisition failed')
    const marker = workspaceLockRuntimeMarkerFilename('instance-a', 'owner-a')
    expect(fs.existsSync(path.join(h.workspace, marker))).toBe(true)
    first.dispose()

    const priorWorkspace = path.join(h.root, 'workspace-prior')
    fs.renameSync(h.workspace, priorWorkspace)
    fs.mkdirSync(path.join(h.workspace, 'src'), { recursive: true })
    fs.writeFileSync(path.join(h.workspace, 'src', 'a.ts'), 'replacement\n')
    h.observations.set(201, { state: 'dead' })

    const restarted = await openAuthority({
      persistence: h.persistence,
      dependencies: {
        ...h.dependencies,
        instance: { ...h.dependencies.instance, instanceId: 'instance-b' }
      }
    })

    expect(restarted.snapshot().leases).toEqual([
      expect.objectContaining({ status: 'recovered', recoveryReason: 'owner_dead' })
    ])
    expect(fs.existsSync(path.join(h.workspace, marker))).toBe(false)
    expect(fs.existsSync(path.join(priorWorkspace, marker))).toBe(true)
    expect(decodeWorkspaceLockWal(h.persistence.readEvents().raw).knownMarkers).toEqual([])
    restarted.dispose()
  })

  it('fences direct release tokens and protects exact-live orphans from terminal cleanup', async () => {
    const h = harness()
    const authority = await openAuthority({
      persistence: h.persistence,
      dependencies: h.dependencies
    })
    const acquired = await authority.acquire(owner({ lockOwnerId: 'owner-a', runId: 'run-a' }), {
      workspacePath: h.workspace,
      kind: 'file',
      targetPath: path.join(h.workspace, 'src', 'a.ts')
    })
    if (!acquired.ok) throw new Error('fixture acquisition failed')
    expect(
      await authority.release({
        ...acquired.tokens[0],
        authorityInstanceId: 'foreign-instance'
      })
    ).toMatchObject({ ok: false, reason: 'foreign_authority' })
    expect(
      await authority.release({ ...acquired.tokens[0], acquiredTransitionId: 'stale' })
    ).toMatchObject({ ok: false, reason: 'stale_token' })
    expect(await authority.releaseAllForRun('run-a')).toMatchObject({ ok: true })
    authority.dispose()
  })

  it('repairs a torn WAL tail, rejects committed corruption, and projects marker lifecycle', async () => {
    const h = harness()
    const authority = await openAuthority({
      persistence: h.persistence,
      dependencies: h.dependencies
    })
    const acquired = await authority.acquire(owner({ lockOwnerId: 'owner-a', runId: 'run-a' }), {
      workspacePath: h.workspace,
      kind: 'file',
      targetPath: path.join(h.workspace, 'src', 'a.ts')
    })
    if (!acquired.ok) throw new Error('fixture acquisition failed')
    const marker = workspaceLockRuntimeMarkerFilename('instance-a', 'owner-a')
    expect(fs.existsSync(path.join(h.workspace, marker))).toBe(true)
    authority.dispose()

    const walPath = path.join(
      h.userData,
      WORKSPACE_LOCK_AUTHORITY_DIRECTORY,
      WORKSPACE_LOCK_EVENTS_FILENAME
    )
    fs.appendFileSync(walPath, Buffer.from([0x7b, 0x22, 0xc3]))
    h.observations.set(201, { state: 'dead' })
    const restarted = await openAuthority({
      persistence: h.persistence,
      dependencies: {
        ...h.dependencies,
        instance: { ...h.dependencies.instance, instanceId: 'instance-b' }
      }
    })
    expect(fs.readFileSync(walPath).at(-1)).toBe(0x0a)
    expect(fs.existsSync(path.join(h.workspace, marker))).toBe(false)
    restarted.dispose()

    fs.appendFileSync(walPath, '{not-json}\n')
    await expect(
      openAuthority({
        persistence: h.persistence,
        dependencies: {
          ...h.dependencies,
          instance: { ...h.dependencies.instance, instanceId: 'instance-c' }
        }
      })
    ).rejects.toThrow(/corrupt/i)
  })

  it('replays a committed acquisition release and clears its marker health failure', async () => {
    const h = harness()
    let failMarkerRemoval = false
    const persistence = {
      readEvents: h.persistence.readEvents.bind(h.persistence),
      appendEvent: h.persistence.appendEvent.bind(h.persistence),
      confirmEventsDurable: h.persistence.confirmEventsDurable.bind(h.persistence),
      repairTornEventTail: h.persistence.repairTornEventTail.bind(h.persistence),
      acquireInstanceFence: h.persistence.acquireInstanceFence.bind(h.persistence),
      replaceInstanceFence: h.persistence.replaceInstanceFence.bind(h.persistence),
      recoverStaleReclaimGuard: h.persistence.recoverStaleReclaimGuard.bind(h.persistence),
      releaseInstanceFence: h.persistence.releaseInstanceFence.bind(h.persistence),
      writeDerivedMarker: h.persistence.writeDerivedMarker.bind(h.persistence),
      removeDerivedMarker: (root: string, name: string, identity: string) => {
        if (failMarkerRemoval) throw new Error('injected release marker removal failure')
        return h.persistence.removeDerivedMarker(root, name, identity)
      }
    }
    const authority = await openAuthority({
      persistence,
      dependencies: h.dependencies
    })
    const acquired = await authority.acquire(
      owner({ lockOwnerId: 'release-replay', runId: 'release-replay-run' }),
      {
        workspacePath: h.workspace,
        kind: 'file',
        targetPath: path.join(h.workspace, 'src', 'a.ts')
      },
      { transitionId: 'release-replay-acquire' }
    )
    if (!acquired.ok) throw new Error('fixture acquisition failed')
    failMarkerRemoval = true
    await expect(
      authority.releaseAcquisition('release-replay-run', acquired.transitionId, {
        transitionId: 'release-replay-operation'
      })
    ).rejects.toThrow(/pending inventory was retained/i)
    expect(authority.snapshot().leases).toEqual([])
    expect(runtimeMarkerContents(h.workspace)).not.toEqual([])

    failMarkerRemoval = false
    const replay = await authority.releaseAcquisition('release-replay-run', acquired.transitionId, {
      transitionId: 'release-replay-operation'
    })
    expect(replay).toMatchObject({
      ok: true,
      transitionId: 'release-replay-operation',
      released: [expect.objectContaining({ leaseId: acquired.leases[0].leaseId })]
    })
    expect(runtimeMarkerContents(h.workspace)).toEqual([])
    expect(decodeWorkspaceLockWal(h.persistence.readEvents().raw).knownMarkers).toEqual([])
    authority.dispose()
  })

  it('retires a marker under a deleted inactive worktree without blocking unrelated work', async () => {
    const h = harness()
    const disposableWorkspace = fs.mkdtempSync(
      path.join(os.tmpdir(), 'taskwraith-lock-authority-')
    )
    temporaryRoots.push(disposableWorkspace)
    fs.mkdirSync(path.join(disposableWorkspace, 'src'), { recursive: true })
    fs.writeFileSync(path.join(disposableWorkspace, 'src', 'gone.ts'), 'gone\n')
    const authority = await openAuthority({
      persistence: h.persistence,
      dependencies: h.dependencies
    })
    const acquired = await authority.acquire(
      owner({ lockOwnerId: 'deleted-root', runId: 'deleted-root-run' }),
      {
        workspacePath: disposableWorkspace,
        kind: 'file',
        targetPath: path.join(disposableWorkspace, 'src', 'gone.ts')
      },
      { transitionId: 'deleted-root-acquire' }
    )
    if (!acquired.ok) throw new Error('fixture acquisition failed')
    removeTemporaryRoot(disposableWorkspace)
    expect(
      await authority.releaseAcquisition('deleted-root-run', acquired.transitionId, {
        transitionId: 'deleted-root-release'
      })
    ).toMatchObject({ ok: true })
    expect(decodeWorkspaceLockWal(h.persistence.readEvents().raw).knownMarkers).toEqual([])
    expect(
      await authority.acquire(
        owner({
          lockOwnerId: 'unrelated-after-delete',
          runId: 'unrelated-after-delete-run',
          pid: 202,
          processBirthIdentity: 'owner-b-birth'
        }),
        {
          workspacePath: h.workspace,
          kind: 'file',
          targetPath: path.join(h.workspace, 'src', 'a.ts')
        },
        { transitionId: 'unrelated-after-delete-acquire' }
      )
    ).toMatchObject({ ok: true })
    authority.dispose()
  })

  it('retains the conservative barrier until a visible ambiguous append is durably confirmed', async () => {
    const h = harness()
    let throwAfterAcquireAppend = true
    let failDurabilityConfirmation = true
    const persistence = {
      readEvents: h.persistence.readEvents.bind(h.persistence),
      appendEvent: (line: string, expectedByteLength: number) => {
        const length = h.persistence.appendEvent(line, expectedByteLength)
        if (
          throwAfterAcquireAppend &&
          line.includes('"transitionId":"ambiguous-durability-acquire"')
        ) {
          throw new Error('injected post-write append failure')
        }
        return length
      },
      confirmEventsDurable: (expectedByteLength: number) => {
        if (failDurabilityConfirmation) {
          throw new Error('injected WAL confirmation fsync failure')
        }
        h.persistence.confirmEventsDurable(expectedByteLength)
      },
      repairTornEventTail: h.persistence.repairTornEventTail.bind(h.persistence),
      acquireInstanceFence: h.persistence.acquireInstanceFence.bind(h.persistence),
      replaceInstanceFence: h.persistence.replaceInstanceFence.bind(h.persistence),
      recoverStaleReclaimGuard: h.persistence.recoverStaleReclaimGuard.bind(h.persistence),
      releaseInstanceFence: h.persistence.releaseInstanceFence.bind(h.persistence),
      writeDerivedMarker: h.persistence.writeDerivedMarker.bind(h.persistence),
      removeDerivedMarker: h.persistence.removeDerivedMarker.bind(h.persistence)
    }
    const authority = await openAuthority({
      persistence,
      dependencies: h.dependencies
    })
    const request = {
      workspacePath: h.workspace,
      kind: 'file' as const,
      targetPath: path.join(h.workspace, 'src', 'a.ts')
    }
    await expect(
      authority.acquire(
        owner({ lockOwnerId: 'ambiguous-durability', runId: 'ambiguous-durability-run' }),
        request,
        { transitionId: 'ambiguous-durability-acquire' }
      )
    ).rejects.toThrow(/not durably confirmed/i)
    expect(authority.snapshot().leases).toHaveLength(1)
    expect(
      runtimeMarkerContents(h.workspace).some((content) =>
        content.includes('ambiguous-durability::provisional::')
      )
    ).toBe(true)

    throwAfterAcquireAppend = false
    failDurabilityConfirmation = false
    expect(
      await authority.acquire(
        owner({ lockOwnerId: 'ambiguous-durability', runId: 'ambiguous-durability-run' }),
        request,
        { transitionId: 'ambiguous-durability-acquire' }
      )
    ).toMatchObject({ ok: true })
    expect(
      runtimeMarkerContents(h.workspace).some((content) => content.includes('::provisional::'))
    ).toBe(false)
    authority.dispose()
  })

  it('does not commit an acquire when its conservative marker cannot be projected', async () => {
    const h = harness()
    const failingPersistence = {
      ...h.persistence,
      readEvents: h.persistence.readEvents.bind(h.persistence),
      appendEvent: h.persistence.appendEvent.bind(h.persistence),
      confirmEventsDurable: h.persistence.confirmEventsDurable.bind(h.persistence),
      repairTornEventTail: h.persistence.repairTornEventTail.bind(h.persistence),
      acquireInstanceFence: h.persistence.acquireInstanceFence.bind(h.persistence),
      replaceInstanceFence: h.persistence.replaceInstanceFence.bind(h.persistence),
      recoverStaleReclaimGuard: h.persistence.recoverStaleReclaimGuard.bind(h.persistence),
      releaseInstanceFence: h.persistence.releaseInstanceFence.bind(h.persistence),
      removeDerivedMarker: h.persistence.removeDerivedMarker.bind(h.persistence),
      writeDerivedMarker: () => {
        throw new Error('disk denied marker')
      }
    }
    const authority = await openAuthority({
      persistence: failingPersistence,
      dependencies: h.dependencies
    })
    await expect(
      authority.acquire(owner({ lockOwnerId: 'owner-a', runId: 'run-a' }), {
        workspacePath: h.workspace,
        kind: 'file',
        targetPath: path.join(h.workspace, 'src', 'a.ts')
      })
    ).rejects.toThrow(/marker projection/i)
    // Strict: a rolled-back acquire leaves no lease of ANY status behind. The previous
    // `.filter((lease) => lease.status !== 'recovered')` was dead code here — this scenario
    // never produces a recovered lease — and it would have hidden a stray one.
    expect(authority.snapshot().leases).toEqual([])
    const state = decodeWorkspaceLockWal(h.persistence.readEvents().raw)
    expect(state.events.some((event) => event.kind === 'prepare')).toBe(true)
    expect(state.events.some((event) => event.kind === 'acquire')).toBe(false)
    authority.dispose()
  })

  it('measures the recovered-lease visibility window against the injected clock', async () => {
    const h = harness('instance-a')
    const first = await openAuthority({
      persistence: h.persistence,
      dependencies: h.dependencies
    })
    await first.acquire(owner({ lockOwnerId: 'owner-a', runId: 'run-a' }), {
      workspacePath: h.workspace,
      kind: 'file',
      targetPath: path.join(h.workspace, 'src', 'a.ts')
    })
    first.dispose()

    h.observations.set(201, { state: 'dead' })
    const recoveredVisibilityMs = 1_000
    // Bracket the whole restart recovery: the recovered stamp is written during `open()`.
    const recoveredFloor = globalTime
    const second = await openAuthority({
      persistence: h.persistence,
      dependencies: {
        ...h.dependencies,
        instance: { ...h.dependencies.instance, instanceId: 'instance-b' }
      },
      recoveredVisibilityMs
    })
    await second.recoverStaleClaims()
    const recoveredCeiling = globalTime

    // Inside the window under the injected clock: the recovered lease is PRESENT and correct.
    // The fixture clock sits at 2026-07-29T18:00Z and only advances 1ms per read, so under a
    // real `Date.now()` cutoff this lease is always aged out and `leases` would be empty.
    const visible = second.snapshot().leases
    expect(visible).toHaveLength(1)
    expect(visible[0]).toMatchObject({
      status: 'recovered',
      recoveryReason: 'owner_dead'
    })
    expect(visible[0].claim.relativeTargetPath).toBe('src/a.ts')
    const statusChangedAt = Date.parse(visible[0].statusChangedAt)
    expect(statusChangedAt).toBeGreaterThanOrEqual(recoveredFloor)
    expect(statusChangedAt).toBeLessThanOrEqual(recoveredCeiling)

    // Advancing only the INJECTED clock past the window must age the same lease out, which
    // proves the cutoff is derived from the injected clock rather than wall time.
    globalTime += recoveredVisibilityMs * 5
    expect(second.snapshot().leases).toEqual([])
    second.dispose()
  })

  it('keeps both owner incarnations barred until a failed exact transfer projection is retried', async () => {
    const h = harness()
    let failExactProjection = false
    const persistence = {
      readEvents: h.persistence.readEvents.bind(h.persistence),
      appendEvent: h.persistence.appendEvent.bind(h.persistence),
      confirmEventsDurable: h.persistence.confirmEventsDurable.bind(h.persistence),
      repairTornEventTail: h.persistence.repairTornEventTail.bind(h.persistence),
      acquireInstanceFence: h.persistence.acquireInstanceFence.bind(h.persistence),
      replaceInstanceFence: h.persistence.replaceInstanceFence.bind(h.persistence),
      recoverStaleReclaimGuard: h.persistence.recoverStaleReclaimGuard.bind(h.persistence),
      releaseInstanceFence: h.persistence.releaseInstanceFence.bind(h.persistence),
      removeDerivedMarker: h.persistence.removeDerivedMarker.bind(h.persistence),
      writeDerivedMarker: (root: string, name: string, content: string, identity: string) => {
        if (failExactProjection && !content.includes('::provisional::')) {
          throw new Error('injected exact marker projection failure')
        }
        h.persistence.writeDerivedMarker(root, name, content, identity)
      }
    }
    const authority = await openAuthority({
      persistence,
      dependencies: h.dependencies
    })
    const parentOwner = owner({ lockOwnerId: 'transfer-fault', runId: 'transfer-fault-run' })
    const acquired = await authority.acquire(
      parentOwner,
      {
        workspacePath: h.workspace,
        kind: 'file',
        targetPath: path.join(h.workspace, 'src', 'a.ts')
      },
      { transitionId: 'transfer-fault-admission' }
    )
    if (!acquired.ok) throw new Error('fixture acquisition failed')
    const childOwner = {
      ...parentOwner,
      pid: 203,
      processBirthIdentity: 'spawned-child-birth'
    }
    failExactProjection = true
    await expect(
      authority.transferAcquisition(parentOwner, acquired.transitionId, childOwner, {
        transitionId: 'transfer-fault-child'
      })
    ).rejects.toThrow(/conservative markers were retained/i)

    expect(authority.snapshot().leases).toEqual([
      expect.objectContaining({
        acquiredTransitionId: 'transfer-fault-child',
        owner: expect.objectContaining({
          lifecycle: 'child',
          pid: 203,
          processBirthIdentity: 'spawned-child-birth'
        })
      })
    ])
    const conservative = runtimeMarkerContents(h.workspace).filter((content) =>
      content.includes('::provisional::')
    )
    expect(conservative).toHaveLength(2)
    expect(
      conservative.some(
        (content) =>
          content.includes(
            'lockOwnerId: "transfer-fault::provisional::transfer-fault-child::run::pid-201::birth-'
          ) && content.includes('expires: "9999-12-31T23:59:59.999Z"')
      )
    ).toBe(true)
    expect(
      conservative.some(
        (content) =>
          content.includes(
            'lockOwnerId: "transfer-fault::provisional::transfer-fault-child::child::pid-203::birth-'
          ) && content.includes('expires: "9999-12-31T23:59:59.999Z"')
      )
    ).toBe(true)

    failExactProjection = false
    expect(
      await authority.transferAcquisition(parentOwner, acquired.transitionId, childOwner, {
        transitionId: 'transfer-fault-child'
      })
    ).toMatchObject({
      ok: true,
      transitionId: 'transfer-fault-child',
      leases: [expect.objectContaining({ owner: expect.objectContaining({ lifecycle: 'child' }) })]
    })
    const reconciled = runtimeMarkerContents(h.workspace)
    expect(reconciled.some((content) => content.includes('::provisional::'))).toBe(false)
    expect(
      reconciled.some(
        (content) =>
          content.includes('lockOwnerId: "transfer-fault"') && content.includes('pid: 203')
      )
    ).toBe(true)
    expect(
      await authority.releaseAcquisition('transfer-fault-run', 'transfer-fault-child')
    ).toMatchObject({ ok: true })
    authority.dispose()
  })

  it('keeps a durable replacement and reconciles its exact marker on stable retry', async () => {
    const h = harness()
    let failExactProjection = false
    const persistence = {
      readEvents: h.persistence.readEvents.bind(h.persistence),
      appendEvent: h.persistence.appendEvent.bind(h.persistence),
      confirmEventsDurable: h.persistence.confirmEventsDurable.bind(h.persistence),
      repairTornEventTail: h.persistence.repairTornEventTail.bind(h.persistence),
      acquireInstanceFence: h.persistence.acquireInstanceFence.bind(h.persistence),
      replaceInstanceFence: h.persistence.replaceInstanceFence.bind(h.persistence),
      recoverStaleReclaimGuard: h.persistence.recoverStaleReclaimGuard.bind(h.persistence),
      releaseInstanceFence: h.persistence.releaseInstanceFence.bind(h.persistence),
      removeDerivedMarker: h.persistence.removeDerivedMarker.bind(h.persistence),
      writeDerivedMarker: (root: string, name: string, content: string, identity: string) => {
        if (failExactProjection && !content.includes('::provisional::')) {
          throw new Error('injected exact marker projection failure')
        }
        h.persistence.writeDerivedMarker(root, name, content, identity)
      }
    }
    const authority = await openAuthority({
      persistence,
      dependencies: h.dependencies
    })
    const replacingOwner = owner({ lockOwnerId: 'replace-fault', runId: 'replace-fault-run' })
    const acquired = await authority.acquire(
      replacingOwner,
      {
        workspacePath: h.workspace,
        kind: 'file',
        targetPath: path.join(h.workspace, 'src', 'a.ts')
      },
      { transitionId: 'replace-fault-admission' }
    )
    if (!acquired.ok) throw new Error('fixture acquisition failed')
    failExactProjection = true
    await expect(
      authority.replaceAcquisition(
        replacingOwner,
        acquired.transitionId,
        [
          {
            workspacePath: h.workspace,
            kind: 'file',
            targetPath: path.join(h.workspace, 'src', 'b.ts')
          }
        ],
        { transitionId: 'replace-fault-next' }
      )
    ).rejects.toThrow(/conservative markers were retained/i)

    expect(authority.snapshot().leases).toEqual([
      expect.objectContaining({
        acquiredTransitionId: expect.any(String),
        claim: expect.objectContaining({ relativeTargetPath: 'src/b.ts' })
      })
    ])
    const prepared = runtimeMarkerContents(h.workspace).find((content) =>
      content.includes('replace-fault::provisional::')
    )
    expect(prepared).toContain('"src/a.ts"')
    expect(prepared).toContain('"src/b.ts"')

    failExactProjection = false
    const replacement = await authority.replaceAcquisition(
      replacingOwner,
      acquired.transitionId,
      [
        {
          workspacePath: h.workspace,
          kind: 'file',
          targetPath: path.join(h.workspace, 'src', 'b.ts')
        }
      ],
      { transitionId: 'replace-fault-next' }
    )
    expect(replacement).toMatchObject({ ok: true, transitionId: 'replace-fault-next' })
    const exact = runtimeMarkerContents(h.workspace)
    expect(exact.some((content) => content.includes('::provisional::'))).toBe(false)
    expect(exact.some((content) => content.includes('"src/b.ts"'))).toBe(true)
    expect(exact.some((content) => content.includes('"src/a.ts"'))).toBe(false)
    authority.dispose()
  })

  it('reopens a committed acquire behind its inventoried barrier and replays it exactly', async () => {
    const h = harness()
    let failExactProjection = false
    const persistence = {
      readEvents: h.persistence.readEvents.bind(h.persistence),
      appendEvent: h.persistence.appendEvent.bind(h.persistence),
      confirmEventsDurable: h.persistence.confirmEventsDurable.bind(h.persistence),
      repairTornEventTail: h.persistence.repairTornEventTail.bind(h.persistence),
      acquireInstanceFence: h.persistence.acquireInstanceFence.bind(h.persistence),
      replaceInstanceFence: h.persistence.replaceInstanceFence.bind(h.persistence),
      recoverStaleReclaimGuard: h.persistence.recoverStaleReclaimGuard.bind(h.persistence),
      releaseInstanceFence: h.persistence.releaseInstanceFence.bind(h.persistence),
      removeDerivedMarker: h.persistence.removeDerivedMarker.bind(h.persistence),
      writeDerivedMarker: (root: string, name: string, content: string, identity: string) => {
        if (failExactProjection && !content.includes('::provisional::')) {
          throw new Error('injected exact marker projection failure')
        }
        h.persistence.writeDerivedMarker(root, name, content, identity)
      }
    }
    const authority = await openAuthority({
      persistence,
      dependencies: h.dependencies
    })
    failExactProjection = true
    const request = {
      workspacePath: h.workspace,
      kind: 'file' as const,
      targetPath: path.join(h.workspace, 'src', 'a.ts')
    }
    await expect(
      authority.acquire(
        owner({ lockOwnerId: 'plain-double', runId: 'plain-double-run' }),
        request,
        { transitionId: 'plain-double-acquire' }
      )
    ).rejects.toThrow(/conservative markers were retained/i)

    expect(authority.snapshot().leases).toEqual([
      expect.objectContaining({
        acquiredTransitionId: 'plain-double-acquire',
        owner: expect.objectContaining({ pid: 201 })
      })
    ])
    expect(
      runtimeMarkerContents(h.workspace).some(
        (content) =>
          content.includes(
            'lockOwnerId: "plain-double::provisional::plain-double-acquire::run::pid-201::birth-'
          ) && content.includes('pid: 201')
      )
    ).toBe(true)
    authority.dispose()

    failExactProjection = false
    const reopened = await openAuthority({
      persistence,
      dependencies: h.dependencies
    })
    const afterRestart = runtimeMarkerContents(h.workspace)
    expect(afterRestart.some((content) => content.includes('::provisional::'))).toBe(false)
    expect(afterRestart.some((content) => content.includes('lockOwnerId: "plain-double"'))).toBe(
      true
    )
    expect(
      await reopened.acquire(
        owner({ lockOwnerId: 'plain-double', runId: 'plain-double-run' }),
        request,
        { transitionId: 'plain-double-acquire' }
      )
    ).toMatchObject({ ok: true, transitionId: 'plain-double-acquire' })
    reopened.dispose()
  })

  it('durably inventories a partial multi-root preparation and removes it after restart', async () => {
    const h = harness()
    const otherWorkspace = path.join(h.root, 'other-workspace')
    fs.mkdirSync(path.join(otherWorkspace, 'src'), { recursive: true })
    fs.writeFileSync(path.join(otherWorkspace, 'src', 'c.ts'), 'c\n')
    const writtenProvisionalNames = new Set<string>()
    let provisionalWrites = 0
    let failCleanup = true
    const persistence = {
      readEvents: h.persistence.readEvents.bind(h.persistence),
      appendEvent: h.persistence.appendEvent.bind(h.persistence),
      confirmEventsDurable: h.persistence.confirmEventsDurable.bind(h.persistence),
      repairTornEventTail: h.persistence.repairTornEventTail.bind(h.persistence),
      acquireInstanceFence: h.persistence.acquireInstanceFence.bind(h.persistence),
      replaceInstanceFence: h.persistence.replaceInstanceFence.bind(h.persistence),
      recoverStaleReclaimGuard: h.persistence.recoverStaleReclaimGuard.bind(h.persistence),
      releaseInstanceFence: h.persistence.releaseInstanceFence.bind(h.persistence),
      removeDerivedMarker: (root: string, name: string, identity: string) => {
        if (failCleanup && writtenProvisionalNames.has(name)) {
          throw new Error('injected provisional cleanup failure')
        }
        return h.persistence.removeDerivedMarker(root, name, identity)
      },
      writeDerivedMarker: (root: string, name: string, content: string, identity: string) => {
        if (content.includes('::provisional::')) {
          provisionalWrites += 1
          if (provisionalWrites === 2) {
            throw new Error('injected second provisional write failure')
          }
          writtenProvisionalNames.add(name)
        }
        h.persistence.writeDerivedMarker(root, name, content, identity)
      }
    }
    const authority = await openAuthority({
      persistence,
      dependencies: h.dependencies
    })
    await expect(
      authority.acquireMany(
        owner({ lockOwnerId: 'partial-prepare', runId: 'partial-prepare-run' }),
        [
          {
            workspacePath: h.workspace,
            kind: 'file',
            targetPath: path.join(h.workspace, 'src', 'a.ts')
          },
          {
            workspacePath: otherWorkspace,
            kind: 'file',
            targetPath: path.join(otherWorkspace, 'src', 'c.ts')
          }
        ],
        { transitionId: 'partial-prepare-acquire' }
      )
    ).rejects.toThrow(/projection and durable-inventory cleanup both failed/i)
    expect(authority.snapshot().leases).toEqual([])
    const state = decodeWorkspaceLockWal(h.persistence.readEvents().raw)
    const prepare = state.events.findLast((event) => event.kind === 'prepare')
    expect(prepare?.kind === 'prepare' ? prepare.payload.markers : []).toHaveLength(2)
    expect(state.events.some((event) => event.transitionId === 'partial-prepare-acquire')).toBe(
      false
    )
    expect(
      [...runtimeMarkerContents(h.workspace), ...runtimeMarkerContents(otherWorkspace)].some(
        (content) => content.includes('::provisional::')
      )
    ).toBe(true)
    authority.dispose()

    failCleanup = false
    const reopened = await openAuthority({
      persistence,
      dependencies: h.dependencies
    })
    expect(
      [...runtimeMarkerContents(h.workspace), ...runtimeMarkerContents(otherWorkspace)].some(
        (content) => content.includes('::provisional::')
      )
    ).toBe(false)
    expect(reopened.snapshot().leases).toEqual([])
    reopened.dispose()
  })

  it('retains an inventoried barrier when acquire append and cleanup both fail', async () => {
    const h = harness()
    const writtenProvisionalNames = new Set<string>()
    let failAcquireAppend = true
    let failCleanup = true
    const persistence = {
      readEvents: h.persistence.readEvents.bind(h.persistence),
      appendEvent: (line: string, expectedByteLength: number) => {
        if (
          failAcquireAppend &&
          line.includes('"kind":"acquire"') &&
          line.includes('"transitionId":"append-fault-acquire"')
        ) {
          throw new Error('injected acquire append failure')
        }
        return h.persistence.appendEvent(line, expectedByteLength)
      },
      confirmEventsDurable: h.persistence.confirmEventsDurable.bind(h.persistence),
      repairTornEventTail: h.persistence.repairTornEventTail.bind(h.persistence),
      acquireInstanceFence: h.persistence.acquireInstanceFence.bind(h.persistence),
      replaceInstanceFence: h.persistence.replaceInstanceFence.bind(h.persistence),
      recoverStaleReclaimGuard: h.persistence.recoverStaleReclaimGuard.bind(h.persistence),
      releaseInstanceFence: h.persistence.releaseInstanceFence.bind(h.persistence),
      removeDerivedMarker: (root: string, name: string, identity: string) => {
        if (failCleanup && writtenProvisionalNames.has(name)) {
          throw new Error('injected cleanup after append failure')
        }
        return h.persistence.removeDerivedMarker(root, name, identity)
      },
      writeDerivedMarker: (root: string, name: string, content: string, identity: string) => {
        if (content.includes('::provisional::')) writtenProvisionalNames.add(name)
        h.persistence.writeDerivedMarker(root, name, content, identity)
      }
    }
    const authority = await openAuthority({
      persistence,
      dependencies: h.dependencies
    })
    await expect(
      authority.acquire(
        owner({ lockOwnerId: 'append-fault', runId: 'append-fault-run' }),
        {
          workspacePath: h.workspace,
          kind: 'file',
          targetPath: path.join(h.workspace, 'src', 'a.ts')
        },
        { transitionId: 'append-fault-acquire' }
      )
    ).rejects.toThrow(/append and conservative-marker cleanup both failed/i)
    expect(authority.snapshot().leases).toEqual([])
    expect(
      runtimeMarkerContents(h.workspace).some((content) => content.includes('::provisional::'))
    ).toBe(true)
    const state = decodeWorkspaceLockWal(h.persistence.readEvents().raw)
    expect(state.events.some((event) => event.transitionId === 'append-fault-acquire')).toBe(false)
    authority.dispose()

    failAcquireAppend = false
    failCleanup = false
    const reopened = await openAuthority({
      persistence,
      dependencies: h.dependencies
    })
    expect(
      runtimeMarkerContents(h.workspace).some((content) => content.includes('::provisional::'))
    ).toBe(false)
    reopened.dispose()
  })

  it('projects a conservative marker before the WAL-to-exact-marker window', async () => {
    const h = harness()
    let observedAfterWalAppend = false
    const persistence = {
      readEvents: h.persistence.readEvents.bind(h.persistence),
      appendEvent: (line: string, expectedByteLength: number) => {
        const appendedLength = h.persistence.appendEvent(line, expectedByteLength)
        if (line.includes('"transitionId":"window-acquire"')) {
          const markerContents = fs
            .readdirSync(h.workspace)
            .filter((name) => name.startsWith('.WORK-IN-PROGRESS-taskwraith-runtime-'))
            .map((name) => fs.readFileSync(path.join(h.workspace, name), 'utf8'))
          expect(
            markerContents.some((content) =>
              content.includes(
                'lockOwnerId: "window-owner::provisional::window-acquire::run::pid-201::birth-'
              )
            )
          ).toBe(true)
          observedAfterWalAppend = true
        }
        return appendedLength
      },
      confirmEventsDurable: h.persistence.confirmEventsDurable.bind(h.persistence),
      repairTornEventTail: h.persistence.repairTornEventTail.bind(h.persistence),
      acquireInstanceFence: h.persistence.acquireInstanceFence.bind(h.persistence),
      replaceInstanceFence: h.persistence.replaceInstanceFence.bind(h.persistence),
      recoverStaleReclaimGuard: h.persistence.recoverStaleReclaimGuard.bind(h.persistence),
      releaseInstanceFence: h.persistence.releaseInstanceFence.bind(h.persistence),
      removeDerivedMarker: h.persistence.removeDerivedMarker.bind(h.persistence),
      writeDerivedMarker: h.persistence.writeDerivedMarker.bind(h.persistence)
    }
    const authority = await openAuthority({
      persistence,
      dependencies: h.dependencies
    })
    expect(
      await authority.acquire(
        owner({ lockOwnerId: 'window-owner', runId: 'window-run' }),
        {
          workspacePath: h.workspace,
          kind: 'file',
          targetPath: path.join(h.workspace, 'src', 'a.ts')
        },
        { transitionId: 'window-acquire' }
      )
    ).toMatchObject({ ok: true })
    expect(observedAfterWalAppend).toBe(true)
    const finalMarkerContents = fs
      .readdirSync(h.workspace)
      .filter((name) => name.startsWith('.WORK-IN-PROGRESS-taskwraith-runtime-'))
      .map((name) => fs.readFileSync(path.join(h.workspace, name), 'utf8'))
    expect(finalMarkerContents.some((content) => content.includes('::provisional::'))).toBe(false)
    authority.dispose()
  })

  it('returns authority_busy when an exact-live transition mutex remains held', async () => {
    const h = harness()
    const authority = await openAuthority({
      persistence: h.persistence,
      dependencies: h.dependencies
    })
    const foreignFence = {
      instanceId: 'other-instance',
      generation: 99,
      pid: 202,
      processBirthIdentity: 'owner-b-birth',
      fenceId: 'held-fence',
      acquiredAt: new Date(globalTime++).toISOString()
    }
    expect(h.persistence.acquireInstanceFence(foreignFence)).toEqual({ ok: true })
    const result = await authority.acquire(owner({ lockOwnerId: 'owner-a', runId: 'run-a' }), {
      workspacePath: h.workspace,
      kind: 'workspace'
    })
    expect(result).toMatchObject({ ok: false, reason: 'authority_busy' })
    expect(h.persistence.releaseInstanceFence(foreignFence.fenceId)).toBe(true)
    authority.dispose()
  })

  it('exposes busy errors for marker renewal rather than silently extending authority state', async () => {
    const h = harness()
    const authority = await openAuthority({
      persistence: h.persistence,
      dependencies: h.dependencies
    })
    const foreignFence = {
      instanceId: 'other-instance',
      generation: 99,
      pid: 202,
      processBirthIdentity: 'owner-b-birth',
      fenceId: 'renew-held-fence',
      acquiredAt: new Date(globalTime++).toISOString()
    }
    h.persistence.acquireInstanceFence(foreignFence)
    await expect(authority.renewDerivedMarkers()).rejects.toBeInstanceOf(
      WorkspaceLockAuthorityBusyError
    )
    h.persistence.releaseInstanceFence(foreignFence.fenceId)
    authority.dispose()
  })
})

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}`)
}

function birth16(processBirthIdentity: string): string {
  return createHash('sha256').update(processBirthIdentity, 'utf8').digest('hex').slice(0, 16)
}

function holdersDirectory(userData: string): string {
  return path.join(userData, WORKSPACE_LOCK_AUTHORITY_DIRECTORY, WORKSPACE_LOCK_HOLDERS_DIRECTORY)
}

function walEvents(persistence: NodeWorkspaceLockPersistence) {
  return decodeWorkspaceLockWal(persistence.readEvents().raw).events
}

function readAuditLines(userData: string): Record<string, unknown>[] {
  const auditPath = path.join(holdersDirectory(userData), WORKSPACE_LOCK_RECLAIM_AUDIT_FILENAME)
  if (!fs.existsSync(auditPath)) return []
  return fs
    .readFileSync(auditPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

/**
 * Holder-lease fixture: a holder authority (`instance-a`, pid 201) acquires
 * one file lease and stays open; a reclaimer authority (`instance-b`) runs
 * `runPeriodicRecovery` by hand against injected wall and monotonic clocks.
 * The holder's sidecar is written by the test so its beat times are exact.
 */
async function lapseFixture(
  options: {
    /** The one record the port names; an Error makes the port throw it. */
    fenceOwner?: WorkspaceLockCommitFenceOwnerIdentity | Error | null
    /** False opens the reclaimer with no commit-fence port at all. */
    fencePort?: boolean
    /** Observation of the holder's pid while the reclaimer boots (live by default). */
    observationAtBoot?: WorkspaceLockProcessObservation
    /** Runs inside every reclaimer observation, before it answers. */
    onReclaimerObserve?: (pid: number) => Promise<void>
    holderLease?: WorkspaceLockHolderLeaseOptions
  } = {}
) {
  const h = harness('instance-b')
  let monotonicMs = 0
  let fenceOwner: WorkspaceLockCommitFenceOwnerIdentity | Error | null = options.fenceOwner ?? null
  const holderInstance = {
    instanceId: 'instance-a',
    pid: 201,
    processBirthIdentity: 'owner-a-birth'
  }
  const holder = await openAuthority({
    persistence: h.persistence,
    dependencies: { ...h.dependencies, instance: holderInstance },
    holderLease: { enabled: false }
  })
  const holderOwner = owner({ lockOwnerId: 'owner-a', runId: 'run-a' })
  const request = {
    workspacePath: h.workspace,
    kind: 'file' as const,
    targetPath: path.join(h.workspace, 'src', 'a.ts')
  }
  const acquired = await holder.acquire(holderOwner, request)
  if (!acquired.ok) throw new Error('fixture acquisition failed')
  const liveAtScan = h.observations.get(201)!
  if (options.observationAtBoot) h.observations.set(201, options.observationAtBoot)
  const reclaimer = await openAuthority({
    persistence: h.persistence,
    dependencies: {
      ...h.dependencies,
      monotonicNowMs: () => monotonicMs,
      ...(options.onReclaimerObserve
        ? {
            observeProcess: async (pid: number) => {
              await options.onReclaimerObserve!(pid)
              return h.dependencies.observeProcess(pid)
            }
          }
        : {}),
      ...(options.fencePort === false
        ? {}
        : {
            readCommitFenceOwners: () => {
              if (fenceOwner instanceof Error) throw fenceOwner
              return fenceOwner ? [fenceOwner] : []
            }
          })
    },
    holderLease: {
      heartbeatIntervalMs: 60_000,
      scanIntervalMs: 60_000,
      heartbeatTtlMs: 90_000,
      reclaimGraceMs: 180_000,
      suspendGapMs: 60 * 60_000,
      ...options.holderLease
    }
  })
  h.observations.set(201, liveAtScan)
  let beatSeq = 0
  return {
    h,
    holder,
    holderOwner,
    request,
    leaseId: acquired.leases[0].leaseId,
    transitionId: acquired.transitionId,
    reclaimer,
    beat: async (beatAt = new Date(globalTime).toISOString()): Promise<number> => {
      beatSeq += 1
      await h.persistence.writeHolderHeartbeat({
        schema: WORKSPACE_LOCK_HEARTBEAT_SCHEMA,
        ...holderInstance,
        generation: 1,
        beatSeq,
        monotonicMs: 0,
        beatAt
      })
      return beatSeq
    },
    advanceWall: (ms: number): void => {
      globalTime += ms
    },
    advanceMonotonic: (ms: number): void => {
      monotonicMs += ms
    },
    setFenceOwner: (next: WorkspaceLockCommitFenceOwnerIdentity | Error | null): void => {
      fenceOwner = next
    },
    leaseStatus: () =>
      reclaimer.snapshot().leases.find((lease) => lease.leaseId === acquired.leases[0].leaseId)
        ?.status,
    scan: (): Promise<WorkspaceLockPeriodicRecoveryOutcome> => reclaimer.runPeriodicRecovery(),
    dispose: (): void => {
      reclaimer.dispose()
      holder.dispose()
    }
  }
}

describe('WorkspaceLockAuthority holder leases', () => {
  it('writes a heartbeat sidecar on open, beats on its cadence, and removes it on dispose', async () => {
    const h = harness('instance-a')
    const authority = await openAuthority({
      persistence: h.persistence,
      dependencies: h.dependencies,
      holderLease: { heartbeatIntervalMs: 25, scanIntervalMs: 60_000 }
    })
    const holders = holdersDirectory(h.userData)
    const filename = `instance-a.100.${birth16('authority-birth')}.json`
    expect(fs.readdirSync(holders).filter((name) => name.endsWith('.json'))).toEqual([filename])
    const sidecar = path.join(holders, filename)
    const read = (): Record<string, unknown> =>
      JSON.parse(fs.readFileSync(sidecar, 'utf8')) as Record<string, unknown>
    const first = read()
    expect(Object.keys(first)).toEqual([
      'schema',
      'instanceId',
      'generation',
      'pid',
      'processBirthIdentity',
      'beatSeq',
      'monotonicMs',
      'beatAt'
    ])
    expect(first).toMatchObject({
      schema: 'taskwraith.workspace-lock.heartbeat.v1',
      instanceId: 'instance-a',
      generation: 1,
      pid: 100,
      processBirthIdentity: 'authority-birth',
      beatSeq: 1
    })
    expect(new Date(first.beatAt as string).toISOString()).toBe(first.beatAt)
    expect(first.monotonicMs).toEqual(expect.any(Number))

    await waitFor(() => (read().beatSeq as number) >= 3, 2_000, 'three heartbeats')
    expect(authority.snapshot().projectionErrors).toEqual([])
    expect(authority.holderLeaseTimings()).toEqual({
      enabled: true,
      heartbeatIntervalMs: 25,
      heartbeatTtlMs: 90_000,
      reclaimGraceMs: 180_000,
      scanIntervalMs: 60_000,
      suspendGapMs: 120_000,
      sweepIntervalMs: 600_000
    })

    authority.dispose()
    expect(fs.existsSync(sidecar)).toBe(false)
  })

  it('never retires its own live leases, however long its own beats fail to land', async () => {
    const h = harness('instance-a')
    let monotonicMs = 0
    const authority = await openAuthority({
      persistence: h.persistence,
      dependencies: {
        ...h.dependencies,
        monotonicNowMs: () => monotonicMs,
        readCommitFenceOwners: () => []
      },
      // One beat at open, then none: a stalled disk holds every later write.
      holderLease: { heartbeatIntervalMs: 3_600_000, scanIntervalMs: 3_600_000 }
    })
    const self = owner({
      lockOwnerId: 'owner-self',
      runId: 'run-self',
      pid: 100,
      processBirthIdentity: 'authority-birth'
    })
    const acquired = await authority.acquire(self, {
      workspacePath: h.workspace,
      kind: 'file',
      targetPath: path.join(h.workspace, 'src', 'a.ts')
    })
    if (!acquired.ok) throw new Error('fixture acquisition failed')
    for (let scan = 0; scan < 12; scan += 1) {
      globalTime += 60_000
      monotonicMs += 60_000
      // This process is alive by construction: its own leases are never candidates.
      expect(await authority.runPeriodicRecovery()).toEqual({
        skipped: true,
        reason: 'no_active_leases'
      })
    }
    expect(authority.snapshot().leases.map((lease) => lease.status)).toEqual(['held'])
    expect(walEvents(h.persistence).filter((event) => event.kind === 'recover')).toEqual([])
    expect(await authority.verifyAcquisitionForMutation(self, acquired.transitionId)).toMatchObject(
      {
        ok: true
      }
    )
    authority.dispose()
  })

  it('retires a lease another incarnation of its own pid holds, and never its own', async () => {
    const h = harness('instance-a')
    let monotonicMs = 0
    const authority = await openAuthority({
      persistence: h.persistence,
      dependencies: {
        ...h.dependencies,
        monotonicNowMs: () => monotonicMs,
        readCommitFenceOwners: () => []
      },
      holderLease: { heartbeatIntervalMs: 3_600_000, scanIntervalMs: 3_600_000 }
    })
    // Opened before any lease exists, so its boot relabels nothing.
    const injector = await openAuthority({
      persistence: h.persistence,
      dependencies: {
        ...h.dependencies,
        instance: {
          instanceId: 'instance-injector',
          pid: 202,
          processBirthIdentity: 'owner-b-birth'
        }
      },
      holderLease: { enabled: false }
    })
    const self = owner({
      lockOwnerId: 'owner-self',
      runId: 'run-self',
      pid: 100,
      processBirthIdentity: 'authority-birth'
    })
    const own = await authority.acquire(self, {
      workspacePath: h.workspace,
      kind: 'file',
      targetPath: path.join(h.workspace, 'src', 'a.ts')
    })
    if (!own.ok) throw new Error('fixture acquisition failed')
    // Synthetic: two live processes never share a pid, and boot retires the
    // lease of an earlier incarnation. So pid 100 is observed as an earlier
    // incarnation only while the injector acquires in its name.
    h.observations.set(100, { state: 'live', processBirthIdentity: 'authority-birth-previous' })
    const stranger = await injector.acquire(
      owner({
        lockOwnerId: 'owner-previous',
        runId: 'run-previous',
        pid: 100,
        processBirthIdentity: 'authority-birth-previous'
      }),
      {
        workspacePath: h.workspace,
        kind: 'file',
        targetPath: path.join(h.workspace, 'src', 'b.ts')
      }
    )
    h.observations.set(100, { state: 'live', processBirthIdentity: 'authority-birth' })
    if (!stranger.ok) throw new Error('fixture injection failed')

    // Same pid, another birth: not this process, so a candidate like any other.
    expect(await authority.runPeriodicRecovery()).toMatchObject({
      skipped: false,
      decisions: [
        { leaseId: stranger.leases[0].leaseId, status: 'recovered', reason: 'pid_reused' }
      ],
      deferred: []
    })
    for (let scan = 0; scan < 3; scan += 1) {
      globalTime += 60_000
      monotonicMs += 60_000
      expect(await authority.runPeriodicRecovery()).toEqual({
        skipped: true,
        reason: 'no_active_leases'
      })
    }
    const status = (leaseId: string) =>
      authority.snapshot().leases.find((lease) => lease.leaseId === leaseId)?.status
    expect(status(own.leases[0].leaseId)).toBe('held')
    expect(status(stranger.leases[0].leaseId)).toBe('recovered')
    expect(await authority.verifyAcquisitionForMutation(self, own.transitionId)).toMatchObject({
      ok: true
    })
    injector.dispose()
    authority.dispose()
  })

  it('never retires a recovery_blocked lease by lapse, however long its live owner stays silent', async () => {
    // Boot could not observe the holder, so its lease is blocked for a human;
    // the holder is observable and silent afterwards. Lapse only ever retires
    // held or orphan_live, so the lease stays blocked (and still conflicts).
    const f = await lapseFixture({ observationAtBoot: { state: 'identity_unavailable' } })
    expect(f.leaseStatus()).toBe('recovery_blocked')
    await f.beat()
    f.advanceWall(10 * 60_000)
    expect(await f.scan()).toEqual({ skipped: true, reason: 'no_candidates' })
    for (let scan = 0; scan < 4; scan += 1) {
      f.advanceMonotonic(181_000)
      expect(await f.scan()).toEqual({ skipped: true, reason: 'no_candidates' })
    }
    expect(f.leaseStatus()).toBe('recovery_blocked')
    expect(
      walEvents(f.h.persistence)
        .filter((event) => event.kind === 'recover')
        .flatMap((event) => event.payload.decisions.map((decision) => decision.status))
    ).toEqual(['recovery_blocked'])
    // Positive control: the verdict is lapsed, so only the status rule held it.
    expect(f.reclaimer.snapshot().holderLiveness?.[f.leaseId]).toMatchObject({
      instanceScope: 'other',
      liveness: 'lapsed'
    })
    expect(
      await f.reclaimer.acquire(
        owner({
          lockOwnerId: 'owner-b',
          runId: 'run-b',
          pid: 202,
          processBirthIdentity: 'owner-b-birth'
        }),
        f.request
      )
    ).toMatchObject({ ok: false, reason: 'conflict' })
    f.dispose()
  })

  it('never retires a lease a peer quarantined as recovery_blocked while the pass was observing its owner', async () => {
    const peers: WorkspaceLockAuthority[] = []
    let armed = false
    const f = await lapseFixture({
      onReclaimerObserve: async (pid) => {
        if (!armed || pid !== 201) return
        armed = false
        // A peer boots now and cannot observe the holder (a resolver timeout,
        // say), so its boot quarantines the lease as recovery_blocked.
        peers.push(
          await openAuthority({
            persistence: f.h.persistence,
            dependencies: {
              ...f.h.dependencies,
              observeProcess: async (observed) =>
                observed === 201
                  ? { state: 'identity_unavailable' }
                  : f.h.dependencies.observeProcess(observed),
              instance: { instanceId: 'instance-p', pid: 505, processBirthIdentity: 'peer-birth' }
            },
            holderLease: { enabled: false }
          })
        )
      }
    })
    await f.beat()
    f.advanceWall(10 * 60_000)
    expect(await f.scan()).toEqual({ skipped: true, reason: 'no_candidates' })
    f.advanceMonotonic(181_000)
    armed = true
    // The pre-check judged the lease lapsed before its await. Under the fence
    // it is recovery_blocked, which lapse never retires.
    expect(await f.scan()).toEqual({ skipped: false, decisions: [], deferred: [], reclaimed: [] })
    expect(peers).toHaveLength(1)
    expect(
      walEvents(f.h.persistence)
        .filter((event) => event.kind === 'recover')
        .map((event) => [
          event.authority.instanceId,
          ...event.payload.decisions.map((decision) => decision.status)
        ])
    ).toEqual([
      ['instance-b', 'orphan_live'],
      ['instance-p', 'recovery_blocked']
    ])
    expect(f.leaseStatus()).toBe('recovery_blocked')
    expect(readAuditLines(f.h.userData)).toEqual([])
    // The next pass reads the status before anything else and leaves it.
    f.advanceMonotonic(181_000)
    expect(await f.scan()).toEqual({ skipped: true, reason: 'no_candidates' })
    expect(f.leaseStatus()).toBe('recovery_blocked')
    for (const peer of peers) peer.dispose()
    f.dispose()
  })

  it('keeps its heartbeat cadence after a beat throws instead of going silent', async () => {
    const h = harness('instance-a')
    const write = h.persistence.writeHolderHeartbeat.bind(h.persistence)
    let calls = 0
    h.persistence.writeHolderHeartbeat = (record) => {
      calls += 1
      // Thrown, not rejected: the failure a caught promise chain never sees.
      if (calls === 2) throw new Error('synthetic sidecar failure')
      return write(record)
    }
    const authority = await openAuthority({
      persistence: h.persistence,
      dependencies: h.dependencies,
      holderLease: { heartbeatIntervalMs: 20, scanIntervalMs: 60_000 }
    })
    await waitFor(() => calls >= 4, 2_000, 'beats after the failed one')
    expect(authority.snapshot().projectionErrors).toEqual([])
    authority.dispose()
  })

  it('runs on the design timing table by default and refuses a suspend gap no wider than a scan', async () => {
    const h = harness('instance-a')
    const authority = await openAuthority({
      persistence: h.persistence,
      dependencies: h.dependencies
    })
    expect(authority.holderLeaseTimings()).toEqual({
      enabled: true,
      heartbeatIntervalMs: 10_000,
      heartbeatTtlMs: 90_000,
      reclaimGraceMs: 180_000,
      scanIntervalMs: 30_000,
      suspendGapMs: 60_000,
      sweepIntervalMs: 600_000
    })
    authority.dispose()
    await expect(
      openAuthority({
        persistence: h.persistence,
        dependencies: h.dependencies,
        holderLease: { scanIntervalMs: 30_000, suspendGapMs: 30_000 }
      })
    ).rejects.toThrow(/suspendGapMs must exceed scanIntervalMs/)
  })

  it('reclaims a dead owner from the periodic pass without any open()', async () => {
    const h = harness('instance-a')
    const holder = await openAuthority({
      persistence: h.persistence,
      dependencies: h.dependencies,
      holderLease: { scanIntervalMs: 60_000, heartbeatIntervalMs: 60_000 }
    })
    const request = {
      workspacePath: h.workspace,
      kind: 'file' as const,
      targetPath: path.join(h.workspace, 'src', 'a.ts')
    }
    const held = await holder.acquire(owner({ lockOwnerId: 'owner-a', runId: 'run-a' }), request)
    expect(held).toMatchObject({ ok: true })

    const reclaimer = await openAuthority({
      persistence: h.persistence,
      dependencies: {
        ...h.dependencies,
        instance: { ...h.dependencies.instance, instanceId: 'instance-b' }
      },
      holderLease: { scanIntervalMs: 25, heartbeatIntervalMs: 60_000 }
    })
    // Boot keeps its relabel; the timer must not need another boot to act.
    expect(reclaimer.snapshot().leases[0].status).toBe('orphan_live')
    const bootsBefore = walEvents(h.persistence).filter((event) => event.kind === 'boot').length
    expect(bootsBefore).toBe(2)
    expect(
      await reclaimer.acquire(
        owner({
          lockOwnerId: 'owner-b',
          runId: 'run-b',
          pid: 202,
          processBirthIdentity: 'owner-b-birth'
        }),
        request
      )
    ).toMatchObject({ ok: false, reason: 'conflict' })

    h.observations.set(201, { state: 'dead' })
    await waitFor(
      () => reclaimer.snapshot().leases[0]?.status === 'recovered',
      3_000,
      'the periodic pass to retire the dead owner'
    )
    expect(reclaimer.snapshot().leases[0]).toMatchObject({
      status: 'recovered',
      recoveryReason: 'owner_dead'
    })
    const events = walEvents(h.persistence)
    expect(events.filter((event) => event.kind === 'boot')).toHaveLength(2)
    const recover = events.filter((event) => event.kind === 'recover').at(-1)
    expect(recover).toMatchObject({
      authority: { instanceId: 'instance-b' },
      payload: { decisions: [{ status: 'recovered', reason: 'owner_dead' }] }
    })
    expect(
      await reclaimer.acquire(
        owner({
          lockOwnerId: 'owner-b',
          runId: 'run-b',
          pid: 202,
          processBirthIdentity: 'owner-b-birth'
        }),
        request
      )
    ).toMatchObject({ ok: true })
    await waitFor(() => readAuditLines(h.userData).length === 1, 2_000, 'the reclaim audit line')
    expect(readAuditLines(h.userData)[0]).toMatchObject({
      schema: 'taskwraith.workspace-lock.reclaim.v1',
      evidence: 'owner_dead',
      walStatus: 'recovered',
      walReason: 'owner_dead',
      ownerPid: 201,
      reclaimerInstanceId: 'instance-b'
    })
    reclaimer.dispose()
    holder.dispose()
  })

  it("never relabels a live peer's held lease from the periodic pass", async () => {
    const h = harness('instance-b')
    const reclaimer = await openAuthority({
      persistence: h.persistence,
      dependencies: h.dependencies,
      holderLease: { scanIntervalMs: 60_000, heartbeatIntervalMs: 60_000 }
    })
    const holder = await openAuthority({
      persistence: h.persistence,
      dependencies: {
        ...h.dependencies,
        instance: { instanceId: 'instance-a', pid: 201, processBirthIdentity: 'owner-a-birth' }
      },
      holderLease: { scanIntervalMs: 60_000, heartbeatIntervalMs: 60_000 }
    })
    const holderOwner = owner({ lockOwnerId: 'owner-a', runId: 'run-a' })
    const acquired = await holder.acquire(holderOwner, {
      workspacePath: h.workspace,
      kind: 'file',
      targetPath: path.join(h.workspace, 'src', 'a.ts')
    })
    if (!acquired.ok) throw new Error('fixture acquisition failed')

    // Wall-stale for far longer than TTL + grace on the file's own timestamp
    // is not enough either: a live peer keeps a `held` lease exactly `held`.
    for (let pass = 0; pass < 3; pass += 1) {
      expect(await reclaimer.runPeriodicRecovery()).toEqual({
        skipped: true,
        reason: 'no_candidates'
      })
    }
    expect(reclaimer.snapshot().leases[0].status).toBe('held')
    expect(walEvents(h.persistence).filter((event) => event.kind === 'recover')).toEqual([])
    expect(
      await holder.verifyAcquisitionForMutation(holderOwner, acquired.transitionId)
    ).toMatchObject({ ok: true, acquiredTransitionId: acquired.transitionId })

    // The boot-time relabel is unchanged and stays a boot-only behaviour.
    const third = await openAuthority({
      persistence: h.persistence,
      dependencies: {
        ...h.dependencies,
        instance: { ...h.dependencies.instance, instanceId: 'instance-c' }
      },
      holderLease: { scanIntervalMs: 60_000, heartbeatIntervalMs: 60_000 }
    })
    expect(third.snapshot().leases[0].status).toBe('orphan_live')
    third.dispose()
    holder.dispose()
    reclaimer.dispose()
  })

  it('does not reclaim a holder whose heartbeat is younger than the TTL, however long the grace', async () => {
    const f = await lapseFixture()
    await f.beat()
    f.advanceWall(60_000)
    expect(await f.scan()).toEqual({ skipped: true, reason: 'no_candidates' })
    f.advanceMonotonic(10 * 60_000)
    expect(await f.scan()).toEqual({ skipped: true, reason: 'no_candidates' })
    expect(f.leaseStatus()).toBe('orphan_live')
    expect(f.reclaimer.snapshot().holderLiveness?.[f.leaseId]).toMatchObject({
      instanceScope: 'other',
      liveness: 'live',
      generation: 1
    })
    f.dispose()
  })

  it('reclaims a wall-lapsed live holder only after the monotonic grace, labelled owner_dead on the WAL and lease_lapsed in the audit', async () => {
    const f = await lapseFixture()
    const beatSeq = await f.beat()
    f.advanceWall(10 * 60_000)
    expect(await f.scan()).toEqual({ skipped: true, reason: 'no_candidates' })
    f.advanceMonotonic(179_999)
    expect(await f.scan()).toEqual({ skipped: true, reason: 'no_candidates' })
    expect(f.leaseStatus()).toBe('orphan_live')
    expect(f.reclaimer.snapshot().holderLiveness?.[f.leaseId]).toMatchObject({
      instanceScope: 'other',
      liveness: 'lapsed'
    })

    f.advanceMonotonic(2)
    const outcome = await f.scan()
    expect(outcome).toMatchObject({
      skipped: false,
      decisions: [{ leaseId: f.leaseId, status: 'recovered', reason: 'owner_dead' }],
      deferred: []
    })
    expect(f.leaseStatus()).toBe('recovered')
    const recover = walEvents(f.h.persistence)
      .filter((event) => event.kind === 'recover')
      .at(-1)
    expect(recover).toMatchObject({
      authority: { instanceId: 'instance-b' },
      payload: { decisions: [{ leaseId: f.leaseId, status: 'recovered', reason: 'owner_dead' }] }
    })
    // The holder is alive and finds out at its next verification, never mid-write.
    expect(
      await f.holder.verifyAcquisitionForMutation(f.holderOwner, f.transitionId)
    ).toMatchObject({
      ok: false,
      reason: 'stale_acquisition'
    })
    await waitFor(() => readAuditLines(f.h.userData).length === 1, 2_000, 'the audit line')
    const audit = readAuditLines(f.h.userData)[0]
    expect(audit).toMatchObject({
      schema: 'taskwraith.workspace-lock.reclaim.v1',
      leaseId: f.leaseId,
      ownerRunId: 'run-a',
      ownerPid: 201,
      holderInstanceId: 'instance-a',
      evidence: 'lease_lapsed',
      walStatus: 'recovered',
      walReason: 'owner_dead',
      beatSeq,
      reclaimerInstanceId: 'instance-b',
      reclaimerGeneration: 2
    })
    expect(audit.heartbeatAgeMs).toBeGreaterThanOrEqual(10 * 60_000)
    expect(audit.graceObservedMs).toBeGreaterThanOrEqual(180_000)
    expect(f.reclaimer.snapshot().holderLiveness?.[f.leaseId]).toBeUndefined()
    f.dispose()
  })

  it('restarts the grace when the holder beats again', async () => {
    const f = await lapseFixture()
    await f.beat()
    f.advanceWall(10 * 60_000)
    await f.scan()
    f.advanceMonotonic(170_000)
    expect(await f.scan()).toEqual({ skipped: true, reason: 'no_candidates' })

    await f.beat()
    f.advanceMonotonic(20_000)
    expect(await f.scan()).toEqual({ skipped: true, reason: 'no_candidates' })
    f.advanceWall(10 * 60_000)
    expect(await f.scan()).toEqual({ skipped: true, reason: 'no_candidates' })
    f.advanceMonotonic(179_000)
    expect(await f.scan()).toEqual({ skipped: true, reason: 'no_candidates' })
    expect(f.leaseStatus()).toBe('orphan_live')
    f.advanceMonotonic(2_000)
    expect(await f.scan()).toMatchObject({ skipped: false, decisions: [{ status: 'recovered' }] })
    f.dispose()
  })

  it('restarts the grace on a new beatSeq even when the holder clock dates the beat stale', async () => {
    const f = await lapseFixture()
    const staleBeatAt = new Date(globalTime).toISOString()
    await f.beat(staleBeatAt)
    f.advanceWall(10 * 60_000)
    await f.scan()
    f.advanceMonotonic(170_000)
    expect(await f.scan()).toEqual({ skipped: true, reason: 'no_candidates' })

    // A holder whose clock lags beats again: still wall-stale to the
    // reclaimer, but the new beatSeq proves it alive and restarts the grace.
    await f.beat(staleBeatAt)
    f.advanceMonotonic(20_000)
    expect(await f.scan()).toEqual({ skipped: true, reason: 'no_candidates' })
    f.advanceMonotonic(179_000)
    expect(await f.scan()).toEqual({ skipped: true, reason: 'no_candidates' })
    expect(f.leaseStatus()).toBe('orphan_live')
    f.advanceMonotonic(2_000)
    expect(await f.scan()).toMatchObject({ skipped: false, decisions: [{ status: 'recovered' }] })
    f.dispose()
  })

  it('leaves a lapsed holder it cannot observe exactly as it is, however long it waits', async () => {
    const f = await lapseFixture()
    await f.beat()
    f.h.observations.set(201, { state: 'identity_unavailable' })
    f.advanceWall(10 * 60_000)
    expect(await f.scan()).toEqual({ skipped: true, reason: 'no_candidates' })
    for (let pass = 0; pass < 4; pass += 1) {
      f.advanceMonotonic(15 * 60_000)
      expect(await f.scan()).toEqual({ skipped: true, reason: 'no_candidates' })
    }
    // Neither recovered nor quarantined: any status change away from what
    // the owner holds would fail its next verification while freeing nothing.
    expect(f.leaseStatus()).toBe('orphan_live')
    expect(walEvents(f.h.persistence).filter((event) => event.kind === 'recover')).toHaveLength(1)
    expect(f.reclaimer.snapshot().holderLiveness?.[f.leaseId]).toMatchObject({
      instanceScope: 'other',
      liveness: 'lapsed'
    })
    expect(
      await f.reclaimer.acquire(
        owner({
          lockOwnerId: 'owner-b',
          runId: 'run-b',
          pid: 202,
          processBirthIdentity: 'owner-b-birth'
        }),
        f.request
      )
    ).toMatchObject({ ok: false, reason: 'conflict' })
    expect(readAuditLines(f.h.userData)).toEqual([])
    f.dispose()
  })

  it('defers a lapsed holder that still owns its commit-fence partition and reclaims once it lets go', async () => {
    const f = await lapseFixture({
      fenceOwner: { pid: 201, processBirthIdentity: 'owner-a-birth' }
    })
    await f.beat()
    f.advanceWall(10 * 60_000)
    await f.scan()
    f.advanceMonotonic(181_000)
    expect(await f.scan()).toMatchObject({
      skipped: false,
      decisions: [],
      deferred: [f.leaseId],
      reclaimed: []
    })
    expect(f.leaseStatus()).toBe('orphan_live')
    expect(walEvents(f.h.persistence).filter((event) => event.kind === 'recover')).toHaveLength(1)

    // Another process on the partition is not this holder: no deferral.
    f.setFenceOwner({ pid: 202, processBirthIdentity: 'owner-b-birth' })
    f.advanceMonotonic(1_000)
    expect(await f.scan()).toMatchObject({
      skipped: false,
      decisions: [{ leaseId: f.leaseId, status: 'recovered', reason: 'owner_dead' }],
      deferred: []
    })
    expect(f.leaseStatus()).toBe('recovered')
    f.dispose()
  })

  it('defers a lapsed live holder while its commit fence cannot be read, says why, and reclaims after a clean read', async () => {
    const f = await lapseFixture({
      fenceOwner: new Error('Unrecognised commit-fence entry: fence-v2-layout.json')
    })
    await f.beat()
    f.advanceWall(10 * 60_000)
    await f.scan()
    f.advanceMonotonic(181_000)
    expect(await f.scan()).toMatchObject({
      skipped: false,
      decisions: [],
      deferred: [f.leaseId],
      reclaimed: []
    })
    expect(f.leaseStatus()).toBe('orphan_live')
    expect(f.reclaimer.snapshot().projectionErrors).toContain(
      'commit fence read: Unrecognised commit-fence entry: fence-v2-layout.json'
    )

    // A clean read that names no one ends the deferral.
    f.setFenceOwner(null)
    f.advanceMonotonic(1_000)
    expect(await f.scan()).toMatchObject({
      skipped: false,
      decisions: [{ leaseId: f.leaseId, status: 'recovered', reason: 'owner_dead' }],
      deferred: []
    })
    expect(f.leaseStatus()).toBe('recovered')
    f.dispose()
  })

  it('never retires a lapsed live holder without a commit-fence port, yet still frees a dead one', async () => {
    const f = await lapseFixture({ fencePort: false })
    await f.beat()
    f.advanceWall(10 * 60_000)
    await f.scan()
    f.advanceMonotonic(181_000)
    expect(await f.scan()).toMatchObject({
      skipped: false,
      decisions: [],
      deferred: [f.leaseId],
      reclaimed: []
    })
    f.advanceMonotonic(30 * 60_000)
    expect(await f.scan()).toMatchObject({ skipped: false, decisions: [], deferred: [f.leaseId] })
    expect(f.leaseStatus()).toBe('orphan_live')

    // Death needs no fence read: a dead process owns no critical section.
    f.h.observations.set(201, { state: 'dead' })
    f.advanceMonotonic(1_000)
    expect(await f.scan()).toMatchObject({
      skipped: false,
      decisions: [{ leaseId: f.leaseId, status: 'recovered', reason: 'owner_dead' }],
      deferred: [],
      reclaimed: [expect.objectContaining({ evidence: 'owner_dead' })]
    })
    expect(f.leaseStatus()).toBe('recovered')
    f.dispose()
  })

  it('never reclaims a live holder that has no heartbeat file', async () => {
    const f = await lapseFixture()
    f.advanceWall(30 * 60_000)
    f.advanceMonotonic(30 * 60_000)
    expect(await f.scan()).toEqual({ skipped: true, reason: 'no_candidates' })
    f.advanceMonotonic(30 * 60_000)
    expect(await f.scan()).toEqual({ skipped: true, reason: 'no_candidates' })
    expect(f.leaseStatus()).toBe('orphan_live')
    expect(walEvents(f.h.persistence).filter((event) => event.kind === 'recover')).toHaveLength(1)
    expect(f.reclaimer.snapshot().holderLiveness?.[f.leaseId]).toEqual({
      instanceScope: 'other',
      liveness: 'live',
      generation: 1
    })
    f.dispose()
  })

  it('takes no transition fence while nothing is reclaimable', async () => {
    const f = await lapseFixture()
    await f.beat()
    const acquireFence = vi.spyOn(f.h.persistence, 'acquireInstanceFence')
    for (let pass = 0; pass < 3; pass += 1) {
      f.advanceMonotonic(30_000)
      expect(await f.scan()).toEqual({ skipped: true, reason: 'no_candidates' })
    }
    expect(acquireFence).not.toHaveBeenCalled()
    f.dispose()
  })

  it('keeps the lease when a beat lands between the pre-check and the fenced decision', async () => {
    const f = await lapseFixture()
    await f.beat()
    f.advanceWall(10 * 60_000)
    await f.scan()
    f.advanceMonotonic(181_000)
    const original = f.h.persistence.readHolderHeartbeats.bind(f.h.persistence)
    const read = vi.spyOn(f.h.persistence, 'readHolderHeartbeats').mockImplementationOnce(() => {
      const stale = original()
      const holders = holdersDirectory(f.h.userData)
      const [name] = fs.readdirSync(holders).filter((entry) => entry.endsWith('.json'))
      const record = JSON.parse(fs.readFileSync(path.join(holders, name), 'utf8')) as Record<
        string,
        unknown
      >
      fs.writeFileSync(
        path.join(holders, name),
        `${JSON.stringify({ ...record, beatSeq: (record.beatSeq as number) + 1 })}\n`
      )
      return stale
    })
    expect(await f.scan()).toMatchObject({ skipped: false, decisions: [], deferred: [] })
    expect(read).toHaveBeenCalledTimes(2)
    expect(f.leaseStatus()).toBe('orphan_live')
    f.dispose()
  })

  it('projects holder liveness for peers and itself without pids or birth identities', async () => {
    const f = await lapseFixture()
    const mine = await f.reclaimer.acquire(
      owner({
        lockOwnerId: 'owner-b',
        runId: 'run-b',
        pid: 100,
        processBirthIdentity: 'authority-birth'
      }),
      {
        workspacePath: f.h.workspace,
        kind: 'file',
        targetPath: path.join(f.h.workspace, 'src', 'b.ts')
      }
    )
    if (!mine.ok) throw new Error('fixture acquisition failed')
    expect(f.reclaimer.snapshot().holderLiveness?.[f.leaseId]).toEqual({
      instanceScope: 'other',
      liveness: 'unknown',
      generation: 1
    })
    await f.beat()
    f.advanceWall(30_000)
    await f.scan()
    const liveness = f.reclaimer.snapshot().holderLiveness
    expect(Object.keys(liveness ?? {}).sort()).toEqual([f.leaseId, mine.leases[0].leaseId].sort())
    expect(liveness?.[f.leaseId]).toMatchObject({ instanceScope: 'other', liveness: 'live' })
    expect(liveness?.[f.leaseId].heartbeatAgeMs).toBeGreaterThanOrEqual(30_000)
    expect(liveness?.[mine.leases[0].leaseId]).toEqual({
      instanceScope: 'this',
      liveness: 'live',
      generation: 2
    })
    expect(JSON.stringify(liveness)).not.toContain('201')
    expect(JSON.stringify(liveness)).not.toContain('owner-a-birth')
    expect(JSON.stringify(liveness)).not.toContain('authority-birth')
    f.h.observations.set(201, { state: 'dead' })
    await f.scan()
    expect(f.reclaimer.snapshot().holderLiveness?.[f.leaseId]).toBeUndefined()
    f.dispose()
  })

  it('keeps the holder projection stable between scans so a subscribed renderer is not re-sent it every second', async () => {
    const f = await lapseFixture()
    const mine = await f.reclaimer.acquire(
      owner({
        lockOwnerId: 'owner-b',
        runId: 'run-b',
        pid: 100,
        processBirthIdentity: 'authority-birth'
      }),
      {
        workspacePath: f.h.workspace,
        kind: 'file',
        targetPath: path.join(f.h.workspace, 'src', 'b.ts')
      }
    )
    if (!mine.ok) throw new Error('fixture acquisition failed')
    await f.beat()
    f.advanceWall(20_000)
    await f.scan()
    const first = JSON.stringify(f.reclaimer.snapshot().holderLiveness)
    expect(first).toContain(mine.leases[0].leaseId)
    expect(first).toContain(f.leaseId)
    f.advanceWall(9_000)
    f.advanceMonotonic(9_000)
    expect(JSON.stringify(f.reclaimer.snapshot().holderLiveness)).toBe(first)

    // The next scan is the only thing that moves a peer's observed age.
    f.advanceMonotonic(30_000)
    await f.scan()
    const rescanned = f.reclaimer.snapshot().holderLiveness
    expect(rescanned?.[f.leaseId].heartbeatAgeMs).toBeGreaterThan(
      JSON.parse(first)[f.leaseId].heartbeatAgeMs as number
    )
    expect(rescanned?.[mine.leases[0].leaseId]).toEqual({
      instanceScope: 'this',
      liveness: 'live',
      generation: 2
    })
    f.dispose()
  })

  it('restarts every grace window when the reclaimer itself was suspended between scans', async () => {
    const f = await lapseFixture({ holderLease: { scanIntervalMs: 60_000, suspendGapMs: 120_000 } })
    await f.beat()
    f.advanceWall(10 * 60_000)
    expect(await f.scan()).toEqual({ skipped: true, reason: 'no_candidates' })
    f.advanceMonotonic(100_000)
    expect(await f.scan()).toEqual({ skipped: true, reason: 'no_candidates' })

    // A ten-minute gap on the reclaimer's own clock (a macOS sleep advances
    // it) must not count as ten minutes of observed grace.
    f.advanceMonotonic(10 * 60_000)
    expect(await f.scan()).toEqual({ skipped: true, reason: 'no_candidates' })
    f.advanceMonotonic(100_000)
    expect(await f.scan()).toEqual({ skipped: true, reason: 'no_candidates' })
    expect(f.leaseStatus()).toBe('orphan_live')
    f.advanceMonotonic(80_000)
    expect(await f.scan()).toMatchObject({
      skipped: false,
      decisions: [{ leaseId: f.leaseId, status: 'recovered', reason: 'owner_dead' }]
    })
    f.dispose()
  })

  it('skips a scan while another live instance holds the transition mutex, and reclaims at the next one', async () => {
    const f = await lapseFixture()
    f.h.observations.set(201, { state: 'dead' })
    const foreignFence = {
      instanceId: 'other-instance',
      generation: 99,
      pid: 202,
      processBirthIdentity: 'owner-b-birth',
      fenceId: 'periodic-held-fence',
      acquiredAt: new Date(globalTime++).toISOString()
    }
    expect(f.h.persistence.acquireInstanceFence(foreignFence)).toEqual({ ok: true })
    expect(await f.scan()).toEqual({ skipped: true, reason: 'authority_busy' })
    expect(f.leaseStatus()).toBe('orphan_live')
    expect(f.reclaimer.snapshot().projectionErrors).toEqual([])
    expect(f.h.persistence.releaseInstanceFence(foreignFence.fenceId)).toBe(true)

    expect(await f.scan()).toMatchObject({
      skipped: false,
      decisions: [{ leaseId: f.leaseId, status: 'recovered', reason: 'owner_dead' }]
    })
    f.dispose()
  })

  it('keeps the reclaim audit line when marker cleanup fails after the recover frame landed', async () => {
    const f = await lapseFixture()
    f.h.observations.set(201, { state: 'dead' })
    const removeMarker = vi
      .spyOn(f.h.persistence, 'removeDerivedMarker')
      .mockImplementationOnce(() => {
        throw new Error('marker volume unavailable')
      })
    await expect(f.scan()).rejects.toThrow(/marker cleanup/i)
    expect(removeMarker).toHaveBeenCalled()
    expect(
      walEvents(f.h.persistence)
        .filter((event) => event.kind === 'recover')
        .at(-1)
    ).toMatchObject({
      authority: { instanceId: 'instance-b' },
      payload: { decisions: [{ leaseId: f.leaseId, status: 'recovered', reason: 'owner_dead' }] }
    })
    await waitFor(() => readAuditLines(f.h.userData).length === 1, 2_000, 'the audit line')
    expect(readAuditLines(f.h.userData)[0]).toMatchObject({
      leaseId: f.leaseId,
      evidence: 'owner_dead',
      walReason: 'owner_dead'
    })
    f.dispose()
  })

  it('sweeps the sidecars of holders that are conclusively gone and keeps live, unobservable and its own', async () => {
    const f = await lapseFixture({ holderLease: { sweepIntervalMs: 10 * 60_000 } })
    const sidecar = async (pid: number, processBirthIdentity: string): Promise<void> => {
      await f.h.persistence.writeHolderHeartbeat({
        schema: WORKSPACE_LOCK_HEARTBEAT_SCHEMA,
        instanceId: `holder-${pid}`,
        pid,
        processBirthIdentity,
        generation: 1,
        beatSeq: 1,
        monotonicMs: 0,
        beatAt: new Date(globalTime).toISOString()
      })
    }
    const pids = (): number[] =>
      f.h.persistence
        .readHolderHeartbeats()
        .heartbeats.map((heartbeat) => heartbeat.pid)
        .sort((left, right) => left - right)
    await sidecar(201, 'owner-a-birth')
    await sidecar(202, 'a-birth-202-no-longer-has')
    await sidecar(404, 'unobservable-birth')
    await sidecar(505, 'dead-birth')
    f.h.observations.set(505, { state: 'dead' })
    // The reclaimer's own sidecar (pid 100) was written by open().
    expect(pids()).toEqual([100, 201, 202, 404, 505])

    expect(await f.reclaimer.sweepDeadHolderHeartbeats()).toBe(2)
    expect(pids()).toEqual([100, 201, 404])

    // The periodic pass sweeps on its own cadence, not on every scan.
    await sidecar(606, 'dead-birth-606')
    f.h.observations.set(606, { state: 'dead' })
    f.advanceMonotonic(60_000)
    await f.scan()
    expect(pids()).toContain(606)
    f.advanceMonotonic(10 * 60_000)
    await f.scan()
    expect(pids()).toEqual([100, 201, 404])
    f.dispose()
  })
})

describe('WorkspaceLockAuthority boot recovery truth table', () => {
  // Captured from the pre-change authority (e7a608b8d, identical to HEAD
  // for every workLocks source) over its eight input classes. The periodic
  // pass must leave every row, including the live-foreign relabel, as is.
  const rows: {
    name: string
    lifecycle?: WorkspaceLockOwner['lifecycle']
    priorOrphan?: boolean
    issuedHere?: boolean
    observation: WorkspaceLockProcessObservation
    frames: { status: string; reason?: string }[][]
    after: string
  }[] = [
    {
      name: 'child lifecycle',
      lifecycle: 'child',
      observation: { state: 'live', processBirthIdentity: 'owner-a-birth' },
      frames: [[{ status: 'recovery_blocked' }]],
      after: 'recovery_blocked'
    },
    {
      name: 'launching-child lifecycle',
      lifecycle: 'launching-child',
      observation: { state: 'live', processBirthIdentity: 'owner-a-birth' },
      frames: [[{ status: 'recovery_blocked' }]],
      after: 'recovery_blocked'
    },
    {
      name: 'dead owner',
      observation: { state: 'dead' },
      frames: [[{ status: 'recovered', reason: 'owner_dead' }]],
      after: 'recovered/owner_dead'
    },
    {
      name: 'identity unavailable',
      observation: { state: 'identity_unavailable' },
      frames: [[{ status: 'recovery_blocked' }]],
      after: 'recovery_blocked'
    },
    {
      name: 'pid reused',
      observation: { state: 'live', processBirthIdentity: 'other-birth' },
      frames: [[{ status: 'recovered', reason: 'pid_reused' }]],
      after: 'recovered/pid_reused'
    },
    {
      name: 'live, issued by this instance and generation',
      issuedHere: true,
      observation: { state: 'live', processBirthIdentity: 'owner-a-birth' },
      frames: [],
      after: 'held'
    },
    {
      name: 'live, issued elsewhere',
      observation: { state: 'live', processBirthIdentity: 'owner-a-birth' },
      frames: [[{ status: 'orphan_live' }]],
      after: 'orphan_live'
    },
    {
      name: 'live, issued elsewhere and already orphan_live',
      priorOrphan: true,
      observation: { state: 'live', processBirthIdentity: 'owner-a-birth' },
      frames: [[{ status: 'orphan_live' }]],
      after: 'orphan_live'
    }
  ]

  it.each(rows)('$name', async (row) => {
    const h = harness('instance-a')
    const first = await openAuthority({
      persistence: h.persistence,
      dependencies: h.dependencies
    })
    const acquired = await first.acquire(
      owner({
        lockOwnerId: 'owner-a',
        runId: 'run-a',
        ...(row.lifecycle ? { lifecycle: row.lifecycle } : {})
      }),
      {
        workspacePath: h.workspace,
        kind: 'file',
        targetPath: path.join(h.workspace, 'src', 'a.ts')
      }
    )
    expect(acquired).toMatchObject({ ok: true })
    if (row.priorOrphan) {
      first.dispose()
      const foreign = await openAuthority({
        persistence: h.persistence,
        dependencies: {
          ...h.dependencies,
          instance: { ...h.dependencies.instance, instanceId: 'instance-x' }
        }
      })
      expect(foreign.snapshot().leases.map((lease) => lease.status)).toEqual(['orphan_live'])
      foreign.dispose()
    } else if (!row.issuedHere) {
      first.dispose()
    }
    h.observations.set(201, row.observation)
    let after: WorkspaceLockAuthority
    if (row.issuedHere) {
      await first.recoverStaleClaims()
      after = first
    } else {
      after = await openAuthority({
        persistence: h.persistence,
        dependencies: {
          ...h.dependencies,
          instance: { ...h.dependencies.instance, instanceId: 'instance-b' }
        }
      })
    }
    const frames = (): { status: string; reason?: string }[][] =>
      walEvents(h.persistence).flatMap((event) =>
        event.kind === 'recover'
          ? [
              event.payload.decisions.map((decision) => ({
                status: decision.status,
                ...(decision.reason ? { reason: decision.reason } : {})
              }))
            ]
          : []
      )
    const statuses = (): string[] =>
      after
        .snapshot()
        .leases.map(
          (lease) => `${lease.status}${lease.recoveryReason ? `/${lease.recoveryReason}` : ''}`
        )
    expect(frames()).toEqual(row.frames)
    expect(statuses()).toEqual([row.after])

    // The periodic pass leaves every row exactly as boot left it.
    await after.runPeriodicRecovery()
    expect(frames()).toEqual(row.frames)
    expect(statuses()).toEqual([row.after])
    after.dispose()
  })

  it.each(['child', 'launching-child'] as const)(
    'never reclaims a %s lease from the periodic pass, even once its process is gone',
    async (lifecycle) => {
      const h = harness('instance-a')
      const authority = await openAuthority({
        persistence: h.persistence,
        dependencies: h.dependencies,
        holderLease: { scanIntervalMs: 60_000, heartbeatIntervalMs: 60_000 }
      })
      const acquired = await authority.acquire(
        owner({ lockOwnerId: 'owner-a', runId: 'run-a', lifecycle }),
        {
          workspacePath: h.workspace,
          kind: 'file',
          targetPath: path.join(h.workspace, 'src', 'a.ts')
        }
      )
      expect(acquired).toMatchObject({ ok: true })
      // A child's lease belongs to the human recovery path, dead or alive.
      h.observations.set(201, { state: 'dead' })
      expect(await authority.runPeriodicRecovery()).toEqual({
        skipped: true,
        reason: 'no_active_leases'
      })
      expect(authority.snapshot().leases.map((lease) => lease.status)).toEqual(['held'])
      expect(walEvents(h.persistence).filter((event) => event.kind === 'recover')).toEqual([])
      authority.dispose()
    }
  )
})
