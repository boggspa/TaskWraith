/**
 * Host local transport envelope (Wave 3.2).
 *
 * Pure types + codecs wrapping the transport-independent Host protocol frames
 * (`hostProtocol.ts`) for an authenticated local socket/pipe binding.
 * This module has no Node or Electron imports — sockets, tokens on disk, and
 * listeners live in a later HostLocalServer slice.
 *
 * Conceptual coexistence with control protocol v1 (`taskWraithControlProtocol`):
 * this envelope is Host v2 local transport, not a replacement for TUI control v1.
 *
 * Nested payload types are imported type-only from hostProtocol. Deep payload
 * validation remains hostProtocol's job at the Authority/session bind boundary;
 * this layer fail-closes on transport shape, version, id, and closed kind unions.
 * Error frames are body-free: closed `code` union only — never prose bodies.
 */

import type {
  HostBootstrapHello,
  HostBootstrapWelcome,
  HostCommand,
  HostCommandReceipt,
  HostCursorPosition,
  HostDeltasFrame,
  HostHealthFrame,
  HostSnapshotFrame
} from './hostProtocol'

/** Local Host transport envelope version — distinct from HOST_PROTOCOL_VERSION. */
export const HOST_LOCAL_TRANSPORT_VERSION = 1 as const

export type HostLocalTransportVersion = typeof HOST_LOCAL_TRANSPORT_VERSION

/** Bounded correlation id for request/response pairing. */
export const HOST_LOCAL_TRANSPORT_MAX_ID = 512

/** Bounded auth token length on the hello frame (opaque; never logged here). */
export const HOST_LOCAL_TRANSPORT_MAX_TOKEN = 512

/**
 * Closed body-free error codes. Never attach message/prose/args — callers map
 * codes to UI copy outside the wire contract.
 */
export const HOST_LOCAL_TRANSPORT_ERROR_CODES = [
  'unsupported_transport_version',
  'unknown_frame_kind',
  'unknown_request_kind',
  'invalid_frame',
  'missing_id',
  'oversize_id',
  'invalid_token',
  'invalid_payload',
  'unauthorized',
  'host_unavailable'
] as const

export type HostLocalTransportErrorCode = (typeof HOST_LOCAL_TRANSPORT_ERROR_CODES)[number]

export interface HostLocalTransportError {
  code: HostLocalTransportErrorCode
}

export const HOST_LOCAL_TRANSPORT_REQUEST_KINDS = [
  'snapshot.get',
  'deltas.since',
  'receipt.lookup',
  'health.get',
  'command.submit',
  'twmission.export'
] as const

export type HostLocalTransportRequestKind = (typeof HOST_LOCAL_TRANSPORT_REQUEST_KINDS)[number]

export const HOST_LOCAL_TRANSPORT_EVENT_KINDS = ['deltas', 'health', 'host.closing'] as const

export type HostLocalTransportEventKind = (typeof HOST_LOCAL_TRANSPORT_EVENT_KINDS)[number]

/** Client → Host: authenticated hello carrying the existing HostBootstrapHello. */
export interface HostLocalTransportHello {
  type: 'hello'
  transportVersion: HostLocalTransportVersion
  token: string
  hello: HostBootstrapHello
}

export type HostLocalTransportReceiptLookupParams =
  | { commandId: string; idempotencyKey?: undefined }
  | { idempotencyKey: string; commandId?: undefined }

export type HostLocalTransportRequest =
  | {
      type: 'request'
      transportVersion: HostLocalTransportVersion
      id: string
      kind: 'snapshot.get'
      params: Record<string, never>
    }
  | {
      type: 'request'
      transportVersion: HostLocalTransportVersion
      id: string
      kind: 'deltas.since'
      params: HostCursorPosition
    }
  | {
      type: 'request'
      transportVersion: HostLocalTransportVersion
      id: string
      kind: 'receipt.lookup'
      params: HostLocalTransportReceiptLookupParams
    }
  | {
      type: 'request'
      transportVersion: HostLocalTransportVersion
      id: string
      kind: 'health.get'
      params: Record<string, never>
    }
  | {
      type: 'request'
      transportVersion: HostLocalTransportVersion
      id: string
      kind: 'command.submit'
      params: HostCommand
    }
  | {
      type: 'request'
      transportVersion: HostLocalTransportVersion
      id: string
      kind: 'twmission.export'
      params: Record<string, never>
    }

export type HostLocalTransportClientFrame = HostLocalTransportHello | HostLocalTransportRequest

/** Host → Client: welcome carrying the existing HostBootstrapWelcome. */
export interface HostLocalTransportWelcome {
  type: 'welcome'
  transportVersion: HostLocalTransportVersion
  welcome: HostBootstrapWelcome
}

export type HostLocalTransportSuccessResult =
  | { kind: 'snapshot.get'; frame: HostSnapshotFrame }
  | { kind: 'deltas.since'; frame: HostDeltasFrame }
  | { kind: 'receipt.lookup'; receipt: HostCommandReceipt }
  | { kind: 'health.get'; frame: HostHealthFrame }
  | { kind: 'command.submit'; receipt: HostCommandReceipt }
  | { kind: 'twmission.export'; result: Record<string, unknown> }

export type HostLocalTransportResponse =
  | {
      type: 'response'
      transportVersion: HostLocalTransportVersion
      id: string
      ok: true
      result: HostLocalTransportSuccessResult
    }
  | {
      type: 'response'
      transportVersion: HostLocalTransportVersion
      id: string
      ok: false
      error: HostLocalTransportError
    }

/**
 * Known event kinds carry typed payloads. Unknown event kinds are skippable
 * by contract (forward compatibility) — see decodeHostLocalTransportHostFrame.
 */
export type HostLocalTransportEvent =
  | {
      type: 'event'
      transportVersion: HostLocalTransportVersion
      event: 'deltas'
      sequence: number
      payload: HostDeltasFrame
    }
  | {
      type: 'event'
      transportVersion: HostLocalTransportVersion
      event: 'health'
      sequence: number
      payload: HostHealthFrame
    }
  | {
      type: 'event'
      transportVersion: HostLocalTransportVersion
      event: 'host.closing'
      sequence: number
    }

export type HostLocalTransportHostFrame =
  | HostLocalTransportWelcome
  | HostLocalTransportResponse
  | HostLocalTransportEvent

export type HostLocalTransportDecodeResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: HostLocalTransportError }

/**
 * Host-frame decode may skip unknown event kinds (forward compat) instead of
 * rejecting the whole stream. Unknown *request* kinds always reject.
 */
export type HostLocalTransportHostDecodeResult =
  | { ok: true; value: HostLocalTransportHostFrame }
  | {
      ok: true
      skipped: true
      reason: 'unknown_event_kind'
      event: string
      sequence: number
      transportVersion: HostLocalTransportVersion
    }
  | { ok: false; error: HostLocalTransportError }

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function fail<T>(code: HostLocalTransportErrorCode): HostLocalTransportDecodeResult<T> {
  return { ok: false, error: { code } }
}

function failHost(code: HostLocalTransportErrorCode): HostLocalTransportHostDecodeResult {
  return { ok: false, error: { code } }
}

function isTransportVersion(value: unknown): value is HostLocalTransportVersion {
  return value === HOST_LOCAL_TRANSPORT_VERSION
}

function isBoundedId(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= HOST_LOCAL_TRANSPORT_MAX_ID
  )
}

function isBoundedToken(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= HOST_LOCAL_TRANSPORT_MAX_TOKEN
  )
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function isEmptyParams(value: unknown): value is Record<string, never> {
  return isRecord(value) && Object.keys(value).length === 0
}

function isErrorCode(value: unknown): value is HostLocalTransportErrorCode {
  return (
    typeof value === 'string' &&
    (HOST_LOCAL_TRANSPORT_ERROR_CODES as readonly string[]).includes(value)
  )
}

function isRequestKind(value: unknown): value is HostLocalTransportRequestKind {
  return (
    typeof value === 'string' &&
    (HOST_LOCAL_TRANSPORT_REQUEST_KINDS as readonly string[]).includes(value)
  )
}

function isBodyFreeError(value: unknown): value is HostLocalTransportError {
  if (!isRecord(value)) return false
  if (!isErrorCode(value.code)) return false
  // Reject any prose/extra fields — body-free by construction.
  return Object.keys(value).length === 1
}

function hasHostHelloShape(value: unknown): value is HostBootstrapHello {
  return isRecord(value) && value.type === 'host.hello'
}

function hasHostWelcomeShape(value: unknown): value is HostBootstrapWelcome {
  return isRecord(value) && value.type === 'host.welcome'
}

function hasHostCommandShape(value: unknown): value is HostCommand {
  return isRecord(value) && value.type === 'host.command'
}

function hasHostReceiptShape(value: unknown): value is HostCommandReceipt {
  return isRecord(value) && value.type === 'host.receipt'
}

function hasSnapshotFrameShape(value: unknown): value is HostSnapshotFrame {
  return isRecord(value) && value.type === 'host.snapshot'
}

function hasDeltasFrameShape(value: unknown): value is HostDeltasFrame {
  return isRecord(value) && value.type === 'host.deltas'
}

function hasHealthFrameShape(value: unknown): value is HostHealthFrame {
  return isRecord(value) && value.type === 'host.health'
}

function decodeCursorPosition(value: unknown): HostLocalTransportDecodeResult<HostCursorPosition> {
  if (!isRecord(value)) return fail('invalid_payload')
  if (!isNonNegativeInt(value.generation) || !isNonNegativeInt(value.cursor)) {
    return fail('invalid_payload')
  }
  if (Object.keys(value).length !== 2) return fail('invalid_payload')
  return { ok: true, value: { generation: value.generation, cursor: value.cursor } }
}

function decodeReceiptLookupParams(
  value: unknown
): HostLocalTransportDecodeResult<HostLocalTransportReceiptLookupParams> {
  if (!isRecord(value)) return fail('invalid_payload')
  const keys = Object.keys(value)
  const hasCommandId = typeof value.commandId === 'string' && value.commandId.length > 0
  const hasIdempotencyKey =
    typeof value.idempotencyKey === 'string' && value.idempotencyKey.length > 0
  if (hasCommandId === hasIdempotencyKey) return fail('invalid_payload')
  if (keys.length !== 1) return fail('invalid_payload')
  if (hasCommandId) {
    if (!isBoundedId(value.commandId)) return fail('invalid_payload')
    return { ok: true, value: { commandId: value.commandId } }
  }
  if (!isBoundedId(value.idempotencyKey)) return fail('invalid_payload')
  return { ok: true, value: { idempotencyKey: value.idempotencyKey as string } }
}

function decodeSuccessResult(
  value: unknown
): HostLocalTransportDecodeResult<HostLocalTransportSuccessResult> {
  if (!isRecord(value) || typeof value.kind !== 'string') return fail('invalid_payload')
  switch (value.kind) {
    case 'snapshot.get':
      if (!hasSnapshotFrameShape(value.frame)) return fail('invalid_payload')
      return { ok: true, value: { kind: 'snapshot.get', frame: value.frame } }
    case 'deltas.since':
      if (!hasDeltasFrameShape(value.frame)) return fail('invalid_payload')
      return { ok: true, value: { kind: 'deltas.since', frame: value.frame } }
    case 'receipt.lookup':
      if (!hasHostReceiptShape(value.receipt)) return fail('invalid_payload')
      return { ok: true, value: { kind: 'receipt.lookup', receipt: value.receipt } }
    case 'health.get':
      if (!hasHealthFrameShape(value.frame)) return fail('invalid_payload')
      return { ok: true, value: { kind: 'health.get', frame: value.frame } }
    case 'command.submit':
      if (!hasHostReceiptShape(value.receipt)) return fail('invalid_payload')
      return { ok: true, value: { kind: 'command.submit', receipt: value.receipt } }
    case 'twmission.export':
      if (!isRecord(value.result)) return fail('invalid_payload')
      return { ok: true, value: { kind: 'twmission.export', result: value.result } }
    default:
      return fail('invalid_payload')
  }
}

function decodeRequestId(value: unknown): HostLocalTransportDecodeResult<string> {
  if (value === undefined || value === null || value === '') return fail('missing_id')
  if (typeof value !== 'string') return fail('missing_id')
  if (value.length > HOST_LOCAL_TRANSPORT_MAX_ID) return fail('oversize_id')
  return { ok: true, value }
}

/**
 * Decode a client→host transport frame. Unknown request kinds reject;
 * unknown top-level frame kinds reject; bad transport version rejects.
 * Never throws.
 */
export function decodeHostLocalTransportClientFrame(
  value: unknown
): HostLocalTransportDecodeResult<HostLocalTransportClientFrame> {
  if (!isRecord(value)) return fail('invalid_frame')
  if (!isTransportVersion(value.transportVersion)) {
    return fail('unsupported_transport_version')
  }

  if (value.type === 'hello') {
    if (!isBoundedToken(value.token)) return fail('invalid_token')
    if (!hasHostHelloShape(value.hello)) return fail('invalid_payload')
    return {
      ok: true,
      value: {
        type: 'hello',
        transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
        token: value.token,
        hello: value.hello
      }
    }
  }

  if (value.type === 'request') {
    const id = decodeRequestId(value.id)
    if (!id.ok) return id
    if (!isRequestKind(value.kind)) return fail('unknown_request_kind')

    switch (value.kind) {
      case 'snapshot.get': {
        if (!isEmptyParams(value.params)) return fail('invalid_payload')
        return {
          ok: true,
          value: {
            type: 'request',
            transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
            id: id.value,
            kind: 'snapshot.get',
            params: {}
          }
        }
      }
      case 'deltas.since': {
        const params = decodeCursorPosition(value.params)
        if (!params.ok) return params
        return {
          ok: true,
          value: {
            type: 'request',
            transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
            id: id.value,
            kind: 'deltas.since',
            params: params.value
          }
        }
      }
      case 'receipt.lookup': {
        const params = decodeReceiptLookupParams(value.params)
        if (!params.ok) return params
        return {
          ok: true,
          value: {
            type: 'request',
            transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
            id: id.value,
            kind: 'receipt.lookup',
            params: params.value
          }
        }
      }
      case 'health.get': {
        if (!isEmptyParams(value.params)) return fail('invalid_payload')
        return {
          ok: true,
          value: {
            type: 'request',
            transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
            id: id.value,
            kind: 'health.get',
            params: {}
          }
        }
      }
      case 'command.submit': {
        if (!hasHostCommandShape(value.params)) return fail('invalid_payload')
        return {
          ok: true,
          value: {
            type: 'request',
            transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
            id: id.value,
            kind: 'command.submit',
            params: value.params
          }
        }
      }
      case 'twmission.export': {
        if (!isEmptyParams(value.params)) return fail('invalid_payload')
        return {
          ok: true,
          value: {
            type: 'request',
            transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
            id: id.value,
            kind: 'twmission.export',
            params: {}
          }
        }
      }
    }
  }

  return fail('unknown_frame_kind')
}

/**
 * Decode a host→client transport frame. Unknown event kinds are skipped
 * (forward compat); unknown top-level frame kinds and bad versions reject.
 * Never throws.
 */
export function decodeHostLocalTransportHostFrame(
  value: unknown
): HostLocalTransportHostDecodeResult {
  if (!isRecord(value)) return failHost('invalid_frame')
  if (!isTransportVersion(value.transportVersion)) {
    return failHost('unsupported_transport_version')
  }

  if (value.type === 'welcome') {
    if (!hasHostWelcomeShape(value.welcome)) return failHost('invalid_payload')
    return {
      ok: true,
      value: {
        type: 'welcome',
        transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
        welcome: value.welcome
      }
    }
  }

  if (value.type === 'response') {
    const id = decodeRequestId(value.id)
    if (!id.ok) return id
    if (value.ok === true) {
      const result = decodeSuccessResult(value.result)
      if (!result.ok) return result
      return {
        ok: true,
        value: {
          type: 'response',
          transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
          id: id.value,
          ok: true,
          result: result.value
        }
      }
    }
    if (value.ok === false) {
      if (!isBodyFreeError(value.error)) return failHost('invalid_payload')
      return {
        ok: true,
        value: {
          type: 'response',
          transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
          id: id.value,
          ok: false,
          error: { code: value.error.code }
        }
      }
    }
    return failHost('invalid_frame')
  }

  if (value.type === 'event') {
    if (!isNonNegativeInt(value.sequence)) return failHost('invalid_payload')
    if (typeof value.event !== 'string' || value.event.length === 0) {
      return failHost('invalid_payload')
    }

    if (value.event === 'deltas') {
      if (!hasDeltasFrameShape(value.payload)) return failHost('invalid_payload')
      return {
        ok: true,
        value: {
          type: 'event',
          transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
          event: 'deltas',
          sequence: value.sequence,
          payload: value.payload
        }
      }
    }
    if (value.event === 'health') {
      if (!hasHealthFrameShape(value.payload)) return failHost('invalid_payload')
      return {
        ok: true,
        value: {
          type: 'event',
          transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
          event: 'health',
          sequence: value.sequence,
          payload: value.payload
        }
      }
    }
    if (value.event === 'host.closing') {
      if (value.payload !== undefined) return failHost('invalid_payload')
      return {
        ok: true,
        value: {
          type: 'event',
          transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
          event: 'host.closing',
          sequence: value.sequence
        }
      }
    }

    // Forward-compat: unknown event kinds are skippable, not rejected.
    return {
      ok: true,
      skipped: true,
      reason: 'unknown_event_kind',
      event: value.event,
      sequence: value.sequence,
      transportVersion: HOST_LOCAL_TRANSPORT_VERSION
    }
  }

  return failHost('unknown_frame_kind')
}

/** Identity encode helpers — frames are already JSON-plain; validate then return. */
export function encodeHostLocalTransportClientFrame(
  frame: HostLocalTransportClientFrame
): HostLocalTransportDecodeResult<HostLocalTransportClientFrame> {
  return decodeHostLocalTransportClientFrame(frame)
}

export function encodeHostLocalTransportHostFrame(
  frame: HostLocalTransportHostFrame
): HostLocalTransportHostDecodeResult {
  return decodeHostLocalTransportHostFrame(frame)
}

/** True when an error object is body-free (closed code, no prose fields). */
export function assertHostLocalTransportErrorBodyFree(
  error: HostLocalTransportError
): HostLocalTransportDecodeResult<HostLocalTransportError> {
  if (!isBodyFreeError(error)) return fail('invalid_payload')
  return { ok: true, value: { code: error.code } }
}
