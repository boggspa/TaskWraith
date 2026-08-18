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
    expect(html).toContain('ban-risk; requires explicit consent')
    // The long ToS/mechanics prose moved out of the card; the consent gate
    // itself — checkbox plus explicit accept button — is what must remain.
    expect(html).toContain('may breach Google')
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
        onOpenUpgrade={() => {}}
        upgradeState="opened"
      />
    )

    expect(html).toContain('Risk acceptance recorded')
    expect(html).toContain('<code>agy</code>')
    expect(html).toContain('Open Terminal to sign in')
    expect(html).toContain('Upgrade CLI…')
    expect(html).toContain('Upgrade terminal opened')
    expect(html).toContain('Disable AntiGravity')
    expect(html).not.toContain('Accept risk and enable')
  })

  it('keeps Gemini API disclosure separate and explicit inside the card', () => {
    const html = renderToStaticMarkup(
      <AntigravityOptInCard enabled={false} acceptedAt={null} onChange={() => {}} />
    )

    expect(html).toContain('Gemini API (BYO key; separate billing)')
    expect(html).toContain('I understand the separate Gemini API billing')
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
    expect(apiSection).not.toContain('Accept risk and enable')
    expect(apiSection).not.toContain('ban-risk')
    expect(apiSection).not.toContain('suspend or terminate')
    expect(apiSection).toContain('I understand the separate Gemini API billing')
  })
})
