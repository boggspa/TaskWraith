import { constants } from 'node:fs'
import { lstat, open, type FileHandle } from 'node:fs/promises'

const READ_CHUNK_BYTES = 64 * 1024

export interface BoundedRegularFileReadOptions {
  maxBytes: number
  regularFileErrorMessage?: string
  sizeLimitErrorMessage?: string
}

const defaultRegularFileErrorMessage = 'The selected path must be a regular file.'

function regularFileError(options: BoundedRegularFileReadOptions): Error {
  return new Error(options.regularFileErrorMessage || defaultRegularFileErrorMessage)
}

function sizeLimitError(options: BoundedRegularFileReadOptions): Error {
  return new Error(
    options.sizeLimitErrorMessage || `File exceeds the ${options.maxBytes}-byte read limit.`
  )
}

function assertValidOptions(options: BoundedRegularFileReadOptions): void {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0) {
    throw new RangeError('A non-negative safe-integer byte limit is required.')
  }
}

function isNoFollowError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const code = (error as NodeJS.ErrnoException).code
  return code === 'ELOOP' || code === 'EMLINK'
}

async function readOpenedRegularFile(
  fileHandle: Pick<FileHandle, 'read' | 'stat'>,
  options: BoundedRegularFileReadOptions,
  expectedIdentity?: { dev: bigint; ino: bigint }
): Promise<Buffer> {
  assertValidOptions(options)
  const openedStat = await fileHandle.stat({ bigint: true })
  if (!openedStat.isFile()) throw regularFileError(options)
  if (
    expectedIdentity &&
    (openedStat.dev !== expectedIdentity.dev || openedStat.ino !== expectedIdentity.ino)
  ) {
    throw regularFileError(options)
  }
  if (openedStat.size > BigInt(options.maxBytes)) throw sizeLimitError(options)

  const chunks: Buffer[] = []
  let totalBytes = 0
  let position = 0
  while (true) {
    // Probe one byte beyond the allowed size. This keeps the read bounded even
    // if the file grows after fstat while still allowing a file exactly at the
    // limit when the next descriptor read reaches EOF.
    const readLength = Math.min(
      READ_CHUNK_BYTES,
      options.maxBytes - totalBytes + 1
    )
    const chunk = Buffer.allocUnsafe(readLength)
    const { bytesRead } = await fileHandle.read(chunk, 0, readLength, position)
    if (bytesRead === 0) return Buffer.concat(chunks, totalBytes)

    totalBytes += bytesRead
    position += bytesRead
    if (totalBytes > options.maxBytes) throw sizeLimitError(options)
    chunks.push(chunk.subarray(0, bytesRead))
  }
}

/**
 * Read a regular file without reopening its path between validation and read.
 * The final path component may not be a symlink, the opened inode must match
 * the pre-open path identity, and descriptor reads stop after maxBytes + 1.
 */
export async function readBoundedRegularFile(
  path: string,
  options: BoundedRegularFileReadOptions
): Promise<Buffer> {
  assertValidOptions(options)
  const pathStat = await lstat(path, { bigint: true })
  if (pathStat.isSymbolicLink() || !pathStat.isFile()) throw regularFileError(options)

  let fileHandle: FileHandle
  try {
    fileHandle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    if (isNoFollowError(error)) throw regularFileError(options)
    throw error
  }

  try {
    return await readOpenedRegularFile(fileHandle, options, {
      dev: pathStat.dev,
      ino: pathStat.ino
    })
  } finally {
    await fileHandle.close()
  }
}

/**
 * Reusable descriptor variant for callers that already own a file handle.
 * The handle remains owned by the caller and is never closed here.
 */
export async function readBoundedRegularFileHandle(
  fileHandle: Pick<FileHandle, 'read' | 'stat'>,
  options: BoundedRegularFileReadOptions
): Promise<Buffer> {
  return readOpenedRegularFile(fileHandle, options)
}
