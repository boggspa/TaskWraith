import { describe, expect, it } from 'vitest'
import {
  OFFICE_MODEL_LIMITS,
  createEmptyOfficeDocumentModel,
  normalizeOfficeDocumentModel,
  officeModelPlainText,
  type CalendarDocumentModel,
  type SheetDocumentModel,
  type WordDocumentModel
} from './officeModels'

describe('normalizeOfficeDocumentModel', () => {
  it('rejects values that are not office models', () => {
    expect(normalizeOfficeDocumentModel(null)).toBeNull()
    expect(normalizeOfficeDocumentModel('word')).toBeNull()
    expect(normalizeOfficeDocumentModel({ kind: 'presentation' })).toBeNull()
    expect(normalizeOfficeDocumentModel([])).toBeNull()
  })

  it('normalizes a word model and drops malformed fragments without failing', () => {
    const model = normalizeOfficeDocumentModel({
      kind: 'word',
      blocks: [
        { type: 'heading', level: 9, runs: [{ text: 'Title', bold: true }] },
        {
          type: 'paragraph',
          runs: [{ text: 42 }, 'garbage', { text: 'ok', link: 'javascript:x' }]
        },
        { type: 'list-item', ordered: 'yes', level: -4, runs: [{ text: 'item' }] },
        { type: 'unknown-block' },
        null
      ]
    }) as WordDocumentModel
    expect(model.kind).toBe('word')
    expect(model.blocks).toHaveLength(3)
    expect(model.blocks[0]).toEqual({
      type: 'heading',
      level: 1,
      runs: [{ text: 'Title', bold: true }]
    })
    // Non-string text degrades to '', junk entries dropped, non-http links stripped.
    expect(model.blocks[1]).toEqual({ type: 'paragraph', runs: [{ text: '' }, { text: 'ok' }] })
    expect(model.blocks[2]).toEqual({
      type: 'list-item',
      ordered: false,
      level: 0,
      runs: [{ text: 'item' }]
    })
  })

  it('clamps sheet dimensions and guarantees at least one named sheet', () => {
    const oversized = Array.from({ length: OFFICE_MODEL_LIMITS.maxSheetCols + 10 }, () => 'x')
    const model = normalizeOfficeDocumentModel({
      kind: 'sheet',
      sheets: [{ name: '', rows: [oversized, 'not-a-row'] }]
    }) as SheetDocumentModel
    expect(model.sheets[0].name).toBe('Sheet1')
    expect(model.sheets[0].rows[0]).toHaveLength(OFFICE_MODEL_LIMITS.maxSheetCols)
    expect(model.sheets[0].rows[1]).toEqual([])

    const empty = normalizeOfficeDocumentModel({ kind: 'sheet' }) as SheetDocumentModel
    expect(empty.sheets).toEqual([{ name: 'Sheet1', rows: [] }])
  })

  it('drops calendar events with malformed stamps and preserves extras', () => {
    const model = normalizeOfficeDocumentModel({
      kind: 'calendar',
      events: [
        {
          uid: 'a',
          title: 'ok',
          start: '2026-07-25T09:00',
          end: '2026-07-25T10:00',
          allDay: false
        },
        { uid: 'b', title: 'bad', start: '25/07/2026', end: '2026-07-25', allDay: true },
        {
          uid: 'c',
          title: 'spans',
          start: '2026-07-25',
          end: '2026-07-27',
          allDay: true,
          extraProperties: ['RRULE:FREQ=WEEKLY']
        }
      ]
    }) as CalendarDocumentModel
    expect(model.events.map((event) => event.uid)).toEqual(['a', 'c'])
    expect(model.events[1].extraProperties).toEqual(['RRULE:FREQ=WEEKLY'])
  })

  it('generates uids for events that lack one', () => {
    const model = normalizeOfficeDocumentModel({
      kind: 'calendar',
      events: [{ title: 'x', start: '2026-01-01', end: '2026-01-02', allDay: true }]
    }) as CalendarDocumentModel
    expect(model.events[0].uid).toMatch(/^taskwraith-event-/)
  })

  it('filters mail extra headers to valid RFC names', () => {
    const model = normalizeOfficeDocumentModel({
      kind: 'mail',
      from: 'a@b.c',
      to: 'd@e.f',
      subject: 'Hi',
      body: 'Body',
      extraHeaders: [
        { name: 'X-Priority', value: '1' },
        { name: 'Bad Header:', value: 'nope' },
        { name: '', value: 'nope' }
      ]
    })
    expect(model).toMatchObject({
      kind: 'mail',
      extraHeaders: [{ name: 'X-Priority', value: '1' }]
    })
  })
})

describe('createEmptyOfficeDocumentModel', () => {
  it('creates a usable starter model for every kind', () => {
    expect(createEmptyOfficeDocumentModel('word').kind).toBe('word')
    const sheet = createEmptyOfficeDocumentModel('sheet') as SheetDocumentModel
    expect(sheet.sheets[0].rows).toHaveLength(3)
    expect(createEmptyOfficeDocumentModel('deck')).toEqual({
      kind: 'deck',
      slides: [{ title: '', bullets: [], notes: '' }]
    })
    expect(createEmptyOfficeDocumentModel('calendar')).toEqual({ kind: 'calendar', events: [] })
    expect(createEmptyOfficeDocumentModel('mail').kind).toBe('mail')
  })

  it('round-trips every empty model through normalization unchanged', () => {
    for (const kind of ['word', 'sheet', 'deck', 'calendar', 'mail'] as const) {
      const empty = createEmptyOfficeDocumentModel(kind)
      expect(normalizeOfficeDocumentModel(JSON.parse(JSON.stringify(empty)))).toEqual(empty)
    }
  })
})

describe('officeModelPlainText', () => {
  it('projects each kind to searchable text', () => {
    const word = normalizeOfficeDocumentModel({
      kind: 'word',
      blocks: [
        { type: 'heading', level: 1, runs: [{ text: 'Report' }] },
        { type: 'table', rows: [[[{ text: 'a' }], [{ text: 'b' }]]] }
      ]
    }) as WordDocumentModel
    expect(officeModelPlainText(word)).toBe('Report\na\tb')
  })
})
