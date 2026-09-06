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

/** Stable-surface schema fingerprint observed on Muse Code 1.0.3 (1.0.3-R2198.1). */
export const MUSE_MSP_SCHEMA_FINGERPRINT =
  'sha256:03312c213efd14277a0e0a102f70adeae497a469ca4edf7242f479953ed758b7'

/** `clientInfo.name` is a MACHINE identifier: `^[a-z0-9_]+$` (SS1.4.1). A
 * hyphen is rejected with `-32602 invalidParams`, which reads like a transport
 * fault rather than a name problem, so the constant is pinned here. */
export const MUSE_MSP_CLIENT_NAME = 'taskwraith'
export const MUSE_MSP_CLIENT_NAME_PATTERN = /^[a-z0-9_]+$/

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

/** `ErrorKind` (closed). Only the members this lane acts on are named; the rest
 * ride as strings so an added kind is not a parse failure. */
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

/** `ReasoningEffort`. Note MSP publishes `none`, which the exec CLI rejects for
 * `--provider meta` — the two vocabularies are NOT interchangeable. */
export const MUSE_MSP_REASONING_EFFORTS = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'ultra'
] as const
export type MuseMspReasoningEffort = (typeof MUSE_MSP_REASONING_EFFORTS)[number]

/** Disposition when a turn is already running. `steer` folds the input into the
 * running turn instead of queueing it. */
export type MuseMspIfBusy = 'queue' | 'steer' | 'replace'

export type MuseMspTurnTerminal = 'completed' | 'failed' | 'cancelled'

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

export interface MuseMspItem {
  itemId: string
  kind: MuseMspItemKind
  /** Strictly monotonic per item; apply rule is replace-iff-higher. */
  revision: number
  /** Open enum; terminal is anything other than `inProgress`. */
  status: string
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
}

/** `ApprovalChoice.scope` — maps onto TaskWraith's once / session / persistent
 * approval scopes. */
export type MuseMspApprovalChoiceScope = 'once' | 'session' | 'localPersistent'

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
  subject: MuseMspApprovalSubject
  availableChoices: MuseMspApprovalChoice[]
  /** CAS token: `approval/decide` is rejected `approvalRequirementStale` if the
   * requirement moved on, so it must be echoed from the LATEST request/update. */
  currentRequirementId: MuseMspApprovalRequirementRef
  judgeEscalated: boolean
  protectedWrite: boolean
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
