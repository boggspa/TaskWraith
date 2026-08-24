import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CloseoutFileChangesSection } from './CloseoutFileChangesSection'

describe('CloseoutFileChangesSection line stats', () => {
  it('keeps a deletion-only line count absent from the additions column', () => {
    const html = renderToStaticMarkup(
      <CloseoutFileChangesSection
        changes={[{ path: 'src/removed.ts', status: 'deleted', deletions: 7 }]}
      />
    )

    // Both the card header and its file row render -7, but neither should
    // fabricate a +0 for the line-count side that was never captured.
    expect(html).toContain('aria-label="7 deletions"')
    expect(html).toContain('>-7</span>')
    expect(html).toContain('file-change-stat-spacer')
    expect(html).not.toContain('>+0</span>')
  })

  it('keeps an additions-only line count absent from the deletions column', () => {
    const html = renderToStaticMarkup(
      <CloseoutFileChangesSection
        changes={[{ path: 'src/created.ts', status: 'created', additions: 4 }]}
      />
    )

    expect(html).toContain('aria-label="4 additions"')
    expect(html).toContain('>+4</span>')
    expect(html).not.toContain('>-0</span>')
  })

  it('withholds an incomplete aggregate while retaining each captured row stat', () => {
    const html = renderToStaticMarkup(
      <CloseoutFileChangesSection
        changes={[
          { path: 'src/added.ts', status: 'created', additions: 4 },
          { path: 'src/removed.ts', status: 'deleted', deletions: 7 }
        ]}
      />
    )
    const headerEnd = html.indexOf('file-change-summary-list')
    const headerHtml = html.slice(0, headerEnd)

    // A header total must cover the whole card. Showing +4 or -7 here would
    // silently treat the other file's unknown side as zero.
    expect(headerHtml).not.toContain('file-change-summary-stats')
    expect(html).toContain('aria-label="4 additions"')
    expect(html).toContain('aria-label="7 deletions"')
  })

  it('continues to render an explicitly captured zero', () => {
    const html = renderToStaticMarkup(
      <CloseoutFileChangesSection
        changes={[
          { path: 'src/unchanged-lines.ts', status: 'modified', additions: 0 },
          { path: 'src/added.ts', status: 'created', additions: 2 }
        ]}
      />
    )

    expect(html).toContain('aria-label="2 additions"')
    expect(html).toContain('aria-label="0 additions"')
    expect(html).toContain('>+0</span>')
    expect(html).not.toContain('>-0</span>')
  })
})
