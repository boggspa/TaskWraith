/**
 * Pure month-grid math for the Calendar editor. All date arithmetic uses
 * Date.UTC so results are timezone-independent and deterministic in tests.
 */

import type { CalendarEvent } from './officeModels'

export interface CalendarGridDay {
  /** 'YYYY-MM-DD' */
  iso: string
  dayOfMonth: number
  inMonth: boolean
}

const pad = (value: number): string => String(value).padStart(2, '0')

export const isoDateOf = (year: number, monthIndex: number, day: number): string => {
  const date = new Date(Date.UTC(year, monthIndex, day))
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
}

/**
 * Weeks (rows of 7) covering the given month. `weekStartsOn`: 0 = Sunday,
 * 1 = Monday (default).
 */
export function buildMonthGrid(
  year: number,
  monthIndex: number,
  weekStartsOn: 0 | 1 = 1
): CalendarGridDay[][] {
  const firstOfMonth = new Date(Date.UTC(year, monthIndex, 1))
  const firstWeekday = firstOfMonth.getUTCDay()
  const leading = (firstWeekday - weekStartsOn + 7) % 7
  const daysInMonth = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate()
  const totalCells = Math.ceil((leading + daysInMonth) / 7) * 7

  const weeks: CalendarGridDay[][] = []
  let week: CalendarGridDay[] = []
  for (let cell = 0; cell < totalCells; cell += 1) {
    const dayOffset = cell - leading + 1
    const date = new Date(Date.UTC(year, monthIndex, dayOffset))
    week.push({
      iso: isoDateOf(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
      dayOfMonth: date.getUTCDate(),
      inMonth: date.getUTCMonth() === ((monthIndex % 12) + 12) % 12
    })
    if (week.length === 7) {
      weeks.push(week)
      week = []
    }
  }
  return weeks
}

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December'
]

export function monthLabel(year: number, monthIndex: number): string {
  const normalizedMonth = ((monthIndex % 12) + 12) % 12
  const normalizedYear = year + Math.floor(monthIndex / 12)
  return `${MONTH_NAMES[normalizedMonth]} ${normalizedYear}`
}

export const WEEKDAY_LABELS_MONDAY_FIRST = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

const eventStartDate = (event: CalendarEvent): string => event.start.slice(0, 10)
const eventEndDateExclusive = (event: CalendarEvent): string => {
  if (event.allDay) return event.end
  return event.end.slice(0, 10)
}

/**
 * Buckets events by ISO day. All-day events span start → end (exclusive);
 * timed events land on each day they touch (inclusive of the end's day).
 */
export function eventsByDay(events: readonly CalendarEvent[]): Map<string, CalendarEvent[]> {
  const byDay = new Map<string, CalendarEvent[]>()
  const push = (iso: string, event: CalendarEvent): void => {
    const bucket = byDay.get(iso)
    if (bucket) bucket.push(event)
    else byDay.set(iso, [event])
  }
  for (const event of events) {
    const startIso = eventStartDate(event)
    const endIso = eventEndDateExclusive(event)
    if (startIso > endIso) {
      push(startIso, event)
      continue
    }
    let cursor = startIso
    let guard = 0
    while (guard < 366) {
      if (event.allDay ? cursor >= endIso : cursor > endIso) break
      push(cursor, event)
      if (!event.allDay && cursor === endIso) break
      cursor = nextIsoDay(cursor)
      guard += 1
    }
  }
  for (const bucket of byDay.values()) {
    bucket.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))
  }
  return byDay
}

export function nextIsoDay(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
  if (!match) return iso
  return isoDateOf(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + 1)
}

/** Sorted flat agenda: [dayIso, events] pairs in ascending date order. */
export function sortedAgenda(events: readonly CalendarEvent[]): [string, CalendarEvent[]][] {
  return [...eventsByDay(events).entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
}
