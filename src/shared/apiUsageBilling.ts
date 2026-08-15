/**
 * User-entered, non-secret billing readings for API providers whose consoles
 * do not expose a stable machine-readable usage endpoint. API keys remain in
 * their dedicated encrypted stores; this shape is safe to project to the main
 * renderer because it contains only amounts, currency codes, labels and dates.
 */

export const API_USAGE_BILLING_CURRENCIES = ['USD', 'EUR', 'GBP'] as const

export type ApiUsageBillingCurrency = (typeof API_USAGE_BILLING_CURRENCIES)[number]

export interface DeepSeekApiUsageBilling {
  totalTopUp?: number
  monthlyBudgetUsd?: number
}

export interface CerebrasApiUsageBilling {
  purchasedCredits?: number
  currentBalance?: number
  currency?: ApiUsageBillingCurrency
  monthlyBudgetUsd?: number
}

export interface MetaApiUsageBilling {
  preloadCredits?: number
  remainingBalance?: number
  paymentThreshold?: number
  spent?: number
  currency?: ApiUsageBillingCurrency
  resetAt?: string
  planName?: string
  monthlyBudgetUsd?: number
  anchorUpdatedAt?: string
}

export interface ApiUsageBillingSettings {
  deepseek?: DeepSeekApiUsageBilling
  cerebras?: CerebrasApiUsageBilling
  meta?: MetaApiUsageBilling
}

const MAX_BILLING_AMOUNT = 1_000_000_000_000
const MAX_MONTHLY_BUDGET_USD = 1_000_000
const MAX_PLAN_NAME_LENGTH = 64

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function amount(
  value: unknown,
  options: { positive?: boolean; maximum?: number } = {}
): number | undefined {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined
  if (typeof value === 'string' && !value.trim()) return undefined
  const parsed = Number(value)
  const minimumAccepted = options.positive ? parsed > 0 : parsed >= 0
  const maximum = options.maximum ?? MAX_BILLING_AMOUNT
  return Number.isFinite(parsed) && minimumAccepted && parsed <= maximum ? parsed : undefined
}

function currency(value: unknown): ApiUsageBillingCurrency | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim().toUpperCase()
  return API_USAGE_BILLING_CURRENCIES.includes(normalized as ApiUsageBillingCurrency)
    ? (normalized as ApiUsageBillingCurrency)
    : undefined
}

function isoDate(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim() || value.length > 64) return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined
}

function planName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (!normalized || normalized.length > MAX_PLAN_NAME_LENGTH) return undefined
  for (const character of normalized) {
    const codePoint = character.codePointAt(0) ?? 0
    if (codePoint <= 0x1f || codePoint === 0x7f) return undefined
  }
  return normalized
}

function present<T extends object>(value: T): T | undefined {
  return Object.keys(value).length > 0 ? value : undefined
}

/**
 * Normalize an untrusted settings patch into the exact display-only schema.
 * Unknown keys are discarded so a renderer cannot smuggle credentials into
 * the ordinary plaintext settings file under this feature's namespace.
 */
export function normalizeApiUsageBillingSettings(
  value: unknown
): ApiUsageBillingSettings | undefined {
  const input = record(value)
  if (!input) return undefined

  const deepseekInput = record(input.deepseek)
  const deepseek = deepseekInput
    ? present<DeepSeekApiUsageBilling>({
        ...(amount(deepseekInput.totalTopUp, { positive: true }) !== undefined
          ? { totalTopUp: amount(deepseekInput.totalTopUp, { positive: true }) }
          : {}),
        ...(amount(deepseekInput.monthlyBudgetUsd, {
          positive: true,
          maximum: MAX_MONTHLY_BUDGET_USD
        }) !== undefined
          ? {
              monthlyBudgetUsd: amount(deepseekInput.monthlyBudgetUsd, {
                positive: true,
                maximum: MAX_MONTHLY_BUDGET_USD
              })
            }
          : {})
      })
    : undefined

  const cerebrasInput = record(input.cerebras)
  const cerebrasCurrency = currency(cerebrasInput?.currency)
  const cerebras = cerebrasInput
    ? present<CerebrasApiUsageBilling>({
        ...(amount(cerebrasInput.purchasedCredits, { positive: true }) !== undefined
          ? { purchasedCredits: amount(cerebrasInput.purchasedCredits, { positive: true }) }
          : {}),
        ...(amount(cerebrasInput.currentBalance) !== undefined
          ? { currentBalance: amount(cerebrasInput.currentBalance) }
          : {}),
        ...(cerebrasCurrency ? { currency: cerebrasCurrency } : {}),
        ...(amount(cerebrasInput.monthlyBudgetUsd, {
          positive: true,
          maximum: MAX_MONTHLY_BUDGET_USD
        }) !== undefined
          ? {
              monthlyBudgetUsd: amount(cerebrasInput.monthlyBudgetUsd, {
                positive: true,
                maximum: MAX_MONTHLY_BUDGET_USD
              })
            }
          : {})
      })
    : undefined

  const metaInput = record(input.meta)
  const metaCurrency = currency(metaInput?.currency)
  const metaResetAt = isoDate(metaInput?.resetAt)
  const metaAnchorUpdatedAt = isoDate(metaInput?.anchorUpdatedAt)
  const metaPlanName = planName(metaInput?.planName)
  const meta = metaInput
    ? present<MetaApiUsageBilling>({
        ...(amount(metaInput.preloadCredits, { positive: true }) !== undefined
          ? { preloadCredits: amount(metaInput.preloadCredits, { positive: true }) }
          : {}),
        ...(amount(metaInput.remainingBalance) !== undefined
          ? { remainingBalance: amount(metaInput.remainingBalance) }
          : {}),
        ...(amount(metaInput.paymentThreshold, { positive: true }) !== undefined
          ? { paymentThreshold: amount(metaInput.paymentThreshold, { positive: true }) }
          : {}),
        ...(amount(metaInput.spent) !== undefined ? { spent: amount(metaInput.spent) } : {}),
        ...(metaCurrency ? { currency: metaCurrency } : {}),
        ...(metaResetAt ? { resetAt: metaResetAt } : {}),
        ...(metaPlanName ? { planName: metaPlanName } : {}),
        ...(amount(metaInput.monthlyBudgetUsd, {
          positive: true,
          maximum: MAX_MONTHLY_BUDGET_USD
        }) !== undefined
          ? {
              monthlyBudgetUsd: amount(metaInput.monthlyBudgetUsd, {
                positive: true,
                maximum: MAX_MONTHLY_BUDGET_USD
              })
            }
          : {}),
        ...(metaAnchorUpdatedAt ? { anchorUpdatedAt: metaAnchorUpdatedAt } : {})
      })
    : undefined

  return present<ApiUsageBillingSettings>({
    ...(deepseek ? { deepseek } : {}),
    ...(cerebras ? { cerebras } : {}),
    ...(meta ? { meta } : {})
  })
}

export function hasApiUsageBillingProvider(
  settings: ApiUsageBillingSettings | null | undefined,
  provider: keyof ApiUsageBillingSettings
): boolean {
  return Boolean(settings?.[provider] && Object.keys(settings[provider] as object).length > 0)
}
