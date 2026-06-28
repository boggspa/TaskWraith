import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ComposerImageThumb } from './ComposerImageThumb'

describe('ComposerImageThumb', () => {
  it('renders a visible file-type placeholder while preview data is unavailable', () => {
    const html = renderToStaticMarkup(
      <ComposerImageThumb path="/Users/test/Pictures/capture.heic" name="capture.heic" />
    )

    expect(html).toContain('composer-image-thumb-fallback')
    expect(html).toContain('HEIC')
    expect(html).toContain('aria-label="capture.heic"')
  })
})
