import { describe, expect, it } from 'vitest'
import { createActiveGoal } from './GoalState'
import {
  decideEnsembleGoalLifecycle,
  ensembleGoalAuthorityForParticipant,
  latestGoalAssignmentForParticipant
} from './EnsembleGoalCompletionPolicy'
import type { ChatRecord, EnsembleConfig } from './store/types'

function ensemble(): EnsembleConfig {
  return {
    enabled: true,
    maxParticipants: 3,
    participants: [
      {
        id: 'boss',
        provider: 'codex',
        role: 'Boss',
        instructions: 'Coordinate the Goal.',
        enabled: true,
        order: 0,
        stageRole: 'worker'
      },
      {
        id: 'worker',
        provider: 'claude',
        role: 'Worker',
        instructions: 'Implement the assignment.',
        enabled: true,
        order: 1,
        stageRole: 'worker'
      },
      {
        id: 'reviewer',
        provider: 'gemini',
        role: 'Reviewer',
        instructions: 'Review the result.',
        enabled: true,
        order: 2,
        stageRole: 'reviewer'
      }
    ],
    bossmanParticipantId: 'boss',
    captainParticipantIds: []
  }
}

function chat(config = ensemble()): Pick<ChatRecord, 'activeGoal' | 'ensemble'> {
  return {
    activeGoal: createActiveGoal('codex', 'Ship the whole feature.', {
      now: new Date('2026-08-21T00:00:00.000Z')
    }),
    ensemble: config
  }
}

describe('Ensemble Goal completion authority', () => {
  it('maps Boss to root, workers to assignments, and reviewers to review evidence', () => {
    const config = ensemble()
    expect(ensembleGoalAuthorityForParticipant(config, 'boss')).toBe('root')
    expect(ensembleGoalAuthorityForParticipant(config, 'worker')).toBe('assignment')
    expect(ensembleGoalAuthorityForParticipant(config, 'reviewer')).toBe('review')
  })

  it('refuses every root lifecycle transition from a non-authority seat', () => {
    for (const status of ['active', 'paused', 'blocked', 'completed'] as const) {
      expect(
        decideEnsembleGoalLifecycle({ chat: chat(), participantId: 'worker', status })
      ).toMatchObject({
        allowed: false,
        authority: 'assignment',
        code: 'root_authority_required'
      })
    }
    expect(
      decideEnsembleGoalLifecycle({ chat: chat(), participantId: 'reviewer', status: 'completed' })
        .message
    ).toContain('review evidence')
  })

  it('blocks root completion while a current or legacy assignment remains open', () => {
    const source = chat()
    source.ensemble!.bossmanControlState = {
      assignments: [
        {
          id: 'work-1',
          participantId: 'worker',
          objective: 'Implement it.',
          status: 'in_progress',
          createdAt: '2026-08-21T00:01:00.000Z',
          updatedAt: '2026-08-21T00:01:00.000Z'
        }
      ]
    }

    expect(
      decideEnsembleGoalLifecycle({ chat: source, participantId: 'boss', status: 'completed' })
    ).toMatchObject({
      allowed: false,
      authority: 'root',
      code: 'open_assignments',
      blockingAssignmentIds: ['work-1']
    })
    source.ensemble!.bossmanControlState!.assignments![0].status = 'done'
    expect(
      decideEnsembleGoalLifecycle({ chat: source, participantId: 'boss', status: 'completed' })
    ).toEqual({ allowed: true, authority: 'root' })
  })

  it('finds only the participant assignment belonging to the active Goal', () => {
    const source = chat()
    source.ensemble!.bossmanControlState = {
      assignments: [
        {
          id: 'old',
          goalId: 'goal-old',
          participantId: 'worker',
          objective: 'Old work.',
          status: 'done',
          createdAt: '2026-08-20T00:00:00.000Z',
          updatedAt: '2026-08-20T00:00:00.000Z'
        },
        {
          id: 'current',
          goalId: source.activeGoal!.id,
          participantId: 'worker',
          objective: 'Current work.',
          status: 'in_progress',
          createdAt: '2026-08-21T00:01:00.000Z',
          updatedAt: '2026-08-21T00:01:00.000Z'
        }
      ]
    }

    expect(latestGoalAssignmentForParticipant(source, 'worker')?.id).toBe('current')
  })
})
