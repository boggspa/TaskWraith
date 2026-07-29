import type { ProviderId } from '../main/store/types'

export const WORK_LOCK_PROJECTION_SCHEMA_VERSION = 1 as const

export type WorkLockProjectionStatus = 'held' | 'orphan_live' | 'recovery_blocked' | 'recovered'

export type WorkLockProjectionChangeReason =
  | 'initial'
  | 'acquired'
  | 'released'
  | 'contended'
  | 'orphan-detected'
  | 'recovery-blocked'
  | 'recovered'
  | 'replayed'

export type WorkLockProjectionTarget =
  | {
      kind: 'workspace'
    }
  | {
      kind: 'tree'
      /** Workspace-relative folder path. */
      path: string
    }
  | {
      kind: 'file'
      /** Workspace-relative display path. */
      path: string
    }
  | {
      kind: 'hunk'
      /** Workspace-relative display path. */
      path: string
      /** Inclusive, one-based line range. */
      startLine: number
      /** Inclusive, one-based line range. */
      endLine: number
      /** Optional content revision used to anchor the range. */
      baseRevision?: string
      /** True when a zero-width core range represents an insertion point. */
      isInsertion?: boolean
    }

/**
 * Renderer-safe owner identity. Process ids and process-birth receipts are
 * deliberately absent: main uses them for recovery, but UI only needs the
 * durable product identities that explain who owns an edit.
 */
export interface WorkLockOwnerProjection {
  displayName: string
  provider?: ProviderId
  chatId?: string
  chatTitle?: string
  laneId?: string
  runId?: string
  participantId?: string
}

export interface WorkLockWorkspaceProjection {
  /** Canonical workspace selected by the user. */
  basePath: string
  /** Exact checkout receiving the edit. Equals basePath outside a worktree. */
  effectivePath: string
  isWorktree: boolean
  worktreeName?: string
  branch?: string
}

export interface WorkLockProjection {
  schemaVersion: typeof WORK_LOCK_PROJECTION_SCHEMA_VERSION
  lockId: string
  status: WorkLockProjectionStatus
  owner: WorkLockOwnerProjection
  workspace: WorkLockWorkspaceProjection
  target: WorkLockProjectionTarget
  acquiredAt: string
  statusChangedAt: string
  recoveredAt?: string
}

export interface WorkLockProjectionSnapshot {
  schemaVersion: typeof WORK_LOCK_PROJECTION_SCHEMA_VERSION
  generation: number
  sampledAt: string
  locks: WorkLockProjection[]
}

/**
 * chatId carries authorization provenance for linked/external workspaces. It
 * does not filter out other chats: cross-chat holders are exactly what a user
 * needs to see before two runs touch the same checkout.
 */
export interface WorkLockProjectionQuery {
  workspacePath?: string
  chatId?: string
}

export interface WorkLockProjectionSubscribeRequest extends WorkLockProjectionQuery {
  subscriptionId: string
}

export interface WorkLockProjectionChangedEvent {
  subscriptionId: string
  reason: Exclude<WorkLockProjectionChangeReason, 'initial'>
  snapshot: WorkLockProjectionSnapshot
}

export interface WorkLockProjectionUpdate {
  reason: WorkLockProjectionChangeReason
  snapshot: WorkLockProjectionSnapshot
}

export type WorkLockProjectionSubscribeResult =
  | {
      ok: true
      data: {
        subscriptionId: string
        snapshot: WorkLockProjectionSnapshot
      }
    }
  | {
      ok: false
      error: string
    }

/**
 * Core services may carry additional recovery-only fields. This source shape
 * intentionally allows them while the projector copies only renderer-safe
 * fields into the public contract.
 */
export type WorkLockProjectionSourceTarget =
  | {
      kind: 'workspace'
    }
  | {
      kind: 'tree' | 'file'
      path: string
    }
  | {
      kind: 'hunk'
      path: string
      /**
       * Core coordinates are zero-based half-open. The public projection always
       * converts them to one-based inclusive coordinates.
       */
      startLine: number
      endLine: number
      baseline?: string
      baseRevision?: string
      coordinateSystem?: 'zero-based-half-open' | 'one-based-inclusive'
      isInsertion?: boolean
    }

export type WorkLockProjectionSource = Omit<WorkLockProjection, 'schemaVersion' | 'target'> & {
  owner: WorkLockOwnerProjection & Record<string, unknown>
  workspace: WorkLockWorkspaceProjection & Record<string, unknown>
  target: WorkLockProjectionSourceTarget & Record<string, unknown>
  [key: string]: unknown
}

export function projectWorkLock(
  source: WorkLockProjectionSource | WorkLockProjection
): WorkLockProjection {
  const target: WorkLockProjectionTarget =
    source.target.kind === 'workspace'
      ? { kind: 'workspace' }
      : source.target.kind === 'tree'
        ? { kind: 'tree', path: source.target.path }
        : source.target.kind === 'file'
          ? { kind: 'file', path: source.target.path }
          : projectHunkTarget(source)

  return {
    schemaVersion: WORK_LOCK_PROJECTION_SCHEMA_VERSION,
    lockId: source.lockId,
    status: source.status,
    owner: {
      displayName: source.owner.displayName,
      ...(source.owner.provider ? { provider: source.owner.provider } : {}),
      ...(source.owner.chatId ? { chatId: source.owner.chatId } : {}),
      ...(source.owner.chatTitle ? { chatTitle: source.owner.chatTitle } : {}),
      ...(source.owner.laneId ? { laneId: source.owner.laneId } : {}),
      ...(source.owner.runId ? { runId: source.owner.runId } : {}),
      ...(source.owner.participantId ? { participantId: source.owner.participantId } : {})
    },
    workspace: {
      basePath: source.workspace.basePath,
      effectivePath: source.workspace.effectivePath,
      isWorktree: source.workspace.isWorktree,
      ...(source.workspace.worktreeName ? { worktreeName: source.workspace.worktreeName } : {}),
      ...(source.workspace.branch ? { branch: source.workspace.branch } : {})
    },
    target,
    acquiredAt: source.acquiredAt,
    statusChangedAt: source.statusChangedAt,
    ...(source.recoveredAt ? { recoveredAt: source.recoveredAt } : {})
  }
}

function projectHunkTarget(
  source: WorkLockProjectionSource | WorkLockProjection
): Extract<WorkLockProjectionTarget, { kind: 'hunk' }> {
  const hunk = source.target as Extract<WorkLockProjectionSourceTarget, { kind: 'hunk' }>
  const alreadyPublic =
    source.schemaVersion === WORK_LOCK_PROJECTION_SCHEMA_VERSION ||
    hunk.coordinateSystem === 'one-based-inclusive'
  const insertion = hunk.isInsertion === true || (!alreadyPublic && hunk.startLine === hunk.endLine)
  const startLine = alreadyPublic ? hunk.startLine : hunk.startLine + 1
  const endLine = alreadyPublic ? hunk.endLine : insertion ? hunk.startLine + 1 : hunk.endLine
  const baseRevision = hunk.baseRevision || hunk.baseline

  return {
    kind: 'hunk',
    path: hunk.path,
    startLine,
    endLine,
    ...(baseRevision ? { baseRevision } : {}),
    ...(insertion ? { isInsertion: true } : {})
  }
}

export function createWorkLockProjectionSnapshot(input: {
  generation: number
  sampledAt: string
  locks: readonly WorkLockProjectionSource[]
}): WorkLockProjectionSnapshot {
  return {
    schemaVersion: WORK_LOCK_PROJECTION_SCHEMA_VERSION,
    generation: input.generation,
    sampledAt: input.sampledAt,
    locks: input.locks
      .map(projectWorkLock)
      .sort(
        (left, right) =>
          left.acquiredAt.localeCompare(right.acquiredAt) || left.lockId.localeCompare(right.lockId)
      )
  }
}

export function workLockProjectionIsActive(status: WorkLockProjectionStatus): boolean {
  return status !== 'recovered'
}

function comparablePath(value: string): string {
  if (!value || value.trim().length === 0) return ''
  if (value === '/' || value === '\\' || /^[A-Za-z]:[\\/]$/.test(value)) return value
  return value.replace(/[\\/]+$/, '')
}

export function scopeWorkLockProjectionSnapshot(
  snapshot: WorkLockProjectionSnapshot,
  query: WorkLockProjectionQuery
): WorkLockProjectionSnapshot {
  const requestedPath = comparablePath(query.workspacePath || '')
  if (!requestedPath) {
    return {
      ...snapshot,
      locks: snapshot.locks.map((lock) => projectWorkLock(lock))
    }
  }

  return {
    ...snapshot,
    locks: snapshot.locks
      .filter((lock) => {
        const basePath = comparablePath(lock.workspace.basePath)
        const effectivePath = comparablePath(lock.workspace.effectivePath)
        return requestedPath === basePath || requestedPath === effectivePath
      })
      .map((lock) => projectWorkLock(lock))
  }
}

export function workLockProjectionQueryKey(query: WorkLockProjectionQuery): string {
  return `${comparablePath(query.workspacePath || '')}\u0000${query.chatId?.trim() || ''}`
}

/**
 * A contention notice can legitimately reuse the current WAL generation
 * because it reports a rejected transition rather than a state mutation.
 * Only an older snapshot is stale.
 */
export function workLockProjectionUpdateIsStale(
  latestGeneration: number,
  nextGeneration: number
): boolean {
  return nextGeneration < latestGeneration
}
