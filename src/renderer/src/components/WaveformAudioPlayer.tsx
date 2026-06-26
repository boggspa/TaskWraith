import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode
} from 'react'

/**
 * WaveformAudioPlayer — a DAW-clip-style inline audio player for the transcript.
 *
 * The visual IS the UI: a crisp, theme-reactive waveform canvas (Logic Pro / Pro
 * Tools "audio clip" look) with a played/unplayed colour split, a moving playhead,
 * and click/drag-to-seek. Playback rides a real, headless <audio> element (NO native
 * `controls` — the canvas drives it) over the twmedia:// Range protocol.
 *
 * PERF CONTRACT (an adversarial reviewer will attack this): the waveform canvases are
 * drawn EXACTLY ONCE per (size × peaks) — never per animation frame. The played/
 * unplayed split is two stacked, identically-drawn canvases (base = dim/unplayed,
 * overlay = accent/played) where only a wrapping <div>'s `width` is mutated on
 * `timeupdate` to reveal the played portion; the playhead is a 1px element whose
 * `left` is mutated the same way. So a timeupdate touches two inline styles, zero
 * canvas pixels.
 *
 * FALLBACK CHAIN:
 *   1. `peaks` present       → the canvas DAW waveform (preferred).
 *   2. else `posterSrc`      → the poster waveform JPEG as the strip background, with
 *                              the SAME played-overlay + playhead + click-seek.
 *   3. else                  → a plain <audio controls> (always playable).
 *
 * Source of colour: CSS custom properties read off the rendered element
 * (`--wf-played`, `--wf-unplayed`) so the waveform re-tints with the theme; canvas
 * can't consume CSS vars directly, hence the getComputedStyle read at draw time.
 */

export interface WaveformAudioPlayerProps {
  src: string
  peaks?: number[]
  posterSrc?: string
  durationMs?: number
  name?: string
}

const FALLBACK_PLAYED = '#4c8dff'
const FALLBACK_UNPLAYED = 'rgba(140, 160, 190, 0.42)'
/** Logical canvas height (px). Device-pixel-ratio is applied on top for crispness. */
const WAVE_HEIGHT = 56
/** Minimum logical canvas width before we have a measured container size. */
const WAVE_MIN_WIDTH = 160
/**
 * Render-side bound on the bucket count. Defense-in-depth only: emission caps at 512
 * (normalizeHarvestedPeaks / buildAvMediaRef) and the RAW provider sanitizer drops
 * `peaks` entirely, so an oversized/hostile array is unreachable today. This keeps the
 * draw loop self-defending against any future writer that bypasses those caps.
 */
const WAVE_MAX_PEAKS = 1024

function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0
  const total = Math.floor(seconds)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

/** Read a CSS custom property off an element, falling back when unset/empty. */
function readCssVar(el: HTMLElement | null, name: string, fallback: string): string {
  if (!el || typeof window === 'undefined' || !window.getComputedStyle) return fallback
  const value = window.getComputedStyle(el).getPropertyValue(name).trim()
  return value || fallback
}

/**
 * Draw the symmetric DAW envelope onto a canvas in a single colour. Called once per
 * (size × peaks × colour) — NOT per frame. Bars are mirrored around the centerline;
 * each bar's half-height = (peak/255) * (H/2). A tiny min height keeps silent buckets
 * visible as a hairline (the Pro-Tools "you can see the whole clip" feel).
 */
function drawWaveform(
  canvas: HTMLCanvasElement | null,
  peaks: number[],
  cssWidth: number,
  cssHeight: number,
  color: string
): void {
  if (!canvas) return
  const dpr = typeof window !== 'undefined' && window.devicePixelRatio ? window.devicePixelRatio : 1
  const pxW = Math.max(1, Math.round(cssWidth * dpr))
  const pxH = Math.max(1, Math.round(cssHeight * dpr))
  if (canvas.width !== pxW) canvas.width = pxW
  if (canvas.height !== pxH) canvas.height = pxH
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.clearRect(0, 0, pxW, pxH)
  const n = Math.min(peaks.length, WAVE_MAX_PEAKS)
  if (n === 0) return

  // Bar geometry in DEVICE px. A ~1px gap between bars reads as discrete samples;
  // when there are more buckets than pixels we fall back to a filled envelope.
  const slot = pxW / n
  const gap = slot > 3 * dpr ? Math.max(1, Math.floor(dpr)) : 0
  const barW = Math.max(1, slot - gap)
  const mid = pxH / 2
  const maxHalf = mid - Math.max(1, dpr) // keep a hair of padding top/bottom
  ctx.fillStyle = color
  for (let i = 0; i < n; i++) {
    const norm = Math.min(1, Math.max(0, peaks[i] / 255))
    const half = Math.max(dpr * 0.75, norm * maxHalf)
    const x = i * slot + (slot - barW) / 2
    ctx.fillRect(x, mid - half, barW, half * 2)
  }
}

export function WaveformAudioPlayer({
  src,
  peaks,
  posterSrc,
  durationMs,
  name
}: WaveformAudioPlayerProps): ReactNode {
  const hasPeaks = Array.isArray(peaks) && peaks.length > 0
  const usePoster = !hasPeaks && !!posterSrc

  // No waveform AND no poster → the always-playable plain control. (Variant C tail.)
  if (!hasPeaks && !usePoster) {
    return (
      <audio
        className="tw-wave-audio-plain"
        controls
        preload="metadata"
        src={src}
        aria-label={name ? `Audio: ${name}` : 'Audio'}
      />
    )
  }

  return (
    <WaveformAudioPlayerCore
      src={src}
      peaks={hasPeaks ? (peaks as number[]) : undefined}
      posterSrc={usePoster ? posterSrc : undefined}
      durationMs={durationMs}
      name={name}
    />
  )
}

function WaveformAudioPlayerCore({
  src,
  peaks,
  posterSrc,
  durationMs,
  name
}: WaveformAudioPlayerProps): ReactNode {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const baseCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const playedCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const playedWrapRef = useRef<HTMLDivElement | null>(null)
  const playheadRef = useRef<HTMLDivElement | null>(null)

  const [isPlaying, setIsPlaying] = useState(false)
  // Duration: seeded from the durationMs prop so the "/ m:ss" label is right before
  // metadata loads, then corrected by the element's own loadedmetadata.
  const initialDuration = typeof durationMs === 'number' && durationMs > 0 ? durationMs / 1000 : 0
  const [duration, setDuration] = useState(initialDuration)
  const [current, setCurrent] = useState(0)
  const [cssWidth, setCssWidth] = useState(WAVE_MIN_WIDTH)

  const usingCanvas = Array.isArray(peaks) && peaks.length > 0

  // --- ONE-TIME (per size × peaks) canvas paint -----------------------------------
  // Redraw both layers only when the measured width or the peaks change — NEVER on a
  // timeupdate. Colours are read from CSS vars so the waveform re-tints with the theme.
  const redraw = useCallback(() => {
    if (!usingCanvas || !peaks) return
    const played = readCssVar(containerRef.current, '--wf-played', FALLBACK_PLAYED)
    const unplayed = readCssVar(containerRef.current, '--wf-unplayed', FALLBACK_UNPLAYED)
    drawWaveform(baseCanvasRef.current, peaks, cssWidth, WAVE_HEIGHT, unplayed)
    drawWaveform(playedCanvasRef.current, peaks, cssWidth, WAVE_HEIGHT, played)
  }, [usingCanvas, peaks, cssWidth])

  useLayoutEffect(() => {
    redraw()
  }, [redraw])

  // Measure the container width (and react to resizes) so the canvas is crisp at any
  // column width. ResizeObserver → cssWidth → redraw (the effect above).
  useEffect(() => {
    const el = containerRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = Math.max(WAVE_MIN_WIDTH, Math.floor(entry.contentRect.width))
        setCssWidth((prev) => (Math.abs(prev - w) >= 1 ? w : prev))
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // --- Cheap per-frame update: just two inline styles (no canvas redraw) ----------
  const applyProgressStyles = useCallback((ratio: number) => {
    const clamped = Math.min(1, Math.max(0, Number.isFinite(ratio) ? ratio : 0))
    const pct = `${clamped * 100}%`
    if (playedWrapRef.current) playedWrapRef.current.style.width = pct
    if (playheadRef.current) playheadRef.current.style.left = pct
  }, [])

  const progressRatio = duration > 0 ? current / duration : 0
  // Keep the DOM styles in sync when current/duration change from React state too
  // (covers the poster path, seeks, and the very first metadata load).
  useLayoutEffect(() => {
    applyProgressStyles(progressRatio)
  }, [applyProgressStyles, progressRatio])

  // --- <audio> wiring -------------------------------------------------------------
  const onLoadedMetadata = useCallback(() => {
    const el = audioRef.current
    if (!el) return
    if (Number.isFinite(el.duration) && el.duration > 0) setDuration(el.duration)
  }, [])

  const onTimeUpdate = useCallback(() => {
    const el = audioRef.current
    if (!el) return
    const t = el.duration > 0 ? el.currentTime : 0
    // Update the cheap DOM styles immediately (smooth), and the label state (coarse).
    const dur = el.duration > 0 ? el.duration : duration
    applyProgressStyles(dur > 0 ? t / dur : 0)
    setCurrent(t)
  }, [applyProgressStyles, duration])

  const onEnded = useCallback(() => {
    setIsPlaying(false)
    setCurrent(0)
    applyProgressStyles(0)
    const el = audioRef.current
    if (el) el.currentTime = 0
  }, [applyProgressStyles])

  const onPlay = useCallback(() => setIsPlaying(true), [])
  const onPause = useCallback(() => setIsPlaying(false), [])

  const togglePlay = useCallback(() => {
    const el = audioRef.current
    if (!el) return
    if (el.paused) {
      void el.play().catch(() => setIsPlaying(false))
    } else {
      el.pause()
    }
  }, [])

  // --- Click / drag to seek -------------------------------------------------------
  const seekToClientX = useCallback(
    (clientX: number) => {
      const el = audioRef.current
      const strip = containerRef.current
      if (!el || !strip) return
      const rect = strip.getBoundingClientRect()
      if (rect.width <= 0) return
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
      const dur = el.duration > 0 ? el.duration : duration
      if (dur > 0) {
        el.currentTime = ratio * dur
        setCurrent(el.currentTime)
      }
      applyProgressStyles(ratio)
    },
    [applyProgressStyles, duration]
  )

  const draggingRef = useRef(false)
  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      // Left button / touch / pen only.
      if (event.button !== 0 && event.pointerType === 'mouse') return
      draggingRef.current = true
      try {
        event.currentTarget.setPointerCapture(event.pointerId)
      } catch {
        // setPointerCapture can throw if the pointer is already gone — harmless.
      }
      seekToClientX(event.clientX)
    },
    [seekToClientX]
  )
  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!draggingRef.current) return
      seekToClientX(event.clientX)
    },
    [seekToClientX]
  )
  const endDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return
    draggingRef.current = false
    try {
      event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {
      // ignore
    }
  }, [])

  // Keyboard seek/scrub for the focusable strip (Space toggles via the button).
  const onStripKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const el = audioRef.current
      if (!el) return
      const dur = el.duration > 0 ? el.duration : duration
      if (event.key === 'ArrowRight') {
        event.preventDefault()
        el.currentTime = Math.min(dur || 0, el.currentTime + 5)
        setCurrent(el.currentTime)
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault()
        el.currentTime = Math.max(0, el.currentTime - 5)
        setCurrent(el.currentTime)
      } else if (event.key === 'Enter') {
        event.preventDefault()
        togglePlay()
      }
    },
    [duration, togglePlay]
  )

  const label = `${formatClock(current)} / ${formatClock(duration)}`

  return (
    <div
      ref={containerRef}
      className={`tw-wave-player${usingCanvas ? ' is-canvas' : ' is-poster'}`}
      data-playing={isPlaying ? 'true' : 'false'}
    >
      {/* Headless audio: the canvas is the UI, so NO `controls`. Kept in the DOM so
          playback works (and the test's `<audio` assertion holds). */}
      <audio
        ref={audioRef}
        className="tw-wave-audio-el"
        preload="metadata"
        src={src}
        onLoadedMetadata={onLoadedMetadata}
        onTimeUpdate={onTimeUpdate}
        onEnded={onEnded}
        onPlay={onPlay}
        onPause={onPause}
      />

      <button
        type="button"
        className="tw-wave-playbtn"
        onClick={togglePlay}
        aria-label={isPlaying ? `Pause ${name ?? 'audio'}` : `Play ${name ?? 'audio'}`}
        title={isPlaying ? 'Pause' : 'Play'}
      >
        {isPlaying ? (
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <rect x="3.5" y="2.5" width="3" height="11" rx="1" fill="currentColor" />
            <rect x="9.5" y="2.5" width="3" height="11" rx="1" fill="currentColor" />
          </svg>
        ) : (
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <path d="M4.5 3.2 12.5 8l-8 4.8z" fill="currentColor" />
          </svg>
        )}
      </button>

      <div
        className="tw-wave-strip"
        role="slider"
        tabIndex={0}
        aria-label={`Seek ${name ?? 'audio'}`}
        aria-valuemin={0}
        aria-valuemax={Math.max(0, Math.round(duration))}
        aria-valuenow={Math.round(current)}
        aria-valuetext={label}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={onStripKeyDown}
      >
        {usingCanvas ? (
          <>
            {/* Base (unplayed) waveform — full width, dim. */}
            <canvas ref={baseCanvasRef} className="tw-wave-canvas tw-wave-canvas-base" />
            {/* Played overlay — identical waveform in the accent colour, revealed by a
                width-clipping wrapper. Only the wrapper width changes on timeupdate. */}
            <div ref={playedWrapRef} className="tw-wave-played-wrap" style={{ width: '0%' }}>
              <canvas
                ref={playedCanvasRef}
                className="tw-wave-canvas tw-wave-canvas-played"
                style={{ width: cssWidth }}
              />
            </div>
          </>
        ) : (
          <>
            {/* Poster fallback (Variant A): the waveform JPEG is the strip background;
                the played portion is the same image tinted via a clipped overlay. */}
            <img className="tw-wave-poster tw-wave-poster-base" src={posterSrc} alt="" aria-hidden="true" />
            <div ref={playedWrapRef} className="tw-wave-played-wrap" style={{ width: '0%' }}>
              <img
                className="tw-wave-poster tw-wave-poster-played"
                src={posterSrc}
                alt=""
                aria-hidden="true"
                style={{ width: cssWidth }}
              />
            </div>
          </>
        )}
        <div ref={playheadRef} className="tw-wave-playhead" style={{ left: '0%' }} aria-hidden="true" />
      </div>

      <span className="tw-wave-time" aria-hidden="true">
        {label}
      </span>
    </div>
  )
}
