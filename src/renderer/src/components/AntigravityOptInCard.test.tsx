import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  AntigravityOptInCard,
  createAntigravityOptInPatch
} from './AntigravityOptInCard'

describe('AntigravityOptInCard', () => {
  it('is disabled by default and requires an explicit risk acknowledgement', () => {
    const html = renderToStaticMarkup(
      <AntigravityOptInCard enabled={false} acceptedAt={null} onChange={() => {}} />
    )

    expect(html).toContain('data-provider="antigravity"')
    expect(html).toContain('Disabled — explicit consent required')
    expect(html).toContain(
      'Using third party software, tools, or services to access the Service'
    )
    expect(html).toContain('can suspend or terminate your Google account')
    expect(html).toContain('February 2026')
    expect(html).toContain('not ToS-approved or ban-safe')
    expect(html).toContain('TaskWraith never reads, copies, or stores')
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
})
