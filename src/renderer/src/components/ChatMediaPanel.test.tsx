import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../../../main/store/types'
import {
  ChatMediaPreviewOverlay,
  ChatMessageMediaStrip,
  collectChatMediaRefs,
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

  it('renders video refs as clip strips and audio refs as inline players instead of file cards', () => {
    const refs: ChatMediaRef[] = [
      {
        id: 'vid-1',
        kind: 'video',
        source: 'tool_result',
        name: 'clip.mp4',
        path: '',
        mimeType: 'video/mp4',
        sha256: 'abcDEF1234567890_abcdefghijklmnopqrstuvwxyz0123456789-XYZ',
        durationMs: 28000,
        thumbnail: { dataBase64: 'POSTER', mimeType: 'image/jpeg', width: 320, height: 180 }
      },
      {
        id: 'aud-1',
        kind: 'audio',
        source: 'tool_result',
        name: 'render.wav',
        path: '',
        mimeType: 'audio/wav',
        sha256: 'wavHash_abcdefghijklmnopqrstuvwxyz0123456789-XYZ0000'
      }
    ]
    const html = renderToStaticMarkup(<ChatMessageMediaStrip refs={refs} workspacePath="/repo" />)
    expect(html).toContain('tw-video-clip has-poster')
    expect(html).toContain('Preview video clip.mp4')
    expect(html).toContain('0:28')
    expect((html.match(/class="tw-video-clip-frame"/g) ?? []).length).toBe(6)
    expect(html).not.toContain('<video')
    expect(html).toContain('<audio')
    expect(html).toContain('src="twmedia://asset/wavHash_abcdefghijklmnopqrstuvwxyz0123456789-XYZ0000.wav"')
    expect(html).toContain('controls')
    // Did NOT degrade to a generic file chip (the regression S0c fixes).
    expect(html).not.toContain('message-attachment-icon')
  })

  it('shows a "pop out to pane" affordance on AV cards ONLY when onDetachToPane is wired', () => {
    const refs: ChatMediaRef[] = [
      {
        id: 'vid-1',
        kind: 'video',
        source: 'tool_result',
        name: 'clip.mp4',
        path: '',
        mimeType: 'video/mp4',
        sha256: 'abcDEF1234567890_abcdefghijklmnopqrstuvwxyz0123456789-XYZ'
      }
    ]
    const withDetach = renderToStaticMarkup(
      <ChatMessageMediaStrip refs={refs} workspacePath="/repo" onDetachToPane={() => {}} />
    )
    expect(withDetach).toContain('message-attachment-detach')
    expect(withDetach).toContain('Pop clip.mp4 out to a pane')
    // (The "Detach to pane" action-menu item lives in a portal that is closed by
    // default, so it isn't in the static markup — its presence is unit-covered by
    // the buildMediaCardActions assertions below.)

    const withoutDetach = renderToStaticMarkup(
      <ChatMessageMediaStrip refs={refs} workspacePath="/repo" />
    )
    expect(withoutDetach).not.toContain('message-attachment-detach')
  })

  it('renders the DAW waveform canvas (+ a headless <audio>) for an audio ref WITH peaks', () => {
    const refs: ChatMediaRef[] = [
      {
        id: 'aud-peaks',
        kind: 'audio',
        source: 'tool_result',
        name: 'mix.wav',
        path: '',
        mimeType: 'audio/wav',
        sha256: 'peaksHash_abcdefghijklmnopqrstuvwxyz0123456789-XYZ0000',
        peaks: [0, 64, 128, 255, 200, 12, 0]
      }
    ]
    const html = renderToStaticMarkup(<ChatMessageMediaStrip refs={refs} workspacePath="/repo" />)
    // The canvas DAW waveform is the preferred render when peaks are present...
    expect(html).toContain('<canvas')
    expect(html).toContain('tw-wave-canvas')
    expect(html).toContain('tw-wave-player is-canvas')
    // ...and the headless <audio> (no native controls) is still present for playback
    // over twmedia:// (this preserves the existing `<audio` assertion + Range playback).
    expect(html).toContain('<audio')
    expect(html).toContain('src="twmedia://asset/peaksHash_abcdefghijklmnopqrstuvwxyz0123456789-XYZ0000.wav"')
    // The headless element must NOT carry native controls (the canvas is the UI).
    expect(html).not.toContain('tw-wave-audio-plain')
  })

  it('carries peaks through collectMessageMediaRefs onto the ChatMediaRef (no field-drop)', () => {
    const refs = collectMessageMediaRefs(
      userMessage({
        mediaRefs: [
          {
            id: 'aud-1',
            kind: 'audio',
            format: 'container',
            source: 'tool_result',
            name: 'mix.wav',
            mimeType: 'audio/wav',
            sha256: 'peaksHash_abcdefghijklmnopqrstuvwxyz0123456789-XYZ0000',
            peaks: [0, 128, 255],
            status: 'available'
          }
        ]
      } as ChatMessage['metadata'])
    )
    expect(refs).toHaveLength(1)
    expect(refs[0].peaks).toEqual([0, 128, 255])
  })

  it('keeps pathless sha-backed transcript AV refs in chat-level media collection', () => {
    const refs = collectChatMediaRefs(
      {
        messages: [
          userMessage({
            mediaRefs: [
              {
                id: 'generated-video',
                kind: 'video',
                source: 'tool_result',
                name: 'render.mp4',
                mimeType: 'video/mp4',
                sha256: 'vidHash_abcdefghijklmnopqrstuvwxyz0123456789-XYZ0000',
                durationMs: 4200,
                thumbnail: { dataBase64: 'POSTER', mimeType: 'image/jpeg', width: 320, height: 180 },
                status: 'available'
              }
            ]
          } as ChatMessage['metadata'])
        ]
      } as any,
      [],
      []
    )
    expect(refs).toHaveLength(1)
    expect(refs[0]).toMatchObject({
      id: 'generated-video',
      kind: 'video',
      path: '',
      sha256: 'vidHash_abcdefghijklmnopqrstuvwxyz0123456789-XYZ0000',
      durationMs: 4200
    })
    expect(refs[0].thumbnail?.dataBase64).toBe('POSTER')
  })

  it('falls back to the poster waveform strip (no canvas) for an audio ref with a poster but NO peaks', () => {
    const refs: ChatMediaRef[] = [
      {
        id: 'aud-poster',
        kind: 'audio',
        source: 'tool_result',
        name: 'render.wav',
        path: '',
        mimeType: 'audio/wav',
        sha256: 'posterHash_abcdefghijklmnopqrstuvwxyz0123456789-XYZ00',
        thumbnail: { dataBase64: 'POSTER', mimeType: 'image/jpeg', width: 320, height: 80 }
      }
    ]
    const html = renderToStaticMarkup(<ChatMessageMediaStrip refs={refs} workspacePath="/repo" />)
    expect(html).toContain('tw-wave-player is-poster')
    // The poster JPEG is the strip background (Variant A fallback).
    expect(html).toContain('tw-wave-poster')
    expect(html).toContain('src="data:image/jpeg;base64,POSTER"')
    // No peaks → no canvas waveform.
    expect(html).not.toContain('<canvas')
    // Still a headless <audio> for playback, not the plain-control fallback.
    expect(html).toContain('<audio')
    expect(html).not.toContain('tw-wave-audio-plain')
  })

  it('falls back to a plain <audio controls> when an audio ref has neither peaks nor a poster', () => {
    const refs: ChatMediaRef[] = [
      {
        id: 'aud-bare',
        kind: 'audio',
        source: 'tool_result',
        name: 'bare.wav',
        path: '',
        mimeType: 'audio/wav',
        sha256: 'bareHash_abcdefghijklmnopqrstuvwxyz0123456789-XYZ0000'
      }
    ]
    const html = renderToStaticMarkup(<ChatMessageMediaStrip refs={refs} workspacePath="/repo" />)
    // Neither peaks nor poster → the always-playable plain control.
    expect(html).toContain('tw-wave-audio-plain')
    expect(html).toContain('<audio')
    expect(html).toContain('controls')
    expect(html).toContain('src="twmedia://asset/bareHash_abcdefghijklmnopqrstuvwxyz0123456789-XYZ0000.wav"')
    // It is the plain fallback, not the canvas/poster player.
    expect(html).not.toContain('<canvas')
    expect(html).not.toContain('tw-wave-player')
  })

  it('falls back to a file card for an AV ref with no content hash (no twmedia URL)', () => {
    const refs: ChatMediaRef[] = [
      { id: 'vid-x', kind: 'video', source: 'tool_result', name: 'clip.mp4', path: '', mimeType: 'video/mp4' }
    ]
    const html = renderToStaticMarkup(<ChatMessageMediaStrip refs={refs} workspacePath="/repo" />)
    expect(html).not.toContain('<video')
    expect(html).toContain('message-attachment-icon') // the card fallback
  })

  it('carries audio/video kind + sha256 through collectMessageMediaRefs (S0c)', () => {
    const refs = collectMessageMediaRefs(
      userMessage({
        mediaRefs: [
          {
            id: 'vid-1',
            kind: 'video',
            format: 'container',
            source: 'tool_result',
            name: 'clip.mp4',
            mimeType: 'video/mp4',
            sha256: 'abcDEF1234567890_abcdefghijklmnopqrstuvwxyz0123456789-XYZ',
            status: 'available'
          }
        ]
      } as ChatMessage['metadata'])
    )
    expect(refs).toHaveLength(1)
    expect(refs[0].kind).toBe('video')
    expect(refs[0].sha256).toBe('abcDEF1234567890_abcdefghijklmnopqrstuvwxyz0123456789-XYZ')
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

  it('renders legacy phone-upload image thumbnails from message metadata', () => {
    const refs = collectMessageMediaRefs(
      userMessage({
        imagePaths: ['/var/folders/taskwraith-remote-attachments/photo.jpg'],
        imageThumbnails: [
          {
            dataBase64: 'phone-thumb',
            mimeType: 'image/jpeg',
            width: 256,
            height: 192
          }
        ]
      })
    )
    const html = renderToStaticMarkup(
      <ChatMessageMediaStrip refs={refs} workspacePath="/repo" onPreviewImage={() => {}} />
    )

    expect(refs).toHaveLength(1)
    expect(refs[0]).toMatchObject({
      kind: 'image',
      source: 'upload',
      name: 'photo.jpg',
      path: '/var/folders/taskwraith-remote-attachments/photo.jpg',
      thumbnail: {
        dataBase64: 'phone-thumb',
        mimeType: 'image/jpeg',
        width: 256,
        height: 192
      }
    })
    expect(html).toContain('message-attachment-thumb is-image')
    expect(html).toContain('src="data:image/jpeg;base64,phone-thumb"')
    expect(html).toContain('aria-label="Preview image photo.jpg"')
  })

  it('keeps extra phone-upload paths when only the first thumbnails are available', () => {
    const refs = collectMessageMediaRefs(
      userMessage({
        imagePaths: [
          '/var/folders/taskwraith-remote-attachments/one.jpg',
          '/var/folders/taskwraith-remote-attachments/two.jpg',
          '/var/folders/taskwraith-remote-attachments/three.jpg'
        ],
        imageThumbnails: [
          { dataBase64: 'thumb-one', mimeType: 'image/jpeg', width: 2, height: 1 },
          { dataBase64: 'thumb-two', mimeType: 'image/jpeg', width: 2, height: 1 }
        ]
      })
    )
    const html = renderToStaticMarkup(
      <ChatMessageMediaStrip refs={refs} workspacePath="/repo" onPreviewImage={() => {}} />
    )

    expect(refs).toHaveLength(3)
    expect(refs[0].thumbnail?.dataBase64).toBe('thumb-one')
    expect(refs[1].thumbnail?.dataBase64).toBe('thumb-two')
    expect(refs[2].thumbnail).toBeUndefined()
    expect(html).toContain('src="data:image/jpeg;base64,thumb-one"')
    expect(html).toContain('src="data:image/jpeg;base64,thumb-two"')
    expect(html).toContain('src="file:///var/folders/taskwraith-remote-attachments/three.jpg"')
  })

  it('ignores malformed legacy thumbnail records without dropping image paths', () => {
    const refs = collectMessageMediaRefs(
      userMessage({
        imagePaths: ['/var/folders/taskwraith-remote-attachments/photo.jpg'],
        imageThumbnails: [{ dataBase64: '', mimeType: 'image/jpeg' }]
      })
    )
    const html = renderToStaticMarkup(
      <ChatMessageMediaStrip refs={refs} workspacePath="/repo" onPreviewImage={() => {}} />
    )

    expect(refs).toHaveLength(1)
    expect(refs[0].thumbnail).toBeUndefined()
    expect(html).not.toContain('data:image/jpeg;base64')
    expect(html).toContain('src="file:///var/folders/taskwraith-remote-attachments/photo.jpg"')
  })

  it('dedupes dual-written legacy image paths and canonical upload media refs', () => {
    const refs = collectMessageMediaRefs(
      userMessage({
        imagePaths: ['/var/folders/taskwraith-remote-attachments/photo.jpg'],
        imageThumbnails: [
          {
            dataBase64: 'legacy-thumb',
            mimeType: 'image/jpeg',
            width: 2,
            height: 1
          }
        ],
        mediaRefs: [
          {
            id: 'canonical-upload',
            kind: 'image',
            format: 'raster',
            source: 'upload',
            name: 'Canonical upload',
            path: '/var/folders/taskwraith-remote-attachments/photo.jpg',
            mimeType: 'image/jpeg',
            thumbnail: {
              dataBase64: 'canonical-thumb',
              mimeType: 'image/jpeg',
              width: 2,
              height: 1
            },
            status: 'available'
          }
        ]
      })
    )

    expect(refs).toHaveLength(1)
    expect(refs[0]).toMatchObject({
      source: 'upload',
      path: '/var/folders/taskwraith-remote-attachments/photo.jpg',
      thumbnail: { dataBase64: 'legacy-thumb' }
    })
  })

  it('renders legacy thumbnail-only metadata when no local path is present', () => {
    const refs = collectMessageMediaRefs(
      userMessage({
        imageThumbnails: [
          {
            dataBase64: 'orphan-thumb',
            mimeType: 'image/jpeg',
            width: 2,
            height: 1
          }
        ]
      })
    )
    const html = renderToStaticMarkup(
      <ChatMessageMediaStrip refs={refs} workspacePath="/repo" onPreviewImage={() => {}} />
    )

    expect(refs).toHaveLength(1)
    expect(refs[0]).toMatchObject({
      id: 'image-thumbnail:message-1:0',
      kind: 'image',
      source: 'upload',
      name: 'Image 1',
      path: '',
      thumbnail: { dataBase64: 'orphan-thumb' }
    })
    expect(html).toContain('message-attachment-thumb is-image')
    expect(html).toContain('src="data:image/jpeg;base64,orphan-thumb"')
    expect(html).toContain('Preview image Image 1')
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

  it('overlay shows a "Detach to pane" footer button for an AV ref ONLY when wired', () => {
    const avRef: ChatMediaRef = {
      id: 'aud-1',
      kind: 'audio',
      source: 'tool_result',
      name: 'render.wav',
      path: '',
      mimeType: 'audio/wav',
      sha256: 'wavHash_abcdefghijklmnopqrstuvwxyz0123456789-XYZ0000'
    }
    const wired = renderToStaticMarkup(
      <ChatMediaPreviewOverlay mediaRef={avRef} onClose={() => {}} onDetachToPane={() => {}} />
    )
    expect(wired).toContain('Detach to pane')

    const unwired = renderToStaticMarkup(
      <ChatMediaPreviewOverlay mediaRef={avRef} onClose={() => {}} />
    )
    expect(unwired).not.toContain('Detach to pane')

    // An IMAGE ref never gets the detach button even when the callback is wired
    // (detaching only makes sense for a playable A/V player).
    const imageWired = renderToStaticMarkup(
      <ChatMediaPreviewOverlay
        mediaRef={{ id: 'img-1', kind: 'image', source: 'upload', name: 'p.png', path: '/p.png' }}
        onClose={() => {}}
        onDetachToPane={() => {}}
      />
    )
    expect(imageWired).not.toContain('Detach to pane')
  })

  it('carries groupKind through collectMessageMediaRefs (no field-drop)', () => {
    const refs = collectMessageMediaRefs(
      userMessage({
        mediaRefs: [
          {
            id: 'frame-1',
            kind: 'image',
            format: 'raster',
            source: 'tool_result',
            name: 'inspect_video_frames image 1',
            mimeType: 'image/png',
            assetId: 'tool-image:f1',
            thumbnail: { dataBase64: 'iVBORw0KGgo=', mimeType: 'image/png' },
            caption: '0:03',
            groupKind: 'video_frames',
            status: 'available'
          }
        ]
      } as ChatMessage['metadata'])
    )
    expect(refs).toHaveLength(1)
    expect(refs[0].groupKind).toBe('video_frames')
    expect(refs[0].caption).toBe('0:03')
  })

  it('groups a CONSECUTIVE run of video_frames refs into ONE filmstrip', () => {
    const frame = (n: number): ChatMediaRef => ({
      id: `frame-${n}`,
      kind: 'image',
      source: 'tool_result',
      name: `frame ${n}`,
      path: '',
      mimeType: 'image/png',
      thumbnail: { dataBase64: 'iVBORw0KGgo=', mimeType: 'image/png' },
      caption: `0:0${n}`,
      groupKind: 'video_frames'
    })
    const refs = [frame(1), frame(2), frame(3)]
    const html = renderToStaticMarkup(
      <ChatMessageMediaStrip refs={refs} workspacePath="/repo" onPreviewImage={() => {}} />
    )
    // Exactly ONE filmstrip container wrapping all three frames.
    expect((html.match(/tw-filmstrip"/g) ?? []).length).toBe(1)
    expect((html.match(/tw-filmstrip-frame/g) ?? []).length).toBe(3)
    // Per-frame timestamp captions are rendered beneath the thumbs.
    expect(html).toContain('tw-filmstrip-label')
    expect(html).toContain('0:01')
    expect(html).toContain('0:03')
    // No standard image-thumb cards were emitted for the grouped frames.
    expect(html).not.toContain('message-attachment-thumb is-image')
  })

  it('renders a filmstrip for the video_frames run AND separate cards for other refs', () => {
    const refs: ChatMediaRef[] = [
      {
        id: 'screenshot-1',
        kind: 'image',
        source: 'upload',
        name: 'screen.png',
        path: '/repo/screen.png'
      },
      {
        id: 'frame-1',
        kind: 'image',
        source: 'tool_result',
        name: 'frame 1',
        path: '',
        mimeType: 'image/png',
        thumbnail: { dataBase64: 'iVBORw0KGgo=', mimeType: 'image/png' },
        caption: '0:00',
        groupKind: 'video_frames'
      },
      {
        id: 'frame-2',
        kind: 'image',
        source: 'tool_result',
        name: 'frame 2',
        path: '',
        mimeType: 'image/png',
        thumbnail: { dataBase64: 'iVBORw0KGgo=', mimeType: 'image/png' },
        caption: '0:05',
        groupKind: 'video_frames'
      },
      {
        id: 'readme-1',
        kind: 'file',
        source: 'upload',
        name: 'README.md',
        path: '/repo/README.md'
      }
    ]
    const html = renderToStaticMarkup(
      <ChatMessageMediaStrip refs={refs} workspacePath="/repo" onPreviewImage={() => {}} />
    )
    // One filmstrip for the two contiguous video_frames refs...
    expect((html.match(/tw-filmstrip"/g) ?? []).length).toBe(1)
    expect((html.match(/tw-filmstrip-frame/g) ?? []).length).toBe(2)
    // ...the standalone upload image renders as a normal thumb card...
    expect(html).toContain('aria-label="Preview image screen.png"')
    // ...and the file ref renders as its own copy-path card.
    expect(html).toContain('README.md')
    expect(html).toContain('is-file')
  })
})
