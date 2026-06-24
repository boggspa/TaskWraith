import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ImageGenerationSettingsCard } from './ImageGenerationSettingsCard'

describe('ImageGenerationSettingsCard', () => {
  it('renders nothing (no crash) when the image-generation bridge is unavailable', () => {
    // No window.api in the static-markup environment → status never loads → the
    // card degrades to an empty render rather than throwing.
    const html = renderToStaticMarkup(<ImageGenerationSettingsCard />)
    expect(html).toBe('')
  })
})
