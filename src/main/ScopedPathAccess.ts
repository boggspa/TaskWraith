import { constants, type BigIntStats, type Dirent } from 'node:fs'
import {
  mkdir,
  open,
  lstat,
  realpath,
  readdir,
  type FileHandle
} from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

import {
  readBoundedLineWindowHandle,
  readBoundedRegularFileHandle,
  type BoundedLineWindowResult,
  type ReadFileLineWindowRequest
} from './BoundedRegularFileReader'

export type ScopedPathAccessTestStage =
  | 'after_directory_snapshot'
  | 'before_write_commit'
  | 'after_write_truncate'

type ScopedPathAccessTestHook = (
  stage: ScopedPathAccessTestStage
) => Promise<void> | void

let scopedPathAccessTestHook: ScopedPathAccessTestHook | undefined

export function setScopedPathAccessTestHookForTests(
  hook: ScopedPathAccessTestHook | undefined
): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('Scoped path access test hooks are only available in tests.')
  }
  scopedPathAccessTestHook = hook
}

export interface ScopedPathAuthority {
  rootPath: string
  targetPath: string
}

export interface ScopedRegularFileReadResult {
  buffer: Buffer
  stat: BigIntStats
}

export interface ScopedUtf8FileUpdateResult {
  content: string
  previousContent: string
  stat: BigIntStats
}

export interface ScopedUtf8FileWriteResult {
  content: string
  created: boolean
  stat: BigIntStats
}

export class ScopedPathTargetMissingError extends Error {
  constructor() {
    super('Scoped file target does not exist.')
    this.name = 'ScopedPathTargetMissingError'
  }
}

interface DirectoryIdentity {
  path: string
  dev: bigint
  ino: bigint
}

type DirectorySnapshot = DirectoryIdentity[]

export async function readScopedRegularFile(
  authority: ScopedPathAuthority,
  options: {
    maxBytes: number
    regularFileErrorMessage?: string
    sizeLimitErrorMessage?: string
  }
): Promise<ScopedRegularFileReadResult> {
  const { rootPath, targetPath } = await normalizeAuthority(authority, false)
  const directorySnapshot = await snapshotDirectoryChain(rootPath, dirname(targetPath))
  await runTestHook('after_directory_snapshot')

  const pathStat = await requireRegularTarget(targetPath)
  const fileHandle = await openNoFollow(targetPath, constants.O_RDONLY)
  try {
    const openedStat = await requireOpenedTarget(
      fileHandle,
      targetPath,
      pathStat,
      directorySnapshot
    )
    const buffer = await readBoundedRegularFileHandle(fileHandle, {
      maxBytes: options.maxBytes,
      regularFileErrorMessage:
        options.regularFileErrorMessage || 'Selected path is not a regular file.',
      sizeLimitErrorMessage:
        options.sizeLimitErrorMessage || `File exceeds the ${options.maxBytes}-byte read limit.`
    })
    await assertDirectoryChainStable(directorySnapshot)
    await assertPathMatchesOpenedFile(targetPath, openedStat)
    return { buffer, stat: openedStat }
  } finally {
    await fileHandle.close()
  }
}

/**
 * S4 — the line-window sibling of readScopedRegularFile.
 *
 * Every security step is deliberately IDENTICAL to the whole-file read above:
 * same authority normalization, same directory-chain snapshot, same
 * requireRegularTarget, same openNoFollow, same opened-identity check, same
 * post-read chain-stability and path-match assertions. Only the byte strategy
 * differs — the window is streamed rather than buffered — so this adds a read
 * shape without adding a way around the jail.
 */
export async function readScopedRegularFileLineWindow(
  authority: ScopedPathAuthority,
  request: ReadFileLineWindowRequest,
  options: {
    maxWindowBytes: number
    regularFileErrorMessage?: string
    scanLimitErrorMessage?: string
  }
): Promise<BoundedLineWindowResult> {
  const { rootPath, targetPath } = await normalizeAuthority(authority, false)
  const directorySnapshot = await snapshotDirectoryChain(rootPath, dirname(targetPath))
  await runTestHook('after_directory_snapshot')

  const pathStat = await requireRegularTarget(targetPath)
  const fileHandle = await openNoFollow(targetPath, constants.O_RDONLY)
  try {
    const openedStat = await requireOpenedTarget(
      fileHandle,
      targetPath,
      pathStat,
      directorySnapshot
    )
    const result = await readBoundedLineWindowHandle(fileHandle, request, {
      maxWindowBytes: options.maxWindowBytes,
      regularFileErrorMessage:
        options.regularFileErrorMessage || 'Selected path is not a regular file.',
      ...(options.scanLimitErrorMessage
        ? { scanLimitErrorMessage: options.scanLimitErrorMessage }
        : {})
    })
    await assertDirectoryChainStable(directorySnapshot)
    await assertPathMatchesOpenedFile(targetPath, openedStat)
    return result
  } finally {
    await fileHandle.close()
  }
}

export async function readScopedDirectory(
  authority: ScopedPathAuthority
): Promise<Dirent[]> {
  const { rootPath, targetPath } = await normalizeAuthority(authority, true)
  const directorySnapshot = await snapshotDirectoryChain(rootPath, targetPath)
  await runTestHook('after_directory_snapshot')

  const entries = await readdir(targetPath, { withFileTypes: true })
  await assertDirectoryChainStable(directorySnapshot)
  return entries
}

/**
 * Update an existing UTF-8 regular file through one verified descriptor.
 * New paths are reported with ScopedPathTargetMissingError so the broker can
 * preserve its legacy create-file behavior explicitly. Node does not expose a
 * portable openat(2) walk, so that creation path remains a separate hardening
 * boundary rather than being mislabeled as descriptor-safe here.
 */
export async function updateScopedUtf8File(
  authority: ScopedPathAuthority,
  options: {
    maxBytes: number
    update: (currentContent: string) => string
    beforeCommit?: () => Promise<void> | void
  }
): Promise<ScopedUtf8FileUpdateResult> {
  let rootPath: string
  let targetPath: string
  let directorySnapshot: DirectorySnapshot
  try {
    const normalized = await normalizeAuthority(authority, false)
    rootPath = normalized.rootPath
    targetPath = normalized.targetPath
    directorySnapshot = await snapshotDirectoryChain(rootPath, dirname(targetPath))
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      throw new ScopedPathTargetMissingError()
    }
    throw error
  }
  await runTestHook('after_directory_snapshot')

  let pathStat: BigIntStats
  try {
    pathStat = await requireRegularTarget(targetPath)
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      throw new ScopedPathTargetMissingError()
    }
    throw error
  }

  const fileHandle = await openNoFollow(targetPath, constants.O_RDWR)
  try {
    const openedStat = await requireOpenedTarget(
      fileHandle,
      targetPath,
      pathStat,
      directorySnapshot
    )
    const previousBuffer = await readBoundedRegularFileHandle(fileHandle, {
      maxBytes: options.maxBytes,
      regularFileErrorMessage: 'Selected path is not a regular file.',
      sizeLimitErrorMessage: `File exceeds the ${options.maxBytes}-byte edit limit.`
    })
    assertUtf8Text(previousBuffer)
    const previousContent = previousBuffer.toString('utf8')
    const content = options.update(previousContent)
    const nextBuffer = encodeUtf8Text(content, options.maxBytes)

    await runTestHook('before_write_commit')
    await assertDirectoryChainStable(directorySnapshot)
    await assertPathMatchesOpenedFile(targetPath, openedStat)
    await options.beforeCommit?.()

    try {
      await fileHandle.truncate(0)
      await runTestHook('after_write_truncate')
      await writeBufferAtStart(fileHandle, nextBuffer)
      await fileHandle.sync()

      const savedStat = await fileHandle.stat({ bigint: true })
      assertSameIdentity(openedStat, savedStat)
      await assertDirectoryChainStable(directorySnapshot)
      await assertPathMatchesOpenedFile(targetPath, savedStat)
      return { content, previousContent, stat: savedStat }
    } catch (error) {
      // A truncate-plus-write sequence is not atomic. If the write or its
      // post-commit identity checks fail, restore the bytes we read from this
      // exact descriptor before surfacing the failure. Restoration is best
      // effort (the original ENOSPC/I/O condition may still apply), but never
      // follows the pathname and therefore cannot overwrite a swapped target.
      try {
        await fileHandle.truncate(0)
        await writeBufferAtStart(fileHandle, previousBuffer)
        await fileHandle.sync()
      } catch {
        // Preserve the original write/authority error for the caller.
      }
      throw error
    }
  } finally {
    await fileHandle.close()
  }
}

/**
 * Preserve the broker's established write_file contract while existing files
 * take the descriptor-pinned update path above. New files use a component-wise
 * no-symlink parent walk plus O_EXCL|O_NOFOLLOW for the final leaf. Portable
 * Node still has no openat(2), so concurrent ancestor replacement remains an
 * explicitly documented structural-path residual rather than a race-free
 * guarantee.
 */
export async function writeScopedUtf8FileWithLegacyCreate(
  authority: ScopedPathAuthority,
  options: {
    maxBytes: number
    content: string
    beforeCommit?: () => Promise<void> | void
    assertStillLive?: () => void
  }
): Promise<ScopedUtf8FileWriteResult> {
  const contentBuffer = encodeUtf8Text(options.content, options.maxBytes)
  try {
    const updated = await updateScopedUtf8File(authority, {
      maxBytes: options.maxBytes,
      update: () => options.content,
      beforeCommit: options.beforeCommit
    })
    return { content: updated.content, created: false, stat: updated.stat }
  } catch (error) {
    if (!(error instanceof ScopedPathTargetMissingError)) throw error
  }

  const { rootPath, targetPath } = await normalizePlannedAuthority(authority)
  const targetDirectory = dirname(targetPath)
  const mutationAuthorized = await ensurePlannedDirectoryChain(
    rootPath,
    targetDirectory,
    options.beforeCommit,
    options.assertStillLive
  )
  const directorySnapshot = await snapshotDirectoryChain(rootPath, targetDirectory)
  await runTestHook('after_directory_snapshot')
  await assertDirectoryChainStable(directorySnapshot)
  if (mutationAuthorized) {
    options.assertStillLive?.()
  } else {
    await options.beforeCommit?.()
  }

  const fileHandle = await openNoFollow(
    targetPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
  )
  try {
    const openedStat = await fileHandle.stat({ bigint: true })
    if (!openedStat.isFile()) throw new Error('Created path is not a regular file.')
    await assertDirectoryChainStable(directorySnapshot)
    await assertPathMatchesOpenedFile(targetPath, openedStat)
    try {
      await writeBufferAtStart(fileHandle, contentBuffer)
      await fileHandle.sync()
      const createdStat = await fileHandle.stat({ bigint: true })
      assertSameIdentity(openedStat, createdStat)
      await assertDirectoryChainStable(directorySnapshot)
      await assertPathMatchesOpenedFile(targetPath, createdStat)
      return { content: options.content, created: true, stat: createdStat }
    } catch (error) {
      try {
        await fileHandle.truncate(0)
        await fileHandle.sync()
      } catch {
        // Preserve the original create/write failure.
      }
      throw error
    }
  } finally {
    await fileHandle.close()
  }
}

async function normalizeAuthority(
  authority: ScopedPathAuthority,
  allowRoot: boolean
): Promise<ScopedPathAuthority> {
  if (!isAbsolute(authority.rootPath) || !isAbsolute(authority.targetPath)) {
    throw new Error('Scoped filesystem authority requires absolute paths.')
  }
  const requestedRoot = resolve(authority.rootPath)
  const requestedTarget = resolve(authority.targetPath)
  const relativeTarget = relative(requestedRoot, requestedTarget)
  if (
    relativeTarget === '..' ||
    relativeTarget.startsWith(`..${sep}`) ||
    isAbsolute(relativeTarget) ||
    (!allowRoot && relativeTarget === '')
  ) {
    throw new Error('Path is outside the authorized filesystem root.')
  }

  const rootPath = await realpath(requestedRoot)
  const rootStat = await lstat(rootPath, { bigint: true })
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error('Scoped filesystem authority root is not a stable directory.')
  }
  const targetPath = resolve(rootPath, relativeTarget)
  if (!pathWithinRoot(rootPath, targetPath)) {
    throw new Error('Path is outside the authorized filesystem root.')
  }
  return { rootPath, targetPath }
}

async function normalizePlannedAuthority(
  authority: ScopedPathAuthority
): Promise<ScopedPathAuthority> {
  if (!isAbsolute(authority.rootPath) || !isAbsolute(authority.targetPath)) {
    throw new Error('Scoped filesystem authority requires absolute paths.')
  }
  const requestedRoot = resolve(authority.rootPath)
  const requestedTarget = resolve(authority.targetPath)
  const relativeTarget = relative(requestedRoot, requestedTarget)
  if (
    relativeTarget === '' ||
    relativeTarget === '..' ||
    relativeTarget.startsWith(`..${sep}`) ||
    isAbsolute(relativeTarget)
  ) {
    throw new Error('Path is outside the authorized filesystem root.')
  }
  const rootPath = await realpath(requestedRoot)
  return { rootPath, targetPath: resolve(rootPath, relativeTarget) }
}

async function snapshotDirectoryChain(
  rootPath: string,
  targetDirectory: string
): Promise<DirectorySnapshot> {
  if (!pathWithinRoot(rootPath, targetDirectory)) {
    throw new Error('Path is outside the authorized filesystem root.')
  }
  const paths: string[] = []
  let cursor = targetDirectory
  while (true) {
    paths.push(cursor)
    if (cursor === rootPath) break
    const parent = dirname(cursor)
    if (parent === cursor || !pathWithinRoot(rootPath, parent)) {
      throw new Error('Path is outside the authorized filesystem root.')
    }
    cursor = parent
  }
  paths.reverse()

  const snapshot: DirectorySnapshot = []
  for (const path of paths) {
    const stat = await lstat(path, { bigint: true })
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error('Authorized filesystem path contains an unstable directory.')
    }
    snapshot.push({ path, dev: stat.dev, ino: stat.ino })
  }
  return snapshot
}

async function ensurePlannedDirectoryChain(
  rootPath: string,
  targetDirectory: string,
  beforeFirstMutation?: () => Promise<void> | void,
  assertStillLive?: () => void
): Promise<boolean> {
  if (!pathWithinRoot(rootPath, targetDirectory)) {
    throw new Error('Path is outside the authorized filesystem root.')
  }
  const relativeDirectory = relative(rootPath, targetDirectory)
  let cursor = rootPath
  let mutationAuthorized = false
  for (const segment of relativeDirectory.split(sep).filter(Boolean)) {
    cursor = resolve(cursor, segment)
    try {
      const existing = await lstat(cursor, { bigint: true })
      if (existing.isSymbolicLink() || !existing.isDirectory()) {
        throw new Error('Authorized filesystem path contains an unstable directory.')
      }
      continue
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'ENOENT') throw error
    }
    if (mutationAuthorized) {
      assertStillLive?.()
    } else {
      await beforeFirstMutation?.()
      mutationAuthorized = true
    }
    try {
      await mkdir(cursor)
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'EEXIST') throw error
    }
    const created = await lstat(cursor, { bigint: true })
    if (created.isSymbolicLink() || !created.isDirectory()) {
      throw new Error('Authorized filesystem path contains an unstable directory.')
    }
  }
  return mutationAuthorized
}

async function assertDirectoryChainStable(snapshot: DirectorySnapshot): Promise<void> {
  for (const expected of snapshot) {
    const stat = await lstat(expected.path, { bigint: true })
    if (
      stat.isSymbolicLink() ||
      !stat.isDirectory() ||
      stat.dev !== expected.dev ||
      stat.ino !== expected.ino
    ) {
      throw new Error('Authorized filesystem path changed during access.')
    }
  }
}

async function requireRegularTarget(targetPath: string): Promise<BigIntStats> {
  const stat = await lstat(targetPath, { bigint: true })
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error('Selected path is not a regular file.')
  }
  return stat
}

async function openNoFollow(targetPath: string, flags: number): Promise<FileHandle> {
  try {
    return await open(targetPath, flags | constants.O_NOFOLLOW)
  } catch (error) {
    if (isNodeError(error) && (error.code === 'ELOOP' || error.code === 'EMLINK')) {
      throw new Error('Selected path is not a regular file.')
    }
    throw error
  }
}

async function requireOpenedTarget(
  fileHandle: FileHandle,
  targetPath: string,
  pathStat: BigIntStats,
  directorySnapshot: DirectorySnapshot
): Promise<BigIntStats> {
  const openedStat = await fileHandle.stat({ bigint: true })
  if (!openedStat.isFile()) throw new Error('Selected path is not a regular file.')
  assertSameIdentity(pathStat, openedStat)
  await assertDirectoryChainStable(directorySnapshot)
  await assertPathMatchesOpenedFile(targetPath, openedStat)
  return openedStat
}

async function assertPathMatchesOpenedFile(
  targetPath: string,
  openedStat: BigIntStats
): Promise<void> {
  const current = await lstat(targetPath, { bigint: true })
  if (current.isSymbolicLink() || !current.isFile()) {
    throw new Error('Authorized file path changed during access.')
  }
  assertSameIdentity(openedStat, current)
}

function assertSameIdentity(expected: BigIntStats, actual: BigIntStats): void {
  if (
    expected.dev !== actual.dev ||
    expected.ino !== actual.ino ||
    !actual.isFile()
  ) {
    throw new Error('Authorized file path changed during access.')
  }
}

function pathWithinRoot(rootPath: string, targetPath: string): boolean {
  const rel = relative(rootPath, targetPath)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function assertUtf8Text(buffer: Buffer): void {
  if (buffer.includes(0)) throw new Error('Only UTF-8 text files can be edited.')
  const text = buffer.toString('utf8')
  if (!Buffer.from(text, 'utf8').equals(buffer)) {
    throw new Error('Only UTF-8 text files can be edited.')
  }
}

function encodeUtf8Text(content: string, maxBytes: number): Buffer {
  if (content.includes('\0')) throw new Error('Only UTF-8 text files can be edited.')
  const buffer = Buffer.from(content, 'utf8')
  if (buffer.toString('utf8') !== content) {
    throw new Error('Only UTF-8 text files can be edited.')
  }
  if (buffer.length > maxBytes) {
    throw new Error(`File exceeds the ${maxBytes}-byte edit limit.`)
  }
  assertUtf8Text(buffer)
  return buffer
}

async function writeBufferAtStart(fileHandle: FileHandle, buffer: Buffer): Promise<void> {
  let offset = 0
  while (offset < buffer.length) {
    const { bytesWritten } = await fileHandle.write(
      buffer,
      offset,
      buffer.length - offset,
      offset
    )
    if (bytesWritten <= 0) throw new Error('Could not complete the scoped file write.')
    offset += bytesWritten
  }
}

async function runTestHook(stage: ScopedPathAccessTestStage): Promise<void> {
  await scopedPathAccessTestHook?.(stage)
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(error && typeof error === 'object' && 'code' in error)
}
