export const ANTIGRAVITY_GOAL_COMPLETE_FALLBACK_PREFIX = 'TASKWRAITH_GOAL_COMPLETE '

const MAX_GOAL_COMPLETION_SUMMARY_CHARS = 500

export interface AntigravityGoalCompletionFallbackSignal {
  summary: string
}

function normalizedSummary(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, MAX_GOAL_COMPLETION_SUMMARY_CHARS) : ''
}

export function buildAntigravityGoalCompletionFallbackInstruction(): string {
  const payload = JSON.stringify({
    summary: 'Verified the active goal is complete.'
  })
  return [
    'Host goal-lifecycle fallback (official agy has no TaskWraith MCP bridge):',
    '- Only if you are the current Boss or acting Captain AND the active goal is genuinely complete, finish your response with the exact standalone line below.',
    '- TaskWraith binds this signal to the exact live run, active goal, and authority seat. Replace only summary with concise completion evidence; do not add IDs or fields, and do not emit it while work or a required review gate remains.',
    `${ANTIGRAVITY_GOAL_COMPLETE_FALLBACK_PREFIX}${payload}`
  ].join('\n')
}

export function parseAntigravityGoalCompletionFallback(
  content: string
): AntigravityGoalCompletionFallbackSignal | null {
  const matchingLines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith(ANTIGRAVITY_GOAL_COMPLETE_FALLBACK_PREFIX))
  if (matchingLines.length !== 1) return null

  const serialized = matchingLines[0].slice(ANTIGRAVITY_GOAL_COMPLETE_FALLBACK_PREFIX.length)
  let parsed: unknown
  try {
    parsed = JSON.parse(serialized)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null

  const candidate = parsed as Record<string, unknown>
  if (Object.keys(candidate).some((key) => key !== 'summary')) return null
  const summary = normalizedSummary(candidate.summary)
  return summary ? { summary } : null
}
