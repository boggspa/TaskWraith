import { describe, expect, it } from 'vitest'
import { formatTranscriptClock } from './dateTimeFormat'

// Local-time constructor so the calendar-day math is timezone-independent.
const at = (y: number, m: number, d: number, h: number, min: number): Date =>
  new Date(y, m - 1, d, h, min)

const hhmm = (d: Date): string => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
const weekday = (d: Date): string => d.toLocaleDateString([], { weekday: 'long' })

describe('formatTranscriptClock', () => {
  const now = at(2026, 6, 29, 15, 30) // Monday 29 Jun 2026

  it('returns null for missing / unparseable input', () => {
    expect(formatTranscriptClock(null, now)).toBeNull()
    expect(formatTranscriptClock(undefined, now)).toBeNull()
    expect(formatTranscriptClock('not-a-date', now)).toBeNull()
  })

  it('shows time only for a stamp earlier the same day', () => {
    const d = at(2026, 6, 29, 13, 21)
    expect(formatTranscriptClock(d, now)).toBe(hhmm(d))
  })

  it('shows time only for a future stamp', () => {
    const d = at(2026, 6, 30, 9, 0)
    expect(formatTranscriptClock(d, now)).toBe(hhmm(d))
  })

  it('prefixes the weekday for a previous day within the last 7 days', () => {
    const d = at(2026, 6, 24, 8, 5) // 5 days earlier
    expect(formatTranscriptClock(d, now)).toBe(`${weekday(d)} ${hhmm(d)}`)
  })

  it('still uses the weekday at exactly 7 days ago', () => {
    const d = at(2026, 6, 22, 8, 5) // 7 days earlier
    expect(formatTranscriptClock(d, now)).toBe(`${weekday(d)} ${hhmm(d)}`)
  })

  it('uses DD/MM/YYYY for more than 7 days ago', () => {
    const d = at(2026, 6, 21, 8, 5) // 8 days earlier
    expect(formatTranscriptClock(d, now)).toBe(`21/06/2026 ${hhmm(d)}`)
  })

  it('zero-pads single-digit day and month', () => {
    const d = at(2026, 3, 4, 8, 5)
    expect(formatTranscriptClock(d, at(2026, 6, 29, 15, 30))).toBe(`04/03/2026 ${hhmm(d)}`)
  })

  it('accepts ISO strings as well as Date objects', () => {
    const d = at(2026, 6, 24, 8, 5)
    expect(formatTranscriptClock(d.toISOString(), now)).toBe(formatTranscriptClock(d, now))
  })
})
