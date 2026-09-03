export const MUSE_LONG_TURN_PROGRESS_NOTE = [
  'TaskWraith Muse progress visibility (host guidance):',
  '- Announce your current progress in a couple of prose sentences and then proceed.',
  '- During a long, tool-heavy turn, add one brief checkpoint only after a coherent investigation, edit, or verification phase: state the outcome and next phase, then continue.',
  '- Checkpoints are phase-based, not per tool or fixed count. A checkpoint is not a final answer, question, yield, handoff, or completion signal; keep working unless the requested work is actually complete or blocked.',
  '- Report concise conclusions and next actions, not private step-by-step reasoning.'
].join('\n')

/**
 * Standing progress-visibility steer. Muse often starts tool work before any
 * visible prose, which leaves the transcript on an empty "Working..." state.
 * The guidance is host-side and never rendered as a user message.
 */
export function withMuseProgressSteer(prompt: string): string {
  if (/^\s*\//.test(prompt) || prompt.includes(MUSE_LONG_TURN_PROGRESS_NOTE)) {
    return prompt
  }
  return `${MUSE_LONG_TURN_PROGRESS_NOTE}\n\n${prompt}`
}

export const MUSE_OPENING_STEER_NOTE =
  'TaskWraith Muse launch guidance (host guidance): announce what you plan to do before starting tool calls.'

/**
 * Opening acknowledgement steer. Every `muse exec` opens a fresh isolated
 * home, so there is no native resume that already carries a plan announcement.
 * Host-side only — hidden from the user's transcript.
 */
export function withMuseOpeningSteer(prompt: string): string {
  if (/^\s*\//.test(prompt) || prompt.includes(MUSE_OPENING_STEER_NOTE)) {
    return prompt
  }
  return `${MUSE_OPENING_STEER_NOTE}\n\n${prompt}`
}

/**
 * Compose the prompt Muse receives on argv. Always applies both steers:
 * isolated-home exec has no durable native conversation to skip the opener.
 */
export function composeMuseLaunchPrompt(prompt: string): string {
  return withMuseOpeningSteer(withMuseProgressSteer(prompt))
}
