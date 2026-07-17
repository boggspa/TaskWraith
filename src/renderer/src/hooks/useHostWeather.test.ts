import { describe, expect, it } from 'vitest'
import { fallbackHostWeather, isStaleHostWeather } from './useHostWeather'

// Assertions are derived from the same `date.getHours()` the implementation
// reads, so they hold regardless of the machine/CI timezone.
describe('fallbackHostWeather', () => {
  it('is always an "unknown" sky from the fallback source', () => {
    const weather = fallbackHostWeather(new Date('2026-06-13T10:00:00'))
    expect(weather.kind).toBe('unknown')
    expect(weather.source).toBe('fallback')
  })

  it('stamps updatedAt with the provided clock', () => {
    const date = new Date('2026-06-13T10:00:00')
    expect(fallbackHostWeather(date).updatedAt).toBe(date.toISOString())
  })

  it('labels 07:00–18:59 local as daytime', () => {
    for (const hour of [7, 12, 18]) {
      const date = new Date(2026, 5, 13, hour, 0, 0)
      const weather = fallbackHostWeather(date)
      expect(weather.isDay).toBe(true)
      expect(weather.description).toBe('Local daytime sky')
    }
  })

  it('labels 19:00–06:59 local as night', () => {
    for (const hour of [0, 6, 19, 23]) {
      const date = new Date(2026, 5, 13, hour, 0, 0)
      const weather = fallbackHostWeather(date)
      expect(weather.isDay).toBe(false)
      expect(weather.description).toBe('Local night sky')
    }
  })

  it('keeps isDay and the description label in agreement', () => {
    for (let hour = 0; hour < 24; hour += 1) {
      const weather = fallbackHostWeather(new Date(2026, 5, 13, hour, 0, 0))
      expect(weather.description).toBe(weather.isDay ? 'Local daytime sky' : 'Local night sky')
    }
  })
})

describe('isStaleHostWeather', () => {
  const at = (iso: string) => fallbackHostWeather(new Date(iso))

  it('flags snapshots older than the refresh TTL (stale-while-revalidate answers)', () => {
    const nowMs = Date.parse('2026-07-17T21:00:00.000Z')
    expect(isStaleHostWeather(at('2026-07-17T20:59:00.000Z'), nowMs)).toBe(false)
    expect(isStaleHostWeather(at('2026-07-17T20:46:00.000Z'), nowMs)).toBe(false)
    expect(isStaleHostWeather(at('2026-07-17T20:30:00.000Z'), nowMs)).toBe(true)
    expect(isStaleHostWeather(at('2026-07-17T09:00:00.000Z'), nowMs)).toBe(true)
  })

  it('treats an unparseable timestamp as fresh (no follow-up churn)', () => {
    const weather = { ...at('2026-07-17T20:59:00.000Z'), updatedAt: 'not-a-date' }
    expect(isStaleHostWeather(weather, Date.parse('2026-07-17T21:00:00.000Z'))).toBe(false)
  })
})
