import { constants } from 'node:fs'
import { lstat, open, type FileHandle } from 'node:fs/promises'
import {
  MCP_READ_FILE_WINDOW_DEFAULT_LINES,
  MCP_READ_FILE_WINDOW_MAX_LINES
} from './index.constants'

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

// ── S4: line windows that are bounded by CONSTRUCTION ──────────────────────
//
// read_file's own description tells agents to pass offset/limit instead of
// shelling out to `sed` for a large file. That advice could not work: the whole
// file was buffered under MAX_EDITOR_FILE_BYTES and only sliced afterwards, so
// the byte gate fired first and the error named neither the remedy nor a
// fallback. Every seat that followed the documentation was pushed straight back
// to the tool the documentation discourages.
//
// The fix is NOT a bigger byte cap — that cap is the bridge's safety model and
// stays exactly where it is. A line window is small by definition, so it is
// served by STREAMING: fixed-size chunks are scanned for newlines and
// discarded, and only the requested lines are ever retained. Peak memory is one
// chunk plus the capped window, whatever the file size.

/**
 * Total bytes we will scan to locate a window. Reaching line N requires
 * counting N-1 newlines from the start (there is no line index), so this bounds
 * the work a single call can provoke. It is NOT a buffering limit — scanned
 * bytes are discarded — so it can sit far above MAX_EDITOR_FILE_BYTES.
 */
export const MAX_LINE_WINDOW_SCAN_BYTES = 64 * 1024 * 1024

const NEWLINE_BYTE = 0x0a

export interface ReadFileLineWindowRequest {
  /** 1-based first line to return. */
  startLine: number
  /** Maximum number of lines to return. */
  maxLines: number
}

/**
 * Resolve read_file's offset/limit into a concrete window, or null when the
 * caller asked for the whole file. Deliberately mirrors windowReadFileText's
 * argument handling: the two read paths must agree about what was requested,
 * and BoundedRegularFileReader.test.ts pins them byte-equal so this cannot
 * drift away from the whole-file path unnoticed.
 */
export function resolveReadFileLineWindowRequest(args: {
  offset?: unknown
  limit?: unknown
}): ReadFileLineWindowRequest | null {
  const offsetArg = Number(args.offset)
  const limitArg = Number(args.limit)
  const hasOffset = Number.isFinite(offsetArg) && offsetArg >= 1
  const hasLimit = Number.isFinite(limitArg) && limitArg >= 1
  if (!hasOffset && !hasLimit) return null
  return {
    startLine: hasOffset ? Math.trunc(offsetArg) : 1,
    maxLines: hasLimit
      ? Math.min(Math.trunc(limitArg), MCP_READ_FILE_WINDOW_MAX_LINES)
      : MCP_READ_FILE_WINDOW_DEFAULT_LINES
  }
}

/** Render a streamed window in the exact shape the whole-file path returns. */
export function formatReadFileLineWindow(result: {
  windowText: string
  startLine: number
  endLine: number
  totalLines: number
}): string {
  if (result.startLine > result.totalLines) {
    const clamped = Math.min(result.startLine, result.totalLines + 1)
    return `[read_file: offset ${clamped} is past the end of the file (${result.totalLines} lines)]`
  }
  return `[read_file: lines ${result.startLine}-${result.endLine} of ${result.totalLines}]\n${result.windowText}`
}

export interface BoundedLineWindowResult {
  /** Exact bytes of the selected lines, separators included, no trailing newline. */
  window: Buffer
  startLine: number
  /** Last line actually returned, clamped to totalLines. Unused past EOF. */
  endLine: number
  totalLines: number
  /** True when maxWindowBytes cut the window short. */
  truncated: boolean
}

export interface BoundedLineWindowOptions {
  maxWindowBytes: number
  regularFileErrorMessage?: string
  scanLimitErrorMessage?: string
}

function scanLimitError(options: BoundedLineWindowOptions): Error {
  return new Error(
    options.scanLimitErrorMessage ||
      `File exceeds the ${MAX_LINE_WINDOW_SCAN_BYTES}-byte line-window scan limit.`
  )
}

/**
 * Stream a line window from an already-opened, already-verified handle.
 *
 * The window is the byte range from the start of `startLine` through the end of
 * the last requested line, exclusive of that line's terminator — byte-identical
 * to slicing the decoded text, without ever holding the decoded text.
 */
export async function readBoundedLineWindowHandle(
  fileHandle: Pick<FileHandle, 'read' | 'stat'>,
  request: ReadFileLineWindowRequest,
  options: BoundedLineWindowOptions
): Promise<BoundedLineWindowResult> {
  if (!Number.isSafeInteger(options.maxWindowBytes) || options.maxWindowBytes < 0) {
    throw new RangeError('A non-negative safe-integer window byte limit is required.')
  }
  const openedStat = await fileHandle.stat({ bigint: true })
  if (!openedStat.isFile()) {
    throw new Error(options.regularFileErrorMessage || defaultRegularFileErrorMessage)
  }
  if (openedStat.size > BigInt(MAX_LINE_WINDOW_SCAN_BYTES)) throw scanLimitError(options)

  // Newline ordinals bracket the window: line N starts after newline N-1.
  const startNewlineOrdinal = request.startLine - 1
  const endNewlineOrdinal = request.startLine + request.maxLines - 1

  let newlineCount = 0
  let position = 0
  let startByte = request.startLine <= 1 ? 0 : -1
  let endByte = -1
  let windowBytes = 0
  let truncated = false
  const windowChunks: Buffer[] = []

  // The scan always runs to EOF. Stopping at the window's end would leave the
  // newline count short, and the reported total ("of N lines") has to match the
  // whole-file path exactly or the two read paths disagree about the same file.
  // Only COLLECTION stops early; scanning is what stays cheap.
  while (true) {
    const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES)
    const { bytesRead } = await fileHandle.read(chunk, 0, READ_CHUNK_BYTES, position)
    if (bytesRead === 0) break
    if (position + bytesRead > MAX_LINE_WINDOW_SCAN_BYTES) throw scanLimitError(options)

    for (let index = 0; index < bytesRead; index += 1) {
      if (chunk[index] !== NEWLINE_BYTE) continue
      newlineCount += 1
      if (newlineCount === startNewlineOrdinal) startByte = position + index + 1
      if (newlineCount === endNewlineOrdinal && endByte < 0) endByte = position + index
    }

    // Retain only the bytes that fall inside the window; everything else is
    // scanned and dropped, which is what keeps this bounded on a huge file.
    if (startByte >= 0 && !truncated) {
      const chunkEnd = position + bytesRead
      const from = Math.max(startByte, position)
      const to = endByte >= 0 ? Math.min(endByte, chunkEnd) : chunkEnd
      if (to > from) {
        let slice = chunk.subarray(from - position, to - position)
        if (windowBytes + slice.length > options.maxWindowBytes) {
          slice = slice.subarray(0, Math.max(0, options.maxWindowBytes - windowBytes))
          truncated = true
        }
        if (slice.length > 0) {
          windowChunks.push(Buffer.from(slice))
          windowBytes += slice.length
        }
      }
    }

    position += bytesRead
  }

  // `text.split('\n').length` is always newlines + 1, so a trailing newline
  // yields a final empty line exactly as the whole-file path reports it.
  const totalLines = newlineCount + 1
  const endLine = Math.min(request.startLine + request.maxLines - 1, totalLines)
  return {
    window: Buffer.concat(windowChunks, windowBytes),
    startLine: request.startLine,
    endLine,
    totalLines,
    truncated
  }
}
