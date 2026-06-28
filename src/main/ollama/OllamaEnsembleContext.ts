import { resolveOllamaModelFamily } from './OllamaModelPreflight'

/** Compact transcript cap for Ollama ensemble participants. */
export const OLLAMA_ENSEMBLE_MAX_TRANSCRIPT_CHARS = 10_000

/** Turn window cap paired with the char budget above. */
export const OLLAMA_ENSEMBLE_MAX_CONTEXT_TURNS = 4

/** Conservative default when Ollama metadata is unavailable. */
export const OLLAMA_CONSERVATIVE_CONTEXT_TOKENS = 4096

/** Tokens reserved for model output so prompts do not fill 100% of ctx. */
export const OLLAMA_GENERATION_RESERVE_TOKENS = 768

/** Rough token overhead for compact vs full native tool schemas. */
export const OLLAMA_COMPACT_TOOL_SCHEMA_TOKENS = 620
export const OLLAMA_FULL_TOOL_SCHEMA_TOKENS = 1180

/** Tool system prompt + family lines (ensemble uses a shorter variant). */
export const OLLAMA_TOOL_SYSTEM_PROMPT_TOKENS = 420
export const OLLAMA_COMPACT_TOOL_SYSTEM_PROMPT_TOKENS = 260

const TRANSCRIPT_SECTION_HEADER = 'Recent tagged transcript:'
const CURRENT_REQUEST_HEADER = 'Current user request:'

export type OllamaContextPressureSeverity = 'ok' | 'warn' | 'critical'

export interface OllamaContextPressure {
  estimatedPromptTokens: number
  contextLimit: number
  reservedForGeneration: number
  usagePercent: number
  severity: OllamaContextPressureSeverity
  effectiveTranscriptChars: number
  autoCompacted: boolean
}

export function estimateTextTokens(text: string): number {
  const chars = (text || '').length
  if (!chars) return 0
  // Code-heavy ensemble transcripts tokenize slightly denser than prose.
  return Math.ceil(chars / 3.5)
}

export function resolveOllamaContextTokenLimit(
  modelId?: string | null,
  contextLength?: number
): number {
  if (typeof contextLength === 'number' && Number.isFinite(contextLength) && contextLength >= 2048) {
    return Math.min(Math.floor(contextLength), 131_072)
  }
  const family = resolveOllamaModelFamily(modelId || '')
  if (family === 'gpt_oss_20b') return 8192
  if (
    family === 'gemma4_12b' ||
    family === 'qwen3_5_9b' ||
    family === 'qwen3_6_35b' ||
    family === 'minicpm_v45_8b' ||
    family === 'granite4_1_3b' ||
    family === 'granite4_1_30b' ||
    family === 'ornith_9b' ||
    family === 'ornith_35b' ||
    family === 'nemotron3_33b'
  ) return 8192
  if (family === 'qwen3_4b') return 4096
  return OLLAMA_CONSERVATIVE_CONTEXT_TOKENS
}

export function estimateOllamaEnsemblePromptTokens(input: {
  promptChars: number
  compactToolSchema?: boolean
  toolsEnabled?: boolean
}): number {
  const promptTokens = estimateTextTokens('x'.repeat(Math.max(0, input.promptChars)))
  if (!input.toolsEnabled) return promptTokens
  const toolTokens = input.compactToolSchema
    ? OLLAMA_COMPACT_TOOL_SCHEMA_TOKENS
    : OLLAMA_FULL_TOOL_SCHEMA_TOKENS
  const systemTokens = input.compactToolSchema
    ? OLLAMA_COMPACT_TOOL_SYSTEM_PROMPT_TOKENS
    : OLLAMA_TOOL_SYSTEM_PROMPT_TOKENS
  return promptTokens + toolTokens + systemTokens
}

export function assessOllamaContextPressure(input: {
  estimatedPromptTokens: number
  contextLimit: number
  reservedForGeneration?: number
}): Pick<OllamaContextPressure, 'usagePercent' | 'severity'> {
  const reserve = input.reservedForGeneration ?? OLLAMA_GENERATION_RESERVE_TOKENS
  const available = Math.max(512, input.contextLimit - reserve)
  const usagePercent = Math.min(
    100,
    Math.round((input.estimatedPromptTokens / available) * 100)
  )
  const severity: OllamaContextPressureSeverity =
    usagePercent >= 95 ? 'critical' : usagePercent >= 80 ? 'warn' : 'ok'
  return { usagePercent, severity }
}

export function resolveOllamaEnsembleTranscriptCharsForBudget(input: {
  configuredChars?: number
  configuredTurns?: number
  promptWithoutTranscriptChars: number
  modelId?: string | null
  contextLength?: number
  toolsEnabled?: boolean
}): {
  contextChars: number
  contextTurns: number
  autoCompacted: boolean
} {
  const configuredChars = input.configuredChars ?? OLLAMA_ENSEMBLE_MAX_TRANSCRIPT_CHARS
  const configuredTurns = input.configuredTurns ?? 6
  const ceiling = Math.min(configuredChars, OLLAMA_ENSEMBLE_MAX_TRANSCRIPT_CHARS)
  const contextLimit = resolveOllamaContextTokenLimit(input.modelId, input.contextLength)
  const reserve = OLLAMA_GENERATION_RESERVE_TOKENS
  const toolOverhead = input.toolsEnabled ? OLLAMA_COMPACT_TOOL_SCHEMA_TOKENS : 0
  const systemOverhead = input.toolsEnabled ? OLLAMA_COMPACT_TOOL_SYSTEM_PROMPT_TOKENS : 0
  const baseTokens =
    estimateTextTokens('x'.repeat(Math.max(0, input.promptWithoutTranscriptChars))) +
    toolOverhead +
    systemOverhead
  const availableForTranscript = Math.max(
    0,
    contextLimit - reserve - baseTokens
  )
  const maxTranscriptChars = Math.floor(availableForTranscript * 3.5)
  const minTranscriptChars = 2_500
  let contextChars = Math.min(ceiling, Math.max(minTranscriptChars, maxTranscriptChars))
  let contextTurns = Math.min(configuredTurns, OLLAMA_ENSEMBLE_MAX_CONTEXT_TURNS)
  const autoCompacted = contextChars < ceiling || contextTurns < configuredTurns

  if (maxTranscriptChars < minTranscriptChars) {
    contextChars = Math.max(1_500, maxTranscriptChars)
    contextTurns = Math.min(contextTurns, 2)
  }

  return { contextChars, contextTurns, autoCompacted }
}

export function compactOllamaEnsemblePromptText(prompt: string, maxChars: number): string {
  const value = (prompt || '').trim()
  if (!value || value.length <= maxChars) return value

  const transcriptIdx = value.indexOf(TRANSCRIPT_SECTION_HEADER)
  const requestIdx = value.indexOf(CURRENT_REQUEST_HEADER)
  if (transcriptIdx < 0 || requestIdx <= transcriptIdx) {
    return `${value.slice(0, Math.max(0, maxChars - 48))}\n[ensemble prompt compacted for Ollama context]`
  }

  const prefix = value.slice(0, transcriptIdx + TRANSCRIPT_SECTION_HEADER.length)
  const suffix = value.slice(requestIdx)
  const suffixBudget = suffix.length
  const transcriptBudget = Math.max(800, maxChars - prefix.length - suffixBudget - 80)
  const transcriptBody = value
    .slice(transcriptIdx + TRANSCRIPT_SECTION_HEADER.length, requestIdx)
    .trim()
  const compactedTranscript =
    transcriptBody.length <= transcriptBudget
      ? transcriptBody
      : `${transcriptBody.slice(0, Math.max(0, transcriptBudget - 64))}\n[transcript compacted for Ollama context]`

  return `${prefix}\n${compactedTranscript}\n\n${suffix}`
}

export function estimateOllamaEnsembleUiPressure(input: {
  configuredContextChars?: number
  participantCount: number
  ollamaModelId?: string | null
  ollamaContextLength?: number
  toolsEnabled?: boolean
  /** Approximate chars of ensemble shell (rules/roster) without transcript. */
  promptShellChars?: number
}): OllamaContextPressure {
  const budget = resolveOllamaEnsembleTranscriptCharsForBudget({
    configuredChars: input.configuredContextChars,
    configuredTurns: 6,
    promptWithoutTranscriptChars: input.promptShellChars ?? 5_500,
    modelId: input.ollamaModelId,
    contextLength: input.ollamaContextLength,
    toolsEnabled: input.toolsEnabled ?? true
  })
  const promptChars =
    (input.promptShellChars ?? 5_500) + budget.contextChars + 120 * input.participantCount
  const estimatedPromptTokens = estimateOllamaEnsemblePromptTokens({
    promptChars,
    compactToolSchema: true,
    toolsEnabled: input.toolsEnabled ?? true
  })
  const contextLimit = resolveOllamaContextTokenLimit(
    input.ollamaModelId,
    input.ollamaContextLength
  )
  const { usagePercent, severity } = assessOllamaContextPressure({
    estimatedPromptTokens,
    contextLimit
  })
  return {
    estimatedPromptTokens,
    contextLimit,
    reservedForGeneration: OLLAMA_GENERATION_RESERVE_TOKENS,
    usagePercent,
    severity,
    effectiveTranscriptChars: budget.contextChars,
    autoCompacted: budget.autoCompacted
  }
}

export function ollamaContextPressureMessage(pressure: OllamaContextPressure): string {
  if (pressure.severity === 'critical') {
    return `Ollama context ~${pressure.usagePercent}% full (~${pressure.estimatedPromptTokens}/${pressure.contextLimit} tokens). Transcript auto-compacts to ~${formatK(
      pressure.effectiveTranscriptChars
    )} chars — lower Shared history or bind a smaller panel.`
  }
  if (pressure.severity === 'warn') {
    return `Ollama context ~${pressure.usagePercent}% full. Locals auto-compact transcript to ~${formatK(
      pressure.effectiveTranscriptChars
    )} chars; cloud providers still use the full budget.`
  }
  return `Ollama transcript capped at ~${formatK(
    pressure.effectiveTranscriptChars
  )} chars so generation keeps headroom.`
}

function formatK(chars: number): string {
  return chars >= 1000 ? `${Math.round(chars / 1000)}K` : `${chars}`
}
