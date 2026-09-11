import { describe, expect, it, vi } from 'vitest'
import type { EnsembleParticipant } from '../../../main/store/types'
import type { EnsembleBriefPreset } from '../lib/ensembleBriefPresets'

// `suggestedPresetName` only consults the roster after every generated name
// ("New brief", "New brief 2" … "New brief 999") is already taken, so the
// roster read is unreachable through a rendered component. Saturating the
// user's preset list is the only way to exercise it.
const SATURATED_PRESETS: EnsembleBriefPreset[] = [
  { id: 'saturate-1', name: 'New brief', brief: '', source: 'user' },
  ...Array.from({ length: 998 }, (_, index) => ({
    id: `saturate-${index + 2}`,
    name: `New brief ${index + 2}`,
    brief: '',
    source: 'user' as const
  }))
]

const listUserEnsembleBriefPresets = vi.fn<() => EnsembleBriefPreset[]>(() => [])

vi.mock('../lib/ensembleBriefPresets', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/ensembleBriefPresets')>()
  return { ...actual, listUserEnsembleBriefPresets: () => listUserEnsembleBriefPresets() }
})

const { suggestedPresetName } = await import('./EnsembleBriefEditor')

function participant(overrides: Partial<EnsembleParticipant> = {}): EnsembleParticipant {
  return {
    id: 'captain',
    provider: 'codex',
    enabled: true,
    role: 'Captain',
    instructions: '',
    order: 1,
    ...overrides
  }
}

describe('suggestedPresetName', () => {
  it('offers the base name when nothing collides', () => {
    listUserEnsembleBriefPresets.mockReturnValue([])

    expect(suggestedPresetName([participant()])).toBe('New brief')
  })

  // `EnsembleParticipant.role` is typed required but reaches the renderer
  // absent, exactly like `instructions`. Main guards every read of it with
  // `|| ''`; this fallback did not, and threw
  // `Cannot read properties of undefined (reading 'trim')`.
  it('skips a participant whose role is absent instead of throwing', () => {
    listUserEnsembleBriefPresets.mockReturnValue(SATURATED_PRESETS)

    expect(suggestedPresetName([participant({ role: undefined as unknown as string })])).toBe(
      'New brief'
    )
  })

  it('still names the first participant that has a role', () => {
    listUserEnsembleBriefPresets.mockReturnValue(SATURATED_PRESETS)

    const name = suggestedPresetName([
      participant({ id: 'ghost', role: undefined as unknown as string }),
      participant({ id: 'blank', role: '   ' }),
      participant({ id: 'captain', role: '  Captain  ' })
    ])

    expect(name).toBe('Captain brief')
  })
})
