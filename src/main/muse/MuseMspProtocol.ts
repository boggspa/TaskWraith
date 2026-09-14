// Muse Session Protocol (MSP) wire types and pure framing helpers.
//
// MSP is the protocol served by `muse serve` (Muse Code >= 1.0.3): NDJSON
// JSON-RPC 2.0 over the child's stdio, one frame per line — no Content-Length
// headers. It is the successor surface to this seat's `muse exec --json` lane:
// Meta is moving its own TUI onto it (MUSE_EXPERIMENTAL_TUI_MSP_CLIENT).
//
// AUTHORITY: `muse schema generate-json-schema --out DIR` exports the exact
// wire contract for a given binary, offline and instantly, precomputed at build
// time. These types are a hand-translation of `schemaVersion: 1`. The binary
// echoes the schema fingerprint in its `initialize` result, so a mismatch
// against MUSE_MSP_SCHEMA_FINGERPRINT is detectable at runtime rather than
// being discovered as a malformed frame — re-export and re-translate when it
// moves. Do NOT infer shapes from observed traffic; read the schema.
//
// No Electron/node imports beyond `node:` primitives so the module stays unit
// testable and inside the Host Node pure closure.

/** Stable-surface schema fingerprint observed on Muse Code 1.2.1 (1.2.1-R2847.1),
 * re-exported (`muse schema generate-json-schema`) after the drift this mismatch
 * warning had been reporting since the binary moved off 1.1.1-R2514.1. Diff
 * vs the prior translation: enums unchanged; `subagent/*` command family added
 * (not adopted — this lane never sends them); ten notifications published that
 * this lane does not act on (explicit no-op cases in MuseMspClient so they are
 * not mis-counted as method drift); required provenance cursors
 * (`sourceRange`/`viewCursor`, `Session.forkedFrom`) added below. */
export const MUSE_MSP_SCHEMA_FINGERPRINT =
  'sha256:c7ff6c5d1e89cd42f803aea1f05b8e72082f2099685802473eb726903484713b'

/** `clientInfo.name` is a MACHINE identifier: `^[a-z0-9_]+$` (SS1.4.1). A
 * hyphen is rejected with `-32602 invalidParams`, which reads like a transport
 * fault rather than a name problem, so the constant is pinned here. */
export const MUSE_MSP_CLIENT_NAME = 'taskwraith'
export const MUSE_MSP_CLIENT_NAME_PATTERN = /^[a-z0-9_]+$/
/**
 * `clientInfo.version`. Identifies THIS MSP client implementation, not the app
 * build: it is what a server-side compatibility rule would key on, and it must
 * change when the wire behaviour here changes rather than on every release.
 */
export const MUSE_MSP_CLIENT_VERSION = '2'

export type MuseMspJsonRpcId = number | string

export interface MuseMspRequestFrame {
  jsonrpc: '2.0'
  id: MuseMspJsonRpcId
  method: string
  params?: Record<string, unknown>
}

export interface MuseMspNotificationFrame {
  jsonrpc: '2.0'
  method: string
  params?: Record<string, unknown>
}

export interface MuseMspErrorBody {
  code: number
  message: string
  data?: { kind?: MuseMspErrorKind } & Record<string, unknown>
}

export interface MuseMspResponseFrame {
  jsonrpc: '2.0'
  id: MuseMspJsonRpcId
  result?: unknown
  error?: MuseMspErrorBody
}

export type MuseMspInboundFrame =
  | { kind: 'response'; id: MuseMspJsonRpcId; result?: unknown; error?: MuseMspErrorBody }
  | { kind: 'notification'; method: string; params: Record<string, unknown> }
  | { kind: 'request'; id: MuseMspJsonRpcId; method: string; params: Record<string, unknown> }
  | { kind: 'unparsable'; line: string }

/** `ErrorKind` (x-msp-openness: OPEN). Only the members this lane acts on are
 * named; the rest ride as strings so an added kind is not a parse failure. */
export type MuseMspErrorKind =
  | 'invalidParams'
  | 'methodNotFound'
  | 'notInitialized'
  | 'sessionNotFound'
  | 'sessionNotLoaded'
  | 'sessionInUse'
  | 'approvalNotFound'
  | 'approvalAlreadyResolved'
  | 'approvalChoiceInvalid'
  | 'approvalRequirementStale'
  | 'interrupted'
  | 'cancelled'
  | 'overloaded'
  | 'backpressured'
  | 'experimentalRequired'
  | 'capabilityRequired'
  | 'internal'
  | (string & {})

/** `ApprovalMode` — CLOSED by design ("select, never create"): a client selects
 * a mode the host already defines and can never describe a policy on the wire. */
export const MUSE_MSP_APPROVAL_MODES = [
  'allowAll',
  'promptUnmatched',
  'onRequest',
  'denyUnmatched'
] as const
export type MuseMspApprovalMode = (typeof MUSE_MSP_APPROVAL_MODES)[number]

/** `ReasoningEffort` — CLOSED, so a tier missing from this list is not a
 * tolerated unknown: sending it is `invalidParams` and asserting it is absent
 * is a claim about the wire. The asymmetry with the exec ladder runs ONE way
 * only — MSP additionally publishes `none`, which the exec CLI rejects for
 * `--provider meta`. Every exec tier is spelled identically here, `max`
 * included (verified against the 1.1.1-R2514.1 schema export); an earlier
 * translation dropped `max`, and the MSP lane silently upgraded a Max
 * selection to Ultra on the strength of that omission. */
export const MUSE_MSP_REASONING_EFFORTS = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra'
] as const
export type MuseMspReasoningEffort = (typeof MUSE_MSP_REASONING_EFFORTS)[number]

/** Disposition when a turn is already running. `steer` folds the input into the
 * running turn instead of queueing it. */
export type MuseMspIfBusy = 'queue' | 'steer' | 'replace'

/** `ContextPressureLevel` (SS4.6.6). Occupancy vs the host pressure basis —
 * hard threshold first, both inclusive `>=`. OPEN. This is NOT compaction:
 * the sibling `compaction` item kind (SS4.5.10) is a different plane. */
export const MUSE_MSP_CONTEXT_PRESSURE_LEVELS = ['normal', 'warning', 'blocked'] as const
export type MuseMspContextPressureLevel =
  | (typeof MUSE_MSP_CONTEXT_PRESSURE_LEVELS)[number]
  | (string & {})

/** `CompactionTrigger` (SS4.5.10). OPEN. Lives on the compaction ITEM. */
export const MUSE_MSP_COMPACTION_TRIGGERS = ['manual', 'auto'] as const
export type MuseMspCompactionTrigger = (typeof MUSE_MSP_COMPACTION_TRIGGERS)[number] | (string & {})

/** `CompactionOutcome` (SS4.5.10 / SS3.7). OPEN. A `noop` is success. */
export const MUSE_MSP_COMPACTION_OUTCOMES = ['compacted', 'noop', 'failed', 'cancelled'] as const
export type MuseMspCompactionOutcome = (typeof MUSE_MSP_COMPACTION_OUTCOMES)[number] | (string & {})

/** Wire-OPEN for evolution even though the runtime's own vocabulary is closed. */
export type MuseMspTurnTerminal = 'completed' | 'failed' | 'cancelled' | (string & {})

/**
 * The two error kinds the schema's own error table marks `retryable: true`
 * (-32001 overloaded, -32031 backpressured).
 *
 * Everything else is the server saying "this will fail again". Treating a
 * retryable kind as fatal throws away a turn the host expected us to re-offer;
 * treating a fatal one as retryable burns the user's money in a loop. The
 * schema decides, not us.
 */
export const MUSE_MSP_RETRYABLE_ERROR_KINDS: ReadonlySet<string> = new Set([
  'overloaded',
  'backpressured'
])

export function isMuseMspRetryableErrorKind(kind: string | undefined | null): boolean {
  return typeof kind === 'string' && MUSE_MSP_RETRYABLE_ERROR_KINDS.has(kind)
}

/**
 * `TurnError` — present iff a turn's terminal is `failed`.
 *
 * The schema is explicit that mid-turn failures arrive HERE and never as a
 * JSON-RPC error, and that the sibling free-text `reason` is "display and
 * diagnostics only; never branch on it". `retryable` is the server's own
 * judgment and is the only field a retry policy may read.
 */
export interface MuseMspTurnError {
  kind: string
  message: string
  retryable: boolean
}

/** `RecordPosition`/`StreamRef`/`SourceRange` (SS4.2) — durable-record
 * provenance cursors, required on 1.2.1 approval/userInput requests and on
 * every 1.2.1 notification. Opaque tokens to this lane: read nothing off
 * them, pass nothing through. */
export interface MuseMspRecordPosition {
  id: string
  sequence: number
}

export interface MuseMspStreamRef {
  id: string
  /** Free string, NOT an enum — the raw stream vocabulary is deliberately
   * unfrozen upstream (#13929), so closing it here would be pure drift risk. */
  kind: string
}

export interface MuseMspSourceRange {
  first: MuseMspRecordPosition
  last: MuseMspRecordPosition
  stream: MuseMspStreamRef
}

/** One open `userInput/*` prompt. Unanswered, the gated tool call blocks and
 * the turn never terminates — `autoResolutionMs` is OPTIONAL, so there is no
 * guaranteed host-side timeout to rescue us. */
export interface MuseMspUserInputRequest {
  userInputId: string
  sessionId: string
  turnId: string
  itemId: string
  toolCallId: string
  toolName: string
  questions: unknown[]
  /** 1.2.1-required transcript cursor; opaque to this lane. */
  viewCursor: string
  sourceRange?: MuseMspSourceRange
  autoResolutionMs?: number
}

/** A JSON-RPC error that keeps `data.kind` as structured data. Flattening the
 * kind into the message makes every retry decision impossible downstream. */
export class MuseMspRpcError extends Error {
  readonly kind: MuseMspErrorKind
  readonly code: number
  readonly method: string
  constructor(method: string, body: MuseMspErrorBody) {
    const kind = body.data?.kind ?? ''
    super(`${method} failed${kind ? ` (${kind})` : ''}: ${body.message}`)
    this.name = 'MuseMspRpcError'
    this.method = method
    this.code = body.code
    this.kind = kind
  }
  get retryable(): boolean {
    return isMuseMspRetryableErrorKind(this.kind)
  }
}

export type MuseMspItemKind =
  | 'userMessage'
  | 'agentMessage'
  | 'reasoning'
  | 'toolCall'
  | 'userShell'
  | 'subagent'
  | 'workflow'
  | 'reminderChild'
  | 'compaction'
  // Open enum: an unknown kind MUST render generically, never crash the lane.
  | (string & {})

export interface MuseMspTokenUsage {
  inputTokens: number
  outputTokens: number
  cachedTokens: number
  reasoningTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

/** `ItemStatus`. Open: terminal is anything other than `inProgress`, and an
 * unknown value is terminal-unknown and rendered generically. */
export type MuseMspItemStatus =
  | 'inProgress'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'rejected'
  | 'timedOut'
  | (string & {})

export interface MuseMspItem {
  itemId: string
  kind: MuseMspItemKind
  /** Strictly monotonic per item; apply rule is replace-iff-higher. */
  revision: number
  status: MuseMspItemStatus
  turnId?: string
  text?: string
  tool?: string
  args?: string
  callId?: string
  approvalId?: string
  visibleOutput?: string
  failureKind?: string
  failureReason?: string
  fallbackText?: string
  summary?: unknown[]
  steered?: boolean
  truncated?: boolean
  recordedAt?: string
  /** `compaction` item (SS4.5.10) — distinct from `contextUsage.pressure`. */
  outcome?: MuseMspCompactionOutcome
  trigger?: MuseMspCompactionTrigger
  tokensBefore?: number
  tokensAfter?: number
  reason?: string
  summarizedThrough?: string
  strategyId?: string
}

/** `ApprovalChoice.scope` — maps onto TaskWraith's once / session / persistent
 * approval scopes. */
export type MuseMspApprovalChoiceScope = 'once' | 'session' | 'localPersistent' | (string & {})

export interface MuseMspApprovalChoice {
  choiceId: string
  decision: string
  label: string
  scope: MuseMspApprovalChoiceScope
  acceptsFeedback?: boolean
  rulePreview?: string
}

/** Open discriminator: `shell | fileAccess | network | process | tool`. */
export interface MuseMspApprovalSubject {
  kind: string
  toolName?: string
  command?: string
  path?: string
  access?: string
  host?: string
  port?: number
  protocol?: string
  target?: string
  origin?: unknown
  workspaceRoot?: string
  stages?: unknown[]
}

export interface MuseMspApprovalRequirementRef {
  approvalId: string
  sourceIndex: number
}

export interface MuseMspApprovalRequest {
  approvalId: string
  sessionId: string
  turnId: string
  itemId: string
  taskId: string
  toolCallId: string
  toolName: string
  /** Model-authored argument JSON, verbatim. Never eval or trust it. */
  rawArgs: string
  /** 1.2.1-required provenance cursors; opaque to this lane. */
  sourceRange: MuseMspSourceRange
  viewCursor: string
  subject: MuseMspApprovalSubject
  availableChoices: MuseMspApprovalChoice[]
  /** CAS token: `approval/decide` is rejected `approvalRequirementStale` if the
   * requirement moved on, so it must be echoed from the LATEST request/update. */
  currentRequirementId: MuseMspApprovalRequirementRef
  judgeEscalated: boolean
  protectedWrite: boolean
}

/** `ForkProvenance` (1.2.1) — where a forked session came from; null on
 * sessions that were never forked. */
export interface MuseMspForkProvenance {
  sessionId: string
  commandId: string
  cutCursor: string
  cutExplicit: boolean
}

export interface MuseMspSession {
  sessionId: string
  status: string
  activeTurnId: string | null
  turnCount: number
  path: string
  providerId: string | null
  modelId: string | null
  workspaceRoot: string | null
  createdAt: string
  updatedAt: string
  /** 1.2.1-required fork provenance; null on non-forked sessions. */
  forkedFrom: MuseMspForkProvenance | null
  approvalMode?: { mode?: MuseMspApprovalMode; source?: string; lastCommandId?: string | null }
}

export type MuseMspTurnInputPart =
  | { type: 'text'; text: string }
  | {
      type: 'image'
      /** Required on an image part; invalid or empty base64 is invalidParams. */
      base64Data: string
      mediaType: string
      /** `width`/`height` are a dependentRequired PAIR — send both or neither. */
      width?: number
      height?: number
    }

/** Serialize one outbound frame. MSP is line-delimited: exactly one JSON object
 * per line, and the newline is part of the frame. */
export function encodeMuseMspFrame(
  frame: MuseMspRequestFrame | MuseMspNotificationFrame | MuseMspResponseFrame
): string {
  return `${JSON.stringify(frame)}\n`
}

/**
 * Split a stdout chunk into complete NDJSON frames, returning the unconsumed
 * tail. A frame can straddle chunk boundaries, so the caller owns the buffer.
 */
export function decodeMuseMspFrames(buffer: string): {
  frames: MuseMspInboundFrame[]
  rest: string
} {
  const frames: MuseMspInboundFrame[] = []
  let rest = buffer
  for (;;) {
    const index = rest.indexOf('\n')
    if (index < 0) break
    const line = rest.slice(0, index).trim()
    rest = rest.slice(index + 1)
    if (!line) continue
    frames.push(classifyMuseMspLine(line))
  }
  return { frames, rest }
}

function classifyMuseMspLine(line: string): MuseMspInboundFrame {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return { kind: 'unparsable', line }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { kind: 'unparsable', line }
  }
  const record = parsed as Record<string, unknown>
  const id = record.id
  const hasId = typeof id === 'number' || typeof id === 'string'
  const method = typeof record.method === 'string' ? record.method : ''
  const params =
    record.params && typeof record.params === 'object' && !Array.isArray(record.params)
      ? (record.params as Record<string, unknown>)
      : {}
  if (hasId && !method) {
    const error = record.error
    return {
      kind: 'response',
      id: id as MuseMspJsonRpcId,
      ...(record.result !== undefined ? { result: record.result } : {}),
      ...(error && typeof error === 'object' ? { error: error as MuseMspErrorBody } : {})
    }
  }
  if (hasId && method) {
    return { kind: 'request', id: id as MuseMspJsonRpcId, method, params }
  }
  if (method) return { kind: 'notification', method, params }
  return { kind: 'unparsable', line }
}

/** UUIDv7 `commandId`, required on EVERY MSP command — "the server never mints
 * one", and a fresh turn's `turnId` derives from it, so it is the idempotency
 * handle rather than a decoration. */
export function museMspCommandId(
  randomBytes: (size: number) => Uint8Array,
  now = Date.now()
): string {
  const bytes = Uint8Array.from(randomBytes(16))
  const timestamp = BigInt(Math.max(0, Math.trunc(now)))
  bytes[0] = Number((timestamp >> 40n) & 0xffn)
  bytes[1] = Number((timestamp >> 32n) & 0xffn)
  bytes[2] = Number((timestamp >> 24n) & 0xffn)
  bytes[3] = Number((timestamp >> 16n) & 0xffn)
  bytes[4] = Number((timestamp >> 8n) & 0xffn)
  bytes[5] = Number(timestamp & 0xffn)
  bytes[6] = (bytes[6] & 0x0f) | 0x70
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
