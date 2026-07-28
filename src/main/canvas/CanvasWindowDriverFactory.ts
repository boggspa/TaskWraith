/**
 * Main-only construction boundary for the Tier-4 native-window Canvas driver.
 *
 * A CanvasWindowOpenTarget is an opaque, short-lived, one-use rendezvous token;
 * it is not the native attachment handle and it is not a lease.  Main resolves
 * the user-approved, run-owned coordinator lease before issuing a token and
 * again while consuming it.  The resulting driver closes over the full scoped
 * attachment access envelope, which never reaches CanvasService, MCP, or the
 * renderer.
 */
import { createHash, randomUUID } from 'node:crypto'

import type {
  CanvasElementDetail,
  CanvasElementNode,
  CanvasElementTree,
  CanvasFrame,
  CanvasViewport,
  CanvasWindowOpenTarget
} from './canvasTypes'
import {
  CanvasWindowDriver,
  type CanvasWindowActResult,
  type CanvasWindowAdoptResult,
  type CanvasWindowCaptureResult,
  type CanvasWindowClickAuthorization,
  type CanvasWindowClickAuthorizationRequest,
  type CanvasWindowClickAuthorizationScope,
  type CanvasWindowClickRequest,
  type CanvasWindowInspectResult,
  type CanvasWindowLeaseIdentity,
  type CanvasWindowNativeBridge,
  type CanvasWindowObserveResult,
  type CanvasWindowReleaseResult
} from './CanvasWindowDriver'
import type {
  NativeWindowCoordinatorAccessParams,
  NativeWindowCoordinatorCanvasAccess,
  NativeWindowCoordinatorCanvasLeaseIdentity,
  NativeWindowCoordinatorCanvasOwner
} from '../nativeWindow/NativeWindowCoordinator'
import type {
  NativeWindowLeaseControlVerb,
  NativeWindowLeaseReadVerb
} from '../nativeWindow/NativeWindowLeaseRegistry'

const DEFAULT_TARGET_TTL_MS = 30_000
const MAX_TARGET_TTL_MS = 5 * 60_000
const DEFAULT_CLICK_RECEIPT_TTL_MS = 30_000
const MAX_CLICK_RECEIPT_TTL_MS = 60_000
const MAX_CLICK_RECEIPT_LENGTH = 256
const MAX_CLICK_SUMMARY_LENGTH = 300
const MAX_AX_NODES = 400
const MAX_AX_DEPTH = 12
const MAX_AX_CHILDREN = 128
const MAX_TEXT_LENGTH = 4096
const MAX_REF_LENGTH = 256
const MAX_PNG_BYTES = 32 * 1024 * 1024
const MAX_GEOMETRY_MAGNITUDE = 1_000_000
const PNG_SIGNATURE_HEX = '89504e470d0a1a0a'

const LEASE_FIELDS: ReadonlyArray<keyof CanvasWindowLeaseIdentity> = [
  'chatId',
  'runId',
  'attemptId',
  'pid',
  'windowId',
  'processStartedAt',
  'instanceEpoch',
  'consentEpoch',
  'generation'
]

const NATIVE_REFUSAL_REASONS = new Set([
  'not_found',
  'stale_target',
  'occluded',
  'not_fillable',
  'secret_field',
  'user_active',
  'stale_input_epoch',
  'consequential_confirmation_required'
])

export interface CanvasWindowCoordinatorPort {
  resolveLeaseForCanvas(
    owner: NativeWindowCoordinatorCanvasOwner,
    verb?: NativeWindowLeaseReadVerb
  ): NativeWindowCoordinatorCanvasAccess
  currentCanvasLeaseIdentity(
    owner: NativeWindowCoordinatorCanvasOwner
  ): NativeWindowCoordinatorCanvasLeaseIdentity | null
  consumeCanvasActionStep(
    owner: NativeWindowCoordinatorCanvasOwner,
    verb: NativeWindowLeaseControlVerb
  ): NativeWindowCoordinatorCanvasAccess
}

/** Deliberately generic so this module stays Electron-free and unit-testable. */
export interface CanvasWindowDriverFactoryDaemon {
  request<T = unknown>(
    method: string,
    params?: unknown,
    options?: { timeoutMs?: number }
  ): Promise<T>
}

export interface CanvasWindowDriverFactoryOptions {
  readonly coordinator: CanvasWindowCoordinatorPort
  readonly daemon: CanvasWindowDriverFactoryDaemon
  readonly now?: () => number
  readonly createTargetId?: () => string
  /** Short-lived by design; values above five minutes are refused. */
  readonly targetTtlMs?: number
  /**
   * Main-owned UI confirmation for each native click. It receives only the
   * public run/consent scope and a value-free target summary; it never receives
   * a PID, window identity, process-start identity, or attachment handle.
   */
  readonly clickConfirmation?: CanvasWindowClickConfirmation
  /**
   * Synchronous strict-intent audit gate. A throw, thenable, or missing hook
   * fails the click before action budget is consumed or a daemon RPC is sent.
   */
  readonly clickAuditClaim?: CanvasWindowClickAuditClaim
  /** Injectable only for deterministic tests; production uses randomUUID(). */
  readonly createClickReceipt?: () => string
  /** One-use click receipts are intentionally short lived (maximum one minute). */
  readonly clickReceiptTtlMs?: number
}

/** The confirmation UI sees only this safe subset of the exact native binding. */
export interface CanvasWindowClickConfirmation {
  confirm(request: CanvasWindowClickAuthorizationRequest): boolean | Promise<boolean>
}

/**
 * Durable audit data claimed immediately before native dispatch. The preview is
 * a digest, never raw AX text or a submitted fill value.
 */
export interface CanvasWindowClickAuditClaimRequest {
  readonly scope: CanvasWindowClickAuthorizationScope
  readonly ref: string
  readonly expectedObservationId: string
  readonly inputEpoch: number
  readonly previewDigest: string
}

export interface CanvasWindowClickAuditClaim {
  /** Must complete synchronously; returning a thenable is rejected at runtime. */
  claim(request: CanvasWindowClickAuditClaimRequest): void
}

export type CanvasWindowDriverFactoryErrorCode =
  | 'invalid-owner'
  | 'invalid-target'
  | 'lease-stale'
  | 'native-protocol'
  | 'native-rpc-failed'
  | 'target-expired'
  | 'target-not-found'
  | 'target-owner-mismatch'

/** Errors intentionally contain no daemon text, AX text, or fill values. */
export class CanvasWindowDriverFactoryError extends Error {
  constructor(
    readonly code: CanvasWindowDriverFactoryErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'CanvasWindowDriverFactoryError'
  }
}

interface CanonicalOwner {
  readonly chatId: string
  readonly runId: string
  readonly launchAttemptId: string
  readonly provider: string
  readonly participantId: string | null
}

interface Bounds {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

interface CanonicalTarget {
  readonly pid: number
  readonly windowID: number
  readonly bundleID: string
  readonly processLaunchTimeMicros: number
  readonly expectedBounds: Bounds
}

interface CanonicalAccess {
  readonly lease: CanvasWindowLeaseIdentity
  readonly attachment: NativeWindowCoordinatorAccessParams
  readonly target: CanonicalTarget
  readonly protectedHostPIDs: readonly number[]
}

interface PendingTargetBinding {
  readonly id: string
  readonly owner: CanonicalOwner
  readonly lease: CanvasWindowLeaseIdentity
  readonly attachment: NativeWindowCoordinatorAccessParams
  readonly issuedAt: number
  readonly expiresAt: number
}

interface PendingClickReceipt {
  readonly receipt: string
  readonly owner: CanonicalOwner
  readonly lease: CanvasWindowLeaseIdentity
  readonly ref: string
  readonly observationId: string
  readonly inputEpoch: number
  readonly previewDigest: string
  readonly issuedAt: number
  readonly expiresAt: number
}

interface ParsedRawNode {
  readonly ref: string
  readonly parentRef: string | null
  readonly childRefs: readonly string[]
  readonly role: string
  readonly subrole: string | null
  readonly title: string | null
  readonly label: string | null
  readonly identifier: string | null
  readonly frame: Bounds | null
  readonly secure: boolean
}

class SerializedNativeWindowRequests {
  private tail: Promise<void> = Promise.resolve()

  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation)
    this.tail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
}

function factoryError(code: CanvasWindowDriverFactoryErrorCode, message: string): never {
  throw new CanvasWindowDriverFactoryError(code, message)
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)
    if (
      codePoint !== undefined &&
      (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))
    ) {
      return true
    }
  }
  return false
}

function canonicalString(
  value: unknown,
  label: string,
  code: CanvasWindowDriverFactoryErrorCode,
  maximum = MAX_TEXT_LENGTH
): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximum ||
    value.trim() !== value ||
    value.normalize('NFC') !== value ||
    hasControlCharacters(value)
  ) {
    factoryError(code, `${label} is invalid.`)
  }
  return value
}

function optionalText(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  return canonicalString(value, label, 'native-protocol')
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    factoryError('native-protocol', `${label} is invalid.`)
  }
  return value as Record<string, unknown>
}

function positiveInteger(
  value: unknown,
  label: string,
  code: CanvasWindowDriverFactoryErrorCode = 'native-protocol'
): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    factoryError(code, `${label} is invalid.`)
  }
  return Number(value)
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    factoryError('native-protocol', `${label} is invalid.`)
  }
  return Number(value)
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    factoryError('native-protocol', `${label} is invalid.`)
  }
  return value
}

function canonicalTimestamp(value: unknown, label: string): string {
  const timestamp = canonicalString(value, label, 'native-protocol')
  try {
    if (new Date(timestamp).toISOString() !== timestamp) {
      factoryError('native-protocol', `${label} is invalid.`)
    }
  } catch {
    factoryError('native-protocol', `${label} is invalid.`)
  }
  return timestamp
}

function canonicalOwner(input: NativeWindowCoordinatorCanvasOwner): CanonicalOwner {
  const owner = record(input, 'Canvas owner')
  const participant = owner.participantId
  if (participant !== undefined && participant !== null && typeof participant !== 'string') {
    factoryError('invalid-owner', 'Canvas owner is invalid.')
  }
  return Object.freeze({
    chatId: canonicalString(owner.chatId, 'chatId', 'invalid-owner'),
    runId: canonicalString(owner.runId, 'runId', 'invalid-owner'),
    launchAttemptId: canonicalString(owner.launchAttemptId, 'launchAttemptId', 'invalid-owner'),
    provider: canonicalString(owner.provider, 'provider', 'invalid-owner'),
    participantId:
      participant === undefined || participant === null
        ? null
        : canonicalString(participant, 'participantId', 'invalid-owner')
  })
}

function coordinatorOwner(owner: CanonicalOwner): NativeWindowCoordinatorCanvasOwner {
  return {
    chatId: owner.chatId,
    runId: owner.runId,
    launchAttemptId: owner.launchAttemptId,
    provider: owner.provider,
    participantId: owner.participantId
  }
}

function sameOwner(left: CanonicalOwner, right: CanonicalOwner): boolean {
  return (
    left.chatId === right.chatId &&
    left.runId === right.runId &&
    left.launchAttemptId === right.launchAttemptId &&
    left.provider === right.provider &&
    left.participantId === right.participantId
  )
}

function clickAuthorizationScope(
  owner: CanonicalOwner,
  lease: CanvasWindowLeaseIdentity
): CanvasWindowClickAuthorizationScope {
  // The factory has already established this relationship when it creates the
  // driver. Rechecking here keeps the UI scope deliberately smaller than the
  // private lease while ensuring it still names the exact run/consent epoch.
  requireLeaseOwner(lease, owner)
  return Object.freeze({
    chatId: owner.chatId,
    runId: owner.runId,
    attemptId: owner.launchAttemptId,
    consentEpoch: lease.consentEpoch,
    generation: lease.generation
  })
}

function sameClickAuthorizationScope(
  expected: CanvasWindowClickAuthorizationScope,
  candidate: unknown
): boolean {
  try {
    const scope = record(candidate, 'Native click confirmation scope')
    return (
      canonicalString(scope.chatId, 'native click chatId', 'native-rpc-failed') ===
        expected.chatId &&
      canonicalString(scope.runId, 'native click runId', 'native-rpc-failed') === expected.runId &&
      canonicalString(scope.attemptId, 'native click attemptId', 'native-rpc-failed') ===
        expected.attemptId &&
      canonicalString(scope.consentEpoch, 'native click consentEpoch', 'native-rpc-failed') ===
        expected.consentEpoch &&
      positiveInteger(scope.generation, 'native click generation', 'native-rpc-failed') ===
        expected.generation
    )
  } catch {
    return false
  }
}

function canonicalClickAuthorizationRequest(
  value: unknown,
  owner: CanonicalOwner,
  lease: CanvasWindowLeaseIdentity
): CanvasWindowClickAuthorizationRequest {
  const input = record(value, 'Native click confirmation')
  const scope = clickAuthorizationScope(owner, lease)
  if (!sameClickAuthorizationScope(scope, input.scope)) {
    factoryError('native-rpc-failed', 'Native click confirmation does not match this run.')
  }
  if (typeof input.consequentialHint !== 'boolean') {
    factoryError('native-rpc-failed', 'Native click confirmation hint is invalid.')
  }
  return Object.freeze({
    scope,
    observationId: canonicalString(
      input.observationId,
      'native click observation id',
      'native-rpc-failed',
      MAX_REF_LENGTH
    ),
    inputEpoch: nonNegativeInteger(input.inputEpoch, 'native click input epoch'),
    ref: canonicalString(input.ref, 'native click ref', 'native-rpc-failed', MAX_REF_LENGTH),
    semanticSummary: canonicalString(
      input.semanticSummary,
      'native click summary',
      'native-rpc-failed',
      MAX_CLICK_SUMMARY_LENGTH
    ),
    consequentialHint: input.consequentialHint
  })
}

function clickPreviewDigest(summary: string): string {
  return createHash('sha256').update(summary, 'utf8').digest('hex')
}

function isThenable(value: unknown): boolean {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) return false
  try {
    return typeof (value as { then?: unknown }).then === 'function'
  } catch {
    return true
  }
}

function canonicalLease(
  value: unknown,
  code: CanvasWindowDriverFactoryErrorCode
): CanvasWindowLeaseIdentity {
  const input = record(value, 'Native-window lease')
  return Object.freeze({
    chatId: canonicalString(input.chatId, 'lease.chatId', code),
    runId: canonicalString(input.runId, 'lease.runId', code),
    attemptId: canonicalString(input.attemptId, 'lease.attemptId', code),
    pid: positiveInteger(input.pid, 'lease.pid', code),
    windowId: positiveInteger(input.windowId, 'lease.windowId', code),
    processStartedAt: canonicalString(input.processStartedAt, 'lease.processStartedAt', code),
    instanceEpoch: canonicalString(input.instanceEpoch, 'lease.instanceEpoch', code),
    consentEpoch: canonicalString(input.consentEpoch, 'lease.consentEpoch', code),
    generation: positiveInteger(input.generation, 'lease.generation', code)
  })
}

function sameLease(
  left: CanvasWindowLeaseIdentity,
  right: CanvasWindowLeaseIdentity | null | undefined
): boolean {
  return !!right && LEASE_FIELDS.every((field) => left[field] === right[field])
}

function requireExactLease(
  expected: CanvasWindowLeaseIdentity,
  candidate: CanvasWindowLeaseIdentity | null | undefined,
  message = 'Native-window authority is stale or mismatched.'
): void {
  if (!sameLease(expected, candidate)) factoryError('lease-stale', message)
}

function requireLeaseOwner(lease: CanvasWindowLeaseIdentity, owner: CanonicalOwner): void {
  if (
    lease.chatId !== owner.chatId ||
    lease.runId !== owner.runId ||
    lease.attemptId !== owner.launchAttemptId
  ) {
    factoryError('lease-stale', 'Native-window coordinator returned another run owner.')
  }
}

function canonicalBounds(value: unknown, label: string): Bounds {
  const input = record(value, label)
  const x = finiteNumber(input.x, `${label}.x`)
  const y = finiteNumber(input.y, `${label}.y`)
  const width = finiteNumber(input.width, `${label}.width`)
  const height = finiteNumber(input.height, `${label}.height`)
  if (
    width < 0 ||
    height < 0 ||
    [x, y, width, height].some((part) => Math.abs(part) > MAX_GEOMETRY_MAGNITUDE)
  ) {
    factoryError('native-protocol', `${label} is invalid.`)
  }
  return Object.freeze({ x, y, width, height })
}

function canonicalAttachment(value: unknown): NativeWindowCoordinatorAccessParams {
  const input = record(value, 'Native-window attachment access')
  return Object.freeze({
    handleID: canonicalString(input.handleID, 'attachment.handleID', 'lease-stale'),
    scopeID: canonicalString(input.scopeID, 'attachment.scopeID', 'lease-stale'),
    chatID: canonicalString(input.chatID, 'attachment.chatID', 'lease-stale'),
    consentEpoch: nonNegativeInteger(input.consentEpoch, 'attachment.consentEpoch'),
    generation: positiveInteger(input.generation, 'attachment.generation', 'lease-stale')
  })
}

function sameAttachment(
  left: NativeWindowCoordinatorAccessParams,
  right: NativeWindowCoordinatorAccessParams
): boolean {
  return (
    left.handleID === right.handleID &&
    left.scopeID === right.scopeID &&
    left.chatID === right.chatID &&
    left.consentEpoch === right.consentEpoch &&
    left.generation === right.generation
  )
}

function attachmentParams(access: NativeWindowCoordinatorAccessParams): Record<string, unknown> {
  return {
    handleID: access.handleID,
    scopeID: access.scopeID,
    chatID: access.chatID,
    consentEpoch: access.consentEpoch,
    generation: access.generation
  }
}

function canonicalAccess(value: unknown): CanonicalAccess {
  const input = record(value, 'Native-window coordinator access')
  const lease = canonicalLease(input.lease, 'lease-stale')
  const attachment = canonicalAttachment(input.attachment)
  const rawTarget = record(input.target, 'Native-window target')
  const target: CanonicalTarget = Object.freeze({
    pid: positiveInteger(rawTarget.pid, 'target.pid', 'lease-stale'),
    windowID: positiveInteger(rawTarget.windowID, 'target.windowID', 'lease-stale'),
    bundleID: canonicalString(rawTarget.bundleID, 'target.bundleID', 'lease-stale'),
    processLaunchTimeMicros: positiveInteger(
      rawTarget.processLaunchTimeMicros,
      'target.processLaunchTimeMicros',
      'lease-stale'
    ),
    expectedBounds: canonicalBounds(rawTarget.expectedBounds, 'target.expectedBounds')
  })
  if (target.pid !== lease.pid || target.windowID !== lease.windowId) {
    factoryError('lease-stale', 'Native-window target identity is stale or mismatched.')
  }
  if (!Array.isArray(input.protectedHostPIDs) || input.protectedHostPIDs.length === 0) {
    factoryError('lease-stale', 'Native-window protected-host identity is unavailable.')
  }
  const protectedHostPIDs = Object.freeze(
    [
      ...new Set(input.protectedHostPIDs.map((pid) => positiveInteger(pid, 'protectedHostPIDs')))
    ].sort((left, right) => left - right)
  )
  return Object.freeze({ lease, attachment, target, protectedHostPIDs })
}

function responseRecord(value: unknown): Record<string, unknown> {
  return record(value, 'Native-window response')
}

function assertAttachmentEcho(
  response: Record<string, unknown>,
  expected: NativeWindowCoordinatorAccessParams
): void {
  let echoed: NativeWindowCoordinatorAccessParams
  try {
    echoed = canonicalAttachment(response)
  } catch {
    factoryError('native-protocol', 'Native-window response did not echo its scoped attachment.')
  }
  if (!sameAttachment(expected, echoed)) {
    factoryError('native-protocol', 'Native-window response belongs to another attachment scope.')
  }
}

function assertOptionalLeaseEcho(
  response: Record<string, unknown>,
  expected: CanvasWindowLeaseIdentity
): void {
  if (!Object.prototype.hasOwnProperty.call(response, 'lease')) return
  let echoed: CanvasWindowLeaseIdentity
  try {
    echoed = canonicalLease(response.lease, 'native-protocol')
  } catch {
    factoryError('native-protocol', 'Native-window response has an invalid lease echo.')
  }
  if (!sameLease(expected, echoed)) {
    factoryError('native-protocol', 'Native-window response has a mismatched lease echo.')
  }
}

function expectedViewport(target: CanonicalTarget): CanvasViewport {
  return {
    width: Math.max(1, Math.round(target.expectedBounds.width)),
    height: Math.max(1, Math.round(target.expectedBounds.height))
  }
}

function relativeBBox(frame: Bounds, target: CanonicalTarget): [number, number, number, number] {
  const x = frame.x - target.expectedBounds.x
  const y = frame.y - target.expectedBounds.y
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    factoryError('native-protocol', 'Native AX bounds are invalid.')
  }
  return [x, y, frame.width, frame.height]
}

function directBBox(value: unknown): [number, number, number, number] {
  if (!Array.isArray(value) || value.length !== 4) {
    factoryError('native-protocol', 'Native AX bounds are invalid.')
  }
  const parts = value.map((part, index) => finiteNumber(part, `native AX bbox[${index}]`))
  if (
    parts[2] === undefined ||
    parts[3] === undefined ||
    parts[2] < 0 ||
    parts[3] < 0 ||
    parts.some((part) => Math.abs(part) > MAX_GEOMETRY_MAGNITUDE)
  ) {
    factoryError('native-protocol', 'Native AX bounds are invalid.')
  }
  return [parts[0] as number, parts[1] as number, parts[2], parts[3]]
}

function optionalRawText(value: unknown, label: string): string | null {
  return value === undefined || value === null || value === ''
    ? null
    : canonicalString(value, label, 'native-protocol')
}

function parseRawNode(value: unknown): ParsedRawNode {
  const input = record(value, 'Native AX node')
  if (!Array.isArray(input.childRefs) || input.childRefs.length > MAX_AX_CHILDREN) {
    factoryError('native-protocol', 'Native AX child references are invalid.')
  }
  const childRefs = input.childRefs.map((child, index) =>
    canonicalString(child, `native AX childRefs[${index}]`, 'native-protocol', MAX_REF_LENGTH)
  )
  if (new Set(childRefs).size !== childRefs.length) {
    factoryError('native-protocol', 'Native AX child references are duplicated.')
  }
  if (typeof input.secure !== 'boolean') {
    factoryError('native-protocol', 'Native AX secure-field metadata is invalid.')
  }
  const parentRef =
    input.parentRef === undefined || input.parentRef === null
      ? null
      : canonicalString(input.parentRef, 'native AX parentRef', 'native-protocol', MAX_REF_LENGTH)
  return Object.freeze({
    ref: canonicalString(input.ref, 'native AX ref', 'native-protocol', MAX_REF_LENGTH),
    parentRef,
    childRefs: Object.freeze(childRefs),
    role: canonicalString(input.role, 'native AX role', 'native-protocol'),
    subrole: optionalRawText(input.subrole, 'native AX subrole'),
    title: optionalRawText(input.title, 'native AX title'),
    label: optionalRawText(input.label, 'native AX label'),
    identifier: optionalRawText(input.identifier, 'native AX identifier'),
    frame:
      input.frame === undefined || input.frame === null
        ? null
        : canonicalBounds(input.frame, 'native AX frame'),
    secure: input.secure
  })
}

function nodeDisplayName(node: ParsedRawNode): string | undefined {
  return node.label ?? node.title ?? node.identifier ?? undefined
}

function assertRawTarget(value: unknown, expected: CanonicalTarget): void {
  const target = record(value, 'Native AX target')
  if (
    positiveInteger(target.pid, 'native AX target.pid') !== expected.pid ||
    positiveInteger(target.windowID, 'native AX target.windowID') !== expected.windowID ||
    canonicalString(target.bundleID, 'native AX target.bundleID', 'native-protocol') !==
      expected.bundleID ||
    positiveInteger(target.processLaunchTimeMicros, 'native AX target.processLaunchTimeMicros') !==
      expected.processLaunchTimeMicros
  ) {
    factoryError('native-protocol', 'Native AX target does not match the exact lease.')
  }
  const bounds = canonicalBounds(target.expectedBounds, 'native AX target.expectedBounds')
  if (
    bounds.x !== expected.expectedBounds.x ||
    bounds.y !== expected.expectedBounds.y ||
    bounds.width !== expected.expectedBounds.width ||
    bounds.height !== expected.expectedBounds.height
  ) {
    factoryError('native-protocol', 'Native AX bounds do not match the exact lease.')
  }
}

function mapRawSnapshot(
  value: unknown,
  target: CanonicalTarget,
  fallbackTitle: string,
  expectedObservationId: string,
  expectedInputEpoch: number
): CanvasElementTree {
  const snapshot = record(value, 'Native AX snapshot')
  assertRawTarget(snapshot.target, target)
  if (
    canonicalString(
      snapshot.snapshotID,
      'native AX snapshotID',
      'native-protocol',
      MAX_REF_LENGTH
    ) !== expectedObservationId ||
    nonNegativeInteger(snapshot.inputEpoch, 'native AX snapshot inputEpoch') !== expectedInputEpoch
  ) {
    factoryError('native-protocol', 'Native AX snapshot does not match the observation echo.')
  }
  const rootRef = canonicalString(
    snapshot.rootRef,
    'native AX rootRef',
    'native-protocol',
    MAX_REF_LENGTH
  )
  if (
    !Array.isArray(snapshot.nodes) ||
    snapshot.nodes.length === 0 ||
    snapshot.nodes.length > MAX_AX_NODES
  ) {
    factoryError('native-protocol', 'Native AX nodes are invalid.')
  }
  if (typeof snapshot.truncated !== 'boolean') {
    factoryError('native-protocol', 'Native AX truncation metadata is invalid.')
  }
  const parsedNodes = snapshot.nodes.map(parseRawNode)
  const nodesByRef = new Map<string, ParsedRawNode>()
  for (const node of parsedNodes) {
    if (nodesByRef.has(node.ref)) {
      factoryError('native-protocol', 'Native AX node references are duplicated.')
    }
    nodesByRef.set(node.ref, node)
  }
  if (!nodesByRef.has(rootRef)) {
    factoryError('native-protocol', 'Native AX root reference is absent.')
  }

  const visiting = new Set<string>()
  const visited = new Set<string>()
  const build = (ref: string, parentRef: string | null, depth: number): CanvasElementNode => {
    if (depth > MAX_AX_DEPTH || visiting.has(ref) || visited.has(ref)) {
      factoryError('native-protocol', 'Native AX graph is cyclic or shared.')
    }
    const node = nodesByRef.get(ref)
    if (!node || node.parentRef !== parentRef) {
      factoryError('native-protocol', 'Native AX graph is invalid.')
    }
    visiting.add(ref)
    const children = node.childRefs.map((childRef) => build(childRef, ref, depth + 1))
    visiting.delete(ref)
    visited.add(ref)
    const name = nodeDisplayName(node)
    return {
      ref: node.ref,
      role: node.role,
      tag: node.subrole ?? node.role,
      ...(name ? { name, text: name } : {}),
      // AXValue is deliberately not returned. In particular it cannot leak a
      // credential if a daemon/backend ever mislabels a secure control.
      secure: node.secure,
      ...(node.frame ? { bbox: relativeBBox(node.frame, target) } : {}),
      ...(children.length > 0 ? { children } : {})
    }
  }
  const root = build(rootRef, null, 0)
  if (visited.size !== nodesByRef.size) {
    factoryError('native-protocol', 'Native AX graph contains unreachable nodes.')
  }
  const rootNode = nodesByRef.get(rootRef)
  const title = rootNode ? (nodeDisplayName(rootNode) ?? fallbackTitle) : fallbackTitle
  return {
    url: 'window://native',
    title,
    viewport: expectedViewport(target),
    capturedAt: canonicalTimestamp(snapshot.createdAt, 'native AX createdAt'),
    root,
    nodeCount: nodesByRef.size,
    truncated: snapshot.truncated
  }
}

function mapRenderedTree(
  value: unknown,
  target: CanonicalTarget,
  fallbackTitle: string,
  expectedInputEpoch: number
): CanvasElementTree {
  const input = record(value, 'Native AX tree')
  if (typeof input.truncated !== 'boolean') {
    factoryError('native-protocol', 'Native AX truncation metadata is invalid.')
  }
  const nodeCount = positiveInteger(input.nodeCount, 'native AX nodeCount')
  if (nodeCount > MAX_AX_NODES) {
    factoryError('native-protocol', 'Native AX node count exceeds the limit.')
  }
  const viewport = record(input.viewport, 'native AX viewport')
  const expected = expectedViewport(target)
  if (
    positiveInteger(viewport.width, 'native AX viewport.width') !== expected.width ||
    positiveInteger(viewport.height, 'native AX viewport.height') !== expected.height
  ) {
    factoryError('native-protocol', 'Native AX viewport does not match the selected window.')
  }
  if (
    input.inputEpoch !== undefined &&
    nonNegativeInteger(input.inputEpoch, 'native AX tree inputEpoch') !== expectedInputEpoch
  ) {
    factoryError('native-protocol', 'Native AX tree has a mismatched input epoch.')
  }

  const seenRefs = new Set<string>()
  const visitedObjects = new Set<object>()
  const visitingObjects = new Set<object>()
  let actualCount = 0
  const build = (value: unknown, depth: number): CanvasElementNode => {
    const inputNode = record(value, 'Native AX tree node')
    if (depth > MAX_AX_DEPTH || visitingObjects.has(inputNode) || visitedObjects.has(inputNode)) {
      factoryError('native-protocol', 'Native AX graph is cyclic or shared.')
    }
    const ref = canonicalString(inputNode.ref, 'native AX ref', 'native-protocol', MAX_REF_LENGTH)
    if (seenRefs.has(ref)) {
      factoryError('native-protocol', 'Native AX node references are duplicated.')
    }
    visitingObjects.add(inputNode)
    seenRefs.add(ref)
    actualCount += 1
    if (actualCount > MAX_AX_NODES) {
      factoryError('native-protocol', 'Native AX node count exceeds the limit.')
    }
    const rawChildren = inputNode.children
    if (
      rawChildren !== undefined &&
      (!Array.isArray(rawChildren) || rawChildren.length > MAX_AX_CHILDREN)
    ) {
      factoryError('native-protocol', 'Native AX children are invalid.')
    }
    const children = Array.isArray(rawChildren)
      ? rawChildren.map((child) => build(child, depth + 1))
      : []
    visitingObjects.delete(inputNode)
    visitedObjects.add(inputNode)
    const name = optionalText(inputNode.name, 'native AX name')
    const text = optionalText(inputNode.text, 'native AX text')
    if (inputNode.secure !== undefined && typeof inputNode.secure !== 'boolean') {
      factoryError('native-protocol', 'Native AX secure-field metadata is invalid.')
    }
    return {
      ref,
      role: canonicalString(inputNode.role, 'native AX role', 'native-protocol'),
      tag: canonicalString(inputNode.tag, 'native AX tag', 'native-protocol'),
      ...(name ? { name } : {}),
      ...(text ? { text } : {}),
      // Ignore any daemon-provided value field. Canvas action selection does
      // not require it, and omitting it makes secure-value leakage impossible.
      ...(inputNode.secure !== undefined ? { secure: inputNode.secure } : {}),
      ...(inputNode.bbox !== undefined ? { bbox: directBBox(inputNode.bbox) } : {}),
      ...(children.length > 0 ? { children } : {})
    }
  }
  const root = build(input.root, 0)
  if (actualCount !== nodeCount) {
    factoryError('native-protocol', 'Native AX node count does not match the graph.')
  }
  return {
    url: 'window://native',
    title: optionalText(input.title, 'native AX title') ?? fallbackTitle,
    viewport: expected,
    capturedAt: canonicalTimestamp(input.capturedAt, 'native AX capturedAt'),
    root,
    nodeCount,
    truncated: input.truncated
  }
}

function parseObservation(
  response: Record<string, unknown>,
  target: CanonicalTarget,
  fallbackTitle: string
): Omit<CanvasWindowObserveResult, 'lease'> {
  const observationId = canonicalString(
    response.observationId,
    'nativeWindow.observe.observationId',
    'native-protocol',
    MAX_REF_LENGTH
  )
  const inputEpoch = nonNegativeInteger(response.inputEpoch, 'nativeWindow.observe.inputEpoch')
  const tree =
    response.snapshot !== undefined
      ? mapRawSnapshot(response.snapshot, target, fallbackTitle, observationId, inputEpoch)
      : mapRenderedTree(response.tree, target, fallbackTitle, inputEpoch)
  if (tree.inputEpoch !== undefined && tree.inputEpoch !== inputEpoch) {
    factoryError('native-protocol', 'Native AX tree has a mismatched input epoch.')
  }
  const rawVerification = response.actionVerification
  let actionVerification: CanvasWindowObserveResult['actionVerification']
  if (rawVerification !== undefined && rawVerification !== null) {
    const verification = record(rawVerification, 'native action verification')
    const verified = verification.verified
    if (verified !== 'changed' && verified !== 'unchanged' && verified !== 'unknown') {
      factoryError('native-protocol', 'Native action verification is invalid.')
    }
    actionVerification = {
      actionId: canonicalString(
        verification.actionId,
        'native action verification id',
        'native-protocol',
        MAX_REF_LENGTH
      ),
      verified
    }
  }
  return {
    observationId,
    inputEpoch,
    tree: { ...tree, inputEpoch },
    ...(actionVerification ? { actionVerification } : {})
  }
}

function parseInspection(
  response: Record<string, unknown>,
  observationId: string,
  inputEpoch: number,
  ref: string
): Omit<CanvasWindowInspectResult, 'lease'> {
  if (response.observationId !== observationId) {
    factoryError('native-protocol', 'Native inspection belongs to another observation.')
  }
  if (response.inputEpoch !== undefined && response.inputEpoch !== inputEpoch) {
    factoryError('native-protocol', 'Native inspection has a mismatched input epoch.')
  }
  const detail = record(response.detail, 'native inspection detail')
  if (typeof detail.found !== 'boolean') {
    factoryError('native-protocol', 'Native inspection detail is invalid.')
  }
  if (detail.ref !== undefined && detail.ref !== ref) {
    factoryError('native-protocol', 'Native inspection belongs to another AX ref.')
  }
  const parsed: CanvasElementDetail = {
    found: detail.found,
    ref,
    ...(optionalText(detail.tag, 'native inspection tag')
      ? { tag: optionalText(detail.tag, 'native inspection tag') }
      : {}),
    ...(optionalText(detail.role, 'native inspection role')
      ? { role: optionalText(detail.role, 'native inspection role') }
      : {}),
    ...(optionalText(detail.text, 'native inspection text')
      ? { text: optionalText(detail.text, 'native inspection text') }
      : {}),
    ...(detail.bbox !== undefined ? { bbox: directBBox(detail.bbox) } : {})
  }
  return { observationId, detail: parsed }
}

function parseAction(
  response: Record<string, unknown>,
  observationId: string,
  inputEpoch: number
): Omit<CanvasWindowActResult, 'lease'> {
  if (response.observationId !== observationId) {
    factoryError('native-protocol', 'Native action belongs to another observation.')
  }
  if (response.inputEpoch !== undefined && response.inputEpoch !== inputEpoch) {
    factoryError('native-protocol', 'Native action has a mismatched input epoch.')
  }
  const result = record(response.result, 'native action result')
  if (
    typeof result.ok !== 'boolean' ||
    typeof result.found !== 'boolean' ||
    typeof result.executed !== 'boolean'
  ) {
    factoryError('native-protocol', 'Native action result is invalid.')
  }
  const refusalReason = result.refusalReason === null ? undefined : result.refusalReason
  if (
    refusalReason !== undefined &&
    (typeof refusalReason !== 'string' || !NATIVE_REFUSAL_REASONS.has(refusalReason))
  ) {
    factoryError('native-protocol', 'Native action refusal is invalid.')
  }
  if (result.executed && refusalReason !== undefined) {
    factoryError('native-protocol', 'Native action cannot both execute and refuse.')
  }
  const typedRefusalReason =
    typeof refusalReason === 'string'
      ? (refusalReason as NonNullable<CanvasWindowActResult['result']['refusalReason']>)
      : undefined
  return {
    observationId,
    actionId: canonicalString(
      response.actionId,
      'nativeWindow.action.actionId',
      'native-protocol',
      MAX_REF_LENGTH
    ),
    result: {
      ok: result.ok === true && result.executed === true,
      found: result.found,
      executed: result.executed,
      ...(typedRefusalReason ? { refusalReason: typedRefusalReason } : {})
      // Deliberately omit daemon result.message. It can be derived from AX text
      // or a submitted value and is not needed for CanvasWindowDriver's policy.
    }
  }
}

function parseCapture(response: Record<string, unknown>, target: CanonicalTarget): CanvasFrame {
  const safety = record(response.captureSafety, 'native capture safety receipt')
  if (safety.safe !== true) {
    factoryError('native-protocol', 'Native capture did not pass secure-field preflight.')
  }
  assertRawTarget(safety.target, target)
  const frame = record(response.frame, 'native capture frame')
  if (frame.mimeType !== 'image/png' || typeof frame.data !== 'string') {
    factoryError('native-protocol', 'Native capture is not a PNG frame.')
  }
  if (
    frame.data.length === 0 ||
    frame.data.length > MAX_PNG_BYTES * 2 ||
    frame.data.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(frame.data)
  ) {
    factoryError('native-protocol', 'Native capture PNG encoding is invalid.')
  }
  const png = Buffer.from(frame.data, 'base64')
  if (
    png.byteLength === 0 ||
    png.byteLength > MAX_PNG_BYTES ||
    png.toString('base64') !== frame.data ||
    png.byteLength < 24 ||
    png.toString('hex', 0, 8) !== PNG_SIGNATURE_HEX ||
    png.toString('ascii', 12, 16) !== 'IHDR'
  ) {
    factoryError('native-protocol', 'Native capture PNG bytes are invalid.')
  }
  const width = positiveInteger(frame.width, 'native capture width')
  const height = positiveInteger(frame.height, 'native capture height')
  const byteLength = positiveInteger(frame.byteLength, 'native capture byteLength')
  if (
    byteLength !== png.byteLength ||
    png.readUInt32BE(16) !== width ||
    png.readUInt32BE(20) !== height ||
    typeof frame.hash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(frame.hash) ||
    createHash('sha256').update(png).digest('hex') !== frame.hash
  ) {
    factoryError('native-protocol', 'Native capture integrity verification failed.')
  }
  const secretsRedacted =
    frame.secretsRedacted === undefined
      ? undefined
      : nonNegativeInteger(frame.secretsRedacted, 'native capture secretsRedacted')
  return {
    mimeType: 'image/png',
    data: frame.data,
    width,
    height,
    byteLength,
    hash: frame.hash,
    capturedAt: canonicalTimestamp(frame.capturedAt, 'native capture capturedAt'),
    ...(secretsRedacted === undefined ? {} : { secretsRedacted })
  }
}

class BoundCanvasWindowNativeBridge implements CanvasWindowNativeBridge {
  private title = 'Managed native window'
  private releaseConfirmed = false

  constructor(
    private readonly coordinator: CanvasWindowCoordinatorPort,
    private readonly daemon: CanvasWindowDriverFactoryDaemon,
    private readonly owner: CanonicalOwner,
    private readonly lease: CanvasWindowLeaseIdentity,
    private readonly releaseAccess: NativeWindowCoordinatorAccessParams,
    private readonly gate: SerializedNativeWindowRequests,
    /** Factory-owned, synchronous one-use receipt claim at the RPC boundary. */
    private readonly claimClickReceipt: (request: CanvasWindowClickRequest) => void
  ) {}

  async adopt(request: { lease: CanvasWindowLeaseIdentity }): Promise<CanvasWindowAdoptResult> {
    return this.gate.run(async () => {
      const access = this.resolveRead(request.lease, 'observe')
      const response = await this.requestDaemon('nativeWindow.adopt', {
        ...attachmentParams(access.attachment),
        protectedHostPIDs: access.protectedHostPIDs
      })
      this.assertResponseBinding(response, access)
      assertRawTarget(response.target, access.target)
      const pid = positiveInteger(response.pid, 'nativeWindow.adopt.pid')
      if (pid !== this.lease.pid) {
        factoryError('native-protocol', 'Native adoption resolved a different process.')
      }
      const title =
        optionalText(response.title, 'nativeWindow.adopt.title') ?? 'Managed native window'
      const viewport = record(response.viewport, 'nativeWindow.adopt.viewport')
      const expected = expectedViewport(access.target)
      if (
        positiveInteger(viewport.width, 'nativeWindow.adopt.viewport.width') !== expected.width ||
        positiveInteger(viewport.height, 'nativeWindow.adopt.viewport.height') !== expected.height
      ) {
        factoryError(
          'native-protocol',
          'Native adoption viewport does not match the selected window.'
        )
      }
      const after = this.resolveRead(request.lease, 'observe')
      this.title = title
      return { lease: after.lease, pid, title, viewport: expected }
    })
  }

  async observe(request: { lease: CanvasWindowLeaseIdentity }): Promise<CanvasWindowObserveResult> {
    return this.gate.run(async () => {
      const access = this.resolveRead(request.lease, 'observe')
      const response = await this.requestDaemon(
        'nativeWindow.observe',
        attachmentParams(access.attachment)
      )
      this.assertResponseBinding(response, access)
      const parsed = parseObservation(response, access.target, this.title)
      const after = this.resolveRead(request.lease, 'observe')
      return { lease: after.lease, ...parsed }
    })
  }

  async capture(request: { lease: CanvasWindowLeaseIdentity }): Promise<CanvasWindowCaptureResult> {
    return this.gate.run(async () => {
      const access = this.resolveRead(request.lease, 'observe')
      // One daemon RPC intentionally combines AX secure-field preflight and
      // ScreenCaptureKit capture. There is no separate capture or retry path.
      const response = await this.requestDaemon(
        'nativeWindow.capture',
        attachmentParams(access.attachment)
      )
      this.assertResponseBinding(response, access)
      const frame = parseCapture(response, access.target)
      const after = this.resolveRead(request.lease, 'observe')
      return { lease: after.lease, frame }
    })
  }

  async inspect(request: {
    lease: CanvasWindowLeaseIdentity
    observationId: string
    inputEpoch: number
    ref: string
  }): Promise<CanvasWindowInspectResult> {
    return this.gate.run(async () => {
      const access = this.resolveRead(request.lease, 'inspect')
      const response = await this.requestDaemon('nativeWindow.inspect', {
        ...attachmentParams(access.attachment),
        observationId: request.observationId,
        inputEpoch: request.inputEpoch,
        ref: request.ref
      })
      this.assertResponseBinding(response, access)
      const parsed = parseInspection(
        response,
        request.observationId,
        request.inputEpoch,
        request.ref
      )
      const after = this.resolveRead(request.lease, 'inspect')
      return { lease: after.lease, ...parsed }
    })
  }

  async click(request: CanvasWindowClickRequest): Promise<CanvasWindowActResult> {
    return this.performAction('click', request)
  }

  async fill(request: {
    lease: CanvasWindowLeaseIdentity
    observationId: string
    inputEpoch: number
    ref: string
    value: string
  }): Promise<CanvasWindowActResult> {
    return this.performAction('fill', request)
  }

  async release(request: { lease: CanvasWindowLeaseIdentity }): Promise<CanvasWindowReleaseResult> {
    return this.gate.run(async () => {
      this.assertBoundLease(request.lease)
      if (this.releaseConfirmed) return { lease: this.lease, released: true }
      try {
        const response = await this.requestDaemon(
          'nativeWindow.release',
          attachmentParams(this.releaseAccess)
        )
        // Release is allowed after revocation, but only this exact binding may
        // request it. A malformed reply is treated as an unsuccessful cleanup.
        assertAttachmentEcho(response, this.releaseAccess)
        assertOptionalLeaseEcho(response, this.lease)
        if (response.released !== true) return { lease: this.lease, released: false }
        this.releaseConfirmed = true
        return { lease: this.lease, released: true }
      } catch {
        return { lease: this.lease, released: false }
      }
    })
  }

  private async performAction(
    verb: NativeWindowLeaseControlVerb,
    request:
      | CanvasWindowClickRequest
      | {
          lease: CanvasWindowLeaseIdentity
          observationId: string
          inputEpoch: number
          ref: string
          value: string
        }
  ): Promise<CanvasWindowActResult> {
    return this.gate.run(async () => {
      if (verb === 'click') {
        // This lookup deletes the receipt before every validation/audit check.
        // It is synchronous and immediately precedes the action-budget consume
        // and daemon enqueue, so a stale/replayed/mismatched receipt cannot
        // cross either consequential boundary.
        this.claimClickReceipt(request as CanvasWindowClickRequest)
      }
      this.assertBoundLease(request.lease)
      // This is intentionally inside the serial queue and immediately precedes
      // dispatch. A failure after this point is indeterminate and is never retried.
      const access = this.consumeAction(request.lease, verb)
      const response = await this.requestDaemon(`nativeWindow.${verb}`, {
        ...attachmentParams(access.attachment),
        observationId: request.observationId,
        inputEpoch: request.inputEpoch,
        ref: request.ref,
        // Receipt material is never sent to the daemon; it is factory-local
        // authorization state consumed above.
        ...(verb === 'fill' ? { value: (request as { readonly value: string }).value } : {})
      })
      this.assertResponseBinding(response, access)
      const parsed = parseAction(response, request.observationId, request.inputEpoch)
      const after = this.resolveRead(request.lease, 'observe')
      return { lease: after.lease, ...parsed }
    })
  }

  private resolveRead(
    requestLease: CanvasWindowLeaseIdentity,
    verb: NativeWindowLeaseReadVerb
  ): CanonicalAccess {
    this.assertBoundLease(requestLease)
    const access = canonicalAccess(
      this.coordinator.resolveLeaseForCanvas(coordinatorOwner(this.owner), verb)
    )
    requireLeaseOwner(access.lease, this.owner)
    requireExactLease(this.lease, access.lease)
    return access
  }

  private consumeAction(
    requestLease: CanvasWindowLeaseIdentity,
    verb: NativeWindowLeaseControlVerb
  ): CanonicalAccess {
    this.assertBoundLease(requestLease)
    const access = canonicalAccess(
      this.coordinator.consumeCanvasActionStep(coordinatorOwner(this.owner), verb)
    )
    requireLeaseOwner(access.lease, this.owner)
    requireExactLease(this.lease, access.lease)
    return access
  }

  private assertBoundLease(value: CanvasWindowLeaseIdentity): void {
    let candidate: CanvasWindowLeaseIdentity
    try {
      candidate = canonicalLease(value, 'lease-stale')
    } catch {
      factoryError('lease-stale', 'Native-window authority is stale or mismatched.')
    }
    requireExactLease(this.lease, candidate)
  }

  private assertResponseBinding(response: Record<string, unknown>, access: CanonicalAccess): void {
    assertAttachmentEcho(response, access.attachment)
    assertOptionalLeaseEcho(response, this.lease)
  }

  private async requestDaemon(method: string, params: unknown): Promise<Record<string, unknown>> {
    try {
      return responseRecord(await this.daemon.request(method, params))
    } catch {
      // Never preserve the daemon error text: it can include AX text or a fill value.
      factoryError('native-rpc-failed', 'Native-window RPC failed without a retry.')
    }
  }
}

/**
 * One-time binding registry and driver factory.  Integration should call:
 *
 *   const target = factory.issueOpenTarget(exactRunOwner)
 *   const driver = factory.takeDriver(exactRunOwner, target)
 *
 * The second call consumes the token before it revalidates current authority,
 * so a stale target never becomes reusable after a transient failure.
 */
export class CanvasWindowDriverFactory {
  private readonly coordinator: CanvasWindowCoordinatorPort
  private readonly daemon: CanvasWindowDriverFactoryDaemon
  private readonly now: () => number
  private readonly createTargetId: () => string
  private readonly targetTtlMs: number
  private readonly clickConfirmation?: CanvasWindowClickConfirmation
  private readonly clickAuditClaim?: CanvasWindowClickAuditClaim
  private readonly createClickReceipt: () => string
  private readonly clickReceiptTtlMs: number
  private readonly targets = new Map<string, PendingTargetBinding>()
  private readonly clickReceipts = new Map<string, PendingClickReceipt>()
  private readonly gate = new SerializedNativeWindowRequests()

  constructor(options: CanvasWindowDriverFactoryOptions) {
    if (!options || typeof options !== 'object') {
      factoryError('invalid-target', 'Native-window driver factory options are required.')
    }
    if (!options.coordinator || typeof options.coordinator.resolveLeaseForCanvas !== 'function') {
      factoryError('invalid-target', 'A native-window coordinator is required.')
    }
    if (!options.daemon || typeof options.daemon.request !== 'function') {
      factoryError('invalid-target', 'A native-window daemon is required.')
    }
    this.coordinator = options.coordinator
    this.daemon = options.daemon
    this.now = options.now ?? Date.now
    this.createTargetId = options.createTargetId ?? randomUUID
    this.clickConfirmation = options.clickConfirmation
    this.clickAuditClaim = options.clickAuditClaim
    this.createClickReceipt = options.createClickReceipt ?? randomUUID
    const ttl = options.targetTtlMs ?? DEFAULT_TARGET_TTL_MS
    if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > MAX_TARGET_TTL_MS) {
      factoryError('invalid-target', 'Native-window target TTL is invalid.')
    }
    this.targetTtlMs = ttl
    const clickReceiptTtl = options.clickReceiptTtlMs ?? DEFAULT_CLICK_RECEIPT_TTL_MS
    if (
      !Number.isSafeInteger(clickReceiptTtl) ||
      clickReceiptTtl < 1 ||
      clickReceiptTtl > MAX_CLICK_RECEIPT_TTL_MS
    ) {
      factoryError('invalid-target', 'Native click receipt TTL is invalid.')
    }
    this.clickReceiptTtlMs = clickReceiptTtl
  }

  /**
   * The driver can ask for an opaque receipt, but cannot mint or inspect one.
   * We require both human confirmation and a synchronous audit sink up front so
   * an incomplete integration is indistinguishable from a declined request.
   */
  private createClickAuthorization(
    owner: CanonicalOwner,
    lease: CanvasWindowLeaseIdentity
  ): CanvasWindowClickAuthorization {
    return Object.freeze({
      authorize: (request) => this.authorizeClick(owner, lease, request)
    })
  }

  private async authorizeClick(
    owner: CanonicalOwner,
    lease: CanvasWindowLeaseIdentity,
    request: CanvasWindowClickAuthorizationRequest
  ): Promise<{ readonly receipt: string } | null> {
    const confirmation = this.clickConfirmation
    if (!confirmation || !this.clickAuditClaim) return null

    let canonicalRequest: CanvasWindowClickAuthorizationRequest
    try {
      canonicalRequest = canonicalClickAuthorizationRequest(request, owner, lease)
    } catch {
      return null
    }

    let confirmed: boolean
    try {
      confirmed = (await confirmation.confirm(canonicalRequest)) === true
    } catch {
      return null
    }
    if (!confirmed) return null

    // A human can take time to decide. Do not mint a receipt for the lease that
    // was live before the modal if the run, consent, process, or generation was
    // replaced/expired while it was open. This check is intentionally sync and
    // happens immediately before issuance; claim still rechecks exact binding
    // again at the separate action-budget/RPC boundary.
    try {
      const current = this.coordinator.currentCanvasLeaseIdentity(coordinatorOwner(owner))
      if (!current || !sameLease(lease, canonicalLease(current, 'lease-stale'))) return null
    } catch {
      return null
    }

    try {
      const issuedAt = this.clickReceiptNow()
      this.purgeExpiredClickReceipts(issuedAt)
      const receipt = canonicalString(
        this.createClickReceipt(),
        'native click receipt',
        'native-rpc-failed',
        MAX_CLICK_RECEIPT_LENGTH
      )
      if (this.clickReceipts.has(receipt)) return null
      const expiresAt = issuedAt + this.clickReceiptTtlMs
      if (!Number.isSafeInteger(expiresAt) || expiresAt <= issuedAt) return null
      this.clickReceipts.set(
        receipt,
        Object.freeze({
          receipt,
          owner,
          lease,
          ref: canonicalRequest.ref,
          observationId: canonicalRequest.observationId,
          inputEpoch: canonicalRequest.inputEpoch,
          previewDigest: clickPreviewDigest(canonicalRequest.semanticSummary),
          issuedAt,
          expiresAt
        })
      )
      return Object.freeze({ receipt })
    } catch {
      // Do not surface token generation, clock, or storage implementation
      // errors to a model as a cue to bypass confirmation.
      return null
    }
  }

  /**
   * Claim a receipt in the same serial turn as native dispatch. Receipt deletion
   * intentionally happens before every exact-binding/audit check: a malformed,
   * stale, or failed-audit use is still a use and cannot be replayed.
   */
  private claimClickReceipt(
    owner: CanonicalOwner,
    lease: CanvasWindowLeaseIdentity,
    request: CanvasWindowClickRequest
  ): void {
    let receipt: string
    try {
      receipt = canonicalString(
        request?.clickReceipt,
        'native click receipt',
        'native-rpc-failed',
        MAX_CLICK_RECEIPT_LENGTH
      )
    } catch {
      factoryError(
        'native-rpc-failed',
        'Native click confirmation is missing, stale, expired, or already used.'
      )
    }

    const pending = this.clickReceipts.get(receipt)
    if (!pending) {
      factoryError(
        'native-rpc-failed',
        'Native click confirmation is missing, stale, expired, or already used.'
      )
    }
    this.clickReceipts.delete(receipt)

    let requestLease: CanvasWindowLeaseIdentity
    let ref: string
    let observationId: string
    let inputEpoch: number
    let now: number
    try {
      requestLease = canonicalLease(request.lease, 'native-rpc-failed')
      ref = canonicalString(request.ref, 'native click ref', 'native-rpc-failed', MAX_REF_LENGTH)
      observationId = canonicalString(
        request.observationId,
        'native click observation id',
        'native-rpc-failed',
        MAX_REF_LENGTH
      )
      inputEpoch = nonNegativeInteger(request.inputEpoch, 'native click input epoch')
      now = this.clickReceiptNow()
    } catch {
      factoryError(
        'native-rpc-failed',
        'Native click confirmation is missing, stale, expired, or already used.'
      )
    }

    if (
      pending.expiresAt <= now ||
      !sameOwner(pending.owner, owner) ||
      !sameLease(pending.lease, lease) ||
      !sameLease(pending.lease, requestLease) ||
      pending.ref !== ref ||
      pending.observationId !== observationId ||
      pending.inputEpoch !== inputEpoch
    ) {
      factoryError(
        'native-rpc-failed',
        'Native click confirmation is missing, stale, expired, or already used.'
      )
    }

    const auditClaim = this.clickAuditClaim
    if (!auditClaim) {
      factoryError('native-rpc-failed', 'Native click intent audit could not be claimed.')
    }
    const auditRequest: CanvasWindowClickAuditClaimRequest = Object.freeze({
      scope: clickAuthorizationScope(owner, lease),
      ref: pending.ref,
      expectedObservationId: pending.observationId,
      inputEpoch: pending.inputEpoch,
      previewDigest: pending.previewDigest
    })
    try {
      const auditResult: unknown = auditClaim.claim(auditRequest)
      if (isThenable(auditResult)) {
        factoryError('native-rpc-failed', 'Native click intent audit must complete synchronously.')
      }
    } catch {
      factoryError('native-rpc-failed', 'Native click intent audit could not be claimed.')
    }
  }

  private clickReceiptNow(): number {
    const now = this.now()
    if (!Number.isSafeInteger(now)) {
      factoryError('native-rpc-failed', 'Native click receipt clock is invalid.')
    }
    return now
  }

  private purgeExpiredClickReceipts(now = this.clickReceiptNow()): number {
    let removed = 0
    for (const [receipt, pending] of this.clickReceipts) {
      if (pending.expiresAt <= now) {
        this.clickReceipts.delete(receipt)
        removed += 1
      }
    }
    return removed
  }

  /** Mint an opaque open target only after exact control lease resolution. */
  issueOpenTarget(ownerInput: NativeWindowCoordinatorCanvasOwner): CanvasWindowOpenTarget {
    const owner = canonicalOwner(ownerInput)
    this.purgeExpiredTargets()
    const access = canonicalAccess(
      this.coordinator.resolveLeaseForCanvas(coordinatorOwner(owner), 'observe')
    )
    requireLeaseOwner(access.lease, owner)
    const id = canonicalString(
      this.createTargetId(),
      'native-window target id',
      'invalid-target',
      256
    )
    if (this.targets.has(id)) {
      factoryError('invalid-target', 'Native-window target id must be fresh.')
    }
    const issuedAt = this.now()
    if (!Number.isSafeInteger(issuedAt)) {
      factoryError('invalid-target', 'Native-window clock is invalid.')
    }
    this.targets.set(
      id,
      Object.freeze({
        id,
        owner,
        lease: access.lease,
        attachment: access.attachment,
        issuedAt,
        expiresAt: issuedAt + this.targetTtlMs
      })
    )
    // CanvasWindowOpenTarget intentionally exposes no handle, PID, receipt,
    // scope, consent epoch, or native lease identity.
    return Object.freeze({ leaseId: id })
  }

  /** Consume an opaque target and construct a freshly revalidated driver. */
  takeDriver(
    ownerInput: NativeWindowCoordinatorCanvasOwner,
    targetInput: CanvasWindowOpenTarget
  ): CanvasWindowDriver {
    const owner = canonicalOwner(ownerInput)
    const target = record(targetInput, 'Native-window open target')
    const id = canonicalString(target.leaseId, 'native-window open target', 'invalid-target', 256)
    const binding = this.targets.get(id)
    if (!binding)
      factoryError('target-not-found', 'Native-window open target is absent or already used.')
    if (binding.expiresAt <= this.now()) {
      this.targets.delete(id)
      factoryError('target-expired', 'Native-window open target expired before use.')
    }
    if (!sameOwner(binding.owner, owner)) {
      factoryError(
        'target-owner-mismatch',
        'Native-window open target belongs to another exact run owner.'
      )
    }

    // Delete before the current-lease lookup. A failed revalidation must not
    // leave a token replayable after launch/run/consent state has changed.
    this.targets.delete(id)
    const access = canonicalAccess(
      this.coordinator.resolveLeaseForCanvas(coordinatorOwner(binding.owner), 'observe')
    )
    requireLeaseOwner(access.lease, binding.owner)
    requireExactLease(binding.lease, access.lease, 'Native-window target became stale before use.')
    if (!sameAttachment(binding.attachment, access.attachment)) {
      factoryError('lease-stale', 'Native-window attachment changed before target use.')
    }

    const ownerForAuthority = binding.owner
    return new CanvasWindowDriver({
      lease: access.lease,
      authority: {
        current: () => {
          try {
            const current = this.coordinator.currentCanvasLeaseIdentity(
              coordinatorOwner(ownerForAuthority)
            )
            return current ? canonicalLease(current, 'lease-stale') : null
          } catch {
            return null
          }
        }
      },
      bridge: new BoundCanvasWindowNativeBridge(
        this.coordinator,
        this.daemon,
        binding.owner,
        access.lease,
        access.attachment,
        this.gate,
        (request) => this.claimClickReceipt(binding.owner, access.lease, request)
      ),
      // Always inject the factory-owned broker. With no confirmation/audit
      // integration it returns null, preserving the fail-closed driver policy.
      clickAuthorization: this.createClickAuthorization(binding.owner, access.lease)
    })
  }

  /**
   * CanvasService does not receive provider or launch-attempt authority. It
   * contributes only the canonical chat/run context already bound to the live
   * Canvas call; the private token binding supplies and revalidates the rest.
   */
  takeDriverForCanvasContext(
    contextInput: { chatId: string; runId: string },
    targetInput: CanvasWindowOpenTarget
  ): CanvasWindowDriver {
    const context = record(contextInput, 'Canvas window context')
    const chatId = canonicalString(context.chatId, 'chatId', 'invalid-owner')
    const runId = canonicalString(context.runId, 'runId', 'invalid-owner')
    const target = record(targetInput, 'Native-window open target')
    const id = canonicalString(target.leaseId, 'native-window open target', 'invalid-target', 256)
    const binding = this.targets.get(id)
    if (!binding) {
      factoryError('target-not-found', 'Native-window open target is absent or already used.')
    }
    if (binding.owner.chatId !== chatId || binding.owner.runId !== runId) {
      factoryError(
        'target-owner-mismatch',
        'Native-window open target belongs to another Canvas chat or run.'
      )
    }
    return this.takeDriver(binding.owner, { leaseId: id })
  }

  /** Useful for lifecycle tests and optional periodic housekeeping. */
  purgeExpiredTargets(): number {
    const now = this.now()
    let removed = 0
    for (const [id, binding] of this.targets) {
      if (binding.expiresAt <= now) {
        this.targets.delete(id)
        removed += 1
      }
    }
    return removed
  }

  /** Main-only diagnostics; does not reveal binding content. */
  pendingTargetCount(): number {
    this.purgeExpiredTargets()
    return this.targets.size
  }
}
