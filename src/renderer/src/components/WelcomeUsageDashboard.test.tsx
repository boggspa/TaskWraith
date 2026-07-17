import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { UsageRecord } from '../../../main/store/types'
import { buildWelcomeUsageDashboardData } from '../lib/welcomeUsageDashboard'
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
})
