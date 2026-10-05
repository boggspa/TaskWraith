import { isThreadTitleRepairTarget, deriveThreadTitleFromTranscript } from './ThreadTitleRepair'
import type {
  FoldedLogOutcome,
  StaleChatRunSettlement,
  TerminalChatRunRecovery,
  ThreadFoldLogBatch
} from '../../shared/threadCatalogueTypes'
import { ThreadCatalogueRequestError } from '../../shared/threadCatalogueRequestError'
import { isThreadLogBatch, type ThreadLogBatch } from '../../host-shared/thread-log/ThreadLogBatch'
import { applyThreadLogBatches } from '../../host-shared/thread-log/ThreadLogApply'
import * as fs from 'node:fs'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { reconcileStaleChatRuns } from '../ChatRunReconciler'
import { pruneExpiredBlackboardEntries } from '../blackboard/Blackboard'
import { recoverSubThreadWorkerControl } from '../SubThreadWorkerControl'
import {
  ThreadCatalogueDiskReader,
  type ThreadCatalogueReaderOptions
} from './ThreadCatalogueDiskReader'
import { projectThreadCatalogueRecord } from './ThreadCatalogueFromRecord'
import { encodeThreadJsonChunks } from './ThreadCatalogueJson'
import {
  INCREMENTAL_CHAT_CHECKPOINT_FORMAT,
  INCREMENTAL_CHAT_CHECKPOINT_VERSION
} from './IncrementalChatJournal'
import type { ThreadCatalogueEpoch, ThreadCatalogueSourceHeads } from './ThreadCatalogue'
import type { ChatRecord } from './types'

export type {
  ThreadCatalogueMutation,
  PreparedThreadFile,
  PreparedThreadMutation
} from '../../shared/threadCatalogueTypes'
import type {
  ThreadCatalogueMutation,
  PreparedThreadFile,
  PreparedThreadMutation
} from '../../shared/threadCatalogueTypes'
export { preparedThreadDirectory } from '../../host-shared/thread-catalogue/ThreadCataloguePreparedPath'
import { preparedThreadDirectory } from '../../host-shared/thread-catalogue/ThreadCataloguePreparedPath'

function writePrepared(directory: string, name: string, value: unknown): PreparedThreadFile {
  const file = join(directory, name)
  const fd = fs.openSync(file, 'wx', 0o600)
  const hash = createHash('sha256')
  let byteLength = 0
  try {
    for (const chunk of encodeThreadJsonChunks(value)) {
      let offset = 0
      while (offset < chunk.byteLength)
        offset += fs.writeSync(fd, chunk, offset, chunk.byteLength - offset)
      hash.update(chunk)
      byteLength += chunk.byteLength
    }
    fs.fsyncSync(fd)
    const stat = fs.fstatSync(fd, { bigint: true })
    return {
      name,
      byteLength,
      sha256: hash.digest('hex'),
      device: String(stat.dev),
      inode: String(stat.ino),
      modified: String(stat.mtimeNs),
      changed: String(stat.ctimeNs)
    }
  } finally {
    fs.closeSync(fd)
  }
}

/** Decoder-only preparation. The source owner rechecks liveness and source identity before adoption. */
export function prepareThreadCatalogueMutation(
  options: ThreadCatalogueReaderOptions,
  input: {
    chatId: string
    sourceWitness: string
    epoch: ThreadCatalogueEpoch
    heads: ThreadCatalogueSourceHeads
    mutation: ThreadCatalogueMutation
  }
): PreparedThreadMutation | null {
  const decoded = new ThreadCatalogueDiskReader(options).read(input.chatId)
  if (!decoded) return null
  if (!decoded.sourceComplete) throw new Error('History recovery source is incomplete')
  if (decoded.source.witness !== input.sourceWitness)
    throw new Error('History changed before mutation preparation')
  const original = decoded.persisted
  let next: ChatRecord = original
  let settlements: StaleChatRunSettlement[] = []
  let terminalRecoveries: TerminalChatRunRecovery[] = []
  let checkedRuns: PreparedThreadMutation['checkedRuns'] = []
  const operation = input.mutation
  let at: number
  if (operation.kind === 'settle-runs') {
    if (operation.runs.length > 1000 || !Number.isFinite(Date.parse(operation.nowIso)))
      throw new Error('Invalid recovery batch')
    at = Date.parse(operation.nowIso)
    const wanted = new Map(operation.runs.map((run) => [run.runId, run]))
    const result = reconcileStaleChatRuns([original], (id) => !wanted.has(id), operation.nowIso, {
      nowMs: at,
      minAgeMs: operation.minAgeMs,
      getRunSession: (id) => wanted.get(id)?.session
    })
    next = result.chats[0] ?? original
    settlements = result.settlements
    terminalRecoveries = result.terminalRecoveries
    const changed = new Set([...settlements, ...terminalRecoveries].map((run) => run.runId))
    checkedRuns = operation.runs.filter((run) => changed.has(run.runId))
  } else if (operation.kind === 'repair-title') {
    at = Date.parse(operation.at)
    const title = isThreadTitleRepairTarget(original)
      ? deriveThreadTitleFromTranscript(original)
      : null
    if (title && title !== original.title) next = { ...original, title }
  } else if (operation.kind === 'prune-blackboard') {
    at = operation.atMs
    if (!Number.isFinite(at)) throw new Error('Invalid expiry clock')
    if (original.ensemble) {
      const before = original.ensemble.blackboard ?? []
      const blackboard = pruneExpiredBlackboardEntries(before, at)
      if (blackboard !== before)
        next = {
          ...original,
          ensemble: { ...original.ensemble, blackboard, updatedAt: new Date(at).toISOString() }
        }
    }
  } else if (operation.kind === 'recover-worker-control') {
    at = Date.parse(operation.at)
    if (!Number.isFinite(at)) throw new Error('Invalid worker recovery clock')
    const control = original.delegationContext?.workerControl
    if (control) {
      const runs = (original.runs ?? []).flatMap((run) =>
        typeof run.status === 'string'
          ? [
              {
                runId: run.runId,
                status: run.status,
                ...(run.cancelled ? { cancelled: true } : {})
              }
            ]
          : []
      )
      const recovered = recoverSubThreadWorkerControl(control, runs, operation.at)
      if (JSON.stringify(recovered) !== JSON.stringify(control))
        next = {
          ...original,
          delegationContext: { ...original.delegationContext!, workerControl: recovered }
        }
    }
  } else {
    at = Date.parse(operation.expiredAt)
    if (!Number.isFinite(at)) throw new Error('Invalid wakeup expiry clock')
    if (operation.family === 'solo') {
      const wakeup = original.soloWakeups?.[operation.wakeupId]
      if (wakeup?.status === 'pending' && wakeup.wakeAt === operation.expectedWakeAt)
        next = {
          ...original,
          soloWakeups: {
            ...original.soloWakeups,
            [operation.wakeupId]: { ...wakeup, status: 'expired', expiredAt: operation.expiredAt }
          }
        }
    } else {
      const wakeup = original.ensemble?.wakeups?.[operation.wakeupId]
      if (
        original.ensemble &&
        wakeup?.status === 'pending' &&
        wakeup.wakeAt === operation.expectedWakeAt
      )
        next = {
          ...original,
          ensemble: {
            ...original.ensemble,
            wakeups: {
              ...original.ensemble.wakeups,
              [operation.wakeupId]: {
                ...wakeup,
                status: 'expired',
                expiredAt: operation.expiredAt,
                ...(operation.message ? { message: operation.message } : {})
              }
            },
            updatedAt: operation.expiredAt
          }
        }
    }
  }
  if (next === original) return null
  const previousRevision = projectThreadCatalogueRecord(original).revision
  next = { ...next, persistenceRevision: previousRevision + 1, updatedAt: at }
  const preparedId = randomUUID()
  const directory = preparedThreadDirectory(options.profilePath, input.chatId)
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const names = [`${preparedId}.record.json`, `${preparedId}.checkpoint.json`]
  try {
    const record = writePrepared(directory, names[0], next)
    const checkpoint = writePrepared(directory, names[1], {
      format: INCREMENTAL_CHAT_CHECKPOINT_FORMAT,
      version: INCREMENTAL_CHAT_CHECKPOINT_VERSION,
      chatId: input.chatId,
      revision: previousRevision + 1,
      savedAt: new Date(at).toISOString(),
      reason: 'recovery',
      record: next
    })
    return {
      preparedId,
      chatId: input.chatId,
      epoch: input.epoch,
      heads: input.heads,
      sourceWitness: input.sourceWitness,
      previousRevision,
      projection: projectThreadCatalogueRecord(next),
      record,
      checkpoint,
      checkedRuns,
      settlements,
      terminalRecoveries
    }
  } catch (error) {
    for (const name of names) fs.rmSync(join(directory, name), { force: true })
    throw error
  }
}

/**
 * Decoder-only fold of a dead writer's log onto the thread's full copy.
 *
 * `prepareThreadCatalogueMutation` is a new edit: it moves the revision on by
 * one and stamps `updatedAt` with the clock. A fold publishes work that was
 * already done, so it keeps the log's own head revision and `updatedAt` and the
 * full copy's `createdAt`; moving any of them would make the thread look
 * edited at recovery time and fork its revision chain from the log's.
 *
 * Returns null, and writes nothing, when there is nothing to fold or when the
 * canonical source is missing: a missing source stays unresolved rather than
 * being resurrected from a log.
 */
export function foldOwnedLogThreadCatalogueMutation(
  options: ThreadCatalogueReaderOptions,
  input: {
    chatId: string
    sourceWitness: string
    epoch: ThreadCatalogueEpoch
    heads: ThreadCatalogueSourceHeads
    headRevision: number
    updatedAt: string
    profileAuthority: string
    logEntries: readonly ThreadFoldLogBatch[]
  }
): FoldedLogOutcome | null {
  const decoded = new ThreadCatalogueDiskReader(options).read(input.chatId)
  if (!decoded) return null
  if (!decoded.sourceComplete) throw new Error('History recovery source is incomplete')
  if (decoded.source.witness !== input.sourceWitness)
    throw new ThreadCatalogueRequestError('source_changed')
  const at = Date.parse(input.updatedAt)
  if (!Number.isSafeInteger(input.headRevision) || input.headRevision < 1 || !Number.isFinite(at))
    throw new Error('Invalid fold head')
  if (input.logEntries.length === 0) return null
  const batches: ThreadLogBatch[] = []
  for (const entry of input.logEntries) {
    if (!isThreadLogBatch(entry, input.chatId)) throw new Error('Invalid log batch')
    batches.push(entry)
  }
  if (batches[batches.length - 1].revision !== input.headRevision)
    throw new Error('Log head does not match the folded revision')
  const original = decoded.persisted
  const previousRevision = projectThreadCatalogueRecord(original).revision
  // The applier checks every link from the full copy's revision to the head.
  const folded = applyThreadLogBatches(original, batches)
  const next: ChatRecord = {
    ...folded,
    createdAt: original.createdAt,
    persistenceRevision: input.headRevision,
    updatedAt: at
  }
  const foldId = randomUUID()
  const directory = preparedThreadDirectory(options.profilePath, input.chatId)
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const names = [`${foldId}.record.json`, `${foldId}.checkpoint.json`]
  try {
    const record = writePrepared(directory, names[0], next)
    const checkpoint = writePrepared(directory, names[1], {
      format: INCREMENTAL_CHAT_CHECKPOINT_FORMAT,
      version: INCREMENTAL_CHAT_CHECKPOINT_VERSION,
      chatId: input.chatId,
      revision: input.headRevision,
      savedAt: input.updatedAt,
      reason: 'recovery',
      record: next
    })
    return {
      foldId,
      chatId: input.chatId,
      epoch: input.epoch,
      heads: input.heads,
      sourceWitness: input.sourceWitness,
      profileAuthority: input.profileAuthority,
      previousRevision,
      headRevision: input.headRevision,
      updatedAt: input.updatedAt,
      projection: projectThreadCatalogueRecord(next),
      record,
      checkpoint
    }
  } catch (error) {
    for (const name of names) fs.rmSync(join(directory, name), { force: true })
    throw error
  }
}
