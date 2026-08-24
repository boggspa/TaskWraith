/**
 * Exhaustive store ↔ wire Host authority decision vocabulary map.
 *
 * Store (HostCommandReceiptStore): allowed | denied | deferred
 * Wire (hostProtocol HostAuthorityDecision): allow | deny | ask
 *
 * Unknown / untrusted input fails closed (null). No permissive default.
 * Pure / Electron-free — decision tokens only; reason/policy projection
 * belongs to a later receipt projector.
 */

import type { HostAuthorityDecision } from '../../shared/hostProtocol'
import type { HostCommandAuthorityDecision } from '../../host-runtime/HostCommandReceiptStore'

/** Wire authority.decision tokens. */
export type HostWireAuthorityDecision = HostAuthorityDecision['decision']

/** Store authority.decision tokens. */
export type HostStoreAuthorityDecision = HostCommandAuthorityDecision

export const HOST_STORE_AUTHORITY_DECISIONS = [
  'allowed',
  'denied',
  'deferred'
] as const satisfies readonly HostStoreAuthorityDecision[]

export const HOST_WIRE_AUTHORITY_DECISIONS = [
  'allow',
  'deny',
  'ask'
] as const satisfies readonly HostWireAuthorityDecision[]

/**
 * Compile-time exhaustive store → wire table. Adding a store decision without
 * a wire peer fails typecheck via `satisfies Record`.
 */
export const HOST_STORE_TO_WIRE_AUTHORITY_DECISION = {
  allowed: 'allow',
  denied: 'deny',
  deferred: 'ask'
} as const satisfies Record<HostStoreAuthorityDecision, HostWireAuthorityDecision>

/**
 * Compile-time exhaustive wire → store table. Adding a wire decision without
 * a store peer fails typecheck via `satisfies Record`.
 */
export const HOST_WIRE_TO_STORE_AUTHORITY_DECISION = {
  allow: 'allowed',
  deny: 'denied',
  ask: 'deferred'
} as const satisfies Record<HostWireAuthorityDecision, HostStoreAuthorityDecision>

type AssertBijection<
  Forward extends Record<string, string>,
  Reverse extends Record<string, string>
> = {
  [K in keyof Forward & string]: Reverse[Forward[K] & keyof Reverse] extends K ? true : never
}[keyof Forward & string] extends true
  ? true
  : never

// Fail compile if either direction is not the exact inverse of the other.
const _storeToWireBijectionOk: AssertBijection<
  typeof HOST_STORE_TO_WIRE_AUTHORITY_DECISION,
  typeof HOST_WIRE_TO_STORE_AUTHORITY_DECISION
> = true
const _wireToStoreBijectionOk: AssertBijection<
  typeof HOST_WIRE_TO_STORE_AUTHORITY_DECISION,
  typeof HOST_STORE_TO_WIRE_AUTHORITY_DECISION
> = true

void _storeToWireBijectionOk
void _wireToStoreBijectionOk

function isHostStoreAuthorityDecision(value: string): value is HostStoreAuthorityDecision {
  return value === 'allowed' || value === 'denied' || value === 'deferred'
}

function isHostWireAuthorityDecision(value: string): value is HostWireAuthorityDecision {
  return value === 'allow' || value === 'deny' || value === 'ask'
}

/**
 * Map a store authority decision token to the wire token.
 * Returns null for unknown / non-string input (fail closed).
 */
export function mapHostStoreAuthorityDecisionToWire(
  value: unknown
): HostWireAuthorityDecision | null {
  if (typeof value !== 'string') return null
  if (!isHostStoreAuthorityDecision(value)) return null
  return HOST_STORE_TO_WIRE_AUTHORITY_DECISION[value]
}

/**
 * Map a wire authority decision token to the store token.
 * Returns null for unknown / non-string input (fail closed).
 */
export function mapHostWireAuthorityDecisionToStore(
  value: unknown
): HostStoreAuthorityDecision | null {
  if (typeof value !== 'string') return null
  if (!isHostWireAuthorityDecision(value)) return null
  return HOST_WIRE_TO_STORE_AUTHORITY_DECISION[value]
}
