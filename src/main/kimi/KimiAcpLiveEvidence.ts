export interface KimiLiveToolCallEvidence {
  id: string
  title: string
  status: string
  rawFrames: string[]
}

export interface KimiLiveFsRequestEvidence {
  id: string | number
  method: 'fs/read_text_file' | 'fs/write_text_file'
  path: string
}

export interface KimiLiveFsErrorEvidence {
  id: string | number
  code: number
  message: string
}

const TERMINAL_TOOL_STATUSES = new Set(['completed', 'failed'])

function collectStrings(value: unknown, target: string[]): void {
  if (typeof value === 'string') {
    target.push(value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, target)
    return
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectStrings(item, target)
  }
}

function terminalToolResultStrings(
  rawFrames: readonly string[],
  expectedToolCallId: string
): string[] {
  const result: string[] = []
  for (const rawFrame of rawFrames) {
    try {
      const frame = JSON.parse(rawFrame) as {
        method?: unknown
        params?: {
          update?: {
            sessionUpdate?: unknown
            toolCallId?: unknown
            status?: unknown
            content?: unknown
            result?: unknown
            error?: unknown
          }
        }
      }
      const update = frame.method === 'session/update' ? frame.params?.update : undefined
      if (
        update?.sessionUpdate !== 'tool_call_update' ||
        String(update.toolCallId) !== expectedToolCallId ||
        typeof update.status !== 'string' ||
        !TERMINAL_TOOL_STATUSES.has(update.status)
      ) {
        continue
      }
      // Initial tool_call title/rawInput fields are model-controlled. Only a
      // terminal result/error payload from the bound update is denial evidence.
      collectStrings(update.content, result)
      collectStrings(update.result, result)
      collectStrings(update.error, result)
    } catch {
      // A malformed raw frame is not affirmative denial evidence.
    }
  }
  return result
}

function denialPrefixes(toolName: string): string[] {
  return [
    `Tool "${toolName}" was denied by permission rule.`,
    `Tool "${toolName}" was denied by permission policy.`,
    `Tool "${toolName}" was denied.`
  ]
}

/**
 * Exact Kimi 0.27.x permission-policy denial semantics observed in ACP tool
 * result frames. A generic network failure, empty result, or pending call is
 * deliberately insufficient release evidence.
 */
export function hasTerminalPermissionDenial(toolCall: KimiLiveToolCallEvidence): boolean {
  if (!TERMINAL_TOOL_STATUSES.has(toolCall.status)) return false
  const prefixes = denialPrefixes(toolCall.title)
  return terminalToolResultStrings(toolCall.rawFrames, toolCall.id).some((text) =>
    prefixes.some((prefix) => text.startsWith(prefix))
  )
}

export function toolResultContainsPermissionDenial(
  parentToolCall: KimiLiveToolCallEvidence,
  deniedChildToolName: string
): boolean {
  if (!TERMINAL_TOOL_STATUSES.has(parentToolCall.status)) return false
  const prefixes = denialPrefixes(deniedChildToolName)
  return terminalToolResultStrings(parentToolCall.rawFrames, parentToolCall.id).some((text) =>
    prefixes.some((prefix) => text.startsWith(prefix))
  )
}

export function hasDeniedToolCall(
  toolCalls: readonly KimiLiveToolCallEvidence[],
  expectedToolName: string
): boolean {
  const normalized = expectedToolName.toLowerCase()
  return toolCalls.some(
    (toolCall) =>
      toolCall.title.trim().toLowerCase() === normalized && hasTerminalPermissionDenial(toolCall)
  )
}

export function hasDeniedFsRequest(
  requests: readonly KimiLiveFsRequestEvidence[],
  errors: readonly KimiLiveFsErrorEvidence[],
  method: KimiLiveFsRequestEvidence['method'],
  expectedPath: string
): boolean {
  return requests.some(
    (request) =>
      request.method === method &&
      request.path === expectedPath &&
      errors.some(
        (error) =>
          String(error.id) === String(request.id) &&
          error.code === -32001 &&
          error.message === 'Path is outside the granted workspace roots.'
      )
  )
}
