import { describe, expect, it } from 'vitest'
import {
  ANTIGRAVITY_AGY_STATIC_MODEL_IDS,
  antigravityAgyStaticModels
} from './AntigravityAgyStaticModels'
import { parseAgyModels } from './AntigravityCli'
import { isAntigravityGeminiApiModelCandidate } from './AntigravityCombinedModeDispatch'

describe('antigravityAgyStaticModels', () => {
  it('offers the observed official catalogue', () => {
    expect(ANTIGRAVITY_AGY_STATIC_MODEL_IDS).toContain('gemini-3.6-flash-high')
    expect(ANTIGRAVITY_AGY_STATIC_MODEL_IDS).toContain('claude-sonnet-4-6')
    expect(ANTIGRAVITY_AGY_STATIC_MODEL_IDS).toContain('gpt-oss-120b-medium')
    expect(antigravityAgyStaticModels().length).toBe(ANTIGRAVITY_AGY_STATIC_MODEL_IDS.length)
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
