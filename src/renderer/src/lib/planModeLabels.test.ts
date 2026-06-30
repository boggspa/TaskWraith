import { describe, expect, it } from 'vitest'
import { PLAN_LABEL, READ_ONLY_RECON_LABEL, resolvePlanModeLabel } from './planModeLabels'

describe('resolvePlanModeLabel', () => {
  it('labels the current read-only preset as Plan while plan workflow shares that wire', () => {
    expect(resolvePlanModeLabel('read_only')).toBe(PLAN_LABEL)
  })

  it('uses the recon label for non-plan presets', () => {
    expect(resolvePlanModeLabel('default')).toBe(READ_ONLY_RECON_LABEL)
    expect(resolvePlanModeLabel('workspace_write')).toBe(READ_ONLY_RECON_LABEL)
    expect(resolvePlanModeLabel(null)).toBe(READ_ONLY_RECON_LABEL)
  })
})
