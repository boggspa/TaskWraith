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
  it('offers Gemini and third-party families now that CLAUDE/GPT fallback IDs are supported', () => {
    expect(ANTIGRAVITY_AGY_STATIC_MODEL_IDS).toContain('gemini-3.7-flash-high')
    expect(ANTIGRAVITY_AGY_STATIC_MODEL_IDS).toContain('gemini-3.6-flash-high')
    expect(ANTIGRAVITY_AGY_STATIC_MODEL_IDS).toContain('gemini-3.1-pro-low')
    expect(ANTIGRAVITY_AGY_STATIC_MODEL_IDS).toContain('claude-opus-4-6')
    expect(ANTIGRAVITY_AGY_STATIC_MODEL_IDS).toContain('claude-opus-4-8')
    expect(ANTIGRAVITY_AGY_STATIC_MODEL_IDS).toContain('claude-sonnet-4-5')
    expect(ANTIGRAVITY_AGY_STATIC_MODEL_IDS).toContain('gpt-oss-120b-medium')
    expect(antigravityAgyStaticModels().length).toBe(ANTIGRAVITY_AGY_STATIC_MODEL_IDS.length)
  })

  it('does not filter out any usable model id from fallback offerability by name', () => {
    expect(isResoldFirstPartyAgyModelId('claude-sonnet-4-6')).toBe(false)
    expect(isResoldFirstPartyAgyModelId('claude-opus-4-6-thinking')).toBe(false)
    expect(isResoldFirstPartyAgyModelId('gpt-oss-120b-medium')).toBe(false)
    expect(isResoldFirstPartyAgyModelId('gemini-3.7-flash-high')).toBe(false)
    const filtered = offerableAgyModels([
      { id: 'gemini-3.7-flash-high', label: 'Gemini 3.7 Flash (High)' },
      { id: 'claude-sonnet-4-6', label: 'claude-sonnet-4-6' },
      { id: 'gpt-oss-120b-medium', label: 'gpt-oss-120b-medium' }
    ])
    expect(filtered.map((model) => model.id)).toEqual([
      'gemini-3.7-flash-high',
      'claude-sonnet-4-6',
      'gpt-oss-120b-medium'
    ])
  })

  it('uses each exact wire id as the deterministic fallback label', () => {
    const parsedBareIds = parseAgyModels(ANTIGRAVITY_AGY_STATIC_MODEL_IDS.join('\n'))
    expect(antigravityAgyStaticModels()).toEqual(parsedBareIds)
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
