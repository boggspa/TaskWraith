import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AntigravityOptInCard, createAntigravityOptInPatch } from './AntigravityOptInCard'

describe('AntigravityOptInCard', () => {
  it('is disabled by default and requires an explicit risk acknowledgement', () => {
    const html = renderToStaticMarkup(
      <AntigravityOptInCard enabled={false} acceptedAt={null} onChange={() => {}} />
    )

    expect(html).toContain('data-provider="antigravity"')
    expect(html).toContain('Disabled — explicit consent required')
    expect(html).toContain('Using third party software, tools, or services to access the Service')
    expect(html).toContain('can suspend or terminate your Google account')
    expect(html).toContain('February 2026')
    expect(html).toContain('not ToS-approved or ban-safe')
    expect(html).toContain('TaskWraith never reads, copies, or stores')
    // The card is the lane's consent document: every local read/write the
    // adapter performs must stay disclosed here. The settings lease writes a
    // temporary permission overlay into agy's own settings file each run.
    expect(html).toContain('~/.gemini/antigravity-cli/settings.json')
    expect(html).toContain('restoring your original settings')
    expect(html).toContain('pre-authorized inside')
    expect(html).toContain('Accept risk and enable')
    expect(html).toContain('disabled=""')
    expect(html).not.toContain('Open Terminal to sign in')
  })

  it('records both enablement and a timestamp only after affirmative acceptance', () => {
    expect(createAntigravityOptInPatch(1_769_000_000_000)).toEqual({
      antigravityEnabled: true,
      antigravityOptInAcceptedAt: 1_769_000_000_000
    })
  })

  it('offers only the official CLI handoff after consent is recorded', () => {
    const html = renderToStaticMarkup(
      <AntigravityOptInCard
        enabled
        acceptedAt={1_769_000_000_000}
        onChange={() => {}}
        onOpenLogin={() => {}}
      />
    )

    expect(html).toContain('Risk acceptance recorded')
    expect(html).toContain('<code>agy</code>')
    expect(html).toContain('Open Terminal to sign in')
    expect(html).toContain('Disable AntiGravity')
    expect(html).not.toContain('Accept risk and enable')
  })

  it('keeps Gemini API disclosure separate and explicit inside the card', () => {
    const html = renderToStaticMarkup(
      <AntigravityOptInCard enabled={false} acceptedAt={null} onChange={() => {}} />
    )

    expect(html).toContain('Gemini API (BYO key; separate billing)')
    expect(html).toContain('Gemini-only')
    expect(html).toContain('separately metered and billed')
    expect(html).toContain('tier and rate limits')
    expect(html).toContain('does not consume AntiGravity subscription quota')
    expect(html).toContain('does not expose AntiGravity Claude or GPT models')
    expect(html).toContain('Free Tier content may be used to improve Google products')
    expect(html).toContain('Paid Services content is not used to improve Google products')
    expect(html).toContain('type="password"')
    expect(html).not.toContain('apiKey')
  })

  it('presents the API-key lane as normal BYO-key setup without AGY risk framing', () => {
    const html = renderToStaticMarkup(
      <AntigravityOptInCard enabled={false} acceptedAt={null} onChange={() => {}} />
    )
    const apiSection = html.match(
      /<section class="settings-antigravity-gemini-api-section"[\s\S]*?<\/section>/
    )?.[0]

    expect(apiSection).toBeDefined()
    expect(apiSection).toContain('BYO key; separate billing')
    expect(apiSection).toContain('Saving a valid key is sufficient')
    expect(apiSection).not.toContain('Accept risk and enable')
    expect(apiSection).not.toContain('ban-safe')
    expect(apiSection).not.toContain('suspend or terminate')
    expect(apiSection).toContain('I understand the separate Gemini API billing')
  })
})
