/**
 * 1.0.5-EW25 — Cost display formatter with user-selectable currency.
 *
 * Provider event payloads emit `cost_usd` verbatim (set in
 * `src/main/index.ts` at the run-stats accumulation site). This
 * module converts that USD value into the user's preferred display
 * currency (USD / GBP / EUR), with sensible "tiny amount" floors
 * so a $0.003 turn doesn't render as the slightly-misleading
 * `$0.00`.
 *
 * **Rates are STATIC approximations.** Live FX lookup is deferred
 * to 1.0.6 sub-slice c per the maintainer's release plan. The constants
 * below are accurate as of 2026-05-27 (approximate spot rates);
 * update them periodically until live-fetch lands. Hardcoded
 * single-direction rates intentionally — we only ever convert
 * USD → other, never the reverse, because providers always
 * report in USD.
 *
 * Locale handling: `Intl.NumberFormat` defaults to the user's
 * system locale for grouping/decimal separators, but the
 * currency code is always pinned. So a French user with
 * currency=USD sees `1 234,56 $US`; a UK user with currency=GBP
 * sees `£1,234.56`. Reasonable across all locales.
 */

export type DisplayCurrency = 'USD' | 'GBP' | 'EUR'

// 1.0.5-EW25 — Static FX rates, USD-relative. These are the
// fallback constants used when the live-fetch service hasn't
// hydrated yet, or when both live fetch + cache file fail.
//
// 1.0.5-EW35 — Currency sub-slice (c): rates can now be hot-
// swapped at runtime via `setFxRatesPerUsd`. The renderer
// hydrates this map from `window.api.getFxRates()` on app boot;
// main-side `FxRateService` keeps the cache fresh in the
// background (12h interval). USD is always 1.
const FX_RATES_PER_USD: Record<DisplayCurrency, number> = {
  USD: 1,
  GBP: 0.79, // approx mid-2026 spot (baked-in fallback)
  EUR: 0.92 // approx mid-2026 spot (baked-in fallback)
}

/**
 * 1.0.5-EW35 — Hot-swap entry point for the live-fetched FX rate
 * snapshot. Called from `App.tsx` after the renderer reads
 * `window.api.getFxRates()`. Mutates the module-level map in place
 * so existing callers don't need to re-import — subsequent
 * `formatCost` calls just pick up the new numbers.
 *
 * Defensive: only accepts finite positive numbers; silently drops
 * malformed values so a corrupted snapshot can't break rendering.
 * USD is pinned to 1 — even if a (broken) live source returns a
 * non-1 USD rate we ignore it; the whole table is USD-relative.
 */
export function setFxRatesPerUsd(partial: Partial<Record<DisplayCurrency, number>>): void {
  if (!partial || typeof partial !== 'object') return
  for (const key of ['GBP', 'EUR'] as const) {
    const value = partial[key]
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      FX_RATES_PER_USD[key] = value
    }
  }
}

/**
 * 1.0.5-EW35 — Read-side accessor for tests + debug. Returns a
 * defensive shallow copy so callers can't mutate the module's
 * internal map.
 */
export function getFxRatesPerUsd(): Record<DisplayCurrency, number> {
  return { ...FX_RATES_PER_USD }
}

// Per-currency floor for "tiny but non-zero" amounts. Pre-EW25
// the codebase rendered `<$0.01` to avoid a misleading `$0.00`
// when a turn cost was just below 1 cent; we mirror that floor
// in the user's chosen currency so the behaviour is consistent.
const FLOORS: Record<DisplayCurrency, { threshold: number; label: string }> = {
  USD: { threshold: 0.01, label: '<$0.01' },
  GBP: { threshold: 0.01, label: '<£0.01' },
  EUR: { threshold: 0.01, label: '<€0.01' }
}

/**
 * 1.0.5-EW34 — Conservative-overestimate bias cap. Slider in Settings
 * → General is constrained to 0-25; we re-clamp here so a malformed
 * stored value can't break rendering. 25% is enough to cover most
 * "I want my displayed bill to comfortably over-shoot the real one"
 * cases without painting wildly-misleading numbers.
 */
const OVERESTIMATE_PERCENT_MIN = 0
const OVERESTIMATE_PERCENT_MAX = 25

function clampOverestimate(percent: number | undefined): number {
  if (!Number.isFinite(percent ?? 0)) return 0
  const p = percent ?? 0
  if (p < OVERESTIMATE_PERCENT_MIN) return OVERESTIMATE_PERCENT_MIN
  if (p > OVERESTIMATE_PERCENT_MAX) return OVERESTIMATE_PERCENT_MAX
  return p
}

/**
 * Format a USD amount for display in the user's chosen currency.
 *
 * Returns:
 *  - `''` for non-finite / non-positive amounts (callers depend
 *    on this falsy check to decide whether to render the cost
 *    segment at all — preserves pre-EW25 behaviour).
 *  - The per-currency "tiny" label (e.g. `<£0.01`) for
 *    positive-but-sub-floor amounts.
 *  - A properly localised currency string for everything else.
 *
 * @param usd  Original USD value from provider event payload.
 * @param currency  User's selected display currency.
 * @param locale  Optional locale override. Defaults to system locale
 *                (`undefined` → `Intl.NumberFormat` picks the
 *                browser/Electron locale).
 * @param overestimatePercent  1.0.5-EW34 — Conservative-overestimate
 *   bias percent (sub-slice e). When non-zero, the USD figure is
 *   multiplied by `1 + (clamped / 100)` BEFORE FX conversion so the
 *   bias is currency-agnostic. Clamped to 0-25. Default 0 (no bias —
 *   identical to pre-EW34 behaviour).
 */
export interface FormatCostOptions {
  truncateOneDecimal?: boolean
}

export function formatCost(
  usd: number,
  currency: DisplayCurrency = 'USD',
  locale?: string,
  overestimatePercent: number = 0,
  options?: FormatCostOptions
): string {
  if (!Number.isFinite(usd) || usd <= 0) return ''
  // Apply the overestimate first (in USD-space) so the bias is
  // currency-agnostic — a 5% bias means "5% more cost" regardless
  // of whether the user is viewing in USD / GBP / EUR. We also
  // apply it BEFORE the floor check because if a bias actually
  // pushes a tiny amount past the 1¢ floor (e.g. $0.0099 at +5%
  // = $0.0104), the user expects to see the real biased number
  // rather than the "tiny" label.
  const bias = clampOverestimate(overestimatePercent)
  const biased = bias > 0 ? usd * (1 + bias / 100) : usd
  const rate = FX_RATES_PER_USD[currency] ?? 1
  const converted = biased * rate
  const floor = FLOORS[currency]
  if (converted < floor.threshold) return floor.label

  const truncate = options?.truncateOneDecimal
  const finalValue = truncate ? Math.floor(converted * 10) / 10 : converted
  const fractionDigits = truncate ? 1 : 2

  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits
    }).format(finalValue)
  } catch {
    // Fallback for environments without full ICU — render the
    // bare number with a currency-prefix symbol. Shouldn't fire
    // in normal Electron, but keeps us robust.
    const symbol = currency === 'USD' ? '$' : currency === 'GBP' ? '£' : '€'
    return `${symbol}${finalValue.toFixed(fractionDigits)}`
  }
}

/**
 * Format a USD amount as the "always-visible" cumulative chip
 * variant — same as `formatCost` but returns the per-currency
 * `0.00` placeholder when the amount is zero/missing instead of
 * an empty string. Used by the chat-level cumulative chip
 * (1.0.5-EW26) where we want a persistent surface even before
 * any tokens have been spent, so the user knows the chip exists.
 */
export function formatCostAlwaysOn(
  usd: number,
  currency: DisplayCurrency = 'USD',
  locale?: string,
  overestimatePercent: number = 0
): string {
  const formatted = formatCost(usd, currency, locale, overestimatePercent)
  if (formatted) return formatted
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(0)
  } catch {
    const symbol = currency === 'USD' ? '$' : currency === 'GBP' ? '£' : '€'
    return `${symbol}0.00`
  }
}
