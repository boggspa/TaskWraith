/**
 * The transactional persist's manifest and its recovery decisions
 * (Independent Threads M4, slice 6).
 *
 * A transactional persist writes a `prepare` record before it commits and
 * ends it with `abort`, `published` or, when recovery cannot tell,
 * `indeterminate`. The commit itself is a rename of the
 * client's artifact over `chats/<id>.json`, which keeps the artifact's inode,
 * so the file's identity is the commit witness:
 * - committed if and only if `lstat` of the chat file equals the manifest's
 *   resulting `{ dev, ino, size }`;
 * - not committed if the expected prior identity is still there, or the file
 *   is still absent where there was none;
 * - otherwise indeterminate.
 *
 * On restart, `decideHostTransactionRecovery` maps what recovery finds (the
 * command's receipt, its manifest, the chat file's identity and the delta
 * store's group for the command) to one action (Appendix D):
 * - D1, written and not published (and D2, whose torn group line is never
 *   visible): publish the group from the durable record, then complete the
 *   receipt at the group's end;
 * - D3, published and not completed: complete the receipt at the existing
 *   group, never a second group, or mark the manifest published when only
 *   that was left;
 * - D4, interrupted before the commit: fail the receipt as interrupted with
 *   zero effects, and record the abort;
 * - anything contradictory or unwitnessed: indeterminate, never re-executed.
 *   The manifest records it, and a receipt still pending is marked; a
 *   receipt already terminal is never rewritten.
 * Every action leaves a state this function then decides is done, so a
 * second recovery is a no-op. D5 (recover manifests before a generation
 * reset replays) and D6 (a delete refuses an older persist, which then never
 * prepares) are ordering rules owned by the recovery driver and the scope
 * ledger.
 *
 * Pure: no I/O. Unwired in this slice.
 */
import type { HostCursorPosition, HostReceiptStatus } from '../shared/hostProtocol'
import type { HostCommandExecutionClass } from './HostCommandExecutionClass'
import type { HostScopeEpoch } from './HostScopeLedger'

/** A file's identity as `lstat` reports it; dev and ino as decimal strings. */
export interface HostFileIdentity {
  readonly dev: string
  readonly ino: string
  readonly size: number
}

export interface HostTransactionPrepareRecord {
  readonly kind: 'prepare'
  readonly commandId: string
  readonly threadId: string
  /** The scope epoch the persist was admitted under. */
  readonly epoch: HostScopeEpoch
  readonly expectedRevision: number
  readonly resultingRevision: number
  /** The chat file before the commit; null when there was none. */
  readonly prior: HostFileIdentity | null
  /** The artifact the commit renames into place. */
  readonly resulting: HostFileIdentity
  /** The scope-complete effect set the group will carry. */
  readonly effects: { readonly count: number; readonly setDigest: string }
  readonly preparedAt: number
}

export interface HostTransactionAbortRecord {
  readonly kind: 'abort'
  readonly commandId: string
  readonly reason: string
  readonly at: number
}

export interface HostTransactionPublishedRecord {
  readonly kind: 'published'
  readonly commandId: string
  readonly position: HostCursorPosition
  readonly at: number
}

export interface HostTransactionIndeterminateRecord {
  readonly kind: 'indeterminate'
  readonly commandId: string
  readonly reason: string
  readonly at: number
}

export type HostTransactionRecord =
  | HostTransactionPrepareRecord
  | HostTransactionAbortRecord
  | HostTransactionPublishedRecord
  | HostTransactionIndeterminateRecord

export type HostCommitWitness = 'committed' | 'not_committed' | 'indeterminate'

/** The delta store's group line for a command, as recovery reads it. */
export interface HostTransactionGroup {
  readonly count: number
  readonly setDigest: string
  readonly end: HostCursorPosition
}

export interface HostTransactionRecoveryInput {
  /** The command's receipt, or null when the store has none. */
  readonly receipt: {
    readonly status: HostReceiptStatus
    /** The class `begin` recorded durably. */
    readonly commandClass: HostCommandExecutionClass
  } | null
  readonly prepare: HostTransactionPrepareRecord | null
  /** The manifest's terminal record for the command, if any. */
  readonly terminal: 'aborted' | 'published' | 'indeterminate' | null
  /** `lstat` of the chat file now; null when it is absent. */
  readonly observed: HostFileIdentity | null
  readonly group: HostTransactionGroup | null
}

export type HostTransactionIndeterminateReason =
  | 'receipt_missing'
  | 'group_without_manifest'
  | 'aborted_but_committed'
  | 'aborted_but_published'
  | 'aborted_but_succeeded'
  | 'published_without_group'
  | 'published_but_receipt_failed'
  | 'group_digest_mismatch'
  | 'group_without_commit'
  | 'group_but_receipt_failed'
  | 'committed_but_receipt_failed'
  | 'succeeded_without_group'
  | 'unknown_identity'

export type HostTransactionRecoveryAction =
  /** Nothing to recover: the command never began, or it ended consistently. */
  | { readonly action: 'none' }
  /** Not a transactional command: the existing recovery owns it. */
  | { readonly action: 'not_transactional' }
  /**
   * D1/D2: publish the group from the durable record, complete the receipt
   * at its end, and mark the manifest published.
   */
  | { readonly action: 'publish_and_complete'; readonly row: 'D1' }
  /** D3: complete the receipt at the existing group's end, then mark it published. */
  | {
      readonly action: 'complete_at_group'
      readonly row: 'D3'
      readonly position: HostCursorPosition
    }
  /** D3's tail: the receipt completed; only the manifest's mark is left. */
  | { readonly action: 'mark_published'; readonly row: 'D3'; readonly position: HostCursorPosition }
  /**
   * D4: fail the receipt as interrupted with zero effects. `writeAbort` says
   * whether the manifest still needs its abort record; `completeReceipt`
   * whether the receipt is still pending.
   */
  | {
      readonly action: 'fail_interrupted'
      readonly row: 'D4'
      readonly writeAbort: boolean
      readonly completeReceipt: boolean
    }
  /**
   * Contradictory or unwitnessed: never re-executed. Record it in the
   * manifest (when there is a prepare) and mark the receipt indeterminate
   * when it is still pending.
   */
  | { readonly action: 'indeterminate'; readonly reason: HostTransactionIndeterminateReason }

const SHA256_HEX = /^[0-9a-f]{64}$/
const DECIMAL = /^(0|[1-9][0-9]{0,39})$/
const MAX_ID_LENGTH = 512
const MAX_REASON_LENGTH = 256

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function isText(value: unknown, maxLength: number): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) return false
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return false
  }
  return true
}

function readIdentity(value: unknown): HostFileIdentity | null {
  if (
    !isRecord(value) ||
    typeof value.dev !== 'string' ||
    !DECIMAL.test(value.dev) ||
    typeof value.ino !== 'string' ||
    !DECIMAL.test(value.ino) ||
    !isNonNegativeSafeInteger(value.size)
  ) {
    return null
  }
  return Object.freeze({ dev: value.dev, ino: value.ino, size: value.size })
}

function readPosition(value: unknown): HostCursorPosition | null {
  return isRecord(value) &&
    isNonNegativeSafeInteger(value.generation) &&
    isNonNegativeSafeInteger(value.cursor)
    ? Object.freeze({ generation: value.generation, cursor: value.cursor })
    : null
}

export function sameHostFileIdentity(left: HostFileIdentity, right: HostFileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
}

/**
 * Parse one manifest record strictly; anything else is refused with a
 * reason. A prepare whose resulting identity is its prior one is refused:
 * the rename would witness nothing.
 */
export function parseHostTransactionRecord(
  value: unknown
):
  | { readonly ok: true; readonly record: HostTransactionRecord }
  | { readonly ok: false; readonly reason: string } {
  if (!isRecord(value) || !isText(value.commandId, MAX_ID_LENGTH)) {
    return { ok: false, reason: 'record_invalid' }
  }
  const commandId = value.commandId
  if (value.kind === 'abort' || value.kind === 'indeterminate') {
    if (!isText(value.reason, MAX_REASON_LENGTH) || !isNonNegativeSafeInteger(value.at)) {
      return { ok: false, reason: `${value.kind}_invalid` }
    }
    return {
      ok: true,
      record: Object.freeze({ kind: value.kind, commandId, reason: value.reason, at: value.at })
    }
  }
  if (value.kind === 'published') {
    const position = readPosition(value.position)
    if (position === null || !isNonNegativeSafeInteger(value.at)) {
      return { ok: false, reason: 'published_invalid' }
    }
    return {
      ok: true,
      record: Object.freeze({ kind: 'published', commandId, position, at: value.at })
    }
  }
  if (value.kind !== 'prepare') return { ok: false, reason: 'kind_invalid' }
  const epoch = value.epoch
  const effects = value.effects
  const prior = value.prior === null ? null : readIdentity(value.prior)
  const resulting = readIdentity(value.resulting)
  if (
    !isText(value.threadId, MAX_ID_LENGTH) ||
    !isRecord(epoch) ||
    !isText(epoch.hostIncarnation, 256) ||
    !isNonNegativeSafeInteger(epoch.deleteCounter) ||
    !isNonNegativeSafeInteger(value.expectedRevision) ||
    !isNonNegativeSafeInteger(value.resultingRevision) ||
    value.resultingRevision <= value.expectedRevision ||
    (value.prior !== null && prior === null) ||
    resulting === null ||
    !isRecord(effects) ||
    !isNonNegativeSafeInteger(effects.count) ||
    typeof effects.setDigest !== 'string' ||
    !SHA256_HEX.test(effects.setDigest) ||
    !isNonNegativeSafeInteger(value.preparedAt)
  ) {
    return { ok: false, reason: 'prepare_invalid' }
  }
  if (prior !== null && sameHostFileIdentity(prior, resulting)) {
    return { ok: false, reason: 'prepare_witnesses_nothing' }
  }
  return {
    ok: true,
    record: Object.freeze({
      kind: 'prepare',
      commandId,
      threadId: value.threadId,
      epoch: Object.freeze({
        hostIncarnation: epoch.hostIncarnation,
        deleteCounter: epoch.deleteCounter
      }),
      expectedRevision: value.expectedRevision,
      resultingRevision: value.resultingRevision,
      prior,
      resulting,
      effects: Object.freeze({ count: effects.count, setDigest: effects.setDigest }),
      preparedAt: value.preparedAt
    })
  }
}

/** Whether the chat file shows this prepare's commit. */
export function hostCommitWitness(
  prepare: HostTransactionPrepareRecord,
  observed: HostFileIdentity | null
): HostCommitWitness {
  if (observed !== null && sameHostFileIdentity(observed, prepare.resulting)) return 'committed'
  if (prepare.prior === null) return observed === null ? 'not_committed' : 'indeterminate'
  return observed !== null && sameHostFileIdentity(observed, prepare.prior)
    ? 'not_committed'
    : 'indeterminate'
}

const NONE: HostTransactionRecoveryAction = Object.freeze({ action: 'none' })

function indeterminate(reason: HostTransactionIndeterminateReason): HostTransactionRecoveryAction {
  return { action: 'indeterminate', reason }
}

/** The one recovery action for a command, per Appendix D. */
export function decideHostTransactionRecovery(
  input: HostTransactionRecoveryInput
): HostTransactionRecoveryAction {
  const { receipt, prepare, terminal, observed, group } = input
  if (receipt === null) {
    return prepare === null || terminal === 'indeterminate'
      ? NONE
      : indeterminate('receipt_missing')
  }
  if (receipt.commandClass !== 'txn-record-persist') return { action: 'not_transactional' }
  // Indeterminate is final: nothing is re-executed or decided again.
  if (terminal === 'indeterminate' || receipt.status === 'indeterminate') return NONE
  const receiptDone = receipt.status !== 'pending'
  const succeeded = receipt.status === 'succeeded'

  // No manifest: admitted and never prepared (a queued persist interrupted
  // before its turn, or one the lane refused), or one compaction dropped
  // after the command finished.
  if (prepare === null) {
    if (receiptDone) return NONE
    if (group !== null) return indeterminate('group_without_manifest')
    return { action: 'fail_interrupted', row: 'D4', writeAbort: false, completeReceipt: true }
  }

  const groupMatches =
    group !== null &&
    group.count === prepare.effects.count &&
    group.setDigest === prepare.effects.setDigest

  // Published: judged on its records alone. Later commits replace the chat
  // file, and a freed inode can come back, so the witness no longer speaks.
  if (terminal === 'published') {
    if (group === null) return indeterminate('published_without_group')
    if (!groupMatches) return indeterminate('group_digest_mismatch')
    if (!receiptDone) return { action: 'complete_at_group', row: 'D3', position: group.end }
    return succeeded ? NONE : indeterminate('published_but_receipt_failed')
  }

  const witness = hostCommitWitness(prepare, observed)

  if (terminal === 'aborted') {
    if (succeeded) return indeterminate('aborted_but_succeeded')
    if (group !== null) return indeterminate('aborted_but_published')
    if (receiptDone) return NONE
    if (witness === 'committed') return indeterminate('aborted_but_committed')
    return { action: 'fail_interrupted', row: 'D4', writeAbort: false, completeReceipt: true }
  }

  // Prepared and unresolved: nothing has written the chat file since.
  if (group !== null) {
    if (!groupMatches) return indeterminate('group_digest_mismatch')
    if (witness === 'not_committed') return indeterminate('group_without_commit')
    if (!receiptDone) return { action: 'complete_at_group', row: 'D3', position: group.end }
    return succeeded
      ? { action: 'mark_published', row: 'D3', position: group.end }
      : indeterminate('group_but_receipt_failed')
  }
  if (succeeded) return indeterminate('succeeded_without_group')
  if (witness === 'indeterminate') return indeterminate('unknown_identity')
  if (witness === 'committed') {
    // A durable record whose receipt already failed cannot be put right here.
    return receiptDone
      ? indeterminate('committed_but_receipt_failed')
      : { action: 'publish_and_complete', row: 'D1' }
  }
  // Not committed: the record is unchanged and nothing was published.
  return {
    action: 'fail_interrupted',
    row: 'D4',
    writeAbort: true,
    completeReceipt: !receiptDone
  }
}
