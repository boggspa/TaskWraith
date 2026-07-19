import { createHash } from 'crypto'
import { canonicalTaskWraithToolName } from '../TaskWraithMcpTools'
import { isCanvasMcpToolName, type CanvasMcpToolName } from '../mcp/CanvasToolExecutors'

type JsonRecord = Record<string, unknown>

const ID_KEYS = [
  'tool_id',
  'toolId',
  'tool_use_id',
  'toolCallId',
  'request_id',
  'requestId',
  'item_id',
  'itemId',
  'call_id',
  'callId',
  'tool_call_id',
  'id'
] as const

const TOOL_IDENTITY_KEYS = [
  'tool_name',
  'toolName',
  'mcpToolName',
  'tool',
  'name',
  'action',
  'sender'
] as const

const NESTED_KEYS = ['item', 'raw', 'params', 'payload', 'function', 'message', 'content'] as const

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function recordFromMaybeJson(value: unknown): JsonRecord | undefined {
  if (isRecord(value)) return value
  if (typeof value !== 'string' || !value.trim().startsWith('{')) return undefined
  try {
    const parsed = JSON.parse(value) as unknown
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function normalizedEventType(value: unknown): string {
  return String(value || '')
    .toLowerCase()
    .replace(/[/.-]/g, '_')
}

function isToolEnvelope(value: JsonRecord): boolean {
  const type = normalizedEventType(value.type ?? value.method)
  return (
    type.includes('tool') ||
    type.includes('mcp') ||
    TOOL_IDENTITY_KEYS.some((key) => value[key] !== undefined)
  )
}

function gatewayTarget(value: JsonRecord): CanvasMcpToolName | null {
  for (const key of ['arguments', 'parameters', 'params', 'input'] as const) {
    const container = recordFromMaybeJson(value[key])
    if (!container || typeof container.name !== 'string') continue
    const canonical = canonicalTaskWraithToolName(container.name)
    if (isCanvasMcpToolName(canonical)) return canonical
  }
  return null
}

/** Resolve a canonical Canvas identity only from a tool-shaped envelope. */
export function nativeCanvasCompatToolName(value: unknown, depth = 0): CanvasMcpToolName | null {
  if (depth > 8) return null
  if (Array.isArray(value)) {
    for (const child of value) {
      const match = nativeCanvasCompatToolName(child, depth + 1)
      if (match) return match
    }
    return null
  }
  if (typeof value === 'string') {
    const parsed = recordFromMaybeJson(value)
    return parsed ? nativeCanvasCompatToolName(parsed, depth + 1) : null
  }
  if (!isRecord(value)) return null

  if (isToolEnvelope(value)) {
    for (const key of TOOL_IDENTITY_KEYS) {
      if (typeof value[key] !== 'string') continue
      const canonical = canonicalTaskWraithToolName(value[key] as string)
      if (isCanvasMcpToolName(canonical)) return canonical
      if (canonical === 'capability_invoke') {
        const target = gatewayTarget(value)
        if (target) return target
      }
    }
  }
  for (const key of NESTED_KEYS) {
    const match = nativeCanvasCompatToolName(value[key], depth + 1)
    if (match) return match
  }
  return null
}

export function nativeCanvasCompatToolIds(
  value: unknown,
  depth = 0,
  seen = new Set<string>()
): string[] {
  if (depth > 7) return [...seen]
  if (Array.isArray(value)) {
    for (const child of value) nativeCanvasCompatToolIds(child, depth + 1, seen)
    return [...seen]
  }
  if (typeof value === 'string') {
    const parsed = recordFromMaybeJson(value)
    if (parsed) nativeCanvasCompatToolIds(parsed, depth + 1, seen)
    return [...seen]
  }
  if (!isRecord(value)) return [...seen]
  for (const key of ID_KEYS) {
    const id = value[key]
    if (typeof id === 'string' && id) seen.add(id)
    else if (typeof id === 'number' && Number.isFinite(id)) seen.add(String(id))
  }
  for (const key of NESTED_KEYS) {
    nativeCanvasCompatToolIds(value[key], depth + 1, seen)
  }
  return [...seen]
}

function isToolUse(value: JsonRecord): boolean {
  const type = normalizedEventType(value.type ?? value.method)
  return [
    'tool_use',
    'tool_call',
    'tool_request',
    'mcp_tool_call',
    'item_started',
    'item_start'
  ].includes(type)
}

function isToolResult(value: JsonRecord): boolean {
  const type = normalizedEventType(value.type ?? value.method)
  return [
    'tool_result',
    'tool_output',
    'tool_response',
    'tool_completed',
    'tool_call_result',
    'function_call_output',
    'function_result',
    'function_response',
    'mcp_tool_result',
    'mcp_tool_call_result',
    'mcp_tool_call_completed',
    'item_completed',
    'item_complete'
  ].includes(type)
}

function opaqueId(scope: string, ids: string[]): string | undefined {
  if (ids.length === 0) return undefined
  return `canvas-tool-${createHash('sha256')
    .update(scope, 'utf8')
    .update('\0', 'utf8')
    .update(ids.slice().sort().join('\0'), 'utf8')
    .digest('hex')
    .slice(0, 24)}`
}

function argumentByteLength(value: JsonRecord): number {
  const candidate = value.parameters ?? value.arguments ?? value.input
  if (candidate === undefined) return 0
  try {
    return Buffer.byteLength(
      typeof candidate === 'string' ? candidate : JSON.stringify(candidate),
      'utf8'
    )
  } catch {
    return 0
  }
}

function safeProjection(
  value: JsonRecord,
  toolName: CanvasMcpToolName,
  toolId: string | undefined,
  result: boolean
): JsonRecord {
  const provider = typeof value.provider === 'string' ? value.provider : undefined
  const server = typeof value.server === 'string' ? value.server : undefined
  const viaGateway = value.via_gateway === true || value.viaGateway === true
  if (!result) {
    return {
      type: 'tool_use',
      tool_name: toolName,
      ...(toolId ? { tool_id: toolId } : {}),
      parameters: {
        redacted: true,
        argumentByteLength: argumentByteLength(value)
      },
      ...(provider ? { provider } : {}),
      ...(server ? { server } : {}),
      ...(viaGateway ? { via_gateway: true, gateway_tool_name: 'capability_invoke' } : {})
    }
  }
  const rawStatus = String(value.status || '').toLowerCase()
  const failed =
    value.is_error === true ||
    value.isError === true ||
    rawStatus === 'error' ||
    rawStatus === 'failed' ||
    rawStatus === 'cancelled'
  const projection = { redacted: true, tool: toolName, ok: !failed }
  return {
    type: 'tool_result',
    tool_name: toolName,
    ...(toolId ? { tool_id: toolId } : {}),
    status: failed ? 'error' : 'success',
    output: failed
      ? 'Canvas operation failed (provider_reported_error).'
      : 'Canvas operation completed.',
    result: projection,
    structuredContent: projection,
    ...(provider ? { provider } : {}),
    ...(server ? { server } : {}),
    ...(viaGateway ? { via_gateway: true, gateway_tool_name: 'capability_invoke' } : {})
  }
}

export interface NativeCanvasCompatSanitizer {
  prime: (scope: string, toolName: string, ids: Iterable<string>) => void
  projectedToolId: (scope: string, ids: Iterable<string>) => string | undefined
  sanitize: (value: unknown, scope: string) => unknown
}

interface PendingCanvasCorrelation {
  toolName: CanvasMcpToolName
  projectedToolId?: string
}

/**
 * Keep the provider-facing MCP response untouched while reducing native
 * provider echo frames to a bounded, metadata-only durable/renderer projection.
 * Correlations never evict: after saturation, otherwise-unknown result frames
 * fail closed instead of allowing a delayed Canvas result to leak.
 */
export function createNativeCanvasCompatSanitizer(maxPending = 2048): NativeCanvasCompatSanitizer {
  const pending = new Map<string, PendingCanvasCorrelation | null>()
  const limit = Number.isSafeInteger(maxPending) && maxPending > 0 ? maxPending : 1
  const saturatedScopes = new Set<string>()
  const key = (scope: string, id: string): string =>
    createHash('sha256').update(scope).update('\0').update(id).digest('hex')

  const remember = (
    scope: string,
    toolName: CanvasMcpToolName,
    ids: Iterable<string>
  ): string | undefined => {
    const idList = [...new Set([...ids].filter(Boolean))]
    if (idList.length === 0) {
      saturatedScopes.add(scope)
      return undefined
    }
    const existing = idList
      .map((id) => pending.get(key(scope, id)))
      .filter((entry): entry is PendingCanvasCorrelation | null => entry !== undefined)
    const conflicting = existing.some((entry) => entry === null || entry.toolName !== toolName)
    const existingProjectedIds = new Set(
      existing.flatMap((entry) => (entry?.projectedToolId ? [entry.projectedToolId] : []))
    )
    if (conflicting || existingProjectedIds.size > 1) {
      for (const id of idList) pending.set(key(scope, id), null)
      return undefined
    }
    const projectedToolId =
      existingProjectedIds.size === 1 ? [...existingProjectedIds][0] : opaqueId(scope, idList)
    for (const id of idList) {
      const scoped = key(scope, id)
      if (pending.has(scoped)) {
        continue
      }
      if (pending.size >= limit) {
        saturatedScopes.add(scope)
        continue
      }
      pending.set(scoped, { toolName, projectedToolId })
    }
    return projectedToolId
  }

  return {
    prime(scope, toolName, ids) {
      const canonical = canonicalTaskWraithToolName(toolName)
      if (isCanvasMcpToolName(canonical)) remember(scope, canonical, ids)
    },

    projectedToolId(scope, ids) {
      const projected = new Set(
        [...ids].flatMap((id) => {
          const entry = pending.get(key(scope, id))
          return entry?.projectedToolId ? [entry.projectedToolId] : []
        })
      )
      return projected.size === 1 ? [...projected][0] : undefined
    },

    sanitize(value, scope) {
      if (!isRecord(value)) return value
      const ids = nativeCanvasCompatToolIds(value)
      const explicitTool = nativeCanvasCompatToolName(value)
      const result = isToolResult(value)
      const use = isToolUse(value)
      const rememberedProjection =
        explicitTool && use ? remember(scope, explicitTool, ids) : undefined

      const matches = ids
        .map((id) => [key(scope, id), pending.get(key(scope, id))] as const)
        .filter((entry) => entry[1] !== undefined)
      const correlatedNames = new Set(
        matches.flatMap((entry) => (entry[1]?.toolName ? [entry[1].toolName] : []))
      )
      const correlatedProjectedIds = new Set(
        matches.flatMap((entry) => (entry[1]?.projectedToolId ? [entry[1].projectedToolId] : []))
      )
      const correlatedTool = correlatedNames.size === 1 ? [...correlatedNames][0] : null
      const toolName = explicitTool ?? correlatedTool

      if (!toolName && !(saturatedScopes.has(scope) && result)) return value
      const safeTool = toolName ?? 'canvas_status'
      if (result) {
        for (const [pendingKey] of matches) pending.delete(pendingKey)
      }
      const projectedToolId =
        correlatedProjectedIds.size === 1
          ? [...correlatedProjectedIds][0]
          : (rememberedProjection ?? opaqueId(scope, ids))
      return safeProjection(value, safeTool, projectedToolId, result)
    }
  }
}
