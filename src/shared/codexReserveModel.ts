/**
 * Codex "reserve" model policy.
 *
 * `gpt-reserve` is a real, first-class row in the Codex `model/list` catalog,
 * but it ships with `hidden: true` so it never reaches a picker by default.
 * Verified 2026-09-03 against Codex CLI 0.153.0: with
 * `model/list { includeHidden: true }` the row comes back with metadata
 * byte-identical to `gpt-5.6-luna` (same description, same low..max effort
 * ladder, same medium default, same `priority`/Fast service tier). It is Luna
 * drawn from a separate allowance rather than a distinct model.
 *
 * The ChatGPT desktop app activates the same allowance only when the account
 * actually holds it — a `gpt-reserve` limit with headroom, surfaced alongside a
 * `luna_reserve` upsell banner. This module is the equivalent gate for
 * TaskWraith: the row is revealed when a live grant is observed and stays
 * hidden otherwise, so an unusable model never reaches the picker.
 *
 * Every other discovery-hidden row (for example `codex-auto-review`, the
 * internal approval-review model) stays hidden unconditionally.
 */

export const CODEX_RESERVE_MODEL_ID = 'gpt-reserve'

const LUNA_RESERVE_BANNER_TYPE = 'luna_reserve'

function normalizedToken(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function record(value: unknown): Record<string, any> | null {
  return value && typeof value === 'object' ? (value as Record<string, any>) : null
}

/** True for the reserve model slug, tolerating case and surrounding padding. */
export function isCodexReserveModelId(value: unknown): boolean {
  return normalizedToken(value) === normalizedToken(CODEX_RESERVE_MODEL_ID)
}

/**
 * True for the names the reserve allowance is known by. `wham`/usage names the
 * bucket by its hidden model slug; the ChatGPT surface brands the same bucket
 * "Luna Reserve".
 */
export function isCodexReserveLimitName(value: unknown): boolean {
  const normalized = normalizedToken(value)
  if (!normalized) return false
  return (
    normalized === normalizedToken(CODEX_RESERVE_MODEL_ID) || normalized.includes('lunareserve')
  )
}

function windowHasHeadroom(windowEntry: unknown): boolean {
  const entry = record(windowEntry)
  if (!entry) return false
  const used = entry.usedPercent ?? entry.used_percent
  return typeof used === 'number' && Number.isFinite(used) && used < 100
}

function bucketHasHeadroom(bucket: unknown): boolean {
  const entry = record(bucket)
  if (!entry) return false
  const limit = record(entry.rate_limit) ?? record(entry.rateLimit) ?? entry
  return windowHasHeadroom(limit.primary) || windowHasHeadroom(limit.secondary)
}

/**
 * True when the account currently holds a usable reserve allowance.
 *
 * Conservative by construction: an unreadable payload, a missing bucket, or a
 * spent bucket all resolve to `false`, so the hidden row stays hidden unless a
 * grant is positively observed.
 */
export function codexReserveGrantActive(payload: unknown): boolean {
  const root = record(payload)
  if (!root) return false

  const upsell = record(root.rateLimitUpsell) ?? record(root.rate_limit_upsell)
  const bannerType = upsell?.banner_type ?? upsell?.bannerType
  if (normalizedToken(bannerType) === normalizedToken(LUNA_RESERVE_BANNER_TYPE)) return true

  const byLimitId = record(root.rateLimitsByLimitId) ?? record(root.rate_limits_by_limit_id)
  if (byLimitId) {
    for (const [key, bucket] of Object.entries(byLimitId)) {
      const entry = record(bucket)
      const names = [key, entry?.limitId, entry?.limit_id, entry?.limitName, entry?.limit_name]
      if (names.some((name) => isCodexReserveLimitName(name)) && bucketHasHeadroom(bucket)) {
        return true
      }
    }
  }

  const additional = Array.isArray(root.additional_rate_limits)
    ? root.additional_rate_limits
    : Array.isArray(root.additionalRateLimits)
      ? root.additionalRateLimits
      : []
  for (const bucket of additional) {
    const entry = record(bucket)
    const names = [entry?.limit_name, entry?.limitName, entry?.limitId, entry?.limit_id]
    if (names.some((name) => isCodexReserveLimitName(name)) && bucketHasHeadroom(bucket)) {
      return true
    }
  }

  return false
}

/**
 * Reduce live `model/list` rows to the set a picker may show.
 *
 * Replaces a blanket `!row.hidden` filter: visible rows always survive, the
 * reserve row survives only while a grant is live, and every other hidden row
 * is dropped. Input order is preserved so downstream ordering rules still see
 * the catalog's own sequence.
 */
export function filterCodexDiscoverableModelRows<T extends { id?: unknown; hidden?: unknown }>(
  rows: readonly (T | null | undefined)[],
  options: { reserveGrantActive: boolean }
): T[] {
  if (!Array.isArray(rows)) return []
  return rows.filter((row): row is T => {
    const entry = record(row)
    if (!entry) return false
    if (typeof entry.id !== 'string' || !entry.id.trim()) return false
    if (entry.hidden !== true) return true
    return isCodexReserveModelId(entry.id) && options.reserveGrantActive
  })
}
