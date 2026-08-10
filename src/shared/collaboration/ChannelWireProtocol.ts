/**
 * Closed, versioned P1 Channel protocol.
 *
 * Only admission/reconnect handshakes are plaintext. Every application
 * request, response, membership event, append result, replay batch, and
 * revocation notice is carried inside ChannelEncryptedFrame.
 */

export const CHANNEL_WIRE_PROTOCOL = 'taskwraith-channel-wire-v1'

export const CHANNEL_WIRE_METHODS = [
  'channel.admission.begin',
  'channel.admission.confirm',
  'channel.reconnect',
  'channel.members.snapshot',
  'channel.log.append',
  'channel.log.appendResult',
  'channel.log.resume',
  'channel.log.batch',
  'channel.member.revoked'
] as const

export type ChannelWireMethod = (typeof CHANNEL_WIRE_METHODS)[number]
export type ChannelHandshakeMode = 'admission' | 'reconnect'
export type ChannelFrameDirection = 'hostToMember' | 'memberToHost'

const HANDSHAKE_REQUEST_METHODS = new Set<ChannelWireMethod>([
  'channel.admission.begin',
  'channel.admission.confirm',
  'channel.reconnect'
])

const APPLICATION_REQUEST_METHODS = new Set<ChannelWireMethod>([
  'channel.log.append',
  'channel.log.resume'
])

const EVENT_METHODS = new Set<ChannelWireMethod>([
  'channel.members.snapshot',
  'channel.log.batch',
  'channel.member.revoked',
  'channel.log.appendResult'
])

export type ChannelWireErrorCode =
  | 'protocol_unsupported'
  | 'human_only'
  | 'not_member'
  | 'identity_mismatch'
  | 'revoked'
  | 'quota_exceeded'
  | 'policy_denied'
  | 'idempotency_conflict'
  | 'invalid_cursor'
  | 'resync_required'
  | 'recovery_blocked'
  | 'host_unavailable'
  | 'channel_closed'

export interface ChannelWireError {
  code: ChannelWireErrorCode | string
  message: string
}

export interface ChannelWireRequest {
  t: 'channel.req'
  protocol: typeof CHANNEL_WIRE_PROTOCOL
  reqId: string
  method: ChannelWireMethod
  params: unknown
}

export interface ChannelWireResponse {
  t: 'channel.res'
  protocol: typeof CHANNEL_WIRE_PROTOCOL
  reqId: string
  ok: boolean
  result?: unknown
  error?: ChannelWireError
}

export interface ChannelWireEvent {
  t: 'channel.event'
  protocol: typeof CHANNEL_WIRE_PROTOCOL
  method: ChannelWireMethod
  params: unknown
  reqId?: string
}

export interface ChannelEncryptedFrame {
  t: 'channel.enc'
  protocol: typeof CHANNEL_WIRE_PROTOCOL
  sessionId: string
  direction: ChannelFrameDirection
  seq: number
  nonce: string
  ct: string
  tag: string
}

export type ChannelApplicationMessage = ChannelWireRequest | ChannelWireResponse | ChannelWireEvent

export type ChannelTransportMessage =
  | ChannelWireRequest
  | ChannelWireResponse
  | ChannelEncryptedFrame

/**
 * Backwards-compatible public union. The raw parser deliberately never
 * returns a plaintext event; callers that inspect historical fixtures can
 * still name the complete logical wire union.
 */
export type ChannelWireMessage = ChannelTransportMessage | ChannelWireEvent

export interface ChannelHandshakeContext {
  protocol: typeof CHANNEL_WIRE_PROTOCOL
  mode: ChannelHandshakeMode
  channelId: string
  chatId: string
  inviteId: string
  inviteTokenHash: string
  inviteExpiresAt: number
  memberId: string
  roomId: string
  hostIdentityPubKeyB64: string
  memberIdentityPubKeyB64: string
  hostEphemeralPubKeyB64: string
  memberEphemeralPubKeyB64: string
  hostNonceB64: string
  memberNonceB64: string
}

export interface ChannelAdmissionBeginInput {
  channelId: string
  inviteId: string
  inviteToken: string
  roomId: string
  displayName: string
  memberIdentityPubKeyB64: string
  memberEphemeralPubKeyB64: string
  memberNonceB64: string
}

export interface ChannelReconnectInput {
  channelId: string
  memberId: string
  roomId: string
  memberIdentityPubKeyB64: string
  memberEphemeralPubKeyB64: string
  memberNonceB64: string
}

export interface ChannelAdmissionConfirmInput {
  handshakeId: string
  confirmCode: string
  memberTranscriptSigB64: string
}

export interface ChannelHandshakeBeginResult {
  handshakeId: string
  protocol: typeof CHANNEL_WIRE_PROTOCOL
  mode: ChannelHandshakeMode
  channelId: string
  chatId: string
  inviteId: string
  memberId: string
  roomId: string
  hostIdentityPubKeyB64: string
  hostEphemeralPubKeyB64: string
  hostNonceB64: string
  confirmCode: string
  hostTranscriptSigB64: string
  transcriptHashB64: string
  inviteExpiresAt: number
  expiresAt: number
}

export interface ChannelHandshakeConfirmResult {
  sessionId: string
  channelId: string
  memberId: string
  membershipRevision: number
  hostIdentityPubKeyB64: string
  establishedAt: number
}

export interface ChannelHumanReviewReceipt {
  reviewId: string
  state: 'queued' | 'approved'
  enqueuedAt: number
  expiresAt: number
}

export interface ChannelQueuedAppendResult {
  accepted: false
  queuedForHostReview: true
  deduplicated: boolean
  review: ChannelHumanReviewReceipt
}

const MAX_REQ_ID = 200
const MAX_IDENTIFIER = 512
const MAX_KEY_OR_SIGNATURE = 512
const MAX_TOKEN = 512
const MAX_DISPLAY_NAME = 120
const MAX_CLIENT_MESSAGE_ID = 200
const MAX_CONTENT_BYTES = 8_000
const MAX_ERROR_MESSAGE = 240
const MAX_ENCODED_CIPHERTEXT = 1_270_000

function isWireMethod(value: unknown): value is ChannelWireMethod {
  return typeof value === 'string' && (CHANNEL_WIRE_METHODS as readonly string[]).includes(value)
}

function isReqId(value: unknown): value is string {
  return isBoundedString(value, MAX_REQ_ID)
}

function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys)
  return Object.keys(value).every((key) => allowed.has(key))
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

export function parseChannelAdmissionBeginParams(
  params: unknown
): ChannelAdmissionBeginInput | null {
  if (!isPlainObject(params)) return null
  if (
    !hasOnlyKeys(params, [
      'channelId',
      'inviteId',
      'inviteToken',
      'roomId',
      'displayName',
      'memberIdentityPubKeyB64',
      'memberEphemeralPubKeyB64',
      'memberNonceB64'
    ]) ||
    !isBoundedString(params.channelId, MAX_IDENTIFIER) ||
    !isBoundedString(params.inviteId, MAX_IDENTIFIER) ||
    !isBoundedString(params.inviteToken, MAX_TOKEN) ||
    !isBoundedString(params.roomId, MAX_IDENTIFIER) ||
    !isBoundedString(params.displayName, MAX_DISPLAY_NAME) ||
    !isBoundedString(params.memberIdentityPubKeyB64, MAX_KEY_OR_SIGNATURE) ||
    !isBoundedString(params.memberEphemeralPubKeyB64, MAX_KEY_OR_SIGNATURE) ||
    !isBoundedString(params.memberNonceB64, MAX_KEY_OR_SIGNATURE)
  ) {
    return null
  }
  return {
    channelId: params.channelId,
    inviteId: params.inviteId,
    inviteToken: params.inviteToken,
    roomId: params.roomId,
    displayName: params.displayName,
    memberIdentityPubKeyB64: params.memberIdentityPubKeyB64,
    memberEphemeralPubKeyB64: params.memberEphemeralPubKeyB64,
    memberNonceB64: params.memberNonceB64
  }
}

export function parseChannelReconnectParams(params: unknown): ChannelReconnectInput | null {
  if (!isPlainObject(params)) return null
  if (
    !hasOnlyKeys(params, [
      'channelId',
      'memberId',
      'roomId',
      'memberIdentityPubKeyB64',
      'memberEphemeralPubKeyB64',
      'memberNonceB64'
    ]) ||
    !isBoundedString(params.channelId, MAX_IDENTIFIER) ||
    !isBoundedString(params.memberId, MAX_IDENTIFIER) ||
    !isBoundedString(params.roomId, MAX_IDENTIFIER) ||
    !isBoundedString(params.memberIdentityPubKeyB64, MAX_KEY_OR_SIGNATURE) ||
    !isBoundedString(params.memberEphemeralPubKeyB64, MAX_KEY_OR_SIGNATURE) ||
    !isBoundedString(params.memberNonceB64, MAX_KEY_OR_SIGNATURE)
  ) {
    return null
  }
  return {
    channelId: params.channelId,
    memberId: params.memberId,
    roomId: params.roomId,
    memberIdentityPubKeyB64: params.memberIdentityPubKeyB64,
    memberEphemeralPubKeyB64: params.memberEphemeralPubKeyB64,
    memberNonceB64: params.memberNonceB64
  }
}

export function parseChannelAdmissionConfirmParams(
  params: unknown
): ChannelAdmissionConfirmInput | null {
  if (!isPlainObject(params)) return null
  if (
    !hasOnlyKeys(params, ['handshakeId', 'confirmCode', 'memberTranscriptSigB64']) ||
    !isBoundedString(params.handshakeId, MAX_IDENTIFIER) ||
    typeof params.confirmCode !== 'string' ||
    !/^\d{6}$/.test(params.confirmCode) ||
    !isBoundedString(params.memberTranscriptSigB64, MAX_KEY_OR_SIGNATURE)
  ) {
    return null
  }
  return {
    handshakeId: params.handshakeId,
    confirmCode: params.confirmCode,
    memberTranscriptSigB64: params.memberTranscriptSigB64
  }
}

/**
 * Append params are intentionally exact: content + clientMessageId only.
 * Author, agent, provider, dispatch, room, and unknown fields all fail closed.
 */
export function parseChannelLogAppendParams(params: unknown): {
  clientMessageId: string
  content: string
} | null {
  if (!isPlainObject(params)) return null
  if (!hasOnlyKeys(params, ['clientMessageId', 'content'])) return null
  if (typeof params.clientMessageId !== 'string') return null
  const clientMessageId = params.clientMessageId.trim()
  if (!clientMessageId || clientMessageId.length > MAX_CLIENT_MESSAGE_ID) return null
  if (typeof params.content !== 'string') return null
  if (utf8Bytes(params.content) > MAX_CONTENT_BYTES || !params.content.trim()) return null
  return { clientMessageId, content: params.content }
}

export function parseChannelLogResumeParams(params: unknown): {
  resumeAfter: number
  maxRecords?: number
  maxBytes?: number
} | null {
  if (!isPlainObject(params)) return null
  if (!hasOnlyKeys(params, ['resumeAfter', 'maxRecords', 'maxBytes'])) return null
  if (!Number.isInteger(params.resumeAfter) || (params.resumeAfter as number) < 0) return null
  const out: { resumeAfter: number; maxRecords?: number; maxBytes?: number } = {
    resumeAfter: params.resumeAfter as number
  }
  if (params.maxRecords !== undefined) {
    if (!Number.isInteger(params.maxRecords) || (params.maxRecords as number) < 1) return null
    out.maxRecords = params.maxRecords as number
  }
  if (params.maxBytes !== undefined) {
    if (!Number.isInteger(params.maxBytes) || (params.maxBytes as number) < 1) return null
    out.maxBytes = params.maxBytes as number
  }
  return out
}

export function makeChannelRequest(
  reqId: string,
  method: ChannelWireMethod,
  params: unknown = {}
): ChannelWireRequest {
  if (!HANDSHAKE_REQUEST_METHODS.has(method) && !APPLICATION_REQUEST_METHODS.has(method)) {
    throw new Error(`method ${method} is not a member→host request`)
  }
  if (!isReqId(reqId)) throw new Error('request id is invalid')
  return {
    t: 'channel.req',
    protocol: CHANNEL_WIRE_PROTOCOL,
    reqId,
    method,
    params
  }
}

export function makeChannelResponse(
  reqId: string,
  outcome: { ok: true; result: unknown } | { ok: false; error: ChannelWireError }
): ChannelWireResponse {
  if (!isReqId(reqId)) throw new Error('request id is invalid')
  return outcome.ok
    ? {
        t: 'channel.res',
        protocol: CHANNEL_WIRE_PROTOCOL,
        reqId,
        ok: true,
        result: outcome.result
      }
    : {
        t: 'channel.res',
        protocol: CHANNEL_WIRE_PROTOCOL,
        reqId,
        ok: false,
        error: {
          code: String(outcome.error.code).slice(0, 80),
          message: String(outcome.error.message).slice(0, MAX_ERROR_MESSAGE)
        }
      }
}

export function makeChannelEvent(
  method: ChannelWireMethod,
  params: unknown,
  reqId?: string
): ChannelWireEvent {
  if (!EVENT_METHODS.has(method)) {
    throw new Error(`method ${method} is not a host→member event`)
  }
  if (reqId !== undefined && !isReqId(reqId)) throw new Error('request id is invalid')
  return {
    t: 'channel.event',
    protocol: CHANNEL_WIRE_PROTOCOL,
    method,
    params,
    ...(reqId ? { reqId } : {})
  }
}

/** Parse a raw relay frame. Plaintext application methods are rejected. */
export function parseChannelWireMessage(data: string): ChannelWireMessage | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    return null
  }
  if (!isPlainObject(parsed) || parsed.protocol !== CHANNEL_WIRE_PROTOCOL) return null
  if (parsed.t === 'channel.enc') return parseEncryptedFrame(parsed)
  if (parsed.t === 'channel.req') {
    const request = parseRequest(parsed)
    return request && HANDSHAKE_REQUEST_METHODS.has(request.method) ? request : null
  }
  if (parsed.t === 'channel.res') return parseResponse(parsed)
  return null
}

/** Validate a decrypted application payload against the closed method set. */
export function parseChannelApplicationMessage(value: unknown): ChannelApplicationMessage | null {
  if (!isPlainObject(value) || value.protocol !== CHANNEL_WIRE_PROTOCOL) return null
  if (value.t === 'channel.req') {
    const request = parseRequest(value)
    return request && APPLICATION_REQUEST_METHODS.has(request.method) ? request : null
  }
  if (value.t === 'channel.res') return parseResponse(value)
  if (value.t === 'channel.event') return parseEvent(value)
  return null
}

function parseRequest(value: Record<string, unknown>): ChannelWireRequest | null {
  if (
    !hasOnlyKeys(value, ['t', 'protocol', 'reqId', 'method', 'params']) ||
    !isReqId(value.reqId) ||
    !isWireMethod(value.method)
  ) {
    return null
  }
  return {
    t: 'channel.req',
    protocol: CHANNEL_WIRE_PROTOCOL,
    reqId: value.reqId,
    method: value.method,
    params: value.params
  }
}

function parseResponse(value: Record<string, unknown>): ChannelWireResponse | null {
  if (
    !hasOnlyKeys(value, ['t', 'protocol', 'reqId', 'ok', 'result', 'error']) ||
    !isReqId(value.reqId) ||
    typeof value.ok !== 'boolean'
  ) {
    return null
  }
  if (value.ok) {
    if (value.error !== undefined) return null
    return {
      t: 'channel.res',
      protocol: CHANNEL_WIRE_PROTOCOL,
      reqId: value.reqId,
      ok: true,
      ...(value.result !== undefined ? { result: value.result } : {})
    }
  }
  if (
    !isPlainObject(value.error) ||
    !hasOnlyKeys(value.error, ['code', 'message']) ||
    !isBoundedString(value.error.code, 80) ||
    !isBoundedString(value.error.message, MAX_ERROR_MESSAGE)
  ) {
    return null
  }
  return {
    t: 'channel.res',
    protocol: CHANNEL_WIRE_PROTOCOL,
    reqId: value.reqId,
    ok: false,
    error: { code: value.error.code, message: value.error.message }
  }
}

function parseEvent(value: Record<string, unknown>): ChannelWireEvent | null {
  if (
    !hasOnlyKeys(value, ['t', 'protocol', 'method', 'params', 'reqId']) ||
    !isWireMethod(value.method) ||
    !EVENT_METHODS.has(value.method) ||
    (value.reqId !== undefined && !isReqId(value.reqId))
  ) {
    return null
  }
  return {
    t: 'channel.event',
    protocol: CHANNEL_WIRE_PROTOCOL,
    method: value.method,
    params: value.params,
    ...(value.reqId ? { reqId: value.reqId } : {})
  }
}

function parseEncryptedFrame(value: Record<string, unknown>): ChannelEncryptedFrame | null {
  if (
    !hasOnlyKeys(value, ['t', 'protocol', 'sessionId', 'direction', 'seq', 'nonce', 'ct', 'tag']) ||
    !isBoundedString(value.sessionId, MAX_IDENTIFIER) ||
    (value.direction !== 'hostToMember' && value.direction !== 'memberToHost') ||
    !Number.isSafeInteger(value.seq) ||
    (value.seq as number) < 1 ||
    !isBoundedString(value.nonce, 64) ||
    !isBoundedString(value.ct, MAX_ENCODED_CIPHERTEXT) ||
    !isBoundedString(value.tag, 64)
  ) {
    return null
  }
  return {
    t: 'channel.enc',
    protocol: CHANNEL_WIRE_PROTOCOL,
    sessionId: value.sessionId,
    direction: value.direction,
    seq: value.seq as number,
    nonce: value.nonce,
    ct: value.ct,
    tag: value.tag
  }
}
