import { beforeEach, describe, expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => {
  const store = new Map<string, string>()
  const localStorage = {
    getItem: (key: string) => (store.has(key) ? (store.get(key) as string) : null),
    setItem: (key: string, value: string) => {
      store.set(key, value)
    },
    removeItem: (key: string) => {
      store.delete(key)
    },
    clear: () => {
      store.clear()
    }
  }
  ;(globalThis as unknown as { window: unknown }).window = {
    localStorage,
    addEventListener: () => {},
    removeEventListener: () => {}
  }
  return { store }
})

import {
  BUILT_IN_ENSEMBLE_BRIEF_PRESETS,
  listEnsembleBriefPresets,
  listUserEnsembleBriefPresets,
  renameUserEnsembleBriefPreset,
  saveUserEnsembleBriefPreset
} from './ensembleBriefPresets'
import { ENSEMBLE_ROLE_PRESETS } from './ensembleRolePresets'

beforeEach(() => {
  fake.store.clear()
})

describe('ensembleBriefPresets', () => {
  it('exposes a built-in brief for each role preset', () => {
    expect(BUILT_IN_ENSEMBLE_BRIEF_PRESETS).toHaveLength(ENSEMBLE_ROLE_PRESETS.length)
    expect(listEnsembleBriefPresets().map((preset) => preset.name)).toContain('Reviewer')
    expect(listEnsembleBriefPresets()).toContainEqual(
      expect.objectContaining({
        id: 'role:designer',
        name: 'Designer',
        rolePresetId: 'designer',
        source: 'role',
        brief: expect.stringContaining('Protect UI/UX quality')
      })
    )
    expect(
      listEnsembleBriefPresets().every((preset) => preset.source === 'role')
    ).toBe(true)
  })

  it('saves and recalls user-defined briefs after built-ins', () => {
    const saved = saveUserEnsembleBriefPreset('Review polish', 'Check edge cases and tests.')
    const userPresets = listUserEnsembleBriefPresets()
    expect(userPresets).toHaveLength(1)
    expect(userPresets[0]).toMatchObject({
      id: saved.id,
      name: 'Review polish',
      brief: 'Check edge cases and tests.',
      source: 'user'
    })
    expect(listEnsembleBriefPresets().at(-1)).toMatchObject({ id: saved.id })
  })

  it('renames user-defined briefs without mutating the brief text', () => {
    const saved = saveUserEnsembleBriefPreset('Old name', 'Keep the text.')
    const renamed = renameUserEnsembleBriefPreset(saved.id, 'New name')
    expect(renamed).toMatchObject({
      id: saved.id,
      name: 'New name',
      brief: 'Keep the text.',
      source: 'user'
    })
    expect(listUserEnsembleBriefPresets()[0].name).toBe('New name')
  })
})
