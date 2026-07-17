/**
 * Continuous sky-scene model for the transcript weather visuals.
 *
 * Turns a host-weather snapshot (Open-Meteo conditions + coarse coordinates)
 * plus the live clock into everything the sky layer paints with: a
 * solar-elevation-keyed gradient palette, sun/moon arc positions, twilight
 * phase tokens, star density, cloud tint/coverage and precipitation levels.
 * Between 15-minute weather refreshes the scene keeps moving because the
 * astronomy is recomputed locally every tick — this is what makes the sky
 * show a low golden evening sun at 20:33 BST instead of jumping to a moon.
 *
 * Pure and clock-injected throughout so every band and palette is
 * unit-testable with fixed instants.
 */

import {
  SUNSET_ELEVATION_DEG,
  moonPhase,
  solarPosition,
  surroundingSunEvents
} from '../../../shared/skyAstronomy'

export type SkySceneWeatherKind =
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

/** Structural subset of HostWeatherVisualState the scene reads (kept local to
 * avoid a module cycle with FxLayers). All fields optional except the basics —
 * the scene renders a full sky from the clock alone. */
export interface SkySceneWeatherInput {
  kind: SkySceneWeatherKind
  isDay: boolean
  latitude?: number
  longitude?: number
  cloudCoverPct?: number
  precipitationMmHr?: number
  snowfallCmHr?: number
  windSpeedKph?: number
}

export type SkyScenePhase = 'day' | 'golden' | 'sunrise' | 'civil' | 'nautical' | 'astro' | 'night'

export type SkySceneEdge = 'dawn' | 'dusk' | null

export interface SkyScene {
  isSunUp: boolean
  phase: SkyScenePhase
  edge: SkySceneEdge
  /** Solar elevation in degrees (real or synthesized). */
  elevationDeg: number
  /** Gradient stops, zenith → horizon, as CSS rgb() strings. */
  top: string
  upper: string
  mid: string
  horizon: string
  /** Sun disc: container-percent position, scale, opacity and colours. */
  sunX: number
  sunY: number
  sunScale: number
  sunOpacity: number
  sunCore: string
  sunMid: string
  sunEdge: string
  sunRayOpacity: number
  /** Warm horizon bloom that tracks the sun through twilight. */
  glowX: number
  glowOpacity: number
  glowColor: string
  /** Moon: visibility, container-percent position, phase and brightness. */
  moonVisible: boolean
  moonX: number
  moonY: number
  moonPhase: number
  moonIllumination: number
  moonBright: number
  starOpacity: number
  cloudLit: string
  cloudShade: string
  cloudBand: 0 | 1 | 2 | 3 | 4
  cloudOpacity: number
  rainLevel: 0 | 1 | 2
  snowLevel: 0 | 1
  rainSlantDeg: number
  rainOpacity: number
  fogLevel: 0 | 1 | 2
  stormFlash: boolean
}

type Rgb = [number, number, number]

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value))

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t

const mixRgb = (a: Rgb, b: Rgb, t: number): Rgb => [
  lerp(a[0], b[0], t),
  lerp(a[1], b[1], t),
  lerp(a[2], b[2], t)
]

const scaleRgb = (a: Rgb, factor: number): Rgb => [a[0] * factor, a[1] * factor, a[2] * factor]

const rgbString = (rgb: Rgb): string =>
  `rgb(${Math.round(clamp(rgb[0], 0, 255))}, ${Math.round(clamp(rgb[1], 0, 255))}, ${Math.round(
    clamp(rgb[2], 0, 255)
  )})`

interface PaletteKey {
  e: number
  top: Rgb
  upper: Rgb
  mid: Rgb
  horizon: Rgb
}

/** Elevation-keyed sky palette (shared spine for dawn and dusk; the horizon
 * hue is nudged warmer/pinker per edge below). Tuned for the layer's
 * screen-blend over dark themes while staying honest on light themes. */
const PALETTE: PaletteKey[] = [
  { e: -30, top: [2, 6, 19], upper: [5, 11, 30], mid: [10, 21, 48], horizon: [16, 32, 63] },
  { e: -18, top: [3, 8, 22], upper: [7, 17, 41], mid: [14, 27, 58], horizon: [24, 42, 78] },
  { e: -12, top: [7, 17, 41], upper: [14, 29, 66], mid: [27, 47, 92], horizon: [52, 68, 112] },
  { e: -6, top: [14, 28, 63], upper: [30, 53, 99], mid: [64, 86, 127], horizon: [178, 122, 94] },
  {
    e: -2,
    top: [28, 55, 102],
    upper: [63, 93, 146],
    mid: [157, 123, 160],
    horizon: [255, 158, 88]
  },
  {
    e: 2,
    top: [42, 90, 160],
    upper: [95, 138, 194],
    mid: [216, 163, 127],
    horizon: [255, 195, 126]
  },
  {
    e: 8,
    top: [47, 111, 194],
    upper: [102, 160, 221],
    mid: [169, 198, 232],
    horizon: [255, 217, 160]
  },
  {
    e: 16,
    top: [46, 119, 208],
    upper: [95, 159, 227],
    mid: [163, 205, 242],
    horizon: [216, 236, 251]
  },
  {
    e: 35,
    top: [43, 111, 211],
    upper: [79, 151, 230],
    mid: [147, 198, 244],
    horizon: [207, 233, 252]
  },
  {
    e: 60,
    top: [34, 102, 205],
    upper: [70, 145, 228],
    mid: [140, 195, 245],
    horizon: [201, 231, 253]
  }
]

function paletteAt(elevationDeg: number): { top: Rgb; upper: Rgb; mid: Rgb; horizon: Rgb } {
  const e = clamp(elevationDeg, PALETTE[0].e, PALETTE[PALETTE.length - 1].e)
  let hi = 1
  while (hi < PALETTE.length - 1 && PALETTE[hi].e < e) hi += 1
  const a = PALETTE[hi - 1]
  const b = PALETTE[hi]
  const t = (e - a.e) / (b.e - a.e)
  return {
    top: mixRgb(a.top, b.top, t),
    upper: mixRgb(a.upper, b.upper, t),
    mid: mixRgb(a.mid, b.mid, t),
    horizon: mixRgb(a.horizon, b.horizon, t)
  }
}

interface ConditionProfile {
  greyMix: number
  darken: number
  milky: boolean
  impliedCloud01: number
  minCloudBand: 0 | 1 | 2 | 3 | 4
}

const CONDITIONS: Record<SkySceneWeatherKind, ConditionProfile> = {
  clear: { greyMix: 0, darken: 0, milky: false, impliedCloud01: 0.08, minCloudBand: 0 },
  unknown: { greyMix: 0, darken: 0, milky: false, impliedCloud01: 0.2, minCloudBand: 1 },
  partly_cloudy: { greyMix: 0.16, darken: 0, milky: false, impliedCloud01: 0.45, minCloudBand: 1 },
  cloudy: { greyMix: 0.45, darken: 0.05, milky: false, impliedCloud01: 0.78, minCloudBand: 2 },
  overcast: { greyMix: 0.68, darken: 0.1, milky: false, impliedCloud01: 0.95, minCloudBand: 3 },
  rain: { greyMix: 0.6, darken: 0.16, milky: false, impliedCloud01: 0.9, minCloudBand: 3 },
  heavy_rain: { greyMix: 0.75, darken: 0.28, milky: false, impliedCloud01: 1, minCloudBand: 4 },
  storm: { greyMix: 0.8, darken: 0.44, milky: false, impliedCloud01: 1, minCloudBand: 4 },
  snow: { greyMix: 0.55, darken: 0, milky: true, impliedCloud01: 0.85, minCloudBand: 3 },
  mist: { greyMix: 0.45, darken: 0.02, milky: true, impliedCloud01: 0.7, minCloudBand: 2 },
  fog: { greyMix: 0.72, darken: 0.05, milky: true, impliedCloud01: 0.92, minCloudBand: 3 }
}

const DAY_GREY: PaletteKey = {
  e: 0,
  top: [100, 112, 124],
  upper: [120, 131, 143],
  mid: [141, 151, 162],
  horizon: [162, 171, 180]
}
const DAY_MILK: PaletteKey = {
  e: 0,
  top: [142, 154, 166],
  upper: [165, 176, 186],
  mid: [188, 198, 207],
  horizon: [211, 219, 226]
}
const NIGHT_GREY: PaletteKey = {
  e: 0,
  top: [11, 15, 22],
  upper: [17, 23, 34],
  mid: [24, 31, 45],
  horizon: [34, 43, 58]
}

interface SunColourKey {
  e: number
  core: Rgb
  mid: Rgb
  edge: Rgb
}

const SUN_COLOURS: SunColourKey[] = [
  { e: 0, core: [255, 240, 215], mid: [255, 180, 100], edge: [255, 120, 50] },
  { e: 8, core: [255, 252, 240], mid: [255, 224, 150], edge: [255, 170, 80] },
  { e: 25, core: [255, 255, 255], mid: [255, 244, 214], edge: [255, 214, 120] }
]

function sunColoursAt(elevationDeg: number): { core: Rgb; mid: Rgb; edge: Rgb } {
  const e = clamp(elevationDeg, SUN_COLOURS[0].e, SUN_COLOURS[SUN_COLOURS.length - 1].e)
  let hi = 1
  while (hi < SUN_COLOURS.length - 1 && SUN_COLOURS[hi].e < e) hi += 1
  const a = SUN_COLOURS[hi - 1]
  const b = SUN_COLOURS[hi]
  const t = (e - a.e) / (b.e - a.e)
  return {
    core: mixRgb(a.core, b.core, t),
    mid: mixRgb(a.mid, b.mid, t),
    edge: mixRgb(a.edge, b.edge, t)
  }
}

const CLOUD_TINTS: Record<SkyScenePhase, { lit: Rgb; shade: Rgb }> = {
  day: { lit: [255, 255, 255], shade: [214, 226, 240] },
  golden: { lit: [255, 225, 180], shade: [226, 180, 168] },
  sunrise: { lit: [255, 190, 140], shade: [178, 120, 152] },
  civil: { lit: [216, 150, 160], shade: [110, 105, 160] },
  nautical: { lit: [120, 130, 175], shade: [58, 66, 105] },
  astro: { lit: [92, 106, 148], shade: [42, 52, 84] },
  night: { lit: [86, 100, 140], shade: [38, 48, 78] }
}

const hasCoords = (
  weather: SkySceneWeatherInput | null
): weather is SkySceneWeatherInput &
  Required<Pick<SkySceneWeatherInput, 'latitude' | 'longitude'>> =>
  !!weather &&
  typeof weather.latitude === 'number' &&
  Number.isFinite(weather.latitude) &&
  typeof weather.longitude === 'number' &&
  Number.isFinite(weather.longitude)

/** Synthetic solar elevation when no coordinates exist: a clock-shaped curve
 * (day ~06:30–20:00 local), reconciled with the snapshot's isDay flag so the
 * only authority we do have wins near the boundaries. */
function syntheticElevation(nowMs: number, weather: SkySceneWeatherInput | null): number {
  const now = new Date(nowMs)
  const hour = now.getHours() + now.getMinutes() / 60
  let elevation = clamp(55 * Math.sin((2 * Math.PI * (hour - 6.5)) / 24), -28, 55)
  if (weather) {
    if (weather.isDay && elevation < 2) elevation = 8
    if (!weather.isDay && elevation > -2) elevation = -8
  }
  return elevation
}

function phaseForElevation(elevationDeg: number): SkyScenePhase {
  if (elevationDeg > 10) return 'day'
  if (elevationDeg > 2) return 'golden'
  if (elevationDeg > SUNSET_ELEVATION_DEG) return 'sunrise'
  if (elevationDeg > -6) return 'civil'
  if (elevationDeg > -12) return 'nautical'
  if (elevationDeg > -18) return 'astro'
  return 'night'
}

export function computeSkyScene(weather: SkySceneWeatherInput | null, nowMs: number): SkyScene {
  const real = hasCoords(weather)
  const elevationDeg = real
    ? solarPosition(nowMs, weather.latitude, weather.longitude).elevationDeg
    : syntheticElevation(nowMs, weather)
  const isSunUp = elevationDeg > SUNSET_ELEVATION_DEG
  const phase = phaseForElevation(elevationDeg)

  // Day/night arc fractions.
  let dayT = 0.5
  let nightT = 0.5
  let maxElevation = 55
  if (real) {
    const events = surroundingSunEvents(nowMs, weather.latitude, weather.longitude)
    if (isSunUp && events.prevSunriseMs !== null && events.nextSunsetMs !== null) {
      const span = events.nextSunsetMs - events.prevSunriseMs
      if (span > 0) dayT = clamp((nowMs - events.prevSunriseMs) / span, 0, 1)
      maxElevation = Math.max(
        8,
        solarPosition(
          (events.prevSunriseMs + events.nextSunsetMs) / 2,
          weather.latitude,
          weather.longitude
        ).elevationDeg
      )
    } else if (!isSunUp && events.prevSunsetMs !== null && events.nextSunriseMs !== null) {
      const span = events.nextSunriseMs - events.prevSunsetMs
      if (span > 0) nightT = clamp((nowMs - events.prevSunsetMs) / span, 0, 1)
    } else {
      // Polar stretch: position by azimuth sweep instead.
      const azimuth = solarPosition(nowMs, weather.latitude, weather.longitude).azimuthDeg
      const sweep = clamp((azimuth - 70) / 220, 0, 1)
      dayT = sweep
      nightT = sweep
    }
  } else {
    const now = new Date(nowMs)
    const hour = now.getHours() + now.getMinutes() / 60
    dayT = clamp((hour - 6.5) / 13.5, 0, 1)
    nightT = clamp(((hour - 20 + 24) % 24) / 10.5, 0, 1)
  }

  const edge: SkySceneEdge =
    phase === 'day' || phase === 'night'
      ? null
      : isSunUp
        ? dayT < 0.5
          ? 'dawn'
          : 'dusk'
        : nightT >= 0.5
          ? 'dawn'
          : 'dusk'

  // Base palette + dawn/dusk hue nudge on the warm band.
  const base = paletteAt(elevationDeg)
  if (edge === 'dawn' && elevationDeg < 8) {
    // Dawns read cooler/pinker than dusks.
    base.horizon = mixRgb(base.horizon, [255, 178, 158], 0.35)
    base.mid = mixRgb(base.mid, [190, 150, 170], 0.2)
  }

  const condition = CONDITIONS[weather?.kind ?? 'unknown']
  const coverPct =
    typeof weather?.cloudCoverPct === 'number' && Number.isFinite(weather.cloudCoverPct)
      ? clamp(weather.cloudCoverPct, 0, 100)
      : null
  const cloud01 = Math.max(coverPct !== null ? coverPct / 100 : 0, condition.impliedCloud01)

  let greyMix = condition.greyMix
  if (
    (weather?.kind === 'clear' ||
      weather?.kind === 'partly_cloudy' ||
      weather?.kind === 'unknown') &&
    coverPct !== null
  ) {
    greyMix = Math.max(greyMix, (coverPct / 100) * 0.4)
  }

  const nightness = clamp((2 - elevationDeg) / 14, 0, 1)
  const greyTargetDay = condition.milky ? DAY_MILK : DAY_GREY
  const applyCondition = (stop: Rgb, key: keyof Omit<PaletteKey, 'e'>): Rgb => {
    const target = mixRgb(greyTargetDay[key], NIGHT_GREY[key], nightness)
    const mixed = mixRgb(stop, target, greyMix)
    return scaleRgb(mixed, 1 - condition.darken)
  }

  const top = applyCondition(base.top, 'top')
  const upper = applyCondition(base.upper, 'upper')
  const mid = applyCondition(base.mid, 'mid')
  const horizon = applyCondition(base.horizon, 'horizon')

  // Sun.
  const elevationRatio = clamp(elevationDeg / maxElevation, 0, 1)
  const sunX = clamp(7 + 86 * dayT, 2, 98)
  const sunY = clamp(88 - 74 * elevationRatio, 12, 94)
  const sunScale = 1 + 0.22 * clamp((12 - elevationDeg) / 12, 0, 1)
  const sunOpacity = isSunUp ? clamp((elevationDeg + 2) / 3, 0, 1) : 0
  const sunColours = sunColoursAt(elevationDeg)
  const sunRayOpacity = clamp((elevationDeg - 4) / 10, 0, 1) * clamp(1 - cloud01 * 1.05, 0, 1)

  // Twilight bloom that follows the sun below the horizon.
  const glowX = isSunUp ? sunX : edge === 'dawn' ? 10 : 90
  const glowOpacity =
    clamp(1 - Math.abs(elevationDeg) / 14, 0, 1) * clamp(1 - cloud01 * 0.7, 0.12, 1) * 0.9
  const glowColor = rgbString(
    mixRgb(
      [255, 148, 72],
      elevationDeg >= 0 ? [255, 208, 130] : [255, 110, 96],
      clamp(Math.abs(elevationDeg) / 10, 0, 1)
    )
  )

  // Moon (night arc; hidden through daylight like the Apple ambient sky).
  const { phase: lunarPhase, illumination } = moonPhase(nowMs)
  const moonVisible = elevationDeg < -1.5
  const moonX = clamp(8 + 84 * nightT, 4, 96)
  const moonY = clamp(80 - 58 * Math.sin(Math.PI * nightT), 14, 88)
  const moonBright =
    clamp((-elevationDeg - 1.5) / 6, 0, 1) *
    (0.45 + 0.55 * illumination) *
    clamp(1 - cloud01 * 0.75, 0.12, 1)

  const starOpacity = clamp((-4 - elevationDeg) / 10, 0, 1) * clamp(1 - cloud01 * 0.9, 0, 1)

  // Clouds.
  const coverBand: 0 | 1 | 2 | 3 | 4 =
    coverPct === null
      ? condition.minCloudBand
      : coverPct < 12
        ? 0
        : coverPct < 35
          ? 1
          : coverPct < 60
            ? 2
            : coverPct < 85
              ? 3
              : 4
  const cloudBand = Math.max(coverBand, condition.minCloudBand) as 0 | 1 | 2 | 3 | 4
  const cloudOpacity = (0.25 + cloudBand * 0.19) * (isSunUp ? 1 : 0.82)
  const tint = CLOUD_TINTS[phase]
  let cloudLit = tint.lit
  let cloudShade = tint.shade
  if (!isSunUp && starOpacity > 0.3) {
    // Moonlit silvering on clear-ish nights.
    cloudLit = mixRgb(cloudLit, [150, 170, 205], illumination * 0.4)
  }
  if (greyMix > 0) {
    const litTarget: Rgb =
      nightness > 0.6 ? [52, 60, 74] : condition.milky ? [225, 231, 238] : [205, 212, 220]
    const shadeTarget: Rgb = nightness > 0.6 ? [30, 36, 48] : [150, 160, 172]
    cloudLit = mixRgb(cloudLit, litTarget, clamp(greyMix * 1.1, 0, 1))
    cloudShade = mixRgb(cloudShade, shadeTarget, clamp(greyMix * 1.1, 0, 1))
  }
  if (condition.darken > 0.2) {
    cloudLit = scaleRgb(cloudLit, 0.82)
    cloudShade = scaleRgb(cloudShade, 0.78)
  }

  // Precipitation.
  const precip =
    typeof weather?.precipitationMmHr === 'number' && Number.isFinite(weather.precipitationMmHr)
      ? Math.max(0, weather.precipitationMmHr)
      : 0
  const kind = weather?.kind ?? 'unknown'
  const rainLevel: 0 | 1 | 2 =
    kind === 'heavy_rain' || kind === 'storm' || (kind === 'rain' && precip >= 4)
      ? 2
      : kind === 'rain'
        ? 1
        : 0
  const snowLevel: 0 | 1 = kind === 'snow' ? 1 : 0
  const wind =
    typeof weather?.windSpeedKph === 'number' && Number.isFinite(weather.windSpeedKph)
      ? Math.max(0, weather.windSpeedKph)
      : 0
  const rainSlantDeg = clamp(6 + wind * 0.35, 6, 26)
  const rainOpacity = clamp(0.4 + precip * 0.1, 0.4, 0.95)
  const fogLevel: 0 | 1 | 2 = kind === 'fog' ? 2 : kind === 'mist' ? 1 : 0

  return {
    isSunUp,
    phase,
    edge,
    elevationDeg,
    top: rgbString(top),
    upper: rgbString(upper),
    mid: rgbString(mid),
    horizon: rgbString(horizon),
    sunX,
    sunY,
    sunScale,
    sunOpacity,
    sunCore: rgbString(sunColours.core),
    sunMid: rgbString(sunColours.mid),
    sunEdge: rgbString(sunColours.edge),
    sunRayOpacity,
    glowX,
    glowOpacity,
    glowColor,
    moonVisible,
    moonX,
    moonY,
    moonPhase: lunarPhase,
    moonIllumination: illumination,
    moonBright,
    starOpacity,
    cloudLit: rgbString(cloudLit),
    cloudShade: rgbString(cloudShade),
    cloudBand,
    cloudOpacity,
    rainLevel,
    snowLevel,
    rainSlantDeg,
    rainOpacity,
    fogLevel,
    stormFlash: kind === 'storm'
  }
}

/** Maps the rich scene onto the legacy 4-phase token some layers still key
 * their CSS off (`living-phase-*`, `sky-phase-*` compatibility). */
export function legacyTimePhase(scene: SkyScene): 'dawn' | 'day' | 'evening' | 'night' {
  if (scene.phase === 'day') return 'day'
  if (scene.phase === 'night' || scene.phase === 'astro' || scene.phase === 'nautical') {
    return 'night'
  }
  return scene.edge === 'dawn' ? 'dawn' : 'evening'
}

/** SVG path for the moon's shadowed portion (viewBox 96×96, disc r=44 at
 * 48,48). `phase`: 0 new → 0.5 full → 1 new; waxing light grows from the
 * right, matching the northern-hemisphere view (mirrored when `southern`). */
export function moonShadowPath(phase: number, southern = false): string | null {
  const p = ((phase % 1) + 1) % 1
  const illuminated = 0.5 * (1 - Math.cos(2 * Math.PI * p))
  if (illuminated > 0.985) return null

  const r = 44
  const cx = 48
  const topY = 4
  const bottomY = 92
  const terminatorRx = Math.abs(r * Math.cos(2 * Math.PI * p))
  const waxing = p < 0.5
  // Shadow sits opposite the lit limb: waxing → shadow on the left.
  const shadowOnLeft = southern ? !waxing : waxing
  const gibbous = illuminated > 0.5

  // Outer edge: the half-circle on the shadow side.
  const outerSweep = shadowOnLeft ? 0 : 1
  // Terminator: bulges INTO the shadow side when gibbous (thin shadow),
  // into the lit side when crescent (fat shadow).
  const bulgeTowardShadow = gibbous
  const innerSweep = shadowOnLeft === bulgeTowardShadow ? 1 : 0

  return (
    `M ${cx} ${topY} ` +
    `A ${r} ${r} 0 0 ${outerSweep} ${cx} ${bottomY} ` +
    `A ${terminatorRx.toFixed(2)} ${r} 0 0 ${innerSweep} ${cx} ${topY} Z`
  )
}
