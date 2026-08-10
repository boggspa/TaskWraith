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

/** Map fleet role → sub-thread worker isolation (posture). */
export function resolveEphemeralFleetIsolation(
  role: FleetWaveRole | undefined
): SubThreadWorkerIsolationRequest {
  // Reviewers investigate/critique only — never same-checkout writes.
  // Workers may inherit a capped writer posture (Full Access demoted).
  // Default / scout → read_only.
  if (role === 'worker') {
    return { kind: 'capped_inherit' }
  }
  return { kind: 'read_only' }
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
