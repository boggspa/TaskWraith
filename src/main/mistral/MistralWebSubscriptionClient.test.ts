import { describe, expect, it } from 'vitest'
import { parseMistralSubscriptionHtml } from './MistralWebSubscriptionClient'

/** Synthetic markup shaped like admin.mistral.ai/subscription — the section
 *  headings, two currency figures per bar, and the reset phrase are the whole
 *  contract (ported from Limit Counter's parser; see the module header). */
const NOW = new Date('2026-08-18T12:00:00.000Z')

const SIGNED_IN_PAGE = `
<html><body>
  <div>CURRENT PLAN</div><div>Pro</div>
  <section><h3>API usage</h3>
    <p>€0.28 of €25.50</p>
    <p>Resets in 4 days</p>
  </section>
  <section><h3>Vibe Code usage</h3>
    <p>€21.30 of €255.00</p>
    <p>Resets in 4 days</p>
  </section>
  <div>PAY-AS-YOU-GO</div><p>€99.99 unrelated overflow figure</p>
</body></html>`

describe('parseMistralSubscriptionHtml', () => {
  it('reads BOTH bars — API usage and Vibe Code usage — with plan and reset', () => {
    const result = parseMistralSubscriptionHtml(SIGNED_IN_PAGE, NOW)
    expect(result).not.toBeNull()
    expect(result?.planName).toBe('Pro')
    expect(result?.currency).toBe('EUR')
    expect(result?.apiSpent).toBe(0.28)
    expect(result?.apiAllowance).toBe(25.5)
    expect(result?.vibeSpent).toBe(21.3)
    expect(result?.vibeAllowance).toBe(255)
    // 4 days out from NOW.
    expect(result?.periodEnd?.toISOString()).toBe('2026-08-22T12:00:00.000Z')
  })

  it('does not let the pay-as-you-go figure bleed into the Vibe bar', () => {
    const result = parseMistralSubscriptionHtml(SIGNED_IN_PAGE, NOW)
    expect(result?.vibeAllowance).toBe(255)
    expect(result?.vibeSpent).toBe(21.3)
  })

  it('reads an hours-scale reset', () => {
    const page = SIGNED_IN_PAGE.replaceAll('Resets in 4 days', 'Resets in 6 hours')
    const result = parseMistralSubscriptionHtml(page, NOW)
    expect(result?.periodEnd?.toISOString()).toBe('2026-08-18T18:00:00.000Z')
  })

  it('tolerates a page with only one bar', () => {
    const apiOnly = `
      <div>API usage</div><p>$1.00 of $5.00</p><p>Resets in 2 days</p>`
    const result = parseMistralSubscriptionHtml(apiOnly, NOW)
    expect(result?.apiSpent).toBe(1)
    expect(result?.apiAllowance).toBe(5)
    expect(result?.currency).toBe('USD')
    expect(result?.vibeSpent).toBeUndefined()
  })

  it('returns null on the login wall — an unauthenticated fetch must never read as €0.00 spent', () => {
    expect(
      parseMistralSubscriptionHtml('<h1>Sign in to your account</h1><form>…</form>', NOW)
    ).toBeNull()
    expect(parseMistralSubscriptionHtml('<a href="/login">Log in</a>', NOW)).toBeNull()
  })

  it('returns null when neither usage section is present', () => {
    expect(parseMistralSubscriptionHtml('<html><body>maintenance</body></html>', NOW)).toBeNull()
  })
})
