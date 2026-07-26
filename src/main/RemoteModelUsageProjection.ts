import type { AppSettings, ProviderId, UsageRecord } from './store/types'

type RemoteDisplayCurrency = 'USD' | 'GBP' | 'EUR'
type SpendWindowId = 'day' | 'week' | 'month'

interface ModelRate {
  modelId: string
  inputUsdPerMillion: number
  outputUsdPerMillion: number
  cachedInputUsdPerMillion?: number
}

type ProviderRates = Partial<Record<ProviderId, ModelRate[]>>

export interface RemoteUsageSpendWindow {
  id: SpendWindowId
  label: string
  totalTokens: number
  runs: number
  costText?: string
}

export interface RemoteUsageSpendProvider {
  provider: ProviderId
  windows: RemoteUsageSpendWindow[]
}

export interface RemoteAntigravityBudget {
  provider: 'antigravity'
  spentText?: string
  capText: string
  usedPercent: number
  resetAt: string
}

export interface RemoteModelUsageExtras {
  spend?: {
    providers: RemoteUsageSpendProvider[]
  }
  antigravityBudget?: RemoteAntigravityBudget
}

export interface RemoteModelUsageProjectionInput {
  records: readonly UsageRecord[]
  settings: Pick<
    AppSettings,
    'currency' | 'currencyOverestimatePercent' | 'antigravityGeminiApiMonthlySpendCapUsd'
  >
  providerRates: unknown
  fxRates: unknown
  now?: number
}

const SPEND_PROVIDER_ORDER: ProviderId[] = [
  'gemini',
  'codex',
  'claude',
  'kimi',
  'grok',
  'cursor',
  'antigravity',
  // The Mistral Vibe seat runs on a plan subscription, so its rows are
  // projected API-equivalent like claude/codex/grok/cursor rather than a real
  // billing basis. Omitting it dropped Mistral spend from the iOS/remote view
  // while the desktop card showed it.
  'mistral'
]

const SPEND_WINDOWS: ReadonlyArray<{ id: SpendWindowId; label: string; durationMs: number }> = [
  { id: 'day', label: 'Day', durationMs: 24 * 60 * 60 * 1000 },
  { id: 'week', label: '7d', durationMs: 7 * 24 * 60 * 60 * 1000 },
  { id: 'month', label: '30d', durationMs: 30 * 24 * 60 * 60 * 1000 }
]

const FALLBACK_FX_RATES_PER_USD: Record<RemoteDisplayCurrency, number> = {
  USD: 1,
  GBP: 0.79,
  EUR: 0.92
}

const COST_FLOORS: Record<RemoteDisplayCurrency, { threshold: number; label: string }> = {
  USD: { threshold: 0.01, label: '<$0.01' },
  GBP: { threshold: 0.01, label: '<£0.01' },
  EUR: { threshold: 0.01, label: '<€0.01' }
}

const DEFAULT_RATE_MODEL_BY_PROVIDER: Partial<Record<ProviderId, string>> = {
  codex: 'gpt-5.5',
  claude: 'claude-sonnet-5',
  gemini: 'gemini-3.1-flash-lite',
  kimi: 'kimi-k2.7-code',
  grok: 'grok-4.5',
  cursor: 'composer-2.5-fast',
  antigravity: 'gemini-api:gemini-2.5-flash'
}

const DEFAULT_MODEL_SENTINELS = new Set(['', 'default', 'cli-default', 'custom', 'best'])
const CODEX_DEFAULT_SENTINELS = new Set(['auto', 'pro', 'flash', 'flash-lite'])

const positiveNumber = (value: unknown): number => {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

function normaliseCurrency(value: unknown): RemoteDisplayCurrency {
  return value === 'GBP' || value === 'EUR' ? value : 'USD'
}

function normaliseFxRates(raw: unknown): Partial<Record<RemoteDisplayCurrency, number>> {
  if (!raw || typeof raw !== 'object') return {}
  const envelope = raw as Record<string, unknown>
  const candidate = envelope.rates && typeof envelope.rates === 'object' ? envelope.rates : raw
  if (!candidate || typeof candidate !== 'object') return {}
  const rates = candidate as Record<string, unknown>
  return Object.fromEntries(
    (['USD', 'GBP', 'EUR'] as const).flatMap((currency) => {
      const rate = positiveNumber(rates[currency])
      return rate > 0 ? [[currency, rate]] : []
    })
  ) as Partial<Record<RemoteDisplayCurrency, number>>
}

function normaliseProviderRates(raw: unknown): ProviderRates {
  if (!raw || typeof raw !== 'object') return {}
  const envelope = raw as Record<string, unknown>
  const tables =
    envelope.baseline && typeof envelope.baseline === 'object'
      ? (envelope.baseline as Record<string, unknown>)
      : envelope
  const result: ProviderRates = {}
  for (const [provider, table] of Object.entries(tables)) {
    const models = Array.isArray(table)
      ? table
      : table && typeof table === 'object'
        ? (table as Record<string, unknown>).models
        : undefined
    if (!Array.isArray(models)) continue
    const parsed = models.flatMap((model) => {
      if (!model || typeof model !== 'object') return []
      const row = model as Record<string, unknown>
      if (typeof row.modelId !== 'string') return []
      const inputUsdPerMillion = positiveNumber(row.inputUsdPerMillion)
      const outputUsdPerMillion = positiveNumber(row.outputUsdPerMillion)
      if (inputUsdPerMillion === 0 || outputUsdPerMillion === 0) return []
      const cachedInputUsdPerMillion = positiveNumber(row.cachedInputUsdPerMillion)
      return [
        {
          modelId: row.modelId,
          inputUsdPerMillion,
          outputUsdPerMillion,
          ...(cachedInputUsdPerMillion > 0 && cachedInputUsdPerMillion < inputUsdPerMillion
            ? { cachedInputUsdPerMillion }
            : {})
        }
      ]
    })
    if (parsed.length > 0) result[provider as ProviderId] = parsed
  }
  return result
}

function canonicalRateModelId(provider: ProviderId, model: string | undefined): string {
  const trimmed = (model || '').trim()
  const key = trimmed.toLowerCase()
  const fallback = DEFAULT_RATE_MODEL_BY_PROVIDER[provider]
  if (!fallback) return trimmed
  if (DEFAULT_MODEL_SENTINELS.has(key)) return fallback
  if (provider === 'codex' && CODEX_DEFAULT_SENTINELS.has(key)) return fallback
  if (provider === 'gemini' && key === 'flash-lite') return fallback
  if (provider === 'grok' && (key === 'grok-build' || key === 'grok-build-0.1')) return 'grok-4.5'
  if (
    provider === 'cursor' &&
    (key === 'cursor-grok-4.5' || key.startsWith('grok-4.5-fast-') || key.startsWith('grok-4.5-'))
  ) {
    return 'grok-4.5'
  }
  return trimmed
}

function resolveRate(rates: ProviderRates, provider: ProviderId, model: string | undefined): ModelRate | null {
  const table = rates[provider]
  if (!table || table.length === 0) return null
  const wanted = canonicalRateModelId(provider, model).toLowerCase()
  if (wanted) {
    const exact = table.find((entry) => entry.modelId.toLowerCase() === wanted)
    if (exact) return exact
    const prefix = table.find((entry) => {
      const id = entry.modelId.toLowerCase()
      return wanted.startsWith(id) || id.startsWith(wanted)
    })
    if (prefix) return prefix
  }
  return table[0]
}

function recordCostUsd(record: UsageRecord, rates: ProviderRates): number {
  const raw = record as unknown as Record<string, unknown>
  const explicit = positiveNumber(raw.explicitCostUsd ?? raw.cost_usd)
  if (explicit > 0) return explicit
  if (!record.provider) return 0
  const rate = resolveRate(rates, record.provider, record.costRateModel || record.model)
  if (!rate) return 0
  const inputTokens = positiveNumber(record.inputTokens)
  const cacheRead = positiveNumber(record.cacheReadInputTokens)
  const cacheCreation = positiveNumber(record.cacheCreationInputTokens)
  const outputTokens = positiveNumber(record.outputTokens)
  const cachedInputRate = rate.cachedInputUsdPerMillion ?? rate.inputUsdPerMillion
  const cost =
    (inputTokens / 1_000_000) * rate.inputUsdPerMillion +
    (cacheRead / 1_000_000) * cachedInputRate +
    (cacheCreation / 1_000_000) * rate.inputUsdPerMillion +
    (outputTokens / 1_000_000) * rate.outputUsdPerMillion
  return Number.isFinite(cost) && cost > 0 ? cost : 0
}

function recordTokenTotal(record: UsageRecord): number {
  const input =
    positiveNumber(record.inputTokens) +
    positiveNumber(record.cacheReadInputTokens) +
    positiveNumber(record.cacheCreationInputTokens)
  const output = positiveNumber(record.outputTokens)
  return Math.round(input + output)
}

function formatCost(
  usd: number,
  currency: RemoteDisplayCurrency,
  fxRates: Partial<Record<RemoteDisplayCurrency, number>>,
  overestimatePercent: number
): string {
  if (!Number.isFinite(usd) || usd <= 0) return ''
  const rate = fxRates[currency] ?? FALLBACK_FX_RATES_PER_USD[currency]
  const converted = usd * (1 + Math.max(0, Math.min(25, overestimatePercent)) / 100) * rate
  if (converted < COST_FLOORS[currency].threshold) return COST_FLOORS[currency].label
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(converted)
  } catch {
    const symbol = currency === 'USD' ? '$' : currency === 'GBP' ? '£' : '€'
    return `${symbol}${converted.toFixed(2)}`
  }
}

/**
 * Projects the desktop Model Usage spend and AntiGravity budget additions into
 * a compact, preformatted companion payload. Quota windows remain sourced from
 * provider-usage-snapshots.json through the existing snapshot fetchers.
 */
export function projectRemoteModelUsageExtras(
  input: RemoteModelUsageProjectionInput
): RemoteModelUsageExtras {
  const now = input.now ?? Date.now()
  const rates = normaliseProviderRates(input.providerRates)
  const currency = normaliseCurrency(input.settings.currency)
  const fxRates = normaliseFxRates(input.fxRates)
  const overestimatePercent = positiveNumber(input.settings.currencyOverestimatePercent)
  const allowedProviders = new Set<ProviderId>(SPEND_PROVIDER_ORDER)
  const buckets = new Map<ProviderId, Map<SpendWindowId, { tokens: number; runs: number; costUsd: number }>>()

  for (const record of input.records) {
    if (!record || record.usageKind === 'reset_hint' || !record.provider) continue
    if (!allowedProviders.has(record.provider)) continue
    const timestamp = Number(record.timestamp)
    if (!Number.isFinite(timestamp) || timestamp > now || timestamp < now - SPEND_WINDOWS[2].durationMs) {
      continue
    }
    let providerBuckets = buckets.get(record.provider)
    if (!providerBuckets) {
      providerBuckets = new Map(
        SPEND_WINDOWS.map((window) => [window.id, { tokens: 0, runs: 0, costUsd: 0 }])
      )
      buckets.set(record.provider, providerBuckets)
    }
    const tokens = recordTokenTotal(record)
    const costUsd = recordCostUsd(record, rates)
    for (const window of SPEND_WINDOWS) {
      if (timestamp < now - window.durationMs) continue
      const bucket = providerBuckets.get(window.id)
      if (!bucket) continue
      bucket.tokens += tokens
      bucket.runs += 1
      bucket.costUsd += costUsd
    }
  }

  const providers: RemoteUsageSpendProvider[] = SPEND_PROVIDER_ORDER.flatMap((provider) => {
    const windows = buckets.get(provider)
    if (!windows) return []
    return [
      {
        provider,
        windows: SPEND_WINDOWS.map((window) => {
          const bucket = windows.get(window.id)!
          const costText = formatCost(bucket.costUsd, currency, fxRates, overestimatePercent)
          return {
            id: window.id,
            label: window.label,
            totalTokens: Math.round(bucket.tokens),
            runs: bucket.runs,
            ...(costText ? { costText } : {})
          }
        })
      }
    ]
  })

  const extras: RemoteModelUsageExtras = providers.length > 0 ? { spend: { providers } } : {}
  const capUsd = positiveNumber(input.settings.antigravityGeminiApiMonthlySpendCapUsd)
  if (capUsd === 0) return extras

  const monthStart = new Date(new Date(now).getFullYear(), new Date(now).getMonth(), 1).getTime()
  const antigravitySpentUsd = input.records.reduce((total, record) => {
    if (
      !record ||
      record.usageKind === 'reset_hint' ||
      record.provider !== 'antigravity' ||
      !Number.isFinite(record.timestamp) ||
      record.timestamp < monthStart ||
      record.timestamp > now
    ) {
      return total
    }
    return total + recordCostUsd(record, rates)
  }, 0)
  const nextMonth = new Date(new Date(now).getFullYear(), new Date(now).getMonth() + 1, 1)
  const spentText = formatCost(antigravitySpentUsd, currency, fxRates, overestimatePercent)
  extras.antigravityBudget = {
    provider: 'antigravity',
    ...(spentText ? { spentText } : {}),
    capText: formatCost(capUsd, currency, fxRates, 0),
    usedPercent: Math.round(Math.max(0, Math.min(100, (antigravitySpentUsd / capUsd) * 100))),
    resetAt: nextMonth.toISOString()
  }
  return extras
}
