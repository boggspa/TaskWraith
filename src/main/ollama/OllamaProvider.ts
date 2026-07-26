import { execFile } from 'child_process'
import { promisify } from 'util'
import { normalizeProviderUsage } from '../ProviderRunStats'
import { buildProviderCapabilityContract } from '../ProviderCapabilities'
import { canonicalTaskWraithToolName } from '../TaskWraithMcpTools'
import {
  gatewayToolDefinitions,
  isCapabilityGatewayToolName,
  type CapabilityGatewayToolName
} from '../mcp/McpToolGateway'
import type { AgentRunPayload, AgentRunRoute } from '../run/AgentRunTypes'
import type { HostCommandProjectionHandle } from '../run/HostCommandOperationRegistry'
import type { RunManager, RunSessionStatus } from '../RunManager'
import type { AppSettings, OllamaToolControlTier, ProviderCapabilityContract } from '../store/types'
import {
  evaluateOllamaModelPreflight,
  ollamaModelPreflightKey,
  shouldRunOllamaModelPreflight,
  type OllamaModelPreflightResult
} from './OllamaModelPreflight'
import {
  compactOllamaEnsemblePromptText,
  resolveOllamaEnsembleTranscriptCharsForBudget
} from './OllamaEnsembleContext'
import {
  appendOllamaTrajectoryEntry,
  compressOllamaMessagesWithWorkingMemory,
  pruneOllamaSessionMemoryForPersist,
  shouldRollOllamaRunSummary,
  type OllamaSessionMemory
} from './OllamaRunMemory'
import { ollamaPrefersJsonToolProtocol } from './OllamaModelProtocol'
import {
  createOllamaHarnessRunState,
  evaluateOllamaHarnessGate,
  ollamaEnsembleHarnessKickoffPrompt,
  ollamaHarnessKickoffPrompt,
  ollamaHarnessToolFollowUpPrompt,
  recordOllamaHarnessToolResult,
  type OllamaHarnessRunState
} from './OllamaHarnessGates'
import { summarizeOllamaToolResult } from './OllamaToolResultSummary'
import type { CanvasEvalApprovalReceipt } from '../canvas/canvasTypes'
import type { OllamaPromptIntent } from './OllamaPromptIntent'
import { ollamaLocalToolSystemPrompt } from './OllamaModelProfiles'
import { buildOllamaWorkspaceIndexBlock } from './OllamaWorkspaceIndex'
import {
  OLLAMA_TOOL_HELP_NAME,
  mergeOllamaModelShow,
  ollamaModelIdsMatch,
  ollamaSessionMemoryKeyForParticipant,
  ollamaToolCallFormatSchema,
  resolveOllamaFinalLaunchPlan
} from './OllamaLaunchPlan'

export { ollamaLocalToolSystemPrompt } from './OllamaModelProfiles'
export {
  OLLAMA_TOOL_HELP_NAME,
  extractOllamaShowContextLength,
  ollamaModelSupportsNativeTools,
  ollamaToolCallFormatSchema
} from './OllamaLaunchPlan'
import {
  OLLAMA_ADVERTISED_TOOL_NAMES,
  OLLAMA_KNOWN_TOOL_NAMES,
  ollamaAdvertisedToolNames,
  ollamaToolIntent,
  ollamaToolNamesForTier,
  type OllamaToolName
} from './OllamaToolTiers'

export const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434'
const OLLAMA_MEMORY_POLL_INTERVAL_MS = 5_000
const execFileAsync = promisify(execFile)

export interface OllamaModelInfo {
  id: string
  label: string
  description?: string
  isDefault?: boolean
  sizeBytes?: number
  digest?: string
  format?: string
  family?: string
  families?: string[]
  embeddingLength?: number
  contextLength?: number
  parameterSize?: string
  quantizationLevel?: string
  capabilities?: string[]
  show?: OllamaModelShowInfo
}

export interface OllamaModelShowInfo {
  license?: string
  modelfile?: string
  parameters?: string
  template?: string
  details?: {
    format?: string
    family?: string
    families?: string[]
    parameter_size?: string
    quantization_level?: string
    context_length?: number
  }
  model_info?: Record<string, unknown>
  capabilities?: string[]
}

export interface OllamaStatusSnapshot {
  available: boolean
  setupRequired: boolean
  baseUrl: string
  modelCount: number
  defaultModel?: string
  models?: OllamaModelInfo[]
  error?: string
}

export interface OllamaProcessMemoryEntry {
  pid: number
  rssBytes: number
  command: string
}

export interface OllamaProcessMemorySnapshot {
  sampledAt: string
  processCount: number
  rssBytes: number
  rssGb: number
  processes: OllamaProcessMemoryEntry[]
}

export interface OllamaProviderDeps {
  getSettings: () => Pick<
    AppSettings,
    | 'ollamaBaseUrl'
    | 'ollamaDefaultModel'
    | 'ollamaModelPreflightAt'
    | 'agenticServices'
    | 'geminiMcpBridgeEnabled'
    | 'codexSandboxFallback'
  >
  getTotalMemoryBytes?: () => number
  markOllamaModelPreflightComplete?: (modelId: string) => void
  emitOllamaModelPreflight?: (
    sender: Electron.WebContents,
    result: OllamaModelPreflightResult,
    route?: AgentRunRoute | null
  ) => void
  sendAgentCompatLine: (
    sender: Electron.WebContents,
    provider: 'ollama',
    payload: any,
    route?: AgentRunRoute | null
  ) => void
  sendAgentCompatError: (
    sender: Electron.WebContents,
    provider: 'ollama',
    error: string,
    route?: AgentRunRoute | null
  ) => void
  sendAgentCompatExit: (
    sender: Electron.WebContents,
    provider: 'ollama',
    code: number | null,
    route?: AgentRunRoute | null
  ) => void
  runManager: Pick<
    RunManager<any>,
    | 'attachAbortController'
    | 'canAdmitTransport'
    | 'getClaimedTerminalStatus'
    | 'finish'
    | 'confirmTerminalStatus'
  >
  emitProviderCapabilityWarnings?: (
    sender: Electron.WebContents,
    provider: 'ollama',
    workspacePath: string | undefined,
    approvalMode: string | undefined,
    route?: AgentRunRoute | null,
    options?: { excludeIds?: string[] }
  ) => Promise<void>
  executeTool?: (request: OllamaToolExecutionRequest) => Promise<OllamaToolExecutionResult>
  createHostCommandProjection?: (
    request: OllamaToolExecutionRequest
  ) => HostCommandProjectionHandle | null
  getOllamaSessionMemory?: (
    chatId: string,
    memoryKey?: string
  ) => OllamaSessionMemory | null | undefined
  saveOllamaSessionMemory?: (
    chatId: string,
    memory: OllamaSessionMemory,
    memoryKey?: string
  ) => void
}

interface OllamaTagsResponse {
  models?: Array<{
    name?: string
    model?: string
    size?: number
    digest?: string
    details?: {
      format?: string
      family?: string
      families?: string[]
      parameter_size?: string
      quantization_level?: string
      context_length?: number
      embedding_length?: number
    }
    capabilities?: string[]
  }>
}

type OllamaTagModel = NonNullable<OllamaTagsResponse['models']>[number]

interface OllamaNativeToolCall {
  function?: {
    name?: string
    /** Ollama returns parsed arguments as an object, but some builds emit a
     * JSON string. Accept both. */
    arguments?: Record<string, unknown> | string
  }
}

interface OllamaChatChunk {
  model?: string
  created_at?: string
  message?: {
    role?: string
    content?: string
    // Harmony-format models (e.g. gpt-oss) stream their answer into a
    // separate reasoning channel. Ollama surfaces it as `thinking`.
    thinking?: string
    // Models with native tool support (gpt-oss, qwen, etc.) return structured
    // calls here when the request includes a `tools` array.
    tool_calls?: OllamaNativeToolCall[]
  }
  done?: boolean
  error?: string
  prompt_eval_count?: number
  eval_count?: number
  total_duration?: number
  load_duration?: number
  prompt_eval_duration?: number
  eval_duration?: number
}

export interface OllamaChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  /** Echoed back on an assistant turn that made native tool calls so the model
   * keeps a coherent transcript across the stateless HTTP loop. */
  tool_calls?: OllamaNativeToolCall[]
  /** Names the tool a `role: 'tool'` result message answers. */
  tool_name?: string
}

interface OllamaChatTurnResult {
  content: string
  /** Accumulated harmony reasoning text (gpt-oss et al.), used as a fallback
   * when a model emits its answer into the thinking channel and leaves
   * `message.content` empty. */
  thinking: string
  /** Native structured tool calls (Ollama `tools` API). Preferred over the
   * legacy JSON-in-prose protocol when present. */
  toolCalls: OllamaToolRequest[]
  /** Names of native tool_calls that were DROPPED because the name is not a
   * known/callable tool (a hallucinated tool). Surfaced so the run loop can send
   * a name-specific "that tool doesn't exist" repair instead of a generic nudge. */
  droppedNativeToolNames: string[]
  lastDone: OllamaChatChunk | null
  parseErrors: string[]
  streamedContent: string
  streamedThinking: string
}

interface OllamaChatTurnStreamCallbackInput {
  delta: string
  content: string
  chunk: OllamaChatChunk
}

interface OllamaChatTurnThinkingCallbackInput {
  delta: string
  thinking: string
  content: string
  chunk: OllamaChatChunk
}

interface OllamaChatRetryCallbackInput {
  attempt: number
  maxAttempts: number
  delayMs: number
  error: string
}

// `tool_help` is a virtual, Ollama-only meta tool (NOT in the shared catalog):
// it returns one catalog tool's arg schema on demand so a text-protocol local
// model can look up a long-tail tool's exact arguments without the full doc.
// Native-calling models receive the compact direct schemas inline. Legacy
// tool_help remains a schema lookup, but hidden targets execute through
// capability_invoke rather than widening the callable name surface.
type OllamaDirectToolName = (typeof OLLAMA_ADVERTISED_TOOL_NAMES)[number]
export type OllamaCallableToolName =
  | OllamaDirectToolName
  | typeof OLLAMA_TOOL_HELP_NAME
  | CapabilityGatewayToolName

const OLLAMA_CAPABILITY_GATEWAY_PROMPT =
  'For an uncommon capability, call capability_search with {"query":"what you need","limit":4}; then call capability_invoke with {"name":"exact_tool_name","arguments":{...}}. The target keeps its own permissions and approval policy. The legacy tool_help lookup remains available.'

function isOllamaCallableToolName(name: string): name is OllamaCallableToolName {
  return (
    (OLLAMA_ADVERTISED_TOOL_NAMES as readonly string[]).includes(name) ||
    name === OLLAMA_TOOL_HELP_NAME ||
    isCapabilityGatewayToolName(name)
  )
}

export interface OllamaToolExecutionRequest {
  toolName: OllamaCallableToolName
  arguments: Record<string, unknown>
  workspacePath: string
  appChatId?: string
  appRunId?: string
  toolControlTier?: OllamaToolControlTier
}

export interface OllamaToolExecutionResult {
  ok: boolean
  output: string
  structuredContent?: unknown
  /** Out-of-band approval proof for privacy-safe durable canvas_eval memory. */
  canvasEvalApproval?: CanvasEvalApprovalReceipt
  tierBumpRequired?: boolean
  /** Set when the call failed pre-execution arg validation (missing required
   * field) — the run loop routes this to a narrow schema-repair nudge, distinct
   * from a genuine tool failure. */
  validationError?: boolean
}

export interface OllamaToolRequest {
  toolName: OllamaCallableToolName
  arguments: Record<string, unknown>
}

export function ollamaSessionMemoryKeyForRun(payload: AgentRunPayload): string | undefined {
  return ollamaSessionMemoryKeyForParticipant(payload.ensembleRun?.participantId) ?? undefined
}

const OLLAMA_TOOL_RESULT_MAX_CHARS = 8000
// Finalize gracefully after this many CONSECUTIVE non-productive turns (empty,
// reasoning-only, malformed tool JSON, tool-intent stub, arg-invalid, degenerate)
// instead of nudging the model forever.
// Exported for the scheduled-occurrence seal evidence layer, which must bind
// the exact runtime constants dispatch enforces rather than duplicating them.
export const OLLAMA_MAX_CONSECUTIVE_NON_PRODUCTIVE_TURNS = 4
export const OLLAMA_CHAT_TRANSPORT_RETRY_DELAYS_MS = [250, 750]
const OLLAMA_LOCAL_TOOL_SERVER = 'TaskWraith-local'

export interface OllamaOpeningMessagesInput {
  toolProtocolEnabled: boolean
  harnessEnabled: boolean
  promptIntent: OllamaPromptIntent
  toolControlTier: OllamaToolControlTier | string | undefined | null
  networkAccess?: string | null
  readOnly?: boolean
  model: string
  workspaceIndexBlock: string
  userPrompt: string
  ensembleRun?: boolean
}

/** Opening transcript for a local run. Workspace intent gets the full harness
 * scaffold (workflow system line, workspace index, todo-first kickoff after
 * the request); conversational intent gets only the tool catalog and the
 * user's words, so small models answer the person instead of the harness. */
export function buildOllamaOpeningMessages(input: OllamaOpeningMessagesInput): OllamaChatMessage[] {
  const workspaceIntent = input.promptIntent === 'workspace'
  const systemPromptParts = [
    input.toolProtocolEnabled
      ? [
          ollamaLocalToolSystemPrompt(input.toolControlTier, input.model, {
            intent: input.promptIntent,
            networkAccess: input.networkAccess,
            readOnly: input.readOnly
          }),
          OLLAMA_CAPABILITY_GATEWAY_PROMPT
        ].join('\n')
      : '',
    // Prompt economy (2026-07): the explore→read→edit workflow line used to live
    // here AND in the harness kickoff message below — triplicated with the family
    // lines. The anchored kickoff (which references the user's actual request) is
    // the single source now, so the standalone system line is dropped.
    workspaceIntent ? input.workspaceIndexBlock : ''
  ].filter(Boolean)
  return [
    ...(systemPromptParts.length
      ? [{ role: 'system' as const, content: systemPromptParts.join('\n\n') }]
      : []),
    { role: 'user' as const, content: input.userPrompt },
    ...(input.harnessEnabled && workspaceIntent
      ? [
          {
            role: 'user' as const,
            content: input.ensembleRun
              ? ollamaEnsembleHarnessKickoffPrompt(input.toolControlTier)
              : ollamaHarnessKickoffPrompt(input.toolControlTier)
          }
        ]
      : [])
  ]
}

export function truncateOllamaToolResultOutput(
  output: string,
  maxChars = OLLAMA_TOOL_RESULT_MAX_CHARS,
  toolName?: OllamaToolName | string
): string {
  if (toolName) return summarizeOllamaToolResult(toolName, output, maxChars)
  const value = String(output || '')
  if (value.length <= maxChars) return value
  return `${value.slice(0, maxChars)}\n[tool result truncated for selected Ollama context budget]`
}

/**
 * Order-independent JSON serialization so two tool calls with the same
 * arguments in a different key order still hash to the same key.
 */
function ollamaCanonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(ollamaCanonicalJson).join(',')}]`
  const obj = value as Record<string, unknown>
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${ollamaCanonicalJson(obj[k])}`)
    .join(',')}}`
}

/** Stable per-run key for a (toolName, arguments) pair. */
export function ollamaToolCallKey(toolName: string, args: Record<string, unknown>): string {
  return `${toolName}${ollamaCanonicalJson(args || {})}`
}

/**
 * Cheap change-detecting signature of a tool result. Length-prefixed
 * FNV-1a (32-bit) — collisions are astronomically unlikely for the
 * "did this file/result change between two identical calls" question,
 * and it avoids retaining full result bodies in memory.
 */
export function ollamaToolResultSignature(output: string): string {
  const value = String(output || '')
  let hash = 0x811c9dc5
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return `${value.length}:${(hash >>> 0).toString(16)}`
}

/**
 * Detect a no-op repeated tool call: the SAME tool + SAME arguments
 * returning the SAME result as an earlier call this run. Records the
 * signature on first/changed calls so a later re-read after an edit
 * (different result) is correctly treated as fresh, not a repeat. The
 * passed map is the per-run signature store and is mutated in place.
 */
export function evaluateOllamaRepeatedToolCall(
  signatures: Map<string, string>,
  toolName: string,
  args: Record<string, unknown>,
  output: string
): { repeated: boolean } {
  const key = ollamaToolCallKey(toolName, args)
  const signature = ollamaToolResultSignature(output)
  const previous = signatures.get(key)
  if (previous !== undefined && previous === signature) {
    return { repeated: true }
  }
  signatures.set(key, signature)
  return { repeated: false }
}

/**
 * Redirect fed to a local model that just repeated an identical tool
 * call. Enforces in code the "do not repeat an identical tool call"
 * rule that otherwise only lived in the system prompt — small models
 * (e.g. a 9B) ignore the soft rule and burn their whole tool-loop
 * budget re-reading the same file before they ever edit.
 */
export function ollamaRepeatedToolCallNudge(
  toolName: string,
  options?: OllamaRetryPromptOptions
): string {
  return [
    `You already called \`${toolName}\` with these exact arguments earlier this turn and got the same result, so its output is unchanged and already in your context.`,
    'Do NOT call it again.',
    ...ollamaEnsembleRetryReminder(options),
    options?.ensembleRun
      ? 'Act on what you have now inside your assigned ensemble slice: make only the edits your role owns, or give your final answer for this turn.'
      : 'Act on what you have now: make the edits the task needs (edit_file / write_file), or give your final answer.',
    'Repeating identical reads wastes your limited local tool budget and will end the run with no result.'
  ].join(' ')
}

const OLLAMA_GOAL_LIFECYCLE_TOOL_NAMES = new Set([
  'goal_update',
  'update_goal',
  'goal_complete',
  'goal_blocked'
])

export function isOllamaNoActiveGoalToolResult(
  toolName: string,
  result: Pick<OllamaToolExecutionResult, 'ok' | 'output'>
): boolean {
  return (
    !result.ok &&
    OLLAMA_GOAL_LIFECYCLE_TOOL_NAMES.has(toolName) &&
    result.output.includes('No active TaskWraith goal is set')
  )
}

export function ollamaNoActiveGoalToolNudge(
  toolName: string,
  options: { repeated?: boolean; ensembleRun?: boolean } = {}
): string {
  const prefix = options.repeated
    ? `You already retried \`${toolName}\`, but TaskWraith still has no active thread goal.`
    : `TaskWraith reported there is no active thread goal, so \`${toolName}\` cannot help this request.`
  return [
    prefix,
    'Do NOT call update_goal, goal_update, goal_complete, or goal_blocked again in this run.',
    'Those tools only change the lifecycle of an existing TaskWraith goal; they are not todo lists, progress notes, or planning tools.',
    ...ollamaEnsembleRetryReminder(options),
    options.ensembleRun
      ? 'Continue inside your assigned ensemble slice with the available workspace tools, or give a normal final answer with the next local step.'
      : 'Continue the user request with the available workspace tools, or give a normal final answer with the next local step.'
  ].join(' ')
}

export function normalizeOllamaBaseUrl(value?: string | null): string {
  const raw = String(value || '').trim() || DEFAULT_OLLAMA_BASE_URL
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return DEFAULT_OLLAMA_BASE_URL
    url.pathname = ''
    url.search = ''
    url.hash = ''
    return url.toString().replace(/\/+$/, '')
  } catch {
    return DEFAULT_OLLAMA_BASE_URL
  }
}

function endpoint(baseUrl: string | undefined | null, path: string): string {
  return `${normalizeOllamaBaseUrl(baseUrl)}${path.startsWith('/') ? path : `/${path}`}`
}

function unknownErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : ''
}

function errorCauseCode(error: unknown): string {
  const cause = recordFromUnknown((error as { cause?: unknown } | null)?.cause)
  const code = cause && typeof cause.code === 'string' ? cause.code : ''
  return code.toUpperCase()
}

function isAbortLikeError(error: unknown): boolean {
  return errorName(error) === 'AbortError' || errorCauseCode(error) === 'ABORT_ERR'
}

type OllamaTransportLaunchAuthority = () => boolean

class OllamaTransportLaunchDeniedError extends Error {
  constructor() {
    super('Ollama run cancelled before transport launch.')
    this.name = 'AbortError'
  }
}

function assertOllamaTransportLaunchAuthorized(
  signal: AbortSignal,
  launchAuthorized?: OllamaTransportLaunchAuthority
): void {
  if (signal.aborted || launchAuthorized?.() === false) {
    throw new OllamaTransportLaunchDeniedError()
  }
}

function isOllamaTransportError(error: unknown): boolean {
  if (isAbortLikeError(error)) return false
  const message = unknownErrorMessage(error).toLowerCase()
  const causeCode = errorCauseCode(error)
  return (
    message.includes('fetch failed') ||
    message.includes('terminated') ||
    message.includes('socket') ||
    message.includes('network') ||
    ['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'UND_ERR_SOCKET'].includes(causeCode)
  )
}

export function ollamaRunFailureMessage(error: unknown, baseUrl: string): string {
  if (isOllamaTransportError(error)) {
    return [
      `Ollama connection dropped while talking to ${normalizeOllamaBaseUrl(baseUrl)}.`,
      'TaskWraith retried the local chat request, but Ollama still closed or refused the connection.',
      'Make sure the Ollama app/service is running, the model is pulled, and the model runner is not being killed by memory pressure.',
      `Original error: ${unknownErrorMessage(error)}`
    ].join(' ')
  }
  return unknownErrorMessage(error)
}

function waitForOllamaRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'))
  return new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout | null = null
    const cleanup = () => {
      if (timer) clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    }
    const onAbort = () => {
      cleanup()
      reject(new DOMException('Aborted', 'AbortError'))
    }
    timer = setTimeout(() => {
      cleanup()
      resolve()
    }, delayMs)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export function humanizeOllamaModelId(model: string): string {
  const id = model.trim()
  const key = id.toLowerCase()
  if (key === 'qwen3:4b-instruct') return 'Qwen 3 (4B Param)'
  if (key === 'qwen3.5:9b' || key.startsWith('qwen3.5:9b-')) {
    return 'Qwen 3.5 (9B Param)'
  }
  if (key === 'qwen3.6:35b' || key.startsWith('qwen3.6:35b-')) {
    return 'Qwen 3.6 (35B-A3B)'
  }
  if (key === 'gemma4:12b' || key.startsWith('gemma4:12b-')) {
    return 'Gemma 4 (12B Param)'
  }
  if (
    key === 'ornith' ||
    key === 'ornith:latest' ||
    key === 'ornith:9b' ||
    key.startsWith('ornith:9b-')
  ) {
    return 'Ornith 1.0 (9B Param)'
  }
  if (key === 'ornith:35b' || key.startsWith('ornith:35b-')) {
    return 'Ornith 1.0 (35B Param)'
  }
  if (key === 'laguna-xs-2.1:q8_0') {
    return 'Laguna XS 2.1 (33B-A3B Q8)'
  }
  if (
    key === 'gpt-oss' ||
    key === 'gpt-oss:20b' ||
    key === 'gpt-oss:latest' ||
    key === 'openai/gpt-oss-20b'
  ) {
    return 'GPT OSS (20B Param)'
  }
  if (key === 'minicpm-v4.5:8b' || key.startsWith('minicpm-v4.5:8b-')) {
    return 'MiniCPM-V 4.5 (8B Param)'
  }
  if (key === 'granite4.1:3b' || key.startsWith('granite4.1:3b-')) {
    return 'Granite 4.1 (3B Param)'
  }
  if (key === 'granite4.1:30b' || key.startsWith('granite4.1:30b-')) {
    return 'Granite 4.1 (30B Param)'
  }
  if (key === 'nemotron3:33b' || key.startsWith('nemotron3:33b-')) {
    return 'Nemotron 3 Nano Omni (33B Param)'
  }
  return id
    .split(':')
    .map((part) => part.trim())
    .filter(Boolean)
    .join(':')
}

function modelDescription(model: OllamaTagModel): string | undefined {
  const details = model.details || {}
  const pieces = [
    details.family,
    details.parameter_size,
    details.quantization_level,
    typeof details.context_length === 'number' ? `${details.context_length.toLocaleString()} ctx` : ''
  ].filter(Boolean)
  return pieces.length > 0 ? pieces.join(' · ') : undefined
}

export function normalizeOllamaModels(
  response: OllamaTagsResponse,
  defaultModel?: string | null
): OllamaModelInfo[] {
  const seen = new Set<string>()
  const selectedDefault = String(defaultModel || '').trim()
  const normalized: OllamaModelInfo[] = []
  for (const entry of Array.isArray(response.models) ? response.models : []) {
    const id = String(entry.model || entry.name || '').trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    const info: OllamaModelInfo = {
      id,
      label: humanizeOllamaModelId(id),
      isDefault: selectedDefault ? ollamaModelIdsMatch(id, selectedDefault) : seen.size === 1
    }
    const description = modelDescription(entry)
    if (description) info.description = description
    if (typeof entry.size === 'number') info.sizeBytes = entry.size
    if (typeof entry.digest === 'string' && entry.digest.trim()) info.digest = entry.digest.trim()
    if (entry.details?.format) info.format = entry.details.format
    if (entry.details?.family) info.family = entry.details.family
    if (Array.isArray(entry.details?.families)) {
      const families = entry.details.families.filter(
        (item): item is string => typeof item === 'string' && item.trim().length > 0
      )
      if (families.length > 0) info.families = families
    }
    if (typeof entry.details?.context_length === 'number') {
      info.contextLength = entry.details.context_length
    }
    if (typeof entry.details?.embedding_length === 'number') {
      info.embeddingLength = entry.details.embedding_length
    }
    if (entry.details?.parameter_size) info.parameterSize = entry.details.parameter_size
    if (entry.details?.quantization_level) {
      info.quantizationLevel = entry.details.quantization_level
    }
    if (Array.isArray(entry.capabilities)) {
      const capabilities = entry.capabilities.filter(
        (item): item is string => typeof item === 'string'
      )
      if (capabilities.length > 0) info.capabilities = capabilities
    }
    normalized.push(info)
  }
  return normalized
}

function isOllamaModelRuntimeCommand(command: string): boolean {
  const lower = command.toLowerCase()
  if (lower.includes('llama-server')) return true
  if (lower.includes('ollama_llama_server')) return true
  return lower.includes('ollama') && lower.includes('runner')
}

export function parseOllamaMemoryPsOutput(
  stdout: string,
  sampledAt = new Date().toISOString()
): OllamaProcessMemorySnapshot | null {
  const processes: OllamaProcessMemoryEntry[] = []
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    const match = line.match(/^(\d+)\s+(\d+)\s+(.+)$/)
    if (!match) continue
    const command = match[3].trim()
    if (!isOllamaModelRuntimeCommand(command)) continue
    const pid = Number(match[1])
    const rssKb = Number(match[2])
    if (!Number.isFinite(pid) || !Number.isFinite(rssKb) || rssKb <= 0) continue
    processes.push({
      pid,
      rssBytes: Math.round(rssKb * 1024),
      command
    })
  }
  if (processes.length === 0) return null
  const rssBytes = processes.reduce((sum, process) => sum + process.rssBytes, 0)
  return {
    sampledAt,
    processCount: processes.length,
    rssBytes,
    rssGb: rssBytes / 1_000_000_000,
    processes
  }
}

export async function sampleOllamaLlamaServerMemory(): Promise<OllamaProcessMemorySnapshot | null> {
  try {
    const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,rss=,command='], {
      timeout: 2_000,
      maxBuffer: 1024 * 1024
    })
    return parseOllamaMemoryPsOutput(String(stdout))
  } catch {
    return null
  }
}

function ollamaHardwareStats(
  latest: OllamaProcessMemorySnapshot | null,
  peak: OllamaProcessMemorySnapshot | null,
  sampleCount: number
): Record<string, unknown> {
  if (!latest && !peak) return {}
  const selectedPeak = peak || latest
  const selectedLatest = latest || peak
  if (!selectedLatest || !selectedPeak) return {}
  return {
    ollamaMemoryRssBytes: selectedLatest.rssBytes,
    ollamaMemoryRssGb: selectedLatest.rssGb,
    ollamaMemoryPeakRssBytes: selectedPeak.rssBytes,
    ollamaMemoryPeakRssGb: selectedPeak.rssGb,
    ollamaMemoryProcessCount: selectedPeak.processCount,
    ollamaMemorySampleCount: sampleCount,
    ollamaMemorySampledAt: selectedPeak.sampledAt,
    hardware: {
      ram: {
        process: 'llama-server',
        rssBytes: selectedLatest.rssBytes,
        rssGb: selectedLatest.rssGb,
        peakRssBytes: selectedPeak.rssBytes,
        peakRssGb: selectedPeak.rssGb,
        processCount: selectedPeak.processCount,
        sampleCount,
        sampledAt: selectedPeak.sampledAt
      }
    }
  }
}

function createOllamaMemoryMonitor(intervalMs = OLLAMA_MEMORY_POLL_INTERVAL_MS) {
  let timer: NodeJS.Timeout | null = null
  let latest: OllamaProcessMemorySnapshot | null = null
  let peak: OllamaProcessMemorySnapshot | null = null
  let sampleCount = 0
  let inflight: Promise<void> | null = null

  const sample = async (): Promise<void> => {
    if (inflight) return inflight
    inflight = sampleOllamaLlamaServerMemory()
      .then((snapshot) => {
        if (!snapshot) return
        latest = snapshot
        sampleCount += 1
        if (!peak || snapshot.rssBytes > peak.rssBytes) {
          peak = snapshot
        }
      })
      .catch(() => {})
      .finally(() => {
        inflight = null
      })
    return inflight
  }

  return {
    start(): void {
      void sample()
      timer = setInterval(() => void sample(), intervalMs)
      timer.unref?.()
    },
    async stop(): Promise<Record<string, unknown>> {
      if (timer) {
        clearInterval(timer)
        timer = null
      }
      await sample()
      if (inflight) await inflight
      return ollamaHardwareStats(latest, peak, sampleCount)
    }
  }
}

export async function fetchOllamaModels(
  settings: Pick<AppSettings, 'ollamaBaseUrl' | 'ollamaDefaultModel'>,
  options: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<OllamaModelInfo[]> {
  const timeoutMs = options.timeoutMs ?? 3_000
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const signal = options.signal || controller.signal
  try {
    const response = await fetch(endpoint(settings.ollamaBaseUrl, '/api/tags'), { signal })
    if (!response.ok) {
      throw new Error(`Ollama model list failed with HTTP ${response.status}.`)
    }
    const json = (await response.json()) as OllamaTagsResponse
    return normalizeOllamaModels(json, settings.ollamaDefaultModel)
  } finally {
    clearTimeout(timer)
  }
}

async function fetchOllamaModelShow(
  baseUrl: string,
  model: string,
  options: {
    signal?: AbortSignal
    timeoutMs?: number
    launchAuthorized?: OllamaTransportLaunchAuthority
  } = {}
): Promise<OllamaModelShowInfo | null> {
  const timeoutMs = options.timeoutMs ?? 2_000
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const signal = options.signal || controller.signal
  try {
    assertOllamaTransportLaunchAuthorized(signal, options.launchAuthorized)
    const response = await fetch(endpoint(baseUrl, '/api/show'), {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model })
    })
    if (!response.ok) return null
    const parsed = (await response.json()) as OllamaModelShowInfo
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch (error) {
    // Status discovery treats an unavailable `/api/show` endpoint as optional,
    // but a provider run's exact Stop/terminal signal must cross this helper
    // instead of being mistaken for absent model metadata.
    if (options.signal?.aborted || error instanceof OllamaTransportLaunchDeniedError) throw error
    return null
  } finally {
    clearTimeout(timer)
  }
}

async function enrichOllamaModelsWithShowInfo(
  baseUrl: string,
  models: OllamaModelInfo[]
): Promise<OllamaModelInfo[]> {
  const targets = models.filter((model) => !model.contextLength).slice(0, 16)
  if (targets.length === 0) return models
  const showResults = await Promise.all(
    targets.map(async (model) => ({
      id: model.id,
      show: await fetchOllamaModelShow(baseUrl, model.id, { timeoutMs: 750 })
    }))
  )
  const showById = new Map(showResults.map((result) => [result.id, result.show]))
  return models.map((model) => mergeOllamaModelShow(model, showById.get(model.id) || null) || model)
}

export async function getOllamaStatusSnapshot(
  settings: Pick<AppSettings, 'ollamaBaseUrl' | 'ollamaDefaultModel'>
): Promise<OllamaStatusSnapshot> {
  const baseUrl = normalizeOllamaBaseUrl(settings.ollamaBaseUrl)
  try {
    const models = await enrichOllamaModelsWithShowInfo(
      baseUrl,
      await fetchOllamaModels({ ...settings, ollamaBaseUrl: baseUrl })
    )
    const defaultModel =
      String(settings.ollamaDefaultModel || '').trim() || models.find((model) => model.isDefault)?.id
    return {
      available: true,
      setupRequired: models.length === 0,
      baseUrl,
      modelCount: models.length,
      defaultModel,
      models,
      ...(models.length === 0 ? { error: 'Ollama is reachable, but no local models are installed.' } : {})
    }
  } catch (error) {
    return {
      available: false,
      setupRequired: true,
      baseUrl,
      modelCount: 0,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

export async function getOllamaCapabilityContract(
  deps: Pick<OllamaProviderDeps, 'getSettings'>,
  request: { workspacePath?: string; approvalMode?: string; networkAccess?: string | null } = {}
): Promise<ProviderCapabilityContract> {
  const settings = deps.getSettings()
  const approvalMode = request.approvalMode || 'plan'
  const networkAccess = request.networkAccess || settings.agenticServices?.networkAccess
  // Tier retirement (2026-07): the surface is always full; 'provider_parity' is a
  // fixed placeholder for the (tier-agnostic) name resolver.
  const toolNames = ollamaToolNamesForTier('provider_parity', { networkAccess })
  const status = await getOllamaStatusSnapshot(settings)
  return buildProviderCapabilityContract({
    provider: 'ollama',
    settings,
    workspacePath: request.workspacePath,
    approvalMode,
    status,
    mcpStatus: {
      available:
        Boolean(request.workspacePath) && settings.agenticServices?.mcpTools !== 'deny',
      enabled: settings.agenticServices?.mcpTools !== 'deny',
      installed: true,
      serverName: OLLAMA_LOCAL_TOOL_SERVER,
      tools:
        Boolean(request.workspacePath) && settings.agenticServices?.mcpTools !== 'deny'
          ? toolNames
          : [],
      message:
        Boolean(request.workspacePath) && settings.agenticServices?.mcpTools !== 'deny'
          ? 'Ollama local mode uses the full TaskWraith tool surface, governed by the run permission role.'
          : 'Ollama tools require a workspace thread and enabled TaskWraith MCP/tool policy.'
    }
  })
}

/** Map an Ollama chat `done` chunk to canonical run stats (snake_case +
 * camelCase) so ensemble participant token chips, usage recording, and the
 * composer thread tally all read the same fields. */
export function ollamaUsageStats(chunk: OllamaChatChunk): Record<string, unknown> {
  const inputTokens =
    typeof chunk.prompt_eval_count === 'number' && Number.isFinite(chunk.prompt_eval_count)
      ? Math.max(0, Math.trunc(chunk.prompt_eval_count))
      : 0
  const outputTokens =
    typeof chunk.eval_count === 'number' && Number.isFinite(chunk.eval_count)
      ? Math.max(0, Math.trunc(chunk.eval_count))
      : 0
  const durationMs =
    typeof chunk.total_duration === 'number' && chunk.total_duration > 0
      ? Math.max(0, Math.round(chunk.total_duration / 1_000_000))
      : 0
  if (inputTokens <= 0 && outputTokens <= 0 && durationMs <= 0) return {}
  return normalizeProviderUsage('ollama', {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
    duration_ms: durationMs,
    inputTokens,
    outputTokens,
    totalDurationNs: chunk.total_duration,
    loadDurationNs: chunk.load_duration,
    promptEvalDurationNs: chunk.prompt_eval_duration,
    evalDurationNs: chunk.eval_duration
  })
}

export function accumulateOllamaUsageStats(
  accumulated: Record<string, unknown> | undefined,
  chunk: OllamaChatChunk
): Record<string, unknown> | undefined {
  const next = ollamaUsageStats(chunk)
  if (!next || Object.keys(next).length === 0) return accumulated
  if (!accumulated) return { ...next }
  const sum = (key: 'input_tokens' | 'output_tokens' | 'total_tokens' | 'duration_ms') => {
    const left = Number(accumulated[key])
    const right = Number(next[key])
    return (Number.isFinite(left) ? left : 0) + (Number.isFinite(right) ? right : 0)
  }
  const inputTokens = sum('input_tokens')
  const outputTokens = sum('output_tokens')
  const totalTokens = sum('total_tokens')
  const durationMs = sum('duration_ms')
  return normalizeProviderUsage('ollama', {
    ...accumulated,
    ...next,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
    duration_ms: durationMs,
    inputTokens,
    outputTokens
  })
}

function recordFromUnknown(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function parseJsonObject(candidate: string): unknown | null {
  try {
    return JSON.parse(candidate)
  } catch {
    return null
  }
}

/** Escape backslashes that are NOT part of a valid JSON escape sequence so a
 * tolerant re-parse can recover. Models frequently embed source code in a tool
 * call's string arguments (e.g. Swift's `\(date)` interpolation, Windows paths,
 * LaTeX), which is invalid JSON — strict `JSON.parse` throws and the whole tool
 * call would otherwise leak to the user as raw text. The negative lookahead
 * leaves real escapes (`\n`, `\"`, `\\`, `\uXXXX`, …) untouched. */
export function sanitizeLooseJsonEscapes(candidate: string): string {
  // Consume valid escape pairs atomically (so the char after a real `\\` isn't
  // misread), and double any remaining lone backslash.
  return candidate.replace(/\\(["\\/bfnrtu])|\\/g, (_match, valid) =>
    valid ? `\\${valid}` : '\\\\'
  )
}

/** Strict JSON parse, falling back to a tolerant re-parse that repairs invalid
 * backslash escapes (the common failure when models embed code in string args). */
export function parseJsonObjectLoose(candidate: string): unknown | null {
  const strict = parseJsonObject(candidate)
  if (strict !== null) return strict
  return parseJsonObject(sanitizeLooseJsonEscapes(candidate))
}

function jsonCandidatesFromText(text: string): string[] {
  const candidates: string[] = []
  for (const match of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    if (match[1]?.trim()) candidates.push(match[1].trim())
  }
  const trimmed = text.trim()
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    candidates.push(trimmed)
  }
  const keyIndex = trimmed.indexOf('"taskwraith_tool"')
  if (keyIndex >= 0) {
    const start = trimmed.lastIndexOf('{', keyIndex)
    const end = trimmed.lastIndexOf('}')
    if (start >= 0 && end > start) candidates.push(trimmed.slice(start, end + 1))
  }
  return [...new Set(candidates)]
}

export function parseOllamaToolRequest(text: string): OllamaToolRequest | null {
  for (const candidate of jsonCandidatesFromText(text)) {
    const parsed = recordFromUnknown(parseJsonObjectLoose(candidate))
    if (!parsed) continue
    const wrapper = recordFromUnknown(parsed.taskwraith_tool) || recordFromUnknown(parsed.tool)
    if (!wrapper) continue
    const rawName = typeof wrapper.name === 'string' ? wrapper.name.trim() : ''
    const name = canonicalTaskWraithToolName(rawName)
    if (!isOllamaCallableToolName(name)) {
      continue
    }
    const args = recordFromUnknown(wrapper.arguments) || recordFromUnknown(wrapper.args) || {}
    return {
      toolName: name,
      arguments: args
    }
  }
  return null
}

export interface OllamaNativeToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: {
      type: 'object'
      properties: Record<string, unknown>
      required?: string[]
    }
  }
}

const STRING = { type: 'string' as const }

function ollamaNativeToolParameters(
  toolName: OllamaToolName,
  compact = false
): {
  description: string
  properties: Record<string, unknown>
  required: string[]
} {
  switch (toolName) {
    case 'read_file':
      return {
        description: compact ? 'Read workspace file.' : 'Read a UTF-8 text file inside the active workspace.',
        properties: {
          path: { ...STRING, description: compact ? 'Relative path.' : 'Workspace-relative file path.' },
          startLine: { type: 'number', description: 'Optional 1-based first line to read.' },
          endLine: { type: 'number', description: 'Optional 1-based last line to read.' },
          maxLines: { type: 'number', description: 'Optional maximum number of lines to return.' }
        },
        required: ['path']
      }
    case 'list_directory':
      return {
        description: compact ? 'List workspace directory.' : 'List the entries of a directory inside the active workspace.',
        properties: {
          path: {
            ...STRING,
            description: compact ? 'Relative path ("." for root).' : 'Workspace-relative directory path. Use "." for the root.'
          }
        },
        required: ['path']
      }
    case 'find_files':
      return compact
        ? {
            description: 'Find workspace files by glob.',
            properties: {
              pattern: { ...STRING, description: 'Filename/path glob.' },
              path: { ...STRING, description: 'Optional subdirectory.' }
            },
            required: ['pattern']
          }
        : {
            description: 'Find files by filename or path glob inside the active workspace.',
            properties: {
              pattern: {
                ...STRING,
                description: 'Filename/path glob such as package.json, *.test.ts, or **/*.tsx.'
              },
              path: { ...STRING, description: 'Optional subdirectory to scope the search.' },
              maxResults: { type: 'number', description: 'Maximum files to return.' },
              includeHidden: { type: 'boolean', description: 'Include hidden files. Defaults to false.' }
            },
            required: ['pattern']
          }
    case 'workspace_search':
      return compact
        ? {
            description: 'Search workspace text/regex.',
            properties: {
              query: { ...STRING, description: 'Search text or regex.' },
              path: { ...STRING, description: 'Optional subdirectory.' }
            },
            required: ['query']
          }
        : {
            description: 'Search the workspace tree for text or a regular expression.',
            properties: {
              query: { ...STRING, description: 'Text or regex to search for.' },
              path: { ...STRING, description: 'Optional subdirectory to scope the search.' },
              maxResults: { type: 'number', description: 'Maximum matches to return.' },
              contextLines: { type: 'number', description: 'Lines of context around each match.' }
            },
            required: ['query']
          }
    case 'web_search':
      return {
        description: compact
          ? 'Search the live web.'
          : 'Search the live web. Returns a ranked list of result titles and URLs. Use this for current events, weather, prices, or anything not answerable from memory.',
        properties: { query: { ...STRING, description: compact ? 'Search query.' : 'What to search the web for.' } },
        required: ['query']
      }
    case 'web_fetch':
      return {
        description: compact
          ? 'Fetch readable page text from a URL.'
          : 'Download a web page and return its readable text (HTML stripped) so you can summarize it.',
        properties: { url: { ...STRING, description: compact ? 'http(s) URL.' : 'Absolute http(s) URL to fetch.' } },
        required: ['url']
      }
    case 'git_log':
      return compact
        ? {
            description: 'Read recent git commits.',
            properties: {
              path: { ...STRING, description: 'Optional relative path.' },
              maxCount: { type: 'number', description: 'Maximum commits.' }
            },
            required: []
          }
        : {
            description: 'Read bounded structured commit history for the active workspace.',
            properties: {
              ref: { ...STRING, description: 'Optional branch, tag, or commit ref.' },
              path: { ...STRING, description: 'Optional workspace-relative path filter.' },
              maxCount: { type: 'number', description: 'Maximum commits to return.' },
              grep: { ...STRING, description: 'Optional commit-message grep.' },
              author: { ...STRING, description: 'Optional author filter.' }
            },
            required: []
          }
    case 'git_show':
      return {
        description: compact ? 'Inspect a git commit/ref.' : 'Inspect metadata, stats, or patch for a git ref.',
        properties: {
          ref: { ...STRING, description: compact ? 'Commit/ref.' : 'Commit, tag, or git ref to inspect.' },
          path: { ...STRING, description: 'Optional workspace-relative path filter.' },
          includePatch: { type: 'boolean', description: 'Include patch output.' },
          stat: { type: 'boolean', description: 'Include diffstat.' }
        },
        required: ['ref']
      }
    case 'git_blame':
      return {
        description: compact ? 'Blame file lines.' : 'Read bounded git blame information for a workspace file.',
        properties: {
          path: { ...STRING, description: compact ? 'Relative file path.' : 'Workspace-relative file path.' },
          startLine: { type: 'number', description: 'Optional first line.' },
          endLine: { type: 'number', description: 'Optional last line.' },
          maxLines: { type: 'number', description: 'Maximum lines to return.' }
        },
        required: ['path']
      }
    case 'git_push':
      return {
        description: compact ? 'Push current branch (intent required).' : 'Push the current git branch. Requires a short intent.',
        properties: {
          remote: {
            ...STRING,
            description: compact ? 'Optional remote.' : 'Optional remote name. Defaults to upstream or origin.'
          },
          setUpstream: { type: 'boolean', description: 'Push with -u even when an upstream exists.' },
          intent: {
            ...STRING,
            description: compact ? 'Short reason.' : 'Short reason for publishing code.'
          }
        },
        required: ['intent']
      }
    case 'git_create_pr':
      return {
        description: compact ? 'Create GitHub PR (intent required).' : 'Create a GitHub pull request using gh. Requires a short intent.',
        properties: {
          title: { ...STRING, description: 'Pull request title.' },
          body: { ...STRING, description: 'Pull request body.' },
          draft: { type: 'boolean', description: 'Create as draft.' },
          base: { ...STRING, description: 'Optional base branch.' },
          head: { ...STRING, description: 'Optional head branch.' },
          intent: {
            ...STRING,
            description: compact ? 'Short reason.' : 'Short reason for publishing a pull request.'
          }
        },
        required: ['intent']
      }
    case 'github_ci_status':
      return {
        description: compact
          ? 'Read GitHub CI status.'
          : 'Read GitHub Actions / PR check state for this repo through the shared Git service. Optionally fetch bounded failed logs for repair planning.',
        properties: {
          pr: { ...STRING, description: 'Optional PR number, URL, or branch selector.' },
          branch: { ...STRING, description: 'Optional branch. Defaults to the current branch.' },
          commitSha: { ...STRING, description: 'Optional commit SHA to bind checks.' },
          includeFailedLogs: { type: 'boolean', description: 'Fetch bounded failed job logs.' },
          maxRuns: { type: 'number', description: 'Maximum workflow runs to inspect.' },
          repairAttempt: { type: 'number', description: 'Current repair attempt count.' },
          maxRepairPushes: { type: 'number', description: 'Stop after this many repair pushes.' }
        },
        required: []
      }
    case 'write_file':
      return {
        description: compact ? 'Write workspace file (intent required).' : 'Create or overwrite a workspace file. Requires a short intent.',
        properties: {
          path: { ...STRING, description: compact ? 'Relative path.' : 'Workspace-relative file path.' },
          content: { ...STRING, description: compact ? 'File contents.' : 'Full new file contents.' },
          intent: { ...STRING, description: compact ? 'Short reason.' : 'Short reason for the change (shown in the approval modal).' }
        },
        required: ['path', 'content', 'intent']
      }
    case 'replace':
      return {
        description: compact ? 'Replace text in file (intent required).' : 'Replace an exact substring within a workspace file. Requires a short intent.',
        properties: {
          path: { ...STRING, description: compact ? 'Relative path.' : 'Workspace-relative file path.' },
          old_string: { ...STRING, description: compact ? 'Text to replace.' : 'Exact text to replace.' },
          new_string: { ...STRING, description: compact ? 'Replacement.' : 'Replacement text.' },
          intent: { ...STRING, description: compact ? 'Short reason.' : 'Short reason for the change.' }
        },
        required: ['path', 'old_string', 'new_string', 'intent']
      }
    case 'create_directory':
      return {
        description: compact ? 'Create directory (intent required).' : 'Create a directory inside the active workspace. Requires a short intent.',
        properties: {
          path: { ...STRING, description: compact ? 'Relative directory.' : 'Workspace-relative directory path.' },
          recursive: { type: 'boolean', description: 'Create parent directories. Defaults to true.' },
          intent: { ...STRING, description: compact ? 'Short reason.' : 'Short reason for the change.' }
        },
        required: ['path', 'intent']
      }
    case 'delete_path':
      return {
        description: compact ? 'Delete file/empty dir (intent required).' : 'Delete a file or empty directory inside the active workspace. Recursive deletion is not supported. Requires a short intent.',
        properties: {
          path: { ...STRING, description: compact ? 'Relative path.' : 'Workspace-relative file or empty directory path.' },
          intent: { ...STRING, description: compact ? 'Short reason.' : 'Short reason for the deletion.' }
        },
        required: ['path', 'intent']
      }
    case 'move_path':
      return {
        description: compact ? 'Move path (intent required).' : 'Move a file or directory inside the active workspace. Requires a short intent.',
        properties: {
          from: { ...STRING, description: compact ? 'Source path.' : 'Workspace-relative source path.' },
          to: { ...STRING, description: compact ? 'Destination path.' : 'Workspace-relative destination path.' },
          overwrite: { type: 'boolean', description: 'Replace an existing destination. Defaults to false.' },
          createParents: { type: 'boolean', description: 'Create missing destination parent directories. Defaults to false.' },
          intent: { ...STRING, description: compact ? 'Short reason.' : 'Short reason for the move.' }
        },
        required: ['from', 'to', 'intent']
      }
    case 'rename_path':
      return {
        description: compact ? 'Rename path (intent required).' : 'Rename a file or directory within its current parent directory. Requires a short intent.',
        properties: {
          path: { ...STRING, description: compact ? 'Source path.' : 'Workspace-relative source path.' },
          newName: { ...STRING, description: compact ? 'New basename.' : 'New basename only, not a path.' },
          overwrite: { type: 'boolean', description: 'Replace an existing destination. Defaults to false.' },
          intent: { ...STRING, description: compact ? 'Short reason.' : 'Short reason for the rename.' }
        },
        required: ['path', 'newName', 'intent']
      }
    case 'apply_patch':
      return {
        description: compact ? 'Apply unified diff (intent required).' : 'Apply a unified diff to the workspace. Requires a short intent.',
        properties: {
          patch: { ...STRING, description: compact ? 'Unified diff.' : 'Unified diff text.' },
          intent: { ...STRING, description: compact ? 'Short reason.' : 'Short reason for the change.' }
        },
        required: ['patch', 'intent']
      }
    case 'run_shell_command':
      return {
        description: compact ? 'Run shell command (intent required).' : 'Run a shell command in the workspace. Requires a short intent.',
        properties: {
          command: { ...STRING, description: compact ? 'Command.' : 'Exact command to run.' },
          intent: { ...STRING, description: compact ? 'Short reason.' : 'Short reason for running it.' }
        },
        required: ['command', 'intent']
      }
    case 'get_diagnostics':
      return {
        description: compact ? 'Run diagnostics (intent required).' : 'Run fixed workspace diagnostics. Requires a short intent.',
        properties: {
          source: {
            ...STRING,
            description: compact ? 'typescript|eslint|all.' : 'Diagnostic source: typescript, eslint, or all.'
          },
          path: { ...STRING, description: compact ? 'Optional relative path.' : 'Optional workspace-relative file or directory filter.' },
          project: { ...STRING, description: compact ? 'Optional tsconfig.' : 'Optional workspace-relative tsconfig path.' },
          maxDiagnostics: { type: 'number', description: 'Maximum diagnostics to return.' },
          intent: { ...STRING, description: compact ? 'Short reason.' : 'Short reason for running diagnostics.' }
        },
        required: ['intent']
      }
    case 'list_active_runs':
      return {
        description: compact ? 'List active runs.' : 'List TaskWraith-owned active runs and queued run jobs.',
        properties: {
          provider: { ...STRING, description: compact ? 'Optional provider.' : 'Optional provider filter.' },
          chatId: { ...STRING, description: compact ? 'Optional chat id.' : 'Optional chat id filter.' },
          includeEvents: { type: 'boolean', description: compact ? 'Include recent events.' : 'Include bounded recent durable events.' }
        },
        required: []
      }
    case 'cancel_active_run':
      return {
        description: compact ? 'Cancel active run (intent required).' : 'Request cancellation of one TaskWraith-owned active run. Requires a short intent.',
        properties: {
          provider: { ...STRING, description: compact ? 'Provider.' : 'Provider that owns the run.' },
          runId: { ...STRING, description: compact ? 'Run id.' : 'TaskWraith app run id. Required when multiple runs match.' },
          chatId: { ...STRING, description: compact ? 'Optional chat id.' : 'Optional chat id to narrow the target.' },
          intent: { ...STRING, description: compact ? 'Short reason.' : 'Short reason for cancelling the run.' }
        },
        required: ['provider', 'intent']
      }
    default:
      return {
        description: `Invoke the TaskWraith ${toolName} tool using its documented MCP argument schema.`,
        properties: {},
        required: []
      }
  }
}

/** Build OpenAI-style function definitions for the tools allowed in `tier`, to
 * pass via Ollama's native `tools` request field. Models with native tool
 * support (gpt-oss, qwen, etc.) emit structured `tool_calls` against these. */
export function ollamaNativeToolDefinitions(
  _tier: OllamaToolControlTier | string | undefined | null,
  options?: { compact?: boolean; networkAccess?: string | null; readOnly?: boolean }
): OllamaNativeToolDefinition[] {
  const compact = Boolean(options?.compact)
  // Advertise the immutable gateway-v1 direct set as native function defs (not
  // the full catalogue). The tail remains executable through capability_invoke
  // and discoverable through the gateway or legacy tool_help. A read-only
  // posture receives the exact intersection with the shared safe advertise set.
  const defs: OllamaNativeToolDefinition[] = ollamaAdvertisedToolNames({
    networkAccess: options?.networkAccess,
    readOnly: options?.readOnly
  }).map((toolName) => {
    const { description, properties, required } = ollamaNativeToolParameters(toolName, compact)
    return {
      type: 'function',
      function: {
        name: toolName,
        description,
        parameters: { type: 'object', properties, ...(required.length ? { required } : {}) }
      }
    }
  })
  // Progressive-disclosure tools are virtual (not in the canonical catalogue)
  // but native Ollama models still need their exact function schemas.
  for (const definition of gatewayToolDefinitions()) {
    const schema = recordFromUnknown(definition.inputSchema) || {}
    const properties = recordFromUnknown(schema.properties) || {}
    const required = Array.isArray(schema.required)
      ? schema.required.filter((name): name is string => typeof name === 'string')
      : []
    defs.push({
      type: 'function',
      function: {
        name: definition.name,
        description: definition.description || `Invoke the ${definition.name} gateway tool.`,
        parameters: {
          type: 'object',
          properties,
          ...(required.length ? { required } : {})
        }
      }
    })
  }
  // tool_help remains as a backwards-compatible Ollama-only lookup alongside
  // the provider-neutral capability gateway.
  defs.push({
    type: 'function',
    function: {
      name: OLLAMA_TOOL_HELP_NAME,
      description:
        'Get the exact arguments/schema for any TaskWraith tool (or pass an empty name to list every tool). Invoke a hidden result through capability_invoke.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Tool name, or empty to list all tools.' }
        }
      }
    }
  })
  return defs
}

/** Normalize a single native tool call from an Ollama stream chunk into the
 * internal request shape, or null when the name is unknown / unparseable. */
export function normalizeOllamaNativeToolCall(call: OllamaNativeToolCall): OllamaToolRequest | null {
  const rawName = typeof call.function?.name === 'string' ? call.function.name.trim() : ''
  const name = canonicalTaskWraithToolName(rawName)
  if (!isOllamaCallableToolName(name)) {
    return null
  }
  const rawArgs = call.function?.arguments
  let args: Record<string, unknown> = {}
  if (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)) {
    args = rawArgs as Record<string, unknown>
  } else if (typeof rawArgs === 'string' && rawArgs.trim()) {
    args = recordFromUnknown(parseJsonObjectLoose(rawArgs)) || {}
  }
  return { toolName: name, arguments: args }
}

export function ollamaToolResultFollowUpPrompt(input: {
  toolName: OllamaCallableToolName
  output: string
  ok: boolean
}): string {
  return [
    `TaskWraith executed ${input.toolName}.`,
    input.ok ? 'Tool status: success.' : 'Tool status: error.',
    'Tool result:',
    input.output,
    '',
    input.ok
      ? [
          'Continue the task using this result.',
          'If you still need more information to fully complete what the user asked, call another TaskWraith tool now (use different arguments than before).',
          'When you have everything you need, give your complete final answer to the user in normal assistant prose.',
          'Do not repeat an identical tool call, and only output JSON when you are requesting another TaskWraith tool.'
        ].join(' ')
      : [
          'The tool failed.',
          'Explain the limitation or request a different allowed TaskWraith tool only if that can recover.'
        ].join(' ')
  ].join('\n')
}

export function ollamaToolArgumentRepairPrompt(
  input: {
    toolName: OllamaCallableToolName
    output: string
  } & OllamaRetryPromptOptions
): string {
  return [
    `TaskWraith rejected ${input.toolName} before execution because its arguments did not match the required schema.`,
    'Validation error:',
    input.output,
    '',
    `Re-issue the same ${input.toolName} tool call with the missing required argument set.`,
    'Do not describe the tool call in prose, and do not answer as if the tool already ran.',
    ...ollamaEnsembleRetryReminder(input)
  ].join('\n')
}

export function ollamaGoalLifecycleStopContent(toolName: string): string | null {
  if (toolName === 'goal_complete') {
    return 'Goal marked complete. I will stop here so the active objective stays closed.'
  }
  if (toolName === 'goal_blocked') {
    return 'Goal marked blocked. I will stop here so the handoff stays explicit.'
  }
  return null
}

export function shouldStopOllamaAfterGoalLifecycleTool(toolName: string, ok: boolean): boolean {
  return ok && ollamaGoalLifecycleStopContent(toolName) !== null
}

interface OllamaRetryPromptOptions {
  ensembleRun?: boolean
}

function ollamaEnsembleRetryReminder(options?: OllamaRetryPromptOptions): string[] {
  return options?.ensembleRun
    ? [
        'For this ensemble run, answer as your assigned participant and keep following the Role boundary contract plus Boss/Bossman/Lead routing.'
      ]
    : []
}

/** Terminal content emitted when the retry ceiling fires. Solo runs get a
 * user-facing "rephrase" instruction; an ensemble seat gets panel-voiced text
 * with no user directive (it defers to the panel rather than telling the user
 * what to do — that's the orchestrator's job, not one seat's). */
export function ollamaCeilingFinalizeContent(options?: OllamaRetryPromptOptions): string {
  return options?.ensembleRun
    ? 'I could not converge on a usable result for my assigned slice this round after several attempts, so I am stopping here and deferring to the panel.'
    : 'I could not produce a valid tool call or a usable answer after several attempts, so I am stopping instead of looping. Please rephrase or narrow the request.'
}

export function ollamaEmptyToolResponseRetryPrompt(options?: OllamaRetryPromptOptions): string {
  return [
    'Your previous response was empty after TaskWraith returned tool results.',
    'Do not request another tool unless it is strictly required.',
    ...ollamaEnsembleRetryReminder(options),
    options?.ensembleRun
      ? 'Answer now in normal assistant prose, summarizing the tool results inside your assigned ensemble slice.'
      : 'Answer the original user now in normal assistant prose, summarizing the tool results you already received.'
  ].join(' ')
}

export function ollamaEmptyResponseRetryPrompt(options?: OllamaRetryPromptOptions): string {
  return [
    'Your previous response was empty.',
    ...ollamaEnsembleRetryReminder(options),
    options?.ensembleRun
      ? 'Answer the current ensemble turn now in normal assistant prose from your assigned participant role.'
      : 'Answer the original user request now in normal assistant prose.',
    'Put your final answer in your normal response, not only in hidden reasoning.'
  ].join(' ')
}

/** Max generated tokens that still counts as a degenerate ensemble/solo turn. */
export const OLLAMA_DEGENERATE_OUTPUT_TOKEN_MAX = 1

/** Max visible chars for a stub fragment ("The", "I", …) worth re-prompting. */
export const OLLAMA_DEGENERATE_STUB_MAX_CHARS = 24

export function ollamaDegenerateResponseNudgePrompt(options?: OllamaRetryPromptOptions): string {
  return [
    'Your previous reply was too short to count as a turn (often caused by running out of context window).',
    ...ollamaEnsembleRetryReminder(options),
    options?.ensembleRun
      ? 'Answer the current ensemble turn in full assistant prose now, or call a TaskWraith tool if your assigned slice needs workspace facts.'
      : 'Answer the current request in full assistant prose now, or call a TaskWraith tool if you need workspace facts.',
    'Do not stop after a single word or fragment.'
  ].join(' ')
}

export function looksLikeDegenerateOllamaStub(visibleText: string): boolean {
  const text = (visibleText || '').trim()
  if (!text) return false
  if (text.length > OLLAMA_DEGENERATE_STUB_MAX_CHARS) return false
  const wordCount = text.split(/\s+/).filter(Boolean).length
  return wordCount <= 2 && !/[.!?]/.test(text)
}

export function isDegenerateOllamaTurn(
  turn: { content: string; thinking?: string },
  visibleText: string,
  toolRequestCount: number,
  outputTokens: number | null
): boolean {
  if (toolRequestCount > 0) return false
  if (outputTokens !== null && outputTokens <= OLLAMA_DEGENERATE_OUTPUT_TOKEN_MAX) return true
  const thinking = (turn.thinking || '').trim()
  if (looksLikeDegenerateOllamaStub(visibleText) && thinking.length < 80) return true
  return false
}

/** Nudge for harmony-format models (gpt-oss) that emit a plan into their hidden
 * reasoning channel without producing a final answer or an actual tool call.
 * We must not surface chain-of-thought as the answer, so push the model to act. */
export function ollamaReasoningOnlyNudgePrompt(options?: OllamaRetryPromptOptions): string {
  return [
    'You produced internal reasoning but no final answer and no tool call.',
    'If you need external data (web pages, files, search results), call one of the available tools now.',
    ...ollamaEnsembleRetryReminder(options),
    options?.ensembleRun
      ? 'Otherwise, write your final answer for this ensemble turn in normal assistant prose from your assigned participant role.'
      : 'Otherwise, write your final answer for the user in normal assistant prose.',
    'Do not leave your response only in hidden reasoning.'
  ].join(' ')
}

/** Nudge for models (notably gpt-oss) that ANNOUNCE a tool in prose
 * ("We need to use web_search", "Let's do web_search") but never emit an
 * actual structured tool call, then stop — handing an intent stub back to the
 * user instead of acting. Push them to emit the real call (or, if no tool is
 * actually needed, to answer) rather than describing the call in prose. */
export function ollamaToolIntentNudgePrompt(
  toolNames: string[] = [],
  options?: OllamaRetryPromptOptions
): string {
  const available = toolNames.filter(Boolean)
  return [
    'You described using a tool in prose but did not actually call one.',
    'Stop announcing the tool and emit a real tool call now (a structured function call), not a description of it.',
    available.length ? `Available tools: ${available.join(', ')}.` : '',
    ...ollamaEnsembleRetryReminder(options),
    options?.ensembleRun
      ? 'If you do not actually need a tool, give your complete final answer for this ensemble turn from your assigned participant role instead.'
      : 'If you do not actually need a tool, give your complete final answer to the user in normal assistant prose instead.'
  ]
    .filter(Boolean)
    .join(' ')
}

/** Nudge for a model that emitted a native tool call naming a tool that does
 * is not directly callable — the call is dropped before execution, so instead
 * of misreading the turn as empty we list the compact surface and point at the
 * gateway for the hidden tail. */
export function ollamaUnknownToolNameNudgePrompt(
  droppedNames: string[],
  toolNames: string[] = [],
  options?: OllamaRetryPromptOptions
): string {
  const invalid = [...new Set(droppedNames.filter(Boolean))]
  const available = toolNames.filter(Boolean)
  return [
    invalid.length
      ? `The tool ${invalid.map((n) => `"${n}"`).join(', ')} is not directly callable in this compact TaskWraith profile, so that call did nothing.`
      : 'That tool call is not directly callable in this compact TaskWraith profile, so it did nothing.',
    available.length ? `Available tools: ${available.join(', ')}.` : '',
    'Use capability_search for a hidden capability, then capability_invoke with its exact name and arguments. Legacy tool_help can also fetch one schema.',
    'Re-issue a call through an available direct tool or capability_invoke, or answer in normal prose if no tool is needed.',
    ...ollamaEnsembleRetryReminder(options)
  ]
    .filter(Boolean)
    .join(' ')
}

/** Detect a leaked tool-protocol attempt: the model tried to emit the
 * `{"taskwraith_tool":{...}}` JSON contract in prose but it could not be parsed
 * into a real request (e.g. invalid JSON escapes that even the tolerant parser
 * couldn't repair). We must not show this raw blob to the user as the answer. */
export function looksLikeLeakedOllamaToolProtocol(text: string): boolean {
  const value = (text || '').trim()
  if (!value) return false
  return value.includes('"taskwraith_tool"') || value.includes('"tool"')
    ? /\{[\s\S]*"(?:taskwraith_tool|tool)"[\s\S]*\}/.test(value)
    : false
}

/** Nudge for a malformed/leaked tool-call JSON that couldn't be parsed. */
export function ollamaMalformedToolJsonNudgePrompt(options?: OllamaRetryPromptOptions): string {
  return [
    'Your previous tool request could not be parsed as valid JSON.',
    'If a string argument contains source code or backslashes, escape them correctly (for example, a literal backslash must be written as \\\\, and embedded double quotes as \\").',
    ...ollamaEnsembleRetryReminder(options),
    'Re-issue the tool call now as a single valid JSON object (or emit a native tool call). Do not output the tool request as plain prose.',
    options?.ensembleRun
      ? 'If this tool is no longer required for your assigned participant slice, answer from your assigned role instead.'
      : ''
  ]
    .filter(Boolean)
    .join(' ')
}

/** Heuristic: does this turn's visible `content` merely ANNOUNCE a tool call
 * (without an accompanying structured tool call) rather than answer the user?
 * Used to re-prompt instead of finalizing an intent stub like
 * "We need to use web_search tool." Conservative: requires a short response
 * that names an available tool AND uses an action cue, so substantive answers
 * that merely mention a tool aren't misclassified. */
export function looksLikeOllamaToolIntent(content: string, toolNames: string[]): boolean {
  const text = (content || '').trim().toLowerCase()
  if (!text) return false
  // Intent stubs are short; a real answer that happens to mention a tool is not.
  if (text.length > 400) return false
  const names = (toolNames || [])
    .map((name) => (name || '').trim().toLowerCase())
    .filter(Boolean)
  const mentionsToolName = names.some((name) => name && text.includes(name))
  const mentionsGenericTool = /\b(tool|function call|function)\b/.test(text)
  if (!mentionsToolName && !mentionsGenericTool) return false
  // Action cue announcing an intent to act. `\buse\b` deliberately does not
  // match "used" so past-tense summaries of completed calls don't trigger.
  const actionCue =
    /\b(use|using|call|calling|invoke|invoking|run|running|perform|performing|let'?s|lets|let us|need to|needs to|should|going to|gonna|will|i'?ll|we'?ll|proceed to|do)\b/.test(
      text
    )
  return actionCue
}

export function unwrapOllamaStructuredResponseText(text: string): string {
  const trimmed = (text || '').trim()
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return text
  const parsed = recordFromUnknown(parseJsonObject(trimmed))
  const response = typeof parsed?.response === 'string' ? parsed.response : ''
  return response.trim() ? response : text
}

/** Resolve the text TaskWraith should treat as the model's turn output.
 * Prefers the normal `content` channel; falls back to harmony reasoning
 * (`thinking`) so models like gpt-oss that emit their answer into the
 * reasoning channel still produce a visible response instead of nothing. */
export function resolveOllamaVisibleText(turn: { content: string; thinking?: string }): string {
  const content = unwrapOllamaStructuredResponseText(turn.content)
  if (content.trim()) return content
  const thinking = unwrapOllamaStructuredResponseText(turn.thinking || '')
  return looksLikeOllamaPromptRestatement(thinking) ? '' : thinking
}

export function looksLikeOllamaPromptRestatement(text: string): boolean {
  const value = (text || '').trim().toLowerCase()
  if (!value) return false
  return (
    /\bwe need to (?:respond|reply|answer|produce (?:a )?response|provide (?:a )?response) as ollama\b/.test(value) ||
    /\bwe are #p\d+\b/.test(value) ||
    /\bprior participants?\b/.test(value) ||
    /\bturn-bound round\b/.test(value) ||
    /\bthe system (?:says|said|message|prompt)\b/.test(value) ||
    /\bparticipant health\b/.test(value) ||
    /\bthe user (says|said|asked|asks|wants|requested|request is)\b/.test(value) ||
    /\bworkspace coding task\b/.test(value) ||
    /\byour task is the user request in the previous message\b/.test(value) ||
    /\buse todo_write only\b/.test(value) ||
    /\bsuggested todos\b/.test(value)
  )
}

/**
 * Whether a turn's reasoning (`thinking`) channel should be surfaced as a
 * separate streamed reasoning note.
 *
 * Ollama's thinking stream is unusually prone to echoing the system/harness
 * prompt immediately before a tool call ("Workspace coding task...", "the user
 * says..."). Keep those internal: they remain available to the model for the
 * next turn, but they are not useful transcript content. If a model emits its
 * final answer only through `thinking`, `resolveOllamaVisibleText` still
 * promotes that text to the assistant reply; this helper only controls the
 * separate activity row.
 */
export function shouldEmitOllamaReasoning(
  turn: { content: string; thinking?: string },
  toolRequestCount: number
): boolean {
  const reasoningText = (turn.thinking || '').trim()
  if (!reasoningText) return false
  if (toolRequestCount > 0) return false
  const reasoningIsAnswer = toolRequestCount === 0 && !turn.content.trim()
  if (reasoningIsAnswer) return false
  return !looksLikeOllamaPromptRestatement(reasoningText)
}

export function ollamaPreToolContentText(
  turn: { content: string; thinking?: string },
  usingNativeToolCalls: boolean
): string {
  if (!usingNativeToolCalls) return ''
  const content = unwrapOllamaStructuredResponseText(turn.content).trim()
  if (!content) return ''
  if (looksLikeOllamaPromptRestatement(content)) return ''
  if (looksLikeLeakedOllamaToolProtocol(content)) return ''
  return content
}

function estimateOllamaContextTokens(input: {
  messages: OllamaChatMessage[]
  tools?: OllamaNativeToolDefinition[]
}): number {
  const messageChars = input.messages.reduce(
    (sum, message) =>
      sum +
      message.content.length +
      (message.tool_calls ? JSON.stringify(message.tool_calls).length : 0) +
      (message.tool_name ? message.tool_name.length : 0),
    0
  )
  const toolChars = input.tools?.length ? JSON.stringify(input.tools).length : 0
  return Math.ceil((messageChars + toolChars) / 3.6)
}

function roundOllamaContext(tokens: number): number {
  const quantum = 4096
  return Math.ceil(tokens / quantum) * quantum
}

function resolveOllamaNumCtx(input: {
  messages: OllamaChatMessage[]
  tools?: OllamaNativeToolDefinition[]
  modelInfo?: OllamaModelInfo | null
  contextCapTokens?: number
  reserveTokens?: number
}): number | undefined {
  const limit = resolveOllamaRuntimeContextLimit(input)
  const required = estimateOllamaContextTokens(input) + (input.reserveTokens || 4096)
  const rounded = roundOllamaContext(Math.max(8192, required))
  return Math.min(limit, rounded)
}

export function resolveOllamaRuntimeContextLimit(input: {
  modelInfo?: OllamaModelInfo | null
  contextCapTokens?: number
}): number {
  const modelLimit =
    typeof input.modelInfo?.contextLength === 'number' && input.modelInfo.contextLength > 0
      ? input.modelInfo.contextLength
      : undefined
  const profileLimit =
    typeof input.contextCapTokens === 'number' && input.contextCapTokens > 0
      ? input.contextCapTokens
      : undefined
  return Math.min(modelLimit || profileLimit || 131_072, profileLimit || modelLimit || 65_536)
}

export function prepareOllamaEnsemblePromptForRuntime(input: {
  prompt: string
  modelId: string
  modelInfo?: OllamaModelInfo | null
  contextCapTokens?: number
  configuredContextChars?: number
  configuredContextTurns?: number
  toolsEnabled?: boolean
}): string {
  const shellChars = Math.max(0, input.prompt.indexOf('Recent tagged transcript:'))
  const runtimeContextLimit = resolveOllamaRuntimeContextLimit({
    modelInfo: input.modelInfo,
    contextCapTokens: input.contextCapTokens
  })
  const budget = resolveOllamaEnsembleTranscriptCharsForBudget({
    configuredChars: input.configuredContextChars,
    configuredTurns: input.configuredContextTurns,
    promptWithoutTranscriptChars: shellChars > 0 ? shellChars : 5_800,
    modelId: input.modelId,
    contextLength: runtimeContextLimit,
    toolsEnabled: input.toolsEnabled
  })
  const maxPromptChars = shellChars + budget.contextChars + 2_400
  return compactOllamaEnsemblePromptText(input.prompt, maxPromptChars)
}

function shouldHoldOllamaContentForPublicStream(input: {
  content: string
  availableToolNames: string[]
}): boolean {
  const trimmed = input.content.trimStart()
  if (!trimmed) return true
  if (trimmed.startsWith('{') || trimmed.startsWith('[') || trimmed.startsWith('```')) return true
  if (/taskwraith_tool/i.test(trimmed)) return true
  if (looksLikeLeakedOllamaToolProtocol(trimmed)) return true
  if (looksLikeDegenerateOllamaStub(trimmed)) return true
  return looksLikeOllamaToolIntent(trimmed, input.availableToolNames)
}

async function fetchOllamaChatResponseWithRetry(input: {
  baseUrl: string
  signal: AbortSignal
  request: Record<string, unknown>
  launchAuthorized?: OllamaTransportLaunchAuthority
  onRetry?: (input: OllamaChatRetryCallbackInput) => void
}): Promise<Response> {
  const maxAttempts = OLLAMA_CHAT_TRANSPORT_RETRY_DELAYS_MS.length + 1
  let lastError: unknown
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      // This check and the fetch invocation are deliberately adjacent with no
      // await between them. The AbortSignal owns cancellation after launch;
      // RunManager's terminal claim owns admission before launch.
      assertOllamaTransportLaunchAuthorized(input.signal, input.launchAuthorized)
      return await fetch(endpoint(input.baseUrl, '/api/chat'), {
        method: 'POST',
        signal: input.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input.request)
      })
    } catch (error) {
      lastError = error
      const retryDelay = OLLAMA_CHAT_TRANSPORT_RETRY_DELAYS_MS[attempt - 1]
      if (
        attempt >= maxAttempts ||
        retryDelay === undefined ||
        input.signal.aborted ||
        !isOllamaTransportError(error)
      ) {
        throw error
      }
      input.onRetry?.({
        attempt,
        maxAttempts,
        delayMs: retryDelay,
        error: unknownErrorMessage(error)
      })
      await waitForOllamaRetry(retryDelay, input.signal)
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError || 'Ollama fetch failed.'))
}

export function shouldReleaseOllamaContentDelta(input: {
  content: string
  pending: string
  streamed: string
  jsonToolFallback: boolean
  toolProtocolEnabled: boolean
  availableToolNames: string[]
}): boolean {
  if (!input.pending) return false
  if (input.jsonToolFallback) return false
  if (
    shouldHoldOllamaContentForPublicStream({
      content: input.content,
      availableToolNames: input.availableToolNames
    })
  ) {
    return false
  }
  if (!input.toolProtocolEnabled) return true
  // Tool-capable turn: gate ONLY the first exposure so a fallback JSON/tool
  // stub can't flash. The hold-guard above already vets the cumulative content
  // on every chunk; once prose has begun streaming (streamed non-empty) the
  // turn is classified as ordinary assistant text, so release per token.
  // Otherwise the gate re-buffers ~24 chars after every short sentence (the
  // threshold is relative to total visible length, which a short `streamed`
  // keeps resetting) — the source of Ollama's uniquely choppy cadence in
  // tool turns.
  if (input.streamed.length > 0) return true
  // First exposure (streamed empty): require enough prose, or a sentence end,
  // before showing anything.
  return input.pending.length >= 24 || /[.!?\n]\s*$/.test(input.content)
}

function shouldReleaseOllamaThinkingUpdate(input: {
  thinking: string
  streamedContent: string
  toolProtocolEnabled: boolean
}): boolean {
  const thinking = input.thinking.trim()
  if (!thinking) return false
  if (input.toolProtocolEnabled) return false
  if (!input.streamedContent) return false
  if (looksLikeOllamaPromptRestatement(thinking)) return false
  if (looksLikeDegenerateOllamaStub(thinking)) return false
  return thinking.length >= OLLAMA_DEGENERATE_STUB_MAX_CHARS || /[.!?\n]\s*$/.test(input.thinking)
}

/**
 * JSON schema for the text-protocol tool-call envelope, passed as Ollama's
 * `format` so llama.cpp compiles a GBNF grammar and the model CANNOT decode a
 * wrong wrapper key or a hallucinated tool name — it can only emit
 * {"taskwraith_tool":{"name":<one of the advertised names>,"arguments":{...}}}.
 * This is used only on the json-tool-fallback path (which already expects a tool
 * call, not prose), so constraining the envelope is a strict tightening of the
 * old bare `format:'json'`. `arguments` is intentionally left an open object —
 * per-tool arg schemas can't be applied until `name` decodes, and required-field
 * / enum checks are enforced separately by validateOllamaToolArguments.
 */
// Per-tool aliases the current local/shared executors already tolerate. Keep
// this narrow: a broad "directory means path everywhere" table would accept
// calls that the eventual executor still rejects.
const OLLAMA_ARG_SYNONYMS_BY_TOOL: Partial<Record<OllamaToolName, Record<string, string[]>>> = {
  read_file: { path: ['file_path'] },
  list_directory: { path: ['directory'] },
  find_files: { pattern: ['patterns', 'glob', 'globs'] },
  workspace_search: { query: ['pattern'] },
  git_blame: { path: ['file'] },
  write_file: { path: ['file_path'] },
  replace: {
    path: ['file_path'],
    old_string: ['oldString'],
    new_string: ['newString']
  },
  create_directory: { path: ['directory'] },
  delete_path: { path: ['file', 'directory'] },
  move_path: {
    from: ['source', 'sourcePath', 'path'],
    to: ['destination', 'destinationPath', 'target']
  },
  rename_path: {
    path: ['from', 'source'],
    newName: ['name']
  },
  apply_patch: { patch: ['diff'] }
}

function ollamaArgPresent(
  toolName: OllamaToolName,
  args: Record<string, unknown>,
  field: string
): boolean {
  for (const key of [field, ...(OLLAMA_ARG_SYNONYMS_BY_TOOL[toolName]?.[field] || [])]) {
    const value = args[key]
    if (value === undefined || value === null) continue
    if (typeof value === 'string' && value.trim().length === 0) continue
    if (
      Array.isArray(value) &&
      value.every(
        (item) => item === undefined || item === null || (typeof item === 'string' && item.trim().length === 0)
      )
    ) {
      continue
    }
    return true
  }
  return false
}

// Resolve an argument value through the tool's synonyms (first non-null key wins).
function ollamaResolvedArgValue(
  toolName: OllamaToolName,
  args: Record<string, unknown>,
  field: string
): unknown {
  for (const key of [field, ...(OLLAMA_ARG_SYNONYMS_BY_TOOL[toolName]?.[field] || [])]) {
    const value = args[key]
    if (value !== undefined && value !== null) return value
  }
  return undefined
}

function ollamaArgTypeMatches(expected: 'string' | 'array', value: unknown): boolean {
  return expected === 'array' ? Array.isArray(value) : typeof value === 'string'
}

// Curated (tool → field → type) checks for load-bearing args where a wrong type
// is unambiguously fatal at execution. Deliberately narrow: only fields with NO
// string-or-array synonym variance (e.g. find_files' pattern accepts a glob
// LIST via the `globs` synonym, so it is intentionally absent) — a pre-execution
// gate must never false-positive a call the executor would run. Presence/required
// is handled separately; this only fires on a PRESENT arg of the wrong shape.
const OLLAMA_ARG_TYPE_CHECKS: Partial<Record<OllamaToolName, Record<string, 'string' | 'array'>>> = {
  read_file: { path: 'string' },
  write_file: { path: 'string', content: 'string' },
  replace: { path: 'string', old_string: 'string', new_string: 'string' },
  create_directory: { path: 'string' },
  delete_path: { path: 'string' },
  move_path: { from: 'string', to: 'string' },
  rename_path: { path: 'string', newName: 'string' },
  run_shell_command: { command: 'string' },
  workspace_search: { query: 'string' },
  todo_write: { todos: 'array' },
  blackboard_post: { key: 'string', value: 'string' },
  blackboard_read: { ids: 'array', keys: 'array' },
  blackboard_delete: { ids: 'array', keys: 'array' }
}

/**
 * Validate a tool call's arguments against the tool's declared schema BEFORE
 * execution — specifically the required fields (the tools declare no enums).
 * Conservative by design: only catalog tools with a known schema are checked,
 * required fields are synonym-tolerant, and a genuinely-missing field yields a
 * SPECIFIC, repairable message ("missing required argument: path"). This turns a
 * malformed call into a narrow repair prompt (see the run loop) instead of a
 * deep, unhelpful executor error the model can't distinguish from a real failure.
 *
 * The `intent` field is checked through the executor's own `ollamaToolIntent`
 * (intent/summary/reason/description) so the validator and the runtime
 * `assertOllamaMutationIntent` gate agree exactly — a mutation call that supplies
 * `reason:"…"` instead of `intent:"…"` must NOT be flagged, or we'd reject a call
 * the executor would happily run.
 */
export function validateOllamaToolArguments(
  toolName: string,
  args: Record<string, unknown>
): { ok: true } | { ok: false; message: string } {
  if (toolName === OLLAMA_TOOL_HELP_NAME) return { ok: true }
  if (!OLLAMA_KNOWN_TOOL_NAMES.has(toolName as OllamaToolName)) return { ok: true }
  const typedToolName = toolName as OllamaToolName
  const { required } = ollamaNativeToolParameters(typedToolName)
  const missing = required.filter((field) =>
    field === 'intent' ? !ollamaToolIntent(args) : !ollamaArgPresent(typedToolName, args, field)
  )
  if (missing.length > 0) {
    const fields = missing.join(', ')
    return {
      ok: false,
      message: `Your ${toolName} call is missing required argument${
        missing.length > 1 ? 's' : ''
      }: ${fields}. Re-issue the ${toolName} tool call with ${missing
        .map((field) => `"${field}"`)
        .join(', ')} set.`
    }
  }
  const typeChecks = OLLAMA_ARG_TYPE_CHECKS[typedToolName]
  if (typeChecks) {
    for (const [field, expected] of Object.entries(typeChecks)) {
      const value = ollamaResolvedArgValue(typedToolName, args, field)
      if (value === undefined) continue
      if (!ollamaArgTypeMatches(expected, value)) {
        const got = Array.isArray(value) ? 'a list' : `a ${typeof value}`
        return {
          ok: false,
          message: `Your ${toolName} call has the wrong type for "${field}": it must be ${
            expected === 'array' ? 'a list' : `a ${expected}`
          }, but you sent ${got}. Re-issue the ${toolName} tool call with "${field}" as ${
            expected === 'array' ? 'a list' : `a ${expected}`
          }.`
        }
      }
    }
  }
  return { ok: true }
}

async function runOllamaChatTurn(input: {
  baseUrl: string
  model: string
  messages: OllamaChatMessage[]
  signal: AbortSignal
  tools?: OllamaNativeToolDefinition[]
  temperature?: number
  jsonToolFallback?: boolean
  think?: 'low' | 'medium' | 'high'
  numCtx?: number
  numPredict?: number
  keepAlive?: string
  toolProtocolEnabled?: boolean
  availableToolNames?: string[]
  // Exact compact callable names used by constrained decoding. Hidden target
  // names live inside capability_invoke arguments rather than this enum.
  formatToolNames?: string[]
  /** Exact pre-resolved first-turn request body from OllamaFinalLaunchPlan. */
  request?: Record<string, unknown>
  launchAuthorized?: OllamaTransportLaunchAuthority
  onRetry?: (input: OllamaChatRetryCallbackInput) => void
  onContentDelta?: (input: OllamaChatTurnStreamCallbackInput) => void
  onThinkingUpdate?: (input: OllamaChatTurnThinkingCallbackInput) => void
}): Promise<OllamaChatTurnResult> {
  const options: Record<string, unknown> = {
    temperature: input.temperature ?? 0.2
  }
  if (typeof input.numCtx === 'number' && Number.isFinite(input.numCtx)) {
    options.num_ctx = Math.max(1024, Math.trunc(input.numCtx))
  }
  if (typeof input.numPredict === 'number' && Number.isFinite(input.numPredict)) {
    options.num_predict = Math.max(1, Math.trunc(input.numPredict))
  }
  const response = await fetchOllamaChatResponseWithRetry({
    baseUrl: input.baseUrl,
    signal: input.signal,
    launchAuthorized: input.launchAuthorized,
    onRetry: input.onRetry,
    request: input.request ?? {
      model: input.model,
      stream: true,
      messages: input.messages,
      ...(input.tools && input.tools.length ? { tools: input.tools } : {}),
      // Constrained decoding: on the json-tool-fallback path, pass a JSON SCHEMA
      // (envelope + tool-name enum) as `format`, not the bare 'json' string — the
      // model then cannot emit a wrong wrapper key or an invalid tool name.
      ...(input.jsonToolFallback
        ? {
            // Grammar and direct advertisement share the same immutable profile;
            // capability_invoke carries hidden target names as ordinary args.
            format:
              input.formatToolNames?.length
                ? ollamaToolCallFormatSchema(input.formatToolNames)
                : input.availableToolNames?.length
                  ? ollamaToolCallFormatSchema(input.availableToolNames)
                  : 'json'
          }
        : {}),
      ...(input.think ? { think: input.think } : {}),
      ...(input.keepAlive ? { keep_alive: input.keepAlive } : {}),
      options
    }
  })

  if (!response.ok || !response.body) {
    throw new Error(`Ollama chat failed with HTTP ${response.status}.`)
  }

  const decoder = new TextDecoder()
  let buffer = ''
  let content = ''
  let pendingStreamContent = ''
  let streamedContent = ''
  let thinking = ''
  let streamedThinking = ''
  const toolCalls: OllamaToolRequest[] = []
  const droppedNativeToolNames: string[] = []
  let lastDone: OllamaChatChunk | null = null
  const parseErrors: string[] = []
  const handleChunk = (chunk: OllamaChatChunk) => {
    if (chunk.error) {
      throw new Error(chunk.error)
    }
    const contentDelta = chunk.message?.content || ''
    content += contentDelta
    if (contentDelta && input.onContentDelta) {
      pendingStreamContent += contentDelta
      if (
        shouldReleaseOllamaContentDelta({
          content,
          pending: pendingStreamContent,
          streamed: streamedContent,
          jsonToolFallback: input.jsonToolFallback === true,
          toolProtocolEnabled: input.toolProtocolEnabled === true,
          availableToolNames: input.availableToolNames || []
        })
      ) {
        const delta = pendingStreamContent
        pendingStreamContent = ''
        streamedContent += delta
        input.onContentDelta({ delta, content, chunk })
      }
    }
    const thinkingDelta = chunk.message?.thinking || ''
    thinking += thinkingDelta
    if (
      thinkingDelta &&
      input.onThinkingUpdate &&
      shouldReleaseOllamaThinkingUpdate({
        thinking,
        streamedContent,
        toolProtocolEnabled: input.toolProtocolEnabled === true
      })
    ) {
      const delta = thinking.slice(streamedThinking.length)
      if (delta) {
        streamedThinking = thinking
        input.onThinkingUpdate({ delta, thinking, content, chunk })
      }
    }
    for (const call of chunk.message?.tool_calls || []) {
      const normalized = normalizeOllamaNativeToolCall(call)
      if (normalized) {
        toolCalls.push(normalized)
      } else {
        // Hallucinated / unknown tool name — record it so the run loop can send a
        // specific repair rather than silently dropping the call and misreading
        // the turn as empty/reasoning-only.
        const droppedName =
          typeof call.function?.name === 'string' ? call.function.name.trim() : ''
        if (droppedName) droppedNativeToolNames.push(droppedName)
      }
    }
    if (chunk.done) {
      lastDone = chunk
    }
  }
  const handleLine = (line: string) => {
    const trimmed = line.trim()
    if (!trimmed) return
    let parsed: OllamaChatChunk
    try {
      parsed = JSON.parse(trimmed) as OllamaChatChunk
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      parseErrors.push(`Malformed Ollama stream chunk ignored: ${message}`)
      return
    }
    handleChunk(parsed)
  }

  for await (const value of response.body as any as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''
    for (const line of lines) {
      handleLine(line)
    }
  }
  const trailing = buffer.trim()
  if (trailing) {
    handleLine(trailing)
  }
  return {
    content,
    thinking,
    toolCalls,
    droppedNativeToolNames,
    lastDone,
    parseErrors,
    streamedContent,
    streamedThinking
  }
}

export async function runOllamaProvider(
  deps: OllamaProviderDeps,
  event: Electron.IpcMainInvokeEvent,
  payload: AgentRunPayload,
  route: AgentRunRoute
): Promise<void> {
  const settings = deps.getSettings()
  const baseUrl = normalizeOllamaBaseUrl(settings.ollamaBaseUrl)
  const controller = new AbortController()
  let memoryMonitor: ReturnType<typeof createOllamaMemoryMonitor> | null = null
  let terminalStatus: RunSessionStatus = 'failed'
  let terminalProjectionStarted = false
  deps.runManager.attachAbortController(route.appRunId!, controller)
  const launchAuthorized = (): boolean =>
    !controller.signal.aborted &&
    deps.runManager.canAdmitTransport(route.appRunId, true)

  try {
    const launchPlan = await resolveOllamaFinalLaunchPlan(
      {
        baseUrl,
        requestedModel: payload.model,
        configuredDefaultModel: settings.ollamaDefaultModel,
        prompt: payload.prompt,
        scope: payload.scope,
        workspacePath: payload.workspace,
        toolExecutionAvailable: Boolean(deps.executeTool),
        mcpToolsPolicy: settings.agenticServices?.mcpTools,
        configuredNetworkAccess: settings.agenticServices?.networkAccess,
        effectiveNetworkAccess: payload.effectivePermissions?.networkAccess,
        readOnly: payload.effectivePermissions?.readOnly === true,
        ollamaRunProfile: payload.ollamaRunProfile,
        taskWraithMcpAdvertised: payload.taskWraithMcpAdvertised,
        taskWraithMcpProfileId: payload.taskWraithMcpProfileId,
        chatId: route.appChatId || payload.appChatId,
        ensemble: {
          enabled: Boolean(payload.ensembleRun),
          participantId: payload.ensembleRun?.participantId,
          contextChars: payload.ensembleRun?.ensembleContextChars,
          contextTurns: payload.ensembleRun?.ensembleContextTurns
        }
      },
      {
        loadInstalledModels: () =>
          fetchOllamaModels(
            { ...settings, ollamaBaseUrl: baseUrl },
            { signal: controller.signal }
          ),
        loadModelShow: (model) =>
          fetchOllamaModelShow(baseUrl, model, {
            signal: controller.signal,
            launchAuthorized
          }),
        modelLabel: humanizeOllamaModelId,
        buildNativeToolDefinitions: (input) =>
          ollamaNativeToolDefinitions('provider_parity', input),
        getSessionMemory: (chatId, memoryKey) =>
          deps.getOllamaSessionMemory?.(chatId, memoryKey),
        prepareEnsemblePrompt: prepareOllamaEnsemblePromptForRuntime,
        buildWorkspaceIndexBlock: buildOllamaWorkspaceIndexBlock,
        buildOpeningMessages: buildOllamaOpeningMessages,
        resolveNumCtx: resolveOllamaNumCtx
      }
    )
    if (!launchPlan) {
      terminalStatus = 'failed'
      terminalProjectionStarted = true
      deps.sendAgentCompatError(
        event.sender,
        'ollama',
        'Ollama is reachable, but no local model is installed. Pull a model with `ollama pull qwen3:4b-instruct`, `ollama pull qwen3.5:9b`, `ollama pull gemma4:12b`, `ollama pull ornith:9b`, `ollama pull laguna-xs-2.1:q8_0`, or `ollama pull gpt-oss`, then refresh models.',
        route
      )
      deps.sendAgentCompatExit(event.sender, 'ollama', 1, route)
      return
    }
    const {
      installedModels: models,
      model,
      modelLabel,
      toolProtocolEnabled,
      toolControlTier,
      runProfile,
      nativeToolsSupported,
      oneToolAtATime,
      nativeToolDefinitions: nativeToolDefs,
      availableToolNames,
      formatToolNames,
      temperature: modelTemperature,
      thinkingLevel,
      harnessEnabled
    } = launchPlan
    const modelInfo = launchPlan.modelManifest.merged
    const ensembleRun = Boolean(payload.ensembleRun)
    const chatId = route.appChatId || payload.appChatId
    const memoryKey = launchPlan.memoryKey ?? undefined
    let sessionMemory = JSON.parse(
      JSON.stringify(launchPlan.sessionMemory)
    ) as OllamaSessionMemory
    const messages = JSON.parse(
      JSON.stringify(launchPlan.openingMessages)
    ) as OllamaChatMessage[]
    const preflightKey = ollamaModelPreflightKey(model, modelInfo)
    if (
      shouldRunOllamaModelPreflight(settings.ollamaModelPreflightAt, preflightKey) &&
      deps.emitOllamaModelPreflight
    ) {
      const preflight = evaluateOllamaModelPreflight({
        modelId: model,
        modelLabel,
        modelInfo,
        installedModelIds: models.map((entry) => entry.id),
        totalMemoryBytes: deps.getTotalMemoryBytes?.() || 16 * 1024 ** 3
      })
      deps.emitOllamaModelPreflight(event.sender, preflight, route)
      deps.markOllamaModelPreflightComplete?.(preflightKey)
    }
    memoryMonitor = createOllamaMemoryMonitor()
    memoryMonitor.start()

    await deps.emitProviderCapabilityWarnings?.(
      event.sender,
      'ollama',
      payload.workspace,
      // Tier retirement (2026-07): report the run's actual permission role, not a
      // hardcoded 'plan' — Ollama now honors Plan/Read-Only/Default/Full like
      // every provider, so capability warnings must reflect the real posture.
      payload.approvalMode || 'default',
      route
    )

    deps.sendAgentCompatLine(
      event.sender,
      'ollama',
      {
        type: 'init',
        session_id: `ollama://${model}`,
        model,
        modelLabel,
        timestamp: new Date().toISOString()
      },
      route
    )

    let harnessState: OllamaHarnessRunState = createOllamaHarnessRunState()
    let lastDone: OllamaChatChunk | null = null
    let runUsageStats: Record<string, unknown> | undefined
    let toolCallCount = 0
    // Retry ceiling: a local model can get stuck emitting empty / malformed /
    // reasoning-only / arg-invalid turns and receive nudge after nudge forever
    // (the loop below has no natural cap). Count CONSECUTIVE non-productive turns
    // and finalize gracefully after this many, instead of looping until the user
    // cancels. Reset to 0 whenever the model does something productive (a tool
    // executes, or it answers).
    let consecutiveNonProductiveTurns = 0
    let forceJsonToolFallback =
      toolProtocolEnabled && (!nativeToolsSupported || runProfile.protocolMode === 'json_only')
    // Per-run (toolName+args) → result-signature store for the
    // repeated-tool-call guard: a model that re-issues an identical call
    // with an unchanged result gets a redirect instead of the re-dumped
    // output, so it stops burning its tool-loop budget re-reading files.
    const toolCallSignatures = new Map<string, string>()
    const emitOllamaContent = (text: string): void => {
      if (!text) return
      deps.sendAgentCompatLine(
        event.sender,
        'ollama',
        {
          type: 'content',
          text,
          model,
          modelLabel,
          timestamp: new Date().toISOString()
        },
        route
      )
    }
    const unstreamedOllamaContent = (text: string, streamed: string): string => {
      if (!streamed) return text
      if (text === streamed) return ''
      if (text === streamed.trimEnd()) return ''
      if (text.startsWith(streamed)) return text.slice(streamed.length)
      const trimmedStreamed = streamed.trimEnd()
      if (trimmedStreamed && text.startsWith(trimmedStreamed)) {
        return text.slice(trimmedStreamed.length).trimStart()
      }
      return text
    }
    for (let turnIndex = 0; ; turnIndex += 1) {
      assertOllamaTransportLaunchAuthorized(controller.signal, launchAuthorized)
      if (consecutiveNonProductiveTurns >= OLLAMA_MAX_CONSECUTIVE_NON_PRODUCTIVE_TURNS) {
        emitOllamaContent(ollamaCeilingFinalizeContent({ ensembleRun }))
        break
      }
      const jsonToolFallback =
        turnIndex === 0
          ? Object.prototype.hasOwnProperty.call(launchPlan.firstRequest, 'format')
          : forceJsonToolFallback ||
            runProfile.protocolMode === 'json_fallback' ||
            (nativeToolDefs.length === 0 &&
              toolProtocolEnabled &&
              ollamaPrefersJsonToolProtocol(model, modelInfo))
      const numPredict = toolCallCount > 0 ? runProfile.numPredictFinal : runProfile.numPredictTool
      const reasoningId = `ollama-thinking-${route.appRunId || 'run'}-${turnIndex}`
      let streamedThinkingStarted = false
      let streamedThinkingText = ''
      const emitOllamaThinkingUpdate = (thinkingText: string): void => {
        if (!thinkingText) return
        if (!streamedThinkingStarted) {
          deps.sendAgentCompatLine(
            event.sender,
            'ollama',
            {
              type: 'tool_use',
              tool_id: reasoningId,
              tool_name: 'ollama_thinking',
              kind: 'think',
              parameters: { title: 'Thinking' },
              provider: 'ollama',
              server: OLLAMA_LOCAL_TOOL_SERVER
            },
            route
          )
          streamedThinkingStarted = true
        }
        streamedThinkingText = thinkingText
        const visible = !toolProtocolEnabled && !looksLikeOllamaPromptRestatement(thinkingText)
        deps.sendAgentCompatLine(
          event.sender,
          'ollama',
          {
            type: 'tool_result',
            tool_id: reasoningId,
            tool_name: 'ollama_thinking',
            status: 'success',
            output: thinkingText,
            provider: 'ollama',
            server: OLLAMA_LOCAL_TOOL_SERVER,
            ...(visible ? {} : { transcriptVisible: false })
          },
          route
        )
      }
      const turn = await runOllamaChatTurn({
        baseUrl,
        model,
        messages,
        signal: controller.signal,
        tools: jsonToolFallback ? [] : nativeToolDefs,
        jsonToolFallback,
        ...(modelTemperature != null ? { temperature: modelTemperature } : {}),
        ...(thinkingLevel ? { think: thinkingLevel } : {}),
        numCtx: resolveOllamaNumCtx({
          messages,
          tools: jsonToolFallback ? [] : nativeToolDefs,
          modelInfo,
          contextCapTokens: runProfile.contextCapTokens,
          reserveTokens: runProfile.numPredictFinal
        }),
        ...(numPredict ? { numPredict } : {}),
        ...(runProfile.keepAlive ? { keepAlive: runProfile.keepAlive } : {}),
        toolProtocolEnabled,
        availableToolNames,
        formatToolNames,
        request: turnIndex === 0 ? launchPlan.firstRequest : undefined,
        launchAuthorized,
        onRetry: ({ attempt, maxAttempts, delayMs, error }) => {
          deps.sendAgentCompatLine(
            event.sender,
            'ollama',
            {
              type: 'provider_warning',
              id: 'ollama-chat-transport-retry',
              severity: 'warning',
              title: 'Retrying Ollama connection',
              message: `Ollama dropped the local chat request (${error}). Retrying ${attempt + 1}/${maxAttempts} in ${delayMs}ms.`
            },
            route
          )
        },
        onContentDelta: ({ delta }) => {
          emitOllamaContent(delta)
        },
        onThinkingUpdate: ({ thinking }) => {
          emitOllamaThinkingUpdate(thinking)
        }
      })
      // A response body can resolve re-entrantly with Stop/history-clear
      // projection. Re-check the exact run before interpreting that resolved
      // turn or dispatching any tool it requested.
      assertOllamaTransportLaunchAuthorized(controller.signal, launchAuthorized)
      for (const parseError of turn.parseErrors.slice(0, 3)) {
        deps.sendAgentCompatLine(
          event.sender,
          'ollama',
          {
            type: 'provider_warning',
            id: 'ollama-stream-parse-warning',
            severity: 'warning',
            title: 'Ollama stream chunk skipped',
            message: parseError
          },
          route
        )
      }
      if (turn.lastDone) {
        lastDone = turn.lastDone
        runUsageStats = accumulateOllamaUsageStats(runUsageStats, turn.lastDone)
      }
      // gpt-oss and other harmony-format models emit their answer into the
      // reasoning (`thinking`) channel and may leave `content` empty; fall
      // back so the run still produces a visible reply instead of nothing.
      const visibleText = resolveOllamaVisibleText(turn)
      // Prefer native structured tool calls (Ollama `tools` API). Models that
      // ignore the schema and instead embed the legacy JSON-in-prose protocol
      // still work via the fallback parser.
      const nativeCalls = toolProtocolEnabled ? turn.toolCalls : []
      const usingNativeToolCalls = nativeCalls.length > 0
      const fallbackRequest =
        !usingNativeToolCalls && toolProtocolEnabled
          ? parseOllamaToolRequest(visibleText)
          : null
      let toolRequests: OllamaToolRequest[] = usingNativeToolCalls
        ? nativeCalls
        : fallbackRequest
          ? [fallbackRequest]
          : []
      if (oneToolAtATime && toolRequests.length > 1) {
        toolRequests = toolRequests.slice(0, 1)
      }
      // Surface the model's reasoning (`thinking`) channel as a streamed
      // reasoning note so it renders inside the live activity viewport — except
      // when thinking is being promoted to the visible answer (no content + no
      // tool call), where emitting it here would duplicate the final reply.
      const hasReasoningTrace = turn.thinking.trim().length > 0
      const reasoningIsVisibleAnswer = toolRequests.length === 0 && !turn.content.trim()
      const emitVisibleReasoning = shouldEmitOllamaReasoning(turn, toolRequests.length)
      if (hasReasoningTrace && !reasoningIsVisibleAnswer) {
        if (streamedThinkingStarted) {
          if (turn.thinking !== streamedThinkingText) {
            deps.sendAgentCompatLine(
              event.sender,
              'ollama',
              {
                type: 'tool_result',
                tool_id: reasoningId,
                tool_name: 'ollama_thinking',
                status: 'success',
                output: turn.thinking,
                provider: 'ollama',
                server: OLLAMA_LOCAL_TOOL_SERVER,
                ...(emitVisibleReasoning ? {} : { transcriptVisible: false })
              },
              route
            )
          }
        } else {
          deps.sendAgentCompatLine(
            event.sender,
            'ollama',
            {
              type: 'tool_use',
              tool_id: reasoningId,
              tool_name: 'ollama_thinking',
              kind: 'think',
              parameters: { title: 'Thinking' },
              provider: 'ollama',
              server: OLLAMA_LOCAL_TOOL_SERVER,
              ...(emitVisibleReasoning ? {} : { transcriptVisible: false })
            },
            route
          )
          deps.sendAgentCompatLine(
            event.sender,
            'ollama',
            {
              type: 'tool_result',
              tool_id: reasoningId,
              tool_name: 'ollama_thinking',
              status: 'success',
              output: turn.thinking,
              provider: 'ollama',
              server: OLLAMA_LOCAL_TOOL_SERVER,
              ...(emitVisibleReasoning ? {} : { transcriptVisible: false })
            },
            route
          )
        }
      }
      if (toolRequests.length === 0) {
        // No structured tool call this turn. Every branch below either nudges
        // and `continue`s (non-productive — count it toward the ceiling) or
        // emits a final answer and `break`s (loop ends, counter irrelevant).
        consecutiveNonProductiveTurns += 1
        const hasContent = turn.content.trim().length > 0
        // Hallucinated native tool name: the model DID try to call a tool, but
        // the name isn't real, so it was dropped. Give a name-specific repair
        // (not the generic empty/reasoning steer) so it fixes the name or uses
        // tool_help, instead of being told it "said nothing".
        if (toolProtocolEnabled && turn.droppedNativeToolNames.length > 0) {
          forceJsonToolFallback = true
          messages.push({
            role: 'user',
            content: ollamaUnknownToolNameNudgePrompt(
              turn.droppedNativeToolNames,
              availableToolNames,
              { ensembleRun }
            )
          })
          continue
        }
        // Reasoning-only (or empty) turn while tools are available: nudge the
        // model to either call a tool or answer in prose rather than surfacing
        // hidden chain-of-thought as the final answer.
        if (!hasContent && toolProtocolEnabled) {
          messages.push({
            role: 'user',
            content:
              toolCallCount > 0
                ? ollamaEmptyToolResponseRetryPrompt({ ensembleRun })
                : ollamaReasoningOnlyNudgePrompt({ ensembleRun })
          })
          continue
        }
        if (!visibleText.trim()) {
          messages.push({
            role: 'user',
            content:
              toolCallCount > 0
                ? ollamaEmptyToolResponseRetryPrompt({ ensembleRun })
                : ollamaEmptyResponseRetryPrompt({ ensembleRun })
          })
          continue
        }
        // Leaked tool protocol: the model tried to emit the taskwraith_tool
        // JSON contract but it couldn't be parsed (e.g. invalid escapes from
        // embedded source code). Re-prompt to re-issue valid JSON rather than
        // leaking the raw blob to the user as the final answer.
        if (
          hasContent &&
          toolProtocolEnabled &&
          looksLikeLeakedOllamaToolProtocol(turn.content)
        ) {
          forceJsonToolFallback = true
          messages.push({ role: 'assistant', content: turn.content })
          messages.push({ role: 'user', content: ollamaMalformedToolJsonNudgePrompt({ ensembleRun }) })
          continue
        }
        // Tool-intent stub: the model announced a tool in prose ("We need to
        // use web_search") but emitted no structured tool call, then stopped.
        // Re-prompt it to actually call the tool instead of handing the stub
        // back to the user.
        if (
          hasContent &&
          toolProtocolEnabled &&
          looksLikeOllamaToolIntent(turn.content, availableToolNames)
        ) {
          forceJsonToolFallback = true
          messages.push({ role: 'assistant', content: turn.content })
          messages.push({
            role: 'user',
            content: ollamaToolIntentNudgePrompt(availableToolNames, { ensembleRun })
          })
          continue
        }
        const outputTokens =
          typeof lastDone?.eval_count === 'number' ? lastDone.eval_count : null
        if (isDegenerateOllamaTurn(turn, visibleText, toolRequests.length, outputTokens)) {
          if (turn.content.trim()) {
            messages.push({ role: 'assistant', content: turn.content })
          }
          messages.push({ role: 'user', content: ollamaDegenerateResponseNudgePrompt({ ensembleRun }) })
          continue
        }
        if (visibleText) {
          emitOllamaContent(unstreamedOllamaContent(visibleText, turn.streamedContent))
        }
        break
      }
      // Echo the assistant's native tool-call turn so the model keeps a coherent
      // transcript across the stateless HTTP loop.
      let goalLifecycleStopContent: string | null = null
      const preToolContent = ollamaPreToolContentText(turn, usingNativeToolCalls)
      if (preToolContent) {
        emitOllamaContent(unstreamedOllamaContent(preToolContent, turn.streamedContent))
      }
      if (usingNativeToolCalls) {
        messages.push({
          role: 'assistant',
          content: turn.content || '',
          tool_calls: toolRequests.map((request) => ({
            function: { name: request.toolName, arguments: request.arguments }
          }))
        })
      }
      // Reset the ceiling only when a tool actually executes (not when the
      // model just re-emits an arg-invalid call that fails pre-execution).
      let productiveToolRanThisTurn = false
      for (const toolRequest of toolRequests) {
        toolCallCount += 1
        const toolId = `ollama-tool-${route.appRunId || Date.now()}-${toolCallCount}`
        deps.sendAgentCompatLine(
          event.sender,
          'ollama',
          {
            type: 'tool_use',
            tool_id: toolId,
            tool_name: toolRequest.toolName,
            parameters: toolRequest.arguments,
            provider: 'ollama',
            server: OLLAMA_LOCAL_TOOL_SERVER
          },
          route
        )
        let toolResult: OllamaToolExecutionResult
        const toolExecutionRequest: OllamaToolExecutionRequest = {
          toolName: toolRequest.toolName,
          arguments: toolRequest.arguments,
          workspacePath: payload.workspace!,
          appChatId: route.appChatId || payload.appChatId,
          appRunId: route.appRunId || payload.appRunId,
          toolControlTier
        }
        const hostCommandProjection = deps.createHostCommandProjection?.(toolExecutionRequest)
        const harnessGate = harnessEnabled
          ? evaluateOllamaHarnessGate({
              modelId: model,
              tier: toolControlTier,
              state: harnessState,
              toolName: toolRequest.toolName,
              args: toolRequest.arguments
            })
          : { blocked: false as const }
        try {
          if (harnessGate.blocked) {
            toolResult = {
              ok: false,
              output: harnessGate.message || 'Harness gate blocked this tool call.'
            }
          } else {
            const executeTool = () => {
              // Host-command projection may synchronously trigger Stop before
              // invoking this callback. Keep the final claim fence adjacent to
              // the actual tool dispatch.
              assertOllamaTransportLaunchAuthorized(controller.signal, launchAuthorized)
              return deps.executeTool!(toolExecutionRequest)
            }
            toolResult = hostCommandProjection
              ? await hostCommandProjection.run(executeTool)
              : await executeTool()
          }
          // Stop can land while a brokered/local tool is awaiting approval or
          // completion. Do not publish its result into a new model turn, and
          // do not allow the next `/api/chat` continuation to cross the
          // already-claimed terminal boundary.
          assertOllamaTransportLaunchAuthorized(controller.signal, launchAuthorized)
          // Progress = a tool that ACTUALLY executed. A harness-gate block and an
          // arg-invalid (validationError) result are both pre-execution redirects
          // with their own repair message — no tool ran, so they count as
          // non-productive and feed the retry ceiling. Otherwise a model that
          // re-hits the harness gate every turn would reset the counter forever.
          if (!harnessGate.blocked && !toolResult.validationError) {
            productiveToolRanThisTurn = true
          }
          if (harnessEnabled) {
            harnessState = recordOllamaHarnessToolResult(
              harnessState,
              toolRequest.toolName,
              toolRequest.arguments,
              toolResult.ok
            )
          }
          deps.sendAgentCompatLine(
            event.sender,
            'ollama',
            {
              type: 'tool_result',
              tool_id: toolId,
              tool_name: toolRequest.toolName,
              status: toolResult.ok ? 'success' : 'error',
              output: toolResult.output,
              result: toolResult.structuredContent,
              provider: 'ollama',
              server: OLLAMA_LOCAL_TOOL_SERVER
            },
            route
          )
        } finally {
          hostCommandProjection?.complete()
        }
        const truncatedOutput = truncateOllamaToolResultOutput(
          toolResult.output,
          OLLAMA_TOOL_RESULT_MAX_CHARS,
          toolRequest.toolName
        )
        // Repeated-tool-call guard: if this exact call already returned the
        // same result earlier this run, feed the model a redirect instead of
        // re-dumping identical output. The UI tool_result + trajectory below
        // still record the real read; only the model-facing follow-up changes.
        const noActiveGoalToolResult = isOllamaNoActiveGoalToolResult(
          toolRequest.toolName,
          toolResult
        )
        let modelFacingOutput = noActiveGoalToolResult
          ? ollamaNoActiveGoalToolNudge(toolRequest.toolName, { ensembleRun })
          : toolResult.validationError
            ? ollamaToolArgumentRepairPrompt({
                toolName: toolRequest.toolName,
                output: truncatedOutput,
                ensembleRun
              })
            : truncatedOutput
        if (toolResult.ok || noActiveGoalToolResult) {
          const repeat = evaluateOllamaRepeatedToolCall(
            toolCallSignatures,
            toolRequest.toolName,
            toolRequest.arguments,
            toolResult.output
          )
          if (repeat.repeated) {
            modelFacingOutput = noActiveGoalToolResult
              ? ollamaNoActiveGoalToolNudge(toolRequest.toolName, { repeated: true, ensembleRun })
              : ollamaRepeatedToolCallNudge(toolRequest.toolName, { ensembleRun })
          }
        }
        sessionMemory = appendOllamaTrajectoryEntry(sessionMemory, {
          toolName: toolRequest.toolName,
          args: toolRequest.arguments,
          ok: toolResult.ok,
          resultSummary: truncatedOutput,
          canvasEvalApproval: toolResult.canvasEvalApproval
        })
        goalLifecycleStopContent = toolResult.ok
          ? ollamaGoalLifecycleStopContent(toolRequest.toolName)
          : null
        if (goalLifecycleStopContent) {
          deps.sendAgentCompatLine(
            event.sender,
            'ollama',
            {
              type: 'content',
              text: goalLifecycleStopContent,
              model,
              modelLabel,
              timestamp: new Date().toISOString()
            },
            route
          )
          break
        }
        if (shouldRollOllamaRunSummary(sessionMemory.toolTurnCount)) {
          messages.splice(
            0,
            messages.length,
            ...(compressOllamaMessagesWithWorkingMemory(
              messages,
              sessionMemory.workingMemory
            ) as OllamaChatMessage[])
          )
        }
        if (usingNativeToolCalls) {
          // Native protocol: feed the result back as a `role: 'tool'` message
          // so the model resumes naturally on the next turn.
          messages.push({
            role: 'tool',
            content: modelFacingOutput,
            tool_name: toolRequest.toolName
          })
        } else {
          messages.push({
            role: 'assistant',
            content: `Requested TaskWraith tool ${toolRequest.toolName}.`
          })
          messages.push({
            role: 'user',
            content: toolResult.validationError
              ? modelFacingOutput
              : harnessEnabled
                ? ollamaHarnessToolFollowUpPrompt({
                    toolName: toolRequest.toolName,
                    output: modelFacingOutput,
                    ok: toolResult.ok,
                    state: harnessState,
                    tier: toolControlTier,
                    ensembleRun
                  })
                : ollamaToolResultFollowUpPrompt({
                    toolName: toolRequest.toolName,
                    output: modelFacingOutput,
                    ok: toolResult.ok
                  })
          })
        }
      }
      if (productiveToolRanThisTurn) {
        consecutiveNonProductiveTurns = 0
      } else {
        consecutiveNonProductiveTurns += 1
      }
      if (goalLifecycleStopContent) {
        break
      }
    }

    if (chatId && deps.saveOllamaSessionMemory && sessionMemory.toolTurnCount > 0) {
      deps.saveOllamaSessionMemory(chatId, pruneOllamaSessionMemoryForPersist(sessionMemory), memoryKey)
    }

    const hardwareStats = memoryMonitor ? await memoryMonitor.stop() : {}
    memoryMonitor = null
    assertOllamaTransportLaunchAuthorized(controller.signal, launchAuthorized)
    terminalStatus = 'completed'
    terminalProjectionStarted = true
    deps.sendAgentCompatLine(
      event.sender,
      'ollama',
      {
        type: 'result',
        status: 'success',
        model,
        modelLabel,
        stats: {
          ...(runUsageStats || {}),
          ...(toolCallCount > 0 ? { taskWraithToolCalls: toolCallCount } : {}),
          ...hardwareStats
        }
      },
      route
    )
    deps.sendAgentCompatExit(event.sender, 'ollama', 0, route)
  } catch (error) {
    // Terminal projectors are outside provider execution. If one throws, keep
    // the outcome already selected and let the sole finally settlement run;
    // do not recursively project a contradictory second terminal outcome.
    if (terminalProjectionStarted) throw error
    if (memoryMonitor) {
      await memoryMonitor.stop().catch(() => {})
      memoryMonitor = null
    }
    const aborted = controller.signal.aborted || isAbortLikeError(error)
    const claimedTerminalStatus = deps.runManager.getClaimedTerminalStatus(route.appRunId)
    terminalStatus = claimedTerminalStatus ?? (aborted ? 'cancelled' : 'failed')
    terminalProjectionStarted = true
    const cancelled = terminalStatus === 'cancelled'
    const message = cancelled
      ? 'Ollama run cancelled.'
      : ollamaRunFailureMessage(error, baseUrl)
    deps.sendAgentCompatError(event.sender, 'ollama', message, route)
    deps.sendAgentCompatExit(event.sender, 'ollama', cancelled ? 130 : 1, route)
  } finally {
    const effectiveTerminalStatus =
      deps.runManager.getClaimedTerminalStatus(route.appRunId) ?? terminalStatus
    try {
      deps.runManager.finish(route.appRunId, effectiveTerminalStatus)
    } finally {
      deps.runManager.confirmTerminalStatus(route.appRunId, effectiveTerminalStatus)
    }
  }
}
