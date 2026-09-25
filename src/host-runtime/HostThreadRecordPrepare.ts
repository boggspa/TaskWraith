/**
 * The prepare stage of a transactional thread-record persist (Independent
 * Threads M4, slice 11).
 *
 * Everything record-proportional that the legacy persist does on the Host
 * loop happens here, inside the transfer worker: verify the artifact, parse
 * it, decode it, run the store's revision math, decide adoption, write the
 * normalized document when adoption declines, and model the record's public
 * effects. What leaves is a descriptor bounded by the run window, never the
 * record: the file the commit renames, the revision it commits, the effects,
 * and the thread summary when it fits.
 *
 * Every outcome mirrors the legacy executor and store for the same inputs:
 * the same error code, the same adoption decision, and on success an artifact
 * whose bytes are the chat file the legacy path would have written. The
 * revision check here is advisory; the commit re-checks it by file identity.
 *
 * Unwired in this slice.
 */
import { createHash } from 'node:crypto'

import { peopleDonorMutationOwned } from '../host-shared/thread-catalogue/PeopleDonorMutationGate'
import {
  decodeHostProfileThread,
  isHostProfileId,
  MAX_CHAT_BYTES,
  summarizeHostProfileThread,
  type HostProfileThread,
  type HostProfileThreadSummary
} from './HostProfileDomainStore'
import {
  modelHostThreadRecordEffects,
  type HostThreadRecordEffectModel
} from './HostThreadRecordEffectModel'
import {
  decodeHostThreadRecordTransferBody,
  HostThreadRecordTransferIntegrityError,
  HostThreadRecordTransferMissingError,
  publishHostThreadRecordTransfer,
  removeHostThreadRecordTransfer,
  verifyHostThreadRecordTransfer,
  type HostThreadRecordTransferDescriptor,
  type HostThreadRecordTransferIdentity
} from './HostThreadRecordTransfer'

/** The largest thread summary a descriptor carries; a larger one is omitted. */
export const HOST_THREAD_RECORD_PREPARED_SUMMARY_MAX_BYTES = 256 * 1024

export interface HostThreadRecordPrepareInput {
  /** Absolute profile path. */
  readonly profilePath: string
  readonly threadId: string
  /** The transfer descriptor as the command carried it. */
  readonly descriptor: HostThreadRecordTransferDescriptor
  /** The command's CAS base. */
  readonly expectedRevision: number
  /** The revision the lane's cache holds for the thread; null when it has no record. */
  readonly currentRevision: number | null
  /** The `updatedAt` a normalized document is stamped with. */
  readonly now: number
  readonly summaryMaxBytes?: number
}

export interface HostThreadRecordPreparedArtifact {
  readonly path: string
  readonly identity: HostThreadRecordTransferIdentity
  readonly byteLength: number
  readonly sha256: string
  /** `original`: the transfer adopted as sent. `normalized`: rewritten by prepare. */
  readonly source: 'original' | 'normalized'
}

export interface HostThreadRecordPrepared {
  readonly kind: 'prepared'
  readonly threadId: string
  /** The `currentRevision` the revision math ran against. */
  readonly base: number | null
  readonly expectedRevision: number
  readonly persistenceRevision: number
  /** The file the commit renames into the chats directory. */
  readonly artifact: HostThreadRecordPreparedArtifact
  readonly effects: HostThreadRecordEffectModel
  /** The store's summary of the committed record, or null above the cap. */
  readonly summary: HostProfileThreadSummary | null
}

export type HostThreadRecordPrepareErrorCode =
  | 'thread_record_transfer_missing'
  | 'thread_record_transfer_integrity'
  | 'thread_record_revision_conflict'
  | 'thread_record_identity_mismatch'
  | 'thread_record_invalid'
  | 'thread_record_persist_failed'

export interface HostThreadRecordPrepareRejected {
  readonly kind: 'rejected'
  readonly threadId: string
  readonly errorCode: HostThreadRecordPrepareErrorCode
}

/** A persist this stage cannot prepare; the legacy path still serves it. */
export interface HostThreadRecordPrepareUnsupported {
  readonly kind: 'unsupported'
  readonly threadId: string
  readonly reason: 'people_donor_owned'
}

export type HostThreadRecordPrepareResult =
  | HostThreadRecordPrepared
  | HostThreadRecordPrepareRejected
  | HostThreadRecordPrepareUnsupported

/**
 * The id a normalized document is published under. Deterministic, so a retry
 * after a crash replaces its own leftover instead of accumulating new ones.
 */
export function hostThreadRecordNormalizedTransferId(transferId: string): string {
  return `n${createHash('sha256').update(transferId, 'utf8').digest('hex').slice(0, 63)}`
}

/** A domain refusal, carrying the message the legacy store would have thrown. */
class Refusal extends Error {}

function refusalCode(message: string): HostThreadRecordPrepareErrorCode {
  // The executor's mapping for a store failure, verbatim.
  if (message === 'Thread persistence revision mismatch' || message === 'Thread is not found') {
    return 'thread_record_revision_conflict'
  }
  if (message === 'Thread identity mismatch') return 'thread_record_identity_mismatch'
  if (message.startsWith('Invalid ')) return 'thread_record_invalid'
  return 'thread_record_persist_failed'
}

function removeQuietly(
  profilePath: string,
  transferId: string,
  expectedIdentity: HostThreadRecordTransferIdentity
): void {
  try {
    removeHostThreadRecordTransfer({ profilePath, transferId, expectedIdentity })
  } catch {
    // The outcome is what the caller reports; a stranded artifact is
    // owner-only inside the profile.
  }
}

/** The store's revision math from `persistThreadRecord`, verbatim. */
function committedRevision(input: HostThreadRecordPrepareInput, incoming: unknown): number {
  const { currentRevision, expectedRevision } = input
  if (currentRevision === null) {
    if (expectedRevision !== 0) throw new Refusal('Thread is not found')
  } else if (currentRevision !== expectedRevision) {
    throw new Refusal('Thread persistence revision mismatch')
  }
  const incomingRevision =
    Number.isSafeInteger(incoming) && (incoming as number) >= 0 ? (incoming as number) : null
  if (currentRevision === null) return 0
  if (incomingRevision !== null && incomingRevision < expectedRevision) {
    throw new Refusal('Invalid record persistence revision: cannot move backwards')
  }
  if (incomingRevision !== null && incomingRevision > expectedRevision) return incomingRevision
  // Legacy complete snapshots either omit this field or echo their CAS base.
  if (
    !Number.isSafeInteger(currentRevision) ||
    currentRevision < 0 ||
    currentRevision >= Number.MAX_SAFE_INTEGER
  ) {
    throw new Refusal('Profile persistence revision is invalid')
  }
  return currentRevision + 1
}

/** The store's adoption predicate from `tryAdoptVerifiedTransfer`, verbatim. */
function adoptable(
  input: HostThreadRecordPrepareInput,
  source: Record<string, unknown>,
  decoded: HostProfileThread,
  persistenceRevision: number
): boolean {
  if (input.descriptor.byteLength > MAX_CHAT_BYTES) return false
  if (
    source.runs === undefined ||
    source.createdAt !== decoded.createdAt ||
    source.scope !== decoded.scope ||
    source.archived !== decoded.archived
  ) {
    return false
  }
  const incomingRevision = decoded.persistenceRevision
  return (
    typeof incomingRevision === 'number' &&
    Number.isSafeInteger(incomingRevision) &&
    incomingRevision >= 0 &&
    incomingRevision === persistenceRevision &&
    incomingRevision > input.expectedRevision
  )
}

function boundedSummary(
  thread: HostProfileThread,
  maxBytes: number
): HostProfileThreadSummary | null {
  const summary = summarizeHostProfileThread(thread)
  return Buffer.byteLength(JSON.stringify(summary), 'utf8') <= maxBytes ? summary : null
}

export function prepareHostThreadRecord(
  input: HostThreadRecordPrepareInput
): HostThreadRecordPrepareResult {
  const { profilePath, threadId, descriptor } = input
  const rejected = (
    errorCode: HostThreadRecordPrepareErrorCode
  ): HostThreadRecordPrepareRejected => ({
    kind: 'rejected',
    threadId,
    errorCode
  })

  // Verification failures leave the artifact where it is, as the legacy read does.
  let verified: ReturnType<typeof verifyHostThreadRecordTransfer>
  try {
    verified = verifyHostThreadRecordTransfer({ profilePath, descriptor })
  } catch (error) {
    if (error instanceof HostThreadRecordTransferMissingError) {
      return rejected('thread_record_transfer_missing')
    }
    if (error instanceof HostThreadRecordTransferIntegrityError) {
      return rejected('thread_record_transfer_integrity')
    }
    throw error
  }

  // From here every outcome except success and `unsupported` removes the
  // exact inode that was verified, as the legacy read and persist do.
  let normalized: { transferId: string; identity: HostThreadRecordTransferIdentity } | null = null
  try {
    let source: Record<string, unknown>
    try {
      source = decodeHostThreadRecordTransferBody(verified.body)
    } catch (error) {
      removeQuietly(profilePath, descriptor.transferId, verified.identity)
      if (error instanceof HostThreadRecordTransferIntegrityError) {
        return rejected('thread_record_transfer_integrity')
      }
      throw error
    }

    let published: HostProfileThread
    let original: boolean
    let persistenceRevision: number
    try {
      if (!isHostProfileId(threadId)) throw new Refusal('Profile identity is invalid')
      if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
        throw new Refusal('Invalid expected revision')
      }
      const decoded = decodeProfileThread(source)
      if (decoded.appChatId !== threadId) throw new Refusal('Thread identity mismatch')
      persistenceRevision = committedRevision(input, decoded.persistenceRevision)
      if (peopleDonorMutationOwned(profilePath)) {
        return { kind: 'unsupported', threadId, reason: 'people_donor_owned' }
      }
      original = adoptable(input, source, decoded, persistenceRevision)
      published = original
        ? { ...decoded, persistenceRevision }
        : { ...decoded, persistenceRevision, updatedAt: input.now }
    } catch (error) {
      removeQuietly(profilePath, descriptor.transferId, verified.identity)
      if (error instanceof Refusal) return rejected(refusalCode(error.message))
      throw error
    }

    let artifact: HostThreadRecordPreparedArtifact
    if (original) {
      artifact = {
        path: verified.path,
        identity: verified.identity,
        byteLength: verified.descriptor.byteLength,
        sha256: verified.descriptor.sha256,
        source: 'original'
      }
    } else {
      // The legacy write refuses a document over the chat cap before writing it.
      const bytes = Buffer.byteLength(`${JSON.stringify(published)}\n`, 'utf8')
      if (bytes > MAX_CHAT_BYTES) {
        removeQuietly(profilePath, descriptor.transferId, verified.identity)
        return rejected('thread_record_persist_failed')
      }
      const transferId = hostThreadRecordNormalizedTransferId(descriptor.transferId)
      const written = publishHostThreadRecordTransfer({
        profilePath,
        transferId,
        record: published
      })
      const reread = verifyHostThreadRecordTransfer({ profilePath, descriptor: written })
      normalized = { transferId, identity: reread.identity }
      removeQuietly(profilePath, descriptor.transferId, verified.identity)
      artifact = {
        path: reread.path,
        identity: reread.identity,
        byteLength: written.byteLength,
        sha256: written.sha256,
        source: 'normalized'
      }
    }

    return {
      kind: 'prepared',
      threadId,
      base: input.currentRevision,
      expectedRevision: input.expectedRevision,
      persistenceRevision,
      artifact,
      effects: modelHostThreadRecordEffects(published),
      summary: boundedSummary(
        published,
        input.summaryMaxBytes ?? HOST_THREAD_RECORD_PREPARED_SUMMARY_MAX_BYTES
      )
    }
  } catch (error) {
    removeQuietly(profilePath, descriptor.transferId, verified.identity)
    if (normalized) removeQuietly(profilePath, normalized.transferId, normalized.identity)
    throw error
  }
}

function decodeProfileThread(source: Record<string, unknown>): HostProfileThread {
  try {
    return decodeHostProfileThread(source)
  } catch (error) {
    // The decoder's refusals are all `Invalid ...`; carry the message through.
    throw new Refusal(error instanceof Error ? error.message : 'Invalid profile chat')
  }
}
