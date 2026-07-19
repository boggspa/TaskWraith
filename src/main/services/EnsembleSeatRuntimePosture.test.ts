import { describe, expect, it } from 'vitest'
import { KIMI_ACP_PRODUCTION_POSTURE_VERSION } from '../../shared/kimiAcpPosture'
import type { EnsembleParticipant, ProviderId } from '../store/types'
import {
  isHostSeatCompactionProvider,
  isProductionKimiAcpSeat,
  persistedSeatRuntimeState,
  seatOverflowEvidenceKey
} from './EnsembleSeatRuntimePosture'

function participant(overrides: Partial<EnsembleParticipant> = {}): EnsembleParticipant {
  const base: EnsembleParticipant = {
    id: 'seat-1',
    provider: 'kimi',
    model: 'kimi-k2.7-code',
    role: 'Reviewer',
    instructions: 'Reviewer.',
    order: 1,
    enabled: true,
    permissionPresetId: 'read_only'
  }
  return {
    ...base,
    ...overrides,
    instructions: overrides.instructions ?? base.instructions
  }
}

describe('EnsembleSeatRuntimePosture', () => {
  it('limits host compaction to the Kimi and Grok maintenance transports', () => {
    const providers: ProviderId[] = [
      'gemini',
      'codex',
      'claude',
      'kimi',
      'grok',
      'cursor',
      'ollama'
    ]
    expect(providers.filter(isHostSeatCompactionProvider)).toEqual(['kimi', 'grok'])
  })

  it('requires the complete production Kimi ACP posture', () => {
    expect(
      isProductionKimiAcpSeat(
        participant({
          kimiAcpNativeSession: true,
          kimiAcpPostureVersion: KIMI_ACP_PRODUCTION_POSTURE_VERSION
        })
      )
    ).toBe(true)
    expect(
      isProductionKimiAcpSeat(
        participant({ kimiAcpNativeSession: true, kimiAcpPostureVersion: undefined })
      )
    ).toBe(false)
    expect(
      isProductionKimiAcpSeat(
        participant({
          provider: 'claude',
          kimiAcpNativeSession: true,
          kimiAcpPostureVersion: KIMI_ACP_PRODUCTION_POSTURE_VERSION
        })
      )
    ).toBe(false)
  })

  it('projects only the persisted seat runtime fields refreshed after compaction', () => {
    const source = participant({
      linkedProviderSessionId: 'session-1',
      contextCompactionSummary: {
        text: 'summary',
        createdAt: '2026-07-19T00:00:00.000Z',
        provider: 'kimi'
      },
      promptShellVersion: 'shell-v1',
      promptDynamicStateVersion: 'dynamic-v1',
      taskWraithMcpProfileReceipt: {
        schemaVersion: 1,
        profileId: 'taskwraith-gateway-v2',
        provider: 'kimi',
        providerSessionId: 'session-1',
        pinnedAt: '2026-07-19T00:00:00.000Z'
      },
      kimiAcpNativeSession: true,
      kimiAcpPostureVersion: KIMI_ACP_PRODUCTION_POSTURE_VERSION
    })

    expect(persistedSeatRuntimeState(source)).toEqual({
      linkedProviderSessionId: 'session-1',
      contextCompactionSummary: {
        text: 'summary',
        createdAt: '2026-07-19T00:00:00.000Z',
        provider: 'kimi'
      },
      promptShellVersion: 'shell-v1',
      promptDynamicStateVersion: 'dynamic-v1',
      taskWraithMcpProfileReceipt: {
        schemaVersion: 1,
        profileId: 'taskwraith-gateway-v2',
        provider: 'kimi',
        providerSessionId: 'session-1',
        pinnedAt: '2026-07-19T00:00:00.000Z'
      },
      kimiAcpNativeSession: true,
      kimiAcpPostureVersion: KIMI_ACP_PRODUCTION_POSTURE_VERSION
    })
  })

  it('keeps overflow evidence scoped to one chat and participant', () => {
    expect(seatOverflowEvidenceKey('chat-1', 'seat-2')).toBe('chat-1:seat-2')
  })
})
