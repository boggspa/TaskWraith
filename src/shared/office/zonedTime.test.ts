import { describe, expect, it } from 'vitest'
import {
  convertWallTime,
  epochToWallTime,
  isValidTimeZone,
  utcWallTimeToZone,
  wallTimeToUtcEpoch
} from './zonedTime'

const parts = (
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second = 0
): { year: number; month: number; day: number; hour: number; minute: number; second: number } => ({
  year,
  month,
  day,
  hour,
  minute,
  second
})

describe('zone validity', () => {
  it('accepts IANA zones and rejects junk', () => {
    expect(isValidTimeZone('Europe/London')).toBe(true)
    expect(isValidTimeZone('America/New_York')).toBe(true)
    expect(isValidTimeZone('UTC')).toBe(true)
    expect(isValidTimeZone('Not/A_Zone')).toBe(false)
    expect(isValidTimeZone('')).toBe(false)
  })
})

describe('epochToWallTime', () => {
  it('reads known instants in fixed zones', () => {
    // 2026-08-01T12:00:00Z
    const epoch = Date.UTC(2026, 7, 1, 12, 0, 0)
    expect(epochToWallTime('UTC', epoch)).toEqual(parts(2026, 8, 1, 12, 0))
    // BST is UTC+1 in August.
    expect(epochToWallTime('Europe/London', epoch)).toEqual(parts(2026, 8, 1, 13, 0))
    // EDT is UTC-4 in August.
    expect(epochToWallTime('America/New_York', epoch)).toEqual(parts(2026, 8, 1, 8, 0))
    // Kolkata is UTC+5:30 year-round.
    expect(epochToWallTime('Asia/Kolkata', epoch)).toEqual(parts(2026, 8, 1, 17, 30))
  })

  it('handles winter offsets (no DST)', () => {
    const epoch = Date.UTC(2026, 0, 15, 12, 0, 0)
    expect(epochToWallTime('Europe/London', epoch)).toEqual(parts(2026, 1, 15, 12, 0))
    expect(epochToWallTime('America/New_York', epoch)).toEqual(parts(2026, 1, 15, 7, 0))
  })
})

describe('wallTimeToUtcEpoch', () => {
  it('inverts epochToWallTime across DST seasons', () => {
    for (const [zone, wall, expectedUtc] of [
      ['Europe/London', parts(2026, 8, 1, 13, 0), Date.UTC(2026, 7, 1, 12, 0)],
      ['Europe/London', parts(2026, 1, 15, 12, 0), Date.UTC(2026, 0, 15, 12, 0)],
      ['America/New_York', parts(2026, 8, 1, 8, 0), Date.UTC(2026, 7, 1, 12, 0)],
      ['Asia/Kolkata', parts(2026, 8, 1, 17, 30), Date.UTC(2026, 7, 1, 12, 0)]
    ] as const) {
      expect(wallTimeToUtcEpoch(zone, wall)).toBe(expectedUtc)
    }
  })

  it('resolves nonexistent spring-forward times deterministically', () => {
    // US spring-forward 2026: 2026-03-08 02:30 EST does not exist.
    const epoch = wallTimeToUtcEpoch('America/New_York', parts(2026, 3, 8, 2, 30))
    expect(epoch).not.toBeNull()
    const readBack = epochToWallTime('America/New_York', epoch!)
    // Lands on a real neighbouring instant (01:30 or 03:30 wall).
    expect([1, 3]).toContain(readBack!.hour)
    expect(readBack!.minute).toBe(30)
  })

  it('returns null for invalid zones', () => {
    expect(wallTimeToUtcEpoch('Nope/Nope', parts(2026, 1, 1, 0, 0))).toBeNull()
  })
})

describe('convertWallTime / utcWallTimeToZone', () => {
  it('converts London wall time to New York wall time', () => {
    expect(convertWallTime('Europe/London', 'America/New_York', parts(2026, 8, 1, 9, 0))).toEqual(
      parts(2026, 8, 1, 4, 0)
    )
  })

  it('converts UTC wall parts into a zone', () => {
    expect(utcWallTimeToZone('Asia/Kolkata', parts(2026, 8, 1, 12, 0))).toEqual(
      parts(2026, 8, 1, 17, 30)
    )
  })

  it('crosses date boundaries correctly', () => {
    expect(utcWallTimeToZone('Pacific/Auckland', parts(2026, 8, 1, 23, 30))).toEqual(
      parts(2026, 8, 2, 11, 30)
    )
  })
})
