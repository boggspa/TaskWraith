import { describe, expect, it } from 'vitest'
import {
  canonicalTaskWraithToolName,
  isEnsembleControlToolName,
  isPortableEnsembleControlToolName,
  normalizeEnsembleMcpToolArguments,
  normalizePortableEnsembleControlArguments
} from './taskWraithMcpCatalog'

const CONTROL_TOOL_NAMES = ['ensemble_control', 'ensemble_bossman_control'] as const

describe('one Ensemble argument convention', () => {
  it('unwraps the params envelope on BOTH control tool names', () => {
    for (const toolName of CONTROL_TOOL_NAMES) {
      expect(
        normalizeEnsembleMcpToolArguments(toolName, {
          action: 'set_round_plan',
          params: { planSummary: 'Review the implementation.' }
        })
      ).toEqual({ action: 'set_round_plan', planSummary: 'Review the implementation.' })
    }
  })

  it('passes an already-flat call through unchanged on BOTH control tool names', () => {
    for (const toolName of CONTROL_TOOL_NAMES) {
      expect(
        normalizeEnsembleMcpToolArguments(toolName, {
          action: 'set_round_plan',
          planSummary: 'Review the implementation.'
        })
      ).toEqual({ action: 'set_round_plan', planSummary: 'Review the implementation.' })
    }
  })

  it('MERGES instead of replacing, so an envelope that omits action keeps the outer action', () => {
    // The broker path used to assign `arguments = arguments.params`, which
    // dropped a top-level action the envelope did not repeat.
    for (const toolName of CONTROL_TOOL_NAMES) {
      expect(
        normalizeEnsembleMcpToolArguments(toolName, {
          action: 'assign_work',
          params: { targetParticipantId: 'p7', objective: 'Ship the slice.' }
        })
      ).toEqual({
        action: 'assign_work',
        targetParticipantId: 'p7',
        objective: 'Ship the slice.'
      })
    }
  })

  it('lets a flat field win, but never lets an absent flat field erase an enveloped one', () => {
    expect(
      normalizeEnsembleMcpToolArguments('ensemble_control', {
        action: 'set_round_plan',
        planSummary: 'flat wins',
        params: { planSummary: 'enveloped loses' }
      })
    ).toMatchObject({ planSummary: 'flat wins' })

    expect(
      normalizeEnsembleMcpToolArguments('ensemble_control', {
        action: 'set_round_plan',
        planSummary: undefined,
        params: { planSummary: 'enveloped survives' }
      })
    ).toMatchObject({ planSummary: 'enveloped survives' })
  })

  it('folds snake_case aliases centrally instead of per dispatch site', () => {
    expect(
      normalizeEnsembleMcpToolArguments('ensemble_fanout', {
        prompt: 'go',
        write_scopes: { Work4: ['src/main/index.ts'] },
        target_stage: 'workers'
      })
    ).toMatchObject({
      writeScopes: { Work4: ['src/main/index.ts'] },
      targetStage: 'workers'
    })

    expect(
      normalizeEnsembleMcpToolArguments('ensemble_lane_result', {
        lane_id: 'lane-7',
        max_chars: 2000
      })
    ).toMatchObject({ laneId: 'lane-7', maxChars: 2000 })
  })

  it('never overwrites an explicit camelCase field with its snake_case twin', () => {
    expect(
      normalizeEnsembleMcpToolArguments('ensemble_lane_result', {
        laneId: 'lane-camel',
        lane_id: 'lane-snake'
      })
    ).toMatchObject({ laneId: 'lane-camel' })
  })

  it('folds only the top level so nested strict-schema objects stay byte-identical', () => {
    const normalized = normalizeEnsembleMcpToolArguments('ensemble_roster_edit', {
      action: 'edit_participant',
      target_participant_id: 'p1',
      participant: { permission_preset_id: 'read_only' }
    }) as Record<string, unknown>

    expect(normalized.targetParticipantId).toBe('p1')
    expect(normalized.participant).toEqual({ permission_preset_id: 'read_only' })
  })

  it('leaves non-Ensemble tools completely alone, by identity', () => {
    const args = { path: 'a.ts', old_string: 'x', new_string: 'y' }
    expect(normalizeEnsembleMcpToolArguments('replace', args)).toBe(args)
    expect(normalizeEnsembleMcpToolArguments('run_shell_command', { command: 'ls' })).toEqual({
      command: 'ls'
    })
  })

  it('tolerates non-record arguments without throwing', () => {
    expect(normalizeEnsembleMcpToolArguments('ensemble_control', undefined)).toBeUndefined()
    expect(normalizeEnsembleMcpToolArguments('ensemble_control', 'raw-string')).toBe('raw-string')
    expect(
      normalizeEnsembleMcpToolArguments('ensemble_control', { action: 'x', params: 7 })
    ).toEqual({ action: 'x', params: 7 })
  })

  it('resolves prefixed provider spellings of both control names', () => {
    expect(
      normalizeEnsembleMcpToolArguments('mcp__TaskWraith__ensemble_bossman_control', {
        action: 'set_round_plan',
        params: { plan_summary: 'Prefixed spelling still normalizes.' }
      })
    ).toMatchObject({
      action: 'set_round_plan',
      planSummary: 'Prefixed spelling still normalizes.'
    })
  })

  it('keeps the profile FENCE predicate narrow while argument shaping covers both names', () => {
    // Widening isPortableEnsembleControlToolName would make legacy profiles
    // reject the canonical ensemble_bossman_control with -32601.
    expect(isPortableEnsembleControlToolName('ensemble_control')).toBe(true)
    expect(isPortableEnsembleControlToolName('ensemble_bossman_control')).toBe(false)

    expect(isEnsembleControlToolName('ensemble_control')).toBe(true)
    expect(isEnsembleControlToolName('ensemble_bossman_control')).toBe(true)
    expect(isEnsembleControlToolName('ensemble_fanout')).toBe(false)

    expect(canonicalTaskWraithToolName('ensemble_control')).toBe('ensemble_bossman_control')
  })

  it('keeps the legacy alias export delegating to the shared convention', () => {
    expect(
      normalizePortableEnsembleControlArguments('ensemble_bossman_control', {
        action: 'set_round_plan',
        params: { planSummary: 'Legacy alias, new behaviour.' }
      })
    ).toEqual({ action: 'set_round_plan', planSummary: 'Legacy alias, new behaviour.' })
  })
})
