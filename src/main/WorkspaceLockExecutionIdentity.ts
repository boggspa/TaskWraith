import { randomUUID } from 'node:crypto'

import type { ProviderId } from './store/types'

export const TASKWRAITH_LOCK_OWNER_ENV_KEY = 'TASKWRAITH_LOCK_OWNER_ID'

export type WorkspaceLockExecutionIdentityScope =
  | {
      kind: 'logical-run'
      runId: string
      laneId?: string
      participantId?: string
    }
  | {
      /**
       * Persistent ACP processes may span serial logical runs. A seat identity
       * is valid only while the caller enforces one active write-capable run
       * for that seat.
       */
      kind: 'provider-seat'
      provider: ProviderId
      seatId: string
    }

export interface WorkspaceLockExecutionIdentityRegistryDependencies {
  createId?: () => string
}

/**
 * Issues opaque lock-owner ids at the narrowest execution boundary that can be
 * propagated to a native process. Logical run identities include lane and
 * participant coordinates, so two seats sharing a run can never inherit one
 * another's git-hook bypass.
 */
export class WorkspaceLockExecutionIdentityRegistry {
  private readonly identities = new Map<string, string>()
  private readonly scopesByIdentity = new Map<string, string>()
  private readonly createId: () => string

  constructor(deps: WorkspaceLockExecutionIdentityRegistryDependencies = {}) {
    this.createId = deps.createId ?? (() => randomUUID())
  }

  getOrCreate(scope: WorkspaceLockExecutionIdentityScope): string {
    const key = executionIdentityScopeKey(scope)
    const existing = this.identities.get(key)
    if (existing) return existing

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidate = normalizeOpaqueIdentity(this.createId())
      if (this.scopesByIdentity.has(candidate)) continue
      this.identities.set(key, candidate)
      this.scopesByIdentity.set(candidate, key)
      return candidate
    }
    throw new Error('Unable to allocate a unique workspace-lock execution identity.')
  }

  get(scope: WorkspaceLockExecutionIdentityScope): string | null {
    return this.identities.get(executionIdentityScopeKey(scope)) ?? null
  }

  release(scope: WorkspaceLockExecutionIdentityScope): boolean {
    const key = executionIdentityScopeKey(scope)
    const identity = this.identities.get(key)
    if (!identity) return false
    this.identities.delete(key)
    this.scopesByIdentity.delete(identity)
    return true
  }

  releaseLogicalRun(runId: string): number {
    const normalizedRunId = requireIdentityCoordinate(runId, 'run id')
    const prefix = `logical-run\u0000${normalizedRunId}\u0000`
    let released = 0
    for (const [key, identity] of this.identities) {
      if (!key.startsWith(prefix)) continue
      this.identities.delete(key)
      this.scopesByIdentity.delete(identity)
      released += 1
    }
    return released
  }
}

/**
 * Return a fresh env object whose owner can come only from explicit admission.
 * Passing null removes ambient/profile authority.
 */
export function withExactWorkspaceLockOwnerEnv(
  env: Readonly<Record<string, string | undefined>>,
  lockOwnerId: string | null | undefined
): Record<string, string | undefined> {
  const result = { ...env }
  for (const key of Object.keys(result)) {
    if (key.toUpperCase() === TASKWRAITH_LOCK_OWNER_ENV_KEY) delete result[key]
  }
  const normalized = normalizeOptionalOpaqueIdentity(lockOwnerId)
  if (normalized) result[TASKWRAITH_LOCK_OWNER_ENV_KEY] = normalized
  return result
}

function executionIdentityScopeKey(scope: WorkspaceLockExecutionIdentityScope): string {
  if (scope.kind === 'provider-seat') {
    return [
      scope.kind,
      requireIdentityCoordinate(scope.provider, 'provider'),
      requireIdentityCoordinate(scope.seatId, 'seat id')
    ].join('\u0000')
  }
  return [
    scope.kind,
    requireIdentityCoordinate(scope.runId, 'run id'),
    normalizeIdentityCoordinate(scope.laneId),
    normalizeIdentityCoordinate(scope.participantId)
  ].join('\u0000')
}

function normalizeOptionalOpaqueIdentity(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null
  return normalizeOpaqueIdentity(value)
}

function normalizeOpaqueIdentity(value: string): string {
  const normalized = requireIdentityCoordinate(value, 'lock owner id')
  if (normalized.length > 256) throw new Error('Workspace-lock owner id is too long.')
  return normalized
}

function normalizeIdentityCoordinate(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return ''
  return requireIdentityCoordinate(value, 'identity coordinate')
}

function requireIdentityCoordinate(value: string, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Workspace-lock ${label} is required.`)
  }
  if (value !== value.trim() || value.includes('\u0000')) {
    throw new Error(`Workspace-lock ${label} is malformed.`)
  }
  return value
}
