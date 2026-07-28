import { randomUUID } from 'node:crypto'

/**
 * Main-process state for the one Screen Watch window selected by the user.
 *
 * This is an observation-scoping boundary, not a native-control lease. It
 * intentionally accepts an arbitrary user-picked window with either exact or
 * best-effort identity metadata. AppDrive run ownership, LaunchAttempt
 * identity, control verbs, and step budgets belong in their separate authority
 * layer and must not be inferred from this attachment.
 */

export type ScopedAttachedWindowIdentityQuality = 'exact' | 'bestEffort'
export type ScopedAttachedWindowProcessIdentitySource = 'nsRunningApplication' | 'procBSDInfo'

export interface ScopedAttachedWindowProcessIdentity {
  readonly pid: number
  readonly launchTimeMicros: number
  readonly source: ScopedAttachedWindowProcessIdentitySource
}

export interface ScopedAttachedWindowBounds {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface ScopedAttachedWindowMeta {
  readonly windowID: number
  readonly title: string
  readonly bundleID: string
  readonly applicationName: string
  readonly pid: number
  readonly identityQuality: ScopedAttachedWindowIdentityQuality
  readonly processIdentity: ScopedAttachedWindowProcessIdentity
  /** Canonical opaque receipt echoed by the Swift bridge on every native call. */
  readonly processStartedAt: string
  /** Main-only picker geometry used to correlate the public AX window API. */
  readonly bounds: ScopedAttachedWindowBounds
}

export interface ScopedAttachedWindowStreaming {
  readonly fps: number
  readonly bufferSeconds: number
  readonly frameCount: number
  readonly startedAt: string
}

export interface ScopedAttachedWindowPick {
  readonly scopeID: string
  readonly chatID: string
  readonly consentEpoch: number
}

export interface ScopedAttachedWindowCompleteInput extends ScopedAttachedWindowPick {
  readonly handleID: string
  readonly generation: number
  readonly windowMeta: ScopedAttachedWindowMeta
}

export interface ScopedAttachedWindowSnapshot extends ScopedAttachedWindowCompleteInput {
  readonly attachedAt: string
  readonly streaming?: ScopedAttachedWindowStreaming
}

export interface ScopedAttachedWindowCompleteResult {
  readonly active: ScopedAttachedWindowSnapshot
  /** Main-only old attachment to detach after the atomic state replacement. */
  readonly replaced: ScopedAttachedWindowSnapshot | null
}

export interface ScopedAttachedWindowStreamingUpdate {
  readonly scopeID: string
  readonly generation: number
  readonly streaming: ScopedAttachedWindowStreaming | null
}

export interface ScopedAttachedWindowDetachInput {
  readonly chatID: string
  readonly scopeID: string
  readonly generation: number
}

export interface ScopedAttachedWindowRendererMeta {
  readonly title: string
  readonly bundleID: string
  readonly applicationName: string
  readonly identityQuality: ScopedAttachedWindowIdentityQuality
}

/**
 * Safe renderer projection. Main-only handle/scope/consent/native window and
 * process identities are omitted explicitly rather than removed from a spread
 * object.
 */
export interface ScopedAttachedWindowRendererProjection {
  readonly chatID: string
  readonly generation: number
  readonly attachedAt: string
  readonly windowMeta: ScopedAttachedWindowRendererMeta
  readonly streaming?: ScopedAttachedWindowStreaming
}

export interface ScopedAttachedWindowStatusProjection {
  readonly pickerPending: boolean
  readonly active: ScopedAttachedWindowRendererProjection | null
}

export type ScopedAttachedWindowStateErrorCode =
  | 'chat-mismatch'
  | 'invalid-input'
  | 'missing-app-chat-id'
  | 'no-active-attachment'
  | 'no-pending-picker'
  | 'pending-picker-exists'
  | 'pending-picker-mismatch'
  | 'scope-id-collision'
  | 'consent-epoch-exhausted'

export class ScopedAttachedWindowStateError extends Error {
  constructor(
    readonly code: ScopedAttachedWindowStateErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'ScopedAttachedWindowStateError'
  }
}

export interface ScopedAttachedWindowStateOptions {
  createScopeID?: () => string
  now?: () => string
}

const MAX_WINDOW_ID = 0xffff_ffff
const MAX_PID = 0x7fff_ffff

function fail(code: ScopedAttachedWindowStateErrorCode, message: string): never {
  throw new ScopedAttachedWindowStateError(code, message)
}

function hasForbiddenText(value: string): boolean {
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

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('invalid-input', `${name} must be an object.`)
  }
  return value as Record<string, unknown>
}

function opaqueString(value: unknown, name: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 512 ||
    value.trim() !== value ||
    value.normalize('NFC') !== value ||
    hasForbiddenText(value)
  ) {
    fail('invalid-input', `${name} must be a canonical non-empty string.`)
  }
  return value
}

function descriptiveString(value: unknown, name: string, maxLength: number): string {
  if (
    typeof value !== 'string' ||
    value.length > maxLength ||
    value.normalize('NFC') !== value ||
    hasForbiddenText(value)
  ) {
    fail('invalid-input', `${name} must be canonical display text.`)
  }
  return value
}

function integer(
  value: unknown,
  name: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    fail('invalid-input', `${name} must be a safe integer from ${minimum} through ${maximum}.`)
  }
  return value as number
}

function positiveFinite(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    fail('invalid-input', `${name} must be a positive finite number.`)
  }
  return value
}

function finite(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail('invalid-input', `${name} must be a finite number.`)
  }
  return value
}

function canonicalTimestamp(value: unknown, name: string): string {
  if (typeof value !== 'string') {
    fail('invalid-input', `${name} must be an ISO-8601 timestamp.`)
  }
  try {
    if (new Date(value).toISOString() !== value) {
      fail('invalid-input', `${name} must be a canonical ISO-8601 timestamp.`)
    }
  } catch {
    fail('invalid-input', `${name} must be a canonical ISO-8601 timestamp.`)
  }
  return value
}

function normalizePick(value: unknown): ScopedAttachedWindowPick {
  const input = record(value, 'picker scope')
  return Object.freeze({
    scopeID: opaqueString(input.scopeID, 'scopeID'),
    chatID: opaqueString(input.chatID, 'chatID'),
    consentEpoch: integer(input.consentEpoch, 'consentEpoch', 0)
  })
}

function normalizeProcessIdentity(value: unknown): ScopedAttachedWindowProcessIdentity {
  const input = record(value, 'windowMeta.processIdentity')
  const pid = integer(input.pid, 'windowMeta.processIdentity.pid', 1, MAX_PID)
  const launchTimeMicros = integer(
    input.launchTimeMicros,
    'windowMeta.processIdentity.launchTimeMicros',
    1
  )
  if (input.source !== 'nsRunningApplication' && input.source !== 'procBSDInfo') {
    fail('invalid-input', 'windowMeta.processIdentity.source is unsupported.')
  }
  return Object.freeze({
    pid,
    launchTimeMicros,
    source: input.source
  })
}

function normalizeWindowMeta(value: unknown): ScopedAttachedWindowMeta {
  const input = record(value, 'windowMeta')
  const pid = integer(input.pid, 'windowMeta.pid', 1, MAX_PID)
  const processIdentity = normalizeProcessIdentity(input.processIdentity)
  if (processIdentity.pid !== pid) {
    fail('invalid-input', 'windowMeta.processIdentity.pid must match windowMeta.pid.')
  }
  if (input.identityQuality !== 'exact' && input.identityQuality !== 'bestEffort') {
    fail('invalid-input', 'windowMeta.identityQuality is unsupported.')
  }
  const processStartedAt = opaqueString(input.processStartedAt, 'windowMeta.processStartedAt')
  const expectedProcessStartedAt = `${processIdentity.source}:${processIdentity.launchTimeMicros}`
  if (processStartedAt !== expectedProcessStartedAt) {
    fail(
      'invalid-input',
      'windowMeta.processStartedAt must match the canonical process identity receipt.'
    )
  }
  const boundsInput = record(input.bounds, 'windowMeta.bounds')
  const bounds: ScopedAttachedWindowBounds = Object.freeze({
    x: finite(boundsInput.x, 'windowMeta.bounds.x'),
    y: finite(boundsInput.y, 'windowMeta.bounds.y'),
    width: positiveFinite(boundsInput.width, 'windowMeta.bounds.width'),
    height: positiveFinite(boundsInput.height, 'windowMeta.bounds.height')
  })
  return Object.freeze({
    windowID: integer(input.windowID, 'windowMeta.windowID', 1, MAX_WINDOW_ID),
    title: descriptiveString(input.title, 'windowMeta.title', 4096),
    bundleID: descriptiveString(input.bundleID, 'windowMeta.bundleID', 512),
    applicationName: descriptiveString(input.applicationName, 'windowMeta.applicationName', 512),
    pid,
    identityQuality: input.identityQuality,
    processIdentity,
    processStartedAt,
    bounds
  })
}

function normalizeStreaming(value: unknown): ScopedAttachedWindowStreaming {
  const input = record(value, 'streaming')
  return Object.freeze({
    fps: positiveFinite(input.fps, 'streaming.fps'),
    bufferSeconds: positiveFinite(input.bufferSeconds, 'streaming.bufferSeconds'),
    frameCount: integer(input.frameCount, 'streaming.frameCount', 0),
    startedAt: canonicalTimestamp(input.startedAt, 'streaming.startedAt')
  })
}

function samePick(left: ScopedAttachedWindowPick, right: ScopedAttachedWindowPick): boolean {
  return (
    left.scopeID === right.scopeID &&
    left.chatID === right.chatID &&
    left.consentEpoch === right.consentEpoch
  )
}

function rendererProjection(
  snapshot: ScopedAttachedWindowSnapshot
): ScopedAttachedWindowRendererProjection {
  const windowMeta: ScopedAttachedWindowRendererMeta = Object.freeze({
    title: snapshot.windowMeta.title,
    bundleID: snapshot.windowMeta.bundleID,
    applicationName: snapshot.windowMeta.applicationName,
    identityQuality: snapshot.windowMeta.identityQuality
  })
  return Object.freeze({
    chatID: snapshot.chatID,
    generation: snapshot.generation,
    attachedAt: snapshot.attachedAt,
    windowMeta,
    ...(snapshot.streaming ? { streaming: snapshot.streaming } : {})
  })
}

function tryAppChatID(value: unknown): string | null {
  try {
    return opaqueString(value, 'appChatId')
  } catch {
    return null
  }
}

/**
 * Pure synchronous one-active-attachment state machine.
 *
 * Async picker/daemon work happens outside this class. Callers retain the
 * frozen token from `beginPick` and must echo it byte-for-byte to complete or
 * cancel that picker.
 */
export class ScopedAttachedWindowState {
  private readonly createScopeID: () => string
  private readonly now: () => string
  private readonly issuedScopeIDs = new Set<string>()
  private pending: ScopedAttachedWindowPick | null = null
  private active: ScopedAttachedWindowSnapshot | null = null
  private lastConsentEpoch = -1

  constructor(options: ScopedAttachedWindowStateOptions = {}) {
    if (!options || typeof options !== 'object') {
      fail('invalid-input', 'Scoped attachment options must be an object.')
    }
    if (options.createScopeID !== undefined && typeof options.createScopeID !== 'function') {
      fail('invalid-input', 'createScopeID must be a function.')
    }
    if (options.now !== undefined && typeof options.now !== 'function') {
      fail('invalid-input', 'now must be a function.')
    }
    this.createScopeID = options.createScopeID ?? randomUUID
    this.now = options.now ?? (() => new Date().toISOString())
  }

  beginPick(chatId: string): ScopedAttachedWindowPick {
    if (this.pending) {
      fail('pending-picker-exists', 'Another Screen Watch picker is already pending.')
    }
    const chatID = opaqueString(chatId, 'chatId')
    if (this.lastConsentEpoch >= Number.MAX_SAFE_INTEGER) {
      fail('consent-epoch-exhausted', 'The Screen Watch consent epoch is exhausted.')
    }
    const scopeID = opaqueString(this.createScopeID(), 'generated scopeID')
    if (this.issuedScopeIDs.has(scopeID)) {
      fail('scope-id-collision', 'The generated Screen Watch scopeID was already issued.')
    }
    const pending = Object.freeze({
      scopeID,
      chatID,
      consentEpoch: this.lastConsentEpoch + 1
    })
    this.lastConsentEpoch = pending.consentEpoch
    this.issuedScopeIDs.add(scopeID)
    this.pending = pending
    return pending
  }

  cancelPick(pick: ScopedAttachedWindowPick): boolean {
    const candidate = normalizePick(pick)
    if (!this.pending || !samePick(this.pending, candidate)) return false
    this.pending = null
    return true
  }

  completePick(input: ScopedAttachedWindowCompleteInput): ScopedAttachedWindowCompleteResult {
    const candidate = normalizePick(input)
    if (!this.pending) {
      fail('no-pending-picker', 'No Screen Watch picker is pending.')
    }
    if (!samePick(this.pending, candidate)) {
      fail('pending-picker-mismatch', 'The Screen Watch completion does not match the picker.')
    }

    const completion = record(input, 'picker completion')
    const snapshot: ScopedAttachedWindowSnapshot = Object.freeze({
      handleID: opaqueString(completion.handleID, 'handleID'),
      scopeID: this.pending.scopeID,
      chatID: this.pending.chatID,
      consentEpoch: this.pending.consentEpoch,
      generation: integer(completion.generation, 'generation', 1),
      attachedAt: canonicalTimestamp(this.now(), 'attachedAt'),
      windowMeta: normalizeWindowMeta(completion.windowMeta)
    })

    const replaced = this.active
    this.pending = null
    this.active = snapshot
    return Object.freeze({ active: snapshot, replaced })
  }

  getForChat(appChatId: string | null | undefined): ScopedAttachedWindowSnapshot | null {
    const chatID = tryAppChatID(appChatId)
    if (!chatID || !this.active || this.active.chatID !== chatID) return null
    return this.active
  }

  requireForExecutor(appChatId: string | null | undefined): ScopedAttachedWindowSnapshot {
    const chatID = tryAppChatID(appChatId)
    if (!chatID) {
      fail('missing-app-chat-id', 'Screen Watch requires a canonical appChatId.')
    }
    if (!this.active) {
      fail('no-active-attachment', 'No Screen Watch attachment is active.')
    }
    if (this.active.chatID !== chatID) {
      fail('chat-mismatch', 'The Screen Watch attachment belongs to another chat.')
    }
    return this.active
  }

  updateStreaming(
    update: ScopedAttachedWindowStreamingUpdate
  ): ScopedAttachedWindowSnapshot | null {
    const input = record(update, 'streaming update')
    const scopeID = opaqueString(input.scopeID, 'scopeID')
    const generation = integer(input.generation, 'generation', 1)
    if (!this.active || this.active.scopeID !== scopeID || this.active.generation !== generation) {
      return null
    }
    const streaming = input.streaming === null ? null : normalizeStreaming(input.streaming)
    const next: ScopedAttachedWindowSnapshot = Object.freeze({
      handleID: this.active.handleID,
      scopeID: this.active.scopeID,
      chatID: this.active.chatID,
      consentEpoch: this.active.consentEpoch,
      generation: this.active.generation,
      attachedAt: this.active.attachedAt,
      windowMeta: this.active.windowMeta,
      ...(streaming ? { streaming } : {})
    })
    this.active = next
    return next
  }

  detach(input: ScopedAttachedWindowDetachInput): ScopedAttachedWindowSnapshot | null {
    const candidate = record(input, 'detach request')
    const chatID = opaqueString(candidate.chatID, 'chatID')
    const scopeID = opaqueString(candidate.scopeID, 'scopeID')
    const generation = integer(candidate.generation, 'generation', 1)
    if (
      !this.active ||
      this.active.chatID !== chatID ||
      this.active.scopeID !== scopeID ||
      this.active.generation !== generation
    ) {
      return null
    }
    const detached = this.active
    this.active = null
    return detached
  }

  clearActive(): ScopedAttachedWindowSnapshot | null {
    const cleared = this.active
    this.active = null
    return cleared
  }

  status(): ScopedAttachedWindowStatusProjection {
    return Object.freeze({
      pickerPending: this.pending !== null,
      active: this.active ? rendererProjection(this.active) : null
    })
  }
}
