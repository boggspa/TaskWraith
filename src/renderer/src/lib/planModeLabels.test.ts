import { describe, expect, it } from 'vitest'
import {
  composerPermissionOptions,
  PLAN_LABEL,
  READ_ONLY_RECON_LABEL,
  resolvePlanModeLabel
} from './planModeLabels'

describe('composerPermissionOptions', () => {
  it('offers all four presets in order, including Full Workspace Access', () => {
    expect(composerPermissionOptions().map((o) => o.value)).toEqual([
      'plan',
      'read_only',
      'default',
      'auto_edit'
    ])
  })

  it('includes the user-only Full Workspace Access elevation (regression guard)', () => {
    // It was accidentally dropped from the ensemble picker; both solo + ensemble
    // read this single list, so this guards against it going missing again.
    const full = composerPermissionOptions().find((o) => o.value === 'auto_edit')
    expect(full).toBeDefined()
    expect(full?.label).toBe('Full Workspace Access')
  })
})

describe('resolvePlanModeLabel', () => {
  it('keeps the legacy preset-only label while callers migrate to workflow mode', () => {
    expect(resolvePlanModeLabel('read_only')).toBe(PLAN_LABEL)
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
