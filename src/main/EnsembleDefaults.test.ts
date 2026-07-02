import { describe, expect, it } from 'vitest'
import { createDefaultEnsembleConfig } from './EnsembleDefaults'
import { MAX_ENSEMBLE_PARTICIPANTS } from './EnsemblePrompt'
import type { ProviderId } from './store/types'
import { getDefaultEnsembleParticipantConfig } from '../renderer/src/lib/ensembleProviderDefaults'

// gemini is RETIRED — it is no longer seeded into the default ensemble.
const EXPECTED_PROVIDERS = ['codex', 'claude', 'kimi', 'grok', 'cursor', 'ollama'] as const
const DEFAULT_ORDER = ['claude', 'codex', 'kimi', 'grok', 'cursor', 'ollama'] as const

describe('createDefaultEnsembleConfig parity guard', () => {
  it('seeds exactly the six live providers (gemini retired)', () => {
    const config = createDefaultEnsembleConfig()
    const providers = config.participants.map((participant) => participant.provider)

    expect(new Set(providers)).toEqual(new Set(EXPECTED_PROVIDERS))
    expect(providers).toEqual(DEFAULT_ORDER)
    expect(config.participants).toHaveLength(EXPECTED_PROVIDERS.length)
  })

  it('keeps main participant seeds in sync with renderer provider defaults', () => {
    const config = createDefaultEnsembleConfig()

    for (const participant of config.participants) {
      const rendererDefaults = getDefaultEnsembleParticipantConfig(participant.provider)
      expect(participant.id).toBe(`ensemble-${participant.provider}`)
      expect(participant.enabled).toBe(true)
      expect(participant.model).toBe(rendererDefaults.model)
      expect(participant.permissionPresetId).toBe(rendererDefaults.permissionPresetId)
    }
  })

  it('pins provider roles and instructions exposed by the default config', () => {
    const rolesByProvider = Object.fromEntries(
      createDefaultEnsembleConfig().participants.map((participant) => [
        participant.provider,
        {
          role: participant.role,
          instructions: participant.instructions
        }
      ])
    )

    expect(rolesByProvider).toEqual({
      claude: {
        role: 'Claude',
        instructions:
          'Explore the request, identify constraints, and propose the safest path forward.'
      },
      codex: {
        role: 'Codex',
        instructions: 'Implement concrete code or workflow changes when the round calls for action.'
      },
      kimi: {
        role: 'Kimi',
        instructions: 'Review prior responses for gaps, edge cases, and test coverage.'
      },
      grok: {
        role: 'Grok',
        instructions:
          'Stress-test the proposed approach: surface risky assumptions, failure modes, and simpler alternatives.'
      },
      cursor: {
        role: 'Cursor',
        instructions:
          'Draft the concrete implementation: propose specific edits, file touches, and integration steps.'
      },
      ollama: {
        role: 'Local',
        instructions:
          'Provide a local, privacy-preserving second opinion for summaries, triage, and small read-only reasoning tasks.'
      }
    })
  })

  it('rotates each active provider first without changing the seeded set or renderer parity', () => {
    for (const provider of EXPECTED_PROVIDERS) {
      const config = createDefaultEnsembleConfig(provider)
      expect(config.participants[0]?.provider).toBe(provider)
      expect(new Set(config.participants.map((participant) => participant.provider))).toEqual(
        new Set(EXPECTED_PROVIDERS)
      )

      for (const participant of config.participants) {
        const rendererDefaults = getDefaultEnsembleParticipantConfig(participant.provider)
        expect(participant.order).toBe(config.participants.indexOf(participant) + 1)
        expect(participant.model).toBe(rendererDefaults.model)
        expect(participant.permissionPresetId).toBe(rendererDefaults.permissionPresetId)
      }
    }
  })

  it('keeps exported config constants stable', () => {
    const config = createDefaultEnsembleConfig('codex' satisfies ProviderId)

    expect(config.enabled).toBe(true)
    // Parity guard against the prompt-builder ceiling: EnsembleDefaults
    // hard-codes its own literal, so assert it tracks the canonical
    // exported cap rather than a test-local number that goes stale on
    // the next cap raise (this assertion sat at 18 after the 18 → 20
    // bump for exactly that reason).
    expect(config.maxParticipants).toBe(MAX_ENSEMBLE_PARTICIPANTS)
    expect(config.orchestrationMode).toBe('turn_bound')
    expect(config.maxContinuationHops).toBe(6)
    expect(typeof config.updatedAt).toBe('string')
    expect(Number.isNaN(Date.parse(config.updatedAt ?? ''))).toBe(false)
  })
})

describe('createDefaultEnsembleConfig — configured-provider seeding (E)', () => {
  it('seeds all six live providers when no configured set is supplied (back-compat)', () => {
    const providers = createDefaultEnsembleConfig('claude').participants.map((p) => p.provider)
    expect(new Set(providers)).toEqual(new Set(EXPECTED_PROVIDERS))
  })

  it('seeds only the configured providers when a set is supplied', () => {
    const configured = new Set<ProviderId>(['claude', 'codex'])
    const providers = createDefaultEnsembleConfig('claude', configured).participants.map(
      (p) => p.provider
    )
    expect(new Set(providers)).toEqual(new Set(['claude', 'codex']))
    expect(providers).toHaveLength(2)
  })

  it('always includes the active provider even if absent from the configured set', () => {
    const configured = new Set<ProviderId>(['claude', 'codex'])
    const providers = createDefaultEnsembleConfig('grok', configured).participants.map(
      (p) => p.provider
    )
    expect(new Set(providers)).toEqual(new Set(['claude', 'codex', 'grok']))
  })

  it('falls back to the full roster when fewer than two would remain', () => {
    const configured = new Set<ProviderId>(['claude'])
    const providers = createDefaultEnsembleConfig('claude', configured).participants.map(
      (p) => p.provider
    )
    expect(new Set(providers)).toEqual(new Set(EXPECTED_PROVIDERS))
  })

  it('treats an empty configured set as a fallback to the full roster', () => {
    const providers = createDefaultEnsembleConfig('claude', new Set<ProviderId>()).participants.map(
      (p) => p.provider
    )
    expect(new Set(providers)).toEqual(new Set(EXPECTED_PROVIDERS))
  })
})
