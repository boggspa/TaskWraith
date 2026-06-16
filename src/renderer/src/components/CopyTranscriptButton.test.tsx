import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { CopyTranscriptButton } from './CopyTranscriptButton'

const ok = async () => ({
  ok: true as const,
  messageCount: 3,
  charCount: 120,
  omissions: ['absolute paths scrubbed']
})

describe('CopyTranscriptButton', () => {
  it('renders a stable accessible icon button', () => {
    const html = renderToStaticMarkup(<CopyTranscriptButton onCopy={ok} />)

    expect(html).toContain('composer-copy-transcript-button')
    expect(html).toContain('aria-label="Copy transcript as Markdown"')
    expect(html).toContain('aria-haspopup="dialog"')
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('Copy handoff Markdown')
  })

  it('renders the popover with the primary handoff action when open', () => {
    const html = renderToStaticMarkup(<CopyTranscriptButton defaultOpen onCopy={ok} />)

    expect(html).toContain('role="dialog"')
    expect(html).toContain('Copy handoff Markdown')
    expect(html).toContain('Creates safe handoff Markdown')
    expect(html).toContain('aria-expanded="true"')
  })

  it('can render disabled and copied states without changing button text width', () => {
    const disabled = renderToStaticMarkup(<CopyTranscriptButton disabled onCopy={ok} />)
    const copied = renderToStaticMarkup(
      <CopyTranscriptButton initialCopied onCopy={vi.fn(async () => ok())} />
    )

    expect(disabled).toContain('disabled=""')
    expect(disabled).toContain('aria-expanded="false"')
    expect(copied).toContain('is-copied')
    expect(copied).toContain('aria-label="Copied transcript as Markdown"')
    expect(copied).toContain('composer-copy-transcript-check')
  })
})
