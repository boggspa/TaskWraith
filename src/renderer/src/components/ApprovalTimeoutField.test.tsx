import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  APPROVAL_TIMEOUT_MAX_MS,
  APPROVAL_TIMEOUT_MIN_MS
} from '../../../shared/interactionTimeouts'
import { ApprovalTimeoutField } from './ApprovalTimeoutField'

describe('ApprovalTimeoutField', () => {
  it('renders the label and the timeout in seconds, not milliseconds', () => {
    const html = renderToStaticMarkup(
      <ApprovalTimeoutField label="Codex" valueMs={45_000} onChange={() => {}} />
    )

    expect(html).toContain('approval-timeout-field')
    expect(html).toContain('approval-timeout-field-label')
    expect(html).toContain('Codex')
    expect(html).toContain('value="45"')
    expect(html).not.toContain('value="45000"')
    // The unit suffix makes the seconds display explicit.
    expect(html).toContain('approval-timeout-field-unit')
    expect(html).toContain('>s</span>')
  })

  it('rounds a sub-second remainder to the nearest whole second', () => {
    const html = renderToStaticMarkup(
      <ApprovalTimeoutField label="Kimi" valueMs={45_500} onChange={() => {}} />
    )

    expect(html).toContain('value="46"')
  })

  it('exposes the shared timeout bounds as input min/max with a 5s step', () => {
    const html = renderToStaticMarkup(
      <ApprovalTimeoutField label="Claude" valueMs={60_000} onChange={() => {}} />
    )

    expect(html).toContain(`min="${APPROVAL_TIMEOUT_MIN_MS / 1000}"`)
    expect(html).toContain(`max="${APPROVAL_TIMEOUT_MAX_MS / 1000}"`)
    expect(html).toContain('step="5"')
    expect(html).toContain('type="number"')
  })

  it('marks the input disabled when the field is disabled', () => {
    const html = renderToStaticMarkup(
      <ApprovalTimeoutField label="Grok" valueMs={240_000} disabled onChange={() => {}} />
    )

    expect(html).toContain('value="240"')
    expect(html).toContain('disabled=""')
  })

  it('leaves the input enabled by default', () => {
    const html = renderToStaticMarkup(
      <ApprovalTimeoutField label="Muse" valueMs={10_000} onChange={() => {}} />
    )

    expect(html).toContain('value="10"')
    expect(html).not.toContain('disabled')
  })
})
