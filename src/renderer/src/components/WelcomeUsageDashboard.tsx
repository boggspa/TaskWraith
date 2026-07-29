import { useEffect, useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import { formatCost, type DisplayCurrency } from '../lib/formatCost'
import {
  formatCompactUsageNumber,
  formatDashboardDuration,
  mixProviderColors,
  WELCOME_USAGE_PROVIDER_IDS,
  type WelcomeUsageDashboardData,
  type WelcomeUsageTab
} from '../lib/welcomeUsageDashboard'
import { isDashboardStatVisible } from '../lib/dashboardStatRegistry'
import { WelcomeUsageAgentsTab } from './WelcomeUsageAgentsTab'
import {
  ClockSymbolIcon,
  FolderSymbolIcon,
  MascotGhost,
  ModelSymbolIcon,
  OverviewSymbolIcon
} from './AppChromeSymbols'

/**
 * Welcome-dashboard tab descriptors. Each entry carries an icon
 * component so the header reads "<icon> <label>" — a deliberate
 * point of differentiation from Claude's text-only segmented tabs
 * (the dashboard otherwise sat very close to Claude's pattern).
 * Icons are reused from the inline SymbolIcon set so they pick up
 * theme colour tokens automatically.
 */
const WELCOME_USAGE_TABS: Array<{
  value: WelcomeUsageTab
  label: string
  Icon: () => ReactElement
}> = [
  { value: 'overview', label: 'Statistics', Icon: OverviewSymbolIcon },
  { value: 'models', label: 'Model Comparisons', Icon: ModelSymbolIcon },
  // 1.0.5-EW51 — Workspaces tab. Shows per-workspace cumulative
  // token + cost totals (scrollable cards, capped at the user-
  // configured max from `AppSettings.dashboardStatPrefs
  // .workspacesShown`) plus a 30-day daily cost chart. Reuses
  // the FolderSymbolIcon (already imported as the welcome
  // workspace-picker icon) so the tab visually echoes the
  // workspace concept without a new asset.
  { value: 'workspaces', label: 'Workspaces', Icon: FolderSymbolIcon },
  // 1.0.5-EW52 — Providers tab. Per-provider tokens + cost
  // cards (all ten stable provider identities, always shown) above a
  // giant 24H wall-time timecode display. Different shape from
  // Workspaces (which has a 30d chart underneath) — the
  // timecode emphasises "how much agent-time happened today"
  // as a single legible glyph.
  { value: 'providers', label: 'Providers', Icon: ProviderTabIcon },
  // Agents tab — the Settings → Agent pool leaderboard re-dressed
  // in dashboard chrome: #1-agent hero chips above a scrollable
  // standings list. Data is self-contained inside the tab body
  // (localStorage pool + async stats IPC), so this entry needs no
  // new dashboard props. Always visible, like Statistics / Model
  // Comparisons.
  { value: 'agents', label: 'Agents', Icon: AgentsTabIcon }
]

export function nextWelcomeUsageTab(
  current: WelcomeUsageTab,
  visibleTabs: WelcomeUsageTab[]
): WelcomeUsageTab {
  if (visibleTabs.length === 0) return 'overview'
  const currentIndex = visibleTabs.indexOf(current)
  return visibleTabs[(currentIndex + 1) % visibleTabs.length] ?? visibleTabs[0]
}

// 1.0.5-EW52 — Lightweight icon for the Providers tab. Same
// stroke language as the other tab icons (1.4 weight, rounded
// caps/joins). Renders as three stacked horizontal bars — a
// nod to the "multiple providers in parallel" identity.
function ProviderTabIcon(): React.JSX.Element {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="2" y="3.5" width="12" height="2" rx="1" />
      <rect x="2" y="7" width="9" height="2" rx="1" />
      <rect x="2" y="10.5" width="11" height="2" rx="1" />
    </svg>
  )
}

// Agents-tab icon. Same stroke language as the other tab icons
// (1.4 weight, rounded caps/joins): two head-and-shoulders figures,
// echoing the Agent-pool "reusable roster" identity.
function AgentsTabIcon(): React.JSX.Element {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="5.6" cy="5.6" r="2.3" />
      <path d="M2 13c.4-2.2 1.9-3.4 3.6-3.4S8.8 10.8 9.2 13" />
      <path d="M10.4 4a2 2 0 1 1 1.4 3.6" />
      <path d="M11.4 9.4c1.5.2 2.4 1.3 2.7 2.9" />
    </svg>
  )
}

// Welcome L7 — range toggle retired. The dashboard now locks to a
// fixed 30-day rolling window that matches the sidebar UsageHeatmap.
// (The L2–L5 toggle infrastructure stays in the lib because the
// builder still accepts a `range` param, but the UI only ever calls
// it with '30d' from one site.) The WELCOME_USAGE_RANGES constant +
// rangeLabelFor helper were removed alongside the toggle JSX.

// `ActivityContributionGrid` retired in Welcome L1 — the welcome
// dashboard now hosts the sidebar's UsageHeatmap (logarithmic
// intensity, 2-hour buckets, dominant-provider coloring) so a single
// renderer powers both surfaces. The linear-scaled day-grid is gone.

export function WelcomeUsageDashboard({
  data,
  initialTab = 'overview',
  displayCurrency,
  overestimatePercent,
  dashboardStatVisibility,
  workspacesTabEnabled,
  workspacesShown,
  providersTabEnabled,
  autoCycleSeconds
}: {
  data: WelcomeUsageDashboardData
  /**
   * Ephemeral presentation state belongs to this dashboard instance. Keeping
   * it local prevents the auto-cycle timer and manual tab clicks from
   * invalidating the root App tree (including an active composer).
   */
  initialTab?: WelcomeUsageTab
  // 1.0.5-EW49 — Currency + overestimate bias passed in so the
  // EW49 "Total cost" chip can route through `formatCost` with
  // the user's preferences. Defaults to USD + 0 if the caller
  // omits them (e.g. tests or older callers).
  displayCurrency?: DisplayCurrency
  overestimatePercent?: number
  // Per-stat visibility (true/false/undefined-defaults-to-true).
  // Hidden stats are dropped from the dense grid render below.
  dashboardStatVisibility?: Record<string, boolean>
  /**
   * 1.0.5-EW51 — Workspaces tab on/off + max cards shown. The
   * tab strip filters the Workspaces entry out when the user
   * disables the tab; the cards list slices to `workspacesShown`
   * (default 8). Both come from AppSettings.dashboardStatPrefs.
   */
  workspacesTabEnabled?: boolean
  workspacesShown?: number
  /**
   * 1.0.5-EW52 — Providers tab on/off + auto-cycle interval.
   * Providers default visible; auto-cycle defaults to 180s
   * (3 min). Auto-cycle 0 / undefined disables looping.
   */
  providersTabEnabled?: boolean
  autoCycleSeconds?: number
}) {
  const [tab, setTab] = useState<WelcomeUsageTab>(initialTab)
  const resolvedCurrency: DisplayCurrency = displayCurrency || 'USD'
  const resolvedOverestimate = Math.max(0, Math.min(25, Number(overestimatePercent ?? 0) || 0))
  const resolvedWorkspacesEnabled = workspacesTabEnabled !== false
  const resolvedWorkspacesShown = Math.max(4, Math.min(20, Number(workspacesShown ?? 8) || 8))
  const resolvedProvidersEnabled = providersTabEnabled !== false
  // Auto-cycle: 0/undefined = disabled, else clamp 30–3600.
  const resolvedAutoCycleSeconds = (() => {
    const raw = Number(autoCycleSeconds)
    if (!Number.isFinite(raw) || raw <= 0) return autoCycleSeconds === undefined ? 180 : 0
    return Math.max(30, Math.min(3600, Math.round(raw)))
  })()

  // 1.0.5-EW52 — Auto-cycle the dashboard tabs every N seconds
  // while the welcome screen is mounted. The interval runs in
  // setInterval; on each tick we advance to the next visible
  // tab. Visibility is recomputed each tick so the user
  // toggling a tab off in Settings is honoured live. We
  // intentionally don't pause on user click — the user said
  // "loop", we loop. A pause-on-interaction tweak is a small
  // follow-up if usage proves the auto-jump feels intrusive.
  const visibleTabValues = useMemo(() => {
    return WELCOME_USAGE_TABS.filter((option) => {
      if (option.value === 'workspaces') return resolvedWorkspacesEnabled
      if (option.value === 'providers') return resolvedProvidersEnabled
      return true
    }).map((option) => option.value)
  }, [resolvedWorkspacesEnabled, resolvedProvidersEnabled])
  useEffect(() => {
    setTab((current) =>
      visibleTabValues.includes(current) ? current : (visibleTabValues[0] ?? 'overview')
    )
  }, [visibleTabValues])
  useEffect(() => {
    if (!resolvedAutoCycleSeconds || visibleTabValues.length < 2) return
    const intervalId = setInterval(() => {
      setTab((current) => nextWelcomeUsageTab(current, visibleTabValues))
    }, resolvedAutoCycleSeconds * 1000)
    return () => clearInterval(intervalId)
  }, [resolvedAutoCycleSeconds, visibleTabValues])
  // Phase K-followup — Provider color palette + mixed rail colour.
  // Each stat chip carries a thin top rail in this colour. The mix
  // is computed from this dashboard's per-provider token totals so
  // the rail visually communicates "this data spans these providers
  // in roughly this proportion" — TaskWraith's distinct identity vs
  // Claude's single-accent dashboard.
  const PROVIDER_PALETTE = {
    gemini: '#346EEC',
    codex: '#705AFF',
    claude: '#B16105',
    kimi: '#0073E6',
    grok: '#757575',
    cursor: '#8D7312',
    ollama: '#1A8562',
    antigravity: '#308713',
    pi: '#68768C',
    mistral: '#D44404'
  } as const
  const chipRailColor =
    mixProviderColors(data.providerTokenTotals, PROVIDER_PALETTE) ||
    'color-mix(in srgb, var(--accent) 60%, transparent)'
  const chipRailStyle = { '--chip-rail-color': chipRailColor } as React.CSSProperties
  // Provider mix ribbon segments — flex-grown by token share. Each
  // segment is always present; segments with no tokens fall to a
  // hairline minimum so the ribbon never collapses entirely while
  // also not pretending a provider was active when it wasn't.
  const totalProviderTokens = WELCOME_USAGE_PROVIDER_IDS.reduce(
    (total, provider) => total + data.providerTokenTotals[provider],
    0
  )
  const providerRibbonSegments = WELCOME_USAGE_PROVIDER_IDS.map((provider) => ({
    provider,
    weight: data.providerTokenTotals[provider],
    share: totalProviderTokens > 0 ? data.providerTokenTotals[provider] / totalProviderTokens : 0
  }))

  // Welcome L9 — Overview chip rework. Top row hosts three hero chips
  // (Favorite model + Favorite project + 24H Tkns); bottom row carries
  // the seven denser stat pills. Hero stats lead with what the user
  // looks at first; dense pills carry the supporting numbers.
  const heroStatItems = [
    {
      label: 'Favorite model',
      value: data.favoriteModel,
      // Long model identifiers (e.g. `gemini-3.1-flash-lite-preview`)
      // would otherwise wrap awkwardly inside the hero chip.
      title: data.favoriteModel
    },
    {
      label: 'Favorite project',
      value: data.favoriteProject,
      // Workspace display names can be long (full path tails) — keep
      // the full string available on hover.
      title: data.favoriteProject
    },
    { label: '24H Tkns', value: formatCompactUsageNumber(data.tokens24h) }
  ]
  /*
    1.0.5-EW48 — Reordered into three semantic rows for the new
    3-column dense grid (was a single 7-column row with awkward
    7+2 wrap after EW44 pushed the count to 9). Each row groups
    a coherent data family so a glance at the grid reads as
    "calendar · time · volume" rather than a chip soup:

      Row 1 (Calendar) : Current streak · Longest streak · Active days
      Row 2 (Duration) : Longest thread · Cumulative wall time · Peak hour
      Row 3 (Volume)   : Sessions · Messages · Total tokens
  */
  // 1.0.5-EW49 — Twelve entries to balance the 3-column grid to
  // 4×3. Each item carries a stable `key` (from
  // `dashboardStatRegistry.ts`) used by Settings → General for
  // per-stat show/hide. Row 4 (Spend) is EW49 new: Total cost,
  // Avg session, Tokens/session.
  const denseStatItemsAll = [
    // Row 1 — calendar metrics (days-based, always lifetime).
    { key: 'currentStreak', label: 'Current streak', value: `${data.currentStreak || 0}d` },
    { key: 'longestStreak', label: 'Longest streak', value: `${data.longestStreak || 0}d` },
    { key: 'activeDays', label: 'Active days', value: formatCompactUsageNumber(data.activeDays) },
    // Row 2 — duration metrics (Longest thread + Cumulative
    // wall time are lifetime EW44 additions; Peak hour is
    // range-scoped to the 30-day window).
    {
      key: 'longestThreadMs',
      label: 'Longest thread',
      value: formatDashboardDuration(data.longestThreadMs)
    },
    {
      key: 'totalWallTimeMs',
      label: 'Cumulative wall time',
      value: formatDashboardDuration(data.totalWallTimeMs)
    },
    { key: 'peakHour', label: 'Peak hour', value: data.peakHour },
    // Row 3 — volume metrics (count-based, range-scoped).
    { key: 'sessions', label: 'Sessions', value: formatCompactUsageNumber(data.sessions) },
    { key: 'messages', label: 'Messages', value: formatCompactUsageNumber(data.messages) },
    {
      key: 'totalTokens',
      label: 'Total tokens',
      value: formatCompactUsageNumber(data.totalTokens)
    },
    // Row 4 — spend / efficiency metrics (1.0.5-EW49 new
    // additions). Total cost flows through `formatCost` so it
    // honours the user's currency + overestimate bias; Avg
    // session uses the same scale-smart duration formatter as
    // Longest thread / Cumulative wall time; Tokens / session
    // is a compact count.
    {
      key: 'totalCostUsd',
      label: 'Total cost',
      value: formatCost(data.totalCostUsd, resolvedCurrency, undefined, resolvedOverestimate)
    },
    {
      key: 'avgSessionMs',
      label: 'Avg session',
      value: formatDashboardDuration(data.avgSessionMs)
    },
    {
      key: 'tokensPerSession',
      label: 'Tokens / session',
      value: formatCompactUsageNumber(data.tokensPerSession)
    }
  ]
  const denseStatItems = denseStatItemsAll.filter((item) =>
    isDashboardStatVisible(dashboardStatVisibility, item.key)
  )
  const overviewStatItems = [
    ...heroStatItems.map((item) => ({
      key: item.label,
      label: item.label,
      value: item.value,
      title: item.title
    })),
    ...denseStatItems.map((item) => ({
      key: item.key,
      label: item.label,
      value: item.value,
      title: item.label
    }))
  ]

  return (
    <section className="welcome-usage-dashboard" aria-label="Provider usage overview">
      <div className="welcome-usage-dashboard-header">
        <div className="welcome-usage-tabs" role="tablist" aria-label="Usage view">
          {WELCOME_USAGE_TABS.filter((option) => {
            // 1.0.5-EW51/EW52 — Hide the Workspaces / Providers
            // tab when the user toggled it off in Settings. The
            // Statistics + Model Comparisons tabs always show.
            if (option.value === 'workspaces') return resolvedWorkspacesEnabled
            if (option.value === 'providers') return resolvedProvidersEnabled
            return true
          }).map((option) => {
            const Icon = option.Icon
            return (
              <button
                key={option.value}
                type="button"
                role="tab"
                aria-selected={tab === option.value}
                className={`welcome-usage-tab ${tab === option.value ? 'active' : ''}`}
                onClick={() => setTab(option.value)}
              >
                <Icon />
                <span className="welcome-usage-tab-label">{option.label}</span>
              </button>
            )
          })}
        </div>
        <span className="welcome-usage-window-label" aria-label="Reporting window">
          <ClockSymbolIcon />
          <span>Last 30 days</span>
        </span>
      </div>

      {/* Phase K-followup — Provider mix ribbon. Nine-segment
          horizontal bar where each segment's width is proportional to
          that provider's token share in the 30-day window. TaskWraith's
          multi-provider identity made literal — Claude structurally
          cannot have this. Hidden when nothing has run yet. */}
      {totalProviderTokens > 0 && (
        <div
          className="welcome-usage-provider-ribbon"
          aria-label="Provider mix across the last 30 days"
          title={providerRibbonSegments
            .filter((s) => s.weight > 0)
            .map((s) => `${s.provider}: ${Math.round(s.share * 100)}%`)
            .join(' · ')}
        >
          {providerRibbonSegments.map((seg) => (
            <span
              key={seg.provider}
              className={`welcome-usage-provider-ribbon-seg provider-${seg.provider}`}
              style={
                {
                  flexGrow: seg.weight > 0 ? seg.weight : 0.001,
                  background: PROVIDER_PALETTE[seg.provider],
                  opacity: seg.weight > 0 ? 1 : 0.25
                } as React.CSSProperties
              }
            />
          ))}
        </div>
      )}

      {/* Welcome L6/L7 — empty-state when the 30-day rolling window has
          no activity. The dashboard still mounts (lifetimeHasActivity
          is true) so the user sees the headline shape; this card
          replaces the stat grid / chart inside. The Agents tab is
          exempt: pool standings are ALL-TIME (forward-only ledger),
          so a quiet month must not blank the leaderboard — it renders
          ahead of the hasActivity gate and carries its own empty
          states. */}
      {tab === 'agents' ? (
        /*
          Agents tab — Agent-pool leaderboard in dashboard chrome.
          Hero row (#1 agent identity + its headline stats) above a
          scrollable standings chip. The component owns its own data
          (localStorage pool + async stats IPC), so the dashboard
          passes nothing through.
        */
        <WelcomeUsageAgentsTab />
      ) : !data.hasActivity ? (
        <div className="welcome-usage-empty welcome-usage-empty--range">
          <MascotGhost size={34} />
          <strong>No activity in the last 30 days.</strong>
          <span>Kick off a run on this workspace to start filling the dashboard.</span>
        </div>
      ) : tab === 'overview' ? (
        <>
          <div
            className="welcome-usage-stat-list"
            style={chipRailStyle}
            aria-label="Usage statistics"
          >
            {overviewStatItems.map((item) => (
              <div key={item.key} className="welcome-usage-stat-list-row" title={item.title}>
                <span>{item.label}</span>
                <strong>{item.value}</strong>
              </div>
            ))}
          </div>
          <p className="welcome-usage-footnote">{data.comparisonText}</p>
        </>
      ) : tab === 'models' ? (
        /* Welcome L7 — per-model meters replace the per-day stacked
         * bar chart. Each model gets a row with a horizontal meter
         * whose fill is proportional to that model's share of the
         * 30-day window. Bars stretch to fill the dashboard width so
         * the layout doesn't overshoot regardless of how many models
         * the user has run. The bar's filled length encodes the
         * share; the right-hand numeric stack carries the exact %
         * and in/out token counts. */
        <div className="welcome-usage-model-meters">
          {data.modelBreakdown.length > 0 ? (
            data.modelBreakdown.map((model) => {
              const percent = Math.max(0, Math.min(100, model.percent))
              const fillWidth = `${Math.max(2, percent)}%`
              return (
                <div
                  key={model.id}
                  className={`welcome-usage-model-meter ${model.colorClass}`}
                >
                  <div className="welcome-usage-model-meter-header">
                    <span
                      className={`welcome-usage-model-dot ${model.colorClass}`}
                      aria-hidden
                    />
                    <span className="welcome-usage-model-name" title={model.label}>
                      {model.label}
                    </span>
                    <span className="welcome-usage-model-tokens">
                      {formatCompactUsageNumber(model.inputTokens)} in ·{' '}
                      {formatCompactUsageNumber(model.outputTokens)} out
                    </span>
                    <strong className="welcome-usage-model-percent">
                      {percent >= 10 ? percent.toFixed(1) : percent.toFixed(1)}%
                    </strong>
                  </div>
                  <div
                    className="welcome-usage-model-meter-track"
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={percent}
                    aria-label={`${model.label} accounts for ${percent.toFixed(1)}% of 30-day usage`}
                  >
                    <span
                      className={`welcome-usage-model-meter-fill ${model.colorClass}`}
                      style={{ width: fillWidth }}
                    />
                  </div>
                </div>
              )
            })
          ) : (
            <div className="welcome-usage-empty">
              No model-level usage tracked in the last 30 days.
            </div>
          )}
        </div>
      ) : tab === 'workspaces' ? (
        /*
          1.0.5-EW51 — Workspaces tab. Two-section layout:
            1. Scrollable list of per-workspace cards (top N from
               settings, default 8). Each card: workspace name on
               the left, token total + cost on the right, with a
               share-of-total progress bar underneath.
            2. 30-day daily cost chart below. SVG bars, height
               scaled to the max-cost day in the window. Hover
               surfaces date + token + cost via the bar's title.

          (1.0.5-EW52 — Promoted from catch-all to an explicit
           `tab === 'workspaces'` branch so the Providers tab can
           own the catch-all slot below.)
        */
        <div className="welcome-usage-workspaces">
          {data.workspaceCostBreakdown.length === 0 ? (
            <div className="welcome-usage-empty">
              No workspace-attributed activity tracked since the last reset.
            </div>
          ) : (
            <>
              <div
                className="welcome-usage-workspaces-list"
                role="list"
                aria-label="Workspace cost breakdown"
              >
                {data.workspaceCostBreakdown.slice(0, resolvedWorkspacesShown).map((ws) => {
                  // 1.0.6-CRUX43 — meter = share of total TOKENS (not cost), so a
                  // workspace's bar reflects its real prominence (the token label
                  // beside it stays unchanged).
                  const share = Math.max(0, Math.min(100, ws.shareOfTotalTokens))
                  const fillWidth = `${Math.max(2, share)}%`
                  return (
                    <div
                      key={ws.workspaceId}
                      role="listitem"
                      className="welcome-usage-workspace-card"
                      title={`${ws.displayName} · ${formatCompactUsageNumber(ws.tokens)} tokens · ${formatCost(
                        ws.costUsd,
                        resolvedCurrency,
                        undefined,
                        resolvedOverestimate
                      )}`}
                    >
                      <div className="welcome-usage-workspace-card-row">
                        <span className="welcome-usage-workspace-card-name">{ws.displayName}</span>
                        <span className="welcome-usage-workspace-card-totals">
                          <span className="welcome-usage-workspace-card-tokens">
                            {formatCompactUsageNumber(ws.tokens)} tokens
                          </span>
                          <strong className="welcome-usage-workspace-card-cost">
                            {formatCost(
                              ws.costUsd,
                              resolvedCurrency,
                              undefined,
                              resolvedOverestimate
                            )}
                          </strong>
                        </span>
                      </div>
                      <div
                        className="welcome-usage-workspace-card-track"
                        role="progressbar"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={share}
                        aria-label={`${ws.displayName} accounts for ${share.toFixed(1)}% of total tokens`}
                      >
                        <span
                          className="welcome-usage-workspace-card-fill"
                          style={{ width: fillWidth }}
                        />
                      </div>
                    </div>
                  )
                })}
              </div>
              {(() => {
                /*
                  Daily cost chart. SVG layout chosen over a div
                  grid so the bars can scale fluidly to whatever
                  width the dashboard ends up at + we can drop
                  proper accessible labels per bar. ViewBox uses
                  a fixed coordinate space (0..30 × 0..100) and
                  `preserveAspectRatio='none'` lets the bars
                  stretch horizontally. Height: bars scale
                  against the max-cost day; if no day has cost
                  yet (Gemini-only history) we fall back to a
                  tokens-scaled visualisation so the chart still
                  reads as activity.
                */
                const days = data.dailyCostBreakdown
                const maxCost = days.reduce((max, day) => Math.max(max, day.costUsd), 0)
                const maxTokens = days.reduce((max, day) => Math.max(max, day.tokens), 0)
                const scaleByCost = maxCost > 0
                const max = scaleByCost ? maxCost : maxTokens
                const totalCostInWindow = days.reduce((sum, day) => sum + day.costUsd, 0)
                const totalTokensInWindow = days.reduce((sum, day) => sum + day.tokens, 0)
                return (
                  <div className="welcome-usage-cost-chart">
                    <div className="welcome-usage-cost-chart-header">
                      <span className="welcome-usage-cost-chart-title">
                        Daily {scaleByCost ? 'cost' : 'tokens'} · last 30 days
                      </span>
                      <span className="welcome-usage-cost-chart-total">
                        {scaleByCost
                          ? `${formatCost(totalCostInWindow, resolvedCurrency, undefined, resolvedOverestimate)} total`
                          : `${formatCompactUsageNumber(totalTokensInWindow)} tokens total`}
                      </span>
                    </div>
                    {max > 0 ? (
                      <svg
                        className="welcome-usage-cost-chart-svg"
                        viewBox={`0 0 ${days.length} 100`}
                        preserveAspectRatio="none"
                        role="img"
                        aria-label={`${days.length}-day ${scaleByCost ? 'cost' : 'token'} chart`}
                      >
                        {days.map((day, index) => {
                          const value = scaleByCost ? day.costUsd : day.tokens
                          const height = max > 0 ? (value / max) * 96 : 0
                          const y = 100 - height
                          const tooltip = `${day.dayLabel} · ${formatCompactUsageNumber(
                            day.tokens
                          )} tokens · ${formatCost(
                            day.costUsd,
                            resolvedCurrency,
                            undefined,
                            resolvedOverestimate
                          )}`
                          return (
                            <rect
                              key={day.dayKey}
                              x={index + 0.1}
                              y={y}
                              width={0.8}
                              height={Math.max(0, height)}
                              className={`welcome-usage-cost-chart-bar${
                                value > 0 ? ' is-active' : ''
                              }`}
                            >
                              <title>{tooltip}</title>
                            </rect>
                          )
                        })}
                      </svg>
                    ) : (
                      <div className="welcome-usage-empty welcome-usage-cost-chart-empty">
                        No cost or token activity in the last 30 days.
                      </div>
                    )}
                    <div className="welcome-usage-cost-chart-axis">
                      <span>{days[0]?.dayLabel}</span>
                      <span>{days[days.length - 1]?.dayLabel}</span>
                    </div>
                  </div>
                )
              })()}
            </>
          )}
        </div>
      ) : (
        /*
          1.0.5-EW52 — Providers tab. Per-provider card list at
          the top (nine cards, always shown — even zero-token
          providers stay visible because "you haven't tried
          Kimi" is itself useful information). Below the cards:
          a giant timecode showing the cumulative wall-clock
          time across runs in the last 24 hours, framed as a
          single dominant glyph rather than the small "Avg
          session" chip on the Statistics tab.
        */
        <div className="welcome-usage-providers">
          <div
            className="welcome-usage-providers-list"
            role="list"
            aria-label="Provider cost breakdown"
          >
            {data.providerCostBreakdown.map((entry) => {
              /*
                1.0.5-EW52 follow-up — Meter now reads share of
                tokens rather than share of cost. Cost is often
                0 for Gemini CLI runs (the provider doesn't
                report explicitCostUsd), which made the
                cost-based meter visually misleading for users
                whose biggest token-consumer was Gemini. Token
                totals are populated for every provider so the
                meter consistently mirrors the provider-mix
                balance ribbon above. The cost figure stays in
                the right-hand readout + hover title — meter is
                "share of usage", cost is "what it cost you".
              */
              const share = Math.max(0, Math.min(100, entry.shareOfTotalTokens))
              const fillWidth = `${Math.max(2, share)}%`
              return (
                <div
                  key={entry.provider}
                  role="listitem"
                  className={`welcome-usage-provider-card provider-${entry.provider}`}
                  title={`${entry.displayName} · ${formatCompactUsageNumber(entry.tokens)} tokens (${share.toFixed(1)}%) · ${formatCost(
                    entry.costUsd,
                    resolvedCurrency,
                    undefined,
                    resolvedOverestimate
                  )}`}
                >
                  <div className="welcome-usage-provider-card-row">
                    <span className="welcome-usage-provider-card-name">
                      <span
                        className={`welcome-usage-provider-card-dot provider-${entry.provider}`}
                        aria-hidden
                      />
                      {entry.displayName}
                    </span>
                    <span className="welcome-usage-provider-card-totals">
                      <span className="welcome-usage-provider-card-tokens">
                        {formatCompactUsageNumber(entry.tokens)} tokens
                      </span>
                      <strong className="welcome-usage-provider-card-cost">
                        {formatCost(
                          entry.costUsd,
                          resolvedCurrency,
                          undefined,
                          resolvedOverestimate
                        )}
                      </strong>
                    </span>
                  </div>
                  <div
                    className="welcome-usage-provider-card-track"
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={share}
                    aria-label={`${entry.displayName} accounts for ${share.toFixed(1)}% of post-reset tokens`}
                  >
                    <span
                      className={`welcome-usage-provider-card-fill provider-${entry.provider}`}
                      style={{ width: fillWidth }}
                    />
                  </div>
                </div>
              )
            })}
          </div>
          {(() => {
            /*
              Giant 24H wall-time timecode. Format mirrors the
              composer's AR10 cumulative session timecode style
              but in HH:MM:SS only (no centiseconds — at this
              scale the second-level precision is honest).
              Padded to 2 digits per slot so the readout has a
              fixed width regardless of magnitude — the digits
              don't reflow as time accumulates.
            */
            const ms = Math.max(0, Number(data.wallTime24hMs) || 0)
            const totalSeconds = Math.floor(ms / 1000)
            const hours = Math.floor(totalSeconds / 3600)
            const minutes = Math.floor((totalSeconds % 3600) / 60)
            const seconds = totalSeconds % 60
            const pad = (n: number): string => String(n).padStart(2, '0')
            const timecode = `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`
            return (
              <div
                className="welcome-usage-providers-timecode"
                aria-label={`Wall time across all runs in the last 24 hours: ${timecode}`}
              >
                <div className="welcome-usage-providers-timecode-label">24H Wall Time</div>
                <div className="welcome-usage-providers-timecode-readout" role="timer">
                  <span className="welcome-usage-providers-timecode-segment">{pad(hours)}</span>
                  <span className="welcome-usage-providers-timecode-sep">:</span>
                  <span className="welcome-usage-providers-timecode-segment">{pad(minutes)}</span>
                  <span className="welcome-usage-providers-timecode-sep">:</span>
                  <span className="welcome-usage-providers-timecode-segment">{pad(seconds)}</span>
                </div>
                <div className="welcome-usage-providers-timecode-sub">
                  Cumulative wall-clock time across runs in the rolling 24-hour window.
                </div>
              </div>
            )
          })()}
        </div>
      )}
    </section>
  )
}
