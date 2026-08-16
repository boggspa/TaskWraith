import { describe, expect, it } from 'vitest'
import {
  appendMissionFactRecord,
  replayMissionFacts,
  type MissionFactInput,
  type MissionFactRecord,
  type MissionProjection
} from './MissionFactLedger'
import {
  deriveLegacyMissionFactBatch,
  missionWorkItemStatusFromLegacyBoardColumn,
  type LegacyMissionSurfaceSnapshot
} from './LegacyMissionFactReconciler'

function snapshot(
  overrides: Partial<LegacyMissionSurfaceSnapshot> = {}
): LegacyMissionSurfaceSnapshot {
  return {
    goal: {
      missionId: 'goal-1',
      objective: 'Ship the mission ledger',
      status: 'active',
      observedAt: '2026-08-16T00:00:00.000Z',
      statusProvenance: { actor: 'system', chatId: 'chat-1', workspaceId: 'workspace-1' },
      provenance: { actor: 'user', chatId: 'chat-1', workspaceId: 'workspace-1' }
    },
    plan: {
      state: 'present',
      plan: {
        planId: 'message-plan-1',
        title: 'Ledger build order',
        body: '1. Kernel\n2. Shadow writes\n3. Cutover',
        status: 'pending'
      },
      observedAt: '2026-08-16T00:00:01.000Z',
      provenance: {
        actor: 'agent',
        chatId: 'chat-1',
        runId: 'run-plan',
        participantId: 'boss'
      }
    },
    boards: [
      {
        boardId: 'board-1',
        observedAt: '2026-08-16T00:00:02.000Z',
        provenance: { actor: 'user', workspaceId: 'workspace-1' },
        items: [
          {
            item: {
              workItemId: 'card-b',
              title: 'Cut over reads',
              status: 'pending',
              sortOrder: 2
            }
          },
          {
            item: {
              workItemId: 'card-a',
              title: 'Build kernel',
              status: 'running',
              sortOrder: 1
            },
            observedAt: '2026-08-16T00:00:03.000Z',
            provenance: { actor: 'agent', workspaceId: 'workspace-1', runId: 'run-card-a' }
          }
        ]
      }
    ],
    ...overrides
  }
}

function appendBatch(
  records: readonly MissionFactRecord[],
  batch: readonly MissionFactInput[]
): MissionFactRecord[] {
  let next = [...records]
  for (const input of batch) {
    const record = appendMissionFactRecord(next, {
      ...input,
      factId: `fact-${next.length + 1}`
    })
    next = [...next, record]
  }
  return next
}

function project(input: LegacyMissionSurfaceSnapshot): {
  records: MissionFactRecord[]
  projection: MissionProjection
} {
  const records = appendBatch([], deriveLegacyMissionFactBatch(null, input))
  const projection = replayMissionFacts(input.goal.missionId, records).projection
  if (!projection) throw new Error('fixture did not produce a mission projection')
  return { records, projection }
}

describe('deriveLegacyMissionFactBatch', () => {
  it('bootstraps one ordered semantic batch from Goal, Plan, and Board snapshots', () => {
    const batch = deriveLegacyMissionFactBatch(null, snapshot())

    expect(batch.map((item) => item.payload.kind)).toEqual([
      'mission_defined',
      'mission_status_set',
      'plan_set',
      'work_item_upserted',
      'work_item_upserted'
    ])
    expect(batch[0]).toMatchObject({
      missionId: 'goal-1',
      provenance: { surface: 'goal', actor: 'user', sourceId: 'goal-1' }
    })
    expect(batch[1].provenance).toMatchObject({ surface: 'goal', actor: 'system' })
    expect(batch[2]).toMatchObject({
      provenance: {
        surface: 'plan',
        actor: 'agent',
        sourceId: 'message-plan-1',
        runId: 'run-plan',
        participantId: 'boss'
      }
    })
    expect(batch.slice(3).map((item) => item.provenance.sourceId)).toEqual(['card-a', 'card-b'])
    expect(batch[3].provenance).toMatchObject({ actor: 'agent', runId: 'run-card-a' })
  })

  it('emits no facts when all observed legacy surfaces match the fold', () => {
    const source = snapshot()
    const { projection } = project(source)

    expect(deriveLegacyMissionFactBatch(projection, source)).toEqual([])
  })

  it('emits only changed fields, plan state, card upserts, and scoped removals', () => {
    const source = snapshot()
    const { projection } = project(source)
    const changed = snapshot({
      goal: {
        ...source.goal,
        status: 'blocked',
        reason: 'Waiting for the background resolver.',
        observedAt: '2026-08-16T00:01:00.000Z'
      },
      plan: {
        state: 'present',
        plan: {
          ...(source.plan?.state === 'present' ? source.plan.plan : null),
          planId: 'message-plan-1',
          title: 'Ledger build order',
          body: '1. Kernel\n2. Shadow writes\n3. Cutover',
          status: 'approved',
          artifactPath: 'docs/plans/ledger.md'
        },
        observedAt: '2026-08-16T00:01:01.000Z',
        provenance: { actor: 'user', chatId: 'chat-1' }
      },
      boards: [
        {
          boardId: 'board-1',
          observedAt: '2026-08-16T00:01:02.000Z',
          provenance: { actor: 'agent', workspaceId: 'workspace-1', runId: 'run-board' },
          items: [
            {
              item: { workItemId: 'card-a', title: 'Build kernel', status: 'done', sortOrder: 1 }
            },
            {
              item: {
                workItemId: 'card-c',
                title: 'Wire shadow writes',
                status: 'running',
                sortOrder: 2
              }
            }
          ]
        }
      ]
    })

    const batch = deriveLegacyMissionFactBatch(projection, changed)

    expect(batch.map((item) => item.payload.kind)).toEqual([
      'mission_status_set',
      'plan_set',
      'work_item_upserted',
      'work_item_upserted',
      'work_item_removed'
    ])
    expect(batch[0].payload).toEqual({
      kind: 'mission_status_set',
      status: 'blocked',
      reason: 'Waiting for the background resolver.'
    })
    expect(batch.slice(2).map((item) => item.provenance.sourceId)).toEqual([
      'card-a',
      'card-c',
      'card-b'
    ])
    expect(batch[2].provenance).toMatchObject({
      surface: 'board',
      actor: 'agent',
      runId: 'run-board'
    })
  })

  it('distinguishes unobserved surfaces from explicit absence', () => {
    const source = snapshot()
    const { projection } = project(source)
    const goalOnly = snapshot({ goal: source.goal, plan: undefined, boards: undefined })

    expect(deriveLegacyMissionFactBatch(projection, goalOnly)).toEqual([])

    const explicitAbsence = deriveLegacyMissionFactBatch(projection, {
      ...goalOnly,
      plan: {
        state: 'absent',
        observedAt: '2026-08-16T00:02:00.000Z',
        provenance: { actor: 'user', chatId: 'chat-1' }
      },
      boards: [
        {
          boardId: 'board-1',
          observedAt: '2026-08-16T00:02:00.000Z',
          provenance: { actor: 'user', workspaceId: 'workspace-1' },
          items: []
        }
      ]
    })
    expect(explicitAbsence.map((item) => item.payload.kind)).toEqual([
      'plan_cleared',
      'work_item_removed',
      'work_item_removed'
    ])
  })

  it('rejects a snapshot aimed at a different folded mission', () => {
    const source = snapshot()
    const { projection } = project(source)

    expect(() =>
      deriveLegacyMissionFactBatch(projection, {
        ...source,
        goal: { ...source.goal, missionId: 'goal-other' }
      })
    ).toThrow('cannot reconcile projection')
  })
})

describe('missionWorkItemStatusFromLegacyBoardColumn', () => {
  it.each([
    ['inbox', 'pending'],
    ['ready', 'pending'],
    ['running', 'running'],
    ['needs-input', 'needs-input'],
    ['blocked', 'blocked'],
    ['review-ready', 'review-ready'],
    ['done', 'done'],
    ['archived', 'archived'],
    ['future-column', 'pending']
  ] as const)('maps %s to %s', (column, expected) => {
    expect(missionWorkItemStatusFromLegacyBoardColumn(column)).toBe(expected)
  })
})
