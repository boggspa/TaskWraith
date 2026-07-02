import { describe, expect, it } from 'vitest'
import { isReconRunPosture } from './ReconPosture'

const readOnlySlice = { presetId: 'read_only', readOnly: true } as const

describe('isReconRunPosture', () => {
  it('recognizes a solo Read-Only/Recon run (plan approvalMode, normal workflow, read_only preset)', () => {
    expect(
      isReconRunPosture({
        approvalMode: 'plan',
        workflowMode: 'normal',
        effectivePermissions: readOnlySlice
      })
    ).toBe(true)
  })

  it('keeps Plan-workflow runs plan-shaped even though the preset is byte-identical read_only', () => {
    // Solo "Plan" picker and solo "Read-Only/Recon" picker both stamp
    // presetId 'read_only'; workflowMode is the only differentiator.
    expect(
      isReconRunPosture({
        approvalMode: 'plan',
        workflowMode: 'plan',
        effectivePermissions: readOnlySlice
      })
    ).toBe(false)
  })

  it('excludes ensemble plan seats (presetId plan) in a normal-workflow chat', () => {
    expect(
      isReconRunPosture({
        approvalMode: 'plan',
        workflowMode: 'normal',
        effectivePermissions: { presetId: 'plan', readOnly: true }
      })
    ).toBe(false)
  })

  it('treats clamp-downgraded postures as recon (forced plan + re-derived read_only + normal workflow)', () => {
    // clampUntrustedRunPosture forceReadOnly → approvalMode 'plan',
    // presetId 'read_only'; normalizeAgentRunPayload forces workflowMode
    // 'normal' on downgrade. Containment comes from the service denies,
    // not the provider plan persona, so recon shape is the correct
    // degraded behavior.
    expect(
      isReconRunPosture({
        approvalMode: 'plan',
        workflowMode: 'normal',
        effectivePermissions: readOnlySlice
      })
    ).toBe(true)
  })

  it('never fires for non-plan approval modes', () => {
    for (const approvalMode of ['default', 'auto_edit', undefined, null, '']) {
      expect(
        isReconRunPosture({
          approvalMode,
          workflowMode: 'normal',
          effectivePermissions: readOnlySlice
        })
      ).toBe(false)
    }
  })

  it('fails closed (keeps plan mode) when workflowMode is missing or unrecognized', () => {
    for (const workflowMode of [undefined, null, '', 'weird']) {
      expect(
        isReconRunPosture({
          approvalMode: 'plan',
          workflowMode,
          effectivePermissions: readOnlySlice
        })
      ).toBe(false)
    }
  })

  it('fails closed when effectivePermissions are absent or not read-only', () => {
    expect(
      isReconRunPosture({ approvalMode: 'plan', workflowMode: 'normal' })
    ).toBe(false)
    expect(
      isReconRunPosture({
        approvalMode: 'plan',
        workflowMode: 'normal',
        effectivePermissions: null
      })
    ).toBe(false)
    expect(
      isReconRunPosture({
        approvalMode: 'plan',
        workflowMode: 'normal',
        effectivePermissions: { presetId: 'read_only', readOnly: false }
      })
    ).toBe(false)
  })
})
