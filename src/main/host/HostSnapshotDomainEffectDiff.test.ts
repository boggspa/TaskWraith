import { describe, expect, it } from 'vitest'

import {
  HOST_PROTOCOL_MAX_ID,
  HOST_PROTOCOL_VERSION,
  HOST_PROJECTION_VERSION,
  createEmptyHostSnapshot,
  type HostSnapshot
} from '../../shared/hostProtocol'
import { diffHostSnapshotDomainEffects } from './HostSnapshotDomainEffectDiff'

const GENERATED_AT = '2026-08-04T03:00:00.000Z'

function baseSnapshot(overrides: Partial<HostSnapshot> = {}): HostSnapshot {
  return {
    ...createEmptyHostSnapshot({
      generation: 1,
      cursor: 7,
      freshness: 'live',
      generatedAt: GENERATED_AT
    }),
    ...overrides
  }
}

function cloneSnapshot(snapshot: HostSnapshot): HostSnapshot {
  return JSON.parse(JSON.stringify(snapshot)) as HostSnapshot
}

describe('diffHostSnapshotDomainEffects', () => {
  it('returns empty effects when snapshots are unchanged (excluding metadata)', () => {
    const before = baseSnapshot({
      generatedAt: '2026-08-04T01:00:00.000Z',
      freshness: 'live',
      threads: [
        {
          id: 'th-1',
          workspaceId: null,
          title: 'Host Arc',
          chatKind: 'ensemble',
          archived: false,
          pinned: false,
          updatedAt: 1,
          messageCount: 0
        }
      ]
    })
    const after = cloneSnapshot(before)
    after.generatedAt = '2026-08-04T02:00:00.000Z'
    after.freshness = 'cached'

    const result = diffHostSnapshotDomainEffects(before, after)
    expect(result).toEqual({ kind: 'effects', effects: [] })
  })

  it('does not mutate caller inputs', () => {
    const before = baseSnapshot({
      threads: [
        {
          id: 'th-1',
          workspaceId: null,
          title: 'A',
          chatKind: 'single',
          archived: false,
          pinned: false,
          updatedAt: 1,
          messageCount: 0
        }
      ]
    })
    const after = cloneSnapshot(before)
    after.threads[0]!.title = 'B'
    const frozenBefore = JSON.stringify(before)
    const frozenAfter = JSON.stringify(after)

    const result = diffHostSnapshotDomainEffects(before, after)
    expect(result.kind).toBe('effects')
    expect(JSON.stringify(before)).toBe(frozenBefore)
    expect(JSON.stringify(after)).toBe(frozenAfter)
  })

  it('rejects decode failures without leaking a body', () => {
    const result = diffHostSnapshotDomainEffects({ not: 'a snapshot' }, baseSnapshot())
    expect(result.kind).toBe('invalid')
    if (result.kind !== 'invalid') return
    expect(result.reason).toBe('decode_failed')
    expect(JSON.stringify(result)).not.toMatch(/password|secret|Bearer/i)
  })

  it('rejects privacy sentinels without leaking a body', () => {
    const dirty = baseSnapshot({
      warnings: [
        {
          warningId: 'w-secret',
          severity: 'warning',
          code: 'x',
          message: 'export TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789',
          at: 1
        }
      ]
    })
    const result = diffHostSnapshotDomainEffects(dirty, dirty)
    expect(result.kind).toBe('invalid')
    if (result.kind !== 'invalid') return
    expect(result.reason).toBe('privacy_failed')
    expect(JSON.stringify(result)).not.toMatch(/ghp_/)
  })

  it('requires matching protocol/projection/generation/cursor (coherence fences)', () => {
    const before = baseSnapshot()
    const protocol = cloneSnapshot(before)
    ;(protocol as { protocolVersion: number }).protocolVersion = 99
    expect(diffHostSnapshotDomainEffects(before, protocol)).toMatchObject({
      kind: 'invalid',
      reason: 'decode_failed'
    })

    const afterGen = cloneSnapshot(before)
    afterGen.generation = 2
    expect(diffHostSnapshotDomainEffects(before, afterGen)).toEqual({
      kind: 'incoherent',
      reason: 'generation_mismatch',
      detail: 'generation 1 !== 2'
    })

    const afterCursor = cloneSnapshot(before)
    afterCursor.cursor = 99
    expect(diffHostSnapshotDomainEffects(before, afterCursor)).toEqual({
      kind: 'incoherent',
      reason: 'cursor_mismatch',
      detail: 'cursor 7 !== 99'
    })

    const afterProj = cloneSnapshot(before)
    ;(afterProj as { projectionVersion: number }).projectionVersion = 99
    expect(diffHostSnapshotDomainEffects(before, afterProj)).toMatchObject({
      kind: 'invalid',
      reason: 'decode_failed'
    })
  })

  it('emits upsert/change/tombstone for every collection family in deterministic order', () => {
    const before = baseSnapshot({
      workspaces: [
        {
          id: 'ws-keep',
          name: 'Keep',
          path: '/tmp/keep',
          pinned: false,
          updatedAt: 1
        },
        {
          id: 'ws-gone',
          name: 'Gone',
          path: '/tmp/gone',
          pinned: false,
          updatedAt: 1
        }
      ],
      threads: [
        {
          id: 'th-1',
          workspaceId: null,
          title: 'old',
          chatKind: 'ensemble',
          archived: false,
          pinned: false,
          updatedAt: 1,
          messageCount: 0
        }
      ],
      runs: [
        {
          runId: 'run-1',
          threadId: 'th-1',
          providerId: 'cursor',
          providerOutcome: 'running'
        }
      ],
      missions: [
        {
          missionId: 'm-1',
          title: 'Host Arc',
          status: 'active',
          updatedAt: 1
        }
      ],
      rounds: [
        {
          roundId: 'r-1',
          threadId: 'th-1',
          status: 'running',
          participantIds: ['p1'],
          providerRunIds: ['run-1']
        }
      ],
      participants: [
        {
          id: 'p1',
          providerId: 'cursor',
          role: 'CursorWork',
          order: 1,
          enabled: true,
          active: true
        }
      ],
      providers: [
        {
          providerId: 'cursor',
          displayProvider: 'Cursor',
          shortCode: 'cur',
          available: true,
          modelId: 'grok-4.5'
        }
      ],
      questions: [
        {
          questionId: 'q-1',
          threadId: 'th-1',
          status: 'open',
          promptPreview: 'Ship?',
          askedAt: 1
        }
      ],
      approvals: [
        {
          approvalId: 'a-1',
          status: 'pending',
          actionKind: 'shell',
          createdAt: 1,
          summary: 'npm test'
        }
      ],
      schedules: [
        {
          scheduleId: 's-1',
          title: 'daily',
          enabled: true
        }
      ],
      artifacts: [
        {
          artifactId: 'art-1',
          kind: 'diff',
          title: 'patch',
          createdAt: 1,
          sha256: 'a'.repeat(64),
          byteLength: 12
        }
      ],
      warnings: [
        {
          warningId: 'w-1',
          severity: 'warning',
          code: 'host.cache',
          message: 'stale',
          at: 1
        }
      ]
    })

    const after = cloneSnapshot(before)
    after.workspaces = [
      {
        id: 'ws-keep',
        name: 'Keep',
        path: '/tmp/keep',
        pinned: false,
        updatedAt: 1
      },
      {
        id: 'ws-new',
        name: 'New',
        path: '/tmp/new',
        pinned: true,
        updatedAt: 2
      }
    ]
    after.threads[0]!.title = 'new-title'
    after.runs[0]!.providerOutcome = 'completed'
    after.missions[0]!.status = 'blocked'
    after.rounds[0]!.status = 'completed'
    after.participants[0]!.active = false
    after.providers[0]!.available = false
    after.questions[0]!.status = 'answered'
    after.approvals[0]!.status = 'approved'
    after.schedules[0]!.enabled = false
    after.artifacts[0]!.title = 'patch-v2'
    after.warnings = []

    const result = diffHostSnapshotDomainEffects(before, after)
    expect(result.kind).toBe('effects')
    if (result.kind !== 'effects') return

    expect(result.effects.map((e) => `${e.family}:${e.kind}:${e.entityId}`)).toEqual([
      'workspace:tombstone:ws-gone',
      'workspace:upsert:ws-new',
      'thread:upsert:th-1',
      'run:upsert:run-1',
      'mission:upsert:m-1',
      'round:upsert:r-1',
      'participant:upsert:p1',
      'provider:upsert:cursor:grok-4.5',
      'question:upsert:q-1',
      'approval:upsert:a-1',
      'schedule:upsert:s-1',
      'artifact:upsert:art-1',
      'warning:tombstone:w-1'
    ])

    const threadUpsert = result.effects.find((e) => e.family === 'thread')
    expect(threadUpsert?.kind).toBe('upsert')
    expect(threadUpsert?.payload).toMatchObject({ id: 'th-1', title: 'new-title' })
    // Payload is cloned, not aliased to the after snapshot entity.
    expect(threadUpsert?.payload).not.toBe(after.threads[0])
  })

  it('diffs singleton routing/usage/health/recovery and ignores metadata-only churn', () => {
    const before = baseSnapshot({
      routing: { mode: 'turn-bound', fanout: 'none' },
      usage: { availability: 'unavailable', confidence: 'unknown', band: 'unknown' },
      health: {
        hostStatus: 'ok',
        connectionPhase: 'live',
        supervised: true,
        freshness: 'live'
      },
      recovery: { reopenStatus: 'unknown' }
    })
    const after = cloneSnapshot(before)
    after.routing = { mode: 'continuous', fanout: 'locked_writers', activeParticipantId: 'p3' }
    after.usage = {
      availability: 'available',
      confidence: 'exact',
      band: 'medium',
      tokens: 12
    }
    after.health = {
      hostStatus: 'degraded',
      connectionPhase: 'reconnecting',
      supervised: true,
      freshness: 'cached',
      detail: 'peer lag'
    }
    after.recovery = { reopenStatus: 'recovered', lastGeneration: 1, lastCursor: 7 }
    after.generatedAt = '2026-08-04T09:00:00.000Z'
    after.freshness = 'stale'

    const result = diffHostSnapshotDomainEffects(before, after)
    expect(result.kind).toBe('effects')
    if (result.kind !== 'effects') return
    expect(result.effects.map((e) => `${e.family}:${e.kind}:${e.entityId}`)).toEqual([
      'routing:upsert:routing',
      'usage:upsert:usage',
      'recovery:upsert:recovery',
      'health:upsert:health'
    ])
  })

  it('tombstones optional routing when it disappears and upserts when it appears', () => {
    const withRouting = baseSnapshot({
      routing: { mode: 'continuous', fanout: 'read_only' }
    })
    const withoutRouting = baseSnapshot()

    const removed = diffHostSnapshotDomainEffects(withRouting, withoutRouting)
    expect(removed).toEqual({
      kind: 'effects',
      effects: [{ kind: 'tombstone', family: 'routing', entityId: 'routing' }]
    })

    const added = diffHostSnapshotDomainEffects(withoutRouting, withRouting)
    expect(added.kind).toBe('effects')
    if (added.kind !== 'effects') return
    expect(added.effects).toEqual([
      {
        kind: 'upsert',
        family: 'routing',
        entityId: 'routing',
        payload: { mode: 'continuous', fanout: 'read_only' }
      }
    ])
  })

  it('rejects duplicate collection entity ids', () => {
    const snap = baseSnapshot({
      threads: [
        {
          id: 'th-dup',
          workspaceId: null,
          title: 'A',
          chatKind: 'single',
          archived: false,
          pinned: false,
          updatedAt: 1,
          messageCount: 0
        },
        {
          id: 'th-dup',
          workspaceId: null,
          title: 'B',
          chatKind: 'single',
          archived: false,
          pinned: false,
          updatedAt: 2,
          messageCount: 1
        }
      ]
    })
    const result = diffHostSnapshotDomainEffects(snap, snap)
    expect(result).toMatchObject({
      kind: 'incoherent',
      reason: 'duplicate_entity_id'
    })
  })

  it('rejects unsafe and overlong entity ids without truncation', () => {
    const unsafe = baseSnapshot({
      threads: [
        {
          id: ' leading',
          workspaceId: null,
          title: 'A',
          chatKind: 'single',
          archived: false,
          pinned: false,
          updatedAt: 1,
          messageCount: 0
        }
      ]
    })
    // decodeHostSnapshot accepts non-empty ids; our index rejects whitespace-padded ids.
    expect(diffHostSnapshotDomainEffects(unsafe, unsafe)).toMatchObject({
      kind: 'incoherent',
      reason: 'unsafe_entity_id'
    })

    const overlongId = 'x'.repeat(HOST_PROTOCOL_MAX_ID + 1)
    const overlong = baseSnapshot({
      threads: [
        {
          id: overlongId,
          workspaceId: null,
          title: 'A',
          chatKind: 'single',
          archived: false,
          pinned: false,
          updatedAt: 1,
          messageCount: 0
        }
      ]
    })
    // Overlong ids fail closed at decode (still no truncation into a valid effect).
    const overlongResult = diffHostSnapshotDomainEffects(overlong, overlong)
    expect(overlongResult.kind).toBe('invalid')
    expect(JSON.stringify(overlongResult)).not.toContain(overlongId.slice(0, 32))
  })

  it('uses provider composites and rejects composite collisions / overlong composites', () => {
    const distinct = baseSnapshot({
      providers: [
        {
          providerId: 'cursor',
          displayProvider: 'Cursor',
          shortCode: 'cur',
          available: true,
          modelId: 'grok-4.5'
        },
        {
          providerId: 'cursor',
          displayProvider: 'Cursor',
          shortCode: 'cur',
          available: true,
          modelId: 'composer-2.5-fast'
        }
      ]
    })
    const distinctOk = diffHostSnapshotDomainEffects(distinct, distinct)
    expect(distinctOk).toEqual({ kind: 'effects', effects: [] })

    const collided = baseSnapshot({
      providers: [
        {
          providerId: 'cursor',
          displayProvider: 'Cursor',
          shortCode: 'cur',
          available: true,
          modelId: 'grok-4.5'
        },
        {
          providerId: 'cursor',
          displayProvider: 'Cursor',
          shortCode: 'cur',
          available: false,
          modelId: 'grok-4.5'
        }
      ]
    })
    expect(diffHostSnapshotDomainEffects(collided, collided)).toMatchObject({
      kind: 'incoherent',
      reason: 'provider_composite_collision'
    })

    const providerId = 'p'.repeat(300)
    const modelId = 'm'.repeat(300)
    expect(providerId.length + 1 + modelId.length).toBeGreaterThan(HOST_PROTOCOL_MAX_ID)
    const overlongComposite = baseSnapshot({
      providers: [
        {
          providerId,
          displayProvider: 'Big',
          shortCode: 'big',
          available: true,
          modelId
        }
      ]
    })
    // Individual ids fit decode bounds; composite does not.
    expect(providerId.length).toBeLessThanOrEqual(HOST_PROTOCOL_MAX_ID)
    expect(modelId.length).toBeLessThanOrEqual(HOST_PROTOCOL_MAX_ID)
    const overlongResult = diffHostSnapshotDomainEffects(overlongComposite, overlongComposite)
    expect(overlongResult).toMatchObject({
      kind: 'incoherent',
      reason: 'provider_composite_overlong'
    })
    expect(JSON.stringify(overlongResult)).not.toContain(providerId.slice(0, 40))
  })

  it('orders effects by family then entityId lexicographically', () => {
    const before = baseSnapshot({
      threads: [
        {
          id: 'th-b',
          workspaceId: null,
          title: 'B',
          chatKind: 'single',
          archived: false,
          pinned: false,
          updatedAt: 1,
          messageCount: 0
        },
        {
          id: 'th-a',
          workspaceId: null,
          title: 'A',
          chatKind: 'single',
          archived: false,
          pinned: false,
          updatedAt: 1,
          messageCount: 0
        }
      ],
      workspaces: [
        {
          id: 'ws-z',
          name: 'Z',
          path: '/z',
          pinned: false,
          updatedAt: 1
        }
      ]
    })
    const after = baseSnapshot()
    const result = diffHostSnapshotDomainEffects(before, after)
    expect(result.kind).toBe('effects')
    if (result.kind !== 'effects') return
    expect(result.effects.map((e) => `${e.family}:${e.entityId}`)).toEqual([
      'workspace:ws-z',
      'thread:th-a',
      'thread:th-b'
    ])
  })

  it('keeps protocol constants aligned with empty snapshot fixtures', () => {
    const snap = baseSnapshot()
    expect(snap.protocolVersion).toBe(HOST_PROTOCOL_VERSION)
    expect(snap.projectionVersion).toBe(HOST_PROJECTION_VERSION)
    expect(diffHostSnapshotDomainEffects(snap, snap)).toEqual({ kind: 'effects', effects: [] })
  })
})
