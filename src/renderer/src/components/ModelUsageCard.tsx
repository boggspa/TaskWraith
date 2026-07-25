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
import type { ModelUsageAggregate, UsageWindowAggregate } from '../lib/usageAggregateTypes'
import {
  API_SPEND_WINDOW_ORDER,
  buildApiSpendByProvider,
  buildProviderCalendarMonthSpend,
  type ApiSpendCurrencyOptions,
  type ApiSpendProviderTotals,
  type ApiSpendWindowKey,
  type CalendarMonthSpendMeter
} from '../lib/apiSpendAggregation'
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
import { getProviderName } from './Sidebar'
import {
  GrokCreditsMeterView,
  useGrokCreditsMeterState,
  type GrokCreditsMeterViewProps
} from './GrokCreditsMeter'
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
}

interface ModelUsageCardProps {
  usageSummary: ModelUsageAggregate[]
  variant?: 'card' | 'sidebar'
  /** View-B configuration. Omit to render only the quota view. */
  apiSpend?: ModelUsageApiSpendOptions
}

/** Row sort order for the quota view. `sortByProvider` maps an unlisted id to
 *  99, so omissions land at the end in undefined relative order rather than
 *  their intended slot — keep every provider that can produce a row here. */
const PROVIDER_ORDER: ProviderId[] = [
  'gemini',
  'codex',
  'claude',
  'kimi',
  'grok',
  'cursor',
  'ollama',
  'antigravity',
  'pi'
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
  'pi'
]
const SIDEBAR_USAGE_HEIGHT_STORAGE_KEY = 'taskwraith-sidebar-model-usage-height'
const SIDEBAR_USAGE_DEFAULT_HEIGHT = 520
const SIDEBAR_USAGE_MIN_HEIGHT = 220
// Six providers (gemini/codex/claude/kimi/cursor/grok) make the meter list
// much taller, so the drag cap was raised 1080 → 1400 (the rendered height is
// still bounded by `calc(100vh - 56px)` in ModelUsageCard.css so it can't
// overflow the viewport).
const SIDEBAR_USAGE_MAX_HEIGHT = 1400
const SIDEBAR_USAGE_RESIZE_STEP = 24
const COMPACT_USAGE_PROVIDERS: ProviderId[] = ['codex', 'claude', 'kimi', 'cursor', 'grok']
const COMPACT_USAGE_PROVIDER_LABELS: Partial<Record<ProviderId, string>> = {
  codex: 'Codex',
  claude: 'Claude',
  kimi: 'Kimi',
  cursor: 'Cursor',
  grok: 'Grok'
}
const COMPACT_USAGE_ROWS = [
  { key: 'fiveHour', label: '5H' },
  { key: 'weekly', label: 'WK' },
  { key: 'extraOne', label: 'X1' },
  { key: 'extraTwo', label: 'X2' }
] as const

type CompactUsageRowKey = (typeof COMPACT_USAGE_ROWS)[number]['key']

interface CompactQuotaCell {
  value: string
  fraction: number | null
  title: string
  state?: 'loading'
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
    const aIdx = PROVIDER_ORDER.indexOf(a.provider)
    const bIdx = PROVIDER_ORDER.indexOf(b.provider)
    return (aIdx === -1 ? 99 : aIdx) - (bIdx === -1 ? 99 : bIdx)
  })
}

function ProviderLabel({
  provider,
  planName
}: {
  provider: ProviderId | undefined
  planName?: string
}) {
  const providerName = provider || 'gemini'
  return (
    <span className={`sidebar-provider-label provider-${providerName}`}>
      <ProviderLogoTile provider={provider} />
      <span className="model-usage-provider-name">{getProviderName(provider)}</span>
      {planName && planName.trim() && (
        <span className="model-usage-tier-badge">{planName.trim()}</span>
      )}
    </span>
  )
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

function compactQuotaTone(fraction: number | null): string {
  if (fraction === null) return ''
  if (fraction >= 0.98) return ' is-danger'
  if (fraction >= 0.9) return ' is-warning'
  return ''
}

function normaliseQuotaWindowText(windowEntry: UsageWindowAggregate): string {
  return `${windowEntry.id} ${windowEntry.label}`.toLowerCase().replace(/[-_+]/g, ' ')
}

function compactWindowCell(
  provider: ProviderId,
  windowEntry: UsageWindowAggregate
): CompactQuotaCell {
  const fraction = fillFractionForWindow(windowEntry)
  const percentText = `${Math.round(fraction * 100)}%`
  const resetText = formatResetShort({ resetAt: windowEntry.resetAt })
  const title = [
    `${getProviderName(provider)} ${windowEntry.label}: ${percentText}`,
    windowEntry.limitLabel,
    resetText ? `resets ${resetText}` : ''
  ]
    .filter(Boolean)
    .join(' · ')
  return { value: percentText, fraction, title }
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

function isCodexSparkWindow(text: string): boolean {
  return text.includes('spark') || text.includes('gpt 5.3 codex')
}

function isClaudeExtraWindow(text: string): boolean {
  return text.includes('fable') || text.includes('sonnet') || text.includes('design')
}

function compactCellsForEntry(
  provider: ProviderId,
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

  if (provider === 'kimi') {
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
  }
  return cells
}

function compactGrokCell(grokUsage: GrokCreditsMeterViewProps | undefined): CompactQuotaCell | null {
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
    title: `Grok ${kindText}: ${snapshot.creditsUsedDisplay}${
      grokUsage.stale ? ' · stale' : ''
    }`
  }
}

export function CompactModelUsageGrid({
  quotaEntries,
  grokUsage
}: {
  quotaEntries: ModelUsageAggregate[]
  grokUsage?: GrokCreditsMeterViewProps
}) {
  const entriesByProvider = new Map(quotaEntries.map((entry) => [entry.provider, entry]))
  const cellsByProvider = new Map(
    COMPACT_USAGE_PROVIDERS.map((provider) => [
      provider,
      compactCellsForEntry(provider, entriesByProvider.get(provider))
    ])
  )
  const grokCell = compactGrokCell(grokUsage)
  if (grokCell) {
    cellsByProvider.set('grok', { ...cellsByProvider.get('grok'), weekly: grokCell })
  }

  return (
    <table className="model-usage-compact-grid" aria-label="Compact model usage">
      <thead>
        <tr>
          <th scope="col" className="model-usage-compact-corner" aria-label="Window" />
          {COMPACT_USAGE_PROVIDERS.map((provider) => (
            <th key={provider} scope="col" className={`provider-${provider}`}>
              {COMPACT_USAGE_PROVIDER_LABELS[provider]}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {COMPACT_USAGE_ROWS.map((row) => (
          <tr key={row.key}>
            <th scope="row">{row.label}</th>
            {COMPACT_USAGE_PROVIDERS.map((provider) => {
              const cell = cellsByProvider.get(provider)?.[row.key]
              return (
                <td
                  key={`${row.key}-${provider}`}
                  className={`model-usage-compact-cell provider-${provider}${
                    cell ? compactQuotaTone(cell.fraction) : ' is-empty'
                  }${cell?.state === 'loading' ? ' is-loading' : ''}`}
                  title={
                    cell?.title ||
                    `${COMPACT_USAGE_PROVIDER_LABELS[provider]} ${row.label}: unavailable`
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
  provider: ProviderId
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
  return (
    <div key={`${provider}-${windowEntry.id}`} className="model-usage-window" title={title}>
      <div className="model-usage-window-row">
        <span className="model-usage-window-label">{windowEntry.label}</span>
        {windowReset && <span className="model-usage-window-reset">resets {windowReset}</span>}
        <span className="model-usage-window-percent">{percentText}</span>
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
          entry.windows!.map((windowEntry) => (
            <UsageWindowRow
              key={`${entry.provider}-${windowEntry.id}`}
              provider={entry.provider}
              windowEntry={windowEntry}
            />
          ))
        ) : (
          <div className="model-usage-quota-unavailable" role="status">
            {entry.quotaError || 'Quota unavailable.'}
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
export function ApiSpendCapMeterRow({ meter }: { meter: CalendarMonthSpendMeter }) {
  const spent = meter.spentDisplay ? `~${meter.spentDisplay}` : '—'
  const label =
    meter.capUsd === null
      ? `${spent} this month`
      : `${spent} of ${meter.capDisplay} · resets ${meter.resetLabel}`
  return (
    <div
      className="model-usage-spend-cap-meter"
      title="Estimated month-to-date spend vs your soft budget — advisory only, never blocks a run. Set a hard limit in your Google Cloud billing console."
    >
      <div className="model-usage-spend-row">
        <span className="model-usage-spend-window">Budget</span>
        <span className="model-usage-spend-cost" data-testid="antigravity-cap-meter-label">
          {label}
        </span>
      </div>
      {meter.capUsd !== null && (
        <QuotaProgressBar
          fraction={meter.fraction}
          accent="var(--provider-antigravity-color, var(--accent))"
        />
      )}
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
  /** Present only on the Antigravity block when a spend/budget exists. */
  capMeter?: CalendarMonthSpendMeter | null
}) {
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
        {capMeter ? <ApiSpendCapMeterRow meter={capMeter} /> : null}
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
        <div key={group.provider} className={`model-usage-item provider-${group.provider} context-only`}>
          <div className="model-usage-provider-heading">
            <span className={`sidebar-provider-label provider-${group.provider}`}>
              <ProviderLogoTile provider={group.provider} />
              <span className="model-usage-provider-name">{getProviderName(group.provider)}</span>
            </span>
          </div>
          <div className="model-usage-context-rows">
            {group.models.map((m) => (
              <div key={m.modelId} className="model-usage-context-row">
                <span className="model-usage-context-model" title={m.modelId}>{humaniseModelIdCompact(group.provider, m.modelId) || m.label}</span>
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

  // Calendar month-to-date budget meter for the AntiGravity key lane. Only
  // materialised when a cap is configured — without one the rolling rows
  // already tell the whole story.
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
    spend.reduce((total, entry) => total + entry.month.runs, 0) +
    (ollamaMemory?.month.runs ?? 0)
  const spendByProvider = new Map(spend.map((entry) => [entry.provider, entry]))
  return (
    <div className="model-usage-list model-usage-spend-list">
      {API_SPEND_RENDER_ORDER.map((provider) => {
        const entry = spendByProvider.get(provider)
        return entry ? (
          <ApiSpendProviderBlock
            key={provider}
            entry={entry}
            capMeter={provider === 'antigravity' ? antigravityCapMeter : null}
          />
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

export function ModelUsageCard({ usageSummary, variant = 'card', apiSpend }: ModelUsageCardProps) {
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
  const quotaEntries = sortByProvider(usageSummary).filter(
    (entry) =>
      entry.model === 'usage limits' &&
      ((entry.windows?.length || 0) > 0 || (entry.quotaConfigured === true && Boolean(entry.quotaError)))
  )
  // The API-spend view is offered whenever the caller wired it (sidebar).
  const apiSpendEnabled = Boolean(apiSpend)
  // A plan-side meter exists when there are quota entries or the gated Grok
  // credit meter. Only then is the Plan ⇄ Spend choice meaningful.
  const planViewAvailable = quotaEntries.length > 0 || grokAvailable
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
    candidate === 'plan' ? planViewAvailable : candidate === 'spend' ? apiSpendEnabled : contextViewAvailable
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
          <CompactModelUsageGrid quotaEntries={quotaEntries} grokUsage={grokUsage} />
        )}
        <div id={quotaContentId} className="model-usage-collapsible" aria-hidden={!showQuotaEntries}>
          <div className="model-usage-collapsible-inner">
            {effectiveView === 'spend' ? (
              <ApiSpendView options={apiSpend} />
            ) : effectiveView === 'context' ? (
              <ContextLengthsView />
            ) : (
              <div className="model-usage-list">
                {quotaEntries.map((entry) => (
                  <ProviderUsageBlock key={`${entry.provider}-${entry.model}`} entry={entry} />
                ))}
                {/* 1.0.6-GU — Grok subscription credits (separate data model from
                 * the token/cost meters above; manual-refresh PTY probe). Only
                 * mounts when the gated Grok provider adapter is registered. Kept
                 * inside the list so the `.model-usage-item + .model-usage-item`
                 * divider lands between Kimi and Grok. */}
                {grokAvailable ? <GrokCreditsMeterView {...grokUsage} /> : null}
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
