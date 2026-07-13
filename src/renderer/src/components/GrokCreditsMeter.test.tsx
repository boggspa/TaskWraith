import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { GrokCreditsMeterView } from './GrokCreditsMeter'
import { parseGrokUsage, type GrokUsageSnapshot } from '../../../main/grok/GrokUsage'

function snap(raw: string): GrokUsageSnapshot {
  return parseGrokUsage(raw, '2026-05-28T00:00:00.000Z')
}

function render(props: {
  snapshot: GrokUsageSnapshot | null
  loading?: boolean
  errored?: boolean
  stale?: boolean
}): string {
  return renderToStaticMarkup(
    <GrokCreditsMeterView
      snapshot={props.snapshot}
      loading={props.loading ?? false}
      errored={props.errored ?? false}
      stale={props.stale ?? false}
    />
  )
}

describe('GrokCreditsMeterView', () => {
  it('renders as a Grok credits row (never token/cost) using the shared meter classes', () => {
    const html = render({ snapshot: snap('Credits used: 1.05%') })
    expect(html).toContain('model-usage-item provider-grok')
    expect(html).toContain('Grok')
    expect(html).toContain('Credits')
    expect(html).toContain('Subscription credits')
    expect(html).not.toMatch(/token/i)
    expect(html).not.toMatch(/\$/)
    // No bespoke local refresh button anymore (matches the other meters).
    expect(html).not.toContain('grok-credits-refresh')
    expect(html).not.toContain('Refresh')
  })

  it('renders a decimal percent', () => {
    const html = render({ snapshot: snap('Credits used: 1.05%') })
    expect(html).toContain('1.05%')
  })

  it('renders an exact 0%', () => {
    const html = render({ snapshot: snap('Credits used: 0%') })
    expect(html).toContain('0%')
  })

  it('preserves the raw "<1%" band without inventing a number', () => {
    const html = render({ snapshot: snap('Credits used: <1%') })
    expect(html).toContain('&lt;1%')
    expect(html).not.toContain('>0%<')
    expect(html).not.toContain('>1%<')
  })

  it('shows the reset window when present', () => {
    const html = render({ snapshot: snap('Credits used: 0%\nResets: May 31, 16:00 PT') })
    expect(html).toContain('resets May 31, 16:00 PT')
  })

  it('renders the shared pace tick when the reset timestamp is parseable', () => {
    // Deterministic across time. The view calls computeQuotaPace with the REAL
    // wall clock, but `snap()` pins refreshedAt to a fixed date — so a hardcoded
    // reset rots: once real time passes it, remainingMs<=0 → pace returns null →
    // no tick (it only passed the night it was written). Build the reset in the
    // parser's own "Mon DD, HH:MM PT" format ~15 days ahead of real now, with
    // refreshedAt = real now so the year resolves correctly. The inferred 30-day
    // Grok credit window is then ~half elapsed; at 1% used the meter reads well
    // "ahead" of pace, so the shared tick surfaces on every run.
    const MONTHS = [
      'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
      'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
    ]
    const now = new Date()
    const future = new Date(now.getTime() + 15 * 24 * 60 * 60 * 1000)
    const resetText = `${MONTHS[future.getUTCMonth()]} ${future.getUTCDate()}, 12:00 PT`
    const snapshot = parseGrokUsage(`Credits used: 1%\nResets: ${resetText}`, now.toISOString())
    const html = render({ snapshot })
    expect(html).toContain('quota-pace-tick')
  })

  it('tidies a collapsed reset window for display', () => {
    const html = render({ snapshot: snap('Credits used: 0%\nResets: May31,16:00PT') })
    expect(html).toContain('resets May 31, 16:00 PT')
  })

  it('omits the reset line entirely when the reset window is missing', () => {
    const html = render({ snapshot: snap('Credits used: 5%') })
    expect(html).not.toContain('resets ')
  })

  it('shows the plan label (tier badge) but never the pay-as-you-go line', () => {
    const html = render({
      snapshot: snap('Free credits with SuperGrok\nCredits used: 2%\nPay as you go: disabled')
    })
    expect(html).toContain('>SuperGrok<')
    expect(html).not.toContain('Free credits with')
    expect(html).not.toContain('Pay as you go')
  })

  it('falls back to SuperGrok for an observed weekly screen without a plan line', () => {
    const html = render({ snapshot: snap('Weekly limit: 25%') })
    expect(html).toContain('model-usage-tier-badge')
    expect(html).toContain('>SuperGrok<')
  })

  it('preserves an explicit SuperGrok Heavy plan', () => {
    const html = render({ snapshot: snap('Plan: SuperGrok Heavy\nWeekly limit: 25%') })
    expect(html).toContain('>SuperGrok Heavy<')
  })

  it('renders an unavailable state', () => {
    const html = render({ snapshot: snap('') })
    expect(html).toContain('Usage unavailable')
  })

  it('renders an errored unavailable state distinctly', () => {
    const html = render({ snapshot: null, errored: true })
    expect(html).toContain('Could not read the Grok CLI')
  })

  it('renders a loading state', () => {
    const html = render({ snapshot: null, loading: true })
    expect(html).toContain('Reading Grok usage…')
  })

  it('renders the weekly-limit /usage screen with Weekly labels', () => {
    const html = render({
      snapshot: snap('Weekly limit: 98%\nNext reset: July 2, 09:04 PT')
    })
    expect(html).toContain('>Weekly<')
    expect(html).toContain('98%')
    expect(html).toContain('Weekly limit')
    expect(html).toContain('resets July 2, 09:04 PT')
    expect(html).not.toContain('Subscription credits')
    expect(html).not.toContain('>Credits<')
  })

  it('pins the bar near-full for a ">99%" weekly used band', () => {
    const html = render({ snapshot: snap('Weekly limit left: <1%') })
    expect(html).toContain('&gt;99%')
    // The band floor drives the bar width (99%), never an invented exact number.
    expect(html).toContain('width:99.00%')
  })

  it('flags a stale weekly reading with the weekly meta text', () => {
    const html = render({ snapshot: snap('Weekly limit: 98%'), stale: true })
    expect(html).toContain('Weekly limit · stale')
  })

  it('does not flag a fresh observed snapshot as stale', () => {
    const html = render({ snapshot: snap('Credits used: 0%'), stale: false })
    expect(html).not.toContain('stale')
  })

  it('flags a prior reading shown after a failed refresh as stale', () => {
    const html = render({ snapshot: snap('Credits used: 3%'), stale: true })
    expect(html).toContain('3%')
    expect(html).toContain('stale')
  })
})
