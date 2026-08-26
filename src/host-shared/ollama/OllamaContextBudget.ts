/**
 * Node-pure Ollama context budget and run memory.
 *
 * Adapted from src/main/ollama/OllamaRunMemory.ts (working memory limits,
 * trajectory, compression) and src/main/ollama/OllamaProvider.ts
 * (resolveOllamaToolResultLimits, resolveOllamaRuntimeContextLimit).
 * Desktop reuse is a named follow-up.
 *
 * This module owns the context-window and message-compression policy for the
 * pure-Node Host: measured context tokens, tool-result limits, working-memory
 * bounds, and the pressure-driven compression that keeps long tool loops inside
 * the daemon's window.
 */

import type { OllamaChatMessage } from './OllamaDaemonClient'

export interface OllamaWorkingMemoryLimits {
  toolResultMaxChars: number
  workingMemoryMaxChars: number
}

export interface OllamaToolTrajectoryEntry {
  toolName: string
  effectiveToolName?: string
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

export const OLLAMA_WORKING_MEMORY_MAX_CHARS = 1800
export const OLLAMA_TOOL_RESULT_MEMORY_MAX_CHARS = 220
export const OLLAMA_ROLLING_SUMMARY_AFTER_TOOL_TURNS = 3

function resolveOllamaWorkingMemoryLimits(modelId: string): OllamaWorkingMemoryLimits {
  const family = modelId.split(':')[0]?.toLowerCase() ?? ''
  if (family.includes('qwen') || family.includes('gemma')) {
    return { toolResultMaxChars: 220, workingMemoryMaxChars: 1800 }
  }
  return { toolResultMaxChars: 220, workingMemoryMaxChars: 1800 }
}

function buildOllamaWorkingMemoryBlock(
  trajectory: readonly OllamaToolTrajectoryEntry[],
  maxChars: number
): string {
  const lines: string[] = []
  let total = 0
  for (const entry of trajectory.slice(-8)) {
    const line = `${entry.ok ? '✓' : '✗'} ${entry.toolName}: ${entry.resultSummary}`
    if (total + line.length > maxChars) break
    lines.push(line)
    total += line.length
  }
  return lines.join('\n')
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

export function upsertOllamaSessionMemory(
  memory: OllamaSessionMemory,
  entry: OllamaToolTrajectoryEntry
): OllamaSessionMemory {
  const trajectory = [...(memory.trajectory ?? []), entry].slice(-32)
  const limits = resolveOllamaWorkingMemoryLimits(memory.modelId)
  return {
    ...memory,
    updatedAt: Date.now(),
    toolTurnCount: memory.toolTurnCount + 1,
    trajectory,
    workingMemory: buildOllamaWorkingMemoryBlock(trajectory, limits.workingMemoryMaxChars)
  }
}

export function shouldCompressOllamaMessagesForPressure(input: {
  measuredRuntimeContextTokens?: number
  currentPromptTokens: number
  toolTurnCount: number
}): boolean {
  if (input.measuredRuntimeContextTokens === undefined) {
    return input.toolTurnCount >= OLLAMA_ROLLING_SUMMARY_AFTER_TOOL_TURNS
  }
  return input.currentPromptTokens > input.measuredRuntimeContextTokens * 0.85
}

export function compressOllamaMessagesWithWorkingMemory(input: {
  messages: OllamaChatMessage[]
  memory: OllamaSessionMemory
  maxChars?: number
}): OllamaChatMessage[] {
  const maxChars = input.maxChars ?? 12_000
  const messages = [...input.messages]
  let total = messages.reduce((sum, message) => sum + message.content.length, 0)
  if (total <= maxChars) return messages

  // Keep system prompt and the last few turns; compress the middle.
  const system = messages.filter((message) => message.role === 'system')
  const nonSystem = messages.filter((message) => message.role !== 'system')
  const recent = nonSystem.slice(-6)
  const middle = nonSystem.slice(0, -6)

  const memoryBlock = input.memory.workingMemory
    ? `\n\n[Working memory]\n${input.memory.workingMemory}`
    : ''
  const compressed: OllamaChatMessage[] = [
    ...system,
    ...(middle.length > 0
      ? [
          {
            role: 'user' as const,
            content: `[Earlier turns compressed: ${middle.length} messages, ${middle.reduce((sum, message) => sum + message.content.length, 0)} chars]${memoryBlock}`
          }
        ]
      : []),
    ...recent
  ]
  return compressed
}

export function resolveOllamaToolResultLimits(input: {
  measuredContextTokens?: number
  contextCapTokens: number
}): { toolResultMaxChars: number; workingMemoryMaxChars: number } {
  const contextTokens = input.measuredContextTokens ?? input.contextCapTokens
  const scale = Math.max(1, Math.min(4, contextTokens / 8_192))
  return {
    toolResultMaxChars: Math.floor(220 * scale),
    workingMemoryMaxChars: Math.floor(1800 * scale)
  }
}

export function resolveOllamaRuntimeContextLimit(input: {
  modelInfo?: { contextLength?: number }
  contextCapTokens: number
}): number {
  const measured = input.modelInfo?.contextLength
  if (typeof measured === 'number' && measured > 0) {
    return Math.min(measured, input.contextCapTokens)
  }
  return input.contextCapTokens
}
