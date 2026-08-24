// Pure helpers for Grok's ACP (Agent Client Protocol) wire format, as spoken by
// `grok agent stdio`. No Electron / fs / child_process imports — unit-testable
// against fixtures captured from the real 0.2.8 agent.
//
// ACP is JSON-RPC 2.0 over NDJSON (one JSON object per line, both directions):
//   client→agent requests:  {jsonrpc,id,method,params}
//   agent→client responses: {jsonrpc,id,result|error}
//   agent→client notifs:    {jsonrpc,method:'session/update',params:{sessionId,update:{...}}}
// The assistant answer streams as session/update `agent_message_chunk`
// (`update.content.text`); reasoning as `agent_thought_chunk`. The session/prompt
// response (and the `_x.ai/session/prompt_complete` notification) carry the
// terminal `stopReason`. session/new's result carries the resumable `sessionId`.

import type { NormalizedGrokRunEvent } from './GrokStreamingJson'
import type { AgenticServiceId } from '../store/types'
import { extractToolInvocationParameters } from '../../shared/toolInvocationPresentation'

export type { NormalizedGrokRunEvent }

/** Serialize a JSON-RPC message as one NDJSON frame (trailing newline). */
export function encodeAcpFrame(message: unknown): string {
  return `${JSON.stringify(message)}\n`
}

/**
 * Split a chunk of agent stdout into parsed JSON-RPC messages, carrying a
 * partial trailing line across chunks. Non-JSON lines are skipped (ACP is
 * strictly JSON; banners would be noise).
 */
export function parseAcpStreamChunk(
  rawChunk: string,
  carry: string
): { messages: Record<string, unknown>[]; carry: string } {
  const buffer = (carry || '') + (rawChunk || '')
  const segments = buffer.split(/\r?\n/)
  const nextCarry = segments.pop() ?? ''
  const messages: Record<string, unknown>[] = []
  for (const segment of segments) {
    const trimmed = segment.trim()
    if (!trimmed) continue
    try {
      const parsed = JSON.parse(trimmed)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        messages.push(parsed as Record<string, unknown>)
      }
    } catch {
      // ACP is strict JSON; ignore any non-JSON noise line.
    }
  }
  return { messages, carry: nextCarry }
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** First non-empty string among the candidates (defensive field lookup). */
function firstStr(...vals: unknown[]): string {
  for (const v of vals) if (typeof v === 'string' && v) return v
  return ''
}

function safeStringify(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return ''
  }
}

/**
 * Best-effort flatten of an ACP tool-call `content` payload to display text.
 * ACP content is a `ContentBlock[]`; the common shapes are a text block
 * (`{type:'content', content:{type:'text', text}}` or `{text}`) and a diff
 * block (`{type:'diff', path, ...}`). Defensive — the exact live shape is
 * confirmed via TASKWRAITH_GROK_DEBUG and the lookups extended if needed.
 */
function acpToolContentToText(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) {
    const obj = asObject(value)
    if (obj && typeof obj.text === 'string') return obj.text
    return ''
  }
  const parts: string[] = []
  for (const entry of value) {
    const block = asObject(entry)
    if (!block) continue
    const inner = asObject(block.content)
    if (inner && typeof inner.text === 'string') {
      parts.push(inner.text)
      continue
    }
    if (typeof block.text === 'string') {
      parts.push(block.text)
      continue
    }
    if (block.type === 'diff') {
      const path = typeof block.path === 'string' ? block.path : ''
      parts.push(path ? `(diff ${path})` : '(diff)')
    }
  }
  return parts.join('')
}

/**
 * Recover file-edit arguments from an ACP `{type:'diff'}` content block.
 *
 * ACP describes a file edit twice: in the tool's `rawInput`, and as a diff
 * content block carrying `path` + the before/after text. An agent may send ONLY
 * the block — Mistral Vibe omits `rawInput` on some tool calls (the same reason
 * AcpTurnClient retains a merged copy of each tool call), and the block is then
 * the sole evidence of what was edited. `acpToolContentToText` deliberately
 * flattens it to a short "(diff path)" label for the human-readable output, so
 * without this the edit reaches the transcript with no target file and no
 * `+N -M` stats.
 *
 * The fields are emitted under the canonical SNAKE_CASE names because that is
 * what every downstream diff parser reads first (renderer `estimateLineChanges`
 * / `getPathFromRecord`, main-side `bridgeToolDiffStats`), so an ACP edit lands
 * on the same, best-supported path as a native Claude or broker-MCP edit rather
 * than relying on an alias.
 *
 * Shape rules, both deliberate:
 *  - A block with before AND after text is a replacement → `old_string` /
 *    `new_string`.
 *  - A block with only after text states no prior content, so it is a
 *    create/overwrite → `content`, which counts additions-only. Claiming
 *    `old_string: ''` instead would invent deletions the agent never reported.
 * Only the first diff block is read: one ACP tool call describes one edit, and
 * `locations` — not repeated diff blocks — is how ACP reports multiple targets.
 */
function acpDiffBlockToolInput(content: unknown): Record<string, unknown> {
  if (!Array.isArray(content)) return {}
  for (const entry of content) {
    const block = asObject(entry)
    if (!block || block.type !== 'diff') continue
    const path = firstStr(block.path, block.file_path, block.filePath)
    const oldText = firstStr(block.oldText, block.old_text)
    const newText = firstStr(block.newText, block.new_text)
    const recovered: Record<string, unknown> = {}
    if (path) recovered.file_path = path
    if (oldText && newText) {
      recovered.old_string = oldText
      recovered.new_string = newText
    } else if (newText) {
      recovered.content = newText
    }
    if (Object.keys(recovered).length > 0) return recovered
  }
  return {}
}

/** Pull only declared argument bags out of an ACP update. The update object
 * itself carries lifecycle/content metadata, which must never become a tool's
 * input merely because an adapter omitted rawInput. */
function acpToolUpdateInput(update: Record<string, unknown>): Record<string, unknown> {
  return extractToolInvocationParameters({
    rawInput: update.rawInput,
    input: update.input,
    arguments: update.arguments,
    args: update.args,
    parameters: update.parameters,
    payload: update.payload,
    toolInput: update.toolInput,
    tool_input: update.tool_input,
    function: update.function
  })
}

/**
 * Map an ACP `session/update` tool event (`tool_call` / `tool_call_update`) to
 * normalized run events. A `tool_call` opens the activity card (`tool_use`); a
 * terminal status (completed/failed) closes it (`tool_result`). Stateless: a
 * `tool_call` that arrives already-terminal emits both. This is what gives the
 * ACP transport real inline tool-call cards (the headless transport emits no
 * tool events at all — see GrokStreamingJson header).
 */
function acpToolUpdateToRunEvents(
  update: Record<string, unknown>,
  sub: string,
  raw: Record<string, unknown>
): NormalizedGrokRunEvent[] {
  const toolId = firstStr(update.toolCallId, update.toolCallID, update.id)
  const status = firstStr(update.status).toLowerCase()
  const terminal = status === 'completed' || status === 'failed'
  const events: NormalizedGrokRunEvent[] = []
  if (sub === 'tool_call') {
    // Diff-block evidence FILLS GAPS ONLY: whatever the agent stated in
    // rawInput/input wins every key it set, so a recovered value can never
    // contradict the arguments the tool was actually invoked with.
    const statedInput = acpToolUpdateInput(update)
    const recoveredInput = acpDiffBlockToolInput(update.content)
    events.push({
      type: 'tool_use',
      toolId: toolId || undefined,
      toolName: firstStr(update.title, update.kind) || 'tool',
      // Canonical ACP kind drives the renderer's category icon — the human
      // `title` (the label) is rarely a recognised tool name on its own.
      toolKind: firstStr(update.kind) || undefined,
      toolInput: { ...recoveredInput, ...statedInput },
      raw
    })
  }
  if (terminal) {
    const statedInput = acpToolUpdateInput(update)
    const recoveredInput = acpDiffBlockToolInput(update.content)
    const toolResultInput = { ...recoveredInput, ...statedInput }
    const toolName = firstStr(update.title, update.kind)
    const toolKind = firstStr(update.kind)
    events.push({
      type: 'tool_result',
      toolId: toolId || undefined,
      ...(sub === 'tool_call' || !toolName ? {} : { toolName }),
      ...(sub === 'tool_call' || !toolKind ? {} : { toolKind }),
      ...(Object.keys(toolResultInput).length > 0 ? { toolResultInput } : {}),
      toolStatus: status === 'failed' ? 'error' : 'success',
      toolOutput: acpToolContentToText(update.content) || safeStringify(update.rawOutput),
      raw
    })
  }
  return events
}

/**
 * Map one parsed ACP message to zero or more normalized run events. Never
 * throws; unrecognized messages (model/command updates, summaries) yield [].
 */
export function acpMessageToRunEvents(message: Record<string, unknown>): NormalizedGrokRunEvent[] {
  const method = typeof message.method === 'string' ? message.method : ''

  // Streaming notifications.
  if (method === 'session/update') {
    const update = asObject(asObject(message.params)?.update)
    const sub = update && typeof update.sessionUpdate === 'string' ? update.sessionUpdate : ''
    const content = asObject(update?.content)
    const text = content && typeof content.text === 'string' ? content.text : ''
    if (sub === 'agent_message_chunk' && text) return [{ type: 'content', text, raw: message }]
    if (sub === 'agent_thought_chunk' && text) return [{ type: 'thinking', text, raw: message }]
    if ((sub === 'tool_call' || sub === 'tool_call_update') && update) {
      return acpToolUpdateToRunEvents(update, sub, message)
    }
    return []
  }

  // xAI extension: explicit turn-complete notification.
  if (method === '_x.ai/session/prompt_complete') {
    const stop = asObject(message.params)?.stopReason
    return [{ type: 'result', status: typeof stop === 'string' ? stop : 'success', raw: message }]
  }

  // Responses (have `result` / `error`, no `method`).
  const result = asObject(message.result)
  if (result) {
    const events: NormalizedGrokRunEvent[] = []
    const meta = asObject(result._meta)
    const sessionId =
      typeof result.sessionId === 'string'
        ? result.sessionId
        : meta && typeof meta.sessionId === 'string'
          ? meta.sessionId
          : undefined
    if (sessionId) events.push({ type: 'init', sessionId, raw: message })
    if (typeof result.stopReason === 'string') {
      events.push({ type: 'result', status: result.stopReason, sessionId, raw: message })
    }
    return events
  }

  const error = asObject(message.error)
  if (error) {
    const text = typeof error.message === 'string' ? error.message : 'Grok ACP error.'
    return [{ type: 'provider_warning', text, raw: message }]
  }

  return []
}

// ============================================================
// G5 — session/request_permission (client-mediated tool approvals).
//
// ACP lets the agent ASK the client before running a tool:
//   agent→client request:  {jsonrpc,id,method:'session/request_permission',
//                            params:{sessionId,toolCall:{...},options:[{optionId,name,kind}]}}
//   client→agent response: {jsonrpc,id,result:{outcome:{outcome:'selected',optionId}}}
//                       or: {jsonrpc,id,result:{outcome:{outcome:'cancelled'}}}
// This is the seam where TaskWraith OWNS every Grok side effect: the request is
// surfaced as an approval card (the ledger), and the chosen option is sent back.
// Pure + fixture-tested here; the transport wiring + ledger routing live in
// GrokAcpClient / runGrokAcpProvider (gated behind grokAcpEnabled()).
//
// SAFETY: the response builder DEFAULTS TO CANCELLED. A missing/unknown option,
// a deny decision, or a malformed request can never resolve to an allow — a
// write is approved only when an explicit allow option is matched against an
// explicit allow decision. There is no silent-allow path.
// ============================================================

export const ACP_PERMISSION_METHOD = 'session/request_permission'

export interface AcpPermissionOption {
  optionId: string
  name: string
  /** ACP option kind, e.g. allow_once | allow_always | reject_once | reject_always. */
  kind: string
}

export interface AcpPermissionRequest {
  /** JSON-RPC id to respond to (number or string per the spec). */
  rpcId: number | string
  sessionId: string
  /** Best-effort human label for the requested tool (for the approval card). */
  toolName: string
  /** ACP tool kind (e.g. 'edit', 'execute', 'read') when present. */
  toolKind: string
  options: AcpPermissionOption[]
  /** The raw toolCall object (audit / detail rendering). */
  rawToolCall: Record<string, unknown> | null
}

/** True for an inbound agent→client `session/request_permission` request. */
export function isAcpPermissionRequest(message: Record<string, unknown>): boolean {
  return (
    message.method === ACP_PERMISSION_METHOD &&
    (typeof message.id === 'number' || typeof message.id === 'string')
  )
}

/**
 * Parse a `session/request_permission` request into a structured descriptor.
 * Defensive: returns null unless it's genuinely that request with a usable id.
 */
export function parseAcpPermissionRequest(
  message: Record<string, unknown>
): AcpPermissionRequest | null {
  if (!isAcpPermissionRequest(message)) return null
  const rpcId = message.id as number | string
  const params = asObject(message.params)
  const sessionId = params && typeof params.sessionId === 'string' ? params.sessionId : ''
  const toolCall = asObject(params?.toolCall)
  const toolName =
    (toolCall && typeof toolCall.title === 'string' && toolCall.title) ||
    (toolCall && typeof toolCall.kind === 'string' && toolCall.kind) ||
    'tool'
  const toolKind = toolCall && typeof toolCall.kind === 'string' ? toolCall.kind : ''
  const rawOptions = Array.isArray(params?.options) ? (params!.options as unknown[]) : []
  const options: AcpPermissionOption[] = []
  for (const entry of rawOptions) {
    const opt = asObject(entry)
    if (!opt) continue
    const optionId = typeof opt.optionId === 'string' ? opt.optionId : ''
    if (!optionId) continue
    options.push({
      optionId,
      name: typeof opt.name === 'string' ? opt.name : optionId,
      kind: typeof opt.kind === 'string' ? opt.kind : ''
    })
  }
  return { rpcId, sessionId, toolName, toolKind, options, rawToolCall: toolCall }
}

/**
 * Map an ACP tool kind to the TaskWraith approval-ledger service category so a
 * Grok tool request lands in the right policy bucket + card. Defaults to
 * `shellCommands` (the strictest 'ask' bucket) for unknown/unrecognised kinds —
 * an unfamiliar effect should get the most cautious gate, never a free pass.
 * ACP tool kinds: read | edit | delete | move | search | execute | think |
 * fetch | other.
 */
export function grokToolKindToService(toolKind: string | null | undefined): AgenticServiceId {
  switch ((toolKind || '').toLowerCase()) {
    case 'edit':
    case 'write':
    case 'create':
    case 'delete':
    case 'move':
      return 'fileChanges'
    case 'fetch':
    case 'search':
      return 'mcpTools'
    case 'execute':
    default:
      return 'shellCommands'
  }
}

export type AcpPermissionDecision = 'allow' | 'deny' | 'cancel'

/**
 * Pick the optionId that matches a decision, by ACP option kind. 'allow' prefers
 * a one-shot allow (allow_once) over a persistent one (allow_always); 'deny'
 * prefers reject_once over reject_always. Returns null when no option matches —
 * which the response builder turns into a 'cancelled' outcome (never an allow).
 */
export function selectAcpPermissionOption(
  options: AcpPermissionOption[],
  decision: AcpPermissionDecision
): string | null {
  if (decision === 'cancel') return null
  const prefix = decision === 'allow' ? 'allow' : 'reject'
  const oneShot = decision === 'allow' ? 'allow_once' : 'reject_once'
  const exact = options.find((o) => o.kind === oneShot)
  if (exact) return exact.optionId
  const byPrefix = options.find((o) => o.kind.startsWith(prefix))
  if (byPrefix) return byPrefix.optionId
  return null
}

/**
 * Build the JSON-RPC response for a permission request. Defaults to a
 * 'cancelled' outcome whenever a 'selected' option can't be resolved — so a
 * deny, a cancel, or any option-matching failure never approves a tool.
 */
export function buildAcpPermissionResponse(
  rpcId: number | string,
  options: AcpPermissionOption[],
  decision: AcpPermissionDecision
): Record<string, unknown> {
  const optionId = selectAcpPermissionOption(options, decision)
  const outcome =
    decision !== 'cancel' && optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' }
  return { jsonrpc: '2.0', id: rpcId, result: { outcome } }
}

// ============================================================
// Transport keep-alive — answer inbound requests we don't handle.
//
// ACP is bidirectional: the agent can send the client REQUESTS (method + id)
// that expect a reply. We handle session/request_permission specially; ANY
// OTHER inbound request (most plausibly an `_x.ai/*` extension method, or an
// fs/terminal method) currently goes unanswered, and an unanswered JSON-RPC
// request with an id is the textbook cause of a peer aborting the channel — the
// live `ext_method` / `channel closed` symptom. The fix is to always reply with
// a benign JSON-RPC "method not found" (-32601). SAFETY: this is an ERROR reply,
// never a result/allow/selected outcome, so it can never approve a tool.
// ============================================================

/**
 * True for an inbound agent→client REQUEST: a `method` (string) WITH an `id`
 * (number|string). Distinguishes requests from notifications (method, no id)
 * and responses (id + result/error, no method). session/request_permission is
 * one such request (handled specially); this catches all the rest.
 */
export function isAcpInboundRequest(message: Record<string, unknown>): boolean {
  return (
    typeof message.method === 'string' &&
    (typeof message.id === 'number' || typeof message.id === 'string')
  )
}

/** JSON-RPC "method not found" (-32601) reply for an unhandled inbound request. */
export function buildAcpMethodNotFoundResponse(rpcId: number | string): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id: rpcId,
    error: { code: -32601, message: 'Method not found' }
  }
}
