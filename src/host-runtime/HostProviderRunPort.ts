import { isAbsolute } from 'node:path'

import type { HostRunEventTarget } from './HostRunEventTarget'

/**
 * Transport-neutral Host provider-run boundary.
 *
 * Provider adapters receive only canonical configuration, constrained
 * transcript/run persistence operations, and a bounded event publisher. The
 * transport owns delivery mechanics; this contract never assumes Electron,
 * WebContents, IPC, or a connected client lifetime.
 */

export const HOST_PROVIDER_RUN_MAX_TEXT_CHARS = 16_000
export const HOST_PROVIDER_RUN_MAX_EVENT_TEXT_CHARS = 4_000
export const HOST_PROVIDER_RUN_MAX_WARNING_COUNT = 16
export const HOST_PROVIDER_RUN_MAX_WARNING_CHARS = 300

export type HostProviderRunTranscriptRole = 'user' | 'assistant' | 'system'
export type HostProviderRunTerminalStatus = 'completed' | 'failed' | 'cancelled'

/** A canonical, store-owned workspace identity; raw request paths never enter a run. */
export interface HostProviderRunWorkspace {
  readonly workspaceId: string
  readonly canonicalPath: string
  /** The resolving store verified this is the canonical real directory. */
  readonly canonical: true
}

/** Host-owned selected posture, including the explicit-consent evidence if needed. */
export interface HostProviderRunPosture {
  readonly postureId: string
  readonly approvalMode: string
  readonly requiresExplicitConsent: boolean
  readonly explicitConsentAcknowledged: boolean
  /** Bounded projection emitted only after Host HMAC verification. */
  readonly verifiedConsent?: {
    readonly authority: 'host-signed'
    readonly commandId: string
    readonly commandFingerprint: string
    readonly actorClientClass: 'desktop' | 'tui' | 'test'
    readonly offerRevision: string
    readonly acknowledgedAt: string
  }
}

/** Configuration a provider adapter may consume for one already-created thread. */
export interface HostProviderRunThread {
  readonly threadId: string
  readonly workspace: HostProviderRunWorkspace
  readonly providerId: string
  readonly modelId: string
  readonly reasoningId?: string
  readonly providerSessionId?: string
  readonly posture: HostProviderRunPosture
}

export interface HostProviderRunTranscriptAppend {
  readonly threadId: string
  readonly runId: string
  readonly role: HostProviderRunTranscriptRole
  readonly text: string
  readonly createdAt: string
}

export interface HostProviderRunBegin {
  readonly runId: string
  readonly threadId: string
  readonly providerId: string
  readonly modelId: string
  readonly startedAt: string
}

export interface HostProviderRunUpdate {
  readonly runId: string
  readonly phase: 'starting' | 'streaming' | 'cancelling'
  readonly updatedAt: string
}

export interface HostProviderRunUsage {
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
  readonly estimatedCostUsd?: number
}

export interface HostProviderRunFinish {
  readonly runId: string
  readonly status: HostProviderRunTerminalStatus
  readonly finishedAt: string
  readonly providerSessionId?: string
  readonly usage?: HostProviderRunUsage
  readonly warningSummaries: readonly string[]
  readonly errorCode?: 'provider_setup_unavailable' | 'provider_launch_failed' | 'provider_failed'
}

export type HostProviderRunBeginResult =
  | { readonly kind: 'started' }
  | { readonly kind: 'duplicate' }

export type HostProviderRunCancelRegistrationResult =
  | { readonly kind: 'registered' }
  | { readonly kind: 'duplicate' }

/** Bounded normalized output; raw provider envelopes and tool bodies are excluded. */
export type HostProviderRunEvent =
  | {
      readonly type: 'run.started'
      readonly runId: string
      readonly threadId: string
      readonly providerId: string
      readonly sessionId: string
      readonly at: string
    }
  | {
      readonly type: 'run.content'
      readonly runId: string
      readonly threadId: string
      readonly text: string
      readonly at: string
    }
  | {
      readonly type: 'run.tool'
      readonly runId: string
      readonly threadId: string
      readonly toolId: string
      readonly toolName?: string
      readonly phase: 'started' | 'finished'
      readonly status?: 'success' | 'error'
      readonly at: string
    }
  | {
      readonly type: 'run.status'
      readonly runId: string
      readonly threadId: string
      readonly status: 'running' | HostProviderRunTerminalStatus
      readonly at: string
      readonly warningCount?: number
    }

/**
 * Store/event capability required by a Host provider adapter.
 *
 * `registerCancel` is keyed by an exact run id. Client connection churn must
 * never invoke it; only an explicit Host run.cancel command may do so.
 */
export interface HostProviderRunPort {
  getThread(threadId: string): HostProviderRunThread | null
  appendTranscript(input: HostProviderRunTranscriptAppend): void
  beginRun(input: HostProviderRunBegin): HostProviderRunBeginResult
  updateRun(input: HostProviderRunUpdate): void
  finishRun(input: HostProviderRunFinish): void
  registerCancel(runId: string, cancel: () => void): HostProviderRunCancelRegistrationResult
  clearCancel(runId: string): void
  publishRunEvent(target: HostRunEventTarget, event: HostProviderRunEvent): void
}

// eslint-disable-next-line no-control-regex -- IDs and text reject C0 controls at the port boundary.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/
// eslint-disable-next-line no-control-regex -- ordinary transcript formatting allows tabs/newlines.
const UNSAFE_TEXT_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/
const MAX_IDENTIFIER_CHARS = 512
const PRESENTATION_SECRET_PATTERN =
  /((?:api[_-]?key|token|secret|password|authorization)\s*[:=]\s*)([^\s,;]+)/gi

function canonicalIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_IDENTIFIER_CHARS &&
    value.trim() === value &&
    !CONTROL_CHARACTERS.test(value)
  )
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length !== 24 || CONTROL_CHARACTERS.test(value))
    return false
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value
}

/** Bounded presentation text only; raw provider envelopes are never valid input here. */
export function normalizeHostProviderRunPresentationText(
  value: unknown,
  maxChars = HOST_PROVIDER_RUN_MAX_TEXT_CHARS
): string | null {
  if (!Number.isSafeInteger(maxChars) || maxChars < 1 || typeof value !== 'string') return null
  const cleaned = value
    .replace(UNSAFE_TEXT_CONTROLS, ' ')
    .replace(PRESENTATION_SECRET_PATTERN, '$1[redacted]')
  if (!cleaned.trim()) return null
  return cleaned.length <= maxChars ? cleaned : `${cleaned.slice(0, maxChars - 1)}…`
}

/** User-authored prompts are immutable intent: validate, never redact or truncate. */
export function validateHostProviderRunPrompt(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= HOST_PROVIDER_RUN_MAX_TEXT_CHARS &&
    value.trim().length > 0 &&
    !UNSAFE_TEXT_CONTROLS.test(value)
  )
}

export function normalizeHostProviderRunThread(
  value: HostProviderRunThread | null | undefined
): HostProviderRunThread | null {
  if (!value || !canonicalIdentifier(value.threadId) || !canonicalIdentifier(value.providerId))
    return null
  if (!canonicalIdentifier(value.modelId) || !canonicalIdentifier(value.workspace.workspaceId))
    return null
  if (
    value.workspace.canonical !== true ||
    !isAbsolute(value.workspace.canonicalPath) ||
    value.workspace.canonicalPath.trim() !== value.workspace.canonicalPath ||
    CONTROL_CHARACTERS.test(value.workspace.canonicalPath)
  ) {
    return null
  }
  const verifiedConsent = value.posture.verifiedConsent
  if (verifiedConsent !== undefined) {
    if (
      verifiedConsent.authority !== 'host-signed' ||
      !canonicalIdentifier(verifiedConsent.commandId) ||
      !/^[a-f0-9]{64}$/.test(verifiedConsent.commandFingerprint) ||
      !['desktop', 'tui', 'test'].includes(verifiedConsent.actorClientClass) ||
      !canonicalIdentifier(verifiedConsent.offerRevision) ||
      !canonicalTimestamp(verifiedConsent.acknowledgedAt)
    ) {
      return null
    }
  }
  const requestsFullAccess =
    value.posture.postureId === 'full_access' || value.posture.approvalMode === 'full_access'
  if (
    requestsFullAccess &&
    (value.posture.postureId !== 'full_access' ||
      value.posture.approvalMode !== 'auto_edit' ||
      value.posture.requiresExplicitConsent !== true ||
      value.posture.explicitConsentAcknowledged !== true ||
      verifiedConsent === undefined)
  ) {
    return null
  }
  if (
    !canonicalIdentifier(value.posture.postureId) ||
    !canonicalIdentifier(value.posture.approvalMode) ||
    (value.posture.requiresExplicitConsent && !value.posture.explicitConsentAcknowledged)
  ) {
    return null
  }
  if (value.reasoningId !== undefined && !canonicalIdentifier(value.reasoningId)) return null
  if (value.providerSessionId !== undefined && !canonicalIdentifier(value.providerSessionId))
    return null
  return {
    ...value,
    workspace: { ...value.workspace },
    posture: {
      ...value.posture,
      ...(verifiedConsent ? { verifiedConsent: { ...verifiedConsent } } : {})
    }
  }
}

export function normalizeHostProviderRunTranscriptAppend(
  value: HostProviderRunTranscriptAppend
): HostProviderRunTranscriptAppend | null {
  if (
    !canonicalIdentifier(value.threadId) ||
    !canonicalIdentifier(value.runId) ||
    !canonicalTimestamp(value.createdAt) ||
    !['user', 'assistant', 'system'].includes(value.role)
  ) {
    return null
  }
  if (
    typeof value.text !== 'string' ||
    value.text.length === 0 ||
    value.text.length > HOST_PROVIDER_RUN_MAX_TEXT_CHARS ||
    UNSAFE_TEXT_CONTROLS.test(value.text)
  ) {
    return null
  }
  return { ...value }
}

export function normalizeHostProviderRunBegin(
  value: HostProviderRunBegin
): HostProviderRunBegin | null {
  if (
    !canonicalIdentifier(value.runId) ||
    !canonicalIdentifier(value.threadId) ||
    !canonicalIdentifier(value.providerId) ||
    !canonicalIdentifier(value.modelId) ||
    !canonicalTimestamp(value.startedAt)
  ) {
    return null
  }
  return { ...value }
}

export function normalizeHostProviderRunUpdate(
  value: HostProviderRunUpdate
): HostProviderRunUpdate | null {
  if (
    !canonicalIdentifier(value.runId) ||
    !canonicalTimestamp(value.updatedAt) ||
    !['starting', 'streaming', 'cancelling'].includes(value.phase)
  ) {
    return null
  }
  return { ...value }
}

export function normalizeHostProviderRunUsage(
  value: HostProviderRunUsage | undefined
): HostProviderRunUsage | undefined | null {
  if (value === undefined) return undefined
  const entries = Object.entries(value)
  if (entries.length === 0) return undefined
  const knownKeys = new Set([
    'inputTokens',
    'outputTokens',
    'cacheReadTokens',
    'cacheWriteTokens',
    'estimatedCostUsd'
  ])
  for (const [key, amount] of entries) {
    if (!knownKeys.has(key)) return null
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) return null
  }
  return { ...value }
}

export function normalizeHostProviderRunWarnings(
  values: readonly string[]
): readonly string[] | null {
  if (!Array.isArray(values) || values.length > HOST_PROVIDER_RUN_MAX_WARNING_COUNT) return null
  const output: string[] = []
  for (const value of values) {
    const normalized = normalizeHostProviderRunPresentationText(
      value,
      HOST_PROVIDER_RUN_MAX_WARNING_CHARS
    )
    if (!normalized) return null
    if (!output.includes(normalized)) output.push(normalized)
  }
  return output
}

export function normalizeHostProviderRunFinish(
  value: HostProviderRunFinish
): HostProviderRunFinish | null {
  const usage = normalizeHostProviderRunUsage(value.usage)
  const warningSummaries = normalizeHostProviderRunWarnings(value.warningSummaries)
  if (
    !canonicalIdentifier(value.runId) ||
    !canonicalTimestamp(value.finishedAt) ||
    !['completed', 'failed', 'cancelled'].includes(value.status) ||
    usage === null ||
    warningSummaries === null ||
    (value.providerSessionId !== undefined && !canonicalIdentifier(value.providerSessionId)) ||
    (value.errorCode !== undefined &&
      !['provider_setup_unavailable', 'provider_launch_failed', 'provider_failed'].includes(
        value.errorCode
      ))
  ) {
    return null
  }
  return {
    ...value,
    ...(usage ? { usage } : {}),
    warningSummaries
  }
}

export function normalizeHostProviderRunEvent(
  value: HostProviderRunEvent
): HostProviderRunEvent | null {
  if (
    !canonicalIdentifier(value.runId) ||
    !canonicalIdentifier(value.threadId) ||
    !canonicalTimestamp(value.at)
  ) {
    return null
  }
  if (value.type === 'run.content') {
    const text = normalizeHostProviderRunPresentationText(
      value.text,
      HOST_PROVIDER_RUN_MAX_EVENT_TEXT_CHARS
    )
    return text ? { ...value, text } : null
  }
  if (value.type === 'run.started') {
    return canonicalIdentifier(value.providerId) && canonicalIdentifier(value.sessionId)
      ? { ...value }
      : null
  }
  if (value.type === 'run.tool') {
    if (!canonicalIdentifier(value.toolId)) return null
    if (value.toolName !== undefined && !canonicalIdentifier(value.toolName)) return null
    if (!['started', 'finished'].includes(value.phase)) return null
    if (value.status !== undefined && !['success', 'error'].includes(value.status)) return null
    return { ...value }
  }
  if (
    !['running', 'completed', 'failed', 'cancelled'].includes(value.status) ||
    (value.warningCount !== undefined &&
      (!Number.isSafeInteger(value.warningCount) ||
        value.warningCount < 0 ||
        value.warningCount > HOST_PROVIDER_RUN_MAX_WARNING_COUNT))
  ) {
    return null
  }
  return { ...value }
}
