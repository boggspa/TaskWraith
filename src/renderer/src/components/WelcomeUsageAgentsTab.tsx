import { useEffect, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'
import type { PooledAgentStatsSummary } from '../../../main/store/types'
import {
  listPooledAgents,
  pooledIconColor,
  subscribeEnsembleAgentPool,
  type PooledAgent
} from '../lib/ensembleAgentPool'
import { rankAgentPoolLeaderboard } from '../lib/agentPoolLeaderboard'
import { getProviderLabel } from '../lib/providerLabels'
import { formatCompactUsageNumber, formatDashboardDuration } from '../lib/welcomeUsageDashboard'
import { PooledAgentIcon } from './icons/PooledAgentIcon'

/**
 * Welcome-dashboard "Agents" tab. Re-dresses the Settings → Agent pool
 * leaderboard in the dashboard chrome: a hero row (the #1 agent's identity
 * chip on the left, its headline stats on the right) above a scrollable
 * leaderboard chip. The Settings variant keeps its dense Model-Usage table
 * styling — only the ranking (lib/agentPoolLeaderboard.ts) is shared, so the
 * two surfaces always agree about the standings.
 *
 * Data is self-contained (pool from localStorage, stats over async IPC) so
 * both dashboard mount sites (MainAppLayout + multiview ChatViewPane) pick
 * the tab up without any new prop threading.
 */

function providerModelLabel(agent: PooledAgent): string {
  const provider = getProviderLabel(agent.config.provider)
  const model = agent.config.model && agent.config.model !== 'cli-default' ? agent.config.model : ''
  return model ? `${provider} · ${model}` : provider
}

function championAccent(agent: PooledAgent): string {
  const identity = agent.identity
  const hasUserTone =
    (typeof identity.saturation === 'number' && Number.isFinite(identity.saturation)) ||
    (typeof identity.brightness === 'number' && Number.isFinite(identity.brightness))
  return pooledIconColor(
    hasUserTone ? identity.accent : undefined,
    identity.hue,
    identity.hueEnabled,
    identity.brightness,
    identity.saturation
  )
}

function finiteStat(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

function formatCount(value: number): string {
  return value > 0 ? value.toLocaleString() : '-'
}

function formatWorkTime(ms: number): string {
  return ms > 0 ? formatDashboardDuration(ms) : '-'
}

export function WelcomeUsageAgentsTabView({
  agents,
  stats
}: {
  agents: PooledAgent[]
  stats: Record<string, PooledAgentStatsSummary>
}): JSX.Element {
  const rows = rankAgentPoolLeaderboard(agents, stats)
  const champion = rows[0] && (rows[0].stats?.runs ?? 0) > 0 ? rows[0] : null
  const poolTokens = rows.reduce((sum, row) => sum + finiteStat(row.stats?.tokensTotal), 0)

  if (agents.length === 0) {
    return (
      <div className="welcome-usage-agents">
        <div className="welcome-usage-empty">
          No pool agents yet. Save a participant to the Agent pool (Settings → Agent pool) and it
          will compete here.
        </div>
      </div>
    )
  }
  if (!champion) {
    return (
      <div className="welcome-usage-agents">
        <div className="welcome-usage-empty">
          No pool-linked runs yet. Run a preset that uses an Agent Pool agent; completed turns will
          rank here with runs, tokens, tools, and work time.
        </div>
      </div>
    )
  }

  const championStats = champion.stats
  const championThreads = finiteStat(championStats?.distinctChats)
  const championSessions = finiteStat(championStats?.distinctSessions)
  const championRounds = finiteStat(championStats?.distinctEnsembleRounds)
  const heroCells: Array<{ label: string; value: string; title?: string }> = [
    { label: 'Runs', value: formatCount(finiteStat(championStats?.runs)) },
    {
      label: 'Threads / sessions',
      value: championThreads > 0 ? `${championThreads} / ${championSessions || 0}` : '-',
      title:
        championThreads > 0
          ? `${championThreads.toLocaleString()} threads · ${championSessions.toLocaleString()} sessions${
              championRounds > 0 ? ` · ${championRounds.toLocaleString()} rounds` : ''
            }`
          : undefined
    },
    {
      label: 'Tokens',
      value:
        finiteStat(championStats?.tokensTotal) > 0
          ? formatCompactUsageNumber(championStats?.tokensTotal ?? 0)
          : '-',
      title:
        finiteStat(championStats?.tokensTotal) > 0
          ? `${(championStats?.tokensTotal ?? 0).toLocaleString()} tokens`
          : undefined
    },
    {
      label: 'Tool calls',
      value: formatCount(finiteStat(championStats?.toolCalls)),
      title:
        finiteStat(championStats?.writeToolCalls) > 0
          ? `${(championStats?.writeToolCalls ?? 0).toLocaleString()} write/edit calls`
          : undefined
    },
    { label: 'Work time', value: formatWorkTime(finiteStat(championStats?.durationMs)) }
  ]

  return (
    <div className="welcome-usage-agents">
      <div className="welcome-usage-agents-hero">
        <div
          className="welcome-usage-agents-champion"
          style={
            { '--agents-champion-accent': championAccent(champion.agent) } as React.CSSProperties
          }
          title={`${champion.agent.identity.nickname} · ${providerModelLabel(champion.agent)}`}
        >
          <PooledAgentIcon agent={champion.agent} size={40} />
          <div className="welcome-usage-agents-champion-text">
            <span className="welcome-usage-agents-champion-kicker">
              <span className="welcome-usage-agents-champion-rank">#1</span>
              Top agent
            </span>
            <span className="welcome-usage-agents-champion-name">
              {champion.agent.identity.nickname}
            </span>
            <span className="welcome-usage-agents-champion-meta">
              {providerModelLabel(champion.agent)}
            </span>
          </div>
        </div>
        <div className="welcome-usage-agents-champion-stats" aria-label="Top agent statistics">
          {heroCells.map((cell) => (
            <div key={cell.label} className="welcome-usage-agents-stat-cell" title={cell.title}>
              <strong>{cell.value}</strong>
              <span>{cell.label}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="welcome-usage-agents-list" role="list" aria-label="Agent pool leaderboard">
        {rows.map((row, index) => {
          const summary = row.stats
          const runs = finiteStat(summary?.runs)
          const tokens = finiteStat(summary?.tokensTotal)
          const toolCalls = finiteStat(summary?.toolCalls)
          const durationMs = finiteStat(summary?.durationMs)
          const share = poolTokens > 0 && tokens > 0 ? (tokens / poolTokens) * 100 : 0
          const rowTitle = `${row.agent.identity.nickname} · ${providerModelLabel(row.agent)}${
            runs > 0
              ? ` · ${runs.toLocaleString()} runs · ${tokens.toLocaleString()} tokens · ${toolCalls.toLocaleString()} tool calls · ${formatWorkTime(durationMs)}`
              : ' · no pool-linked runs yet'
          }`
          return (
            <div
              key={row.agent.agentId}
              role="listitem"
              className={`welcome-usage-agents-row${runs > 0 ? '' : ' is-idle'}`}
              title={rowTitle}
            >
              <span className="welcome-usage-agents-row-rank">{runs > 0 ? index + 1 : '-'}</span>
              <PooledAgentIcon
                agent={row.agent}
                size={20}
                className="welcome-usage-agents-row-icon"
              />
              <span className="welcome-usage-agents-row-id">
                <span className="welcome-usage-agents-row-name">{row.agent.identity.nickname}</span>
                <span className="welcome-usage-agents-row-meta">
                  {providerModelLabel(row.agent)}
                </span>
              </span>
              <span className="welcome-usage-agents-row-stat">
                {runs > 0 ? `${runs.toLocaleString()} runs` : '-'}
              </span>
              <span className="welcome-usage-agents-row-stat">
                {tokens > 0 ? `${formatCompactUsageNumber(tokens)} tok` : '-'}
              </span>
              <span className="welcome-usage-agents-row-stat">
                {toolCalls > 0 ? `${formatCompactUsageNumber(toolCalls)} tools` : '-'}
              </span>
              <span className="welcome-usage-agents-row-stat">{formatWorkTime(durationMs)}</span>
              {share > 0 && (
                <span
                  className="welcome-usage-agents-row-meter"
                  style={{ width: `${Math.max(2, Math.min(100, share))}%` }}
                  aria-hidden
                />
              )}
            </div>
          )
        })}
      </div>

      <p className="welcome-usage-footnote">
        All-time Agent pool stats — forward-only from pool-linked runs, no historical backfill.
      </p>
    </div>
  )
}

export function WelcomeUsageAgentsTab(): JSX.Element {
  const [agents, setAgents] = useState<PooledAgent[]>(() => listPooledAgents())
  const [stats, setStats] = useState<Record<string, PooledAgentStatsSummary>>({})

  useEffect(() => {
    const refresh = (): void => setAgents(listPooledAgents())
    refresh()
    return subscribeEnsembleAgentPool(refresh)
  }, [])

  // Lazy per-id stats fetch, mirroring AgentPoolContainer: async-only IPC,
  // explicit id list (never an empty-means-all sweep), sequence-guarded so a
  // stale response can't clobber a newer one. Re-runs when the pool changes;
  // the tab unmounts on tab-switch, so each visit shows fresh standings.
  const agentIdsKey = useMemo(() => agents.map((a) => a.agentId).join(','), [agents])
  const fetchSeqRef = useRef(0)
  useEffect(() => {
    const ids = agentIdsKey ? agentIdsKey.split(',') : []
    if (ids.length === 0) {
      setStats({})
      return
    }
    const api = window.api as unknown as {
      getAgentStatsSummaries?: (ids: string[]) => Promise<PooledAgentStatsSummary[]>
    }
    if (typeof api?.getAgentStatsSummaries !== 'function') return
    const seq = (fetchSeqRef.current += 1)
    void api
      .getAgentStatsSummaries(ids)
      .then((summaries) => {
        if (seq !== fetchSeqRef.current) return
        const next: Record<string, PooledAgentStatsSummary> = {}
        for (const summary of summaries) next[summary.agentId] = summary
        setStats(next)
      })
      .catch(() => {
        /* stats are best-effort; a fetch miss keeps the tab's empty state */
      })
  }, [agentIdsKey])

  return <WelcomeUsageAgentsTabView agents={agents} stats={stats} />
}
