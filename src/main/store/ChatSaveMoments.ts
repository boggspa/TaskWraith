/**
 * The moments one save contains: what the user is told is done, and so what
 * must wait for the disk now that a save itself does not sync (the tickets in
 * `ChatDurabilityTickets` hold that wait).
 *
 * - `user_message`: a row the user wrote is added (composer, steer, a round's
 *   prompt, a remote or command-line send, a scheduled send), a row of theirs
 *   is rewritten (edit and resend), or a prompt is queued for an ensemble
 *   round. Rows with the user's role that the user did not write are not: an
 *   agent's prompt to a sub-thread, an execution graph's stage prompt, a
 *   collaborator's comment and anything else marked external, a retired
 *   channel's inbound row, an imported provider thread.
 * - `decision`: the reply to an agent's question, a proposed plan approved or
 *   dismissed, or a path granted or revoked. A tool approval is recorded, and
 *   synced, in the approval ledger before any save reflects it; the save that
 *   records a path granted from an approval comes before that.
 * - `run_final`: a run reaches a status that is not live, with its id. Read
 *   from the run's own transition and never from the flush reason, which says
 *   `terminal` only when no run on the thread is live: on a thread with many
 *   seats most final records arrive under `normal`.
 * - `destructive`: the batch removes transcript rows, or the save is the
 *   deletion flush.
 * Streamed output, a run starting and an approval opening are not moments.
 *
 * Read from what the save already has: its batch, the renderer operations
 * derived with it, its flush reason, and the few parts of the record before
 * it that the batch points at. It never walks the record. Beyond the batch it
 * reads:
 * - the ids of the rows a splice removed, and only when the batch puts back at
 *   least as many rows as it removed, to tell a moved row from a removed one;
 * - the runs from the newest back to the oldest run the batch writes as
 *   finished, to tell a run reaching its end from a finished run written
 *   again; a seat that ends reads the runs started after it;
 * - an ensemble round's queued prompts and the thread's path grants, when the
 *   batch changes the ensemble or the provider metadata.
 * A batch that removes more rows than it puts back is destructive without
 * reading which went, and each row it puts back is then read as new: a moved
 * row of the user's would count as a message, which waits for the same
 * barrier the removal already does. A rewrite of a decided plan's metadata is
 * read as the decision again, which costs one barrier.
 *
 * A fork is created empty and its rows are copied in by the save that marks
 * it a fork (`forkContext`). They are copies, not messages, so the rows that
 * save puts in are not read at all.
 *
 * A save that creates a thread has no batch: its first checkpoint, written
 * without a sync since 0883f8f97, holds the whole record.
 * `classifyCreatedChatMoments` reads it as the user's message when one of the
 * rows it created is one the user wrote, in one pass that stops at the first,
 * and a thread created as a fork as nothing. A save whose append failed is not
 * classified: the Host's record holds it.
 */
import { isActiveChatRunStatus } from '../../shared/chatRunStatus'
import type { ChatUpdateTranscriptOp } from '../../shared/chatUpdateTransport'
import { isExternalProviderThreadImportMessage } from '../../shared/externalProviderThreadImport'
import { isRetiredExternalChannelInboundMessage } from '../LegacyExternalChannelHistory'
import { EXTERNAL_CONTRIBUTION_TAG } from '../collaboration/ExternalContributionContext'
import {
  isExternalUntrustedMessage,
  isHumanCollaboratorComment
} from '../collaboration/HumanCollaboratorMessages'
import type { ChatRecordMutationOperation } from './ChatRecordMutation'
import { collectExternalPathGrantsFromMetadata } from './ExternalPathGrants'
import type { FlushReason } from './saveCoalescer'
import type { ChatMessage, ChatRecord, ChatRun } from './types'

export type ChatSaveMoment =
  | { moment: 'user_message' }
  | { moment: 'decision' }
  | { moment: 'run_final'; runId: string }
  | { moment: 'destructive' }

export interface ChatSaveMomentsInput {
  /** The record the batch was derived from. */
  previous: ChatRecord
  /** The record the save wrote. */
  next: ChatRecord
  /** The operations of the batch the save appended, in order. */
  operations: readonly ChatRecordMutationOperation[]
  /** The renderer operations derived with the batch; null when the save needs a snapshot instead. */
  transcriptOps?: readonly ChatUpdateTranscriptOp[] | null
  flushReason: FlushReason
}

/** Kinds of row with the user's role that the user did not write. */
const NOT_WRITTEN_BY_THE_USER = new Set(['subThreadDelegation', 'executionGraphAttempt'])
const DECIDED_PLAN_STATUSES = new Set(['approved', 'dismissed'])

/** What adding or rewriting this row means, if anything. */
function rowMoment(row: ChatMessage | null | undefined): 'user_message' | 'decision' | null {
  if (row?.role !== 'user') return null
  const kind = row.metadata?.kind
  if (kind === 'agentQuestionReply') return 'decision'
  if (typeof kind === 'string' && NOT_WRITTEN_BY_THE_USER.has(kind)) return null
  if (
    isHumanCollaboratorComment(row) ||
    isExternalUntrustedMessage(row) ||
    isRetiredExternalChannelInboundMessage(row) ||
    isExternalProviderThreadImportMessage(row) ||
    (typeof row.content === 'string' && row.content.includes(`<${EXTERNAL_CONTRIBUTION_TAG}`))
  ) {
    return null
  }
  return 'user_message'
}

function decidesPlan(metadata: unknown): boolean {
  const plan = (metadata as { proposedPlan?: { status?: unknown } } | null | undefined)
    ?.proposedPlan
  return typeof plan?.status === 'string' && DECIDED_PLAN_STATUSES.has(plan.status)
}

function isFinished(run: Pick<ChatRun, 'status'> | null | undefined): boolean {
  return typeof run?.status === 'string' && run.status !== '' && !isActiveChatRunStatus(run.status)
}

function touches(
  operation: { set: Record<string, unknown>; clear: string[] },
  key: string
): boolean {
  return Object.prototype.hasOwnProperty.call(operation.set, key) || operation.clear.includes(key)
}

/** Positions of the transcript as the batch's splices leave them: previous rows by range, inserted rows by value. */
type Segment = { from: number; to: number } | { rows: readonly ChatMessage[] }

function segmentLength(segment: Segment): number {
  return 'rows' in segment ? segment.rows.length : segment.to - segment.from
}

function sliceSegment(segment: Segment, start: number, end: number): Segment {
  return 'rows' in segment
    ? { rows: segment.rows.slice(start, end) }
    : { from: segment.from + start, to: segment.from + end }
}

/**
 * Applies one splice to positions. A splice counts positions as the batch's
 * earlier operations left them, as the journal applies them; the previous
 * rows it removes are added to `removed` as ranges of the previous record.
 */
function spliceSegments(
  segments: Segment[],
  index: number,
  deleteCount: number,
  rows: readonly ChatMessage[],
  removed: Array<{ from: number; to: number }>
): Segment[] {
  const before: Segment[] = []
  const after: Segment[] = []
  const deleteEnd = index + deleteCount
  let start = 0
  for (const segment of segments) {
    const size = segmentLength(segment)
    const end = start + size
    const cutFrom = Math.max(start, Math.min(end, index)) - start
    const cutTo = Math.max(start, Math.min(end, deleteEnd)) - start
    if (cutFrom > 0) before.push(cutFrom === size ? segment : sliceSegment(segment, 0, cutFrom))
    if (cutTo > cutFrom && !('rows' in segment)) {
      removed.push({ from: segment.from + cutFrom, to: segment.from + cutTo })
    }
    if (cutTo < size) after.push(cutTo === 0 ? segment : sliceSegment(segment, cutTo, size))
    start = end
  }
  return rows.length > 0 ? [...before, { rows }, ...after] : [...before, ...after]
}

/** These runs as the previous record had them, read from its newest run back until all are found. */
function previousRuns(runs: readonly ChatRun[], runIds: Set<string>): Map<string, ChatRun> {
  const found = new Map<string, ChatRun>()
  for (let index = runs.length - 1; index >= 0 && found.size < runIds.size; index -= 1) {
    const run = runs[index]
    if (run && runIds.has(run.runId) && !found.has(run.runId)) found.set(run.runId, run)
  }
  return found
}

function queuedPromptIds(record: ChatRecord): Set<string> {
  const entries = record.ensemble?.activeRound?.queuedPromptEntries
  const ids = new Set<string>()
  if (Array.isArray(entries)) for (const entry of entries) if (entry?.id) ids.add(entry.id)
  return ids
}

function grantIds(record: ChatRecord): Set<string> {
  return new Set(collectExternalPathGrantsFromMetadata(record.providerMetadata).map((g) => g.id))
}

function sameSet(left: Set<string>, right: Set<string>): boolean {
  if (left.size !== right.size) return false
  for (const value of left) if (!right.has(value)) return false
  return true
}

/**
 * The moments of a save that created the thread `record`: the user's message
 * when a row it created is one the user wrote. Rows are read in order up to
 * the first of the user's; a fork's rows are copies and are not read.
 */
export function classifyCreatedChatMoments(record: ChatRecord): ChatSaveMoment[] {
  if (record.forkContext) return []
  const rows = Array.isArray(record.messages) ? record.messages : []
  for (const row of rows) {
    if (rowMoment(row) === 'user_message') return [{ moment: 'user_message' }]
  }
  return []
}

export function classifyChatSaveMoments(input: ChatSaveMomentsInput): ChatSaveMoment[] {
  const { previous, next, operations, transcriptOps } = input
  let userMessage = false
  let decision = false
  let destructive = input.flushReason === 'history-deletion'
  let segments: Segment[] | null = null
  const removed: Array<{ from: number; to: number }> = []
  /** Rows whose content the batch changed in place. */
  let rewritten: Set<string> | null = null
  /** Runs the batch writes as finished, and whether each was already in the record. */
  const finishing = new Map<string, { existed: boolean }>()
  let runSplice: { index: number; deleteCount: number; runs: readonly ChatRun[] } | null = null
  let ensembleChanged = false
  let grantsMayHaveChanged = false
  /** The save that marks the thread a fork, whose rows it puts in are copies. */
  let forkCopy = false

  for (const operation of operations) {
    switch (operation.type) {
      case 'messages_splice':
        segments = spliceSegments(
          segments ?? [{ from: 0, to: previous.messages.length }],
          operation.index,
          operation.deleteCount,
          operation.messages,
          removed
        )
        break
      case 'message_put': {
        const moment = rowMoment(operation.message)
        if (moment === 'user_message') userMessage = true
        if (moment === 'decision' || decidesPlan(operation.message.metadata)) decision = true
        break
      }
      case 'message_patch':
        if (touches(operation, 'content')) (rewritten ??= new Set()).add(operation.messageId)
        if (decidesPlan(operation.set.metadata)) decision = true
        break
      case 'message_content_append':
        ;(rewritten ??= new Set()).add(operation.messageId)
        break
      case 'run_put':
        if (isFinished(operation.run)) finishing.set(operation.runId, { existed: true })
        break
      case 'runs_splice':
        runSplice = operation
        for (const run of operation.runs) {
          if (isFinished(run)) finishing.set(run.runId, { existed: false })
        }
        break
      case 'record_patch':
        if (touches(operation, 'ensemble')) ensembleChanged = true
        if (touches(operation, 'providerMetadata')) grantsMayHaveChanged = true
        if (touches(operation, 'forkContext') && !previous.forkContext && next.forkContext) {
          forkCopy = true
        }
        break
      case 'ensemble_patch':
        ensembleChanged = true
        break
      default:
        break
    }
  }

  if (segments) {
    const placed = segments
    let insertedRows: ChatMessage[] | null = null
    const inserted = (): ChatMessage[] =>
      (insertedRows ??= placed.flatMap((segment) => ('rows' in segment ? segment.rows : [])))
    const insertedCount = placed.reduce(
      (count, segment) => count + ('rows' in segment ? segment.rows.length : 0),
      0
    )
    const removedCount = removed.reduce((count, range) => count + range.to - range.from, 0)
    let moved: Set<string> | null = null
    if (removedCount > insertedCount) {
      destructive = true
    } else if (removedCount > 0) {
      const insertedIds = new Set(inserted().map((row) => row.id))
      moved = new Set()
      for (const range of removed) {
        for (let index = range.from; index < range.to; index += 1) {
          const id = previous.messages[index]?.id
          if (id !== undefined && insertedIds.has(id)) moved.add(id)
          else destructive = true
        }
      }
    }
    for (const row of forkCopy ? [] : inserted()) {
      if (moved?.has(row.id)) continue
      const moment = rowMoment(row)
      if (moment === 'user_message') userMessage = true
      if (moment === 'decision') decision = true
    }
  }

  if (rewritten && transcriptOps) {
    for (const operation of transcriptOps) {
      if (operation.op !== 'update' || !rewritten.has(operation.id)) continue
      const moment = rowMoment(operation.message)
      if (moment === 'user_message') userMessage = true
      if (moment === 'decision') decision = true
    }
  }

  if (ensembleChanged && !userMessage) {
    const queued = queuedPromptIds(previous)
    for (const id of queuedPromptIds(next)) if (!queued.has(id)) userMessage = true
  }

  if (grantsMayHaveChanged && !decision && !sameSet(grantIds(previous), grantIds(next))) {
    decision = true
  }

  const finals: string[] = []
  if (finishing.size > 0) {
    // A run the splice put back after removing it was in the record before.
    if (runSplice && runSplice.deleteCount > 0 && runSplice.deleteCount <= runSplice.runs.length) {
      for (let offset = 0; offset < runSplice.deleteCount; offset += 1) {
        const run = previous.runs[runSplice.index + offset]
        const entry = run && finishing.get(run.runId)
        if (entry && !entry.existed && isFinished(run)) finishing.delete(run.runId)
      }
    }
    const lookup = new Set<string>()
    for (const [runId, entry] of finishing) if (entry.existed) lookup.add(runId)
    const before = lookup.size > 0 ? previousRuns(previous.runs, lookup) : null
    for (const [runId, entry] of finishing) {
      if (entry.existed && isFinished(before?.get(runId))) continue
      finals.push(runId)
    }
  }

  const moments: ChatSaveMoment[] = []
  if (userMessage) moments.push({ moment: 'user_message' })
  if (decision) moments.push({ moment: 'decision' })
  for (const runId of finals) moments.push({ moment: 'run_final', runId })
  if (destructive) moments.push({ moment: 'destructive' })
  return moments
}
