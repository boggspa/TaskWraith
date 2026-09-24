import { describe, expect, it } from 'vitest'
import {
  CURSOR_GROK_46_WIRE_MODEL_IDS,
  cursorGrokBaseModelId,
  cursorGrokFastFromModelId,
  cursorGrokReasoningFromModelId,
  isCursorGrokConcreteModelId,
  isCursorGrokModelId,
  migrateRetiredCursorGrokModelId,
  resolveCursorGrokCliModelId
} from './grok45Models'

/** Every id the retired Cursor Grok 4.5 row could have persisted. */
const RETIRED_45_IDS = [
  'grok-4.5',
  'cursor-grok-4.5',
  'grok-4.5-medium',
  'grok-4.5-high',
  'grok-4.5-xhigh',
  'grok-4.5-fast-medium',
  'grok-4.5-fast-high',
  'grok-4.5-fast-xhigh'
]

describe('Cursor Grok model families', () => {
  it('offers no Grok 4.5 wire id — cursor-agent rejects every one of them', () => {
    // `cursor-agent --list-models` (2026.09.02-c22c1a3) carries NO grok-4.5 row
    // at all, only cursor-grok-4.6-*. Emitting one is not a degraded run, it is
    // a hard failure: "Cannot use this model: grok-4.5-xhigh", exit 1, before a
    // single token of work. Resolution must refuse to build one.
    for (const id of RETIRED_45_IDS) {
      expect(resolveCursorGrokCliModelId({ model: id, reasoningEffort: 'high' })).toBeNull()
      expect(resolveCursorGrokCliModelId({ model: id, fastModeEnabled: true })).toBeNull()
      expect(isCursorGrokModelId(id)).toBe(false)
      expect(cursorGrokBaseModelId(id)).toBeNull()
    }
  })

  it('migrates a persisted Grok 4.5 seat onto Grok 4.6 rather than stranding it', () => {
    // A chat pinned to the retired row must keep the user's Grok intent — 4.6 is
    // the successor and its ladder is a superset (low/medium/high + xhigh).
    for (const id of RETIRED_45_IDS) {
      expect(migrateRetiredCursorGrokModelId(id)).toBe('grok-4.6')
    }
  })

  it('leaves live and foreign ids alone when migrating', () => {
    for (const id of ['grok-4.6', 'cursor-grok-4.6-high', 'composer-2.5-fast', 'gpt-5.2', '']) {
      expect(migrateRetiredCursorGrokModelId(id)).toBeNull()
    }
  })

  it('maps Grok 4.6 efforts directly and places Fast at the end', () => {
    for (const effort of ['low', 'medium', 'high', 'xhigh'] as const) {
      expect(resolveCursorGrokCliModelId({ model: 'grok-4.6', reasoningEffort: effort })).toBe(
        `cursor-grok-4.6-${effort}`
      )
      expect(
        resolveCursorGrokCliModelId({
          model: 'grok-4.6',
          reasoningEffort: effort,
          fastModeEnabled: true
        })
      ).toBe(`cursor-grok-4.6-${effort}-fast`)
    }
  })

  it('recognizes and decodes every exact Grok 4.6 wire id', () => {
    expect(CURSOR_GROK_46_WIRE_MODEL_IDS).toHaveLength(8)
    for (const id of CURSOR_GROK_46_WIRE_MODEL_IDS) {
      expect(isCursorGrokModelId(id)).toBe(true)
      expect(isCursorGrokConcreteModelId(id)).toBe(true)
      expect(cursorGrokBaseModelId(id)).toBe('grok-4.6')
      expect(cursorGrokReasoningFromModelId(id)).toBe(
        id.match(/^cursor-grok-4\.6-(low|medium|high|xhigh)/)?.[1]
      )
      expect(cursorGrokFastFromModelId(id)).toBe(id.endsWith('-fast'))
      expect(resolveCursorGrokCliModelId({ model: id })).toBe(id)
    }
  })

  it('rejects unknown and cross-provider ids', () => {
    for (const id of ['grok-4.7', 'cursor-grok-4.6-ultra', 'gpt-5.6-sol', '']) {
      expect(isCursorGrokModelId(id)).toBe(false)
      expect(cursorGrokBaseModelId(id)).toBeNull()
      expect(resolveCursorGrokCliModelId({ model: id })).toBeNull()
    }
  })
})
