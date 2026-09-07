import { describe, expect, it } from 'vitest'
import { resolveEnsembleListedTools } from './EnsembleListedTools'

describe('resolveEnsembleListedTools', () => {
  it('returns an explicit listed set unchanged', () => {
    expect(
      resolveEnsembleListedTools({
        listedTools: ['delegate_wave'],
        provider: 'cursor',
        profileId: 'taskwraith-gateway-solo-v1',
        permissionPresetId: 'read_only',
        reasoningEffort: 'ultraTask'
      })
    ).toEqual(['delegate_wave'])
  })

  it('omits the filter when no caller list and no pinned profile exist', () => {
    expect(
      resolveEnsembleListedTools({
        provider: 'codex',
        permissionPresetId: 'workspace_write',
        reasoningEffort: 'ultraTask'
      })
    ).toBeUndefined()
  })

  it('drops ensemble_fanout for a Cursor gateway-solo UltraTask seat', () => {
    const listed = resolveEnsembleListedTools({
      provider: 'cursor',
      profileId: 'taskwraith-gateway-solo-v1',
      permissionPresetId: 'read_only',
      reasoningEffort: 'ultraTask'
    })
    expect(listed).toContain('delegate_wave')
    expect(listed).toContain('delegate_to_subthread')
    expect(listed).not.toContain('ensemble_fanout')
  })

  it('keeps ensemble_fanout for a write-capable Cursor full-v1 seat', () => {
    const listed = resolveEnsembleListedTools({
      provider: 'cursor',
      profileId: 'taskwraith-full-v1',
      permissionPresetId: 'workspace_write',
      reasoningEffort: 'ultraTask'
    })
    expect(listed).toContain('ensemble_fanout')
    expect(listed).toContain('delegate_to_subthread')
    expect(listed).not.toContain('delegate_wave')
  })

  it.each(['default', 'custom'] as const)(
    'treats Cursor %s as write-capable like runCursorProvider',
    (permissionPresetId) => {
      const listed = resolveEnsembleListedTools({
        provider: 'cursor',
        profileId: 'taskwraith-full-v1',
        permissionPresetId,
        reasoningEffort: 'ultraTask'
      })
      expect(listed).toContain('ensemble_fanout')
      expect(listed).toContain('delegate_to_subthread')
    }
  )

  it('filters non-Cursor UltraTask names to the pinned profile advertise set', () => {
    const listed = resolveEnsembleListedTools({
      provider: 'codex',
      profileId: 'taskwraith-gateway-solo-v1',
      permissionPresetId: 'workspace_write',
      reasoningEffort: 'ultraTask'
    })
    expect(listed).toContain('delegate_wave')
    expect(listed).toContain('delegate_to_subthread')
    expect(listed).not.toContain('ensemble_fanout')
  })
})
