import {
  normalizeApiUsageBillingSettings,
  type ApiUsageBillingCurrency,
  type ApiUsageBillingSettings
} from '../../../shared/apiUsageBilling'

export interface ApiUsageBillingDrafts {
  deepseekTotalTopUp: string
  deepseekMonthlyBudgetUsd: string
  deepseekResetAt: string
  cerebrasPurchasedCredits: string
  cerebrasCurrentBalance: string
  cerebrasCurrency: ApiUsageBillingCurrency
  cerebrasMonthlyBudgetUsd: string
  cerebrasResetAt: string
  metaPreloadCredits: string
  metaRemainingBalance: string
  metaPaymentThreshold: string
  metaSpent: string
  metaCurrency: ApiUsageBillingCurrency
  metaResetAt: string
  metaPlanName: string
  metaMonthlyBudgetUsd: string
  openrouterMonthlyBudgetUsd: string
  openrouterCurrency: ApiUsageBillingCurrency
  openrouterResetAt: string
}

export const EMPTY_API_USAGE_BILLING_DRAFTS: ApiUsageBillingDrafts = {
  deepseekTotalTopUp: '',
  deepseekMonthlyBudgetUsd: '',
  deepseekResetAt: '',
  cerebrasPurchasedCredits: '',
  cerebrasCurrentBalance: '',
  cerebrasCurrency: 'USD',
  cerebrasMonthlyBudgetUsd: '',
  cerebrasResetAt: '',
  metaPreloadCredits: '',
  metaRemainingBalance: '',
  metaPaymentThreshold: '',
  metaSpent: '',
  metaCurrency: 'USD',
  metaResetAt: '',
  metaPlanName: '',
  metaMonthlyBudgetUsd: '',
  openrouterMonthlyBudgetUsd: '',
  openrouterCurrency: 'USD',
  openrouterResetAt: ''
}

function draftNumber(value: number | undefined): string {
  return value === undefined ? '' : String(value)
}

export function apiUsageBillingDraftsFromSettings(
  settings: ApiUsageBillingSettings | null | undefined
): ApiUsageBillingDrafts {
  return {
    deepseekTotalTopUp: draftNumber(settings?.deepseek?.totalTopUp),
    deepseekMonthlyBudgetUsd: draftNumber(settings?.deepseek?.monthlyBudgetUsd),
    deepseekResetAt: settings?.deepseek?.resetAt?.slice(0, 10) ?? '',
    cerebrasPurchasedCredits: draftNumber(settings?.cerebras?.purchasedCredits),
    cerebrasCurrentBalance: draftNumber(settings?.cerebras?.currentBalance),
    cerebrasCurrency: settings?.cerebras?.currency ?? 'USD',
    cerebrasMonthlyBudgetUsd: draftNumber(settings?.cerebras?.monthlyBudgetUsd),
    cerebrasResetAt: settings?.cerebras?.resetAt?.slice(0, 10) ?? '',
    metaPreloadCredits: draftNumber(settings?.meta?.preloadCredits),
    metaRemainingBalance: draftNumber(settings?.meta?.remainingBalance),
    metaPaymentThreshold: draftNumber(settings?.meta?.paymentThreshold),
    metaSpent: draftNumber(settings?.meta?.spent),
    metaCurrency: settings?.meta?.currency ?? 'USD',
    metaResetAt: settings?.meta?.resetAt?.slice(0, 10) ?? '',
    metaPlanName: settings?.meta?.planName ?? '',
    metaMonthlyBudgetUsd: draftNumber(settings?.meta?.monthlyBudgetUsd),
    openrouterMonthlyBudgetUsd: draftNumber(settings?.openrouter?.monthlyBudgetUsd),
    openrouterCurrency: settings?.openrouter?.currency ?? 'USD',
    openrouterResetAt: settings?.openrouter?.resetAt?.slice(0, 10) ?? ''
  }
}

function optionalAmount(value: string, label: string, positive = false): number | undefined {
  const trimmed = value.trim()
  if (!trimmed) return undefined
  const parsed = Number(trimmed)
  if (!Number.isFinite(parsed) || (positive ? parsed <= 0 : parsed < 0)) {
    throw new Error(`${label} must be ${positive ? 'greater than zero' : 'zero or greater'}.`)
  }
  return parsed
}

function canonicalResetDate(value: string, label = 'Meta'): string | undefined {
  const trimmed = value.trim()
  if (!trimmed) return undefined
  const parsed = Date.parse(`${trimmed}T00:00:00.000Z`)
  if (!Number.isFinite(parsed)) throw new Error(`${label} reset date is invalid.`)
  return new Date(parsed).toISOString()
}

function metaAnchorSignature(settings: ApiUsageBillingSettings['meta'] | undefined): string {
  return JSON.stringify({
    preloadCredits: settings?.preloadCredits,
    remainingBalance: settings?.remainingBalance,
    paymentThreshold: settings?.paymentThreshold,
    spent: settings?.spent,
    currency: settings?.currency,
    resetAt: settings?.resetAt
  })
}

/** Turn form drafts into the exact display-only settings schema. */
export function apiUsageBillingFromDrafts(
  drafts: ApiUsageBillingDrafts,
  previous: ApiUsageBillingSettings | null | undefined,
  now = Date.now()
): ApiUsageBillingSettings | undefined {
  const deepseek = {
    totalTopUp: optionalAmount(drafts.deepseekTotalTopUp, 'DeepSeek total top-up', true),
    monthlyBudgetUsd: optionalAmount(
      drafts.deepseekMonthlyBudgetUsd,
      'DeepSeek monthly budget',
      true
    ),
    resetAt: canonicalResetDate(drafts.deepseekResetAt, 'DeepSeek')
  }

  const cerebrasPurchasedCredits = optionalAmount(
    drafts.cerebrasPurchasedCredits,
    'Cerebras purchased credits',
    true
  )
  const cerebrasCurrentBalance = optionalAmount(
    drafts.cerebrasCurrentBalance,
    'Cerebras current balance'
  )
  if ((cerebrasPurchasedCredits === undefined) !== (cerebrasCurrentBalance === undefined)) {
    throw new Error('Enter both Cerebras purchased credits and current balance, or clear both.')
  }
  const cerebrasMonthlyBudgetUsd = optionalAmount(
    drafts.cerebrasMonthlyBudgetUsd,
    'Cerebras monthly budget',
    true
  )
  const cerebrasResetAt = canonicalResetDate(drafts.cerebrasResetAt, 'Cerebras')
  const cerebrasHasReading =
    cerebrasPurchasedCredits !== undefined ||
    cerebrasMonthlyBudgetUsd !== undefined ||
    cerebrasResetAt !== undefined
  const cerebras = cerebrasHasReading
    ? {
        purchasedCredits: cerebrasPurchasedCredits,
        currentBalance: cerebrasCurrentBalance,
        currency: drafts.cerebrasCurrency,
        monthlyBudgetUsd: cerebrasMonthlyBudgetUsd,
        resetAt: cerebrasResetAt
      }
    : undefined

  const metaBase = {
    preloadCredits: optionalAmount(drafts.metaPreloadCredits, 'Meta preload credit', true),
    remainingBalance: optionalAmount(drafts.metaRemainingBalance, 'Meta remaining balance'),
    paymentThreshold: optionalAmount(drafts.metaPaymentThreshold, 'Meta payment threshold', true),
    spent: optionalAmount(drafts.metaSpent, 'Meta spend'),
    currency: drafts.metaCurrency,
    resetAt: canonicalResetDate(drafts.metaResetAt),
    planName: drafts.metaPlanName.trim() || undefined,
    monthlyBudgetUsd: optionalAmount(drafts.metaMonthlyBudgetUsd, 'Meta monthly budget', true)
  }
  const metaHasReading = Object.entries(metaBase).some(
    ([key, value]) => key !== 'currency' && value !== undefined
  )
  const metaWithoutTimestamp = metaHasReading ? metaBase : undefined
  const anchorChanged =
    metaWithoutTimestamp !== undefined &&
    metaAnchorSignature(metaWithoutTimestamp) !== metaAnchorSignature(previous?.meta)
  const meta = metaWithoutTimestamp
    ? {
        ...metaWithoutTimestamp,
        ...(anchorChanged
          ? { anchorUpdatedAt: new Date(now).toISOString() }
          : previous?.meta?.anchorUpdatedAt
            ? { anchorUpdatedAt: previous.meta.anchorUpdatedAt }
            : {})
      }
    : undefined

  const openrouterMonthlyBudgetUsd = optionalAmount(
    drafts.openrouterMonthlyBudgetUsd,
    'OpenRouter monthly budget',
    true
  )
  const openrouterResetAt = canonicalResetDate(drafts.openrouterResetAt, 'OpenRouter')
  const openrouterHasReading =
    openrouterMonthlyBudgetUsd !== undefined || openrouterResetAt !== undefined
  const openrouter = openrouterHasReading
    ? {
        monthlyBudgetUsd: openrouterMonthlyBudgetUsd,
        currency: drafts.openrouterCurrency,
        resetAt: openrouterResetAt
      }
    : undefined

  return normalizeApiUsageBillingSettings({
    deepseek,
    cerebras,
    meta,
    openrouter
  })
}

export function configuredApiUsageProviderCount(
  settings: ApiUsageBillingSettings | null | undefined
): number {
  return ['deepseek', 'cerebras', 'meta', 'openrouter'].filter(
    (provider) => settings?.[provider as keyof ApiUsageBillingSettings]
  ).length
}
