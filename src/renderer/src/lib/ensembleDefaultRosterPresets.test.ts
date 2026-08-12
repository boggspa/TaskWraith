import { describe, expect, it } from 'vitest'
import { isEnsembleRosterPreset } from '../../../main/EnsembleRosterPresetContract'
import type { ProviderId } from '../../../main/store/types'
import {
  buildDefaultEnsembleRosterPresets,
  DEFAULT_ENSEMBLE_ROSTER_SIZES
} from './ensembleDefaultRosterPresets'

describe('buildDefaultEnsembleRosterPresets', () => {
  it('builds valid 3/4/5/6/8/10 participant presets', () => {
    const presets = buildDefaultEnsembleRosterPresets(['codex', 'mistral'], 123)

    expect(presets.map((preset) => preset.participants.length)).toEqual(
      DEFAULT_ENSEMBLE_ROSTER_SIZES
    )
    expect(presets.every(isEnsembleRosterPreset)).toBe(true)
    expect(presets.every((preset) => preset.orchestrationMode === 'continuous')).toBe(true)
    expect(presets.every((preset) => preset.fanoutPolicy === 'read_only')).toBe(true)
  })

  it('uses only configured providers and repeats them round-robin for larger panels', () => {
    const full = buildDefaultEnsembleRosterPresets(['codex', 'mistral'], 123).at(-1)!

    expect(full.participants.map((participant) => participant.provider)).toEqual([
      'codex',
      'mistral',
      'codex',
      'mistral',
      'codex',
      'mistral',
      'codex',
      'mistral',
      'codex',
      'mistral'
    ])
    expect(
      full.participants
        .filter((participant) => participant.provider === 'codex')
        .every((participant) => participant.model === 'gpt-5.5')
    ).toBe(true)
    expect(
      full.participants
        .filter((participant) => participant.provider === 'mistral')
        .every((participant) => participant.model === 'devstral-small')
    ).toBe(true)
  })

  it('keeps every seeded seat at Accept Edits with no elevated overrides', () => {
    const participants = buildDefaultEnsembleRosterPresets(
      ['claude', 'codex', 'mistral'],
      123
    ).flatMap((preset) => preset.participants)

    expect(new Set(participants.map((participant) => participant.permissionPresetId))).toEqual(
      new Set(['default'])
    )
    expect(participants.every((participant) => participant.permissionOverrides === undefined)).toBe(
      true
    )
  })

  it('carries the requested management authority and staged fan-out roles', () => {
    const full = buildDefaultEnsembleRosterPresets(['codex'], 123).at(-1)!

    expect(full.participants.map((participant) => participant.role)).toEqual([
      'Orchestrator',
      'Advisor',
      'Boardmaster',
      'Scout1',
      'Scout2',
      'Work1',
      'Work2',
      'Work3',
      'Challenge1',
      'Challenge2'
    ])
    expect(
      full.participants.filter((participant) => participant.isBossman).map((p) => p.role)
    ).toEqual(['Orchestrator'])
    expect(
      full.participants.filter((participant) => participant.isSecondInCommand).map((p) => p.role)
    ).toEqual(['Advisor', 'Boardmaster'])
    expect(full.participants.map((participant) => participant.stageRole)).toEqual([
      undefined,
      undefined,
      undefined,
      'scout',
      'scout',
      'worker',
      'worker',
      'worker',
      'reviewer',
      'reviewer'
    ])
  })

  it('scales smaller variants as balanced role subsets with a Boss and Captain', () => {
    const presets = buildDefaultEnsembleRosterPresets(['codex'], 123)

    expect(
      presets.map((preset) => preset.participants.map((participant) => participant.role))
    ).toEqual([
      ['Orchestrator', 'Advisor', 'Work1'],
      ['Orchestrator', 'Advisor', 'Work1', 'Challenge1'],
      ['Orchestrator', 'Advisor', 'Scout1', 'Work1', 'Challenge1'],
      ['Orchestrator', 'Advisor', 'Scout1', 'Work1', 'Work2', 'Challenge1'],
      [
        'Orchestrator',
        'Advisor',
        'Boardmaster',
        'Scout1',
        'Scout2',
        'Work1',
        'Work2',
        'Challenge1'
      ],
      [
        'Orchestrator',
        'Advisor',
        'Boardmaster',
        'Scout1',
        'Scout2',
        'Work1',
        'Work2',
        'Work3',
        'Challenge1',
        'Challenge2'
      ]
    ])
    expect(
      presets.every(
        (preset) =>
          preset.participants.filter((participant) => participant.isBossman).length === 1 &&
          preset.participants.some((participant) => participant.isSecondInCommand)
      )
    ).toBe(true)
  })

  it('filters retired/duplicate providers and waits when no runnable provider is known', () => {
    expect(
      buildDefaultEnsembleRosterPresets(
        ['gemini', 'codex', 'codex'] as ProviderId[],
        123
      )[0].participants.map((participant) => participant.provider)
    ).toEqual(['codex', 'codex', 'codex'])
    expect(buildDefaultEnsembleRosterPresets([], 123)).toEqual([])
  })
})
