import { describe, expect, it } from 'vitest'
import {
  createEmptyHostSnapshot,
  HOST_PROTOCOL_VERSION,
  HOST_PROJECTION_VERSION,
  type HostDeltaEnvelope,
  type HostDeltaFamily,
  type HostSnapshot
} from './hostProtocol'
import { applyHostSnapshotDeltas } from './hostSnapshotApply'

function envelope(
  overrides: Partial<HostDeltaEnvelope> &
    Pick<HostDeltaEnvelope, 'cursor' | 'previousCursor' | 'kind' | 'family'>
): HostDeltaEnvelope {
  return {
    protocolVersion: HOST_PROTOCOL_VERSION,
    projectionVersion: HOST_PROJECTION_VERSION,
    generation: 1,
    at: '2026-08-04T00:00:00.000Z',
    ...overrides
  }
}

function baseCache(cursor = 0): HostSnapshot {
  return createEmptyHostSnapshot({
    generation: 1,
    cursor,
    freshness: 'live',
    generatedAt: '2026-08-04T00:00:00.000Z'
  })
}

const COLLECTION_CASES: Array<{
  family: HostDeltaFamily
  entityId: string
  payload: Record<string, unknown>
}> = [
  {
    family: 'workspace',
    entityId: 'ws-1',
    payload: {
      id: 'ws-1',
      name: 'AGBench',
      path: '/tmp/agbench',
      pinned: false,
      updatedAt: 1
    }
  },
  {
    family: 'thread',
    entityId: 'th-1',
    payload: {
      id: 'th-1',
      workspaceId: null,
      title: 'Host Arc',
      chatKind: 'ensemble',
      archived: false,
      pinned: false,
      updatedAt: 2,
      messageCount: 3
    }
  },
  {
    family: 'run',
    entityId: 'run-1',
    payload: {
      runId: 'run-1',
      threadId: 'th-1',
      providerId: 'cursor',
      providerOutcome: 'completed'
    }
  },
  {
    family: 'mission',
    entityId: 'm-1',
    payload: {
      missionId: 'm-1',
      title: 'Host Arc',
      status: 'active',
      updatedAt: 3
    }
  },
  {
    family: 'round',
    entityId: 'r-1',
    payload: {
      roundId: 'r-1',
      threadId: 'th-1',
      status: 'running',
      participantIds: ['p1'],
      providerRunIds: ['run-1']
    }
  },
  {
    family: 'participant',
    entityId: 'pt1:4:th-1:2:p1',
    payload: {
      id: 'p1',
      threadId: 'th-1',
      providerId: 'cursor',
      role: 'CursorWork3',
      order: 1,
      enabled: true,
      active: true
    }
  },
  {
    family: 'provider',
    entityId: 'p0:6:cursor',
    payload: {
      providerId: 'cursor',
      displayProvider: 'Cursor',
      shortCode: 'cur',
      available: true
    }
  },
  {
    family: 'question',
    entityId: 'q-1',
    payload: {
      questionId: 'q-1',
      threadId: 'th-1',
      status: 'open',
      promptPreview: 'Ship?',
      askedAt: 4
    }
  },
  {
    family: 'approval',
    entityId: 'a-1',
    payload: {
      approvalId: 'a-1',
      commandId: 'cmd-a-1',
      status: 'pending',
      actionKind: 'shell',
      createdAt: 5,
      summary: 'npm test'
    }
  },
  {
    family: 'schedule',
    entityId: 's-1',
    payload: {
      scheduleId: 's-1',
      title: 'daily',
      enabled: true
    }
  },
  {
    family: 'artifact',
    entityId: 'art-1',
    payload: {
      artifactId: 'art-1',
      kind: 'diff',
      title: 'patch',
      createdAt: 6,
      sha256: 'a'.repeat(64),
      byteLength: 12
    }
  },
  {
    family: 'warning',
    entityId: 'w-1',
    payload: {
      warningId: 'w-1',
      severity: 'warning',
      code: 'host.cache',
      message: 'stale',
      at: 7
    }
  }
]

describe('applyHostSnapshotDeltas', () => {
  it('rejects an invalid base snapshot without mutating the caller object', () => {
    const bad = baseCache() as HostSnapshot & { usage: { availability: 'unavailable'; tokens: 0 } }
    bad.usage = { availability: 'unavailable', tokens: 0 }
    const frozen = JSON.stringify(bad)
    const result = applyHostSnapshotDeltas(bad, [])
    expect(result).toMatchObject({
      outcome: 'rejected',
      reason: expect.stringContaining('invalid base snapshot')
    })
    expect(JSON.stringify(bad)).toBe(frozen)
  })

  it('returns unchanged for an empty batch and preserves the original reference', () => {
    const cache = baseCache(4)
    const result = applyHostSnapshotDeltas(cache, [])
    expect(result.outcome).toBe('unchanged')
    if (result.outcome === 'unchanged') {
      expect(result.snapshot).toBe(cache)
      expect(result.generation).toBe(1)
      expect(result.cursor).toBe(4)
    }
  })

  it('applies collection upsert/remove/tombstone by stable ids for every family', () => {
    let cache = baseCache(0)
    let cursor = 0

    for (const entry of COLLECTION_CASES) {
      const upsert = envelope({
        cursor: cursor + 1,
        previousCursor: cursor,
        kind: 'upsert',
        family: entry.family,
        entityId: entry.entityId,
        payload: { ...entry.payload, apiKey: 'SECRET-SHOULD-STRIP' }
      })
      const applied = applyHostSnapshotDeltas(cache, [upsert])
      expect(applied.outcome).toBe('applied')
      if (applied.outcome !== 'applied') return
      expect(applied.snapshot).not.toBe(cache)
      expect(applied.snapshot.freshness).toBe('cached')
      expect(applied.snapshot.health.freshness).toBe('cached')
      expect(applied.cursor).toBe(cursor + 1)
      // Privacy-shaped extras must not survive decode rebuild.
      const serialized = JSON.stringify(applied.snapshot)
      expect(serialized).not.toContain('SECRET-SHOULD-STRIP')
      expect(serialized).not.toContain('apiKey')
      cache = applied.snapshot
      cursor = applied.cursor
    }

    // Tombstone first collection entity, remove the second.
    const tombstone = envelope({
      cursor: cursor + 1,
      previousCursor: cursor,
      kind: 'tombstone',
      family: 'workspace',
      entityId: 'ws-1',
      tombstone: true
    })
    const afterTombstone = applyHostSnapshotDeltas(cache, [tombstone])
    expect(afterTombstone.outcome).toBe('applied')
    if (afterTombstone.outcome !== 'applied') return
    expect(afterTombstone.snapshot.workspaces).toEqual([])
    cache = afterTombstone.snapshot
    cursor = afterTombstone.cursor

    const remove = envelope({
      cursor: cursor + 1,
      previousCursor: cursor,
      kind: 'remove',
      family: 'thread',
      entityId: 'th-1'
    })
    // Incomplete upsert must reject atomically — original cache unchanged.
    const rejectedKind = applyHostSnapshotDeltas(cache, [
      envelope({
        cursor: cursor + 1,
        previousCursor: cursor,
        kind: 'upsert',
        family: 'thread',
        entityId: 'th-1',
        payload: { id: 'th-1' } // incomplete
      })
    ])
    expect(rejectedKind.outcome).toBe('rejected')
    expect(cache.threads.some((t) => t.id === 'th-1')).toBe(true)

    const removed = applyHostSnapshotDeltas(cache, [remove])
    expect(removed.outcome).toBe('applied')
    if (removed.outcome === 'applied') {
      expect(removed.snapshot.threads.some((t) => t.id === 'th-1')).toBe(false)
    }
  })

  it('treats duplicates and late events as idempotent skips', () => {
    const cache = baseCache(5)
    const original = JSON.stringify(cache)
    const result = applyHostSnapshotDeltas(cache, [
      envelope({
        cursor: 5,
        previousCursor: 4,
        kind: 'upsert',
        family: 'warning',
        entityId: 'w-dup',
        payload: {
          warningId: 'w-dup',
          severity: 'info',
          code: 'x',
          message: 'dup',
          at: 1
        }
      }),
      envelope({
        cursor: 3,
        previousCursor: 2,
        kind: 'upsert',
        family: 'warning',
        entityId: 'w-late',
        payload: {
          warningId: 'w-late',
          severity: 'info',
          code: 'x',
          message: 'late',
          at: 1
        }
      })
    ])
    expect(result).toMatchObject({
      outcome: 'unchanged',
      skippedDuplicates: 1,
      skippedLate: 1
    })
    if (result.outcome === 'unchanged') {
      expect(result.snapshot).toBe(cache)
    }
    expect(JSON.stringify(cache)).toBe(original)
  })

  it('applies same roster id independently in different threads', () => {
    const cache = baseCache(0)
    const firstId = 'pt1:8:thread-a:11:shared-seat'
    const secondId = 'pt1:8:thread-b:11:shared-seat'
    const result = applyHostSnapshotDeltas(cache, [
      envelope({
        cursor: 1,
        previousCursor: 0,
        kind: 'upsert',
        family: 'participant',
        entityId: firstId,
        payload: {
          id: 'shared-seat',
          threadId: 'thread-a',
          providerId: 'codex',
          role: 'Worker A',
          order: 1,
          enabled: true,
          active: false
        }
      }),
      envelope({
        cursor: 2,
        previousCursor: 1,
        kind: 'upsert',
        family: 'participant',
        entityId: secondId,
        payload: {
          id: 'shared-seat',
          threadId: 'thread-b',
          providerId: 'codex',
          role: 'Worker B',
          order: 1,
          enabled: true,
          active: true
        }
      }),
      envelope({
        cursor: 3,
        previousCursor: 2,
        kind: 'tombstone',
        family: 'participant',
        entityId: firstId,
        tombstone: true
      })
    ])

    expect(result.outcome).toBe('applied')
    if (result.outcome !== 'applied') return
    expect(result.snapshot.participants).toEqual([
      expect.objectContaining({ threadId: 'thread-b', id: 'shared-seat', active: true })
    ])
  })

  it('applies provider-wide and model rows without key collisions', () => {
    const cache = baseCache(0)
    const result = applyHostSnapshotDeltas(cache, [
      envelope({
        cursor: 1,
        previousCursor: 0,
        kind: 'upsert',
        family: 'provider',
        entityId: 'p0:6:cursor',
        payload: {
          providerId: 'cursor',
          displayProvider: 'Cursor',
          shortCode: 'cur',
          available: true
        }
      }),
      envelope({
        cursor: 2,
        previousCursor: 1,
        kind: 'upsert',
        family: 'provider',
        entityId: 'p1:6:cursor:8:grok-4.5',
        payload: {
          providerId: 'cursor',
          modelId: 'grok-4.5',
          displayProvider: 'Cursor',
          displayModel: 'Grok 4.5',
          shortCode: 'cur',
          available: true
        }
      })
    ])

    expect(result.outcome).toBe('applied')
    if (result.outcome === 'applied') {
      expect(result.snapshot.providers).toHaveLength(2)
      expect(result.snapshot.providers.map((provider) => provider.modelId ?? null)).toEqual([
        null,
        'grok-4.5'
      ])
    }
  })

  it('requires full resnapshot on generation mismatch, reset, gap, and projection mismatch', () => {
    const cache = baseCache(2)
    const frozen = JSON.stringify(cache)

    expect(
      applyHostSnapshotDeltas(cache, [
        envelope({
          generation: 9,
          cursor: 1,
          previousCursor: 0,
          kind: 'upsert',
          family: 'warning',
          entityId: 'w',
          payload: {
            warningId: 'w',
            severity: 'info',
            code: 'x',
            message: 'g',
            at: 1
          }
        })
      ])
    ).toMatchObject({ outcome: 'require_resnapshot', reason: 'generation_mismatch' })

    expect(
      applyHostSnapshotDeltas(cache, [
        envelope({
          generation: 2,
          cursor: 1,
          previousCursor: 0,
          kind: 'generation-reset',
          family: 'snapshot-meta'
        })
      ])
    ).toMatchObject({ outcome: 'require_resnapshot', reason: 'generation_reset' })

    expect(
      applyHostSnapshotDeltas(cache, [
        envelope({
          cursor: 4,
          previousCursor: 2,
          kind: 'upsert',
          family: 'warning',
          entityId: 'w',
          payload: {
            warningId: 'w',
            severity: 'info',
            code: 'x',
            message: 'gap',
            at: 1
          }
        })
      ])
    ).toMatchObject({ outcome: 'require_resnapshot', reason: 'previous_cursor_mismatch' })

    expect(
      applyHostSnapshotDeltas(cache, [
        {
          ...envelope({
            cursor: 3,
            previousCursor: 2,
            kind: 'upsert',
            family: 'warning',
            entityId: 'w',
            payload: {
              warningId: 'w',
              severity: 'info',
              code: 'x',
              message: 'pv',
              at: 1
            }
          }),
          projectionVersion: 99 as never
        }
      ])
    ).toMatchObject({
      outcome: 'rejected',
      reason: expect.stringContaining('projection')
    })

    expect(JSON.stringify(cache)).toBe(frozen)
  })

  it('replaces singletons with valid payloads and forces resnapshot on singleton remove', () => {
    const cache = baseCache(0)

    const health = applyHostSnapshotDeltas(cache, [
      envelope({
        cursor: 1,
        previousCursor: 0,
        kind: 'upsert',
        family: 'health',
        payload: {
          hostStatus: 'degraded',
          connectionPhase: 'reconnecting',
          supervised: true,
          freshness: 'cached',
          detail: 'peer offline'
        }
      })
    ])
    expect(health.outcome).toBe('applied')
    if (health.outcome !== 'applied') return
    expect(health.snapshot.health.hostStatus).toBe('degraded')
    expect(health.snapshot.freshness).toBe('cached')

    const usage = applyHostSnapshotDeltas(health.snapshot, [
      envelope({
        cursor: 2,
        previousCursor: 1,
        kind: 'upsert',
        family: 'usage',
        payload: { availability: 'unavailable', confidence: 'unknown', band: 'unknown' }
      })
    ])
    expect(usage.outcome).toBe('applied')
    if (usage.outcome !== 'applied') return
    expect(usage.snapshot.usage.availability).toBe('unavailable')
    expect(usage.snapshot.usage).not.toHaveProperty('tokens')

    const recovery = applyHostSnapshotDeltas(usage.snapshot, [
      envelope({
        cursor: 3,
        previousCursor: 2,
        kind: 'upsert',
        family: 'recovery',
        payload: { reopenStatus: 'recovered', lastGeneration: 1, lastCursor: 3 }
      })
    ])
    expect(recovery.outcome).toBe('applied')
    if (recovery.outcome !== 'applied') return

    const routing = applyHostSnapshotDeltas(recovery.snapshot, [
      envelope({
        cursor: 4,
        previousCursor: 3,
        kind: 'upsert',
        family: 'routing',
        payload: { mode: 'continuous', fanout: 'locked_writers', activeParticipantId: 'p7' }
      })
    ])
    expect(routing.outcome).toBe('applied')
    if (routing.outcome !== 'applied') return
    expect(routing.snapshot.routing?.mode).toBe('continuous')

    const meta = applyHostSnapshotDeltas(routing.snapshot, [
      envelope({
        cursor: 5,
        previousCursor: 4,
        kind: 'upsert',
        family: 'snapshot-meta',
        payload: { generatedAt: '2026-08-04T01:00:00.000Z', freshness: 'stale' }
      })
    ])
    expect(meta.outcome).toBe('applied')
    if (meta.outcome !== 'applied') return
    expect(meta.snapshot.generatedAt).toBe('2026-08-04T01:00:00.000Z')
    expect(meta.snapshot.freshness).toBe('stale')
    expect(meta.snapshot.health.freshness).toBe('cached')

    const frozen = JSON.stringify(meta.snapshot)
    expect(
      applyHostSnapshotDeltas(meta.snapshot, [
        envelope({
          cursor: 6,
          previousCursor: 5,
          kind: 'remove',
          family: 'health'
        })
      ])
    ).toMatchObject({
      outcome: 'require_resnapshot',
      reason: 'unsupported_singleton_removal'
    })
    expect(JSON.stringify(meta.snapshot)).toBe(frozen)

    expect(
      applyHostSnapshotDeltas(meta.snapshot, [
        envelope({
          cursor: 6,
          previousCursor: 5,
          kind: 'upsert',
          family: 'usage',
          payload: { availability: 'unavailable', tokens: 0 }
        })
      ])
    ).toMatchObject({ outcome: 'rejected' })
    expect(JSON.stringify(meta.snapshot)).toBe(frozen)

    expect(
      applyHostSnapshotDeltas(meta.snapshot, [
        envelope({
          cursor: 6,
          previousCursor: 5,
          kind: 'upsert',
          family: 'snapshot-meta',
          payload: { freshness: 'live' }
        })
      ])
    ).toMatchObject({
      outcome: 'rejected',
      reason: 'snapshot-meta cannot promote cache to live'
    })
  })

  it('rolls back the whole batch when a later delta is invalid', () => {
    const cache = baseCache(0)
    const frozen = JSON.stringify(cache)
    const result = applyHostSnapshotDeltas(cache, [
      envelope({
        cursor: 1,
        previousCursor: 0,
        kind: 'upsert',
        family: 'warning',
        entityId: 'w-ok',
        payload: {
          warningId: 'w-ok',
          severity: 'info',
          code: 'ok',
          message: 'first',
          at: 1
        }
      }),
      envelope({
        cursor: 2,
        previousCursor: 1,
        kind: 'upsert',
        family: 'thread',
        entityId: 'bad',
        payload: { id: 'bad', title: 'missing-required-fields' }
      })
    ])
    expect(result.outcome).toBe('rejected')
    expect(JSON.stringify(cache)).toBe(frozen)
    expect(cache.warnings).toEqual([])
    expect(cache.cursor).toBe(0)
  })

  it('does not infer client authority from cache contents', () => {
    const cache = baseCache(0)
    cache.routing = {
      mode: 'continuous',
      fanout: 'read_only',
      bossParticipantId: 'boss',
      captainParticipantId: 'captain'
    }
    const result = applyHostSnapshotDeltas(cache, [
      envelope({
        cursor: 1,
        previousCursor: 0,
        kind: 'upsert',
        family: 'participant',
        entityId: 'pt1:8:thread-1:6:worker',
        payload: {
          id: 'worker',
          threadId: 'thread-1',
          providerId: 'cursor',
          role: 'CursorWork3',
          order: 3,
          enabled: true,
          active: true
        }
      })
    ])
    expect(result.outcome).toBe('applied')
    if (result.outcome !== 'applied') return
    // Applicator never invents/clears authority seats from participant upserts.
    expect(result.snapshot.routing?.bossParticipantId).toBe('boss')
    expect(result.snapshot.routing?.captainParticipantId).toBe('captain')
    expect(result.snapshot.participants).toHaveLength(1)
  })

  it('keeps provider/run/round/mission outcome taxonomies distinct after apply', () => {
    const cache = baseCache(0)
    const result = applyHostSnapshotDeltas(cache, [
      envelope({
        cursor: 1,
        previousCursor: 0,
        kind: 'upsert',
        family: 'run',
        entityId: 'run-ok',
        payload: {
          runId: 'run-ok',
          threadId: 't',
          providerId: 'codex',
          providerOutcome: 'completed'
        }
      }),
      envelope({
        cursor: 2,
        previousCursor: 1,
        kind: 'upsert',
        family: 'round',
        entityId: 'round-cancelled',
        payload: {
          roundId: 'round-cancelled',
          threadId: 't',
          status: 'cancelled',
          participantIds: [],
          providerRunIds: ['run-ok']
        }
      }),
      envelope({
        cursor: 3,
        previousCursor: 2,
        kind: 'upsert',
        family: 'mission',
        entityId: 'mission-active',
        payload: {
          missionId: 'mission-active',
          title: 'still going',
          status: 'active',
          updatedAt: 9
        }
      })
    ])
    expect(result.outcome).toBe('applied')
    if (result.outcome !== 'applied') return
    expect(result.snapshot.runs[0]?.providerOutcome).toBe('completed')
    expect(result.snapshot.rounds[0]?.status).toBe('cancelled')
    expect(result.snapshot.missions[0]?.status).toBe('active')
  })
})
