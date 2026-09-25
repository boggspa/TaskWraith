/**
 * Execution class per Host command (Independent Threads M4, slice 1).
 *
 * M4 moves `thread.record.persist` onto a transactional per-thread lane while
 * every other command keeps today's path. The authority is to decide that
 * from this closed map, never from a command's shape: a `threadId` target
 * admits nothing. (Today the standalone Host holds every command that targets
 * a thread behind that thread's recovery gate; that is a recovery rule, not
 * an execution class.)
 *
 * - `txn-record-persist`: the transactional lane. Only `thread.record.persist`,
 *   and only while `TASKWRAITH_HOST_TXN_PERSIST` is on; off, it runs as
 *   `legacy-observed`, exactly as today.
 * - `legacy-observed`: the projection FIFO, a before and an after capture, and
 *   one durable effect batch (`AppStoreHostAuthority.executeAllowedMutation`).
 * - `control`: skips the FIFO so that a queued start waiting on capacity can be
 *   released (cancel, approval, answer); still validated, governed and
 *   observed. Under M4 these hold the commit gate's observer mode across their
 *   captures.
 * - `queued-start`: `composer.send` while a queued-start publication is wired
 *   (M2, `TASKWRAITH_HOST_QUEUED_START`); otherwise `legacy-observed`.
 * - `setup`: the setup executor's window.
 *
 * The four Authority-RPC read aliases never execute as commands, so they have
 * no class and classify as null. Nothing here is wired yet; the integration
 * slice routes the authority through it and records the class on the receipt.
 */

import type { HostCommandName } from '../shared/hostProtocol'
import { HOST_COMMAND_ROUTING_CLASS, parseHostCommandName } from './HostCommandRouting'

export type HostCommandExecutionClass =
  | 'txn-record-persist'
  | 'legacy-observed'
  | 'control'
  | 'queued-start'
  | 'setup'

type HostReadAliasName = {
  [Name in HostCommandName]: (typeof HOST_COMMAND_ROUTING_CLASS)[Name] extends 'authority-rpc-read-alias'
    ? Name
    : never
}[HostCommandName]

/** Every command that executes through the authority's command path. */
export type HostExecutingCommandName = Exclude<HostCommandName, HostReadAliasName>

/**
 * Each executing command's class with both flags on. A command added without
 * an entry, or a read alias given one, fails typecheck.
 */
export const HOST_COMMAND_EXECUTION_CLASS = {
  'thread.record.persist': 'txn-record-persist',
  'composer.send': 'queued-start',
  'run.cancel': 'control',
  'question.answer': 'control',
  'approval.decide': 'control',
  'ensemble.seat.toggle': 'legacy-observed',
  'thread.record.delete': 'legacy-observed',
  'thread.select': 'legacy-observed',
  'channel.member.revoke': 'legacy-observed',
  'channel.close': 'legacy-observed',
  'workspace.record.upsert': 'legacy-observed',
  'workspace.record.remove': 'legacy-observed',
  'workspace.records.clear': 'legacy-observed',
  'workspace.register': 'setup',
  'thread.create': 'setup',
  'thread.configure': 'setup',
  'thread.archive': 'setup',
  'provider.auth.begin': 'setup',
  'provider.auth.cancel': 'setup'
} as const satisfies Record<HostExecutingCommandName, HostCommandExecutionClass>

/** Stable order derived from the typed map keys (no parallel catalogue). */
export const HOST_EXECUTING_COMMAND_NAMES = Object.freeze(
  Object.keys(HOST_COMMAND_EXECUTION_CLASS) as HostExecutingCommandName[]
) as readonly HostExecutingCommandName[]

/** The flags that decide whether a command takes its M2 or M4 path. */
export interface HostCommandExecutionFlags {
  /** `TASKWRAITH_HOST_TXN_PERSIST`, read once when the Host starts. */
  readonly txnRecordPersist: boolean
  /** Whether a queued-start publication is wired (M2). */
  readonly queuedStart: boolean
}

/** M4 gate for the transactional persist lane. Default OFF. */
export const TASKWRAITH_HOST_TXN_PERSIST_ENV = 'TASKWRAITH_HOST_TXN_PERSIST'

/** Only the exact token `1` enables. Enabling is a harness decision. */
export function isHostTxnRecordPersistEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env
): boolean {
  return env[TASKWRAITH_HOST_TXN_PERSIST_ENV] === '1'
}

function isExecutingCommandName(name: HostCommandName): name is HostExecutingCommandName {
  return Object.prototype.hasOwnProperty.call(HOST_COMMAND_EXECUTION_CLASS, name)
}

/** The class a known executing command runs under with these flags. */
export function hostCommandExecutionClassFor(
  name: HostExecutingCommandName,
  flags: HostCommandExecutionFlags
): HostCommandExecutionClass {
  const target: HostCommandExecutionClass = HOST_COMMAND_EXECUTION_CLASS[name]
  if (target === 'txn-record-persist') {
    return flags.txnRecordPersist === true ? target : 'legacy-observed'
  }
  if (target === 'queued-start') return flags.queuedStart === true ? target : 'legacy-observed'
  return target
}

/**
 * Classify an untrusted command name. Unknown names and read aliases fail
 * closed (null): neither may execute.
 */
export function classifyHostCommandExecution(
  value: unknown,
  flags: HostCommandExecutionFlags
): HostCommandExecutionClass | null {
  const name = parseHostCommandName(value)
  if (name === null || !isExecutingCommandName(name)) return null
  return hostCommandExecutionClassFor(name, flags)
}
