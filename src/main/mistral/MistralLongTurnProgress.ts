export const MISTRAL_OPENING_STEER =
  'For work that needs tools, give one brief first-person introduction and issue the first tool call in the same response. The introduction accompanies execution; it is not the final answer, a handoff, or a request for permission. Do not stop after announcing a plan.'

export const MISTRAL_PROGRESS_STEER = [
  'TaskWraith Mistral progress visibility (host guidance):',
  '- Continue the requested work through investigation, implementation when requested, and verification. A prose claim does not perform an operation. Use the attached TaskWraith tools for host-managed work when applicable.',
  '- Between meaningful tool phases in a long turn, give a brief checkpoint stating the result and next concrete action, then continue. Do not narrate every tool call or use a fixed update count.',
  '- Keep private reasoning in the native thinking channel. User-facing progress should contain concise conclusions and next actions, not step-by-step reasoning.',
  '- Finish with the verified result or the exact remaining blocker. Respect user denials and explicit no-tools instructions; a direct question that needs no tools should receive a direct answer.'
].join('\n')

/** Every managed Vibe turn opens a fresh ACP session, so visibility guidance
 * must accompany each launch. It never changes turn completion or permissions. */
export function withMistralProgressSteer(prompt: string, introduction?: string | null): string {
  if (/^\s*\//.test(prompt) || prompt.includes(MISTRAL_PROGRESS_STEER)) return prompt
  if (introduction) {
    return [
      'TaskWraith has already displayed your introduction. Begin the actual work now; do not repeat the opening or stop after a plan.',
      `Previously displayed introduction (context only): ${JSON.stringify(introduction)}`,
      MISTRAL_PROGRESS_STEER,
      prompt
    ].join('\n\n')
  }
  return `${MISTRAL_OPENING_STEER}\n\n${MISTRAL_PROGRESS_STEER}\n\n${prompt}`
}
