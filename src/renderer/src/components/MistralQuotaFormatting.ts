import { formatCostAlwaysOn, getFxRatesPerUsd, type DisplayCurrency } from '../lib/formatCost'

function formatConvertedCurrency(
  value: number,
  currency: DisplayCurrency,
  locale: string | undefined,
  fractionDigits: number
): string {
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits
    }).format(value)
  } catch {
    const symbol = currency === 'USD' ? '$' : currency === 'GBP' ? '£' : '€'
    return `${symbol}${value.toFixed(fractionDigits)}`
  }
}

function convertedFromUsd(usd: number, currency: DisplayCurrency): number {
  const rate = getFxRatesPerUsd()[currency]
  return Math.max(0, usd) * (Number.isFinite(rate) && rate > 0 ? rate : 1)
}

/**
 * Keep the normal two-decimal house format unless it would hide a real local
 * increment. Devstral Small often costs less than one display-currency cent per
 * turn; in that case expand only as far as needed (max four decimals) so the
 * compact sidebar value visibly moves instead of looking frozen for hours.
 */
export function formatMistralAccumulatedSpend(
  spentUsd: number,
  locallyEstimatedSinceReadingUsd: number,
  currency: DisplayCurrency = 'USD',
  locale?: string
): string {
  const standard = formatCostAlwaysOn(spentUsd, currency, locale)
  if (
    !Number.isFinite(spentUsd) ||
    spentUsd <= 0 ||
    !Number.isFinite(locallyEstimatedSinceReadingUsd) ||
    locallyEstimatedSinceReadingUsd <= 0
  ) {
    return standard
  }

  const total = convertedFromUsd(spentUsd, currency)
  const baseline = convertedFromUsd(
    Math.max(0, spentUsd - locallyEstimatedSinceReadingUsd),
    currency
  )
  const rounded = (value: number, digits: number): number => Math.round(value * 10 ** digits)
  if (!standard.startsWith('<') && rounded(total, 2) !== rounded(baseline, 2)) return standard

  let digits = 3
  while (digits < 4 && rounded(total, digits) === rounded(baseline, digits)) digits += 1
  return formatConvertedCurrency(total, currency, locale, digits)
}

/** The explanatory delta always gets enough precision to show cheap turns. */
export function formatMistralLocalIncrement(
  usd: number,
  currency: DisplayCurrency = 'USD',
  locale?: string
): string {
  const converted = convertedFromUsd(usd, currency)
  const digits = converted >= 0.01 ? 2 : converted >= 0.001 ? 3 : 4
  return formatConvertedCurrency(converted, currency, locale, digits)
}
