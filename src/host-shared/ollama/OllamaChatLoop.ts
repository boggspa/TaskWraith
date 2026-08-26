/**
 * Node-pure Ollama chat completion loop.
 *
 * Adapted from src/main/ollama/OllamaProvider.ts (run loop, streaming parse,
 * tool-call envelope, shouldReleaseOllamaContentDelta). Desktop reuse is a
 * named follow-up.
 *
 * This module owns the streaming chat loop for the pure-Node Host: NDJSON
 * parsing, content release gating, tool-call envelope decoding, and the
 * cancel-safe transport contract. It does NOT own tool execution — the caller
 * supplies an executeTool port.
 */

import type { OllamaChatChunk, OllamaChatMessage, OllamaChatRequest } from './OllamaDaemonClient'
import { ollamaChatTransport } from './OllamaDaemonClient'

export interface OllamaToolCall {
  name: string
  arguments: Record<string, unknown>
}

export interface OllamaChatLoopOptions {
  baseUrl: string
  apiKey?: string | null
  signal: AbortSignal
  model: string
  messages: OllamaChatMessage[]
  temperature?: number
  numCtx?: number
  numPredict?: number
  tools?: Array<{
    type: 'function'
    function: {
      name: string
      description: string
      parameters: Record<string, unknown>
    }
  }>
  format?: 'json' | Record<string, unknown>
  launchAuthorized?: () => boolean
  onRetry?: (input: {
    attempt: number
    maxAttempts: number
    delayMs: number
    error: string
  }) => void
  onContentDelta?: (delta: string, full: string) => void
  onToolCalls?: (toolCalls: OllamaToolCall[]) => Promise<OllamaChatMessage[]>
  executeTool?: (toolCall: OllamaToolCall) => Promise<{ ok: boolean; result: string }>
}

export interface OllamaChatLoopResult {
  content: string
  toolCalls: OllamaToolCall[]
  toolResults: OllamaChatMessage[]
  usage?: {
    promptTokens?: number
    completionTokens?: number
    totalDuration?: number
  }
}

function shouldReleaseOllamaContentDelta(input: {
  content: string
  pending: string
  streamed: string
  toolProtocolEnabled: boolean
}): boolean {
  if (!input.pending) return false
  if (!input.toolProtocolEnabled) return true
  if (input.streamed.length > 0) return true
  return input.pending.length >= 24 || /[.!?\n]\s*$/.test(input.content)
}

function extractOllamaToolCalls(chunk: OllamaChatChunk): OllamaToolCall[] {
  const toolCalls = chunk.message?.tool_calls
  if (!Array.isArray(toolCalls)) return []
  return toolCalls
    .filter((call) => call?.function?.name && typeof call.function.name === 'string')
    .map((call) => ({
      name: call.function.name,
      arguments:
        typeof call.function.arguments === 'object' && call.function.arguments !== null
          ? call.function.arguments
          : {}
    }))
}

/** Run a single streaming chat completion turn. */
export async function runOllamaChatLoop(
  options: OllamaChatLoopOptions
): Promise<OllamaChatLoopResult> {
  const request: OllamaChatRequest = {
    model: options.model,
    messages: options.messages,
    stream: true,
    ...(options.format ? { format: options.format } : {}),
    ...(options.tools && options.tools.length > 0 ? { tools: options.tools } : {}),
    options: {
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(options.numCtx !== undefined ? { num_ctx: options.numCtx } : {}),
      ...(options.numPredict !== undefined ? { num_predict: options.numPredict } : {})
    }
  }

  let content = ''
  let pending = ''
  const toolCalls: OllamaToolCall[] = []
  const toolResults: OllamaChatMessage[] = []
  let usage: OllamaChatLoopResult['usage']

  const stream = ollamaChatTransport({
    baseUrl: options.baseUrl,
    ...(options.apiKey ? { apiKey: options.apiKey } : {}),
    signal: options.signal,
    request,
    ...(options.launchAuthorized ? { launchAuthorized: options.launchAuthorized } : {}),
    ...(options.onRetry ? { onRetry: options.onRetry } : {})
  })

  for await (const chunk of stream) {
    if (chunk.message?.content) {
      const delta = chunk.message.content
      pending += delta
      if (
        shouldReleaseOllamaContentDelta({
          content: delta,
          pending,
          streamed: content,
          toolProtocolEnabled: Boolean(options.tools && options.tools.length > 0)
        })
      ) {
        content += pending
        options.onContentDelta?.(pending, content)
        pending = ''
      }
    }
    const chunkToolCalls = extractOllamaToolCalls(chunk)
    if (chunkToolCalls.length > 0) {
      toolCalls.push(...chunkToolCalls)
      if (options.executeTool) {
        for (const toolCall of chunkToolCalls) {
          const result = await options.executeTool(toolCall)
          toolResults.push({
            role: 'tool',
            content: result.result,
            tool_name: toolCall.name
          })
        }
      }
    }
    if (chunk.done) {
      if (chunk.prompt_eval_count !== undefined || chunk.eval_count !== undefined) {
        usage = {
          ...(chunk.prompt_eval_count !== undefined
            ? { promptTokens: chunk.prompt_eval_count }
            : {}),
          ...(chunk.eval_count !== undefined ? { completionTokens: chunk.eval_count } : {}),
          ...(chunk.total_duration !== undefined ? { totalDuration: chunk.total_duration } : {})
        }
      }
      break
    }
  }

  if (pending) {
    content += pending
    options.onContentDelta?.(pending, content)
  }

  return { content, toolCalls, toolResults, usage }
}
