import { applyChatRecordMutations, type ChatRecordMutationBatch } from './ChatRecordMutation'
import type { ChatRecord } from './types'

/** Model identities are inode-bound; paths never confer identity after rotation. */
export interface JournalCaptureInode {
  readonly dev: string
  readonly ino: string
  readonly openGeneration: number
}

export interface JournalCaptureFile {
  readonly inode: JournalCaptureInode
  readonly bytes: number
}

export interface JournalCaptureImmutableFile extends JournalCaptureFile {
  /** Exact immutable-source identity, e.g. the adapter's stat fingerprint. */
  readonly version: string
}

export interface JournalCaptureCheckpoint extends JournalCaptureImmutableFile {
  readonly revision: number
}

export interface JournalSourceCaptureInput {
  chatId: string
  generation: number
  revision: number
  headRevision: number
  baselineVerified: boolean
  durabilityFallback: boolean
  conflictRebased: boolean
  erased: boolean
  /** Combined checkpoint + sealed + active-prefix admission budget. */
  maxSourceBytes: number
  checkpoint: JournalCaptureCheckpoint | null
  sealed: JournalCaptureImmutableFile | null
  active: JournalCaptureFile | null
}

export interface JournalSourceCapture {
  readonly chatId: string
  readonly generation: number
  readonly revision: number
  readonly checkpoint: JournalCaptureCheckpoint
  readonly sealed: JournalCaptureImmutableFile | null
  readonly active: JournalCaptureFile | null
}

export type JournalSourceFallbackReason =
  | 'erased'
  | 'durability-fallback'
  | 'conflict-rebased'
  | 'baseline-unverified'
  | 'revision-mismatch'
  | 'no-journal'
  | 'invalid-source'
  | 'oversize'

export type JournalSourceCaptureResult =
  | { kind: 'captured'; capture: JournalSourceCapture }
  | { kind: 'fallback'; reason: JournalSourceFallbackReason }

function integer(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}

function validFile(file: JournalCaptureFile): boolean {
  return (
    integer(file.bytes) &&
    !!file.inode.dev &&
    !!file.inode.ino &&
    integer(file.inode.openGeneration)
  )
}

function sameInode(a: JournalCaptureInode, b: JournalCaptureInode): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.openGeneration === b.openGeneration
}

function pin<T extends JournalCaptureFile>(file: T): T {
  return Object.freeze({ ...file, inode: Object.freeze({ ...file.inode }) })
}

/** Pure, O(1) admission/pinning; no chat clone, replay, stat or filesystem write. */
export function captureJournalSource(input: JournalSourceCaptureInput): JournalSourceCaptureResult {
  const refuse = (reason: JournalSourceFallbackReason): JournalSourceCaptureResult => ({
    kind: 'fallback',
    reason
  })
  if (input.erased) return refuse('erased')
  if (input.durabilityFallback) return refuse('durability-fallback')
  if (input.conflictRebased) return refuse('conflict-rebased')
  if (!input.baselineVerified) return refuse('baseline-unverified')
  if (
    !input.chatId ||
    !integer(input.generation) ||
    !integer(input.revision) ||
    !integer(input.headRevision) ||
    !integer(input.maxSourceBytes) ||
    input.maxSourceBytes === 0
  ) {
    return refuse('invalid-source')
  }
  if (input.revision !== input.headRevision) return refuse('revision-mismatch')
  if (!input.checkpoint) return refuse('no-journal')
  const { checkpoint, sealed, active } = input
  if (
    !validFile(checkpoint) ||
    !integer(checkpoint.revision) ||
    checkpoint.revision > input.revision ||
    !checkpoint.version ||
    (sealed && (!validFile(sealed) || !sealed.version)) ||
    (active && !validFile(active))
  ) {
    return refuse('invalid-source')
  }
  const files = [checkpoint, sealed, active].filter(
    (file): file is JournalCaptureFile => file !== null
  )
  if (
    files.some((file, index) =>
      files.slice(index + 1).some((other) => sameInode(file.inode, other.inode))
    )
  ) {
    return refuse('invalid-source')
  }
  const bytes = checkpoint.bytes + (sealed?.bytes ?? 0) + (active?.bytes ?? 0)
  if (!integer(bytes)) return refuse('invalid-source')
  if (bytes > input.maxSourceBytes) return refuse('oversize')
  return {
    kind: 'captured',
    capture: Object.freeze({
      chatId: input.chatId,
      generation: input.generation,
      revision: input.revision,
      checkpoint: pin(checkpoint),
      sealed: sealed ? pin(sealed) : null,
      active: active ? pin(active) : null
    })
  }
}

export interface JournalCapturedSegment extends JournalCaptureFile {
  version?: string
  batches: ReadonlyArray<{ endOffset: number; batch: ChatRecordMutationBatch }>
}

export interface JournalSourceReplayInput {
  chatId: string
  generation: number
  erased: boolean
  checkpoint: JournalCaptureCheckpoint & { record: ChatRecord }
  /** Worker-opened inode references; the active inode may now be sealed. */
  segments: ReadonlyArray<JournalCapturedSegment>
}

/**
 * Pure worker replay model using the production mutation reducer. Adapters must
 * open exact immutable sources and read only the pinned active prefix. Later
 * appends are allowed; generation changes and inode reuse refuse the capture.
 */
export function replayJournalSource(
  capture: JournalSourceCapture,
  source: JournalSourceReplayInput
): ChatRecord {
  if (
    source.erased ||
    source.chatId !== capture.chatId ||
    source.generation !== capture.generation
  ) {
    throw new Error('Journal capture invalidated')
  }
  const checkpoint = source.checkpoint
  if (
    !sameInode(checkpoint.inode, capture.checkpoint.inode) ||
    checkpoint.version !== capture.checkpoint.version ||
    checkpoint.bytes !== capture.checkpoint.bytes ||
    checkpoint.revision !== capture.checkpoint.revision ||
    checkpoint.record.appChatId !== capture.chatId ||
    (checkpoint.record.persistenceRevision ?? 0) !== checkpoint.revision
  ) {
    throw new Error('Journal checkpoint changed')
  }
  let revision = checkpoint.revision
  const batches: ChatRecordMutationBatch[] = []
  for (const reference of [capture.sealed, capture.active]) {
    if (!reference) continue
    const matches = source.segments.filter((segment) => sameInode(segment.inode, reference.inode))
    if (matches.length !== 1) throw new Error('Journal inode missing or ambiguous')
    const segment = matches[0]
    if (
      !integer(segment.bytes) ||
      segment.bytes < reference.bytes ||
      ('version' in reference &&
        (segment.version !== reference.version || segment.bytes !== reference.bytes))
    ) {
      throw new Error('Journal source changed or truncated')
    }
    let offset = 0
    for (const entry of segment.batches) {
      if (
        !integer(entry.endOffset) ||
        entry.endOffset <= offset ||
        entry.endOffset > segment.bytes
      ) {
        throw new Error('Invalid journal extent')
      }
      if (entry.endOffset > reference.bytes) break
      offset = entry.endOffset
      const batch = entry.batch
      if (
        batch.chatId !== capture.chatId ||
        !integer(batch.baseRevision) ||
        !integer(batch.revision) ||
        batch.revision <= batch.baseRevision
      )
        throw new Error('Invalid mutation revision')
      if (batch.revision <= revision) continue
      if (batch.baseRevision !== revision || batch.revision > capture.revision)
        throw new Error('Journal revision gap')
      batches.push(batch)
      revision = batch.revision
    }
    if (offset !== reference.bytes) throw new Error('Torn captured prefix')
  }
  if (revision !== capture.revision) throw new Error('Journal capture did not reach R')
  return applyChatRecordMutations(checkpoint.record, batches)
}
