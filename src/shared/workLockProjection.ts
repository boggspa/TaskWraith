import type { ProviderId } from '../main/store/types'

/**
 * v2 adds the optional renderer-safe `holder` block. A v1 snapshot is still a
 * valid input everywhere; only the producer moved.
 */
export const WORK_LOCK_PROJECTION_SCHEMA_VERSION = 2 as const
export type WorkLockProjectionSchemaVersion = 1 | typeof WORK_LOCK_PROJECTION_SCHEMA_VERSION

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

export type WorkLockHolderLiveness = 'live' | 'lapsed' | 'dead' | 'unknown'

/**
 * Renderer-safe liveness of the process behind a lease, as last observed by
 * main's periodic reclaim pass. Pids, birth identities and heartbeat file
 * paths deliberately never reach this shape.
 */
export interface WorkLockHolderProjection {
  /**
   * `this` when the running app process issued the lease; `other` for any
   * other process, including an earlier launch of the same profile.
   */
  instanceScope: 'this' | 'other'
  liveness: WorkLockHolderLiveness
  /**
   * Wall age of the holder's last heartbeat at main's last scan; absent for
   * the running app's own leases and for a holder that never wrote one.
   */
  heartbeatAgeMs?: number
  generation: number
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
  schemaVersion: WorkLockProjectionSchemaVersion
  lockId: string
  status: WorkLockProjectionStatus
  owner: WorkLockOwnerProjection
  workspace: WorkLockWorkspaceProjection
  target: WorkLockProjectionTarget
  acquiredAt: string
  statusChangedAt: string
  recoveredAt?: string
  holder?: WorkLockHolderProjection
}

export interface WorkLockProjectionSnapshot {
  schemaVersion: WorkLockProjectionSchemaVersion
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

export interface WorkLockRecoveryRequest extends WorkLockProjectionQuery {
  /** Public lock id selected from the renderer-safe projection. */
  lockId: string
}

export type WorkLockRecoveryFailureReason =
  | 'invalid_request'
  | 'not_found_or_forbidden'
  | 'unavailable'
  | 'owner_live'
  | 'owner_identity_unavailable'
  | 'cancelled'
  | 'stale'
  | 'release_failed'

export type WorkLockRecoveryResult =
  | {
      ok: true
      releasedLeaseCount: number
      attentionRequired: boolean
      message: string
    }
  | {
      ok: false
      reason: WorkLockRecoveryFailureReason
      message: string
    }

export function workspaceLockRecoveryMessage(result: WorkLockRecoveryResult): string | null {
  if (result.ok && !result.attentionRequired) return null
  return result.message
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

export type WorkLockProjectionSource = Omit<
  WorkLockProjection,
  'schemaVersion' | 'target' | 'holder'
> & {
  owner: WorkLockOwnerProjection & Record<string, unknown>
  workspace: WorkLockWorkspaceProjection & Record<string, unknown>
  target: WorkLockProjectionSourceTarget & Record<string, unknown>
  holder?: WorkLockHolderProjection & Record<string, unknown>
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
    ...(source.recoveredAt ? { recoveredAt: source.recoveredAt } : {}),
    ...(source.holder ? { holder: projectHolder(source.holder) } : {})
  }
}

const HOLDER_LIVENESS: readonly WorkLockHolderLiveness[] = ['live', 'lapsed', 'dead', 'unknown']

/** Copies only the declared holder fields; anything else a source carries is dropped. */
function projectHolder(holder: WorkLockHolderProjection): WorkLockHolderProjection {
  // Sources are untyped at runtime (IPC, older producers): read every field as unknown.
  const raw: Record<string, unknown> = { ...holder }
  const heartbeatAgeMs =
    typeof raw.heartbeatAgeMs === 'number' && Number.isFinite(raw.heartbeatAgeMs)
      ? Math.max(0, Math.round(raw.heartbeatAgeMs))
      : undefined
  const liveness = HOLDER_LIVENESS.find((candidate) => candidate === raw.liveness) ?? 'unknown'
  return {
    instanceScope: raw.instanceScope === 'this' ? 'this' : 'other',
    liveness,
    ...(heartbeatAgeMs !== undefined ? { heartbeatAgeMs } : {}),
    generation: Number.isSafeInteger(raw.generation) ? (raw.generation as number) : 0
  }
}

function projectHunkTarget(
  source: WorkLockProjectionSource | WorkLockProjection
): Extract<WorkLockProjectionTarget, { kind: 'hunk' }> {
  const hunk = source.target as Extract<WorkLockProjectionSourceTarget, { kind: 'hunk' }>
  const alreadyPublic =
    source.schemaVersion === 1 ||
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
