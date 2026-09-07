import { describe, expect, it } from 'vitest'
import {
  applyForcedReadOnlyFanoutWriteDeny,
  isForcedReadOnlyFanoutClampedPosture
} from './ForcedReadOnlyFanoutPosture'
import type { EffectiveRunPermissions } from './store/types'

function readOnlyLanePermissions(
  overrides: Partial<EffectiveRunPermissions['agenticServices']> = {}
): EffectiveRunPermissions {
  return {
    presetId: 'read_only',
    approvalMode: 'plan',
    readOnly: true,
    agenticServices: {
      shellCommands: 'ask',
      fileChanges: 'ask',
      externalPublish: 'ask',
      mcpTools: 'ask',
      subThreadDelegation: 'ask',
      canvasInteraction: 'ask',
      sketchCanvas: 'ask',
      meshCanvas: 'ask',
      simulatorCanvas: 'ask',
      crossThreadRead: 'ask',
      threadMessage: 'ask',
      mediaEditing: 'ask',
      mediaRecording: 'deny',
      canvasEval: 'ask',
      webBrowsing: 'ask',
      ...overrides
    },
    networkAccess: 'allow',
    externalPathGrants: [],
    workspaceGrantServiceIds: []
  }
}

describe('applyForcedReadOnlyFanoutWriteDeny', () => {
  it('denies fileChanges so an unanswerable card becomes an in-band refusal', () => {
    const clamped = applyForcedReadOnlyFanoutWriteDeny(readOnlyLanePermissions())
    expect(clamped.agenticServices.fileChanges).toBe('deny')
  })

  it('leaves shellCommands on ask so a watching human can still authorise it', () => {
    const clamped = applyForcedReadOnlyFanoutWriteDeny(readOnlyLanePermissions())
    expect(clamped.agenticServices.shellCommands).toBe('ask')
  })

  it('narrows nothing else — every other service and posture field is untouched', () => {
    const base = readOnlyLanePermissions()
    const clamped = applyForcedReadOnlyFanoutWriteDeny(base)
    expect(clamped.presetId).toBe('read_only')
    expect(clamped.approvalMode).toBe('plan')
    expect(clamped.readOnly).toBe(true)
    expect(clamped.networkAccess).toBe(base.networkAccess)
    for (const [service, policy] of Object.entries(base.agenticServices)) {
      if (service === 'fileChanges') continue
      expect(clamped.agenticServices[service as keyof typeof base.agenticServices]).toBe(policy)
    }
  })

  it('is runtime-only: the caller-supplied posture object is never mutated', () => {
    const base = readOnlyLanePermissions()
    applyForcedReadOnlyFanoutWriteDeny(base)
    expect(base.agenticServices.fileChanges).toBe('ask')
    expect(isForcedReadOnlyFanoutClampedPosture(base)).toBe(false)
  })

  it('is idempotent', () => {
    const once = applyForcedReadOnlyFanoutWriteDeny(readOnlyLanePermissions())
    const twice = applyForcedReadOnlyFanoutWriteDeny(once)
    expect(twice).toEqual(once)
  })

  it('keeps a stricter global deny that the resolver already applied', () => {
    const clamped = applyForcedReadOnlyFanoutWriteDeny(
      readOnlyLanePermissions({ shellCommands: 'deny' })
    )
    expect(clamped.agenticServices.shellCommands).toBe('deny')
    expect(clamped.agenticServices.fileChanges).toBe('deny')
  })
})

describe('isForcedReadOnlyFanoutClampedPosture', () => {
  it('recognises a posture the clamp produced', () => {
    expect(
      isForcedReadOnlyFanoutClampedPosture(
        applyForcedReadOnlyFanoutWriteDeny(readOnlyLanePermissions())
      )
    ).toBe(true)
  })

  it('does not claim an ordinary posture, including a user-configured fileChanges deny', () => {
    expect(isForcedReadOnlyFanoutClampedPosture(readOnlyLanePermissions())).toBe(false)
    expect(
      isForcedReadOnlyFanoutClampedPosture(readOnlyLanePermissions({ fileChanges: 'deny' }))
    ).toBe(false)
  })

  it('is safe on missing or malformed input', () => {
    expect(isForcedReadOnlyFanoutClampedPosture(undefined)).toBe(false)
    expect(isForcedReadOnlyFanoutClampedPosture(null)).toBe(false)
    expect(
      isForcedReadOnlyFanoutClampedPosture({
        ...readOnlyLanePermissions(),
        forcedReadOnlyFanoutClamp: 'yes'
      } as unknown as EffectiveRunPermissions)
    ).toBe(false)
  })
})
