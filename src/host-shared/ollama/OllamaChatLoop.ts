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

/**
 * Canonical reasoning-fence patterns (matches EnsembleThinkingEphemerality.ts).
 * Matches <think>...</think>, <thinking>...</thinking>, <reasoning>...</reasoning>.
 */
const REASONING_FENCE = /<(think|thinking|reasoning)>[\s\S]*?<\/>/gi

/**
 * Stateful parser for inline reasoning blocks that handles chunk-split tags.
 * Tracks partial <think>/<thinking>/<reasoning> blocks across chunk boundaries.
 */
interface InlineReasoningParser {
  buffer: string
  openTag: string | null
  currentBlock: string
}

function createInlineReasoningParser(): InlineReasoningParser {
  return {
    buffer: '',
    openTag: null,
    currentBlock: ''
  }
}

/**
 * Process a content chunk through the stateful parser.
 * Returns extracted reasoning blocks from this chunk.
 */
function processReasoningChunk(parser: InlineReasoningParser, chunk: string): string[] {
  const extracted: string[] = []
  let combined = parser.buffer + chunk

  // If we're inside an open tag, look for the closing tag
  if (parser.openTag !== null) {
    const closeTag = `</${parser.openTag}>`
    const closeIndex = combined.indexOf(closeTag)
    if (closeIndex !== -1) {
      parser.currentBlock += combined.slice(0, closeIndex)
      extracted.push(parser.currentBlock)
      parser.openTag = null
      parser.currentBlock = ''
      combined = combined.slice(closeIndex + closeTag.length)
    } else {
      parser.currentBlock += combined
      parser.buffer = ''
      return extracted
    }
  }

  // Look for new reasoning blocks in the remaining content
  let match
  while ((match = REASONING_FENCE.exec(combined)) !== null) {
    extracted.push(match[1])
    combined = combined.slice(match.index + match[0].length)
    REASONING_FENCE.lastIndex = 0 // reset for next iteration
  }

  // Check if we have a partial open tag at the end
  const partialMatch = combined.match(/<(think|thinking|reasoning)>/i)
  if (partialMatch) {
    const tagName = partialMatch[1].toLowerCase()
    const tagStart = partialMatch.index!
    const afterTag = combined.slice(tagStart + partialMatch[0].length)

    // Check if there's a closing tag in the remainder
    const closeTag = `</${tagName}>`
    if (!afterTag.includes(closeTag)) {
      parser.openTag = tagName
      parser.currentBlock = afterTag
      combined = combined.slice(0, tagStart)
    }
  }

  parser.buffer = combined
  return extracted
}

/**
 * Strip reasoning tags from content (for cleaning visible content).
 * Removes <think>, <thinking>, <reasoning> and their closing tags.
 */
function stripReasoningTags(content: string): string {
  return content.replace(/<\/(think|thinking|reasoning)>|<(think|thinking|reasoning)>/gi, '')
}

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
  think?: OllamaChatRequest['think']
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
  onThinkingDelta?: (delta: string, full: string) => void
  onToolCalls?: (toolCalls: OllamaToolCall[]) => Promise<OllamaChatMessage[]>
  executeTool?: (toolCall: OllamaToolCall) => Promise<{ ok: boolean; result: string }>
}

export interface OllamaChatLoopResult {
  content: string
  thinking: string
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
    ...(options.think !== undefined ? { think: options.think } : {}),
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
  let thinking = ''
  let pendingThinking = ''
  const toolCalls: OllamaToolCall[] = []
  const toolResults: OllamaChatMessage[] = []
  let usage: OllamaChatLoopResult['usage']

  // Stateful parser for inline reasoning blocks across chunk boundaries
  const inlineParser = createInlineReasoningParser()

  const stream = ollamaChatTransport({
    baseUrl: options.baseUrl,
    ...(options.apiKey ? { apiKey: options.apiKey } : {}),
    signal: options.signal,
    request,
    ...(options.launchAuthorized ? { launchAuthorized: options.launchAuthorized } : {}),
    ...(options.onRetry ? { onRetry: options.onRetry } : {})
  })

  for await (const chunk of stream) {
    // Handle content from the daemon
    if (chunk.message?.content) {
      const delta = chunk.message.content
      const strippedDelta = stripReasoningTags(delta)
      pending += strippedDelta

      // Process inline reasoning blocks from this chunk
      const inlineBlocks = processReasoningChunk(inlineParser, delta)
      for (const block of inlineBlocks) {
        pendingThinking += block
        if (
          shouldReleaseOllamaContentDelta({
            content: block,
            pending: pendingThinking,
            streamed: thinking,
            toolProtocolEnabled: Boolean(options.tools && options.tools.length > 0)
          })
        ) {
          thinking += pendingThinking
          options.onThinkingDelta?.(pendingThinking, thinking)
          pendingThinking = ''
        }
      }

      if (
        shouldReleaseOllamaContentDelta({
          content: strippedDelta,
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

    // Handle thinking content from the daemon (separate field)
    if (chunk.message?.thinking) {
      const thinkingDelta = chunk.message.thinking
      pendingThinking += thinkingDelta
      if (
        shouldReleaseOllamaContentDelta({
          content: thinkingDelta,
          pending: pendingThinking,
          streamed: thinking,
          toolProtocolEnabled: Boolean(options.tools && options.tools.length > 0)
        })
      ) {
        thinking += pendingThinking
        options.onThinkingDelta?.(pendingThinking, thinking)
        pendingThinking = ''
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

  // Flush any remaining content
  if (pending) {
    content += pending
    options.onContentDelta?.(pending, content)
  }

  // Flush any remaining thinking content
  if (pendingThinking) {
    thinking += pendingThinking
    options.onThinkingDelta?.(pendingThinking, thinking)
  }

  // Handle any remaining partial reasoning block in the parser
  if (inlineParser.openTag !== null && inlineParser.currentBlock) {
    thinking += inlineParser.currentBlock
    options.onThinkingDelta?.(inlineParser.currentBlock, thinking)
  }

  return { content, thinking, toolCalls, toolResults, usage }
}
