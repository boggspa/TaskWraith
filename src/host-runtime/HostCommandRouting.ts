/**
 * Exhaustive HostCommandName routing classification (Wave 2D-1 Lane A).
 *
 * Separates reserved Authority-RPC read aliases from governed mutations so a
 * later command() integration can fail closed on path misuse. This module does
 * not execute commands, fingerprint, validate arguments, or integrate into
 * HostAuthority.command().
 *
 * Single typed catalog: HOST_COMMAND_ROUTING_CLASS is checked against
 * HostCommandName via `satisfies Record`. There is no second untyped
 * command-name string list.
 */

import type { HostCommandName } from '../shared/hostProtocol'

/**
 * Authority-RPC read aliases map to dedicated HostAuthority methods
 * (snapshot / deltas / receipt / health-style ping). They must not enter the
 * durable governed command() mutation path.
 */
export type HostCommandRoutingClass = 'authority-rpc-read-alias' | 'governed-mutation'

/**
 * Compile-time exhaustive routing table. Adding a HostCommandName without an
 * entry fails typecheck via `satisfies Record`.
 */
export const HOST_COMMAND_ROUTING_CLASS = {
  'snapshot.get': 'authority-rpc-read-alias',
  'deltas.since': 'authority-rpc-read-alias',
  'receipt.lookup': 'authority-rpc-read-alias',
  ping: 'authority-rpc-read-alias',
  'composer.send': 'governed-mutation',
  'run.cancel': 'governed-mutation',
  'question.answer': 'governed-mutation',
  'approval.decide': 'governed-mutation',
  'ensemble.seat.toggle': 'governed-mutation',
  'channel.member.revoke': 'governed-mutation',
  'channel.close': 'governed-mutation',
  'thread.select': 'governed-mutation'
} as const satisfies Record<HostCommandName, HostCommandRoutingClass>

/** Stable order derived from the typed routing map keys (no parallel catalog). */
export const HOST_COMMAND_NAMES = Object.freeze(
  Object.keys(HOST_COMMAND_ROUTING_CLASS) as HostCommandName[]
) as readonly HostCommandName[]

export const HOST_AUTHORITY_RPC_READ_ALIAS_NAMES = Object.freeze(
  HOST_COMMAND_NAMES.filter(
    (name) => HOST_COMMAND_ROUTING_CLASS[name] === 'authority-rpc-read-alias'
  )
) as readonly HostCommandName[]

export const HOST_GOVERNED_MUTATION_COMMAND_NAMES = Object.freeze(
  HOST_COMMAND_NAMES.filter((name) => HOST_COMMAND_ROUTING_CLASS[name] === 'governed-mutation')
) as readonly HostCommandName[]

type AssertExhaustivePartition =
  typeof HOST_COMMAND_ROUTING_CLASS extends Record<HostCommandName, HostCommandRoutingClass>
    ? true
    : never

const _exhaustivePartitionOk: AssertExhaustivePartition = true
void _exhaustivePartitionOk

function isKnownHostCommandName(value: string): value is HostCommandName {
  return Object.prototype.hasOwnProperty.call(HOST_COMMAND_ROUTING_CLASS, value)
}

/**
 * Parse an untrusted value as HostCommandName.
 * Unknown / non-string input fails closed (null). No permissive default.
 */
export function parseHostCommandName(value: unknown): HostCommandName | null {
  if (typeof value !== 'string') return null
  if (!isKnownHostCommandName(value)) return null
  return value
}

/**
 * Classify a known HostCommandName. Exhaustive on the typed input.
 */
export function hostCommandRoutingClassFor(name: HostCommandName): HostCommandRoutingClass {
  return HOST_COMMAND_ROUTING_CLASS[name]
}

/**
 * Classify untrusted input. Returns null when the name is not a known
 * HostCommandName (fail closed for later command() integration).
 */
export function classifyHostCommandName(value: unknown): HostCommandRoutingClass | null {
  const name = parseHostCommandName(value)
  if (!name) return null
  return HOST_COMMAND_ROUTING_CLASS[name]
}

export function isAuthorityRpcReadAliasName(name: HostCommandName): boolean {
  return HOST_COMMAND_ROUTING_CLASS[name] === 'authority-rpc-read-alias'
}

export function isGovernedMutationCommandName(name: HostCommandName): boolean {
  return HOST_COMMAND_ROUTING_CLASS[name] === 'governed-mutation'
}

/**
 * Gate for a future durable command() path: only governed mutations may enter.
 * Reserved Authority-RPC read aliases and unknown names fail closed (null).
 */
export function parseGovernedMutationCommandName(value: unknown): HostCommandName | null {
  const name = parseHostCommandName(value)
  if (!name) return null
  if (HOST_COMMAND_ROUTING_CLASS[name] !== 'governed-mutation') return null
  return name
}

/**
 * Gate for reserved Authority-RPC read aliases (snapshot/deltas/receipt/ping).
 * Governed mutations and unknown names fail closed (null).
 */
export function parseAuthorityRpcReadAliasName(value: unknown): HostCommandName | null {
  const name = parseHostCommandName(value)
  if (!name) return null
  if (HOST_COMMAND_ROUTING_CLASS[name] !== 'authority-rpc-read-alias') return null
  return name
}
