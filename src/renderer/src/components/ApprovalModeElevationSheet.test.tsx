import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  APPROVAL_ELEVATION_ACK_CHECKBOX_ID,
  ApprovalModeElevationSheetSurface
} from './ApprovalModeElevationSheet'

describe('ApprovalModeElevationSheet', () => {
  it('links the full-access risk checkbox to its label', () => {
    const html = renderToStaticMarkup(
      <ApprovalModeElevationSheetSurface
        tier={2}
        provider="claude"
        workspaceLabel="demo"
        acknowledged={false}
        onAcknowledgedChange={() => {}}
        onCancel={() => {}}
        onConfirm={() => {}}
      />
    )
    expect(html).toContain(`id="${APPROVAL_ELEVATION_ACK_CHECKBOX_ID}"`)
    expect(html).toContain(`for="${APPROVAL_ELEVATION_ACK_CHECKBOX_ID}"`)
    expect(html).toContain('I understand the risks and am on a disposable or recoverable device.')
  })
})