import { describe, expect, it } from 'vitest'
import {
  computeSkyScene,
  legacyTimePhase,
  moonShadowPath,
  type SkySceneWeatherInput
} from './skyScene'

const CAMBRIDGE = { latitude: 52.2, longitude: 0.1 }

const utc = (y: number, mo: number, d: number, h: number, mi = 0): number =>
  Date.UTC(y, mo - 1, d, h, mi)

const clearWeather = (overrides: Partial<SkySceneWeatherInput> = {}): SkySceneWeatherInput => ({
  kind: 'clear',
  isDay: true,
  ...CAMBRIDGE,
  cloudCoverPct: 5,
  precipitationMmHr: 0,
  windSpeedKph: 10,
  ...overrides
})

describe('computeSkyScene — the 20:33 BST regression', () => {
  it('keeps a low evening sun (no moon) while the Cambridge sun is still up', () => {
    const scene = computeSkyScene(clearWeather(), utc(2026, 7, 17, 19, 33))
    expect(scene.isSunUp).toBe(true)
    expect(scene.moonVisible).toBe(false)
    expect(scene.sunOpacity).toBeGreaterThan(0.9)
    expect(['golden', 'sunrise']).toContain(scene.phase)
    expect(scene.edge).toBe('dusk')
    // Late in the day: sun far right and low.
    expect(scene.sunX).toBeGreaterThan(75)
    expect(scene.sunY).toBeGreaterThan(60)
    expect(scene.starOpacity).toBe(0)
  })

  it('moves through sunset → civil dusk → night with the moon and stars rising', () => {
    const atSunset = computeSkyScene(clearWeather(), utc(2026, 7, 17, 20, 5))
    expect(atSunset.phase).toBe('sunrise')
    expect(atSunset.glowOpacity).toBeGreaterThan(0.5)

    const civil = computeSkyScene(clearWeather({ isDay: false }), utc(2026, 7, 17, 20, 50))
    expect(civil.phase).toBe('civil')
    expect(civil.isSunUp).toBe(false)
    expect(civil.sunOpacity).toBe(0)
    expect(civil.moonVisible).toBe(true)

    const night = computeSkyScene(clearWeather({ isDay: false }), utc(2026, 7, 18, 0, 30))
    expect(['astro', 'nautical', 'night']).toContain(night.phase)
    expect(night.starOpacity).toBeGreaterThan(0.5)
    expect(night.moonVisible).toBe(true)
  })

  it('tracks the morning as dawn on the east side', () => {
    const dawn = computeSkyScene(clearWeather({ isDay: false }), utc(2026, 7, 17, 3, 30))
    expect(dawn.isSunUp).toBe(false)
    expect(dawn.edge).toBe('dawn')
    expect(dawn.glowX).toBeLessThan(20)

    const morning = computeSkyScene(clearWeather(), utc(2026, 7, 17, 7, 0))
    expect(morning.isSunUp).toBe(true)
    expect(morning.sunX).toBeLessThan(40)
  })

  it('puts the noon sun high with a bright blue palette', () => {
    const noon = computeSkyScene(clearWeather(), utc(2026, 7, 17, 12, 5))
    expect(noon.phase).toBe('day')
    expect(noon.sunY).toBeLessThan(25)
    expect(noon.sunRayOpacity).toBeGreaterThan(0.5)
    // Zenith should be a saturated blue: blue channel dominant.
    const [r, , b] = noon.top.match(/\d+/g)!.map(Number)
    expect(b).toBeGreaterThan(r * 2)
  })
})

describe('computeSkyScene — weather conditioning', () => {
  const noonMs = utc(2026, 7, 17, 12, 5)

  it('desaturates and darkens the palette under storm', () => {
    const clear = computeSkyScene(clearWeather(), noonMs)
    const storm = computeSkyScene(
      clearWeather({ kind: 'storm', cloudCoverPct: 100, precipitationMmHr: 6 }),
      noonMs
    )
    const clearB = Number(clear.top.match(/\d+/g)![2])
    const stormB = Number(storm.top.match(/\d+/g)![2])
    expect(stormB).toBeLessThan(clearB)
    expect(storm.rainLevel).toBe(2)
    expect(storm.stormFlash).toBe(true)
    expect(storm.cloudBand).toBe(4)
    expect(storm.sunRayOpacity).toBe(0)
  })

  it('suppresses stars under heavy cloud at night', () => {
    const nightMs = utc(2026, 7, 18, 0, 30)
    const clearNight = computeSkyScene(clearWeather({ isDay: false }), nightMs)
    const overcastNight = computeSkyScene(
      clearWeather({ isDay: false, kind: 'overcast', cloudCoverPct: 100 }),
      nightMs
    )
    expect(overcastNight.starOpacity).toBeLessThan(clearNight.starOpacity * 0.25)
    expect(overcastNight.moonBright).toBeLessThan(clearNight.moonBright)
  })

  it('maps precipitation kinds onto rain/snow/fog levels and wind onto slant', () => {
    expect(computeSkyScene(clearWeather({ kind: 'rain' }), noonMs).rainLevel).toBe(1)
    expect(computeSkyScene(clearWeather({ kind: 'heavy_rain' }), noonMs).rainLevel).toBe(2)
    expect(
      computeSkyScene(clearWeather({ kind: 'rain', precipitationMmHr: 5 }), noonMs).rainLevel
    ).toBe(2)
    expect(computeSkyScene(clearWeather({ kind: 'snow' }), noonMs).snowLevel).toBe(1)
    expect(computeSkyScene(clearWeather({ kind: 'fog' }), noonMs).fogLevel).toBe(2)
    expect(computeSkyScene(clearWeather({ kind: 'mist' }), noonMs).fogLevel).toBe(1)
    const windy = computeSkyScene(clearWeather({ kind: 'rain', windSpeedKph: 45 }), noonMs)
    const calm = computeSkyScene(clearWeather({ kind: 'rain', windSpeedKph: 0 }), noonMs)
    expect(windy.rainSlantDeg).toBeGreaterThan(calm.rainSlantDeg)
  })

  it('drives cloud coverage bands from cloud cover percent', () => {
    expect(computeSkyScene(clearWeather({ cloudCoverPct: 0 }), noonMs).cloudBand).toBe(0)
    expect(computeSkyScene(clearWeather({ cloudCoverPct: 50 }), noonMs).cloudBand).toBe(2)
    expect(
      computeSkyScene(clearWeather({ kind: 'partly_cloudy', cloudCoverPct: 50 }), noonMs).cloudBand
    ).toBe(2)
    expect(
      computeSkyScene(clearWeather({ kind: 'overcast', cloudCoverPct: 96 }), noonMs).cloudBand
    ).toBe(4)
  })
})

describe('computeSkyScene — clock-only fallback (no coordinates)', () => {
  it('renders a day sky mid-afternoon and honours the isDay flag near bounds', () => {
    const midAfternoon = new Date(2026, 6, 17, 15, 0).getTime()
    const scene = computeSkyScene({ kind: 'unknown', isDay: true }, midAfternoon)
    expect(scene.isSunUp).toBe(true)
    expect(scene.phase).not.toBe('night')

    // 20:33 local with the snapshot saying "day" (the astronomy fallback in
    // main): the scene must trust it and keep a low sun, not a moon.
    const evening = new Date(2026, 6, 17, 20, 33).getTime()
    const eveningScene = computeSkyScene({ kind: 'unknown', isDay: true }, evening)
    expect(eveningScene.isSunUp).toBe(true)
    expect(eveningScene.moonVisible).toBe(false)
  })

  it('renders night at 2am with no weather at all', () => {
    const night = new Date(2026, 6, 17, 2, 0).getTime()
    const scene = computeSkyScene(null, night)
    expect(scene.isSunUp).toBe(false)
    expect(scene.moonVisible).toBe(true)
    expect(scene.starOpacity).toBeGreaterThan(0)
  })
})

describe('legacyTimePhase', () => {
  it('maps rich phases onto the legacy dawn/day/evening/night tokens', () => {
    expect(legacyTimePhase(computeSkyScene(clearWeather(), utc(2026, 7, 17, 12, 0)))).toBe('day')
    expect(
      legacyTimePhase(computeSkyScene(clearWeather({ isDay: false }), utc(2026, 7, 18, 0, 30)))
    ).toBe('night')
    expect(legacyTimePhase(computeSkyScene(clearWeather(), utc(2026, 7, 17, 19, 33)))).toBe(
      'evening'
    )
    expect(legacyTimePhase(computeSkyScene(clearWeather(), utc(2026, 7, 17, 4, 30)))).toBe('dawn')
  })
})

describe('moonShadowPath', () => {
  it('returns null (no shadow) at full moon and a full-disc shadow at new moon', () => {
    expect(moonShadowPath(0.5)).toBeNull()
    const newMoon = moonShadowPath(0)
    expect(newMoon).toContain('A 44 44')
    expect(newMoon).toContain('A 44.00 44')
  })

  it('flattens the terminator at the quarters', () => {
    const firstQuarter = moonShadowPath(0.25)
    expect(firstQuarter).toContain('A 0.00 44')
  })

  it('mirrors for southern-hemisphere viewers', () => {
    const north = moonShadowPath(0.2)
    const south = moonShadowPath(0.2, true)
    expect(north).not.toBe(south)
  })
})
