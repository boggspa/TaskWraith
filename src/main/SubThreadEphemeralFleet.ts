/**
 * SubThreadEphemeralFleet — pure helpers for the die-on-return fleet layer
 * built on `delegate_wave` / sub-threads.
 *
 * Ensemble-agnostic: no roster, fan-out, or WavePlan. Agent assigns roles;
 * user only Allow/Deny (+ elevations). Same-provider preferred at parse time.
 *
 * No `fleet_await` in v1: the parent expresses wait-vs-partials up front via
 * `join.deadlineMs` / `join.quorum`. That is the same decision Ensemble's
 * `ensemble_await` gives a Boss at poll time — recorded here so it is not
 * rediscovered as a missing tool.
 */

import { resolve } from 'path'
import type { ChatRecord } from './store/types'
import type { SubThreadWorkerIsolationRequest } from './SubThreadPermissions'

/**
 * Agent-assigned fleet worker role.
 *
 * Deliberately parallel to `EnsembleStageRole` (`scout` | `worker` |
 * `reviewer` | `background`) — do NOT unify. Fleet has no `background`, and
 * these strings do not drive Ensemble stage dispatch.
 */
export type FleetWaveRole = 'scout' | 'worker' | 'reviewer'

export type FleetWaveLifecycle = 'ephemeral' | 'durable'

export function normalizeFleetLifecycle(raw: unknown): FleetWaveLifecycle {
  return raw === 'ephemeral' ? 'ephemeral' : 'durable'
}

export function parseFleetWaveRole(raw: unknown): FleetWaveRole | undefined {
  if (raw === 'scout' || raw === 'worker' || raw === 'reviewer') return raw
  return undefined
}

/**
 * Map a single fleet role → sub-thread worker isolation (posture).
 *
 * Role-only: ignores wave peers. Prefer
 * {@link resolveEphemeralFleetIsolationForWave} at spawn time — parallel
 * `role=worker` seats share the parent checkout, so `capped_inherit` is only
 * safe for a sole worker in the wave (see that helper).
 *
 * - scout / reviewer / undefined → `read_only`
 * - worker → `capped_inherit` (Full Access demoted; same-checkout writes)
 */
export function resolveEphemeralFleetIsolation(
  role: FleetWaveRole | undefined
): SubThreadWorkerIsolationRequest {
  if (role === 'worker') {
    return { kind: 'capped_inherit' }
  }
  return { kind: 'read_only' }
}

/**
 * Wave-aware isolation for ephemeral fleet seats.
 *
 * Residual: parallel `role=worker` seats would otherwise all get
 * `capped_inherit` and race on the shared parent checkout. Fail closed:
 * when two or more seats in the wave have `role === 'worker'`, every worker
 * seat is `read_only`. A sole worker may take optional worktree isolation
 * when the caller supplies distinct base/effective paths (from
 * `allocateEphemeralFleetWriterWorktree`); otherwise it falls back to
 * `capped_inherit`. Scout / reviewer / undefined remain `read_only`.
 *
 * `workerRoles` is the role list for all seats in the wave (same order as
 * spawn is fine; only the count of `'worker'` matters).
 */
export function resolveEphemeralFleetIsolationForWave(input: {
  role: FleetWaveRole | undefined
  workerIndex?: number
  workerRoles: ReadonlyArray<FleetWaveRole | undefined>
  /** Optional sole-writer worktree paths from a successful soft-fail allocator. */
  worktree?: { baseWorkspacePath: string; effectiveWorkspacePath: string }
}): SubThreadWorkerIsolationRequest {
  if (input.role !== 'worker') {
    return { kind: 'read_only' }
  }
  // Prefer ALL read_only when count(worker) > 1 — shared-checkout races are
  // not product-safe under capped_inherit, and multi-writer worktrees are not
  // admitted by this helper (parent allocates at most one sole-writer tree).
  const workerSeatCount = input.workerRoles.filter((role) => role === 'worker').length
  if (workerSeatCount > 1) {
    return { kind: 'read_only' }
  }
  const worktree = normalizeSoleWorkerWorktree(input.worktree)
  if (worktree) {
    return {
      kind: 'worktree',
      baseWorkspacePath: worktree.baseWorkspacePath,
      effectiveWorkspacePath: worktree.effectiveWorkspacePath
    }
  }
  return { kind: 'capped_inherit' }
}

function normalizeSoleWorkerWorktree(
  worktree: { baseWorkspacePath: string; effectiveWorkspacePath: string } | undefined
): { baseWorkspacePath: string; effectiveWorkspacePath: string } | null {
  if (!worktree) return null
  const baseWorkspacePath = worktree.baseWorkspacePath.trim().replace(/\/+$/, '')
  const effectiveWorkspacePath = worktree.effectiveWorkspacePath.trim().replace(/\/+$/, '')
  if (!baseWorkspacePath || !effectiveWorkspacePath) return null
  if (resolve(baseWorkspacePath) === resolve(effectiveWorkspacePath)) return null
  return { baseWorkspacePath, effectiveWorkspacePath }
}

/** Host-injected ≤2-sentence role frame prepended to the parent’s task prompt. */
export function buildEphemeralFleetRoleFrame(
  role: FleetWaveRole | undefined,
  label?: string
): string {
  const tag = label?.trim() ? ` (${label.trim()})` : ''
  if (role === 'scout') {
    return `Fleet role: scout${tag}. Investigate and report findings; do not implement or mutate the workspace.`
  }
  if (role === 'reviewer') {
    return `Fleet role: reviewer${tag}. Critique and report risks; prefer evidence over speculation. Stay within your permission posture.`
  }
  if (role === 'worker') {
    return `Fleet role: worker${tag}. Execute the assigned task under your capped permission posture; do not escalate or spawn further fleets.`
  }
  return `Fleet worker${tag}. Complete the assigned task under your permission posture; do not spawn further fleets.`
}

/** True when a typed return should archive the child (die-on-return). */
export function shouldArchiveEphemeralFleetChild(
  chat: Pick<ChatRecord, 'parentChatRelation' | 'delegationContext' | 'parentChatId'>
): boolean {
  const isSubThread =
    Boolean(chat.parentChatId) &&
    (chat.parentChatRelation === undefined || chat.parentChatRelation === 'subThread')
  return isSubThread && chat.delegationContext?.lifecycle === 'ephemeral'
}

/**
 * Die-on-return archive after worktree settle.
 * `null` means settle was unnecessary (no fleet worktree / not ephemeral path).
 * Promote/discard failure keeps the child visible for recovery.
 */
export function shouldArchiveEphemeralFleetAfterSettle(settle: { ok: boolean } | null): boolean {
  if (settle == null) return true
  return settle.ok
}
