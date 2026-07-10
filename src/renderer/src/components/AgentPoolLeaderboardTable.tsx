import type { JSX } from 'react'
import type { PooledAgentStatsSummary } from '../../../main/store/types'
import { getProviderLabel } from '../lib/providerLabels'
import { type PooledAgent } from '../lib/ensembleAgentPool'
import { rankAgentPoolLeaderboard } from '../lib/agentPoolLeaderboard'
import { formatTokenCount } from '../lib/UsageHeatmap'
import { PooledAgentIcon } from './icons/PooledAgentIcon'
import './ModelUsageSettingsTable.css'
import './AgentPoolLeaderboardTable.css'

type AgentPoolLeaderboardStats = PooledAgentStatsSummary & {
  toolCalls?: number
  writeToolCalls?: number
  editToolCalls?: number
  distinctSessions?: number
  distinctRounds?: number
  distinctEnsembleRounds?: number
  ensembleStageRoles?: unknown
  ensembleRoles?: unknown
  ensembleLaneIntents?: unknown
  stageRoleCounts?: unknown
  ensembleStageRoleCounts?: unknown
  fanoutRoles?: unknown
}

interface AgentPoolLeaderboardTableProps {
  agents: PooledAgent[]
  stats: Record<string, PooledAgentStatsSummary>
}

type LeaderboardRow = {
  agent: PooledAgent
  stats?: AgentPoolLeaderboardStats
  score: number
}

function numberField(stats: AgentPoolLeaderboardStats | undefined, key: keyof AgentPoolLeaderboardStats): number {
  const value = stats?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function formatInteger(value: number): string {
  return value > 0 ? value.toLocaleString() : '-'
}

function formatTokens(value: number): string {
  return value > 0 ? `${formatTokenCount(value)} tok` : '-'
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '-'
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours}h`
  const days = Math.round(hours / 24)
  return `${days}d`
}

function formatLastActive(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '-'
  return new Date(ms).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: new Date(ms).getFullYear() === new Date().getFullYear() ? undefined : 'numeric'
  })
}

function providerModel(agent: PooledAgent): string {
  const provider = getProviderLabel(agent.config.provider)
  const model = agent.config.model && agent.config.model !== 'cli-default' ? agent.config.model : ''
  return model ? `${provider} / ${model}` : provider
}

function titleCase(value: string): string {
  return value
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (match) => match.toUpperCase())
}

function collectRoleValues(source: unknown, bucket: Map<string, number>): void {
  if (!source) return
  if (typeof source === 'string') {
    const key = titleCase(source)
    bucket.set(key, (bucket.get(key) ?? 0) + 1)
    return
  }
  if (Array.isArray(source)) {
    for (const item of source) collectRoleValues(item, bucket)
    return
  }
  if (typeof source === 'object') {
    const breakdown = source as { key?: unknown; count?: unknown }
    if (typeof breakdown.key === 'string') {
      const key = titleCase(breakdown.key)
      const count =
        typeof breakdown.count === 'number' && Number.isFinite(breakdown.count)
          ? breakdown.count
          : 1
      if (count > 0) bucket.set(key, (bucket.get(key) ?? 0) + count)
      return
    }
    for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
      const label = titleCase(key)
      const count = typeof value === 'number' && Number.isFinite(value) ? value : value ? 1 : 0
      if (count > 0) bucket.set(label, (bucket.get(label) ?? 0) + count)
    }
  }
}

function formatRoleSummary(stats: AgentPoolLeaderboardStats | undefined): string {
  if (!stats) return '-'
  const roles = new Map<string, number>()
  collectRoleValues(stats.ensembleStageRoleCounts, roles)
  collectRoleValues(stats.stageRoleCounts, roles)
  collectRoleValues(stats.ensembleStageRoles, roles)
  collectRoleValues(stats.ensembleRoles, roles)
  collectRoleValues(stats.ensembleLaneIntents, roles)
  collectRoleValues(stats.fanoutRoles, roles)
  const ordered = [...roles.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  if (ordered.length === 0) return '-'
  const shown = ordered.slice(0, 2).map(([role, count]) => {
    return count > 1 ? `${role} x${count}` : role
  })
  return ordered.length > shown.length ? `${shown.join(', ')} +${ordered.length - shown.length}` : shown.join(', ')
}

function editsTitle(stats: AgentPoolLeaderboardStats | undefined): string | undefined {
  if (!stats) return undefined
  const parts = [
    `${stats.linesAdded.toLocaleString()} lines added`,
    `${stats.linesRemoved.toLocaleString()} lines removed`,
    `${stats.filesTouched.toLocaleString()} files touched`
  ]
  if (stats.runsWithDiffUnavailable > 0) {
    parts.push(`${stats.runsWithDiffUnavailable.toLocaleString()} run${stats.runsWithDiffUnavailable === 1 ? '' : 's'} without diff data`)
  }
  return parts.join(' / ')
}

function buildRows(
  agents: PooledAgent[],
  stats: Record<string, PooledAgentStatsSummary>
): LeaderboardRow[] {
  // Ranking (score + tiebreak) is shared with the dashboard's Agents tab —
  // see lib/agentPoolLeaderboard.ts. This table only re-brands the row type
  // to its wider stats view.
  return rankAgentPoolLeaderboard(agents, stats).map((row) => ({
    agent: row.agent,
    stats: row.stats as AgentPoolLeaderboardStats | undefined,
    score: row.score
  }))
}

function scopeCell(stats: AgentPoolLeaderboardStats | undefined): string {
  if (!stats) return '-'
  const sessions = numberField(stats, 'distinctSessions')
  const rounds = numberField(stats, 'distinctRounds') || numberField(stats, 'distinctEnsembleRounds')
  const parts = [`${stats.distinctChats.toLocaleString()} thd`]
  if (sessions > 0) parts.push(`${sessions.toLocaleString()} sess`)
  if (rounds > 0) parts.push(`${rounds.toLocaleString()} rnd`)
  return parts.join(' / ')
}

export function AgentPoolLeaderboardTable({
  agents,
  stats
}: AgentPoolLeaderboardTableProps): JSX.Element {
  const rows = buildRows(agents, stats)
  const hasActivity = rows.some((row) => row.stats && row.stats.runs > 0)
  const totals = rows.reduce(
    (acc, row) => {
      const summary = row.stats
      if (!summary) return acc
      acc.runs += summary.runs
      acc.tokens += summary.tokensTotal
      acc.durationMs += summary.durationMs
      acc.toolCalls += numberField(summary, 'toolCalls')
      acc.writeToolCalls += numberField(summary, 'writeToolCalls') || numberField(summary, 'editToolCalls')
      acc.linesAdded += summary.linesAdded
      acc.linesRemoved += summary.linesRemoved
      acc.filesTouched += summary.filesTouched
      acc.diffUnavailable += summary.runsWithDiffUnavailable
      return acc
    },
    {
      runs: 0,
      tokens: 0,
      durationMs: 0,
      toolCalls: 0,
      writeToolCalls: 0,
      linesAdded: 0,
      linesRemoved: 0,
      filesTouched: 0,
      diffUnavailable: 0
    }
  )

  return (
    <section className="model-usage-table-section agent-pool-leaderboard" aria-label="Agent pool leaderboard">
      <div className="model-usage-table-header">
        <div className="model-usage-table-heading">
          <span className="model-usage-table-title">Agent leaderboard</span>
          <span className="model-usage-table-subtitle">
            Pool-attributed runs, threads, tokens, edits, tools, stage roles, and work time
          </span>
        </div>
      </div>

      {hasActivity ? (
        <>
          <div className="model-usage-table-scroll">
            <table className="model-usage-table model-usage-table--agent-leaderboard">
              <colgroup>
                <col className="model-usage-table-rank-col" />
                <col className="model-usage-table-name-col" />
                <col className="model-usage-table-metric-col" />
                <col className="model-usage-table-metric-col" />
                <col className="model-usage-table-metric-col" />
                <col className="model-usage-table-metric-col" />
                <col className="model-usage-table-metric-col" />
                <col className="model-usage-table-metric-col" />
                <col className="model-usage-table-metric-col" />
                <col className="model-usage-table-metric-col" />
              </colgroup>
              <thead>
                <tr>
                  <th scope="col" className="model-usage-table-corner agent-pool-leaderboard-rank-head">
                    #
                  </th>
                  <th scope="col" className="model-usage-table-corner">
                    Agent
                  </th>
                  <th scope="col">Runs</th>
                  <th scope="col">Threads / sessions</th>
                  <th scope="col">Tokens</th>
                  <th scope="col">Tool calls</th>
                  <th scope="col">Edits</th>
                  <th scope="col">Work time</th>
                  <th scope="col">Stage / role</th>
                  <th scope="col">Last active</th>
                </tr>
              </thead>
              <tbody className="model-usage-table-provider agent-pool-leaderboard-body">
                {rows.map((row, index) => {
                  const summary = row.stats
                  const writeCalls = numberField(summary, 'writeToolCalls') || numberField(summary, 'editToolCalls')
                  const toolCalls = numberField(summary, 'toolCalls')
                  const changedLines = (summary?.linesAdded ?? 0) + (summary?.linesRemoved ?? 0)
                  return (
                    <tr key={row.agent.agentId} className="model-usage-table-model-row agent-pool-leaderboard-row">
                      <td className="agent-pool-leaderboard-rank">
                        {summary && summary.runs > 0 ? index + 1 : '-'}
                      </td>
                      <th scope="row" className="model-usage-table-model-cell agent-pool-leaderboard-agent-cell">
                        <span className="agent-pool-leaderboard-agent">
                          <PooledAgentIcon agent={row.agent} size={22} />
                          <span className="agent-pool-leaderboard-agent-text">
                            <span className="agent-pool-leaderboard-agent-name">
                              {row.agent.identity.nickname}
                            </span>
                            <span className="agent-pool-leaderboard-agent-meta">
                              {providerModel(row.agent)}
                            </span>
                          </span>
                        </span>
                      </th>
                      <td className="model-usage-table-tokens">{formatInteger(summary?.runs ?? 0)}</td>
                      <td className="model-usage-table-tokens">{scopeCell(summary)}</td>
                      <td className="model-usage-table-tokens">{formatTokens(summary?.tokensTotal ?? 0)}</td>
                      <td
                        className="model-usage-table-tokens"
                        title={writeCalls > 0 ? `${writeCalls.toLocaleString()} write/edit calls` : undefined}
                      >
                        {toolCalls > 0 ? `${toolCalls.toLocaleString()} (${writeCalls.toLocaleString()} edit)` : '-'}
                      </td>
                      <td className="model-usage-table-tokens" title={editsTitle(summary)}>
                        {changedLines > 0
                          ? `+${formatTokenCount(summary?.linesAdded ?? 0)} / -${formatTokenCount(summary?.linesRemoved ?? 0)}`
                          : summary?.filesTouched
                            ? `${summary.filesTouched.toLocaleString()} files`
                            : '-'}
                      </td>
                      <td className="model-usage-table-tokens">{formatDuration(summary?.durationMs ?? 0)}</td>
                      <td className="model-usage-table-tokens agent-pool-leaderboard-role-cell">
                        {formatRoleSummary(summary)}
                      </td>
                      <td className="model-usage-table-tokens">{formatLastActive(summary?.lastRunAt ?? 0)}</td>
                    </tr>
                  )
                })}
              </tbody>
              <tfoot className="model-usage-table-totals">
                <tr className="model-usage-table-totals-row">
                  <th scope="row" className="model-usage-table-totals-label" colSpan={2}>
                    Totals
                  </th>
                  <td className="model-usage-table-tokens">{formatInteger(totals.runs)}</td>
                  <td className="model-usage-table-tokens">-</td>
                  <td className="model-usage-table-tokens">{formatTokens(totals.tokens)}</td>
                  <td className="model-usage-table-tokens">
                    {totals.toolCalls > 0
                      ? `${totals.toolCalls.toLocaleString()} (${totals.writeToolCalls.toLocaleString()} edit)`
                      : '-'}
                  </td>
                  <td className="model-usage-table-tokens">
                    {totals.linesAdded + totals.linesRemoved > 0
                      ? `+${formatTokenCount(totals.linesAdded)} / -${formatTokenCount(totals.linesRemoved)}`
                      : totals.filesTouched > 0
                        ? `${totals.filesTouched.toLocaleString()} files`
                        : '-'}
                  </td>
                  <td className="model-usage-table-tokens">{formatDuration(totals.durationMs)}</td>
                  <td className="model-usage-table-tokens">-</td>
                  <td className="model-usage-table-tokens">-</td>
                </tr>
              </tfoot>
            </table>
          </div>
          <p className="model-usage-table-footnote">
            Agent stats are forward-only from pool-linked runs; there is no historical backfill.
            Diff edit totals only include runs with captured diffs
            {totals.diffUnavailable > 0
              ? ` (${totals.diffUnavailable.toLocaleString()} run${totals.diffUnavailable === 1 ? '' : 's'} without diff data).`
              : '.'}
          </p>
        </>
      ) : (
        <div className="model-usage-table-empty" role="note">
          <strong>No leaderboard data yet</strong>
          <span>
            Run a preset that uses an Agent Pool agent; completed pool-linked turns will appear here
            with tokens, threads, edits, tools, and work time.
          </span>
        </div>
      )}
    </section>
  )
}
