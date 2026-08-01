import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ProviderId, UsageRecord } from '../../../main/store/types'
import { OLLAMA_DISPLAY_BRANDS } from '../lib/ollamaDisplayBrand'
import {
  WELCOME_USAGE_PROVIDER_IDS,
  buildWelcomeUsageDashboardData
} from '../lib/welcomeUsageDashboard'
import { PI_UPSTREAM_BRANDS } from '../../../shared/piBrandTable'
import { nextWelcomeUsageTab, WelcomeUsageDashboard } from './WelcomeUsageDashboard'

const modelComparisonCss = readFileSync(
  new URL('../assets/css/03-composer-welcome-activity.css', import.meta.url),
  'utf8'
)

const modelComparisonHueClasses = [
  'antigravity',
  'pi',
  'mistral',
  ...OLLAMA_DISPLAY_BRANDS.map((brand) => brand.providerClass),
  ...Object.values(PI_UPSTREAM_BRANDS).map((brand) => brand.hueClass)
]

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

  it.each([...new Set(modelComparisonHueClasses)])(
    '%s paints its model-comparison dot and meter fill with its provider hue',
    (hueClass) => {
      // Pi and Ollama model entries resolve to their upstream brand class in
      // the dashboard data. Pin the CSS triplet too, so a new class cannot
      // silently inherit the default blue dot / near-white fill.
      expect(modelComparisonCss).toMatch(
        new RegExp(
          `\\.welcome-usage-model-dot\\.provider-${hueClass},\\s*` +
            `\\.welcome-usage-model-meter-fill\\.provider-${hueClass},\\s*` +
            `\\.welcome-usage-bar-segment\\.provider-${hueClass}\\s*` +
            `\\{\\s*color: var\\(--provider-${hueClass}-color\\);\\s*\\}`
        )
      )
    }
  )

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
