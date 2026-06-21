import { describe, it, expect } from 'vitest'
import {
  reroutePresetId,
  isNonEscalatingPreset,
  presetAuthorityRank,
  selectFailoverTarget
} from './RerouteFailoverPosture'

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

  it('default / undefined mode → no effectivePermissions object', () => {
    expect(reroutePresetId('default', 'workspace_write', 'codex')).toBeUndefined()
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
})

describe('reroutePresetId + isNonEscalatingPreset compose to fail safe', () => {
  it('an auto_edit run with no original preset derives workspace_write but the guard bails it', () => {
    const target = reroutePresetId('auto_edit', undefined, 'codex')
    expect(target).toBe('workspace_write')
    // guard catches it because original authority is unknown/default
    expect(isNonEscalatingPreset(target, undefined)).toBe(false)
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
})
