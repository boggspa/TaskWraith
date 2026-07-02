import { describe, expect, it } from 'vitest'
import { buildScopeRadarResult } from './ScopeRadarModel'

const NOW = new Date('2026-07-02T21:00:00.000Z')

describe('ScopeRadarModel', () => {
  it('turns a vague UI importer prompt into bounded capability slices', () => {
    const radar = buildScopeRadarResult({
      prompt: 'Make my app import UI. It should support arbitrary UI and be complete.',
      now: NOW
    })

    expect(radar.riskLevel).toBe('high')
    expect(radar.desiredCapability).toBe(
      'Make my app import UI'
    )
    expect(radar.capabilityMap.map((entry) => entry.key)).toContain('source-format-contract')
    expect(radar.capabilityMap.map((entry) => entry.key)).toContain('arbitrary-ui-coverage')
    expect(radar.sliceKinds['source-format-contract']).toBe('prerequisite')
    expect(radar.sliceKinds['arbitrary-ui-coverage']).toBe('speculative')
    expect(radar.questions.map((question) => question.id)).toEqual([
      'source-format',
      'first-fixture',
      'current-state',
      'done-proof'
    ])
    expect(radar.nonGoals).toContain('Arbitrary support for every possible UI framework or source format.')
    expect(radar.slopBudget).toMatchObject({
      maxNewAbstractions: 1,
      maxPlaceholderFiles: 0,
      maxDuplicatedPatterns: 0
    })
    expect(radar.evidencePackDraft.mapEntries).toHaveLength(radar.capabilityMap.length)
    expect(radar.evidencePackDraft.capabilityCells.every((cell) => cell.status === 'unverified')).toBe(true)
  })

  it('creates a generic scope map for narrower implementation prompts', () => {
    const radar = buildScopeRadarResult({
      prompt: 'Add a retry button to the failed upload card.',
      currentState: 'The failed upload card already renders an error state.',
      now: NOW
    })

    expect(radar.riskLevel).toBe('low')
    expect(radar.questions.map((question) => question.id)).not.toContain('current-state')
    expect(radar.capabilityMap.some((entry) => entry.key.endsWith('-validation'))).toBe(true)
    expect(radar.allowedSurfaces).toContain('directly related implementation files')
    expect(radar.evidenceRequired).toContain(
      'Focused tests, commands, screenshots, or fixture runs that prove the changed capability.'
    )
  })

  it('rejects empty prompts', () => {
    expect(() => buildScopeRadarResult({ prompt: '   ', now: NOW })).toThrow(
      'Scope Radar requires a non-empty prompt.'
    )
  })
})
