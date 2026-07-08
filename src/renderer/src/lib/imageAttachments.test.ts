import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_IMAGE_ATTACHMENTS,
  attachmentQueueKey,
  attachmentSummary,
  collectClipboardAttachmentPaths,
  collectDroppedAttachmentPaths,
  dataTransferHasFiles,
  dedupePaths,
  getImageName,
  getImagePreviewSrc,
  hasAttachmentPromptContent,
  imagePreviewDataUrlToThumbnail,
  isPdfAttachmentPath,
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

  it('detects PDFs separately from native image attachments', () => {
    expect(isPdfAttachmentPath('/tmp/spec.pdf')).toBe(true)
    expect(isPdfAttachmentPath('/tmp/spec.PDF?download=1')).toBe(true)
    expect(isPdfAttachmentPath('/tmp/spec.png')).toBe(false)
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

  it('treats non-empty attachments as sendable prompt content', () => {
    expect(hasAttachmentPromptContent('   ', [])).toBe(false)
    expect(
      hasAttachmentPromptContent('   ', [{ id: 'a', path: '/tmp/screen.png', name: 'screen.png' }])
    ).toBe(true)
    expect(hasAttachmentPromptContent('Inspect this', [])).toBe(true)
  })

  it('builds stable attachment summaries and queue keys', () => {
    const attachments = [
      { id: 'b', path: '/tmp/B.png', name: 'B.png' },
      { id: 'a', path: '/tmp/a.png', name: 'a.png' }
    ]

    expect(attachmentSummary(attachments)).toBe('Attached 2 files: B.png, a.png')
    expect(attachmentQueueKey(attachments)).toBe('/tmp/B.png\n/tmp/a.png')
  })

  it('parses bounded raster preview data URLs for transcript thumbnails', () => {
    expect(imagePreviewDataUrlToThumbnail('data:image/png;base64,QUJD')).toEqual({
      mimeType: 'image/png',
      dataBase64: 'QUJD'
    })
    expect(imagePreviewDataUrlToThumbnail('data:image/svg+xml;base64,PHN2Zz4=')).toBeUndefined()
    expect(imagePreviewDataUrlToThumbnail('file:///tmp/screen.png')).toBeUndefined()
  })

  it('ignores clipboard filenames that are not readable local paths', () => {
    const clipboard = {
      files: { length: 1, item: () => ({ name: 'screenshot.png' }) },
      getData: () => '',
      items: []
    } as unknown as DataTransfer

    expect(collectClipboardAttachmentPaths(clipboard)).toEqual([])
  })

  it('keeps clipboard files only when Electron exposes a real local path', () => {
    const clipboard = {
      files: { length: 1, item: () => ({ name: 'screenshot.png', path: '/tmp/screenshot.png' }) },
      getData: () => '',
      items: []
    } as unknown as DataTransfer

    expect(collectClipboardAttachmentPaths(clipboard)).toEqual(['/tmp/screenshot.png'])
  })
})

describe('dropped file path resolution (Electron 39 File.path removal)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('resolves a dropped file path via the webUtils preload bridge when File.path is absent', () => {
    // Electron 32+ dropped Files carry no `.path`; the path comes from
    // window.api.getPathForFile (webUtils.getPathForFile in the preload).
    vi.stubGlobal('window', {
      api: {
        getPathForFile: (file: { name?: string }) =>
          file?.name === 'dropped.png' ? '/tmp/dropped.png' : ''
      }
    })
    const dataTransfer = {
      files: { length: 1, item: () => ({ name: 'dropped.png' }) },
      getData: () => '',
      items: []
    } as unknown as DataTransfer

    expect(collectDroppedAttachmentPaths(dataTransfer)).toEqual(['/tmp/dropped.png'])
  })

  it('collects nothing when neither File.path nor the preload bridge yields a path', () => {
    vi.stubGlobal('window', { api: { getPathForFile: () => '' } })
    const dataTransfer = {
      files: { length: 1, item: () => ({ name: 'dropped.png' }) },
      getData: () => '',
      items: []
    } as unknown as DataTransfer

    expect(collectDroppedAttachmentPaths(dataTransfer)).toEqual([])
  })

  it('honours a present File.path without invoking the bridge', () => {
    const getPathForFile = vi.fn(() => '/should/not/be/used.png')
    vi.stubGlobal('window', { api: { getPathForFile } })
    const dataTransfer = {
      files: { length: 1, item: () => ({ name: 'legacy.png', path: '/tmp/legacy.png' }) },
      getData: () => '',
      items: []
    } as unknown as DataTransfer

    expect(collectDroppedAttachmentPaths(dataTransfer)).toEqual(['/tmp/legacy.png'])
    expect(getPathForFile).not.toHaveBeenCalled()
  })
})

describe('dataTransferHasFiles (drag-over file detection in protected mode)', () => {
  it('detects an OS file drag from the `Files` type', () => {
    expect(dataTransferHasFiles({ types: ['Files'], items: [] } as unknown as DataTransfer)).toBe(
      true
    )
  })

  it('detects files from item.kind when the types list is empty', () => {
    expect(
      dataTransferHasFiles({ types: [], items: [{ kind: 'file' }] } as unknown as DataTransfer)
    ).toBe(true)
  })

  it('ignores internal app drags that carry only custom MIME types', () => {
    expect(
      dataTransferHasFiles({
        types: ['application/x-taskwraith-chat-id'],
        items: [{ kind: 'string' }]
      } as unknown as DataTransfer)
    ).toBe(false)
  })

  it('is null-safe', () => {
    expect(dataTransferHasFiles(null)).toBe(false)
    expect(dataTransferHasFiles(undefined)).toBe(false)
  })
})
