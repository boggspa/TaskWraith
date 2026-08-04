/**
 * Pure authenticated Host session binder (Wave 2E-1 Lane J).
 *
 * Responsibilities:
 * - Bind a transport-verified client context to a decode-valid HostBootstrapWelcome
 * - Require verified context fields to exactly match the protocol-visible
 *   authenticated client identity (spoof / mismatch fail closed)
 * - Mint HostActorIdentity only via hostActorIdentityFromVerifiedContext
 * - Source welcome generation/cursor only from HostRuntimeBootstrap.getPosition
 *   (sole journal — never a second position counter)
 * - Intersect capabilities only (via buildHostBootstrapWelcome)
 * - Issue session IDs from an injected bounded factory (default randomUUID);
 *   clients cannot select or invent session ids
 * - Provide reconnect-safe in-memory lookup + idempotent re-bind by actor key
 *
 * Non-goals (fail closed / never implemented here):
 * - Authentication, credential verification, pairing, or transport handshake
 * - Opening listeners / net / http / Electron sockets
 * - Daemon / supervisor / remote-access widening
 * - Command execution, receipt minting, or domain delta publication
 * - A second generation/cursor journal
 * - Accepting wire-asserted actor objects as authority
 */

import { randomUUID } from 'node:crypto'

import {
  HOST_PROTOCOL_MAX_ID,
  buildHostBootstrapWelcome,
  type HostActorIdentity,
  type HostAuthenticatedClientIdentity,
  type HostBootstrapWelcome,
  type HostCapability,
  type HostCursorPosition,
  type HostDecodeResult,
  type HostProjectionFreshness
} from '../../shared/hostProtocol'
import {
  hostActorIdentityFromVerifiedContext,
  isHostUuid,
  isSafeHostIdentifier,
  type HostTransportVerifiedClientContext,
  type HostUuidFactory
} from './HostCommandIdentity'
import type { HostRuntimeBootstrap } from './HostRuntimeBootstrap'

export type HostSessionIdFactory = HostUuidFactory

/** Minimal sole-journal position port (HostRuntimeBootstrap satisfies this). */
export interface HostSessionPositionPort {
  getPosition(): HostCursorPosition
}

export interface HostSessionHostIdentity {
  readonly hostId: string
  readonly hostVersion: string
}

export interface HostSessionOptions {
  readonly host: HostSessionHostIdentity
  /** Sole journal position source. Prefer HostRuntimeBootstrap. */
  readonly runtime: HostSessionPositionPort | Pick<HostRuntimeBootstrap, 'getPosition'>
  readonly hostCapabilityOffer: readonly HostCapability[]
  /** Injected for tests; default randomUUID. Never taken from the client. */
  readonly sessionIdFactory?: HostSessionIdFactory
  /** Welcome freshness; defaults to live for a fresh authenticated bind. */
  readonly freshness?: HostProjectionFreshness
}

/**
 * Client bind request. `authenticatedClient` is the protocol-visible identity
 * after the transport binding already verified the caller — this module still
 * requires it to exactly match `verifiedContext` fields and never trusts a
 * nested wire `actor` claim.
 */
export interface HostSessionBindRequest {
  readonly verifiedContext: HostTransportVerifiedClientContext
  readonly authenticatedClient: HostAuthenticatedClientIdentity
  readonly clientCapabilityRequest: readonly HostCapability[]
}

export interface HostSessionBinding {
  readonly sessionId: string
  readonly actor: HostActorIdentity
  readonly authenticatedClient: HostAuthenticatedClientIdentity
  readonly welcome: HostBootstrapWelcome
  /** Position refreshed from the sole journal on each successful bind/re-bind. */
  readonly boundGeneration: number
  readonly boundCursor: number
}

function fail(error: string): HostDecodeResult<never> {
  return { ok: false, error }
}

function actorBindingKey(actor: HostActorIdentity): string {
  return `${actor.clientClass}\u0000${actor.clientId}\u0000${actor.actorId}`
}

/**
 * Require transport-verified fields to exactly match the protocol-visible
 * authenticated client identity. Mismatch / spoof fails closed.
 */
export function assertVerifiedContextMatchesAuthenticatedClient(
  verified: HostTransportVerifiedClientContext,
  authenticated: HostAuthenticatedClientIdentity
): HostDecodeResult<true> {
  if (verified === null || typeof verified !== 'object' || Array.isArray(verified)) {
    return fail('verified client context must be an object')
  }
  if (authenticated === null || typeof authenticated !== 'object' || Array.isArray(authenticated)) {
    return fail('authenticatedClient must be an object')
  }
  if (verified.clientClass !== authenticated.clientClass) {
    return fail('verified clientClass does not match authenticatedClient')
  }
  if (verified.clientId !== authenticated.clientId) {
    return fail('verified clientId does not match authenticatedClient')
  }
  const verifiedSubject = verified.subjectId
  const authSubject = authenticated.subjectId
  if (verifiedSubject !== authSubject) {
    // Both undefined → equal. One-sided or unequal → spoof/mismatch.
    return fail('verified subjectId does not match authenticatedClient')
  }
  return { ok: true, value: true }
}

/**
 * In-memory authenticated session registry.
 *
 * Bindings are host-issued and reconnect-safe: repeated bind for the same
 * verified actor returns the existing session; lookup is by host-issued
 * sessionId only. No sockets, no persistence, no second journal.
 */
export class HostSession {
  private readonly host: HostSessionHostIdentity
  private readonly runtime: HostSessionPositionPort
  private readonly hostCapabilityOffer: readonly HostCapability[]
  private readonly sessionIdFactory: HostSessionIdFactory
  private readonly freshness: HostProjectionFreshness
  private readonly bySessionId = new Map<string, HostSessionBinding>()
  private readonly sessionIdByActorKey = new Map<string, string>()

  constructor(options: HostSessionOptions) {
    if (!options || typeof options !== 'object') {
      throw new Error('HostSession requires options')
    }
    if (!isSafeHostIdentifier(options.host?.hostId)) {
      throw new Error('HostSession requires a safe hostId')
    }
    if (
      typeof options.host?.hostVersion !== 'string' ||
      options.host.hostVersion.length === 0 ||
      options.host.hostVersion.length > 80
    ) {
      throw new Error('HostSession requires a bounded hostVersion')
    }
    if (!options.runtime || typeof options.runtime.getPosition !== 'function') {
      throw new Error('HostSession requires a runtime position port')
    }
    if (!Array.isArray(options.hostCapabilityOffer)) {
      throw new Error('HostSession requires a hostCapabilityOffer array')
    }
    this.host = {
      hostId: options.host.hostId,
      hostVersion: options.host.hostVersion
    }
    this.runtime = options.runtime
    this.hostCapabilityOffer = options.hostCapabilityOffer
    this.sessionIdFactory = options.sessionIdFactory ?? randomUUID
    this.freshness = options.freshness ?? 'live'
  }

  /**
   * Bind (or idempotently re-bind) an authenticated client.
   * Session ids are host-minted only — never accepted from the request.
   */
  bind(request: HostSessionBindRequest): HostDecodeResult<HostSessionBinding> {
    if (request === null || typeof request !== 'object' || Array.isArray(request)) {
      return fail('bind request must be an object')
    }
    // Reject client-selected session ids on the bind path (even if sneaky).
    if (
      Object.prototype.hasOwnProperty.call(request, 'sessionId') &&
      (request as { sessionId?: unknown }).sessionId !== undefined
    ) {
      return fail('sessionId cannot be client-selected')
    }

    const match = assertVerifiedContextMatchesAuthenticatedClient(
      request.verifiedContext,
      request.authenticatedClient
    )
    if (!match.ok) return match

    const actorResult = hostActorIdentityFromVerifiedContext(request.verifiedContext)
    if (!actorResult.ok) return actorResult
    const actor = actorResult.value

    const existingId = this.sessionIdByActorKey.get(actorBindingKey(actor))
    if (existingId !== undefined) {
      const existing = this.bySessionId.get(existingId)
      if (!existing) {
        return fail('session binding index is inconsistent')
      }

      const positionResult = this.readPosition()
      if (!positionResult.ok) return positionResult
      const position = positionResult.value

      // Re-bind may only retain/narrow the existing grant. A wider current
      // request cannot add capabilities that were not already granted.
      const retainedHostOffer = this.hostCapabilityOffer.filter((capability) =>
        existing.welcome.capabilities.includes(capability)
      )
      const welcomeResult = buildHostBootstrapWelcome({
        hostId: this.host.hostId,
        hostVersion: this.host.hostVersion,
        sessionId: existing.sessionId,
        generation: position.generation,
        cursor: position.cursor,
        authenticatedClient: request.authenticatedClient,
        hostCapabilityOffer: retainedHostOffer,
        clientCapabilityRequest: request.clientCapabilityRequest,
        freshness: this.freshness
      })
      if (!welcomeResult.ok) return welcomeResult

      const refreshed: HostSessionBinding = {
        sessionId: existing.sessionId,
        actor: existing.actor,
        authenticatedClient: welcomeResult.value.authenticatedClient,
        welcome: welcomeResult.value,
        boundGeneration: position.generation,
        boundCursor: position.cursor
      }
      this.bySessionId.set(existingId, refreshed)
      return { ok: true, value: refreshed }
    }

    let sessionId: string
    try {
      sessionId = this.sessionIdFactory()
    } catch {
      return fail('sessionId mint failed')
    }
    if (!isSafeHostIdentifier(sessionId, HOST_PROTOCOL_MAX_ID) || !isHostUuid(sessionId)) {
      return fail('sessionId mint produced an unsafe or non-UUID value')
    }
    if (this.bySessionId.has(sessionId)) {
      return fail('sessionId mint collided with an existing binding')
    }

    const positionResult = this.readPosition()
    if (!positionResult.ok) return positionResult
    const position = positionResult.value

    const welcomeResult = buildHostBootstrapWelcome({
      hostId: this.host.hostId,
      hostVersion: this.host.hostVersion,
      sessionId,
      generation: position.generation,
      cursor: position.cursor,
      authenticatedClient: request.authenticatedClient,
      hostCapabilityOffer: this.hostCapabilityOffer,
      clientCapabilityRequest: request.clientCapabilityRequest,
      freshness: this.freshness
    })
    if (!welcomeResult.ok) return welcomeResult

    const binding: HostSessionBinding = {
      sessionId,
      actor,
      authenticatedClient: welcomeResult.value.authenticatedClient,
      welcome: welcomeResult.value,
      boundGeneration: position.generation,
      boundCursor: position.cursor
    }
    this.bySessionId.set(sessionId, binding)
    this.sessionIdByActorKey.set(actorBindingKey(actor), sessionId)
    return { ok: true, value: binding }
  }

  private readPosition(): HostDecodeResult<HostCursorPosition> {
    let position: HostCursorPosition
    try {
      position = this.runtime.getPosition()
    } catch {
      return fail('runtime position unavailable')
    }
    if (
      position === null ||
      typeof position !== 'object' ||
      typeof position.generation !== 'number' ||
      typeof position.cursor !== 'number' ||
      !Number.isInteger(position.generation) ||
      !Number.isInteger(position.cursor) ||
      position.generation < 0 ||
      position.cursor < 0
    ) {
      return fail('runtime position is invalid')
    }
    return { ok: true, value: position }
  }

  /**
   * Reconnect-safe lookup by host-issued sessionId.
   * Unknown / unsafe ids fail closed — never invent a binding.
   */
  lookup(sessionId: unknown): HostDecodeResult<HostSessionBinding> {
    if (!isSafeHostIdentifier(sessionId, HOST_PROTOCOL_MAX_ID)) {
      return fail('sessionId is empty, oversized, or unsafe')
    }
    const binding = this.bySessionId.get(sessionId)
    if (!binding) {
      return fail('sessionId is unknown')
    }
    return { ok: true, value: binding }
  }

  /** Number of live bindings (test / diagnostics only). */
  size(): number {
    return this.bySessionId.size
  }
}
