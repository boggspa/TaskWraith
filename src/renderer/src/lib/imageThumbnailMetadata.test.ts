import { describe, expect, it } from 'vitest'
import { compactResolvedImageThumbnailMetadata } from './imageThumbnailMetadata'

describe('compactResolvedImageThumbnailMetadata', () => {
  it('retains all successful images when one preview cannot be resolved', () => {
    expect(
      compactResolvedImageThumbnailMetadata(
        [
          { id: 'a', path: '/tmp/a.png', name: 'a.png' },
          { id: 'b', path: '/tmp/b.png', name: 'b.png' },
          { id: 'c', path: '/tmp/c.png', name: 'c.png' }
        ],
        [
          { dataBase64: 'aaa', mimeType: 'image/png' },
          undefined,
          { dataBase64: 'ccc', mimeType: 'image/png' }
        ]
      )
    ).toEqual({
      imagePaths: ['/tmp/a.png', '/tmp/c.png'],
      imageThumbnails: [
        { dataBase64: 'aaa', mimeType: 'image/png' },
        { dataBase64: 'ccc', mimeType: 'image/png' }
      ]
    })
  })
})
