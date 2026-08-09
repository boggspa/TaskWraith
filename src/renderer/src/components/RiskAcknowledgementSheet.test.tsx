import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { RiskAcknowledgementSheetSurface } from './RiskAcknowledgementSheet'

describe('RiskAcknowledgementSheetSurface', () => {
  it('requires the linked acknowledgement before a high-risk action', () => {
    const html = renderToStaticMarkup(
      <RiskAcknowledgementSheetSurface
        titleId="policy-warning-title"
        eyebrow="Policy override"
        title="Override policy defaults?"
        description="This changes approval behavior."
        caution="Some actions may stop prompting."
        acknowledgementId="policy-warning-ack"
        acknowledgementLabel="I understand the risk."
        acknowledged={false}
        onAcknowledgedChange={() => {}}
        onCancel={() => {}}
        onConfirm={() => {}}
        confirmLabel="Open override hatch"
      />
    )

    expect(html).toContain('aria-labelledby="policy-warning-title"')
    expect(html).toContain('data-elevation-tier="2"')
    expect(html).toContain('id="policy-warning-ack"')
    expect(html).toContain('for="policy-warning-ack"')
    expect(html).toMatch(/disabled=""[^>]*>Open override hatch<\/button>/)
  })

  it('allows a standard warning to continue without an acknowledgement', () => {
    const html = renderToStaticMarkup(
      <RiskAcknowledgementSheetSurface
        titleId="edit-warning-title"
        eyebrow="Permission change"
        title="Allow edits?"
        description="Edits remain visible."
        acknowledged={false}
        onAcknowledgedChange={() => {}}
        onCancel={() => {}}
        onConfirm={() => {}}
        confirmLabel="Continue"
        riskLevel="standard"
      />
    )

    expect(html).toContain('data-elevation-tier="1"')
    expect(html).not.toContain('approval-elevation-ack')
    expect(html).not.toMatch(/disabled=""[^>]*>Continue<\/button>/)
  })
})
