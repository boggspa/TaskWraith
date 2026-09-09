/**
 * The conditional "no tools" clause shared by the Mistral, Devin and Grok
 * prompt preambles.
 *
 * The earlier wording, "An explicit no-tools instruction in the user request
 * or role brief overrides that allowance: do not call shell, file, or any
 * other tool.", reads to a mid-size model as if the sentence itself were the
 * instruction. Observed 2026-09-09 on a Mistral Medium 3.5 Vibe seat that had a
 * full write posture and a listed broker: it quoted the sentence as a
 * "system-level no-tools override", stopped, and asked whether it had any tool
 * surface at all. The clause therefore (1) says it applies only when such an
 * instruction actually appears, (2) gives the model a concrete test (can it
 * quote one?), and (3) only then names what not to call.
 *
 * Prompt wording only. The host gate remains the safety floor; nothing here
 * widens or narrows any capability.
 */
export function noToolsOverrideClause(forbidden: string): string {
  return (
    'The tool allowances above are overridden only by an explicit no-tools instruction that ' +
    'actually appears in the user request or your role brief. If you cannot quote such an ' +
    'instruction, no override is in effect and you should use the listed tools. When one ' +
    `does appear, do not call ${forbidden}.`
  )
}

/** The exact old phrasing a seat misread as an active ban; tests pin its absence. */
export const AMBIGUOUS_NO_TOOLS_OVERRIDE_PHRASE = 'overrides that allowance: do not call'
