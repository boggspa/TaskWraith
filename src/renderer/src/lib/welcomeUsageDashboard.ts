import type {
  ChatListItem,
  ChatRecord,
  ProviderId,
  UsageRecord,
  WorkspaceRecord
} from '../../../main/store/types'
import { canonicalModelIdForProvider, humaniseModelId } from './modelDisplayName'
import { resolveOllamaDisplayBrand } from './ollamaDisplayBrand'
import { usageRecordInputTokens, usageRecordTotalTokens } from './providerRateEstimate'

export type WelcomeUsageTab = 'overview' | 'models' | 'workspaces' | 'providers' | 'agents'

/**
 * 1.0.5-EW51 — Per-workspace cumulative cost + token breakdown
 * for the dashboard's "Workspaces" tab. One entry per workspace
 * that has any post-reset usage records. Sorted DESC by cost
 * (with tokens as tiebreaker so an OAuth-only provider with zero
 * recorded cost doesn't bury under another zero-cost workspace).
 * The renderer caps the visible list at the user-configured max
 * (`AppSettings.dashboardStatPrefs.workspacesShown`, default 8)
 * — the full list is still emitted so a future "show all" toggle
 * is a CSS change rather than a data change.
 */
export interface WorkspaceCostBreakdownEntry {
  workspaceId: string
  /**
   * Human-readable name for the row. Falls back to:
   *   - the workspace's `displayName` if registered
   *   - `'No workspace'` for records without a workspaceId
   *     (global chats, runs that landed before workspace
   *     selection — surfaced explicitly so the user sees
   *     where the spend went, not silently dropped).
   *   - the raw workspaceId when the workspace is unknown
   *     (e.g. removed from the workspaces table but records
   *     still reference it).
   */
  displayName: string
  tokens: number
  costUsd: number
  /** Percentage of the total post-reset cost. 0–100. */
  shareOfTotalCost: number
  /** Percentage of total post-reset tokens (drives the meter). 0–100. */
  shareOfTotalTokens: number
}

/**
 * 1.0.5-EW51 — One bar in the "Workspaces" tab's 30-day cost
 * chart. Built as a strict 30-day series (oldest first), with
 * zero-fill for days that had no usage so the chart's x-axis
 * stays uniform regardless of activity density.
 */
export interface DailyCostBucket {
  /** YYYY-MM-DD local-day key. */
  dayKey: string
  /** Short label for the tooltip / axis ("May 15"). */
  dayLabel: string
  tokens: number
  costUsd: number
}

/**
 * 1.0.5-EW52 — One card on the "Providers" dashboard tab. Built
 * from the same `recordsAfterReset` walk as the existing
 * provider-token totals — but rolled up with cost so the
 * Providers tab can show "tokens · cost · share" parity with
 * the Workspaces tab. Always emits all six canonical providers
 * (zero-filled for any provider the user hasn't run yet) so the
 * tab's card list reads as a stable roster rather than a sparse
 * set that grows over time.
 */
export interface ProviderCostBreakdownEntry {
  provider: ProviderId
  /** Human-readable label ("Codex" / "Claude" / "Gemini" / "Kimi" / "Grok" / "Cursor"). */
  displayName: string
  tokens: number
  costUsd: number
  /** Percentage of post-reset cost. 0–100. Zero when no cost. */
  shareOfTotalCost: number
  /**
   * 1.0.5-EW52 follow-up — Percentage of post-reset *tokens* across
   * all six providers. 0–100. Drives the under-card meter on the
   * Providers tab because token totals are populated for every
   * provider (the cost field is often 0 for Gemini CLI runs, which
   * made the cost-based meter visually misleading). Mirrors the
   * provider-mix balance ribbon at the top of the dashboard.
   */
  shareOfTotalTokens: number
}
/**
 * Time-window discriminator for the welcome dashboard. `24h` was added in
 * Welcome L3 alongside the range-toggle UI; `all` is the historical
 * fallback (lifetime aggregate).
 */
export type WelcomeUsageRange = 'all' | '30d' | '7d' | '24h'

export const HEATMAP_DAY_COUNT = 30

/**
 * 1.0.5-EW51 — Number of daily buckets in the Workspaces tab's
 * cost chart. Mirrors the heatmap's 30-day window so the two
 * surfaces on the dashboard share the same rolling cadence.
 */
export const DASHBOARD_COST_CHART_DAY_COUNT = 30
export const HEATMAP_HOUR_COUNT = 24
const GLOBAL_CHATS_WORKSPACE_KEY = '__taskwraith_global_chats__'
const LEGACY_AGBENCH_GLOBAL_CHATS_WORKSPACE_KEYS = new Set([
  '__agentbench_global_chats__',
  '_agentbench_global_chats_'
])

export interface WelcomeUsageDayCell {
  dayKey: string
  label: string
  value: number
  level: number
  isToday: boolean
}

export interface WelcomeUsageHourCell {
  /** Local-time day, formatted as YYYY-MM-DD. */
  dayKey: string
  /** Hour-of-day, 0-23 (local time). */
  hour: number
  /** Display label like "Mar 14 03:00". */
  label: string
  /** Sum of tokens for this hour bucket. */
  totalTokens: number
  /** Per-provider token totals for this hour bucket. */
  providerTotals: Record<ProviderId, number>
  /** Intensity 0..4 (0 = empty, 4 = strongest). */
  level: number
  /** True when this cell corresponds to the current local hour. */
  isCurrentHour: boolean
}

export interface WelcomeUsageModelDatum {
  id: string
  provider: ProviderId
  model: string
  label: string
  /**
   * CSS hue class for the row dot + meter fill. Normally `provider-<id>`,
   * but Ollama-backed display brands (Alibaba/Qwen, Google/Gemma, …) resolve
   * to their spoofed upstream brand class (e.g. `provider-alibaba`) so the
   * Model Comparisons tab wears the same per-brand hue as the transcript,
   * run cards, and model picker.
   */
  colorClass: string
  runs: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
  percent: number
  dailyTotals: Map<string, number>
}

export interface WelcomeUsageDashboardData {
  /**
   * True when the SELECTED RANGE has activity. Drives empty-state
   * copy inside the dashboard ("No activity in the last 24 hours").
   */
  hasActivity: boolean
  /**
   * True when the user has ANY lifetime activity at all. Drives the
   * outer "should the welcome dashboard render?" decision in the
   * renderer — the toggle stays visible even when the current
   * range happens to be empty, so the user can switch ranges from
   * the empty state.
   */
  lifetimeHasActivity: boolean
  /**
   * Tokens consumed in the last 24 hours, regardless of the range the
   * rest of the dashboard is computed against. Surfaced as the "24H
   * Tkns" hero chip on the Overview tab and matches the sidebar
   * UsageHeatmap's `last24h` total so the two surfaces agree.
   */
  tokens24h: number
  sessions: number
  messages: number
  totalTokens: number
  activeDays: number
  currentStreak: number
  longestStreak: number
  /**
   * 1.0.5-EW44 — Longest single thread/run duration ever recorded
   * by the user, in milliseconds. Each `UsageRecord.durationMs` is
   * "auditioned" against the running max via a simple
   * `Math.max(...lifetimeDurations)` over the unfiltered lifetime
   * record set — no per-run storage of every duration is needed
   * beyond what `UsageRecord` already keeps. Always-lifetime (never
   * range-scoped) so the chip reads as a personal record across
   * the user's whole history, matching the
   * Current/Longest-streak semantics.
   *
   * Zero when the user has no usage history yet (or no record
   * carried a positive durationMs).
   */
  longestThreadMs: number
  /**
   * 1.0.5-EW44 — Cumulative wall-clock time across all threads
   * ever, in milliseconds. Sum of `UsageRecord.durationMs` over the
   * unfiltered lifetime record set. Always-lifetime so the chip
   * keeps growing across sessions; like `longestThreadMs`, the
   * dashboard surfaces this alongside the streak chips so the
   * "all-time" subset is visually grouped.
   */
  totalWallTimeMs: number
  /**
   * 1.0.5-EW49 — Total cost in USD across all records the
   * current stat reset window covers. Derived from
   * `UsageRecord.explicitCostUsd` (or per-provider rate when
   * explicit is absent). Always lifetime-from-reset; ignores the
   * 30-day range. Zero when nothing has an attributable cost.
   * Formatted via `formatCost` in the chip renderer.
   */
  totalCostUsd: number
  /**
   * 1.0.5-EW49 — Average session duration in milliseconds.
   * Computed as `totalWallTimeMs / sessions` over the same
   * record set that drives those two stats. Zero when no
   * sessions yet (avoid divide-by-zero). Formatted via
   * `formatDashboardDuration`.
   */
  avgSessionMs: number
  /**
   * 1.0.5-EW49 — Average tokens per session. `totalTokens /
   * sessions`. Zero when no sessions. Formatted as a compact
   * usage number ("12k", "3.4M").
   */
  tokensPerSession: number
  /**
   * 1.0.5-EW51 — Per-workspace cumulative cost + token breakdown
   * for the "Workspaces" tab. Sorted by cost desc; the renderer
   * slices the first N (default 8). Empty array when no records
   * carry attribution.
   */
  workspaceCostBreakdown: WorkspaceCostBreakdownEntry[]
  /**
   * 1.0.5-EW51 — 30-day daily cost/token series for the
   * Workspaces tab's bar chart. Always exactly 30 entries
   * (oldest first, today last), zero-filled for inactive days
   * so the chart's x-axis stays uniform.
   */
  dailyCostBreakdown: DailyCostBucket[]
  /**
   * 1.0.5-EW52 — Per-provider cumulative cost + token breakdown
   * for the "Providers" tab. Always 4 entries (codex / claude /
   * gemini / kimi), sorted DESC by cost so the dominant
   * provider lands at the top. Zero-filled for providers with
   * no post-reset activity.
   */
  providerCostBreakdown: ProviderCostBreakdownEntry[]
  /**
   * 1.0.5-EW52 — Cumulative wall-clock time across all runs
   * that started in the last 24 hours, in milliseconds. Drives
   * the giant timecode below the Providers tab's card list.
   * Distinct from `totalWallTimeMs` (which is lifetime-from-
   * reset) — this is a tight rolling 24h slice.
   */
  wallTime24hMs: number
  peakHour: string
  favoriteModel: string
  /**
   * Display name of the workspace with the most tokens consumed in the
   * selected range. Surfaced as a hero chip alongside Favorite model.
   * Falls back to `'n/a'` when no records carried a workspaceId in the
   * window (typical for users who only run global / no-workspace chats).
   * Global chats and records without a workspaceId are excluded from
   * the tally — a "project" implies a workspace.
   */
  favoriteProject: string
  providerCount: number
  /**
   * Per-provider token totals across the selected range. Drives the
   * provider color rails on stat chips and the multi-provider mix
   * ribbon under the tabs — TaskWraith's structural differentiator from
   * Claude's single-provider dashboard. Always carries all six
   * provider keys (zero-filled when a provider has no activity).
   */
  providerTokenTotals: Record<ProviderId, number>
  comparisonText: string
  heatmap: WelcomeUsageDayCell[]
  /**
   * Hourly grid covering the most recent {@link HEATMAP_DAY_COUNT} days × 24
   * hours, ordered chronologically (oldest first, by day then hour). Used by
   * the dense activity grid in the welcome dashboard.
   */
  hourlyHeatmap: WelcomeUsageHourCell[]
  chartDays: Array<{ dayKey: string; label: string; total: number }>
  modelBreakdown: WelcomeUsageModelDatum[]
  maxChartTotal: number
}

const startOfLocalDay = (timestamp: number): number => {
  const date = new Date(timestamp)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

const startOfLocalHour = (timestamp: number): number => {
  const date = new Date(timestamp)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours()).getTime()
}

const dayKeyFromTimestamp = (timestamp: number): string => {
  const date = new Date(startOfLocalDay(timestamp))
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

const emptyProviderTotals = (): Record<ProviderId, number> => ({
  gemini: 0,
  codex: 0,
  claude: 0,
  kimi: 0,
  grok: 0,
  cursor: 0,
  ollama: 0,
  antigravity: 0
})

const formatHourLabel = (dayKey: string, hour: number): string => {
  const [year, month, day] = dayKey.split('-').map(Number)
  const date = new Date(year, (month || 1) - 1, day || 1, hour)
  const dayLabel = date.toLocaleDateString([], { month: 'short', day: 'numeric' })
  const hourLabel = date.toLocaleTimeString([], { hour: 'numeric' })
  return `${dayLabel} ${hourLabel}`
}

/**
 * 1.0.5-EW44 — Compact human-readable duration formatter for the
 * welcome dashboard stats. An earlier per-turn duration formatter
 * capped at minutes ("12m 34s"); for
 * dashboard metrics that can span hours/days (Longest thread,
 * Cumulative wall time across a user's whole history) we need a
 * fuller scale that drops down to days when the value is large.
 *
 * Picked to read at a glance — two units max, no decimals, never
 * showing zero-valued tail units ("3h" not "3h 0m"; "5d" not
 * "5d 0h").
 *
 *   0           → '0s'
 *   < 1s        → '<1s'      (avoid "0.4s" being mis-read as 0s)
 *   < 1 min     → '32s'
 *   < 1 hour    → '12m 34s' or '12m' when seconds round to 0
 *   < 24 hours  → '3h 12m' or '3h'
 *   ≥ 24 hours  → '5d 3h' or '5d'
 *
 * Exported so the App.tsx stat-chip renderer (and any future
 * cumulative-time surface) can format consistently.
 */
export function formatDashboardDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0s'
  if (ms < 1000) return '<1s'
  const totalSeconds = Math.round(ms / 1000)
  if (totalSeconds < 60) return `${totalSeconds}s`
  const totalMinutes = Math.floor(totalSeconds / 60)
  if (totalMinutes < 60) {
    const seconds = totalSeconds % 60
    return seconds === 0 ? `${totalMinutes}m` : `${totalMinutes}m ${seconds}s`
  }
  const totalHours = Math.floor(totalMinutes / 60)
  if (totalHours < 24) {
    const minutes = totalMinutes % 60
    return minutes === 0 ? `${totalHours}h` : `${totalHours}h ${minutes}m`
  }
  const days = Math.floor(totalHours / 24)
  const hours = totalHours % 24
  return hours === 0 ? `${days}d` : `${days}d ${hours}h`
}

const formatUsageDateLabel = (dayKey: string): string => {
  const [year, month, day] = dayKey.split('-').map(Number)
  const date = new Date(year, (month || 1) - 1, day || 1)
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

export const formatCompactUsageNumber = (value: number): string => {
  const safe = Math.max(0, Number.isFinite(value) ? value : 0)
  if (safe >= 1_000_000) return `${(safe / 1_000_000).toFixed(safe >= 10_000_000 ? 0 : 1)}M`
  if (safe >= 1_000) return `${(safe / 1_000).toFixed(safe >= 100_000 ? 0 : 1)}k`
  return String(Math.round(safe))
}

const formatPeakHour = (hour: number): string => {
  if (!Number.isFinite(hour) || hour < 0) return 'n/a'
  const normalized = ((Math.round(hour) % 24) + 24) % 24
  const suffix = normalized >= 12 ? 'PM' : 'AM'
  const display = normalized % 12 || 12
  return `${display} ${suffix}`
}

/**
 * Welcome L8 — model-breakdown filter. Drops noisy entries from the
 * Models-tab meter list so usage reads deterministically:
 *
 *   - `default` / `unknown` model names are removed across all providers
 *     (model usage needs to be explicit, not a wildcard bucket).
 *   - Kimi: only the canonical `kimi-k2.7-code` (default), its thinking
 *     variants, `kimi-k3`, and legacy K2.6 rows survive; deprecated names
 *     (`kimi-latest`, `kimi-k2`, `kimi-k2.5`, `kimi-k2-thinking` aliases,
 *     etc.) collapse to nothing. Kimi Code now treats K2.7 Coding as the
 *     implicit default model.
 *
 * Returns `false` when the (provider, model) pair shouldn't surface in
 * the dashboard's per-model breakdown.
 */
const shouldSurfaceModelInBreakdown = (provider: ProviderId, model: string): boolean => {
  const trimmed = (model || '').trim().toLowerCase()
  if (!trimmed || trimmed === 'default' || trimmed === 'unknown') return false
  if (provider === 'kimi') {
    const KIMI_KEEP = new Set([
      'kimi-k3',
      'kimi-k2.7-code',
      'kimi-k2.7-code-thinking',
      'kimi-k2.7-thinking',
      'kimi-k2.6',
      'kimi-k2.6-thinking',
      'kimi-k2-thinking'
    ])
    return KIMI_KEEP.has(trimmed)
  }
  return true
}

/**
 * Friendly label for the per-model meter row. Falls back to the raw
 * model id when no provider-specific rename applies, so unfamiliar
 * models stay readable.
 *
 * 1.0.5-EW50 — Delegates to the shared `humaniseModelId` resolver
 * in `lib/modelDisplayName.ts` so the Favorite Model chip, the
 * Model Comparisons tab, and the Settings → Model Usage list all
 * use the same mapping table. Pre-EW50 this function only mapped
 * Kimi ids; every other provider fell through to the raw CLI id,
 * which read as developer-y noise in the user-facing chip.
 */
const labelForBreakdownModel = (provider: ProviderId, model: string): string =>
  humaniseModelId(provider, model)

/**
 * Resolve the display label + CSS hue class for a breakdown row. For most
 * providers this is just the humanised model name + `provider-<id>`. For
 * Ollama-backed display brands the row adopts the spoofed upstream brand
 * label + class (e.g. Qwen → `provider-alibaba`) so the Model Comparisons
 * tab matches the transcript / run-card / picker hue treatment.
 */
const presentationForBreakdownModel = (
  provider: ProviderId,
  model: string
): { label: string; colorClass: string } => {
  const baseLabel = labelForBreakdownModel(provider, model)
  if (provider === 'ollama') {
    const brand = resolveOllamaDisplayBrand(model, baseLabel)
    if (brand) {
      return {
        label: brand.modelLabel || baseLabel,
        colorClass: `provider-${brand.providerClass}`
      }
    }
  }
  return { label: baseLabel, colorClass: `provider-${provider}` }
}

const inferProviderFromModelName = (model: string): ProviderId => {
  const normalized = model.toLowerCase()
  if (
    normalized.includes('claude') ||
    normalized.includes('opus') ||
    normalized.includes('fable') ||
    normalized.includes('sonnet') ||
    normalized.includes('haiku')
  )
    return 'claude'
  if (normalized.includes('kimi') || normalized.includes('moonshot') || normalized.includes('k2'))
    return 'kimi'
  if (
    normalized.includes('ollama') ||
    normalized.includes('qwen') ||
    normalized.includes('llama') ||
    normalized.includes('gemma') ||
    normalized.includes('ornith')
  ) {
    return 'ollama'
  }
  if (normalized.includes('gpt-oss') || normalized.includes('gptoss')) return 'ollama'
  if (
    normalized.includes('codex') ||
    normalized.includes('gpt') ||
    normalized.includes('o3') ||
    normalized.includes('o4') ||
    normalized.includes('o5')
  )
    return 'codex'
  if (normalized.includes('grok')) return 'grok'
  if (normalized.includes('composer') || normalized.includes('cursor')) return 'cursor'
  return 'gemini'
}

const getWelcomeUsageRangeCutoff = (range: WelcomeUsageRange, now: number): number => {
  if (range === '24h') return now - 24 * 60 * 60 * 1000
  if (range === '7d') return now - 7 * 24 * 60 * 60 * 1000
  if (range === '30d') return now - 30 * 24 * 60 * 60 * 1000
  return 0
}

const getWelcomeUsageHeatmapDayCount = (range: WelcomeUsageRange): number => {
  if (range === '24h') return 2
  if (range === '7d') return 7
  if (range === '30d') return 30
  return 84
}

/**
 * Number of bars in the Models-tab chart. Welcome L3 widens this from the
 * historical fixed 6-day default so the bars normalise against the
 * caller-selected range — empty windows now mean genuine inactivity in the
 * chosen period instead of "your spike was outside the visible 6 days".
 * 24h falls back to 2 columns (yesterday + today) because a single bar
 * looks broken; for finer-grain 24h work, Welcome L6 will add hour-of-day
 * bucketing as a separate render path.
 */
const getWelcomeUsageChartDayCount = (range: WelcomeUsageRange): number => {
  if (range === '24h') return 2
  if (range === '7d') return 7
  if (range === '30d') return 30
  return 30
}

export const buildWelcomeUsageDashboardData = (
  records: UsageRecord[],
  chats: ChatRecord[],
  range: WelcomeUsageRange,
  now = Date.now(),
  /**
   * Optional workspace list for resolving favoriteProject. Caller passes
   * the renderer's `workspaces` slice; we only ever look up `id` and
   * `displayName`. Pass `[]` (or omit) to skip the workspace dimension —
   * `favoriteProject` then degrades to `'n/a'`.
   */
  workspaces: Pick<WorkspaceRecord, 'id' | 'displayName'>[] = [],
  /**
   * 1.0.5-EW49 — Global "reset all dashboard stats" timestamp
   * (epoch ms). When set + non-zero, every record older than
   * this is dropped from the underlying source set before any
   * stat is computed — so the dashboard reads as if the user's
   * usage history started at `statResetAt`. Pass `0` (or omit)
   * for the default "include all history" behaviour. Per-stat
   * reset (one cutoff per stat) is deferred to EW49b — the
   * single-timestamp shape is the simpler MVP and serves the
   * main user intent ("zero my dashboard back to today").
   */
  statResetAt: number = 0
): WelcomeUsageDashboardData => {
  const cutoff = getWelcomeUsageRangeCutoff(range, now)
  // 1.0.5-EW49 — Apply the global reset cutoff to the source
  // record set BEFORE any range scoping or per-stat aggregation.
  // Every downstream computation (sessions, tokens, streaks,
  // longest thread, etc.) inherits the filter naturally — no
  // per-stat threading needed. Range-scoped stats then apply
  // the additional range cutoff on top.
  const resetCutoff = Number.isFinite(statResetAt) && statResetAt > 0 ? statResetAt : 0
  const recordsAfterReset =
    resetCutoff > 0 ? records.filter((record) => record.timestamp >= resetCutoff) : records
  const chatsAfterReset =
    resetCutoff > 0
      ? chats.map((chat) => ({
          ...chat,
          messages: (chat.messages || []).filter((message) => {
            const ts = new Date(message.timestamp || '').getTime()
            return Number.isFinite(ts) && ts >= resetCutoff
          })
        }))
      : chats
  const runRecords = recordsAfterReset
    .filter((record) => record.usageKind !== 'reset_hint')
    .filter((record) => record.timestamp >= cutoff)
  const messageEvents = chatsAfterReset.flatMap((chat) =>
    (chat.messages || [])
      .map((message) => {
        const timestamp = new Date(message.timestamp || '').getTime()
        return {
          chatId: chat.appChatId,
          timestamp
        }
      })
      .filter((event) => Number.isFinite(event.timestamp) && event.timestamp >= cutoff)
  )

  // Welcome L5 — streaks stay all-time. Current/longest-streak are
  // lifetime metrics; computing them off the range-filtered day set
  // would collapse the user's actual streak (e.g. 24h window → max
  // longest-streak is 1 day, no matter the actual usage history).
  // Build a separate "lifetime" active-day set from the unfiltered
  // records + chats so the streak computation always sees the full
  // calendar of activity even when the rest of the dashboard is
  // showing 24h / 7d / 30d.
  const lifetimeActiveDayKeys = new Set<string>()
  // 1.0.5-EW44 — Longest single-thread duration + cumulative
  // wall-clock time. Both are lifetime metrics derived from the
  // existing `UsageRecord.durationMs` field — no new storage
  // needed. The "longest thread" pass is the gating-principle the
  // user asked for: every record auditions, the max wins, no
  // per-run history beyond what's already kept.
  let longestThreadMs = 0
  let totalWallTimeMs = 0
  // 1.0.5-EW49 — Total cost in USD across all post-reset
  // records. `explicitCostUsd` is the per-record cost field
  // emitted by providers that report it (currently Claude +
  // Codex + Kimi via the chat-completions endpoint; Gemini
  // doesn't always populate it). We sum what's available and
  // skip records that lack the field — surfacing a real-vs-
  // partial signal honestly via the magnitude.
  let totalCostUsd = 0
  // 1.0.5-EW51 — Per-workspace + per-day aggregates for the new
  // "Workspaces" dashboard tab. Built in the same lifetime loop
  // as the EW49 totals so we get them for free. Workspaces are
  // keyed by `workspaceId` (special `__no_workspace` sentinel
  // for global/no-attribution records — surfaced as "No
  // workspace" rather than silently dropped). Daily buckets are
  // keyed by local-day YYYY-MM-DD and only populated for
  // records within the last 30 days (the bar chart's window).
  const workspaceAggregate = new Map<string, { tokens: number; costUsd: number }>()
  const dailyCostAggregate = new Map<string, { tokens: number; costUsd: number }>()
  const dailyCostCutoff = now - DASHBOARD_COST_CHART_DAY_COUNT * 24 * 60 * 60 * 1000
  const NO_WORKSPACE_KEY = '__no_workspace'
  // 1.0.5-EW52 — Per-provider aggregate (tokens + cost) for the
  // new "Providers" dashboard tab. Initialised with all six
  // canonical providers so the card list is a stable roster
  // regardless of which providers the user has actually run.
  // Cost source is the same `explicitCostUsd` field the
  // Workspaces tab uses (Codex / Claude / Kimi populate it via
  // chat-completions; Gemini often leaves it 0 — that's a real
  // signal worth surfacing, not noise).
  const providerCostAggregate: Record<ProviderId, { tokens: number; costUsd: number }> = {
    codex: { tokens: 0, costUsd: 0 },
    claude: { tokens: 0, costUsd: 0 },
    gemini: { tokens: 0, costUsd: 0 },
    kimi: { tokens: 0, costUsd: 0 },
    grok: { tokens: 0, costUsd: 0 },
    cursor: { tokens: 0, costUsd: 0 },
    ollama: { tokens: 0, costUsd: 0 },
    antigravity: { tokens: 0, costUsd: 0 }
  }
  // 1.0.5-EW52 — Cumulative wall time across runs whose
  // timestamp is within the last 24 hours. Distinct from
  // `totalWallTimeMs` (lifetime-from-reset). Rolling 24h slice
  // so the giant timecode on the Providers tab tracks "how much
  // time did agents spend running for me today".
  let wallTime24hMs = 0
  const wallTime24hCutoff = now - 24 * 60 * 60 * 1000
  for (const record of recordsAfterReset) {
    if (record.usageKind === 'reset_hint') continue
    lifetimeActiveDayKeys.add(dayKeyFromTimestamp(record.timestamp))
    const duration = Number(record.durationMs)
    if (Number.isFinite(duration) && duration > 0) {
      if (duration > longestThreadMs) longestThreadMs = duration
      totalWallTimeMs += duration
    }
    const cost = Number((record as unknown as Record<string, unknown>).explicitCostUsd ?? 0)
    const hasCost = Number.isFinite(cost) && cost > 0
    if (hasCost) {
      totalCostUsd += cost
    }
    // EW51 workspace bucket — contribute even when cost is 0
    // (tokens-only providers like Gemini still get a row on the
    // Workspaces tab; cost simply renders as "—" or the bias-
    // adjusted zero from `formatCost`).
    const wsKey = record.workspaceId || NO_WORKSPACE_KEY
    const wsBucket = workspaceAggregate.get(wsKey) || { tokens: 0, costUsd: 0 }
    const recordTotalTokens = usageRecordTotalTokens(record)
    wsBucket.tokens += recordTotalTokens
    if (hasCost) wsBucket.costUsd += cost
    workspaceAggregate.set(wsKey, wsBucket)
    // EW51 daily bucket — only the last 30 days contribute to
    // the chart series. Older records hit the workspace tally
    // (lifetime) but not the chart bars.
    if (record.timestamp >= dailyCostCutoff) {
      const dayKey = dayKeyFromTimestamp(record.timestamp)
      const dayBucket = dailyCostAggregate.get(dayKey) || { tokens: 0, costUsd: 0 }
      dayBucket.tokens += recordTotalTokens
      if (hasCost) dayBucket.costUsd += cost
      dailyCostAggregate.set(dayKey, dayBucket)
    }
    // EW52 per-provider bucket — narrow `record.provider` to
    // our canonical set so a malformed record doesn't grow the
    // aggregate map with junk keys. Unknown / missing provider
    // silently drops (matches the broader dashboard's
    // posture).
    const recordProvider = record.provider as ProviderId | undefined
    if (
      recordProvider === 'codex' ||
      recordProvider === 'claude' ||
      recordProvider === 'gemini' ||
      recordProvider === 'kimi' ||
      recordProvider === 'grok' ||
      recordProvider === 'cursor' ||
      recordProvider === 'ollama'
    ) {
      providerCostAggregate[recordProvider].tokens += recordTotalTokens
      if (hasCost) providerCostAggregate[recordProvider].costUsd += cost
    }
  }
  // EW52 24h wall-time slice — separate walk against the RAW
  // record set (not `recordsAfterReset`). The giant timecode
  // is meant as a "right now" pulse, so it has to keep
  // counting even if the user reset the dashboard recently.
  // Skip `reset_hint` markers (they have no duration and
  // shouldn't contribute anyway).
  for (const record of records) {
    if (record.usageKind === 'reset_hint') continue
    const duration = Number(record.durationMs)
    if (record.timestamp >= wallTime24hCutoff && Number.isFinite(duration) && duration > 0) {
      wallTime24hMs += duration
    }
  }
  // Re-walk the original lifetime-active-day loop body that EW44
  // absorbed into the for-loop above. Keep the chat-message
  // iteration intact (no durationMs there to merge in).
  for (const chat of chatsAfterReset) {
    for (const message of chat.messages || []) {
      const ts = new Date(message.timestamp || '').getTime()
      if (Number.isFinite(ts)) lifetimeActiveDayKeys.add(dayKeyFromTimestamp(ts))
    }
  }

  const activeDayKeys = new Set<string>()
  const sessionIds = new Set<string>()
  const providerIds = new Set<ProviderId>()
  // Multi-provider color rail aggregate. Each provider gets a running
  // token total scoped to the displayed range; the chip rail colour
  // is mixed weighted by these totals at render time. Always carries
  // all six provider keys so consumers don't need to null-check.
  const providerTokenTotals = emptyProviderTotals()
  const hourlyTotals = new Array(24).fill(0) as number[]
  const dailyTotals = new Map<string, number>()
  const modelMap = new Map<string, WelcomeUsageModelDatum>()
  // L9 — running 24h subtotal. Computed against `now` directly, not
  // the dashboard's selected cutoff, so the hero chip stays meaningful
  // even when the user views a wider window.
  const cutoff24h = now - 24 * 60 * 60 * 1000
  let tokens24h = 0
  // L9 — per-workspace token totals for the favoriteProject hero chip.
  // Records that lack a workspaceId (global chats, ad-hoc runs) are
  // skipped so the "favourite project" signal stays workspace-scoped.
  // Token-weighted, not record-count-weighted, to align with the rest
  // of the dashboard's tokens-centric framing.
  const workspaceTokens = new Map<string, number>()
  /**
   * Hourly buckets keyed by the local-time hour start (ms epoch). We bucket
   * usage records here so the dense 30×24 welcome heatmap can render
   * provider-coloured intensity without re-scanning records in the component.
   */
  const hourBuckets = new Map<
    number,
    { totalTokens: number; providerTotals: Record<ProviderId, number> }
  >()

  for (const event of messageEvents) {
    activeDayKeys.add(dayKeyFromTimestamp(event.timestamp))
    sessionIds.add(event.chatId)
  }

  for (const record of runRecords) {
    const provider = record.provider || inferProviderFromModelName(record.model || '')
    const model = canonicalModelIdForProvider(provider, record.model || 'unknown') || 'unknown'
    const totalTokens = usageRecordTotalTokens(record)
    const inputTokens = usageRecordInputTokens(record)
    const outputTokens = Math.max(0, Number(record.outputTokens || 0))
    const dayKey = dayKeyFromTimestamp(record.timestamp)
    const hour = new Date(record.timestamp).getHours()

    // Aggregate stats (sessions / activeDays / hourly / hourly heatmap)
    // always count the record. Only the per-model breakdown is gated by
    // shouldSurfaceModelInBreakdown — so a run from a deprecated Kimi
    // alias still bumps the sidebar heatmap + headline stats, but
    // doesn't add a separate noisy meter row to the Models tab.
    activeDayKeys.add(dayKey)
    sessionIds.add(record.chatId)
    providerIds.add(provider)
    providerTokenTotals[provider] += totalTokens
    hourlyTotals[hour] += totalTokens || 1
    dailyTotals.set(dayKey, (dailyTotals.get(dayKey) || 0) + totalTokens)
    if (record.timestamp >= cutoff24h) tokens24h += totalTokens
    if (record.workspaceId) {
      workspaceTokens.set(
        record.workspaceId,
        (workspaceTokens.get(record.workspaceId) || 0) + totalTokens
      )
    }

    const hourStart = startOfLocalHour(record.timestamp)
    const bucket = hourBuckets.get(hourStart) || {
      totalTokens: 0,
      providerTotals: emptyProviderTotals()
    }
    // Use raw token count when present; otherwise count the run as a single
    // unit so the cell still shows activity even for usage records that lack
    // explicit token totals (mirrors the existing hourlyTotals heuristic).
    const cellWeight = totalTokens || 1
    bucket.totalTokens += cellWeight
    bucket.providerTotals[provider] += cellWeight
    hourBuckets.set(hourStart, bucket)

    // Drop the wildcard `default` / `cli-default` bucket by its RAW id: the
    // canonical id above has already rewritten it to a real provider default
    // (e.g. claude `default` -> `claude-sonnet-5`), so the canonical filter
    // alone would no longer recognise it as the noisy default bucket. The run
    // still counts toward the headline/aggregate stats — only this per-model
    // breakdown row is suppressed.
    const rawModelKey = (record.model || '').trim().toLowerCase()
    if (rawModelKey === 'default' || rawModelKey === 'cli-default') continue
    if (!shouldSurfaceModelInBreakdown(provider, model)) continue
    const modelId = `${provider}:${model}`
    const { label, colorClass } = presentationForBreakdownModel(provider, model)
    const existing = modelMap.get(modelId) || {
      id: modelId,
      provider,
      model,
      label,
      colorClass,
      runs: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      percent: 0,
      dailyTotals: new Map<string, number>()
    }
    existing.runs += 1
    existing.inputTokens += inputTokens
    existing.outputTokens += outputTokens
    existing.totalTokens += totalTokens
    existing.dailyTotals.set(dayKey, (existing.dailyTotals.get(dayKey) || 0) + totalTokens)
    modelMap.set(modelId, existing)
  }

  const totalTokens = runRecords.reduce(
    (sum, record) => sum + usageRecordTotalTokens(record),
    0
  )
  // Welcome L4/L8 — model breakdown is range-scoped AND filtered to
  // canonical models (see shouldSurfaceModelInBreakdown). Percentage
  // denominator is the sum of KEPT model tokens, not all run records:
  // otherwise dropping `default` / deprecated-Kimi entries would just
  // lower every visible model's percent without rebalancing. The
  // headline `totalTokens` stat above still sums every run record so
  // users see all tracked activity, not just the kept-model subset.
  const modelBreakdownTokenTotal = Array.from(modelMap.values()).reduce(
    (sum, model) => sum + model.totalTokens,
    0
  )
  const modelBreakdown = Array.from(modelMap.values())
    .sort((a, b) => b.totalTokens - a.totalTokens || b.runs - a.runs)
    .map((model) => ({
      ...model,
      percent:
        modelBreakdownTokenTotal > 0 ? (model.totalTokens / modelBreakdownTokenTotal) * 100 : 0
    }))

  const todayStart = startOfLocalDay(now)
  // Welcome L5 — streaks read from the LIFETIME day set so 24h / 7d /
  // 30d views still show the user's real all-time current + longest
  // streak. (`activeDayKeys` above is range-filtered and drives the
  // sessions/messages/active-days/peak-hour stats below.)
  const lifetimeDayStarts = Array.from(lifetimeActiveDayKeys)
    .map((key) => new Date(`${key}T00:00:00`).getTime())
    .filter(Number.isFinite)
    .sort((a, b) => a - b)
  const lifetimeStartSet = new Set(lifetimeDayStarts)
  const countStreakEndingAt = (start: number): number => {
    let count = 0
    for (let cursor = start; lifetimeStartSet.has(cursor); cursor -= 24 * 60 * 60 * 1000) {
      count += 1
    }
    return count
  }
  const currentStreak =
    countStreakEndingAt(todayStart) || countStreakEndingAt(todayStart - 24 * 60 * 60 * 1000)
  let longestStreak = 0
  let runningStreak = 0
  let previousDay = -1
  for (const day of lifetimeDayStarts) {
    runningStreak =
      previousDay > 0 && day - previousDay === 24 * 60 * 60 * 1000 ? runningStreak + 1 : 1
    longestStreak = Math.max(longestStreak, runningStreak)
    previousDay = day
  }

  const peakHour = hourlyTotals.reduce(
    (best, value, hour) => (value > hourlyTotals[best] ? hour : best),
    0
  )
  const heatmapDayCount = getWelcomeUsageHeatmapDayCount(range)
  const heatmapStart = todayStart - (heatmapDayCount - 1) * 24 * 60 * 60 * 1000
  const maxDayValue = Math.max(1, ...Array.from(dailyTotals.values()))
  const heatmap = Array.from({ length: heatmapDayCount }, (_, index) => {
    const timestamp = heatmapStart + index * 24 * 60 * 60 * 1000
    const dayKey = dayKeyFromTimestamp(timestamp)
    const value = dailyTotals.get(dayKey) || 0
    return {
      dayKey,
      label: formatUsageDateLabel(dayKey),
      value,
      level: value <= 0 ? 0 : Math.max(1, Math.min(4, Math.ceil((value / maxDayValue) * 4))),
      isToday: timestamp === todayStart
    }
  })

  // Build the dense 30-day × 24-hour grid. The grid is anchored on the current
  // local hour so the most recent activity occupies the last cell. The grid is
  // returned in chronological order (oldest first), giving the renderer a
  // flat list it can slot into a fixed-size CSS grid.
  const nowHourStart = startOfLocalHour(now)
  const oneHour = 60 * 60 * 1000
  const hourlyHeatmapTotalCells = HEATMAP_DAY_COUNT * HEATMAP_HOUR_COUNT
  const hourlyHeatmapStart = nowHourStart - (hourlyHeatmapTotalCells - 1) * oneHour
  let maxHourlyValue = 0
  for (let index = 0; index < hourlyHeatmapTotalCells; index += 1) {
    const cellStart = hourlyHeatmapStart + index * oneHour
    const bucket = hourBuckets.get(cellStart)
    if (bucket && bucket.totalTokens > maxHourlyValue) maxHourlyValue = bucket.totalTokens
  }
  const hourlyHeatmap: WelcomeUsageHourCell[] = Array.from(
    { length: hourlyHeatmapTotalCells },
    (_, index) => {
      const cellStart = hourlyHeatmapStart + index * oneHour
      const cellDate = new Date(cellStart)
      const dayKey = dayKeyFromTimestamp(cellStart)
      const hour = cellDate.getHours()
      const bucket = hourBuckets.get(cellStart)
      const total = bucket?.totalTokens || 0
      const providerTotals = bucket ? { ...bucket.providerTotals } : emptyProviderTotals()
      const level =
        total <= 0
          ? 0
          : maxHourlyValue > 0
            ? Math.max(1, Math.min(4, Math.ceil((total / maxHourlyValue) * 4)))
            : 1
      return {
        dayKey,
        hour,
        label: formatHourLabel(dayKey, hour),
        totalTokens: total,
        providerTotals,
        level,
        isCurrentHour: cellStart === nowHourStart
      }
    }
  )

  // Welcome L3: chart day count now follows the selected range so bars
  // normalise against the active window (not a hardcoded 6 days). For
  // ranges with explicit cutoffs (24h / 7d / 30d) we anchor the chart on
  // today and walk backwards, filling empty days as zero. `all` keeps the
  // historical "active-days-only" behaviour but widens the cap to 30 so
  // a busy week doesn't get cropped to 6 columns.
  const chartDayCount = getWelcomeUsageChartDayCount(range)
  const consecutiveChartDays = Array.from({ length: chartDayCount }, (_, index) =>
    dayKeyFromTimestamp(todayStart - (chartDayCount - 1 - index) * 24 * 60 * 60 * 1000)
  )
  const activeChartDays = Array.from(dailyTotals.keys()).sort().slice(-chartDayCount)
  const chartDayKeys =
    range === 'all'
      ? activeChartDays.length >= Math.min(2, chartDayCount)
        ? activeChartDays
        : consecutiveChartDays
      : consecutiveChartDays
  const chartDays = chartDayKeys.map((dayKey) => ({
    dayKey,
    label: formatUsageDateLabel(dayKey),
    total: dailyTotals.get(dayKey) || 0
  }))
  const maxChartTotal = Math.max(1, ...chartDays.map((day) => day.total))
  const favoriteModel = modelBreakdown[0]?.label || 'n/a'
  // Pick the workspace with the highest token total in-window, then
  // look up its display name. Ties resolve to the first one we saw
  // (Map iteration order is insertion order in JS), which matches
  // "most recently seen first" for our typical flow. Zero-token
  // workspaces are skipped: if every record had `totalTokens === 0`
  // the favoriteProject falls through to 'n/a' rather than picking
  // arbitrarily.
  let favoriteWorkspaceId: string | null = null
  let favoriteWorkspaceTokens = 0
  for (const [workspaceId, tokens] of workspaceTokens) {
    if (tokens > favoriteWorkspaceTokens) {
      favoriteWorkspaceTokens = tokens
      favoriteWorkspaceId = workspaceId
    }
  }
  const favoriteProject = favoriteWorkspaceId
    ? workspaces.find((w) => w.id === favoriteWorkspaceId)?.displayName || 'n/a'
    : 'n/a'
  const hasActivity = runRecords.length > 0 || messageEvents.length > 0
  // Welcome L6 — lifetime "has any activity ever" flag. Used by the
  // renderer to decide whether to mount the dashboard at all. Without
  // this, a 24h range that happens to be empty would unmount the
  // dashboard wholesale and the user would lose access to the toggle
  // even though their lifetime history is rich.
  // 1.0.5-EW49 — `lifetimeHasActivity` honours the global reset.
  // If the user resets all stats, the dashboard's "lifetime" set
  // becomes "everything from the reset point". An older record
  // pre-dating the reset shouldn't make the dashboard claim
  // lifetime activity exists when the visible stats are all zero.
  const lifetimeHasActivity =
    recordsAfterReset.some((record) => record.usageKind !== 'reset_hint') ||
    chatsAfterReset.some((chat) => {
      const summary = chat as ChatListItem
      if (summary.summaryOnly === true) {
        return (summary.messageCount ?? 0) > 0
      }
      return (chat.messages || []).length > 0
    })

  // 1.0.5-EW51 — Materialise the workspace + daily-cost arrays
  // from the aggregates we built in the lifetime loop above.
  // Workspaces: resolve displayName from the caller's
  // `workspaces` slice (fall back to a synthesised label for
  // unknown / no-workspace records), sort DESC by cost (tokens
  // tiebreaker), compute share-of-total-cost. Daily series:
  // zero-fill every day in the rolling 30-day window so the
  // chart's x-axis stays uniform regardless of activity
  // density, oldest-first.
  const totalAllWorkspaceCost = Array.from(workspaceAggregate.values()).reduce(
    (sum, bucket) => sum + (bucket.costUsd || 0),
    0
  )
  const totalAllWorkspaceTokens = Array.from(workspaceAggregate.values()).reduce(
    (sum, bucket) => sum + (bucket.tokens || 0),
    0
  )
  const workspaceCostBreakdown: WorkspaceCostBreakdownEntry[] = Array.from(
    workspaceAggregate.entries()
  )
    .map(([key, bucket]) => {
      // Humanise internal/persisted global-chat sentinels so old usage
      // records don't leak implementation names into the dashboard.
      const displayName =
        key === NO_WORKSPACE_KEY
          ? 'No workspace'
          : key === GLOBAL_CHATS_WORKSPACE_KEY
            ? 'General Chat'
            : LEGACY_AGBENCH_GLOBAL_CHATS_WORKSPACE_KEYS.has(key)
              ? 'Legacy Global Chats'
              : workspaces.find((w) => w.id === key)?.displayName || key
      return {
        workspaceId: key,
        displayName,
        tokens: bucket.tokens,
        costUsd: bucket.costUsd,
        shareOfTotalCost:
          totalAllWorkspaceCost > 0 ? (bucket.costUsd / totalAllWorkspaceCost) * 100 : 0,
        // 1.0.6-CRUX43 — token share drives the dashboard workspace meters. Cost
        // is 0 for most Gemini-heavy workspaces, so the cost meter read near-empty
        // for everything; token share reflects each workspace's real prominence.
        shareOfTotalTokens:
          totalAllWorkspaceTokens > 0 ? (bucket.tokens / totalAllWorkspaceTokens) * 100 : 0
      }
    })
    .sort(
      (a, b) =>
        b.costUsd - a.costUsd || b.tokens - a.tokens || a.displayName.localeCompare(b.displayName)
    )
  const todayDayStart = startOfLocalDay(now)
  const dailyCostBreakdown: DailyCostBucket[] = []
  for (let i = DASHBOARD_COST_CHART_DAY_COUNT - 1; i >= 0; i--) {
    const ts = todayDayStart - i * 24 * 60 * 60 * 1000
    const dayKey = dayKeyFromTimestamp(ts)
    const bucket = dailyCostAggregate.get(dayKey) || { tokens: 0, costUsd: 0 }
    dailyCostBreakdown.push({
      dayKey,
      dayLabel: formatUsageDateLabel(dayKey),
      tokens: bucket.tokens,
      costUsd: bucket.costUsd
    })
  }

  // 1.0.5-EW52 — Build the per-provider breakdown from the
  // aggregate map. Always 4 entries (one per canonical
  // provider) so the Providers tab card list is a stable
  // roster — even an unused provider gets a 0-token card,
  // which surfaces "you haven't tried Kimi yet" usefully.
  // Sorted DESC by cost (tokens tiebreaker, then alpha by
  // provider name for stable cross-provider ordering when
  // everything's zero).
  const totalProviderCost = Object.values(providerCostAggregate).reduce(
    (sum, bucket) => sum + bucket.costUsd,
    0
  )
  const providerDisplayNames: Record<ProviderId, string> = {
    codex: 'Codex',
    claude: 'Claude',
    gemini: 'Gemini',
    kimi: 'Kimi',
    grok: 'Grok',
    cursor: 'Cursor',
    ollama: 'Ollama',
    antigravity: 'Antigravity'
  }
  // 1.0.5-EW52 follow-up — Also compute total provider-tokens
  // so each card's meter can render as share-of-tokens rather
  // than share-of-cost. Gemini CLI runs frequently report 0
  // cost, which made the cost-based meter visually misleading
  // (e.g. 92M Gemini tokens but no fill). Tokens are populated
  // for every provider so the meter is consistently informative.
  const totalProviderTokensForBreakdown = (
    Object.keys(providerCostAggregate) as ProviderId[]
  ).reduce((sum, provider) => sum + providerCostAggregate[provider].tokens, 0)
  const providerCostBreakdown: ProviderCostBreakdownEntry[] = (
    Object.keys(providerCostAggregate) as ProviderId[]
  )
    .map((provider) => ({
      provider,
      displayName: providerDisplayNames[provider],
      tokens: providerCostAggregate[provider].tokens,
      costUsd: providerCostAggregate[provider].costUsd,
      shareOfTotalCost:
        totalProviderCost > 0
          ? (providerCostAggregate[provider].costUsd / totalProviderCost) * 100
          : 0,
      shareOfTotalTokens:
        totalProviderTokensForBreakdown > 0
          ? (providerCostAggregate[provider].tokens / totalProviderTokensForBreakdown) * 100
          : 0
    }))
    // Cursor rows cover live Path-B runs as well as historical usage; this
    // breakdown is a ledger view, not a provider offer.
    .sort(
      (a, b) =>
        b.tokens - a.tokens || b.costUsd - a.costUsd || a.displayName.localeCompare(b.displayName)
    )

  const sessionsCount = sessionIds.size
  // 1.0.5-EW49 — Three derived metrics, computed once we have the
  // primary aggregates above. All gated on `sessionsCount > 0` so
  // we don't surface NaN / Infinity values when the user just
  // installed the app or has no in-range activity. The average
  // session duration is sum-of-wall-time / sessions; tokens per
  // session is the same shape but for tokens.
  const avgSessionMs = sessionsCount > 0 ? Math.round(totalWallTimeMs / sessionsCount) : 0
  const tokensPerSession = sessionsCount > 0 ? Math.round(totalTokens / sessionsCount) : 0

  return {
    hasActivity,
    lifetimeHasActivity,
    tokens24h,
    sessions: sessionsCount,
    messages: messageEvents.length || runRecords.length * 2,
    totalTokens,
    activeDays: activeDayKeys.size,
    currentStreak,
    longestStreak,
    longestThreadMs,
    totalWallTimeMs,
    totalCostUsd,
    avgSessionMs,
    tokensPerSession,
    workspaceCostBreakdown,
    dailyCostBreakdown,
    providerCostBreakdown,
    wallTime24hMs,
    peakHour: runRecords.length > 0 ? formatPeakHour(peakHour) : 'n/a',
    favoriteModel,
    favoriteProject,
    providerCount: providerIds.size,
    providerTokenTotals,
    comparisonText: hasActivity
      ? `You've tracked ${formatCompactUsageNumber(totalTokens)} tokens across ${providerIds.size || 1} provider${(providerIds.size || 1) === 1 ? '' : 's'}.`
      : 'Start a provider run to seed workspace activity stats.',
    heatmap,
    hourlyHeatmap,
    chartDays,
    modelBreakdown,
    maxChartTotal
  }
}

/**
 * Mix provider colours weighted by token share. Returns a CSS colour string
 * suitable for use as a chip background. Empty input returns an empty string,
 * letting the caller fall back to the default empty-cell background.
 */
export const mixProviderColors = (
  providerTotals: Record<ProviderId, number>,
  providerColors: Record<ProviderId, string>
): string => {
  const entries = (Object.keys(providerTotals) as ProviderId[])
    .map((provider) => ({ provider, weight: providerTotals[provider] }))
    .filter(({ weight }) => weight > 0)
  if (entries.length === 0) return ''
  const totalWeight = entries.reduce((sum, item) => sum + item.weight, 0)
  if (totalWeight <= 0) return ''
  if (entries.length === 1) {
    return providerColors[entries[0].provider]
  }
  // color-mix only takes two colours at a time so we fold left, mixing each
  // additional colour by its share of the *remaining* weight. This gives a
  // weighted average without depending on a runtime RGB parser.
  let accumulatedWeight = entries[0].weight
  let blend = `${providerColors[entries[0].provider]}`
  for (let i = 1; i < entries.length; i += 1) {
    const next = entries[i]
    const nextWeight = next.weight
    const blendWeight = accumulatedWeight
    accumulatedWeight += nextWeight
    const blendPercent = Math.round((blendWeight / accumulatedWeight) * 100)
    const nextPercent = 100 - blendPercent
    blend = `color-mix(in srgb, ${blend} ${blendPercent}%, ${providerColors[next.provider]} ${nextPercent}%)`
  }
  return blend
}
