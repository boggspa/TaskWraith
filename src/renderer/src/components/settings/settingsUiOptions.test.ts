import * as allOptions from './settingsUiOptions'
import { describe, expect, it } from 'vitest'
import {
  APP_ICON_THUMBS,
  CODEX_SANDBOX_FALLBACK_OPTIONS,
  COMPOSER_STYLE_OPTIONS,
  CONTEXT_TURN_OPTIONS,
  FANOUT_LANE_LAYOUT_OPTIONS,
  FUN_FX_MODES,
  NATIVE_SUB_AGENT_REQUEST_OPTIONS,
  VISUAL_EFFECT_OPTIONS,
  clampPaneOpacity,
  rangeFillStyle
} from './settingsUiOptions'

describe('clampPaneOpacity', () => {
  it('passes in-range integers through unchanged', () => {
    expect(clampPaneOpacity(0)).toBe(0)
    expect(clampPaneOpacity(42)).toBe(42)
    expect(clampPaneOpacity(100)).toBe(100)
  })

  it('rounds fractional values to the nearest integer', () => {
    expect(clampPaneOpacity(42.4)).toBe(42)
    expect(clampPaneOpacity(42.5)).toBe(43)
  })

  it('clamps out-of-range values to the 0-100 pane range', () => {
    expect(clampPaneOpacity(-1)).toBe(0)
    expect(clampPaneOpacity(-500)).toBe(0)
    expect(clampPaneOpacity(101)).toBe(100)
    expect(clampPaneOpacity(10000)).toBe(100)
  })

  it('coerces numeric strings before clamping', () => {
    expect(clampPaneOpacity('72')).toBe(72)
    expect(clampPaneOpacity('150')).toBe(100)
  })

  it('falls back to fully opaque for anything non-numeric', () => {
    // NaN, undefined, and garbage strings all mean "no stored value", so the
    // pane renders at full opacity rather than going transparent.
    expect(clampPaneOpacity(NaN)).toBe(100)
    expect(clampPaneOpacity(undefined)).toBe(100)
    expect(clampPaneOpacity('not-a-number')).toBe(100)
    expect(clampPaneOpacity({})).toBe(100)
  })

  it('treats null as zero via Number(null), not as missing', () => {
    // `Number(null)` is 0 (finite), so null clamps to transparent instead of
    // taking the opaque fallback. Pinning the quirk so a "fix" stays loud.
    expect(clampPaneOpacity(null)).toBe(0)
  })
})

describe('rangeFillStyle', () => {
  it('reports the fill percentage for an in-range value', () => {
    expect(rangeFillStyle(50, 0, 100)).toEqual({ '--ensemble-context-slider-fill': '50%' })
    expect(rangeFillStyle(25, 0, 200)).toEqual({ '--ensemble-context-slider-fill': '12.5%' })
  })

  it('clamps over- and under-range values to 100% and 0%', () => {
    expect(rangeFillStyle(150, 0, 100)).toEqual({ '--ensemble-context-slider-fill': '100%' })
    expect(rangeFillStyle(-50, 0, 100)).toEqual({ '--ensemble-context-slider-fill': '0%' })
  })

  it('renders an empty track when the range is degenerate', () => {
    expect(rangeFillStyle(50, 100, 100)).toEqual({ '--ensemble-context-slider-fill': '0%' })
    expect(rangeFillStyle(50, 100, 0)).toEqual({ '--ensemble-context-slider-fill': '0%' })
  })
})

describe('CONTEXT_TURN_OPTIONS', () => {
  it('offers the exact turn-count roster the slider expects', () => {
    expect(CONTEXT_TURN_OPTIONS).toEqual([0, 2, 4, 6, 8, 10, 12, 16, 20])
  })
})

/**
 * Every exported `{ value, label }` array in the module, found by inspecting
 * the module's own exports rather than by listing them here.
 *
 * A hand-written list fails OPEN: a new options array is simply absent from it
 * and every assertion passes over the arrays that were remembered.
 */
function optionLists(): Array<[string, Array<{ value: unknown; label: string }>]> {
  const lists: Array<[string, Array<{ value: unknown; label: string }>]> = []
  for (const [name, exported] of Object.entries(allOptions) as Array<[string, unknown]>) {
    if (!Array.isArray(exported) || exported.length === 0) continue
    const isOptionList = exported.every(
      (option) =>
        typeof option === 'object' &&
        option !== null &&
        'value' in option &&
        'label' in option &&
        typeof (option as { label: unknown }).label === 'string'
    )
    if (!isOptionList) continue
    lists.push([name, exported as Array<{ value: unknown; label: string }>])
  }
  return lists
}

describe('option arrays', () => {
  it('discovers every option list in the module, not a hand-copied subset', () => {
    // Anti-vacuity, and the reason the two hand-maintained copies below are
    // gone. Each `it` used to carry its own literal list of seven arrays, so a
    // NEW options array was covered only if someone remembered to add it to
    // BOTH — and nothing red if they did not. Discovery removes the choice.
    const names = optionLists().map(([name]) => name)
    for (const known of [
      'VISUAL_EFFECT_OPTIONS',
      'PROMPT_SURFACE_OPTIONS',
      'FANOUT_LANE_LAYOUT_OPTIONS',
      'COMPOSER_STYLE_OPTIONS',
      'NATIVE_SUB_AGENT_REQUEST_OPTIONS',
      'CODEX_SANDBOX_FALLBACK_OPTIONS',
      'FUN_FX_MODES',
      'TRANSCRIPT_VIEW_OPTIONS',
      'TRANSCRIPT_TEXT_SIZE_OPTIONS',
      'TRANSCRIPT_WIDTH_OPTIONS'
    ]) {
      expect(names, known).toContain(known)
    }
    expect(names.length).toBeGreaterThanOrEqual(10)
  })

  it('keeps every option value unique within its own list', () => {
    for (const [, list] of optionLists()) {
      const values = list.map((option) => option.value)
      expect(new Set(values).size).toBe(values.length)
    }
  })

  it('gives every option a non-empty label', () => {
    const lists = optionLists().map(([, list]) => list)
    for (const list of lists) {
      for (const option of list) {
        expect(option.label.length).toBeGreaterThan(0)
      }
    }
  })

  it('covers every visual-effect style the theme engine supports', () => {
    expect(VISUAL_EFFECT_OPTIONS.map((option) => option.value)).toEqual([
      'auto',
      'liquid_glass',
      'thin_material',
      'classic'
    ])
  })

  it('keeps the fanout lane layouts as a stacked/paired pair', () => {
    expect(FANOUT_LANE_LAYOUT_OPTIONS.map((option) => option.value)).toEqual(['stacked', 'paired'])
  })

  it('keeps the native shell plus the two TaskWraith-redirect composer styles', () => {
    const values = COMPOSER_STYLE_OPTIONS.map((option) => option.value)
    expect(values[0]).toBe('default')
    expect(values).toContain('obsidian')
    expect(values).toContain('alabaster')
  })

  it('orders the fun-fx modes from off to epic', () => {
    expect(FUN_FX_MODES.map((option) => option.value)).toEqual([
      'off',
      'subtle',
      'cinematic',
      'epic'
    ])
  })

  it('offers ask/provider/taskwraith for native sub-agent requests', () => {
    expect(NATIVE_SUB_AGENT_REQUEST_OPTIONS.map((option) => option.value)).toEqual([
      'ask',
      'provider',
      'taskwraith'
    ])
  })

  it('offers ask-to-rerun plus off for the codex sandbox fallback', () => {
    expect(CODEX_SANDBOX_FALLBACK_OPTIONS.map((option) => option.value)).toEqual([
      'ask_rerun',
      'off'
    ])
  })

  it('ships a thumbnail for every app-icon variant', () => {
    expect(Object.keys(APP_ICON_THUMBS).sort()).toEqual([
      'glass',
      'lightMonoline',
      'monoline',
      'regular'
    ])
    for (const thumb of Object.values(APP_ICON_THUMBS)) {
      expect(typeof thumb).toBe('string')
      expect(thumb.length).toBeGreaterThan(0)
    }
  })
})
