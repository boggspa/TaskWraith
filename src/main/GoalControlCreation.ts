import type { ActiveGoalObjectiveSource } from './store/types'

/**
 * Whether a goal-control tool call may CREATE the thread's active goal.
 *
 * TaskWraith has no agent-facing "create goal" tool: `ensemble_control`'s
 * `set_goal` needs Boss authority and the `op:'set'` lifecycle is renderer /
 * remote only. For a solo run the only creation path is this relaxation inside
 * the `goal_update` / `update_goal` handler, so it is the whole route rather
 * than a convenience.
 *
 * It used to additionally require `chat.messages.length === 1`. That window is
 * shut before any model can reach it: `PromptComposition` reads the same length
 * BEFORE the run to decide whether to tell the agent "call update_goal once to
 * persist it", and by the time the call arrives the agent's own streamed
 * assistant row (plus any tool/system rows) has been appended and saved. The
 * app therefore instructed the model to do the exact thing it then refused,
 * and the refusal named a precondition with no agent-reachable remedy — which
 * is what produced the observed retry loops (mistral, muse, ollama).
 *
 * Extracted from index.ts rather than edited in place: the composition-root
 * growth policy wants the logic and its test in their own file, and the guard
 * this replaces was only ever exercised through a source-pinning test.
 */

/** Goal-control tools that may create the goal when none exists. */
export const GOAL_CONTROL_CREATE_TOOL_NAMES = ['goal_update', 'update_goal'] as const

/** Objective used when neither the call nor the thread supplies any text. */
export const GOAL_CONTROL_PLACEHOLDER_OBJECTIVE = 'Auto-created objective'

/**
 * Refusal for a lifecycle-only tool (`goal_complete` / `goal_blocked`) with no
 * goal to act on. It names the tool that CAN create one, because the previous
 * wording stated a precondition and no remedy.
 */
export const GOAL_CONTROL_NO_ACTIVE_GOAL_ERROR =
  'No active TaskWraith goal is set for this chat. Call update_goal with an objective to set one first.'

/** Refusal when the call carries no resolvable thread at all. */
export const GOAL_CONTROL_NO_THREAD_ERROR =
  'No TaskWraith thread is bound to this run, so its goal cannot be read or changed.'

export interface GoalControlChatFacts {
  readonly messages?: readonly { readonly role?: string; readonly content?: string }[] | null
}

export type GoalControlCreationDecision =
  | {
      readonly create: true
      readonly objective: string
      readonly objectiveSource: ActiveGoalObjectiveSource
    }
  | { readonly create: false; readonly error: string }

function trimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** The thread's opening human prompt, which is the goal a bare call means. */
function firstUserMessageContent(chat: GoalControlChatFacts): string {
  const messages = chat.messages || []
  for (const message of messages) {
    if (message?.role === 'user') return trimmedString(message.content)
  }
  return trimmedString(messages[0]?.content)
}

/**
 * Decide whether this goal-control call creates the goal, and with what text.
 *
 * Only call this once the caller has established that the thread has NO active
 * goal; `hasActiveGoal` is accepted so the decision fails closed if that ever
 * stops being true at the call site.
 */
export function resolveGoalControlCreation(input: {
  readonly toolName: string
  readonly args?: Record<string, unknown> | null
  readonly chat?: GoalControlChatFacts | null
  readonly hasActiveGoal?: boolean
}): GoalControlCreationDecision {
  if (input.hasActiveGoal) return { create: false, error: GOAL_CONTROL_NO_ACTIVE_GOAL_ERROR }
  if (!input.chat) return { create: false, error: GOAL_CONTROL_NO_THREAD_ERROR }
  if (!(GOAL_CONTROL_CREATE_TOOL_NAMES as readonly string[]).includes(input.toolName)) {
    return { create: false, error: GOAL_CONTROL_NO_ACTIVE_GOAL_ERROR }
  }

  const args = input.args || {}
  // Objective text the AGENT authored in this call. Labelled 'agent' because
  // `objectiveSource: 'user'` asserts a human owns the wording — the prompt
  // block says so, and ContinuationProposal only reuses user-owned goals.
  const authored = trimmedString(args.objective) || trimmedString(args.description)
  if (authored) return { create: true, objective: authored, objectiveSource: 'agent' }

  // A bare status-only call still means "this thread has an objective": adopt
  // the human's opening prompt, which is what the user actually asked for.
  const opening = firstUserMessageContent(input.chat)
  if (opening) return { create: true, objective: opening, objectiveSource: 'user' }

  return {
    create: true,
    objective: GOAL_CONTROL_PLACEHOLDER_OBJECTIVE,
    objectiveSource: 'user'
  }
}
