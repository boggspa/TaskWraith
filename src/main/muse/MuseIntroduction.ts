import { runMuseProvider, type MuseRunInput } from './MuseRun'
import type { MuseProviderStats } from './MuseUsage'

export interface MuseIntroductionInput extends Pick<
  MuseRunInput,
  | 'binaryPath'
  | 'workspacePath'
  | 'prompt'
  | 'runId'
  | 'temporaryRoot'
  | 'model'
  | 'apiKey'
  | 'authJsonText'
  | 'spawn'
  | 'shouldCancel'
> {
  run?: typeof runMuseProvider
  timeoutMs?: number
}

export interface MuseIntroductionResult {
  text: string | null
  stats?: MuseProviderStats
  warning?: string
}

export function museIntroductionPrompt(request: string): string {
  return [
    'Write the user-facing opening for the task below. The host will immediately start your working phase after displaying this opening.',
    "Return one short first-person sentence acknowledging the request and explaining your next concrete action. Use the user's language. Return only the opening sentence, with no heading.",
    'This phase only writes the acknowledgment. Do not use tools, inspect files, carry out the task, claim completed work, ask a question, or give the final answer.',
    'Task and conversation context:',
    request
  ].join('\n\n')
}

/** Private provider call: its terminal event never settles the user's run. */
export async function generateMuseIntroduction(
  input: MuseIntroductionInput
): Promise<MuseIntroductionResult> {
  if (/^\s*\//.test(input.prompt) || input.shouldCancel?.()) return { text: null }
  const deadline = Date.now() + (input.timeoutMs ?? 30_000)
  let usedTool = false
  try {
    const outcome = await (input.run ?? runMuseProvider)({
      binaryPath: input.binaryPath,
      workspacePath: input.workspacePath,
      prompt: museIntroductionPrompt(input.prompt),
      runId: `${input.runId}-introduction`,
      temporaryRoot: input.temporaryRoot,
      model: input.model,
      apiKey: input.apiKey,
      authJsonText: input.authJsonText,
      introductionOnly: true,
      spawn: input.spawn,
      shouldCancel: () => Boolean(input.shouldCancel?.() || Date.now() >= deadline),
      onEvent: (event) => {
        if (event.type === 'tool_use') usedTool = true
      }
    })
    const text = outcome.assistantText.trim()
    if (outcome.status === 'success' && !usedTool && text) {
      return { text: text.slice(0, 600), stats: outcome.providerStats }
    }
    return {
      text: null,
      stats: outcome.providerStats,
      ...(input.shouldCancel?.()
        ? {}
        : { warning: 'Muse did not return an opening; continuing with the task.' })
    }
  } catch {
    return { text: null, warning: 'Muse introduction was unavailable; continuing with the task.' }
  }
}

/** Count both native phases once while keeping missing usage explicitly unreported. */
export function museStatsWithIntroduction(
  work: MuseProviderStats,
  introduction?: MuseProviderStats
): MuseProviderStats {
  if (!introduction) return work
  const stats = { ...work }
  for (const key of [
    'input_tokens',
    'output_tokens',
    'total_tokens',
    'cache_read_input_tokens',
    'cache_creation_input_tokens',
    'reasoning_tokens',
    'duration_ms'
  ] as const)
    stats[key] += introduction[key]
  if (work.total_cost_usd !== undefined || introduction.total_cost_usd !== undefined) {
    stats.total_cost_usd = (work.total_cost_usd ?? 0) + (introduction.total_cost_usd ?? 0)
  }
  if (
    work._taskwraith_token_count_confidence !== 'reported' ||
    introduction._taskwraith_token_count_confidence !== 'reported'
  ) {
    stats._taskwraith_token_count_confidence = 'unavailable'
  }
  return stats
}
