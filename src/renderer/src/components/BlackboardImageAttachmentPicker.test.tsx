import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
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
})
