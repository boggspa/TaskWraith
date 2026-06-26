import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MediaPane } from './MediaPane'
import type { MultiviewPaneMediaRef } from '../../../shared/multiviewLayouts'

const noop = (): void => {}

describe('MediaPane', () => {
  it('renders an audio ref through the WaveformAudioPlayer over twmedia://', () => {
    const ref: MultiviewPaneMediaRef = {
      id: 'a1',
      kind: 'audio',
      name: 'voice.wav',
      sha256: 'audioHash_abcdefghijklmnopqrstuvwxyz0123456789-XYZ0000',
      mimeType: 'audio/wav',
      peaks: [10, 200, 90, 255]
    }
    const html = renderToStaticMarkup(<MediaPane mediaRef={ref} onClose={noop} />)
    // The audio path reuses the existing canvas DAW player (peaks present).
    expect(html).toContain('tw-wave-player')
    expect(html).toContain('tw-wave-canvas')
    expect(html).toContain(
      'src="twmedia://asset/audioHash_abcdefghijklmnopqrstuvwxyz0123456789-XYZ0000.wav"'
    )
    // Audio is NOT wrapped in the 16:9 video frame.
    expect(html).not.toContain('media-pane-video-frame')
    // Toolbar name + close affordance.
    expect(html).toContain('media-pane-toolbar')
    expect(html).toContain('voice.wav')
    expect(html).toContain('aria-label="Close voice.wav"')
  })

  it('renders a video ref in the 16:9 frame with a <video> over twmedia://', () => {
    const ref: MultiviewPaneMediaRef = {
      id: 'v1',
      kind: 'video',
      name: 'clip.mp4',
      sha256: 'videoHash_abcdefghijklmnopqrstuvwxyz0123456789-XYZ0000',
      mimeType: 'video/mp4',
      thumbnail: { dataBase64: 'AAAA', mimeType: 'image/jpeg' }
    }
    const html = renderToStaticMarkup(<MediaPane mediaRef={ref} onClose={noop} />)
    expect(html).toContain('media-pane-video-frame')
    expect(html).toContain('<video')
    expect(html).toContain('controls')
    expect(html).toContain(
      'src="twmedia://asset/videoHash_abcdefghijklmnopqrstuvwxyz0123456789-XYZ0000.mp4"'
    )
    // The thumbnail becomes a data: poster.
    expect(html).toContain('poster="data:image/jpeg;base64,AAAA"')
    // No audio waveform for a video ref.
    expect(html).not.toContain('tw-wave-player')
  })

  it('shows the "Media unavailable" fallback when no twmedia URL can be built', () => {
    // Missing sha256 → twMediaUrl returns null → fallback (no player, no <video>).
    const ref: MultiviewPaneMediaRef = {
      id: 'x1',
      kind: 'video',
      name: 'orphan.mov',
      mimeType: 'video/quicktime'
    }
    const html = renderToStaticMarkup(<MediaPane mediaRef={ref} onClose={noop} />)
    expect(html).toContain('media-pane-unavailable')
    expect(html).toContain('Media unavailable')
    expect(html).not.toContain('<video')
    expect(html).not.toContain('tw-wave-player')
    // The toolbar (name + close) still renders so the empty pane is closable.
    expect(html).toContain('orphan.mov')
    expect(html).toContain('media-pane-close')
  })
})
