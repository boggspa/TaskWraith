import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { HostAdmissionBannerCard, hostAdmissionRejectAriaLabel } from './HostAdmissionBanner'

describe('HostAdmissionBanner', () => {
  it('builds a descriptive reject label from the collaborator name', () => {
    expect(hostAdmissionRejectAriaLabel('Alex')).toBe(
      "Reject Alex's join attempt and stop sharing"
    )
  })

  it('renders the reject button with the descriptive aria-label', () => {
    const html = renderToStaticMarkup(
      <HostAdmissionBannerCard
        entry={{
          handshakeId: 'hs-1',
          shareId: 'share-1',
          displayName: 'Alex',
          confirmCode: '123456',
          mode: 'admission'
        }}
        onReject={() => {}}
        onDismiss={() => {}}
      />
    )
    expect(html).toContain('aria-label="Reject Alex&#x27;s join attempt and stop sharing"')
    expect(html).toContain('aria-label="Security code 123456"')
    expect(html).toContain('123456')
  })

  it('renders a reconnect as an informational notice: no SAS code, no Reject', () => {
    const html = renderToStaticMarkup(
      <HostAdmissionBannerCard
        entry={{
          handshakeId: 'hs-2',
          shareId: 'share-1',
          displayName: 'Alex',
          confirmCode: '654321',
          mode: 'reconnect'
        }}
        onReject={() => {}}
        onDismiss={() => {}}
      />
    )
    expect(html).toContain('reconnecting to this People chat')
    expect(html).not.toContain('654321')
    expect(html).not.toContain('Reject')
    expect(html).toContain('aria-label="Dismiss"')
  })
})