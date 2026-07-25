import { constants, promises as fs } from 'fs'
import type { BigIntStats, Dirent } from 'fs'
import type { FileHandle } from 'fs/promises'
import { basename, dirname, join, resolve } from 'path'
import { createHash, randomBytes } from 'crypto'
import {
  MAX_EDITOR_DEPTH,
  MAX_EDITOR_FILE_BYTES,
  MAX_EDITOR_FILES,
  SKIP_EDITOR_DIRS
} from '../index.constants'
import { isPathInsideWorkspace } from '../AgenticPolicy'
import { resolveWorkspaceChild, toWorkspaceRelativePath } from '../PathScope'
import type {
  WorkspaceChangeSet,
  WorkspaceEditorChangeInput,
  WorkspaceFileEntry,
  WorkspaceFileReadResult
} from '../store/types'

export interface WorkspaceFileListResult {
  entries: WorkspaceFileEntry[]
  truncated: boolean
}

export interface WorkspaceFileListOptions {
  /** Directory path relative to the workspace. Empty / omitted means root. */
  path?: string
  /** Optional server-side path search. When present, `path` is ignored. */
  query?: string
  /** Whether search results may include matching directories. Defaults to true. */
  includeDirectories?: boolean
  /** Returned entry cap. Legacy flat lists keep MAX_EDITOR_FILES. */
  limit?: number
}

export type RecordWorkspaceEditorChangeFn = (
  input: WorkspaceEditorChangeInput
) => WorkspaceChangeSet

/**
 * How `content` travels across the IPC boundary. The default 'utf8' keeps the
 * historical text-only contract (NUL/invalid-UTF-8 rejected). 'base64' is the
 * opt-in lane for structured binary documents (docx/xlsx/pptx via the Office
 * suite); callers using it are expected to skip `recordChange` — change-set
 * diffs are text-oriented.
 */
export type WorkspaceFileContentEncoding = 'utf8' | 'base64'

export interface WorkspaceFileReadOptions {
  encoding?: WorkspaceFileContentEncoding
  /** Per-call size ceiling override; defaults to MAX_EDITOR_FILE_BYTES. */
  maxBytes?: number
}

export interface WorkspaceFileWriteOptions {
  workspacePath: string
  workspaceId?: string
  filePath: string
  content: string
  /** Required for remote/iOS writes. Desktop passes the etag returned by read. */
  baseEtag?: string | null
  origin?: string
  recordChange?: RecordWorkspaceEditorChangeFn
  requireBaseEtag?: boolean
  contentEncoding?: WorkspaceFileContentEncoding
  /** Per-call size ceiling override; defaults to MAX_EDITOR_FILE_BYTES. */
  maxBytes?: number
}

export interface WorkspaceFileDeleteOptions {
  workspacePath: string
  workspaceId?: string
  filePath: string
  /** Required for editor deletes so external edits are not silently removed. */
  baseEtag?: string | null
  origin?: string
  recordChange?: RecordWorkspaceEditorChangeFn
  requireBaseEtag?: boolean
}

export interface WorkspaceFileDeleteResult {
  path: string
  changeSet?: WorkspaceChangeSet
}

export type WorkspaceFileEditorErrorCode =
  | 'path_outside_workspace'
  | 'directory_selected'
  | 'file_too_large'
  | 'binary_file'
  | 'missing_base_etag'
  | 'stale_etag'
  | 'symlink_unsupported'

export type WorkspaceFileEditorTestHookStage =
  | 'before_read_open'
  | 'before_write_parent_snapshot'
  | 'before_write_commit'
  | 'after_write_truncate'
  | 'before_new_file_commit'
  | 'before_delete_commit'

type WorkspaceFileEditorTestHook = (stage: WorkspaceFileEditorTestHookStage) => Promise<void> | void

let workspaceFileEditorTestHook: WorkspaceFileEditorTestHook | undefined

/** Test-only seam for deterministically exercising filesystem replacement races. */
export function setWorkspaceFileEditorTestHookForTests(
  hook: WorkspaceFileEditorTestHook | undefined
): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('Workspace file editor test hooks are only available in tests.')
  }
  workspaceFileEditorTestHook = hook
}

export class WorkspaceFileEditorError extends Error {
  readonly code: WorkspaceFileEditorErrorCode

  constructor(code: WorkspaceFileEditorErrorCode, message: string) {
    super(message)
    this.name = 'WorkspaceFileEditorError'
    this.code = code
  }
}

const DIRECTORY_LIST_LIMIT_MAX = 500
const DIRECTORY_LIST_LIMIT_DEFAULT = 240
const SEARCH_LIST_LIMIT_DEFAULT = 160

export async function listWorkspaceFiles(
  workspacePath: string,
  options: WorkspaceFileListOptions = {}
): Promise<WorkspaceFileListResult> {
  const query = options.query?.trim()
  if (query) {
    return searchWorkspaceFiles(workspacePath, query, options.limit, options.includeDirectories)
  }
  if (options.path !== undefined || options.limit !== undefined) {
    return listWorkspaceDirectory(workspacePath, options.path ?? '', options.limit)
  }
  return listWorkspaceFilesFlat(workspacePath)
}

async function listWorkspaceFilesFlat(workspacePath: string): Promise<WorkspaceFileListResult> {
  const workspaceRoot = resolve(workspacePath)
  const entries: WorkspaceFileEntry[] = []
  let truncated = false

  async function walk(dirPath: string, depth: number): Promise<void> {
    if (entries.length >= MAX_EDITOR_FILES) {
      truncated = true
      return
    }
    if (depth > MAX_EDITOR_DEPTH) {
      truncated = true
      return
    }

    let dirEntries
    try {
      dirEntries = await fs.readdir(dirPath, { withFileTypes: true })
    } catch {
      return
    }

    dirEntries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
      return a.name.localeCompare(b.name)
    })

    for (const dirent of dirEntries) {
      if (entries.length >= MAX_EDITOR_FILES) {
        truncated = true
        break
      }
      if (dirent.name.startsWith('.') && dirent.name !== '.env') continue
      if (dirent.isDirectory() && SKIP_EDITOR_DIRS.has(dirent.name)) continue
      if (dirent.isSymbolicLink()) continue

      const fullPath = join(dirPath, dirent.name)
      const relPath = toWorkspaceRelativePath(workspaceRoot, fullPath)
      let sizeBytes: number | undefined

      if (!dirent.isDirectory()) {
        try {
          const stat = await fs.stat(fullPath)
          if (!stat.isFile()) continue
          sizeBytes = stat.size
        } catch {
          continue
        }
      }

      entries.push({
        path: relPath,
        name: dirent.name,
        isDirectory: dirent.isDirectory(),
        sizeBytes,
        depth,
        hasChildren: dirent.isDirectory() ? await directoryHasVisibleChildren(fullPath) : undefined
      })

      if (dirent.isDirectory()) {
        await walk(fullPath, depth + 1)
      }
    }
  }

  await walk(workspaceRoot, 0)
  return { entries, truncated }
}

async function listWorkspaceDirectory(
  workspacePath: string,
  dirPath: string,
  limit = DIRECTORY_LIST_LIMIT_DEFAULT
): Promise<WorkspaceFileListResult> {
  const workspaceRoot = resolve(workspacePath)
  const maxEntries = clampListLimit(limit)
  const targetPath = await resolveReadableDirectory(workspaceRoot, dirPath, true)
  const parentDepth = depthForRelativePath(toWorkspaceRelativePath(workspaceRoot, targetPath))
  const entries: WorkspaceFileEntry[] = []
  let truncated = false

  let dirEntries
  try {
    dirEntries = await fs.readdir(targetPath, { withFileTypes: true })
  } catch {
    return { entries, truncated: false }
  }

  dirEntries.sort(sortDirents)

  for (const dirent of dirEntries) {
    if (entries.length >= maxEntries) {
      truncated = true
      break
    }
    if (shouldSkipDirent(dirent)) continue

    const fullPath = join(targetPath, dirent.name)
    const relPath = toWorkspaceRelativePath(workspaceRoot, fullPath)
    const isDirectory = dirent.isDirectory()
    let sizeBytes: number | undefined

    if (!isDirectory) {
      try {
        const stat = await fs.stat(fullPath)
        if (!stat.isFile()) continue
        sizeBytes = stat.size
      } catch {
        continue
      }
    }

    entries.push({
      path: relPath,
      name: dirent.name,
      isDirectory,
      sizeBytes,
      depth: parentDepth,
      hasChildren: isDirectory ? await directoryHasVisibleChildren(fullPath) : undefined
    })
  }

  return { entries, truncated }
}

async function searchWorkspaceFiles(
  workspacePath: string,
  query: string,
  limit = SEARCH_LIST_LIMIT_DEFAULT,
  includeDirectories = true
): Promise<WorkspaceFileListResult> {
  const workspaceRoot = resolve(workspacePath)
  const maxEntries = clampListLimit(limit)
  const needle = query.toLowerCase()
  const entries: WorkspaceFileEntry[] = []
  let truncated = false

  async function walk(dirPath: string, depth: number): Promise<void> {
    if (entries.length >= maxEntries) {
      truncated = true
      return
    }
    if (depth > MAX_EDITOR_DEPTH) {
      truncated = true
      return
    }

    let dirEntries
    try {
      dirEntries = await fs.readdir(dirPath, { withFileTypes: true })
    } catch {
      return
    }

    dirEntries.sort(sortDirents)

    for (const dirent of dirEntries) {
      if (entries.length >= maxEntries) {
        truncated = true
        break
      }
      if (shouldSkipDirent(dirent)) continue

      const fullPath = join(dirPath, dirent.name)
      const relPath = toWorkspaceRelativePath(workspaceRoot, fullPath)
      const isDirectory = dirent.isDirectory()
      const matches = relPath.toLowerCase().includes(needle)
      let sizeBytes: number | undefined

      if (!isDirectory) {
        try {
          const stat = await fs.stat(fullPath)
          if (!stat.isFile()) continue
          sizeBytes = stat.size
        } catch {
          continue
        }
      }

      if (matches && (includeDirectories || !isDirectory)) {
        entries.push({
          path: relPath,
          name: dirent.name,
          isDirectory,
          sizeBytes,
          depth,
          hasChildren: isDirectory ? await directoryHasVisibleChildren(fullPath) : undefined
        })
      }

      if (isDirectory) {
        await walk(fullPath, depth + 1)
      }
    }
  }

  await walk(workspaceRoot, 0)
  return { entries, truncated }
}

function clampListLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit) || !Number.isInteger(limit)) {
    return DIRECTORY_LIST_LIMIT_DEFAULT
  }
  return Math.min(DIRECTORY_LIST_LIMIT_MAX, Math.max(1, limit))
}

function sortDirents(a: Dirent, b: Dirent): number {
  if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
  return a.name.localeCompare(b.name)
}

function shouldSkipDirent(dirent: Dirent): boolean {
  if (dirent.name.startsWith('.') && dirent.name !== '.env') return true
  if (dirent.isDirectory() && SKIP_EDITOR_DIRS.has(dirent.name)) return true
  if (dirent.isSymbolicLink()) return true
  return false
}

async function directoryHasVisibleChildren(dirPath: string): Promise<boolean> {
  try {
    const children = await fs.readdir(dirPath, { withFileTypes: true })
    return children.some((child) => !shouldSkipDirent(child))
  } catch {
    return false
  }
}

function depthForRelativePath(relativePath: string): number {
  if (!relativePath || relativePath === '.') return 0
  return relativePath.split('/').filter(Boolean).length
}

async function resolveReadableDirectory(
  workspaceRoot: string,
  dirPath: string,
  allowRoot = false
): Promise<string> {
  const trimmed = dirPath.trim()
  const targetPath = trimmed ? resolveWorkspaceChild(workspaceRoot, trimmed) : workspaceRoot
  const lstat = await fs.lstat(targetPath)
  if (lstat.isSymbolicLink()) {
    throw new WorkspaceFileEditorError(
      'symlink_unsupported',
      'Symbolic links cannot be browsed from the file editor.'
    )
  }
  if (!lstat.isDirectory()) {
    throw new WorkspaceFileEditorError('directory_selected', 'Selected item is not a directory.')
  }
  if (!allowRoot && targetPath === workspaceRoot) {
    throw new WorkspaceFileEditorError('path_outside_workspace', 'Path is outside the workspace.')
  }
  const realWorkspace = await fs.realpath(workspaceRoot)
  const realTarget = await fs.realpath(targetPath)
  if (!isPathInsideWorkspace(realWorkspace, realTarget)) {
    throw new WorkspaceFileEditorError('path_outside_workspace', 'Path is outside the workspace.')
  }
  return targetPath
}

export async function readWorkspaceFile(
  workspacePath: string,
  filePath: string,
  options: WorkspaceFileReadOptions = {}
): Promise<WorkspaceFileReadResult> {
  const encoding = options.encoding ?? 'utf8'
  const maxBytes = options.maxBytes ?? MAX_EDITOR_FILE_BYTES
  const workspaceRoot = await canonicalWorkspaceRoot(workspacePath)
  const targetPath = resolveWorkspaceChild(workspaceRoot, filePath)
  const parentSnapshot = await snapshotDirectoryChain(workspaceRoot, dirname(targetPath))

  await runWorkspaceFileEditorTestHook('before_read_open')
  const fileHandle = await openNoFollow(targetPath, constants.O_RDONLY)
  try {
    const fileStat = await assertOpenedWorkspaceFile(
      fileHandle,
      targetPath,
      parentSnapshot,
      'opened'
    )
    assertEditorFileStat(fileStat, maxBytes)

    // Content is read from the pinned descriptor, never by reopening the lexical path.
    const buffer = await fileHandle.readFile()
    if (encoding === 'utf8') assertTextBuffer(buffer)

    return {
      path: toWorkspaceRelativePath(workspaceRoot, targetPath),
      content: buffer.toString(encoding),
      sizeBytes: Number(fileStat.size),
      mtimeMs: Number(fileStat.mtimeMs),
      etag: workspaceFileEtag(buffer)
    }
  } finally {
    await fileHandle.close()
  }
}

export async function writeWorkspaceFile(
  options: WorkspaceFileWriteOptions
): Promise<WorkspaceFileReadResult> {
  const contentEncoding = options.contentEncoding ?? 'utf8'
  const maxBytes = options.maxBytes ?? MAX_EDITOR_FILE_BYTES
  const recordedWorkspacePath = resolve(options.workspacePath)
  const workspaceRoot = await canonicalWorkspaceRoot(options.workspacePath)
  const requireBaseEtag = options.requireBaseEtag ?? true
  const targetPath = resolveWorkspaceChild(workspaceRoot, options.filePath)
  await runWorkspaceFileEditorTestHook('before_write_parent_snapshot')
  let parentSnapshot: DirectoryIdentitySnapshot | undefined
  try {
    parentSnapshot = await snapshotDirectoryChain(workspaceRoot, dirname(targetPath))
  } catch (err) {
    if (isNodeErrnoException(err) && err.code === 'ENOENT') parentSnapshot = undefined
    else throw err
  }

  const nextBuffer = Buffer.from(options.content, contentEncoding)
  if (contentEncoding === 'utf8') {
    assertIncomingTextContent(options.content, nextBuffer, maxBytes)
  } else if (nextBuffer.length > maxBytes) {
    throw new WorkspaceFileEditorError('file_too_large', 'File is too large for the basic editor.')
  }

  if (!parentSnapshot) {
    return createWorkspaceFile({
      options,
      recordedWorkspacePath,
      workspaceRoot,
      targetPath,
      nextBuffer,
      requireBaseEtag
    })
  }

  let fileHandle: FileHandle
  try {
    fileHandle = await openNoFollow(targetPath, constants.O_RDWR)
  } catch (err) {
    if (err instanceof WorkspaceFileEditorError) throw err
    if (isNodeErrnoException(err) && err.code === 'ENOENT') {
      return createWorkspaceFile({
        options,
        recordedWorkspacePath,
        workspaceRoot,
        targetPath,
        nextBuffer,
        requireBaseEtag,
        parentSnapshot
      })
    }
    throw err
  }

  try {
    const openedStat = await assertOpenedWorkspaceFile(
      fileHandle,
      targetPath,
      parentSnapshot,
      'edited'
    )
    assertEditorFileStat(openedStat, maxBytes)
    if (requireBaseEtag && !options.baseEtag) {
      throw new WorkspaceFileEditorError('missing_base_etag', 'Missing base file version for save.')
    }

    const previousBuffer = await fileHandle.readFile()
    if (contentEncoding === 'utf8') assertTextBuffer(previousBuffer)
    const currentEtag = workspaceFileEtag(previousBuffer)
    if (requireBaseEtag && currentEtag !== options.baseEtag) {
      throw new WorkspaceFileEditorError(
        'stale_etag',
        'File changed on disk. Reload before saving.'
      )
    }

    await runWorkspaceFileEditorTestHook('before_write_commit')
    await assertDirectoryChainStable(parentSnapshot)
    await assertPathMatchesOpenedFile(targetPath, openedStat, 'edited')

    // Write through the already-verified descriptor. No lexical target path is reopened.
    let writeStarted = false
    let savedStat: BigIntStats
    try {
      await fileHandle.truncate(0)
      writeStarted = true
      await runWorkspaceFileEditorTestHook('after_write_truncate')
      await writeBufferAtStart(fileHandle, nextBuffer)
      await fileHandle.sync()

      savedStat = await fileHandle.stat({ bigint: true })
      assertSameFileIdentity(openedStat, savedStat)
      await assertDirectoryChainStable(parentSnapshot)
      await assertPathMatchesOpenedFile(targetPath, savedStat, 'saved')
    } catch (error) {
      if (writeStarted) {
        // Best effort only: the verified descriptor is still the safest rollback
        // target, but an I/O failure can also make restoration fail. Preserve the
        // original error and never reopen the lexical path during recovery.
        await restoreOpenedFileBestEffort(fileHandle, previousBuffer)
      }
      throw error
    }

    const relativePath = toWorkspaceRelativePath(workspaceRoot, targetPath)
    const nextEtag = workspaceFileEtag(nextBuffer)
    const changeSet = options.recordChange?.({
      workspaceId: options.workspaceId,
      workspacePath: recordedWorkspacePath,
      filePath: relativePath,
      existedBefore: true,
      previousContent: previousBuffer.toString('utf8'),
      nextContent: options.content,
      sizeBytes: Number(savedStat.size),
      metadata: {
        origin: options.origin ?? 'file-editor'
      }
    })

    return {
      path: relativePath,
      content: options.content,
      sizeBytes: Number(savedStat.size),
      mtimeMs: Number(savedStat.mtimeMs),
      etag: nextEtag,
      changeSet
    }
  } finally {
    await fileHandle.close()
  }
}

async function createWorkspaceFile(input: {
  options: WorkspaceFileWriteOptions
  recordedWorkspacePath: string
  workspaceRoot: string
  targetPath: string
  nextBuffer: Buffer
  requireBaseEtag: boolean
  parentSnapshot?: DirectoryIdentitySnapshot
}): Promise<WorkspaceFileReadResult> {
  const {
    options,
    recordedWorkspacePath,
    workspaceRoot,
    targetPath,
    nextBuffer,
    requireBaseEtag
  } = input
  if (requireBaseEtag && options.baseEtag !== null) {
    throw new WorkspaceFileEditorError(
      'stale_etag',
      'File no longer exists on disk. Reload before saving.'
    )
  }

  const parentPath = dirname(targetPath)
  const parentSnapshot = input.parentSnapshot
    ? input.parentSnapshot
    : await createMissingParentDirectories(workspaceRoot, parentPath)

  await runWorkspaceFileEditorTestHook('before_new_file_commit')
  await assertDirectoryChainStable(parentSnapshot)
  await assertTargetPathMissing(targetPath)

  const tempPath = join(
    parentPath,
    `.${basename(targetPath)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  )
  const tempHandle = await openNoFollow(
    tempPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_RDWR,
    0o666
  )
  let tempStat: BigIntStats | undefined
  let committed = false
  let handleClosed = false
  try {
    const openedTempStat = await tempHandle.stat({ bigint: true })
    tempStat = openedTempStat
    assertEditorFileStat(openedTempStat)
    await assertDirectoryChainStable(parentSnapshot)
    await assertPathMatchesOpenedFile(tempPath, openedTempStat, 'created')
    await writeBufferAtStart(tempHandle, nextBuffer)
    await tempHandle.sync()
    tempStat = await tempHandle.stat({ bigint: true })
    assertSameFileIdentity(openedTempStat, tempStat)
    await tempHandle.close()
    handleClosed = true

    await assertDirectoryChainStable(parentSnapshot)
    await assertPathMatchesOpenedFile(tempPath, tempStat, 'committed')
    await assertTargetPathMissing(targetPath)

    // Preserve the editor's established atomic temp-file replacement behavior.
    // Node has no portable renameat(2) rooted at a verified directory descriptor,
    // so a final path-based parent/target race remains until structural writes
    // move to a native descriptor-relative primitive.
    await fs.rename(tempPath, targetPath)
    committed = true
    await assertDirectoryChainStable(parentSnapshot)
    await assertPathMatchesOpenedFile(targetPath, tempStat, 'created')
  } catch (error) {
    if (!handleClosed) {
      await tempHandle.close().catch(() => {})
      handleClosed = true
    }
    if (!committed && tempStat) {
      await removeOpenedPathBestEffort(tempPath, tempStat, parentSnapshot)
    }
    throw error
  } finally {
    if (!handleClosed) await tempHandle.close()
  }

  if (!tempStat) {
    throw new Error('Created file identity was unavailable after save.')
  }
  const savedStat = await fs.lstat(targetPath, { bigint: true })
  assertSameFileIdentity(tempStat, savedStat)
  const relativePath = toWorkspaceRelativePath(workspaceRoot, targetPath)
  const changeSet = options.recordChange?.({
    workspaceId: options.workspaceId,
    workspacePath: recordedWorkspacePath,
    filePath: relativePath,
    existedBefore: false,
    previousContent: undefined,
    nextContent: options.content,
    sizeBytes: Number(savedStat.size),
    metadata: {
      origin: options.origin ?? 'file-editor'
    }
  })

  return {
    path: relativePath,
    content: options.content,
    sizeBytes: Number(savedStat.size),
    mtimeMs: Number(savedStat.mtimeMs),
    etag: workspaceFileEtag(nextBuffer),
    changeSet
  }
}

export async function deleteWorkspaceFile(
  options: WorkspaceFileDeleteOptions
): Promise<WorkspaceFileDeleteResult> {
  const recordedWorkspacePath = resolve(options.workspacePath)
  const workspaceRoot = await canonicalWorkspaceRoot(options.workspacePath)
  const requireBaseEtag = options.requireBaseEtag ?? true
  const targetPath = resolveWorkspaceChild(workspaceRoot, options.filePath)
  const parentSnapshot = await snapshotDirectoryChain(workspaceRoot, dirname(targetPath))
  const fileHandle = await openNoFollow(targetPath, constants.O_RDONLY)

  try {
    const openedStat = await assertOpenedWorkspaceFile(
      fileHandle,
      targetPath,
      parentSnapshot,
      'deleted'
    )
    assertEditorFileStat(openedStat)
    const previousBuffer = await fileHandle.readFile()
    assertTextBuffer(previousBuffer)
    const currentEtag = workspaceFileEtag(previousBuffer)
    if (requireBaseEtag && !options.baseEtag) {
      throw new WorkspaceFileEditorError(
        'missing_base_etag',
        'Missing base file version for delete.'
      )
    }
    if (requireBaseEtag && currentEtag !== options.baseEtag) {
      throw new WorkspaceFileEditorError(
        'stale_etag',
        'File changed on disk. Reload before deleting.'
      )
    }

    await runWorkspaceFileEditorTestHook('before_delete_commit')
    await assertDirectoryChainStable(parentSnapshot)
    await assertPathMatchesOpenedFile(targetPath, openedStat, 'deleted')

    // Node has no portable unlinkat(2). The identity + ancestor checks close
    // deterministic replacement windows, but a final path race between this
    // check and unlink remains until structural operations move to a native
    // descriptor-relative primitive.
    await fs.unlink(targetPath)

    const relativePath = toWorkspaceRelativePath(workspaceRoot, targetPath)
    const changeSet = options.recordChange?.({
      workspaceId: options.workspaceId,
      workspacePath: recordedWorkspacePath,
      filePath: relativePath,
      existedBefore: true,
      deleted: true,
      previousContent: previousBuffer.toString('utf8'),
      nextContent: '',
      sizeBytes: 0,
      metadata: {
        origin: options.origin ?? 'file-editor'
      }
    })

    return { path: relativePath, changeSet }
  } finally {
    await fileHandle.close()
  }
}

export function workspaceFileEtag(buffer: Buffer): string {
  return `sha256:${createHash('sha256').update(buffer).digest('hex')}`
}

function assertIncomingTextContent(
  content: string,
  buffer: Buffer,
  maxBytes: number = MAX_EDITOR_FILE_BYTES
): void {
  if (buffer.length > maxBytes) {
    throw new WorkspaceFileEditorError('file_too_large', 'File is too large for the basic editor.')
  }
  if (content.includes('\u0000')) {
    throw new WorkspaceFileEditorError('binary_file', 'Binary files cannot be edited.')
  }
}

async function createMissingParentDirectories(
  workspaceRoot: string,
  parentPath: string
): Promise<DirectoryIdentitySnapshot> {
  const existingParent = await nearestExistingDirectory(workspaceRoot, parentPath)
  const existingSnapshot = await snapshotDirectoryChain(workspaceRoot, existingParent)
  await assertDirectoryChainStable(existingSnapshot)

  // This retains the existing create-in-new-folders behavior. Recursive mkdir
  // is necessarily path-based in portable Node, so an attacker able to replace
  // a missing component during this call can still race it. The snapshots before
  // and after reject every replacement that is observable at our checkpoints.
  await fs.mkdir(parentPath, { recursive: true })
  await assertDirectoryChainStable(existingSnapshot)
  return snapshotDirectoryChain(workspaceRoot, parentPath)
}

async function nearestExistingDirectory(
  workspaceRoot: string,
  targetPath: string
): Promise<string> {
  let cursor = targetPath
  while (isPathInsideWorkspace(workspaceRoot, cursor)) {
    try {
      const stat = await fs.lstat(cursor, { bigint: true })
      if (stat.isSymbolicLink()) {
        throw new WorkspaceFileEditorError(
          'symlink_unsupported',
          'Symbolic links cannot be used in file editor paths.'
        )
      }
      if (!stat.isDirectory()) {
        throw new WorkspaceFileEditorError(
          'path_outside_workspace',
          'File editor parent path is not a directory.'
        )
      }
      return cursor
    } catch (error) {
      if (!isNodeErrnoException(error) || error.code !== 'ENOENT') throw error
    }
    if (cursor === workspaceRoot) break
    const next = dirname(cursor)
    if (next === cursor) break
    cursor = next
  }
  throw new WorkspaceFileEditorError(
    'path_outside_workspace',
    'Path is outside the workspace.'
  )
}

async function assertTargetPathMissing(targetPath: string): Promise<void> {
  try {
    await fs.lstat(targetPath)
  } catch (error) {
    if (isNodeErrnoException(error) && error.code === 'ENOENT') return
    throw error
  }
  throw new WorkspaceFileEditorError(
    'stale_etag',
    'File appeared on disk. Reload before saving.'
  )
}

function assertTextBuffer(buffer: Buffer): void {
  if (buffer.includes(0)) {
    throw new WorkspaceFileEditorError('binary_file', 'Binary files cannot be edited.')
  }
  const text = buffer.toString('utf8')
  if (!Buffer.from(text, 'utf8').equals(buffer)) {
    throw new WorkspaceFileEditorError('binary_file', 'Only UTF-8 text files can be edited.')
  }
}

interface DirectoryIdentitySnapshotEntry {
  path: string
  dev: bigint
  ino: bigint
}

type DirectoryIdentitySnapshot = DirectoryIdentitySnapshotEntry[]

async function canonicalWorkspaceRoot(workspacePath: string): Promise<string> {
  const workspaceRoot = await fs.realpath(resolve(workspacePath))
  const rootStat = await fs.lstat(workspaceRoot, { bigint: true })
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new WorkspaceFileEditorError(
      'path_outside_workspace',
      'Workspace root is not a stable directory.'
    )
  }
  return workspaceRoot
}

async function snapshotDirectoryChain(
  workspaceRoot: string,
  parentPath: string
): Promise<DirectoryIdentitySnapshot> {
  if (!isPathInsideWorkspace(workspaceRoot, parentPath)) {
    throw new WorkspaceFileEditorError('path_outside_workspace', 'Path is outside the workspace.')
  }

  const paths: string[] = []
  let cursor = parentPath
  while (true) {
    paths.push(cursor)
    if (cursor === workspaceRoot) break
    const next = dirname(cursor)
    if (next === cursor || !isPathInsideWorkspace(workspaceRoot, next)) {
      throw new WorkspaceFileEditorError('path_outside_workspace', 'Path is outside the workspace.')
    }
    cursor = next
  }
  paths.reverse()

  const snapshot: DirectoryIdentitySnapshot = []
  for (const path of paths) {
    const stat = await fs.lstat(path, { bigint: true })
    if (stat.isSymbolicLink()) {
      throw new WorkspaceFileEditorError(
        'symlink_unsupported',
        'Symbolic links cannot be used in file editor paths.'
      )
    }
    if (!stat.isDirectory()) {
      throw new WorkspaceFileEditorError(
        'path_outside_workspace',
        'File editor parent path is not a directory.'
      )
    }
    snapshot.push({ path, dev: stat.dev, ino: stat.ino })
  }
  return snapshot
}

async function assertDirectoryChainStable(snapshot: DirectoryIdentitySnapshot): Promise<void> {
  for (const expected of snapshot) {
    let stat: BigIntStats
    try {
      stat = await fs.lstat(expected.path, { bigint: true })
    } catch (err) {
      if (isNodeErrnoException(err) && err.code === 'ENOENT') {
        throw unstableWorkspacePathError()
      }
      throw err
    }
    if (
      stat.isSymbolicLink() ||
      !stat.isDirectory() ||
      stat.dev !== expected.dev ||
      stat.ino !== expected.ino
    ) {
      throw unstableWorkspacePathError()
    }
  }
}

async function openNoFollow(path: string, flags: number, mode?: number): Promise<FileHandle> {
  try {
    return await fs.open(path, flags | constants.O_NOFOLLOW, mode)
  } catch (err) {
    if (isNodeErrnoException(err) && (err.code === 'ELOOP' || err.code === 'EMLINK')) {
      throw new WorkspaceFileEditorError(
        'symlink_unsupported',
        'Symbolic links cannot be used in file editor paths.'
      )
    }
    throw err
  }
}

async function assertOpenedWorkspaceFile(
  fileHandle: FileHandle,
  targetPath: string,
  parentSnapshot: DirectoryIdentitySnapshot,
  operation: string
): Promise<BigIntStats> {
  const fileStat = await fileHandle.stat({ bigint: true })
  await assertDirectoryChainStable(parentSnapshot)
  await assertPathMatchesOpenedFile(targetPath, fileStat, operation)
  return fileStat
}

function assertEditorFileStat(
  fileStat: BigIntStats,
  maxBytes: number = MAX_EDITOR_FILE_BYTES
): void {
  if (!fileStat.isFile()) {
    throw new WorkspaceFileEditorError('directory_selected', 'Selected item is not a file.')
  }
  if (fileStat.size > BigInt(maxBytes)) {
    throw new WorkspaceFileEditorError('file_too_large', 'File is too large for the basic editor.')
  }
}

async function assertPathMatchesOpenedFile(
  targetPath: string,
  openedStat: BigIntStats,
  operation: string
): Promise<void> {
  let pathStat: BigIntStats
  try {
    pathStat = await fs.lstat(targetPath, { bigint: true })
  } catch (err) {
    if (isNodeErrnoException(err) && err.code === 'ENOENT') {
      throw unstableWorkspacePathError()
    }
    throw err
  }
  if (
    pathStat.isSymbolicLink() ||
    pathStat.dev !== openedStat.dev ||
    pathStat.ino !== openedStat.ino
  ) {
    throw new WorkspaceFileEditorError(
      'path_outside_workspace',
      `File path changed before it could be ${operation}.`
    )
  }
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
    if (bytesWritten <= 0) {
      throw new Error('Could not complete the file editor write.')
    }
    offset += bytesWritten
  }
}

async function restoreOpenedFileBestEffort(
  fileHandle: FileHandle,
  previousBuffer: Buffer
): Promise<void> {
  try {
    await fileHandle.truncate(0)
    await writeBufferAtStart(fileHandle, previousBuffer)
    await fileHandle.sync()
  } catch {
    // Preserve the original save failure. The caller must surface that the
    // write did not complete; a secondary recovery error cannot be made safe by
    // reopening the path that the descriptor hardening deliberately avoids.
  }
}

async function removeOpenedPathBestEffort(
  targetPath: string,
  openedStat: BigIntStats,
  parentSnapshot: DirectoryIdentitySnapshot
): Promise<void> {
  try {
    await assertDirectoryChainStable(parentSnapshot)
    await assertPathMatchesOpenedFile(targetPath, openedStat, 'cleaned up')
    await fs.unlink(targetPath)
  } catch {
    // A replaced parent makes lexical cleanup unsafe. Leaving the private temp
    // beside the original directory is preferable to unlinking an attacker path.
  }
}

function assertSameFileIdentity(expected: BigIntStats, actual: BigIntStats): void {
  if (expected.dev !== actual.dev || expected.ino !== actual.ino || !actual.isFile()) {
    throw new WorkspaceFileEditorError(
      'path_outside_workspace',
      'Opened file identity changed while the editor save was in progress.'
    )
  }
}

function unstableWorkspacePathError(): WorkspaceFileEditorError {
  return new WorkspaceFileEditorError(
    'path_outside_workspace',
    'Workspace path changed while the file editor operation was in progress.'
  )
}

async function runWorkspaceFileEditorTestHook(
  stage: WorkspaceFileEditorTestHookStage
): Promise<void> {
  await workspaceFileEditorTestHook?.(stage)
}

function isNodeErrnoException(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value
}
