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

  // The next three pin the failure modes observed LIVE against Limit Counter's
  // parser (same contract, diagnosed 2026-08-18): Mistral's console is a
  // Next.js app, so the server HTML is NOT the rendered DOM — landmarks are
  // duplicated into the RSC flight payload inside <script> tags, React emits
  // <!-- --> separators inside interpolated text, and tooltip copy renders
  // inline. Raw-markup scanning half-parses that page: API extracts, Vibe
  // silently returns nil, deterministically.

  it('is not fooled by landmarks duplicated inside the RSC script payload', () => {
    // The FIRST "Vibe Code usage" occurrence sits in a script, immediately
    // followed by pay-as-you-go copy — a raw scan anchors there and clips the
    // chunk before any amount. The real section follows later in the body.
    const page = `
      <script>self.__next_f.push([1,"Vibe Code usage ... Pay-as-you-go for Vibe Code ..."])</script>
      <main>
        <h3>API usage</h3><p>€0.28 of €25.50</p><p>Resets in 4 days</p>
        <h3>Vibe Code usage</h3><p>€21.30 of €255.00</p><p>Resets in 4 days</p>
        <div>PAY-AS-YOU-GO</div>
      </main>`
    const result = parseMistralSubscriptionHtml(page, NOW)
    expect(result?.vibeSpent).toBe(21.3)
    expect(result?.vibeAllowance).toBe(255)
  })

  it('reads amounts split by React comment separators and markup between symbol and digits', () => {
    const page = `
      <div>API usage</div>
      <p>€<!-- -->0.28<!-- --> of <span>€</span><span>25.50</span></p>
      <div>Vibe Code usage</div>
      <p>€<!-- -->21.30<!-- --> of €<b>255.00</b></p>`
    const result = parseMistralSubscriptionHtml(page, NOW)
    expect(result?.apiSpent).toBe(0.28)
    expect(result?.apiAllowance).toBe(25.5)
    expect(result?.vibeSpent).toBe(21.3)
    expect(result?.vibeAllowance).toBe(255)
  })

  it('does not let inline pay-as-you-go tooltip copy clip the Vibe amounts', () => {
    // Tooltip text mentioning pay-as-you-go renders between the heading and
    // the figures; the end boundary must not swallow the amounts with it.
    const page = `
      <div>API usage</div><p>€0.28 of €25.50</p>
      <div>Vibe Code usage
        <span role="tooltip">Enable Pay-as-you-go for Vibe Code to keep going past your budget.</span>
      </div>
      <p>€21.30 of €255.00</p>
      <div>ESTIMATED PRICE</div><p>€99.99</p>`
    const result = parseMistralSubscriptionHtml(page, NOW)
    expect(result?.vibeSpent).toBe(21.3)
    expect(result?.vibeAllowance).toBe(255)
  })
})
