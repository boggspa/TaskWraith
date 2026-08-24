import { describe, expect, it } from 'vitest'
import type { EffectiveRunPermissions } from '../store/types'
import {
  PI_ENSEMBLE_COORDINATION_TOOL_NAMES,
  PI_ULTRATASK_DELEGATION_TOOL_NAMES
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
