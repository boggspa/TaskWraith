import { describe, expect, it } from 'vitest'
import {
  GRAPH_LIMITS,
  graphCollection,
  graphDateTimeToLocalStamp,
  graphEventToCalendarEvent,
  graphHtmlToText,
  graphMessageSummary,
  graphMessageToMailModel
} from './graphMappers'

const MESSAGE = {
  id: 'AAMkAD_message_id',
  subject: 'Q3 planning',
  from: { emailAddress: { name: 'Alice Smith', address: 'alice@example.com' } },
  toRecipients: [
    { emailAddress: { name: 'Bob', address: 'bob@example.com' } },
    { emailAddress: { address: 'carol@example.com' } }
  ],
  ccRecipients: [{ emailAddress: { name: 'Dan', address: 'dan@example.com' } }],
  receivedDateTime: '2026-08-01T09:30:00Z',
  sentDateTime: '2026-08-01T09:29:00Z',
  bodyPreview: 'Short preview',
  body: { contentType: 'text', content: 'Hello team,\n\nPlanning starts Monday.' },
  conversationId: 'conv-1',
  webLink: 'https://outlook.office365.com/owa/?ItemID=abc',
  isRead: false,
  hasAttachments: false
}

describe('graphMessageToMailModel', () => {
  it('maps addresses, subject, date and body into the mail model', () => {
    const mapped = graphMessageToMailModel(MESSAGE)
    expect(mapped?.messageId).toBe('AAMkAD_message_id')
    expect(mapped?.warnings).toEqual([])
    expect(mapped?.model).toEqual({
      kind: 'mail',
      from: 'Alice Smith <alice@example.com>',
      to: 'Bob <bob@example.com>, carol@example.com',
      cc: 'Dan <dan@example.com>',
      bcc: '',
      subject: 'Q3 planning',
      body: 'Hello team,\n\nPlanning starts Monday.',
      date: '2026-08-01T09:29:00Z',
      extraHeaders: [
        { name: 'X-TaskWraith-Graph-Conversation', value: 'conv-1' },
        {
          name: 'X-TaskWraith-Graph-Weblink',
          value: 'https://outlook.office365.com/owa/?ItemID=abc'
        }
      ]
    })
  })

  it('flattens HTML bodies and reports attachments as warnings', () => {
    const mapped = graphMessageToMailModel({
      ...MESSAGE,
      hasAttachments: true,
      body: {
        contentType: 'html',
        content:
          '<html><head><style>p{color:red}</style></head><body><p>First</p><p>Second &amp; last</p><script>steal()</script></body></html>'
      }
    })
    expect(mapped?.model.body).toBe('First\nSecond & last')
    expect(mapped?.warnings).toEqual([
      'HTML message converted to plain text.',
      'Attachments are not downloaded.'
    ])
  })

  it('falls back to the preview when the body is empty', () => {
    const mapped = graphMessageToMailModel({
      ...MESSAGE,
      body: { contentType: 'text', content: '' }
    })
    expect(mapped?.model.body).toBe('Short preview')
  })

  it('clamps hostile field lengths and drops non-https weblinks', () => {
    const mapped = graphMessageToMailModel({
      ...MESSAGE,
      subject: 'x'.repeat(GRAPH_LIMITS.maxSubject + 500),
      body: { contentType: 'text', content: 'y'.repeat(GRAPH_LIMITS.maxBody + 1_000) },
      webLink: 'javascript:alert(1)',
      toRecipients: Array.from({ length: GRAPH_LIMITS.maxRecipients + 50 }, (_, index) => ({
        emailAddress: { address: `user${index}@example.com` }
      }))
    })
    expect(mapped?.model.subject).toHaveLength(GRAPH_LIMITS.maxSubject)
    expect(mapped?.model.body.length).toBeLessThanOrEqual(GRAPH_LIMITS.maxBody)
    expect(mapped?.model.to.length).toBeLessThanOrEqual(GRAPH_LIMITS.maxAddressList)
    expect(mapped?.model.extraHeaders?.some((header) => header.name.includes('Weblink'))).toBe(
      false
    )
  })

  it('rejects non-object payloads', () => {
    expect(graphMessageToMailModel(null)).toBeNull()
    expect(graphMessageToMailModel('message')).toBeNull()
    expect(graphMessageToMailModel([])).toBeNull()
  })
})

describe('graphHtmlToText', () => {
  it('drops script/style subtrees entirely', () => {
    expect(graphHtmlToText('<div>ok<script>bad()</script><style>x{}</style></div>')).toBe('ok')
  })

  it('breaks lines on block elements and <br>', () => {
    expect(graphHtmlToText('<p>one</p><p>two<br>three</p>')).toBe('one\ntwo\nthree')
  })

  it('decodes entities and collapses whitespace', () => {
    expect(graphHtmlToText('<p>a &amp;&nbsp;b   c</p>')).toBe('a & b c')
  })

  it('survives pathologically nested markup instead of overflowing the stack', () => {
    // ~20k nesting levels, well inside the byte clamp — a remote sender
    // chooses the depth, so it must be bounded independently of size.
    const nested = '<div>'.repeat(20_000) + 'deep' + '</div>'.repeat(20_000)
    expect(() => graphHtmlToText(nested)).not.toThrow()
  })
})

describe('graphMessageSummary', () => {
  it('produces a compact row without the body', () => {
    expect(graphMessageSummary(MESSAGE)).toEqual({
      id: 'AAMkAD_message_id',
      subject: 'Q3 planning',
      from: 'Alice Smith <alice@example.com>',
      receivedAt: '2026-08-01T09:30:00Z',
      preview: 'Short preview',
      isRead: false,
      hasAttachments: false
    })
  })

  it('requires an id', () => {
    expect(graphMessageSummary({ subject: 'no id' })).toBeNull()
  })
})

describe('graphDateTimeToLocalStamp', () => {
  it('converts UTC stamps into the display zone', () => {
    expect(
      graphDateTimeToLocalStamp(
        { dateTime: '2026-08-01T09:00:00.0000000', timeZone: 'UTC' },
        'America/New_York',
        false
      )
    ).toEqual({ stamp: '2026-08-01T05:00' })
  })

  it('takes non-UTC zones as written and warns', () => {
    const result = graphDateTimeToLocalStamp(
      { dateTime: '2026-08-01T09:00:00', timeZone: 'Pacific Standard Time' },
      'America/New_York',
      false
    )
    expect(result?.stamp).toBe('2026-08-01T09:00')
    expect(result?.warning).toContain('Pacific Standard Time')
  })

  it('renders all-day events as dates', () => {
    expect(
      graphDateTimeToLocalStamp({ dateTime: '2026-08-10T00:00:00', timeZone: 'UTC' }, 'UTC', true)
    ).toEqual({ stamp: '2026-08-10' })
  })

  it('rejects malformed stamps', () => {
    expect(graphDateTimeToLocalStamp({ dateTime: 'yesterday' }, 'UTC', false)).toBeNull()
    expect(graphDateTimeToLocalStamp(null, 'UTC', false)).toBeNull()
  })

  it('rejects out-of-range components rather than wrapping them into a plausible date', () => {
    // Date.UTC would silently turn this into a real date ~10 months later.
    expect(graphDateTimeToLocalStamp({ dateTime: '2024-13-45T99:99:99' }, 'UTC', false)).toBeNull()
    expect(graphDateTimeToLocalStamp({ dateTime: '2024-00-10T10:00' }, 'UTC', false)).toBeNull()
    expect(graphDateTimeToLocalStamp({ dateTime: '0001-01-01T00:00' }, 'UTC', false)).toBeNull()
  })

  it('pads the year so stamps stay ISO-shaped', () => {
    expect(
      graphDateTimeToLocalStamp({ dateTime: '1000-06-07T08:09', timeZone: 'UTC' }, 'UTC', false)
    ).toEqual({ stamp: '1000-06-07T08:09' })
  })
})

describe('graphEventToCalendarEvent', () => {
  const EVENT = {
    id: 'event-1',
    subject: 'Standup',
    start: { dateTime: '2026-08-01T09:00:00.0000000', timeZone: 'UTC' },
    end: { dateTime: '2026-08-01T09:15:00.0000000', timeZone: 'UTC' },
    isAllDay: false,
    location: { displayName: 'Room 2' },
    body: { contentType: 'html', content: '<p>Daily sync</p>' }
  }

  it('maps a timed event into the calendar model', () => {
    const mapped = graphEventToCalendarEvent(EVENT, 'Europe/London')
    expect(mapped?.eventId).toBe('event-1')
    expect(mapped?.event).toEqual({
      uid: 'event-1',
      title: 'Standup',
      start: '2026-08-01T10:00',
      end: '2026-08-01T10:15',
      allDay: false,
      location: 'Room 2',
      description: 'Daily sync'
    })
    expect(mapped?.warnings).toEqual([])
  })

  it('warns about recurrence and keeps only the occurrence shown', () => {
    const mapped = graphEventToCalendarEvent(
      { ...EVENT, recurrence: { pattern: { type: 'daily' } } },
      'UTC'
    )
    expect(mapped?.warnings.some((warning) => warning.includes('Recurring'))).toBe(true)
  })

  it('maps all-day events to date stamps', () => {
    const mapped = graphEventToCalendarEvent(
      {
        ...EVENT,
        isAllDay: true,
        start: { dateTime: '2026-08-10T00:00:00', timeZone: 'UTC' },
        end: { dateTime: '2026-08-12T00:00:00', timeZone: 'UTC' }
      },
      'UTC'
    )
    expect(mapped?.event).toMatchObject({ start: '2026-08-10', end: '2026-08-12', allDay: true })
  })

  it('gives an all-day event with no end the exclusive next-day end', () => {
    const mapped = graphEventToCalendarEvent(
      {
        ...EVENT,
        isAllDay: true,
        start: { dateTime: '2026-08-10T00:00:00', timeZone: 'UTC' },
        end: null
      },
      'UTC'
    )
    // Matches the ICS convention; end === start would be dropped by clients.
    expect(mapped?.event).toMatchObject({ start: '2026-08-10', end: '2026-08-11' })
  })

  it('requires a parsable start', () => {
    expect(graphEventToCalendarEvent({ ...EVENT, start: null }, 'UTC')).toBeNull()
    expect(graphEventToCalendarEvent('nope', 'UTC')).toBeNull()
  })
})

describe('graphCollection', () => {
  it('extracts the value array defensively', () => {
    expect(graphCollection({ value: [1, 2] })).toEqual([1, 2])
    expect(graphCollection({ value: 'nope' })).toEqual([])
    expect(graphCollection(null)).toEqual([])
  })
})
