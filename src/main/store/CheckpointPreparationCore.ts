import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import { applyChatRecordMutations, type ChatRecordMutationBatch } from './ChatRecordMutation'
import {
  INCREMENTAL_CHAT_CHECKPOINT_FORMAT,
  INCREMENTAL_CHAT_CHECKPOINT_VERSION,
  validCheckpoint,
  validMutationBatch,
  type IncrementalChatCheckpoint
} from './IncrementalChatJournal'
import { encodeThreadJsonChunks } from './ThreadCatalogueJson'
import {
  checkpointFileIdentity,
  checkpointReferenceIsCurrent,
  sameCheckpointFile,
  type CheckpointFileReference,
  type CheckpointPreparationRequest,
  type PreparedCheckpoint
} from './CheckpointPreparationProtocol'

function openExact(reference: CheckpointFileReference, writable = false): number {
  const fd = fs.openSync(
    reference.path,
    (writable ? fs.constants.O_RDWR : fs.constants.O_RDONLY) | (fs.constants.O_NOFOLLOW ?? 0)
  )
  try {
    if (
      !sameCheckpointFile(
        reference.identity,
        checkpointFileIdentity(fs.fstatSync(fd, { bigint: true }))
      )
    ) {
      throw new Error('Checkpoint source changed before preparation')
    }
    return fd
  } catch (error) {
    fs.closeSync(fd)
    throw error
  }
}

function readExact(fd: number, bytes: number): string {
  const buffer = Buffer.allocUnsafe(bytes)
  let offset = 0
  while (offset < bytes) {
    const count = fs.readSync(fd, buffer, offset, Math.min(48 * 1024, bytes - offset), offset)
    if (!count) throw new Error('Checkpoint source was truncated during preparation')
    offset += count
  }
  return buffer.toString('utf8')
}

/** Child-process only. Opens existing files; never creates a directory or output path. */
export function prepareCheckpoint(request: CheckpointPreparationRequest): PreparedCheckpoint {
  const sourceBytes = request.checkpoint.identity.size + request.journal.identity.size
  if (
    !/^[A-Za-z0-9_-]{1,256}$/.test(request.chatId) ||
    !Number.isSafeInteger(request.revision) ||
    request.revision < 0 ||
    !Number.isSafeInteger(sourceBytes) ||
    sourceBytes <= 0 ||
    sourceBytes > 64 * 1024 * 1024 ||
    !Number.isSafeInteger(request.maxOutputBytes) ||
    request.maxOutputBytes <= 0 ||
    request.maxOutputBytes > 128 * 1024 * 1024 ||
    request.output.identity.size !== 0
  )
    throw new Error('Invalid checkpoint preparation bounds')

  const descriptors: number[] = []
  try {
    const checkpointFd = openExact(request.checkpoint)
    descriptors.push(checkpointFd)
    const journalFd = openExact(request.journal)
    descriptors.push(journalFd)
    const outputFd = openExact(request.output, true)
    descriptors.push(outputFd)
    const checkpoint: unknown = JSON.parse(
      readExact(checkpointFd, request.checkpoint.identity.size)
    )
    if (!validCheckpoint(checkpoint, request.chatId)) throw new Error('Invalid checkpoint baseline')
    const tail = readExact(journalFd, request.journal.identity.size)
    if (!tail.endsWith('\n')) throw new Error('Checkpoint preparation refuses a torn journal')
    const batches: ChatRecordMutationBatch[] = []
    let revision = checkpoint.revision
    for (const line of tail.split('\n')) {
      if (!line) continue
      const batch: unknown = JSON.parse(line)
      if (!validMutationBatch(batch, request.chatId)) throw new Error('Invalid checkpoint mutation')
      if (batch.revision <= revision) continue
      if (batch.baseRevision !== revision) throw new Error('Checkpoint journal revision gap')
      batches.push(batch)
      revision = batch.revision
    }
    if (revision !== request.revision) throw new Error('Checkpoint head changed before preparation')
    const record = applyChatRecordMutations(checkpoint.record, batches)
    const prepared: IncrementalChatCheckpoint = {
      format: INCREMENTAL_CHAT_CHECKPOINT_FORMAT,
      version: INCREMENTAL_CHAT_CHECKPOINT_VERSION,
      chatId: request.chatId,
      revision,
      savedAt: request.savedAt,
      reason: 'idle',
      record
    }
    const hash = createHash('sha256')
    let bytes = 0
    for (const chunk of encodeThreadJsonChunks(prepared)) {
      if (bytes + chunk.byteLength > request.maxOutputBytes)
        throw new Error('Prepared checkpoint exceeds byte budget')
      let offset = 0
      while (offset < chunk.byteLength) {
        const count = fs.writeSync(
          outputFd,
          chunk,
          offset,
          chunk.byteLength - offset,
          bytes + offset
        )
        if (!count) throw new Error('Checkpoint output write made no progress')
        offset += count
      }
      bytes += chunk.byteLength
      hash.update(chunk)
    }
    fs.fsyncSync(outputFd)
    for (const [reference, fd] of [
      [request.checkpoint, checkpointFd],
      [request.journal, journalFd]
    ] as const) {
      if (
        !sameCheckpointFile(
          reference.identity,
          checkpointFileIdentity(fs.fstatSync(fd, { bigint: true }))
        ) ||
        !checkpointReferenceIsCurrent(reference)
      )
        throw new Error('Checkpoint source changed during preparation')
    }
    return {
      chatId: request.chatId,
      revision,
      sha256: hash.digest('hex'),
      identity: checkpointFileIdentity(fs.fstatSync(outputFd, { bigint: true }))
    }
  } finally {
    for (const fd of descriptors) fs.closeSync(fd)
  }
}
