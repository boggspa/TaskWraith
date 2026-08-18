export const ANTIGRAVITY_GOAL_COMPLETE_FALLBACK_PREFIX = 'TASKWRAITH_GOAL_COMPLETE '
export const ANTIGRAVITY_GOAL_SET_FALLBACK_PREFIX = 'TASKWRAITH_GOAL_SET '

const MAX_GOAL_COMPLETION_SUMMARY_CHARS = 500
const MAX_GOAL_SET_OBJECTIVE_CHARS = 2_000

export interface AntigravityGoalCompletionFallbackSignal {
  summary: string
}

export interface AntigravityGoalSetFallbackSignal {
  objective: string
}

function normalizedSummary(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, MAX_GOAL_COMPLETION_SUMMARY_CHARS) : ''
}

function normalizedObjective(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, MAX_GOAL_SET_OBJECTIVE_CHARS) : ''
}

/**
 * One strict standalone signal line per protocol. Exactly one matching line
 * may appear; the payload must be a flat JSON object holding only the allowed
 * key. Model-transcribed identities (goal/round/run ids) are rejected — the
 * host binds the signal to the exact live run and authority seat itself.
 */
function parseSingleFallbackLine(
  content: string,
  prefix: string,
  allowedKey: string
): Record<string, unknown> | null {
  const matchingLines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith(prefix))
  if (matchingLines.length !== 1) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(matchingLines[0].slice(prefix.length))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null

  const candidate = parsed as Record<string, unknown>
  if (Object.keys(candidate).some((key) => key !== allowedKey)) return null
  return candidate
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
  const candidate = parseSingleFallbackLine(
    content,
    ANTIGRAVITY_GOAL_COMPLETE_FALLBACK_PREFIX,
    'summary'
  )
  if (!candidate) return null
  const summary = normalizedSummary(candidate.summary)
  return summary ? { summary } : null
}

/**
 * Goal-SET twin of the completion fallback, for the same reason: the official
 * agy lane carries no TaskWraith MCP bridge, so an authority seat asked to
 * establish the thread goal has no tool to do it with (live incident
 * 2026-08-18: the fleet concluded goal creation was user-owned and stalled).
 * Offered only while NO unfinished goal exists; a stray set line while a goal
 * is active is ignored at apply time, so an agent cannot clobber a live
 * objective through this path.
 */
export function buildAntigravityGoalSetFallbackInstruction(): string {
  const payload = JSON.stringify({
    objective: 'One-sentence objective and stopping condition for this thread.'
  })
  return [
    'Host goal-lifecycle fallback (official agy has no TaskWraith MCP bridge):',
    '- Only if you are the current Boss or a configured Captain AND no unfinished TaskWraith goal exists, you may establish the thread goal by finishing your response with the exact standalone line below.',
    '- TaskWraith binds this signal to the exact live run and authority seat, and ignores it while a goal is already active. Replace only objective with the goal text; do not add IDs or fields.',
    `${ANTIGRAVITY_GOAL_SET_FALLBACK_PREFIX}${payload}`
  ].join('\n')
}

export function parseAntigravityGoalSetFallback(
  content: string
): AntigravityGoalSetFallbackSignal | null {
  const candidate = parseSingleFallbackLine(
    content,
    ANTIGRAVITY_GOAL_SET_FALLBACK_PREFIX,
    'objective'
  )
  if (!candidate) return null
  const objective = normalizedObjective(candidate.objective)
  return objective ? { objective } : null
}
