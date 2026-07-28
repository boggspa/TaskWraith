import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

import { ComposerAboveRowsToggleButton } from './ComposerAboveRowsToggleButton'

describe('ComposerAboveRowsToggleButton', () => {
  it('renders a direct, icon-only minimize control with no popover contract', () => {
    const html = renderToStaticMarkup(
      <ComposerAboveRowsToggleButton minimized={false} onToggle={() => undefined} />
    )

    expect(html).toContain('composer-above-rows-toggle-button')
    expect(html).toContain('composer-hint-pill--left')
    expect(html).toContain('data-hint-label="Minimise rows"')
    expect(html).toContain('aria-label="Minimise composer above rows"')
    expect(html).toContain('aria-pressed="false"')
    expect(html).not.toContain('aria-haspopup')
  })

  it('reflects its pressed state with the inverse label and glyph state', () => {
    const html = renderToStaticMarkup(
      <ComposerAboveRowsToggleButton minimized onToggle={() => undefined} />
    )

    expect(html).toContain('composer-above-rows-toggle-button composer-hint-pill')
    expect(html).toContain('is-active')
    expect(html).toContain('data-hint-label="Show rows"')
    expect(html).toContain('aria-label="Show composer above rows"')
    expect(html).toContain('aria-pressed="true"')
    expect(html).toContain('composer-above-rows-toggle-glyph')
  })
})
