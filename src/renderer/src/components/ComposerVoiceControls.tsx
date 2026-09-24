import type { JSX, Ref } from 'react'
import type { ComposerStyle } from '../../../main/store/types'
import {
  ClaudeMicrophoneSymbolIcon,
  MicrophoneSymbolIcon,
  StopSymbolIcon
} from './AppChromeSymbols'

interface ComposerVoiceControlsProps {
  composerStyle: ComposerStyle
  controlRef?: Ref<HTMLSpanElement>
  chevronRef?: Ref<HTMLButtonElement>
  disabled?: boolean
  isRecording?: boolean
  isMenuOpen?: boolean
  isStarting?: boolean
  isTranscribing?: boolean
  title?: string
  onToggleRecording?: () => void
  onToggleMenu?: () => void
}

/** Shared button chrome, with no microphone discovery or capture lifecycle. */
export function ComposerVoiceControls({
  composerStyle,
  controlRef,
  chevronRef,
  disabled = false,
  isRecording = false,
  isMenuOpen = false,
  isStarting = false,
  isTranscribing = false,
  title = 'Voice dictation',
  onToggleRecording,
  onToggleMenu
}: ComposerVoiceControlsProps): JSX.Element {
  return (
    <span
      ref={controlRef}
      data-composer-control="voice"
      className={`composer-voice-control${isRecording ? ' is-recording' : ''}${isMenuOpen ? ' is-menu-open' : ''}`}
    >
      <button
        type="button"
        className={`composer-action-btn voice-btn composer-voice-btn${isRecording ? ' is-recording' : ''}`}
        onClick={onToggleRecording}
        disabled={(disabled && !isRecording) || isStarting || isTranscribing}
        title={isStarting ? 'Starting microphone...' : title}
        aria-label={
          isRecording
            ? 'Stop voice dictation'
            : isStarting
              ? 'Starting voice dictation'
              : isTranscribing
                ? 'Transcribing voice dictation'
                : 'Start voice dictation'
        }
        aria-pressed={isRecording}
      >
        {isRecording ? (
          <StopSymbolIcon />
        ) : composerStyle === 'claude' ? (
          <ClaudeMicrophoneSymbolIcon />
        ) : (
          <MicrophoneSymbolIcon />
        )}
      </button>
      <button
        ref={chevronRef}
        type="button"
        className="composer-voice-chevron"
        onClick={onToggleMenu}
        disabled={disabled || isRecording || isStarting || isTranscribing}
        title="Select microphone"
        aria-label="Select microphone"
        aria-haspopup="dialog"
        aria-expanded={isMenuOpen}
      >
        <span aria-hidden />
      </button>
    </span>
  )
}
