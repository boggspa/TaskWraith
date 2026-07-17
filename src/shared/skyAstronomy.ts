/**
 * Pure local astronomy for the transcript sky — no network, no Electron.
 *
 * Implements the NOAA solar-position spreadsheet algorithm (accurate to
 * roughly ±0.2° / ±1–2 min of sunrise/sunset for years 1900–2100) plus a
 * mean-synodic moon phase. Shared by:
 *   - main/services/HostWeatherService — offline day/night + sun-times from
 *     last-known coordinates when every network source is unreachable
 *   - renderer/lib/skyScene — continuous sun/moon arcs, twilight palettes and
 *     star density between weather refreshes
 *
 * Everything takes epoch milliseconds and works in UTC internally, so results
 * are identical across host timezones (and unit-testable with fixed instants).
 */

const DEG = Math.PI / 180
const DAY_MS = 86_400_000

/** Solar elevation below which the sun disc is considered set (accounts for
 * refraction + half the disc, the standard 90.833° zenith). */
export const SUNSET_ELEVATION_DEG = -0.833

/** Civil / nautical / astronomical twilight elevation bounds (degrees). */
export const CIVIL_TWILIGHT_DEG = -6
export const NAUTICAL_TWILIGHT_DEG = -12
export const ASTRO_TWILIGHT_DEG = -18

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value))

interface SolarBasis {
  declinationDeg: number
  eqOfTimeMin: number
}

/** Declination + equation-of-time for the given instant (NOAA). */
function solarBasis(atMs: number): SolarBasis {
  const julianDay = atMs / DAY_MS + 2440587.5
  const t = (julianDay - 2451545) / 36525

  const meanLong = (((280.46646 + t * (36000.76983 + t * 0.0003032)) % 360) + 360) % 360
  const meanAnom = 357.52911 + t * (35999.05029 - 0.0001537 * t)
  const eccent = 0.016708634 - t * (0.000042037 + 0.0000001267 * t)
  const eqOfCentre =
    Math.sin(meanAnom * DEG) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
    Math.sin(2 * meanAnom * DEG) * (0.019993 - 0.000101 * t) +
    Math.sin(3 * meanAnom * DEG) * 0.000289
  const trueLong = meanLong + eqOfCentre
  const omega = 125.04 - 1934.136 * t
  const apparentLong = trueLong - 0.00569 - 0.00478 * Math.sin(omega * DEG)

  const meanObliq = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60
  const obliqCorr = meanObliq + 0.00256 * Math.cos(omega * DEG)

  const declinationDeg = Math.asin(Math.sin(obliqCorr * DEG) * Math.sin(apparentLong * DEG)) / DEG

  const varY = Math.tan((obliqCorr / 2) * DEG) ** 2
  const eqOfTimeMin =
    (4 *
      (varY * Math.sin(2 * meanLong * DEG) -
        2 * eccent * Math.sin(meanAnom * DEG) +
        4 * eccent * varY * Math.sin(meanAnom * DEG) * Math.cos(2 * meanLong * DEG) -
        0.5 * varY * varY * Math.sin(4 * meanLong * DEG) -
        1.25 * eccent * eccent * Math.sin(2 * meanAnom * DEG))) /
    DEG
  return { declinationDeg, eqOfTimeMin }
}

export interface SolarPosition {
  /** Degrees above the horizon (refraction-corrected; negative = below). */
  elevationDeg: number
  /** Degrees clockwise from true north. */
  azimuthDeg: number
}

/** Atmospheric refraction correction (degrees) for an apparent elevation. */
function refractionDeg(elevationDeg: number): number {
  if (elevationDeg > 85) return 0
  const tanE = Math.tan(elevationDeg * DEG)
  if (elevationDeg > 5) {
    return (58.1 / tanE - 0.07 / tanE ** 3 + 0.000086 / tanE ** 5) / 3600
  }
  if (elevationDeg > -0.575) {
    return (
      (1735 +
        elevationDeg *
          (-518.2 + elevationDeg * (103.4 + elevationDeg * (-12.79 + elevationDeg * 0.711)))) /
      3600
    )
  }
  return -20.772 / tanE / 3600
}

export function solarPosition(
  atMs: number,
  latitudeDeg: number,
  longitudeDeg: number
): SolarPosition {
  const { declinationDeg, eqOfTimeMin } = solarBasis(atMs)
  const minutesUtc = (((atMs % DAY_MS) + DAY_MS) % DAY_MS) / 60_000
  const trueSolarMin = (((minutesUtc + eqOfTimeMin + 4 * longitudeDeg) % 1440) + 1440) % 1440
  const hourAngleDeg = trueSolarMin / 4 < 0 ? trueSolarMin / 4 + 180 : trueSolarMin / 4 - 180

  const latRad = latitudeDeg * DEG
  const decRad = declinationDeg * DEG
  const cosZenith = clamp(
    Math.sin(latRad) * Math.sin(decRad) +
      Math.cos(latRad) * Math.cos(decRad) * Math.cos(hourAngleDeg * DEG),
    -1,
    1
  )
  const zenithDeg = Math.acos(cosZenith) / DEG
  const rawElevation = 90 - zenithDeg

  const sinZenith = Math.sin(zenithDeg * DEG)
  let azimuthDeg = 180
  if (sinZenith > 1e-6) {
    const cosAz = clamp(
      (Math.sin(latRad) * cosZenith - Math.sin(decRad)) / (Math.cos(latRad) * sinZenith),
      -1,
      1
    )
    const azFromSouth = Math.acos(cosAz) / DEG
    azimuthDeg = hourAngleDeg > 0 ? (azFromSouth + 180) % 360 : (540 - azFromSouth) % 360
  }

  return { elevationDeg: rawElevation + refractionDeg(rawElevation), azimuthDeg }
}

export type SunTimesKind = 'normal' | 'polar-day' | 'polar-night'

export interface SunTimes {
  kind: SunTimesKind
  /** Epoch ms, present only when kind === 'normal'. */
  sunriseMs: number | null
  sunsetMs: number | null
}

/**
 * Sunrise/sunset instants for the UTC day containing `dayAnchorMs`.
 * Polar summer/winter days report `polar-day` / `polar-night` with null times.
 */
export function sunTimesForUtcDay(
  dayAnchorMs: number,
  latitudeDeg: number,
  longitudeDeg: number
): SunTimes {
  const dayStartMs = Math.floor(dayAnchorMs / DAY_MS) * DAY_MS
  // Evaluate declination/EoT near local solar noon for best accuracy.
  const approxNoonMs = dayStartMs + (720 - 4 * longitudeDeg) * 60_000
  const { declinationDeg, eqOfTimeMin } = solarBasis(approxNoonMs)

  const latRad = latitudeDeg * DEG
  const decRad = declinationDeg * DEG
  const cosHourAngle =
    (Math.cos(90.833 * DEG) - Math.sin(latRad) * Math.sin(decRad)) /
    (Math.cos(latRad) * Math.cos(decRad))

  if (cosHourAngle > 1) return { kind: 'polar-night', sunriseMs: null, sunsetMs: null }
  if (cosHourAngle < -1) return { kind: 'polar-day', sunriseMs: null, sunsetMs: null }

  const hourAngleDeg = Math.acos(cosHourAngle) / DEG
  const sunriseMin = 720 - 4 * (longitudeDeg + hourAngleDeg) - eqOfTimeMin
  const sunsetMin = 720 - 4 * (longitudeDeg - hourAngleDeg) - eqOfTimeMin
  return {
    kind: 'normal',
    sunriseMs: dayStartMs + sunriseMin * 60_000,
    sunsetMs: dayStartMs + sunsetMin * 60_000
  }
}

export interface SurroundingSunEvents {
  /** Most recent sunrise at or before now (null in long polar stretches). */
  prevSunriseMs: number | null
  prevSunsetMs: number | null
  nextSunriseMs: number | null
  nextSunsetMs: number | null
}

/**
 * The sunrise/sunset instants bracketing `nowMs`, scanning ±2 UTC days.
 * Gives the renderer its day arc (prev rise → next set) and night arc
 * (prev set → next rise) without caring about host timezone or DST.
 */
export function surroundingSunEvents(
  nowMs: number,
  latitudeDeg: number,
  longitudeDeg: number
): SurroundingSunEvents {
  const rises: number[] = []
  const sets: number[] = []
  for (let dayOffset = -2; dayOffset <= 2; dayOffset += 1) {
    const times = sunTimesForUtcDay(nowMs + dayOffset * DAY_MS, latitudeDeg, longitudeDeg)
    if (times.sunriseMs !== null) rises.push(times.sunriseMs)
    if (times.sunsetMs !== null) sets.push(times.sunsetMs)
  }
  const before = (list: number[]): number | null => {
    const hits = list.filter((value) => value <= nowMs)
    return hits.length > 0 ? Math.max(...hits) : null
  }
  const after = (list: number[]): number | null => {
    const hits = list.filter((value) => value > nowMs)
    return hits.length > 0 ? Math.min(...hits) : null
  }
  return {
    prevSunriseMs: before(rises),
    prevSunsetMs: before(sets),
    nextSunriseMs: after(rises),
    nextSunsetMs: after(sets)
  }
}

export function isSunUp(atMs: number, latitudeDeg: number, longitudeDeg: number): boolean {
  return solarPosition(atMs, latitudeDeg, longitudeDeg).elevationDeg > SUNSET_ELEVATION_DEG
}

/** Greenwich Mean Sidereal Time in degrees [0, 360). */
export function greenwichSiderealTimeDeg(atMs: number): number {
  const julianDay = atMs / DAY_MS + 2440587.5
  const d = julianDay - 2451545
  const t = d / 36525
  const gmst = 280.46061837 + 360.98564736629 * d + 0.000387933 * t * t - (t * t * t) / 38710000
  return ((gmst % 360) + 360) % 360
}

/** Local Sidereal Time in degrees (east longitudes positive). */
export function localSiderealTimeDeg(atMs: number, longitudeDeg: number): number {
  return (((greenwichSiderealTimeDeg(atMs) + longitudeDeg) % 360) + 360) % 360
}

export interface HorizontalPosition {
  altitudeDeg: number
  /** Degrees clockwise from true north. */
  azimuthDeg: number
}

/**
 * Projects a J2000 equatorial position (right ascension / declination, both
 * in degrees) onto the observer's sky. Precession since J2000 is ~0.4° —
 * irrelevant at ambient-art scale, so catalog coordinates are used as-is.
 */
export function equatorialToHorizontal(
  atMs: number,
  latitudeDeg: number,
  longitudeDeg: number,
  rightAscensionDeg: number,
  declinationDeg: number
): HorizontalPosition {
  const hourAngleDeg =
    (((localSiderealTimeDeg(atMs, longitudeDeg) - rightAscensionDeg) % 360) + 360) % 360
  const latRad = latitudeDeg * DEG
  const decRad = declinationDeg * DEG
  const haRad = hourAngleDeg * DEG

  const sinAlt = clamp(
    Math.sin(latRad) * Math.sin(decRad) + Math.cos(latRad) * Math.cos(decRad) * Math.cos(haRad),
    -1,
    1
  )
  const altitudeDeg = Math.asin(sinAlt) / DEG

  const cosAlt = Math.cos(altitudeDeg * DEG)
  let azimuthDeg = 180
  if (cosAlt > 1e-6) {
    const cosAz = clamp(
      (Math.sin(decRad) - sinAlt * Math.sin(latRad)) / (cosAlt * Math.cos(latRad)),
      -1,
      1
    )
    const azFromNorth = Math.acos(cosAz) / DEG
    // Hour angle 0–180° = object west of the meridian (setting side).
    azimuthDeg = hourAngleDeg < 180 ? 360 - azFromNorth : azFromNorth
  }
  return { altitudeDeg, azimuthDeg }
}

export interface MoonPhase {
  /** 0 = new, 0.25 = first quarter, 0.5 = full, 0.75 = last quarter. */
  phase: number
  /** Illuminated fraction of the disc, 0..1. */
  illumination: number
}

/**
 * TRUE lunar phase from Sun–Moon ecliptic elongation (low-precision series,
 * Meeus Astronomical Algorithms ch. 22/25 leading terms, good to ~0.2°).
 *
 * A mean-synodic-cycle approximation was replaced deliberately: real
 * lunations vary 29.27–29.83 days, so the mean cycle drifts up to ~14 h from
 * the actual sky — enough to show the wrong quarter day. Elongation is exact
 * by construction: 0° = new, 90° = first quarter, 180° = full, 270° = last
 * quarter, and it increases monotonically (the Moon outruns the Sun).
 */
export function moonPhase(atMs: number): MoonPhase {
  const t = (atMs / DAY_MS + 2440587.5 - 2451545) / 36525
  const norm = (deg: number): number => ((deg % 360) + 360) % 360

  const meanElongation = 297.8501921 + 445267.1114034 * t
  const sunAnomaly = 357.5291092 + 35999.0502909 * t
  const moonAnomaly = 134.9633964 + 477198.8675055 * t
  const moonLatArg = 93.272095 + 483202.0175233 * t

  const moonLongitude =
    218.3164477 +
    481267.88123421 * t +
    6.288774 * Math.sin(moonAnomaly * DEG) +
    1.274027 * Math.sin((2 * meanElongation - moonAnomaly) * DEG) +
    0.658314 * Math.sin(2 * meanElongation * DEG) +
    0.213618 * Math.sin(2 * moonAnomaly * DEG) -
    0.185116 * Math.sin(sunAnomaly * DEG) -
    0.114332 * Math.sin(2 * moonLatArg * DEG)

  const sunLongitude =
    280.46646 +
    36000.76983 * t +
    1.914602 * Math.sin(sunAnomaly * DEG) +
    0.019993 * Math.sin(2 * sunAnomaly * DEG)

  const elongationDeg = norm(moonLongitude - sunLongitude)
  return {
    phase: elongationDeg / 360,
    illumination: 0.5 * (1 - Math.cos(elongationDeg * DEG))
  }
}
