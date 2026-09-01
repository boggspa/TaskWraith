import { describe, expect, it } from 'vitest'
import {
  EXECUTION_PLAN_CHANGE_KIND,
  isExecutionPlanChangePayload,
  resolveExecutionPlanChangePayload,
  type ExecutionPlanChangePayload
} from './executionPlanChange'

function validPayload(): ExecutionPlanChangePayload {
  return {
    summary: 'Ship the parser first, then the renderer row.',
    actor: 'boss',
    actorParticipantId: 'claude',
    changedAt: '2026-09-01T10:42:00.000Z'
  }
}

describe('isExecutionPlanChangePayload', () => {
  it('accepts the minimal authoritative payload', () => {
    expect(
      isExecutionPlanChangePayload({
        summary: 'Land the plan row.',
        actor: 'captain',
        changedAt: '2026-09-01T10:42:00.000Z'
      })
    ).toBe(true)
  })

  it('accepts every documented optional field', () => {
    expect(
      isExecutionPlanChangePayload({
        ...validPayload(),
        previousSummary: 'Prototype the plan row.',
        phase: 'Implementation',
        ownerParticipantIds: ['codex'],
        ownerLabels: ['Worker'],
        blockers: ['Waiting on the decoder audit'],
        doneCriteria: 'Row renders before generic notices.'
      })
    ).toBe(true)
  })

  it.each([
    ['null', null],
    ['an array', ['plan']],
    ['a string', 'plan'],
    ['empty summary', { ...validPayload(), summary: '' }],
    ['whitespace summary', { ...validPayload(), summary: '   ' }],
    ['a non-string summary', { ...validPayload(), summary: 7 }],
    ['a user actor — set_round_plan is authority-only', { ...validPayload(), actor: 'user' }],
    ['the legacy authority spelling', { ...validPayload(), actor: 'second_in_command' }],
    ['a missing actor', { summary: 'x', changedAt: '2026-09-01T10:42:00.000Z' }],
    ['an unparseable changedAt', { ...validPayload(), changedAt: 'soon' }],
    ['an empty optional phase', { ...validPayload(), phase: '' }],
    ['an empty optional previousSummary', { ...validPayload(), previousSummary: '  ' }],
    ['an empty optional doneCriteria', { ...validPayload(), doneCriteria: '' }],
    ['an empty optional actorParticipantId', { ...validPayload(), actorParticipantId: '' }],
    ['a non-array blockers', { ...validPayload(), blockers: 'blocked' }],
    ['a blockers entry that is blank', { ...validPayload(), blockers: ['ok', ' '] }],
    ['an ownerLabels entry that is not a string', { ...validPayload(), ownerLabels: [7] }],
    ['an ownerParticipantIds entry that is blank', { ...validPayload(), ownerParticipantIds: [''] }]
  ])('rejects %s', (_label, candidate) => {
    expect(isExecutionPlanChangePayload(candidate)).toBe(false)
  })
})

describe('resolveExecutionPlanChangePayload', () => {
  it('returns a valid structured payload from metadata', () => {
    const payload = validPayload()
    expect(
      resolveExecutionPlanChangePayload({
        role: 'system',
        content: 'Boss set the execution plan: Ship the parser first, then the renderer row.',
        timestamp: '2026-09-01T10:42:00.000Z',
        metadata: { kind: EXECUTION_PLAN_CHANGE_KIND, executionPlanChange: payload }
      })
    ).toEqual(payload)
  })

  it('rejects malformed metadata instead of falling through to sentence promotion', () => {
    expect(
      resolveExecutionPlanChangePayload({
        role: 'system',
        content: 'Boss set the execution plan: Ship it.',
        timestamp: '2026-09-01T10:42:00.000Z',
        metadata: {
          kind: 'ensembleRoundStatus',
          executionPlanChange: { summary: '', actor: 'boss', changedAt: 'soon' }
        }
      })
    ).toBeNull()
  })

  it.each([
    ['Boss', 'boss'],
    ['Captain', 'captain']
  ] as const)('promotes the exact legacy %s fallback sentence', (label, actor) => {
    expect(
      resolveExecutionPlanChangePayload({
        role: 'system',
        content: `${label} set the execution plan: Verify the close-out, then ship.`,
        timestamp: '2026-08-18T09:00:00.000Z',
        metadata: { kind: 'ensembleRoundStatus' }
      })
    ).toEqual({
      summary: 'Verify the close-out, then ship.',
      actor,
      changedAt: '2026-08-18T09:00:00.000Z'
    })
  })

  it.each([
    [
      'a non-system role',
      {
        role: 'assistant',
        content: 'Boss set the execution plan: Ship it.',
        timestamp: '2026-08-18T09:00:00.000Z',
        metadata: { kind: 'ensembleRoundStatus' }
      }
    ],
    [
      'a non-round-status kind',
      {
        role: 'system',
        content: 'Boss set the execution plan: Ship it.',
        timestamp: '2026-08-18T09:00:00.000Z',
        metadata: { kind: 'fleetWave' }
      }
    ],
    [
      'arbitrary system prose',
      {
        role: 'system',
        content: 'Boss routed the plan to Worker.',
        timestamp: '2026-08-18T09:00:00.000Z',
        metadata: { kind: 'ensembleRoundStatus' }
      }
    ],
    [
      'an unparseable timestamp',
      {
        role: 'system',
        content: 'Boss set the execution plan: Ship it.',
        timestamp: 'soon',
        metadata: { kind: 'ensembleRoundStatus' }
      }
    ],
    [
      'a multi-line sentence — normalizeBossmanText never emits one',
      {
        role: 'system',
        content: 'Boss set the execution plan: Ship it.\nThen more.',
        timestamp: '2026-08-18T09:00:00.000Z',
        metadata: { kind: 'ensembleRoundStatus' }
      }
    ],
    [
      'an overlong sentence',
      {
        role: 'system',
        content: `Boss set the execution plan: ${'x'.repeat(1500)}`,
        timestamp: '2026-08-18T09:00:00.000Z',
        metadata: { kind: 'ensembleRoundStatus' }
      }
    ]
  ])('leaves %s as a plain notice', (_label, message) => {
    expect(resolveExecutionPlanChangePayload(message)).toBeNull()
  })
})
