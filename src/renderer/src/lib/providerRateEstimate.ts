/**
 * 1.0.7 — Renderer-side token->USD ESTIMATOR for subscription/credit seats.
 *
 * Several providers bill via a flat subscription or a credit pool rather than
 * per-token, so their run stats carry NO `cost_usd`:
 *   - Codex  → ChatGPT subscription quota (Plus / Pro / Business)
 *   - Grok   → SuperGrok subscription credits
 *   - Cursor → Cursor subscription (Composer pool on individual plans;
 *              projected against Composer 2.5 Fast list pricing)
 *
 * For those seats the real spend is blank. This module maps summed input /
 * output tokens to a PROJECTED API-equivalent USD figure using the per-model
 * rate table that `ProviderRateService` exposes over the `providerRates:get`
 * IPC (rates are USD per 1,000,000 tokens).
 *
 * **HONESTY GUARDRAILS** (the maintainer's explicit constraint):
 * `ProviderRateService` self-documents these rates as PROJECTED API-equivalents
 * — "what this run WOULD have cost on the API", not what was actually billed.
 * Therefore:
 *   (a) callers MUST only estimate when there is no explicit `cost_usd`, and
 *   (b) an estimate MUST be badged as such (e.g. "~$0.0x est. API-equiv"),
 *       never rendered as a bare currency string that implies money spent.
 * This module returns the raw USD number only; the badging lives in the
 * display layer (see `runCompleteSummary.ts`).
 *
 * Kept PURE + dependency-free so it's exhaustively unit-testable without an
 * IPC harness. The (impure) one-shot fetch helper is the only window-touching
 * export and is trivially mockable.
 */

import type { ProviderId, UsageRecord } from '../../../main/store/types'

/**
 * Minimal renderer-side mirror of `ProviderRateService`'s `ModelRateEntry`.
 * The preload types `getProviderRates()` as `unknown` (the concrete shape
 * lives main-side), so we narrow to just the fields the estimator needs and
 * stay defensive about everything else.
 */
export interface RendererModelRate {
  modelId: string
  inputUsdPerMillion: number
  outputUsdPerMillion: number
  cachedInputUsdPerMillion?: number
}

/** Per-provider rate table, keyed by provider id. Partial because a snapshot
 * may omit providers (e.g. Cursor ships an empty model list). */
export type RendererProviderRates = Partial<Record<ProviderId, RendererModelRate[]>>

const isFiniteNonNeg = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0

export interface RunCostEstimateOptions {
  /** Input tokens that were served from provider prompt-cache. */
  cacheReadInputTokens?: number
  /** Input tokens written into provider prompt-cache; billed as normal input. */
  cacheCreationInputTokens?: number
  /** True when `inputTokens` already includes cache read/create tokens. */
  inputIncludesCache?: boolean
}

/**
 * Narrow the loosely-typed `providerRates:get` IPC payload into a
 * {@link RendererProviderRates} map. Tolerant of the full
 * `ProviderRatesSnapshot` envelope (`{ baseline: { <provider>: { models } } }`)
 * as well as already-unwrapped shapes. Returns `{}` on anything unexpected so
 * a malformed snapshot can never break the estimator or rendering.
 */
export function normalizeProviderRates(raw: unknown): RendererProviderRates {
  if (!raw || typeof raw !== 'object') return {}
  // The IPC returns the full snapshot; the per-provider tables live under
  // `.baseline`. Fall back to treating `raw` itself as the table map for
  // forward/backward compatibility.
  const envelope = raw as Record<string, unknown>
  const tables =
    envelope.baseline && typeof envelope.baseline === 'object'
      ? (envelope.baseline as Record<string, unknown>)
      : envelope
  const out: RendererProviderRates = {}
  for (const [provider, table] of Object.entries(tables)) {
    if (!table || typeof table !== 'object') continue
    const models = (table as Record<string, unknown>).models
    if (!Array.isArray(models)) continue
    const entries: RendererModelRate[] = []
    for (const model of models) {
      if (!model || typeof model !== 'object') continue
      const m = model as Record<string, unknown>
      if (
        typeof m.modelId === 'string' &&
        isFiniteNonNeg(m.inputUsdPerMillion) &&
        isFiniteNonNeg(m.outputUsdPerMillion)
      ) {
        const entry: RendererModelRate = {
          modelId: m.modelId,
          inputUsdPerMillion: m.inputUsdPerMillion,
          outputUsdPerMillion: m.outputUsdPerMillion
        }
        if (
          isFiniteNonNeg(m.cachedInputUsdPerMillion) &&
          m.cachedInputUsdPerMillion < m.inputUsdPerMillion
        ) {
          entry.cachedInputUsdPerMillion = m.cachedInputUsdPerMillion
        }
        entries.push(entry)
      }
    }
    if (entries.length > 0) out[provider as ProviderId] = entries
  }
  return out
}

/**
 * Resolve a rate entry for a (provider, model) pair. Matches the model id
 * exactly first, then by case-insensitive prefix (CLIs sometimes report
 * `gpt-5.5-2026-xx` where the table keys `gpt-5.5`), then falls back to the
 * provider's first/cheapest-listed model so a known provider still yields a
 * ballpark rather than nothing. Returns `null` when the provider is unknown
 * or has no rates (e.g. Cursor's empty list).
 */
export function resolveModelRate(
  rates: RendererProviderRates,
  provider: ProviderId | undefined,
  model: string | undefined
): RendererModelRate | null {
  if (!provider) return null
  const table = rates[provider]
  if (!table || table.length === 0) return null
  const wanted = (model || '').trim().toLowerCase()
  if (wanted) {
    const exact = table.find((r) => r.modelId.toLowerCase() === wanted)
    if (exact) return exact
    const prefix = table.find(
      (r) =>
        wanted.startsWith(r.modelId.toLowerCase()) || r.modelId.toLowerCase().startsWith(wanted)
    )
    if (prefix) return prefix
  }
  return table[0]
}

/**
 * Pure estimate: project the USD API-equivalent cost of `inputTokens` /
 * `outputTokens` for one (provider, model) pair using the rate table.
 *
 * Returns `0` when the provider/model can't be resolved or both token counts
 * are zero — callers treat `<= 0` as "no estimate available" and render
 * nothing rather than a misleading `$0.00`.
 */
export function estimateRunCostUsd(
  rates: RendererProviderRates,
  provider: ProviderId | undefined,
  model: string | undefined,
  inputTokens: number,
  outputTokens: number,
  options: RunCostEstimateOptions = {}
): number {
  const rate = resolveModelRate(rates, provider, model)
  if (!rate) return 0
  const inTok = isFiniteNonNeg(inputTokens) ? inputTokens : 0
  const outTok = isFiniteNonNeg(outputTokens) ? outputTokens : 0
  const cacheRead = toNonNeg(options.cacheReadInputTokens)
  const cacheCreation = toNonNeg(options.cacheCreationInputTokens)
  const billedInputTok = options.inputIncludesCache
    ? Math.max(0, inTok - cacheRead - cacheCreation)
    : inTok
  if (billedInputTok === 0 && cacheRead === 0 && cacheCreation === 0 && outTok === 0) return 0
  const cachedInputRate = rate.cachedInputUsdPerMillion ?? rate.inputUsdPerMillion
  const usd =
    (billedInputTok / 1_000_000) * rate.inputUsdPerMillion +
    (cacheRead / 1_000_000) * cachedInputRate +
    (cacheCreation / 1_000_000) * rate.inputUsdPerMillion +
    (outTok / 1_000_000) * rate.outputUsdPerMillion
  return Number.isFinite(usd) && usd > 0 ? usd : 0
}

type UsageCostRecord = Pick<
  UsageRecord,
  | 'provider'
  | 'model'
  | 'inputTokens'
  | 'outputTokens'
  | 'cacheReadInputTokens'
  | 'cacheCreationInputTokens'
>

const toNonNeg = (value: unknown): number => (isFiniteNonNeg(value) ? value : 0)

/** Sum input-side tokens for display when a record carries a cache breakdown. */
export function usageRecordInputTokens(record: UsageCostRecord): number {
  const base = toNonNeg(record.inputTokens)
  const cacheRead = toNonNeg(record.cacheReadInputTokens)
  const cacheCreation = toNonNeg(record.cacheCreationInputTokens)
  if (cacheRead > 0 || cacheCreation > 0) return base + cacheRead + cacheCreation
  return base
}

/**
 * Cache-aware variant of {@link estimateRunCostUsd} for persisted usage rows.
 * When `cacheReadInputTokens` / `cacheCreationInputTokens` are present, cache
 * reads bill at `cachedInputUsdPerMillion` (falling back to the standard input
 * rate). Legacy rows that still combine all input into `inputTokens` keep the
 * previous all-at-input-rate behaviour.
 */
export function estimateUsageRecordCostUsd(
  rates: RendererProviderRates,
  record: UsageCostRecord
): number {
  const rate = resolveModelRate(rates, record.provider, record.model)
  if (!rate) return 0
  const outputTokens = toNonNeg(record.outputTokens)
  const cacheRead = toNonNeg(record.cacheReadInputTokens)
  const cacheCreation = toNonNeg(record.cacheCreationInputTokens)
  const hasCacheBreakdown = cacheRead > 0 || cacheCreation > 0
  const inputTokens = toNonNeg(record.inputTokens)

  return estimateRunCostUsd(rates, record.provider, record.model, inputTokens, outputTokens, {
    cacheReadInputTokens: hasCacheBreakdown ? cacheRead : 0,
    cacheCreationInputTokens: hasCacheBreakdown ? cacheCreation : 0
  })
}

/**
 * One-shot fetch of the provider rate snapshot over the existing
 * `providerRates:get` IPC, narrowed to {@link RendererProviderRates}. The only
 * impure export. Returns `{}` (never throws) when the API is unavailable or
 * the call fails, so the estimator degrades to "no estimate" gracefully.
 */
export async function fetchProviderRates(): Promise<RendererProviderRates> {
  try {
    const api = (globalThis as { api?: { getProviderRates?: () => Promise<unknown> } }).api
    if (typeof api?.getProviderRates !== 'function') return {}
    const raw = await api.getProviderRates()
    return normalizeProviderRates(raw)
  } catch {
    return {}
  }
}
