/**
 * Devin subscription-plan model access.
 *
 * A free Devin plan may run only SWE-1.6 Slow; the rest of the catalogue is
 * paid. TaskWraith therefore offers a free seat exactly one row instead of
 * letting the picker advertise 24 families the account cannot dispatch.
 *
 * The gate is deliberately FAIL-OPEN. `freePlan` must be positively observed
 * before anything is withheld: an unreadable plan cache, a signed-out client,
 * a shape this parser does not recognise, or a plan TaskWraith has never seen
 * all leave the full catalogue in place. Narrowing a paying user's catalogue
 * because a local SQLite cache was mid-write is a worse failure than showing a
 * free user a row their plan will reject, so the uncertain case resolves
 * towards capability rather than away from it.
 *
 * Detection lives in DevinUsage (the desktop client's cached plan info); this
 * module is the pure policy that consumes the resulting flag.
 */

import { DEVIN_DEFAULT_MODEL_ID } from './devinModelCatalog'

/**
 * Ids a free Devin plan may select. `swe-1-6-slow` is also
 * DEVIN_DEFAULT_MODEL_ID, so a gated seat never needs a different default.
 */
export const DEVIN_FREE_PLAN_MODEL_IDS: ReadonlySet<string> = new Set([DEVIN_DEFAULT_MODEL_ID])

export interface DevinPlanAccess {
  /** True only when a Devin-owned plan blob positively reported a free plan. */
  freePlan?: boolean
}

function normalizedId(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

/** True when `access` positively establishes a gated (free) plan. */
export function isDevinFreePlanGated(access?: DevinPlanAccess | null): boolean {
  return access?.freePlan === true
}

/**
 * True when the plan may select `modelId`. Ungated plans may select anything,
 * including custom ids that pass through to `devin acp --model` verbatim.
 */
export function isDevinModelAllowedForPlan(
  modelId: unknown,
  access?: DevinPlanAccess | null
): boolean {
  if (!isDevinFreePlanGated(access)) return true
  const id = normalizedId(modelId)
  if (!id) return false
  return DEVIN_FREE_PLAN_MODEL_IDS.has(id)
}

/**
 * Reduce catalogue rows to what the plan may select. Order is preserved, and
 * an ungated plan gets the list back untouched.
 */
export function filterDevinModelsForPlan<T extends { id?: unknown }>(
  rows: readonly (T | null | undefined)[],
  access?: DevinPlanAccess | null
): T[] {
  if (!Array.isArray(rows)) return []
  const gated = isDevinFreePlanGated(access)
  return rows.filter((row): row is T => {
    if (!row || typeof row !== 'object') return false
    if (!gated) return true
    return isDevinModelAllowedForPlan((row as { id?: unknown }).id, access)
  })
}

/**
 * Clamp a selected or persisted model onto what the plan may run. A gated seat
 * carrying a paid model — persisted before the plan lapsed, or restored from
 * another seat — resolves to SWE-1.6 Slow rather than dispatching a model the
 * plan will refuse.
 */
export function clampDevinModelForPlan(modelId: unknown, access?: DevinPlanAccess | null): string {
  const id = typeof modelId === 'string' ? modelId.trim() : ''
  if (!isDevinFreePlanGated(access)) return id || DEVIN_DEFAULT_MODEL_ID
  return isDevinModelAllowedForPlan(id, access) ? id : DEVIN_DEFAULT_MODEL_ID
}
