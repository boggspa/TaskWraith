import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import {
  ComposerVoiceInputButton,
  ComposerVoiceWaveform,
  appendComposerVoiceTranscript,
  encodeComposerVoiceWav,
  formatComposerVoiceElapsed
} from './ComposerVoiceInput'

describe('ComposerVoiceInput helpers', () => {
  it('normalizes dictated text before appending it to the composer draft', () => {
    expect(appendComposerVoiceTranscript('', '  Hello   world  ')).toBe('Hello world')
    expect(appendComposerVoiceTranscript('Existing', 'next phrase')).toBe('Existing next phrase')
    expect(appendComposerVoiceTranscript('Existing ', 'next phrase')).toBe(
      'Existing next phrase'
    )
    expect(appendComposerVoiceTranscript('Existing', '   ')).toBe('Existing')
  })

  it('formats elapsed recording time as m:ss', () => {
    expect(formatComposerVoiceElapsed(0)).toBe('0:00')
    expect(formatComposerVoiceElapsed(9_999)).toBe('0:09')
    expect(formatComposerVoiceElapsed(65_250)).toBe('1:05')
  })

  it('encodes native dictation samples as mono PCM WAV', () => {
    const wav = encodeComposerVoiceWav([new Float32Array([-1, 0, 1])], 16_000)
    expect(wav).not.toBeNull()
    const data = wav!
    const header = String.fromCharCode(...data.slice(0, 4))
    const format = String.fromCharCode(...data.slice(8, 12))
    const view = new DataView(data.buffer)

    expect(header).toBe('RIFF')
    expect(format).toBe('WAVE')
    expect(view.getUint16(20, true)).toBe(1)
    expect(view.getUint16(22, true)).toBe(1)
    expect(view.getUint32(24, true)).toBe(16_000)
    expect(view.getUint16(34, true)).toBe(16)
    expect(view.getUint32(40, true)).toBe(6)
    expect(view.getInt16(44, true)).toBe(-32768)
    expect(view.getInt16(46, true)).toBe(0)
    expect(view.getInt16(48, true)).toBe(32767)
  })
})

describe('ComposerVoiceInput markup', () => {
  it('renders the voice control as a composer control satellite', () => {
    const html = renderToStaticMarkup(
      <ComposerVoiceInputButton
        onCaptureStateChange={vi.fn()}
        onTranscript={vi.fn()}
      />
    )

    expect(html).toContain('data-composer-control="voice"')
    expect(html).toContain('composer-voice-btn')
    expect(html).toContain('composer-voice-chevron')
    expect(html).toContain('aria-label="Start voice dictation"')
    expect(html).toContain('aria-label="Select microphone"')
  })

  it('renders a clipped waveform strip with elapsed time', () => {
    const html = renderToStaticMarkup(
      <ComposerVoiceWaveform elapsedMs={14_000} levels={[0, 0.4, 0.8]} />
    )

    expect(html).toContain('composer-voice-overlay')
    expect(html).toContain('composer-voice-waveform-window')
    expect(html.match(/composer-voice-waveform-bar/g)?.length).toBe(3)
    expect(html).toContain('0:14')
  })
})
