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
describe('Tier 1 — the one-per-workspace edit-consent notice', () => {
  it('is provider-agnostic: agents wording, Ask label, covers-every-agent line', () => {
    const html = renderToStaticMarkup(
      <ApprovalModeElevationSheetSurface
        tier={1}
        provider="antigravity"
        workspaceLabel="AGBench"
        acknowledged={false}
        onAcknowledgedChange={() => {}}
        onCancel={() => {}}
        onConfirm={() => {}}
      />
    )
    expect(html).toContain('Let agents edit files in AGBench?')
    expect(html).toContain('agents can create, edit, and delete files')
    expect(html).toContain('drop back to Ask at any time')
    expect(html).toContain('covers every agent and model working here')
    // No provider name anywhere in the Tier-1 surface.
    expect(html).not.toContain('Antigravity')
    expect(html).not.toContain('Read-only')
  })
})
