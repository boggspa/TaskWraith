import type { PermissionPresetId, ProviderId } from './store/types'
import { ANTIGRAVITY_PROVIDER_ID, isRetiredProvider } from '../shared/retiredProviders'

/**
 * Pure decision logic for an auto-failover reroute's permission posture and
 * target selection. The security-critical invariant — a failover may PRESERVE
 * the user's approved authority but NEVER ESCALATE it — lives here so it is
 * unit-tested in isolation from the Electron/AppStore wiring in index.ts.
 *
 * Why this is needed: `applyReroutePlanToPayload` clears
 * `effectivePermissions` + signature on a provider change, and
 * `clampUntrustedRunPosture` then BLINDLY TRUSTS any validly-signed posture
 * (it does not re-derive a ceiling and intersect). So the only escalation
 * guard on a re-signed reroute posture is the preset we choose here. It must
 * be airtight.
 */

/**
 * Authority rank of each permission preset, for the non-escalation comparison.
 * Higher = more authority. An unknown / absent preset is treated as `default`
 * (the safe assumption — prompt-on-action, no standing write authority).
 *
 * `plan` sits STRICTLY between `read_only` and `default`: after the posture
 * split it permits approval-gated instruments (canvas actuation, media compute,
 * subthread delegation) that `read_only` denies, but — unlike `default` — it
 * still cannot edit files or run shell. Keeping `plan` above `read_only` here is
 * what makes `isNonEscalatingPreset` correctly BAIL a read_only → plan reroute
 * target (an escalation) while still allowing plan → read_only (de-escalation).
 * `reroutePresetId` never actually emits a `plan` target today, so this entry is
 * defense-in-depth against a future producer that does.
 */
const DEFAULT_PRESET_AUTHORITY_RANK = 2
const PRESET_AUTHORITY_RANK: Readonly<Record<string, number>> = {
  read_only: 0,
  plan: 1,
  custom: 2,
  default: 2,
  workspace_write: 3,
  full_access: 4
}

export function presetAuthorityRank(presetId: string | null | undefined): number {
  return presetId ? (PRESET_AUTHORITY_RANK[presetId] ?? DEFAULT_PRESET_AUTHORITY_RANK) : DEFAULT_PRESET_AUTHORITY_RANK
}

/**
 * Choose the preset to re-derive for the failover TARGET provider, given the
 * already-mode-capped approval mode and the ORIGINAL run's preset.
 *
 * - Ollama target → always `read_only`: a local Ollama run is forced to plan
 *   by every first-party producer (its tool-tier ladder lives outside the
 *   posture object), so a reroute to Ollama must not grant more.
 * - plan → `read_only`.
 * - auto_edit → `full_access` ONLY if the original already had full_access,
 *   else `workspace_write` (never inflate workspace_write → full_access).
 * - default / undefined → `undefined` (no effectivePermissions object, matching
 *   every existing producer for a default-mode run).
 *
 * Returns `undefined` to mean "attach no effectivePermissions object".
 */
export function reroutePresetId(
  cappedApprovalMode: string | undefined,
  originalPresetId: string | undefined,
  targetProvider: ProviderId
): PermissionPresetId | undefined {
  if (targetProvider === 'ollama') return 'read_only'
  if (cappedApprovalMode === 'plan') return 'read_only'
  if (cappedApprovalMode === 'auto_edit') {
    return originalPresetId === 'full_access' ? 'full_access' : 'workspace_write'
  }
  return undefined
}

/**
 * Defense-in-depth assertion: the chosen target preset must not out-rank the
 * original. `undefined` target preset (no object) is always safe. Callers MUST
 * bail (leave the posture cleared so normalize fails it closed to read-only)
 * when this returns false.
 */
export function isNonEscalatingPreset(
  targetPresetId: string | undefined,
  originalPresetId: string | undefined
): boolean {
  if (!targetPresetId) return true
  return presetAuthorityRank(targetPresetId) <= presetAuthorityRank(originalPresetId)
}

export interface SelectFailoverTargetInput {
  failedProvider: ProviderId
  /** Live (runnable, non-retired) providers, in a sensible default order. */
  liveProviders: ProviderId[]
  /** Whether a provider currently has an active pause. */
  isPaused: (provider: ProviderId) => boolean
  /** The user's pre-configured reroute target for the failed provider, if any. */
  preferred?: ProviderId | null
  /** Optional explicit failover order; defaults to `liveProviders`. */
  order?: ProviderId[]
}

/**
 * Pick the provider to fail over to: the user's configured reroute target if
 * it's live and un-paused, else the first live, un-paused provider that isn't
 * the failed one. Returns null when nothing is eligible (all walled) — the
 * caller should surface a hard failure rather than loop.
 */
export function selectFailoverTarget(input: SelectFailoverTargetInput): ProviderId | null {
  const live = new Set(input.liveProviders)
  const eligible = (
    p: ProviderId | null | undefined,
    selection: 'preferred' | 'automatic'
  ): p is ProviderId =>
    !!p &&
    p !== input.failedProvider &&
    !isRetiredProvider(p) &&
    live.has(p) &&
    // AntiGravity is conditional. The caller's live set proves current
    // admission, while an explicit reroute preference proves the user chose
    // it as this failover target. Mere list membership must not silently route
    // a failing provider into a conditional lane.
    (p !== ANTIGRAVITY_PROVIDER_ID || selection === 'preferred') &&
    !input.isPaused(p)
  if (eligible(input.preferred, 'preferred')) return input.preferred
  for (const p of input.order && input.order.length ? input.order : input.liveProviders) {
    if (eligible(p, 'automatic')) return p
  }
  return null
}
