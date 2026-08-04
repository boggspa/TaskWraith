import { describe, expect, it } from 'vitest'
import {
  composerPermissionOptions,
  PLAN_LABEL,
  READ_ONLY_RECON_LABEL,
  resolvePlanModeLabel
} from './planModeLabels'

describe('composerPermissionOptions', () => {
  it('offers all five presets in order, including separate write and Full Access', () => {
    expect(composerPermissionOptions().map((o) => o.value)).toEqual([
      'plan',
      'read_only',
      'default',
      'workspace_write',
      'full_access'
    ])
  })

  it('keeps Full WS Access and Full Access as separate selectable presets', () => {
    // It was accidentally dropped from the ensemble picker; both solo + ensemble
    // read this single list, so this guards against it going missing again.
    const workspaceWrite = composerPermissionOptions().find((o) => o.value === 'workspace_write')
    const full = composerPermissionOptions().find((o) => o.value === 'full_access')
    expect(workspaceWrite?.label).toBe('Full WS Access')
    expect(full?.label).toBe('Full Access')
  })
})

describe('resolvePlanModeLabel', () => {
  it('keeps plan distinct from bare read-only posture', () => {
    expect(resolvePlanModeLabel('read_only')).toBe(READ_ONLY_RECON_LABEL)
    expect(resolvePlanModeLabel('plan')).toBe(PLAN_LABEL)
  })

  it('uses explicit workflow mode before the permission preset', () => {
    expect(
      resolvePlanModeLabel({ workflowMode: 'normal', permissionPresetId: 'read_only' })
    ).toBe(READ_ONLY_RECON_LABEL)
    expect(
      resolvePlanModeLabel({ workflowMode: 'plan', permissionPresetId: 'workspace_write' })
    ).toBe(PLAN_LABEL)
  })

  it('falls back to the recon label for non-plan presets', () => {
    expect(resolvePlanModeLabel('default')).toBe(READ_ONLY_RECON_LABEL)
    expect(resolvePlanModeLabel('workspace_write')).toBe(READ_ONLY_RECON_LABEL)
    expect(resolvePlanModeLabel(null)).toBe(READ_ONLY_RECON_LABEL)
  })
})
