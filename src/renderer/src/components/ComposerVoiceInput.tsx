import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CSSProperties, JSX } from 'react'
import type { ComposerStyle, ProviderId } from '../../../main/store/types'
import { MicrophoneSymbolIcon, StopSymbolIcon } from './AppChromeSymbols'

const VOICE_LEVEL_COUNT = 96
const EMPTY_LEVELS = Array.from({ length: VOICE_LEVEL_COUNT }, () => 0)
const DEFAULT_AUDIO_DEVICE_ID = 'default'
const VOICE_PICKER_WIDTH = 260

type SpeechRecognitionErrorCode =
  | 'aborted'
  | 'audio-capture'
  | 'bad-grammar'
  | 'language-not-supported'
  | 'network'
  | 'no-speech'
  | 'not-allowed'
  | 'phrases-not-supported'
  | 'service-not-allowed'

type SpeechRecognitionResultListLike = {
  length: number
  item(index: number): SpeechRecognitionResultLike
  [index: number]: SpeechRecognitionResultLike
}

type SpeechRecognitionResultLike = {
  isFinal: boolean
  length: number
  item(index: number): SpeechRecognitionAlternativeLike
  [index: number]: SpeechRecognitionAlternativeLike
}

type SpeechRecognitionAlternativeLike = {
  transcript: string
}

type SpeechRecognitionEventLike = Event & {
  resultIndex: number
  results: SpeechRecognitionResultListLike
}

type SpeechRecognitionErrorEventLike = Event & {
  error?: SpeechRecognitionErrorCode
  message?: string
}

type SpeechRecognitionLike = EventTarget & {
  continuous: boolean
  interimResults: boolean
  lang: string
  onend: ((event: Event) => void) | null
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null
  onresult: ((event: SpeechRecognitionEventLike) => void) | null
  start: () => void
  stop: () => void
  abort: () => void
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike

type AudioContextConstructor = new () => AudioContext

export interface ComposerVoiceCaptureState {
  isRecording: boolean
  elapsedMs: number
  levels: number[]
  message: string | null
}

export interface ComposerVoiceInputDevice {
  deviceId: string
  label: string
}

export const EMPTY_COMPOSER_VOICE_CAPTURE_STATE: ComposerVoiceCaptureState = {
  isRecording: false,
  elapsedMs: 0,
  levels: EMPTY_LEVELS,
  message: null
}

interface ComposerVoiceInputButtonProps {
  composerStyle?: ComposerStyle
  disabled?: boolean
  onCaptureStateChange: (state: ComposerVoiceCaptureState) => void
  onTranscript: (transcript: string) => void
  provider?: ProviderId
}

interface ComposerVoiceWaveformProps {
  elapsedMs: number
  levels: number[]
  message?: string | null
}

function getSpeechRecognitionConstructor(): SpeechRecognitionConstructor | null {
  const candidate = window as typeof window & {
    SpeechRecognition?: SpeechRecognitionConstructor
    webkitSpeechRecognition?: SpeechRecognitionConstructor
  }
  return candidate.SpeechRecognition || candidate.webkitSpeechRecognition || null
}

function getAudioContextConstructor(): AudioContextConstructor | null {
  const candidate = window as typeof window & {
    webkitAudioContext?: AudioContextConstructor
  }
  return window.AudioContext || candidate.webkitAudioContext || null
}

function normalizeAudioDeviceId(deviceId: string | null | undefined): string {
  return deviceId && deviceId.trim() ? deviceId : DEFAULT_AUDIO_DEVICE_ID
}

function labelAudioInputDevice(device: MediaDeviceInfo, index: number): string {
  if (device.label.trim()) return device.label.trim()
  return index === 0 ? 'Default microphone' : `Microphone ${index + 1}`
}

function audioConstraintsForDevice(deviceId: string): MediaTrackConstraints {
  const normalizedDeviceId = normalizeAudioDeviceId(deviceId)
  return {
    ...(normalizedDeviceId !== DEFAULT_AUDIO_DEVICE_ID
      ? { deviceId: { exact: normalizedDeviceId } }
      : {}),
    autoGainControl: true,
    echoCancellation: true,
    noiseSuppression: true
  }
}

function levelFromTimeDomain(data: Uint8Array): number {
  if (data.length === 0) return 0
  let sum = 0
  for (const value of data) {
    const centered = (value - 128) / 128
    sum += centered * centered
  }
  return Math.min(1, Math.sqrt(sum / data.length) * 3.5)
}

function recognitionErrorMessage(error?: SpeechRecognitionErrorCode): string {
  if (error === 'not-allowed' || error === 'service-not-allowed') {
    return 'Microphone permission denied.'
  }
  if (error === 'audio-capture') return 'No microphone input was available.'
  if (error === 'network') return 'Dictation service unavailable.'
  if (error === 'language-not-supported') return 'Dictation language is not supported.'
  if (error === 'no-speech' || error === 'aborted') return ''
  return 'Dictation stopped before text was captured.'
}

function getMediaErrorMessage(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError' || error.name === 'SecurityError') {
      return 'Microphone permission denied.'
    }
    if (error.name === 'NotFoundError' || error.name === 'OverconstrainedError') {
      return 'Selected microphone is unavailable.'
    }
    if (error.name === 'NotReadableError') return 'Microphone is already in use.'
  }
  return error instanceof Error ? error.message : 'Could not start microphone capture.'
}

async function stopStream(stream: MediaStream | null | undefined): Promise<void> {
  for (const track of stream?.getTracks() || []) {
    track.stop()
  }
}

export function appendComposerVoiceTranscript(prompt: string, transcript: string): string {
  const cleanTranscript = transcript.replace(/\s+/g, ' ').trim()
  if (!cleanTranscript) return prompt
  if (!prompt.trim()) return cleanTranscript
  if (/\s$/.test(prompt)) return `${prompt}${cleanTranscript}`
  return `${prompt} ${cleanTranscript}`
}

export function formatComposerVoiceElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

export function ComposerVoiceWaveform({
  elapsedMs,
  levels,
  message
}: ComposerVoiceWaveformProps): JSX.Element {
  const visibleLevels = levels.length > 0 ? levels : EMPTY_LEVELS
  return (
    <div className="composer-voice-overlay" aria-live="polite">
      <div className="composer-voice-waveform-window" aria-hidden="true">
        <div className="composer-voice-waveform">
          {visibleLevels.map((level, index) => (
            <span
              key={`${index}-${Math.round(level * 100)}`}
              className="composer-voice-waveform-bar"
              style={{ height: `${Math.max(2, 3 + level * 28).toFixed(2)}px` } as CSSProperties}
            />
          ))}
        </div>
      </div>
      <span className="composer-voice-elapsed">{formatComposerVoiceElapsed(elapsedMs)}</span>
      {message ? <span className="composer-voice-status">{message}</span> : null}
    </div>
  )
}

export function ComposerVoiceInputButton({
  composerStyle = 'default',
  disabled = false,
  onCaptureStateChange,
  onTranscript,
  provider = 'codex'
}: ComposerVoiceInputButtonProps): JSX.Element {
  const [state, setState] = useState<ComposerVoiceCaptureState>(EMPTY_COMPOSER_VOICE_CAPTURE_STATE)
  const [isStarting, setIsStarting] = useState(false)
  const [isMenuOpen, setIsMenuOpen] = useState(false)
  const [isLoadingDevices, setIsLoadingDevices] = useState(false)
  const [devices, setDevices] = useState<ComposerVoiceInputDevice[]>([])
  const [selectedDeviceId, setSelectedDeviceId] = useState(DEFAULT_AUDIO_DEVICE_ID)
  const [menuPosition, setMenuPosition] = useState<{ left: number; top: number } | null>(null)
  const controlRef = useRef<HTMLSpanElement | null>(null)
  const chevronRef = useRef<HTMLButtonElement | null>(null)
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null)
  const animationFrameRef = useRef<number | null>(null)
  const elapsedTimerRef = useRef<number | null>(null)
  const recordingStartedAtRef = useRef(0)
  const finalTranscriptRef = useRef('')
  const interimTranscriptRef = useRef('')
  const stoppingRef = useRef(false)
  const isMountedRef = useRef(true)
  const isRecordingRef = useRef(false)
  const isStartingRef = useRef(false)
  const selectedDeviceIdRef = useRef(DEFAULT_AUDIO_DEVICE_ID)
  const onTranscriptRef = useRef(onTranscript)

  useEffect(() => {
    onTranscriptRef.current = onTranscript
  }, [onTranscript])

  useEffect(() => {
    isRecordingRef.current = state.isRecording
    onCaptureStateChange(state)
  }, [onCaptureStateChange, state])

  useEffect(() => {
    selectedDeviceIdRef.current = selectedDeviceId
  }, [selectedDeviceId])

  const publishState = (patch: Partial<ComposerVoiceCaptureState>): void => {
    setState((current) => ({ ...current, ...patch }))
  }

  const stopVisualCapture = (): void => {
    if (animationFrameRef.current !== null) {
      window.cancelAnimationFrame(animationFrameRef.current)
      animationFrameRef.current = null
    }
    if (elapsedTimerRef.current !== null) {
      window.clearInterval(elapsedTimerRef.current)
      elapsedTimerRef.current = null
    }
    void stopStream(streamRef.current)
    streamRef.current = null
    analyserRef.current = null
    const audioContext = audioContextRef.current
    audioContextRef.current = null
    if (audioContext && audioContext.state !== 'closed') {
      void audioContext.close().catch(() => {})
    }
  }

  const commitTranscript = (): void => {
    const transcript = `${finalTranscriptRef.current} ${interimTranscriptRef.current}`.trim()
    if (transcript) onTranscriptRef.current(transcript)
  }

  const finishRecording = (message: string | null = null): void => {
    if (!isRecordingRef.current && !streamRef.current && !recognitionRef.current) return
    commitTranscript()
    stopVisualCapture()
    recognitionRef.current = null
    stoppingRef.current = false
    isRecordingRef.current = false
    finalTranscriptRef.current = ''
    interimTranscriptRef.current = ''
    setIsStarting(false)
    isStartingRef.current = false
    setState({
      isRecording: false,
      elapsedMs: 0,
      levels: EMPTY_LEVELS,
      message
    })
  }

  const refreshDevices = async (options?: { requestPermission?: boolean }): Promise<void> => {
    if (!navigator.mediaDevices?.enumerateDevices) {
      publishState({ message: 'Audio input selection is unavailable in this runtime.' })
      return
    }
    setIsLoadingDevices(true)
    let probeStream: MediaStream | null = null
    try {
      if (options?.requestPermission && navigator.mediaDevices.getUserMedia) {
        probeStream = await navigator.mediaDevices.getUserMedia({ audio: true })
      }
      const mediaDevices = await navigator.mediaDevices.enumerateDevices()
      const inputs = mediaDevices
        .filter((device) => device.kind === 'audioinput')
        .map((device, index) => ({
          deviceId: normalizeAudioDeviceId(device.deviceId),
          label: labelAudioInputDevice(device, index)
        }))
      if (!isMountedRef.current) return
      setDevices(inputs)
      if (
        inputs.length > 0 &&
        selectedDeviceIdRef.current !== DEFAULT_AUDIO_DEVICE_ID &&
        !inputs.some((device) => device.deviceId === selectedDeviceIdRef.current)
      ) {
        setSelectedDeviceId(DEFAULT_AUDIO_DEVICE_ID)
      }
      if (inputs.length === 0) publishState({ message: 'No microphone input was available.' })
    } catch (error) {
      if (!isMountedRef.current) return
      publishState({ message: getMediaErrorMessage(error) })
      try {
        const mediaDevices = await navigator.mediaDevices.enumerateDevices()
        if (!isMountedRef.current) return
        setDevices(
          mediaDevices
            .filter((device) => device.kind === 'audioinput')
            .map((device, index) => ({
              deviceId: normalizeAudioDeviceId(device.deviceId),
              label: labelAudioInputDevice(device, index)
            }))
        )
      } catch {
        setDevices([])
      }
    } finally {
      await stopStream(probeStream)
      if (isMountedRef.current) setIsLoadingDevices(false)
    }
  }

  const stopRecording = (): void => {
    if (!isRecordingRef.current && !isStartingRef.current) return
    stoppingRef.current = true
    const recognition = recognitionRef.current
    if (recognition) {
      try {
        recognition.stop()
      } catch {
        finishRecording()
      }
      window.setTimeout(() => {
        if (stoppingRef.current) finishRecording()
      }, 450)
      return
    }
    finishRecording('Dictation is unavailable in this runtime.')
  }

  const updateWaveform = (): void => {
    const analyser = analyserRef.current
    if (!analyser) return
    const data = new Uint8Array(analyser.fftSize)
    analyser.getByteTimeDomainData(data)
    const level = levelFromTimeDomain(data)
    setState((current) => ({
      ...current,
      levels: [...current.levels.slice(1), level]
    }))
    animationFrameRef.current = window.requestAnimationFrame(updateWaveform)
  }

  const startRecording = async (): Promise<void> => {
    if (disabled || isStartingRef.current || isRecordingRef.current) return
    if (!navigator.mediaDevices?.getUserMedia) {
      setState({
        ...EMPTY_COMPOSER_VOICE_CAPTURE_STATE,
        message: 'Microphone capture is unavailable in this runtime.'
      })
      return
    }

    isStartingRef.current = true
    setIsStarting(true)
    publishState({ message: 'Starting microphone...' })

    try {
      stoppingRef.current = false
      finalTranscriptRef.current = ''
      interimTranscriptRef.current = ''

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: audioConstraintsForDevice(selectedDeviceIdRef.current)
      })
      if (!isMountedRef.current || !isStartingRef.current) {
        await stopStream(stream)
        return
      }
      streamRef.current = stream

      const AudioContextCtor = getAudioContextConstructor()
      if (AudioContextCtor) {
        const audioContext = new AudioContextCtor()
        const analyser = audioContext.createAnalyser()
        analyser.fftSize = 256
        audioContext.createMediaStreamSource(stream).connect(analyser)
        audioContextRef.current = audioContext
        analyserRef.current = analyser
      }

      const RecognitionCtor = getSpeechRecognitionConstructor()
      let message: string | null = null
      if (RecognitionCtor) {
        const recognition = new RecognitionCtor()
        recognition.continuous = true
        recognition.interimResults = true
        recognition.lang = navigator.language || 'en-US'
        recognition.onresult = (event) => {
          let interim = ''
          for (let i = event.resultIndex; i < event.results.length; i += 1) {
            const result = event.results[i] || event.results.item(i)
            const alternative = result?.[0] || result?.item(0)
            const text = alternative?.transcript || ''
            if (!text) continue
            if (result.isFinal) {
              finalTranscriptRef.current = `${finalTranscriptRef.current} ${text}`.trim()
            } else {
              interim = `${interim} ${text}`.trim()
            }
          }
          interimTranscriptRef.current = interim
        }
        recognition.onerror = (event) => {
          const nextMessage = recognitionErrorMessage(event.error)
          if (nextMessage) publishState({ message: nextMessage })
          window.setTimeout(() => {
            if (recognitionRef.current === recognition && event.error !== 'aborted') {
              finishRecording(nextMessage || null)
            }
          }, 150)
        }
        recognition.onend = () => {
          finishRecording(stoppingRef.current ? null : 'Dictation stopped.')
        }
        recognitionRef.current = recognition
        recognition.start()
      } else {
        message = 'Waveform only. Dictation is unavailable in this runtime.'
      }

      recordingStartedAtRef.current = Date.now()
      isRecordingRef.current = true
      setIsStarting(false)
      isStartingRef.current = false
      setState({
        isRecording: true,
        elapsedMs: 0,
        levels: EMPTY_LEVELS,
        message
      })
      elapsedTimerRef.current = window.setInterval(() => {
        publishState({ elapsedMs: Date.now() - recordingStartedAtRef.current })
      }, 250)
      if (analyserRef.current) {
        animationFrameRef.current = window.requestAnimationFrame(updateWaveform)
      }
    } catch (error) {
      stopVisualCapture()
      isRecordingRef.current = false
      isStartingRef.current = false
      setIsStarting(false)
      setState({
        ...EMPTY_COMPOSER_VOICE_CAPTURE_STATE,
        message: getMediaErrorMessage(error)
      })
    }
  }

  const handleMenuToggle = (): void => {
    if (disabled || state.isRecording || isStarting) return
    const nextOpen = !isMenuOpen
    setIsMenuOpen(nextOpen)
    if (nextOpen) void refreshDevices({ requestPermission: true })
  }

  useEffect(() => {
    if (!isMenuOpen) {
      setMenuPosition(null)
      return
    }
    const computePosition = (): void => {
      const anchor = chevronRef.current || controlRef.current
      if (!anchor) return
      const rect = anchor.getBoundingClientRect()
      const viewportPadding = 8
      const availableWidth = Math.max(160, window.innerWidth - viewportPadding * 2)
      const popoverWidth = Math.min(VOICE_PICKER_WIDTH, availableWidth)
      const left = Math.max(
        viewportPadding,
        Math.min(window.innerWidth - popoverWidth - viewportPadding, rect.right - popoverWidth)
      )
      setMenuPosition({ left, top: Math.max(viewportPadding, rect.top - 8) })
    }
    let cancelled = false
    queueMicrotask(() => {
      if (!cancelled) computePosition()
    })
    window.addEventListener('scroll', computePosition, true)
    window.addEventListener('resize', computePosition)
    return () => {
      cancelled = true
      window.removeEventListener('scroll', computePosition, true)
      window.removeEventListener('resize', computePosition)
    }
  }, [isMenuOpen])

  useEffect(() => {
    if (!navigator.mediaDevices?.enumerateDevices) return
    void refreshDevices()
    const handleDeviceChange = (): void => {
      void refreshDevices()
    }
    navigator.mediaDevices.addEventListener?.('devicechange', handleDeviceChange)
    return () => {
      navigator.mediaDevices.removeEventListener?.('devicechange', handleDeviceChange)
    }
  }, [])

  useEffect(() => {
    if (!isMenuOpen) return
    const handlePointerDown = (event: MouseEvent): void => {
      const target = event.target as Node
      if (controlRef.current?.contains(target)) return
      if (popoverRef.current?.contains(target)) return
      setIsMenuOpen(false)
    }
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setIsMenuOpen(false)
    }
    document.addEventListener('mousedown', handlePointerDown, true)
    document.addEventListener('keydown', handleKeyDown, true)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown, true)
      document.removeEventListener('keydown', handleKeyDown, true)
    }
  }, [isMenuOpen])

  useEffect(
    () => () => {
      isMountedRef.current = false
      stoppingRef.current = false
      isStartingRef.current = false
      try {
        recognitionRef.current?.abort()
      } catch {
        // Best-effort cleanup only.
      }
      stopVisualCapture()
      onCaptureStateChange(EMPTY_COMPOSER_VOICE_CAPTURE_STATE)
    },
    []
  )

  const title = state.isRecording
    ? 'Stop voice dictation'
    : state.message || 'Voice dictation'
  const selectedDevice = devices.find((device) => device.deviceId === selectedDeviceId)
  const menuDevices =
    devices.length > 0
      ? devices
      : [{ deviceId: DEFAULT_AUDIO_DEVICE_ID, label: 'Default microphone' }]
  const popoverContent =
    isMenuOpen && menuPosition && typeof document !== 'undefined' ? (
      <div
        ref={popoverRef}
        className={`composer-combined-picker-popover composer-voice-menu provider-${provider} shell-${composerStyle}`}
        style={{
          position: 'fixed',
          left: `${menuPosition.left}px`,
          top: `${menuPosition.top}px`,
          transform: 'translateY(-100%)'
        }}
        role="dialog"
        aria-label="Choose audio input"
      >
        <div className="composer-combined-picker-column composer-voice-menu-column">
          <div className="composer-combined-picker-column-header">Audio Input</div>
          {isLoadingDevices && (
            <div className="composer-combined-picker-column-note">Checking microphones...</div>
          )}
          {menuDevices.map((device, index) => {
            const selected = device.deviceId === selectedDeviceId
            return (
              <button
                key={`${device.deviceId}-${index}`}
                type="button"
                className={`composer-combined-picker-row composer-voice-menu-item${selected ? ' is-selected' : ''}`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  setSelectedDeviceId(device.deviceId)
                  setIsMenuOpen(false)
                }}
              >
                <span className="composer-combined-picker-row-label">{device.label}</span>
                {selected && (
                  <span className="composer-combined-picker-check" aria-hidden>
                    {'\u2713'}
                  </span>
                )}
              </button>
            )
          })}
          <div className="composer-combined-picker-column-note composer-voice-menu-note">
            {selectedDevice ? `Using ${selectedDevice.label}` : 'System default microphone'}
          </div>
        </div>
      </div>
    ) : null

  return (
    <>
      <span
        ref={controlRef}
        data-composer-control="voice"
        className={`composer-voice-control${state.isRecording ? ' is-recording' : ''}${isMenuOpen ? ' is-menu-open' : ''}`}
      >
        <button
          type="button"
          className={`composer-action-btn voice-btn composer-voice-btn${state.isRecording ? ' is-recording' : ''}`}
          onClick={() => {
            if (state.isRecording) stopRecording()
            else void startRecording()
          }}
          disabled={(disabled && !state.isRecording) || isStarting}
          title={isStarting ? 'Starting microphone...' : title}
          aria-label={
            state.isRecording
              ? 'Stop voice dictation'
              : isStarting
                ? 'Starting voice dictation'
                : 'Start voice dictation'
          }
          aria-pressed={state.isRecording}
        >
          {state.isRecording ? <StopSymbolIcon /> : <MicrophoneSymbolIcon />}
        </button>
        <button
          ref={chevronRef}
          type="button"
          className="composer-voice-chevron"
          onClick={handleMenuToggle}
          disabled={disabled || state.isRecording || isStarting}
          title="Select microphone"
          aria-label="Select microphone"
          aria-haspopup="dialog"
          aria-expanded={isMenuOpen}
        >
          <span aria-hidden />
        </button>
      </span>
      {popoverContent ? createPortal(popoverContent, document.body) : null}
    </>
  )
}
