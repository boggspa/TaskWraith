import type {
  MissionFactInput,
  MissionFactProvenance,
  MissionPlanState,
  MissionProjection,
  MissionStatus,
  MissionWorkItemState,
  MissionWorkItemStatus
} from './MissionFactLedger'

type SurfaceProvenance = Omit<MissionFactProvenance, 'surface' | 'sourceId'> & {
  readonly sourceId?: string
}

export interface LegacyGoalMissionSnapshot {
  readonly missionId: string
  readonly objective: string
  readonly status: MissionStatus
  readonly reason?: string
  readonly observedAt: string
  /** Legacy ActiveGoal does not retain lifecycle actor provenance. Callers
   * should pass `system` here rather than inheriting objective authorship. */
  readonly statusProvenance?: SurfaceProvenance
  readonly provenance: SurfaceProvenance
}

export type LegacyPlanMissionObservation =
  | {
      readonly state: 'present'
      readonly plan: MissionPlanState
      readonly observedAt: string
      readonly provenance: SurfaceProvenance
    }
  | {
      /** Explicit absence. Omit the whole observation when the caller did not
       * hydrate or inspect the plan surface. */
      readonly state: 'absent'
      readonly observedAt: string
      readonly provenance: SurfaceProvenance
    }

export interface LegacyBoardMissionSnapshot {
  readonly boardId: string
  readonly observedAt: string
  readonly provenance: SurfaceProvenance
  readonly items: readonly LegacyBoardMissionItemSnapshot[]
}

export interface LegacyBoardMissionItemSnapshot {
  readonly item: Omit<MissionWorkItemState, 'sourceScopeId'>
  /** Card-level evidence wins over the board mutation fallback when present. */
  readonly observedAt?: string
  readonly provenance?: SurfaceProvenance
}

export interface LegacyMissionSurfaceSnapshot {
  readonly goal: LegacyGoalMissionSnapshot
  /** `undefined` means unobserved and must never clear a durable plan. */
  readonly plan?: LegacyPlanMissionObservation
  /** `undefined` means unobserved and must never remove durable work items. */
  readonly boards?: readonly LegacyBoardMissionSnapshot[]
}

function surfaceProvenance(
  surface: MissionFactProvenance['surface'],
  provenance: SurfaceProvenance,
  sourceId?: string
): MissionFactProvenance {
  return {
    ...provenance,
    surface,
    ...(sourceId || provenance.sourceId ? { sourceId: sourceId || provenance.sourceId } : {})
  }
}

function fact(
  missionId: string,
  timestamp: string,
  provenance: MissionFactProvenance,
  payload: MissionFactInput['payload']
): MissionFactInput {
  return { missionId, timestamp, provenance, payload }
}

function plansEqual(left: MissionPlanState | undefined, right: MissionPlanState): boolean {
  return Boolean(
    left &&
    left.planId === right.planId &&
    left.title === right.title &&
    left.body === right.body &&
    left.status === right.status &&
    left.artifactPath === right.artifactPath
  )
}

function workItemsEqual(left: MissionWorkItemState, right: MissionWorkItemState): boolean {
  return (
    left.workItemId === right.workItemId &&
    left.title === right.title &&
    left.status === right.status &&
    left.body === right.body &&
    left.blockedReason === right.blockedReason &&
    left.nextStep === right.nextStep &&
    left.sortOrder === right.sortOrder &&
    left.sourceScopeId === right.sourceScopeId
  )
}

/**
 * Convert the three legacy mission surfaces into semantic fact deltas.
 *
 * This is the additive shadow boundary: callers continue writing their current
 * stores, then append this returned batch. No legacy read path changes yet.
 * A later cutover can render every surface from the folded projection without
 * changing the fact schema or replay rules.
 */
export function deriveLegacyMissionFactBatch(
  projection: MissionProjection | null | undefined,
  snapshot: LegacyMissionSurfaceSnapshot
): MissionFactInput[] {
  const missionId = snapshot.goal.missionId.trim()
  if (!missionId) throw new Error('Legacy mission snapshot requires a mission id.')
  if (projection && projection.missionId !== missionId) {
    throw new Error(
      `Legacy mission snapshot "${missionId}" cannot reconcile projection "${projection.missionId}".`
    )
  }

  const facts: MissionFactInput[] = []
  const goalProvenance = surfaceProvenance('goal', snapshot.goal.provenance, missionId)
  const goalStatusProvenance = surfaceProvenance(
    'goal',
    snapshot.goal.statusProvenance || snapshot.goal.provenance,
    missionId
  )
  const goalReason = snapshot.goal.reason?.trim() || undefined
  if (!projection) {
    facts.push(
      fact(missionId, snapshot.goal.observedAt, goalProvenance, {
        kind: 'mission_defined',
        objective: snapshot.goal.objective
      })
    )
  } else if (projection.objective !== snapshot.goal.objective.trim()) {
    facts.push(
      fact(missionId, snapshot.goal.observedAt, goalProvenance, {
        kind: 'mission_objective_set',
        objective: snapshot.goal.objective
      })
    )
  }
  if (
    !projection ||
    projection.status !== snapshot.goal.status ||
    projection.statusReason !== goalReason
  ) {
    facts.push(
      fact(missionId, snapshot.goal.observedAt, goalStatusProvenance, {
        kind: 'mission_status_set',
        status: snapshot.goal.status,
        ...(goalReason ? { reason: goalReason } : {})
      })
    )
  }

  if (snapshot.plan?.state === 'present') {
    if (!plansEqual(projection?.plan, snapshot.plan.plan)) {
      facts.push(
        fact(
          missionId,
          snapshot.plan.observedAt,
          surfaceProvenance('plan', snapshot.plan.provenance, snapshot.plan.plan.planId),
          { kind: 'plan_set', plan: snapshot.plan.plan }
        )
      )
    }
  } else if (snapshot.plan?.state === 'absent' && projection?.plan) {
    facts.push(
      fact(
        missionId,
        snapshot.plan.observedAt,
        surfaceProvenance('plan', snapshot.plan.provenance, projection.plan.planId),
        { kind: 'plan_cleared', planId: projection.plan.planId }
      )
    )
  }

  facts.push(...deriveLegacyBoardMissionFactBatch(projection, missionId, snapshot.boards || []))

  return facts
}

/** Board-only delta adapter for low-frequency board mutations after the goal
 * writer has already established the mission ledger. */
export function deriveLegacyBoardMissionFactBatch(
  projection: MissionProjection | null | undefined,
  missionId: string,
  boards: readonly LegacyBoardMissionSnapshot[]
): MissionFactInput[] {
  const normalizedMissionId = missionId.trim()
  if (!normalizedMissionId) throw new Error('Legacy board snapshot requires a mission id.')
  if (projection && projection.missionId !== normalizedMissionId) {
    throw new Error(
      `Legacy board snapshot "${normalizedMissionId}" cannot reconcile projection "${projection.missionId}".`
    )
  }
  const facts: MissionFactInput[] = []
  for (const board of [...boards].sort((a, b) => a.boardId.localeCompare(b.boardId))) {
    const currentItems = new Map(
      (projection?.workItems || [])
        .filter((item) => item.sourceScopeId === board.boardId)
        .map((item) => [item.workItemId, item])
    )
    const observedIds = new Set<string>()
    const observedItems = board.items
      .map((observation) => ({
        item: { ...observation.item, sourceScopeId: board.boardId } as MissionWorkItemState,
        observedAt: observation.observedAt || board.observedAt,
        provenance: observation.provenance || board.provenance
      }))
      .sort(
        (left, right) =>
          (left.item.sortOrder ?? Number.MAX_SAFE_INTEGER) -
            (right.item.sortOrder ?? Number.MAX_SAFE_INTEGER) ||
          left.item.workItemId.localeCompare(right.item.workItemId)
      )
    for (const observation of observedItems) {
      const { item } = observation
      observedIds.add(item.workItemId)
      const current = currentItems.get(item.workItemId)
      if (current && workItemsEqual(current, item)) continue
      facts.push(
        fact(
          normalizedMissionId,
          observation.observedAt,
          surfaceProvenance('board', observation.provenance, item.workItemId),
          { kind: 'work_item_upserted', item }
        )
      )
    }
    for (const current of [...currentItems.values()].sort((a, b) =>
      a.workItemId.localeCompare(b.workItemId)
    )) {
      if (observedIds.has(current.workItemId)) continue
      facts.push(
        fact(
          normalizedMissionId,
          board.observedAt,
          surfaceProvenance('board', board.provenance, current.workItemId),
          { kind: 'work_item_removed', workItemId: current.workItemId }
        )
      )
    }
  }
  return facts
}

export function missionWorkItemStatusFromLegacyBoardColumn(
  columnId: string
): MissionWorkItemStatus {
  switch (columnId) {
    case 'running':
      return 'running'
    case 'needs-input':
      return 'needs-input'
    case 'blocked':
      return 'blocked'
    case 'review-ready':
      return 'review-ready'
    case 'done':
      return 'done'
    case 'archived':
      return 'archived'
    case 'inbox':
    case 'ready':
    default:
      return 'pending'
  }
}
