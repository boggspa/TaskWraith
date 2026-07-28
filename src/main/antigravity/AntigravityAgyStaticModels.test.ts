import { describe, expect, it } from 'vitest'
import {
  ANTIGRAVITY_AGY_STATIC_MODEL_IDS,
  antigravityAgyStaticModels,
  isResoldFirstPartyAgyModelId,
  offerableAgyModels
} from './AntigravityAgyStaticModels'
import { parseAgyModels } from './AntigravityCli'
import { isAntigravityGeminiApiModelCandidate } from './AntigravityCombinedModeDispatch'

describe('antigravityAgyStaticModels', () => {
  it('offers the Gemini families and refuses resold first-party models', () => {
    expect(ANTIGRAVITY_AGY_STATIC_MODEL_IDS).toContain('gemini-3.6-flash-high')
    expect(ANTIGRAVITY_AGY_STATIC_MODEL_IDS).toContain('gemini-3.1-pro-low')
    // claude-*/gpt-oss-* exist in agy's catalogue but are never offered:
    // dispatching first-party models resold through the ban-risk lane
    // compounds the ToS exposure (the Pi anti-circumvention doctrine).
    expect(ANTIGRAVITY_AGY_STATIC_MODEL_IDS).not.toContain('claude-sonnet-4-6')
    expect(ANTIGRAVITY_AGY_STATIC_MODEL_IDS).not.toContain('claude-opus-4-6-thinking')
    expect(ANTIGRAVITY_AGY_STATIC_MODEL_IDS).not.toContain('gpt-oss-120b-medium')
    expect(antigravityAgyStaticModels().length).toBe(ANTIGRAVITY_AGY_STATIC_MODEL_IDS.length)
  })

  it('filters resold first-party ids out of any model list', () => {
    expect(isResoldFirstPartyAgyModelId('claude-sonnet-4-6')).toBe(true)
    expect(isResoldFirstPartyAgyModelId('claude-opus-4-6-thinking')).toBe(true)
    expect(isResoldFirstPartyAgyModelId('gpt-oss-120b-medium')).toBe(true)
    expect(isResoldFirstPartyAgyModelId('gemini-3.6-flash-high')).toBe(false)
    const filtered = offerableAgyModels([
      { id: 'gemini-3.6-flash-high', label: 'gemini-3.6-flash-high' },
      { id: 'claude-sonnet-4-6', label: 'claude-sonnet-4-6' },
      { id: 'gpt-oss-120b-medium', label: 'gpt-oss-120b-medium' }
    ])
    expect(filtered.map((model) => model.id)).toEqual(['gemini-3.6-flash-high'])
  })

  // `agy models` prints bare ids with no display column, so live rows take the
  // id as their label. Floor rows must match or they would look different in the
  // picker from the same model discovered live.
  it('labels rows exactly as live discovery does', () => {
    const live = parseAgyModels(ANTIGRAVITY_AGY_STATIC_MODEL_IDS.join('\n'))
    expect(antigravityAgyStaticModels()).toEqual(live)
  })

  it('has no duplicate ids', () => {
    const ids = antigravityAgyStaticModels().map((model) => model.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  // Combined-mode dispatch routes by model string: a `gemini-api` prefix goes to
  // the separately billed SDK key lane. A floor id landing in that namespace
  // would silently bill the API key instead of running the consented agy lane.
  it('never collides with the gemini-api dispatch namespace', () => {
    for (const model of antigravityAgyStaticModels()) {
      expect(isAntigravityGeminiApiModelCandidate(model.id)).toBe(false)
    }
  })

  it('is selectable argv: no whitespace or option-like ids', () => {
    for (const { id } of antigravityAgyStaticModels()) {
      expect(id).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/)
      expect(id.startsWith('-')).toBe(false)
    }
  })
})
