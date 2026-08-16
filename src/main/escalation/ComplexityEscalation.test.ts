import { describe, expect, it } from 'vitest'
import type { EnsembleRoundParticipantState, ProviderId } from '../store/types'
import {
  appendEscalationSignals,
  detectComplexityEscalation,
  MAX_ESCALATION_SIGNALS,
  TOOL_ERROR_CLUSTER_MIN
} from './ComplexityEscalation'

function p(
  overrides: Partial<EnsembleRoundParticipantState> & { status: EnsembleRoundParticipantState['status'] }
): EnsembleRoundParticipantState {
  return {
    participantId: overrides.participantId ?? 'p',
    provider: (overrides.provider ?? 'codex') as ProviderId,
    role: overrides.role ?? 'Participant',
    order: overrides.order ?? 0,
    status: overrides.status,
    ...(overrides.runId ? { runId: overrides.runId } : {}),
    ...(overrides.reason ? { reason: overrides.reason } : {}),
    ...(overrides.lastFailureReason ? { lastFailureReason: overrides.lastFailureReason } : {})
  }
}

function baseInput(participants: EnsembleRoundParticipantState[], over: Record<string, unknown> = {}) {
  return {
    chatId: 'chat-1',
    roundId: 'round-1',
    participants,
    hasCompletedSynthesis: false,
    createdAt: '2026-05-31T00:00:00.000Z',
    makeId: (kind: string) => `sig-${kind}`,
    ...over
  }
}

describe('detectComplexityEscalation — empty / healthy', () => {
  it('returns [] for an empty roster', () => {
    expect(detectComplexityEscalation(baseInput([]))).toEqual([])
  })

  it('returns [] for a clean single-answer round', () => {
    const out = detectComplexityEscalation(baseInput([p({ status: 'answered', participantId: 'a' })]))
    expect(out).toEqual([])
  })
})

describe('tool-error-cluster', () => {
  it('fires when >= TOOL_ERROR_CLUSTER_MIN participants failed/unreachable', () => {
    const out = detectComplexityEscalation(
      baseInput([
        p({ status: 'failed', participantId: 'a', role: 'Codex' }),
        p({ status: 'unreachable', participantId: 'b', role: 'Kimi' }),
        p({ status: 'answered', participantId: 'c', role: 'Claude' })
      ])
    )
    const cluster = out.find((s) => s.kind === 'tool-error-cluster')
    expect(cluster).toBeTruthy()
    expect(cluster!.recommendedAction).toBe('pause-for-user')
    expect(cluster!.evidence).toContain('Codex')
    expect(cluster!.evidence).toContain('Kimi')
    expect(TOOL_ERROR_CLUSTER_MIN).toBe(2)
  })

  it('fires on the half-roster rule even with a single failure when roster is 2', () => {
    const out = detectComplexityEscalation(
      baseInput([p({ status: 'failed', participantId: 'a' }), p({ status: 'answered', participantId: 'b' })])
    )
    expect(out.some((s) => s.kind === 'tool-error-cluster')).toBe(true)
  })

  it('does NOT fire for a lone failure in a large roster', () => {
    const out = detectComplexityEscalation(
      baseInput([
        p({ status: 'failed', participantId: 'a' }),
        p({ status: 'answered', participantId: 'b' }),
        p({ status: 'answered', participantId: 'c' }),
        p({ status: 'answered', participantId: 'd' })
      ])
    )
    expect(out.some((s) => s.kind === 'tool-error-cluster')).toBe(false)
  })

  it('treats a lastFailureReason as a failure even if status is not failed/unreachable', () => {
    const out = detectComplexityEscalation(
      baseInput([
        p({ status: 'answered', participantId: 'a', lastFailureReason: 'socket timeout' }),
        p({ status: 'failed', participantId: 'b' })
      ])
    )
    expect(out.some((s) => s.kind === 'tool-error-cluster')).toBe(true)
  })
})

describe('stuck', () => {
  it('fires when no participant produced an answer', () => {
    const out = detectComplexityEscalation(
      baseInput([p({ status: 'failed', participantId: 'a' }), p({ status: 'skipped', participantId: 'b' })])
    )
    const stuck = out.find((s) => s.kind === 'stuck')
    expect(stuck).toBeTruthy()
    expect(stuck!.recommendedAction).toBe('pause-for-user')
  })

  it('does NOT fire when at least one participant answered', () => {
    const out = detectComplexityEscalation(
      baseInput([p({ status: 'answered', participantId: 'a' }), p({ status: 'skipped', participantId: 'b' })])
    )
    expect(out.some((s) => s.kind === 'stuck')).toBe(false)
  })

  it('counts a yielded participant as an answer (not stuck)', () => {
    const out = detectComplexityEscalation(baseInput([p({ status: 'yielded', participantId: 'a' })]))
    expect(out.some((s) => s.kind === 'stuck')).toBe(false)
  })
})

describe('looping', () => {
  it('fires when continuationHops reaches maxContinuationHops', () => {
    const out = detectComplexityEscalation(
      baseInput([p({ status: 'answered', participantId: 'a' })], {
        continuationHops: 6,
        maxContinuationHops: 6
      })
    )
    const loop = out.find((s) => s.kind === 'looping')
    expect(loop).toBeTruthy()
    expect(loop!.evidence).toContain('6')
  })

  it('does NOT fire when under the hop budget', () => {
    const out = detectComplexityEscalation(
      baseInput([p({ status: 'answered', participantId: 'a' })], {
        continuationHops: 3,
        maxContinuationHops: 6
      })
    )
    expect(out.some((s) => s.kind === 'looping')).toBe(false)
  })

  it('does NOT fire when hop fields are absent (turn-bound round)', () => {
    const out = detectComplexityEscalation(baseInput([p({ status: 'answered', participantId: 'a' })]))
    expect(out.some((s) => s.kind === 'looping')).toBe(false)
  })
})

describe('disagreement-unresolved', () => {
  it('fires when >= 2 answered and no completed synthesis', () => {
    const out = detectComplexityEscalation(
      baseInput([p({ status: 'answered', participantId: 'a' }), p({ status: 'answered', participantId: 'b' })])
    )
    const dis = out.find((s) => s.kind === 'disagreement-unresolved')
    expect(dis).toBeTruthy()
    expect(dis!.recommendedAction).toBe('call-synthesizer')
  })

  it('does NOT fire when a structured synthesis completed', () => {
    const out = detectComplexityEscalation(
      baseInput([p({ status: 'answered', participantId: 'a' }), p({ status: 'answered', participantId: 'b' })], {
        hasCompletedSynthesis: true
      })
    )
    expect(out.some((s) => s.kind === 'disagreement-unresolved')).toBe(false)
  })

  it('does NOT fire for a single answer', () => {
    const out = detectComplexityEscalation(baseInput([p({ status: 'answered', participantId: 'a' })]))
    expect(out.some((s) => s.kind === 'disagreement-unresolved')).toBe(false)
  })
})

describe('multiple signals co-firing', () => {
  it('an all-failed round trips both tool-error-cluster and stuck', () => {
    const out = detectComplexityEscalation(
      baseInput([p({ status: 'failed', participantId: 'a' }), p({ status: 'unreachable', participantId: 'b' })])
    )
    const kinds = out.map((s) => s.kind).sort()
    expect(kinds).toContain('tool-error-cluster')
    expect(kinds).toContain('stuck')
  })

  it('stamps deterministic ids + shared round/chat ids', () => {
    const out = detectComplexityEscalation(
      baseInput([p({ status: 'failed', participantId: 'a' }), p({ status: 'failed', participantId: 'b' })])
    )
    expect(out.every((s) => s.chatId === 'chat-1' && s.roundId === 'round-1')).toBe(true)
    expect(out.find((s) => s.kind === 'stuck')!.id).toBe('sig-stuck')
  })
})

describe('appendEscalationSignals', () => {
  const sig = (id: string) => ({
    id,
    chatId: 'c',
    roundId: 'r',
    kind: 'stuck' as const,
    evidence: 'e',
    recommendedAction: 'pause-for-user' as const,
    createdAt: '2026-05-31T00:00:00.000Z'
  })

  it('returns the existing reference unchanged when nothing is added', () => {
    const existing = [sig('a')]
    expect(appendEscalationSignals(existing, [])).toBe(existing)
  })

  it('appends fresh signals', () => {
    expect(appendEscalationSignals(undefined, [sig('a'), sig('b')])).toHaveLength(2)
  })

  it('caps at MAX_ESCALATION_SIGNALS keeping the most recent', () => {
    const existing = Array.from({ length: MAX_ESCALATION_SIGNALS }, (_, i) => sig(`old-${i}`))
    const out = appendEscalationSignals(existing, [sig('newest')])
    expect(out).toHaveLength(MAX_ESCALATION_SIGNALS)
    expect(out!.some((s) => s.id === 'old-0')).toBe(false)
    expect(out!.some((s) => s.id === 'newest')).toBe(true)
  })
})
