import { describe, expect, it } from 'vitest'
import {
  MIN_LIVE_ENSEMBLE_PARTICIPANTS,
  createDefaultEnsembleConfig,
  withMinimumEnsembleRoster
} from './EnsembleDefaults'
import { MAX_ENSEMBLE_PARTICIPANTS } from './EnsemblePrompt'
import type { EnsembleParticipant, ProviderId } from './store/types'
import { getDefaultEnsembleParticipantConfig } from '../renderer/src/lib/ensembleProviderDefaults'

// Gemini is retired. Fresh panels choose a small role-shaped subset of these
// live providers; users can still add any configured provider afterwards.
const LIVE_PROVIDERS = ['codex', 'claude', 'kimi', 'grok', 'ollama'] as const
const DEFAULT_PANEL = ['claude', 'codex', 'kimi', 'ollama'] as const

describe('createDefaultEnsembleConfig parity guard', () => {
  it('seeds a four-seat panel with a local outsider by default', () => {
    const config = createDefaultEnsembleConfig()
    const providers = config.participants.map((participant) => participant.provider)

    expect(providers).toEqual(DEFAULT_PANEL)
    expect(config.participants).toHaveLength(4)
  })

  it('keeps main participant MODEL seeds in sync with renderer provider defaults', () => {
    const config = createDefaultEnsembleConfig()

    for (const participant of config.participants) {
      const rendererDefaults = getDefaultEnsembleParticipantConfig(participant.provider)
      expect(participant.id).toBe(`ensemble-${participant.provider}`)
      expect(participant.enabled).toBe(true)
      expect(participant.model).toBe(rendererDefaults.model)
    }
  })

  it('pins small-panel roles, authority and curated permission presets', () => {
    // permissionPresetId is pinned EXPLICITLY here, not against
    // getDefaultEnsembleParticipantConfig: the seeded panel keeps a curated
    // writer/reader split (codex lone writer, read-only recon seats) while
    // chip-strip adds seed uniformly with 'default' (Default Approval).
    const config = createDefaultEnsembleConfig()
    const rolesByProvider = Object.fromEntries(
      config.participants.map((participant) => [
        participant.provider,
        {
          role: participant.role,
          instructions: participant.instructions,
          permissionPresetId: participant.permissionPresetId
        }
      ])
    )

    expect(rolesByProvider).toEqual({
      claude: {
        role: 'Boss',
        instructions:
          'Own the outcome, keep the panel scoped, and synthesize a clear decision from the other seats. Explore the request, identify constraints, and propose the safest path forward.',
        permissionPresetId: 'read_only'
      },
      codex: {
        role: 'Captain',
        instructions:
          'Act as second-in-command: challenge the plan, track unresolved risks, and keep the work moving. Implement concrete code or workflow changes when the round calls for action.',
        permissionPresetId: 'workspace_write'
      },
      kimi: {
        role: 'Specialist',
        instructions:
          'Contribute concrete domain work and evidence for the task in front of the panel. Review prior responses for gaps, edge cases, and test coverage.',
        permissionPresetId: 'read_only'
      },
      ollama: {
        role: 'Outsider',
        instructions:
          'Take an independent view, stress-test the emerging consensus, and surface missed alternatives. Provide a local, privacy-preserving second opinion for summaries, triage, and small read-only reasoning tasks.',
        permissionPresetId: 'read_only'
      }
    })
    expect(config.bossmanParticipantId).toBe('ensemble-claude')
    expect(config.captainParticipantIds).toEqual(['ensemble-codex'])
    expect(config.secondInCommandParticipantId).toBe('ensemble-codex')
  })

  it('rotates each active provider into the Boss seat while keeping the panel small', () => {
    for (const provider of LIVE_PROVIDERS) {
      const config = createDefaultEnsembleConfig(provider)
      expect(config.participants[0]?.provider).toBe(provider)
      expect(config.participants).toHaveLength(4)
      expect(config.participants.map((participant) => participant.role)).toEqual([
        'Boss',
        'Captain',
        'Specialist',
        'Outsider'
      ])
      expect(config.bossmanParticipantId).toBe(config.participants[0]?.id)
      expect(config.captainParticipantIds).toEqual([config.participants[1]?.id])
      expect(config.secondInCommandParticipantId).toBe(config.participants[1]?.id)

      for (const participant of config.participants) {
        const rendererDefaults = getDefaultEnsembleParticipantConfig(participant.provider)
        expect(participant.order).toBe(config.participants.indexOf(participant) + 1)
        expect(participant.model).toBe(rendererDefaults.model)
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
  it('seeds the recommended small panel when no configured set is supplied', () => {
    const providers = createDefaultEnsembleConfig('claude').participants.map((p) => p.provider)
    expect(providers).toEqual(DEFAULT_PANEL)
  })

  it('seeds only the configured providers when a set is supplied', () => {
    const configured = new Set<ProviderId>(['claude', 'codex'])
    const providers = createDefaultEnsembleConfig('claude', configured).participants.map(
      (p) => p.provider
    )
    expect(new Set(providers)).toEqual(new Set(['claude', 'codex']))
    expect(providers).toHaveLength(2)
    expect(
      createDefaultEnsembleConfig('claude', configured).participants.map((p) => p.role)
    ).toEqual(['Boss', 'Captain'])
  })

  it('always includes the active provider even if absent from the configured set', () => {
    const configured = new Set<ProviderId>(['claude', 'codex'])
    const providers = createDefaultEnsembleConfig('grok', configured).participants.map(
      (p) => p.provider
    )
    expect(new Set(providers)).toEqual(new Set(['claude', 'codex', 'grok']))
  })

  it('caps a larger configured-provider set at four seats', () => {
    const configured = new Set<ProviderId>(LIVE_PROVIDERS)
    const providers = createDefaultEnsembleConfig('claude', configured).participants.map(
      (p) => p.provider
    )
    expect(providers).toEqual(DEFAULT_PANEL)
  })

  it('falls back to the recommended panel when fewer than two would remain', () => {
    const configured = new Set<ProviderId>(['claude'])
    const providers = createDefaultEnsembleConfig('claude', configured).participants.map(
      (p) => p.provider
    )
    expect(providers).toEqual(DEFAULT_PANEL)
  })

  it('treats an empty configured set as a fallback to the recommended panel', () => {
    const providers = createDefaultEnsembleConfig('claude', new Set<ProviderId>()).participants.map(
      (p) => p.provider
    )
    expect(providers).toEqual(DEFAULT_PANEL)
  })
})

describe('withMinimumEnsembleRoster (live roster floor)', () => {
  function seat(overrides: Partial<EnsembleParticipant> = {}): EnsembleParticipant {
    return {
      id: 'seed-1',
      provider: 'codex',
      enabled: true,
      role: 'Primary',
      instructions: '',
      order: 1,
      ...overrides
    }
  }

  it('is the identity for a roster that already meets the floor', () => {
    const roster = [seat({ id: 'a' }), seat({ id: 'b', provider: 'claude', order: 2 })]
    expect(withMinimumEnsembleRoster(roster)).toBe(roster)
  })

  it('appends a companion on a DIFFERENT provider behind a lone seat', () => {
    const [seed, companion] = withMinimumEnsembleRoster([seat()])
    expect(seed.id).toBe('seed-1')
    expect(companion.provider).not.toBe('codex')
    expect(companion.enabled).toBe(true)
    expect(companion.order).toBe(2)
    // A real seat, not a placeholder: it must be dispatchable as-is.
    expect(companion.model).toBeTruthy()
    expect(companion.permissionPresetId).toBeTruthy()
    expect(companion.instructions).toBeTruthy()
  })

  it('mints a companion id that cannot collide with the seat it joins', () => {
    const [, companion] = withMinimumEnsembleRoster([
      seat({ id: 'ensemble-companion-claude', provider: 'codex' })
    ])
    expect(companion.id).not.toBe('ensemble-companion-claude')
  })

  it('fills an empty roster all the way to the floor', () => {
    const filled = withMinimumEnsembleRoster([])
    expect(filled).toHaveLength(MIN_LIVE_ENSEMBLE_PARTICIPANTS)
    expect(new Set(filled.map((participant) => participant.id)).size).toBe(filled.length)
  })
})
