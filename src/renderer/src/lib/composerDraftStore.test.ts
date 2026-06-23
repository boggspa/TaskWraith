import { describe, it, expect } from 'vitest'
import { parseDraftBlob, serializeDraftBlob } from './composerDraftStore'

describe('composerDraftStore', () => {
  describe('parseDraftBlob', () => {
    it('returns {} for null / empty / missing input', () => {
      expect(parseDraftBlob(null)).toEqual({})
      expect(parseDraftBlob(undefined)).toEqual({})
      expect(parseDraftBlob('')).toEqual({})
    })

    it('returns {} for corrupt JSON (never throws)', () => {
      expect(parseDraftBlob('{not json')).toEqual({})
      expect(parseDraftBlob('[1,2,3]')).toEqual({})
      expect(parseDraftBlob('"a string"')).toEqual({})
    })

    it('returns {} when the blob has no drafts object', () => {
      expect(parseDraftBlob(JSON.stringify({ v: 1 }))).toEqual({})
      expect(parseDraftBlob(JSON.stringify({ v: 1, drafts: null }))).toEqual({})
    })

    it('reads non-empty drafts and drops empty / whitespace / non-string entries', () => {
      const raw = JSON.stringify({
        v: 1,
        drafts: { a: 'hello', b: '', c: '   ', d: 'world', e: 42 }
      })
      expect(parseDraftBlob(raw)).toEqual({ a: 'hello', d: 'world' })
    })
  })

  describe('serializeDraftBlob', () => {
    it('drops empty / whitespace-only drafts', () => {
      const blob = serializeDraftBlob({ a: 'keep', b: '', c: '   \n ' })
      expect(JSON.parse(blob)).toEqual({ v: 1, drafts: { a: 'keep' } })
    })

    it('clamps an absurdly large draft', () => {
      const huge = 'x'.repeat(250_000)
      const parsed = JSON.parse(serializeDraftBlob({ a: huge })) as {
        drafts: Record<string, string>
      }
      expect(parsed.drafts.a.length).toBe(100_000)
    })

    it('round-trips a draft map through serialize → parse', () => {
      const map = { 'chat-1': 'half a thought', 'chat-2': 'another\nmulti-line draft' }
      expect(parseDraftBlob(serializeDraftBlob(map))).toEqual(map)
    })

    it('a cleared draft does not round-trip (no resurrection)', () => {
      // chat-1 typed then cleared (empty) must NOT survive serialize→parse.
      expect(parseDraftBlob(serializeDraftBlob({ 'chat-1': '' }))).toEqual({})
    })
  })
})
