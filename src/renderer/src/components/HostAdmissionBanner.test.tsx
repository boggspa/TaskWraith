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
          confirmCode: '123456'
        }}
        onReject={() => {}}
        onDismiss={() => {}}
      />
    )
    expect(html).toContain('aria-label="Reject Alex&#x27;s join attempt and stop sharing"')
    expect(html).toContain('123456')
  })
})