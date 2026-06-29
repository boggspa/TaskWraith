import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { DiffFileSummary } from '../../../main/store/types'
import { DiffViewer } from './DiffViewer'

const makeLargeUnifiedDiff = (lineCount: number): string => {
  const lines = [
    'diff --git a/src/large.ts b/src/large.ts',
    'index 1111111..2222222 100644',
    '--- a/src/large.ts',
    '+++ b/src/large.ts',
    `@@ -1,0 +1,${lineCount} @@`
  ]
  for (let index = 0; index < lineCount; index += 1) {
    lines.push(`+line ${String(index).padStart(4, '0')}`)
  }
  return lines.join('\n')
}

const makeSummary = (
  diffText: string,
  overrides: Partial<DiffFileSummary> = {}
): DiffFileSummary => ({
  path: 'src/large.ts',
  status: 'modified',
  additions: 3000,
  deletions: 0,
  previewKind: 'git_diff',
  diffText,
  ...overrides
})

describe('DiffViewer large diff safety', () => {
  it('server-renders only the initial virtual window and shows truncation controls', () => {
    const html = renderToStaticMarkup(
      <DiffViewer
        diff={{
          type: 'changes',
          summaries: [makeSummary(makeLargeUnifiedDiff(3000))]
        }}
      />
    )

    const renderedAddRows = html.match(/class="diff-line add"/g)?.length ?? 0
    expect(renderedAddRows).toBeGreaterThan(0)
    expect(renderedAddRows).toBeLessThan(100)
    expect(html).toContain('class="diff-lines-stack virtualized"')
    expect(html).toContain('class="diff-lines-truncated"')
    expect(html).toContain('role="note"')
    expect(html).toContain('Showing first 2,500 lines')
    expect(html).toContain('504 more omitted')
    expect(html).toContain('Show 504 more')
    expect(html).not.toContain('+line 2499')
    expect(html).not.toContain('+line 2999')
  })

  it('does not show renderer truncation for a complete small diff', () => {
    const html = renderToStaticMarkup(
      <DiffViewer
        diff={{
          type: 'changes',
          summaries: [makeSummary(['@@ -1,1 +1,1 @@', '-old', '+new'].join('\n'))]
        }}
      />
    )

    expect(html).not.toContain('class="diff-lines-truncated"')
    expect(html).not.toContain('more omitted')
  })

  it('labels source-capped previews separately from renderer truncation', () => {
    const html = renderToStaticMarkup(
      <DiffViewer
        diff={{
          type: 'changes',
          summaries: [
            makeSummary(['@@ -1,1 +1,1 @@', '-old', '+new'].join('\n'), {
              diffTextOmittedLines: 42,
              diffTextTruncated: true
            })
          ]
        }}
      />
    )

    expect(html).toContain('diff-lines-source-truncated')
    expect(html).toContain('Preview capped before rendering.')
    expect(html).toContain('42 source lines were omitted.')
    expect(html).not.toContain('Showing first')
  })
})
