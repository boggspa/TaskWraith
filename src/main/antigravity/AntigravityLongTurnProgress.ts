export const ANTIGRAVITY_LONG_TURN_PROGRESS_NOTE = [
  'TaskWraith AntiGravity progress visibility (host guidance):',
  '- During a long, tool-heavy turn, add one brief checkpoint to your native planner trace only after a coherent investigation, edit, or verification phase: state the outcome and next phase, then continue.',
  '- Checkpoints are phase-based, not per tool or fixed count. A checkpoint is not a final answer, question, yield, handoff, or completion signal; keep working unless the requested work is actually complete or blocked.',
  '- Report concise conclusions and next actions, not private step-by-step reasoning.'
].join('\n')

/**
 * Official agy exposes planner frames separately from final assistant output.
 * Keep long native turns legible without manufacturing extra provider turns or
 * interrupting tool execution. Native slash dispatch must remain byte-leading.
 */
export function withAntigravityLongTurnProgress(prompt: string): string {
  if (/^\s*\//.test(prompt) || prompt.includes(ANTIGRAVITY_LONG_TURN_PROGRESS_NOTE)) {
    return prompt
  }
  return `${ANTIGRAVITY_LONG_TURN_PROGRESS_NOTE}\n\n${prompt}`
}
