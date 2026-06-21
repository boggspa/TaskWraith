import type { PermissionPresetId, ProviderId } from './store/types'
import { isRetiredProvider } from '../shared/retiredProviders'

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
 * (1) — the safe assumption (no write authority granted).
 */
const PRESET_AUTHORITY_RANK: Readonly<Record<string, number>> = {
  read_only: 0,
  custom: 1,
  default: 1,
  workspace_write: 2,
  full_access: 3
}

export function presetAuthorityRank(presetId: string | null | undefined): number {
  return presetId ? (PRESET_AUTHORITY_RANK[presetId] ?? 1) : 1
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
  const eligible = (p: ProviderId | null | undefined): p is ProviderId =>
    !!p && p !== input.failedProvider && !isRetiredProvider(p) && live.has(p) && !input.isPaused(p)
  if (eligible(input.preferred)) return input.preferred
  for (const p of input.order && input.order.length ? input.order : input.liveProviders) {
    if (eligible(p)) return p
  }
  return null
}
