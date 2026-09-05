export const MUSE_LONG_TURN_PROGRESS_NOTE = [
  'TaskWraith Muse progress visibility (host guidance):',
  '- Carry out the requested work with tools when needed; a plan or prose claim does not perform an operation.',
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
  'TaskWraith Muse launch guidance (host guidance): carry out the requested work in this turn. When tools are needed, give one brief introduction and issue the first tool call in that same response. Do not stop after announcing a plan. The introduction accompanies tool execution; it is not a final answer or a request for permission. Further progress updates belong between meaningful tool phases while work continues. Verify file changes with tools before reporting completion; report any unavailable or failed operation honestly.'

/**
 * Fresh-exec execution guidance. A progress announcement must lead into tool
 * work rather than being mistaken for completion.
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
export function composeMuseLaunchPrompt(prompt: string, introduction?: string | null): string {
  if (introduction && !/^\s*\//.test(prompt)) {
    return [
      'TaskWraith Muse launch guidance (host guidance): your introduction has already been shown to the user. Carry out the requested work now with tools when needed. Do not repeat the introduction or stop after a plan. Verify the work before the final answer.',
      `Previously displayed Muse introduction (context only): ${JSON.stringify(introduction)}`,
      withMuseProgressSteer(prompt)
    ].join('\n\n')
  }
  return withMuseOpeningSteer(withMuseProgressSteer(prompt))
}
