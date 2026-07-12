import { isRecord } from '../settings/MainSanitizers'
export function contentPartsToText(value: any, options: { includeThinking?: boolean } = {}): string {
  if (typeof value === 'string') return value
  if (!value) return ''
  if (Array.isArray(value)) {
    return value
      .map((item) => contentPartsToText(item, options))
      .filter(Boolean)
      .join('')
  }
  if (typeof value !== 'object') return ''
  if (typeof value.text === 'string') return value.text
  if (typeof value.think === 'string') return options.includeThinking ? value.think : ''
  if (typeof value.thinking === 'string') return options.includeThinking ? value.thinking : ''
  if (typeof value.reasoning === 'string') return options.includeThinking ? value.reasoning : ''
  if (typeof value.content === 'string') return value.content
  if (Array.isArray(value.content)) return contentPartsToText(value.content, options)
  if (Array.isArray(value.message?.content))
    return contentPartsToText(value.message.content, options)
  return ''
}

export function contentPartsToThinkingText(value: any): string {
  if (!value) return ''
  if (Array.isArray(value)) return value.map(contentPartsToThinkingText).filter(Boolean).join('')
  if (typeof value !== 'object') return ''
  const direct =
    typeof value.think === 'string'
      ? value.think
      : typeof value.thinking === 'string'
        ? value.thinking
        : typeof value.reasoning === 'string'
          ? value.reasoning
          : ''
  const nested = Array.isArray(value.content)
    ? contentPartsToThinkingText(value.content)
    : Array.isArray(value.message?.content)
      ? contentPartsToThinkingText(value.message.content)
      : ''
  return `${direct}${nested}`
}

function claudeContentPartsToThinkingText(value: any): string {
  if (!value) return ''
  if (Array.isArray(value)) {
    return value.map(claudeContentPartsToThinkingText).filter(Boolean).join('')
  }
  if (typeof value !== 'object') return ''
  if (value.type === 'redacted_thinking') return ''
  if (value.type === 'thinking') {
    return typeof value.thinking === 'string' ? value.thinking : ''
  }
  if (Array.isArray(value.content)) return claudeContentPartsToThinkingText(value.content)
  if (Array.isArray(value.message?.content)) {
    return claudeContentPartsToThinkingText(value.message.content)
  }
  return ''
}

export function extractProviderText(event: any): string {
  if (!event) return ''
  if (typeof event === 'string') return event
  const params = event.params || {}
  const payload = params.payload || event.payload || {}
  if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta')
    return event.delta.text || ''
  // 1.0.5-S1 — Claude Agent SDK partial messages. When the SDK call
  // passes `includePartialMessages: true` we get `stream_event` frames
  // (SDKPartialAssistantMessage) whose `event` field carries the raw
  // Anthropic message-stream event. We care about
  // content_block_delta / text_delta — pull the incremental chunk so
  // Claude streams text token-by-token like Codex does, instead of
  // dumping the entire response in one cumulative `assistant` event
  // at the end of the turn. The dedup logic in
  // handleCliProviderJsonEvent already drops the trailing cumulative
  // event safely (slice-to-empty when text === accumulated).
  if (event.type === 'stream_event') {
    const inner = event.event || {}
    if (inner.type === 'content_block_delta' && inner.delta?.type === 'text_delta')
      return inner.delta.text || ''
  }
  if (event.type === 'assistant' || event.type === 'message' || event.type === 'message_delta')
    return contentPartsToText(event.message?.content || event.content || event.delta)
  // Kimi CLI 1.47 print mode emits its completed assistant response as an
  // untyped role envelope: `{ role: 'assistant', content: '...' }`. Keep this
  // after the typed branches so a typed streaming event still uses its delta.
  if (!event.type && event.role === 'assistant') return contentPartsToText(event.content)
  if (event.type === 'result' && typeof event.result === 'string') return event.result
  if (event.method === 'event' && params.type === 'ContentPart') return contentPartsToText(payload)
  if (params.type === 'ContentPart') return contentPartsToText(payload)
  if (typeof event.text === 'string') return event.text
  return ''
}

function extractClaudeThinkingText(event: any): string {
  if (!event || typeof event === 'string') return ''
  const params = event.params || {}
  const payload = params.payload || event.payload || {}
  if (event.type === 'content_block_delta' && event.delta?.type === 'thinking_delta') {
    return event.delta.thinking || ''
  }
  if (event.type === 'stream_event') {
    const inner = event.event || {}
    if (inner.type === 'content_block_delta' && inner.delta?.type === 'thinking_delta') {
      return inner.delta.thinking || ''
    }
    return ''
  }
  if (event.type === 'assistant' || event.type === 'message' || event.type === 'message_delta') {
    return claudeContentPartsToThinkingText(event.message?.content || event.content || event.delta)
  }
  if (event.method === 'event' && params.type === 'ContentPart') {
    return claudeContentPartsToThinkingText(payload)
  }
  if (params.type === 'ContentPart') return claudeContentPartsToThinkingText(payload)
  return ''
}

export function extractProviderThinkingText(event: any, provider?: string): string {
  if (!event || typeof event === 'string') return ''
  if (provider === 'claude') return extractClaudeThinkingText(event)
  const params = event.params || {}
  const payload = params.payload || event.payload || {}
  if (event.type === 'assistant' || event.type === 'message' || event.type === 'message_delta') {
    return contentPartsToThinkingText(event.message?.content || event.content || event.delta)
  }
  if (event.method === 'event' && params.type === 'ContentPart')
    return contentPartsToThinkingText(payload)
  if (params.type === 'ContentPart') return contentPartsToThinkingText(payload)
  return contentPartsToThinkingText(event)
}

export function nestedRecord(source: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = source[key]
  return isRecord(value) ? value : {}
}

export function extractProviderSessionId(event: unknown): string | null {
  if (!isRecord(event)) return null
  const session = nestedRecord(event, 'session')
  const message = nestedRecord(event, 'message')
  const params = nestedRecord(event, 'params')
  const result = nestedRecord(event, 'result')
  const resultSession = nestedRecord(result, 'session')
  const candidates = [
    event.session_id,
    event.sessionId,
    session.id,
    session.session_id,
    message.session_id,
    params.session_id,
    event.providerThreadId,
    event.provider_thread_id,
    event.threadId,
    result.session_id,
    result.sessionId,
    result.providerThreadId,
    resultSession.id,
    resultSession.session_id
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
  }
  return null
}

export function cliProviderToolId(payload: Record<string, unknown>, prefix: string): string {
  const candidates = [
    payload.tool_call_id,
    payload.toolCallId,
    payload.id,
    payload.tool_id,
    payload.toolId,
    payload.call_id
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}
