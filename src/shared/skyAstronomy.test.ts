import { describe, expect, it } from 'vitest'
import {
  SUNSET_ELEVATION_DEG,
  equatorialToHorizontal,
  greenwichSiderealTimeDeg,
  isSunUp,
  moonPhase,
  solarPosition,
  sunTimesForUtcDay,
  surroundingSunEvents
} from './skyAstronomy'

// Cambridge, UK — the reference the feature was tuned against: Apple Weather
// on 2026-07-17 reported sunrise 04:59 / sunset 21:11 BST (03:59 / 20:11 UTC).
const CAMBRIDGE = { lat: 52.2053, lon: 0.1218 }

const utc = (y: number, mo: number, d: number, h: number, mi = 0): number =>
  Date.UTC(y, mo - 1, d, h, mi)

const minutesOfUtcDay = (ms: number): number => Math.round((ms % 86_400_000) / 60_000)

describe('solarPosition', () => {
  it('keeps the Cambridge evening sun above the horizon at 20:33 BST in July', () => {
    // The original regression: the sky showed a moon at 20:33 BST while the
    // sun was demonstrably still up (sunset 21:11 BST).
    const { elevationDeg } = solarPosition(utc(2026, 7, 17, 19, 33), CAMBRIDGE.lat, CAMBRIDGE.lon)
    expect(elevationDeg).toBeGreaterThan(0)
    expect(isSunUp(utc(2026, 7, 17, 19, 33), CAMBRIDGE.lat, CAMBRIDGE.lon)).toBe(true)
  })

  it('has the Cambridge sun clearly set by 21:30 UTC', () => {
    const { elevationDeg } = solarPosition(utc(2026, 7, 17, 21, 30), CAMBRIDGE.lat, CAMBRIDGE.lon)
    expect(elevationDeg).toBeLessThan(SUNSET_ELEVATION_DEG)
  })

  it('matches the textbook noon elevation at Greenwich on the equinox', () => {
    // Equinox: solar declination ~0 → max elevation ≈ 90 − latitude (51.48°)
    // ≈ 38.5°. Solar noon at Greenwich on 2026-03-20 is ~12:07 UTC.
    const { elevationDeg } = solarPosition(utc(2026, 3, 20, 12, 7), 51.4779, 0)
    expect(elevationDeg).toBeGreaterThan(37.3)
    expect(elevationDeg).toBeLessThan(39.7)
  })

  it('puts the equatorial equinox sun nearly overhead at solar noon', () => {
    const { elevationDeg } = solarPosition(utc(2026, 3, 20, 12, 7), 0, 0)
    expect(elevationDeg).toBeGreaterThan(85)
  })

  it('tracks azimuth east → south → west across a northern-hemisphere day', () => {
    const morning = solarPosition(utc(2026, 7, 17, 6, 0), CAMBRIDGE.lat, CAMBRIDGE.lon)
    const noonish = solarPosition(utc(2026, 7, 17, 12, 5), CAMBRIDGE.lat, CAMBRIDGE.lon)
    const evening = solarPosition(utc(2026, 7, 17, 18, 30), CAMBRIDGE.lat, CAMBRIDGE.lon)
    expect(morning.azimuthDeg).toBeGreaterThan(45)
    expect(morning.azimuthDeg).toBeLessThan(135)
    expect(noonish.azimuthDeg).toBeGreaterThan(150)
    expect(noonish.azimuthDeg).toBeLessThan(210)
    expect(evening.azimuthDeg).toBeGreaterThan(225)
    expect(evening.azimuthDeg).toBeLessThan(315)
  })
})

describe('sunTimesForUtcDay', () => {
  it('reproduces the Apple Weather Cambridge sunrise/sunset for 2026-07-17', () => {
    const times = sunTimesForUtcDay(utc(2026, 7, 17, 12), CAMBRIDGE.lat, CAMBRIDGE.lon)
    expect(times.kind).toBe('normal')
    // 04:59 BST = 03:59 UTC = 239 min; 21:11 BST = 20:11 UTC = 1211 min.
    expect(minutesOfUtcDay(times.sunriseMs as number)).toBeGreaterThanOrEqual(233)
    expect(minutesOfUtcDay(times.sunriseMs as number)).toBeLessThanOrEqual(245)
    expect(minutesOfUtcDay(times.sunsetMs as number)).toBeGreaterThanOrEqual(1205)
    expect(minutesOfUtcDay(times.sunsetMs as number)).toBeLessThanOrEqual(1217)
  })

  it('reports polar day in Svalbard midsummer and polar night in midwinter', () => {
    const svalbard = { lat: 78.2232, lon: 15.6267 }
    expect(sunTimesForUtcDay(utc(2026, 7, 17, 12), svalbard.lat, svalbard.lon).kind).toBe(
      'polar-day'
    )
    expect(sunTimesForUtcDay(utc(2026, 1, 5, 12), svalbard.lat, svalbard.lon).kind).toBe(
      'polar-night'
    )
  })
})

describe('surroundingSunEvents', () => {
  it('brackets a Cambridge summer evening with the correct four events', () => {
    const now = utc(2026, 7, 17, 19, 33)
    const events = surroundingSunEvents(now, CAMBRIDGE.lat, CAMBRIDGE.lon)
    expect(events.prevSunriseMs).not.toBeNull()
    expect(events.nextSunsetMs).not.toBeNull()
    expect(events.prevSunsetMs).not.toBeNull()
    expect(events.nextSunriseMs).not.toBeNull()

    // Sun is up: last sunrise this morning, next sunset ~38 min away.
    expect(now - (events.prevSunriseMs as number)).toBeGreaterThan(14 * 3_600_000)
    expect((events.nextSunsetMs as number) - now).toBeLessThan(2 * 3_600_000)
    // Previous sunset was yesterday evening; next sunrise is tomorrow morning.
    expect(now - (events.prevSunsetMs as number)).toBeGreaterThan(20 * 3_600_000)
    expect((events.nextSunriseMs as number) - now).toBeGreaterThan(6 * 3_600_000)
  })

  it('orders night-arc events around local midnight', () => {
    const now = utc(2026, 7, 18, 0, 30)
    const events = surroundingSunEvents(now, CAMBRIDGE.lat, CAMBRIDGE.lon)
    expect(events.prevSunsetMs).not.toBeNull()
    expect(events.nextSunriseMs).not.toBeNull()
    expect(events.prevSunsetMs as number).toBeLessThan(now)
    expect(events.nextSunriseMs as number).toBeGreaterThan(now)
    // Night is short in July: set→rise span under 9 hours.
    expect((events.nextSunriseMs as number) - (events.prevSunsetMs as number)).toBeLessThan(
      9 * 3_600_000
    )
  })
})

describe('moonPhase', () => {
  // Eclipses pin the true phase exactly: a solar eclipse IS new moon, a
  // lunar eclipse IS full moon. The elongation-based phase must nail both
  // far tighter than the old mean-synodic cycle ever could (~14 h drift).
  it('is new at a total solar eclipse (2024-04-08 18:17 UTC)', () => {
    const { phase, illumination } = moonPhase(utc(2024, 4, 8, 18, 17))
    const distanceFromNew = Math.min(phase, 1 - phase)
    expect(distanceFromNew).toBeLessThan(0.01)
    expect(illumination).toBeLessThan(0.005)
  })

  it('is full at a total lunar eclipse (2015-09-28 02:47 UTC)', () => {
    const { phase, illumination } = moonPhase(utc(2015, 9, 28, 2, 47))
    expect(Math.abs(phase - 0.5)).toBeLessThan(0.01)
    expect(illumination).toBeGreaterThan(0.995)
  })

  it('waxes after a new moon and wanes before it', () => {
    const waxing = moonPhase(utc(2024, 4, 11, 21, 0))
    expect(waxing.phase).toBeGreaterThan(0.05)
    expect(waxing.phase).toBeLessThan(0.18)

    const waning = moonPhase(utc(2024, 4, 5, 21, 0))
    expect(waning.phase).toBeGreaterThan(0.82)
    expect(waning.phase).toBeLessThan(0.95)
  })

  it('advances monotonically through a lunation (real cycle, not mean)', () => {
    // New (eclipse) → half a mean month later ≈ full; a full mean month later
    // ≈ new again, within the true-vs-mean lunation wobble (±~0.02 cycles).
    const start = utc(2024, 4, 8, 18, 17)
    const half = moonPhase(start + 14.765 * 86_400_000)
    expect(Math.abs(half.phase - 0.5)).toBeLessThan(0.03)
    const cycle = moonPhase(start + 29.53 * 86_400_000)
    expect(Math.min(cycle.phase, 1 - cycle.phase)).toBeLessThan(0.03)
  })
})

describe('sidereal time + equatorial projection', () => {
  // J2000 star coordinates (RA converted hours -> degrees).
  const POLARIS = { ra: 37.95, dec: 89.26 }
  const VEGA = { ra: 279.23, dec: 38.78 }
  const SIRIUS = { ra: 101.29, dec: -16.72 }
  const ACRUX = { ra: 186.65, dec: -63.1 }

  it('matches the textbook GMST at the J2000 epoch', () => {
    // 2000-01-01 12:00 UTC (JD 2451545.0): GMST = 280.4606°.
    expect(greenwichSiderealTimeDeg(utc(2000, 1, 1, 12, 0))).toBeCloseTo(280.4606, 1)
  })

  it('pins Polaris at the observer latitude, due north, around the clock', () => {
    for (const hour of [0, 6, 12, 18]) {
      const pos = equatorialToHorizontal(
        utc(2026, 7, 17, hour),
        CAMBRIDGE.lat,
        CAMBRIDGE.lon,
        POLARIS.ra,
        POLARIS.dec
      )
      expect(Math.abs(pos.altitudeDeg - CAMBRIDGE.lat)).toBeLessThan(1)
      const northDistance = Math.min(pos.azimuthDeg, 360 - pos.azimuthDeg)
      expect(northDistance).toBeLessThan(2)
    }
  })

  it('puts Vega nearly overhead on a UK July night and Sirius below the horizon', () => {
    const at = utc(2026, 7, 17, 22, 30)
    const vega = equatorialToHorizontal(at, CAMBRIDGE.lat, CAMBRIDGE.lon, VEGA.ra, VEGA.dec)
    expect(vega.altitudeDeg).toBeGreaterThan(55)

    const sirius = equatorialToHorizontal(at, CAMBRIDGE.lat, CAMBRIDGE.lon, SIRIUS.ra, SIRIUS.dec)
    expect(sirius.altitudeDeg).toBeLessThan(0)
  })

  it('raises Sirius in the southern evening sky on a UK January night', () => {
    const sirius = equatorialToHorizontal(
      utc(2026, 1, 15, 22, 0),
      CAMBRIDGE.lat,
      CAMBRIDGE.lon,
      SIRIUS.ra,
      SIRIUS.dec
    )
    expect(sirius.altitudeDeg).toBeGreaterThan(10)
    expect(sirius.azimuthDeg).toBeGreaterThan(120)
    expect(sirius.azimuthDeg).toBeLessThan(240)
  })

  it('never shows the Southern Cross from Cambridge but does from Sydney', () => {
    for (const hour of [0, 6, 12, 18]) {
      const fromUk = equatorialToHorizontal(
        utc(2026, 7, 17, hour),
        CAMBRIDGE.lat,
        CAMBRIDGE.lon,
        ACRUX.ra,
        ACRUX.dec
      )
      expect(fromUk.altitudeDeg).toBeLessThan(0)
    }
    // Sydney mid-winter evening: Crux high in the south.
    const fromSydney = equatorialToHorizontal(utc(2026, 7, 17, 9, 0), -33.87, 151.21, ACRUX.ra, ACRUX.dec)
    expect(fromSydney.altitudeDeg).toBeGreaterThan(20)
  })
})
