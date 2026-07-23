import { describe, expect, it } from 'vitest'
import {
  getCachedRemoteEnsemblePresets,
  mapRawPresetsToRemote,
  setRemoteEnsemblePresetsFromRaw
} from './EnsembleRosterPresetsCache'

describe('EnsembleRosterPresetsCache.mapRawPresetsToRemote', () => {
  it('maps a renderer preset (snapshot shape) to the iOS projection shape', () => {
    const out = mapRawPresetsToRemote([
      {
        id: 'preset-1',
        name: 'Review panel',
        createdAt: 1,
        updatedAt: 2,
        orchestrationMode: 'turn_bound',
        maxParticipants: 6,
        participants: [
          {
            provider: 'codex',
            enabled: true,
            role: 'Builder',
            instructions: 'Build it.',
            order: 1,
            model: 'gpt-5.5',
            permissionPresetId: 'workspace_write',
            reasoningEffort: 'high',
            fastModeEnabled: true,
            isBossman: true
          },
          {
            provider: 'claude',
            enabled: false,
            role: '',
            instructions: '',
            order: 2
          }
        ]
      }
    ])
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      id: 'preset-1',
      name: 'Review panel',
      orchestrationMode: 'turn_bound',
      maxParticipants: 6,
      updatedAt: 2
    })
    expect(out[0].participants[0]).toMatchObject({
      id: 'preset-1-p1',
      provider: 'codex',
      role: 'Builder',
      enabled: true,
      order: 1,
      model: 'gpt-5.5',
      brief: 'Build it.',
      permissionPresetId: 'workspace_write',
      reasoningEffort: 'high',
      fastModeEnabled: true,
      isBossman: true
    })
    // role falls back to provider; disabled preserved; instructions→brief omitted when empty
    expect(out[0].participants[1]).toMatchObject({
      id: 'preset-1-p2',
      provider: 'claude',
      role: 'claude',
      enabled: false,
      order: 2
    })
    expect(out[0].participants[1].brief).toBeUndefined()
  })

  it('clips long briefs and survives malformed input', () => {
    const long = 'x'.repeat(900)
    const out = mapRawPresetsToRemote([
      { id: 'p', name: 'P', participants: [{ provider: 'codex', instructions: long }] },
      null,
      { name: 'no id' }, // dropped (no id)
      { id: 'no-name' }, // dropped (no name)
      'garbage'
    ])
    expect(out).toHaveLength(1)
    expect(out[0].participants[0].brief?.length).toBe(500)
  })

  it('retains disconnected AntiGravity selections but drops retired and garbage ids', () => {
    const out = mapRawPresetsToRemote([
      {
        id: 'p',
        name: 'Legacy',
        participants: [
          { provider: 'codex', role: 'Builder' },
          { provider: 'antigravity', role: 'Configured later' },
          { provider: 'gemini', role: 'Old' },
          { provider: 'gemni', role: 'Typo' },
          { provider: 'claude', role: 'Reviewer' }
        ]
      }
    ])
    expect(out[0].participants.map((entry) => entry.provider)).toEqual([
      'codex',
      'antigravity',
      'claude'
    ])
  })

  it('returns [] for non-array input', () => {
    expect(mapRawPresetsToRemote(undefined)).toEqual([])
    expect(mapRawPresetsToRemote({})).toEqual([])
  })

  it('setRemoteEnsemblePresetsFromRaw updates the cache getter', () => {
    setRemoteEnsemblePresetsFromRaw([{ id: 'a', name: 'A', participants: [] }])
    expect(getCachedRemoteEnsemblePresets().map((p) => p.id)).toEqual(['a'])
    setRemoteEnsemblePresetsFromRaw('nope')
    expect(getCachedRemoteEnsemblePresets()).toEqual([])
  })
})
