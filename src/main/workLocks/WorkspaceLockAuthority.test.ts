import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  resolveCanonicalWorkspaceLockPath,
  verifyCanonicalWorkspaceLockPath
} from './CanonicalWorkspaceLockPath'
import {
  NodeWorkspaceLockPersistence,
  WORKSPACE_LOCK_AUTHORITY_DIRECTORY,
  WORKSPACE_LOCK_EVENTS_FILENAME
} from './NodeWorkspaceLockPersistence'
import { WorkspaceLockAuthority, WorkspaceLockAuthorityBusyError } from './WorkspaceLockAuthority'
import { workspaceLockRuntimeMarkerFilename } from './WorkspaceLockMarkerProjection'
import type {
  WorkspaceLockAuthorityDependencies,
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

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
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
  it('acquires deterministic batches atomically and permits the exact owner to continue', async () => {
    const h = harness()
    const authority = await WorkspaceLockAuthority.open({
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
  })

  it('contains untrusted presentation before WAL preparation without weakening owner ids', async () => {
    const h = harness()
    const authority = await WorkspaceLockAuthority.open({
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
  })

  it('allows disjoint same-baseline hunks but rejects overlap and baseline drift', async () => {
    const h = harness()
    const authority = await WorkspaceLockAuthority.open({
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
    const authority = await WorkspaceLockAuthority.open({
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
    const authority = await WorkspaceLockAuthority.open({
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
  })

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

    const authority = await WorkspaceLockAuthority.open({
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
  })

  it('atomically transfers a native lease to the exact spawned child incarnation', async () => {
    const h = harness()
    const authority = await WorkspaceLockAuthority.open({
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
    let authority = await WorkspaceLockAuthority.open({
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
    authority = await WorkspaceLockAuthority.open({
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
    authority = await WorkspaceLockAuthority.open({
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
    const authority = await WorkspaceLockAuthority.open({
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
    const authority = await WorkspaceLockAuthority.open({
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
    const authority = await WorkspaceLockAuthority.open({
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
      const authority = await WorkspaceLockAuthority.open({
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
    const authority = await WorkspaceLockAuthority.open({
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
    const first = await WorkspaceLockAuthority.open({
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
    const second = await WorkspaceLockAuthority.open({
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
    const third = await WorkspaceLockAuthority.open({
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

  it('fences direct release tokens and protects exact-live orphans from terminal cleanup', async () => {
    const h = harness()
    const authority = await WorkspaceLockAuthority.open({
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
    const authority = await WorkspaceLockAuthority.open({
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
    const restarted = await WorkspaceLockAuthority.open({
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
      WorkspaceLockAuthority.open({
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
    const authority = await WorkspaceLockAuthority.open({
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
    const disposableWorkspace = path.join(h.root, 'disposable-worktree')
    fs.mkdirSync(path.join(disposableWorkspace, 'src'), { recursive: true })
    fs.writeFileSync(path.join(disposableWorkspace, 'src', 'gone.ts'), 'gone\n')
    const authority = await WorkspaceLockAuthority.open({
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
    fs.rmSync(disposableWorkspace, { recursive: true })
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
    const authority = await WorkspaceLockAuthority.open({
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
    const authority = await WorkspaceLockAuthority.open({
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
    const first = await WorkspaceLockAuthority.open({
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
    const second = await WorkspaceLockAuthority.open({
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
    const authority = await WorkspaceLockAuthority.open({
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
    const authority = await WorkspaceLockAuthority.open({
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
    const authority = await WorkspaceLockAuthority.open({
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
    const reopened = await WorkspaceLockAuthority.open({
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
    const authority = await WorkspaceLockAuthority.open({
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
    const reopened = await WorkspaceLockAuthority.open({
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
    const authority = await WorkspaceLockAuthority.open({
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
    const reopened = await WorkspaceLockAuthority.open({
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
    const authority = await WorkspaceLockAuthority.open({
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
    const authority = await WorkspaceLockAuthority.open({
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
    const authority = await WorkspaceLockAuthority.open({
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
