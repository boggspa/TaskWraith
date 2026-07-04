import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { PooledAgentStatsSummary } from '../../../main/store/types'
import type { PooledAgent } from '../lib/ensembleAgentPool'
import { AgentPoolLeaderboardTable } from './AgentPoolLeaderboardTable'

function makeAgent(overrides: Partial<PooledAgent> = {}): PooledAgent {
  return {
    agentId: 'pooled-agent-test',
    createdAt: 1,
    updatedAt: 2,
    schemaVersion: 1,
    identity: {
      nickname: 'Scout Prime',
      iconKind: 'seed',
      seed: 'pooled-agent-test',
      hue: 210
    },
    config: {
      provider: 'codex',
      role: 'Scout',
      instructions: 'Investigate.'
    },
    ...overrides
  }
}

function makeStats(overrides: Partial<PooledAgentStatsSummary> = {}): PooledAgentStatsSummary {
  return {
    agentId: 'pooled-agent-test',
    runs: 4,
    success: 3,
    failed: 1,
    cancelled: 0,
    tokensIn: 30_000,
    tokensOut: 12_000,
    tokensTotal: 42_000,
    costUsd: 0,
    durationMs: 12 * 60 * 1000,
    linesAdded: 120,
    linesRemoved: 35,
    filesTouched: 6,
    toolCalls: 9,
    writeToolCalls: 2,
    distinctChats: 3,
    distinctSessions: 2,
    distinctEnsembleRounds: 2,
    ensembleRoles: [{ key: 'Scout', count: 2 }],
    ensembleStageRoles: [{ key: 'scout', count: 2 }],
    ensembleLaneIntents: [{ key: 'read', count: 2 }],
    runsWithDiffUnavailable: 1,
    lastRunAt: new Date('2026-07-05T12:00:00.000Z').getTime(),
    ...overrides
  }
}

describe('AgentPoolLeaderboardTable', () => {
  it('renders an empty state when no pool agent has attributed runs', () => {
    const html = renderToStaticMarkup(<AgentPoolLeaderboardTable agents={[makeAgent()]} stats={{}} />)

    expect(html).toContain('Agent leaderboard')
    expect(html).toContain('No leaderboard data yet')
  })

  it('renders ranked agent usage rows using the Model Usage table chrome', () => {
    const agent = makeAgent()
    const html = renderToStaticMarkup(
      <AgentPoolLeaderboardTable
        agents={[agent]}
        stats={{ [agent.agentId]: makeStats() }}
      />
    )

    expect(html).toContain('model-usage-table-section')
    expect(html).toContain('model-usage-table--agent-leaderboard')
    expect(html).toContain('Scout Prime')
    expect(html).toContain('42K tok')
    expect(html).toContain('9 (2 edit)')
    expect(html).toContain('Scout x4')
  })
})
