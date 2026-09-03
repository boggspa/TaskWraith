import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { StableMarkdownBlock } from './StableMarkdownBlock'

function countClass(html: string, className: string): number {
  return (html.match(new RegExp(className, 'g')) || []).length
}

describe('StableMarkdownBlock check-result accents', () => {
  it('accents check outcomes in prose and emphasis but never in code, fences or links', () => {
    const html = renderToStaticMarkup(
      <StableMarkdownBlock
        raw={[
          'Suite is green: **2,127 passed**, 0 failures.',
          '',
          'Then 2 test files failed.',
          '',
          '> Typecheck passes and there are no lint errors.',
          '',
          'Keep `5 failed` and [linked 3 failed](https://example.com) literal.',
          '',
          '```text',
          '12 failed',
          '```'
        ].join('\n')}
      />
    )

    // "2,127 passed", "0 failures", "Typecheck passes", "no lint errors".
    expect(countClass(html, 'markdown-inline-check-outcome is-pass')).toBe(4)
    // Exactly one of the four "failed" idioms is in accentable prose; the
    // inline code, the link text and the fenced block are all excluded.
    expect(countClass(html, 'markdown-inline-check-outcome is-fail')).toBe(1)
    expect(html).toContain(
      '<strong><span class="markdown-inline-check-outcome is-pass">2,127</span>'
    )
    expect(html).toContain('<span class="markdown-inline-check-outcome is-fail">2</span>')
    expect(html).toContain('<code>5 failed</code>')
    expect(html).toContain('linked 3 failed')
  })

  it('keeps the whole negated phrase inside one accent so its polarity cannot invert', () => {
    const html = renderToStaticMarkup(<StableMarkdownBlock raw={'Shipped with no lint errors.'} />)

    expect(html).toContain(
      '<span class="markdown-inline-check-outcome is-pass">no lint errors</span>'
    )
    expect(countClass(html, 'markdown-inline-check-outcome is-fail')).toBe(0)
  })

  it('adds check-result classes only after safe HTML has been sanitised', () => {
    const html = renderToStaticMarkup(
      <StableMarkdownBlock
        raw={'<span class="markdown-inline-check-outcome is-fail">plain</span> 7 failed'}
        allowSafeHtml
      />
    )

    expect(html).not.toContain('class="markdown-inline-check-outcome is-fail">plain</span>')
    expect(countClass(html, 'markdown-inline-check-outcome is-fail')).toBe(1)
  })
})
