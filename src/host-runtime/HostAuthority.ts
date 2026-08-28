/**
 * Standalone Host Authority contract (Wave 2B Subwave 4B).
 *
 * Transport-neutral interface only. Implementations inject runtime ports
 * elsewhere (AppStoreHostAuthority / dedicated Host process). This module
 * must not import Node, Electron, AppStore, Bridge, control, providers, or
 * work-lock modules, and must not construct snapshots or execute domain work.
 */

import type {
  HostActorIdentity,
  HostAuthenticatedClientIdentity,
  HostClientClass,
  HostCommand,
  HostCommandReceipt,
  HostCursorPosition,
  HostDeltasSinceResult,
  HostHealthProjection,
  HostSnapshot
} from '../shared/hostProtocol'
import type { TaskWraithControlThreadOffers } from '../shared/taskWraithControlProtocol'
import type {
  HostWorkspaceGitReadParams,
  HostWorkspaceGitReadResult
} from '../shared/hostProtocolTransport'
import type {
  HostHistorySinceRequest,
  HostHistorySinceResult,
  HostThreadHistoryPage,
  HostThreadHistoryRequest
} from '../shared/hostHistoryProtocol'
import type {
  HostProviderAuthFlowProjection,
  HostProviderAuthStatusProjection,
  HostProviderOffersProjection,
  HostProviderStatusProjection
} from '../shared/hostSetupProtocol'

/** Authenticated call context required on every Authority operation. */
export interface HostAuthorityCallContext {
  /** Exact actor identity for authority evaluation and receipt binding. */
  actor: HostActorIdentity
  /** Authenticated client that initiated the call. */
  client: HostAuthenticatedClientIdentity
}

/**
 * Receipt lookup requires exactly one stable key.
 * Implementations must reject ambiguous or empty selectors as invalid_lookup.
 */
export type HostAuthorityReceiptLookup =
  | { readonly commandId: string; readonly idempotencyKey?: never }
  | { readonly idempotencyKey: string; readonly commandId?: never }

/** Narrow operational errors — never carry receipt/snapshot bodies or internals. */
export type HostAuthorityErrorCode = 'host_unavailable' | 'shutting_down' | 'invalid_lookup'

export interface HostAuthorityFailure {
  readonly ok: false
  readonly error: HostAuthorityErrorCode
}

export interface HostAuthoritySuccess<T> {
  readonly ok: true
  readonly value: T
}

export type HostAuthorityResult<T> = HostAuthoritySuccess<T> | HostAuthorityFailure

/**
 * Receipt lookup outcomes. Miss / actor-mismatch / incomplete never include a
 * receipt body. Found is the only branch that may carry HostCommandReceipt.
 */
export type HostAuthorityReceiptResult =
  | { readonly ok: true; readonly outcome: 'found'; readonly receipt: HostCommandReceipt }
  | { readonly ok: true; readonly outcome: 'not_found' }
  | { readonly ok: true; readonly outcome: 'actor_mismatch' }
  | { readonly ok: true; readonly outcome: 'incomplete' }
  | HostAuthorityFailure

/** Explicit shutdown acknowledgement; idempotent when already stopped. */
export interface HostAuthorityShutdownResult {
  readonly stopped: true
  readonly alreadyStopped: boolean
}

/**
 * Host Authority facade — sole client-facing Host domain surface once wired.
 *
 * - Position for snapshots/deltas/receipts is owned by HostDeltaStore via the
 *   implementing runtime; this interface does not expose a second journal.
 * - `command` always returns a durable HostCommandReceipt on the success
 *   branch (including denied / conflict). Operational unavailability uses
 *   HostAuthorityFailure instead of inventing semantic success.
 * - Implementations MUST verify `command.actor` against `context.actor`
 *   (see hostAuthorityCommandActorMatchesContext) before durable begin.
 */
export interface HostAuthority {
  snapshot(
    context: HostAuthorityCallContext,
    cursor?: HostCursorPosition
  ): Promise<HostAuthorityResult<HostSnapshot>>

  deltas(
    context: HostAuthorityCallContext,
    since: HostCursorPosition
  ): Promise<HostAuthorityResult<HostDeltasSinceResult>>

  /** Capability-gated read added during the Host-v2 control migration. */
  threadOffers?(
    context: HostAuthorityCallContext,
    threadId: string
  ): Promise<HostAuthorityResult<TaskWraithControlThreadOffers>>

  /** Capability-gated, workspace-scoped read. Never enters mutation/receipt machinery. */
  gitRead?(
    context: HostAuthorityCallContext,
    request: HostWorkspaceGitReadParams
  ): Promise<HostAuthorityResult<HostWorkspaceGitReadResult>>

  /** Capability-gated cold-start read; no provider runtime or credential body. */
  providerStatuses?(
    context: HostAuthorityCallContext
  ): Promise<HostAuthorityResult<readonly HostProviderStatusProjection[]>>

  providerOffers?(
    context: HostAuthorityCallContext,
    providerId: string
  ): Promise<HostAuthorityResult<HostProviderOffersProjection>>

  providerAuthFlows?(
    context: HostAuthorityCallContext,
    providerId: string
  ): Promise<HostAuthorityResult<readonly HostProviderAuthFlowProjection[]>>

  providerAuthStatus?(
    context: HostAuthorityCallContext,
    providerId: string
  ): Promise<HostAuthorityResult<HostProviderAuthStatusProjection>>

  /** Bounded immutable history page; separate from the live snapshot cursor. */
  threadHistory?(
    context: HostAuthorityCallContext,
    request: HostThreadHistoryRequest
  ): Promise<HostAuthorityResult<HostThreadHistoryPage>>

  historySince?(
    context: HostAuthorityCallContext,
    request: HostHistorySinceRequest
  ): Promise<HostAuthorityResult<HostHistorySinceResult>>

  command(
    context: HostAuthorityCallContext,
    command: HostCommand
  ): Promise<HostAuthorityResult<HostCommandReceipt>>

  receipt(
    context: HostAuthorityCallContext,
    lookup: HostAuthorityReceiptLookup
  ): Promise<HostAuthorityReceiptResult>

  health(context: HostAuthorityCallContext): Promise<HostAuthorityResult<HostHealthProjection>>

  /** Explicit Host stop. Idempotent: repeated calls succeed with alreadyStopped. */
  shutdown(
    context: HostAuthorityCallContext
  ): Promise<HostAuthorityResult<HostAuthorityShutdownResult>>
}

const HOST_CLIENT_CLASSES: ReadonlySet<HostClientClass> = new Set(['desktop', 'tui', 'ios', 'test'])

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isHostClientClass(value: unknown): value is HostClientClass {
  return typeof value === 'string' && HOST_CLIENT_CLASSES.has(value as HostClientClass)
}

/** Exact actor requires non-empty actorId, clientId, and a known clientClass. */
export function isExactHostActorIdentity(actor: HostActorIdentity): boolean {
  return (
    isNonEmptyString(actor.actorId) &&
    isNonEmptyString(actor.clientId) &&
    isHostClientClass(actor.clientClass)
  )
}

/** Exact match on actorId + clientId + clientClass; incomplete never matches. */
export function hostActorsMatchExact(left: HostActorIdentity, right: HostActorIdentity): boolean {
  if (!isExactHostActorIdentity(left) || !isExactHostActorIdentity(right)) return false
  return (
    left.actorId === right.actorId &&
    left.clientId === right.clientId &&
    left.clientClass === right.clientClass
  )
}

/**
 * Command actor must equal the authenticated call-context actor.
 * Implementations MUST gate durable begin on this check.
 */
export function hostAuthorityCommandActorMatchesContext(
  context: HostAuthorityCallContext,
  command: HostCommand
): boolean {
  if (!isExactHostActorIdentity(context.actor)) return false
  return hostActorsMatchExact(context.actor, command.actor)
}

/**
 * Validate that a lookup carries exactly one non-empty stable key.
 * Returns null when ambiguous, empty, or both keys are present.
 */
export function parseHostAuthorityReceiptLookup(
  lookup: unknown
): HostAuthorityReceiptLookup | null {
  if (lookup === null || typeof lookup !== 'object' || Array.isArray(lookup)) return null
  const record = lookup as Record<string, unknown>
  const commandId = record.commandId
  const idempotencyKey = record.idempotencyKey
  const hasCommandId = isNonEmptyString(commandId)
  const hasIdempotencyKey = isNonEmptyString(idempotencyKey)
  if (hasCommandId === hasIdempotencyKey) return null
  if (hasCommandId) return { commandId }
  return { idempotencyKey: idempotencyKey as string }
}

/** True when a receipt result is allowed to carry a HostCommandReceipt body. */
export function hostAuthorityReceiptResultHasBody(
  result: HostAuthorityReceiptResult
): result is Extract<HostAuthorityReceiptResult, { outcome: 'found' }> {
  return result.ok === true && result.outcome === 'found'
}
