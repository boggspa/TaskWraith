import { describe, expect, it } from 'vitest'
import {
  ULTRATASK_DELEGATION_TOOL_NAMES,
  hasUltraTaskDelegationAutoAllow,
  isExplicitUltraTaskSelection,
  isUltraTaskDelegationAutoAllowRequest,
  stripUltraTaskDelegationAutoAllow,
  withUltraTaskDelegationAutoAllow
} from './UltraTaskDelegationConsent'
import type { EffectiveRunPermissions } from './store/types'

function permissions(): EffectiveRunPermissions {
  return {
    presetId: 'read_only',
    approvalMode: 'plan',
    agenticServices: {
      shellCommands: 'ask',
      fileChanges: 'ask',
      externalPublish: 'ask',
      mcpTools: 'ask',
      subThreadDelegation: 'deny',
      canvasInteraction: 'ask',
      sketchCanvas: 'ask',
      meshCanvas: 'ask',
      simulatorCanvas: 'ask',
      crossThreadRead: 'ask',
      threadMessage: 'ask',
      mediaEditing: 'ask',
      mediaRecording: 'deny',
      canvasEval: 'deny',
      webBrowsing: 'ask'
    },
    networkAccess: 'deny',
    externalPathGrants: [],
    workspaceGrantServiceIds: [],
    readOnly: true
  }
}

describe('UltraTask delegation consent', () => {
  it('exports one immutable exact-route tuple for provider adapters', () => {
    expect(ULTRATASK_DELEGATION_TOOL_NAMES).toEqual([
      'delegate_wave',
      'ultra_task',
      'delegate_to_subthread'
    ])
    expect(Object.isFrozen(ULTRATASK_DELEGATION_TOOL_NAMES)).toBe(true)
  })

  it.each(['ultraTask', 'ultratask', ' ULTRATASK '])(
    'recognizes the exact synthetic selection %j',
    (reasoningEffort) => {
      expect(isExplicitUltraTaskSelection({ provider: 'codex', reasoningEffort })).toBe(true)
    }
  )

  it.each(['ultra', 'ultracode', 'max', 'xhigh', '', undefined])(
    'does not convert the ordinary reasoning tier %j into delegation consent',
    (reasoningEffort) => {
      expect(isExplicitUltraTaskSelection({ provider: 'codex', reasoningEffort })).toBe(false)
    }
  )

  it('accepts the AntiGravity presentation marker only for AntiGravity', () => {
    expect(
      isExplicitUltraTaskSelection({
        provider: 'antigravity',
        reasoningEffort: 'high',
        antigravityUltraTaskSelected: true
      })
    ).toBe(true)
    expect(
      isExplicitUltraTaskSelection({
        provider: 'codex',
        reasoningEffort: 'high',
        antigravityUltraTaskSelected: true
      })
    ).toBe(false)
  })

  it('stamps exact consent and clears a stale source when the selection changes', () => {
    const stamped = withUltraTaskDelegationAutoAllow(permissions(), {
      provider: 'claude',
      reasoningEffort: 'ultraTask'
    })
    expect(hasUltraTaskDelegationAutoAllow(stamped)).toBe(true)

    const cleared = withUltraTaskDelegationAutoAllow(stamped, {
      provider: 'claude',
      reasoningEffort: 'ultracode'
    })
    expect(hasUltraTaskDelegationAutoAllow(cleared)).toBe(false)
  })

  it.each(['delegate_wave', 'ultra_task', 'delegate_to_subthread'])(
    'auto-allows only the exact %s delegation route',
    (toolName) => {
      const effectivePermissions = withUltraTaskDelegationAutoAllow(permissions(), {
        provider: 'kimi',
        reasoningEffort: 'ultraTask'
      })
      expect(
        isUltraTaskDelegationAutoAllowRequest({
          service: 'subThreadDelegation',
          toolName,
          effectivePermissions
        })
      ).toBe(true)
    }
  )

  it('does not infer consent from a worker effort, prompt text, wrong tool, or wrong service', () => {
    const unstamped = permissions()
    const modelControlledEvidence = {
      service: 'subThreadDelegation' as const,
      toolName: 'delegate_wave',
      effectivePermissions: unstamped,
      workers: [{ reasoningEffort: 'ultraTask' }],
      prompt: 'ULTRA-TASK MODE ACTIVE'
    }
    expect(isUltraTaskDelegationAutoAllowRequest(modelControlledEvidence)).toBe(false)

    const stamped = withUltraTaskDelegationAutoAllow(unstamped, {
      provider: 'mistral',
      reasoningEffort: 'ultraTask'
    })
    expect(
      isUltraTaskDelegationAutoAllowRequest({
        service: 'subThreadDelegation',
        toolName: 'cancel_subthread',
        effectivePermissions: stamped
      })
    ).toBe(false)
    expect(
      isUltraTaskDelegationAutoAllowRequest({
        service: 'mcpTools',
        toolName: 'delegate_wave',
        effectivePermissions: stamped
      })
    ).toBe(false)
  })

  it('strips the run-scoped source without mutating the input', () => {
    const stamped = withUltraTaskDelegationAutoAllow(permissions(), {
      provider: 'pi',
      reasoningEffort: 'ultraTask'
    })
    const stripped = stripUltraTaskDelegationAutoAllow(stamped)
    expect(stripped).not.toBe(stamped)
    expect(hasUltraTaskDelegationAutoAllow(stripped)).toBe(false)
    expect(hasUltraTaskDelegationAutoAllow(stamped)).toBe(true)
  })
})
