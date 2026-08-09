import { describe, expect, it } from 'vitest'
import type { AgenticServicesSettings } from '../../../main/store/types'
import {
  SUGGESTED_POLICY_POSTURE,
  applyPolicyPostureOverride,
  buildPolicyPostureRows,
  summarizePolicyPosture
} from './policyPosture'

const suggestedSettings: AgenticServicesSettings = {
  ...SUGGESTED_POLICY_POSTURE,
  canvasEval: 'ask',
  mediaRecording: 'deny'
}

describe('policyPosture', () => {
  it('projects the ten user-facing policies and their suggested defaults', () => {
    const rows = buildPolicyPostureRows(suggestedSettings)

    expect(rows.map((row) => row.policyKey)).toEqual([
      'shellCommands',
      'fileChanges',
      'externalPublish',
      'mcpTools',
      'subThreadDelegation',
      'canvasInteraction',
      'webBrowsing',
      'sketchCanvas',
      'mediaEditing',
      'networkAccess'
    ])
    expect(summarizePolicyPosture(rows)).toEqual({
      riskyPolicyCount: 2,
      watchPolicyCount: 1,
      overrideCount: 0
    })
  })

  it('marks permissive saved values as overrides without losing unrelated policy fields', () => {
    const overridden = applyPolicyPostureOverride(suggestedSettings, 'fileChanges', 'allow')
    const offline = applyPolicyPostureOverride(overridden, 'networkAccess', 'deny')
    const summary = summarizePolicyPosture(buildPolicyPostureRows(offline))

    expect(offline.fileChanges).toBe('allow')
    expect(offline.networkAccess).toBe('deny')
    expect(offline.canvasEval).toBe('ask')
    expect(offline.mediaRecording).toBe('deny')
    expect(summary.overrideCount).toBe(2)
  })

  it('fills optional settings from the suggested posture for older settings snapshots', () => {
    const legacy = { ...suggestedSettings }
    delete legacy.webBrowsing
    delete legacy.mediaEditing

    const rows = buildPolicyPostureRows(legacy)

    expect(rows.find((row) => row.policyKey === 'webBrowsing')?.value).toBe('ask')
    expect(rows.find((row) => row.policyKey === 'mediaEditing')?.value).toBe('ask')
  })
})
