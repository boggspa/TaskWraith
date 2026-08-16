import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { CopyTranscriptButton } from './CopyTranscriptButton'
import type { TranscriptExportRound } from '../../../shared/transcriptExportScope'

const ok = async () => ({
  ok: true as const,
  messageCount: 3,
  charCount: 120,
  omissions: ['absolute paths scrubbed']
})

const rounds: TranscriptExportRound[] = [
  {
    roundId: 'round-1',
    ordinal: 1,
    prompt: 'Inspect the export path',
    startedAt: '2026-08-16T14:00:00.000Z',
    endedAt: '2026-08-16T14:02:00.000Z',
    status: 'completed',
    hops: 4,
    participantCount: 2,
    participantLabels: ['Orchestrator · codex', 'Reviewer · claude']
  },
  {
    roundId: 'round-2',
    ordinal: 2,
    prompt: 'Ship the scoped picker',
    startedAt: '2026-08-16T14:03:00.000Z',
    status: 'running',
    hops: 7,
    participantCount: 3,
    participantLabels: ['Orchestrator · codex', 'Worker · codex', 'Reviewer · claude']
  }
]

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
      <CopyTranscriptButton
        defaultOpen
        getRounds={() => rounds}
        onCopy={ok}
        onCopyMessages={ok}
        onDownload={ok}
      />
    )

    expect(html).toContain('role="dialog"')
    expect(html).toContain('Copy Markdown')
    expect(html).toContain('Copy Messages')
    expect(html).toContain('raw conversation messages only')
    expect(html).toContain('Current round')
    expect(html).toContain('Previous round')
    expect(html).toContain('Choose round…')
    expect(html).toContain('Entire task')
    expect(html).toContain('aria-label="Transcript scope"')
    expect(html).toContain('class="is-selected" aria-pressed="true"')
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

    // Trigger, four scope choices, and the three export actions.
    expect(html.match(/disabled=""/g) ?? []).toHaveLength(8)
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
