import { describe, expect, it } from 'vitest'

import { workspaceLockRuntimeMarkerFilename } from './WorkspaceLockMarkerProjection'
import type { WorkspaceLockLease } from './WorkspaceLockTypes'
import {
  appendWorkspaceLockWalEvent,
  createEmptyWorkspaceLockWalState,
  decodeWorkspaceLockWal,
  digestWorkspaceLockWalRecord,
  WORKSPACE_LOCK_WAL_SCHEMA,
  type WorkspaceLockWalEventInput,
  type WorkspaceLockWalState
} from './WorkspaceLockWal'

const timestamp = '2026-07-29T16:40:00.000Z'
const laterTimestamp = '2026-07-29T16:41:00.000Z'
const authority = { instanceId: 'desktop-a', generation: 4 }
const markerName = `.WORK-IN-PROGRESS-taskwraith-runtime-desktop-a-${'a'.repeat(64)}.md`

function boot(): WorkspaceLockWalEventInput {
  return {
    transitionId: 'boot-1',
    timestamp,
    authority,
    kind: 'boot',
    payload: {
      fence: {
        ...authority,
        pid: 1234,
        processBirthIdentity: 'birth-a',
        fenceId: 'fence-a',
        acquiredAt: timestamp
      }
    }
  }
}

function lease(id: string, runId = 'run-a'): WorkspaceLockLease {
  const target = `/workspace/${id}.ts`
  const rootIdentity = { device: '1', inode: '1', key: 'dev:1:ino:1' }
  const targetIdentity = { device: '1', inode: '2', key: `target-${id}` }
  return {
    leaseId: id,
    acquiredTransitionId: 'acquire-1',
    authorityInstanceId: authority.instanceId,
    authorityGeneration: authority.generation,
    owner: {
      lockOwnerId: `owner-${id}`,
      runId,
      pid: 4321,
      processBirthIdentity: `owner-birth-${id}`
    },
    claim: {
      workspaceIdentity: '/workspace',
      worktreeCanonicalPath: '/workspace',
      worktreeIdentity: '/workspace',
      worktreeObjectIdentity: rootIdentity.key,
      targetCanonicalPath: target,
      comparisonTargetPath: target,
      objectIdentity: targetIdentity.key,
      physicalTargetIdentity: target,
      displayWorkspacePath: '/workspace',
      displayWorktreePath: '/workspace',
      relativeTargetPath: `${id}.ts`,
      kind: 'file',
      mode: 'write',
      pathEvidence: {
        requestedRootPath: '/workspace',
        requestedTargetPath: target,
        lexicalRootPath: '/workspace',
        lexicalTargetPath: target,
        pathFlavor: 'posix',
        caseSensitive: true,
        targetExists: true,
        canonicalPath: target,
        comparisonPath: target,
        physicalIdentity: targetIdentity.key,
        targetIdentity: {
          kind: 'existing',
          file: targetIdentity,
          key: targetIdentity.key
        },
        containment: {
          canonicalRootPath: '/workspace',
          canonicalTargetPath: target,
          comparisonRootPath: '/workspace',
          comparisonTargetPath: target,
          relativeTargetPath: `${id}.ts`,
          rootIdentity,
          existingAncestorCanonicalPath: target,
          existingAncestorIdentity: targetIdentity
        }
      }
    },
    acquiredAt: laterTimestamp,
    status: 'held',
    statusChangedAt: laterTimestamp
  }
}

function append(state: WorkspaceLockWalState, input: WorkspaceLockWalEventInput) {
  return appendWorkspaceLockWalEvent(state, input)
}

describe('WorkspaceLockWal', () => {
  it('accepts only a torn final fragment and replays the complete durable prefix', () => {
    const first = append(createEmptyWorkspaceLockWalState(), boot())
    const decoded = decodeWorkspaceLockWal(`${first.line}{"schema":"torn`)

    expect(decoded.sequence).toBe(1)
    expect(decoded.lastTransitionId).toBe('boot-1')
    expect(() => decodeWorkspaceLockWal(`${first.line}{not json}\n`)).toThrow(/corrupt at line 2/i)
    expect(() => decodeWorkspaceLockWal(`${first.line}{"schema":"torn"}\n`)).toThrow(
      /corrupt at line 2/i
    )
  })

  it('rejects tampering, reordering, and duplicate transition or lease ids fail-closed', () => {
    const first = append(createEmptyWorkspaceLockWalState(), boot())
    const second = append(first.nextState, {
      transitionId: 'acquire-1',
      timestamp: laterTimestamp,
      authority,
      kind: 'acquire',
      payload: { leases: [lease('lease-a')] }
    })
    const duplicateTransition = {
      ...second.event,
      transitionId: 'boot-1'
    }
    const { digest: _oldDigest, ...duplicateUnsigned } = duplicateTransition
    duplicateTransition.digest = digestWorkspaceLockWalRecord(duplicateUnsigned)

    expect(() =>
      decodeWorkspaceLockWal(`${first.line}${second.line.replace('acquire-1', 'acquire-x')}`)
    ).toThrow(/digest mismatch/i)
    expect(() => decodeWorkspaceLockWal(`${second.line}${first.line}`)).toThrow(/sequence/i)
    expect(() =>
      decodeWorkspaceLockWal(`${first.line}${JSON.stringify(duplicateTransition)}\n`)
    ).toThrow(/duplicate transition id/i)

    const released = append(second.nextState, {
      transitionId: 'release-1',
      timestamp: '2026-07-29T16:42:00.000Z',
      authority,
      kind: 'release',
      payload: { leaseIds: ['lease-a'] }
    })
    const reusedLease = {
      ...lease('lease-a'),
      acquiredTransitionId: 'acquire-2',
      acquiredAt: '2026-07-29T16:43:00.000Z',
      statusChangedAt: '2026-07-29T16:43:00.000Z'
    }
    expect(() =>
      append(released.nextState, {
        transitionId: 'acquire-2',
        timestamp: '2026-07-29T16:43:00.000Z',
        authority,
        kind: 'acquire',
        payload: { leases: [reusedLease] }
      })
    ).toThrow(/duplicate lease id/i)
  })

  it('replaces an acquisition atomically in one chained WAL record', () => {
    const first = append(createEmptyWorkspaceLockWalState(), boot())
    const acquired = append(first.nextState, {
      transitionId: 'acquire-1',
      timestamp: laterTimestamp,
      authority,
      kind: 'acquire',
      payload: { leases: [lease('lease-old')] }
    })
    const replacementLease = {
      ...lease('lease-new'),
      acquiredTransitionId: 'acquire-2',
      acquiredAt: '2026-07-29T16:42:00.000Z',
      statusChangedAt: '2026-07-29T16:42:00.000Z'
    }
    const replaced = append(acquired.nextState, {
      transitionId: 'acquire-2',
      timestamp: '2026-07-29T16:42:00.000Z',
      authority,
      kind: 'acquire',
      payload: {
        leases: [replacementLease],
        replacesLeaseIds: ['lease-old']
      }
    })

    expect(replaced.nextState.activeLeases.map((candidate) => candidate.leaseId)).toEqual([
      'lease-new'
    ])
    expect(
      decodeWorkspaceLockWal(`${first.line}${acquired.line}${replaced.line}`).activeLeases.map(
        (candidate) => candidate.leaseId
      )
    ).toEqual(['lease-new'])
  })

  it('requires typed recovery reasons only for recovered decisions', () => {
    const first = append(createEmptyWorkspaceLockWalState(), boot())
    const acquired = append(first.nextState, {
      transitionId: 'acquire-1',
      timestamp: laterTimestamp,
      authority,
      kind: 'acquire',
      payload: { leases: [lease('lease-recovery')] }
    })
    expect(() =>
      append(acquired.nextState, {
        transitionId: 'recover-missing-reason',
        timestamp: '2026-07-29T16:42:00.000Z',
        authority,
        kind: 'recover',
        payload: {
          decisions: [{ leaseId: 'lease-recovery', status: 'recovered' }]
        }
      })
    ).toThrow(/missing.*reason/i)
    expect(() =>
      append(acquired.nextState, {
        transitionId: 'recover-extra-reason',
        timestamp: '2026-07-29T16:42:00.000Z',
        authority,
        kind: 'recover',
        payload: {
          decisions: [{ leaseId: 'lease-recovery', status: 'orphan_live', reason: 'owner_dead' }]
        }
      })
    ).toThrow(/cannot include.*reason/i)
  })

  it('bounds recovered lease projection while retaining durable lease-id history', () => {
    let state = append(createEmptyWorkspaceLockWalState(), boot()).nextState
    for (let index = 0; index < 105; index += 1) {
      const acquiredAt = new Date(Date.parse(laterTimestamp) + (index + 1) * 2_000).toISOString()
      const acquiredTransitionId = `bounded-acquire-${index}`
      const candidate = {
        ...lease(`bounded-${index}`),
        acquiredTransitionId,
        acquiredAt,
        statusChangedAt: acquiredAt
      }
      state = append(state, {
        transitionId: acquiredTransitionId,
        timestamp: acquiredAt,
        authority,
        kind: 'acquire',
        payload: { leases: [candidate] }
      }).nextState
      state = append(state, {
        transitionId: `bounded-recover-${index}`,
        timestamp: new Date(Date.parse(acquiredAt) + 1_000).toISOString(),
        authority,
        kind: 'recover',
        payload: {
          decisions: [
            {
              leaseId: candidate.leaseId,
              status: 'recovered',
              reason: 'owner_dead'
            }
          ]
        }
      }).nextState
    }

    expect(state.recoveredLeases).toHaveLength(100)
    expect(state.leaseIds).toHaveLength(105)
    expect(state.recoveredLeases.some((candidate) => candidate.leaseId === 'bounded-0')).toBe(false)
    expect(state.recoveredLeases.some((candidate) => candidate.leaseId === 'bounded-104')).toBe(
      true
    )
  })

  it('replays acquire, release, release_run, and conservative recovery deterministically', () => {
    let state = createEmptyWorkspaceLockWalState()
    let raw = ''
    const frames: WorkspaceLockWalEventInput[] = [
      boot(),
      {
        transitionId: 'acquire-1',
        timestamp: laterTimestamp,
        authority,
        kind: 'acquire',
        payload: {
          leases: [
            lease('lease-release'),
            lease('lease-run', 'run-b'),
            lease('lease-live', 'run-b')
          ],
          markers: [
            {
              worktreeIdentity: '/workspace',
              worktreeObjectIdentity: 'dev:1:ino:1',
              markerName
            }
          ]
        }
      },
      {
        transitionId: 'release-1',
        timestamp: '2026-07-29T16:42:00.000Z',
        authority,
        kind: 'release',
        payload: { leaseIds: ['lease-release'] }
      },
      {
        transitionId: 'release-run-1',
        timestamp: '2026-07-29T16:43:00.000Z',
        authority,
        kind: 'release_run',
        payload: { runId: 'run-b', leaseIds: ['lease-run'] }
      },
      {
        transitionId: 'recover-1',
        timestamp: '2026-07-29T16:44:00.000Z',
        authority,
        kind: 'recover',
        payload: {
          decisions: [{ leaseId: 'lease-live', status: 'orphan_live' }]
        }
      },
      {
        transitionId: 'recover-2',
        timestamp: '2026-07-29T16:45:00.000Z',
        authority,
        kind: 'recover',
        payload: {
          decisions: [{ leaseId: 'lease-live', status: 'recovered', reason: 'owner_dead' }]
        }
      }
    ]

    for (const frame of frames) {
      const appended = append(state, frame)
      state = appended.nextState
      raw += appended.line
    }

    const replayed = decodeWorkspaceLockWal(raw)
    expect(replayed).toEqual(state)
    expect(replayed.activeLeases).toEqual([])
    expect(replayed.recoveredLeases).toMatchObject([
      {
        leaseId: 'lease-live',
        status: 'recovered',
        recoveryReason: 'owner_dead',
        statusChangedAt: '2026-07-29T16:45:00.000Z'
      }
    ])
    expect(replayed.knownMarkers).toEqual([
      {
        worktreeIdentity: '/workspace',
        worktreeObjectIdentity: 'dev:1:ino:1',
        markerName
      }
    ])
    expect(replayed.maxGeneration).toBe(4)
  })

  it('durably retires only pending inactive markers and bounds cleanup inventory', () => {
    const activeLease = lease('active-marker')
    const activeMarker = {
      worktreeIdentity: '/workspace',
      worktreeObjectIdentity: 'dev:1:ino:1',
      markerName: workspaceLockRuntimeMarkerFilename(
        activeLease.authorityInstanceId,
        activeLease.owner.lockOwnerId
      )
    }
    let state = append(createEmptyWorkspaceLockWalState(), boot()).nextState
    state = append(state, {
      transitionId: 'active-marker-acquire',
      timestamp: laterTimestamp,
      authority,
      kind: 'acquire',
      payload: {
        leases: [
          {
            ...activeLease,
            acquiredTransitionId: 'active-marker-acquire'
          }
        ],
        markers: [activeMarker]
      }
    }).nextState
    expect(() =>
      append(state, {
        transitionId: 'invalid-active-cleanup',
        timestamp: '2026-07-29T16:42:00.000Z',
        authority,
        kind: 'cleanup',
        payload: { markers: [activeMarker] }
      })
    ).toThrow(/active marker/i)

    state = append(state, {
      transitionId: 'active-marker-release',
      timestamp: '2026-07-29T16:43:00.000Z',
      authority,
      kind: 'release',
      payload: { leaseIds: [activeLease.leaseId] }
    }).nextState
    state = append(state, {
      transitionId: 'active-marker-cleanup',
      timestamp: '2026-07-29T16:44:00.000Z',
      authority,
      kind: 'cleanup',
      payload: { markers: [activeMarker] }
    }).nextState
    expect(state.knownMarkers).toEqual([])
    expect(() =>
      append(state, {
        transitionId: 'invalid-unknown-cleanup',
        timestamp: '2026-07-29T16:45:00.000Z',
        authority,
        kind: 'cleanup',
        payload: { markers: [activeMarker] }
      })
    ).toThrow(/not pending/i)

    let peakPending = 0
    for (let index = 0; index < 2_000; index += 1) {
      const marker = {
        worktreeIdentity: `/workspace-${index}`,
        worktreeObjectIdentity: `dev:1:ino:${index + 10}`,
        markerName: `.WORK-IN-PROGRESS-taskwraith-runtime-stress-${index
          .toString(16)
          .padStart(64, '0')}.md`
      }
      state = append(state, {
        transitionId: `stress-prepare-${index}`,
        timestamp: '2026-07-29T16:46:00.000Z',
        authority,
        kind: 'prepare',
        payload: { markers: [marker] }
      }).nextState
      peakPending = Math.max(peakPending, state.knownMarkers.length)
      state = append(state, {
        transitionId: `stress-cleanup-${index}`,
        timestamp: '2026-07-29T16:47:00.000Z',
        authority,
        kind: 'cleanup',
        payload: { markers: [marker] }
      }).nextState
    }
    expect(peakPending).toBe(1)
    expect(state.knownMarkers).toEqual([])
  })

  it('replays long WAL histories with linear rather than quadratic growth', () => {
    let previousDigest = ''
    const lines: string[] = []
    for (let index = 1; index <= 10_000; index += 1) {
        const unsigned = {
          schema: WORKSPACE_LOCK_WAL_SCHEMA as typeof WORKSPACE_LOCK_WAL_SCHEMA,
        sequence: index,
        previousDigest,
        transitionId: `scale-${index}`,
        timestamp,
        authority,
        kind: 'boot' as const,
        payload: {
          fence: {
            ...authority,
            pid: 1234,
            processBirthIdentity: 'birth-a',
            fenceId: `scale-fence-${index}`,
            acquiredAt: timestamp
          }
        }
      }
      const digest = digestWorkspaceLockWalRecord(unsigned)
      lines.push(`${JSON.stringify({ ...unsigned, digest })}\n`)
      previousDigest = digest
    }
    const firstHalf = lines.slice(0, 5_000).join('')
    const complete = lines.join('')

    const firstStarted = performance.now()
    expect(decodeWorkspaceLockWal(firstHalf).sequence).toBe(5_000)
    const firstElapsed = performance.now() - firstStarted
    const completeStarted = performance.now()
    expect(decodeWorkspaceLockWal(complete).sequence).toBe(10_000)
    const completeElapsed = performance.now() - completeStarted

    expect(completeElapsed).toBeLessThan(firstElapsed * 3 + 100)
    expect(completeElapsed).toBeLessThan(2_500)
  }, 15_000)
})
