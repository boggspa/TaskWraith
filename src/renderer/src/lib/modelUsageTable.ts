/**
 * modelUsageTable — richer per-provider, per-MODEL usage/cost builder for
 * the Settings → Model usage tab's comprehensive table.
 *
 * This is the deep cousin of `apiSpendAggregation.ts` (the sidebar card's
 * View B). Where that helper rolls up Day / 7d / 30d totals per PROVIDER,
 * this one breaks each provider down per MODEL and reports FIVE rolling
 * windows — 1H / 24H / 7D / 30D / 90D — so the Settings table can show the
 * full grid the user asked for.
 *
 * Two data sources feed it, and the `includeExternal` flag SWITCHES between
 * them — it does NOT sum them:
 *   - off (default): TaskWraith's OWN runs only (`window.api.getUsage()`).
 *   - on: provider-wide activity built from externally-tracked provider
 *     activity plus TaskWraith-owned records for providers whose native logs
 *     are not part of that external dataset. The external side comes from
 *     `window.api.getExternalUsage()` (the same 90-day dataset behind the
 *     External Activity heatmap). Codex now keeps TaskWraith sessions in a
 *     private CODEX_HOME, so its `window.api.getUsage()` records are
 *     deliberately supplemented by the Settings entry point.
 *
 * **Honesty:** records carry token counts only — never a billed cost (see
 * `providerRateEstimate.ts`'s HONESTY GUARDRAILS). Every `costUsd` here is a
 * rate-table PROJECTION ("what this WOULD have cost on the API"), and the
 * matching `costDisplay` is the same projection converted to the display
 * currency. The display layer MUST badge it (`~` prefix + "estimated, not
 * billed"); this module only computes the numbers.
 *
 * Pure + dependency-injected: `now`, both record sets, the rate table, the
 * currency options, and the `includeExternal` flag are all parameters, so
 * window bucketing, per-model grouping, the external merge, and the cost
 * math are exhaustively unit-testable without an IPC harness or a fake clock.
 *
 * Window semantics mirror `apiSpendAggregation` / `UsageHeatmap`: a record
 * counts toward a window when its timestamp is `>= now - windowMs` (inclusive
 * lower bound) and `<= now` (future-dated / clock-skew records are dropped).
 * The windows are strict rolling spans (90d = 90 * 24h, NOT a calendar
 * quarter), and each shorter window is a strict subset of the wider ones.
 */

import type { ChatRecord, ProviderId, UsageRecord } from '../../../main/store/types'
import { canonicalModelIdForProvider } from './modelDisplayName'
import {
  estimateUsageRecordCostUsd,
  usageRecordInputTokens,
  type RendererProviderRates
} from './providerRateEstimate'
import { usageRecordRunCount } from '../../../shared/externalUsageBuckets'
import { formatCost, type DisplayCurrency } from './formatCost'

/** Rolling window keys for the per-model rows (shortest → longest). */
export type ModelUsageWindowKey = 'h1' | 'h24' | 'd7' | 'd30' | 'd90'

const ONE_HOUR_MS = 60 * 60 * 1000
const ONE_DAY_MS = 24 * ONE_HOUR_MS

/** Window length in milliseconds for each column. Exported so the renderer's
 * column headers and any tests share one source of truth. */
export const MODEL_USAGE_WINDOW_MS: Record<ModelUsageWindowKey, number> = {
  h1: ONE_HOUR_MS,
  h24: ONE_DAY_MS,
  d7: 7 * ONE_DAY_MS,
  d30: 30 * ONE_DAY_MS,
  d90: 90 * ONE_DAY_MS
}

/** Canonical render order for the windows (shortest → longest). */
export const MODEL_USAGE_WINDOW_ORDER: ModelUsageWindowKey[] = ['h1', 'h24', 'd7', 'd30', 'd90']

/** Short labels for the column headers. */
export const MODEL_USAGE_WINDOW_LABEL: Record<ModelUsageWindowKey, string> = {
  h1: '1H',
  h24: '24H',
  d7: '7D',
  d30: '30D',
  d90: '90D'
}

/**
 * Providers that can surface in the token/cost table. Ollama is handled
 * separately via {@link buildOllamaMemoryModelTable} (RAM semantics).
 * Grok token runs are priced here; subscription credits stay on the plan
 * meter. Historical Gemini/Cursor records remain visible alongside current
 * live-provider and external-scanner usage; this table is reporting, not an
 * offer or dispatch surface.
 */
export const MODEL_USAGE_PROVIDER_ORDER: ProviderId[] = [
  'gemini',
  'codex',
  'claude',
  'kimi',
  'grok',
  'cursor'
]

/** Aggregated token + cost totals for one (provider, model) over one window. */
export interface ModelUsageWindowTotals {
  /** Input (prompt) tokens summed across runs in this window. */
  tokensIn: number
  /** Output (completion) tokens summed across runs in this window. */
  tokensOut: number
  /** `tokensIn + tokensOut` — convenience for the row's token chip. */
  totalTokens: number
  /** Number of runs that contributed to this window. */
  runs: number
  /**
   * Raw projected spend in USD, BEFORE currency conversion / bias. Kept
   * alongside the formatted string so callers can sort or sum without
   * re-parsing a localized currency string.
   */
  costUsd: number
  /**
   * Spend formatted in the user's display currency (e.g. `£1.23`), with the
   * conservative-overestimate bias applied. Empty string when the projected
   * cost rounds to nothing — callers render a neutral placeholder (e.g. "—")
   * rather than a misleading `£0.00`.
   */
  costDisplay: string
}

/** One model row: the raw model id plus its totals across all five windows. */
export interface ModelUsageModelRow {
  /** Raw model id as reported by the provider (humanise at the display layer). */
  model: string
  windows: Record<ModelUsageWindowKey, ModelUsageWindowTotals>
}

/** One provider block: the provider id, its model rows (sorted), and a
 * roll-up of all its models per window (for the provider's summary row). */
export interface ModelUsageProviderGroup {
  provider: ProviderId
  /** Per-model rows, sorted by 90-day total tokens desc (busiest first). */
  models: ModelUsageModelRow[]
  /** Provider-wide totals (sum of every model) per window. */
  totals: Record<ModelUsageWindowKey, ModelUsageWindowTotals>
}

/** Currency-related inputs for the cost conversion + bias. Mirrors
 * `ApiSpendCurrencyOptions`. */
export interface ModelUsageCurrencyOptions {
  currency?: DisplayCurrency
  /** Conservative-overestimate bias percent (0–25). See `formatCost`. */
  overestimatePercent?: number
  /** Optional locale override forwarded to `Intl.NumberFormat`. */
  locale?: string
}

/** Options for {@link buildModelUsageTable}. */
export interface ModelUsageTableOptions extends ModelUsageCurrencyOptions {
  /**
   * When true, merge the externally-tracked provider activity in with
   * TaskWraith's own runs so the table shows provider-WIDE usage. When false
   * (default), only `internalRecords` count.
   */
  includeExternal?: boolean
}

export interface ModelUsageWorkspaceColumn {
  workspaceId: string
  label: string
  totalTokens: number
  runs: number
  changedFiles: number
  costUsd: number
  costDisplay: string
}

export interface ModelUsageWorkspaceCell {
  runs: number
  changedFiles: number
  totalTokens: number
  costUsd: number
  costDisplay: string
}

export interface ModelUsageWorkspaceModelRow {
  model: string
  workspaces: Record<string, ModelUsageWorkspaceCell>
}

export interface ModelUsageWorkspaceProviderGroup {
  provider: ProviderId
  models: ModelUsageWorkspaceModelRow[]
  totals: Record<string, ModelUsageWorkspaceCell>
}

export interface ModelUsageWorkspaceMatrix {
  workspaces: ModelUsageWorkspaceColumn[]
  groups: ModelUsageWorkspaceProviderGroup[]
}

/** A mutable accumulator used while walking records. */
interface UsageAccumulator {
  tokensIn: number
  tokensOut: number
  runs: number
  costUsd: number
}

const emptyAccumulator = (): UsageAccumulator => ({
  tokensIn: 0,
  tokensOut: 0,
  runs: 0,
  costUsd: 0
})

const emptyWorkspaceCell = (): ModelUsageWorkspaceCell => ({
  runs: 0,
  changedFiles: 0,
  totalTokens: 0,
  costUsd: 0,
  costDisplay: ''
})

const emptyWindowSet = (): Record<ModelUsageWindowKey, UsageAccumulator> => ({
  h1: emptyAccumulator(),
  h24: emptyAccumulator(),
  d7: emptyAccumulator(),
  d30: emptyAccumulator(),
  d90: emptyAccumulator()
})

const toNonNegative = (value: unknown): number => {
  const num = Number(value)
  return Number.isFinite(num) && num > 0 ? num : 0
}

/**
 * Resolve the USD cost of a single record. Prefers an explicit `cost_usd` if
 * a provider ever writes one (the welcome dashboard reads the same defensive
 * field), otherwise projects from the rate table. Returns `0` when neither
 * yields a positive figure. Identical contract to
 * `apiSpendAggregation.recordCostUsd`.
 */
function recordCostUsd(record: UsageRecord, rates: RendererProviderRates): number {
  const explicit = Number(
    (record as unknown as Record<string, unknown>).explicitCostUsd ??
      (record as unknown as Record<string, unknown>).cost_usd ??
      0
  )
  if (Number.isFinite(explicit) && explicit > 0) return explicit
  return estimateUsageRecordCostUsd(rates, record)
}

/** Normalise a model id for grouping. Falls back to the provider name so a
 * record with a blank model still gets a stable bucket rather than vanishing
 * into an empty-string key. */
function modelKeyFor(record: UsageRecord): string {
  const raw = (record.model || '').trim()
  const canonical = canonicalModelIdForProvider(record.provider, raw)
  return canonical || raw || record.provider || 'unknown'
}

function workspaceKeyFor(record: UsageRecord): string {
  const raw = (record.workspaceId || '').trim()
  return raw || '__unknown_workspace__'
}

function workspaceBasename(value: string): string {
  const trimmed = value.trim().replace(/[\\/]+$/, '')
  if (!trimmed) return ''
  const parts = trimmed.split(/[\\/]+/)
  return parts[parts.length - 1] || trimmed
}

/** Structural chat shape for the workspace matrix so BOTH full ChatRecords
 * (getChats) and lean ChatListItems (getChatList — runs stripped, precomputed
 * runsSummary carried) satisfy it without adapters. */
export interface ModelUsageChatContext {
  appChatId: string
  workspaceId?: string
  workspacePath?: string
  runs?: ChatRecord['runs']
  runsSummary?: Array<{ runId: string; diffFileCount?: number }> | null
}

function workspaceLabelFor(workspaceId: string, chats: ModelUsageChatContext[]): string {
  if (workspaceId === '__taskwraith_global_chats__') return 'Global'
  if (workspaceId === '__unknown_workspace__') return 'Unknown'
  const chat = chats.find((candidate) => candidate.workspaceId === workspaceId)
  const path = typeof chat?.workspacePath === 'string' ? chat.workspacePath : ''
  return workspaceBasename(path) || workspaceId
}

/** Mirrored main-side as Store.runDiffFileCountForSummary — keep in sync. */
function runDiffFileCount(run: NonNullable<ChatRecord['runs']>[number] | undefined): number {
  if (!run) return 0
  const paths = new Set<string>()
  const addFile = (path: unknown) => {
    if (typeof path === 'string' && path.trim()) paths.add(path.trim())
  }
  for (const file of run.runDiff?.createdFiles || []) addFile(file.path)
  for (const file of run.runDiff?.modifiedFiles || []) addFile(file.path)
  for (const file of run.runDiff?.deletedFiles || []) addFile(file.path)
  for (const file of run.runDiff?.preExistingFiles || []) addFile(file.path)
  for (const files of Object.values(run.runDiffByPath || {})) {
    for (const file of files || []) addFile(file.path)
  }
  return paths.size
}

function buildRunDiffFileCountMap(chats: ModelUsageChatContext[]): Map<string, number> {
  const result = new Map<string, number>()
  for (const chat of chats || []) {
    // Lean list items carry precomputed counts; full records compute here.
    if (Array.isArray(chat.runsSummary)) {
      for (const run of chat.runsSummary) {
        if (!run?.runId) continue
        const count = Number(run.diffFileCount)
        result.set(`${chat.appChatId}:${run.runId}`, Number.isFinite(count) ? count : 0)
      }
      continue
    }
    for (const run of chat.runs || []) {
      if (!run?.runId) continue
      result.set(`${chat.appChatId}:${run.runId}`, runDiffFileCount(run))
    }
  }
  return result
}

/** Materialise an accumulator into the public window totals shape, formatting
 * the cost in the requested currency. */
function finalizeWindow(
  acc: UsageAccumulator,
  currency: DisplayCurrency,
  overestimatePercent: number,
  locale: string | undefined
): ModelUsageWindowTotals {
  return {
    tokensIn: acc.tokensIn,
    tokensOut: acc.tokensOut,
    totalTokens: acc.tokensIn + acc.tokensOut,
    runs: acc.runs,
    costUsd: acc.costUsd,
    costDisplay: formatCost(acc.costUsd, currency, locale, overestimatePercent)
  }
}

function finalizeWindowSet(
  set: Record<ModelUsageWindowKey, UsageAccumulator>,
  currency: DisplayCurrency,
  overestimatePercent: number,
  locale: string | undefined
): Record<ModelUsageWindowKey, ModelUsageWindowTotals> {
  return {
    h1: finalizeWindow(set.h1, currency, overestimatePercent, locale),
    h24: finalizeWindow(set.h24, currency, overestimatePercent, locale),
    d7: finalizeWindow(set.d7, currency, overestimatePercent, locale),
    d30: finalizeWindow(set.d30, currency, overestimatePercent, locale),
    d90: finalizeWindow(set.d90, currency, overestimatePercent, locale)
  }
}

/**
 * Build the per-provider → per-model usage/cost table across the 1H / 24H /
 * 7D / 30D / 90D rolling windows.
 *
 * @param internalRecords  TaskWraith's own runs (`window.api.getUsage()`).
 * @param externalRecords  Externally-tracked provider activity
 *                         (`window.api.getExternalUsage()`). Ignored unless
 *                         `options.includeExternal` is true.
 * @param rates            Per-model rate table (`fetchProviderRates`).
 * @param options          Display currency + overestimate bias + locale +
 *                         the `includeExternal` flag.
 * @param now              Reference epoch ms. Injected for deterministic
 *                         tests; defaults to `Date.now()`.
 * @returns                One {@link ModelUsageProviderGroup} per provider in
 *                         {@link MODEL_USAGE_PROVIDER_ORDER} that has any
 *                         activity in the 90-day window. Providers with no
 *                         in-window runs are omitted; an empty array means
 *                         "no tracked usage in the last 90 days" and the
 *                         caller shows an empty state.
 */
export function buildModelUsageTable(
  internalRecords: UsageRecord[],
  externalRecords: UsageRecord[],
  rates: RendererProviderRates,
  options: ModelUsageTableOptions = {},
  now: number = Date.now()
): ModelUsageProviderGroup[] {
  const currency: DisplayCurrency = options.currency ?? 'USD'
  const overestimatePercent = Number.isFinite(options.overestimatePercent)
    ? (options.overestimatePercent as number)
    : 0
  const locale = options.locale
  const includeExternal = options.includeExternal === true

  const cutoffs = {
    h1: now - MODEL_USAGE_WINDOW_MS.h1,
    h24: now - MODEL_USAGE_WINDOW_MS.h24,
    d7: now - MODEL_USAGE_WINDOW_MS.d7,
    d30: now - MODEL_USAGE_WINDOW_MS.d30,
    d90: now - MODEL_USAGE_WINDOW_MS.d90
  }

  const allowed = new Set<ProviderId>(MODEL_USAGE_PROVIDER_ORDER)

  // provider -> model -> per-window accumulators.
  const buckets = new Map<ProviderId, Map<string, Record<ModelUsageWindowKey, UsageAccumulator>>>()

  // External Usage SWITCHES the source, it does not add to it: the external
  // dataset is provider-wide and already contains TaskWraith's own CLI runs, so
  // summing internal + external would double-count every TaskWraith run. On →
  // external only (provider-wide); off → internal only (TaskWraith's runs).
  const sources = includeExternal ? [externalRecords] : [internalRecords]

  for (const records of sources) {
    if (!Array.isArray(records)) continue
    for (const record of records) {
      if (!record) continue
      if (record.usageKind === 'reset_hint') continue
      const provider = record.provider
      if (!provider || !allowed.has(provider)) continue
      const timestamp = Number(record.timestamp)
      if (!Number.isFinite(timestamp)) continue
      // Drop future-dated records (clock skew) and anything older than the
      // widest (90d) window — they can never land in any column.
      if (timestamp > now || timestamp < cutoffs.d90) continue

      const tokensIn = usageRecordInputTokens(record)
      const tokensOut = toNonNegative(record.outputTokens)
      const costUsd = recordCostUsd(record, rates)
      // Drop synthetic zero-signal markers — the external scanner emits some
      // (codex session-index, cursor daily-stat rows) with 0 tokens and no
      // cost. They carry no usage for this table and would otherwise inflate
      // run counts. Skip BEFORE bucketing so a provider/model whose ONLY
      // records are markers never sprouts an empty section.
      if (tokensIn === 0 && tokensOut === 0 && costUsd === 0) continue

      let modelMap = buckets.get(provider)
      if (!modelMap) {
        modelMap = new Map()
        buckets.set(provider, modelMap)
      }
      const modelKey = modelKeyFor(record)
      let windowSet = modelMap.get(modelKey)
      if (!windowSet) {
        windowSet = emptyWindowSet()
        modelMap.set(modelKey, windowSet)
      }

      // External records may be time-bucket aggregates standing for many runs.
      const runCount = usageRecordRunCount(record)
      const apply = (acc: UsageAccumulator) => {
        acc.tokensIn += tokensIn
        acc.tokensOut += tokensOut
        acc.runs += runCount
        acc.costUsd += costUsd
      }

      // 90d always applies (we filtered to it). Each shorter window is a
      // strict subset, so a boundary record at exactly the cutoff counts
      // inclusively (>=).
      apply(windowSet.d90)
      if (timestamp >= cutoffs.d30) apply(windowSet.d30)
      if (timestamp >= cutoffs.d7) apply(windowSet.d7)
      if (timestamp >= cutoffs.h24) apply(windowSet.h24)
      if (timestamp >= cutoffs.h1) apply(windowSet.h1)
    }
  }

  const result: ModelUsageProviderGroup[] = []
  for (const provider of MODEL_USAGE_PROVIDER_ORDER) {
    const modelMap = buckets.get(provider)
    if (!modelMap || modelMap.size === 0) continue

    const models: ModelUsageModelRow[] = []
    const providerTotals = emptyWindowSet()
    for (const [model, windowSet] of modelMap.entries()) {
      models.push({
        model,
        windows: finalizeWindowSet(windowSet, currency, overestimatePercent, locale)
      })
      // Fold each model's per-window accumulators into the provider roll-up.
      for (const key of MODEL_USAGE_WINDOW_ORDER) {
        providerTotals[key].tokensIn += windowSet[key].tokensIn
        providerTotals[key].tokensOut += windowSet[key].tokensOut
        providerTotals[key].runs += windowSet[key].runs
        providerTotals[key].costUsd += windowSet[key].costUsd
      }
    }

    // Busiest model first by the widest window's token total, then by id for a
    // stable tiebreak so the render order is deterministic across runs.
    models.sort(
      (a, b) =>
        b.windows.d90.totalTokens - a.windows.d90.totalTokens || a.model.localeCompare(b.model)
    )

    result.push({
      provider,
      models,
      totals: finalizeWindowSet(providerTotals, currency, overestimatePercent, locale)
    })
  }
  return result
}

/**
 * Providers whose TaskWraith-internal records are always folded into the table
 * when External Usage is ON. Codex's TaskWraith-owned sessions live outside
 * the shared home scanned for external activity; Grok is never scanned
 * externally. Cursor is additive for reporting: IDE-native Composer activity
 * comes from the external scanner while historical TaskWraith Cursor records
 * stay visible.
 */
const ALWAYS_SUPPLEMENT_WHEN_EXTERNAL: ProviderId[] = ['codex', 'grok', 'cursor']

/** Cursor's IDE activity scanner exposes input + output but no cache split. Match
 * historical internal Cursor rows on that same fresh-input + output basis; display
 * aggregation remains cache-inclusive through `usageRecordInputTokens`. */
function cursorDedupeTokens(record: UsageRecord): number {
  return toNonNegative(record.inputTokens) + toNonNegative(record.outputTokens)
}

function cursorRecordsLikelyOverlap(internal: UsageRecord, external: UsageRecord): boolean {
  const internalTokens = cursorDedupeTokens(internal)
  const externalTokens = cursorDedupeTokens(external)
  if (internalTokens <= 0 || externalTokens <= 0) return false
  if (Math.abs(internal.timestamp - external.timestamp) > 120_000) return false
  const ratio = internalTokens / externalTokens
  return ratio >= 0.75 && ratio <= 1.33
}

/** Drop external Cursor rows that likely duplicate a historical TaskWraith
 * Cursor record (same ~2m window and similar token total). */
function dedupeCursorExternalAgainstInternal(
  internalRecords: UsageRecord[],
  externalRecords: UsageRecord[]
): UsageRecord[] {
  const internalCursor = internalRecords.filter(
    (record) =>
      record?.provider === 'cursor' &&
      record.usageKind !== 'reset_hint' &&
      cursorDedupeTokens(record) > 0
  )
  if (internalCursor.length === 0) return externalRecords

  return externalRecords.filter((record) => {
    if (record?.provider !== 'cursor' || record.usageKind === 'reset_hint') return true
    if (cursorDedupeTokens(record) <= 0) return false
    const duplicate = internalCursor.some((inner) => cursorRecordsLikelyOverlap(inner, record))
    return !duplicate
  })
}

/** Merge two provider groups that share the same provider id, combining model rows
 * by canonical model key and re-rolling provider totals. */
function mergeModelUsageProviderGroups(
  primary: ModelUsageProviderGroup,
  secondary: ModelUsageProviderGroup,
  currency: DisplayCurrency,
  overestimatePercent: number,
  locale: string | undefined
): ModelUsageProviderGroup {
  const byModel = new Map<string, Record<ModelUsageWindowKey, UsageAccumulator>>()

  const ingest = (group: ModelUsageProviderGroup) => {
    for (const row of group.models) {
      const key = canonicalModelIdForProvider(group.provider, row.model) || row.model
      let accSet = byModel.get(key)
      if (!accSet) {
        accSet = emptyWindowSet()
        byModel.set(key, accSet)
      }
      for (const windowKey of MODEL_USAGE_WINDOW_ORDER) {
        const window = row.windows[windowKey]
        accSet[windowKey].tokensIn += window.tokensIn
        accSet[windowKey].tokensOut += window.tokensOut
        accSet[windowKey].runs += window.runs
        accSet[windowKey].costUsd += window.costUsd
      }
    }
  }

  ingest(primary)
  ingest(secondary)

  const models: ModelUsageModelRow[] = []
  const providerTotals = emptyWindowSet()
  for (const [model, windowSet] of byModel.entries()) {
    models.push({
      model,
      windows: finalizeWindowSet(windowSet, currency, overestimatePercent, locale)
    })
    for (const key of MODEL_USAGE_WINDOW_ORDER) {
      providerTotals[key].tokensIn += windowSet[key].tokensIn
      providerTotals[key].tokensOut += windowSet[key].tokensOut
      providerTotals[key].runs += windowSet[key].runs
      providerTotals[key].costUsd += windowSet[key].costUsd
    }
  }

  models.sort(
    (a, b) =>
      b.windows.d90.totalTokens - a.windows.d90.totalTokens || a.model.localeCompare(b.model)
  )

  return {
    provider: primary.provider,
    models,
    totals: finalizeWindowSet(providerTotals, currency, overestimatePercent, locale)
  }
}

/**
 * Settings-table entry point. When External Usage is OFF this is identical to
 * {@link buildModelUsageTable}. When ON it uses the provider-wide external
 * dataset for CLI providers, always folds in TaskWraith-internal Grok runs,
 * and additively merges historical internal + external Cursor usage with fuzzy
 * dedup for overlapping records. It does not imply Cursor dispatch availability.
 */
export function buildModelUsageTableForSettings(
  internalRecords: UsageRecord[],
  externalRecords: UsageRecord[],
  rates: RendererProviderRates,
  options: ModelUsageTableOptions = {},
  now: number = Date.now()
): ModelUsageProviderGroup[] {
  if (options.includeExternal !== true) {
    return buildModelUsageTable(internalRecords, externalRecords, rates, options, now)
  }

  const currency: DisplayCurrency = options.currency ?? 'USD'
  const overestimatePercent = Number.isFinite(options.overestimatePercent)
    ? (options.overestimatePercent as number)
    : 0
  const locale = options.locale

  const filteredExternal = dedupeCursorExternalAgainstInternal(internalRecords, externalRecords)

  const externalGroups = buildModelUsageTable(
    internalRecords,
    filteredExternal,
    rates,
    { ...options, includeExternal: true },
    now
  )
  const internalGroups = buildModelUsageTable(
    internalRecords,
    [],
    rates,
    { ...options, includeExternal: false },
    now
  )

  const externalByProvider = new Map(externalGroups.map((group) => [group.provider, group]))
  const internalByProvider = new Map(internalGroups.map((group) => [group.provider, group]))

  const byProvider = new Map<ProviderId, ModelUsageProviderGroup>()
  for (const group of externalGroups) {
    byProvider.set(group.provider, group)
  }

  for (const provider of ALWAYS_SUPPLEMENT_WHEN_EXTERNAL) {
    const internalGroup = internalByProvider.get(provider)
    if (!internalGroup) continue
    const existing = byProvider.get(provider)
    if (!existing) {
      byProvider.set(provider, internalGroup)
      continue
    }
    if (provider === 'codex' || provider === 'cursor') {
      byProvider.set(
        provider,
        mergeModelUsageProviderGroups(existing, internalGroup, currency, overestimatePercent, locale)
      )
    } else {
      byProvider.set(provider, internalGroup)
    }
  }

  // Providers only in internal (shouldn't happen for priced roster) — ignore.
  void externalByProvider

  return MODEL_USAGE_PROVIDER_ORDER.map((provider) => byProvider.get(provider)).filter(
    (group): group is ModelUsageProviderGroup => Boolean(group)
  )
}

function modelUsageRecordsForSettingsMatrix(
  internalRecords: UsageRecord[],
  externalRecords: UsageRecord[],
  options: ModelUsageTableOptions
): UsageRecord[] {
  if (options.includeExternal !== true) return internalRecords
  const filteredExternal = dedupeCursorExternalAgainstInternal(internalRecords, externalRecords)
  const supplemental = internalRecords.filter(
    (record) =>
      record?.provider === 'codex' ||
      record?.provider === 'grok' ||
      (record?.provider === 'cursor' &&
        !filteredExternal.some((external) => {
          if (external?.provider !== 'cursor') return false
          return cursorRecordsLikelyOverlap(record, external)
        }))
  )
  return [...filteredExternal, ...supplemental]
}

export function buildModelUsageWorkspaceMatrix(
  internalRecords: UsageRecord[],
  externalRecords: UsageRecord[],
  chats: ModelUsageChatContext[],
  rates: RendererProviderRates,
  options: ModelUsageTableOptions = {},
  now: number = Date.now(),
  limit: number = 7
): ModelUsageWorkspaceMatrix {
  const currency: DisplayCurrency = options.currency ?? 'USD'
  const overestimatePercent = Number.isFinite(options.overestimatePercent)
    ? (options.overestimatePercent as number)
    : 0
  const locale = options.locale
  const cutoff = now - MODEL_USAGE_WINDOW_MS.d90
  const allowed = new Set<ProviderId>(MODEL_USAGE_PROVIDER_ORDER)
  const diffByRun = buildRunDiffFileCountMap(chats)
  const records = modelUsageRecordsForSettingsMatrix(internalRecords, externalRecords, options)
  const workspaceTotals = new Map<string, UsageAccumulator & { changedFiles: number }>()
  const providerModelWorkspace = new Map<
    ProviderId,
    Map<string, Map<string, UsageAccumulator & { changedFiles: number }>>
  >()

  for (const record of records) {
    if (!record || record.usageKind === 'reset_hint') continue
    const provider = record.provider
    if (!provider || !allowed.has(provider)) continue
    const timestamp = Number(record.timestamp)
    if (!Number.isFinite(timestamp) || timestamp > now || timestamp < cutoff) continue
    const tokensIn = usageRecordInputTokens(record)
    const tokensOut = toNonNegative(record.outputTokens)
    const totalTokens = tokensIn + tokensOut
    const costUsd = recordCostUsd(record, rates)
    if (totalTokens === 0 && costUsd === 0) continue

    const workspaceId = workspaceKeyFor(record)
    const changedFiles = diffByRun.get(`${record.chatId}:${record.runId}`) ?? 0
    const apply = (acc: UsageAccumulator & { changedFiles: number }) => {
      acc.tokensIn += tokensIn
      acc.tokensOut += tokensOut
      acc.runs += 1
      acc.costUsd += costUsd
      acc.changedFiles += changedFiles
    }

    let workspaceAcc = workspaceTotals.get(workspaceId)
    if (!workspaceAcc) {
      workspaceAcc = { ...emptyAccumulator(), changedFiles: 0 }
      workspaceTotals.set(workspaceId, workspaceAcc)
    }
    apply(workspaceAcc)

    let modelMap = providerModelWorkspace.get(provider)
    if (!modelMap) {
      modelMap = new Map()
      providerModelWorkspace.set(provider, modelMap)
    }
    const model = modelKeyFor(record)
    let workspaceMap = modelMap.get(model)
    if (!workspaceMap) {
      workspaceMap = new Map()
      modelMap.set(model, workspaceMap)
    }
    let cell = workspaceMap.get(workspaceId)
    if (!cell) {
      cell = { ...emptyAccumulator(), changedFiles: 0 }
      workspaceMap.set(workspaceId, cell)
    }
    apply(cell)
  }

  const workspaceLimit = Math.max(1, Math.min(7, Math.floor(limit) || 7))
  const workspaces = [...workspaceTotals.entries()]
    .sort(
      ([aId, a], [bId, b]) =>
        b.tokensIn + b.tokensOut - (a.tokensIn + a.tokensOut) ||
        b.costUsd - a.costUsd ||
        aId.localeCompare(bId)
    )
    .slice(0, workspaceLimit)
    .map(([workspaceId, acc]) => ({
      workspaceId,
      label: workspaceLabelFor(workspaceId, chats),
      totalTokens: acc.tokensIn + acc.tokensOut,
      runs: acc.runs,
      changedFiles: acc.changedFiles,
      costUsd: acc.costUsd,
      costDisplay: formatCost(acc.costUsd, currency, locale, overestimatePercent)
    }))

  const workspaceIds = new Set(workspaces.map((workspace) => workspace.workspaceId))
  const finalizeCell = (acc: UsageAccumulator & { changedFiles: number }): ModelUsageWorkspaceCell => ({
    runs: acc.runs,
    changedFiles: acc.changedFiles,
    totalTokens: acc.tokensIn + acc.tokensOut,
    costUsd: acc.costUsd,
    costDisplay: formatCost(acc.costUsd, currency, locale, overestimatePercent)
  })

  const groups: ModelUsageWorkspaceProviderGroup[] = []
  for (const provider of MODEL_USAGE_PROVIDER_ORDER) {
    const modelMap = providerModelWorkspace.get(provider)
    if (!modelMap) continue
    const models: ModelUsageWorkspaceModelRow[] = []
    const totals: Record<string, ModelUsageWorkspaceCell> = {}
    for (const workspace of workspaces) totals[workspace.workspaceId] = emptyWorkspaceCell()

    for (const [model, workspaceMap] of modelMap.entries()) {
      const rowCells: Record<string, ModelUsageWorkspaceCell> = {}
      let rowTokens = 0
      for (const workspace of workspaces) {
        const acc = workspaceMap.get(workspace.workspaceId)
        const cell = acc ? finalizeCell(acc) : emptyWorkspaceCell()
        rowCells[workspace.workspaceId] = cell
        rowTokens += cell.totalTokens
        const total = totals[workspace.workspaceId]
        total.runs += cell.runs
        total.changedFiles += cell.changedFiles
        total.totalTokens += cell.totalTokens
        total.costUsd += cell.costUsd
      }
      if (rowTokens > 0) models.push({ model, workspaces: rowCells })
    }
    for (const workspaceId of Object.keys(totals)) {
      totals[workspaceId].costDisplay = formatCost(
        totals[workspaceId].costUsd,
        currency,
        locale,
        overestimatePercent
      )
    }
    models.sort((a, b) => {
      const total = (row: ModelUsageWorkspaceModelRow) =>
        Object.values(row.workspaces).reduce((sum, cell) => sum + cell.totalTokens, 0)
      return total(b) - total(a) || a.model.localeCompare(b.model)
    })
    if (models.length > 0) groups.push({ provider, models, totals })
  }

  return { workspaces, groups: workspaceIds.size > 0 ? groups : [] }
}

/** Sum provider-level roll-ups into a single token/cost totals row. */
export function sumModelUsageProviderTotals(
  groups: ModelUsageProviderGroup[],
  options: ModelUsageCurrencyOptions = {}
): Record<ModelUsageWindowKey, ModelUsageWindowTotals> {
  const currency: DisplayCurrency = options.currency ?? 'USD'
  const overestimatePercent = Number.isFinite(options.overestimatePercent)
    ? (options.overestimatePercent as number)
    : 0
  const locale = options.locale
  const merged = emptyWindowSet()

  for (const group of groups) {
    for (const key of MODEL_USAGE_WINDOW_ORDER) {
      const window = group.totals[key]
      merged[key].tokensIn += window.tokensIn
      merged[key].tokensOut += window.tokensOut
      merged[key].runs += window.runs
      merged[key].costUsd += window.costUsd
    }
  }

  return finalizeWindowSet(merged, currency, overestimatePercent, locale)
}
