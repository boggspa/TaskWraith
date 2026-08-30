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
import { PROVIDER_MODEL_CATALOG_MAX_MODELS_PER_PROVIDER } from './providerModelCatalogLimits'
import type { TaskWraithControlThreadOffers } from './taskWraithControlProtocol'
import {
  decodeHostHistoryDeltasFrame,
  decodeHostHistorySinceRequest,
  decodeHostHistorySinceResult,
  decodeHostThreadHistoryPage,
  decodeHostThreadHistoryRequest,
  type HostHistoryDeltasFrame,
  type HostHistorySinceRequest,
  type HostHistorySinceResult,
  type HostThreadHistoryPage,
  type HostThreadHistoryRequest
} from './hostHistoryProtocol'
import {
  decodeHostProviderAuthFlows,
  decodeHostProviderAuthStatusProjection,
  decodeHostProviderOffersProjection,
  decodeHostProviderStatuses,
  type HostProviderAuthFlowProjection,
  type HostProviderAuthStatusProjection,
  type HostProviderOffersProjection,
  type HostProviderStatusProjection
} from './hostSetupProtocol'

/** Local Host transport envelope version — distinct from HOST_PROTOCOL_VERSION. */
export const HOST_LOCAL_TRANSPORT_VERSION = 1 as const

export type HostLocalTransportVersion = typeof HOST_LOCAL_TRANSPORT_VERSION

/** Bounded correlation id for request/response pairing. */
export const HOST_LOCAL_TRANSPORT_MAX_ID = 512

/** Bounded auth token length on the hello frame (opaque; never logged here). */
export const HOST_LOCAL_TRANSPORT_MAX_TOKEN = 512

/** Maximum serialized workspace Git success-result size (including JSON escaping). */
export const HOST_WORKSPACE_GIT_RESULT_MAX_BYTES = 128 * 1024

/** Bounded workspace-relative path carried by a Git read request or status row. */
export const HOST_WORKSPACE_GIT_MAX_PATH = 4_096

export const HOST_WORKSPACE_GIT_READ_SCOPES = ['status', 'diff', 'log'] as const

export type HostWorkspaceGitReadScope = (typeof HOST_WORKSPACE_GIT_READ_SCOPES)[number]

export const HOST_WORKSPACE_GIT_FILE_KINDS = [
  'created',
  'modified',
  'deleted',
  'renamed',
  'untracked',
  'conflicted',
  'ignored'
] as const

export type HostWorkspaceGitFileKind = (typeof HOST_WORKSPACE_GIT_FILE_KINDS)[number]

export type HostWorkspaceGitReadParams =
  | {
      workspaceId: string
      threadId?: undefined
      scope: HostWorkspaceGitReadScope
      path?: string
    }
  | {
      threadId: string
      workspaceId?: undefined
      scope: HostWorkspaceGitReadScope
      path?: string
    }

export interface HostWorkspaceGitStatusFile {
  path: string
  originalPath?: string
  index: string
  workingTree: string
  kind: HostWorkspaceGitFileKind
  staged: boolean
  unstaged: boolean
}

interface HostWorkspaceGitReadResultBase {
  branch: string | null
  head: string | null
  truncated: boolean
}

export type HostWorkspaceGitReadResult =
  | (HostWorkspaceGitReadResultBase & {
      scope: 'status'
      files: readonly HostWorkspaceGitStatusFile[]
    })
  | (HostWorkspaceGitReadResultBase & {
      scope: 'diff' | 'log'
      text: string
    })

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
  'host_unavailable',
  'shutting_down'
] as const

export type HostLocalTransportErrorCode = (typeof HOST_LOCAL_TRANSPORT_ERROR_CODES)[number]

export interface HostLocalTransportError {
  code: HostLocalTransportErrorCode
}

export const HOST_LOCAL_TRANSPORT_REQUEST_KINDS = [
  'snapshot.get',
  'deltas.since',
  'thread.offers',
  'provider.status',
  'provider.offers',
  'provider.auth.flows',
  'provider.auth.status',
  'thread.history',
  'workspace.git.read',
  'history.since',
  'receipt.lookup',
  'health.get',
  'host.shutdown',
  'command.submit',
  'twmission.export'
] as const

export type HostLocalTransportRequestKind = (typeof HOST_LOCAL_TRANSPORT_REQUEST_KINDS)[number]

export const HOST_LOCAL_TRANSPORT_EVENT_KINDS = [
  'deltas',
  'history',
  'health',
  'host.closing'
] as const

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

export interface HostLocalTransportProviderIdParams {
  providerId: string
}

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
      kind: 'thread.offers'
      params: { threadId: string }
    }
  | {
      type: 'request'
      transportVersion: HostLocalTransportVersion
      id: string
      kind: 'provider.status'
      params: Record<string, never>
    }
  | {
      type: 'request'
      transportVersion: HostLocalTransportVersion
      id: string
      kind: 'provider.offers' | 'provider.auth.flows' | 'provider.auth.status'
      params: HostLocalTransportProviderIdParams
    }
  | {
      type: 'request'
      transportVersion: HostLocalTransportVersion
      id: string
      kind: 'thread.history'
      params: HostThreadHistoryRequest
    }
  | {
      type: 'request'
      transportVersion: HostLocalTransportVersion
      id: string
      kind: 'workspace.git.read'
      params: HostWorkspaceGitReadParams
    }
  | {
      type: 'request'
      transportVersion: HostLocalTransportVersion
      id: string
      kind: 'history.since'
      params: HostHistorySinceRequest
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
      kind: 'host.shutdown'
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
  | { kind: 'thread.offers'; offers: TaskWraithControlThreadOffers }
  | { kind: 'provider.status'; statuses: readonly HostProviderStatusProjection[] }
  | { kind: 'provider.offers'; offers: HostProviderOffersProjection }
  | { kind: 'provider.auth.flows'; flows: readonly HostProviderAuthFlowProjection[] }
  | { kind: 'provider.auth.status'; status: HostProviderAuthStatusProjection }
  | { kind: 'thread.history'; page: HostThreadHistoryPage }
  | { kind: 'workspace.git.read'; result: HostWorkspaceGitReadResult }
  | { kind: 'history.since'; result: HostHistorySinceResult }
  | { kind: 'receipt.lookup'; receipt: HostCommandReceipt }
  | { kind: 'health.get'; frame: HostHealthFrame }
  | { kind: 'host.shutdown'; state: 'stopping' | 'already_stopping' }
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
      event: 'history'
      sequence: number
      payload: HostHistoryDeltasFrame
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

function isOptionalBoundedString(value: unknown, max: number): boolean {
  return (
    value === undefined || (typeof value === 'string' && value.length > 0 && value.length <= max)
  )
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed)
  return Object.keys(value).every((key) => allowedSet.has(key))
}

function isWorkspaceGitReadScope(value: unknown): value is HostWorkspaceGitReadScope {
  return (
    typeof value === 'string' &&
    (HOST_WORKSPACE_GIT_READ_SCOPES as readonly string[]).includes(value)
  )
}

function isWorkspaceGitFileKind(value: unknown): value is HostWorkspaceGitFileKind {
  return (
    typeof value === 'string' &&
    (HOST_WORKSPACE_GIT_FILE_KINDS as readonly string[]).includes(value)
  )
}

function isSafeWorkspaceGitPath(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > HOST_WORKSPACE_GIT_MAX_PATH ||
    value.includes('\0')
  ) {
    return false
  }
  if (value.startsWith('/') || value.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(value)) {
    return false
  }
  const segments = value.split(/[\\/]/)
  return segments.every((segment) => segment.length > 0 && segment !== '..')
}

function utf8ByteLength(value: string): number {
  let bytes = 0
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 0x7f) {
      bytes += 1
    } else if (code <= 0x7ff) {
      bytes += 2
    } else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4
        index += 1
      } else {
        bytes += 3
      }
    } else {
      bytes += 3
    }
  }
  return bytes
}

function serializedJsonByteLength(value: unknown): number | null {
  try {
    const encoded = JSON.stringify(value)
    return typeof encoded === 'string' ? utf8ByteLength(encoded) : null
  } catch {
    return null
  }
}

function hasThreadOffersShape(value: unknown): value is TaskWraithControlThreadOffers {
  if (!isRecord(value)) return false
  if (!isBoundedId(value.threadId) || value.source !== 'curated') return false
  if (!isOptionalBoundedString(value.currentModel, 200)) return false
  if (!isOptionalBoundedString(value.currentReasoningEffort, 80)) return false
  if (!isOptionalBoundedString(value.locked, 1_000)) return false
  if (!isRecord(value.provider)) return false
  for (const key of [
    'runtimeProvider',
    'displayProvider',
    'hueKey',
    'accent',
    'shortCode'
  ] as const) {
    if (!isOptionalBoundedString(value.provider[key], 200) || value.provider[key] === undefined) {
      return false
    }
  }
  if (!isOptionalBoundedString(value.provider.model, 200)) return false
  if (!isOptionalBoundedString(value.provider.modelLabel, 200)) return false
  if (
    !Array.isArray(value.models) ||
    value.models.length > PROVIDER_MODEL_CATALOG_MAX_MODELS_PER_PROVIDER
  ) {
    return false
  }
  return value.models.every((model) => {
    if (!isRecord(model) || !isOptionalBoundedString(model.id, 200) || model.id === undefined) {
      return false
    }
    for (const key of ['label', 'disabledReason', 'retiresAt', 'defaultReasoningEffort'] as const) {
      if (!isOptionalBoundedString(model[key], 1_000)) return false
    }
    for (const key of ['isDefault', 'current', 'disabled'] as const) {
      if (model[key] !== undefined && typeof model[key] !== 'boolean') return false
    }
    if (!Array.isArray(model.reasoningEfforts) || model.reasoningEfforts.length > 12) return false
    return model.reasoningEfforts.every((effort) => {
      if (!isRecord(effort) || !isOptionalBoundedString(effort.id, 80) || effort.id === undefined) {
        return false
      }
      if (!isOptionalBoundedString(effort.disabledReason, 1_000)) return false
      return (
        (effort.isDefault === undefined || typeof effort.isDefault === 'boolean') &&
        (effort.disabled === undefined || typeof effort.disabled === 'boolean')
      )
    })
  })
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

function decodeThreadOffersParams(
  value: unknown
): HostLocalTransportDecodeResult<{ threadId: string }> {
  if (!isRecord(value) || Object.keys(value).length !== 1 || !isBoundedId(value.threadId)) {
    return fail('invalid_payload')
  }
  return { ok: true, value: { threadId: value.threadId } }
}

function decodeProviderIdParams(
  value: unknown
): HostLocalTransportDecodeResult<HostLocalTransportProviderIdParams> {
  if (!isRecord(value) || Object.keys(value).length !== 1 || !isBoundedId(value.providerId)) {
    return fail('invalid_payload')
  }
  return { ok: true, value: { providerId: value.providerId } }
}

export function decodeHostWorkspaceGitReadParams(
  value: unknown
): HostLocalTransportDecodeResult<HostWorkspaceGitReadParams> {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['workspaceId', 'threadId', 'scope', 'path']) ||
    !isWorkspaceGitReadScope(value.scope)
  ) {
    return fail('invalid_payload')
  }
  const hasWorkspaceId = Object.prototype.hasOwnProperty.call(value, 'workspaceId')
  const hasThreadId = Object.prototype.hasOwnProperty.call(value, 'threadId')
  if (hasWorkspaceId === hasThreadId) return fail('invalid_payload')
  if (hasWorkspaceId && !isBoundedId(value.workspaceId)) return fail('invalid_payload')
  if (hasThreadId && !isBoundedId(value.threadId)) return fail('invalid_payload')

  const hasPath = Object.prototype.hasOwnProperty.call(value, 'path')
  if (hasPath && !isSafeWorkspaceGitPath(value.path)) return fail('invalid_payload')

  if (hasWorkspaceId) {
    return {
      ok: true,
      value: {
        workspaceId: value.workspaceId as string,
        scope: value.scope,
        ...(hasPath ? { path: value.path as string } : {})
      }
    }
  }
  return {
    ok: true,
    value: {
      threadId: value.threadId as string,
      scope: value.scope,
      ...(hasPath ? { path: value.path as string } : {})
    }
  }
}

function isWorkspaceGitBranch(value: unknown): value is string | null {
  return (
    value === null ||
    (typeof value === 'string' &&
      value.length > 0 &&
      value.length <= 1_024 &&
      !value.includes('\0') &&
      !value.includes('\n') &&
      !value.includes('\r'))
  )
}

function isWorkspaceGitHead(value: unknown): value is string | null {
  return (
    value === null || (typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value))
  )
}

function decodeWorkspaceGitStatusFile(
  value: unknown
): HostLocalTransportDecodeResult<HostWorkspaceGitStatusFile> {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'path',
      'originalPath',
      'index',
      'workingTree',
      'kind',
      'staged',
      'unstaged'
    ]) ||
    !isSafeWorkspaceGitPath(value.path) ||
    typeof value.index !== 'string' ||
    value.index.length !== 1 ||
    typeof value.workingTree !== 'string' ||
    value.workingTree.length !== 1 ||
    !isWorkspaceGitFileKind(value.kind) ||
    typeof value.staged !== 'boolean' ||
    typeof value.unstaged !== 'boolean'
  ) {
    return fail('invalid_payload')
  }
  const hasOriginalPath = Object.prototype.hasOwnProperty.call(value, 'originalPath')
  if (hasOriginalPath && !isSafeWorkspaceGitPath(value.originalPath)) {
    return fail('invalid_payload')
  }
  return {
    ok: true,
    value: {
      path: value.path,
      ...(hasOriginalPath ? { originalPath: value.originalPath as string } : {}),
      index: value.index,
      workingTree: value.workingTree,
      kind: value.kind,
      staged: value.staged,
      unstaged: value.unstaged
    }
  }
}

export function decodeHostWorkspaceGitReadResult(
  value: unknown
): HostLocalTransportDecodeResult<HostWorkspaceGitReadResult> {
  const serializedBytes = serializedJsonByteLength(value)
  if (
    !isRecord(value) ||
    serializedBytes === null ||
    serializedBytes > HOST_WORKSPACE_GIT_RESULT_MAX_BYTES ||
    !isWorkspaceGitReadScope(value.scope) ||
    !isWorkspaceGitBranch(value.branch) ||
    !isWorkspaceGitHead(value.head) ||
    typeof value.truncated !== 'boolean'
  ) {
    return fail('invalid_payload')
  }

  if (value.scope === 'status') {
    if (
      Object.keys(value).length !== 5 ||
      !hasOnlyKeys(value, ['scope', 'branch', 'head', 'files', 'truncated']) ||
      !Array.isArray(value.files) ||
      value.files.length > 4_096
    ) {
      return fail('invalid_payload')
    }
    const files: HostWorkspaceGitStatusFile[] = []
    for (const file of value.files) {
      const decoded = decodeWorkspaceGitStatusFile(file)
      if (!decoded.ok) return decoded
      files.push(decoded.value)
    }
    return {
      ok: true,
      value: {
        scope: 'status',
        branch: value.branch,
        head: value.head,
        files,
        truncated: value.truncated
      }
    }
  }

  if (
    Object.keys(value).length !== 5 ||
    !hasOnlyKeys(value, ['scope', 'branch', 'head', 'text', 'truncated']) ||
    typeof value.text !== 'string'
  ) {
    return fail('invalid_payload')
  }
  return {
    ok: true,
    value: {
      scope: value.scope,
      branch: value.branch,
      head: value.head,
      text: value.text,
      truncated: value.truncated
    }
  }
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
    case 'thread.offers':
      if (!hasThreadOffersShape(value.offers)) return fail('invalid_payload')
      return { ok: true, value: { kind: 'thread.offers', offers: value.offers } }
    case 'provider.status': {
      const statuses = decodeHostProviderStatuses(value.statuses)
      if (!statuses.ok) return fail('invalid_payload')
      return { ok: true, value: { kind: 'provider.status', statuses: statuses.value } }
    }
    case 'provider.offers': {
      const offers = decodeHostProviderOffersProjection(value.offers)
      if (!offers.ok) return fail('invalid_payload')
      return { ok: true, value: { kind: 'provider.offers', offers: offers.value } }
    }
    case 'provider.auth.flows': {
      const flows = decodeHostProviderAuthFlows(value.flows)
      if (!flows.ok) return fail('invalid_payload')
      return { ok: true, value: { kind: 'provider.auth.flows', flows: flows.value } }
    }
    case 'provider.auth.status': {
      const status = decodeHostProviderAuthStatusProjection(value.status)
      if (!status.ok) return fail('invalid_payload')
      return { ok: true, value: { kind: 'provider.auth.status', status: status.value } }
    }
    case 'thread.history': {
      const page = decodeHostThreadHistoryPage(value.page)
      if (!page.ok) return fail('invalid_payload')
      return { ok: true, value: { kind: 'thread.history', page: page.value } }
    }
    case 'workspace.git.read': {
      const serializedBytes = serializedJsonByteLength(value)
      if (
        Object.keys(value).length !== 2 ||
        serializedBytes === null ||
        serializedBytes > HOST_WORKSPACE_GIT_RESULT_MAX_BYTES
      ) {
        return fail('invalid_payload')
      }
      const result = decodeHostWorkspaceGitReadResult(value.result)
      if (!result.ok) return fail('invalid_payload')
      return { ok: true, value: { kind: 'workspace.git.read', result: result.value } }
    }
    case 'history.since': {
      const result = decodeHostHistorySinceResult(value.result)
      if (!result.ok) return fail('invalid_payload')
      return { ok: true, value: { kind: 'history.since', result: result.value } }
    }
    case 'receipt.lookup':
      if (!hasHostReceiptShape(value.receipt)) return fail('invalid_payload')
      return { ok: true, value: { kind: 'receipt.lookup', receipt: value.receipt } }
    case 'health.get':
      if (!hasHealthFrameShape(value.frame)) return fail('invalid_payload')
      return { ok: true, value: { kind: 'health.get', frame: value.frame } }
    case 'host.shutdown':
      if (
        Object.keys(value).length !== 2 ||
        (value.state !== 'stopping' && value.state !== 'already_stopping')
      )
        return fail('invalid_payload')
      return { ok: true, value: { kind: 'host.shutdown', state: value.state } }
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
      case 'thread.offers': {
        const params = decodeThreadOffersParams(value.params)
        if (!params.ok) return params
        return {
          ok: true,
          value: {
            type: 'request',
            transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
            id: id.value,
            kind: 'thread.offers',
            params: params.value
          }
        }
      }
      case 'provider.status': {
        if (!isEmptyParams(value.params)) return fail('invalid_payload')
        return {
          ok: true,
          value: {
            type: 'request',
            transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
            id: id.value,
            kind: 'provider.status',
            params: {}
          }
        }
      }
      case 'provider.offers':
      case 'provider.auth.flows':
      case 'provider.auth.status': {
        const params = decodeProviderIdParams(value.params)
        if (!params.ok) return params
        return {
          ok: true,
          value: {
            type: 'request',
            transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
            id: id.value,
            kind: value.kind,
            params: params.value
          }
        }
      }
      case 'thread.history': {
        const params = decodeHostThreadHistoryRequest(value.params)
        if (!params.ok) return fail('invalid_payload')
        return {
          ok: true,
          value: {
            type: 'request',
            transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
            id: id.value,
            kind: 'thread.history',
            params: params.value
          }
        }
      }
      case 'workspace.git.read': {
        const params = decodeHostWorkspaceGitReadParams(value.params)
        if (!params.ok) return fail('invalid_payload')
        return {
          ok: true,
          value: {
            type: 'request',
            transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
            id: id.value,
            kind: 'workspace.git.read',
            params: params.value
          }
        }
      }
      case 'history.since': {
        const params = decodeHostHistorySinceRequest(value.params)
        if (!params.ok) return fail('invalid_payload')
        return {
          ok: true,
          value: {
            type: 'request',
            transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
            id: id.value,
            kind: 'history.since',
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
      case 'host.shutdown': {
        if (!isEmptyParams(value.params)) return fail('invalid_payload')
        return {
          ok: true,
          value: {
            type: 'request',
            transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
            id: id.value,
            kind: 'host.shutdown',
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
    if (value.event === 'history') {
      const payload = decodeHostHistoryDeltasFrame(value.payload)
      if (!payload.ok) return failHost('invalid_payload')
      return {
        ok: true,
        value: {
          type: 'event',
          transportVersion: HOST_LOCAL_TRANSPORT_VERSION,
          event: 'history',
          sequence: value.sequence,
          payload: payload.value
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
