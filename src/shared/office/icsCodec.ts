/**
 * iCalendar (RFC 5545) codec for the Calendar editor. Round-trip safe by
 * design: properties and nested blocks the model does not represent (RRULE,
 * ATTENDEE, VALARM…) are preserved verbatim in `extraProperties` and
 * re-emitted on save, so editing a title never strips a recurrence.
 *
 * Timezone stance (v1): DTSTART/DTEND wall times are taken as written —
 * TZID parameters and trailing `Z` markers are surfaced as warnings rather
 * than converted, since no zone database is available here.
 */

import type { CalendarDocumentModel, CalendarEvent } from './officeModels'

export interface IcsParseResult {
  model: CalendarDocumentModel
  warnings: string[]
}

/** RFC 5545 3.1 line unfolding: a CRLF followed by space/tab continues the line. */
export function unfoldIcsLines(text: string): string[] {
  const rawLines = text.split(/\r\n|\n|\r/)
  const lines: string[] = []
  for (const raw of rawLines) {
    if ((raw.startsWith(' ') || raw.startsWith('\t')) && lines.length > 0) {
      lines[lines.length - 1] += raw.slice(1)
    } else {
      lines.push(raw)
    }
  }
  return lines.filter((line) => line.length > 0)
}

/** RFC 5545 3.3.11 TEXT unescaping. */
const unescapeIcsText = (value: string): string =>
  value.replace(/\\([\\;,nN])/g, (_, char: string) => (char === 'n' || char === 'N' ? '\n' : char))

const escapeIcsText = (value: string): string =>
  value.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n')

interface IcsProperty {
  name: string
  params: Record<string, string>
  value: string
  raw: string
}

function parseIcsProperty(line: string): IcsProperty | null {
  // Split name+params from value on the first ':' outside a quoted param value.
  let inQuotes = false
  let colon = -1
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (char === '"') inQuotes = !inQuotes
    else if (char === ':' && !inQuotes) {
      colon = index
      break
    }
  }
  if (colon === -1) return null
  const head = line.slice(0, colon)
  const value = line.slice(colon + 1)
  const segments = head.split(';')
  const name = segments[0]?.toUpperCase()
  if (!name) return null
  const params: Record<string, string> = {}
  for (const segment of segments.slice(1)) {
    const eq = segment.indexOf('=')
    if (eq === -1) continue
    params[segment.slice(0, eq).toUpperCase()] = segment.slice(eq + 1).replace(/^"|"$/g, '')
  }
  return { name, params, value, raw: line }
}

interface ParsedStamp {
  value: string
  allDay: boolean
  warning?: string
}

function parseIcsStamp(property: IcsProperty): ParsedStamp | null {
  const isDateOnly = property.params.VALUE === 'DATE' || /^\d{8}$/.test(property.value)
  if (isDateOnly) {
    const match = /^(\d{4})(\d{2})(\d{2})$/.exec(property.value)
    if (!match) return null
    return { value: `${match[1]}-${match[2]}-${match[3]}`, allDay: true }
  }
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/.exec(property.value)
  if (!match) return null
  const stamp = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}`
  let warning: string | undefined
  if (match[7] === 'Z') {
    warning = `${property.name} is in UTC; shown as wall time without conversion.`
  } else if (property.params.TZID) {
    warning = `${property.name} uses TZID=${property.params.TZID}; shown as wall time without conversion.`
  }
  return { value: stamp, allDay: false, warning }
}

const MODELED_EVENT_PROPS = new Set([
  'UID',
  'SUMMARY',
  'DTSTART',
  'DTEND',
  'LOCATION',
  'DESCRIPTION',
  'DTSTAMP'
])

export function parseIcs(text: string): IcsParseResult {
  const lines = unfoldIcsLines(text)
  const warnings: string[] = []
  const events: CalendarEvent[] = []
  const calendarExtras: string[] = []
  let calendarName: string | undefined

  let index = 0
  let eventCounter = 0
  let insideCalendar = false
  while (index < lines.length) {
    const line = lines[index]
    const upper = line.toUpperCase()
    if (upper === 'BEGIN:VCALENDAR') {
      insideCalendar = true
      index += 1
      continue
    }
    if (upper === 'END:VCALENDAR') {
      insideCalendar = false
      index += 1
      continue
    }
    if (upper === 'BEGIN:VEVENT') {
      // Collect the whole event block (handles nested BEGIN/END like VALARM).
      const block: string[] = []
      let depth = 1
      index += 1
      while (index < lines.length && depth > 0) {
        const inner = lines[index]
        const innerUpper = inner.toUpperCase()
        if (innerUpper.startsWith('BEGIN:')) depth += 1
        if (innerUpper === 'END:VEVENT' && depth === 1) {
          depth = 0
          index += 1
          break
        }
        if (innerUpper.startsWith('END:')) depth -= 1
        block.push(inner)
        index += 1
      }
      eventCounter += 1
      const event = parseEventBlock(block, eventCounter, warnings)
      if (event) events.push(event)
      continue
    }
    if (upper.startsWith('BEGIN:')) {
      // Non-VEVENT component (VTIMEZONE, VTODO…): preserve the whole block.
      const blockName = line.slice('BEGIN:'.length)
      calendarExtras.push(line)
      let depth = 1
      index += 1
      while (index < lines.length && depth > 0) {
        const inner = lines[index]
        const innerUpper = inner.toUpperCase()
        if (innerUpper.startsWith('BEGIN:')) depth += 1
        if (innerUpper.startsWith('END:')) depth -= 1
        calendarExtras.push(inner)
        index += 1
      }
      if (depth > 0) warnings.push(`Unterminated ${blockName} block preserved as-is.`)
      continue
    }
    if (insideCalendar) {
      const property = parseIcsProperty(line)
      if (property?.name === 'X-WR-CALNAME') {
        calendarName = unescapeIcsText(property.value)
      } else if (property && !['VERSION', 'PRODID', 'CALSCALE', 'METHOD'].includes(property.name)) {
        calendarExtras.push(line)
      }
    }
    index += 1
  }

  const model: CalendarDocumentModel = { kind: 'calendar', events }
  if (calendarName) model.calendarName = calendarName
  if (calendarExtras.length > 0) model.extraProperties = calendarExtras
  return { model, warnings }
}

function parseEventBlock(
  block: string[],
  ordinal: number,
  warnings: string[]
): CalendarEvent | null {
  const extras: string[] = []
  let uid = ''
  let title = ''
  let location: string | undefined
  let description: string | undefined
  let start: ParsedStamp | null = null
  let end: ParsedStamp | null = null

  let index = 0
  while (index < block.length) {
    const line = block[index]
    const upper = line.toUpperCase()
    if (upper.startsWith('BEGIN:')) {
      // Nested block (VALARM…): preserve verbatim.
      extras.push(line)
      let depth = 1
      index += 1
      while (index < block.length && depth > 0) {
        const inner = block[index]
        const innerUpper = inner.toUpperCase()
        if (innerUpper.startsWith('BEGIN:')) depth += 1
        if (innerUpper.startsWith('END:')) depth -= 1
        extras.push(inner)
        index += 1
      }
      continue
    }
    const property = parseIcsProperty(line)
    if (!property) {
      index += 1
      continue
    }
    switch (property.name) {
      case 'UID':
        uid = property.value
        break
      case 'SUMMARY':
        title = unescapeIcsText(property.value)
        break
      case 'LOCATION':
        location = unescapeIcsText(property.value)
        break
      case 'DESCRIPTION':
        description = unescapeIcsText(property.value)
        break
      case 'DTSTART':
        start = parseIcsStamp(property)
        if (start?.warning) warnings.push(start.warning)
        break
      case 'DTEND':
        end = parseIcsStamp(property)
        if (end?.warning) warnings.push(end.warning)
        break
      case 'DTSTAMP':
        break
      default:
        if (!MODELED_EVENT_PROPS.has(property.name)) extras.push(property.raw)
        break
    }
    index += 1
  }

  if (!start) {
    warnings.push(`Event ${ordinal} has no DTSTART and was skipped.`)
    return null
  }
  const allDay = start.allDay
  let endValue = end && end.allDay === allDay ? end.value : null
  if (!endValue) {
    endValue = allDay ? addDaysToIsoDate(start.value, 1) : start.value
  }
  const event: CalendarEvent = {
    uid: uid || `taskwraith-imported-${ordinal}`,
    title,
    start: start.value,
    end: endValue,
    allDay
  }
  if (location) event.location = location
  if (description) event.description = description
  if (extras.length > 0) event.extraProperties = extras
  return event
}

export function addDaysToIsoDate(isoDate: string, days: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate)
  if (!match) return isoDate
  const time = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + days)
  const next = new Date(time)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`
}

const stampToIcs = (value: string, allDay: boolean): string =>
  allDay ? value.replace(/-/g, '') : `${value.replace(/[-:]/g, '')}00`

/** RFC 5545 3.1 folding: keep content lines within 75 octets. */
export function foldIcsLine(line: string): string[] {
  const encoder = new TextEncoder()
  if (encoder.encode(line).length <= 75) return [line]
  const folded: string[] = []
  let current = ''
  let currentBytes = 0
  let budget = 75
  for (const char of line) {
    const charBytes = encoder.encode(char).length
    if (currentBytes + charBytes > budget) {
      folded.push(current)
      current = ' '
      currentBytes = 1
      budget = 75
    }
    current += char
    currentBytes += charBytes
  }
  if (current.length > 0) folded.push(current)
  return folded
}

export interface BuildIcsOptions {
  /** UTC DTSTAMP in `YYYYMMDDTHHMMSSZ` form; injectable for deterministic tests. */
  dtstamp?: string
}

export function buildIcs(model: CalendarDocumentModel, options: BuildIcsOptions = {}): string {
  const dtstamp = options.dtstamp ?? defaultDtstamp()
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//TaskWraith//Office Suite//EN',
    'CALSCALE:GREGORIAN'
  ]
  if (model.calendarName) lines.push(`X-WR-CALNAME:${escapeIcsText(model.calendarName)}`)
  for (const extra of model.extraProperties ?? []) lines.push(extra)
  for (const event of model.events) {
    lines.push('BEGIN:VEVENT')
    lines.push(`UID:${escapeIcsText(event.uid)}`)
    lines.push(`DTSTAMP:${dtstamp}`)
    if (event.allDay) {
      lines.push(`DTSTART;VALUE=DATE:${stampToIcs(event.start, true)}`)
      lines.push(`DTEND;VALUE=DATE:${stampToIcs(event.end, true)}`)
    } else {
      lines.push(`DTSTART:${stampToIcs(event.start, false)}`)
      lines.push(`DTEND:${stampToIcs(event.end, false)}`)
    }
    lines.push(`SUMMARY:${escapeIcsText(event.title)}`)
    if (event.location) lines.push(`LOCATION:${escapeIcsText(event.location)}`)
    if (event.description) lines.push(`DESCRIPTION:${escapeIcsText(event.description)}`)
    for (const extra of event.extraProperties ?? []) lines.push(extra)
    lines.push('END:VEVENT')
  }
  lines.push('END:VCALENDAR')
  return lines.flatMap(foldIcsLine).join('\r\n') + '\r\n'
}

function defaultDtstamp(): string {
  const now = new Date()
  const pad = (value: number): string => String(value).padStart(2, '0')
  return (
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`
  )
}
