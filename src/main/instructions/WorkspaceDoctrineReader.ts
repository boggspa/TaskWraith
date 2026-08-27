import * as fs from 'node:fs'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import {
  WORKSPACE_DOCTRINE_FILE,
  WORKSPACE_DOCTRINE_MAX_BYTES,
  type InstructionSkipReason,
  type ResolvedWorkspaceDoctrine
} from '../../shared/instructions/InstructionTypes'

/** [start, end] inclusive. Kept in parity with doctrine-integrity-guard.cjs. */
const FORBIDDEN_CODE_POINT_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00ad, 0x00ad],
  [0x180e, 0x180e],
  [0x200b, 0x200d],
  [0x200e, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x2064],
  [0x2066, 0x2069],
  [0xfe00, 0xfe0f],
  [0xfeff, 0xfeff],
  [0xe0000, 0xe007f]
]

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf])

/** Test-only race seam; production callers omit it. */
export interface WorkspaceDoctrineReaderHooks {
  afterPathInspection?: (filePath: string) => void
  afterDescriptorOpen?: (filePath: string) => void
}

function realpathNative(input: string): string {
  return typeof fs.realpathSync.native === 'function'
    ? fs.realpathSync.native(input)
    : fs.realpathSync(input)
}

function pathWithinRoot(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate)
  return (
    relative === '' ||
    (relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative))
  )
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function byteCount(size: bigint): number | undefined {
  return size <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(size) : undefined
}

function skipped(skipReason: InstructionSkipReason, bytes?: number): ResolvedWorkspaceDoctrine {
  return {
    source: WORKSPACE_DOCTRINE_FILE,
    status: 'skipped',
    skipReason,
    ...(bytes === undefined ? {} : { bytes })
  }
}

function absent(bytes?: number): ResolvedWorkspaceDoctrine {
  return {
    source: WORKSPACE_DOCTRINE_FILE,
    status: 'absent',
    ...(bytes === undefined ? {} : { bytes })
  }
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' ? (error as NodeJS.ErrnoException).code : undefined
}

function isMissingPathError(error: unknown): boolean {
  const code = errorCode(error)
  return code === 'ENOENT' || code === 'ENOTDIR'
}

function isNoFollowError(error: unknown): boolean {
  const code = errorCode(error)
  return code === 'ELOOP' || code === 'EMLINK'
}

function sameIdentity(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function sameSnapshot(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return (
    sameIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  )
}

function containsUnsafeCharacter(text: string): boolean {
  for (const character of text) {
    const codePoint = character.codePointAt(0)
    if (codePoint === undefined) return true
    const disallowedControl =
      (codePoint >= 0 && codePoint <= 0x08) ||
      codePoint === 0x0b ||
      codePoint === 0x0c ||
      (codePoint >= 0x0e && codePoint <= 0x1f) ||
      codePoint === 0x7f
    if (disallowedControl) return true
    if (
      FORBIDDEN_CODE_POINT_RANGES.some(([start, end]) => codePoint >= start && codePoint <= end)
    ) {
      return true
    }
  }
  return false
}

function classifyBuffer(buffer: Buffer): ResolvedWorkspaceDoctrine {
  if (buffer.subarray(0, UTF8_BOM.length).equals(UTF8_BOM)) {
    return skipped('unsafe_characters', buffer.byteLength)
  }

  let decoded: string
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    return skipped('invalid_utf8', buffer.byteLength)
  }
  if (containsUnsafeCharacter(decoded)) {
    return skipped('unsafe_characters', buffer.byteLength)
  }

  const normalized = decoded.replace(/\r\n/g, '\n').trim()
  if (!normalized) return absent(buffer.byteLength)
  return {
    source: WORKSPACE_DOCTRINE_FILE,
    status: 'applied',
    sha256: sha256Hex(normalized),
    bytes: buffer.byteLength,
    content: normalized
  }
}

function readOpenedBounded(fd: number): Buffer | null {
  const buffer = Buffer.allocUnsafe(WORKSPACE_DOCTRINE_MAX_BYTES + 1)
  let totalBytes = 0
  while (totalBytes < buffer.byteLength) {
    const bytesRead = fs.readSync(
      fd,
      buffer,
      totalBytes,
      buffer.byteLength - totalBytes,
      totalBytes
    )
    if (bytesRead === 0) break
    totalBytes += bytesRead
  }
  if (totalBytes > WORKSPACE_DOCTRINE_MAX_BYTES) return null
  return buffer.subarray(0, totalBytes)
}

/**
 * Resolve the workspace-root AGENTS.md without enabling provider-native
 * project discovery. The file is read from one no-follow descriptor, capped
 * before allocation/read, and rejected if its path or descriptor snapshot
 * changes while it is being inspected.
 */
export function resolveWorkspaceDoctrine(
  workspacePath: string,
  hooks: WorkspaceDoctrineReaderHooks = {}
): ResolvedWorkspaceDoctrine {
  if (!workspacePath.trim()) return skipped('unreadable')

  let realRoot: string
  try {
    realRoot = realpathNative(path.resolve(workspacePath))
  } catch {
    return skipped('unreadable')
  }

  const filePath = path.join(realRoot, WORKSPACE_DOCTRINE_FILE)
  let pathStat: fs.BigIntStats
  try {
    pathStat = fs.lstatSync(filePath, { bigint: true })
  } catch (error) {
    return isMissingPathError(error) ? absent() : skipped('unreadable')
  }
  const initialBytes = byteCount(pathStat.size)
  if (pathStat.isSymbolicLink()) return skipped('symlink_refused', initialBytes)
  if (!pathStat.isFile()) return skipped('unreadable', initialBytes)
  if (pathStat.size > BigInt(WORKSPACE_DOCTRINE_MAX_BYTES)) {
    return skipped('too_large', initialBytes)
  }

  try {
    const realFile = realpathNative(filePath)
    if (!pathWithinRoot(realFile, realRoot)) {
      return skipped('outside_workspace', initialBytes)
    }
  } catch {
    return skipped('unreadable', initialBytes)
  }

  hooks.afterPathInspection?.(filePath)

  let fd: number
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
  } catch (error) {
    return isNoFollowError(error)
      ? skipped('symlink_refused', initialBytes)
      : skipped('unreadable', initialBytes)
  }

  try {
    let openedStat: fs.BigIntStats
    try {
      openedStat = fs.fstatSync(fd, { bigint: true })
    } catch {
      return skipped('unreadable', initialBytes)
    }
    if (!openedStat.isFile() || !sameIdentity(pathStat, openedStat)) {
      return skipped('unreadable', byteCount(openedStat.size))
    }
    if (openedStat.size > BigInt(WORKSPACE_DOCTRINE_MAX_BYTES)) {
      return skipped('too_large', byteCount(openedStat.size))
    }

    hooks.afterDescriptorOpen?.(filePath)

    let buffer: Buffer | null
    try {
      buffer = readOpenedBounded(fd)
    } catch {
      return skipped('unreadable', byteCount(openedStat.size))
    }
    if (!buffer) return skipped('too_large', WORKSPACE_DOCTRINE_MAX_BYTES + 1)

    let finalOpenedStat: fs.BigIntStats
    let finalPathStat: fs.BigIntStats
    try {
      finalOpenedStat = fs.fstatSync(fd, { bigint: true })
      finalPathStat = fs.lstatSync(filePath, { bigint: true })
    } catch {
      return skipped('unreadable', buffer.byteLength)
    }
    if (
      finalPathStat.isSymbolicLink() ||
      !finalPathStat.isFile() ||
      !sameSnapshot(openedStat, finalOpenedStat) ||
      !sameSnapshot(finalOpenedStat, finalPathStat)
    ) {
      return skipped('unreadable', buffer.byteLength)
    }

    return classifyBuffer(buffer)
  } finally {
    fs.closeSync(fd)
  }
}
