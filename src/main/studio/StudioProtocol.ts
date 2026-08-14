/**
 * Revisioned Studio companion wire protocol, version 1.
 *
 * Framing is NDJSON: exactly one JSON-RPC 2.0 message per LF-terminated line.
 * Every mutating request carries the caller's baseRevision; the host rejects
 * stale bases with the current revision attached instead of merging, keeping
 * the companion a stateless projection of host-owned state
 * (see StudioRevisionStore).
 *
 * This module is transport- and process-agnostic: it defines envelopes, ops,
 * error codes and byte framing only. It must NOT import Electron and must stay
 * disjoint from src/main/media/TwMediaProtocol.ts — that file is the
 * privileged twmedia:// asset-streaming scheme, not an editor RPC channel.
 */
import type { StudioRationalTime } from './StudioRationalTime'

export const STUDIO_PROTOCOL_VERSION = 1
/** Versioned schema for the additive studio/openMedia request. */
export const STUDIO_OPEN_MEDIA_SCHEMA_VERSION = 1
/** Versioned schema for durable ghost proposals and their resolution. */
export const STUDIO_PROPOSAL_SCHEMA_VERSION = 1
/** Versioned schema for exact, asset-bound transcript segments. */
export const STUDIO_TRANSCRIPT_SCHEMA_VERSION = 1
/** Versioned schema for the bounded, inline external effect preview. */
export const STUDIO_EFFECT_PREVIEW_SCHEMA_VERSION = 1

export const STUDIO_SERVER_NAME = 'taskwraith-studio-host'

export const STUDIO_METHODS = Object.freeze({
  hello: 'studio/hello',
  getDocument: 'studio/getDocument',
  applyEdit: 'studio/applyEdit',
  openMedia: 'studio/openMedia',
  proposeEdit: 'studio/proposeEdit',
  resolveProposal: 'studio/resolveProposal',
  setTranscript: 'studio/setTranscript',
  editCommitted: 'studio/editCommitted'
})

export type StudioErrorCode =
  | 'parse_error'
  | 'invalid_request'
  | 'method_not_found'
  | 'invalid_params'
  | 'stale_base'
  | 'invalid_op'
  | 'insertion_inside_item'
  | 'duplicate_item'
  | 'unrepresentable_time'
  | 'misaligned_time'
  | 'unsupported_protocol_version'
  | 'store_failure'
  | 'duplicate_proposal'
  | 'proposal_not_found'

/** JSON-RPC numeric codes; 4xxx is the Studio application range. */
export const STUDIO_ERROR_NUMBERS: Readonly<Record<StudioErrorCode, number>> = Object.freeze({
  parse_error: -32700,
  invalid_request: -32600,
  method_not_found: -32601,
  invalid_params: -32602,
  stale_base: 4001,
  invalid_op: 4002,
  insertion_inside_item: 4003,
  duplicate_item: 4004,
  unrepresentable_time: 4005,
  misaligned_time: 4006,
  unsupported_protocol_version: 4007,
  store_failure: 4008,
  duplicate_proposal: 4009,
  proposal_not_found: 4010
})

export interface StudioRequestMessage {
  jsonrpc: '2.0'
  id: number
  method: string
  params?: unknown
}

export interface StudioNotificationMessage {
  jsonrpc: '2.0'
  method: string
  params?: unknown
}

export interface StudioErrorPayload {
  code: number
  message: string
  data: { studioCode: StudioErrorCode; [key: string]: unknown }
}

export interface StudioSuccessResponseMessage {
  jsonrpc: '2.0'
  id: number
  result: unknown
}

export interface StudioErrorResponseMessage {
  jsonrpc: '2.0'
  id: number | null
  error: StudioErrorPayload
}

export type StudioResponseMessage = StudioSuccessResponseMessage | StudioErrorResponseMessage

export type StudioMessage = StudioRequestMessage | StudioNotificationMessage | StudioResponseMessage

export type StudioMediaKind = 'video'

/** Stable host-owned identity for a file-backed media source. */
export interface StudioMediaAsset {
  assetId: string
  /** Canonical real path returned by the host after its media-root check. */
  path: string
  mediaKind: StudioMediaKind
}

/** Insert a source range into the sequence. Closed, frame-precise, lossless. */
export interface StudioInsertRangeOp {
  type: 'insert_range'
  /** Caller-chosen stable id; replay and idempotent retries key on it. */
  itemId: string
  assetId: string
  /** Target track; defaults to the primary video track. */
  trackId?: string
  /** When present, sourceIn/sourceOut must land exactly on frame boundaries. */
  assetFrameRate?: StudioRationalTime
  sourceIn: StudioRationalTime
  /** Exclusive end of the source range; must be strictly after sourceIn. */
  sourceOut: StudioRationalTime
  /** Sequence insertion point; items at or after it ripple right. */
  at: StudioRationalTime
}

export type StudioEditOp = StudioInsertRangeOp

/** Durable document mutation emitted by studio/openMedia. */
export interface StudioOpenMediaOp {
  type: 'open_media'
  asset: StudioMediaAsset
}

/** Durable ghost edit. The timeline changes only after explicit acceptance. */
export interface StudioEditProposal {
  schemaVersion: typeof STUDIO_PROPOSAL_SCHEMA_VERSION
  proposalId: string
  /** Revision created by the proposal commit itself. */
  createdRevision: number
  op: StudioEditOp
}

export interface StudioProposeEditOp {
  type: 'propose_edit'
  proposal: StudioEditProposal
}

export type StudioProposalDecision = 'accept' | 'reject'

export interface StudioResolveProposalOp {
  type: 'resolve_proposal'
  proposalId: string
  decision: StudioProposalDecision
}

/** Half-open source range for one stable transcript selection unit. */
export interface StudioTranscriptSegment {
  segmentId: string
  text: string
  sourceIn: StudioRationalTime
  sourceOut: StudioRationalTime
  /** Optional recognizer metadata; never used for edit timing. */
  confidence?: number
}

export interface StudioTranscript {
  schemaVersion: typeof STUDIO_TRANSCRIPT_SCHEMA_VERSION
  transcriptId: string
  assetId: string
  localeIdentifier?: string
  segments: StudioTranscriptSegment[]
}

export interface StudioSetTranscriptOp {
  type: 'set_transcript'
  transcript: StudioTranscript
}

/**
 * A bounded external colour-grade preview, carried INLINE.
 *
 * The operator's filesystem path is deliberately absent from this type. The
 * host validates and reads the file at its own boundary (see
 * StudioEffectPreviewSource) and only the verified text travels, so the
 * companion is never asked to open an arbitrary path and the durable document
 * cannot leak one. This shape intentionally mirrors the loader's return value;
 * a test pins the two schema constants together so they cannot drift.
 */
export interface StudioEffectPreview {
  schemaVersion: typeof STUDIO_EFFECT_PREVIEW_SCHEMA_VERSION
  /** Lowercase SHA-256 hex of the UTF-8 cube text; the stable content identity. */
  effectId: string
  cubeByteLength: number
  cubeText: string
}

export interface StudioSetEffectPreviewOp {
  type: 'set_effect_preview'
  /**
   * `null` CLEARS the preview. The nullable is load-bearing: an absent field is
   * not a clear, so a malformed or truncated payload can never be mistaken for
   * a deliberate removal of the operator's grade.
   */
  effectPreview: StudioEffectPreview | null
}

export type StudioDocumentOperation =
  | StudioEditOp
  | StudioOpenMediaOp
  | StudioProposeEditOp
  | StudioResolveProposalOp
  | StudioSetTranscriptOp
  | StudioSetEffectPreviewOp

export interface StudioHelloParams {
  protocolVersion: number
  client?: string
}

export interface StudioHelloResult {
  protocolVersion: number
  server: string
  revision: number
}

export interface StudioApplyEditParams {
  baseRevision: number
  op: StudioEditOp
}

export interface StudioApplyEditResult {
  revision: number
}

export interface StudioOpenMediaParams {
  /** This field versions the method payload independently of protocol v1. */
  schemaVersion: typeof STUDIO_OPEN_MEDIA_SCHEMA_VERSION
  baseRevision: number
  assetId: string
  path: string
  mediaKind: StudioMediaKind
}

export interface StudioOpenMediaResult {
  schemaVersion: typeof STUDIO_OPEN_MEDIA_SCHEMA_VERSION
  revision: number
  asset: StudioMediaAsset
}

export interface StudioProposeEditParams {
  schemaVersion: typeof STUDIO_PROPOSAL_SCHEMA_VERSION
  baseRevision: number
  proposalId: string
  op: StudioEditOp
}

export interface StudioProposeEditResult {
  schemaVersion: typeof STUDIO_PROPOSAL_SCHEMA_VERSION
  revision: number
  proposal: StudioEditProposal
}

export interface StudioResolveProposalParams {
  schemaVersion: typeof STUDIO_PROPOSAL_SCHEMA_VERSION
  baseRevision: number
  proposalId: string
  decision: StudioProposalDecision
}

export interface StudioResolveProposalResult {
  schemaVersion: typeof STUDIO_PROPOSAL_SCHEMA_VERSION
  revision: number
  proposalId: string
  decision: StudioProposalDecision
  /** Present only when acceptance applied the proposal to the timeline. */
  appliedOp?: StudioEditOp
}

export interface StudioSetTranscriptParams {
  schemaVersion: typeof STUDIO_TRANSCRIPT_SCHEMA_VERSION
  baseRevision: number
  transcriptId: string
  assetId: string
  localeIdentifier?: string
  segments: StudioTranscriptSegment[]
}

export interface StudioSetTranscriptResult {
  schemaVersion: typeof STUDIO_TRANSCRIPT_SCHEMA_VERSION
  revision: number
  transcript: StudioTranscript
}

export interface StudioEditCommittedParams {
  revision: number
  op: StudioDocumentOperation
}

export function studioResult(id: number, result: unknown): StudioSuccessResponseMessage {
  return { jsonrpc: '2.0', id, result }
}

export function studioError(
  id: number | null,
  studioCode: StudioErrorCode,
  message: string,
  extra?: Record<string, unknown>
): StudioErrorResponseMessage {
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code: STUDIO_ERROR_NUMBERS[studioCode],
      message,
      data: { ...extra, studioCode }
    }
  }
}

export type ClassifiedStudioMessage =
  | { kind: 'request'; message: StudioRequestMessage }
  | { kind: 'notification'; message: StudioNotificationMessage }
  | { kind: 'response'; message: StudioResponseMessage }
  | { kind: 'invalid'; reason: string }

export function classifyStudioMessage(raw: unknown): ClassifiedStudioMessage {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { kind: 'invalid', reason: 'message must be a JSON object' }
  }
  const candidate = raw as Record<string, unknown>
  if (candidate.jsonrpc !== '2.0') {
    return { kind: 'invalid', reason: 'missing jsonrpc "2.0" marker' }
  }
  const hasId = 'id' in candidate
  const id = candidate.id
  if (typeof candidate.method === 'string') {
    if (!hasId) {
      return { kind: 'notification', message: candidate as unknown as StudioNotificationMessage }
    }
    if (typeof id === 'number' && Number.isSafeInteger(id)) {
      return { kind: 'request', message: candidate as unknown as StudioRequestMessage }
    }
    return { kind: 'invalid', reason: 'request id must be a safe integer' }
  }
  if (hasId && ('result' in candidate || 'error' in candidate)) {
    return { kind: 'response', message: candidate as unknown as StudioResponseMessage }
  }
  return { kind: 'invalid', reason: 'message is neither request, notification nor response' }
}

export const STUDIO_MAX_NDJSON_LINE_BYTES = 4 * 1024 * 1024

export type StudioDecodeEvent =
  | { kind: 'message'; value: unknown }
  | { kind: 'decode_error'; code: 'parse_error' | 'line_too_long'; message: string }

const LINE_FEED_BYTE = 10
const CARRIAGE_RETURN_CODE = 13

/**
 * Incremental NDJSON decoder. Bytes are buffered until a LF arrives, so a
 * message split anywhere — including inside a multi-byte UTF-8 sequence — is
 * reassembled correctly. An overlong line is dropped and reported, and the
 * decoder resynchronises at the next LF instead of poisoning the stream.
 */
export class StudioNdjsonDecoder {
  private buffered: Buffer = Buffer.alloc(0)
  private skippingOversizedLine = false
  private readonly maxLineBytes: number

  constructor(maxLineBytes = STUDIO_MAX_NDJSON_LINE_BYTES) {
    this.maxLineBytes = maxLineBytes
  }

  get pendingBytes(): number {
    return this.buffered.length
  }

  push(chunk: Buffer | Uint8Array | string): StudioDecodeEvent[] {
    const incoming = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk)
    this.buffered = this.buffered.length === 0 ? incoming : Buffer.concat([this.buffered, incoming])
    const events: StudioDecodeEvent[] = []
    while (true) {
      const lineEnd = this.buffered.indexOf(LINE_FEED_BYTE)
      if (lineEnd === -1) break
      const lineBuffer = this.buffered.subarray(0, lineEnd)
      this.buffered = this.buffered.subarray(lineEnd + 1)
      if (this.skippingOversizedLine) {
        this.skippingOversizedLine = false
        continue
      }
      const event = this.decodeLine(lineBuffer)
      if (event) events.push(event)
    }
    if (!this.skippingOversizedLine && this.buffered.length > this.maxLineBytes) {
      this.skippingOversizedLine = true
      this.buffered = Buffer.alloc(0)
      events.push({
        kind: 'decode_error',
        code: 'line_too_long',
        message: `NDJSON line exceeded ${this.maxLineBytes} bytes without a line feed`
      })
    }
    return events
  }

  private decodeLine(lineBuffer: Buffer): StudioDecodeEvent | null {
    if (lineBuffer.length > this.maxLineBytes) {
      return {
        kind: 'decode_error',
        code: 'line_too_long',
        message: `NDJSON line of ${lineBuffer.length} bytes exceeds the ${this.maxLineBytes}-byte limit`
      }
    }
    let text = lineBuffer.toString('utf8')
    if (text.charCodeAt(text.length - 1) === CARRIAGE_RETURN_CODE) text = text.slice(0, -1)
    if (text.trim() === '') return null
    try {
      return { kind: 'message', value: JSON.parse(text) }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      return {
        kind: 'decode_error',
        code: 'parse_error',
        message: `invalid NDJSON line: ${detail}`
      }
    }
  }
}

/** Serialise one message as a single LF-terminated NDJSON line. */
export function encodeStudioMessage(message: StudioMessage): string {
  return `${JSON.stringify(message)}\n`
}
