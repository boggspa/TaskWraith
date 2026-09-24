import { describe, expect, it } from 'vitest'
import { mcpToolResultImages } from './McpToolResultImages'

describe('mcpToolResultImages', () => {
  it('preserves ordered image bytes and MIME types without converting text or references', () => {
    const png = { type: 'image', mimeType: 'image/png', data: 'cG5n' }
    const jpeg = { type: 'image', mimeType: 'image/jpeg', data: 'anBlZw==' }
    const result = mcpToolResultImages([
      { type: 'text', text: 'Screen: 1200 x 800 pixels' },
      png,
      { type: 'resource_link', uri: 'file:///private/screenshot.png' },
      jpeg
    ])

    expect(result).toEqual([png, jpeg])
    expect(result[0]).toBe(png)
    expect(result[1]).toBe(jpeg)
  })

  it('ignores missing or malformed content without inventing an image', () => {
    expect(mcpToolResultImages(undefined)).toEqual([])
    expect(mcpToolResultImages({ type: 'image', data: 'cG5n' })).toEqual([])
    expect(
      mcpToolResultImages([
        null,
        'cG5n',
        { type: 'image', mimeType: 'image/png' },
        { type: 'image', data: 'cG5n' },
        { type: 'image', mimeType: 'image/png', data: 42 }
      ])
    ).toEqual([])
  })
})
