import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MistralQuotaMeterView } from './MistralQuotaMeter'
import {
  accumulate,
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

  it('qualifies the ceiling in place so it cannot read as a published allowance', () => {
    const html = render({ snapshot: snapshot(3.5, { plan: 'pro' }) })
    expect(html).toContain('of ~$14.99 est.')
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
