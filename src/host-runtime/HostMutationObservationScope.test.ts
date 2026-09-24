import { describe, expect, it } from 'vitest'

import {
  createEmptyHostSnapshot,
  HOST_PROTOCOL_MAX_COLLECTION,
  HOST_PROTOCOL_VERSION,
  type HostCommand,
  type HostRunProjection
} from '../shared/hostProtocol'
import {
  createHostMutationObservationScope,
  extendHostMutationObservationScope,
  scopeHostMutationObservationFamilies,
  type HostMutationObservationFamilies
} from './HostMutationObservationScope'
import { diffHostSnapshotDomainEffects } from './HostSnapshotDomainEffectDiff'
import { projectHostSnapshot } from './HostSnapshotProjector'

const TARGET_THREAD_ID = 'thread-target'

function command(name: HostCommand['name'] = 'thread.record.persist'): HostCommand {
  return {
    type: 'host.command',
    protocolVersion: HOST_PROTOCOL_VERSION,
    commandId: '11111111-1111-4111-8111-111111111111',
    idempotencyKey: 'thread-record:11111111-1111-4111-8111-111111111111',
    actor: { actorId: 'actor', clientId: 'client', clientClass: 'desktop' },
    name,
    target: { threadId: TARGET_THREAD_ID },
    arguments: {},
    issuedAt: '2026-08-30T10:00:00.000Z'
  }
}

function unrelatedRuns(): HostRunProjection[] {
  return Array.from({ length: HOST_PROTOCOL_MAX_COLLECTION + 1 }, (_, index) => ({
    runId: `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    threadId: `thread-unrelated-${index}`,
    providerId: 'codex',
    providerOutcome: 'completed',
    endedAt: index + 1
  }))
}

function families(runs: HostRunProjection[]): HostMutationObservationFamilies {
  return {
    health: {
      hostStatus: 'ok',
      connectionPhase: 'live',
      supervised: false,
      freshness: 'live'
    },
    workspaces: [],
    threads: [
      {
        id: TARGET_THREAD_ID,
        workspaceId: null,
        title: 'Target',
        chatKind: 'ensemble',
        archived: false,
        pinned: false,
        updatedAt: 1,
        messageCount: 0
      }
    ],
    runs,
    missions: [],
    rounds: [],
    participants: [],
    providers: [],
    questions: [],
    approvals: [],
    schedules: [],
    usage: { availability: 'unavailable', confidence: 'unknown', band: 'unknown' },
    artifacts: [],
    warnings: []
  }
}

function snapshot(input: HostMutationObservationFamilies) {
  const empty = createEmptyHostSnapshot({
    generation: 1,
    cursor: 0,
    freshness: 'live',
    generatedAt: '2026-08-30T10:00:00.000Z'
  })
  const projected = projectHostSnapshot({
    ...input,
    position: {
      generation: empty.generation,
      cursor: empty.cursor,
      freshness: empty.freshness,
      generatedAt: empty.generatedAt
    },
    recovery: empty.recovery
  })
  expect(projected.ok).toBe(true)
  if (!projected.ok) throw new Error(projected.error)
  return projected.value
}

describe('HostMutationObservationScope', () => {
  it('does not manufacture an unrelated tombstone when a new UUID enters the global window', () => {
    const existingTarget: HostRunProjection = {
      runId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      threadId: TARGET_THREAD_ID,
      providerId: 'codex',
      providerOutcome: 'completed',
      endedAt: 1
    }
    const createdTarget: HostRunProjection = {
      // This sorts ahead of the unrelated rows and would evict their old
      // 2,000th member from a moving global cap.
      runId: '00000000-0000-4000-8000-000000000001',
      threadId: TARGET_THREAD_ID,
      providerId: 'codex',
      providerOutcome: 'running',
      startedAt: 2
    }
    const before = families([...unrelatedRuns(), existingTarget])
    const after = families([...unrelatedRuns(), existingTarget, createdTarget])
    const initial = createHostMutationObservationScope(command(), before)
    const extended = extendHostMutationObservationScope(initial, undefined, after)

    const diff = diffHostSnapshotDomainEffects(
      snapshot(scopeHostMutationObservationFamilies(before, initial)),
      snapshot(scopeHostMutationObservationFamilies(after, extended))
    )

    expect(diff).toEqual({
      kind: 'effects',
      effects: [
        expect.objectContaining({
          kind: 'upsert',
          family: 'run',
          entityId: createdTarget.runId
        })
      ]
    })
  })

  it('observes a real deletion even when the run was outside the old global window', () => {
    const deletedTarget: HostRunProjection = {
      runId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      threadId: TARGET_THREAD_ID,
      providerId: 'codex',
      providerOutcome: 'completed',
      endedAt: 1
    }
    const before = families([...unrelatedRuns(), deletedTarget])
    const after = families(unrelatedRuns())
    const initial = createHostMutationObservationScope(command('thread.record.delete'), before)
    const extended = extendHostMutationObservationScope(initial, undefined, after)

    const diff = diffHostSnapshotDomainEffects(
      snapshot(scopeHostMutationObservationFamilies(before, initial)),
      snapshot(scopeHostMutationObservationFamilies(after, extended))
    )

    expect(diff).toEqual({
      kind: 'effects',
      effects: [
        expect.objectContaining({
          kind: 'tombstone',
          family: 'run',
          entityId: deletedTarget.runId
        })
      ]
    })
  })
})
