import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { GoalPopoverMarkdown } from './GoalPopoverMarkdown'

describe('GoalPopoverMarkdown', () => {
  it('presents goal text with safe GFM formatting', () => {
    const html = renderToStaticMarkup(
      <GoalPopoverMarkdown
        className="composer-goal-objective"
        content={'# Ship it\n\n- [x] **Build**\n- [ ] [Verify](https://example.com)'}
      />
    )

    expect(html).toContain('composer-goal-markdown composer-goal-objective')
    expect(html).toContain('<h1>Ship it</h1>')
    expect(html).toContain('<strong>Build</strong>')
    expect(html).toContain('type="checkbox"')
    expect(html).toContain('data-link-kind="external"')
  })

  it('renders raw HTML as text instead of executing or loading it', () => {
    const html = renderToStaticMarkup(
      <GoalPopoverMarkdown content={'<img src=x onerror=alert(1)> **safe**'} />
    )

    expect(html).not.toContain('<img')
    expect(html).not.toMatch(/<[a-z][^>]*\bonerror\s*=/i)
    expect(html).toContain('&lt;img')
    expect(html).toContain('<strong>safe</strong>')
  })
})
