import { describe, expect, it } from 'vitest'

import { isMistralThinkingCapableModel } from './mistralModels'

describe('isMistralThinkingCapableModel', () => {
  it('marks the hosted GLM-5.2 subscription model as thinking-capable', () => {
    // glm-5-2 runs on the Vibe subscription and exposes the full
    // off/low/medium/high/max thinking ladder, same as mistral-medium-3.5.
    expect(isMistralThinkingCapableModel('glm-5-2')).toBe(true)
    expect(isMistralThinkingCapableModel('mistral-medium-3.5')).toBe(true)
  })

  it('leaves the API GLM-5.2 (zai-glm-5-2) unchanged; the API lane is not thinking-capable here', () => {
    expect(isMistralThinkingCapableModel('zai-glm-5-2')).toBe(false)
  })
})
