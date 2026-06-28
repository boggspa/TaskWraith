import { describe, expect, it } from 'vitest'
import {
  MAX_IMAGE_ATTACHMENTS,
  dedupePaths,
  getImageName,
  getImagePreviewSrc,
  mergeImageAttachments,
  sanitizeImagePath
} from './imageAttachments'

describe('image attachment path helpers', () => {
  it('normalizes Windows file URIs for provider payloads and previews', () => {
    expect(sanitizeImagePath('file:///C:/Users/chris/Pictures/capture.png')).toBe(
      'C:/Users/chris/Pictures/capture.png'
    )
    expect(getImageName('file:///C:/Users/chris/Pictures/capture.png')).toBe('capture.png')
    expect(getImagePreviewSrc('C:\\Users\\chris\\Pictures\\capture.png')).toBe(
      'file:///C:/Users/chris/Pictures/capture.png'
    )
  })

  it('dedupes Windows drive paths case-insensitively', () => {
    expect(dedupePaths(['C:/Temp/Capture.png', 'c:/temp/capture.png'])).toEqual([
      'C:/Temp/Capture.png'
    ])
  })

  it('keeps the newest 15 composer attachments', () => {
    const attachments = Array.from({ length: 20 }, (_, index) => ({
      id: `attachment-${index}`,
      path: `/tmp/attachment-${index}.png`,
      name: `attachment-${index}.png`
    }))

    const merged = mergeImageAttachments([], attachments)

    expect(MAX_IMAGE_ATTACHMENTS).toBe(15)
    expect(merged).toHaveLength(15)
    expect(merged[0].id).toBe('attachment-5')
    expect(merged[14].id).toBe('attachment-19')
  })
})
