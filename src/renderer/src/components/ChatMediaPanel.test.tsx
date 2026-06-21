import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../../../main/store/types'
import {
  ChatMediaPreviewOverlay,
  ChatMessageMediaStrip,
  collectMessageMediaRefs,
  type ChatMediaRef
} from './ChatMediaPanel'

function userMessage(metadata: ChatMessage['metadata']): ChatMessage {
  return {
    id: 'message-1',
    role: 'user',
    content: 'Please inspect these.',
    timestamp: '2026-06-03T18:00:00Z',
    metadata
  }
}

describe('ChatMediaPanel attachment rendering', () => {
  it('orders message media with image thumbnails before file cards', () => {
    const refs = collectMessageMediaRefs(
      userMessage({
        imageAttachments: [
          { id: 'file-1', path: '/repo/README.md', name: 'README.md' },
          { id: 'image-1', path: '/repo/screen.png', name: 'screen.png' }
        ]
      })
    )

    expect(refs.map((ref) => ref.kind)).toEqual(['image', 'file'])
    expect(refs.map((ref) => ref.name)).toEqual(['screen.png', 'README.md'])
  })

  it('renders image refs as lazy thumbnail buttons and file refs as copy-path cards', () => {
    const refs: ChatMediaRef[] = [
      {
        id: 'image-1',
        kind: 'image',
        source: 'upload',
        name: 'screen.png',
        path: '/repo/screen.png'
      },
      {
        id: 'file-1',
        kind: 'file',
        source: 'upload',
        name: 'README.md',
        path: '/repo/README.md'
      }
    ]
    const html = renderToStaticMarkup(
      <ChatMessageMediaStrip refs={refs} workspacePath="/repo" onPreviewImage={() => {}} />
    )

    expect(html).toContain('message-attachment-thumb is-image')
    expect(html).toContain('aria-label="Preview image screen.png"')
    expect(html).toContain('loading="lazy"')
    expect(html).toContain('decoding="async"')
    expect(html).toContain('is-file')
    expect(html).toContain('title="Copy README.md path"')
    expect(html.indexOf('Preview image screen.png')).toBeLessThan(html.indexOf('README.md'))
  })

  it('renders canonical pathless media refs from safe thumbnails', () => {
    const refs = collectMessageMediaRefs(
      userMessage({
        mediaRefs: [
          {
            id: 'media-1',
            kind: 'image',
            format: 'raster',
            source: 'tool_result',
            name: 'Tool image',
            mimeType: 'image/png',
            assetId: 'tool-image:abc',
            thumbnail: {
              dataBase64: 'thumb',
              mimeType: 'image/jpeg',
              width: 2,
              height: 1
            },
            status: 'available'
          }
        ]
      })
    )
    const html = renderToStaticMarkup(
      <ChatMessageMediaStrip refs={refs} workspacePath="/repo" onPreviewImage={() => {}} />
    )

    expect(refs[0].path).toBe('')
    expect(html).toContain('message-attachment-thumb is-image')
    expect(html).toContain('src="data:image/jpeg;base64,thumb"')
    expect(html).toContain('aria-label="Preview image Tool image"')
    expect(html).not.toContain('file://')
  })

  it('renders unsafe canonical image refs as inert fallback cards', () => {
    const refs = collectMessageMediaRefs(
      userMessage({
        mediaRefs: [
          {
            id: 'media-unsafe',
            kind: 'image',
            format: 'svg',
            source: 'tool_result',
            name: 'SVG output',
            mimeType: 'image/svg+xml',
            status: 'unsafe_svg'
          }
        ]
      })
    )
    const html = renderToStaticMarkup(<ChatMessageMediaStrip refs={refs} workspacePath="/repo" />)

    expect(html).toContain('SVG preview disabled')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('image/svg+xml')
  })

  it('falls back to an icon when an image path cannot produce a preview URL', () => {
    const html = renderToStaticMarkup(
      <ChatMessageMediaStrip
        refs={[
          {
            id: 'relative-image',
            kind: 'image',
            source: 'upload',
            name: 'relative.png',
            path: 'relative.png'
          }
        ]}
      />
    )

    expect(html).toContain('message-attachment-card is-file is-image-fallback')
    expect(html).toContain('message-attachment-icon')
    expect(html).toContain('relative.png')
    expect(html).not.toContain('<img')
  })

  it('renders an in-app preview overlay with copy, open, and close actions', () => {
    const html = renderToStaticMarkup(
      <ChatMediaPreviewOverlay
        mediaRef={{
          id: 'image-1',
          kind: 'image',
          source: 'upload',
          name: 'screen.png',
          path: '/repo/screen.png'
        }}
        workspacePath="/repo"
        onClose={() => {}}
      />
    )

    expect(html).toContain('chat-media-preview-backdrop')
    expect(html).toContain('role="dialog"')
    expect(html).toContain('screen.png')
    expect(html).toContain('Copy path')
    expect(html).toContain('Open file')
    expect(html).toContain('Close')
  })
})
