import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { WaveformAudioPlayer } from './WaveformAudioPlayer'

// SSR-render assertions (no effects run) — they pin the fallback-chain SELECTION
// and the inline-player parity. The `pausedSignal` effect itself drives an
// imperative `audio.pause()` (not markup) and is verified by inspection; these
// tests guarantee it never changes the rendered output of the inline player.
const SRC = 'twmedia://asset/hash.wav'

describe('WaveformAudioPlayer', () => {
  it('renders the canvas DAW waveform when peaks are present', () => {
    const html = renderToStaticMarkup(
      <WaveformAudioPlayer src={SRC} peaks={[10, 200, 90, 255]} durationMs={5000} name="voice" />
    )
    expect(html).toContain('tw-wave-player')
    expect(html).toContain('is-canvas')
    expect(html).toContain('tw-wave-canvas')
    // Playback rides a headless <audio> (the canvas is the UI) — NOT native controls.
    expect(html).toContain('tw-wave-audio-el')
    expect(html).not.toContain('tw-wave-audio-plain')
  })

  it('falls back to the poster waveform strip when peaks are absent but a poster is present', () => {
    const html = renderToStaticMarkup(
      <WaveformAudioPlayer src={SRC} posterSrc="data:image/jpeg;base64,AAAA" name="voice" />
    )
    expect(html).toContain('tw-wave-player')
    expect(html).toContain('is-poster')
    expect(html).toContain('tw-wave-poster')
    expect(html).not.toContain('tw-wave-audio-plain')
  })

  it('falls back to a plain <audio controls> when neither peaks nor poster are present', () => {
    const html = renderToStaticMarkup(<WaveformAudioPlayer src={SRC} name="voice" />)
    expect(html).toContain('tw-wave-audio-plain')
    expect(html).toContain('controls')
    expect(html).not.toContain('is-canvas')
  })

  it('renders the inline player byte-identically whether pausedSignal is omitted or set (canvas path)', () => {
    const base = renderToStaticMarkup(<WaveformAudioPlayer src={SRC} peaks={[5, 250]} name="voice" />)
    const withSignal = renderToStaticMarkup(
      <WaveformAudioPlayer src={SRC} peaks={[5, 250]} name="voice" pausedSignal={true} />
    )
    expect(withSignal).toBe(base)
  })

  it('renders the plain fallback byte-identically with pausedSignal set', () => {
    const base = renderToStaticMarkup(<WaveformAudioPlayer src={SRC} name="voice" />)
    const withSignal = renderToStaticMarkup(
      <WaveformAudioPlayer src={SRC} name="voice" pausedSignal={true} />
    )
    expect(withSignal).toBe(base)
  })
})
