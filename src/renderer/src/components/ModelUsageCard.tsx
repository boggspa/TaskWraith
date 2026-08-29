/*
 * ModelUsageCard — Phase L6 slice 1 extraction.
 *
 * The "Model Usage" card that lives in the TaskWraith sidebar
 * (provider stack with per-window progress bars and reset times).
 * Extracted from `Sidebar.tsx`'s inline JSX so the redesign work
 * (L6 slices 2-6) lands here without growing the already-large
 * Sidebar file further.
 *
 * Slice 1 deliberately keeps the EXISTING visual treatment — same
 * markup, same classes, same gradient — so this is a pure refactor.
 * Slices 2-6 then redesign in this component without churning
 * Sidebar.
 *
 * Data contract: same `ModelUsageAggregate[]` the sidebar consumes
 * today, populated by `App.tsx#refreshUsageSummary`. We filter to
 * the `model === 'usage limits'` entries (the per-provider quota
 * summaries) and sort by the canonical provider order for stable
 * visual ordering.
 */
import {
  Fragment,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent
} from 'react'
import type { ProviderId, UsageRecord, ChatListItem } from '../../../main/store/types'
import type {
  ModelUsageAggregate,
  ModelUsageProviderId,
  UsageWindowAggregate
} from '../lib/usageAggregateTypes'
import {
  API_SPEND_WINDOW_ORDER,
  buildApiSpendByProvider,
  buildProviderCalendarMonthSpend,
  type ApiSpendCurrencyOptions,
  type ApiSpendProviderTotals,
  type ApiSpendWindowKey,
  type CalendarMonthSpendMeter
} from '../lib/apiSpendAggregation'
import { formatCostAlwaysOn, type DisplayCurrency } from '../lib/formatCost'
import {
  buildOllamaMemorySpend,
  formatOllamaMemoryAvgCell,
  formatOllamaSampleAvgCell,
  mergeOllamaMemoryUsageRecords,
  type OllamaMemorySpendTotals,
  type OllamaMemoryWindowTotals
} from '../lib/ollamaMemoryAggregation'
import { computeQuotaPace } from '../lib/QuotaPace'
import { loadRendererUsageRecords } from '../lib/usageRecordsCache'
import type { RendererProviderRates } from '../lib/providerRateEstimate'
import { formatResetShort } from '../lib/UsageFormat'
import { formatTokenCount } from '../lib/UsageHeatmap'
import { buildModelContextLengthGroups } from '../lib/modelContextLengths'
import { humaniseModelIdCompact } from '../lib/modelDisplayName'
import { useUsageSummary } from '../lib/usageSummaryStore'
import { getProviderName } from './Sidebar'
import {
  GrokCreditsMeterView,
  useGrokCreditsMeterState,
  type GrokCreditsMeterViewProps
} from './GrokCreditsMeter'
import {
  formatMistralAccumulatedSpend,
  formatMistralLocalIncrement
} from './MistralQuotaFormatting'
import {
  MistralQuotaMeterView,
  useMistralQuotaMeterState,
  type MistralQuotaMeterViewProps
} from './MistralQuotaMeter'
import { ProviderLogoTile } from './ProviderLogoTile'
import { QuotaProgressBar } from './QuotaProgressBar'
import { UsageHeatmap } from './UsageHeatmap'
import './ModelUsageCard.css'

/** The three views the card's top toggle switches between: plan limits, API spend, and context lengths. */
export type ModelUsagePanelView = 'plan' | 'spend' | 'context'

/**
 * View-B ("API spend") inputs. Threaded from App.tsx → Sidebar so the
 * card can price usage records and persist the chosen view. All optional
 * so the SSR/test render path (and any caller that hasn't wired it) keeps
 * working — when absent the toggle still renders but View B shows an
 * empty state.
 */
export interface ModelUsageApiSpendOptions extends ApiSpendCurrencyOptions {
  /** Per-model rate table from `fetchProviderRates()`. */
  providerRates?: RendererProviderRates
  /** Persisted view ('plan' | 'spend'). Defaults to 'plan'. */
  view?: ModelUsagePanelView
  /**
   * True while the first plan/quota hydration is unresolved. A persisted Plan
   * selection remains provisionally available during that window so the card
   * does not transiently mount API Spend and fetch the complete chat list.
   * Explicit Spend/Context selections remain authoritative.
   */
  planAvailabilityPending?: boolean
  /** Persist a new view selection (writes `settings.modelUsagePanelView`). */
  onViewChange?: (view: ModelUsagePanelView) => void
  /**
   * Refresh trigger — bump to force View B to re-query `getUsage`
   * (e.g. after a turn completes). Mirrors `UsageHeatmap.refreshKey`.
   */
  refreshKey?: number
  /** Manual refresh action for provider quota/usage snapshots. */
  onRefreshUsage?: () => void | Promise<void>
  /** True while a caller-owned refresh is already in progress. */
  refreshing?: boolean
  /**
   * User-set soft monthly budget (USD) for the AntiGravity Gemini API key
   * lane (`settings.antigravityGeminiApiMonthlySpendCapUsd`). Renders a
   * calendar-month spend meter on the Antigravity block — advisory only.
   */
  antigravityMonthlyCapUsd?: number | null
  /**
   * Soft monthly budget (USD) for Muse Code projected spend
   * (`settings.museMonthlySpendCapUsd`). Defaults to $15 when unset; calendar
   * month resets on the 1st. Advisory only — never blocks a run.
   */
  museMonthlyCapUsd?: number | null
}

interface ModelUsageCardProps {
  usageSummary: ModelUsageAggregate[]
  variant?: 'card' | 'sidebar'
  /** View-B configuration. Omit to render only the quota view. */
  apiSpend?: ModelUsageApiSpendOptions
}

/**
 * Source order for the collapsed quota grid. Its compact column order is an
 * established surface and deliberately stays independent from the expanded
 * card's provider stack below.
 */
const COMPACT_QUOTA_PROVIDER_ORDER: ModelUsageProviderId[] = [
  'gemini',
  'codex',
  'claude',
  'kimi',
  'grok',
  'cursor',
  'ollama',
  'antigravity',
  'deepseek',
  'cerebras',
  'meta',
  'pi'
]

/**
 * Canonical provider stack for the expanded sidebar card and Settings → Model
 * Usage. Providers without a current meter simply leave no gap. Keep fallback
 * identities at the end so a legacy snapshot remains visible without
 * displacing the user-facing roster.
 */
export const EXPANDED_USAGE_PROVIDER_ORDER: readonly ModelUsageProviderId[] = [
  'codex',
  'claude',
  'grok',
  'kimi',
  'cursor',
  'antigravity',
  'ollama',
  'mistral',
  'mimo',
  'qwen',
  'meta',
  'deepseek',
  'cerebras',
  'gemini',
  'pi',
  'muse'
]

/**
 * Token/cost providers in the spend view (Ollama uses RAM rows).
 *
 * Exported for the lockstep test only. Every provider rendered here MUST also be
 * in `API_SPEND_PROVIDER_ORDER`, which is what `buildApiSpendAggregation` gates
 * on — a provider present here and absent there renders a row that can only ever
 * read zero. Pi shipped in exactly that state.
 */
export const API_SPEND_RENDER_ORDER: ProviderId[] = [
  'gemini',
  'codex',
  'claude',
  'kimi',
  'grok',
  'cursor',
  'antigravity',
  'pi',
  // Must move in lockstep with API_SPEND_PROVIDER_ORDER in
  // apiSpendAggregation.ts — a provider present there but missing here never
  // renders its spend section (Mistral shipped in exactly that state, the same
  // way Pi once did in the other direction).
  'mistral',
  'muse'
]
const SIDEBAR_USAGE_HEIGHT_STORAGE_KEY = 'taskwraith-sidebar-model-usage-height'
const SIDEBAR_USAGE_DEFAULT_HEIGHT = 520
const SIDEBAR_USAGE_MIN_HEIGHT = 220
// The provider meter list (six providers when this cap was tuned; the stable
// roster is ten identities now) makes the list much taller, so the drag cap
// was raised 1080 → 1400 (the rendered height is still bounded by
// `calc(100vh - 56px)` in ModelUsageCard.css so it can't overflow the
// viewport).
const SIDEBAR_USAGE_MAX_HEIGHT = 1400
const SIDEBAR_USAGE_RESIZE_STEP = 24
const COMPACT_USAGE_BASE_PROVIDERS: ProviderId[] = ['codex', 'claude', 'kimi', 'cursor', 'grok']
/** Exported for the accent-lockstep test only: every provider that can render
 *  a compact column must carry a `.model-usage-compact-cell.provider-<id>`
 *  accent rule wired to a defined `--provider-<id>-color` token, or its cost
 *  figures fall back to plain sidebar text (AGY/DeepSeek/Cerebras shipped in
 *  exactly that state). */
export const COMPACT_USAGE_PROVIDER_LABELS: Partial<Record<ModelUsageProviderId, string>> = {
  codex: 'Codex',
  claude: 'Claude',
  kimi: 'Kimi',
  cursor: 'Cursor',
  grok: 'Grok',
  ollama: 'Ollama',
  antigravity: 'AGY',
  mistral: 'Mistral',
  muse: 'Muse',
  deepseek: 'DeepSeek',
  cerebras: 'Cerebras',
  meta: 'Meta',
  mimo: 'MiMo',
  qwen: 'Qwen'
}
const COMPACT_USAGE_ROWS = [
  { key: 'fiveHour', label: '5H' },
  { key: 'weekly', label: 'WK' },
  { key: 'extraOne', label: 'X1' },
  { key: 'extraTwo', label: 'X2' }
  // No dedicated MO row: a monthly limit is just another non-5h/non-weekly
  // window, so — like Cursor's cycle limits and Codex Spark — it rides an
  // Extra (X1/X2) slot. Mistral's monthly estimate lands in X1 below.
] as const

type CompactUsageRowKey = (typeof COMPACT_USAGE_ROWS)[number]['key']

interface CompactQuotaCell {
  value: string
  fraction: number | null
  title: string
  state?: 'loading'
  estimated?: boolean
  tone?: 'warning' | 'danger'
}

function clampSidebarUsageHeight(height: number, maxHeight = SIDEBAR_USAGE_MAX_HEIGHT): number {
  return Math.max(SIDEBAR_USAGE_MIN_HEIGHT, Math.min(maxHeight, height))
}

function readSidebarUsageHeight(): number | null {
  if (typeof window === 'undefined') return null
  const raw = window.localStorage?.getItem(SIDEBAR_USAGE_HEIGHT_STORAGE_KEY)
  if (!raw) return null
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return null
  return clampSidebarUsageHeight(parsed)
}

function persistSidebarUsageHeight(height: number): void {
  if (typeof window === 'undefined') return
  window.localStorage?.setItem(SIDEBAR_USAGE_HEIGHT_STORAGE_KEY, String(Math.round(height)))
}

function sortByProvider(entries: ModelUsageAggregate[]): ModelUsageAggregate[] {
  return [...entries].sort((a, b) => {
    const aIdx = COMPACT_QUOTA_PROVIDER_ORDER.indexOf(a.provider)
    const bIdx = COMPACT_QUOTA_PROVIDER_ORDER.indexOf(b.provider)
    return (aIdx === -1 ? 99 : aIdx) - (bIdx === -1 ? 99 : bIdx)
  })
}

/** Stable, duplicate-free ordering for the expanded provider stack. */
export function orderExpandedUsageProviders(
  providers: readonly ModelUsageProviderId[]
): ModelUsageProviderId[] {
  const uniqueProviders = [...new Set(providers)]
  const sourceIndex = new Map(uniqueProviders.map((provider, index) => [provider, index]))
  return uniqueProviders.sort((left, right) => {
    const leftIndex = EXPANDED_USAGE_PROVIDER_ORDER.indexOf(left)
    const rightIndex = EXPANDED_USAGE_PROVIDER_ORDER.indexOf(right)
    const leftRank = leftIndex === -1 ? EXPANDED_USAGE_PROVIDER_ORDER.length : leftIndex
    const rightRank = rightIndex === -1 ? EXPANDED_USAGE_PROVIDER_ORDER.length : rightIndex
    return leftRank - rightRank || (sourceIndex.get(left) ?? 0) - (sourceIndex.get(right) ?? 0)
  })
}

function ProviderLabel({
  provider,
  planName
}: {
  provider: ModelUsageProviderId | undefined
  planName?: string
}) {
  const providerName = provider || 'gemini'
  return (
    <span className={`sidebar-provider-label provider-${providerName}`}>
      <ProviderLogoTile provider={provider} />
      <span className="model-usage-provider-name">{modelUsageProviderName(provider)}</span>
      {planName && planName.trim() && (
        <span className="model-usage-tier-badge">{planName.trim()}</span>
      )}
    </span>
  )
}

function modelUsageProviderName(provider?: ModelUsageProviderId): string {
  if (provider === 'deepseek') return 'DeepSeek'
  if (provider === 'cerebras') return 'Cerebras'
  if (provider === 'meta') return 'Meta API'
  if (provider === 'mimo') return 'MiMo Token Plan'
  if (provider === 'qwen') return 'Qwen Token Plan'
  return getProviderName(provider)
}

/**
 * Derive the [0, 1] USED fraction the QuotaProgressBar expects from
 * the aggregator's percent fields. As of the Phase L6 follow-up,
 * `UsageWindowAggregate.usedPercent` is HONEST — actually USED
 * percent — and `remainingPercent` is its complement. We prefer
 * `usedPercent` when set, derive from `remainingPercent` otherwise.
 */
function fillFractionForWindow(window: UsageWindowAggregate): number {
  if (Number.isFinite(window.usedPercent)) {
    return Math.max(0, Math.min(1, (window.usedPercent as number) / 100))
  }
  if (Number.isFinite(window.remainingPercent)) {
    return Math.max(0, Math.min(1, 1 - (window.remainingPercent as number) / 100))
  }
  return 0
}

function compactQuotaTone(cell: CompactQuotaCell | undefined): string {
  if (cell?.tone === 'danger') return ' is-danger'
  if (cell?.tone === 'warning') return ' is-warning'
  if (cell?.fraction == null) return ''
  if (cell.fraction >= 0.98) return ' is-danger'
  if (cell.fraction >= 0.9) return ' is-warning'
  return ''
}

function normaliseQuotaWindowText(windowEntry: UsageWindowAggregate): string {
  return `${windowEntry.id} ${windowEntry.label}`.toLowerCase().replace(/[-_+]/g, ' ')
}

/**
 * Truncate currency display values >= 10 to one decimal place so they fit in
 * the compact sidebar grid columns. Values under 10 and non-currency text
 * (percentages, "~LOW", "...") pass through unchanged.  The title/tooltip
 * always keeps the full original string.
 */
function compactCurrencyCellValue(valueText: string): string {
  const match = valueText.match(/^([~]?)(US\$|[$£€])(\d[\d,]*\.?\d*)$/)
  if (!match) return valueText
  const [, hedge, symbol, digits] = match
  const num = Number(digits.replace(/,/g, ''))
  if (!Number.isFinite(num) || num < 10) return valueText
  const truncated = Math.floor(num * 10) / 10
  const formatted = truncated.toFixed(1)
  return `${hedge}${symbol}${formatted}`
}

function compactWindowCell(
  provider: ModelUsageProviderId,
  windowEntry: UsageWindowAggregate
): CompactQuotaCell {
  const fraction = fillFractionForWindow(windowEntry)
  const percentText = `${Math.round(fraction * 100)}%`
  const valueText = windowEntry.valueText || percentText
  const resetText = formatResetShort({ resetAt: windowEntry.resetAt })
  const title = [
    `${modelUsageProviderName(provider)} ${windowEntry.label}: ${valueText}`,
    windowEntry.limitLabel,
    resetText ? `resets ${resetText}` : ''
  ]
    .filter(Boolean)
    .join(' · ')
  return { value: compactCurrencyCellValue(valueText), fraction, title }
}

function findCompactWindow(
  entry: ModelUsageAggregate | undefined,
  predicate: (text: string) => boolean
): UsageWindowAggregate | undefined {
  return entry?.windows?.find((windowEntry) => predicate(normaliseQuotaWindowText(windowEntry)))
}

function isFiveHourWindow(text: string): boolean {
  return /\b5\s*h\b/.test(text) || /\b5h\b/.test(text) || text.includes('session')
}

function isWeeklyWindow(text: string): boolean {
  return text.includes('weekly') || text.includes('7 day') || text.includes('seven day')
}

function isMonthlyWindow(text: string): boolean {
  return text.includes('monthly') || text.includes('month')
}

function isThirdPartyAgyWindow(text: string): boolean {
  return text.includes('agy') && (text.includes('3p') || text.includes('claude/gpt'))
}

function isAgyThirdPartyWeeklyWindow(text: string): boolean {
  return isThirdPartyAgyWindow(text) && isWeeklyWindow(text)
}

function isAgyThirdPartyFiveHourWindow(text: string): boolean {
  return isThirdPartyAgyWindow(text) && isFiveHourWindow(text)
}

/**
 * Expanded quota blocks lead with the short/session window, then weekly. Any
 * provider-specific extras retain their source order after those two groups.
 * The collapsed grid does its own label-based placement and never calls this.
 */
export function orderExpandedQuotaWindows(
  windows: readonly UsageWindowAggregate[]
): UsageWindowAggregate[] {
  const rank = (windowEntry: UsageWindowAggregate): number => {
    const text = normaliseQuotaWindowText(windowEntry)
    if (isThirdPartyAgyWindow(text)) return 2
    if (isFiveHourWindow(text)) return 0
    if (isWeeklyWindow(text)) return 1
    return 2
  }
  return windows
    .map((windowEntry, sourceIndex) => ({ windowEntry, sourceIndex }))
    .sort(
      (left, right) =>
        rank(left.windowEntry) - rank(right.windowEntry) || left.sourceIndex - right.sourceIndex
    )
    .map(({ windowEntry }) => windowEntry)
}

function isCodexSparkWindow(text: string): boolean {
  return text.includes('spark') || text.includes('gpt 5.3 codex')
}

function isClaudeExtraWindow(text: string): boolean {
  return text.includes('fable') || text.includes('sonnet') || text.includes('design')
}

/**
 * Display-only glyph for the branded meters (Codex Spark ⚡ / Luna Reserve 🌙,
 * Claude Fable 🪶). Provider-gated so e.g. Muse's "Spark 1.2" window never
 * borrows the Codex bolt, and matched on the same normalised id+label text the
 * compact-grid predicates use ('gpt reserve' still moons a pre-rename cached
 * snapshot label). Decoration only: the aggregate's label and the row tooltip
 * stay clean for QuotaPace, dedupe identities, and the iOS remote payload.
 */
function usageWindowGlyph(
  provider: ModelUsageProviderId,
  windowEntry: UsageWindowAggregate
): string | null {
  const text = normaliseQuotaWindowText(windowEntry)
  if (provider === 'codex') {
    if (text.includes('spark')) return '⚡'
    if (text.includes('luna') || text.includes('gpt reserve')) return '🌙'
  }
  if (provider === 'claude' && text.includes('fable')) return '🪶'
  return null
}

/**
 * The reason a lane has no quota data, when it HAS one and no windows.
 *
 * Mirrors the expanded card's admission rule (`quotaConfigured === true` plus a
 * `quotaError` renders the reason in place of window rows), so the compact strip
 * and the expanded block agree about when a provider is present-but-empty. Used
 * for tooltips only: a reason never becomes a cell value, because an empty cell
 * must not be mistakable for a reading.
 */
function quotaReasonOnlyText(entry: ModelUsageAggregate | undefined): string | null {
  if (!entry || (entry.windows?.length || 0) > 0) return null
  return entry.quotaConfigured === true && entry.quotaError ? entry.quotaError : null
}

function compactCellsForEntry(
  provider: ModelUsageProviderId,
  entry: ModelUsageAggregate | undefined
): Partial<Record<CompactUsageRowKey, CompactQuotaCell>> {
  const cells: Partial<Record<CompactUsageRowKey, CompactQuotaCell>> = {}
  const assign = (row: CompactUsageRowKey, windowEntry: UsageWindowAggregate | undefined) => {
    if (windowEntry) cells[row] = compactWindowCell(provider, windowEntry)
  }

  if (provider === 'codex') {
    assign(
      'fiveHour',
      findCompactWindow(entry, (text) => isFiveHourWindow(text) && !isCodexSparkWindow(text))
    )
    assign(
      'weekly',
      findCompactWindow(entry, (text) => isWeeklyWindow(text) && !isCodexSparkWindow(text))
    )
    assign(
      'extraOne',
      findCompactWindow(entry, (text) => isCodexSparkWindow(text) && isFiveHourWindow(text))
    )
    assign(
      'extraTwo',
      findCompactWindow(entry, (text) => isCodexSparkWindow(text) && isWeeklyWindow(text))
    )
    return cells
  }

  if (provider === 'claude') {
    assign('fiveHour', findCompactWindow(entry, isFiveHourWindow))
    assign(
      'weekly',
      findCompactWindow(entry, (text) => isWeeklyWindow(text) && !isClaudeExtraWindow(text))
    )
    assign('extraOne', findCompactWindow(entry, isClaudeExtraWindow))
    return cells
  }

  if (provider === 'antigravity') {
    // agy /usage reports Gemini and CLAUDE/GPT 3P pools as separate sub-limit
    // windows. The Gemini windows map to 5H/WK; the 3P windows map to X1/X2.
    // The same panel now also includes third-party windows; those land on X1/X2.
    assign(
      'fiveHour',
      findCompactWindow(entry, (text) => isFiveHourWindow(text) && !isThirdPartyAgyWindow(text))
    )
    assign(
      'weekly',
      findCompactWindow(entry, (text) => isWeeklyWindow(text) && !isThirdPartyAgyWindow(text))
    )
    assign('extraOne', findCompactWindow(entry, isAgyThirdPartyFiveHourWindow))
    assign('extraTwo', findCompactWindow(entry, isAgyThirdPartyWeeklyWindow))
    return cells
  }

  if (provider === 'kimi') {
    assign('fiveHour', findCompactWindow(entry, isFiveHourWindow))
    assign('weekly', findCompactWindow(entry, isWeeklyWindow))
    assign('extraOne', findCompactWindow(entry, isMonthlyWindow))
    return cells
  }

  if (provider === 'ollama') {
    // 'Session usage' matches the 5H predicate, 'Weekly usage' the weekly one
    // — the same shape Limit Counter renders from ollama.com/settings.
    assign('fiveHour', findCompactWindow(entry, isFiveHourWindow))
    assign('weekly', findCompactWindow(entry, isWeeklyWindow))
    return cells
  }

  if (provider === 'cursor') {
    assign(
      'extraOne',
      findCompactWindow(entry, (text) => text.includes('included') || text.includes('pro'))
    )
    assign(
      'extraTwo',
      findCompactWindow(entry, (text) => text.includes('auto') && text.includes('composer'))
    )
    return cells
  }

  if (provider === 'grok') {
    assign(
      'weekly',
      findCompactWindow(entry, (text) => isWeeklyWindow(text) || text.includes('credits'))
    )
    return cells
  }

  if (
    provider === 'deepseek' ||
    provider === 'cerebras' ||
    provider === 'meta' ||
    provider === 'mimo' ||
    provider === 'qwen'
  ) {
    assign('extraOne', entry?.windows?.[0])
    assign('extraTwo', entry?.windows?.[1])
  }
  return cells
}

function compactGrokCell(
  grokUsage: GrokCreditsMeterViewProps | undefined
): CompactQuotaCell | null {
  if (!grokUsage) return null
  const snapshot = grokUsage.snapshot
  if (snapshot?.confidence !== 'observed') {
    if (grokUsage.loading) {
      return {
        value: '...',
        fraction: null,
        title: 'Grok weekly usage is loading',
        state: 'loading'
      }
    }
    return null
  }
  const bandFloor = snapshot.creditsUsedDisplay.match(/^>(\d[\d.]*)%$/)
  const fraction =
    snapshot.creditsUsedPercent != null && Number.isFinite(snapshot.creditsUsedPercent)
      ? Math.max(0, Math.min(1, snapshot.creditsUsedPercent / 100))
      : bandFloor
        ? Math.max(0, Math.min(1, Number(bandFloor[1]) / 100))
        : null
  const kindText = snapshot.usageKind === 'weekly_limit' ? 'Weekly limit' : 'Subscription credits'
  return {
    value: snapshot.creditsUsedDisplay,
    fraction,
    title: `Grok ${kindText}: ${snapshot.creditsUsedDisplay}${grokUsage.stale ? ' · stale' : ''}`
  }
}

function compactMistralCell(
  mistralQuota: MistralQuotaMeterViewProps | undefined,
  currency?: DisplayCurrency,
  locale?: string
): CompactQuotaCell | null {
  const snapshot = mistralQuota?.snapshot
  if (!snapshot) return null

  const { estimate } = snapshot
  const locallyEstimatedSinceReadingUsd = Math.max(0, estimate.locallyEstimatedSinceReadingUsd ?? 0)
  const hasLocalIncrement = locallyEstimatedSinceReadingUsd > 0
  const measured = estimate.vendorReported === true
  const spendFromVendor =
    !hasLocalIncrement && (estimate.confidence === 'anchored' || estimate.confidence === 'reported')
  const ceilingFromVendor =
    estimate.ceilingConfidence === 'anchored' || estimate.ceilingConfidence === 'reported'
  const resetText = formatResetShort({ resetAt: estimate.cycleResetsAt })
  // Figures are USD; render in the user's display currency (Settings →
  // General) via the shared FX table — the reverse of the conversion the
  // console reading went through on entry, so a €0.32 reading reads €0.32.
  const money = (usd: number): string => formatCostAlwaysOn(usd, currency ?? 'USD', locale)
  const spentAmountText = formatMistralAccumulatedSpend(
    estimate.spentUsd,
    locallyEstimatedSinceReadingUsd,
    currency ?? 'USD',
    locale
  )
  const spentText = `${spendFromVendor ? '' : '~'}${spentAmountText}`
  const ceilingText = `${ceilingFromVendor ? '' : '~'}${money(estimate.estimatedCeilingUsd)}`
  const sourceText = measured
    ? 'Mistral-sourced figures'
    : hasLocalIncrement &&
        (estimate.confidence === 'anchored' || estimate.confidence === 'reported')
      ? 'Mistral baseline + local estimate'
      : 'estimated locally'
  const title = [
    `Mistral monthly: ${estimate.label}`,
    `${spentText} of ${ceilingText}`,
    hasLocalIncrement
      ? `+ ~${formatMistralLocalIncrement(
          locallyEstimatedSinceReadingUsd,
          currency ?? 'USD',
          locale
        )} tracked locally since reading`
      : '',
    resetText ? `resets ${resetText}` : '',
    sourceText,
    mistralQuota.loading ? 'refreshing' : ''
  ]
    .filter(Boolean)
    .join(' · ')
  const fraction = Math.max(0, Math.min(1, estimate.usedPercent / 100))

  return {
    // Show the actual spend figure, not the qualitative band — the compact
    // grid's "~LOW" read as an opaque label. The cell value is unhedged even
    // for a local estimate: the `~` prefix pushed the column into its
    // neighbour, and the hedged tooltip + `is-estimated` styling already say
    // it's estimated. The band still drives tone + the tooltip.
    value: compactCurrencyCellValue(spentAmountText),
    fraction,
    title,
    estimated: !measured,
    tone:
      estimate.band === 'exceeded'
        ? 'danger'
        : estimate.band === 'near-limit'
          ? 'warning'
          : undefined
  }
}

export function CompactModelUsageGrid({
  quotaEntries,
  grokUsage,
  mistralQuota,
  currency,
  locale
}: {
  quotaEntries: ModelUsageAggregate[]
  grokUsage?: GrokCreditsMeterViewProps
  mistralQuota?: MistralQuotaMeterViewProps
  currency?: DisplayCurrency
  locale?: string
}) {
  const entriesByProvider = new Map(quotaEntries.map((entry) => [entry.provider, entry]))
  const mistralCell = compactMistralCell(mistralQuota, currency, locale)
  // The AGY column appears once the credential-free snapshot hook has produced
  // quota data, OR when a caller has an explicit reason to report an empty
  // lane. A non-configured lane contributes no entry and stays absent.
  const antigravityCells = compactCellsForEntry('antigravity', entriesByProvider.get('antigravity'))
  const hasAntigravityCells = Object.keys(antigravityCells).length > 0
  const antigravityReason = quotaReasonOnlyText(entriesByProvider.get('antigravity'))
  // Ollama joins on the same terms as AGY: a column once the imported web
  // session has produced Session/Weekly data, or an explained-empty lane.
  const ollamaCells = compactCellsForEntry('ollama', entriesByProvider.get('ollama'))
  const hasOllamaCells = Object.keys(ollamaCells).length > 0
  const ollamaReason = quotaReasonOnlyText(entriesByProvider.get('ollama'))
  const providers: ModelUsageProviderId[] = [
    ...COMPACT_USAGE_BASE_PROVIDERS,
    ...(hasOllamaCells || ollamaReason ? (['ollama'] as const) : []),
    ...(hasAntigravityCells || antigravityReason ? (['antigravity'] as const) : []),
    ...(mistralCell ? (['mistral'] as const) : []),
    ...(entriesByProvider.has('mimo') ? (['mimo'] as const) : []),
    ...(entriesByProvider.has('qwen') ? (['qwen'] as const) : []),
    ...(entriesByProvider.has('meta') ? (['meta'] as const) : []),
    ...(entriesByProvider.has('deepseek') ? (['deepseek'] as const) : []),
    ...(entriesByProvider.has('cerebras') ? (['cerebras'] as const) : [])
  ]
  const rows = COMPACT_USAGE_ROWS
  const cellsByProvider = new Map(
    providers.map((provider) => [
      provider,
      compactCellsForEntry(provider, entriesByProvider.get(provider))
    ])
  )
  const grokCell = compactGrokCell(grokUsage)
  if (grokCell) {
    cellsByProvider.set('grok', { ...cellsByProvider.get('grok'), weekly: grokCell })
  }
  if (mistralCell) {
    // Monthly-cycle limit → the first Extra slot, matching Cursor's cycle
    // rows. Mistral has no 5h/weekly window, so X1 is its natural home.
    cellsByProvider.set('mistral', {
      ...cellsByProvider.get('mistral'),
      extraOne: mistralCell
    })
  }

  const showWindowLegend = providers.length <= 8

  return (
    <table className="model-usage-compact-grid" aria-label="Compact model usage">
      <thead>
        <tr>
          {showWindowLegend && (
            <th scope="col" className="model-usage-compact-corner" aria-label="Window" />
          )}
          {providers.map((provider) => (
            <th key={provider} scope="col" className={`provider-${provider}`}>
              {COMPACT_USAGE_PROVIDER_LABELS[provider]}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.key}>
            {showWindowLegend && <th scope="row">{row.label}</th>}
            {providers.map((provider) => {
              const cell = cellsByProvider.get(provider)?.[row.key]
              return (
                <td
                  key={`${row.key}-${provider}`}
                  className={`model-usage-compact-cell provider-${provider}${
                    cell ? compactQuotaTone(cell) : ' is-empty'
                  }${cell?.state === 'loading' ? ' is-loading' : ''}${
                    cell?.estimated ? ' is-estimated' : ''
                  }`}
                  title={
                    cell?.title ||
                    // An explained empty cell says WHY, rather than the generic
                    // "unavailable" that reads as a fault. Same reason string
                    // the expanded card shows, so the two never disagree.
                    (provider === 'antigravity' && antigravityReason
                      ? `${COMPACT_USAGE_PROVIDER_LABELS[provider]} ${row.label}: ${antigravityReason}`
                      : provider === 'ollama' && ollamaReason
                        ? `${COMPACT_USAGE_PROVIDER_LABELS[provider]} ${row.label}: ${ollamaReason}`
                        : `${COMPACT_USAGE_PROVIDER_LABELS[provider]} ${row.label}: unavailable`)
                  }
                >
                  {cell?.value || '--'}
                </td>
              )
            })}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function UsageWindowRow({
  provider,
  windowEntry
}: {
  provider: ModelUsageProviderId
  windowEntry: UsageWindowAggregate
}) {
  const fraction = fillFractionForWindow(windowEntry)
  const percentText = `${Math.round(fraction * 100)}%`
  const windowReset = formatResetShort({ resetAt: windowEntry.resetAt })
  const title = `${windowEntry.label}: ${windowEntry.limitLabel}${
    windowReset ? ` · resets ${windowReset}` : ''
  }`
  // Phase L6 slice 2 — accent picks up the provider colour token so
  // each provider's bars read in their own brand colour. The CSS
  // variable name matches the token set defined in theme.css.
  const accent = `var(--provider-${provider}-color)`
  const glyph = usageWindowGlyph(provider, windowEntry)
  return (
    <div key={`${provider}-${windowEntry.id}`} className="model-usage-window" title={title}>
      <div className="model-usage-window-row">
        <span className="model-usage-window-label">
          {glyph ? (
            <span className="model-usage-window-glyph" aria-hidden="true">{`${glyph} `}</span>
          ) : null}
          {windowEntry.label}
        </span>
        {windowReset && <span className="model-usage-window-reset">resets {windowReset}</span>}
        <span className="model-usage-window-percent">{windowEntry.valueText || percentText}</span>
      </div>
      <QuotaProgressBar
        fraction={fraction}
        accent={accent}
        /* Phase L6 slice 3 — pace tick. `computeQuotaPace` returns
         * `null` for on-track / unmeasurable windows and the bar
         * paints no tick in that case. */
        pace={computeQuotaPace(windowEntry)}
      />
      <div className="model-usage-window-meta">
        <span>{windowEntry.limitLabel}</span>
      </div>
    </div>
  )
}

function ProviderUsageBlock({ entry }: { entry: ModelUsageAggregate }) {
  const hasWindows = Boolean(entry.windows?.length)
  return (
    <div
      key={`${entry.provider}-${entry.model}`}
      className={`model-usage-item provider-${entry.provider} quota-only`}
    >
      <div className="model-usage-provider-heading">
        <ProviderLabel provider={entry.provider} planName={entry.planName} />
      </div>
      <div className="model-usage-window-list">
        {hasWindows ? (
          orderExpandedQuotaWindows(entry.windows!).map((windowEntry) => (
            <UsageWindowRow
              key={`${entry.provider}-${windowEntry.id}`}
              provider={entry.provider}
              windowEntry={windowEntry}
            />
          ))
        ) : (
          // An empty quota row says "No data" and carries the WHY in its
          // title, exactly as the compact strip already does. The reason is a
          // full sentence ("no authenticated agy connection was detected. Sign
          // in with the official CLI, then refresh.") — rendering it inline
          // turned one provider's row into a paragraph that swamped every other
          // provider in the card. The explanation is still one hover away, and
          // still identical to the compact strip's, so the two cannot disagree.
          <div
            className="model-usage-quota-unavailable"
            role="status"
            title={entry.quotaError || 'Quota unavailable.'}
          >
            No data
          </div>
        )}
      </div>
    </div>
  )
}

function ModelUsageDisclosureIcon({ isExpanded }: { isExpanded: boolean }) {
  return (
    <span className={`model-usage-toggle-icon ${isExpanded ? 'is-expanded' : ''}`} aria-hidden>
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M6.2 4.7 10 8.1 6.2 11.5" />
      </svg>
    </span>
  )
}

function ModelUsageRefreshIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M13.2 6.2A5.1 5.1 0 0 0 4.5 3.1L3 4.6" />
      <path d="M3 2.2v2.4h2.4" />
      <path d="M2.8 9.8a5.1 5.1 0 0 0 8.7 3.1l1.5-1.5" />
      <path d="M13 13.8v-2.4h-2.4" />
    </svg>
  )
}

/** "Plan limits" glyph — a shield with a gauge needle, reading as
 * "protected quota / allowance". Stroked so it themes via currentColor. */
function PlanLimitsGlyph() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M8 1.6 13 3.4v4.1c0 3.2-2.1 5.6-5 6.9-2.9-1.3-5-3.7-5-6.9V3.4L8 1.6Z" />
      <path d="M5.4 9.1a3 3 0 0 1 5.2 0" />
      <path d="M8 9 9.7 6.6" />
      <circle cx="8" cy="9.2" r="0.75" fill="currentColor" stroke="none" />
    </svg>
  )
}

/** "API spend" glyph — a coin stack with a currency mark, reading as
 * "money / spend". Stroked so it themes via currentColor. */
function ApiSpendGlyph() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <ellipse cx="8" cy="4" rx="5" ry="2.2" />
      <path d="M3 4v3.4c0 1.2 2.2 2.2 5 2.2s5-1 5-2.2V4" />
      <path d="M3 7.4v3.4c0 1.2 2.2 2.2 5 2.2s5-1 5-2.2V7.4" />
    </svg>
  )
}

/** "Context length" glyph — a bracketed window / span, reading as "context window". */
function ContextLengthGlyph() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M4.5 3.5 2 8l2.5 4.5" />
      <path d="M11.5 3.5 14 8l-2.5 4.5" />
      <path d="M6 8h4" />
    </svg>
  )
}

const API_SPEND_WINDOW_LABEL: Record<ApiSpendWindowKey, string> = {
  day: 'Day',
  week: '7d',
  month: '30d'
}

/** One Day/7d/30d row inside a provider's API-spend section. Shows the
 * token total + projected spend in the user's display currency. */
function ApiSpendRow({
  windowKey,
  totals
}: {
  windowKey: ApiSpendWindowKey
  totals: ApiSpendProviderTotals[ApiSpendWindowKey]
}) {
  const hasTokens = totals.totalTokens > 0
  return (
    <div className="model-usage-spend-row">
      <span className="model-usage-spend-window">{API_SPEND_WINDOW_LABEL[windowKey]}</span>
      <span
        className="model-usage-spend-tokens"
        title={`${totals.totalTokens.toLocaleString()} tokens`}
      >
        {hasTokens ? `${formatTokenCount(totals.totalTokens)} tok` : '—'}
      </span>
      <span
        className="model-usage-spend-cost"
        title={totals.costDisplay ? 'Projected API-equivalent — estimated, not billed' : undefined}
      >
        {totals.costDisplay ? `~${totals.costDisplay}` : '—'}
      </span>
    </div>
  )
}

/**
 * Calendar-month budget meter row (AntiGravity Gemini API key lane). Distinct
 * from the rolling 30d row above it: a budget resets with the billing month,
 * so this counts from the 1st and says when it resets. Exported for SSR tests.
 */
export function ApiSpendCapMeterRow({
  meter,
  accent = 'var(--provider-antigravity-color, var(--accent))',
  testId = 'antigravity-cap-meter-label',
  title = 'Estimated month-to-date spend vs your soft budget — advisory only, never blocks a run. Set a hard limit in your billing console.'
}: {
  meter: CalendarMonthSpendMeter
  accent?: string
  testId?: string
  title?: string
}) {
  const spent = meter.spentDisplay ? `~${meter.spentDisplay}` : '—'
  const label =
    meter.capUsd === null
      ? `${spent} this month`
      : `${spent} of ${meter.capDisplay} · resets ${meter.resetLabel}`
  return (
    <div className="model-usage-spend-cap-meter" title={title}>
      <div className="model-usage-spend-row">
        <span className="model-usage-spend-window">Budget</span>
        <span className="model-usage-spend-cost" data-testid={testId}>
          {label}
        </span>
      </div>
      {meter.capUsd !== null && <QuotaProgressBar fraction={meter.fraction} accent={accent} />}
    </div>
  )
}

/** One provider's API-spend section (heading + three window rows).
 * Exported for SSR render tests — pure given its `entry`. */
export function ApiSpendProviderBlock({
  entry,
  capMeter
}: {
  entry: ApiSpendProviderTotals
  /** Present when a calendar-month soft budget is configured (AGY / Muse). */
  capMeter?: CalendarMonthSpendMeter | null
}) {
  const capAccent =
    entry.provider === 'muse'
      ? 'var(--provider-muse-color, var(--provider-meta-color, var(--accent)))'
      : 'var(--provider-antigravity-color, var(--accent))'
  const capTestId =
    entry.provider === 'muse' ? 'muse-cap-meter-label' : 'antigravity-cap-meter-label'
  const capTitle =
    entry.provider === 'muse'
      ? 'Estimated month-to-date Muse spend vs your soft budget — advisory only, never blocks a run. Set a hard limit in Meta / Model API billing if you need one.'
      : 'Estimated month-to-date spend vs your soft budget — advisory only, never blocks a run. Set a hard limit in your Google Cloud billing console.'
  return (
    <div className={`model-usage-item provider-${entry.provider} spend-only`}>
      <div className="model-usage-provider-heading">
        <span className={`sidebar-provider-label provider-${entry.provider}`}>
          <ProviderLogoTile provider={entry.provider} />
          <span className="model-usage-provider-name">{getProviderName(entry.provider)}</span>
        </span>
      </div>
      <div className="model-usage-spend-rows">
        {API_SPEND_WINDOW_ORDER.map((windowKey) => (
          <ApiSpendRow key={windowKey} windowKey={windowKey} totals={entry[windowKey]} />
        ))}
        {capMeter ? (
          <ApiSpendCapMeterRow
            meter={capMeter}
            accent={capAccent}
            testId={capTestId}
            title={capTitle}
          />
        ) : null}
      </div>
    </div>
  )
}

/** One Day/7d/30d row for Ollama's RAM section (avg peak + sample polls). */
function OllamaMemorySpendRow({
  windowKey,
  totals
}: {
  windowKey: ApiSpendWindowKey
  totals: OllamaMemoryWindowTotals
}) {
  return (
    <div className="model-usage-spend-row model-usage-spend-row--memory">
      <span className="model-usage-spend-window">{API_SPEND_WINDOW_LABEL[windowKey]}</span>
      <span
        className="model-usage-spend-tokens"
        title={
          totals.avgPeakRssGb > 0
            ? `Average per-run peak llama-server RSS (${API_SPEND_WINDOW_LABEL[windowKey]})`
            : undefined
        }
      >
        {formatOllamaMemoryAvgCell(totals.avgPeakRssGb)}
      </span>
      <span
        className="model-usage-spend-cost"
        title={
          totals.runs > 0
            ? `Average periodic memory samples per run (${API_SPEND_WINDOW_LABEL[windowKey]})`
            : undefined
        }
      >
        {formatOllamaSampleAvgCell(totals.avgSampleCount, totals.runs)}
      </span>
    </div>
  )
}

/** Ollama RAM section for View B. Exported for SSR render tests. */
export function OllamaMemorySpendBlock({ entry }: { entry: OllamaMemorySpendTotals }) {
  return (
    <div className="model-usage-item provider-ollama spend-only memory-only">
      <div className="model-usage-provider-heading">
        <span className="sidebar-provider-label provider-ollama">
          <ProviderLogoTile provider="ollama" />
          <span className="model-usage-provider-name">{getProviderName('ollama')}</span>
        </span>
      </div>
      <div className="model-usage-spend-rows">
        {API_SPEND_WINDOW_ORDER.map((windowKey) => (
          <OllamaMemorySpendRow key={windowKey} windowKey={windowKey} totals={entry[windowKey]} />
        ))}
      </div>
    </div>
  )
}

export function ContextLengthsView() {
  // Fully static (curated catalog × the static context-window table), so build
  // once — the sidebar card re-renders on resize/expand and settings round-trips.
  // Sidebar variant: include local Ollama models, omit Gemini (kept in the
  // fuller Settings → Model Usage table) to keep the narrow panel focused.
  const groups = useMemo(
    () => buildModelContextLengthGroups({ includeOllama: true, excludeProviders: ['gemini'] }),
    []
  )
  return (
    <div className="model-usage-list model-usage-context-list">
      {groups.map((group) => (
        <div
          key={group.provider}
          className={`model-usage-item provider-${group.provider} context-only`}
        >
          <div className="model-usage-provider-heading">
            <span className={`sidebar-provider-label provider-${group.provider}`}>
              <ProviderLogoTile provider={group.provider} />
              <span className="model-usage-provider-name">{getProviderName(group.provider)}</span>
            </span>
          </div>
          <div className="model-usage-context-rows">
            {group.models.map((m) => (
              <div key={m.modelId} className="model-usage-context-row">
                <span className="model-usage-context-model" title={m.modelId}>
                  {humaniseModelIdCompact(group.provider, m.modelId) || m.label}
                </span>
                <span
                  className="model-usage-context-window"
                  title={
                    m.maxContextWindow
                      ? `${m.contextWindow.toLocaleString()}–${m.maxContextWindow.toLocaleString()} tokens (plan-dependent)`
                      : `${m.contextWindow.toLocaleString()} tokens`
                  }
                >
                  {m.formatted}
                </span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

/**
 * View B body. Fetches usage records over the existing `getUsage` IPC
 * (same pattern as `UsageHeatmap`), aggregates them through the pure
 * `buildApiSpendByProvider` helper, and renders one section per active
 * provider. Spend is the projected API-equivalent (records carry no
 * stored cost), priced via the rate table + converted to display
 * currency. Renders an honest empty state when there's nothing to show.
 */
function ApiSpendView({ options }: { options: ModelUsageApiSpendOptions | undefined }) {
  const [records, setRecords] = useState<UsageRecord[]>([])
  const [chats, setChats] = useState<ChatListItem[]>([])
  const refreshKey = options?.refreshKey ?? 0

  useEffect(() => {
    if (typeof window === 'undefined') return
    let cancelled = false
    // Shared renderer cache: the refreshKey bump follows a usage-changed
    // broadcast, and App's handler has already force-seeded the cache — this
    // join is a cache hit instead of a third identical getUsage IPC call.
    const usagePromise = loadRendererUsageRecords('taskwraith').catch(() => [] as UsageRecord[])
    // Lean chat list: runsSummary carries the Ollama RAM stats this view
    // derives from — no need to ship every chat's full transcript.
    const chatsPromise =
      typeof window.api?.getChatList === 'function'
        ? window.api.getChatList().catch(() => [] as ChatListItem[])
        : Promise.resolve([] as ChatListItem[])
    void Promise.all([usagePromise, chatsPromise]).then(([latestUsage, latestChats]) => {
      if (cancelled) return
      setRecords(Array.isArray(latestUsage) ? latestUsage : [])
      setChats(Array.isArray(latestChats) ? latestChats : [])
    })
    return () => {
      cancelled = true
    }
  }, [refreshKey])

  const spend = useMemo<ApiSpendProviderTotals[]>(() => {
    const currencyOptions: ApiSpendCurrencyOptions = {
      currency: options?.currency,
      overestimatePercent: options?.overestimatePercent,
      locale: options?.locale
    }
    return buildApiSpendByProvider(records, options?.providerRates ?? {}, currencyOptions)
    // The helper reads the clock when it runs, so the rolling Day/7d/30d windows
    // are anchored at recompute time. This memo re-runs only when records/options
    // change (a new run bumps refreshKey → refetch → records), so an idle card
    // keeps its last cutoffs until the next usage-changed tick.
  }, [
    records,
    options?.providerRates,
    options?.currency,
    options?.overestimatePercent,
    options?.locale
  ])

  const ollamaMemory = useMemo(
    () => buildOllamaMemorySpend(mergeOllamaMemoryUsageRecords(records, chats)),
    [records, chats]
  )

  // Calendar month-to-date budget meters for soft-cap lanes (AGY key + Muse).
  // Only materialised when a positive cap is configured — without one the
  // rolling rows already tell the whole story.
  const antigravityCapMeter = useMemo<CalendarMonthSpendMeter | null>(() => {
    const capUsd = options?.antigravityMonthlyCapUsd
    if (!Number.isFinite(capUsd) || (capUsd as number) <= 0) return null
    return buildProviderCalendarMonthSpend(
      records,
      options?.providerRates ?? {},
      'antigravity',
      capUsd,
      {
        currency: options?.currency,
        overestimatePercent: options?.overestimatePercent,
        locale: options?.locale
      }
    )
  }, [
    records,
    options?.providerRates,
    options?.antigravityMonthlyCapUsd,
    options?.currency,
    options?.overestimatePercent,
    options?.locale
  ])

  const museCapMeter = useMemo<CalendarMonthSpendMeter | null>(() => {
    const capUsd = options?.museMonthlyCapUsd
    if (!Number.isFinite(capUsd) || (capUsd as number) <= 0) return null
    return buildProviderCalendarMonthSpend(records, options?.providerRates ?? {}, 'muse', capUsd, {
      currency: options?.currency,
      overestimatePercent: options?.overestimatePercent,
      locale: options?.locale
    })
  }, [
    records,
    options?.providerRates,
    options?.museMonthlyCapUsd,
    options?.currency,
    options?.overestimatePercent,
    options?.locale
  ])

  if (spend.length === 0 && !ollamaMemory) {
    return (
      <div className="model-usage-spend-empty">
        No API spend tracked in the last 30 days. Runs on API keys / SDK credits show their
        projected cost here.
      </div>
    )
  }

  // Count only the runs that feed the displayed windows (the 30d window is the
  // widest), so the footnote can't claim runs from excluded providers or older
  // than the view shows.
  const shownRuns =
    spend.reduce((total, entry) => total + entry.month.runs, 0) + (ollamaMemory?.month.runs ?? 0)
  const spendByProvider = new Map(spend.map((entry) => [entry.provider, entry]))
  return (
    <div className="model-usage-list model-usage-spend-list">
      {API_SPEND_RENDER_ORDER.map((provider) => {
        const entry = spendByProvider.get(provider)
        const capMeter =
          provider === 'antigravity'
            ? antigravityCapMeter
            : provider === 'muse'
              ? museCapMeter
              : null
        return entry ? (
          <ApiSpendProviderBlock key={provider} entry={entry} capMeter={capMeter} />
        ) : null
      })}
      {ollamaMemory ? <OllamaMemorySpendBlock entry={ollamaMemory} /> : null}
      <p className="model-usage-spend-footnote">
        Estimated API-equivalent · not billed ·{' '}
        {shownRuns === 1 ? '1 run' : `${shownRuns.toLocaleString()} runs`}
        {ollamaMemory ? ' · Ollama shows average llama-server RAM' : ''}
      </p>
    </div>
  )
}

export function ModelUsageCard({
  usageSummary: usageSummaryFallback,
  variant = 'card',
  apiSpend
}: ModelUsageCardProps) {
  const usageSummary = useUsageSummary(usageSummaryFallback)
  const quotaContentId = useId()
  const summaryRef = useRef<HTMLDivElement | null>(null)
  // Active view. Seed from the persisted pref (`apiSpend.view`) and keep a
  // local mirror so a click flips instantly even before the settings round-
  // trip resolves. We reconcile to the persisted value *during render* (the
  // React-recommended pattern, no effect) by tracking the last-seen pref: when
  // the persisted pref changes externally, adopt it; otherwise keep the local
  // optimistic value.
  const persistedView = apiSpend?.view ?? 'plan'
  const [view, setView] = useState<ModelUsagePanelView>(persistedView)
  const [lastPersistedView, setLastPersistedView] = useState<ModelUsagePanelView>(persistedView)
  if (persistedView !== lastPersistedView) {
    setLastPersistedView(persistedView)
    setView(persistedView)
  }
  const selectView = (next: ModelUsagePanelView) => {
    if (next === view) return
    setView(next)
    apiSpend?.onViewChange?.(next)
  }
  const resizeStartRef = useRef<{
    height: number
    maxHeight: number
    pointerId: number
    y: number
  } | null>(null)
  const [sidebarHeightPx, setSidebarHeightPx] = useState<number | null>(() =>
    readSidebarUsageHeight()
  )
  const sidebarHeightRef = useRef<number | null>(sidebarHeightPx)
  const [sidebarExpanded, setSidebarExpanded] = useState(false)
  const [sidebarResizing, setSidebarResizing] = useState(false)
  const [localRefreshPending, setLocalRefreshPending] = useState(false)
  // Grok subscription-credit meter gate. Grok is NOT part of the token/cost
  // `usageSummary` (its credit pool comes from a separate on-demand PTY probe),
  // so we surface it only when the gated Grok provider adapter is registered.
  const [grokAvailable, setGrokAvailable] = useState(false)
  useEffect(() => {
    let active = true
    if (typeof window === 'undefined' || typeof window.api?.getProviderAdapters !== 'function') {
      return
    }
    void window.api
      .getProviderAdapters()
      .then((adapters) => {
        if (!active) return
        const ids = Array.isArray(adapters)
          ? adapters.map((adapter) => (adapter as { provider?: string } | null)?.provider)
          : []
        setGrokAvailable(ids.includes('grok'))
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [])
  const grokUsage = useGrokCreditsMeterState(apiSpend?.refreshKey, grokAvailable)
  // Mistral's band is gated on a PERSISTED CYCLE, not on adapter registration:
  // the seat publishes no quota, so the only evidence worth metering is spend we
  // actually observed. A user who has never run Mistral gets a null snapshot and
  // no row. (This also means the meter does not depend on the adapter-descriptor
  // probe above, which is a separate lane with its own timing.)
  const mistralQuota = useMistralQuotaMeterState(apiSpend?.refreshKey)
  const mistralQuotaAvailable = mistralQuota.snapshot !== null
  const quotaEntries = sortByProvider(usageSummary).filter(
    (entry) =>
      entry.model === 'usage limits' &&
      ((entry.windows?.length || 0) > 0 ||
        (entry.quotaConfigured === true && Boolean(entry.quotaError)))
  )
  const expandedUsageProviders = orderExpandedUsageProviders([
    ...quotaEntries.map((entry) => entry.provider),
    ...(grokAvailable ? (['grok'] as const) : []),
    ...(mistralQuotaAvailable ? (['mistral'] as const) : [])
  ])
  // The API-spend view is offered whenever the caller wired it (sidebar).
  const apiSpendEnabled = Boolean(apiSpend)
  // A plan-side meter exists when there are quota entries, the gated Grok
  // credit meter, or Mistral's estimated band. Only then is the Plan ⇄ Spend
  // choice meaningful.
  const hasPlanMeters = quotaEntries.length > 0 || grokAvailable || mistralQuotaAvailable
  const planViewAvailable =
    hasPlanMeters || (apiSpend?.planAvailabilityPending === true && view === 'plan')
  const isSidebarVariant = variant === 'sidebar'
  // Render when there's a plan-side meter OR the API-spend view is available (so
  // a user on API keys with no plan meters can still reach their spend).
  // The context-lengths tab is a static reference; offer it in the sidebar overlay
  // (where the view toggle lives — i.e. whenever apiSpend is wired).
  const contextViewAvailable = isSidebarVariant && apiSpendEnabled
  if (!planViewAvailable && !apiSpendEnabled) return null
  const availableViewCount =
    Number(planViewAvailable) + Number(apiSpendEnabled) + Number(contextViewAvailable)
  const showViewToggle = availableViewCount >= 2
  const viewIsAvailable = (candidate: ModelUsagePanelView): boolean =>
    candidate === 'plan'
      ? planViewAvailable
      : candidate === 'spend'
        ? apiSpendEnabled
        : contextViewAvailable
  const effectiveView: ModelUsagePanelView = viewIsAvailable(view)
    ? view
    : planViewAvailable
      ? 'plan'
      : apiSpendEnabled
        ? 'spend'
        : 'context'
  const showQuotaEntries = !isSidebarVariant || sidebarExpanded
  const showCollapsedCompactUsage = isSidebarVariant && !sidebarExpanded && planViewAvailable
  const title = sidebarExpanded ? 'Collapse provider usage' : 'Expand provider usage'
  const refreshTitle = 'Refresh usage data'
  const usageRefreshPending = localRefreshPending || apiSpend?.refreshing === true
  const ariaHeight = Math.round(sidebarHeightPx ?? SIDEBAR_USAGE_DEFAULT_HEIGHT)
  const rootClassName = [
    'run-summary',
    'model-usage-summary',
    isSidebarVariant ? 'model-usage-summary--sidebar' : '',
    isSidebarVariant && sidebarExpanded ? 'is-resizable' : '',
    isSidebarVariant && !sidebarExpanded ? 'is-collapsed' : '',
    sidebarResizing ? 'is-resizing' : ''
  ]
    .filter(Boolean)
    .join(' ')
  const rootStyle =
    isSidebarVariant && sidebarExpanded && sidebarHeightPx
      ? ({ '--model-usage-sidebar-height': `${sidebarHeightPx}px` } as CSSProperties)
      : undefined

  const getSidebarResizeMaxHeight = (): number => {
    if (typeof window === 'undefined') return SIDEBAR_USAGE_MAX_HEIGHT
    const parentHeight = summaryRef.current?.parentElement?.getBoundingClientRect().height
    const viewportMax = window.innerHeight - 56
    const parentMax = parentHeight ? parentHeight - 24 : SIDEBAR_USAGE_MAX_HEIGHT
    return Math.max(
      SIDEBAR_USAGE_MIN_HEIGHT,
      Math.min(SIDEBAR_USAGE_MAX_HEIGHT, viewportMax, parentMax)
    )
  }

  const updateSidebarHeight = (height: number, maxHeight = getSidebarResizeMaxHeight()): number => {
    const nextHeight = clampSidebarUsageHeight(height, maxHeight)
    sidebarHeightRef.current = nextHeight
    setSidebarHeightPx(nextHeight)
    return nextHeight
  }

  const startSidebarResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!isSidebarVariant || !sidebarExpanded || event.button !== 0) return
    const currentHeight =
      sidebarHeightRef.current ?? summaryRef.current?.getBoundingClientRect().height ?? 0
    const maxHeight = getSidebarResizeMaxHeight()
    resizeStartRef.current = {
      height: clampSidebarUsageHeight(currentHeight || SIDEBAR_USAGE_DEFAULT_HEIGHT, maxHeight),
      maxHeight,
      pointerId: event.pointerId,
      y: event.clientY
    }
    setSidebarResizing(true)
    event.currentTarget.setPointerCapture(event.pointerId)
    event.preventDefault()
  }

  const moveSidebarResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = resizeStartRef.current
    if (!start || start.pointerId !== event.pointerId) return
    const delta = start.y - event.clientY
    updateSidebarHeight(start.height + delta, start.maxHeight)
  }

  const endSidebarResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = resizeStartRef.current
    if (!start || start.pointerId !== event.pointerId) return
    resizeStartRef.current = null
    setSidebarResizing(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    const finalHeight = sidebarHeightRef.current
    if (finalHeight) persistSidebarUsageHeight(finalHeight)
  }

  const resizeSidebarWithKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!isSidebarVariant || !sidebarExpanded) return
    const maxHeight = getSidebarResizeMaxHeight()
    const currentHeight =
      sidebarHeightRef.current ??
      summaryRef.current?.getBoundingClientRect().height ??
      SIDEBAR_USAGE_DEFAULT_HEIGHT
    const step = event.shiftKey ? SIDEBAR_USAGE_RESIZE_STEP * 2 : SIDEBAR_USAGE_RESIZE_STEP
    let nextHeight: number | null = null

    if (event.key === 'ArrowUp') nextHeight = currentHeight + step
    if (event.key === 'ArrowDown') nextHeight = currentHeight - step
    if (event.key === 'Home') nextHeight = SIDEBAR_USAGE_MIN_HEIGHT
    if (event.key === 'End') nextHeight = maxHeight
    if (nextHeight === null) return

    event.preventDefault()
    persistSidebarUsageHeight(updateSidebarHeight(nextHeight, maxHeight))
  }

  const refreshProviderUsage = () => {
    if (!apiSpend?.onRefreshUsage || usageRefreshPending) return
    setLocalRefreshPending(true)
    void Promise.resolve(apiSpend.onRefreshUsage())
      .catch(() => {
        // The caller owns surfacing refresh errors; keep the sidebar control
        // self-resetting so a transient provider failure doesn't strand it.
      })
      .finally(() => {
        setLocalRefreshPending(false)
      })
  }

  return (
    <div ref={summaryRef} className={rootClassName} style={rootStyle}>
      {isSidebarVariant && sidebarExpanded && (
        <div
          role="separator"
          tabIndex={0}
          className="model-usage-resize-handle"
          aria-label="Resize model usage panel"
          aria-orientation="horizontal"
          aria-valuemin={SIDEBAR_USAGE_MIN_HEIGHT}
          aria-valuemax={SIDEBAR_USAGE_MAX_HEIGHT}
          aria-valuenow={ariaHeight}
          aria-valuetext={`${ariaHeight}px tall`}
          title="Drag to resize Model Usage"
          onPointerDown={startSidebarResize}
          onPointerMove={moveSidebarResize}
          onPointerUp={endSidebarResize}
          onPointerCancel={endSidebarResize}
          onKeyDown={resizeSidebarWithKeyboard}
        >
          <span className="model-usage-resize-grip" aria-hidden />
        </div>
      )}
      <div className="model-usage-summary-header">
        <div className="run-summary-title">Model Usage</div>
        {showViewToggle && (
          <div
            className="segmented-control segmented-control--compact model-usage-view-toggle"
            role="radiogroup"
            aria-label="Model usage view"
          >
            {planViewAvailable && (
              <button
                type="button"
                role="radio"
                aria-checked={effectiveView === 'plan'}
                className={`segmented-control-segment model-usage-view-toggle-btn ${effectiveView === 'plan' ? 'is-active' : ''}`}
                onClick={() => selectView('plan')}
                aria-label="Plan limits"
                title="Plan limits"
              >
                <PlanLimitsGlyph />
              </button>
            )}
            {apiSpendEnabled && (
              <button
                type="button"
                role="radio"
                aria-checked={effectiveView === 'spend'}
                className={`segmented-control-segment model-usage-view-toggle-btn ${effectiveView === 'spend' ? 'is-active' : ''}`}
                onClick={() => selectView('spend')}
                aria-label="API spend"
                title="API spend"
              >
                <ApiSpendGlyph />
              </button>
            )}
            {contextViewAvailable && (
              <button
                type="button"
                role="radio"
                aria-checked={effectiveView === 'context'}
                className={`segmented-control-segment model-usage-view-toggle-btn ${effectiveView === 'context' ? 'is-active' : ''}`}
                onClick={() => selectView('context')}
                aria-label="Context lengths"
                title="Context lengths"
              >
                <ContextLengthGlyph />
              </button>
            )}
          </div>
        )}
        {isSidebarVariant && apiSpend?.onRefreshUsage && (
          <button
            type="button"
            className={`model-usage-refresh-button ${usageRefreshPending ? 'is-refreshing' : ''}`}
            onClick={refreshProviderUsage}
            aria-label={refreshTitle}
            title={refreshTitle}
            disabled={usageRefreshPending}
          >
            <ModelUsageRefreshIcon />
          </button>
        )}
        {isSidebarVariant && (
          <button
            type="button"
            className="model-usage-toggle"
            onClick={() => setSidebarExpanded((current) => !current)}
            aria-expanded={sidebarExpanded}
            aria-controls={quotaContentId}
            aria-label={title}
            title={title}
          >
            <ModelUsageDisclosureIcon isExpanded={sidebarExpanded} />
          </button>
        )}
      </div>
      <div className="model-usage-liquid-card">
        {showCollapsedCompactUsage && (
          <CompactModelUsageGrid
            quotaEntries={quotaEntries}
            grokUsage={grokUsage}
            mistralQuota={mistralQuota}
            currency={apiSpend?.currency}
            locale={apiSpend?.locale}
          />
        )}
        <div
          id={quotaContentId}
          className="model-usage-collapsible"
          aria-hidden={!showQuotaEntries}
        >
          <div className="model-usage-collapsible-inner">
            {effectiveView === 'spend' ? (
              <ApiSpendView options={apiSpend} />
            ) : effectiveView === 'context' ? (
              <ContextLengthsView />
            ) : (
              <div className="model-usage-list">
                {expandedUsageProviders.map((provider) => (
                  <Fragment key={provider}>
                    {quotaEntries
                      .filter((entry) => entry.provider === provider)
                      .map((entry) => (
                        <ProviderUsageBlock
                          key={`${entry.provider}-${entry.model}`}
                          entry={entry}
                        />
                      ))}
                    {/* Grok and Mistral have bespoke quota data models rather
                     * than `entry.windows`; place them through the same provider
                     * ordering path so they no longer fall to the list tail. */}
                    {provider === 'grok' && grokAvailable ? (
                      <GrokCreditsMeterView {...grokUsage} />
                    ) : null}
                    {provider === 'mistral' && mistralQuotaAvailable ? (
                      <MistralQuotaMeterView
                        {...mistralQuota}
                        currency={apiSpend?.currency}
                        locale={apiSpend?.locale}
                      />
                    ) : null}
                  </Fragment>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
      {!isSidebarVariant && (
        /* Phase L6 slice 5 — activity heatmap. Renders the last 30
         * days of usage as a 30×12 grid (12 × 2h buckets per day),
         * coloured by the dominant provider in each bucket. Pulls
         * records via the existing `getUsage` IPC; sits at the foot
         * of the card so the bars stay the primary read. The workspace
         * sidebar overlay omits this grid to keep the panel compact. */
        <UsageHeatmap />
      )}
    </div>
  )
}
