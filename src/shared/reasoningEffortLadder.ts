/**
 * The one canonical ordering for TaskWraith's internal reasoning-effort
 * tokens.
 *
 * Before this module the order was implicit: each ladder was assembled by
 * append order and every provider kept its own set of "top tier" tokens. That
 * worked while the top of the ladder was stable. It stopped working when
 * Codex introduced `persistent`, which the CLI's own effort enum places above
 * `ultra` (verified 2026-09-03 in Codex CLI 0.153.0: `none, minimal, low,
 * medium, high, xhigh, max, ultra, persistent`).
 *
 * `persistent` sits ABOVE `ultracode` (TaskWraith's internal token for Codex's
 * `ultra`) and BELOW `ultratask`, which remains the top of the ladder. Any
 * ladder that renders or clamps efforts must agree on that, so the order lives
 * here once and is applied rather than re-stated.
 */

export const REASONING_EFFORT_LADDER = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultracode',
  'persistent',
  'ultratask'
] as const

export type ReasoningEffortToken = (typeof REASONING_EFFORT_LADDER)[number]

/**
 * Inbound spellings that mean an existing rung. `ultra` is the Codex catalog's
 * name for the tier TaskWraith calls `ultracode`; the rest are legacy or
 * provider-local spellings already accepted elsewhere.
 */
const REASONING_EFFORT_ALIASES: Readonly<Record<string, ReasoningEffortToken>> = {
  off: 'none',
  light: 'low',
  extra: 'xhigh',
  maximum: 'max',
  ultra: 'ultracode',
  ultratask: 'ultratask'
}

const LADDER_RANK: ReadonlyMap<string, number> = new Map(
  REASONING_EFFORT_LADDER.map((token, index) => [token, index])
)

/** Lowercase/trim an effort and resolve aliases; null when off-ladder. */
export function normalizeReasoningEffortToken(value: unknown): ReasoningEffortToken | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  if (!normalized) return null
  const aliased = REASONING_EFFORT_ALIASES[normalized] ?? normalized
  return LADDER_RANK.has(aliased) ? (aliased as ReasoningEffortToken) : null
}

/** Position on the canonical ladder, or null when the token is off-ladder. */
export function reasoningEffortRank(value: unknown): number | null {
  const token = normalizeReasoningEffortToken(value)
  return token == null ? null : (LADDER_RANK.get(token) as number)
}

/**
 * Order two efforts by the canonical ladder. Off-ladder tokens sort after every
 * known rung rather than being dropped, so an unrecognised tier stays visible
 * instead of silently vanishing from a picker.
 */
export function compareReasoningEffort(a: unknown, b: unknown): number {
  const rankA = reasoningEffortRank(a)
  const rankB = reasoningEffortRank(b)
  if (rankA == null && rankB == null) return 0
  if (rankA == null) return 1
  if (rankB == null) return -1
  return rankA - rankB
}

/** Stable sort of arbitrary rows onto the canonical ladder. */
export function sortByReasoningEffortLadder<T>(
  rows: readonly T[],
  effortOf: (row: T) => unknown
): T[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const byLadder = compareReasoningEffort(effortOf(a.row), effortOf(b.row))
      return byLadder !== 0 ? byLadder : a.index - b.index
    })
    .map((entry) => entry.row)
}

/**
 * True for the tiers above `xhigh`. Every provider whose wire enum tops out at
 * `xhigh` clamps this set to its ceiling rather than dropping the token — a
 * dropped token falls back to the model default, which is a silent downgrade.
 */
export function isAboveXhighReasoningEffort(value: unknown): boolean {
  const rank = reasoningEffortRank(value)
  const xhigh = LADDER_RANK.get('xhigh') as number
  return rank != null && rank > xhigh
}
