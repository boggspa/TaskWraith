import { describe, expect, it } from 'vitest'
import { isExecutionPlanChangePayload } from '../../shared/executionPlanChange'
import {
  buildExecutionPlanChangeTranscriptEvent,
  type BuildExecutionPlanChangeInput
} from './EnsembleExecutionPlanTranscript'

function baseInput(): BuildExecutionPlanChangeInput {
  return {
    planSummary: 'Ship the parser first, then the renderer row.',
    authorityRole: 'boss',
    actorParticipantId: 'claude',
    changedAt: '2026-09-01T10:42:00.000Z',
    roundId: 'round-1'
  }
}

describe('buildExecutionPlanChangeTranscriptEvent', () => {
  it('keeps the exact plaintext fallback sentence as the carrier content', () => {
    expect(buildExecutionPlanChangeTranscriptEvent(baseInput()).content).toBe(
      'Boss set the execution plan: Ship the parser first, then the renderer row.'
    )
  })

  it('promotes a durable structured payload that passes the shared validator', () => {
    const event = buildExecutionPlanChangeTranscriptEvent(baseInput())
    expect(event.metadata.kind).toBe('ensembleExecutionPlanChange')
    expect(event.metadata.ensembleRoundId).toBe('round-1')
    expect(event.metadata.executionPlanChange).toEqual({
      summary: 'Ship the parser first, then the renderer row.',
      actor: 'boss',
      actorParticipantId: 'claude',
      changedAt: '2026-09-01T10:42:00.000Z'
    })
    expect(isExecutionPlanChangePayload(event.metadata.executionPlanChange)).toBe(true)
  })

  it('speaks Captain for the legacy second_in_command authority spelling', () => {
    const event = buildExecutionPlanChangeTranscriptEvent({
      ...baseInput(),
      authorityRole: 'second_in_command'
    })
    expect(event.content).toBe(
      'Captain set the execution plan: Ship the parser first, then the renderer row.'
    )
    expect(event.metadata.executionPlanChange).toMatchObject({ actor: 'captain' })
  })

  it('carries the full work-contract fields when supplied', () => {
    const event = buildExecutionPlanChangeTranscriptEvent({
      ...baseInput(),
      previousSummary: 'Prototype the plan row.',
      phase: 'Implementation',
      ownerParticipantIds: ['codex'],
      ownerLabels: ['Worker'],
      blockers: ['Waiting on the decoder audit'],
      doneCriteria: 'Row renders before generic notices.'
    })
    expect(event.metadata.executionPlanChange).toEqual({
      summary: 'Ship the parser first, then the renderer row.',
      actor: 'boss',
      actorParticipantId: 'claude',
      changedAt: '2026-09-01T10:42:00.000Z',
      previousSummary: 'Prototype the plan row.',
      phase: 'Implementation',
      ownerParticipantIds: ['codex'],
      ownerLabels: ['Worker'],
      blockers: ['Waiting on the decoder audit'],
      doneCriteria: 'Row renders before generic notices.'
    })
    expect(isExecutionPlanChangePayload(event.metadata.executionPlanChange)).toBe(true)
  })

  it('omits empty optionals so the payload never carries vacuous fields', () => {
    const event = buildExecutionPlanChangeTranscriptEvent({
      ...baseInput(),
      previousSummary: '  ',
      phase: '',
      ownerParticipantIds: [],
      ownerLabels: [],
      blockers: [],
      doneCriteria: '   '
    })
    const payload = event.metadata.executionPlanChange as unknown as Record<string, unknown>
    for (const field of [
      'previousSummary',
      'phase',
      'ownerParticipantIds',
      'ownerLabels',
      'blockers',
      'doneCriteria'
    ]) {
      expect(field in payload, `${field} should be omitted`).toBe(false)
    }
  })

  it('drops a previousSummary identical to the new summary — re-stating a plan is not an update', () => {
    const event = buildExecutionPlanChangeTranscriptEvent({
      ...baseInput(),
      previousSummary: 'Ship the parser first, then the renderer row.'
    })
    expect('previousSummary' in (event.metadata.executionPlanChange as object)).toBe(false)
  })
})
