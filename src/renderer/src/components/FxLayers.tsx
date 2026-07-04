import { useEffect, useId, useRef, useState, type CSSProperties } from 'react'
import type { AppSettings, ProviderId } from '../../../main/store/types'

export type SkyWeatherKind =
  | 'clear'
  | 'partly_cloudy'
  | 'cloudy'
  | 'overcast'
  | 'rain'
  | 'heavy_rain'
  | 'snow'
  | 'mist'
  | 'fog'
  | 'storm'
  | 'unknown'

export interface HostWeatherVisualState {
  kind: SkyWeatherKind
  description: string
  temperatureC?: number
  location?: string
  isDay: boolean
  updatedAt: string
  source: 'wttr' | 'fallback'
  error?: string
}

type SkyTimePhase = 'dawn' | 'day' | 'evening' | 'night'

const SKY_UFO_INITIAL_DELAY_MS = 60_000
const SKY_UFO_RECURRENCE_MS = 40 * 60_000
const SKY_UFO_FLIGHT_MS = 60_000
const SKY_DIFF_CLOUD_INITIAL_DELAY_MS = SKY_UFO_INITIAL_DELAY_MS + SKY_UFO_RECURRENCE_MS / 2
const SKY_DIFF_CLOUD_RECURRENCE_MS = SKY_UFO_RECURRENCE_MS
const SKY_DIFF_CLOUD_FLIGHT_MS = 58_000
const SKY_MEGA_DELETE_DIFF_CLOUD_INITIAL_DELAY_MS =
  SKY_UFO_INITIAL_DELAY_MS + SKY_UFO_RECURRENCE_MS * 0.75
const SKY_UFO_RENDERER_BOOTED_AT_MS = Date.now()

interface SkyUfoFlight {
  id: number
  style: CSSProperties
}

interface SkyUfoTiming {
  delayMs: number
  nextDelayMs: number
}

interface SkyDiffCloudFlight {
  id: number
  variant: 'regular' | 'mega-delete'
  additions: string
  deletions: string
  style: CSSProperties
}

const randomBetween = (min: number, max: number) => min + Math.random() * (max - min)
const randomInt = (min: number, max: number) => Math.round(randomBetween(min, max))
const randomSkyUfoY = () => `clamp(28px, ${randomInt(8, 30)}cqh, 190px)`
const randomSkyDiffY = () => `clamp(40px, ${randomInt(11, 36)}cqh, 230px)`
const formatDiffNumber = (value: number) =>
  Math.round(value)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',')

function createSkyUfoFlight(id: number): SkyUfoFlight {
  return {
    id,
    style: {
      '--sky-ufo-duration': `${SKY_UFO_FLIGHT_MS}ms`,
      '--sky-ufo-scale': randomBetween(0.78, 1.08).toFixed(2),
      '--sky-ufo-y0': randomSkyUfoY(),
      '--sky-ufo-y1': randomSkyUfoY(),
      '--sky-ufo-y2': randomSkyUfoY(),
      '--sky-ufo-y3': randomSkyUfoY(),
      '--sky-ufo-y4': randomSkyUfoY(),
      '--sky-ufo-y5': randomSkyUfoY(),
      '--sky-ufo-r0': `${randomInt(-5, 5)}deg`,
      '--sky-ufo-r1': `${randomInt(-12, 8)}deg`,
      '--sky-ufo-r2': `${randomInt(-8, 12)}deg`,
      '--sky-ufo-r3': `${randomInt(-10, 10)}deg`,
      '--sky-ufo-r4': `${randomInt(-6, 8)}deg`,
      '--sky-ufo-r5': `${randomInt(-3, 6)}deg`
    } as CSSProperties
  }
}

function getNextCyclicSkyTiming(
  initialDelayMs: number,
  recurrenceMs: number,
  flightMs: number,
  now = Date.now(),
  bootedAtMs = SKY_UFO_RENDERER_BOOTED_AT_MS
): SkyUfoTiming {
  const elapsedMs = Math.max(0, now - bootedAtMs)
  if (elapsedMs < initialDelayMs) {
    return {
      delayMs: initialDelayMs - elapsedMs,
      nextDelayMs: recurrenceMs
    }
  }

  const cycleOffsetMs = (elapsedMs - initialDelayMs) % recurrenceMs
  if (cycleOffsetMs < flightMs) {
    return {
      delayMs: 0,
      nextDelayMs: recurrenceMs - cycleOffsetMs
    }
  }

  return {
    delayMs: recurrenceMs - cycleOffsetMs,
    nextDelayMs: recurrenceMs
  }
}

export function getNextSkyUfoTiming(now = Date.now(), bootedAtMs = SKY_UFO_RENDERER_BOOTED_AT_MS) {
  return getNextCyclicSkyTiming(
    SKY_UFO_INITIAL_DELAY_MS,
    SKY_UFO_RECURRENCE_MS,
    SKY_UFO_FLIGHT_MS,
    now,
    bootedAtMs
  )
}

export function getNextSkyDiffCloudTiming(
  now = Date.now(),
  bootedAtMs = SKY_UFO_RENDERER_BOOTED_AT_MS
) {
  return getNextCyclicSkyTiming(
    SKY_DIFF_CLOUD_INITIAL_DELAY_MS,
    SKY_DIFF_CLOUD_RECURRENCE_MS,
    SKY_DIFF_CLOUD_FLIGHT_MS,
    now,
    bootedAtMs
  )
}

export function getNextSkyMegaDeleteDiffCloudTiming(
  now = Date.now(),
  bootedAtMs = SKY_UFO_RENDERER_BOOTED_AT_MS
) {
  return getNextCyclicSkyTiming(
    SKY_MEGA_DELETE_DIFF_CLOUD_INITIAL_DELAY_MS,
    SKY_DIFF_CLOUD_RECURRENCE_MS,
    SKY_DIFF_CLOUD_FLIGHT_MS,
    now,
    bootedAtMs
  )
}

function createSkyDiffCloudFlightFromParts({
  id,
  variant,
  additions,
  deletions
}: {
  id: number
  variant: SkyDiffCloudFlight['variant']
  additions: number
  deletions: number
}): SkyDiffCloudFlight {
  const fromLeft = Math.random() > 0.5
  const xStops = fromLeft
    ? ['-280px', '14cqw', '36cqw', '58cqw', '82cqw', 'calc(100cqw + 280px)']
    : ['calc(100cqw + 280px)', '82cqw', '58cqw', '36cqw', '14cqw', '-280px']

  return {
    id,
    variant,
    additions: `+${formatDiffNumber(additions)}`,
    deletions: `-${formatDiffNumber(deletions)}`,
    style: {
      '--sky-diff-duration': `${SKY_DIFF_CLOUD_FLIGHT_MS}ms`,
      '--sky-diff-scale': randomBetween(0.82, 1.06).toFixed(2),
      '--sky-diff-x0': xStops[0],
      '--sky-diff-x1': xStops[1],
      '--sky-diff-x2': xStops[2],
      '--sky-diff-x3': xStops[3],
      '--sky-diff-x4': xStops[4],
      '--sky-diff-x5': xStops[5],
      '--sky-diff-y0': randomSkyDiffY(),
      '--sky-diff-y1': randomSkyDiffY(),
      '--sky-diff-y2': randomSkyDiffY(),
      '--sky-diff-y3': randomSkyDiffY(),
      '--sky-diff-y4': randomSkyDiffY(),
      '--sky-diff-y5': randomSkyDiffY(),
      '--sky-diff-r0': `${randomInt(-5, 5)}deg`,
      '--sky-diff-r1': `${randomInt(-8, 10)}deg`,
      '--sky-diff-r2': `${randomInt(-10, 8)}deg`,
      '--sky-diff-r3': `${randomInt(-7, 11)}deg`,
      '--sky-diff-r4': `${randomInt(-9, 7)}deg`,
      '--sky-diff-r5': `${randomInt(-4, 6)}deg`
    } as CSSProperties
  }
}

export function createSkyDiffCloudFlight(id: number): SkyDiffCloudFlight {
  const additions = randomInt(1_400, 4_900)
  return createSkyDiffCloudFlightFromParts({
    id,
    variant: 'regular',
    additions,
    deletions: additions + randomInt(1_900, 8_400)
  })
}

export function createSkyMegaDeleteDiffCloudFlight(id: number): SkyDiffCloudFlight {
  return createSkyDiffCloudFlightFromParts({
    id,
    variant: 'mega-delete',
    additions: randomInt(1, 24),
    deletions: randomInt(125_000, 285_000)
  })
}

/**
 * The SVG filter the fog/mist sky variants warp their glow through. Referenced
 * from CSS by a FIXED id (`02-transcript-messages-fx.css`:
 * `filter: url(#sky-fog-mist-warp)` on `.sky-day.sky-mist .sky-glow` and the
 * `.sky-day.sky-fog::after` pseudo-element — the latter can't take an inline
 * per-instance filter), so the id CANNOT be namespaced per-instance.
 *
 * Multiview can mount up to 4 `SkyWeatherVisual`s at once; emitting this filter
 * inside each would create duplicate `id="sky-fog-mist-warp"` nodes. Instead the
 * defs live in ONE shared element (`<SkyFogFilterDefs>`, rendered once by App),
 * which every sky instance — focused or pane — references via the CSS url(). */
export function SkyFogFilterDefs() {
  return (
    <svg className="sky-fog-filter" width="0" height="0" aria-hidden focusable="false">
      <filter
        id="sky-fog-mist-warp"
        x="-12%"
        y="-24%"
        width="124%"
        height="148%"
        colorInterpolationFilters="sRGB"
      >
        <feTurbulence
          type="fractalNoise"
          baseFrequency="0.012 0.056"
          numOctaves="2"
          seed="19"
          result="fogNoise"
        />
        <feDisplacementMap
          in="SourceGraphic"
          in2="fogNoise"
          scale="16"
          xChannelSelector="R"
          yChannelSelector="G"
          result="warpedFog"
        />
        <feGaussianBlur in="warpedFog" stdDeviation="4.8" />
      </filter>
    </svg>
  )
}

/**
 * The shared SVG displacement filter behind the refractive "liquid glass"
 * material. Referenced from CSS by a FIXED id (`filter: url(#tw-glass-refract)`)
 * applied to a synthetic SHEEN layer — NOT the live backdrop or content — so the
 * warp reads as a subtle, static glass-edge refraction.
 *
 * Same multiview dup-id rule as `SkyFogFilterDefs` above: `url(#id)` resolves to
 * the FIRST matching id in document order, so emitting this inside a per-pane
 * component would make every pane bind to pane-0's node. It therefore lives in
 * ONE shared element, rendered once by App, gated by `isFxEnabled`.
 *
 * The displacement is STATIC: `feTurbulence` with a fixed `seed` synthesizes the
 * noise once and does not animate by itself. No filter primitive is animated
 * (animating filter params re-runs the whole filter every frame = perf death). */
export function RefractionFilterDefs() {
  return (
    <svg className="fx-refract-filter" width="0" height="0" aria-hidden focusable="false">
      <filter
        id="tw-glass-refract"
        x="-20%"
        y="-20%"
        width="140%"
        height="140%"
        colorInterpolationFilters="sRGB"
      >
        <feTurbulence
          type="fractalNoise"
          baseFrequency="0.009 0.013"
          numOctaves="2"
          seed="7"
          result="glassNoise"
        />
        <feGaussianBlur in="glassNoise" stdDeviation="2.2" result="softNoise" />
        <feDisplacementMap
          in="SourceGraphic"
          in2="softNoise"
          scale="16"
          xChannelSelector="R"
          yChannelSelector="G"
        />
      </filter>
    </svg>
  )
}

export function SkyWeatherVisual({ weather }: { weather: HostWeatherVisualState | null }) {
  const localHour = new Date().getHours()
  const skyKind = weather?.kind || 'unknown'
  const skyUfoSequenceRef = useRef(0)
  const skyDiffCloudSequenceRef = useRef(0)
  const skyMegaDeleteDiffCloudSequenceRef = useRef(0)
  const [skyUfoFlight, setSkyUfoFlight] = useState<SkyUfoFlight | null>(null)
  const [skyDiffCloudFlight, setSkyDiffCloudFlight] = useState<SkyDiffCloudFlight | null>(null)
  const [skyMegaDeleteDiffCloudFlight, setSkyMegaDeleteDiffCloudFlight] =
    useState<SkyDiffCloudFlight | null>(null)

  // Keep the backend daylight signal for core assets like stars vs sun/day state.
  const isNightBase = weather ? !weather.isDay : localHour < 7 || localHour >= 19

  let timePhase: SkyTimePhase = isNightBase ? 'night' : 'day'
  if (localHour >= 5 && localHour < 8) {
    timePhase = 'dawn'
  } else if (localHour >= 17 && localHour < 20) {
    timePhase = 'evening'
  }

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }

    let scheduledTimer: number | undefined
    let recurringTimer: number | undefined
    let clearFlightTimer: number | undefined

    const clearFlight = (id: number) => {
      setSkyUfoFlight((current) => (current?.id === id ? null : current))
    }

    const launchFlight = () => {
      if (clearFlightTimer !== undefined) {
        window.clearTimeout(clearFlightTimer)
      }

      const id = skyUfoSequenceRef.current + 1
      skyUfoSequenceRef.current = id
      setSkyUfoFlight(createSkyUfoFlight(id))
      clearFlightTimer = window.setTimeout(() => clearFlight(id), SKY_UFO_FLIGHT_MS + 500)
    }

    const scheduleRecurring = (delayMs: number) => {
      scheduledTimer = window.setTimeout(() => {
        launchFlight()
        recurringTimer = window.setInterval(launchFlight, SKY_UFO_RECURRENCE_MS)
      }, delayMs)
    }

    const timing = getNextSkyUfoTiming()
    scheduledTimer = window.setTimeout(() => {
      launchFlight()
      scheduleRecurring(timing.nextDelayMs)
    }, timing.delayMs)

    return () => {
      if (scheduledTimer !== undefined) {
        window.clearTimeout(scheduledTimer)
      }
      if (recurringTimer !== undefined) {
        window.clearInterval(recurringTimer)
      }
      if (clearFlightTimer !== undefined) {
        window.clearTimeout(clearFlightTimer)
      }
    }
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }

    let scheduledTimer: number | undefined
    let recurringTimer: number | undefined
    let clearFlightTimer: number | undefined

    const clearFlight = (id: number) => {
      setSkyMegaDeleteDiffCloudFlight((current) => (current?.id === id ? null : current))
    }

    const launchFlight = () => {
      if (clearFlightTimer !== undefined) {
        window.clearTimeout(clearFlightTimer)
      }

      const id = skyMegaDeleteDiffCloudSequenceRef.current + 1
      skyMegaDeleteDiffCloudSequenceRef.current = id
      setSkyMegaDeleteDiffCloudFlight(createSkyMegaDeleteDiffCloudFlight(id))
      clearFlightTimer = window.setTimeout(() => clearFlight(id), SKY_DIFF_CLOUD_FLIGHT_MS + 500)
    }

    const scheduleRecurring = (delayMs: number) => {
      scheduledTimer = window.setTimeout(() => {
        launchFlight()
        recurringTimer = window.setInterval(launchFlight, SKY_DIFF_CLOUD_RECURRENCE_MS)
      }, delayMs)
    }

    const timing = getNextSkyMegaDeleteDiffCloudTiming()
    scheduledTimer = window.setTimeout(() => {
      launchFlight()
      scheduleRecurring(timing.nextDelayMs)
    }, timing.delayMs)

    return () => {
      if (scheduledTimer !== undefined) {
        window.clearTimeout(scheduledTimer)
      }
      if (recurringTimer !== undefined) {
        window.clearInterval(recurringTimer)
      }
      if (clearFlightTimer !== undefined) {
        window.clearTimeout(clearFlightTimer)
      }
    }
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }

    let scheduledTimer: number | undefined
    let recurringTimer: number | undefined
    let clearFlightTimer: number | undefined

    const clearFlight = (id: number) => {
      setSkyDiffCloudFlight((current) => (current?.id === id ? null : current))
    }

    const launchFlight = () => {
      if (clearFlightTimer !== undefined) {
        window.clearTimeout(clearFlightTimer)
      }

      const id = skyDiffCloudSequenceRef.current + 1
      skyDiffCloudSequenceRef.current = id
      setSkyDiffCloudFlight(createSkyDiffCloudFlight(id))
      clearFlightTimer = window.setTimeout(() => clearFlight(id), SKY_DIFF_CLOUD_FLIGHT_MS + 500)
    }

    const scheduleRecurring = (delayMs: number) => {
      scheduledTimer = window.setTimeout(() => {
        launchFlight()
        recurringTimer = window.setInterval(launchFlight, SKY_DIFF_CLOUD_RECURRENCE_MS)
      }, delayMs)
    }

    const timing = getNextSkyDiffCloudTiming()
    scheduledTimer = window.setTimeout(() => {
      launchFlight()
      scheduleRecurring(timing.nextDelayMs)
    }, timing.delayMs)

    return () => {
      if (scheduledTimer !== undefined) {
        window.clearTimeout(scheduledTimer)
      }
      if (recurringTimer !== undefined) {
        window.clearInterval(recurringTimer)
      }
      if (clearFlightTimer !== undefined) {
        window.clearTimeout(clearFlightTimer)
      }
    }
  }, [])

  return (
    <div
      className={`sky-visual-fx sky-${skyKind} ${isNightBase ? 'sky-night' : 'sky-day'} sky-phase-${timePhase}`}
      aria-hidden
    >
      {/* The fog/mist warp filter is defined ONCE globally via <SkyFogFilterDefs>
       * (rendered by App) — the CSS that applies it references a FIXED id, which
       * can't be namespaced per-instance, so emitting it here would duplicate the
       * id across the up-to-4 panes that can mount this layer at once. */}
      <div className="sky-glow" />
      <div className="sky-orb" />
      {isNightBase && (
        <>
          <div className="sky-moon">
            <svg
              className="sky-moon-glyph"
              viewBox="0 0 96 96"
              aria-hidden
              focusable="false"
            >
              <path
                className="sky-moon-crescent"
                d="M76.4 7.2C54.1 9.8 33.3 27.4 26.1 49.4c-7.7 23.3 6.2 39.9 32.3 39.4 8.5-.2 16.3-3 22.8-8.1-23 1.6-38.9-12.3-38.2-31.3.7-20 13.8-36 33.4-42.2Z"
              />
              <path
                className="sky-moon-sheen"
                d="M38.7 22.2C29.1 31.2 24.1 43.4 25.3 54.7c1.5 14.6 11.1 25.5 25.6 29"
              />
            </svg>
          </div>
          <span className="sky-star sky-star-1" />
          <span className="sky-star sky-star-2" />
          <span className="sky-star sky-star-3" />
          <span className="sky-star sky-star-4" />
          <span className="sky-star sky-star-5" />
        </>
      )}
      <span className="sky-cloud sky-cloud-1" />
      <span className="sky-cloud sky-cloud-2" />
      <span className="sky-cloud sky-cloud-3" />
      <span className="sky-cloud sky-cloud-4" />
      <span className="sky-cloud sky-cloud-5" />
      {skyUfoFlight && (
        <div key={skyUfoFlight.id} className="sky-ufo" style={skyUfoFlight.style}>
          <span className="sky-ufo-dome" />
          <span className="sky-ufo-hull" />
          <span className="sky-ufo-light sky-ufo-light-1" />
          <span className="sky-ufo-light sky-ufo-light-2" />
          <span className="sky-ufo-light sky-ufo-light-3" />
        </div>
      )}
      {[skyDiffCloudFlight, skyMegaDeleteDiffCloudFlight].map(
        (flight) =>
          flight && (
            <div
              key={`${flight.variant}-${flight.id}`}
              className={`sky-diff-cloud sky-diff-cloud-${flight.variant}`}
              style={flight.style}
            >
              <span className="sky-diff-cloud-card">
                <span className="sky-diff-cloud-stat sky-diff-cloud-add">{flight.additions}</span>
                <span className="sky-diff-cloud-stat sky-diff-cloud-delete">{flight.deletions}</span>
              </span>
            </div>
          )
      )}
      <div className="sky-rainfall">
        <span />
        <span />
        <span />
        <span />
        <span />
      </div>
      <div className="sky-snowfall">
        <span />
        <span />
        <span />
        <span />
        <span />
      </div>
    </div>
  )
}

export function GhostCompanion() {
  // 1.0.6 — render the REAL brand mascot (design-assets/ghost/ghost-guy-mark.svg)
  // inline so the shape is pixel-identical to the design and can't drift like the
  // old hand-coded pixel spans did (rotated diamond "face" facets + scattered
  // cheeks that were never in the mark). Inlining (vs an <img>) is what keeps him
  // ALIVE: the eye <g>s carry the `ghost-eye` class so the existing `ghostBlink`
  // squash animates them, while `.ghost-avatar` keeps the float/gesture. viewBox is
  // cropped to the mark's content bounds so he fills the avatar box.
  //
  // Multiview can mount up to 4 ghosts at once (one inline per pane). The fill/rim
  // gradient ids MUST be unique per instance — `fill="url(#id)"` resolves to the
  // FIRST element with that id in document order, so a fixed id would make every
  // ghost reference the first one's gradient (collision). `useId()` namespaces them.
  // Strip the colons React puts in `useId()` output (e.g. `:r0:`) — they break
  // `url(#…)` fragment resolution; same sanitization the codebase uses elsewhere
  // (TerminalPanel.tsx). The result is a valid, unique, collision-free id stem.
  const idPrefix = useId().replace(/:/g, '')
  const fillId = `ghostCompanionFill-${idPrefix}`
  const rimId = `ghostCompanionRim-${idPrefix}`
  return (
    <div className="ghost-companion" aria-hidden>
      <div className="ghost-avatar">
        <div className="ghost-shadow" />
        <svg
          className="ghost-svg"
          viewBox="34 26 68 80"
          xmlns="http://www.w3.org/2000/svg"
          aria-hidden
        >
          <defs>
            <linearGradient
              id={fillId}
              x1="38"
              y1="30"
              x2="98"
              y2="96"
              gradientUnits="userSpaceOnUse"
            >
              <stop offset="0" stopColor="#ffffff" stopOpacity="0.98" />
              <stop offset="0.34" stopColor="#f2fbff" stopOpacity="0.94" />
              <stop offset="0.63" stopColor="#d8f0ff" stopOpacity="0.86" />
              <stop offset="1" stopColor="#9fc6de" stopOpacity="0.76" />
            </linearGradient>
            <linearGradient
              id={rimId}
              x1="32"
              y1="24"
              x2="104"
              y2="102"
              gradientUnits="userSpaceOnUse"
            >
              <stop offset="0" stopColor="#25324b" stopOpacity="0.92" />
              <stop offset="0.62" stopColor="#121b2e" stopOpacity="0.8" />
              <stop offset="1" stopColor="#07101f" stopOpacity="0.72" />
            </linearGradient>
          </defs>
          <g shapeRendering="crispEdges">
            <polygon
              fill={`url(#${fillId})`}
              stroke={`url(#${rimId})`}
              strokeWidth="5"
              strokeLinejoin="miter"
              points="56 30 80 30 92 36 98 48 98 84 92 84 86 90 80 84 74 96 68 84 56 96 50 84 38 84 38 48 44 36"
            />
            <polygon fill="#ffffff" opacity="0.34" points="46 34 64 37 56 52 48 47" />
            <polygon fill="#40689d" opacity="0.18" points="78 44 94 49 90 72 78 64" />
            <g className="ghost-eye ghost-eye-left">
              <rect x="51" y="54" width="10" height="12" fill="#111827" />
              <rect x="54" y="51" width="3" height="3" fill="#ffffff" opacity="0.24" />
              <rect x="51" y="66" width="10" height="4" fill="#111827" opacity="0.2" />
            </g>
            <g className="ghost-eye ghost-eye-right">
              <rect x="75" y="54" width="10" height="12" fill="#111827" />
              <rect x="78" y="51" width="3" height="3" fill="#ffffff" opacity="0.24" />
              <rect x="75" y="66" width="10" height="4" fill="#111827" opacity="0.2" />
            </g>
            <rect x="44" y="92" width="12" height="12" fill="#f7fcff" />
            <rect x="62" y="92" width="12" height="12" fill="#e6f6ff" />
            <rect x="80" y="92" width="12" height="12" fill="#c8e4f5" />
          </g>
        </svg>
      </div>
    </div>
  )
}

export type AdvancedFxIntensity = AppSettings['advancedFx']['intensity']
export type AgentAuraStatus =
  | 'idle'
  | 'running'
  | 'queued'
  | 'approval'
  | 'failed'
  | 'complete'
  | 'handoff'

/**
 * `provider` accepts the synthetic `'ensemble'` key in addition to a real
 * `ProviderId`: the aura colour is keyed off this class (`fx-provider-${provider}`)
 * via the var declarations in 05-polish-fx-layouts.css, and ensemble chats use a
 * dedicated multi-provider palette (`fx-provider-ensemble`) rather than any single
 * participant's brand. App passes `auraProviderKey` (= 'ensemble' for ensemble
 * chats, else the provider); each non-focused Multiview pane passes its own
 * per-pane equivalent so the layer self-colours from its OWN class.
 */
export type AgentAuraProviderKey = ProviderId | 'ensemble'

export function AgentAuraLayer({
  provider,
  status,
  intensity,
  hasHandoff
}: {
  provider: AgentAuraProviderKey
  status: AgentAuraStatus
  intensity: AdvancedFxIntensity
  hasHandoff: boolean
}) {
  return (
    <div
      className={`agent-aura-layer fx-provider-${provider} fx-status-${status} fx-intensity-${intensity} ${hasHandoff ? 'fx-handoff' : ''}`}
      aria-hidden
    >
      <div className="agent-aura-edge agent-aura-edge-left" />
      <div className="agent-aura-edge agent-aura-edge-right" />
      <div className="agent-aura-run-burst" />
    </div>
  )
}

export function LivingWorkspaceLayer({
  weather,
  intensity
}: {
  weather: HostWeatherVisualState | null
  intensity: AdvancedFxIntensity
}) {
  const localHour = new Date().getHours()
  const isNight = weather ? !weather.isDay : localHour < 7 || localHour >= 19
  const phase: SkyTimePhase =
    localHour >= 5 && localHour < 8
      ? 'dawn'
      : localHour >= 17 && localHour < 20
        ? 'evening'
        : isNight
          ? 'night'
          : 'day'
  const kind = weather?.kind || 'unknown'
  const moteCount = intensity === 'epic' ? 18 : intensity === 'cinematic' ? 12 : 7
  const weatherParticleCount = intensity === 'epic' ? 16 : intensity === 'cinematic' ? 10 : 5

  return (
    <div
      className={`living-workspace-layer living-${kind} living-phase-${phase} fx-intensity-${intensity}`}
      aria-hidden
    >
      <div className="living-depth living-depth-back" />
      <div className="living-depth living-depth-mid" />
      <div className="living-room-light" />
      <div className="living-motes">
        {Array.from({ length: moteCount }).map((_, index) => (
          <span key={`mote-${index}`} style={{ '--mote-index': index } as CSSProperties} />
        ))}
      </div>
      <div className="living-weather-particles">
        {Array.from({ length: weatherParticleCount }).map((_, index) => (
          <span key={`weather-${index}`} style={{ '--particle-index': index } as CSSProperties} />
        ))}
      </div>
    </div>
  )
}

export function RunDataVizLayer({
  provider,
  intensity,
  queueCount,
  rawEventCount,
  approvalWaiting,
  status
}: {
  provider: ProviderId
  intensity: AdvancedFxIntensity
  queueCount: number
  rawEventCount: number
  approvalWaiting: boolean
  status: AgentAuraStatus
}) {
  const queueLaneCount = Math.max(1, Math.min(queueCount || 1, intensity === 'epic' ? 5 : 3))
  const eventLevel = Math.min(100, Math.max(8, rawEventCount * 2))

  return (
    <div
      className={`run-data-viz-layer fx-provider-${provider} fx-status-${status} fx-intensity-${intensity} ${approvalWaiting ? 'approval-waiting' : ''}`}
      aria-hidden
    >
      <svg className="run-data-viz-svg" viewBox="0 0 100 100" preserveAspectRatio="none">
        <path
          className="run-data-viz-flow run-data-viz-flow-a"
          d="M4 78 C 24 56, 42 62, 60 42 S 86 24, 96 16"
        />
        <path
          className="run-data-viz-flow run-data-viz-flow-b"
          d="M2 34 C 24 26, 38 42, 58 34 S 82 12, 98 28"
        />
        <path className="run-data-viz-progress" d={`M8 92 H ${Math.min(94, 8 + eventLevel)}`} />
      </svg>
      <div className="run-data-viz-queue">
        {Array.from({ length: queueLaneCount }).map((_, index) => (
          <span key={`queue-${index}`} style={{ '--queue-index': index } as CSSProperties} />
        ))}
      </div>
    </div>
  )
}
