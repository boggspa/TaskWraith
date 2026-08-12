import { describe, expect, it } from 'vitest'
import {
  cloneEnsembleRosterPreset,
  ENSEMBLE_ROSTER_PRESET_EXPORT_FORMAT,
  isEnsembleRosterPreset,
  MAX_ROSTER_PRESET_PARTICIPANTS,
  parseEnsembleRosterPresetJson,
  type EnsembleRosterPreset
} from '../shared/EnsembleRosterPresetContract'

function preset(): EnsembleRosterPreset {
  return {
    id: 'agent-roster-1',
    name: 'Project implementation panel',
    createdAt: 1,
    updatedAt: 1,
    orchestrationMode: 'continuous',
    maxParticipants: 4,
    maxContinuationHops: 12,
    fanoutPolicy: 'all',
    ensembleContextChars: 96_000,
    participants: [
      {
        provider: 'codex',
        enabled: true,
        role: 'Boss',
        instructions: 'Own the result and coordinate the panel.',
        order: 1,
        isBossman: true,
        model: 'gpt-5.6-terra',
        reasoningEffort: 'high',
        permissionPresetId: 'default'
      },
      {
        provider: 'claude',
        enabled: true,
        role: 'Captain',
        instructions: 'Challenge the plan and cover the second lane.',
        order: 2,
        isSecondInCommand: true,
        permissionPresetId: 'plan',
        stageRole: 'reviewer'
      }
    ]
  }
}

describe('EnsembleRosterPresetContract', () => {
  it('parses the same versioned export envelope used by Settings', () => {
    const source = preset()
    const result = parseEnsembleRosterPresetJson(
      JSON.stringify({
        format: ENSEMBLE_ROSTER_PRESET_EXPORT_FORMAT,
        version: 1,
        exportedAt: '2026-07-12T12:00:00.000Z',
        presets: [source]
      })
    )

    expect(result.validPresets).toEqual([source])
    expect(result.skippedCount).toBe(0)
  })

  it('keeps legacy raw arrays parseable and reports invalid siblings', () => {
    const result = parseEnsembleRosterPresetJson(JSON.stringify([{ id: 'bad' }, preset()]))

    expect(result.validPresets).toHaveLength(1)
    expect(result.skippedCount).toBe(1)
  })

  it('rejects malformed JSON and payloads with no roster candidates', () => {
    expect(() => parseEnsembleRosterPresetJson('{')).toThrow('valid JSON')
    expect(() => parseEnsembleRosterPresetJson(JSON.stringify({ nope: [] }))).toThrow(
      'No roster presets'
    )
  })

  it('deep-clones nested permission grants', () => {
    const source = preset()
    source.participants[0].permissionOverrides = {
      agenticServices: { mcpTools: 'deny' },
      externalPathGrants: [
        {
          id: 'grant-1',
          provider: 'codex',
          path: '/tmp/reference',
          kind: 'directory',
          access: 'read',
          duration: 'thisRun',
          createdAt: '2026-07-12T12:00:00.000Z'
        }
      ]
    }

    const cloned = cloneEnsembleRosterPreset(source)
    cloned.participants[0].permissionOverrides!.agenticServices!.mcpTools = 'allow'
    cloned.participants[0].permissionOverrides!.externalPathGrants![0].path = '/tmp/changed'

    expect(source.participants[0].permissionOverrides?.agenticServices?.mcpTools).toBe('deny')
    expect(source.participants[0].permissionOverrides?.externalPathGrants?.[0].path).toBe(
      '/tmp/reference'
    )
  })

  it('rejects malformed stages and participant ceilings', () => {
    const malformedStage = preset() as unknown as Record<string, any>
    malformedStage.participants[0].stageRole = 'boss'
    expect(isEnsembleRosterPreset(malformedStage)).toBe(false)

    const oversized = preset()
    oversized.maxParticipants = MAX_ROSTER_PRESET_PARTICIPANTS + 1
    expect(isEnsembleRosterPreset(oversized)).toBe(false)

    const nonFinite = preset()
    nonFinite.participants[0].order = Number.NaN
    expect(isEnsembleRosterPreset(nonFinite)).toBe(false)
  })

  it('rejects more than three Captains and Boss/Captain overlap', () => {
    const tooManyCaptains = preset()
    tooManyCaptains.participants.push(
      ...['codex', 'kimi', 'cursor'].map((provider, index) => ({
        provider: provider as EnsembleRosterPreset['participants'][number]['provider'],
        enabled: true,
        role: `Captain ${index + 2}`,
        instructions: '',
        order: index + 3,
        isSecondInCommand: true
      }))
    )
    expect(isEnsembleRosterPreset(tooManyCaptains)).toBe(false)

    const overlap = preset()
    overlap.participants[0].isSecondInCommand = true
    expect(isEnsembleRosterPreset(overlap)).toBe(false)

    const twoBosses = preset()
    twoBosses.participants[1].isBossman = true
    expect(isEnsembleRosterPreset(twoBosses)).toBe(false)
  })

  it('keeps legacy presets without a Boss parseable for deterministic recovery', () => {
    const legacy = preset()
    delete legacy.participants[0].isBossman
    expect(isEnsembleRosterPreset(legacy)).toBe(true)
  })
})
