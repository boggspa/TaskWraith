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
    const html = renderToStaticMarkup(
      <CopyTranscriptButton onCopy={ok} onCopyMessages={ok} onDownload={ok} />
    )

    expect(html).toContain('composer-copy-transcript-button')
    expect(html).toContain('aria-label="Copy transcript as Markdown"')
    expect(html).toContain('aria-haspopup="dialog"')
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('Copy Markdown')
    expect(html).not.toContain('Download')
  })

  it('renders the popover with the copy, messages and download actions when open', () => {
    const html = renderToStaticMarkup(
      <CopyTranscriptButton defaultOpen onCopy={ok} onCopyMessages={ok} onDownload={ok} />
    )

    expect(html).toContain('role="dialog"')
    expect(html).toContain('Copy Markdown')
    expect(html).toContain('Copy Messages')
    expect(html).toContain('raw conversation messages only')
    expect(html).toContain('aria-expanded="true"')
    // The renamed primary must not carry the old "handoff" label anywhere.
    expect(html).not.toContain('Copy handoff Markdown')
  })

  it('gives Download the secondary button style and leaves Copy Markdown primary', () => {
    const html = renderToStaticMarkup(
      <CopyTranscriptButton defaultOpen onCopy={ok} onCopyMessages={ok} onDownload={ok} />
    )

    expect(html).toContain(
      '<button type="button" class="composer-copy-transcript-secondary">Download</button>'
    )
    expect(html).toContain(
      '<button type="button" class="composer-copy-transcript-primary">Copy Markdown</button>'
    )
    // Download sits ahead of both copy actions in the row.
    expect(html.indexOf('>Download<')).toBeLessThan(html.indexOf('>Copy Messages<'))
    expect(html.indexOf('>Copy Messages<')).toBeLessThan(html.indexOf('>Copy Markdown<'))
  })

  it('disables every action while the popover is disabled', () => {
    const html = renderToStaticMarkup(
      <CopyTranscriptButton defaultOpen disabled onCopy={ok} onCopyMessages={ok} onDownload={ok} />
    )

    // Trigger plus the three popover actions.
    expect(html.match(/disabled=""/g) ?? []).toHaveLength(4)
  })

  it('can render disabled and copied states without changing button text width', () => {
    const disabled = renderToStaticMarkup(
      <CopyTranscriptButton disabled onCopy={ok} onCopyMessages={ok} onDownload={ok} />
    )
    const copied = renderToStaticMarkup(
      <CopyTranscriptButton
        initialCopied
        onCopy={vi.fn(async () => ok())}
        onCopyMessages={vi.fn(async () => ok())}
        onDownload={vi.fn(async () => ok())}
      />
    )

    expect(disabled).toContain('disabled=""')
    expect(disabled).toContain('aria-expanded="false"')
    expect(copied).toContain('is-copied')
    expect(copied).toContain('aria-label="Copied transcript as Markdown"')
    expect(copied).toContain('composer-copy-transcript-check')
  })
})
