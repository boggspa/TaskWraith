import { useEffect, useState } from 'react'
import type { HostWeatherVisualState } from '../components/FxLayers'

// Re-fetch the host weather on this cadence while the sky visual FX are
// enabled. Matches the main-process Open-Meteo cache TTL so a refresh here
// actually observes new conditions instead of the cached snapshot.
const SKY_WEATHER_REFRESH_MS = 15 * 60 * 1000

// Best-effort local sky used when the host weather lookup fails. Kept pure (the
// clock is passed in) so it can be unit-tested without a DOM; it derives the
// day/night split from the local hour exactly as the original inline effect did.
export function fallbackHostWeather(now: Date): HostWeatherVisualState {
  const hour = now.getHours()
  const isDay = hour >= 7 && hour < 19
  return {
    kind: 'unknown',
    description: isDay ? 'Local daytime sky' : 'Local night sky',
    isDay,
    updatedAt: now.toISOString(),
    source: 'fallback'
  }
}

// How long after a STALE snapshot (main answered stale-while-revalidate) to
// poll again for the background-refreshed conditions.
const SKY_WEATHER_FOLLOW_UP_MS = 12_000

// A snapshot older than the main-process TTL means main answered from its
// stale cache while a refresh runs in the background. Exported for tests.
export function isStaleHostWeather(weather: HostWeatherVisualState, nowMs: number): boolean {
  const updatedAtMs = Date.parse(weather.updatedAt)
  return Number.isFinite(updatedAtMs) && nowMs - updatedAtMs > SKY_WEATHER_REFRESH_MS
}

// Owns the host-weather polling that feeds the sky visual layers. While
// `enabled` is false nothing runs and the last value is retained; when it flips
// true we fetch immediately and then refresh on an interval, falling back to a
// local-clock sky if the lookup throws. A stale-while-revalidate answer from
// main (instant, astronomy-corrected, but conditions possibly old) schedules
// ONE follow-up poll to collect the freshly fetched conditions.
export function useHostWeather(enabled: boolean): HostWeatherVisualState | null {
  const [hostWeather, setHostWeather] = useState<HostWeatherVisualState | null>(null)

  useEffect(() => {
    if (!enabled) {
      return
    }

    let isDisposed = false
    let followUpTimer: number | undefined
    const refreshHostWeather = async (isFollowUp = false): Promise<void> => {
      try {
        const nextWeather = await window.api.getHostWeather()
        if (isDisposed) {
          return
        }
        setHostWeather(nextWeather)
        if (!isFollowUp && followUpTimer === undefined && isStaleHostWeather(nextWeather, Date.now())) {
          followUpTimer = window.setTimeout(() => {
            followUpTimer = undefined
            void refreshHostWeather(true)
          }, SKY_WEATHER_FOLLOW_UP_MS)
        }
      } catch {
        if (!isDisposed) {
          setHostWeather(fallbackHostWeather(new Date()))
        }
      }
    }

    void refreshHostWeather()
    const weatherInterval = window.setInterval(() => {
      void refreshHostWeather()
    }, SKY_WEATHER_REFRESH_MS)

    return () => {
      isDisposed = true
      window.clearInterval(weatherInterval)
      if (followUpTimer !== undefined) {
        window.clearTimeout(followUpTimer)
      }
    }
  }, [enabled])

  return hostWeather
}
