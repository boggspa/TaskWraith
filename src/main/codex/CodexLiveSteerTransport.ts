import type { LiveSteerDeliveryHooks, LiveSteerTransport } from '../RunManager'
import { CodexAppServerNotRunningError } from '../CodexAppServerClient'
import { buildCodexUserInput } from './CodexRunPolicy'
import { isCodexAppServerRequestTimeout } from './CodexAppServerRequestError'

export const CODEX_LIVE_STEER_TIMEOUT_MS = 10_000

export interface CodexLiveSteerClient {
  request(method: string, params: unknown, timeoutMs?: number): Promise<unknown>
}

export interface CodexLiveSteerTransportOptions {
  /** The exact app-server client that owns the active turn. */
  client: CodexLiveSteerClient
  /** The exact app-server thread that owns the active turn. */
  threadId: string
  /** The exact active turn accepted by turn/start. */
  turnId: string
  timeoutMs?: number
}

export type CodexLiveSteerFailureKind = 'rejected' | 'ambiguous'

interface CodexTurnSteerResponse {
  turnId?: unknown
}

const EXPLICIT_PRECONDITION_PATTERNS = [
  /active\s*turn\s*(?:is\s*)?not\s*steerable/,
  /activeturnnotsteerable/,
  /not\s+steerable/,
  /expected\s*turn\s*(?:id)?[^\n]*(?:mismatch|(?:does|did)\s+not\s+match|not\s+active)/,
  /expectedturnid[^\n]*(?:mismatch|(?:does|did)\s*not\s*match|not\s*active)/,
  /(?:no|without)\s+(?:an?\s+)?active\s+turn/,
  /turn[^\n]*(?:is\s+not|isn't|no\s+longer)\s+active/,
  /turn\s*(?:id)?\s*mismatch/,
  /failed\s+precondition/
]

const EXPLICIT_REJECTION_PATTERNS = [
  ...EXPLICIT_PRECONDITION_PATTERNS,
  /method\s*not\s*found/,
  /unknown\s*method/,
  /unsupported\s*method/,
  /not\s*implemented/,
  /(?:^|\D)-32601(?:\D|$)/,
  /steer[^\n]*(?:rejected|refused|denied)/,
  /invalid\s+(?:params|parameters|request)/
]

const AMBIGUOUS_TRANSPORT_PATTERNS = [
  /timed?\s*out/,
  /not\s+running/,
  /(?:server|process|transport|connection|stream|socket|pipe)[^\n]*(?:stop|exit|clos|disconnect|reset|abort|fail)/,
  /(?:broken\s+pipe|econnreset|econnrefused|epipe|eof)/,
  /network\s+(?:error|failure)/
]

function requireBoundId(value: string, label: string): string {
  const normalized = value.trim()
  if (!normalized) throw new Error(`Codex live steer requires an exact ${label}.`)
  return normalized
}

function collectFailureText(value: unknown, seen = new Set<object>(), depth = 0): string {
  if (depth > 5 || value === null || value === undefined) return ''
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  if (typeof value !== 'object' || seen.has(value)) return ''
  seen.add(value)

  const record = value as Record<string, unknown>
  const parts: string[] =
    value instanceof Error ? [value.name, value.message, value.stack || ''] : []
  for (const [key, nested] of Object.entries(record)) {
    parts.push(key, collectFailureText(nested, seen, depth + 1))
  }
  return parts.filter(Boolean).join(' ')
}

function numericJsonRpcErrorCode(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null
  const code = (error as Record<string, unknown>).code
  return typeof code === 'number' && Number.isFinite(code) ? code : null
}

function isDefinitePreAdmissionJsonRpcCode(code: number): boolean {
  // JSON-RPC Invalid Request, Method Not Found, and Invalid Params all prove
  // the requested operation was not admitted. Internal Error (-32603) and
  // server-defined -320xx codes do not: the server may have failed after
  // applying the steer, so replay would risk duplicating the user message.
  return code === -32600 || code === -32601 || code === -32602
}

/**
 * A JSON-RPC rejection proves the steer did not land, while a request timeout
 * or broken transport does not. Unknown failures stay ambiguous: retrying an
 * operation that may already have reached Codex would duplicate the user turn.
 */
export function classifyCodexLiveSteerFailure(error: unknown): CodexLiveSteerFailureKind {
  if (isCodexAppServerRequestTimeout(error, 'turn/steer')) return 'ambiguous'
  if (error instanceof CodexAppServerNotRunningError) return 'rejected'

  const code = numericJsonRpcErrorCode(error)
  if (code !== null && isDefinitePreAdmissionJsonRpcCode(code)) return 'rejected'

  const text = collectFailureText(error).toLowerCase()
  if (code !== null) {
    if (EXPLICIT_PRECONDITION_PATTERNS.some((pattern) => pattern.test(text))) return 'rejected'
    return 'ambiguous'
  }
  if (EXPLICIT_REJECTION_PATTERNS.some((pattern) => pattern.test(text))) return 'rejected'
  if (AMBIGUOUS_TRANSPORT_PATTERNS.some((pattern) => pattern.test(text))) return 'ambiguous'
  return 'ambiguous'
}

function failureDetail(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim()
  const detail = collectFailureText(error).trim()
  return detail || 'Codex returned no usable rejection detail.'
}

function invokeDeliveryHook(callback: (() => void) | undefined): void {
  try {
    callback?.()
  } catch {
    // Delivery evidence must not turn a settled provider request into an
    // unhandled rejection or prevent later steer requests from settling.
  }
}

function invokeOutcomeHook(callback: ((reason: string) => void) | undefined, reason: string): void {
  try {
    callback?.(reason)
  } catch {
    // Outcome reconciliation is durable elsewhere; a consumer hook failure
    // must not escape this asynchronous request or cause an implicit retry.
  }
}

/**
 * Bind Codex native steering to one client/thread/turn tuple.
 *
 * `sendSteer` remains synchronous for RunManager compatibility: `true` means
 * exactly one asynchronous request was launched (or the same durable entry was
 * already launched), not that Codex accepted it. Only the matching turnId in
 * the response fires `onDelivered`.
 */
export class CodexLiveSteerTransport implements LiveSteerTransport {
  private readonly client: CodexLiveSteerClient
  private readonly threadId: string
  private readonly turnId: string
  private readonly timeoutMs: number
  private readonly attemptedEntryIds = new Set<string>()
  private closed = false

  constructor(options: CodexLiveSteerTransportOptions) {
    this.client = options.client
    this.threadId = requireBoundId(options.threadId, 'thread id')
    this.turnId = requireBoundId(options.turnId, 'turn id')
    const requestedTimeoutMs = options.timeoutMs
    this.timeoutMs =
      typeof requestedTimeoutMs === 'number' && Number.isFinite(requestedTimeoutMs)
        ? Math.max(1, requestedTimeoutMs)
        : CODEX_LIVE_STEER_TIMEOUT_MS
  }

  sendSteer(text: string, hooks?: LiveSteerDeliveryHooks): boolean {
    const entryId = hooks?.entryId.trim()
    if (this.closed || !text.trim() || !hooks || !entryId) return false

    // The durable transcript entry is the idempotency boundary. A caller may
    // observe an async timeout and revisit routing, but this transport must
    // never turn that uncertainty into a second provider request.
    if (this.attemptedEntryIds.has(entryId)) return true
    this.attemptedEntryIds.add(entryId)

    const imagePaths = hooks.imagePaths ? [...hooks.imagePaths] : []
    const clientUserMessageId = hooks.messageId?.trim()
    const params = {
      threadId: this.threadId,
      input: buildCodexUserInput(text, imagePaths),
      expectedTurnId: this.turnId,
      ...(clientUserMessageId ? { clientUserMessageId } : {})
    }

    let request: Promise<unknown>
    try {
      request = this.client.request('turn/steer', params, this.timeoutMs)
    } catch (error) {
      this.settleFailure(error, hooks)
      return true
    }

    void Promise.resolve(request).then(
      (response) => this.settleResponse(response, hooks),
      (error) => this.settleFailure(error, hooks)
    )
    return true
  }

  cancel(): void {
    // There is no request-level cancellation seam after turn/steer is written.
    // Keep already-launched settlements live so an accepted-but-late response
    // cannot be mistaken for safe boundary replay. Cancellation only closes
    // this exact binding to further sends.
    this.closed = true
  }

  private settleResponse(response: unknown, hooks: LiveSteerDeliveryHooks): void {
    const responseTurnId =
      response && typeof response === 'object'
        ? (response as CodexTurnSteerResponse).turnId
        : undefined
    if (responseTurnId === this.turnId) {
      invokeDeliveryHook(hooks.onDelivered)
      return
    }

    const detail =
      typeof responseTurnId === 'string' && responseTurnId
        ? `Codex acknowledged turn ${responseTurnId}, not the bound turn ${this.turnId}.`
        : `Codex did not return the bound turn id ${this.turnId}.`
    invokeOutcomeHook(hooks.onAmbiguous, detail)
  }

  private settleFailure(error: unknown, hooks: LiveSteerDeliveryHooks): void {
    const detail = failureDetail(error)
    if (classifyCodexLiveSteerFailure(error) === 'rejected') {
      invokeOutcomeHook(hooks.onRejected, `Codex rejected turn/steer: ${detail}`)
      return
    }
    invokeOutcomeHook(
      hooks.onAmbiguous,
      `Codex turn/steer may have been accepted; it will not be retried: ${detail}`
    )
  }
}

export function createCodexLiveSteerTransport(
  options: CodexLiveSteerTransportOptions
): LiveSteerTransport {
  return new CodexLiveSteerTransport(options)
}
