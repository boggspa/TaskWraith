import { describe, expect, it } from 'vitest'
import { PLAN_LABEL, READ_ONLY_RECON_LABEL, resolvePlanModeLabel } from './planModeLabels'

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
