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

// Owns the host-weather polling that feeds the sky visual layers. While
// `enabled` is false nothing runs and the last value is retained; when it flips
// true we fetch immediately and then refresh on an interval, falling back to a
// local-clock sky if the lookup throws. Extracted from App() with behavior
// preserved — the only change is that the fallback now reads the clock once
// (via fallbackHostWeather) instead of twice.
export function useHostWeather(enabled: boolean): HostWeatherVisualState | null {
  const [hostWeather, setHostWeather] = useState<HostWeatherVisualState | null>(null)

  useEffect(() => {
    if (!enabled) {
      return
    }

    let isDisposed = false
    const refreshHostWeather = async (): Promise<void> => {
      try {
        const nextWeather = await window.api.getHostWeather()
        if (!isDisposed) {
          setHostWeather(nextWeather)
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
    }
  }, [enabled])

  return hostWeather
}
