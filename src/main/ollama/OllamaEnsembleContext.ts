import { resolveContextWindow } from '../../shared/contextWindows'
import { resolveOllamaModelFamily } from './OllamaModelPreflight'

/** Fallback transcript budget when older ensemble chats have no saved slider value. */
export const OLLAMA_ENSEMBLE_MAX_TRANSCRIPT_CHARS = 24_000

/** Turn window cap paired with the char budget above. */
export const OLLAMA_ENSEMBLE_MAX_CONTEXT_TURNS = 6

/** Conservative default retained for malformed/no-model contexts. */
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
const PANEL_CONTEXT_HEADER = 'Recent panel context:'
const CURRENT_REQUEST_HEADER = 'Current user request:'
const ENSEMBLE_COMPACT_MARKER = '[ensemble prompt compacted for Ollama context]'
const TRANSCRIPT_COMPACT_MARKER = '[transcript compacted for Ollama context]'
const PANEL_COMPACT_MARKER = '[panel context compacted for Ollama context]'
const DEFAULT_SHELL_CHARS_FALLBACK = 5_800

/** Ends the pinned Current user request block (header + body). */
const REQUEST_BLOCK_END_RE =
  /\n\n(?=(?:Recent panel context:|Recent tagged transcript:|Your role instructions:|Participant roster:|Do this turn:|Role boundary contract:|Authority and role boundary:|Dynamic ensemble state:|Workspace subject:|Workspace churn:|Scout briefs:|Shared blackboard|Bounded prior-seat summary:|Respond now as |You are a LOCAL model))/

export type OllamaContextPressureSeverity = 'ok' | 'warn' | 'critical'

export interface OllamaContextPressure {
  estimatedPromptTokens: number
  contextLimit: number
  contextKnown: boolean
  reservedForGeneration: number
  usagePercent: number
  severity: OllamaContextPressureSeverity
  effectiveTranscriptChars: number
  autoCompacted: boolean
}

export interface OllamaEnsembleUiPressureCandidate {
  modelId?: string | null
  ollamaContextLength?: number
}

const OLLAMA_CONTEXT_PRESSURE_SEVERITY_RANK: Record<OllamaContextPressureSeverity, number> = {
  ok: 0,
  warn: 1,
  critical: 2
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
    return Math.floor(contextLength)
  }
  const trimmedModelId = String(modelId || '').trim()
  if (!trimmedModelId) return OLLAMA_CONSERVATIVE_CONTEXT_TOKENS
  if (resolveOllamaModelFamily(trimmedModelId) === 'unknown') {
    return OLLAMA_CONSERVATIVE_CONTEXT_TOKENS
  }
  return resolveContextWindow('ollama', trimmedModelId)
}

export function hasKnownOllamaContextTokenLimit(
  modelId?: string | null,
  contextLength?: number
): boolean {
  if (typeof contextLength === 'number' && Number.isFinite(contextLength) && contextLength >= 2048) {
    return true
  }
  const trimmedModelId = String(modelId || '').trim()
  return Boolean(trimmedModelId) && resolveOllamaModelFamily(trimmedModelId) !== 'unknown'
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
  let contextChars = Math.min(configuredChars, Math.max(minTranscriptChars, maxTranscriptChars))
  let contextTurns =
    contextChars < configuredChars
      ? Math.min(configuredTurns, OLLAMA_ENSEMBLE_MAX_CONTEXT_TURNS)
      : configuredTurns

  if (maxTranscriptChars < minTranscriptChars) {
    contextChars = Math.max(1_500, maxTranscriptChars)
    contextTurns = Math.min(contextTurns, 2)
  }

  const autoCompacted = contextChars < configuredChars || contextTurns < configuredTurns

  return { contextChars, contextTurns, autoCompacted }
}

/** Chars before the shrinkable transcript/panel body for ensemble budget math. */
export function resolveOllamaEnsemblePromptShellChars(prompt: string): number {
  const value = String(prompt || '')
  const panelIdx = value.indexOf(PANEL_CONTEXT_HEADER)
  if (panelIdx >= 0) return panelIdx
  const transcriptIdx = value.indexOf(TRANSCRIPT_SECTION_HEADER)
  if (transcriptIdx >= 0) return transcriptIdx
  const requestIdx = value.indexOf(CURRENT_REQUEST_HEADER)
  if (requestIdx > 0) return requestIdx
  return DEFAULT_SHELL_CHARS_FALLBACK
}

function findRequestBlockRange(value: string): { start: number; end: number } | null {
  const start = value.indexOf(CURRENT_REQUEST_HEADER)
  if (start < 0) return null
  const afterHeader = value.slice(start + CURRENT_REQUEST_HEADER.length)
  const endMatch = afterHeader.match(REQUEST_BLOCK_END_RE)
  const end =
    endMatch && typeof endMatch.index === 'number'
      ? start + CURRENT_REQUEST_HEADER.length + endMatch.index
      : value.length
  return { start, end }
}

function findRespondTail(value: string): string {
  const match = value.match(/\nRespond now as \[[^\]]*\]\.?\s*$/)
  return match?.[0] ?? ''
}

function compactFillableBody(body: string, budget: number, marker: string): string {
  const trimmed = body.trim()
  if (trimmed.length <= budget) return trimmed
  const keep = Math.max(0, budget - marker.length - 1)
  return `${trimmed.slice(0, keep)}\n${marker}`
}

function compactCapsulePanelLayout(value: string, maxChars: number, requestRange: {
  start: number
  end: number
}): string {
  const panelIdx = value.indexOf(PANEL_CONTEXT_HEADER)
  if (panelIdx < 0 || panelIdx < requestRange.end) return ''

  const prefix = value.slice(0, panelIdx + PANEL_CONTEXT_HEADER.length)
  const afterHeader = value.slice(panelIdx + PANEL_CONTEXT_HEADER.length)
  const respondTail = findRespondTail(afterHeader)
  const panelBody = respondTail
    ? afterHeader.slice(0, afterHeader.length - respondTail.length)
    : afterHeader
  const overhead = prefix.length + respondTail.length + 2
  if (prefix.length + respondTail.length > maxChars) {
    // Prefix alone still over budget: pin request, shrink middle shell, keep respond tail.
    return pinRequestAndFill(value, maxChars, requestRange, respondTail)
  }
  const panelBudget = Math.max(0, maxChars - overhead)
  const compactedPanel = compactFillableBody(panelBody, panelBudget, PANEL_COMPACT_MARKER)
  return `${prefix}\n${compactedPanel}${respondTail}`
}

function compactClassicTranscriptLayout(value: string, maxChars: number, requestIdx: number): string {
  const transcriptIdx = value.indexOf(TRANSCRIPT_SECTION_HEADER)
  if (transcriptIdx < 0 || requestIdx <= transcriptIdx) return ''

  const prefix = value.slice(0, transcriptIdx + TRANSCRIPT_SECTION_HEADER.length)
  const suffix = value.slice(requestIdx)
  const transcriptBudget = Math.max(800, maxChars - prefix.length - suffix.length - 80)
  const transcriptBody = value
    .slice(transcriptIdx + TRANSCRIPT_SECTION_HEADER.length, requestIdx)
    .trim()
  const compactedTranscript = compactFillableBody(
    transcriptBody,
    transcriptBudget,
    TRANSCRIPT_COMPACT_MARKER
  )
  return `${prefix}\n${compactedTranscript}\n\n${suffix}`
}

function pinRequestAndFill(
  value: string,
  maxChars: number,
  requestRange: { start: number; end: number },
  respondTail = ''
): string {
  const requestBlock = value.slice(requestRange.start, requestRange.end).trimEnd()
  const titlePrefix = value.slice(0, requestRange.start).trimEnd()
  const afterRequest = value.slice(requestRange.end)
  const tail =
    respondTail ||
    findRespondTail(afterRequest) ||
    (afterRequest.trim() ? `\n\n${ENSEMBLE_COMPACT_MARKER}` : `\n${ENSEMBLE_COMPACT_MARKER}`)

  // Always keep the full request block when possible.
  if (requestBlock.length + 1 >= maxChars) {
    const keep = Math.max(0, maxChars - ENSEMBLE_COMPACT_MARKER.length - 1)
    return `${requestBlock.slice(0, keep)}\n${ENSEMBLE_COMPACT_MARKER}`
  }

  const remaining = maxChars - requestBlock.length - tail.length
  if (remaining <= 0) {
    return `${requestBlock}${tail}`.slice(0, maxChars)
  }

  // Prefer a short title/shell prefix before the request, then optional mid fill.
  const prefixBudget = Math.min(titlePrefix.length, Math.max(0, Math.floor(remaining * 0.55)))
  const keptPrefix =
    prefixBudget >= titlePrefix.length
      ? titlePrefix
      : titlePrefix.slice(0, Math.max(0, prefixBudget - 24)).trimEnd()

  const used = (keptPrefix ? keptPrefix.length + 2 : 0) + requestBlock.length + tail.length
  const midBudget = Math.max(0, maxChars - used)
  const midSource = afterRequest.replace(/\nRespond now as \[[^\]]*\]\.?\s*$/, '').trim()
  const mid =
    midBudget > 64 && midSource
      ? `\n${compactFillableBody(midSource, midBudget, ENSEMBLE_COMPACT_MARKER)}\n`
      : keptPrefix || midSource
        ? '\n\n'
        : ''

  const parts = [
    keptPrefix,
    keptPrefix ? '\n\n' : '',
    requestBlock,
    mid.startsWith('\n') ? mid : mid ? `\n${mid}` : '',
    tail.startsWith('\n') ? tail : tail ? `\n${tail}` : ''
  ]
  let assembled = parts.join('')
  if (assembled.length > maxChars) {
    assembled = `${requestBlock}\n${ENSEMBLE_COMPACT_MARKER}`
  }
  return assembled
}

export function compactOllamaEnsemblePromptText(prompt: string, maxChars: number): string {
  const value = (prompt || '').trim()
  if (!value || value.length <= maxChars) return value

  const requestRange = findRequestBlockRange(value)
  const requestIdx = requestRange?.start ?? value.indexOf(CURRENT_REQUEST_HEADER)
  const panelIdx = value.indexOf(PANEL_CONTEXT_HEADER)
  const transcriptIdx = value.indexOf(TRANSCRIPT_SECTION_HEADER)

  // Capsule: request-first, Recent panel context near the end — shrink panel body only.
  if (requestRange && panelIdx > requestRange.end) {
    const capsule = compactCapsulePanelLayout(value, maxChars, requestRange)
    if (capsule) return capsule
  }

  // Classic: Recent tagged transcript before request — shrink the middle transcript body.
  if (transcriptIdx >= 0 && requestIdx > transcriptIdx) {
    const classic = compactClassicTranscriptLayout(value, maxChars, requestIdx)
    if (classic) return classic
  }

  // Fallback: never bare-slice through the request; pin the request block first.
  if (requestRange) {
    return pinRequestAndFill(value, maxChars, requestRange)
  }

  return `${value.slice(0, Math.max(0, maxChars - ENSEMBLE_COMPACT_MARKER.length - 1))}\n${ENSEMBLE_COMPACT_MARKER}`
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
  const contextKnown = hasKnownOllamaContextTokenLimit(
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
    contextKnown,
    reservedForGeneration: OLLAMA_GENERATION_RESERVE_TOKENS,
    usagePercent,
    severity,
    effectiveTranscriptChars: budget.contextChars,
    autoCompacted: budget.autoCompacted
  }
}

export function estimateWorstOllamaEnsembleUiPressure(input: {
  configuredContextChars?: number
  participantCount: number
  ollamaParticipants: OllamaEnsembleUiPressureCandidate[]
  toolsEnabled?: boolean
  /** Approximate chars of ensemble shell (rules/roster) without transcript. */
  promptShellChars?: number
}): OllamaContextPressure | null {
  if (input.ollamaParticipants.length === 0) return null
  return input.ollamaParticipants.reduce<OllamaContextPressure | null>((worst, participant) => {
    const pressure = estimateOllamaEnsembleUiPressure({
      configuredContextChars: input.configuredContextChars,
      participantCount: input.participantCount,
      ollamaModelId: participant.modelId,
      ollamaContextLength: participant.ollamaContextLength,
      toolsEnabled: input.toolsEnabled,
      promptShellChars: input.promptShellChars
    })
    if (!pressure.contextKnown) return worst
    if (!worst) return pressure
    const pressureRank = OLLAMA_CONTEXT_PRESSURE_SEVERITY_RANK[pressure.severity]
    const worstRank = OLLAMA_CONTEXT_PRESSURE_SEVERITY_RANK[worst.severity]
    if (pressureRank !== worstRank) return pressureRank > worstRank ? pressure : worst
    if (pressure.usagePercent !== worst.usagePercent) {
      return pressure.usagePercent > worst.usagePercent ? pressure : worst
    }
    return pressure.contextLimit < worst.contextLimit ? pressure : worst
  }, null)
}

export function ollamaContextPressureMessage(pressure: OllamaContextPressure): string {
  if (!pressure.contextKnown) {
    return 'Ollama context metadata is not available yet. Refresh local models so TaskWraith can size shared history from the installed model window.'
  }
  if (pressure.severity === 'critical') {
    return `Ollama context ~${pressure.usagePercent}% full (~${pressure.estimatedPromptTokens}/${pressure.contextLimit} tokens). Transcript auto-compacts to ~${formatK(
      pressure.effectiveTranscriptChars
    )} chars — lower Shared history or bind a smaller panel.`
  }
  if (pressure.severity === 'warn') {
    return `Ollama context ~${pressure.usagePercent}% full. Locals auto-compact transcript to ~${formatK(
      pressure.effectiveTranscriptChars
    )} chars; other participants still use their configured budgets.`
  }
  return `Ollama transcript capped at ~${formatK(
    pressure.effectiveTranscriptChars
  )} chars so generation keeps headroom.`
}

function formatK(chars: number): string {
  return chars >= 1000 ? `${Math.round(chars / 1000)}K` : `${chars}`
}
