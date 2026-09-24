import type { EffectiveRunPermissions } from './store/types'

/**
 * The forced read-only Ensemble fan-out clamp, and the marker that lets later
 * gates recognise a posture it produced.
 *
 * A Boss `ensemble_fanout(mode='locked_writers')` lane with no `writeScopes`
 * entry (and any explicit `forceReadOnlyDispatch`) is runtime-clamped to the
 * `read_only` preset. That preset resolves `fileChanges: 'ask'`, and
 * `READ_ONLY_APPROVAL_ONLY_INSTRUMENT_SERVICES` folds `fileChanges` into
 * `neverAutoAllow` — so nothing can auto-answer the card. On an interactive
 * seat that is correct: a human is looking at the modal. On a background
 * fan-out lane nobody is, so the lane parks on an unanswerable approval until
 * a transport backstop kills it.
 *
 * User decision: for THIS clamp `fileChanges` becomes `'deny'`, which the
 * approval gate turns into an immediate in-band tool refusal (a paired
 * tool_use/tool_result with an actionable reason) instead of a card nobody
 * answers. `shellCommands` deliberately stays `'ask'` — a watching human can
 * still authorise a shell command — and no other service moves.
 *
 * Why this is a separate leaf module rather than a branch inside the resolver:
 * the fact "this posture was produced by the fan-out clamp" is not derivable
 * from the resolved permission values. A user-configured `fileChanges: 'deny'`
 * on an Ask seat is byte-identical in `agenticServices`, and it legitimately
 * keeps the Plan-workflow plan-artifact write path
 * (`PlanArtifactWritePolicy`). Only the clamp site knows which one it built,
 * so the clamp stamps the fact and the policy reads it back.
 *
 * The marker rides INSIDE `EffectiveRunPermissions` on purpose:
 * `canonicalRunPermissionPosture` stable-stringifies the whole object, so the
 * marker is bound by the run posture's HMAC. Stripping it invalidates the
 * signature, and `clampUntrustedRunPosture` then re-derives a `plan` posture
 * whose `fileChanges` is `'ask'` — which the plan-artifact policy already
 * refuses. The suppression therefore fails closed under tampering.
 */
export const FORCED_READ_ONLY_FANOUT_CLAMP_KEY = 'forcedReadOnlyFanoutClamp'

export type ForcedReadOnlyFanoutClampedPermissions = EffectiveRunPermissions & {
  readonly forcedReadOnlyFanoutClamp: true
}

/**
 * Narrow an already-resolved read-only fan-out posture: deny `fileChanges`,
 * stamp the clamp marker, leave every other service (including the
 * deliberately-attended `shellCommands: 'ask'`) exactly as resolved.
 *
 * Runtime-only and idempotent. It never persists as a roster override — the
 * caller resolves with `ignoreOverrides: true` and this returns a fresh object
 * rather than mutating the participant's stored permissions.
 */
export function applyForcedReadOnlyFanoutWriteDeny(
  permissions: EffectiveRunPermissions
): ForcedReadOnlyFanoutClampedPermissions {
  return {
    ...permissions,
    agenticServices: {
      ...permissions.agenticServices,
      fileChanges: 'deny'
    },
    forcedReadOnlyFanoutClamp: true
  }
}

/** Was this posture produced by `applyForcedReadOnlyFanoutWriteDeny`? */
export function isForcedReadOnlyFanoutClampedPosture(
  permissions: EffectiveRunPermissions | null | undefined
): boolean {
  if (!permissions || typeof permissions !== 'object') return false
  const marked = permissions as Partial<ForcedReadOnlyFanoutClampedPermissions>
  return marked.forcedReadOnlyFanoutClamp === true
}
