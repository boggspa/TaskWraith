/**
 * Microsoft Graph → office model mapping.
 *
 * Everything here treats Graph payloads as UNTRUSTED REMOTE INPUT: shapes are
 * parsed defensively, every string is clamped, and HTML bodies are reduced to
 * plain text rather than rendered. Mail content is data — never instructions —
 * so nothing in this module interprets, follows, or executes anything it reads;
 * callers surfacing this text to a model must keep that boundary explicit.
 *
 * Mapping into the existing office models means a Graph message opens in the
 * same Mail editor as a local .eml, and a Graph event in the same Calendar
 * editor as a local .ics — one editing surface, two sources.
 */

import type { CalendarEvent, MailDocumentModel, MailHeader } from './officeModels'
import { parseMarkup, TEXT_NODE_TAG, localName, type XmlNode } from './xmlLite'
import { utcWallTimeToZone, type WallTimeParts } from './zonedTime'

/** Field caps applied to every remote string before it enters a model. */
export const GRAPH_LIMITS = {
  maxSubject: 4_000,
  maxAddressList: 8_000,
  maxBody: 500_000,
  maxPreview: 400,
  maxLocation: 4_000,
  maxRecipients: 200,
  maxId: 512
} as const

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const clamp = (value: unknown, maxLength: number): string =>
  typeof value === 'string' ? value.slice(0, maxLength) : ''

/** Blocks that end a line when an HTML body is flattened to text. */
const HTML_BREAK_TAGS = new Set([
  'p',
  'div',
  'br',
  'li',
  'tr',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'blockquote',
  'section',
  'article'
])

const HTML_DROP_TAGS = new Set(['script', 'style', 'head', 'title', 'noscript', 'template'])

/** Nesting levels flattened before the rest of a body is ignored. */
const MAX_HTML_DEPTH = 400

/**
 * Flattens an HTML mail body to plain text using the shared lenient parser.
 * Script/style subtrees are dropped wholesale — this is the only sanitizer in
 * the path, because Graph HTML is never mounted as markup anywhere.
 */
export function graphHtmlToText(html: string): string {
  const root = parseMarkup(html.slice(0, GRAPH_LIMITS.maxBody), { html: true })
  const parts: string[] = []
  /** Idempotent line break: Outlook wraps every line in its own <div>, so
   * emitting breaks unconditionally around blocks would double-space it. */
  const pushBreak = (): void => {
    if (parts.length === 0) return
    if (parts[parts.length - 1].endsWith('\n')) return
    parts.push('\n')
  }
  // Depth-bounded: a remote sender chooses the nesting, and ~5k levels of
  // `<div>` (well under the byte clamp) would otherwise overflow the stack.
  const walk = (node: XmlNode, depth: number): void => {
    if (depth > MAX_HTML_DEPTH) return
    for (const child of node.children) {
      if (child.tag === TEXT_NODE_TAG) {
        parts.push(child.text)
        continue
      }
      const tag = localName(child.tag)
      if (HTML_DROP_TAGS.has(tag)) continue
      if (tag === 'br') {
        parts.push('\n')
        continue
      }
      const breaks = HTML_BREAK_TAGS.has(tag)
      if (breaks) pushBreak()
      walk(child, depth + 1)
      if (breaks) pushBreak()
    }
  }
  walk(root, 0)
  return parts
    .join('')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function addressText(value: unknown): string {
  if (!isRecord(value)) return ''
  const emailAddress = isRecord(value.emailAddress) ? value.emailAddress : value
  const name = clamp(emailAddress.name, 256).trim()
  const address = clamp(emailAddress.address, 512).trim()
  if (name && address) return `${name} <${address}>`
  return address || name
}

function addressListText(value: unknown): string {
  if (!Array.isArray(value)) return ''
  return value
    .slice(0, GRAPH_LIMITS.maxRecipients)
    .map(addressText)
    .filter((entry) => entry !== '')
    .join(', ')
    .slice(0, GRAPH_LIMITS.maxAddressList)
}

export interface GraphMailMapping {
  model: MailDocumentModel
  /** Graph message id, for follow-up reads/replies. Never trusted as a path. */
  messageId: string
  warnings: string[]
}

/**
 * Graph message → the Mail editor's model. Returns null when the payload is
 * not a message-shaped object at all.
 */
export function graphMessageToMailModel(message: unknown): GraphMailMapping | null {
  if (!isRecord(message)) return null
  const warnings: string[] = []

  const bodyRecord = isRecord(message.body) ? message.body : null
  const contentType = clamp(bodyRecord?.contentType, 32).toLowerCase()
  const rawBody = clamp(bodyRecord?.content, GRAPH_LIMITS.maxBody)
  let body = rawBody
  if (contentType === 'html') {
    body = graphHtmlToText(rawBody)
    warnings.push('HTML message converted to plain text.')
  }
  if (!body) body = clamp(message.bodyPreview, GRAPH_LIMITS.maxPreview)

  if (message.hasAttachments === true) {
    warnings.push('Attachments are not downloaded.')
  }

  const model: MailDocumentModel = {
    kind: 'mail',
    from: addressText(message.from ?? message.sender),
    to: addressListText(message.toRecipients),
    cc: addressListText(message.ccRecipients),
    bcc: addressListText(message.bccRecipients),
    subject: clamp(message.subject, GRAPH_LIMITS.maxSubject),
    body
  }

  const sentDate = clamp(message.sentDateTime ?? message.receivedDateTime, 64)
  if (sentDate) model.date = sentDate

  // Provenance the user can act on, kept as headers so an exported .eml
  // records where the message came from.
  const extraHeaders: MailHeader[] = []
  const conversationId = clamp(message.conversationId, GRAPH_LIMITS.maxId)
  if (conversationId) {
    extraHeaders.push({ name: 'X-TaskWraith-Graph-Conversation', value: conversationId })
  }
  const webLink = clamp(message.webLink, 2_048)
  if (/^https:\/\//i.test(webLink)) {
    extraHeaders.push({ name: 'X-TaskWraith-Graph-Weblink', value: webLink })
  }
  if (extraHeaders.length > 0) model.extraHeaders = extraHeaders

  return { model, messageId: clamp(message.id, GRAPH_LIMITS.maxId), warnings }
}

/** Compact row for mail list surfaces — no body, so listing stays cheap. */
export interface GraphMailSummary {
  id: string
  subject: string
  from: string
  receivedAt: string
  preview: string
  isRead: boolean
  hasAttachments: boolean
}

export function graphMessageSummary(message: unknown): GraphMailSummary | null {
  if (!isRecord(message)) return null
  const id = clamp(message.id, GRAPH_LIMITS.maxId)
  if (!id) return null
  return {
    id,
    subject: clamp(message.subject, GRAPH_LIMITS.maxSubject),
    from: addressText(message.from ?? message.sender),
    receivedAt: clamp(message.receivedDateTime ?? message.sentDateTime, 64),
    preview: clamp(message.bodyPreview, GRAPH_LIMITS.maxPreview).replace(/\s+/g, ' ').trim(),
    isRead: message.isRead === true,
    hasAttachments: message.hasAttachments === true
  }
}

const ISO_STAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/

function graphStampToWallParts(value: string): WallTimeParts | null {
  const match = ISO_STAMP.exec(value)
  if (!match) return null
  const parts = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: match[6] ? Number(match[6]) : 0
  }
  // Range-validated, not just shape-validated: Date.UTC happily wraps
  // 2024-13-45T99:99 into a plausible-looking date ten months away, which
  // would show the user a real meeting at a confidently wrong time.
  if (
    parts.year < 1000 ||
    parts.year > 9999 ||
    parts.month < 1 ||
    parts.month > 12 ||
    parts.day < 1 ||
    parts.day > 31 ||
    parts.hour > 23 ||
    parts.minute > 59 ||
    parts.second > 59
  ) {
    return null
  }
  return parts
}

/** Exclusive-end convention for all-day events, matching the ICS codec. */
function nextIsoDate(isoDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate)
  if (!match) return isoDate
  const next = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + 1))
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`
}

const pad2 = (value: number): string => String(value).padStart(2, '0')
const pad4 = (value: number): string => String(value).padStart(4, '0')

const wallPartsToLocalStamp = (parts: WallTimeParts): string =>
  `${pad4(parts.year)}-${pad2(parts.month)}-${pad2(parts.day)}T${pad2(parts.hour)}:${pad2(parts.minute)}`

/**
 * Graph dateTimeTimeZone → the Calendar editor's local-wall stamp. Graph
 * returns UTC by default (`timeZone: 'UTC'`); other zones are converted when
 * a display zone is supplied, and otherwise taken as written.
 */
export function graphDateTimeToLocalStamp(
  value: unknown,
  displayZone: string | undefined,
  allDay: boolean
): { stamp: string; warning?: string } | null {
  if (!isRecord(value)) return null
  const raw = clamp(value.dateTime, 64)
  const parts = graphStampToWallParts(raw)
  if (!parts) return null
  if (allDay) {
    return { stamp: `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}` }
  }
  const zone = clamp(value.timeZone, 128).trim()
  if (!displayZone || !zone || zone.toUpperCase() !== 'UTC') {
    return zone && zone.toUpperCase() !== 'UTC'
      ? {
          stamp: wallPartsToLocalStamp(parts),
          warning: `Event time is in ${zone}; shown as written without conversion.`
        }
      : { stamp: wallPartsToLocalStamp(parts) }
  }
  const converted = utcWallTimeToZone(displayZone, parts)
  if (!converted) return { stamp: wallPartsToLocalStamp(parts) }
  return { stamp: wallPartsToLocalStamp(converted) }
}

export interface GraphEventMapping {
  event: CalendarEvent
  /** Graph event id, for follow-up reads/RSVPs. */
  eventId: string
  warnings: string[]
}

export function graphEventToCalendarEvent(
  value: unknown,
  displayZone?: string
): GraphEventMapping | null {
  if (!isRecord(value)) return null
  const allDay = value.isAllDay === true
  const start = graphDateTimeToLocalStamp(value.start, displayZone, allDay)
  const end = graphDateTimeToLocalStamp(value.end, displayZone, allDay)
  if (!start) return null

  const warnings: string[] = []
  if (start.warning) warnings.push(start.warning)
  if (end?.warning && end.warning !== start.warning) warnings.push(end.warning)
  if (isRecord(value.recurrence)) {
    warnings.push('Recurring event: only this occurrence is shown.')
  }

  const eventId = clamp(value.id, GRAPH_LIMITS.maxId)
  const event: CalendarEvent = {
    uid: eventId || `graph-event-${start.stamp}`,
    title: clamp(value.subject, GRAPH_LIMITS.maxSubject),
    start: start.stamp,
    end: end?.stamp ?? (allDay ? nextIsoDate(start.stamp) : start.stamp),
    allDay
  }

  const location = isRecord(value.location)
    ? clamp(value.location.displayName, GRAPH_LIMITS.maxLocation)
    : ''
  if (location) event.location = location

  const bodyRecord = isRecord(value.body) ? value.body : null
  const contentType = clamp(bodyRecord?.contentType, 32).toLowerCase()
  const rawBody = clamp(bodyRecord?.content, GRAPH_LIMITS.maxBody)
  const description = contentType === 'html' ? graphHtmlToText(rawBody) : rawBody
  if (description) event.description = description

  return { event, eventId, warnings }
}

/** Graph collection envelope → items, defensively. */
export function graphCollection(payload: unknown): unknown[] {
  if (!isRecord(payload)) return []
  return Array.isArray(payload.value) ? payload.value : []
}
