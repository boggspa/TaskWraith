import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import {
  ComposerVoiceInputButton,
  ComposerVoiceWaveform,
  appendComposerVoiceTranscript,
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
