import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MistralQuotaMeterView } from './MistralQuotaMeter'
import {
  formatMistralAccumulatedSpend,
  formatMistralLocalIncrement
} from './MistralQuotaFormatting'
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
import { formatResetShort } from '../lib/UsageFormat'

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
function anchoredSnapshot(localAfterReadingUsd = 0): MistralQuotaSnapshot {
  let cycle = applyAnchor(accumulate(startCycle(T0), { costUsd: 0.1, totalTokens: 1000 }), {
    allowanceUsd: 27.8,
    spentUsd: 0.31,
    observedAt: '2026-07-27T12:00:00.000Z',
    cycleResetsAt: '2026-07-31T00:00:00.000Z',
    declared: { allowance: 25.5, spent: 0.28, currency: 'EUR' }
  })
  if (localAfterReadingUsd > 0) {
    cycle = accumulate(cycle, { costUsd: localAfterReadingUsd, totalTokens: 1000 })
  }
  return {
    estimate: estimateQuota(cycle, 'pro', T0),
    plan: 'pro',
    turns: cycle.turns,
    totalTokens: cycle.totalTokens
  }
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

function render(props: {
  snapshot: MistralQuotaSnapshot | null
  loading?: boolean
  currency?: 'USD' | 'GBP' | 'EUR'
  locale?: string
}): string {
  return renderToStaticMarkup(
    <MistralQuotaMeterView
      snapshot={props.snapshot}
      loading={props.loading ?? false}
      currency={props.currency}
      locale={props.locale}
    />
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

  it('renders the figure in the user display currency, not always USD', () => {
    // $3.50 → €3.22 at the baked-in 0.92 EUR/USD fallback. The whole point of
    // wiring Settings → General currency through: a €-console user sees €.
    const eur = render({ snapshot: snapshot(3.5), currency: 'EUR', locale: 'en-GB' })
    expect(eur).toContain('€3.22')
    expect(eur).not.toContain('$3.50')
    // GBP too, at 0.79: $3.50 → £2.77 (0.79 × 3.5 = 2.765 → 2.77).
    const gbp = render({ snapshot: snapshot(3.5), currency: 'GBP', locale: 'en-GB' })
    expect(gbp).toContain('£2.77')
  })

  it('qualifies a SEEDED ceiling in place so it cannot read as a published allowance', () => {
    const html = render({ snapshot: snapshot(3.5, { plan: 'pro' }) })
    expect(html).toContain('of ~$278.00 est.')
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

  it('makes locally accumulated spend after a reading explicit and estimated', () => {
    const html = render({
      snapshot: anchoredSnapshot(0.004),
      currency: 'USD',
      locale: 'en-US'
    })
    expect(html).toContain('Light use this month (estimated)')
    // $0.314 would round to the same $0.31 as the console baseline at the house
    // two-decimal precision, so the Mistral total expands just enough to move.
    expect(html).toContain('~$0.314')
    expect(html).toContain('+ ~$0.004 tracked locally since reading')
    expect(html).toContain('locally estimated spend since that reading')
  })

  it('still hedges when the spend is real but the ceiling is only a plan default', () => {
    // Half-measured is not measured: a real numerator over a guessed denominator
    // is still a guessed ratio.
    const html = render({ snapshot: reportedSpendOnlySnapshot() })
    expect(html).toContain('of ~$278.00 est.')
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

describe('MistralQuotaMeter — accumulation formatting', () => {
  it('keeps the normal two decimals when the accumulated total has visibly advanced', () => {
    expect(formatMistralAccumulatedSpend(0.198, 0.008, 'USD', 'en-US')).toBe('$0.20')
  })

  it('adds precision only when two-decimal rounding would hide the increment', () => {
    expect(formatMistralAccumulatedSpend(0.194, 0.004, 'USD', 'en-US')).toBe('$0.194')
    expect(formatMistralLocalIncrement(0.004, 'USD', 'en-US')).toBe('$0.004')
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
    // cycleResetsAt is 1 Aug from a July start. formatResetShort switches to
    // same-day HH:MM when the wall clock is on that day (Aug 1), so derive the
    // expected label from the same formatter the view uses — never hardcode a
    // month-boundary date string that flips overnight.
    const snap = snapshot(1)
    const reset = formatResetShort({ resetAt: snap.estimate.cycleResetsAt })
    expect(reset).toBeTruthy()
    expect(render({ snapshot: snap })).toContain(`resets ${reset}`)
  })
})
