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
  return {
    favoriteModel: d.favoriteModel,
    favoriteProject: d.favoriteProject,
    tokens24h: d.tokens24h,
    currentStreak: d.currentStreak,
    longestStreak: d.longestStreak,
    activeDays: d.activeDays,
    longestThreadMs: d.longestThreadMs,
    totalWallTimeMs: d.totalWallTimeMs,
    peakHour: d.peakHour,
    sessions: d.sessions,
    messages: d.messages,
    totalTokens: d.totalTokens,
    totalCostUsd: d.totalCostUsd,
    avgSessionMs: d.avgSessionMs,
    tokensPerSession: d.tokensPerSession,
    wallTime24hMs: d.wallTime24hMs,
    comparisonText: d.comparisonText,
    hasActivity: d.hasActivity,
    lifetimeHasActivity: d.lifetimeHasActivity,
    // Record<ProviderId, number> -> array, ribbon-relevant (>0) only.
    providerTokenTotals: Object.entries(d.providerTokenTotals)
      .map(([provider, tokens]) => ({ provider, tokens: Number(tokens) || 0 }))
      .filter((entry) => entry.tokens > 0),
    modelBreakdown: d.modelBreakdown.map((m) => ({
      id: m.id,
      provider: m.provider,
      label: m.label,
      inputTokens: m.inputTokens,
      outputTokens: m.outputTokens,
      percent: m.percent
    })),
    workspaceBreakdown: d.workspaceCostBreakdown.map((w) => ({
      id: w.workspaceId,
      displayName: w.displayName,
      tokens: w.tokens,
      costUsd: w.costUsd,
      shareOfTotalTokens: w.shareOfTotalTokens
    })),
    dailyBreakdown: d.dailyCostBreakdown.map((b) => ({
      id: b.dayKey,
      dayLabel: b.dayLabel,
      tokens: b.tokens,
      costUsd: b.costUsd
    })),
    providerBreakdown: d.providerCostBreakdown.map((p) => ({
      provider: p.provider,
      displayName: p.displayName,
      tokens: p.tokens,
      costUsd: p.costUsd,
      shareOfTotalTokens: p.shareOfTotalTokens
    }))
  }
}
