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
 * Canonical reasoning-fence pattern (same matches as EnsembleThinkingEphemerality.ts).
 * Matches <think>...</think>, <thinking>...</thinking>, <reasoning>...</reasoning>.
 * Capture group 1 is the tag name (for the closing-tag backreference);
 * group 2 is the inner block content for extraction.
 */
const REASONING_FENCE = /<(think|thinking|reasoning)>([\s\S]*?)<\/\1>/gi

/**
 * Stateful parser for inline reasoning blocks that handles chunk-split tags.
 * Tracks partial <think>/<thinking>/<reasoning> blocks across chunk boundaries.
 *
 * `buffer` holds only a short unprocessed tail fragment (a split-tag
 * candidate), never accumulated visible content, so closing a split block
 * cannot pollute thinking with earlier stream text.
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

/** True when `tail` (starting at '<', with no '>') could still grow into an open tag. */
function isOpenTagPrefix(tail: string): boolean {
  if (!tail.startsWith('<') || tail.includes('>')) return false
  const lower = tail.toLowerCase()
  return (
    '<think>'.startsWith(lower) || '<thinking>'.startsWith(lower) || '<reasoning>'.startsWith(lower)
  )
}

/**
 * Process a content chunk through the stateful parser.
 * Returns extracted reasoning block contents from this chunk.
 */
function processReasoningChunk(parser: InlineReasoningParser, chunk: string): string[] {
  const extracted: string[] = []
  let combined = parser.buffer + chunk
  parser.buffer = ''

  // If we're inside an open tag, look for the closing tag
  if (parser.openTag !== null) {
    const closeTag = `</${parser.openTag}>`
    const closeIndex = combined.toLowerCase().indexOf(closeTag)
    if (closeIndex !== -1) {
      parser.currentBlock += combined.slice(0, closeIndex)
      extracted.push(parser.currentBlock)
      parser.openTag = null
      parser.currentBlock = ''
      combined = combined.slice(closeIndex + closeTag.length)
    } else {
      // No close yet: accumulate everything except a trailing fragment that
      // could be a close tag split across the next chunk boundary.
      const keep = Math.min(combined.length, closeTag.length - 1)
      parser.currentBlock += combined.slice(0, combined.length - keep)
      parser.buffer = combined.slice(combined.length - keep)
      return extracted
    }
  }

  // Look for new reasoning blocks in the remaining content
  REASONING_FENCE.lastIndex = 0
  let match
  while ((match = REASONING_FENCE.exec(combined)) !== null) {
    extracted.push(match[2])
    combined = combined.slice(match.index + match[0].length)
    REASONING_FENCE.lastIndex = 0 // reset for next iteration
  }

  // Check for a trailing partial open tag or unclosed block. Only the tail
  // from the last '<' can still become (or extend) a tag; earlier text is
  // visible content and is dropped, keeping the buffer bounded.
  const tagStart = combined.lastIndexOf('<')
  if (tagStart !== -1) {
    const tail = combined.slice(tagStart)
    const openMatch = tail.match(/^<(think|thinking|reasoning)>/i)
    if (openMatch) {
      // Complete open tag with no close in this chunk: the block continues.
      parser.openTag = openMatch[1].toLowerCase()
      parser.currentBlock = tail.slice(openMatch[0].length)
    } else if (isOpenTagPrefix(tail)) {
      parser.buffer = tail
    }
  }

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

  // Handle any remaining partial reasoning block in the parser. When a
  // block is still open, the buffer holds its trailing fragment (a
  // close-tag candidate), so it belongs to the flushed thought.
  if (inlineParser.openTag !== null) {
    const trailing = inlineParser.currentBlock + inlineParser.buffer
    if (trailing) {
      thinking += trailing
      options.onThinkingDelta?.(trailing, thinking)
    }
  }

  return { content, thinking, toolCalls, toolResults, usage }
}
