import { describe, expect, it } from 'vitest'
import type { EffectiveRunPermissions } from '../store/types'
import {
  PI_ENSEMBLE_COORDINATION_TOOL_NAMES,
  PI_ULTRATASK_DELEGATION_TOOL_NAMES,
  PI_EXACT_FILE_TOOL_NAMES,
  PI_MANAGED_SHELL_TOOL_NAMES
} from './PiEnsembleCoordination'
import { resolvePiTaskWraithToolSelection } from './PiTaskWraithToolSelection'

function signedUltraTaskPermissions(): EffectiveRunPermissions {
  return {
    presetId: 'default',
    approvalMode: 'default',
    agenticServices: {} as EffectiveRunPermissions['agenticServices'],
    subThreadDelegationAutoAllowSource: 'ultratask',
    networkAccess: 'deny',
    externalPathGrants: [],
    workspaceGrantServiceIds: [],
    readOnly: false
  }
}

const base = {
  writeCapable: false,
  shellCapable: false,
  ensembleRun: false,
  workspaceScoped: true,
  coordinationAllowed: false,
  meshAllowed: false
}

describe('resolvePiTaskWraithToolSelection', () => {
  it('attaches the exact UltraTask surface to a signed solo workspace run', () => {
    const selection = resolvePiTaskWraithToolSelection({
      ...base,
      effectivePermissions: signedUltraTaskPermissions()
    })

    expect(selection.ultraTaskDelegationExpected).toBe(true)
    expect(selection.managedToolsExpected).toBe(true)
    expect(selection.toolNames).toEqual(PI_ULTRATASK_DELEGATION_TOOL_NAMES)
    expect(selection.toolNames).toContain('ultra_task')
  })

  it('does not attach UltraTask tools without the signed posture', () => {
    expect(resolvePiTaskWraithToolSelection(base)).toMatchObject({
      ultraTaskDelegationExpected: false,
      managedToolsExpected: false,
      toolNames: []
    })
  })

  it.each([
    { ensembleRun: false, workspaceScoped: false, label: 'global run' },
    { ensembleRun: true, workspaceScoped: true, label: 'Ensemble run' }
  ])('does not expose the solo graph launcher to a signed $label', (run) => {
    const selection = resolvePiTaskWraithToolSelection({
      ...base,
      ...run,
      effectivePermissions: signedUltraTaskPermissions()
    })

    expect(selection.ultraTaskDelegationExpected).toBe(false)
    expect(selection.toolNames).not.toContain('ultra_task')
  })

  it('keeps signed Ensemble seats on the ordinary coordination surface', () => {
    const selection = resolvePiTaskWraithToolSelection({
      ...base,
      ensembleRun: true,
      coordinationAllowed: true,
      effectivePermissions: signedUltraTaskPermissions()
    })

    expect(selection.coordinationExpected).toBe(true)
    expect(selection.ultraTaskDelegationExpected).toBe(false)
    expect(selection.toolNames).toEqual(PI_ENSEMBLE_COORDINATION_TOOL_NAMES)
    expect(selection.toolNames).not.toEqual(
      expect.arrayContaining(['ultra_task', 'delegate_wave', 'delegate_to_subthread'])
    )
  })

  it('deduplicates overlapping tools when composing independent surfaces', () => {
    const selection = resolvePiTaskWraithToolSelection({
      ...base,
      writeCapable: true,
      shellCapable: true,
      meshAllowed: true,
      effectivePermissions: signedUltraTaskPermissions()
    })

    expect(new Set(selection.toolNames).size).toBe(selection.toolNames.length)
    expect(selection.toolNames).toEqual(
      expect.arrayContaining([...PI_ULTRATASK_DELEGATION_TOOL_NAMES])
    )
  })
})

describe('Pi direct/hidden split invariant design pinned', () => {
  it('invariant: no tool added or removed by progressive disclosure design', () => {
    // These lists pin the direct tool surface to today's exact state.
    // They enforce the direct/hidden split: a tiny direct set for lifecycle/edit/shell,
    // with any already-eligible optional tools sitting behind a Pi-local discovery/invoke envelope
    // (with signed receipt + server-side eligibility), preventing the Pi prompt from inflating.
    expect([...PI_EXACT_FILE_TOOL_NAMES]).toEqual(['write_file', 'replace', 'apply_patch'])
    expect([...PI_MANAGED_SHELL_TOOL_NAMES]).toEqual(['run_shell_command', 'request_tool_permission'])
    expect([...PI_ENSEMBLE_COORDINATION_TOOL_NAMES]).toEqual([
      'ensemble_yield',
      'ensemble_send',
      'ensemble_fanout',
      'ensemble_poll_response',
      'scout_brief',
      'blackboard_post',
      'blackboard_read',
      'blackboard_delete',
      'ensemble_fanout_all',
      'ensemble_await',
      'ensemble_lane_result',
      'ensemble_control',
      'ensemble_bossman_control',
      'list_ensemble_participants',
      'ensemble_propose_goal_complete',
      'canvas_sketch_open',
      'canvas_sketch_get',
      'canvas_sketch_update',
      'browser_open',
      'browser_click',
      'browser_screenshot',
      'browser_console'
    ])
    expect([...PI_ULTRATASK_DELEGATION_TOOL_NAMES]).toEqual([
      'ultra_task',
      'delegate_wave',
      'delegate_to_subthread',
      'ensemble_await',
      'list_subthreads',
      'read_subthread_result'
    ])
  })

  it('invariant: Captain/manager tools remain reachable for eligible seats', () => {
    // The previous design tests already enforce that coordinationAllowed: true
    // exposes PI_ENSEMBLE_COORDINATION_TOOL_NAMES, ensuring Captains/managers
    // keep their tools.
    const selection = resolvePiTaskWraithToolSelection({
      ...base,
      ensembleRun: true,
      coordinationAllowed: true,
      effectivePermissions: signedUltraTaskPermissions()
    })
    expect(selection.coordinationExpected).toBe(true)
    expect(selection.toolNames).toEqual(expect.arrayContaining([
      'ensemble_control',
      'ensemble_bossman_control',
      'ensemble_fanout_all'
    ]))
  })
})
