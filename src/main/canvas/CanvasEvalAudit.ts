// Namespace import (not `{ createHash }`): this module is transitively reachable
// from the renderer bundle (App.tsx -> src/main/PromptComposition -> OllamaRunMemory
// -> here for CANVAS_EVAL_RESULT_REDACTED / assertCanvasEvalApprovalReceipt /
// isCanvasEvalToolName). A named `crypto` import makes the browser build fail on the
// missing export; a namespace binding resolves the member only at call time, which
// only ever happens in the main process. Keep this a namespace import.
import * as nodeCrypto from 'node:crypto'
import { canonicalTaskWraithToolName } from '../TaskWraithMcpTools'
import type { CanvasEvalApprovalReceipt } from './canvasTypes'

/**
 * Versioned, content-minimised proof of the JavaScript approved for a
 * `canvas_eval` call. The script itself is intentionally absent: approval UI
 * receives it over the live IPC payload, while durable stores retain only this
 * receipt.
 */
export const CANVAS_EVAL_RESULT_REDACTED = '[canvas_eval result redacted from durable history]'
export const CANVAS_EVAL_PROVIDER_TEXT_REDACTED =
  '[canvas_eval provider text redacted from durable history]'

export type { CanvasEvalApprovalReceipt } from './canvasTypes'

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

const MAX_EMBEDDED_JSON_CHARS = 200_000

function canvasEvalScriptDigest(script: string): string {
  // JavaScript strings are sequences of UTF-16 code units. Hashing through
  // Node's UTF-8 encoder is not lossless: distinct unpaired surrogates are both
  // replaced with U+FFFD and can therefore share a receipt. Encode every code
  // unit explicitly so the digest binds the exact string reviewed by the user.
  const codeUnits = Buffer.allocUnsafe(script.length * 2)
  for (let index = 0; index < script.length; index += 1) {
    codeUnits.writeUInt16LE(script.charCodeAt(index), index * 2)
  }
  return nodeCrypto.createHash('sha256').update(codeUnits).digest('hex')
}

function updateHashWithCodeUnits(hash: ReturnType<typeof nodeCrypto.createHash>, value: string): void {
  // Length-prefix each component so tuples such as ["a:b", "c"] and
  // ["a", "b:c"] cannot alias when used as correlation identities.
  const length = Buffer.allocUnsafe(8)
  length.writeBigUInt64LE(BigInt(value.length))
  hash.update(length)

  const codeUnits = Buffer.allocUnsafe(value.length * 2)
  for (let index = 0; index < value.length; index += 1) {
    codeUnits.writeUInt16LE(value.charCodeAt(index), index * 2)
  }
  hash.update(codeUnits)
}

function canvasEvalOpaqueIdentityDigest(domain: string, ...values: string[]): string {
  const hash = nodeCrypto.createHash('sha256')
  updateHashWithCodeUnits(hash, 'taskwraith-canvas-eval-opaque-identity-v1')
  updateHashWithCodeUnits(hash, domain)
  for (const value of values) updateHashWithCodeUnits(hash, value)
  return hash.digest('hex')
}

function recordFromMaybeJson(value: unknown): Record<string, unknown> | undefined {
  if (isRecord(value)) return value
  if (typeof value !== 'string' || value.length > MAX_EMBEDDED_JSON_CHARS) return undefined
  const trimmed = value.trim()
  if (!trimmed.startsWith('{')) return undefined
  try {
    const parsed = JSON.parse(trimmed) as unknown
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

export function createCanvasEvalApprovalReceipt(
  script: string,
  approvalId: string
): CanvasEvalApprovalReceipt {
  const normalizedApprovalId = approvalId.trim()
  if (!normalizedApprovalId) throw new Error('canvas_eval receipt requires an approvalId.')
  return {
    schemaVersion: 2,
    approvalId: normalizedApprovalId,
    scriptHashAlgorithm: 'sha256-utf16le',
    scriptHash: canvasEvalScriptDigest(script),
    scriptLength: script.length,
    scriptByteLength: Buffer.byteLength(script, 'utf8')
  }
}

/**
 * Mint a receipt only from the host-selected canonical argument object. Callers
 * must pass the exact args that the executor will receive, never an enclosing
 * provider envelope that may contain decoy aliases.
 */
export function createCanvasEvalApprovalReceiptFromCanonicalArgs(
  canonicalArgs: unknown,
  approvalId: string
): CanvasEvalApprovalReceipt | undefined {
  if (
    !isRecord(canonicalArgs) ||
    typeof canonicalArgs.canvasId !== 'string' ||
    !canonicalArgs.canvasId.trim() ||
    typeof canonicalArgs.script !== 'string'
  ) {
    return undefined
  }
  return createCanvasEvalApprovalReceipt(canonicalArgs.script, approvalId)
}

export function assertCanvasEvalApprovalReceipt(
  script: string,
  receipt: CanvasEvalApprovalReceipt | undefined
): CanvasEvalApprovalReceipt {
  if (!receipt) throw new Error('canvas_eval requires a bound approval receipt.')
  const expected = createCanvasEvalApprovalReceipt(script, receipt.approvalId)
  if (
    receipt.schemaVersion !== expected.schemaVersion ||
    receipt.scriptHashAlgorithm !== expected.scriptHashAlgorithm ||
    receipt.scriptHash !== expected.scriptHash ||
    receipt.scriptLength !== expected.scriptLength ||
    receipt.scriptByteLength !== expected.scriptByteLength
  ) {
    throw new Error('canvas_eval approval receipt does not match the script to execute.')
  }
  return receipt
}

export function isCanvasEvalToolName(value: unknown): boolean {
  return typeof value === 'string' && canonicalTaskWraithToolName(value) === 'canvas_eval'
}

function canvasEvalScriptFingerprint(script: string): Record<string, unknown> {
  return {
    scriptRedacted: true,
    scriptHashAlgorithm: 'sha256-utf16le',
    scriptHash: canvasEvalScriptDigest(script),
    scriptLength: script.length,
    scriptByteLength: Buffer.byteLength(script, 'utf8')
  }
}

/**
 * Minimise the argument preview written by the stdio MCP bridge logger. This
 * runs before an approval id exists, so it records a content fingerprint but
 * deliberately does not pretend to be an approval-bound receipt.
 */
export function canvasEvalMcpArgsForLog(toolName: unknown, args: unknown): unknown {
  const canonicalName = canonicalTaskWraithToolName(String(toolName || ''))
  const argsRecord = recordFromMaybeJson(args)
  if (canonicalName === 'canvas_eval' && !argsRecord) {
    return { scriptRedacted: true, scriptFingerprintUnavailable: true }
  }
  if (!argsRecord) return args
  const nestedCanvasEval =
    canonicalName === 'capability_invoke' && isCanvasEvalToolName(argsRecord.name)
  if (canonicalName !== 'canvas_eval' && !nestedCanvasEval) return args

  const rawArguments = nestedCanvasEval
    ? recordFromMaybeJson(argsRecord.arguments) || {}
    : argsRecord
  const script = typeof rawArguments.script === 'string' ? rawArguments.script : null
  const safeArguments = {
    ...(script !== null
      ? canvasEvalScriptFingerprint(script)
      : { scriptRedacted: true, scriptFingerprintUnavailable: true })
  }
  return nestedCanvasEval ? { name: 'canvas_eval', arguments: safeArguments } : safeArguments
}

const TOOL_IDENTITY_KEYS = ['toolName', 'tool_name', 'tool'] as const
const TOOL_ENVELOPE_KEYS = [
  'item',
  'raw',
  'params',
  'payload',
  'function',
  'preview',
  'parameters',
  'input',
  'arguments'
] as const

function explicitToolIdentities(value: Record<string, unknown>): string[] {
  return TOOL_IDENTITY_KEYS.flatMap((key) =>
    typeof value[key] === 'string' ? [value[key] as string] : []
  )
}

function isKnownToolEnvelope(value: Record<string, unknown>): boolean {
  const eventType = String(value.type || '').toLowerCase()
  return (
    eventType.includes('tool') ||
    eventType.includes('mcp') ||
    TOOL_ENVELOPE_KEYS.some((key) => value[key] !== undefined)
  )
}

function gatewayTargetMatches(value: Record<string, unknown>, target: string): boolean {
  for (const key of ['arguments', 'parameters', 'params', 'input'] as const) {
    const container = recordFromMaybeJson(value[key])
    if (!container) continue
    if (
      typeof container.name === 'string' &&
      canonicalTaskWraithToolName(container.name) === target
    ) {
      return true
    }
  }
  return false
}

function payloadDescribesCanvasEval(value: unknown, depth = 0): boolean {
  if (depth > 8) return false
  if (Array.isArray(value)) return value.some((item) => payloadDescribesCanvasEval(item, depth + 1))
  if (typeof value === 'string') {
    const parsed = recordFromMaybeJson(value)
    return parsed ? payloadDescribesCanvasEval(parsed, depth + 1) : false
  }
  if (!isRecord(value)) return false
  const explicit = explicitToolIdentities(value).map((identity) =>
    canonicalTaskWraithToolName(identity)
  )
  if (explicit.includes('canvas_eval')) return true
  if (explicit.includes('capability_invoke') && gatewayTargetMatches(value, 'canvas_eval')) {
    return true
  }
  if (isKnownToolEnvelope(value) && isCanvasEvalToolName(value.name)) return true
  if (
    isKnownToolEnvelope(value) &&
    typeof value.name === 'string' &&
    canonicalTaskWraithToolName(value.name) === 'capability_invoke'
  ) {
    return gatewayTargetMatches(value, 'canvas_eval')
  }
  for (const key of TOOL_ENVELOPE_KEYS) {
    if (payloadDescribesCanvasEval(value[key], depth + 1)) return true
  }
  return false
}

/**
 * Produce the payload written to the run-event store / approval ledger. The
 * caller must continue sending the original payload to the live approval UI.
 */
export function canvasEvalApprovalPayloadForDurableStorage<T>(
  service: string | undefined,
  payload: T,
  approvalId: string,
  trustedReceipt?: CanvasEvalApprovalReceipt
): T {
  if (!isRecord(payload)) return payload
  if (service !== 'canvasEval' && !payloadDescribesCanvasEval(payload)) return payload
  // The generic durable sanitizer is not an authority parser. Only the host
  // callsite that owns the canonical args may mint and pass this receipt.
  const receipt =
    isCanvasEvalApprovalReceipt(trustedReceipt) && trustedReceipt.approvalId === approvalId
      ? trustedReceipt
      : undefined
  const receiptProjection = receipt
    ? { canvasEvalReceipt: receipt }
    : { canvasEvalReceiptUnavailable: true }
  const safeToolProjection = {
    kind: 'tool',
    toolName: 'canvas_eval',
    securityClass: 'signed-elevated',
    requiresExactDesktopReview: true,
    requestOnly: true,
    scriptRedacted: true,
    ...receiptProjection
  }
  const safe: Record<string, unknown> = {
    id: approvalId,
    approvalId,
    method: 'canvas_eval',
    title: 'Canvas eval approval requested',
    body: 'Exact JavaScript was shown only in the transient desktop approval.',
    preview: safeToolProjection,
    params: safeToolProjection,
    actions: ['accept', 'decline', 'cancel'],
    scriptRedacted: true,
    ...receiptProjection
  }
  return safe as T
}

function payloadDescribesToolName(value: unknown, target: string, depth = 0): boolean {
  if (depth > 8) return false
  if (typeof value === 'string') {
    const parsed = recordFromMaybeJson(value)
    return parsed ? payloadDescribesToolName(parsed, target, depth + 1) : false
  }
  if (Array.isArray(value)) {
    return value.some((child) => payloadDescribesToolName(child, target, depth + 1))
  }
  if (!isRecord(value)) return false
  const explicit = explicitToolIdentities(value).map((identity) =>
    canonicalTaskWraithToolName(identity)
  )
  if (explicit.includes(target)) return true
  if (explicit.includes('capability_invoke') && gatewayTargetMatches(value, target)) {
    return true
  }
  if (
    isKnownToolEnvelope(value) &&
    typeof value.name === 'string' &&
    canonicalTaskWraithToolName(value.name) === target
  ) {
    return true
  }
  if (
    isKnownToolEnvelope(value) &&
    typeof value.name === 'string' &&
    canonicalTaskWraithToolName(value.name) === 'capability_invoke'
  ) {
    return gatewayTargetMatches(value, target)
  }
  return TOOL_ENVELOPE_KEYS.some((key) => payloadDescribesToolName(value[key], target, depth + 1))
}

function canvasEvalCompatIdentity(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { tool_name: 'canvas_eval' }
  const ids = compatToolIds(payload)
  if (ids.length > 0) {
    out.tool_id = `canvas-eval-${canvasEvalOpaqueIdentityDigest('compat-tool-ids', ...ids).slice(0, 24)}`
  }
  if (payloadDescribesToolName(payload, 'capability_invoke')) {
    out.via_gateway = true
    out.gateway_tool_name = 'capability_invoke'
  }
  if (typeof payload.is_error === 'boolean') out.is_error = payload.is_error
  if (typeof payload.isError === 'boolean') out.isError = payload.isError
  return out
}

function compatToolIds(
  payload: Record<string, unknown>,
  depth = 0,
  seen = new Set<string>()
): string[] {
  if (depth > 6) return [...seen]
  for (const key of [
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
  ]) {
    if (typeof payload[key] === 'string' && payload[key]) seen.add(payload[key] as string)
  }
  for (const key of ['item', 'raw', 'params', 'payload', 'function']) {
    const nested = recordFromMaybeJson(payload[key])
    if (!nested) continue
    compatToolIds(nested, depth + 1, seen)
  }
  return [...seen]
}

function isCanvasEvalApprovalReceipt(value: unknown): value is CanvasEvalApprovalReceipt {
  if (!isRecord(value)) return false
  return (
    value.schemaVersion === 2 &&
    typeof value.approvalId === 'string' &&
    value.scriptHashAlgorithm === 'sha256-utf16le' &&
    typeof value.scriptHash === 'string' &&
    /^[a-f0-9]{64}$/.test(value.scriptHash) &&
    Number.isSafeInteger(value.scriptLength) &&
    Number.isSafeInteger(value.scriptByteLength) &&
    (value.scriptLength as number) >= 0 &&
    (value.scriptByteLength as number) >= 0
  )
}

function normalizedEventType(value: unknown): string {
  return String(value || '')
    .toLowerCase()
    .replace(/[/.-]/g, '_')
}

function nestedItem(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  const params = recordFromMaybeJson(payload.params)
  return recordFromMaybeJson(payload.item) ?? recordFromMaybeJson(params?.item)
}

function isCompatToolUse(payload: Record<string, unknown>): boolean {
  const eventType = normalizedEventType(payload.type)
  const item = nestedItem(payload)
  return (
    ['tool_use', 'tool_call', 'tool_request', 'mcp_tool_call'].includes(eventType) ||
    (['item_started', 'item_start'].includes(eventType) &&
      normalizedEventType(item?.type) === 'mcp_tool_call')
  )
}

function isCompatToolResult(payload: Record<string, unknown>): boolean {
  const eventType = normalizedEventType(payload.type)
  const item = nestedItem(payload)
  return (
    [
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
      'mcp_tool_call_completed'
    ].includes(eventType) ||
    (['item_completed', 'item_complete'].includes(eventType) &&
      (normalizedEventType(item?.type) === 'mcp_tool_call' || item?.result !== undefined))
  )
}

/**
 * Privacy-safe transcript/run-event projection for `canvas_eval`. This is for
 * TaskWraith's compat/event lanes only; the MCP response returned directly to
 * the provider remains unchanged so the tool is still useful.
 */
export function sanitizeCanvasEvalCompatPayload(
  value: unknown,
  receipt?: CanvasEvalApprovalReceipt
): unknown {
  if (!isRecord(value) || !payloadDescribesCanvasEval(value)) return value

  const identity = canvasEvalCompatIdentity(value)
  // Provider payloads are untrusted and can forge a shape-valid receipt. Only
  // an explicit out-of-band host argument is an authority for this projection.
  const effectiveReceipt = isCanvasEvalApprovalReceipt(receipt) ? receipt : undefined
  if (isCompatToolUse(value)) {
    const viaGateway = payloadDescribesToolName(value, 'capability_invoke')
    return {
      ...identity,
      type: 'tool_use',
      parameters: {
        ...(viaGateway ? { name: 'canvas_eval' } : {}),
        scriptRedacted: true,
        ...(effectiveReceipt ? { canvasEvalReceipt: effectiveReceipt } : {})
      }
    }
  }

  const resultReceipt = {
    redacted: true,
    ...(effectiveReceipt ? { canvasEvalReceipt: effectiveReceipt } : {})
  }
  return {
    ...identity,
    type: 'tool_result',
    status: 'redacted',
    output: CANVAS_EVAL_RESULT_REDACTED,
    result: resultReceipt,
    structuredContent: resultReceipt
  }
}

export interface CanvasEvalCompatSanitizer {
  sanitize: (value: unknown, receipt?: CanvasEvalApprovalReceipt, scope?: string) => unknown
}

/**
 * Correlate provider result frames that carry only a tool-call id. The map is
 * deliberately bounded: a provider that never emits completion cannot grow a
 * long-running desktop process without limit. Once full, retain the existing
 * correlations and permanently fail closed for otherwise-unknown result frames
 * on this stream. Evicting an older id would let its delayed result leak.
 */
export function createCanvasEvalCompatSanitizer(maxPending = 2048): CanvasEvalCompatSanitizer {
  const pending = new Map<string, CanvasEvalApprovalReceipt | null>()
  const pendingLimit = Number.isSafeInteger(maxPending) && maxPending > 0 ? maxPending : 1
  let correlationSaturated = false

  const remember = (id: string, receipt: CanvasEvalApprovalReceipt | undefined) => {
    if (pending.has(id)) {
      const existing = pending.get(id)
      if (
        existing === null ||
        (existing && receipt && JSON.stringify(existing) !== JSON.stringify(receipt))
      ) {
        // A provider-controlled id reuse makes receipt attribution ambiguous.
        // Keep redaction active but never project either receipt as authoritative.
        pending.set(id, null)
        correlationSaturated = true
      }
      return
    }
    if (pending.size >= pendingLimit) {
      correlationSaturated = true
      return
    }
    pending.set(id, receipt ?? null)
  }

  return {
    sanitize(value, receipt, scope = 'global') {
      if (!isRecord(value)) return value
      const ids = compatToolIds(value)
      const scopedIds = ids.map((id) =>
        canvasEvalOpaqueIdentityDigest('compat-correlation-id', scope, id)
      )
      const describesCanvasEval = payloadDescribesCanvasEval(value)

      if (describesCanvasEval) {
        let effectiveReceipt = isCanvasEvalApprovalReceipt(receipt) ? receipt : undefined
        if (isCompatToolUse(value)) {
          if (scopedIds.length === 0) correlationSaturated = true
          for (const scopedId of scopedIds) remember(scopedId, effectiveReceipt)
        }
        if (!effectiveReceipt && isCompatToolResult(value)) {
          const candidateReceipts = scopedIds
            .filter((scopedId) => pending.has(scopedId))
            .map((scopedId) => pending.get(scopedId))
            .filter((candidate): candidate is CanvasEvalApprovalReceipt => Boolean(candidate))
          const distinctReceipts = new Map(
            candidateReceipts.map((candidate) => [JSON.stringify(candidate), candidate])
          )
          if (distinctReceipts.size === 1) {
            effectiveReceipt = distinctReceipts.values().next().value
          }
        }
        const sanitized = sanitizeCanvasEvalCompatPayload(value, effectiveReceipt)
        if (isCompatToolResult(value)) {
          for (const scopedId of scopedIds) pending.delete(scopedId)
        }
        return sanitized
      }

      const matchingIds = scopedIds.filter((scopedId) => pending.has(scopedId))
      if (matchingIds.length > 0 && isCompatToolResult(value)) {
        const candidateReceipts = matchingIds
          .map((scopedId) => pending.get(scopedId))
          .filter((candidate): candidate is CanvasEvalApprovalReceipt => Boolean(candidate))
        for (const scopedId of matchingIds) pending.delete(scopedId)
        const distinctReceipts = new Map(
          candidateReceipts.map((candidate) => [JSON.stringify(candidate), candidate])
        )
        const effectiveReceipt = isCanvasEvalApprovalReceipt(receipt)
          ? receipt
          : distinctReceipts.size === 1
            ? distinctReceipts.values().next().value
            : undefined
        return sanitizeCanvasEvalCompatPayload(
          {
            type: 'tool_result',
            tool_name: 'canvas_eval',
            ...(ids.length > 0 ? { tool_id: ids.join('\u0000') } : {})
          },
          effectiveReceipt
        )
      }
      if (correlationSaturated && isCompatToolResult(value)) {
        return sanitizeCanvasEvalCompatPayload(
          {
            type: 'tool_result',
            tool_name: 'canvas_eval',
            ...(ids.length > 0 ? { tool_id: ids.join('\u0000') } : {})
          },
          isCanvasEvalApprovalReceipt(receipt) ? receipt : undefined
        )
      }
      return value
    }
  }
}

export interface CanvasEvalJsonLineSanitizer {
  push: (chunk: string) => string
  flush: () => string
}

/**
 * Fail closed for provider text that could not be trusted as a structured
 * event. A direct canvas_eval spelling is sufficient to redact the text. For
 * result frames that identify the tool only by call id, redact JSON-looking
 * tool frames with result-bearing fields too: once parsing has failed, the raw
 * fallback cannot safely prove that the frame belongs to a different tool.
 */
export function sanitizeCanvasEvalProviderText(text: string): string {
  if (!text) return text
  const canvasEvalMention = /(?:^|[^a-z0-9])canvas[\s_-]*eval(?:$|[^a-z0-9])/i.test(text)
  const jsonLikeToolFrame =
    (text.includes('{') || text.includes('[')) &&
    /(?:tool[\s_-]*(?:use|call|result|output|response)|mcp[\s_-]*tool[\s_-]*call)/i.test(text) &&
    /(?:["']?(?:script|arguments|parameters|output|result|response|content|value)["']?\s*:)/i.test(
      text
    )
  if (!canvasEvalMention && !jsonLikeToolFrame) return text

  const trailingLineBreaks = text.match(/(?:(?:\r\n)|\n|\r)+$/)?.[0] || ''
  return `${CANVAS_EVAL_PROVIDER_TEXT_REDACTED}${trailingLineBreaks}`
}

/**
 * Sanitize a provider JSONL stream before either the raw run ledger or renderer
 * adapter sees it. Incomplete lines stay in memory until a newline/flush, which
 * prevents a split `script` field from leaking before it can be classified.
 */
export function createCanvasEvalJsonLineSanitizer(
  scope: string,
  maxBufferedChars = 1_000_000
): CanvasEvalJsonLineSanitizer {
  const sanitizer = createCanvasEvalCompatSanitizer()
  let buffered = ''
  let discardOversizedLine = false
  const oversizedMarker = '[oversized unterminated provider event redacted]'

  const sanitizeLine = (line: string): string => {
    const trimmed = line.trim()
    if (!trimmed) return line
    try {
      const parsed = JSON.parse(trimmed) as unknown
      const sanitized = sanitizer.sanitize(parsed, undefined, scope)
      return sanitized === parsed ? line : JSON.stringify(sanitized)
    } catch {
      // A malformed JSON-looking tool event is not useful to the structured
      // adapter. Redact it wholesale rather than risk persisting a split or
      // damaged canvas_eval payload that correlation cannot safely inspect.
      return sanitizeCanvasEvalProviderText(line)
    }
  }

  const drain = (flush: boolean): string => {
    if (flush) {
      const tail = buffered
      buffered = ''
      return tail ? sanitizeLine(tail) : ''
    }

    const lastNewline = buffered.lastIndexOf('\n')
    if (lastNewline < 0) {
      return ''
    }
    const complete = buffered.slice(0, lastNewline)
    buffered = buffered.slice(lastNewline + 1)
    return complete
      .split('\n')
      .map((line) => `${sanitizeLine(line)}\n`)
      .join('')
  }

  return {
    push(chunk) {
      let remaining = chunk
      let output = ''
      if (discardOversizedLine) {
        const newline = remaining.indexOf('\n')
        if (newline < 0) return ''
        discardOversizedLine = false
        output = `${oversizedMarker}\n`
        remaining = remaining.slice(newline + 1)
      }
      buffered += remaining
      output += drain(false)
      if (buffered.length > maxBufferedChars) {
        buffered = ''
        discardOversizedLine = true
      }
      return output
    },
    flush() {
      if (discardOversizedLine) {
        discardOversizedLine = false
        buffered = ''
        return oversizedMarker
      }
      return drain(true)
    }
  }
}
