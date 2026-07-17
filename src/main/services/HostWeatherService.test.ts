import { describe, expect, it } from 'vitest'
import {
  HOST_WEATHER_CACHE_SCHEMA_VERSION,
  classifyWmoCode,
  composeAstronomyFallback,
  describeWmoCode,
  parseGeoPayload,
  parseOpenMeteoPayload,
  parsePersistedCache
} from './HostWeatherService'

/**
 * The orchestrator (`getCachedHostWeather`) touches network, timers and
 * `app.getPath('userData')` (Electron-only), so — matching FxRateService —
 * these tests exercise the exported pure helpers that own all of the logic:
 * WMO classification, payload validation, and the astronomy fallback that
 * fixes the "moon while the sun is still up" regression.
 */

const CAMBRIDGE = { latitude: 52.2, longitude: 0.1, location: 'Cambridge, United Kingdom' }

describe('classifyWmoCode', () => {
  it('maps the WMO interpretation codes onto sky kinds', () => {
    expect(classifyWmoCode(0)).toBe('clear')
    expect(classifyWmoCode(1)).toBe('clear')
    expect(classifyWmoCode(2)).toBe('partly_cloudy')
    expect(classifyWmoCode(3)).toBe('overcast')
    expect(classifyWmoCode(45)).toBe('fog')
    expect(classifyWmoCode(48)).toBe('fog')
    expect(classifyWmoCode(51)).toBe('rain')
    expect(classifyWmoCode(61)).toBe('rain')
    expect(classifyWmoCode(63)).toBe('rain')
    expect(classifyWmoCode(65)).toBe('heavy_rain')
    expect(classifyWmoCode(80)).toBe('rain')
    expect(classifyWmoCode(82)).toBe('heavy_rain')
    expect(classifyWmoCode(71)).toBe('snow')
    expect(classifyWmoCode(77)).toBe('snow')
    expect(classifyWmoCode(85)).toBe('snow')
    expect(classifyWmoCode(95)).toBe('storm')
    expect(classifyWmoCode(99)).toBe('storm')
    expect(classifyWmoCode(null)).toBe('unknown')
    expect(classifyWmoCode(42)).toBe('unknown')
  })

  it('upgrades partly-cloudy to cloudy under a nearly solid deck', () => {
    expect(classifyWmoCode(2, 40)).toBe('partly_cloudy')
    expect(classifyWmoCode(2, 90)).toBe('cloudy')
  })
})

describe('describeWmoCode', () => {
  it('produces human descriptions with a safe default', () => {
    expect(describeWmoCode(0)).toBe('Clear sky')
    expect(describeWmoCode(95)).toBe('Thunderstorm')
    expect(describeWmoCode(null)).toBe('Local sky')
    expect(describeWmoCode(1234)).toBe('Local sky')
  })
})

describe('parseGeoPayload', () => {
  it('accepts ipapi.co-shaped payloads and rounds to 1 decimal', () => {
    const fix = parseGeoPayload({
      latitude: 52.2053,
      longitude: 0.1218,
      city: 'Cambridge',
      country_name: 'United Kingdom'
    })
    expect(fix).toEqual({
      latitude: 52.2,
      longitude: 0.1,
      location: 'Cambridge, United Kingdom'
    })
  })

  it('accepts ipwho.is-shaped payloads and rejects its success:false envelope', () => {
    expect(
      parseGeoPayload({ success: true, latitude: -33.87, longitude: 151.21, country: 'Australia' })
    ).toEqual({ latitude: -33.9, longitude: 151.2, location: 'Australia' })
    expect(parseGeoPayload({ success: false, message: 'reserved range' })).toBeNull()
  })

  it('rejects malformed or out-of-range coordinates', () => {
    expect(parseGeoPayload(null)).toBeNull()
    expect(parseGeoPayload({})).toBeNull()
    expect(parseGeoPayload({ latitude: '52', longitude: 0 })).toBeNull()
    expect(parseGeoPayload({ latitude: 91, longitude: 0 })).toBeNull()
    expect(parseGeoPayload({ latitude: 0, longitude: 181 })).toBeNull()
  })

  it('round-trips a persisted fix that already carries a composed location', () => {
    expect(parseGeoPayload(CAMBRIDGE)).toEqual(CAMBRIDGE)
  })
})

describe('parseOpenMeteoPayload', () => {
  const nowIso = '2026-07-17T19:33:00.000Z'

  it('builds a full state from a current-conditions payload', () => {
    const state = parseOpenMeteoPayload(
      {
        current: {
          temperature_2m: 21.4,
          relative_humidity_2m: 60,
          is_day: 1,
          precipitation: 0,
          snowfall: 0,
          weather_code: 0,
          cloud_cover: 8,
          wind_speed_10m: 11.3,
          wind_gusts_10m: 22.6
        }
      },
      CAMBRIDGE,
      nowIso
    )
    expect(state).toMatchObject({
      kind: 'clear',
      description: 'Clear sky',
      temperatureC: 21.4,
      isDay: true,
      updatedAt: nowIso,
      source: 'open-meteo',
      latitude: 52.2,
      longitude: 0.1,
      location: 'Cambridge, United Kingdom',
      cloudCoverPct: 8,
      precipitationMmHr: 0,
      windSpeedKph: 11.3,
      windGustKph: 22.6,
      humidityPct: 60
    })
  })

  it('carries night + storm conditions through', () => {
    const state = parseOpenMeteoPayload(
      { current: { is_day: 0, weather_code: 95, cloud_cover: 100, precipitation: 4.2 } },
      CAMBRIDGE,
      nowIso
    )
    expect(state).toMatchObject({ kind: 'storm', isDay: false, precipitationMmHr: 4.2 })
  })

  it('rejects payloads without a usable current block', () => {
    expect(parseOpenMeteoPayload(null, CAMBRIDGE, nowIso)).toBeNull()
    expect(parseOpenMeteoPayload({}, CAMBRIDGE, nowIso)).toBeNull()
    expect(parseOpenMeteoPayload({ current: {} }, CAMBRIDGE, nowIso)).toBeNull()
  })
})

describe('composeAstronomyFallback', () => {
  it('keeps the Cambridge evening DAY at 20:33 BST — the original regression', () => {
    // 2026-07-17 20:33 BST = 19:33 UTC; Cambridge sunset was 21:11 BST. The
    // old fallback called anything past 19:00 "night" and drew a moon.
    const state = composeAstronomyFallback(CAMBRIDGE, Date.UTC(2026, 6, 17, 19, 33))
    expect(state.isDay).toBe(true)
    expect(state.source).toBe('fallback')
    expect(state.latitude).toBe(52.2)
    expect(state.description).toContain('daytime')
  })

  it('goes night after the real sunset', () => {
    const state = composeAstronomyFallback(CAMBRIDGE, Date.UTC(2026, 6, 17, 21, 30))
    expect(state.isDay).toBe(false)
    expect(state.description).toContain('night')
  })
})

describe('parsePersistedCache', () => {
  it('round-trips a valid cache envelope', () => {
    const parsed = parsePersistedCache({
      schemaVersion: HOST_WEATHER_CACHE_SCHEMA_VERSION,
      geo: CAMBRIDGE,
      geoSavedAt: 1_700_000_000_000,
      lastWeather: {
        kind: 'clear',
        description: 'Clear sky',
        isDay: true,
        updatedAt: '2026-07-17T19:33:00.000Z',
        source: 'open-meteo'
      },
      lastWeatherAt: 1_700_000_100_000
    })
    expect(parsed?.geo).toEqual(CAMBRIDGE)
    expect(parsed?.lastWeather?.kind).toBe('clear')
    expect(parsed?.lastWeatherAt).toBe(1_700_000_100_000)
  })

  it('rejects wrong schema versions and fallback-source weather', () => {
    expect(parsePersistedCache({ schemaVersion: 999 })).toBeNull()
    const parsed = parsePersistedCache({
      schemaVersion: HOST_WEATHER_CACHE_SCHEMA_VERSION,
      geo: null,
      geoSavedAt: 0,
      lastWeather: {
        kind: 'unknown',
        description: 'Local night sky',
        isDay: false,
        updatedAt: '2026-07-17T19:33:00.000Z',
        source: 'fallback'
      },
      lastWeatherAt: 5
    })
    expect(parsed?.lastWeather).toBeNull()
  })
})
