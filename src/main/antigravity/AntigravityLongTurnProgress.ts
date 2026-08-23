export const ANTIGRAVITY_LONG_TURN_PROGRESS_NOTE = [
  'TaskWraith AntiGravity progress visibility (host guidance):',
  '- Announce your current progress in a couple of prose sentences and then proceed.',
  '- During a long, tool-heavy turn, add one brief checkpoint to your native planner trace only after a coherent investigation, edit, or verification phase: state the outcome and next phase, then continue.',
  '- Checkpoints are phase-based, not per tool or fixed count. A checkpoint is not a final answer, question, yield, handoff, or completion signal; keep working unless the requested work is actually complete or blocked.',
  '- Report concise conclusions and next actions, not private step-by-step reasoning.'
].join('\n')

/**
 * Standing progress-visibility steer. AntiGravity's unclassified transcript
 * steps surface as opaque "generic" activity cards, which is the visible
 * symptom of the model working silently through tool calls. The guidance is
 * host-side and never rendered to the user.
 */
export function withAntigravityProgressSteer(prompt: string): string {
  if (/^\s*\//.test(prompt) || prompt.includes(ANTIGRAVITY_LONG_TURN_PROGRESS_NOTE)) {
    return prompt
  }
  return `${ANTIGRAVITY_LONG_TURN_PROGRESS_NOTE}\n\n${prompt}`
}

/**
 * Kept as the historical entry point so existing callers/tests stay valid:
 * the standing note already carries the progress steer, and this wrapper
 * preserves the "never disturb a native slash dispatch" contract.
 */
export const withAntigravityLongTurnProgress = withAntigravityProgressSteer

export const ANTIGRAVITY_COLD_START_STEER_NOTE =
  'TaskWraith AntiGravity launch guidance (host guidance): announce what you plan to do before starting tool calls.'

/**
 * Cold-start-only steer, paired with the synthetic `antigravity_init`
 * liveness emission: fresh-project launches bootstrap silently for several
 * seconds, so the model is asked up front to narrate its plan before its
 * first tool call. Host-side only — hidden from the user's transcript.
 */
export function withAntigravityColdStartSteer(prompt: string): string {
  if (/^\s*\//.test(prompt) || prompt.includes(ANTIGRAVITY_COLD_START_STEER_NOTE)) {
    return prompt
  }
  return `${ANTIGRAVITY_COLD_START_STEER_NOTE}\n\n${prompt}`
}
