import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ComposerHighlightOverlay } from './ComposerHighlightOverlay'

/**
 * No jsdom in this repo — renderer components are asserted through
 * `renderToStaticMarkup`, so these cover the painted output only. The
 * metric-mirroring layout effects don't run here (and don't need to:
 * they're driven by `getComputedStyle` against a live textarea).
 */
function markup(props: Partial<Parameters<typeof ComposerHighlightOverlay>[0]> = {}): string {
  return renderToStaticMarkup(
    <ComposerHighlightOverlay
      value=""
      textareaRef={{ current: null }}
      syncEpoch="test"
      {...props}
    />
  )
}

describe('ComposerHighlightOverlay — ghost suggestion', () => {
  it('paints nothing extra when no ghost is supplied', () => {
    expect(markup()).not.toContain('composer-ghost-suggestion')
  })

  it('paints the ghost text in its own dimmed span', () => {
    const html = markup({ ghostText: 'Retry that last turn on Opus 5' })
    expect(html).toContain('composer-ghost-suggestion')
    expect(html).toContain('Retry that last turn on Opus 5')
  })

  it('treats empty-string and null ghosts as absent', () => {
    expect(markup({ ghostText: '' })).not.toContain('composer-ghost-suggestion')
    expect(markup({ ghostText: null })).not.toContain('composer-ghost-suggestion')
  })

  it('paints the ghost after the draft text, not before it', () => {
    const html = markup({ value: 'already typed', ghostText: 'GHOST' })
    expect(html.indexOf('already typed')).toBeLessThan(html.indexOf('GHOST'))
  })

  it('stays inside the aria-hidden overlay so the ghost is not announced', () => {
    // The suggestion is a visual affordance; a screen reader hitting it
    // as composer content would read unwritten text as if it were the
    // user's own draft.
    const html = markup({ ghostText: 'Commit the working changes on master' })
    expect(html).toContain('aria-hidden="true"')
  })
})
