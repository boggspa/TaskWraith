import { promises as fs } from 'fs'
import type { Dirent } from 'fs'
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
  /** Returned entry cap. Legacy flat lists keep MAX_EDITOR_FILES. */
  limit?: number
}

export type RecordWorkspaceEditorChangeFn = (
  input: WorkspaceEditorChangeInput
) => WorkspaceChangeSet

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
}

export type WorkspaceFileEditorErrorCode =
  | 'path_outside_workspace'
  | 'directory_selected'
  | 'file_too_large'
  | 'binary_file'
  | 'missing_base_etag'
  | 'stale_etag'
  | 'symlink_unsupported'

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
    return searchWorkspaceFiles(workspacePath, query, options.limit)
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
  limit = SEARCH_LIST_LIMIT_DEFAULT
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

      if (matches) {
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
  if (!Number.isFinite(limit) || !Number.isInteger(limit)) return DIRECTORY_LIST_LIMIT_DEFAULT
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
  filePath: string
): Promise<WorkspaceFileReadResult> {
  const workspaceRoot = resolve(workspacePath)
  const targetPath = await resolveReadableFile(workspaceRoot, filePath)
  const fileStat = await fs.stat(targetPath)
  if (!fileStat.isFile()) {
    throw new WorkspaceFileEditorError('directory_selected', 'Selected item is not a file.')
  }
  if (fileStat.size > MAX_EDITOR_FILE_BYTES) {
    throw new WorkspaceFileEditorError('file_too_large', 'File is too large for the basic editor.')
  }

  const buffer = await fs.readFile(targetPath)
  assertTextBuffer(buffer)

  return {
    path: toWorkspaceRelativePath(workspaceRoot, targetPath),
    content: buffer.toString('utf8'),
    sizeBytes: fileStat.size,
    mtimeMs: fileStat.mtimeMs,
    etag: workspaceFileEtag(buffer)
  }
}

export async function writeWorkspaceFile(
  options: WorkspaceFileWriteOptions
): Promise<WorkspaceFileReadResult> {
  const workspaceRoot = resolve(options.workspacePath)
  const requireBaseEtag = options.requireBaseEtag ?? true
  const targetPath = resolveWorkspaceChild(workspaceRoot, options.filePath)
  await assertParentInsideWorkspace(workspaceRoot, dirname(targetPath))

  const nextBuffer = Buffer.from(options.content, 'utf8')
  assertIncomingTextContent(options.content, nextBuffer)

  let previousContent: string | undefined
  let existedBefore = false

  try {
    const lstat = await fs.lstat(targetPath)
    if (lstat.isSymbolicLink()) {
      throw new WorkspaceFileEditorError(
        'symlink_unsupported',
        'Symbolic links cannot be edited from the file editor.'
      )
    }
    if (lstat.isDirectory()) {
      throw new WorkspaceFileEditorError('directory_selected', 'Selected item is not a file.')
    }
    existedBefore = lstat.isFile()
    if (existedBefore) {
      if (requireBaseEtag && !options.baseEtag) {
        throw new WorkspaceFileEditorError(
          'missing_base_etag',
          'Missing base file version for save.'
        )
      }
      if (lstat.size > MAX_EDITOR_FILE_BYTES) {
        throw new WorkspaceFileEditorError(
          'file_too_large',
          'File is too large for the basic editor.'
        )
      }
      const previousBuffer = await fs.readFile(targetPath)
      assertTextBuffer(previousBuffer)
      const currentEtag = workspaceFileEtag(previousBuffer)
      if (requireBaseEtag && currentEtag !== options.baseEtag) {
        throw new WorkspaceFileEditorError(
          'stale_etag',
          'File changed on disk. Reload before saving.'
        )
      }
      previousContent = previousBuffer.toString('utf8')
    }
  } catch (err) {
    if (err instanceof WorkspaceFileEditorError) throw err
    if (!isNodeErrnoException(err) || err.code !== 'ENOENT') {
      throw err
    }
    if (requireBaseEtag && options.baseEtag !== null) {
      throw new WorkspaceFileEditorError(
        'stale_etag',
        'File no longer exists on disk. Reload before saving.'
      )
    }
  }

  await fs.mkdir(dirname(targetPath), { recursive: true })
  const tempPath = join(
    dirname(targetPath),
    `.${basename(targetPath)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  )
  try {
    await fs.writeFile(tempPath, nextBuffer)
    await fs.rename(tempPath, targetPath)
  } catch (err) {
    await fs.unlink(tempPath).catch(() => {})
    throw err
  }

  const fileStat = await fs.stat(targetPath)
  const relativePath = toWorkspaceRelativePath(workspaceRoot, targetPath)
  const nextEtag = workspaceFileEtag(nextBuffer)
  const changeSet = options.recordChange?.({
    workspaceId: options.workspaceId,
    workspacePath: workspaceRoot,
    filePath: relativePath,
    existedBefore,
    previousContent,
    nextContent: options.content,
    sizeBytes: fileStat.size,
    metadata: {
      origin: options.origin ?? 'file-editor'
    }
  })

  return {
    path: relativePath,
    content: options.content,
    sizeBytes: fileStat.size,
    mtimeMs: fileStat.mtimeMs,
    etag: nextEtag,
    changeSet
  }
}

export function workspaceFileEtag(buffer: Buffer): string {
  return `sha256:${createHash('sha256').update(buffer).digest('hex')}`
}

function assertIncomingTextContent(content: string, buffer: Buffer): void {
  if (buffer.length > MAX_EDITOR_FILE_BYTES) {
    throw new WorkspaceFileEditorError('file_too_large', 'File is too large for the basic editor.')
  }
  if (content.includes('\u0000')) {
    throw new WorkspaceFileEditorError('binary_file', 'Binary files cannot be edited.')
  }
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

async function resolveReadableFile(workspaceRoot: string, filePath: string): Promise<string> {
  const targetPath = resolveWorkspaceChild(workspaceRoot, filePath)
  const lstat = await fs.lstat(targetPath)
  if (lstat.isSymbolicLink()) {
    throw new WorkspaceFileEditorError(
      'symlink_unsupported',
      'Symbolic links cannot be opened from the file editor.'
    )
  }
  const realWorkspace = await fs.realpath(workspaceRoot)
  const realTarget = await fs.realpath(targetPath)
  if (!isPathInsideWorkspace(realWorkspace, realTarget)) {
    throw new WorkspaceFileEditorError('path_outside_workspace', 'Path is outside the workspace.')
  }
  return targetPath
}

async function assertParentInsideWorkspace(workspaceRoot: string, parentPath: string): Promise<void> {
  const realWorkspace = await fs.realpath(workspaceRoot)
  let realParent: string
  try {
    realParent = await fs.realpath(parentPath)
  } catch (err) {
    if (isNodeErrnoException(err) && err.code === 'ENOENT') {
      realParent = await nearestExistingParent(parentPath, realWorkspace)
    } else {
      throw err
    }
  }
  if (!isPathInsideWorkspace(realWorkspace, realParent)) {
    throw new WorkspaceFileEditorError('path_outside_workspace', 'Path is outside the workspace.')
  }
}

async function nearestExistingParent(parentPath: string, workspaceRoot: string): Promise<string> {
  let cursor = parentPath
  while (cursor.startsWith(workspaceRoot)) {
    try {
      return await fs.realpath(cursor)
    } catch (err) {
      if (!isNodeErrnoException(err) || err.code !== 'ENOENT') throw err
      const next = dirname(cursor)
      if (next === cursor) break
      cursor = next
    }
  }
  return fs.realpath(workspaceRoot)
}

function isNodeErrnoException(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value
}
