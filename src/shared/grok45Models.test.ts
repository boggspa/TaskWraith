import { describe, expect, it } from 'vitest'
import {
  CURSOR_GROK_46_WIRE_MODEL_IDS,
  cursorGrokBaseModelId,
  cursorGrokFastFromModelId,
  cursorGrokReasoningFromModelId,
  isCursorGrokConcreteModelId,
  isCursorGrokModelId,
  resolveCursorGrok45CliModelId,
  resolveCursorGrokCliModelId
} from './grok45Models'

describe('Cursor Grok model families', () => {
  it('preserves the legacy Grok 4.5 effort translation and Fast placement', () => {
    expect(
      resolveCursorGrok45CliModelId({
        model: 'grok-4.5',
        reasoningEffort: 'low',
        fastModeEnabled: true
      })
    ).toBe('grok-4.5-fast-medium')
    expect(
      resolveCursorGrokCliModelId({
        model: 'grok-4.5',
        reasoningEffort: 'high',
        fastModeEnabled: true
      })
    ).toBe('grok-4.5-fast-xhigh')
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
