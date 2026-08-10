/**
 * Muse soft calendar-month spend budget (advisory only).
 *
 * Resets on the 1st of each month via {@link buildProviderCalendarMonthSpend}.
 * Never blocks a run — TaskWraith cannot see Meta billing, so the hard
 * ceiling belongs with the user's Meta / Model API budget controls.
 *
 * `undefined` in settings means "use this default"; explicit `null` clears
 * the Model Usage budget meter.
 */
export const DEFAULT_MUSE_MONTHLY_SPEND_CAP_USD = 15

/** Resolve the effective Muse soft cap for meters and Settings display. */
export function resolveMuseMonthlySpendCapUsd(value: number | null | undefined): number | null {
  if (value === undefined) return DEFAULT_MUSE_MONTHLY_SPEND_CAP_USD
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
  return null
}
