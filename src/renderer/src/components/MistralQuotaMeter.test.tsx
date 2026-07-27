import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MistralQuotaMeterView } from './MistralQuotaMeter'
import {
  accumulate,
  applyAnchor,
  applyReport,
  estimateQuota,
  recordLimitEvent,
  startCycle,
  type MistralPlanId
} from '../../../main/mistral/MistralQuotaEstimate'
import type { MistralQuotaSnapshot } from '../../../main/mistral/MistralQuotaStore'

const T0 = new Date('2026-07-01T00:00:00.000Z')

/** Build a snapshot through the REAL estimator so the view test cannot drift
 *  away from the semantics it is claiming to render honestly. */
function snapshot(
  spentUsd: number,
  options: { plan?: MistralPlanId; learned?: boolean } = {}
): MistralQuotaSnapshot {
  let cycle = accumulate(startCycle(T0), { costUsd: spentUsd, totalTokens: 200_000 })
  if (options.learned) cycle = recordLimitEvent(cycle)
  const plan = options.plan ?? 'unknown'
  return {
    estimate: estimateQuota(cycle, plan, T0),
    plan,
    turns: cycle.turns,
    totalTokens: cycle.totalTokens
  }
}

/** A cycle carrying a console reading — the Pro figures observed 2026-07-27. */
function anchoredSnapshot(): MistralQuotaSnapshot {
  const cycle = applyAnchor(accumulate(startCycle(T0), { costUsd: 0.1, totalTokens: 1000 }), {
    allowanceUsd: 27.8,
    spentUsd: 0.31,
    observedAt: '2026-07-27T12:00:00.000Z',
    cycleResetsAt: '2026-07-31T00:00:00.000Z',
    declared: { allowance: 25.5, spent: 0.28, currency: 'EUR' }
  })
  return { estimate: estimateQuota(cycle, 'pro', T0), plan: 'pro', turns: 1, totalTokens: 1000 }
}

/** The Admin API's shape: real spend, no entitlement, so the ceiling stays seeded. */
function reportedSpendOnlySnapshot(): MistralQuotaSnapshot {
  const cycle = applyReport(startCycle(T0), {
    spentUsd: 3.27,
    fetchedAt: '2026-07-27T12:00:00.000Z',
    declared: { spent: 3, currency: 'EUR' }
  })
  return { estimate: estimateQuota(cycle, 'pro', T0), plan: 'pro', turns: 0, totalTokens: 0 }
}

function render(props: { snapshot: MistralQuotaSnapshot | null; loading?: boolean }): string {
  return renderToStaticMarkup(
    <MistralQuotaMeterView snapshot={props.snapshot} loading={props.loading ?? false} />
  )
}

/** Text the user actually reads — tags and attributes stripped. The progress
 *  bar's inline gradient is full of `%` values that are not a claim about
 *  anything, so the "no bare percentage" rule has to be checked on text. */
function visibleText(html: string): string {
  return html.replace(/<[^>]*>/g, ' ')
}

describe('MistralQuotaMeterView — the gate', () => {
  it('renders NOTHING when no cycle is persisted', () => {
    // A user who never runs the Mistral seat must not see a row at all.
    expect(render({ snapshot: null })).toBe('')
    expect(render({ snapshot: null, loading: true })).toBe('')
  })
})

describe('MistralQuotaMeterView — honesty', () => {
  it('leads with the self-hedging band phrase', () => {
    const html = render({ snapshot: snapshot(4) })
    expect(html).toContain('Moderate use this month (estimated)')
  })

  it('never renders a bare percentage as if Mistral reported one', () => {
    // Mistral publishes no quota figure. `usedPercent` may drive the bar's
    // length; printing it as text would be a fabricated vendor number.
    const html = render({ snapshot: snapshot(9) })
    expect(visibleText(html)).not.toMatch(/\d+(\.\d+)?%/)
  })

  it('marks money with the house ~ tilde and an "estimated, not billed" tooltip', () => {
    const html = render({ snapshot: snapshot(3.5) })
    expect(html).toContain('~$3.50')
    expect(html).toContain('never billed')
  })

  it('qualifies a SEEDED ceiling in place so it cannot read as a published allowance', () => {
    const html = render({ snapshot: snapshot(3.5, { plan: 'pro' }) })
    expect(html).toContain('of ~$27.80 est.')
  })

  it('drops the hedge once the allowance is a figure Mistral itself gave us', () => {
    // Carrying "~… est." over the user's own console reading would understate
    // what we know just as badly as the reverse overstates it.
    const html = render({ snapshot: anchoredSnapshot() })
    expect(html).toContain('of $27.80')
    expect(html).not.toContain('est.')
    expect(html).not.toContain('not yet calibrated')
    expect(html).not.toContain('mistral-quota-bar--estimated')
  })

  it('quotes the reading back in the currency the console showed', () => {
    const html = render({ snapshot: anchoredSnapshot() })
    expect(html).toContain('your Mistral console')
    expect(html).toContain('EUR 25.50')
  })

  it('still hedges when the spend is real but the ceiling is only a plan default', () => {
    // Half-measured is not measured: a real numerator over a guessed denominator
    // is still a guessed ratio.
    const html = render({ snapshot: reportedSpendOnlySnapshot() })
    expect(html).toContain('of ~$27.80 est.')
    expect(visibleText(html)).toContain('(estimated)')
  })

  it('says plainly in the tooltip that nothing here comes from Mistral', () => {
    const html = render({ snapshot: snapshot(3.5) })
    expect(html).toContain('Mistral publishes no quota figure')
    expect(html).toContain('observed locally')
  })

  it('mutes the bar and flags the reading while the ceiling is still a guess', () => {
    const html = render({ snapshot: snapshot(3.5) })
    expect(html).toContain('mistral-quota-bar--estimated')
    expect(html).toContain('not yet calibrated')
    expect(html).toContain('data-confidence="calibrating"')
  })

  it('drops the muting and the hedge once a real limit event has calibrated it', () => {
    const html = render({ snapshot: snapshot(9.4, { learned: true }) })
    expect(html).not.toContain('mistral-quota-bar--estimated')
    expect(html).not.toContain('not yet calibrated')
    expect(html).not.toContain('(estimated)')
    expect(html).toContain('data-confidence="learned"')
  })
})

describe('MistralQuotaMeterView — sibling shape', () => {
  it('reuses the Model Usage card classes so it reads as a provider row', () => {
    const html = render({ snapshot: snapshot(1) })
    expect(html).toContain('model-usage-item provider-mistral')
    expect(html).toContain('Mistral')
    expect(html).toContain('model-usage-window-list')
  })

  it('shows a plan badge only when the plan is actually known', () => {
    expect(render({ snapshot: snapshot(1, { plan: 'unknown' }) })).not.toContain(
      'model-usage-tier-badge'
    )
    const pro = render({ snapshot: snapshot(1, { plan: 'pro' }) })
    expect(pro).toContain('model-usage-tier-badge')
    expect(pro).toContain('Pro')
  })

  it('names the cycle reset so the band has a horizon', () => {
    expect(render({ snapshot: snapshot(1) })).toContain('resets 1 Aug')
  })
})
