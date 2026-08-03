/**
 * Closed P1 Channel wire method set (§5 contract).
 *
 * Node-free shared module so host transport and future member clients validate
 * the same shape. Application methods ride the pairwise-encrypted room after
 * admission; this module is the plaintext method catalogue and envelope parser,
 * not the E2EE layer (cipher/key schedule remain donor-owned).
 *
 * Unknown methods, agent/author fields on append, and overlong ids are rejected
 * at the parser — they never degrade into provider dispatch.
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

const REQUEST_METHODS = new Set<ChannelWireMethod>([
  'channel.admission.begin',
  'channel.admission.confirm',
  'channel.reconnect',
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
  /** Optional correlation for appendResult. */
  reqId?: string
}

export type ChannelWireMessage = ChannelWireRequest | ChannelWireResponse | ChannelWireEvent

const MAX_REQ_ID = 200
const MAX_CLIENT_MESSAGE_ID = 200
const MAX_CONTENT_BYTES = 8_000

function isWireMethod(value: unknown): value is ChannelWireMethod {
  return typeof value === 'string' && (CHANNEL_WIRE_METHODS as readonly string[]).includes(value)
}

function isReqId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_REQ_ID
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Append params are intentionally narrow: content + clientMessageId only.
 * Author, agent, dispatch, room, or member fields are protocol violations.
 */
export function parseChannelLogAppendParams(params: unknown): {
  clientMessageId: string
  content: string
} | null {
  if (!isPlainObject(params)) return null
  const forbidden = [
    'authorMemberId',
    'author',
    'memberId',
    'agent',
    'provider',
    'dispatch',
    'providerDispatch',
    'roomId',
    'principalMemberId',
    'identityPublicKey',
    'kind'
  ]
  for (const key of forbidden) {
    if (key in params) return null
  }
  if (typeof params.clientMessageId !== 'string') return null
  const clientMessageId = params.clientMessageId.trim()
  if (!clientMessageId || clientMessageId.length > MAX_CLIENT_MESSAGE_ID) return null
  if (typeof params.content !== 'string') return null
  if (Buffer.byteLength(params.content, 'utf8') > MAX_CONTENT_BYTES) return null
  if (!params.content.trim()) return null
  return { clientMessageId, content: params.content }
}

export function parseChannelLogResumeParams(params: unknown): {
  resumeAfter: number
  maxRecords?: number
  maxBytes?: number
} | null {
  if (!isPlainObject(params)) return null
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
  if (!REQUEST_METHODS.has(method)) {
    throw new Error(`method ${method} is not a member→host request`)
  }
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
  outcome:
    | { ok: true; result: unknown }
    | { ok: false; error: ChannelWireError }
): ChannelWireResponse {
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
        error: outcome.error
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
  return {
    t: 'channel.event',
    protocol: CHANNEL_WIRE_PROTOCOL,
    method,
    params,
    ...(reqId ? { reqId } : {})
  }
}

/**
 * Parse + shape-validate an inbound wire frame. Returns null for anything
 * unrecognized — never throws, so a hostile peer cannot crash the transport.
 */
export function parseChannelWireMessage(data: string): ChannelWireMessage | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    return null
  }
  if (!isPlainObject(parsed)) return null
  if (parsed.protocol !== CHANNEL_WIRE_PROTOCOL) return null

  if (parsed.t === 'channel.req') {
    if (!isReqId(parsed.reqId) || !isWireMethod(parsed.method)) return null
    if (!REQUEST_METHODS.has(parsed.method)) return null
    return {
      t: 'channel.req',
      protocol: CHANNEL_WIRE_PROTOCOL,
      reqId: parsed.reqId,
      method: parsed.method,
      params: parsed.params
    }
  }

  if (parsed.t === 'channel.res') {
    if (!isReqId(parsed.reqId) || typeof parsed.ok !== 'boolean') return null
    const error =
      parsed.error && isPlainObject(parsed.error) && typeof parsed.error.message === 'string'
        ? {
            code: typeof parsed.error.code === 'string' ? parsed.error.code : 'protocol_unsupported',
            message: parsed.error.message
          }
        : undefined
    return {
      t: 'channel.res',
      protocol: CHANNEL_WIRE_PROTOCOL,
      reqId: parsed.reqId,
      ok: parsed.ok,
      ...(parsed.result !== undefined ? { result: parsed.result } : {}),
      ...(error ? { error } : {})
    }
  }

  if (parsed.t === 'channel.event') {
    if (!isWireMethod(parsed.method) || !EVENT_METHODS.has(parsed.method)) return null
    return {
      t: 'channel.event',
      protocol: CHANNEL_WIRE_PROTOCOL,
      method: parsed.method,
      params: parsed.params,
      ...(isReqId(parsed.reqId) ? { reqId: parsed.reqId } : {})
    }
  }

  return null
}
