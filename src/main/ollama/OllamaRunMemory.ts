import { summarizeOllamaToolArgs } from './OllamaToolResultSummary'
import { resolveContextWindow } from '../../shared/contextWindows'
import { resolveOllamaModelFamily } from './OllamaModelPreflight'
import { canonicalTaskWraithToolName } from '../TaskWraithMcpTools'
import {
  CANVAS_EVAL_RESULT_REDACTED,
  assertCanvasEvalApprovalReceipt,
  isCanvasEvalToolName
} from '../canvas/CanvasEvalAudit'
import type { CanvasEvalApprovalReceipt } from '../canvas/canvasTypes'
import { redactPermissionOpportunityIdsForDurableStorage } from '../../shared/permissionOpportunityRedaction'

export interface OllamaLoopMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_calls?: unknown[]
  tool_name?: string
}

export const OLLAMA_ROLLING_SUMMARY_AFTER_TOOL_TURNS = 3
export const OLLAMA_WORKING_MEMORY_MAX_CHARS = 1800
export const OLLAMA_TOOL_RESULT_MEMORY_MAX_CHARS = 220
export const CANVAS_FILL_RESULT_REDACTED =
  'Canvas fill result redacted; typed value is not retained.'

export interface OllamaWorkingMemoryLimits {
  toolResultMaxChars: number
  workingMemoryMaxChars: number
}

export interface OllamaToolTrajectoryEntry {
  toolName: string
  /** The gateway target when it differs from the outer callable name. */
  effectiveToolName?: string
  argsSummary: string
  ok: boolean
  resultSummary: string
  /** Content-minimised proof only; the approved script is never retained here. */
  canvasEvalReceipt?: CanvasEvalApprovalReceipt
}

export interface OllamaSessionMemory {
  modelId: string
  updatedAt: number
  workingMemory: string
  toolTurnCount: number
  trajectory?: OllamaToolTrajectoryEntry[]
}

export type OllamaSessionMemoryMap = Record<string, OllamaSessionMemory>

export function normalizeOllamaSessionMemory(
  memory: OllamaSessionMemory | null | undefined
): OllamaSessionMemory | null {
  if (!memory) return null
  const trajectory = memory.trajectory ?? []
  const containsSensitiveCanvas = trajectory.some(
    (entry) => isCanvasEvalTrajectoryEntry(entry) || isCanvasFillTrajectoryEntry(entry)
  )
  const sanitizedTrajectory = trajectory.map(sanitizeOllamaTrajectoryEntryForPersist)
  return {
    ...memory,
    trajectory: sanitizedTrajectory,
    workingMemory: containsSensitiveCanvas
      ? buildOllamaWorkingMemoryBlock(
          sanitizedTrajectory,
          resolveOllamaWorkingMemoryLimits(memory.modelId).workingMemoryMaxChars
        )
      : redactPermissionOpportunityIdsForDurableStorage(memory.workingMemory)
  }
}

function isSafeOllamaSessionMemoryKey(key: string): boolean {
  return /^[a-zA-Z0-9:_-]{1,160}$/.test(key)
}

export function normalizeOllamaSessionMemoryMap(
  memories: OllamaSessionMemoryMap | null | undefined
): OllamaSessionMemoryMap {
  const normalized: OllamaSessionMemoryMap = {}
  if (!memories || typeof memories !== 'object') return normalized
  for (const [key, memory] of Object.entries(memories)) {
    if (!isSafeOllamaSessionMemoryKey(key)) continue
    const next = normalizeOllamaSessionMemory(memory)
    if (next) normalized[key] = next
  }
  return normalized
}

export function upsertOllamaSessionMemory(
  memories: OllamaSessionMemoryMap | null | undefined,
  key: string,
  memory: OllamaSessionMemory,
  maxEntries = 32
): OllamaSessionMemoryMap {
  if (!isSafeOllamaSessionMemoryKey(key)) return normalizeOllamaSessionMemoryMap(memories)
  const next = {
    ...normalizeOllamaSessionMemoryMap(memories),
    [key]: memory
  }
  return Object.fromEntries(
    Object.entries(next)
      .sort(([, a], [, b]) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .slice(0, maxEntries)
  )
}

export function createEmptyOllamaSessionMemory(modelId: string): OllamaSessionMemory {
  return {
    modelId,
    updatedAt: Date.now(),
    workingMemory: '',
    toolTurnCount: 0,
    trajectory: []
  }
}

function scaledWorkingMemoryLimits(
  modelId: string,
  input: {
    toolResultMaxChars: number
    contextShare: number
    maxWorkingMemoryChars: number
  }
): OllamaWorkingMemoryLimits {
  const contextWindow = resolveContextWindow('ollama', modelId)
  return {
    toolResultMaxChars: input.toolResultMaxChars,
    workingMemoryMaxChars: Math.max(
      OLLAMA_WORKING_MEMORY_MAX_CHARS,
      Math.min(input.maxWorkingMemoryChars, Math.round(contextWindow * input.contextShare))
    )
  }
}

export function resolveOllamaWorkingMemoryLimits(
  modelId?: string | null
): OllamaWorkingMemoryLimits {
  const trimmedModelId = String(modelId || '').trim()
  const family = resolveOllamaModelFamily(trimmedModelId)
  switch (family) {
    case 'qwen3_4b':
    case 'qwen3_5_2b':
    case 'qwen3_5_4b':
    case 'gemma3_4b':
    case 'lfm2_5_thinking_1_2b':
    case 'granite4_3b':
    case 'granite4_1_3b':
    case 'granite4_2_3b':
    case 'nemotron3_nano_4b':
    case 'ministral_3_3b':
    case 'deepseek_r1_1_5b':
    case 'llama3_2_3b':
      return scaledWorkingMemoryLimits(trimmedModelId, {
        toolResultMaxChars: 420,
        contextShare: 0.018,
        maxWorkingMemoryChars: 4200
      })
    case 'minicpm_v45_8b':
      return scaledWorkingMemoryLimits(trimmedModelId, {
        toolResultMaxChars: 520,
        contextShare: 0.08,
        maxWorkingMemoryChars: 4200
      })
    case 'qwen3_5_9b':
    case 'gemma4_12b':
    case 'ornith_9b':
    case 'lfm2_5_8b':
    case 'gpt_oss_20b':
    case 'granite4_1_30b':
    case 'granite4_2_8b':
    case 'ministral_3_14b':
    case 'llama3_1_8b':
    case 'deepseek_r1_8b':
    case 'rnj_1_8b':
      return scaledWorkingMemoryLimits(trimmedModelId, {
        toolResultMaxChars: 760,
        contextShare: 0.035,
        maxWorkingMemoryChars: 7200
      })
    case 'qwen3_6_35b':
    case 'qwen3_8_27b':
    case 'qwen3_8_flash_next_125b':
    case 'ornith_35b':
    case 'laguna_xs_2_1':
    case 'nemotron3_33b':
    case 'nemotron3_5_lightning_30b':
    case 'devstral_small_2_24b':
    case 'mistral_medium_3_5_128b':
    case 'granite4_2_30b':
    case 'glm_4_7_flash':
    case 'north_mini_code_1_0':
    case 'muse_glimmer_30b':
      return scaledWorkingMemoryLimits(trimmedModelId, {
        toolResultMaxChars: 1200,
        contextShare: 0.045,
        maxWorkingMemoryChars: 12_000
      })
    default:
      return {
        toolResultMaxChars: OLLAMA_TOOL_RESULT_MEMORY_MAX_CHARS,
        workingMemoryMaxChars: OLLAMA_WORKING_MEMORY_MAX_CHARS
      }
  }
}

function summarizeToolResultForMemory(
  output: string,
  maxChars = OLLAMA_TOOL_RESULT_MEMORY_MAX_CHARS
): string {
  const normalized = output.replace(/\s+/g, ' ').trim()
  if (!normalized) return '(empty)'
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, maxChars)}...`
}

interface CanvasEvalMemoryInvocation {
  effectiveToolName: 'canvas_eval'
  targetArgs: Record<string, unknown>
  viaGateway: boolean
}

interface CanvasFillMemoryInvocation {
  effectiveToolName: 'canvas_fill'
  route: 'direct' | 'gateway' | 'permission_retry' | 'gateway_permission_retry'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function resolveCanvasEvalMemoryInvocation(
  toolName: string,
  args: Record<string, unknown>
): CanvasEvalMemoryInvocation | null {
  if (isCanvasEvalToolName(toolName)) {
    return { effectiveToolName: 'canvas_eval', targetArgs: args, viaGateway: false }
  }
  if (
    canonicalTaskWraithToolName(toolName) !== 'capability_invoke' ||
    !isCanvasEvalToolName(args.name)
  ) {
    return null
  }
  return {
    effectiveToolName: 'canvas_eval',
    targetArgs: isRecord(args.arguments) ? args.arguments : {},
    viaGateway: true
  }
}

function resolveCanvasFillMemoryInvocation(
  toolName: string,
  args: Record<string, unknown>
): CanvasFillMemoryInvocation | null {
  const canonical = canonicalTaskWraithToolName(toolName)
  if (canonical === 'canvas_fill') {
    return { effectiveToolName: 'canvas_fill', route: 'direct' }
  }
  if (canonical === 'request_tool_permission') {
    return typeof args.toolName === 'string' &&
      canonicalTaskWraithToolName(args.toolName) === 'canvas_fill'
      ? { effectiveToolName: 'canvas_fill', route: 'permission_retry' }
      : null
  }
  if (canonical !== 'capability_invoke') return null
  const target = typeof args.name === 'string' ? canonicalTaskWraithToolName(args.name) : undefined
  if (target === 'canvas_fill') {
    return { effectiveToolName: 'canvas_fill', route: 'gateway' }
  }
  if (target !== 'request_tool_permission' || !isRecord(args.arguments)) return null
  return typeof args.arguments.toolName === 'string' &&
    canonicalTaskWraithToolName(args.arguments.toolName) === 'canvas_fill'
    ? { effectiveToolName: 'canvas_fill', route: 'gateway_permission_retry' }
    : null
}

function normalizeCanvasEvalReceipt(value: unknown): CanvasEvalApprovalReceipt | undefined {
  if (!isRecord(value)) return undefined
  const approvalId = typeof value.approvalId === 'string' ? value.approvalId.trim() : ''
  const scriptHash = typeof value.scriptHash === 'string' ? value.scriptHash : ''
  if (
    value.schemaVersion !== 2 ||
    !approvalId ||
    approvalId.length > 200 ||
    value.scriptHashAlgorithm !== 'sha256-utf16le' ||
    !/^[a-f0-9]{64}$/.test(scriptHash) ||
    !Number.isSafeInteger(value.scriptLength) ||
    Number(value.scriptLength) < 0 ||
    !Number.isSafeInteger(value.scriptByteLength) ||
    Number(value.scriptByteLength) < 0
  ) {
    return undefined
  }
  return {
    schemaVersion: 2,
    approvalId,
    scriptHashAlgorithm: 'sha256-utf16le',
    scriptHash,
    scriptLength: Number(value.scriptLength),
    scriptByteLength: Number(value.scriptByteLength)
  }
}

function canvasEvalReceiptForMemory(
  invocation: CanvasEvalMemoryInvocation,
  receipt: CanvasEvalApprovalReceipt | undefined
): CanvasEvalApprovalReceipt | undefined {
  const script = invocation.targetArgs.script
  if (typeof script !== 'string' || !receipt) return undefined
  try {
    return normalizeCanvasEvalReceipt(assertCanvasEvalApprovalReceipt(script, receipt))
  } catch {
    // A missing or mismatched receipt must never weaken redaction. The
    // execution lane owns fail-closed receipt validation; memory simply omits
    // unverifiable metadata while retaining no sensitive text.
    return undefined
  }
}

function canvasEvalArgsSummary(toolName: string, viaGateway: boolean): string {
  return viaGateway
    ? `${toolName} name=canvas_eval script=[redacted]`
    : `${toolName} script=[redacted]`
}

function canvasFillArgsSummary(toolName: string, invocation: CanvasFillMemoryInvocation): string {
  switch (invocation.route) {
    case 'gateway':
      return `${toolName} name=canvas_fill value=[redacted]`
    case 'permission_retry':
      return `${toolName} target=canvas_fill value=[redacted]`
    case 'gateway_permission_retry':
      return `${toolName} name=request_tool_permission target=canvas_fill value=[redacted]`
    default:
      return `${toolName} value=[redacted]`
  }
}

function isCanvasEvalTrajectoryEntry(entry: OllamaToolTrajectoryEntry): boolean {
  return (
    isCanvasEvalToolName(entry.toolName) ||
    isCanvasEvalToolName(entry.effectiveToolName) ||
    (canonicalTaskWraithToolName(entry.toolName) === 'capability_invoke' &&
      /\bname=canvas_eval\b/.test(entry.argsSummary))
  )
}

function isCanvasFillTrajectoryEntry(entry: OllamaToolTrajectoryEntry): boolean {
  return (
    canonicalTaskWraithToolName(entry.toolName) === 'canvas_fill' ||
    canonicalTaskWraithToolName(entry.effectiveToolName || '') === 'canvas_fill' ||
    /\b(?:name|target)=canvas_fill\b/.test(entry.argsSummary)
  )
}

/** Defense-in-depth projection used again at the final persistence boundary. */
export function sanitizeOllamaTrajectoryEntryForPersist(
  entry: OllamaToolTrajectoryEntry
): OllamaToolTrajectoryEntry {
  const redactedEntry = redactPermissionOpportunityIdsForDurableStorage(entry)
  if (isCanvasEvalTrajectoryEntry(redactedEntry)) {
    const viaGateway = canonicalTaskWraithToolName(redactedEntry.toolName) === 'capability_invoke'
    const canvasEvalReceipt = normalizeCanvasEvalReceipt(redactedEntry.canvasEvalReceipt)
    return {
      toolName: redactedEntry.toolName,
      effectiveToolName: 'canvas_eval',
      argsSummary: canvasEvalArgsSummary(redactedEntry.toolName, viaGateway),
      ok: redactedEntry.ok,
      resultSummary: CANVAS_EVAL_RESULT_REDACTED,
      ...(canvasEvalReceipt ? { canvasEvalReceipt } : {})
    }
  }
  if (!isCanvasFillTrajectoryEntry(redactedEntry)) return redactedEntry
  const route: CanvasFillMemoryInvocation['route'] =
    canonicalTaskWraithToolName(redactedEntry.toolName) === 'canvas_fill'
      ? 'direct'
      : /\bname=request_tool_permission\b/.test(redactedEntry.argsSummary)
        ? 'gateway_permission_retry'
        : canonicalTaskWraithToolName(redactedEntry.toolName) === 'request_tool_permission'
          ? 'permission_retry'
          : 'gateway'
  return {
    toolName: redactedEntry.toolName,
    effectiveToolName: 'canvas_fill',
    argsSummary: canvasFillArgsSummary(redactedEntry.toolName, {
      effectiveToolName: 'canvas_fill',
      route
    }),
    ok: redactedEntry.ok,
    resultSummary: CANVAS_FILL_RESULT_REDACTED
  }
}

export function appendOllamaTrajectoryEntry(
  memory: OllamaSessionMemory,
  entry: Omit<
    OllamaToolTrajectoryEntry,
    'argsSummary' | 'effectiveToolName' | 'canvasEvalReceipt'
  > & {
    args: Record<string, unknown>
    canvasEvalApproval?: CanvasEvalApprovalReceipt
  }
): OllamaSessionMemory {
  const limits = resolveOllamaWorkingMemoryLimits(memory.modelId)
  const safeArgs = redactPermissionOpportunityIdsForDurableStorage(entry.args)
  const safeResultSummary = redactPermissionOpportunityIdsForDurableStorage(entry.resultSummary)
  const canvasEvalInvocation = resolveCanvasEvalMemoryInvocation(entry.toolName, safeArgs)
  const canvasFillInvocation = resolveCanvasFillMemoryInvocation(entry.toolName, safeArgs)
  const canvasEvalReceipt = canvasEvalInvocation
    ? canvasEvalReceiptForMemory(canvasEvalInvocation, entry.canvasEvalApproval)
    : undefined
  const trajectory = [
    ...(memory.trajectory ?? []),
    canvasEvalInvocation
      ? {
          toolName: entry.toolName,
          effectiveToolName: canvasEvalInvocation.effectiveToolName,
          argsSummary: canvasEvalArgsSummary(entry.toolName, canvasEvalInvocation.viaGateway),
          ok: entry.ok,
          resultSummary: CANVAS_EVAL_RESULT_REDACTED,
          ...(canvasEvalReceipt ? { canvasEvalReceipt } : {})
        }
      : canvasFillInvocation
        ? {
            toolName: entry.toolName,
            effectiveToolName: canvasFillInvocation.effectiveToolName,
            argsSummary: canvasFillArgsSummary(entry.toolName, canvasFillInvocation),
            ok: entry.ok,
            resultSummary: CANVAS_FILL_RESULT_REDACTED
          }
        : {
            toolName: entry.toolName,
            argsSummary: summarizeOllamaToolArgs(entry.toolName, safeArgs),
            ok: entry.ok,
            resultSummary: summarizeToolResultForMemory(
              safeResultSummary,
              limits.toolResultMaxChars
            )
          }
  ].slice(-12)
  return {
    ...memory,
    updatedAt: Date.now(),
    toolTurnCount: memory.toolTurnCount + 1,
    trajectory,
    workingMemory: buildOllamaWorkingMemoryBlock(trajectory, limits.workingMemoryMaxChars)
  }
}

export function buildOllamaWorkingMemoryBlock(
  trajectory: OllamaToolTrajectoryEntry[],
  maxChars = OLLAMA_WORKING_MEMORY_MAX_CHARS
): string {
  if (trajectory.length === 0) return ''
  const lines = [
    'Ollama working memory (compressed prior tool trajectory):',
    ...trajectory.map(
      (entry, index) =>
        `${index + 1}. ${entry.argsSummary} → ${entry.ok ? 'ok' : 'error'}: ${entry.resultSummary}`
    )
  ]
  const block = lines.join('\n')
  if (block.length <= maxChars) return block
  return `${block.slice(0, maxChars)}\n[working memory truncated]`
}

export function formatOllamaSessionMemoryForPrompt(
  memory: OllamaSessionMemory | null | undefined
): string {
  if (!memory?.workingMemory?.trim()) return ''
  return [
    'Prior Ollama session memory (pruned — tool calls + summaries, not full file bodies):',
    memory.workingMemory.trim()
  ].join('\n')
}

export function shouldRollOllamaRunSummary(toolTurnCount: number): boolean {
  return toolTurnCount > 0 && toolTurnCount % OLLAMA_ROLLING_SUMMARY_AFTER_TOOL_TURNS === 0
}

/**
 * Share of the usable context window at which the in-flight message list is
 * compressed down to the working-memory block.
 */
export const OLLAMA_COMPRESSION_PRESSURE_SHARE = 0.65

/**
 * Compression exists to protect tiny windows, but the fixed 3-turn cadence
 * applied it to every model — erasing file content one to two turns after a
 * model read it, while the follow-up guidance told it to edit using an exact
 * old_string from that content. The forced re-read then returned an identical
 * result and fed the repeat-call nudge: the read-loop class in one mechanism.
 *
 * With a MEASURED window (daemon `/api/show`, bounded by the profile cap) the
 * transcript is kept raw until it genuinely approaches the window; a large
 * local model may never need compression at all. An unmeasured window keeps
 * the conservative cadence — same doctrine as the context-budget floors: only
 * a measurement may widen behavior.
 */
export function shouldCompressOllamaMessagesForPressure(input: {
  estimatedPromptTokens: number
  usableContextTokens?: number | null
  toolTurnCount: number
}): boolean {
  const usable =
    typeof input.usableContextTokens === 'number' &&
    Number.isFinite(input.usableContextTokens) &&
    input.usableContextTokens > 0
      ? input.usableContextTokens
      : undefined
  if (!usable) return shouldRollOllamaRunSummary(input.toolTurnCount)
  return input.estimatedPromptTokens > usable * OLLAMA_COMPRESSION_PRESSURE_SHARE
}

/** Replace raw tool I/O in the in-flight message list with a stable working-memory block. */
export function compressOllamaMessagesWithWorkingMemory(
  messages: OllamaLoopMessage[],
  workingMemory: string
): OllamaLoopMessage[] {
  if (!workingMemory.trim()) return messages
  const system = messages.filter((message) => message.role === 'system')
  const initialUser = messages.find((message) => message.role === 'user')
  return [
    ...system,
    ...(initialUser ? [initialUser] : []),
    { role: 'user', content: workingMemory }
  ]
}

export function pruneOllamaSessionMemoryForPersist(
  memory: OllamaSessionMemory
): OllamaSessionMemory {
  const limits = resolveOllamaWorkingMemoryLimits(memory.modelId)
  const trajectory = (memory.trajectory ?? [])
    .slice(-8)
    .map(sanitizeOllamaTrajectoryEntryForPersist)
  const containsSensitiveCanvas = trajectory.some(
    (entry) => isCanvasEvalTrajectoryEntry(entry) || isCanvasFillTrajectoryEntry(entry)
  )
  return {
    modelId: memory.modelId,
    updatedAt: memory.updatedAt,
    workingMemory: (containsSensitiveCanvas
      ? buildOllamaWorkingMemoryBlock(trajectory, limits.workingMemoryMaxChars)
      : redactPermissionOpportunityIdsForDurableStorage(memory.workingMemory)
    ).slice(0, limits.workingMemoryMaxChars),
    toolTurnCount: memory.toolTurnCount,
    trajectory
  }
}
