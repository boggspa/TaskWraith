import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  applyDroppedBlackboardImages,
  BlackboardImageAttachmentPicker,
  mergeBlackboardImagePaths
} from './BlackboardImageAttachmentPicker'

describe('BlackboardImageAttachmentPicker', () => {
  it('deduplicates supported images, rejects unsafe formats, and caps the tray', () => {
    expect(
      mergeBlackboardImagePaths(
        ['/tmp/a.png'],
        ['/tmp/a.png', '/tmp/b.jpg', '/tmp/c.webp', '/tmp/d.gif', '/tmp/e.bmp', '/tmp/vector.svg']
      )
    ).toEqual({
      paths: ['/tmp/a.png', '/tmp/b.jpg', '/tmp/c.webp', '/tmp/d.gif'],
      rejected: 1,
      overflowed: true
    })
  })

  it('renders removable, named preview items', () => {
    const html = renderToStaticMarkup(
      <BlackboardImageAttachmentPicker
        paths={['/tmp/login-error.png']}
        onChange={() => undefined}
        onError={() => undefined}
      />
    )

    expect(html).toContain('Blackboard image attachments')
    expect(html).toContain('login-error.png')
    expect(html).toContain('Remove login-error.png')
  })

  describe('applyDroppedBlackboardImages', () => {
    it('keeps supported dropped images and reports no error', () => {
      expect(applyDroppedBlackboardImages([], ['/tmp/a.png', '/tmp/b.jpeg', '/tmp/c.webp'])).toEqual({
        paths: ['/tmp/a.png', '/tmp/b.jpeg', '/tmp/c.webp'],
        error: null
      })
    })

    it('filters unsupported formats with the format error message', () => {
      expect(
        applyDroppedBlackboardImages([], ['/tmp/a.png', '/tmp/vector.svg', '/tmp/notes.txt'])
      ).toEqual({
        paths: ['/tmp/a.png'],
        error: 'Blackboard supports PNG, JPEG, WebP, GIF, and BMP images.'
      })
    })

    it('deduplicates against the existing tray and within the drop', () => {
      expect(applyDroppedBlackboardImages(['/tmp/a.png'], ['/tmp/a.png', '/tmp/a.png'])).toEqual({
        paths: ['/tmp/a.png'],
        error: null
      })
    })

    it('caps the tray at the max attachment limit with the overflow error', () => {
      const applied = applyDroppedBlackboardImages(['/tmp/full.png'], [
        '/tmp/1.png',
        '/tmp/2.png',
        '/tmp/3.png',
        '/tmp/4.png',
        '/tmp/5.png'
      ])
      expect(applied.paths).toHaveLength(4)
      expect(applied.error).toContain('at most 4 images')
    })
  })
})
