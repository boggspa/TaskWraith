import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import publicationFs from 'node:fs'
import * as path from 'node:path'
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
import type {
  JournalPublicationRequest,
  JournalPublicationReadReference,
  JournalPublicationArtifact
} from './CheckpointPreparationProtocol'

function validatePinned(reference: JournalPublicationReadReference): void {
  const actual = checkpointFileIdentity(fs.fstatSync(reference.fd, { bigint: true }))
  if (
    actual.dev !== reference.identity.dev ||
    actual.ino !== reference.identity.ino ||
    !Number.isSafeInteger(reference.prefixBytes) ||
    reference.prefixBytes < 0 ||
    (reference.mutablePrefix
      ? actual.size < reference.prefixBytes
      : !sameCheckpointFile(actual, reference.identity))
  ) {
    throw new Error('Pinned publication source changed')
  }
}

/** Thread only: borrowed descriptors are never closed here, including on error. */
export function prepareJournalPublication(
  request: JournalPublicationRequest
): JournalPublicationArtifact {
  const sources = [request.checkpoint, request.sealed, request.active].filter(
    (ref): ref is JournalPublicationReadReference => ref !== null
  )
  const sourceBytes = sources.reduce((total, ref) => total + ref.prefixBytes, 0)
  if (
    !/^[A-Za-z0-9_-]{1,256}$/.test(request.chatId) ||
    !Number.isSafeInteger(request.revision) ||
    request.revision < 0 ||
    !Number.isSafeInteger(request.generation) ||
    request.generation < 0 ||
    !Number.isSafeInteger(sourceBytes) ||
    sourceBytes <= 0 ||
    sourceBytes > 256 * 1024 * 1024 ||
    !Number.isSafeInteger(request.maxOutputBytes) ||
    request.maxOutputBytes <= 0 ||
    request.maxOutputBytes > 128 * 1024 * 1024 ||
    request.output.identity.size !== 0
  ) {
    throw new Error('Invalid publication preparation bounds')
  }
  for (const source of sources) validatePinned(source)
  const checkpoint: unknown = JSON.parse(
    readExact(request.checkpoint.fd, request.checkpoint.prefixBytes)
  )
  if (!validCheckpoint(checkpoint, request.chatId))
    throw new Error('Invalid publication checkpoint')
  let revision = checkpoint.revision
  const batches: ChatRecordMutationBatch[] = []
  for (const source of [request.sealed, request.active]) {
    if (!source) continue
    const text = readExact(source.fd, source.prefixBytes)
    if (text && !text.endsWith('\n')) throw new Error('Torn publication prefix')
    for (const line of text.split('\n')) {
      if (!line) continue
      const batch: unknown = JSON.parse(line)
      if (!validMutationBatch(batch, request.chatId))
        throw new Error('Invalid publication mutation')
      if (batch.revision <= revision) continue
      if (batch.baseRevision !== revision || batch.revision > request.revision)
        throw new Error('Publication revision gap')
      batches.push(batch)
      revision = batch.revision
    }
  }
  if (revision !== request.revision) throw new Error('Publication did not reach R')
  const record = applyChatRecordMutations(checkpoint.record, batches)
  const fd = openExact(request.output, true)
  try {
    const hash = createHash('sha256')
    let byteLength = 0
    for (const chunk of encodeThreadJsonChunks(record)) {
      if (byteLength + chunk.byteLength > request.maxOutputBytes)
        throw new Error('Publication output exceeds bound')
      let offset = 0
      while (offset < chunk.byteLength) {
        const written = fs.writeSync(
          fd,
          chunk,
          offset,
          chunk.byteLength - offset,
          byteLength + offset
        )
        if (!written) throw new Error('Publication output stalled')
        offset += written
      }
      byteLength += chunk.byteLength
      hash.update(chunk)
    }
    publicationFs.fsyncSync(fd)
    if (path.dirname(request.output.path) !== request.outputDirectory.path)
      throw new Error('Publication output directory mismatch')
    const directoryFd = fs.openSync(
      request.outputDirectory.path,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0)
    )
    try {
      const directory = fs.fstatSync(directoryFd, { bigint: true })
      const validate = (): void => {
        const named = fs.lstatSync(request.outputDirectory.path, { bigint: true })
        const output = fs.lstatSync(request.output.path, { bigint: true })
        if (
          !directory.isDirectory() ||
          !named.isDirectory() ||
          String(directory.dev) !== request.outputDirectory.dev ||
          String(directory.ino) !== request.outputDirectory.ino ||
          directory.dev !== named.dev ||
          directory.ino !== named.ino ||
          String(output.dev) !== request.output.identity.dev ||
          String(output.ino) !== request.output.identity.ino
        )
          throw new Error('Publication directory identity changed')
      }
      validate()
      publicationFs.fsyncSync(directoryFd)
      validate()
    } finally {
      fs.closeSync(directoryFd)
    }
    for (const source of sources) validatePinned(source)
    return {
      chatId: request.chatId,
      revision,
      generation: request.generation,
      artifactPath: request.output.path,
      sha256: hash.digest('hex'),
      byteLength,
      identity: checkpointFileIdentity(fs.fstatSync(fd, { bigint: true }))
    }
  } finally {
    fs.closeSync(fd)
  }
}

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
