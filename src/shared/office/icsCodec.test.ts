import { describe, expect, it } from 'vitest'
import { addDaysToIsoDate, buildIcs, foldIcsLine, parseIcs, unfoldIcsLines } from './icsCodec'
import type { CalendarDocumentModel } from './officeModels'

const GOOGLE_STYLE_ICS = [
  'BEGIN:VCALENDAR',
  'PRODID:-//Google Inc//Google Calendar 70.9054//EN',
  'VERSION:2.0',
  'CALSCALE:GREGORIAN',
  'X-WR-CALNAME:Team Calendar',
  'BEGIN:VEVENT',
  'DTSTART:20260801T090000',
  'DTEND:20260801T093000',
  'DTSTAMP:20260725T120000Z',
  'UID:abc123@google.com',
  'SUMMARY:Standup\\, daily',
  'LOCATION:Room 1\\; annex',
  'DESCRIPTION:Line one\\nLine two',
  'RRULE:FREQ=DAILY;COUNT=5',
  'BEGIN:VALARM',
  'ACTION:DISPLAY',
  'TRIGGER:-PT10M',
  'END:VALARM',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'DTSTART;VALUE=DATE:20260810',
  'DTEND;VALUE=DATE:20260812',
  'UID:allday@google.com',
  'SUMMARY:Offsite',
  'END:VEVENT',
  'END:VCALENDAR'
].join('\r\n')

describe('parseIcs', () => {
  it('parses events, unescapes text, and preserves unmodeled lines verbatim', () => {
    const { model, warnings } = parseIcs(GOOGLE_STYLE_ICS)
    expect(warnings).toEqual([])
    expect(model.calendarName).toBe('Team Calendar')
    expect(model.events).toHaveLength(2)
    const [standup, offsite] = model.events
    expect(standup).toMatchObject({
      uid: 'abc123@google.com',
      title: 'Standup, daily',
      start: '2026-08-01T09:00',
      end: '2026-08-01T09:30',
      allDay: false,
      location: 'Room 1; annex',
      description: 'Line one\nLine two'
    })
    expect(standup.extraProperties).toEqual([
      'RRULE:FREQ=DAILY;COUNT=5',
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      'TRIGGER:-PT10M',
      'END:VALARM'
    ])
    expect(offsite).toMatchObject({
      start: '2026-08-10',
      end: '2026-08-12',
      allDay: true
    })
  })

  it('unfolds continuation lines before parsing', () => {
    const folded =
      'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART:20260801T090000\r\nSUMMARY:A very lo\r\n ng title\r\nEND:VEVENT\r\nEND:VCALENDAR'
    const { model } = parseIcs(folded)
    expect(model.events[0].title).toBe('A very long title')
  })

  it('keeps zone-anchored stamps as written (with warnings) when no display zone is given', () => {
    const utc =
      'BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:u\nDTSTART:20260801T090000Z\nDTEND;TZID=Europe/London:20260801T100000\nSUMMARY:x\nEND:VEVENT\nEND:VCALENDAR'
    const { model, warnings } = parseIcs(utc)
    expect(model.events[0].start).toBe('2026-08-01T09:00')
    expect(warnings.some((warning) => warning.includes('UTC'))).toBe(true)
    expect(warnings.some((warning) => warning.includes('TZID=Europe/London'))).toBe(true)
    // Originals ride along either way.
    expect(model.events[0].startRaw).toBe('DTSTART:20260801T090000Z')
    expect(model.events[0].endRaw).toBe('DTEND;TZID=Europe/London:20260801T100000')
  })

  it('converts UTC and IANA-TZID stamps into the display zone without warnings', () => {
    const utc =
      'BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:u\nDTSTART:20260801T090000Z\nDTEND;TZID=Europe/London:20260801T110000\nSUMMARY:x\nEND:VEVENT\nEND:VCALENDAR'
    const { model, warnings } = parseIcs(utc, { displayZone: 'America/New_York' })
    expect(warnings).toEqual([])
    // 09:00Z in August = 05:00 EDT; 11:00 BST = 10:00Z = 06:00 EDT.
    expect(model.events[0].start).toBe('2026-08-01T05:00')
    expect(model.events[0].end).toBe('2026-08-01T06:00')
    expect(model.events[0].startRaw).toBe('DTSTART:20260801T090000Z')
    expect(model.events[0].endRaw).toBe('DTEND;TZID=Europe/London:20260801T110000')
  })

  it('falls back to as-written wall time for unknown TZIDs, preserving the raw stamp', () => {
    const source =
      'BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:u\nDTSTART;TZID=Custom/House_Zone:20260801T090000\nSUMMARY:x\nEND:VEVENT\nEND:VCALENDAR'
    const { model, warnings } = parseIcs(source, { displayZone: 'America/New_York' })
    expect(model.events[0].start).toBe('2026-08-01T09:00')
    expect(model.events[0].startRaw).toBe('DTSTART;TZID=Custom/House_Zone:20260801T090000')
    expect(warnings.some((warning) => warning.includes('Custom/House_Zone'))).toBe(true)
  })

  it('re-emits preserved zone-anchored stamps verbatim, and floating stamps once edited', () => {
    const source =
      'BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:u\nDTSTART:20260801T090000Z\nDTEND:20260801T093000Z\nSUMMARY:x\nEND:VEVENT\nEND:VCALENDAR'
    const { model } = parseIcs(source, { displayZone: 'Asia/Kolkata' })
    expect(model.events[0].start).toBe('2026-08-01T14:30')

    const rebuilt = buildIcs(model, { dtstamp: '20260725T120000Z' })
    expect(rebuilt).toContain('DTSTART:20260801T090000Z')
    expect(rebuilt).toContain('DTEND:20260801T093000Z')
    // Same document parses back to the identical model.
    expect(parseIcs(rebuilt, { displayZone: 'Asia/Kolkata' }).model).toEqual(model)

    // Simulate the editor re-anchoring after a time edit: raws dropped.
    const edited = {
      ...model,
      events: model.events.map(({ startRaw, endRaw, ...event }) => {
        void startRaw
        void endRaw
        return { ...event, start: '2026-08-01T15:00', end: '2026-08-01T15:30' }
      })
    }
    const rebuiltEdited = buildIcs(edited, { dtstamp: '20260725T120000Z' })
    expect(rebuiltEdited).toContain('DTSTART:20260801T150000')
    expect(rebuiltEdited).not.toContain('DTSTART:20260801T090000Z')
  })

  it('skips events without DTSTART and defaults missing DTEND', () => {
    const source =
      'BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:no-start\nSUMMARY:ghost\nEND:VEVENT\nBEGIN:VEVENT\nUID:open\nDTSTART;VALUE=DATE:20260801\nSUMMARY:one-day\nEND:VEVENT\nEND:VCALENDAR'
    const { model, warnings } = parseIcs(source)
    expect(model.events).toHaveLength(1)
    expect(model.events[0].end).toBe('2026-08-02')
    expect(warnings.some((warning) => warning.includes('no DTSTART'))).toBe(true)
  })
})

describe('buildIcs', () => {
  it('emits RFC-shaped output that round-trips including preserved extras', () => {
    const first = parseIcs(GOOGLE_STYLE_ICS).model
    const rebuilt = buildIcs(first, { dtstamp: '20260725T120000Z' })
    expect(rebuilt).toContain('SUMMARY:Standup\\, daily')
    expect(rebuilt).toContain('RRULE:FREQ=DAILY;COUNT=5')
    expect(rebuilt).toContain('BEGIN:VALARM')
    expect(rebuilt).toContain('DTSTART;VALUE=DATE:20260810')
    expect(rebuilt.endsWith('\r\n')).toBe(true)

    const second = parseIcs(rebuilt).model
    expect(second).toEqual(first)
  })

  it('folds long lines to 75 octets', () => {
    const model: CalendarDocumentModel = {
      kind: 'calendar',
      events: [
        {
          uid: 'long',
          title: 'x'.repeat(200),
          start: '2026-08-01',
          end: '2026-08-02',
          allDay: true
        }
      ]
    }
    const built = buildIcs(model, { dtstamp: '20260725T120000Z' })
    for (const line of built.split('\r\n')) {
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75)
    }
    // Unfolding restores the original title.
    const lines = unfoldIcsLines(built)
    expect(lines.some((line) => line === `SUMMARY:${'x'.repeat(200)}`)).toBe(true)
  })

  it('folds multi-byte text without splitting codepoints', () => {
    const folded = foldIcsLine(`SUMMARY:${'é'.repeat(100)}`)
    expect(folded.length).toBeGreaterThan(1)
    expect(folded.join('').replace(/^ /gm, '')).toContain('é'.repeat(10))
  })
})

describe('addDaysToIsoDate', () => {
  it('crosses month and year boundaries', () => {
    expect(addDaysToIsoDate('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDaysToIsoDate('2026-03-01', -1)).toBe('2026-02-28')
    expect(addDaysToIsoDate('2024-02-28', 1)).toBe('2024-02-29')
  })
})
