/**
 * Local weather + astronomy snapshot for the transcript sky visuals.
 *
 * 1.8.5 — rewritten from wttr.in (spawned curl, chronically rate-limited, and
 * a hard-coded 07:00–19:00 "daytime" fallback that showed a moon while the UK
 * summer sun was still up) to:
 *
 *   1. IP geolocation (ipapi.co → ipwho.is, both free/keyless) — coordinates
 *      rounded to 1 decimal (~11 km) before they are stored or leave main.
 *   2. Open-Meteo current conditions (free, keyless, no signup) — WMO weather
 *      code, cloud cover, precipitation, wind, humidity and the API's is_day.
 *   3. `shared/skyAstronomy` — offline sunrise/sunset/day-night from the
 *      last-known coordinates when every network source is unreachable, so
 *      the sky stays astronomically correct even fully offline.
 *
 * Coordinates + the last good snapshot persist to a single tiny JSON in
 * userData (async, bounded — see the persistence-freeze landmine) so restarts
 * are instant and offline launches keep the real sky.
 *
 * Pure helpers (`classifyWmoCode`, `describeWmoCode`, `parseGeoPayload`,
 * `parseOpenMeteoPayload`, `composeAstronomyFallback`, `parsePersistedCache`)
 * are exported for the test suite; the orchestrator (`getCachedHostWeather`)
 * touches network + Electron paths and is exercised live.
 */

import { app } from 'electron'
import { join } from 'node:path'
import { promises as fs } from 'node:fs'
import { isSunUp } from '../../shared/skyAstronomy'

type HostWeatherKind =
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

export interface HostWeatherState {
  kind: HostWeatherKind
  description: string
  temperatureC?: number
  location?: string
  isDay: boolean
  updatedAt: string
  source: 'open-meteo' | 'fallback'
  error?: string
  /** Coordinates rounded to 1 decimal place (~11 km) for privacy. */
  latitude?: number
  longitude?: number
  cloudCoverPct?: number
  precipitationMmHr?: number
  snowfallCmHr?: number
  windSpeedKph?: number
  windGustKph?: number
  humidityPct?: number
}

interface GeoFix {
  latitude: number
  longitude: number
  location?: string
}

const WEATHER_CACHE_MS = 15 * 60 * 1000
const GEO_CACHE_MS = 24 * 60 * 60 * 1000
const STALE_WEATHER_REUSE_MS = 6 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 6_000
const CACHE_FILENAME = 'host-weather-cache.json'
export const HOST_WEATHER_CACHE_SCHEMA_VERSION = 1

let weatherCache: HostWeatherState | null = null
let weatherCacheAt = 0
let geoCache: GeoFix | null = null
let geoCacheAt = 0
let persistedLoaded = false
let inflight: Promise<HostWeatherState> | null = null

function cachePath(): string {
  return join(app.getPath('userData'), CACHE_FILENAME)
}

const roundCoord = (value: number): number => Math.round(value * 10) / 10

/** Maps a WMO weather interpretation code (Open-Meteo `weather_code`) to the
 * sky-visual kind. `cloudCoverPct` upgrades "partly cloudy" to "cloudy" when
 * the deck is nearly solid. */
export function classifyWmoCode(code: number | null, cloudCoverPct?: number): HostWeatherKind {
  if (code === null || !Number.isFinite(code)) return 'unknown'
  if (code === 95 || code === 96 || code === 99) return 'storm'
  if ([71, 73, 75, 77, 85, 86].includes(code)) return 'snow'
  if (code === 65 || code === 82) return 'heavy_rain'
  if ([51, 53, 55, 56, 57, 61, 63, 66, 67, 80, 81].includes(code)) return 'rain'
  if (code === 45 || code === 48) return 'fog'
  if (code === 3) return 'overcast'
  if (code === 2) {
    return typeof cloudCoverPct === 'number' && cloudCoverPct >= 78 ? 'cloudy' : 'partly_cloudy'
  }
  if (code === 0 || code === 1) return 'clear'
  return 'unknown'
}

const WMO_DESCRIPTIONS: Record<number, string> = {
  0: 'Clear sky',
  1: 'Mainly clear',
  2: 'Partly cloudy',
  3: 'Overcast',
  45: 'Fog',
  48: 'Rime fog',
  51: 'Light drizzle',
  53: 'Drizzle',
  55: 'Dense drizzle',
  56: 'Freezing drizzle',
  57: 'Freezing drizzle',
  61: 'Light rain',
  63: 'Rain',
  65: 'Heavy rain',
  66: 'Freezing rain',
  67: 'Freezing rain',
  71: 'Light snow',
  73: 'Snow',
  75: 'Heavy snow',
  77: 'Snow grains',
  80: 'Light rain showers',
  81: 'Rain showers',
  82: 'Violent rain showers',
  85: 'Snow showers',
  86: 'Heavy snow showers',
  95: 'Thunderstorm',
  96: 'Thunderstorm with hail',
  99: 'Thunderstorm with hail'
}

export function describeWmoCode(code: number | null): string {
  if (code === null || !Number.isFinite(code)) return 'Local sky'
  return WMO_DESCRIPTIONS[code] ?? 'Local sky'
}

const finiteOrUndefined = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

/** Validates an ipapi.co / ipwho.is response into a rounded GeoFix. */
export function parseGeoPayload(payload: unknown): GeoFix | null {
  if (!payload || typeof payload !== 'object') return null
  const p = payload as Record<string, unknown>
  // ipwho.is responds 200 with { success: false } on failure.
  if (p.success === false) return null
  const latitude = finiteOrUndefined(p.latitude)
  const longitude = finiteOrUndefined(p.longitude)
  if (
    latitude === undefined ||
    longitude === undefined ||
    Math.abs(latitude) > 90 ||
    Math.abs(longitude) > 180
  ) {
    return null
  }
  const city = typeof p.city === 'string' && p.city.trim() ? p.city.trim() : null
  const country =
    typeof p.country_name === 'string' && p.country_name.trim()
      ? p.country_name.trim()
      : typeof p.country === 'string' && p.country.trim()
        ? p.country.trim()
        : null
  // Accept a pre-composed `location` too so the persisted cache round-trips.
  const preComposed = typeof p.location === 'string' && p.location.trim() ? p.location.trim() : null
  const location = [city, country].filter(Boolean).join(', ') || preComposed || undefined
  return {
    latitude: roundCoord(latitude),
    longitude: roundCoord(longitude),
    ...(location ? { location } : {})
  }
}

/** Validates an Open-Meteo `current=` response into a HostWeatherState. */
export function parseOpenMeteoPayload(
  payload: unknown,
  geo: GeoFix,
  nowIso: string
): HostWeatherState | null {
  if (!payload || typeof payload !== 'object') return null
  const current = (payload as Record<string, unknown>).current
  if (!current || typeof current !== 'object') return null
  const c = current as Record<string, unknown>

  const code = finiteOrUndefined(c.weather_code) ?? null
  const cloudCoverPct = finiteOrUndefined(c.cloud_cover)
  const isDayRaw = c.is_day
  const isDay = isDayRaw === 1 || isDayRaw === true
  if (code === null && isDayRaw === undefined) return null

  const state: HostWeatherState = {
    kind: classifyWmoCode(code, cloudCoverPct),
    description: describeWmoCode(code),
    isDay,
    updatedAt: nowIso,
    source: 'open-meteo',
    latitude: geo.latitude,
    longitude: geo.longitude
  }
  const temperatureC = finiteOrUndefined(c.temperature_2m)
  if (temperatureC !== undefined) state.temperatureC = temperatureC
  if (geo.location) state.location = geo.location
  if (cloudCoverPct !== undefined) state.cloudCoverPct = cloudCoverPct
  const precipitation = finiteOrUndefined(c.precipitation)
  if (precipitation !== undefined) state.precipitationMmHr = precipitation
  const snowfall = finiteOrUndefined(c.snowfall)
  if (snowfall !== undefined) state.snowfallCmHr = snowfall
  const wind = finiteOrUndefined(c.wind_speed_10m)
  if (wind !== undefined) state.windSpeedKph = wind
  const gust = finiteOrUndefined(c.wind_gusts_10m)
  if (gust !== undefined) state.windGustKph = gust
  const humidity = finiteOrUndefined(c.relative_humidity_2m)
  if (humidity !== undefined) state.humidityPct = humidity
  return state
}

/** Offline state from known coordinates: astronomically correct day/night via
 * the shared solar math, unknown conditions. The renderer still gets the full
 * sun/moon/twilight treatment because the coordinates ride along. */
export function composeAstronomyFallback(
  geo: GeoFix,
  nowMs: number,
  error?: string
): HostWeatherState {
  const isDay = isSunUp(nowMs, geo.latitude, geo.longitude)
  const state: HostWeatherState = {
    kind: 'unknown',
    description: isDay ? 'Local daytime sky (offline)' : 'Local night sky (offline)',
    isDay,
    updatedAt: new Date(nowMs).toISOString(),
    source: 'fallback',
    latitude: geo.latitude,
    longitude: geo.longitude
  }
  if (geo.location) state.location = geo.location
  if (error) state.error = error
  return state
}

/** Last-resort state with no coordinates at all: local-clock day banding. */
function composeClockFallback(nowMs: number, error?: string): HostWeatherState {
  const hour = new Date(nowMs).getHours()
  const isDay = hour >= 7 && hour < 19
  const state: HostWeatherState = {
    kind: 'unknown',
    description: isDay ? 'Local daytime sky' : 'Local night sky',
    isDay,
    updatedAt: new Date(nowMs).toISOString(),
    source: 'fallback'
  }
  if (error) state.error = error
  return state
}

interface PersistedCache {
  schemaVersion: number
  geo: GeoFix | null
  geoSavedAt: number
  lastWeather: HostWeatherState | null
  lastWeatherAt: number
}

/** Pure parser for the persisted cache file. Returns null on any structural
 * mismatch so corrupted files fall back to a clean refetch. */
export function parsePersistedCache(payload: unknown): PersistedCache | null {
  if (!payload || typeof payload !== 'object') return null
  const p = payload as Record<string, unknown>
  if (p.schemaVersion !== HOST_WEATHER_CACHE_SCHEMA_VERSION) return null
  const geo = parseGeoPayload(p.geo)
  const geoSavedAt = finiteOrUndefined(p.geoSavedAt) ?? 0
  let lastWeather: HostWeatherState | null = null
  const rawWeather = p.lastWeather
  if (rawWeather && typeof rawWeather === 'object') {
    const w = rawWeather as Record<string, unknown>
    if (
      typeof w.kind === 'string' &&
      typeof w.description === 'string' &&
      typeof w.isDay === 'boolean' &&
      typeof w.updatedAt === 'string' &&
      w.source === 'open-meteo'
    ) {
      lastWeather = w as unknown as HostWeatherState
    }
  }
  return {
    schemaVersion: HOST_WEATHER_CACHE_SCHEMA_VERSION,
    geo,
    geoSavedAt,
    lastWeather,
    lastWeatherAt: finiteOrUndefined(p.lastWeatherAt) ?? 0
  }
}

async function loadPersistedCacheOnce(): Promise<void> {
  if (persistedLoaded) return
  persistedLoaded = true
  try {
    const raw = await fs.readFile(cachePath(), 'utf8')
    const parsed = parsePersistedCache(JSON.parse(raw))
    if (!parsed) return
    if (parsed.geo && !geoCache) {
      geoCache = parsed.geo
      geoCacheAt = parsed.geoSavedAt
    }
    if (parsed.lastWeather && !weatherCache) {
      weatherCache = parsed.lastWeather
      weatherCacheAt = parsed.lastWeatherAt
    }
  } catch {
    // Missing or unreadable cache file — first launch, or fine to refetch.
  }
}

function persistCache(): void {
  const payload: PersistedCache = {
    schemaVersion: HOST_WEATHER_CACHE_SCHEMA_VERSION,
    geo: geoCache,
    geoSavedAt: geoCacheAt,
    lastWeather: weatherCache?.source === 'open-meteo' ? weatherCache : null,
    lastWeatherAt: weatherCache?.source === 'open-meteo' ? weatherCacheAt : 0
  }
  void fs.writeFile(cachePath(), JSON.stringify(payload), 'utf8').catch(() => {})
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { accept: 'application/json' }
  })
  if (!response.ok) {
    throw new Error(`${new URL(url).hostname} responded ${response.status}`)
  }
  return response.json()
}

async function resolveGeoFix(nowMs: number): Promise<GeoFix | null> {
  if (geoCache && nowMs - geoCacheAt < GEO_CACHE_MS) return geoCache
  for (const url of ['https://ipapi.co/json/', 'https://ipwho.is/']) {
    try {
      const fix = parseGeoPayload(await fetchJson(url))
      if (fix) {
        geoCache = fix
        geoCacheAt = nowMs
        return fix
      }
    } catch {
      // Try the next provider; stale coordinates below beat no coordinates.
    }
  }
  // Both providers unreachable: reuse stale coordinates indefinitely — the
  // machine rarely moves far, and real coords keep the astronomy correct.
  return geoCache
}

function openMeteoUrl(geo: GeoFix): string {
  const params = new URLSearchParams({
    latitude: String(geo.latitude),
    longitude: String(geo.longitude),
    current: [
      'temperature_2m',
      'relative_humidity_2m',
      'is_day',
      'precipitation',
      'snowfall',
      'weather_code',
      'cloud_cover',
      'wind_speed_10m',
      'wind_gusts_10m'
    ].join(','),
    wind_speed_unit: 'kmh',
    timezone: 'auto'
  })
  return `https://api.open-meteo.com/v1/forecast?${params.toString()}`
}

async function readHostWeather(): Promise<HostWeatherState> {
  const nowMs = Date.now()
  const geo = await resolveGeoFix(nowMs)
  if (!geo) {
    return composeClockFallback(nowMs, 'location lookup unavailable')
  }
  try {
    const state = parseOpenMeteoPayload(
      await fetchJson(openMeteoUrl(geo)),
      geo,
      new Date(nowMs).toISOString()
    )
    if (state) return state
    return composeAstronomyFallback(geo, nowMs, 'weather payload malformed')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // Recent good conditions beat "unknown": reuse them (astronomy-corrected
    // day/night) for up to 6 h before degrading to the unknown-condition sky.
    if (weatherCache?.source === 'open-meteo' && nowMs - weatherCacheAt < STALE_WEATHER_REUSE_MS) {
      return {
        ...weatherCache,
        isDay: isSunUp(nowMs, geo.latitude, geo.longitude),
        updatedAt: new Date(nowMs).toISOString(),
        error: message
      }
    }
    return composeAstronomyFallback(geo, nowMs, message)
  }
}

export async function getCachedHostWeather(): Promise<HostWeatherState> {
  await loadPersistedCacheOnce()
  const nowMs = Date.now()
  if (weatherCache && nowMs - weatherCacheAt < WEATHER_CACHE_MS) {
    return weatherCache
  }
  if (!inflight) {
    inflight = readHostWeather()
      .then((state) => {
        weatherCache = state
        weatherCacheAt = Date.now()
        if (state.source === 'open-meteo') persistCache()
        return state
      })
      .finally(() => {
        inflight = null
      })
  }
  // Stale-while-revalidate: a cold launch must never leave the renderer
  // weatherless while the network round-trip runs — the sky layer would boot
  // on its clock-only guess (a UK summer 21:50 reads as deep night → a full
  // starfield that then visibly fades once real astronomy arrives). Answer
  // instantly from the persisted snapshot with day/night recomputed from its
  // coordinates; the refresh lands for the renderer's follow-up poll.
  if (weatherCache && nowMs - weatherCacheAt < STALE_WEATHER_REUSE_MS) {
    if (weatherCache.latitude !== undefined && weatherCache.longitude !== undefined) {
      return {
        ...weatherCache,
        isDay: isSunUp(nowMs, weatherCache.latitude, weatherCache.longitude)
      }
    }
    return weatherCache
  }
  // Snapshot too old to trust its conditions, but known coordinates still
  // give the correct sun/moon/twilight immediately (kind stays 'unknown').
  if (geoCache) {
    return composeAstronomyFallback(geoCache, nowMs)
  }
  return inflight
}

/** Test-only: clears module caches so orchestration cases start clean. */
export function __resetHostWeatherServiceForTests(): void {
  weatherCache = null
  weatherCacheAt = 0
  geoCache = null
  geoCacheAt = 0
  persistedLoaded = true
  inflight = null
}
