import { describe, expect, it } from 'vitest'
import { buildAgentWorkContract } from './AgentWorkContract'
import { createActiveGoal } from './GoalState'

describe('buildAgentWorkContract', () => {
  it('defines a run-scoped user request as the Goal when no durable Goal exists', () => {
    const block = buildAgentWorkContract({ completionAuthority: 'root' })

    expect(block).toContain('Goal = the user-owned prompt, expected outcome')
    expect(block).toContain('Plan/Todos = execution steps toward that Goal')
    expect(block).toContain('current user request below')
    expect(block).toContain('You own root completion')
    expect(block).toContain('exact pathspecs or a private index')
  })

  it('projects exact prompt and intended-plan provenance beside the bounded objective', () => {
    const goal = createActiveGoal('codex', 'Ship the complete work-contract feature.', {
      objectiveSource: 'user',
      specification: {
        kind: 'approved_plan',
        sourceMessageId: 'message-full-prompt',
        intendedPlanId: 'plan-approved-1',
        acceptanceCriteria: ['Every provider sees the same meanings.', 'Root completion is gated.']
      }
    })

    const block = buildAgentWorkContract({ activeGoal: goal, completionAuthority: 'root' })

    expect(block).toContain(`Goal id: ${goal.id}`)
    expect(block).toContain('user message message-full-prompt')
    expect(block).toContain('Binding intended plan: plan-approved-1')
    expect(block).toContain('Every provider sees the same meanings.')
    expect(block).toContain(goal.objective)
  })

  it('keeps an Ensemble assignment below the root Goal and denies root closure', () => {
    const block = buildAgentWorkContract({
      activeGoal: createActiveGoal('claude', 'Ship the whole feature.'),
      completionAuthority: 'assignment',
      assignment: {
        id: 'assignment-tests',
        objective: 'Add the regression tests.',
        acceptanceCriteria: 'Focused suite passes.',
        status: 'in_progress'
      }
    })

    expect(block).toContain('Assignment assignment-tests: Add the regression tests.')
    expect(block).toContain('You own only the assigned contribution')
    expect(block).toContain('Do not mark or block the root Goal')
    expect(block).toContain('does not complete the root Goal')
  })

  it('teaches shared semantics without duplicating provider-native objective text', () => {
    const goal = {
      ...createActiveGoal('codex', 'Provider-private objective text.'),
      mode: 'codex_native' as const
    }
    const block = buildAgentWorkContract({
      activeGoal: goal,
      providerOwnsGoalSteering: true,
      completionAuthority: 'root'
    })

    expect(block).toContain('provider-native Goal state')
    expect(block).not.toContain('Provider-private objective text.')
  })
})
