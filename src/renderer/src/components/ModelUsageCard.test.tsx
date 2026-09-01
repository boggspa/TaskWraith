import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  API_SPEND_RENDER_ORDER,
  ApiSpendProviderBlock,
  COMPACT_USAGE_PROVIDER_LABELS,
  CompactModelUsageGrid,
  EXPANDED_USAGE_PROVIDER_ORDER,
  ModelUsageCard,
  orderExpandedQuotaWindows,
  orderExpandedUsageProviders,
  type ModelUsageApiSpendOptions
} from './ModelUsageCard'
import { API_SPEND_PROVIDER_ORDER } from '../lib/apiSpendAggregation'
import type { ModelUsageAggregate } from '../lib/usageAggregateTypes'
import {
  buildApiSpendByProvider,
  buildProviderCalendarMonthSpend
} from '../lib/apiSpendAggregation'
import type { RendererProviderRates } from '../lib/providerRateEstimate'
import type { UsageRecord } from '../../../main/store/types'
import { parseGrokUsage } from '../../../main/grok/GrokUsage'
import {
  accumulate,
  applyAnchor,
  estimateQuota,
  startCycle
} from '../../../main/mistral/MistralQuotaEstimate'
import type { MistralQuotaSnapshot } from '../../../main/mistral/MistralQuotaStore'
import { formatResetShort } from '../lib/UsageFormat'

const MISTRAL_CYCLE_START = new Date('2026-07-01T00:00:00.000Z')

function mistralSnapshot(
  spentUsd: number,
  source: 'estimated' | 'mistral' = 'estimated',
  localAfterReadingUsd = 0
): MistralQuotaSnapshot {
  let cycle =
    source === 'mistral'
      ? applyAnchor(startCycle(MISTRAL_CYCLE_START), {
          allowanceUsd: 10,
          spentUsd,
          observedAt: MISTRAL_CYCLE_START.toISOString(),
          cycleResetsAt: '2026-08-01T00:00:00.000Z'
        })
      : accumulate(startCycle(MISTRAL_CYCLE_START), {
          costUsd: spentUsd,
          totalTokens: 200_000
        })
  if (source === 'mistral' && localAfterReadingUsd > 0) {
    cycle = accumulate(cycle, { costUsd: localAfterReadingUsd, totalTokens: 1_000 })
  }
  const plan = source === 'mistral' ? 'pro' : 'unknown'
  return {
    estimate: estimateQuota(cycle, plan, MISTRAL_CYCLE_START),
    plan,
    turns: cycle.turns,
    totalTokens: cycle.totalTokens
  }
}

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

  it('renders an observed provider plan as a tier badge', () => {
    const html = renderToStaticMarkup(
      <ModelUsageCard usageSummary={[quotaEntry({ provider: 'codex', planName: 'Pro' })]} />
    )

    expect(html).toContain('model-usage-tier-badge')
    expect(html).toContain('>Pro<')
  })

  it('prefixes Spark, Luna Reserve, and Fable meters with display-only glyphs', () => {
    const html = renderToStaticMarkup(
      <ModelUsageCard
        usageSummary={[
          quotaEntry({
            provider: 'codex',
            windows: [
              {
                id: 'primary-weekly',
                label: 'Weekly',
                runs: 0,
                totalTokens: 0,
                limitLabel: '79% remaining',
                usedPercent: 21
              },
              {
                id: 'additional-0-5h',
                label: 'Spark 5h',
                runs: 0,
                totalTokens: 0,
                limitLabel: '100% remaining',
                usedPercent: 0
              },
              {
                id: 'additional-0-weekly',
                label: 'Spark Weekly',
                runs: 0,
                totalTokens: 0,
                limitLabel: '3% remaining',
                usedPercent: 97
              },
              {
                id: 'additional-1-weekly',
                label: 'Luna Reserve Weekly',
                runs: 0,
                totalTokens: 0,
                limitLabel: '100% remaining',
                usedPercent: 0
              }
            ]
          }),
          quotaEntry({
            provider: 'claude',
            windows: [
              {
                id: 'claude-weekly-fable',
                label: 'Fable',
                runs: 0,
                totalTokens: 0,
                limitLabel: '42% remaining',
                usedPercent: 58
              }
            ]
          })
        ]}
      />
    )

    expect(html).toContain(
      '<span class="model-usage-window-glyph" aria-hidden="true">⚡ </span>Spark 5h'
    )
    expect(html).toContain(
      '<span class="model-usage-window-glyph" aria-hidden="true">⚡ </span>Spark Weekly'
    )
    expect(html).toContain(
      '<span class="model-usage-window-glyph" aria-hidden="true">🌙 </span>Luna Reserve Weekly'
    )
    expect(html).toContain(
      '<span class="model-usage-window-glyph" aria-hidden="true">🪶 </span>Fable'
    )
    // The plain aggregate row stays glyph-free — asserted as the exact
    // glyph-less label span, not a not.toContain that could pass vacuously.
    expect(html).toContain('<span class="model-usage-window-label">Weekly</span>')
    // Tooltips keep the clean label: no emoji leaks into title text.
    expect(html).toContain('title="Spark 5h: 100% remaining"')
  })

  it('moons a stale gpt-reserve label from a pre-rename cached snapshot', () => {
    const html = renderToStaticMarkup(
      <ModelUsageCard
        usageSummary={[
          quotaEntry({
            provider: 'codex',
            windows: [
              {
                id: 'additional-1-weekly',
                label: 'gpt-reserve Weekly',
                runs: 0,
                totalTokens: 0,
                limitLabel: '100% remaining',
                usedPercent: 0
              }
            ]
          })
        ]}
      />
    )

    expect(html).toContain(
      '<span class="model-usage-window-glyph" aria-hidden="true">🌙 </span>gpt-reserve Weekly'
    )
  })

  it('gives no Codex bolt to non-Codex spark-named windows', () => {
    // Muse's model literally ships as "Muse Spark 1.2" — the glyph rule is
    // provider-gated so that window must render as a plain label.
    const html = renderToStaticMarkup(
      <ModelUsageCard
        usageSummary={[
          quotaEntry({
            provider: 'muse',
            windows: [
              {
                id: 'muse-monthly',
                label: 'Spark 1.2 Monthly',
                runs: 0,
                totalTokens: 0,
                limitLabel: '90% remaining',
                usedPercent: 10
              }
            ]
          })
        ]}
      />
    )

    expect(html).toContain('<span class="model-usage-window-label">Spark 1.2 Monthly</span>')
    expect(html).not.toContain('model-usage-window-glyph')
  })

  it('fills API-credit meters up with credit used rather than down with credit remaining', () => {
    const html = renderToStaticMarkup(
      <ModelUsageCard
        usageSummary={[
          quotaEntry({
            provider: 'deepseek',
            planName: 'API Credits',
            windows: [
              {
                id: 'deepseek-credit',
                label: 'Credit used',
                runs: 0,
                totalTokens: 0,
                limitLabel: '$0.92 of $10.00',
                usedPercent: 9.2,
                remainingPercent: 90.8,
                valueText: '$0.92',
                unit: 'USD'
              }
            ]
          })
        ]}
      />
    )

    expect(html).toContain('DeepSeek')
    expect(html).toContain('>API Credits<')
    expect(html).toContain('Credit used')
    expect(html).toContain('>$0.92<')
    expect(html).toContain('$0.92 of $10.00')
    expect(html).toContain('width:9.20%')
    expect(html).not.toContain('width:90.80%')
    expect(html).toContain('data-provider-logo="deepseek"')
    expect(html).toContain('provider-logo-deepseek.png')
    expect(html).not.toContain('provider-glyph-deepseek')
  })

  it('orders the expanded provider stack independently from the compact grid', () => {
    const scrambled = [
      'meta',
      'ollama',
      'kimi',
      'deepseek',
      'codex',
      'mistral',
      'qwen',
      'mimo',
      'antigravity',
      'cerebras',
      'cursor',
      'grok',
      'claude'
    ] as const

    expect(orderExpandedUsageProviders(scrambled)).toEqual(
      EXPANDED_USAGE_PROVIDER_ORDER.slice(0, 13)
    )
  })

  it('puts 5H/session meters above weekly meters only in expanded quota blocks', () => {
    const sourceWindows = [
      {
        id: 'agy-gemini-weekly',
        label: 'Gemini Weekly',
        runs: 0,
        totalTokens: 0,
        limitLabel: '42% remaining',
        usedPercent: 58
      },
      {
        id: 'agy-gemini-extra',
        label: 'Gemini extra',
        runs: 0,
        totalTokens: 0,
        limitLabel: '80% remaining',
        usedPercent: 20
      },
      {
        id: 'agy-gemini-5h',
        label: 'Gemini 5H',
        runs: 0,
        totalTokens: 0,
        limitLabel: '100% remaining',
        usedPercent: 0
      }
    ]

    expect(
      orderExpandedQuotaWindows(sourceWindows).map((windowEntry) => windowEntry.label)
    ).toEqual(['Gemini 5H', 'Gemini Weekly', 'Gemini extra'])
    expect(sourceWindows.map((windowEntry) => windowEntry.label)).toEqual([
      'Gemini Weekly',
      'Gemini extra',
      'Gemini 5H'
    ])

    const html = renderToStaticMarkup(
      <ModelUsageCard
        usageSummary={[quotaEntry({ provider: 'antigravity', windows: sourceWindows })]}
      />
    )
    expect(html.indexOf('Gemini 5H')).toBeLessThan(html.indexOf('Gemini Weekly'))
  })

  it('shows a connected AntiGravity quota probe failure as unavailable without inventing a meter', () => {
    const html = renderToStaticMarkup(
      <ModelUsageCard
        usageSummary={[
          quotaEntry({
            provider: 'antigravity',
            windows: [],
            quotaConfigured: true,
            quotaError: 'Quota unavailable: official agy /usage timed out.'
          })
        ]}
      />
    )

    expect(html).toContain('Antigravity')
    expect(html).toContain('model-usage-quota-unavailable')
    expect(html).toContain('official agy /usage timed out')
    expect(html).not.toContain('200 / 200 remaining')
  })

  it('renders the four fixture providers and does NOT add a Grok meter when Grok is unavailable', () => {
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

  it('starts the sidebar model usage section collapsed', () => {
    const html = renderToStaticMarkup(
      <ModelUsageCard usageSummary={[quotaEntry()]} variant="sidebar" />
    )

    expect(html).toContain('model-usage-summary--sidebar is-collapsed')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('title="Expand provider usage"')
    expect(html).toContain('model-usage-compact-grid')
    expect(html).toContain('model-usage-liquid-card')
    expect(html).not.toContain('model-usage-resize-handle')
    expect(html).not.toContain('model-usage-resize-grip')
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
    // Full quota meter rows are hidden while the spend view is active.
    expect(html).not.toContain('model-usage-window-list')
  })

  it('keeps default Plan selected while its first availability check is unresolved', () => {
    const apiSpend: ModelUsageApiSpendOptions = {
      providerRates: {},
      view: 'plan',
      planAvailabilityPending: true
    }
    const html = renderToStaticMarkup(
      <ModelUsageCard usageSummary={[]} variant="sidebar" apiSpend={apiSpend} />
    )

    // ApiSpendView owns the getChatList effect. Keeping its body out of this
    // branch is what prevents the transient all-history startup fetch.
    expect(html).toMatch(/aria-checked="true"[^>]*aria-label="Plan limits"/)
    expect(html).toMatch(/aria-checked="false"[^>]*aria-label="API spend"/)
    expect(html).not.toContain('No API spend tracked in the last 30 days')
  })

  it('preserves an explicit Spend selection while Plan availability is unresolved', () => {
    const apiSpend: ModelUsageApiSpendOptions = {
      providerRates: {},
      view: 'spend',
      planAvailabilityPending: true
    }
    const html = renderToStaticMarkup(
      <ModelUsageCard usageSummary={[]} variant="sidebar" apiSpend={apiSpend} />
    )

    expect(html).toMatch(/aria-checked="true"[^>]*aria-label="API spend"/)
    expect(html).toContain('No API spend tracked in the last 30 days')
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
    // Sidebar variant includes local Ollama models.
    expect(html).toContain('Ollama')
    // AntiGravity is the BYO gemini-api lane, so its rows legitimately carry
    // Gemini-BRANDED MODEL names. Assert on the provider-group marker rather
    // than the bare string "Gemini", which conflates a retired PROVIDER coming
    // back with a live provider simply offering Gemini models.
    expect(html).toContain('provider-antigravity')
    // The RETIRED gemini provider group stays out (excludeProviders: ['gemini']).
    expect(html).not.toContain('provider-gemini')
    // Full quota meter rows are hidden while the context view is active.
    expect(html).not.toContain('model-usage-window-list')
  })

  it('shows a spend/context toggle (no Plan tab) when there are no quota meters but apiSpend is wired', () => {
    const rates: RendererProviderRates = {
      codex: [{ modelId: 'gpt-5.5', inputUsdPerMillion: 1, outputUsdPerMillion: 10 }]
    }
    const apiSpend: ModelUsageApiSpendOptions = {
      providerRates: rates,
      view: 'plan',
      planAvailabilityPending: false
    }
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
    expect(html).not.toContain('>Mistral</th>')
    expect(html).not.toContain('>MO</th>')
  })

  it('maps the Muse subscription meters onto the 5H/WK compact rows', () => {
    const museEntry = quotaEntry({
      provider: 'muse',
      quotaError: undefined,
      windows: [
        {
          id: 'muse-subscription-current',
          label: 'Current usage',
          runs: 0,
          totalTokens: 0,
          limitLabel: '63% remaining · imported browser session',
          usedPercent: 37,
          remainingPercent: 63
        },
        {
          id: 'muse-subscription-weekly',
          label: 'Weekly limit',
          runs: 0,
          totalTokens: 0,
          limitLabel: '18% remaining · imported browser session',
          usedPercent: 82,
          remainingPercent: 18,
          resetAt: '2026-09-07T00:00:00.000Z'
        }
      ]
    })
    const html = renderToStaticMarkup(<CompactModelUsageGrid quotaEntries={[museEntry]} />)

    expect(html).toContain('>Muse</th>')
    const currentIndex = html.indexOf('Muse Current usage: 37%')
    const weeklyIndex = html.indexOf('Muse Weekly limit: 82%')
    expect(currentIndex).toBeGreaterThan(html.indexOf('>5H</th>'))
    expect(currentIndex).toBeLessThan(html.indexOf('>WK</th>'))
    expect(weeklyIndex).toBeGreaterThan(html.indexOf('>WK</th>'))
    expect(weeklyIndex).toBeLessThan(html.indexOf('>X1</th>'))

    // No import, no column: the Muse lane is admitted on its entry alone.
    const withoutMuse = renderToStaticMarkup(<CompactModelUsageGrid quotaEntries={[]} />)
    expect(withoutMuse).not.toContain('>Muse</th>')
  })

  it('hides the row legend column when there are more than 8 providers', () => {
    const summary: ModelUsageAggregate[] = [
      quotaEntry({ provider: 'codex', windows: [] }),
      quotaEntry({ provider: 'claude', windows: [] }),
      quotaEntry({ provider: 'kimi', windows: [] }),
      quotaEntry({ provider: 'cursor', windows: [] }),
      // AGY is the one lane admitted on data-or-reason rather than on mere
      // presence, so `quotaConfigured` is load-bearing here: without it this
      // entry contributes NO column, the grid renders 8 and the legend the
      // assertions below deny stays on.
      quotaEntry({ provider: 'antigravity', windows: [], quotaConfigured: true }),
      quotaEntry({ provider: 'deepseek', windows: [] }),
      quotaEntry({ provider: 'cerebras', windows: [] }),
      quotaEntry({ provider: 'meta', windows: [] })
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
    // Asserted first, and by count: the legend hides at >8, so a fixture that
    // quietly renders only 8 columns fails every assertion below for a reason
    // that has nothing to do with the legend rule under test. Counts PROVIDER
    // headers, not every `<th scope="col">` — the corner cell rides the legend
    // it gates, so the bare total reads 9 whether the fixture produced 8
    // providers + corner or the 9 providers this test means.
    expect(html.split('<th scope="col" class="provider-').length - 1).toBe(9)
    expect(html).not.toContain('>5H</th>')
    expect(html).not.toContain('>WK</th>')
    expect(html).not.toContain('>X1</th>')
    expect(html).not.toContain('>X2</th>')
    expect(html).not.toContain('aria-label="Window"')

    // Providers are still rendered
    expect(html).toContain('Codex')
    expect(html).toContain('Claude')
    expect(html).toContain('Kimi')
    expect(html).toContain('Cursor')
    expect(html).toContain('Grok')
    // The compact strip labels this lane 'AGY', not 'AntiGravity' — the column
    // header is width-constrained (COMPACT_USAGE_PROVIDER_LABELS).
    expect(html).toContain('>AGY</th>')
    expect(html).toContain('DeepSeek')
    expect(html).toContain('Cerebras')
    expect(html).toContain('Meta')
  })

  it('shows the Mistral monthly estimate as a spend figure in the X1 slot, not a band or MO row', () => {
    const html = renderToStaticMarkup(
      <CompactModelUsageGrid
        quotaEntries={[]}
        mistralQuota={{ snapshot: mistralSnapshot(8), loading: false }}
      />
    )

    expect(html).toContain('>Mistral</th>')
    // No dedicated MO row: monthly rides the Extra X1 slot like Cursor.
    expect(html).not.toContain('>MO</th>')
    expect(html).toContain('>X1</th>')
    // A rough € figure, never the old qualitative "~NEAR" band. The cell value
    // is unhedged even for a local estimate — the ~ prefix pushed the column
    // into its neighbour; the tooltip and is-estimated styling carry the hedge.
    expect(html).toContain('>$8.00</td>')
    expect(html).not.toContain('>~$8.00</td>')
    expect(html).not.toContain('NEAR</td>')
    expect(html).toContain('provider-mistral is-warning is-estimated')
    expect(html).toContain('~$8.00 of ~$9.25')
    // cycleResetsAt is 1 Aug from a July start. formatResetShort switches to
    // same-day HH:MM when the wall clock is on that day (Aug 1), so derive the
    // expected label from the same formatter the view uses — never hardcode a
    // month-boundary date string that flips overnight.
    const snap = mistralSnapshot(8)
    const reset = formatResetShort({ resetAt: snap.estimate.cycleResetsAt })
    expect(reset).toBeTruthy()
    expect(html).toContain(`resets ${reset}`)
    expect(html).toContain('estimated locally')
    expect(html).not.toMatch(/>\d+%<\/td>/)
  })

  it('shows Pi upstream API-credit and PAYG meters alongside the existing Mistral meter', () => {
    const financialWindow = (
      id: string,
      label: string,
      valueText: string,
      limitLabel: string,
      usedPercent: number
    ) => ({
      id,
      label,
      runs: 0,
      totalTokens: 0,
      limitLabel,
      usedPercent,
      valueText,
      unit: label === 'This billing period' ? 'GBP' : 'USD'
    })
    const html = renderToStaticMarkup(
      <CompactModelUsageGrid
        quotaEntries={[
          quotaEntry({
            provider: 'deepseek',
            windows: [
              financialWindow('deepseek-credit', 'Credit used', '$0.92', '$0.92 of $10.00', 9.2)
            ]
          }),
          quotaEntry({
            provider: 'cerebras',
            windows: [
              financialWindow('cerebras-credit', 'Credit used', '$1.36', '$1.36 of $10.00', 13.6)
            ]
          })
        ]}
        mistralQuota={{ snapshot: mistralSnapshot(8), loading: false }}
      />
    )

    expect(html).toContain('>Mistral</th>')
    expect(html).toContain('>DeepSeek</th>')
    expect(html).toContain('>Cerebras</th>')
    expect(html).toContain('>$8.00</td>')
    expect(html).toContain('>$0.92</td>')
    expect(html).toContain('>$1.36</td>')
  })

  it('renders the compact Mistral figure in the display currency', () => {
    const html = renderToStaticMarkup(
      <CompactModelUsageGrid
        quotaEntries={[]}
        mistralQuota={{ snapshot: mistralSnapshot(8), loading: false }}
        currency="EUR"
        locale="en-GB"
      />
    )
    // $8 → €7.36 at 0.92; the cell and its tooltip both convert. Only the
    // tooltip hedges — the cell value stays bare so it fits its column.
    expect(html).toContain('>€7.36</td>')
    expect(html).toContain('~€7.36 of')
    expect(html).not.toContain('$8.00')
  })

  it('adds the AGY column only when an antigravity quota snapshot exists', () => {
    const withAgy = renderToStaticMarkup(
      <CompactModelUsageGrid
        quotaEntries={[
          quotaEntry({
            provider: 'antigravity',
            windows: [
              {
                id: 'agy-gemini-weekly',
                label: 'Gemini Weekly',
                runs: 0,
                totalTokens: 0,
                limitLabel: '42% remaining · refresh: in 91h 44m',
                usedPercent: 58
              },
              {
                id: 'agy-gemini-5h',
                label: 'Gemini 5H',
                runs: 0,
                totalTokens: 0,
                limitLabel: '100% remaining',
                usedPercent: 0
              },
              {
                id: 'agy-3p-weekly',
                label: '3P Weekly',
                runs: 0,
                totalTokens: 0,
                limitLabel: '5% remaining',
                usedPercent: 95
              },
              {
                id: 'agy-3p-5h',
                label: '3P 5H',
                runs: 0,
                totalTokens: 0,
                limitLabel: '100% remaining',
                usedPercent: 0
              }
            ]
          })
        ]}
      />
    )
    // The hook-backed pools land on 5H/WK plus X1/X2 by label/id predicate.
    expect(withAgy).toContain('>AGY</th>')
    expect(withAgy).toContain('Gemini Weekly')
    expect(withAgy).toContain('Gemini 5H')
    expect(withAgy).toContain('3P Weekly')
    expect(withAgy).toContain('3P 5H')

    const withoutAgy = renderToStaticMarkup(<CompactModelUsageGrid quotaEntries={[]} />)
    expect(withoutAgy).not.toContain('>AGY</th>')
  })

  it('maps AGY Gemini windows to 5H/WK and 3P windows to X1/X2', () => {
    const withAgy = renderToStaticMarkup(
      <CompactModelUsageGrid
        quotaEntries={[
          quotaEntry({
            provider: 'antigravity',
            windows: [
              {
                id: 'agy-gemini-5h',
                label: 'Gemini 5H',
                runs: 0,
                totalTokens: 0,
                limitLabel: '100% remaining',
                usedPercent: 0
              },
              {
                id: 'agy-gemini-weekly',
                label: 'Gemini Weekly',
                runs: 0,
                totalTokens: 0,
                limitLabel: '42% remaining',
                usedPercent: 58
              },
              {
                id: 'agy-3p-5h',
                label: '3P 5H',
                runs: 0,
                totalTokens: 0,
                limitLabel: '100% remaining',
                usedPercent: 0
              },
              {
                id: 'agy-3p-weekly',
                label: '3P Weekly',
                runs: 0,
                totalTokens: 0,
                limitLabel: '5% remaining',
                usedPercent: 95
              }
            ]
          })
        ]}
      />
    )

    expect(withAgy).toContain('>5H</th>')
    expect(withAgy).toContain('>WK</th>')
    expect(withAgy).toContain('>X1</th>')
    expect(withAgy).toContain('>X2</th>')
    expect(withAgy).toContain('Antigravity Gemini 5H')
    expect(withAgy).toContain('Antigravity Gemini Weekly')
    expect(withAgy).toContain('Antigravity 3P 5H')
    expect(withAgy).toContain('Antigravity 3P Weekly')
  })

  it('shows the AGY column with the reason when the lane is configured but has no windows', () => {
    // A caller-provided reason keeps an explicitly unavailable lane
    // distinguishable from a lane that simply has no hook entry.
    const html = renderToStaticMarkup(
      <CompactModelUsageGrid
        quotaEntries={[
          quotaEntry({
            provider: 'antigravity',
            windows: [],
            quotaConfigured: true,
            quotaError:
              'Quota unavailable: the agy /usage probe only ever runs on an explicit manual refresh.'
          })
        ]}
      />
    )

    expect(html).toContain('>AGY</th>')
    // The reason rides the cell tooltip, NOT the cell value: an empty cell must
    // never be mistakable for a reading.
    expect(html).toContain('explicit manual refresh')
    expect(html).not.toContain('AGY 5H: unavailable')
  })

  it('omits the AGY column for a lane with neither windows nor a reason', () => {
    // configured:false with no error is the not-opted-in shape. The ban-risk
    // lane does not exist then, so it must contribute no column at all.
    const html = renderToStaticMarkup(
      <CompactModelUsageGrid
        quotaEntries={[
          quotaEntry({ provider: 'antigravity', windows: [], quotaConfigured: false })
        ]}
      />
    )

    expect(html).not.toContain('>AGY</th>')
  })

  it('drops the compact Mistral estimate hedge for Mistral-sourced figures', () => {
    const html = renderToStaticMarkup(
      <CompactModelUsageGrid
        quotaEntries={[]}
        mistralQuota={{ snapshot: mistralSnapshot(8, 'mistral'), loading: false }}
      />
    )

    // Mistral-sourced (anchored/reported): even the tooltip drops its ~ hedge,
    // and the cell loses its is-estimated styling.
    expect(html).toContain('>$8.00</td>')
    expect(html).not.toContain('>~$8.00</td>')
    expect(html).toContain('$8.00 of $10.00')
    expect(html).not.toContain('~$8.00 of')
    expect(html).toContain('Mistral-sourced figures')
    expect(html).not.toContain('provider-mistral is-warning is-estimated')
  })

  it('shows a post-reading local increment instead of leaving the compact figure frozen', () => {
    const html = renderToStaticMarkup(
      <CompactModelUsageGrid
        quotaEntries={[]}
        mistralQuota={{ snapshot: mistralSnapshot(0.19, 'mistral', 0.004), loading: false }}
      />
    )

    expect(html).toContain('>$0.194</td>')
    expect(html).not.toContain('>~$0.194</td>')
    expect(html).toContain('+ ~$0.004 tracked locally since reading')
    expect(html).toContain('Mistral baseline + local estimate')
    expect(html).toContain('provider-mistral is-estimated')
  })

  it('truncates currency values >= 10 in compact window cells to one decimal', () => {
    const financialWindow = (
      id: string,
      label: string,
      valueText: string,
      limitLabel: string,
      usedPercent: number
    ) => ({
      id,
      label,
      runs: 0,
      totalTokens: 0,
      limitLabel,
      usedPercent,
      valueText,
      unit: label === 'This billing period' ? 'GBP' : 'USD'
    })
    const html = renderToStaticMarkup(
      <CompactModelUsageGrid
        quotaEntries={[
          quotaEntry({
            provider: 'deepseek',
            windows: [
              financialWindow('deepseek-credit', 'Credit used', '$13.51', '$13.51 of $20.00', 67.5)
            ]
          }),
          quotaEntry({
            provider: 'cerebras',
            windows: [
              financialWindow('cerebras-credit', 'Credit used', '£13.50', '£13.50 of £20.00', 67.5)
            ]
          }),
          quotaEntry({
            provider: 'meta',
            windows: [
              financialWindow('meta-credit', 'Credit used', '€10.99', '€10.99 of €20.00', 54.9)
            ]
          })
        ]}
      />
    )

    // Cell values truncated to 1 decimal (floor, not round)
    expect(html).toContain('>$13.5</td>')
    expect(html).toContain('>£13.5</td>')
    expect(html).toContain('>€10.9</td>')
    // Titles preserve full precision
    expect(html).toContain('DeepSeek Credit used: $13.51')
    expect(html).toContain('Cerebras Credit used: £13.50')
    expect(html).toContain('Meta API Credit used: €10.99')
  })

  it('keeps currency values < 10 at full precision in compact window cells', () => {
    const financialWindow = (
      id: string,
      label: string,
      valueText: string,
      limitLabel: string,
      usedPercent: number
    ) => ({
      id,
      label,
      runs: 0,
      totalTokens: 0,
      limitLabel,
      usedPercent,
      valueText,
      unit: 'USD'
    })
    const html = renderToStaticMarkup(
      <CompactModelUsageGrid
        quotaEntries={[
          quotaEntry({
            provider: 'deepseek',
            windows: [
              financialWindow('deepseek-credit', 'Credit used', '$9.99', '$9.99 of $20.00', 49.9)
            ]
          })
        ]}
      />
    )

    // Under 10 stays at full precision
    expect(html).toContain('>$9.99</td>')
    expect(html).toContain('DeepSeek Credit used: $9.99')
  })

  it('passes non-currency text through compactCurrencyCellValue unchanged', () => {
    const html = renderToStaticMarkup(
      <CompactModelUsageGrid
        quotaEntries={[
          quotaEntry({
            provider: 'kimi',
            windows: [
              {
                id: 'kimi-5h',
                label: '5H',
                runs: 0,
                totalTokens: 0,
                limitLabel: '31 / 100 remaining',
                usedPercent: 69,
                valueText: '69%' // non-currency: percent
              }
            ]
          })
        ]}
      />
    )

    // Percent text passes through unmodified
    expect(html).toContain('>69%</td>')
    expect(html).toContain('Kimi 5H: 69%')
  })

  it('truncates Mistral compact cell spend >= 10 to one decimal', () => {
    // $13.51 spend → cell should show $13.5, title keeps full $13.51
    const html = renderToStaticMarkup(
      <CompactModelUsageGrid
        quotaEntries={[]}
        mistralQuota={{ snapshot: mistralSnapshot(13.51, 'estimated', 0.13), loading: false }}
        // Pinned, because the cell runs through Intl.NumberFormat and an
        // omitted locale means the RUNNER'S locale: USD renders "$13.51" under
        // en-US but "US$13.51" under en-GB, so the prefix these assertions
        // carry is a property of the machine, not of the truncation. en-US is
        // also the only locale a small-ICU build is guaranteed to have.
        locale="en-US"
      />
    )

    // Cell value truncated to 1 decimal
    expect(html).toContain('>$13.5</td>')
    // Title preserves full precision (from formatMistralAccumulatedSpend)
    expect(html).toContain('~$13.51 of')
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
    // Token chip (compact) + projected cost in USD ($2 in + $5 out = $7.0).
    expect(html).toContain('tok')
    expect(html).toContain('$7.0')
  })
})

describe('AntiGravity budget meter (spend view)', () => {
  const rates: RendererProviderRates = {
    antigravity: [
      { modelId: 'gemini-api:gemini-2.5-flash', inputUsdPerMillion: 1, outputUsdPerMillion: 10 }
    ]
  }
  const now = new Date('2026-06-13T12:00:00.000Z').getTime()
  const records: UsageRecord[] = [
    {
      id: 'ag-1',
      workspaceId: 'ws-1',
      chatId: 'chat-1',
      runId: 'run-1',
      provider: 'antigravity',
      model: 'gemini-api:gemini-2.5-flash',
      inputTokens: 1_000_000,
      outputTokens: 0,
      totalTokens: 1_000_000,
      durationMs: 1000,
      timestamp: now - 60_000
    } as UsageRecord
  ]

  it('renders the capped meter with spend, cap, reset date, and a progress bar', () => {
    const [entry] = buildApiSpendByProvider(records, rates, { currency: 'USD' }, now)
    const meter = buildProviderCalendarMonthSpend(
      records,
      rates,
      'antigravity',
      20,
      { currency: 'USD' },
      now
    )
    const html = renderToStaticMarkup(<ApiSpendProviderBlock entry={entry} capMeter={meter} />)
    expect(html).toContain('Antigravity')
    expect(html).toContain('Budget')
    expect(html).toContain('$1.0')
    expect(html).toContain('$20.0')
    expect(html).toContain('resets')
    expect(html).toContain('quota-progress-bar')
    // Advisory framing must survive on the row itself.
    expect(html).toContain('never blocks a run')
  })

  it('renders no meter row when no cap is configured', () => {
    const [entry] = buildApiSpendByProvider(records, rates, { currency: 'USD' }, now)
    const html = renderToStaticMarkup(<ApiSpendProviderBlock entry={entry} capMeter={null} />)
    expect(html).toContain('Antigravity')
    expect(html).not.toContain('Budget')
    expect(html).not.toContain('quota-progress-bar')
  })
})

describe('Muse budget meter (spend view)', () => {
  const rates: RendererProviderRates = {
    muse: [
      {
        modelId: 'muse-spark-1.2',
        inputUsdPerMillion: 1.25,
        outputUsdPerMillion: 4.25,
        cachedInputUsdPerMillion: 0.15
      }
    ]
  }
  const now = new Date('2026-06-13T12:00:00.000Z').getTime()
  const records: UsageRecord[] = [
    {
      id: 'muse-1',
      workspaceId: 'ws-1',
      chatId: 'chat-1',
      runId: 'run-1',
      provider: 'muse',
      model: 'muse-spark-1.2',
      inputTokens: 1_000_000,
      outputTokens: 0,
      totalTokens: 1_000_000,
      durationMs: 1000,
      timestamp: now - 60_000
    } as UsageRecord
  ]

  it('renders the $15 default-style cap with calendar-month reset and Muse accent', () => {
    const [entry] = buildApiSpendByProvider(records, rates, { currency: 'USD' }, now)
    const meter = buildProviderCalendarMonthSpend(
      records,
      rates,
      'muse',
      15,
      { currency: 'USD' },
      now
    )
    const html = renderToStaticMarkup(<ApiSpendProviderBlock entry={entry} capMeter={meter} />)
    expect(html).toContain('Muse')
    expect(html).toContain('Budget')
    expect(html).toContain('$1.2')
    expect(html).toContain('$15.0')
    expect(html).toContain('resets')
    expect(html).toContain('muse-cap-meter-label')
    expect(html).toContain('quota-progress-bar')
    expect(html).toContain('--provider-muse-color')
  })
})

// The two spend rosters must move in lockstep. buildApiSpendAggregation gates on
// API_SPEND_PROVIDER_ORDER, so a provider rendered without being aggregated shows
// a row that can only ever read zero — Pi shipped in exactly that state, and a
// code comment did not prevent it.
describe('API spend roster lockstep', () => {
  it('renders no provider that the aggregation would drop', () => {
    const aggregated = new Set(API_SPEND_PROVIDER_ORDER)
    const rendered = API_SPEND_RENDER_ORDER.filter((provider) => !aggregated.has(provider))
    expect(rendered).toEqual([])
  })

  // The reverse direction: a provider aggregated but absent from the render
  // order never shows its spend section at all — Mistral shipped in exactly
  // that state, the mirror image of the Pi bug above.
  it('drops no aggregated provider from the render order', () => {
    const rendered = new Set(API_SPEND_RENDER_ORDER)
    const aggregated = API_SPEND_PROVIDER_ORDER.filter((provider) => !rendered.has(provider))
    expect(aggregated).toEqual([])
  })
})

// The compact grid colours cost figures through per-provider
// `--compact-quota-color` rules; a provider column with no rule silently falls
// back to plain sidebar text — AGY, DeepSeek and Cerebras all shipped in
// exactly that state while the expanded meters (which build
// `var(--provider-<id>-color)` directly) were already tinted. Pin the full
// column roster against both the accent rule and the token it points at.
describe('compact grid accent lockstep', () => {
  it('gives every compact column an accent rule wired to a defined brand token', () => {
    const cardCss = readFileSync(
      join(process.cwd(), 'src/renderer/src/components/ModelUsageCard.css'),
      'utf8'
    )
    const themeCss = readFileSync(join(process.cwd(), 'src/renderer/src/styles/theme.css'), 'utf8')
    for (const provider of Object.keys(COMPACT_USAGE_PROVIDER_LABELS)) {
      const rule = new RegExp(
        String.raw`\.model-usage-compact-cell\.provider-${provider}\s*\{[^}]*` +
          String.raw`--compact-quota-color:\s*var\(--provider-${provider}-color\);`,
        's'
      )
      expect(cardCss, `missing compact accent rule for ${provider}`).toMatch(rule)
      expect(
        themeCss.includes(`--provider-${provider}-color:`),
        `missing brand token --provider-${provider}-color`
      ).toBe(true)
    }
  })
})
