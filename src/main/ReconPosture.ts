import type { EffectiveRunPermissions } from './store/types'

/**
 * Recon-seat detection — spike 1 of
 * `docs/ensemble-posture-fanout-preamble-design.md`.
 *
 * `read_only` (Recon) and `plan` resolve to byte-identical permission
 * presets (`approvalMode: 'plan'` — see `DEFAULT_PERMISSION_PRESETS` in
 * EffectiveRunPermissions.ts), because 'plan' is the canonical no-write
 * wire value required by `clampUntrustedRunPosture` (a trusted plan
 * posture MUST carry `readOnly: true`, and every fail-closed downgrade
 * lands on plan + read_only). Provider adapters that key their native
 * PLAN persona off `approvalMode === 'plan'` therefore turn every
 * Read-Only/Recon turn into a plan-shaped turn.
 *
 * This helper recovers the recon intent from the two fields that DO
 * record it — both already inside the posture HMAC
 * (`RunPermissionPostureContext.workflowMode` + the signed
 * `effectivePermissions` object), so consuming them adds no new trust
 * surface:
 *
 *   - `workflowMode` — solo composer picker: 'plan' = Plan workflow,
 *     'normal' = Read-Only/Recon (ComposerService stamps
 *     presetId 'read_only' for BOTH). `normalizeAgentRunPayload` forces
 *     'normal' when the clamp downgrades an unverifiable posture, so
 *     downgraded runs read as recon: containment is unchanged (the
 *     effectivePermissions service denies do the enforcement, not the
 *     provider's plan persona) and findings-shaped output is the right
 *     degraded behavior.
 *   - `effectivePermissions.presetId` — ensemble seats: 'read_only'
 *     (recon/review seat) vs 'plan' (plan seat).
 *
 * MUST be called on POST-CLAMP payloads (after `normalizeAgentRunPayload`,
 * which also guarantees `workflowMode` is exactly 'plan' | 'normal') —
 * never on raw renderer input. Anything other than an explicit 'normal'
 * workflow fails the predicate, so a payload that somehow skipped
 * normalization keeps today's plan-mode behavior.
 *
 * Ollama caveat: the composer forces approvalMode 'plan' on EVERY ollama
 * run (its real posture is the tool tier), so ollama runs trivially
 * satisfy this predicate. Ollama call sites must not use it to gate
 * behavior that should track the tier — see the tier-aware workflow hint
 * in ollama/OllamaModelProfiles.ts instead.
 */
export function isReconRunPosture(input: {
  approvalMode?: string | null
  workflowMode?: string | null
  effectivePermissions?: Pick<EffectiveRunPermissions, 'presetId' | 'readOnly'> | null
}): boolean {
  if (input.approvalMode !== 'plan') return false
  if (input.workflowMode !== 'normal') return false
  const permissions = input.effectivePermissions
  if (!permissions) return false
  return permissions.readOnly === true && permissions.presetId === 'read_only'
}
