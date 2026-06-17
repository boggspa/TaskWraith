// WelcomeDashboardRemote.ts — projects the renderer's welcome-dashboard
// aggregator (`buildWelcomeUsageDashboardData`) into the flat, iOS-friendly shape
// the phone decodes (Swift `WelcomeDashboard`). Isolating the cross-tree import
// here (the aggregator lives under src/renderer/src/lib but is pure Node-safe TS:
// its only non-type import is `modelDisplayName`, also pure) keeps the seam in one
// place and lets the mapper be unit-tested without the Electron app.

import { buildWelcomeUsageDashboardData } from '../renderer/src/lib/welcomeUsageDashboard'
import type { UsageRecord, ChatRecord, WorkspaceRecord } from './store/types'

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

/**
 * Run the renderer aggregator over the main-side record/chat/workspace stores and
 * flatten it for the bridge. `now`/`statResetAt` mirror the renderer's call
 * (App.tsx) — 30-day range, all-history when `statResetAt` is 0.
 */
export function buildRemoteWelcomeDashboard(
  records: UsageRecord[],
  chats: ChatRecord[],
  workspaces: Pick<WorkspaceRecord, 'id' | 'displayName'>[],
  now: number,
  statResetAt: number
): RemoteWelcomeDashboard {
  const d = buildWelcomeUsageDashboardData(records, chats, '30d', now, workspaces, statResetAt)
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
// The dashboard rides the usage-rollup broadcast (a 4s prewarm + per-device
// establish + a 2h interval + on-usage-change), but the aggregation plus its three
// store reads (chats/workspaces/settings) are far heavier than the sibling rollup
// work. Rebuild only when the record set changes or the cache is >5 min stale (so
// time-relative stats like the rolling 24h window stay fresh); otherwise return the
// cached projection so newly-paired devices still receive it cheaply on establish.
let cachedDashboard: RemoteWelcomeDashboard | null = null
let cachedSignature = ''
let cachedAtMs = 0
const DASHBOARD_REBUILD_MIN_INTERVAL_MS = 5 * 60_000

export function buildRemoteWelcomeDashboardThrottled(
  records: UsageRecord[],
  now: number,
  deps: {
    getChats: () => ChatRecord[]
    getWorkspaces: () => Pick<WorkspaceRecord, 'id' | 'displayName'>[]
    getStatResetAt: () => number
  }
): RemoteWelcomeDashboard {
  // Usage records are append-only, so length is a reliable change signal — and it
  // avoids the three store reads + full aggregation on an unchanged, fresh cache.
  const signature = String(records.length)
  if (
    cachedDashboard &&
    signature === cachedSignature &&
    now - cachedAtMs < DASHBOARD_REBUILD_MIN_INTERVAL_MS
  ) {
    return cachedDashboard
  }
  cachedDashboard = buildRemoteWelcomeDashboard(
    records,
    deps.getChats(),
    deps.getWorkspaces(),
    now,
    deps.getStatResetAt()
  )
  cachedSignature = signature
  cachedAtMs = now
  return cachedDashboard
}
