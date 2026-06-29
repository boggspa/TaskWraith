import { summarizeOllamaToolArgs } from './OllamaToolResultSummary'
import { resolveContextWindow } from '../../shared/contextWindows'
import { resolveOllamaModelFamily } from './OllamaModelPreflight'

export interface OllamaLoopMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_calls?: unknown[]
  tool_name?: string
}

export const OLLAMA_ROLLING_SUMMARY_AFTER_TOOL_TURNS = 3
export const OLLAMA_WORKING_MEMORY_MAX_CHARS = 1800
export const OLLAMA_TOOL_RESULT_MEMORY_MAX_CHARS = 220

export interface OllamaWorkingMemoryLimits {
  toolResultMaxChars: number
  workingMemoryMaxChars: number
}

export interface OllamaToolTrajectoryEntry {
  toolName: string
  argsSummary: string
  ok: boolean
  resultSummary: string
}

export interface OllamaSessionMemory {
  modelId: string
  updatedAt: number
  workingMemory: string
  toolTurnCount: number
  trajectory?: OllamaToolTrajectoryEntry[]
}

export function normalizeOllamaSessionMemory(
  memory: OllamaSessionMemory | null | undefined
): OllamaSessionMemory | null {
  if (!memory) return null
  return {
    ...memory,
    trajectory: memory.trajectory ?? []
  }
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

export function resolveOllamaWorkingMemoryLimits(modelId?: string | null): OllamaWorkingMemoryLimits {
  const trimmedModelId = String(modelId || '').trim()
  const family = resolveOllamaModelFamily(trimmedModelId)
  switch (family) {
    case 'qwen3_4b':
    case 'granite4_1_3b':
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
    case 'gpt_oss_20b':
    case 'granite4_1_30b':
      return scaledWorkingMemoryLimits(trimmedModelId, {
        toolResultMaxChars: 760,
        contextShare: 0.035,
        maxWorkingMemoryChars: 7200
      })
    case 'qwen3_6_35b':
    case 'ornith_35b':
    case 'nemotron3_33b':
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
  return normalized.length <= maxChars
    ? normalized
    : `${normalized.slice(0, maxChars)}...`
}

export function appendOllamaTrajectoryEntry(
  memory: OllamaSessionMemory,
  entry: Omit<OllamaToolTrajectoryEntry, 'argsSummary'> & {
    args: Record<string, unknown>
  }
): OllamaSessionMemory {
  const limits = resolveOllamaWorkingMemoryLimits(memory.modelId)
  const trajectory = [
    ...(memory.trajectory ?? []),
    {
      toolName: entry.toolName,
      argsSummary: summarizeOllamaToolArgs(entry.toolName, entry.args),
      ok: entry.ok,
      resultSummary: summarizeToolResultForMemory(entry.resultSummary, limits.toolResultMaxChars)
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

export function formatOllamaSessionMemoryForPrompt(memory: OllamaSessionMemory | null | undefined): string {
  if (!memory?.workingMemory?.trim()) return ''
  return [
    'Prior Ollama session memory (pruned — tool calls + summaries, not full file bodies):',
    memory.workingMemory.trim()
  ].join('\n')
}

export function shouldRollOllamaRunSummary(toolTurnCount: number): boolean {
  return toolTurnCount > 0 && toolTurnCount % OLLAMA_ROLLING_SUMMARY_AFTER_TOOL_TURNS === 0
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

export function pruneOllamaSessionMemoryForPersist(memory: OllamaSessionMemory): OllamaSessionMemory {
  const limits = resolveOllamaWorkingMemoryLimits(memory.modelId)
  return {
    modelId: memory.modelId,
    updatedAt: memory.updatedAt,
    workingMemory: memory.workingMemory.slice(0, limits.workingMemoryMaxChars),
    toolTurnCount: memory.toolTurnCount,
    trajectory: (memory.trajectory ?? []).slice(-8)
  }
}
