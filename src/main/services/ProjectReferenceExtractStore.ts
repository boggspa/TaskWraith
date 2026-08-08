import { createHash, randomUUID } from 'crypto'
import fs from 'fs'
import path from 'path'

import {
  parseProjectReferenceExtract,
  type ProjectReferenceExtract,
  type ProjectReferenceExtractConsent,
  type ProjectReferenceExtractError,
  type ProjectReferenceExtractKind,
  type ProjectReferenceExtractPageSpan,
  type ProjectReferenceExtractSource
} from '../../shared/projectReferenceExtract'
import { isSafeChatId } from '../ChatPath'

/**
 * Main-owned, project-scoped durable store for consentful reference extracts.
 * Never performs network I/O. Text bytes are content-addressed; metadata is a
 * per-extract JSON ledger with one active pointer per (projectId, referenceId).
 */
export const PROJECT_REFERENCE_EXTRACTS_DIR_NAME = 'project-reference-extracts'
export const PROJECT_REFERENCE_EXTRACT_ACTIVE_INDEX_FILE = 'active-v1.json'
export const PROJECT_REFERENCE_EXTRACT_MAX_TEXT_CHARS = 200_000
export const PROJECT_REFERENCE_EXTRACT_MAX_TEXT_BYTES = 2 * 1024 * 1024

const ACTIVE_INDEX_VERSION = 1
const ACTIVE_INDEX_MAX_BYTES = 8 * 1024 * 1024

export type ProjectReferenceExtractStoreFailureReason =
  | 'unsafe_extract_directory'
  | 'invalid_input'
  | 'not_found'
  | 'invalid_state'
  | 'persistence_failed'
  | 'text_too_large'
  | 'corrupt_meta'

export type ProjectReferenceExtractStoreResult<T> =
  | { ok: true; extract: T }
  | { ok: false; reason: ProjectReferenceExtractStoreFailureReason }

export type ProjectReferenceExtractPurgeResult =
  | { ok: true; deletedExtracts: number; deletedBlobs: number }
  | { ok: false; reason: ProjectReferenceExtractStoreFailureReason }

export interface PutPendingProjectReferenceExtractInput {
  projectId: string
  referenceId: string
  kind: ProjectReferenceExtractKind
  consent: ProjectReferenceExtractConsent
  source: ProjectReferenceExtractSource
  now?: number
  id?: string
}

export interface MarkReadyProjectReferenceExtractOptions {
  truncated?: boolean
  pages?: readonly ProjectReferenceExtractPageSpan[]
  now?: number
}

interface ActiveIndexEntry {
  projectId: string
  referenceId: string
  extractId: string
}

interface ActiveIndexSnapshot {
  version: 1
  entries: ActiveIndexEntry[]
}

function sameFileIdentity(left: fs.Stats, right: fs.Stats): boolean {
  if (left.ino !== right.ino) return false
  return process.platform === 'win32' || left.dev === right.dev
}

function isMainOwned(stat: fs.Stats): boolean {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null
  return (
    (uid === null || stat.uid === uid) &&
    (process.platform === 'win32' || (stat.mode & 0o022) === 0)
  )
}

function prepareMainOwnedExtractDirectory(directory: string): string | null {
  if (!path.isAbsolute(directory) || directory.includes('\0')) return null
  const requested = path.resolve(directory)
  try {
    fs.mkdirSync(requested, { recursive: true, mode: 0o700 })
    const requestedLstat = fs.lstatSync(requested)
    if (requestedLstat.isSymbolicLink() || !requestedLstat.isDirectory()) return null

    const canonical = fs.realpathSync.native(requested)
    const canonicalLstat = fs.lstatSync(canonical)
    const canonicalStat = fs.statSync(canonical)
    if (
      canonicalLstat.isSymbolicLink() ||
      !canonicalLstat.isDirectory() ||
      !canonicalStat.isDirectory() ||
      !sameFileIdentity(canonicalLstat, canonicalStat) ||
      !isMainOwned(canonicalStat)
    ) {
      return null
    }
    return canonical
  } catch {
    return null
  }
}

function ensureSubdir(root: string, name: 'blobs' | 'meta'): string | null {
  const dir = path.join(root, name)
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    const lstat = fs.lstatSync(dir)
    if (lstat.isSymbolicLink() || !lstat.isDirectory() || !isMainOwned(lstat)) return null
    return dir
  } catch {
    return null
  }
}

function fsyncDirectoryStrict(directory: string): void {
  let fd: number | null = null
  try {
    fd = fs.openSync(directory, fs.constants.O_RDONLY)
    fs.fsyncSync(fd)
  } catch (error) {
    if (process.platform !== 'win32') throw error
    const code = (error as NodeJS.ErrnoException)?.code
    if (code !== 'EACCES' && code !== 'EPERM' && code !== 'EINVAL') throw error
  } finally {
    if (fd !== null) fs.closeSync(fd)
  }
}

function writeAll(fd: number, buffer: Buffer): void {
  let offset = 0
  while (offset < buffer.length) {
    const written = fs.writeSync(fd, buffer, offset, buffer.length - offset, offset)
    if (written <= 0) throw new Error('short_write')
    offset += written
  }
}

function unlinkIfSameFile(filePath: string, expected: fs.Stats | null): void {
  if (!expected) return
  try {
    const current = fs.lstatSync(filePath)
    if (!current.isSymbolicLink() && current.isFile() && sameFileIdentity(current, expected)) {
      fs.unlinkSync(filePath)
    }
  } catch {
    // Never follow or remove an attacker-swapped cleanup target.
  }
}

function safeFlatId(value: unknown): value is string {
  return (
    isSafeChatId(value) && Buffer.byteLength(value, 'utf8') <= 512 && path.basename(value) === value
  )
}

function isSha256Hex(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value)
}

function blobPath(root: string, sha256: string): string {
  return path.join(root, 'blobs', `${sha256}.txt`)
}

function metaPath(root: string, extractId: string): string {
  return path.join(root, 'meta', `${extractId}.json`)
}

function activeIndexPath(root: string): string {
  return path.join(root, PROJECT_REFERENCE_EXTRACT_ACTIVE_INDEX_FILE)
}

function activeKey(projectId: string, referenceId: string): string {
  return `${projectId}\0${referenceId}`
}

function readExactFile(filePath: string, maxBytes: number): Buffer | null {
  let fd: number | null = null
  try {
    const before = fs.lstatSync(filePath)
    if (
      before.isSymbolicLink() ||
      !before.isFile() ||
      before.size <= 0 ||
      before.size > maxBytes ||
      !isMainOwned(before)
    ) {
      return null
    }
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    const opened = fs.fstatSync(fd)
    if (
      !opened.isFile() ||
      opened.size !== before.size ||
      !sameFileIdentity(opened, before) ||
      !isMainOwned(opened)
    ) {
      return null
    }
    const buffer = Buffer.allocUnsafe(opened.size)
    let offset = 0
    while (offset < buffer.length) {
      const read = fs.readSync(fd, buffer, offset, buffer.length - offset, offset)
      if (read <= 0) return null
      offset += read
    }
    const after = fs.lstatSync(filePath)
    if (
      after.isSymbolicLink() ||
      !after.isFile() ||
      after.size !== opened.size ||
      !sameFileIdentity(after, opened)
    ) {
      return null
    }
    return buffer
  } catch {
    return null
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd)
      } catch {
        // Best-effort close.
      }
    }
  }
}

function atomicWriteFile(directory: string, target: string, buffer: Buffer): boolean {
  const tempPath = path.join(directory, `.extract-${process.pid}-${randomUUID()}.tmp`)
  let tempFd: number | null = null
  let tempStat: fs.Stats | null = null
  try {
    tempFd = fs.openSync(
      tempPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600
    )
    fs.fchmodSync(tempFd, 0o600)
    tempStat = fs.fstatSync(tempFd)
    if (!tempStat.isFile()) throw new Error('unsafe_temp')
    writeAll(tempFd, buffer)
    fs.fsyncSync(tempFd)
    const finalTempStat = fs.fstatSync(tempFd)
    const pathStat = fs.lstatSync(tempPath)
    if (
      !finalTempStat.isFile() ||
      pathStat.isSymbolicLink() ||
      !pathStat.isFile() ||
      !sameFileIdentity(finalTempStat, tempStat) ||
      !sameFileIdentity(pathStat, tempStat)
    ) {
      throw new Error('unsafe_temp')
    }
    fs.closeSync(tempFd)
    tempFd = null
    fs.renameSync(tempPath, target)
    fsyncDirectoryStrict(directory)
    return true
  } catch {
    return false
  } finally {
    if (tempFd !== null) {
      try {
        fs.closeSync(tempFd)
      } catch {
        // Best-effort close.
      }
    }
    unlinkIfSameFile(tempPath, tempStat)
  }
}

function persistBlob(root: string, text: string): { sha256: string; path: string } | null {
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.length === 0 || buffer.length > PROJECT_REFERENCE_EXTRACT_MAX_TEXT_BYTES) return null
  const sha256 = createHash('sha256').update(buffer).digest('hex')
  const target = blobPath(root, sha256)
  if (fs.existsSync(target)) {
    const existing = readExactFile(target, PROJECT_REFERENCE_EXTRACT_MAX_TEXT_BYTES)
    if (!existing || createHash('sha256').update(existing).digest('hex') !== sha256) {
      return null
    }
    return { sha256, path: target }
  }
  const blobsDir = ensureSubdir(root, 'blobs')
  if (!blobsDir) return null
  return atomicWriteFile(blobsDir, target, buffer) ? { sha256, path: target } : null
}

function unlinkBlob(root: string, sha256: string): boolean {
  if (!isSha256Hex(sha256)) return false
  const target = blobPath(root, sha256)
  try {
    const before = fs.lstatSync(target)
    if (before.isSymbolicLink() || !before.isFile()) return false
    fs.unlinkSync(target)
    fsyncDirectoryStrict(path.join(root, 'blobs'))
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'ENOENT'
  }
}

/** Deletes a blob only when no remaining meta record still names its digest. */
function deleteBlobIfUnreferenced(root: string, sha256: string): boolean {
  if (!isSha256Hex(sha256)) return false
  const metaDir = path.join(root, 'meta')
  try {
    if (fs.existsSync(metaDir)) {
      for (const entry of fs.readdirSync(metaDir)) {
        if (!entry.endsWith('.json')) continue
        const extractId = entry.slice(0, -'.json'.length)
        const record = readMetaAt(root, extractId)
        if (record?.text?.artifactSha256 === sha256) return false
      }
    }
  } catch {
    return false
  }
  return unlinkBlob(root, sha256)
}

function readMetaAt(root: string, extractId: string): ProjectReferenceExtract | null {
  if (!safeFlatId(extractId)) return null
  const buffer = readExactFile(metaPath(root, extractId), 1024 * 1024)
  if (!buffer) return null
  try {
    return parseProjectReferenceExtract(JSON.parse(buffer.toString('utf8')))
  } catch {
    return null
  }
}

function writeMeta(root: string, extract: ProjectReferenceExtract): boolean {
  const parsed = parseProjectReferenceExtract(extract)
  if (!parsed || !safeFlatId(parsed.id)) return false
  const metaDir = ensureSubdir(root, 'meta')
  if (!metaDir) return false
  const payload = Buffer.from(`${JSON.stringify(parsed)}\n`, 'utf8')
  return atomicWriteFile(metaDir, metaPath(root, parsed.id), payload)
}

function parseActiveIndex(value: unknown): ActiveIndexSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (record.version !== ACTIVE_INDEX_VERSION || !Array.isArray(record.entries)) return null
  const entries: ActiveIndexEntry[] = []
  const seen = new Set<string>()
  for (const entry of record.entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null
    const row = entry as Record<string, unknown>
    if (
      typeof row.projectId !== 'string' ||
      typeof row.referenceId !== 'string' ||
      typeof row.extractId !== 'string' ||
      !safeFlatId(row.projectId) ||
      !safeFlatId(row.referenceId) ||
      !safeFlatId(row.extractId)
    ) {
      return null
    }
    const key = activeKey(row.projectId, row.referenceId)
    if (seen.has(key)) return null
    seen.add(key)
    entries.push({
      projectId: row.projectId,
      referenceId: row.referenceId,
      extractId: row.extractId
    })
  }
  return { version: 1, entries }
}

function readActiveIndex(root: string): ActiveIndexSnapshot | null {
  const target = activeIndexPath(root)
  if (!fs.existsSync(target)) return { version: 1, entries: [] }
  const buffer = readExactFile(target, ACTIVE_INDEX_MAX_BYTES)
  if (!buffer) return null
  try {
    return parseActiveIndex(JSON.parse(buffer.toString('utf8')))
  } catch {
    return null
  }
}

function writeActiveIndex(root: string, snapshot: ActiveIndexSnapshot): boolean {
  const parsed = parseActiveIndex(snapshot)
  if (!parsed) return false
  const payload = Buffer.from(`${JSON.stringify(parsed)}\n`, 'utf8')
  return atomicWriteFile(root, activeIndexPath(root), payload)
}

function setActive(
  root: string,
  projectId: string,
  referenceId: string,
  extractId: string | null
): boolean {
  const index = readActiveIndex(root)
  if (!index) return false
  const next = index.entries.filter(
    (entry) => !(entry.projectId === projectId && entry.referenceId === referenceId)
  )
  if (extractId) {
    next.push({ projectId, referenceId, extractId })
  }
  return writeActiveIndex(root, { version: 1, entries: next })
}

function listMetaExtractIds(root: string): string[] {
  const metaDir = path.join(root, 'meta')
  try {
    if (!fs.existsSync(metaDir)) return []
    return fs
      .readdirSync(metaDir)
      .filter((entry) => entry.endsWith('.json'))
      .map((entry) => entry.slice(0, -'.json'.length))
      .filter((id) => safeFlatId(id))
  } catch {
    return []
  }
}

function deleteMetaFile(root: string, extractId: string): boolean {
  const target = metaPath(root, extractId)
  try {
    const before = fs.lstatSync(target)
    if (before.isSymbolicLink() || !before.isFile()) return false
    fs.unlinkSync(target)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'ENOENT'
  }
}

export class ProjectReferenceExtractStore {
  constructor(private readonly extractDirectory: string) {}

  private root(): string | null {
    return prepareMainOwnedExtractDirectory(this.extractDirectory)
  }

  putPending(
    input: PutPendingProjectReferenceExtractInput
  ): ProjectReferenceExtractStoreResult<ProjectReferenceExtract> {
    const root = this.root()
    if (!root) return { ok: false, reason: 'unsafe_extract_directory' }
    if (!ensureSubdir(root, 'meta') || !ensureSubdir(root, 'blobs')) {
      return { ok: false, reason: 'unsafe_extract_directory' }
    }

    const now =
      typeof input.now === 'number' && Number.isSafeInteger(input.now) && input.now >= 0
        ? input.now
        : Date.now()
    const id = input.id ?? `extract-${randomUUID()}`
    const candidate: ProjectReferenceExtract = {
      schemaVersion: 1,
      id,
      projectId: input.projectId,
      referenceId: input.referenceId,
      kind: input.kind,
      status: 'pending',
      consent: input.consent,
      source: input.source,
      createdAt: now,
      updatedAt: now
    }
    const extract = parseProjectReferenceExtract(candidate)
    if (!extract || !safeFlatId(extract.id)) {
      return { ok: false, reason: 'invalid_input' }
    }

    const index = readActiveIndex(root)
    if (!index) return { ok: false, reason: 'corrupt_meta' }
    const previous = index.entries.find(
      (entry) => entry.projectId === extract.projectId && entry.referenceId === extract.referenceId
    )
    if (previous) {
      const prior = readMetaAt(root, previous.extractId)
      if (prior && prior.status !== 'revoked' && prior.status !== 'stale') {
        // Keep digest metadata for audit, but drop corpus bytes on re-extract.
        const staleRecord: ProjectReferenceExtract = {
          schemaVersion: 1,
          id: prior.id,
          projectId: prior.projectId,
          referenceId: prior.referenceId,
          kind: prior.kind,
          status: 'stale',
          consent: prior.consent,
          source: prior.source,
          ...(prior.text ? { text: prior.text } : {}),
          ...(prior.error ? { error: prior.error } : {}),
          createdAt: prior.createdAt,
          updatedAt: now
        }
        if (!writeMeta(root, staleRecord)) {
          return { ok: false, reason: 'persistence_failed' }
        }
        if (prior.text?.artifactSha256) {
          unlinkBlob(root, prior.text.artifactSha256)
        }
      }
    }

    if (!writeMeta(root, extract)) return { ok: false, reason: 'persistence_failed' }
    if (!setActive(root, extract.projectId, extract.referenceId, extract.id)) {
      return { ok: false, reason: 'persistence_failed' }
    }
    return { ok: true, extract }
  }

  markReady(
    extractId: string,
    text: string,
    options: MarkReadyProjectReferenceExtractOptions = {}
  ): ProjectReferenceExtractStoreResult<ProjectReferenceExtract> {
    const root = this.root()
    if (!root) return { ok: false, reason: 'unsafe_extract_directory' }
    if (typeof text !== 'string') return { ok: false, reason: 'invalid_input' }
    if (text.length > PROJECT_REFERENCE_EXTRACT_MAX_TEXT_CHARS) {
      return { ok: false, reason: 'text_too_large' }
    }

    const current = readMetaAt(root, extractId)
    if (!current) {
      return {
        ok: false,
        reason: fs.existsSync(metaPath(root, extractId)) ? 'corrupt_meta' : 'not_found'
      }
    }
    if (current.status !== 'pending') return { ok: false, reason: 'invalid_state' }

    const persisted = persistBlob(root, text)
    if (!persisted) {
      return {
        ok: false,
        reason:
          Buffer.byteLength(text, 'utf8') > PROJECT_REFERENCE_EXTRACT_MAX_TEXT_BYTES
            ? 'text_too_large'
            : 'persistence_failed'
      }
    }

    const now =
      typeof options.now === 'number' && Number.isSafeInteger(options.now) && options.now >= 0
        ? options.now
        : Date.now()
    const next: ProjectReferenceExtract = {
      schemaVersion: 1,
      id: current.id,
      projectId: current.projectId,
      referenceId: current.referenceId,
      kind: current.kind,
      status: 'ready',
      consent: current.consent,
      source: current.source,
      text: {
        charCount: text.length,
        truncated: options.truncated === true,
        artifactSha256: persisted.sha256,
        ...(options.pages ? { pages: [...options.pages] } : {})
      },
      createdAt: current.createdAt,
      updatedAt: now
    }
    const parsed = parseProjectReferenceExtract(next)
    if (!parsed) return { ok: false, reason: 'invalid_input' }
    if (!writeMeta(root, parsed)) return { ok: false, reason: 'persistence_failed' }
    return { ok: true, extract: parsed }
  }

  markFailed(
    extractId: string,
    error: ProjectReferenceExtractError,
    options: { now?: number } = {}
  ): ProjectReferenceExtractStoreResult<ProjectReferenceExtract> {
    const root = this.root()
    if (!root) return { ok: false, reason: 'unsafe_extract_directory' }
    const current = readMetaAt(root, extractId)
    if (!current) {
      return {
        ok: false,
        reason: fs.existsSync(metaPath(root, extractId)) ? 'corrupt_meta' : 'not_found'
      }
    }
    if (current.status !== 'pending') return { ok: false, reason: 'invalid_state' }
    const now =
      typeof options.now === 'number' && Number.isSafeInteger(options.now) && options.now >= 0
        ? options.now
        : Date.now()
    const next: ProjectReferenceExtract = {
      schemaVersion: 1,
      id: current.id,
      projectId: current.projectId,
      referenceId: current.referenceId,
      kind: current.kind,
      status: 'failed',
      consent: current.consent,
      source: current.source,
      error,
      createdAt: current.createdAt,
      updatedAt: now
    }
    const parsed = parseProjectReferenceExtract(next)
    if (!parsed) return { ok: false, reason: 'invalid_input' }
    if (!writeMeta(root, parsed)) return { ok: false, reason: 'persistence_failed' }
    return { ok: true, extract: parsed }
  }

  revoke(
    extractId: string,
    options: { now?: number } = {}
  ): ProjectReferenceExtractStoreResult<ProjectReferenceExtract> {
    const root = this.root()
    if (!root) return { ok: false, reason: 'unsafe_extract_directory' }
    const current = readMetaAt(root, extractId)
    if (!current) {
      return {
        ok: false,
        reason: fs.existsSync(metaPath(root, extractId)) ? 'corrupt_meta' : 'not_found'
      }
    }
    if (current.status === 'revoked') return { ok: true, extract: current }

    const now =
      typeof options.now === 'number' && Number.isSafeInteger(options.now) && options.now >= 0
        ? options.now
        : Date.now()
    const sha = current.text?.artifactSha256
    const next: ProjectReferenceExtract = {
      schemaVersion: 1,
      id: current.id,
      projectId: current.projectId,
      referenceId: current.referenceId,
      kind: current.kind,
      status: 'revoked',
      consent: current.consent,
      source: current.source,
      ...(current.text ? { text: current.text } : {}),
      ...(current.error ? { error: current.error } : {}),
      createdAt: current.createdAt,
      updatedAt: now,
      revokedAt: now
    }
    const parsed = parseProjectReferenceExtract(next)
    if (!parsed) return { ok: false, reason: 'invalid_input' }
    if (!writeMeta(root, parsed)) return { ok: false, reason: 'persistence_failed' }
    // Revoke deletes bytes even while meta retains the digest for audit/chips.
    if (sha) unlinkBlob(root, sha)
    const index = readActiveIndex(root)
    if (index) {
      const active = index.entries.find((entry) => entry.extractId === extractId)
      if (active) {
        setActive(root, active.projectId, active.referenceId, null)
      }
    }
    return { ok: true, extract: parsed }
  }

  getActive(projectId: string, referenceId: string): ProjectReferenceExtract | null {
    const root = this.root()
    if (!root || !safeFlatId(projectId) || !safeFlatId(referenceId)) return null
    const index = readActiveIndex(root)
    if (!index) return null
    const entry = index.entries.find(
      (row) => row.projectId === projectId && row.referenceId === referenceId
    )
    if (!entry) return null
    const extract = readMetaAt(root, entry.extractId)
    if (!extract) return null
    if (extract.status === 'revoked' || extract.status === 'stale') return null
    if (extract.projectId !== projectId || extract.referenceId !== referenceId) return null
    return extract
  }

  getById(extractId: string): ProjectReferenceExtract | null {
    const root = this.root()
    if (!root) return null
    return readMetaAt(root, extractId)
  }

  readText(extractId: string): string | null {
    const root = this.root()
    if (!root) return null
    const extract = readMetaAt(root, extractId)
    if (!extract || extract.status !== 'ready' || !extract.text) return null
    const buffer = readExactFile(
      blobPath(root, extract.text.artifactSha256),
      PROJECT_REFERENCE_EXTRACT_MAX_TEXT_BYTES
    )
    if (!buffer) return null
    const digest = createHash('sha256').update(buffer).digest('hex')
    if (digest !== extract.text.artifactSha256) return null
    return buffer.toString('utf8')
  }

  purgeForReference(projectId: string, referenceId: string): ProjectReferenceExtractPurgeResult {
    const root = this.root()
    if (!root) return { ok: false, reason: 'unsafe_extract_directory' }
    if (!safeFlatId(projectId) || !safeFlatId(referenceId)) {
      return { ok: false, reason: 'invalid_input' }
    }
    return this.purgeMatching(root, (extract) =>
      extract.projectId === projectId && extract.referenceId === referenceId ? 'delete' : 'keep'
    )
  }

  purgeForProject(projectId: string): ProjectReferenceExtractPurgeResult {
    const root = this.root()
    if (!root) return { ok: false, reason: 'unsafe_extract_directory' }
    if (!safeFlatId(projectId)) return { ok: false, reason: 'invalid_input' }
    return this.purgeMatching(root, (extract) =>
      extract.projectId === projectId ? 'delete' : 'keep'
    )
  }

  private purgeMatching(
    root: string,
    decide: (extract: ProjectReferenceExtract) => 'delete' | 'keep'
  ): ProjectReferenceExtractPurgeResult {
    let deletedExtracts = 0
    let deletedBlobs = 0
    const shasToDelete: string[] = []

    for (const extractId of listMetaExtractIds(root)) {
      const extract = readMetaAt(root, extractId)
      if (!extract) {
        // Fail closed for unreadable meta belonging to an unknown record: skip
        // opaque corruption rather than inventing ownership.
        continue
      }
      if (decide(extract) !== 'delete') continue
      if (extract.text?.artifactSha256) shasToDelete.push(extract.text.artifactSha256)
      if (!deleteMetaFile(root, extractId)) {
        return { ok: false, reason: 'persistence_failed' }
      }
      deletedExtracts += 1
      const index = readActiveIndex(root)
      if (index?.entries.some((entry) => entry.extractId === extractId)) {
        if (!setActive(root, extract.projectId, extract.referenceId, null)) {
          return { ok: false, reason: 'persistence_failed' }
        }
      }
    }

    for (const sha of new Set(shasToDelete)) {
      if (deleteBlobIfUnreferenced(root, sha)) deletedBlobs += 1
    }
    return { ok: true, deletedExtracts, deletedBlobs }
  }
}
