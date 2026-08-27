import type { ActiveGoal } from './store/types'

export type AgentWorkCompletionAuthority = 'root' | 'assignment' | 'review'

export interface AgentWorkAssignmentContract {
  id: string
  objective: string
  acceptanceCriteria?: string
  status?: string
}

export interface AgentWorkContractInput {
  activeGoal?: ActiveGoal | null
  /** Native provider goal engines retain the objective; avoid arming a second
   * steering copy while still teaching the shared Goal/Plan/Todo vocabulary. */
  providerOwnsGoalSteering?: boolean
  completionAuthority: AgentWorkCompletionAuthority
  assignment?: AgentWorkAssignmentContract | null
  /** First actionable solo turn: advertise the durable Goal route without
   * repeating the old standalone no-goal paragraph. */
  suggestDurableGoal?: boolean
}

export const TASKWRAITH_WORK_INVARIANTS_VERSION = 'taskwraith-work-invariants-v1'

/** Stable solo-session rules. PromptComposition delivers this once to a
 * history-carrying provider session and on every host-fed turn. Ensemble keeps
 * the compatibility contract below because assignments have their own shell. */
export function buildAgentWorkInvariants(): string {
  return [
    `<taskwraith_work_invariants version="${TASKWRAITH_WORK_INVARIANTS_VERSION}">`,
    '- Goal is the user-owned request, expected outcome, acceptance conditions, and any user-approved intended plan: what must be true when work is finished.',
    '- Plan/Todos are execution steps toward the Goal, never a replacement Goal.',
    '- Keep Plan/Todos aligned with real remaining work; extend them when follow-up work is discovered.',
    '- A filesystem-changing step is done only after relevant checks pass and the coherent change is committed as its own slice using exact pathspecs or a private index.',
    '- Todo completion alone is never evidence that the Goal is complete.',
    '</taskwraith_work_invariants>'
  ].join('\n')
}

/** Dynamic Goal/authority state kept adjacent to the current solo request. */
export function buildAgentWorkState(input: AgentWorkContractInput): string {
  const goal =
    input.activeGoal?.status === 'active' || input.activeGoal?.status === 'blocked'
      ? input.activeGoal
      : null
  const lines = ['<taskwraith_work_state>']

  if (!goal) {
    lines.push('Goal: current user request (run-scoped; no unfinished durable Goal).')
    if (input.suggestDurableGoal) {
      lines.push('If it needs multi-turn action, call update_goal once to persist it.')
    }
  } else if (input.providerOwnsGoalSteering) {
    lines.push(
      `Goal id: ${goal.id}`,
      `Source: provider-native Goal state (${goal.mode}); TaskWraith does not duplicate its objective here.`,
      'The current user request steers within that Goal unless the user explicitly replaces it.'
    )
  } else {
    lines.push(`Goal id: ${goal.id}`, `Status: ${goal.status}`)
    if (goal.specification?.kind) lines.push(`Specification source: ${goal.specification.kind}`)
    if (goal.specification?.sourceMessageId) {
      lines.push(
        `Exact untruncated source: user message ${goal.specification.sourceMessageId} (the objective below is a bounded display summary).`
      )
    }
    if (goal.specification?.intendedPlanId) {
      lines.push(`Binding intended plan: ${goal.specification.intendedPlanId}`)
    }
    lines.push('Expected outcome:', goal.objective)
    if (goal.specification?.acceptanceCriteria?.length) {
      lines.push(
        'Acceptance criteria:',
        ...goal.specification.acceptanceCriteria.map((criterion) => `- ${criterion}`)
      )
    }
    if (goal.status === 'blocked' && goal.blockedReason) {
      lines.push(`Current blocker: ${goal.blockedReason}`)
    }
  }

  if (input.assignment) {
    lines.push(
      `Assignment ${input.assignment.id}: ${input.assignment.objective}`,
      ...(input.assignment.acceptanceCriteria
        ? [`Assignment acceptance: ${input.assignment.acceptanceCriteria}`]
        : []),
      ...(input.assignment.status ? [`Assignment status: ${input.assignment.status}`] : [])
    )
  }
  if (input.completionAuthority === 'root') {
    lines.push(
      'Authority: root; complete only after the entire outcome—not merely current todos—is achieved and verified.'
    )
  } else if (input.completionAuthority === 'assignment') {
    lines.push(
      'Authority: assigned contribution only; verify it and hand evidence back. Do not mark or block the root Goal.'
    )
  } else {
    lines.push(
      'Authority: review evidence only; hand back the verdict/findings. Do not mark or block the root Goal.'
    )
  }
  lines.push('</taskwraith_work_state>')
  return lines.join('\n')
}

/** Compatibility wrapper retained for EnsemblePrompt and existing receipts. */
export function buildAgentWorkContract(input: AgentWorkContractInput): string {
  const goal =
    input.activeGoal?.status === 'active' || input.activeGoal?.status === 'blocked'
      ? input.activeGoal
      : null
  const lines = [
    '<taskwraith_work_contract>',
    'Canonical meanings:',
    '- Goal = the user-owned prompt, expected outcome, acceptance conditions, and any user-approved intended plan. It describes what must be true when the work is finished.',
    '- Plan/Todos = execution steps toward that Goal. They describe how work progresses; they are never a replacement Goal.',
    "- In an Ensemble, an assignment is one participant-owned Goal step. Completing an assignment or every local todo reports that seat's contribution complete; it does not complete the root Goal.",
    '',
    'Current Goal:'
  ]

  if (!goal) {
    lines.push(
      '- Source: the current user request below (run-scoped; no unfinished durable Goal is active).',
      '- Expected outcome: satisfy that request completely and verify the result.'
    )
  } else if (input.providerOwnsGoalSteering) {
    lines.push(
      `- Goal id: ${goal.id}`,
      `- Source: provider-native Goal state (${goal.mode}); TaskWraith does not duplicate its objective here.`,
      '- The current user request is steering within that Goal unless the user explicitly replaces it.'
    )
  } else {
    lines.push(`- Goal id: ${goal.id}`, `- Status: ${goal.status}`)
    if (goal.specification?.kind) {
      lines.push(`- Specification source: ${goal.specification.kind}`)
    }
    if (goal.specification?.sourceMessageId) {
      lines.push(
        `- Exact untruncated source: user message ${goal.specification.sourceMessageId} (the objective below is a bounded display summary).`
      )
    }
    if (goal.specification?.intendedPlanId) {
      lines.push(`- Binding intended plan: ${goal.specification.intendedPlanId}`)
    }
    lines.push('- Expected outcome:', goal.objective)
    if (goal.specification?.acceptanceCriteria?.length) {
      lines.push(
        '- Acceptance criteria:',
        ...goal.specification.acceptanceCriteria.map((criterion) => `  - ${criterion}`)
      )
    }
    if (goal.status === 'blocked' && goal.blockedReason) {
      lines.push(`- Current blocker: ${goal.blockedReason}`)
    }
  }

  lines.push('', 'Your responsibility:')
  if (input.assignment) {
    lines.push(
      `- Assignment ${input.assignment.id}: ${input.assignment.objective}`,
      ...(input.assignment.acceptanceCriteria
        ? [`- Assignment acceptance: ${input.assignment.acceptanceCriteria}`]
        : []),
      ...(input.assignment.status ? [`- Assignment status: ${input.assignment.status}`] : [])
    )
  }
  if (input.completionAuthority === 'root') {
    lines.push(
      '- You own root completion. Mark the Goal complete only after the entire expected outcome—not merely your current todos—has been achieved and verified.'
    )
  } else if (input.completionAuthority === 'assignment') {
    lines.push(
      '- You own only the assigned contribution. Finish and verify it, update its steps/status, and hand evidence back to the orchestrator. Do not mark or block the root Goal.'
    )
  } else {
    lines.push(
      '- You own review evidence only. Record the review verdict or findings and hand them back; do not mark or block the root Goal.'
    )
  }

  lines.push(
    '',
    'Execution rules:',
    '- Keep Plan/Todos aligned with real remaining work. A completed checklist with discovered follow-up work must be extended before stopping.',
    '- A filesystem-changing step is not done until its relevant checks pass and the coherent change is committed as its own slice using exact pathspecs or a private index.',
    '- Never use todo completion as evidence that the root Goal itself is complete.',
    '</taskwraith_work_contract>'
  )
  return lines.join('\n')
}
