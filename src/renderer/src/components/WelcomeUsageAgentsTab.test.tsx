import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { PooledAgentStatsSummary } from '../../../main/store/types'
import type { PooledAgent } from '../lib/ensembleAgentPool'
import { WelcomeUsageAgentsTabView } from './WelcomeUsageAgentsTab'

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

describe('WelcomeUsageAgentsTabView', () => {
  it('renders an empty state when the pool has no agents', () => {
    const html = renderToStaticMarkup(<WelcomeUsageAgentsTabView agents={[]} stats={{}} />)

    expect(html).toContain('welcome-usage-agents')
    expect(html).toContain('No pool agents yet')
  })

  it('renders an empty state when no pool agent has attributed runs', () => {
    const html = renderToStaticMarkup(
      <WelcomeUsageAgentsTabView agents={[makeAgent()]} stats={{}} />
    )

    expect(html).toContain('No pool-linked runs yet')
  })

  it('renders the #1 hero chips and ranked rows in dashboard chrome', () => {
    const champion = makeAgent({
      agentId: 'pooled-agent-champion',
      identity: { nickname: 'General', iconKind: 'seed', seed: 'a', hue: 260 },
      config: { provider: 'codex', model: 'gpt-5.5', role: 'General', instructions: '' }
    })
    const runnerUp = makeAgent({
      agentId: 'pooled-agent-runner',
      identity: { nickname: 'Captain', iconKind: 'seed', seed: 'b', hue: 30 },
      config: { provider: 'claude', role: 'Captain', instructions: '' }
    })
    const idle = makeAgent({
      agentId: 'pooled-agent-idle',
      identity: { nickname: 'King', iconKind: 'seed', seed: 'c', hue: 90 },
      config: { provider: 'claude', role: 'King', instructions: '' }
    })
    const html = renderToStaticMarkup(
      <WelcomeUsageAgentsTabView
        agents={[idle, runnerUp, champion]}
        stats={{
          [champion.agentId]: makeStats({ agentId: champion.agentId }),
          [runnerUp.agentId]: makeStats({
            agentId: runnerUp.agentId,
            runs: 2,
            tokensTotal: 5_000,
            durationMs: 60_000,
            toolCalls: 3
          })
        }}
      />
    )

    // Hero: champion identity chip + its stat strip.
    expect(html).toContain('welcome-usage-agents-champion')
    expect(html).toContain('Top agent')
    expect(html).toContain('#1')
    expect(html).toContain('General')
    expect(html).toContain('Codex · gpt-5.5')
    expect(html).toContain('42.0k tok')
    expect(html).toContain('3 / 2')
    expect(html).toContain('12m')

    // Leaderboard chip: champion ranks above the runner-up; the idle agent
    // renders unranked and dimmed at the bottom.
    expect(html).toContain('welcome-usage-agents-list')
    expect(html.indexOf('General')).toBeLessThan(html.indexOf('Captain'))
    expect(html.indexOf('Captain')).toBeLessThan(html.indexOf('King'))
    expect(html).toContain('is-idle')
    expect(html).toContain('4 runs')
    expect(html).toContain('welcome-usage-agents-row-meter')
    expect(html).toContain('All-time Agent pool stats')
  })
})
