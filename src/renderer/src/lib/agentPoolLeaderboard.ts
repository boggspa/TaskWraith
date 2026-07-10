import type { PooledAgentStatsSummary } from '../../../main/store/types'
import type { PooledAgent } from './ensembleAgentPool'

/**
 * Shared Agent-pool leaderboard ranking. Two surfaces render the same
 * standings — Settings → Agent pool (dense Model-Usage table chrome) and the
 * welcome dashboard's "Agents" tab (hero chips + card list) — so the score
 * lives here, not in either component, and the two can never disagree about
 * who is #1.
 */
export interface AgentPoolLeaderboardRow {
  agent: PooledAgent
  stats?: PooledAgentStatsSummary
  score: number
}

function finiteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/**
 * Composite activity score: tokens dominate, with work time, runs, and tool
 * calls as secondary weight so a chatty-but-cheap agent still ranks above a
 * never-used one. Zero for agents with no attributed stats yet.
 */
export function agentPoolLeaderboardScore(stats: PooledAgentStatsSummary | undefined): number {
  if (!stats) return 0
  return (
    finiteNumber(stats.tokensTotal) +
    finiteNumber(stats.durationMs) / 1000 +
    finiteNumber(stats.runs) * 100 +
    finiteNumber(stats.toolCalls) * 25
  )
}

/** Rank pool agents DESC by score, nickname as the stable tiebreaker. */
export function rankAgentPoolLeaderboard(
  agents: PooledAgent[],
  stats: Record<string, PooledAgentStatsSummary>
): AgentPoolLeaderboardRow[] {
  return agents
    .map((agent) => {
      const summary = stats[agent.agentId]
      return { agent, stats: summary, score: agentPoolLeaderboardScore(summary) }
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      return a.agent.identity.nickname.localeCompare(b.agent.identity.nickname)
    })
}
