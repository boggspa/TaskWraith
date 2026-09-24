// WelcomeDashboardRemote.ts — projects the renderer's welcome-dashboard
// aggregator (`buildWelcomeUsageDashboardData`) into the flat, iOS-friendly shape
// the phone decodes (Swift `WelcomeDashboard`). Isolating the cross-tree import
// here (the aggregator lives under src/renderer/src/lib but is pure Node-safe TS:
// its only non-type import is `modelDisplayName`, also pure) keeps the seam in one
// place and lets the mapper be unit-tested without the Electron app.

import {
  buildWelcomeUsageDashboardDataFromActivity,
  welcomeUsageMessageActivityRequest
} from '../renderer/src/lib/welcomeUsageDashboard'
import type {
  MessageActivityAggregate,
  MessageActivityProvider,
  MessageActivityRequest
} from '../shared/messageActivityAggregate'
import type { UsageRecord, WorkspaceRecord } from './store/types'

export interface RemoteWelcomeDashboard {
  favoriteModel: string
  favoriteProject: string
  tokens24h: number
  currentStreak: number
  longestStreak: number
  activeDays: number
  longestThreadMs: number
  totalWallTimeMs: number
  /** Pre-formatted by the aggregator ("2 PM" / "n/a"). */
  peakHour: string
  sessions: number
  messages: number
  totalTokens: number
  totalCostUsd: number
  avgSessionMs: number
  tokensPerSession: number
  wallTime24hMs: number
  comparisonText: string
  hasActivity: boolean
  lifetimeHasActivity: boolean
  providerTokenTotals: Array<{ provider: string; tokens: number }>
  modelBreakdown: Array<{
    id: string
    provider: string
    label: string
    /** CSS/theme hue class — `provider-<id>`, or the spoofed Ollama brand
     * class (e.g. `provider-alibaba`) so the phone's Model Comparisons rows
     * wear the same per-brand hue as the desktop. */
    colorClass: string
    inputTokens: number
    outputTokens: number
    percent: number
  }>
  workspaceBreakdown: Array<{
    id: string
    displayName: string
    tokens: number
    costUsd: number
    shareOfTotalTokens: number
  }>
  dailyBreakdown: Array<{ id: string; dayLabel: string; tokens: number; costUsd: number }>
  providerBreakdown: Array<{
    provider: string
    displayName: string
    tokens: number
    costUsd: number
    shareOfTotalTokens: number
  }>
}

/** The remote dashboard always shows the renderer's default 30-day window. */
export const REMOTE_WELCOME_DASHBOARD_RANGE = '30d' as const

/** The request the remote dashboard sends its message-activity provider. */
export const remoteWelcomeDashboardActivityRequest = (
  now: number,
  statResetAt: number
): MessageActivityRequest =>
  welcomeUsageMessageActivityRequest(REMOTE_WELCOME_DASHBOARD_RANGE, now, statResetAt)

/**
 * Run the renderer aggregator over the main-side usage records, the chat-side
 * message-activity aggregate and the workspace list, and flatten it for the
 * bridge. `now`/`statResetAt` mirror the renderer's call (App.tsx) — 30-day
 * range, all-history when `statResetAt` is 0. `activity` must answer
 * `remoteWelcomeDashboardActivityRequest(now, statResetAt)`; no chat record is
 * read here.
 */
export function buildRemoteWelcomeDashboard(
  records: UsageRecord[],
  activity: MessageActivityAggregate,
  workspaces: Pick<WorkspaceRecord, 'id' | 'displayName'>[],
  now: number,
  statResetAt: number
): RemoteWelcomeDashboard {
  const d = buildWelcomeUsageDashboardDataFromActivity(
    records,
    activity,
    REMOTE_WELCOME_DASHBOARD_RANGE,
    now,
    workspaces,
    statResetAt
  )
  // Force every Swift-`Int` field to a finite integer at the boundary: Swift's
  // JSONDecoder rejects an Int decoded from a fractional JSON number, which fails
  // the whole (strict) decode and silently hides the card. UsageRecord token /
  // duration sums are typed `number`, not integer-guaranteed, so round here.
  const int = (n: number): number => (Number.isFinite(n) ? Math.round(n) : 0)
  return {
    favoriteModel: d.favoriteModel,
    favoriteProject: d.favoriteProject,
    tokens24h: int(d.tokens24h),
    currentStreak: int(d.currentStreak),
    longestStreak: int(d.longestStreak),
    activeDays: int(d.activeDays),
    longestThreadMs: int(d.longestThreadMs),
    totalWallTimeMs: int(d.totalWallTimeMs),
    peakHour: d.peakHour,
    sessions: int(d.sessions),
    messages: int(d.messages),
    totalTokens: int(d.totalTokens),
    totalCostUsd: d.totalCostUsd,
    avgSessionMs: int(d.avgSessionMs),
    tokensPerSession: int(d.tokensPerSession),
    wallTime24hMs: int(d.wallTime24hMs),
    comparisonText: d.comparisonText,
    hasActivity: d.hasActivity,
    lifetimeHasActivity: d.lifetimeHasActivity,
    // Record<ProviderId, number> -> array, ribbon-relevant (>0) only.
    providerTokenTotals: Object.entries(d.providerTokenTotals)
      .map(([provider, tokens]) => ({ provider, tokens: int(Number(tokens)) }))
      .filter((entry) => entry.tokens > 0),
    modelBreakdown: d.modelBreakdown.map((m) => ({
      id: m.id,
      provider: m.provider,
      label: m.label,
      colorClass: m.colorClass,
      inputTokens: int(m.inputTokens),
      outputTokens: int(m.outputTokens),
      percent: m.percent
    })),
    workspaceBreakdown: d.workspaceCostBreakdown.map((w) => ({
      id: w.workspaceId,
      displayName: w.displayName,
      tokens: int(w.tokens),
      costUsd: w.costUsd,
      shareOfTotalTokens: w.shareOfTotalTokens
    })),
    dailyBreakdown: d.dailyCostBreakdown.map((b) => ({
      id: b.dayKey,
      dayLabel: b.dayLabel,
      tokens: int(b.tokens),
      costUsd: b.costUsd
    })),
    providerBreakdown: d.providerCostBreakdown.map((p) => ({
      provider: p.provider,
      displayName: p.displayName,
      tokens: int(p.tokens),
      costUsd: p.costUsd,
      shareOfTotalTokens: p.shareOfTotalTokens
    }))
  }
}

// — Throttled wrapper —
// The dashboard rides the usage-rollup broadcast (a 45s prewarm + per-device
// establish + a 2h interval + on-usage-change), but the aggregation plus its
// store reads (activity/workspaces/settings) are far heavier than the sibling
// rollup work. Rebuild only when the record set changes or the cache is >5 min
// stale (so time-relative stats like the rolling 24h window stay fresh);
// otherwise return the cached projection so newly-paired devices still receive
// it cheaply on establish. The activity provider is asynchronous (the thread
// catalogue answers from a worker), so a rebuild that is already awaiting its
// aggregate serves every caller that arrives meanwhile instead of stacking a
// query per trigger.
const DASHBOARD_REBUILD_MIN_INTERVAL_MS = 5 * 60_000

export interface RemoteWelcomeDashboardDeps {
  getMessageActivity: MessageActivityProvider
  getWorkspaces: () => Pick<WorkspaceRecord, 'id' | 'displayName'>[]
  getStatResetAt: () => number
}

export interface RemoteWelcomeDashboardThrottle {
  build(
    records: UsageRecord[],
    now: number,
    deps: RemoteWelcomeDashboardDeps
  ): Promise<RemoteWelcomeDashboard>
}

export function createRemoteWelcomeDashboardThrottle(
  minIntervalMs = DASHBOARD_REBUILD_MIN_INTERVAL_MS
): RemoteWelcomeDashboardThrottle {
  let cachedDashboard: RemoteWelcomeDashboard | null = null
  let cachedSignature = ''
  let cachedAtMs = 0
  let inFlight: { signature: string; promise: Promise<RemoteWelcomeDashboard> } | null = null
  let latestBuild = 0
  return {
    async build(records, now, deps) {
      // Usage records are append-only, so length is a reliable change signal — and
      // it avoids the store reads + full aggregation on an unchanged, fresh cache.
      const signature = String(records.length)
      if (cachedDashboard && signature === cachedSignature && now - cachedAtMs < minIntervalMs) {
        return cachedDashboard
      }
      if (inFlight && inFlight.signature === signature) return inFlight.promise
      const build = ++latestBuild
      const promise = (async () => {
        const statResetAt = deps.getStatResetAt()
        const activity = await deps.getMessageActivity(
          remoteWelcomeDashboardActivityRequest(now, statResetAt)
        )
        const dashboard = buildRemoteWelcomeDashboard(
          records,
          activity,
          deps.getWorkspaces(),
          now,
          statResetAt
        )
        // A build started later may already have answered; never let an older
        // aggregate overwrite it.
        if (build === latestBuild) {
          cachedDashboard = dashboard
          cachedSignature = signature
          cachedAtMs = now
        }
        return dashboard
      })()
      inFlight = { signature, promise }
      try {
        return await promise
      } finally {
        if (inFlight?.promise === promise) inFlight = null
      }
    }
  }
}

const sharedThrottle = createRemoteWelcomeDashboardThrottle()

export function buildRemoteWelcomeDashboardThrottled(
  records: UsageRecord[],
  now: number,
  deps: RemoteWelcomeDashboardDeps
): Promise<RemoteWelcomeDashboard> {
  return sharedThrottle.build(records, now, deps)
}
