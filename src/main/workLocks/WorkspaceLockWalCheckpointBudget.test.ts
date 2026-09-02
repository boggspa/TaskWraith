import { describe, expect, it } from 'vitest'

import type { WorkspaceLockLease } from './WorkspaceLockTypes'
import {
  appendWorkspaceLockWalEvent,
  createEmptyWorkspaceLockWalState,
  decodeWorkspaceLockWal,
  type WorkspaceLockWalState
} from './WorkspaceLockWal'
import {
  planWorkspaceLockWalCompaction,
  decodeWorkspaceLockWalCheckpoint,
  resolveWorkspaceLockWalState
} from './WorkspaceLockWalCheckpoint'

/**
 * CI budget for fix #1.
 *
 * The claim being defended is not "startup got faster" but "startup decode no
 * longer scales with the historical event payload". So this synthesizes a
 * history large enough for the scaling to show, then asserts the checkpointed
 * decode is a small fraction of the full replay AND reconstructs the identical
 * authority projection.
 *
 * The ratio bound is deliberately loose (a 5x floor against a measured ~19x on
 * the real 127.6 MiB journal) so it fails on a lost checkpoint, a reintroduced
 * full replay, or an accidental per-event revalidation — not on CI jitter.
 * `scripts/perf/walCheckpointBench.cjs` is the precise measurement.
 */

const timestamp = '2026-08-29T02:00:00.000Z'
const authority = { instanceId: 'budget-instance', generation: 7 }
const HISTORY_CYCLES = 1_500
// 5x proved to sit inside scheduler jitter, not outside it: the 4-core CI
// runners measured 4.31x (macOS-Intel) / 4.52x (Linux) on run 33591765269 and
// a loaded local Apple Silicon measured 4.97x, while the real 127.6 MiB
// journal sits at ~19x. A lost checkpoint or reintroduced full replay measures
// ~1x, so 3x still fails every defended regression without flaking on load.
// `scripts/perf/walCheckpointBench.cjs` remains the precise measurement.
const MIN_SPEEDUP = 3

function lease(id: string, transitionId: string): WorkspaceLockLease {
  const target = `/workspace/${id}.ts`
  const rootIdentity = { device: '1', inode: '1', key: 'dev:1:ino:1' }
  const targetIdentity = { device: '1', inode: '2', key: `target-${id}` }
  return {
    leaseId: id,
    acquiredTransitionId: transitionId,
    authorityInstanceId: authority.instanceId,
    authorityGeneration: authority.generation,
    owner: {
      lockOwnerId: `owner-${id}`,
      runId: `run-${id}`,
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
        targetIdentity: { kind: 'existing', file: targetIdentity, key: targetIdentity.key },
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
    acquiredAt: timestamp,
    status: 'held',
    statusChangedAt: timestamp
  }
}

/** Acquire/release cycles: the expensive validation path, not cheap boot frames. */
function synthesizeHistory(cycles: number): { raw: string; state: WorkspaceLockWalState } {
  let state = createEmptyWorkspaceLockWalState()
  let raw = ''
  const boot = appendWorkspaceLockWalEvent(state, {
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
  })
  state = boot.nextState
  raw += boot.line
  for (let index = 0; index < cycles; index += 1) {
    const transitionId = `acquire-${index}`
    const acquired = appendWorkspaceLockWalEvent(state, {
      transitionId,
      timestamp,
      authority,
      kind: 'acquire',
      payload: { leases: [lease(`lease-${index}`, transitionId)] }
    })
    state = acquired.nextState
    raw += acquired.line
    const released = appendWorkspaceLockWalEvent(state, {
      transitionId: `release-${index}`,
      timestamp,
      authority,
      kind: 'release',
      payload: { leaseIds: [`lease-${index}`] }
    })
    state = released.nextState
    raw += released.line
  }
  return { raw, state }
}

function medianMs(run: () => unknown, iterations = 3): number {
  const times: number[] = []
  for (let index = 0; index < iterations; index += 1) {
    const start = process.hrtime.bigint()
    run()
    times.push(Number(process.hrtime.bigint() - start) / 1e6)
  }
  times.sort((left, right) => left - right)
  return times[(times.length - 1) >> 1]
}

/** Key-sorted: a checkpointed lease round-trips through canonical JSON. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>
    const result: Record<string, unknown> = {}
    for (const key of Object.keys(source).sort()) {
      if (source[key] !== undefined) result[key] = canonical(source[key])
    }
    return result
  }
  return value
}

function projection(state: WorkspaceLockWalState): string {
  return JSON.stringify(
    canonical({
      sequence: state.sequence,
      lastDigest: state.lastDigest,
      lastTransitionId: state.lastTransitionId,
      transitionIdCount: state.transitionIds.length,
      leaseIds: state.leaseIds,
      maxGeneration: state.maxGeneration,
      activeLeases: state.activeLeases,
      recoveredLeases: state.recoveredLeases,
      knownMarkers: state.knownMarkers
    })
  )
}

describe('workspace-lock startup decode budget', () => {
  it('stops scaling with the historical event payload and preserves the projection', () => {
    const history = synthesizeHistory(HISTORY_CYCLES)
    expect(history.state.sequence).toBe(HISTORY_CYCLES * 2 + 1)

    const plan = planWorkspaceLockWalCompaction({
      state: history.state,
      rawTail: history.raw,
      createdAt: timestamp,
      authority,
      previousCheckpoint: null,
      retainedTailEvents: 512
    })
    expect(plan).not.toBeNull()
    if (!plan) throw new Error('expected a compaction plan')

    const legacyMs = medianMs(() => decodeWorkspaceLockWal(history.raw))
    const checkpointedMs = medianMs(() =>
      resolveWorkspaceLockWalState(
        plan.retainedFrames,
        decodeWorkspaceLockWalCheckpoint(plan.serializedCheckpoint)
      )
    )

    const resolved = resolveWorkspaceLockWalState(
      plan.retainedFrames,
      decodeWorkspaceLockWalCheckpoint(plan.serializedCheckpoint)
    )
    expect(resolved.source).toBe('checkpoint')
    expect(projection(resolved.state)).toBe(projection(history.state))
    // The retained tail is bounded; the sealed prefix is not replayed at all.
    expect(resolved.state.events.length).toBe(512)
    expect(resolved.state.sequence).toBe(history.state.sequence)

    expect(legacyMs / Math.max(checkpointedMs, 0.001)).toBeGreaterThan(MIN_SPEEDUP)
  }, 120_000)
})
