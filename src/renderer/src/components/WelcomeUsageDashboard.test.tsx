import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ProviderId, UsageRecord } from '../../../main/store/types'
import {
  WELCOME_USAGE_PROVIDER_IDS,
  buildWelcomeUsageDashboardData
} from '../lib/welcomeUsageDashboard'
import { nextWelcomeUsageTab, WelcomeUsageDashboard } from './WelcomeUsageDashboard'

describe('WelcomeUsageDashboard model comparisons', () => {
  it('keeps dashboard meter-card chrome isolated from the Settings table', () => {
    const now = Date.parse('2026-07-11T03:30:00.000Z')
    const record: UsageRecord = {
      id: 'usage-1',
      timestamp: now - 60_000,
      workspaceId: 'workspace-1',
      chatId: 'chat-1',
      runId: 'run-1',
      usageKind: 'run',
      provider: 'codex',
      model: 'gpt-5.5',
      inputTokens: 900,
      outputTokens: 100,
      totalTokens: 1000,
      durationMs: 1000
    }
    const data = buildWelcomeUsageDashboardData([record], [], '30d', now)
    const html = renderToStaticMarkup(
      <WelcomeUsageDashboard
        data={data}
        initialTab="models"
        autoCycleSeconds={0}
      />
    )

    expect(html).toContain('welcome-usage-model-meters')
    expect(html).toContain('welcome-usage-model-meter provider-codex')
    expect(html).not.toContain('model-usage-table--comparisons')
    expect(html).not.toContain('settings-model-comparisons')
  })

  it('advances locally through only the visible tabs', () => {
    const visible = ['overview', 'models', 'agents'] as const

    expect(nextWelcomeUsageTab('overview', [...visible])).toBe('models')
    expect(nextWelcomeUsageTab('models', [...visible])).toBe('agents')
    expect(nextWelcomeUsageTab('agents', [...visible])).toBe('overview')
    expect(nextWelcomeUsageTab('providers', [...visible])).toBe('overview')
  })

  it('renders all ten stable provider identities in reporting cards and mix segments', () => {
    const now = Date.parse('2026-07-11T03:30:00.000Z')
    const record = (provider: ProviderId, index: number): UsageRecord => ({
      id: `usage-${provider}`,
      timestamp: now - index * 1000,
      workspaceId: 'workspace-1',
      chatId: `chat-${provider}`,
      runId: `run-${provider}`,
      usageKind: 'run',
      provider,
      model: `${provider}-model`,
      inputTokens: 90,
      outputTokens: 10,
      totalTokens: 100,
      durationMs: 1000
    })
    const data = buildWelcomeUsageDashboardData(
      WELCOME_USAGE_PROVIDER_IDS.map(record),
      [],
      '30d',
      now
    )
    const overviewHtml = renderToStaticMarkup(
      <WelcomeUsageDashboard data={data} initialTab="overview" autoCycleSeconds={0} />
    )
    const providersHtml = renderToStaticMarkup(
      <WelcomeUsageDashboard data={data} initialTab="providers" autoCycleSeconds={0} />
    )

    for (const provider of WELCOME_USAGE_PROVIDER_IDS) {
      expect(overviewHtml).toContain(
        `welcome-usage-provider-ribbon-seg provider-${provider}`
      )
      expect(providersHtml).toContain(`welcome-usage-provider-card provider-${provider}`)
    }
    expect(providersHtml.match(/role="listitem"/g)).toHaveLength(10)
    expect(providersHtml).toContain('AntiGravity')
    expect(providersHtml).toContain('Pi')
    expect(providersHtml).toContain('Mistral')
    expect(providersHtml).toContain('Gemini')
  })
})
