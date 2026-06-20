import type { CSSProperties } from 'react'
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

export function SkyWeatherVisual({ weather }: { weather: HostWeatherVisualState | null }) {
  const localHour = new Date().getHours()
  const skyKind = weather?.kind || 'unknown'

  // Keep the backend daylight signal for core assets like stars vs sun/day state.
  const isNightBase = weather ? !weather.isDay : localHour < 7 || localHour >= 19

  let timePhase: SkyTimePhase = isNightBase ? 'night' : 'day'
  if (localHour >= 5 && localHour < 8) {
    timePhase = 'dawn'
  } else if (localHour >= 17 && localHour < 20) {
    timePhase = 'evening'
  }

  return (
    <div
      className={`sky-visual-fx sky-${skyKind} ${isNightBase ? 'sky-night' : 'sky-day'} sky-phase-${timePhase}`}
      aria-hidden
    >
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
      <div className="sky-glow" />
      <div className="sky-orb" />
      {isNightBase && (
        <>
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
              id="ghostCompanionFill"
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
              id="ghostCompanionRim"
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
              fill="url(#ghostCompanionFill)"
              stroke="url(#ghostCompanionRim)"
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
