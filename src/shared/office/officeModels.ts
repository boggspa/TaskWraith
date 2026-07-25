/**
 * Office suite document models — the format-agnostic in-memory representation
 * every Office editor (Word / Sheet / Deck / Calendar / Mail) edits, and every
 * codec (docx/md, xlsx/csv/tsv, pptx, ics, eml) imports into and exports from.
 *
 * Models are plain JSON so they cross the IPC boundary verbatim. The main
 * process re-normalizes anything arriving from the renderer through
 * `normalizeOfficeDocumentModel` before serializing to disk, so codecs can
 * trust shapes without trusting the sender. Normalization clamps, never
 * throws: malformed fragments degrade to empty content instead of failing a
 * whole save.
 */

export type OfficeDocumentKind = 'word' | 'sheet' | 'deck' | 'calendar' | 'mail'

export const OFFICE_DOCUMENT_KINDS: readonly OfficeDocumentKind[] = [
  'word',
  'sheet',
  'deck',
  'calendar',
  'mail'
]

export interface WordRun {
  text: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strike?: boolean
  code?: boolean
  /** Absolute URL this run links to. */
  link?: string
}

export type WordBlock =
  | { type: 'paragraph'; runs: WordRun[] }
  | { type: 'heading'; level: 1 | 2 | 3; runs: WordRun[] }
  | { type: 'list-item'; ordered: boolean; level: number; runs: WordRun[] }
  /** rows → cells → runs. One implicit paragraph per cell; '\n' in run text is a line break. */
  | { type: 'table'; rows: WordRun[][][] }

export interface WordDocumentModel {
  kind: 'word'
  blocks: WordBlock[]
}

export interface SheetGrid {
  name: string
  /** Dense row-major cells. A cell starting with '=' is a formula; everything else is a literal. */
  rows: string[][]
}

export interface SheetDocumentModel {
  kind: 'sheet'
  sheets: SheetGrid[]
}

export interface DeckBullet {
  text: string
  /** 0-based indent level. */
  level: number
}

export interface DeckSlide {
  title: string
  bullets: DeckBullet[]
  notes: string
}

export interface DeckDocumentModel {
  kind: 'deck'
  slides: DeckSlide[]
}

export interface CalendarEvent {
  uid: string
  title: string
  /** 'YYYY-MM-DD' when allDay, else floating local 'YYYY-MM-DDTHH:mm'. */
  start: string
  /** Exclusive end date when allDay (RFC 5545 convention), else floating local end. */
  end: string
  allDay: boolean
  location?: string
  description?: string
  /**
   * Unfolded ICS lines this model does not represent (RRULE, ATTENDEE, whole
   * VALARM blocks…), re-emitted verbatim so a round-trip never drops them.
   */
  extraProperties?: string[]
}

export interface CalendarDocumentModel {
  kind: 'calendar'
  calendarName?: string
  events: CalendarEvent[]
  /** Calendar-level lines this model does not represent, preserved for round-trips. */
  extraProperties?: string[]
}

export interface MailHeader {
  name: string
  value: string
}

export interface MailDocumentModel {
  kind: 'mail'
  from: string
  to: string
  cc: string
  bcc: string
  subject: string
  /** RFC 5322 Date header value, when known. */
  date?: string
  /** Plain-text body. */
  body: string
  /** Headers this model does not represent, preserved for round-trips. */
  extraHeaders?: MailHeader[]
}

export type OfficeDocumentModel =
  | WordDocumentModel
  | SheetDocumentModel
  | DeckDocumentModel
  | CalendarDocumentModel
  | MailDocumentModel

/** Structural caps applied during normalization so a hostile payload cannot balloon memory. */
export const OFFICE_MODEL_LIMITS = {
  maxWordBlocks: 20_000,
  maxRunsPerBlock: 2_000,
  maxTableRows: 2_000,
  maxTableCols: 64,
  maxSheets: 32,
  maxSheetRows: 5_000,
  maxSheetCols: 256,
  maxDeckSlides: 500,
  maxDeckBullets: 300,
  maxCalendarEvents: 5_000,
  maxExtraLines: 2_000,
  maxTextLength: 200_000
} as const

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const clampText = (
  value: unknown,
  maxLength: number = OFFICE_MODEL_LIMITS.maxTextLength
): string => (typeof value === 'string' ? value.slice(0, maxLength) : '')

const clampStringArray = (value: unknown, maxEntries: number): string[] =>
  Array.isArray(value)
    ? value
        .slice(0, maxEntries)
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => entry.slice(0, OFFICE_MODEL_LIMITS.maxTextLength))
    : []

function normalizeRun(value: unknown): WordRun | null {
  if (!isRecord(value)) return null
  const run: WordRun = { text: clampText(value.text) }
  if (value.bold === true) run.bold = true
  if (value.italic === true) run.italic = true
  if (value.underline === true) run.underline = true
  if (value.strike === true) run.strike = true
  if (value.code === true) run.code = true
  if (typeof value.link === 'string' && /^https?:\/\//i.test(value.link)) {
    run.link = value.link.slice(0, 4_096)
  }
  return run
}

function normalizeRuns(value: unknown): WordRun[] {
  if (!Array.isArray(value)) return []
  const runs: WordRun[] = []
  for (const entry of value.slice(0, OFFICE_MODEL_LIMITS.maxRunsPerBlock)) {
    const run = normalizeRun(entry)
    if (run) runs.push(run)
  }
  return runs
}

function normalizeWordBlock(value: unknown): WordBlock | null {
  if (!isRecord(value)) return null
  switch (value.type) {
    case 'paragraph':
      return { type: 'paragraph', runs: normalizeRuns(value.runs) }
    case 'heading': {
      const level = value.level === 2 ? 2 : value.level === 3 ? 3 : 1
      return { type: 'heading', level, runs: normalizeRuns(value.runs) }
    }
    case 'list-item': {
      const rawLevel = typeof value.level === 'number' ? Math.floor(value.level) : 0
      return {
        type: 'list-item',
        ordered: value.ordered === true,
        level: Math.min(8, Math.max(0, rawLevel)),
        runs: normalizeRuns(value.runs)
      }
    }
    case 'table': {
      if (!Array.isArray(value.rows)) return { type: 'table', rows: [] }
      const rows = value.rows
        .slice(0, OFFICE_MODEL_LIMITS.maxTableRows)
        .map((row) =>
          Array.isArray(row)
            ? row.slice(0, OFFICE_MODEL_LIMITS.maxTableCols).map((cell) => normalizeRuns(cell))
            : []
        )
      return { type: 'table', rows }
    }
    default:
      return null
  }
}

function normalizeWordModel(value: Record<string, unknown>): WordDocumentModel {
  const blocks: WordBlock[] = []
  if (Array.isArray(value.blocks)) {
    for (const entry of value.blocks.slice(0, OFFICE_MODEL_LIMITS.maxWordBlocks)) {
      const block = normalizeWordBlock(entry)
      if (block) blocks.push(block)
    }
  }
  return { kind: 'word', blocks }
}

function normalizeSheetModel(value: Record<string, unknown>): SheetDocumentModel {
  const sheets: SheetGrid[] = []
  if (Array.isArray(value.sheets)) {
    for (const [index, entry] of value.sheets.slice(0, OFFICE_MODEL_LIMITS.maxSheets).entries()) {
      if (!isRecord(entry)) continue
      const rows = Array.isArray(entry.rows)
        ? entry.rows
            .slice(0, OFFICE_MODEL_LIMITS.maxSheetRows)
            .map((row) =>
              Array.isArray(row)
                ? row
                    .slice(0, OFFICE_MODEL_LIMITS.maxSheetCols)
                    .map((cell) => clampText(cell, 32_000))
                : []
            )
        : []
      const name = clampText(entry.name, 64).trim() || `Sheet${index + 1}`
      sheets.push({ name, rows })
    }
  }
  if (sheets.length === 0) sheets.push({ name: 'Sheet1', rows: [] })
  return { kind: 'sheet', sheets }
}

function normalizeDeckModel(value: Record<string, unknown>): DeckDocumentModel {
  const slides: DeckSlide[] = []
  if (Array.isArray(value.slides)) {
    for (const entry of value.slides.slice(0, OFFICE_MODEL_LIMITS.maxDeckSlides)) {
      if (!isRecord(entry)) continue
      const bullets: DeckBullet[] = []
      if (Array.isArray(entry.bullets)) {
        for (const bullet of entry.bullets.slice(0, OFFICE_MODEL_LIMITS.maxDeckBullets)) {
          if (!isRecord(bullet)) continue
          const rawLevel = typeof bullet.level === 'number' ? Math.floor(bullet.level) : 0
          bullets.push({
            text: clampText(bullet.text, 8_000),
            level: Math.min(8, Math.max(0, rawLevel))
          })
        }
      }
      slides.push({
        title: clampText(entry.title, 2_000),
        bullets,
        notes: clampText(entry.notes, 32_000)
      })
    }
  }
  return { kind: 'deck', slides }
}

const isIsoDate = (value: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(value)
const isIsoDateTime = (value: string): boolean => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)

function normalizeCalendarEvent(value: unknown, index: number): CalendarEvent | null {
  if (!isRecord(value)) return null
  const allDay = value.allDay === true
  const validStamp = allDay ? isIsoDate : isIsoDateTime
  const start = clampText(value.start, 32)
  const end = clampText(value.end, 32)
  if (!validStamp(start) || !validStamp(end)) return null
  const event: CalendarEvent = {
    uid: clampText(value.uid, 512).trim() || `taskwraith-event-${index + 1}`,
    title: clampText(value.title, 2_000),
    start,
    end,
    allDay
  }
  const location = clampText(value.location, 4_000)
  if (location) event.location = location
  const description = clampText(value.description, 32_000)
  if (description) event.description = description
  const extra = clampStringArray(value.extraProperties, OFFICE_MODEL_LIMITS.maxExtraLines)
  if (extra.length > 0) event.extraProperties = extra
  return event
}

function normalizeCalendarModel(value: Record<string, unknown>): CalendarDocumentModel {
  const events: CalendarEvent[] = []
  if (Array.isArray(value.events)) {
    for (const [index, entry] of value.events
      .slice(0, OFFICE_MODEL_LIMITS.maxCalendarEvents)
      .entries()) {
      const event = normalizeCalendarEvent(entry, index)
      if (event) events.push(event)
    }
  }
  const model: CalendarDocumentModel = { kind: 'calendar', events }
  const calendarName = clampText(value.calendarName, 256).trim()
  if (calendarName) model.calendarName = calendarName
  const extra = clampStringArray(value.extraProperties, OFFICE_MODEL_LIMITS.maxExtraLines)
  if (extra.length > 0) model.extraProperties = extra
  return model
}

function normalizeMailModel(value: Record<string, unknown>): MailDocumentModel {
  const model: MailDocumentModel = {
    kind: 'mail',
    from: clampText(value.from, 4_000),
    to: clampText(value.to, 8_000),
    cc: clampText(value.cc, 8_000),
    bcc: clampText(value.bcc, 8_000),
    subject: clampText(value.subject, 4_000),
    body: clampText(value.body)
  }
  const date = clampText(value.date, 128).trim()
  if (date) model.date = date
  if (Array.isArray(value.extraHeaders)) {
    const headers: MailHeader[] = []
    for (const entry of value.extraHeaders.slice(0, 256)) {
      if (!isRecord(entry)) continue
      const name = clampText(entry.name, 256).trim()
      if (!name || !/^[!-9;-~]+$/.test(name)) continue
      headers.push({ name, value: clampText(entry.value, 8_000) })
    }
    if (headers.length > 0) model.extraHeaders = headers
  }
  return model
}

/**
 * Defensive parse of an untrusted value into an office model. Returns null
 * when the value is not an office model at all (missing/unknown kind).
 */
export function normalizeOfficeDocumentModel(value: unknown): OfficeDocumentModel | null {
  if (!isRecord(value)) return null
  switch (value.kind) {
    case 'word':
      return normalizeWordModel(value)
    case 'sheet':
      return normalizeSheetModel(value)
    case 'deck':
      return normalizeDeckModel(value)
    case 'calendar':
      return normalizeCalendarModel(value)
    case 'mail':
      return normalizeMailModel(value)
    default:
      return null
  }
}

export function createEmptyOfficeDocumentModel(kind: OfficeDocumentKind): OfficeDocumentModel {
  switch (kind) {
    case 'word':
      return { kind: 'word', blocks: [{ type: 'paragraph', runs: [] }] }
    case 'sheet':
      return {
        kind: 'sheet',
        sheets: [
          {
            name: 'Sheet1',
            rows: [
              ['', '', ''],
              ['', '', ''],
              ['', '', '']
            ]
          }
        ]
      }
    case 'deck':
      return { kind: 'deck', slides: [{ title: '', bullets: [], notes: '' }] }
    case 'calendar':
      return { kind: 'calendar', events: [] }
    case 'mail':
      return { kind: 'mail', from: '', to: '', cc: '', bcc: '', subject: '', body: '' }
  }
}

/** Plain-text projection used for dirty checks, previews and search. */
export function officeModelPlainText(model: OfficeDocumentModel): string {
  switch (model.kind) {
    case 'word':
      return model.blocks
        .map((block) =>
          block.type === 'table'
            ? block.rows
                .map((row) => row.map((cell) => cell.map((run) => run.text).join('')).join('\t'))
                .join('\n')
            : block.runs.map((run) => run.text).join('')
        )
        .join('\n')
    case 'sheet':
      return model.sheets
        .map((sheet) => sheet.rows.map((row) => row.join('\t')).join('\n'))
        .join('\n\n')
    case 'deck':
      return model.slides
        .map((slide) => [slide.title, ...slide.bullets.map((bullet) => bullet.text)].join('\n'))
        .join('\n\n')
    case 'calendar':
      return model.events.map((event) => `${event.start} ${event.title}`).join('\n')
    case 'mail':
      return `${model.subject}\n${model.body}`
  }
}
