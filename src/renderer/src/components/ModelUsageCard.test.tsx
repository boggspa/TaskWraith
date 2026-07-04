import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  ApiSpendProviderBlock,
  CompactModelUsageGrid,
  ModelUsageCard,
  type ModelUsageApiSpendOptions
} from './ModelUsageCard'
import type { ModelUsageAggregate } from '../lib/usageAggregateTypes'
import { buildApiSpendByProvider } from '../lib/apiSpendAggregation'
import type { RendererProviderRates } from '../lib/providerRateEstimate'
import type { UsageRecord } from '../../../main/store/types'
import { parseGrokUsage } from '../../../main/grok/GrokUsage'

function quotaEntry(overrides: Partial<ModelUsageAggregate> = {}): ModelUsageAggregate {
  return {
    provider: 'kimi',
    model: 'usage limits',
    runs: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    durationMs: 0,
    quotaStale: true,
    quotaError: 'Kimi usage fetch failed.',
    windows: [
      {
        id: 'kimi-5h',
        label: '5H',
        runs: 0,
        totalTokens: 0,
        limitLabel: '200 / 200 remaining',
        trackingOnly: false,
        usedPercent: 0,
        remainingPercent: 100
      },
      {
        id: 'kimi-weekly',
        label: 'Weekly',
        runs: 0,
        totalTokens: 0,
        limitLabel: '2000 / 2000 remaining',
        trackingOnly: false,
        usedPercent: 0,
        remainingPercent: 100
      }
    ],
    ...overrides
  }
}

describe('ModelUsageCard', () => {
  it('renders cached zero-usage quota windows instead of dropping the provider', () => {
    const html = renderToStaticMarkup(<ModelUsageCard usageSummary={[quotaEntry()]} />)

    expect(html).toContain('Kimi')
    expect(html).toContain('5H')
    expect(html).toContain('Weekly')
    expect(html).toContain('0%')
    expect(html).toContain('200 / 200 remaining')
    expect(html).toContain('2000 / 2000 remaining')
  })

  it('renders the existing four providers and does NOT add a Grok meter when Grok is unavailable', () => {
    // Regression for 1.0.6-GU: the gated Grok subscription-credit meter
    // must not leak into the card. Under SSR the availability effect never
    // runs, so `grokAvailable` stays false and the meter is absent — exactly
    // the gate-off behaviour. The four token/quota meters render unchanged.
    const summary = [
      quotaEntry({ provider: 'gemini' }),
      quotaEntry({ provider: 'codex' }),
      quotaEntry({ provider: 'claude' }),
      quotaEntry({ provider: 'kimi' })
    ]
    const html = renderToStaticMarkup(<ModelUsageCard usageSummary={summary} />)

    expect(html).toContain('Gemini')
    expect(html).toContain('Codex')
    expect(html).toContain('Claude')
    expect(html).toContain('Kimi')
    // Grok credits meter stays out unless the gated adapter is registered.
    expect(html).not.toContain('Subscription credits')
  })

  it('renders the sidebar resize grip band when expanded', () => {
    const html = renderToStaticMarkup(
      <ModelUsageCard usageSummary={[quotaEntry()]} variant="sidebar" />
    )

    expect(html).toContain('model-usage-resize-handle')
    expect(html).toContain('model-usage-resize-grip')
  })

  it('omits the 30-day activity heatmap from the sidebar overlay only', () => {
    const sidebarHtml = renderToStaticMarkup(
      <ModelUsageCard usageSummary={[quotaEntry()]} variant="sidebar" />
    )
    const cardHtml = renderToStaticMarkup(<ModelUsageCard usageSummary={[quotaEntry()]} />)

    expect(sidebarHtml).not.toContain('usage-heatmap')
    expect(cardHtml).toContain('usage-heatmap')
  })

  it('does NOT render the view toggle when apiSpend is omitted', () => {
    const html = renderToStaticMarkup(
      <ModelUsageCard usageSummary={[quotaEntry()]} variant="sidebar" />
    )
    expect(html).not.toContain('model-usage-view-toggle')
    expect(html).not.toContain('aria-label="API spend"')
  })

  it('renders three toggle glyphs (no text labels) when apiSpend is wired', () => {
    const apiSpend: ModelUsageApiSpendOptions = { providerRates: {}, view: 'plan' }
    const html = renderToStaticMarkup(
      <ModelUsageCard usageSummary={[quotaEntry()]} variant="sidebar" apiSpend={apiSpend} />
    )
    // Toggle group + all three accessible labels present (icons, not text).
    expect(html).toContain('model-usage-view-toggle')
    expect(html).toContain('aria-label="Plan limits"')
    expect(html).toContain('aria-label="API spend"')
    expect(html).toContain('aria-label="Context lengths"')
    // Plan view is active by default; the quota meters still render.
    expect(html).toContain('Kimi')
    expect(html).toContain('200 / 200 remaining')
  })

  it('renders the sidebar provider usage refresh control when wired', () => {
    const apiSpend: ModelUsageApiSpendOptions = {
      providerRates: {},
      view: 'plan',
      onRefreshUsage: () => undefined
    }
    const html = renderToStaticMarkup(
      <ModelUsageCard usageSummary={[quotaEntry()]} variant="sidebar" apiSpend={apiSpend} />
    )

    expect(html).toContain('model-usage-refresh-button')
    expect(html).toContain('aria-label="Refresh usage data"')
    expect(html).toContain('title="Refresh usage data"')
  })

  it('marks the sidebar provider usage refresh control busy while refreshing', () => {
    const apiSpend: ModelUsageApiSpendOptions = {
      providerRates: {},
      view: 'plan',
      onRefreshUsage: () => undefined,
      refreshing: true
    }
    const html = renderToStaticMarkup(
      <ModelUsageCard usageSummary={[quotaEntry()]} variant="sidebar" apiSpend={apiSpend} />
    )

    expect(html).toContain('model-usage-refresh-button is-refreshing')
    expect(html).toContain('disabled=""')
  })

  it('marks the API-spend radio active and shows the empty state under SSR when view=spend', () => {
    // Under renderToStaticMarkup, the getUsage effect does NOT fire, so View B
    // resolves to its honest empty state. We assert the toggle reflects the
    // persisted selection and the spend body (not the quota meters) renders.
    const apiSpend: ModelUsageApiSpendOptions = { providerRates: {}, view: 'spend' }
    const html = renderToStaticMarkup(
      <ModelUsageCard usageSummary={[quotaEntry()]} variant="sidebar" apiSpend={apiSpend} />
    )
    expect(html).toContain('aria-checked="true"')
    expect(html).toContain('No API spend tracked in the last 30 days')
    // Quota meter rows are hidden while the spend view is active.
    expect(html).not.toContain('200 / 200 remaining')
  })

  it('renders the context-lengths table when view=context (static data, no IPC)', () => {
    const apiSpend: ModelUsageApiSpendOptions = { providerRates: {}, view: 'context' }
    const html = renderToStaticMarkup(
      <ModelUsageCard usageSummary={[quotaEntry()]} variant="sidebar" apiSpend={apiSpend} />
    )
    // Context radio is active.
    expect(html).toContain('aria-checked="true"')
    // Context table container.
    expect(html).toContain('model-usage-context-list')
    // A known 1M context window should appear in the table.
    expect(html).toContain('1.0M')
    // Sidebar variant includes local Ollama models but omits Gemini.
    expect(html).toContain('Ollama')
    expect(html).not.toContain('Gemini')
    // Quota meter rows are hidden while the context view is active.
    expect(html).not.toContain('200 / 200 remaining')
  })

  it('shows a spend/context toggle (no Plan tab) when there are no quota meters but apiSpend is wired', () => {
    const rates: RendererProviderRates = {
      codex: [{ modelId: 'gpt-5.5', inputUsdPerMillion: 1, outputUsdPerMillion: 10 }]
    }
    const apiSpend: ModelUsageApiSpendOptions = { providerRates: rates, view: 'plan' }
    // No quota entries at all → spend + context views are available in the sidebar.
    // The toggle shows spend ⇄ context, but no Plan tab (no quota meters).
    const html = renderToStaticMarkup(
      <ModelUsageCard usageSummary={[]} variant="sidebar" apiSpend={apiSpend} />
    )
    expect(html).toContain('Model Usage')
    expect(html).toContain('model-usage-view-toggle')
    expect(html).toContain('aria-label="API spend"')
    expect(html).toContain('aria-label="Context lengths"')
    expect(html).not.toContain('aria-label="Plan limits"')
    // spend is the active view by default (plan unavailable, spend is first fallback)
    expect(html).toContain('No API spend tracked in the last 30 days')
  })

  it('renders a compact collapsed quota grid with provider-specific slot mapping', () => {
    const summary: ModelUsageAggregate[] = [
      quotaEntry({
        provider: 'codex',
        windows: [
          {
            id: 'codex-5h',
            label: '5h',
            runs: 0,
            totalTokens: 0,
            limitLabel: '78% remaining',
            usedPercent: 22
          },
          {
            id: 'codex-weekly',
            label: 'Weekly',
            runs: 0,
            totalTokens: 0,
            limitLabel: '24% remaining',
            usedPercent: 76
          },
          {
            id: 'spark-5h',
            label: 'GPT-5.3-Codex-Spark 5h',
            runs: 0,
            totalTokens: 0,
            limitLabel: '100% remaining',
            usedPercent: 0
          },
          {
            id: 'spark-weekly',
            label: 'GPT-5.3-Codex-Spark Weekly',
            runs: 0,
            totalTokens: 0,
            limitLabel: '21% remaining',
            usedPercent: 79
          }
        ]
      }),
      quotaEntry({
        provider: 'claude',
        windows: [
          {
            id: 'claude-session',
            label: 'Session',
            runs: 0,
            totalTokens: 0,
            limitLabel: '100% remaining',
            usedPercent: 0
          },
          {
            id: 'claude-weekly',
            label: 'Weekly',
            runs: 0,
            totalTokens: 0,
            limitLabel: '2% remaining',
            usedPercent: 98
          },
          {
            id: 'claude-fable',
            label: 'Fable',
            runs: 0,
            totalTokens: 0,
            limitLabel: '0% remaining',
            usedPercent: 100
          }
        ]
      }),
      quotaEntry({
        provider: 'kimi',
        windows: [
          {
            id: 'kimi-5h',
            label: '5H',
            runs: 0,
            totalTokens: 0,
            limitLabel: '31 / 100 remaining',
            usedPercent: 69
          },
          {
            id: 'kimi-weekly',
            label: 'Weekly',
            runs: 0,
            totalTokens: 0,
            limitLabel: '30 / 100 remaining',
            usedPercent: 70
          }
        ]
      }),
      quotaEntry({
        provider: 'cursor',
        windows: [
          {
            id: 'cursor-included',
            label: 'Included in Pro',
            runs: 0,
            totalTokens: 0,
            limitLabel: 'This cycle',
            usedPercent: 13
          },
          {
            id: 'cursor-auto',
            label: 'Auto + Composer',
            runs: 0,
            totalTokens: 0,
            limitLabel: 'This cycle',
            usedPercent: 0
          },
          {
            id: 'cursor-api',
            label: 'API',
            runs: 0,
            totalTokens: 0,
            limitLabel: 'This cycle',
            usedPercent: 100
          }
        ]
      })
    ]
    const html = renderToStaticMarkup(
      <CompactModelUsageGrid
        quotaEntries={summary}
        grokUsage={{
          snapshot: parseGrokUsage('Weekly limit: 5%', '2026-07-04T12:00:00.000Z'),
          loading: false,
          errored: false,
          stale: false
        }}
      />
    )

    expect(html).toContain('model-usage-compact-grid')
    expect(html).toContain('>5H</th>')
    expect(html).toContain('>WK</th>')
    expect(html).toContain('>X1</th>')
    expect(html).toContain('>X2</th>')
    expect(html).toContain('Codex GPT-5.3-Codex-Spark 5h: 0%')
    expect(html).toContain('Codex GPT-5.3-Codex-Spark Weekly: 79%')
    expect(html).toContain('Claude Fable: 100%')
    expect(html).toContain('Kimi 5H: 69%')
    expect(html).toContain('Kimi Weekly: 70%')
    expect(html).toContain('Cursor Included in Pro: 13%')
    expect(html).toContain('Cursor Auto + Composer: 0%')
    expect(html).toContain('Grok Weekly limit: 5%')
    expect(html).not.toContain('Cursor API: 100%')
    expect(html).toContain('provider-claude is-danger')
    expect(html).toContain('provider-grok')
  })
})

describe('ApiSpendProviderBlock (View B populated render)', () => {
  it('renders the provider heading + Day/7d/30d rows with tokens and currency', () => {
    const now = new Date('2026-06-13T12:00:00.000Z').getTime()
    const rates: RendererProviderRates = {
      codex: [{ modelId: 'gpt-5.5', inputUsdPerMillion: 1, outputUsdPerMillion: 10 }]
    }
    const records: UsageRecord[] = [
      {
        id: 'r1',
        provider: 'codex',
        model: 'gpt-5.5',
        timestamp: now - 60_000,
        workspaceId: 'ws',
        chatId: 'c',
        runId: 'run',
        inputTokens: 2_000_000,
        outputTokens: 500_000,
        totalTokens: 2_500_000,
        durationMs: 0
      }
    ]
    const [entry] = buildApiSpendByProvider(records, rates, { currency: 'USD' }, now)
    const html = renderToStaticMarkup(<ApiSpendProviderBlock entry={entry} />)

    expect(html).toContain('Codex')
    // All three window labels present.
    expect(html).toContain('Day')
    expect(html).toContain('7d')
    expect(html).toContain('30d')
    // Token chip (compact) + projected cost in USD ($2 in + $5 out = $7.00).
    expect(html).toContain('tok')
    expect(html).toContain('$7.00')
  })
})
