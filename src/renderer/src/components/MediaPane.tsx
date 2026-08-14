import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { MultiviewPaneMediaRef } from '../../../shared/multiviewLayouts'
import { twMediaUrl } from '../../../shared/twMedia'
import { StudioEffectPreviewControl } from './StudioEffectPreviewControl'
import { WaveformAudioPlayer } from './WaveformAudioPlayer'

function thumbnailSrc(mediaRef: MultiviewPaneMediaRef): string | undefined {
  return mediaRef.thumbnail
    ? `data:${mediaRef.thumbnail.mimeType};base64,${mediaRef.thumbnail.dataBase64}`
    : undefined
}

function thumbnailAspectRatio(mediaRef: MultiviewPaneMediaRef): string | undefined {
  const width = mediaRef.thumbnail?.width
  const height = mediaRef.thumbnail?.height
  if (!width || !height || width <= 0 || height <= 0) return undefined
  return `${width} / ${height}`
}

/**
 * MediaPane — a Multiview pane that hosts an audio/video player DETACHED from the
 * transcript message flow (the docked media player). It REUSES the existing
 * transcript players verbatim — `WaveformAudioPlayer` for audio, a `<video>` for
 * video — sourced from `twmedia://` (which already renders in this same window/CSP
 * today, so no new privilege/iframe/protocol). There is NO new player code here.
 *
 * Lifecycle the adversarial reviewer attacks:
 *   - PAUSE-ON-HIDE: an IntersectionObserver on the host pauses a playing `<video>`
 *     when the pane scrolls off-screen, and raises `paused` (fed to the audio
 *     player's `pausedSignal`) so an off-screen audio pane stops too. It never
 *     auto-resumes — the user can always hit play again.
 *   - UNMOUNT RELEASE: closing the pane unmounts MediaPane; the cleanup pauses the
 *     `<video>`, drops its `src`, and calls `load()` so the twmedia Range
 *     connection tears down and playback stops immediately. (Audio stops for free
 *     when its element unmounts.)
 */
export function MediaPane({
  mediaRef,
  onClose
}: {
  mediaRef: MultiviewPaneMediaRef
  onClose: () => void
}): ReactNode {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  // `true` once the pane is off-screen → pause both the video and (via prop) audio.
  const [paused, setPaused] = useState(false)
  const [videoAspectRatio, setVideoAspectRatio] = useState<string | undefined>(() =>
    thumbnailAspectRatio(mediaRef)
  )

  const src = twMediaUrl(mediaRef.sha256, mediaRef.mimeType)
  const poster = thumbnailSrc(mediaRef)

  useEffect(() => {
    setVideoAspectRatio(thumbnailAspectRatio(mediaRef))
  }, [mediaRef.id, mediaRef.thumbnail?.width, mediaRef.thumbnail?.height])

  // PAUSE-ON-HIDE — observe the pane host; pause the <video> when it leaves the
  // viewport and signal the audio player to pause too. Pause-only, never resume.
  useEffect(() => {
    const host = hostRef.current
    if (!host || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) {
            setPaused(true)
            videoRef.current?.pause()
          } else {
            setPaused(false)
          }
        }
      },
      { threshold: 0 }
    )
    io.observe(host)
    return () => io.disconnect()
  }, [])

  // UNMOUNT RELEASE — on close, stop playback and tear down the twmedia Range
  // connection immediately (don't wait for GC of a still-buffering element).
  useEffect(() => {
    const v = videoRef.current
    return () => {
      if (!v) return
      v.pause()
      v.removeAttribute('src')
      v.load()
    }
  }, [])

  const toolbar = (
    <div className="media-pane-toolbar">
      <span className="media-pane-name" title={mediaRef.name}>
        {mediaRef.name}
      </span>
      {/* Preview-only LUT control. Video only — a LUT has nothing to grade on an
          audio pane. It reaches the landed bounded validator/durable store/
          supervisor chain through pathless IPC; no path is passed from here. */}
      {mediaRef.kind === 'video' ? <StudioEffectPreviewControl /> : null}
      <button
        type="button"
        className="media-pane-close"
        onClick={onClose}
        aria-label={`Close ${mediaRef.name}`}
        title={`Close ${mediaRef.name}`}
      >
        ×
      </button>
    </div>
  )

  if (!src) {
    return (
      <div className="media-pane" ref={hostRef} data-media-kind={mediaRef.kind}>
        {toolbar}
        <div className="media-pane-body media-pane-unavailable">
          <span>Media unavailable</span>
        </div>
      </div>
    )
  }

  return (
    <div className="media-pane" ref={hostRef} data-media-kind={mediaRef.kind}>
      {toolbar}
      <div className="media-pane-body">
        {mediaRef.kind === 'audio' ? (
          <WaveformAudioPlayer
            src={src}
            peaks={mediaRef.peaks}
            posterSrc={poster}
            durationMs={mediaRef.durationMs}
            name={mediaRef.name}
            pausedSignal={paused}
          />
        ) : (
          <div
            className="media-pane-video-frame"
            style={videoAspectRatio ? { aspectRatio: videoAspectRatio } : undefined}
          >
            <video
              ref={videoRef}
              controls
              preload="metadata"
              {...(poster ? { poster } : {})}
              src={src}
              onLoadedMetadata={() => {
                const video = videoRef.current
                if (!video?.videoWidth || !video.videoHeight) return
                setVideoAspectRatio(`${video.videoWidth} / ${video.videoHeight}`)
              }}
            />
          </div>
        )}
      </div>
    </div>
  )
}
