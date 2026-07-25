import { describe, expect, it } from 'vitest'
import {
  buildMonthGrid,
  eventsByDay,
  isoDateOf,
  monthLabel,
  nextIsoDay,
  sortedAgenda
} from './calendarGrid'
import type { CalendarEvent } from './officeModels'

describe('buildMonthGrid', () => {
  it('builds July 2026 starting on Monday with correct padding', () => {
    const weeks = buildMonthGrid(2026, 6, 1)
    // July 1 2026 is a Wednesday → two leading out-of-month days (Mon 29, Tue 30).
    expect(weeks[0][0]).toEqual({ iso: '2026-06-29', dayOfMonth: 29, inMonth: false })
    expect(weeks[0][2]).toEqual({ iso: '2026-07-01', dayOfMonth: 1, inMonth: true })
    expect(weeks.every((week) => week.length === 7)).toBe(true)
    const flat = weeks.flat()
    expect(flat.filter((day) => day.inMonth)).toHaveLength(31)
    expect(flat[flat.length - 1].iso >= '2026-07-31').toBe(true)
  })

  it('supports Sunday-first weeks', () => {
    const weeks = buildMonthGrid(2026, 6, 0)
    expect(weeks[0][0].iso).toBe('2026-06-28')
  })

  it('handles February in a leap year', () => {
    const weeks = buildMonthGrid(2024, 1, 1)
    const inMonth = weeks.flat().filter((day) => day.inMonth)
    expect(inMonth).toHaveLength(29)
  })
})

describe('monthLabel', () => {
  it('labels months and normalizes out-of-range indices', () => {
    expect(monthLabel(2026, 6)).toBe('July 2026')
    expect(monthLabel(2026, 12)).toBe('January 2027')
    expect(monthLabel(2026, -1)).toBe('December 2025')
  })
})

describe('eventsByDay', () => {
  const timed: CalendarEvent = {
    uid: 't',
    title: 'timed',
    start: '2026-07-10T09:00',
    end: '2026-07-10T10:00',
    allDay: false
  }
  const spanning: CalendarEvent = {
    uid: 's',
    title: 'offsite',
    start: '2026-07-20',
    end: '2026-07-23',
    allDay: true
  }

  it('buckets timed events on their day and all-day spans across days (end exclusive)', () => {
    const byDay = eventsByDay([timed, spanning])
    expect(byDay.get('2026-07-10')?.map((event) => event.uid)).toEqual(['t'])
    expect(byDay.get('2026-07-20')?.map((event) => event.uid)).toEqual(['s'])
    expect(byDay.get('2026-07-22')?.map((event) => event.uid)).toEqual(['s'])
    expect(byDay.get('2026-07-23')).toBeUndefined()
  })

  it('sorts same-day events by start and produces a sorted agenda', () => {
    const later: CalendarEvent = {
      ...timed,
      uid: 'later',
      start: '2026-07-10T11:00',
      end: '2026-07-10T12:00'
    }
    const agenda = sortedAgenda([later, timed, spanning])
    expect(agenda[0][0]).toBe('2026-07-10')
    expect(agenda[0][1].map((event) => event.uid)).toEqual(['t', 'later'])
    expect(agenda.map(([day]) => day)).toEqual([
      '2026-07-10',
      '2026-07-20',
      '2026-07-21',
      '2026-07-22'
    ])
  })
})

describe('date helpers', () => {
  it('advances days across boundaries', () => {
    expect(nextIsoDay('2026-07-31')).toBe('2026-08-01')
    expect(isoDateOf(2026, 11, 32)).toBe('2027-01-01')
  })
})
