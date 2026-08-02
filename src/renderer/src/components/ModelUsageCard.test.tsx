import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  API_SPEND_RENDER_ORDER,
  ApiSpendProviderBlock,
  CompactModelUsageGrid,
  ModelUsageCard,
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

  it('renders API-credit usage as money while retaining its quota fill', () => {
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
    expect(html).toContain('data-provider-logo="deepseek"')
    expect(html).toContain('provider-logo-deepseek.png')
    expect(html).not.toContain('provider-glyph-deepseek')
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
    expect(html).not.toContain('>Mistral</th>')
    expect(html).not.toContain('>MO</th>')
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
    // A rough € figure (hedged with ~), never the old qualitative "~NEAR" band.
    expect(html).toContain('>~$8.00</td>')
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
    expect(html).toContain('>~$8.00</td>')
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
    // $8 → €7.36 at 0.92; the cell and its tooltip both convert.
    expect(html).toContain('>~€7.36</td>')
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
              }
            ]
          })
        ]}
      />
    )
    // The hook-backed Gemini pool's two sub-limits land on 5H and WK by label
    // predicate, with the normalized snapshot truth carried in each title.
    expect(withAgy).toContain('>AGY</th>')
    expect(withAgy).toContain('Gemini Weekly')
    expect(withAgy).toContain('Gemini 5H')

    const withoutAgy = renderToStaticMarkup(<CompactModelUsageGrid quotaEntries={[]} />)
    expect(withoutAgy).not.toContain('>AGY</th>')
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

    // Mistral-sourced (anchored/reported): the spend figure drops its ~ hedge.
    expect(html).toContain('>$8.00</td>')
    expect(html).not.toContain('>~$8.00</td>')
    expect(html).toContain('$8.00 of $10.00')
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

    expect(html).toContain('>~$0.194</td>')
    expect(html).toContain('+ ~$0.004 tracked locally since reading')
    expect(html).toContain('Mistral baseline + local estimate')
    expect(html).toContain('provider-mistral is-estimated')
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
    expect(html).toContain('$1.00')
    expect(html).toContain('$20.00')
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
