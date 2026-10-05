import { preparedThreadDirectory } from './ThreadCataloguePreparedPath'
import * as fs from 'node:fs'
import { createHash } from 'node:crypto'
import { join, basename } from 'node:path'
import {
  captureThreadCatalogueWitness,
  type ThreadCatalogueReaderOptions
} from './ThreadCatalogueWitness'
import {
  type FoldedLogOutcome,
  type PreparedThreadMutation,
  type PreparedThreadFile
} from '../../shared/threadCatalogueTypes'
import type { ThreadCatalogueEpoch } from './ThreadCatalogue'

function matches(stat: fs.BigIntStats, expected: PreparedThreadFile): boolean {
  return (
    stat.isFile() &&
    String(stat.dev) === expected.device &&
    String(stat.ino) === expected.inode &&
    String(stat.size) === String(expected.byteLength) &&
    String(stat.mtimeNs) === expected.modified &&
    String(stat.ctimeNs) === expected.changed
  )
}

/** The caller owns source admission. No await may separate the final guard from authoritative rename. */
export function adoptPreparedThreadRecord(
  options: ThreadCatalogueReaderOptions,
  prepared: PreparedThreadMutation,
  guard: { assert(): void; epoch(): ThreadCatalogueEpoch }
): void {
  guard.assert()
  if (JSON.stringify(guard.epoch()) !== JSON.stringify(prepared.epoch))
    throw new Error('History was erased before recovery')
  if (captureThreadCatalogueWitness(options, prepared.chatId).witness !== prepared.sourceWitness)
    throw new Error('History changed before recovery')
  const descriptor = prepared.record
  if (
    basename(descriptor.name) !== descriptor.name ||
    descriptor.name !== `${prepared.preparedId}.record.json`
  )
    throw new Error('Invalid prepared history identity')
  const file = join(preparedThreadDirectory(options.profilePath, prepared.chatId), descriptor.name)
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
  try {
    if (
      !matches(fs.fstatSync(fd, { bigint: true }), descriptor) ||
      !matches(fs.lstatSync(file, { bigint: true }), descriptor)
    )
      throw new Error('Prepared history file changed')
    guard.assert()
    if (
      JSON.stringify(guard.epoch()) !== JSON.stringify(prepared.epoch) ||
      captureThreadCatalogueWitness(options, prepared.chatId).witness !== prepared.sourceWitness
    )
      throw new Error('History changed before recovery')
    fs.renameSync(file, join(options.profilePath, 'chats', `${prepared.chatId}.json`))
    let directory: number | undefined
    try {
      directory = fs.openSync(join(options.profilePath, 'chats'), 'r')
      fs.fsyncSync(directory)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? ''
      if (
        !['EINVAL', 'ENOTSUP'].includes(code) &&
        !(process.platform === 'win32' && ['EISDIR', 'EPERM', 'EACCES'].includes(code))
      )
        throw error
    } finally {
      if (directory !== undefined) fs.closeSync(directory)
    }
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * What a fold's adoption asks its caller to confirm. Each method receives the
 * value adoption observed and throws when the caller's own authoritative value
 * disagrees, so a refusal always happens before the rename.
 */
export interface FoldedAdoptionGuard {
  /** The caller still holds the thread: profile authority, hold, writer and live work. */
  authority(): void
  /** The epoch the fold was prepared under, against the live one. */
  epoch(observed: ThreadCatalogueEpoch): void
  /** The full copy's witness as captured now, against the one the fold was prepared from. */
  witness(observed: string): void
  /** The head revision of the staged record, against the one the fold promised. */
  headRevision(observed: number): void
  /** The `updatedAt` (ISO-8601) of the staged record, against the one the fold promised. */
  updatedAt(observed: string): void
}

const FOLD_HASH_READ_BYTES = 1024 * 1024

function sha256OfDescriptor(fd: number, byteLength: number): string {
  const hash = createHash('sha256')
  const buffer = Buffer.allocUnsafe(Math.min(FOLD_HASH_READ_BYTES, Math.max(byteLength, 1)))
  let position = 0
  while (position < byteLength) {
    const read = fs.readSync(
      fd,
      buffer,
      0,
      Math.min(buffer.length, byteLength - position),
      position
    )
    if (read <= 0) throw new Error('Folded history file changed')
    hash.update(buffer.subarray(0, read))
    position += read
  }
  return hash.digest('hex')
}

/**
 * Adopts a folded log as the thread's full copy.
 *
 * Same contract as `adoptPreparedThreadRecord` -- the caller owns source
 * admission, and no await may separate the final guard from the authoritative
 * rename -- but a fold is not a new edit, so the staged record is checked for
 * what it must NOT have done as well as for being the bytes the decoder wrote:
 * its revision is exactly the log's head, never past it, and its `updatedAt` is
 * exactly the log's, never the clock's. The bytes are bound to the descriptor
 * by identity and by a re-hashed SHA-256 rather than parsed, because this runs
 * on the source parent and a transcript can be large.
 */
export function adoptFoldedThreadRecord(
  options: ThreadCatalogueReaderOptions,
  folded: FoldedLogOutcome,
  guard: FoldedAdoptionGuard
): void {
  const descriptor = folded.record
  if (
    basename(descriptor.name) !== descriptor.name ||
    descriptor.name !== `${folded.foldId}.record.json`
  )
    throw new Error('Invalid folded history identity')
  const staged = Date.parse(folded.updatedAt)
  if (
    !Number.isFinite(staged) ||
    !Number.isSafeInteger(folded.headRevision) ||
    folded.headRevision <= folded.previousRevision ||
    folded.projection.revision !== folded.headRevision ||
    folded.projection.summary.chatId !== folded.chatId ||
    folded.projection.summary.updatedAt !== staged
  )
    throw new Error('Folded history moved a clock it must preserve')
  const confirm = (): void => {
    guard.authority()
    guard.epoch(folded.epoch)
    guard.witness(captureThreadCatalogueWitness(options, folded.chatId).witness)
  }
  confirm()
  guard.headRevision(folded.projection.revision)
  guard.updatedAt(new Date(folded.projection.summary.updatedAt).toISOString())
  const file = join(preparedThreadDirectory(options.profilePath, folded.chatId), descriptor.name)
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
  try {
    if (
      !matches(fs.fstatSync(fd, { bigint: true }), descriptor) ||
      !matches(fs.lstatSync(file, { bigint: true }), descriptor)
    )
      throw new Error('Folded history file changed')
    if (sha256OfDescriptor(fd, descriptor.byteLength) !== descriptor.sha256)
      throw new Error('Folded history file changed')
    confirm()
    if (
      !matches(fs.fstatSync(fd, { bigint: true }), descriptor) ||
      !matches(fs.lstatSync(file, { bigint: true }), descriptor)
    )
      throw new Error('Folded history file changed')
    fs.renameSync(file, join(options.profilePath, 'chats', `${folded.chatId}.json`))
    syncChatsDirectory(options)
  } finally {
    fs.closeSync(fd)
  }
}

function syncChatsDirectory(options: ThreadCatalogueReaderOptions): void {
  let directory: number | undefined
  try {
    directory = fs.openSync(join(options.profilePath, 'chats'), 'r')
    fs.fsyncSync(directory)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? ''
    if (
      !['EINVAL', 'ENOTSUP'].includes(code) &&
      !(process.platform === 'win32' && ['EISDIR', 'EPERM', 'EACCES'].includes(code))
    )
      throw error
  } finally {
    if (directory !== undefined) fs.closeSync(directory)
  }
}
