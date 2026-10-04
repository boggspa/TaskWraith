import * as fs from 'node:fs'

const NEWLINE = 0x0a

/** Where the bytes of one journal segment stop being lines a reader replays. */
export interface SegmentTailMeasure {
  /** Bytes through the last newline: every complete line, valid or not. */
  completeBytes: number
  /** Bytes of the leading run of complete lines the validator accepts. */
  validBytes: number
}

export type SegmentTailRepair =
  | { status: 'missing' }
  | { status: 'clean'; size: number }
  /** The fragment after the last newline was removed; `size` is what remains. */
  | { status: 'repaired'; size: number; removedBytes: number }
  /** A complete line is invalid. Nothing was removed; `validBytes` is where it starts. */
  | { status: 'corrupt'; size: number; validBytes: number }

export interface SegmentTailRepairOptions {
  /** True when one complete line, without its newline, is one a reader replays. */
  isValidLine(line: Buffer): boolean
  /** Runs only when a fragment is about to be removed. Throwing leaves the file as it was. */
  beforeSourceMutation?(): void
  /** Runs after the guard and before the truncation: no cached descriptor may outlive it. */
  retireDescriptor?(): void
  /** A larger segment is refused rather than read into memory. */
  maxBytes?: number
}

/**
 * Lines are split on the newline byte, never on decoded text: a fragment can
 * end inside a multi-byte character, and that byte never occurs inside one.
 */
export function measureSegmentTail(
  bytes: Buffer,
  isValidLine: (line: Buffer) => boolean
): SegmentTailMeasure {
  let offset = 0
  let validBytes = 0
  for (;;) {
    const newline = bytes.indexOf(NEWLINE, offset)
    if (newline < 0) break
    if (!isValidLine(bytes.subarray(offset, newline))) {
      return { completeBytes: bytes.lastIndexOf(NEWLINE) + 1, validBytes }
    }
    offset = newline + 1
    validBytes = offset
  }
  return { completeBytes: offset, validBytes }
}

function readAll(fd: number, size: number): Buffer {
  const bytes = Buffer.allocUnsafe(size)
  let offset = 0
  while (offset < size) {
    const count = fs.readSync(fd, bytes, offset, size - offset, offset)
    if (count === 0) break
    offset += count
  }
  return bytes.subarray(0, offset)
}

/**
 * Remove the torn fragment a crash left after a segment's last complete line,
 * in place, so the next append starts on a line boundary. A writer calls this
 * before it first appends to a segment it did not create; a read never does.
 *
 * Only bytes after the last newline are ever removed, and only when every
 * complete line before them is valid. A segment holding an invalid complete
 * line is damaged rather than torn: it is reported and left byte for byte,
 * because the lines after the damage may be the only copy of what they hold.
 */
export function repairSegmentTornTail(
  filePath: string,
  options: SegmentTailRepairOptions
): SegmentTailRepair {
  let fd: number
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW ?? 0))
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing' }
    throw error
  }
  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile()) throw new Error(`Journal segment is not a regular file: ${filePath}`)
    if (options.maxBytes !== undefined && stat.size > options.maxBytes) {
      throw new Error(`Journal segment exceeds ${options.maxBytes} bytes: ${filePath}`)
    }
    const bytes = readAll(fd, stat.size)
    const size = bytes.length
    const { completeBytes, validBytes } = measureSegmentTail(bytes, options.isValidLine)
    if (validBytes < completeBytes) return { status: 'corrupt', size, validBytes }
    if (completeBytes === size) return { status: 'clean', size }
    options.beforeSourceMutation?.()
    options.retireDescriptor?.()
    fs.ftruncateSync(fd, completeBytes)
    // The descriptor retired above may have carried this file's flush debt.
    fs.fsyncSync(fd)
    return { status: 'repaired', size: completeBytes, removedBytes: size - completeBytes }
  } finally {
    fs.closeSync(fd)
  }
}
