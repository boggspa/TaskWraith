import { describe, it, expect, vi } from 'vitest'
import {
  applyVerifiedFailoverReroutePosture,
  reroutePresetId,
  isNonEscalatingPreset,
  presetAuthorityRank,
  selectFailoverTarget
} from './RerouteFailoverPosture'
import { resolveEffectiveRunPermissions } from './EffectiveRunPermissions'
import type { AgentRunPayload } from './run/AgentRunTypes'
import type { AppSettings } from './store/types'

const permissionSettings: Pick<AppSettings, 'agenticServices' | 'agenticWorkspaceGrants'> = {
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
    networkAccess: 'allow'
  },
  agenticWorkspaceGrants: []
}

function runPayload(overrides: Partial<AgentRunPayload> = {}): AgentRunPayload {
  return {
    provider: 'claude',
    scope: 'workspace',
    workspace: '/repo',
    prompt: 'continue after failover',
    appRunId: 'run-1',
    appChatId: 'chat-1',
    approvalMode: 'default',
    workflowMode: 'normal',
    ...overrides
  }
}

describe('reroutePresetId — preserve, never escalate', () => {
  it('plan → read_only on any non-ollama target', () => {
    expect(reroutePresetId('plan', 'read_only', 'codex')).toBe('read_only')
  })

  it('auto_edit keeps full_access only if the original had it', () => {
    expect(reroutePresetId('auto_edit', 'full_access', 'codex')).toBe('full_access')
    expect(reroutePresetId('auto_edit', 'workspace_write', 'codex')).toBe('workspace_write')
    // original lacked a write preset → never inflate to full_access
    expect(reroutePresetId('auto_edit', undefined, 'codex')).toBe('workspace_write')
  })

  it('default mode preserves a known signed Accept Edits-or-higher origin', () => {
    expect(reroutePresetId('default', 'default', 'codex')).toBe('default')
    expect(reroutePresetId('default', 'workspace_write', 'codex')).toBe('default')
    expect(reroutePresetId('default', 'full_access', 'codex')).toBe('default')
  })

  it('does not manufacture a default posture from an absent/custom origin', () => {
    expect(reroutePresetId('default', undefined, 'codex')).toBeUndefined()
    expect(reroutePresetId('default', 'custom', 'codex')).toBeUndefined()
    expect(reroutePresetId(undefined, 'full_access', 'codex')).toBeUndefined()
  })

  it('ollama target is always read_only regardless of mode/original', () => {
    expect(reroutePresetId('auto_edit', 'full_access', 'ollama')).toBe('read_only')
    expect(reroutePresetId('default', 'workspace_write', 'ollama')).toBe('read_only')
  })
})

describe('isNonEscalatingPreset', () => {
  it('undefined target is always safe', () => {
    expect(isNonEscalatingPreset(undefined, 'read_only')).toBe(true)
  })
  it('equal or lower authority passes', () => {
    expect(isNonEscalatingPreset('workspace_write', 'full_access')).toBe(true)
    expect(isNonEscalatingPreset('workspace_write', 'workspace_write')).toBe(true)
    expect(isNonEscalatingPreset('read_only', 'workspace_write')).toBe(true)
  })
  it('higher authority is rejected (the escalation guard)', () => {
    expect(isNonEscalatingPreset('full_access', 'workspace_write')).toBe(false)
    expect(isNonEscalatingPreset('workspace_write', undefined)).toBe(false) // undefined original → default rank 1
    expect(isNonEscalatingPreset('workspace_write', 'default')).toBe(false)
  })
  it('rank ordering', () => {
    expect(presetAuthorityRank('read_only')).toBeLessThan(presetAuthorityRank('default'))
    expect(presetAuthorityRank('default')).toBeLessThan(presetAuthorityRank('workspace_write'))
    expect(presetAuthorityRank('workspace_write')).toBeLessThan(presetAuthorityRank('full_access'))
    expect(presetAuthorityRank(undefined)).toBe(presetAuthorityRank('default'))
  })
  it('Plan stays below Ask because Ask exposes additional specialist approvals', () => {
    expect(presetAuthorityRank('plan')).toBeLessThan(presetAuthorityRank('read_only'))
    expect(presetAuthorityRank('read_only')).toBeLessThan(presetAuthorityRank('default'))
    // Plan → Ask is an escalation; Ask → Plan is a de-escalation.
    expect(isNonEscalatingPreset('read_only', 'plan')).toBe(false)
    expect(isNonEscalatingPreset('plan', 'read_only')).toBe(true)
  })
})

describe('reroutePresetId + isNonEscalatingPreset compose to fail safe', () => {
  it('an auto_edit run with no original preset derives workspace_write but the guard bails it', () => {
    const target = reroutePresetId('auto_edit', undefined, 'codex')
    expect(target).toBe('workspace_write')
    // guard catches it because original authority is unknown/default
    expect(isNonEscalatingPreset(target, undefined)).toBe(false)
  })
})

describe('applyVerifiedFailoverReroutePosture', () => {
  it('refuses to mint a target posture from an unverified renderer claim', () => {
    const original = runPayload({
      effectivePermissions: resolveEffectiveRunPermissions({
        provider: 'claude',
        workspacePath: '/repo',
        settings: permissionSettings,
        presetId: 'full_access'
      }),
      effectivePermissionsSignature: 'forged-source-signature',
      failoverHopCount: 1
    })
    const routed = runPayload({
      provider: 'codex',
      effectivePermissions: original.effectivePermissions,
      effectivePermissionsSignature: 'must-be-cleared'
    })
    const signPosture = vi.fn(() => 'must-not-sign')

    expect(
      applyVerifiedFailoverReroutePosture(routed, original, {
        settings: permissionSettings,
        verifyPosture: vi.fn(() => false),
        signPosture
      })
    ).toBe(false)
    expect(routed.effectivePermissions).toBeUndefined()
    expect(routed.effectivePermissionsSignature).toBeUndefined()
    expect(signPosture).not.toHaveBeenCalled()
  })

  it('re-derives a verified Accept Edits origin for the target model and current denies', () => {
    const original = runPayload({
      effectivePermissions: resolveEffectiveRunPermissions({
        provider: 'claude',
        workspacePath: '/repo',
        settings: permissionSettings,
        presetId: 'default'
      }),
      effectivePermissionsSignature: 'verified-source-signature',
      failoverHopCount: 1
    })
    const routed = runPayload({
      provider: 'codex',
      model: 'preview:openai:gpt-5.6:sol',
      effectivePermissions: undefined,
      effectivePermissionsSignature: undefined
    })
    const targetSettings = {
      ...permissionSettings,
      agenticServices: { ...permissionSettings.agenticServices, shellCommands: 'deny' as const }
    }
    const verifyPosture = vi.fn(() => true)
    const signPosture = vi.fn(() => 'target-signature')

    expect(
      applyVerifiedFailoverReroutePosture(routed, original, {
        settings: targetSettings,
        verifyPosture,
        signPosture
      })
    ).toBe(true)
    expect(verifyPosture).toHaveBeenCalledWith(
      'default',
      original.effectivePermissions,
      'verified-source-signature',
      expect.objectContaining({ provider: 'claude', appRunId: 'run-1' })
    )
    expect(routed.effectivePermissions).toMatchObject({
      presetId: 'default',
      networkAccess: 'deny',
      agenticServices: {
        shellCommands: 'deny',
        fileChanges: 'ask'
      }
    })
    expect(routed.effectivePermissionsSignature).toBe('target-signature')
    expect(signPosture).toHaveBeenCalledWith(
      'default',
      routed.effectivePermissions,
      expect.objectContaining({ provider: 'codex', appRunId: 'run-1' })
    )
  })
})

describe('selectFailoverTarget', () => {
  const live: Array<'claude' | 'codex' | 'kimi' | 'grok' | 'cursor' | 'ollama'> = [
    'claude',
    'codex',
    'kimi',
    'grok',
    'cursor',
    'ollama'
  ]

  it('prefers the configured reroute target when live and un-paused', () => {
    expect(
      selectFailoverTarget({ failedProvider: 'claude', liveProviders: live, isPaused: () => false, preferred: 'kimi' })
    ).toBe('kimi')
  })

  it('skips the preferred target if it is paused, falls through to first eligible', () => {
    expect(
      selectFailoverTarget({
        failedProvider: 'claude',
        liveProviders: live,
        isPaused: (p) => p === 'kimi',
        preferred: 'kimi'
      })
    ).toBe('codex')
  })

  it('never selects the failed provider', () => {
    const t = selectFailoverTarget({ failedProvider: 'claude', liveProviders: live, isPaused: () => false })
    expect(t).not.toBe('claude')
    expect(t).toBe('codex')
  })

  it('returns null when every other provider is paused (all walled)', () => {
    expect(
      selectFailoverTarget({
        failedProvider: 'claude',
        liveProviders: live,
        isPaused: (p) => p !== 'claude'
      })
    ).toBeNull()
  })

  it('honors an explicit order', () => {
    expect(
      selectFailoverTarget({
        failedProvider: 'claude',
        liveProviders: live,
        isPaused: () => false,
        order: ['grok', 'codex']
      })
    ).toBe('grok')
  })

  it('never selects a retired provider even if listed first or preferred', () => {
    // availableProviderIds() includes retired gemini; the target picker must skip it.
    expect(
      selectFailoverTarget({
        failedProvider: 'claude',
        liveProviders: ['gemini', 'codex', 'kimi'],
        isPaused: () => false
      })
    ).toBe('codex')
    expect(
      selectFailoverTarget({
        failedProvider: 'claude',
        liveProviders: ['gemini', 'codex'],
        isPaused: () => false,
        preferred: 'gemini'
      })
    ).toBe('codex')
  })

  it('accepts AntiGravity only as an explicitly preferred, dynamically admitted target', () => {
    expect(
      selectFailoverTarget({
        failedProvider: 'claude',
        liveProviders: ['codex', 'antigravity'],
        isPaused: () => false,
        preferred: 'antigravity'
      })
    ).toBe('antigravity')

    expect(
      selectFailoverTarget({
        failedProvider: 'claude',
        liveProviders: ['codex'],
        isPaused: () => false,
        preferred: 'antigravity'
      })
    ).toBe('codex')
  })

  it('does not silently choose AntiGravity from the automatic fallback order', () => {
    expect(
      selectFailoverTarget({
        failedProvider: 'claude',
        liveProviders: ['antigravity', 'codex'],
        isPaused: () => false
      })
    ).toBe('codex')
    expect(
      selectFailoverTarget({
        failedProvider: 'claude',
        liveProviders: ['antigravity'],
        isPaused: () => false
      })
    ).toBeNull()
  })
})
