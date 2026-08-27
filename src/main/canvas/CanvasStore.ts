/**
 * Persistence for Canvas sessions + audit events.
 *
 * Deliberately a SELF-CONTAINED store (own atomic read/write) rather than new
 * methods on the static `AppStore`, so this slice never edits the shared
 * `store/index.ts` that a concurrent session is actively changing. The
 * atomic-write discipline (temp → fsync → rename → dir-fsync) and the
 * corrupt-file-backup read mirror `store/index.ts` exactly.
 *
 * `baseDir` is injected (constructor arg) so the class carries no `electron`
 * dependency and is unit-testable against a tmp dir. The real wiring passes
 * `join(app.getPath('userData'), 'canvas')`.
 */
import * as fs from 'fs'
import * as path from 'path'
import { randomBytes } from 'crypto'
import type {
  CanvasAnnotation,
  CanvasDriverKind,
  CanvasEventRecord,
  CanvasMark,
  CanvasSessionRecord,
  CanvasSketchDocument,
  CanvasSketchElement,
  CanvasViewport
} from './canvasTypes'

const SESSION_HISTORY_LIMIT = 100
const EVENT_HISTORY_LIMIT = 2000
const ANNOTATION_HISTORY_LIMIT = 500
const SKETCH_DOCUMENT_LIMIT = 200
const CANVAS_STORE_FILE_NAMES = new Set([
  'canvas-sessions.json',
  'canvas-events.json',
  'canvas-annotations.json',
  'canvas-sketch-documents.json',
  'canvas-eval-approval-uses.json'
])
const CANVAS_DRIVER_KINDS: ReadonlySet<CanvasDriverKind> = new Set([
  'web',
  'html',
  'image',
  'sketch',
  'window',
  'device',
  'chart'
])
const SKETCH_ELEMENT_KINDS = new Set(['rect', 'ellipse', 'line', 'arrow', 'text', 'path'])

/**
 * Best-effort directory-handle fsync. Windows maps fsync to FlushFileBuffers,
 * which rejects directory handles with EPERM (and occasionally EACCES). Some
 * other platforms/filesystems surface EINVAL/EBADF/EISDIR/ENOTSUP. File-handle
 * fsync remains strict at call sites; only directory barriers use this helper
 * (matches UsageJournalStore / ExecutionGraphRepository durability posture).
 */
function fsyncDirectoryFdBestEffort(fd: number): void {
  try {
    fs.fsyncSync(fd)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code
    if (
      code === 'EPERM' ||
      code === 'EACCES' ||
      code === 'EINVAL' ||
      code === 'EBADF' ||
      code === 'EISDIR' ||
      code === 'ENOTSUP'
    ) {
      return
    }
    throw error
  }
}

interface CanvasSketchDocumentRecord {
  schemaVersion: 1
  scope: string
  document: CanvasSketchDocument
  updatedAt: string
}

function readJson<T>(filePath: string, defaultData: T): T {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T
    }
  } catch (e) {
    console.error(`Failed to read ${filePath}`, e)
    try {
      if (fs.existsSync(filePath)) {
        fs.copyFileSync(filePath, `${filePath}.corrupt-${Date.now()}`)
      }
    } catch (backupError) {
      console.error(`Failed to preserve corrupt ${filePath}`, backupError)
    }
  }
  return defaultData
}

function isMissingPathError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'ENOENT')
}

function assertSameFileIdentity(
  filePath: string,
  opened: fs.Stats,
  linked: fs.Stats
): void {
  if (opened.dev !== linked.dev || opened.ino !== linked.ino) {
    throw new Error(`Security ledger ${filePath} changed while it was being opened.`)
  }
}

function assertStrictRegularFile(filePath: string, stat: fs.Stats): void {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new Error(`Security ledger ${filePath} is not a private regular file.`)
  }
}

/** Open an existing security file without following redirections or hardlinks. */
function openStrictRegularFile(filePath: string): number | null {
  const noFollow = fs.constants.O_NOFOLLOW ?? 0
  let fd: number
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow)
  } catch (error) {
    if (isMissingPathError(error)) return null
    throw error
  }
  try {
    const opened = fs.fstatSync(fd)
    assertStrictRegularFile(filePath, opened)
    const linked = fs.lstatSync(filePath)
    assertStrictRegularFile(filePath, linked)
    assertSameFileIdentity(filePath, opened, linked)
    return fd
  } catch (error) {
    fs.closeSync(fd)
    throw error
  }
}

type PinnedDirectory = { fd: number; stat: fs.Stats }

function assertPinnedDirectory(directoryPath: string, pinned: PinnedDirectory): void {
  const opened = fs.fstatSync(pinned.fd)
  if (!opened.isDirectory()) throw new Error(`Security ledger directory changed type.`)
  assertSameFileIdentity(directoryPath, pinned.stat, opened)
  assertDirectoryIdentity(directoryPath, pinned.stat)
}

function readJsonArrayStrict(filePath: string, pinned?: PinnedDirectory): unknown[] {
  const directoryPath = path.dirname(filePath)
  const directory = openStrictDirectory(directoryPath)
  let fd: number | null = null
  try {
    assertDirectoryIdentity(directoryPath, directory.stat)
    if (pinned) {
      assertPinnedDirectory(directoryPath, pinned)
      assertSameFileIdentity(directoryPath, pinned.stat, directory.stat)
    }
    fd = openStrictRegularFile(filePath)
    if (fd === null) return []
    assertDirectoryIdentity(directoryPath, directory.stat)
    const parsed = JSON.parse(fs.readFileSync(fd, 'utf8')) as unknown
    if (pinned) assertPinnedDirectory(directoryPath, pinned)
    if (!Array.isArray(parsed)) throw new Error(`Security ledger ${filePath} is malformed.`)
    return parsed
  } finally {
    if (fd !== null) fs.closeSync(fd)
    fs.closeSync(directory.fd)
  }
}

/** Security-ledger reader: corruption or redirection must fail closed. */
function readStringArrayStrict(filePath: string, pinned?: PinnedDirectory): string[] {
  const parsed = readJsonArrayStrict(filePath, pinned)
  if (parsed.some((value) => typeof value !== 'string' || !value)) {
    throw new Error(`Security ledger ${filePath} is malformed.`)
  }
  return parsed as string[]
}

function openStrictDirectory(directoryPath: string): { fd: number; stat: fs.Stats } {
  fs.mkdirSync(directoryPath, { recursive: true, mode: 0o700 })
  const linked = fs.lstatSync(directoryPath)
  if (!linked.isDirectory() || linked.isSymbolicLink()) {
    throw new Error(`Security ledger directory ${directoryPath} is not a private directory.`)
  }
  const noFollow = fs.constants.O_NOFOLLOW ?? 0
  const directoryOnly = fs.constants.O_DIRECTORY ?? 0
  const fd = fs.openSync(directoryPath, fs.constants.O_RDONLY | directoryOnly | noFollow)
  try {
    const opened = fs.fstatSync(fd)
    if (!opened.isDirectory()) {
      throw new Error(`Security ledger directory ${directoryPath} is not a directory.`)
    }
    const current = fs.lstatSync(directoryPath)
    if (!current.isDirectory() || current.isSymbolicLink()) {
      throw new Error(`Security ledger directory ${directoryPath} was redirected.`)
    }
    assertSameFileIdentity(directoryPath, opened, current)
    // Tighten permissions through the already-verified descriptor. A
    // path-based chmod here would reopen a lstat/chmod symlink race.
    if (process.platform !== 'win32') fs.fchmodSync(fd, 0o700)
    const secured = fs.fstatSync(fd)
    if (!secured.isDirectory()) {
      throw new Error(`Security ledger directory ${directoryPath} changed type.`)
    }
    const securedPath = fs.lstatSync(directoryPath)
    if (!securedPath.isDirectory() || securedPath.isSymbolicLink()) {
      throw new Error(`Security ledger directory ${directoryPath} was redirected.`)
    }
    assertSameFileIdentity(directoryPath, secured, securedPath)
    return { fd, stat: secured }
  } catch (error) {
    fs.closeSync(fd)
    throw error
  }
}

function assertDirectoryIdentity(directoryPath: string, expected: fs.Stats): void {
  const current = fs.lstatSync(directoryPath)
  if (!current.isDirectory() || current.isSymbolicLink()) {
    throw new Error(`Security ledger directory ${directoryPath} was redirected.`)
  }
  assertSameFileIdentity(directoryPath, expected, current)
}

function assertExistingTargetSafe(filePath: string): void {
  const fd = openStrictRegularFile(filePath)
  if (fd !== null) fs.closeSync(fd)
}

function isCanvasRecoveryArtifact(name: string): boolean {
  return [...CANVAS_STORE_FILE_NAMES].some(
    (fileName) =>
      name.startsWith(`${fileName}.`) &&
      (name.endsWith('.tmp') || name.includes('.corrupt-'))
  )
}

function purgeCanvasRecoveryArtifactsStrict(
  directoryPath: string,
  pinned?: PinnedDirectory
): void {
  const directory = openStrictDirectory(directoryPath)
  try {
    assertDirectoryIdentity(directoryPath, directory.stat)
    if (pinned) {
      assertPinnedDirectory(directoryPath, pinned)
      assertSameFileIdentity(directoryPath, pinned.stat, directory.stat)
    }
    for (const entry of fs.readdirSync(directoryPath, { withFileTypes: true })) {
      if (!isCanvasRecoveryArtifact(entry.name)) continue
      if (entry.isDirectory()) {
        throw new Error(`Canvas recovery artifact is unexpectedly a directory: ${entry.name}`)
      }
      // Unlink the entry itself. Symlink targets and hardlink peers are never
      // traversed or overwritten.
      fs.unlinkSync(path.join(directoryPath, entry.name))
      assertDirectoryIdentity(directoryPath, directory.stat)
      if (pinned) assertPinnedDirectory(directoryPath, pinned)
    }
    fsyncDirectoryFdBestEffort(directory.fd)
  } finally {
    fs.closeSync(directory.fd)
  }
}

function writeJsonStrict<T>(filePath: string, data: T, pinned?: PinnedDirectory): void {
  const directoryPath = path.dirname(filePath)
  const directory = openStrictDirectory(directoryPath)
  const tempPath = `${filePath}.${process.pid}.${randomBytes(12).toString('hex')}.tmp`
  let fd: number | null = null
  try {
    assertDirectoryIdentity(directoryPath, directory.stat)
    if (pinned) {
      assertPinnedDirectory(directoryPath, pinned)
      assertSameFileIdentity(directoryPath, pinned.stat, directory.stat)
    }
    fd = fs.openSync(
      tempPath,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        (fs.constants.O_NOFOLLOW ?? 0),
      0o600
    )
    const tempOpened = fs.fstatSync(fd)
    assertStrictRegularFile(tempPath, tempOpened)
    const tempLinked = fs.lstatSync(tempPath)
    assertStrictRegularFile(tempPath, tempLinked)
    assertSameFileIdentity(tempPath, tempOpened, tempLinked)
    fs.writeFileSync(fd, JSON.stringify(data, null, 2), 'utf-8')
    fs.fsyncSync(fd)
    assertDirectoryIdentity(directoryPath, directory.stat)
    if (pinned) assertPinnedDirectory(directoryPath, pinned)
    assertExistingTargetSafe(filePath)
    const tempBeforeRename = fs.lstatSync(tempPath)
    assertStrictRegularFile(tempPath, tempBeforeRename)
    assertSameFileIdentity(tempPath, fs.fstatSync(fd), tempBeforeRename)
    fs.renameSync(tempPath, filePath)
    const destination = fs.lstatSync(filePath)
    assertStrictRegularFile(filePath, destination)
    assertSameFileIdentity(filePath, fs.fstatSync(fd), destination)
    assertDirectoryIdentity(directoryPath, directory.stat)
    if (pinned) assertPinnedDirectory(directoryPath, pinned)
    fsyncDirectoryFdBestEffort(directory.fd)
    fs.closeSync(fd)
    fd = null
  } catch (e) {
    if (fd !== null) {
      try {
        fs.closeSync(fd)
      } catch {
        // Preserve the original failure.
      }
    }
    try {
      fs.unlinkSync(tempPath)
    } catch {
      // A missing/stale temp must not mask the original failure.
    }
    throw e
  } finally {
    fs.closeSync(directory.fd)
  }
}

/** Best-effort writer retained for ordinary canvas history. */
function writeJson<T>(filePath: string, data: T): void {
  try {
    writeJsonStrict(filePath, data)
  } catch (e) {
    console.error(`Failed to write ${filePath}`, e)
  }
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asViewport(value: unknown): CanvasViewport {
  const v = value && typeof value === 'object' ? (value as Partial<CanvasViewport>) : {}
  const width = Number(v.width)
  const height = Number(v.height)
  return {
    width: Number.isFinite(width) && width > 0 ? Math.trunc(width) : 1280,
    height: Number.isFinite(height) && height > 0 ? Math.trunc(height) : 800
  }
}

function asFiniteNumber(value: unknown): number | undefined {
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

function normalizeSketchElement(value: unknown): CanvasSketchElement | null {
  if (!value || typeof value !== 'object') return null
  const input = value as Partial<CanvasSketchElement>
  if (!input.kind || !SKETCH_ELEMENT_KINDS.has(input.kind)) return null
  const element: CanvasSketchElement = { kind: input.kind }
  if (typeof input.id === 'string' && input.id) element.id = input.id.slice(0, 80)
  for (const key of ['x', 'y', 'width', 'height', 'x1', 'y1', 'x2', 'y2'] as const) {
    const n = asFiniteNumber(input[key])
    if (n !== undefined) element[key] = n
  }
  if (Array.isArray(input.points)) {
    element.points = input.points
      .slice(0, 200)
      .map((point) => {
        const p = point && typeof point === 'object' ? point : {}
        const x = asFiniteNumber((p as { x?: unknown }).x)
        const y = asFiniteNumber((p as { y?: unknown }).y)
        return x === undefined || y === undefined ? null : { x, y }
      })
      .filter((point): point is { x: number; y: number } => Boolean(point))
  }
  if (typeof input.d === 'string') element.d = input.d.slice(0, 4000)
  if (typeof input.text === 'string') element.text = input.text.slice(0, 500)
  if (typeof input.fill === 'string') element.fill = input.fill.slice(0, 64)
  if (typeof input.stroke === 'string') element.stroke = input.stroke.slice(0, 64)
  const strokeWidth = asFiniteNumber(input.strokeWidth)
  if (strokeWidth !== undefined) element.strokeWidth = strokeWidth
  const fontSize = asFiniteNumber(input.fontSize)
  if (fontSize !== undefined) element.fontSize = fontSize
  const opacity = asFiniteNumber(input.opacity)
  if (opacity !== undefined) element.opacity = opacity
  return element
}

function normalizeSketchDocument(value: unknown): CanvasSketchDocument | null {
  if (!value || typeof value !== 'object') return null
  const input = value as Partial<CanvasSketchDocument>
  const elements = Array.isArray(input.elements)
    ? input.elements
        .map((element) => normalizeSketchElement(element))
        .filter((element): element is CanvasSketchElement => Boolean(element))
        .slice(0, 400)
    : []
  return {
    schemaVersion: 1,
    title: asString(input.title).trim().slice(0, 120) || 'Sketch Canvas',
    viewport: asViewport(input.viewport),
    elements,
    updatedAt: asString(input.updatedAt) || new Date().toISOString()
  }
}

function normalizeSketchDocumentRecord(value: unknown): CanvasSketchDocumentRecord | null {
  if (!value || typeof value !== 'object') return null
  const input = value as Partial<CanvasSketchDocumentRecord>
  const scope = asString(input.scope).trim()
  const document = normalizeSketchDocument(input.document)
  if (!scope || !document) return null
  return {
    schemaVersion: 1,
    scope,
    document,
    updatedAt: asString(input.updatedAt) || document.updatedAt
  }
}

function normalizeSessionRecord(value: unknown): CanvasSessionRecord | null {
  if (!value || typeof value !== 'object') return null
  const input = value as Partial<CanvasSessionRecord>
  if (!input.id) return null
  const nowIso = new Date().toISOString()
  const status: CanvasSessionRecord['status'] =
    input.status === 'opening' ||
    input.status === 'active' ||
    input.status === 'error' ||
    input.status === 'closed'
      ? input.status
      : 'closed'
  return {
    schemaVersion: 1,
    id: input.id,
    driver:
      typeof input.driver === 'string' && CANVAS_DRIVER_KINDS.has(input.driver)
        ? input.driver
        : 'web',
    url: asString(input.url),
    title: asString(input.title),
    viewport: asViewport(input.viewport),
    status,
    chatId: typeof input.chatId === 'string' ? input.chatId : undefined,
    runId: typeof input.runId === 'string' ? input.runId : undefined,
    workspacePath: typeof input.workspacePath === 'string' ? input.workspacePath : undefined,
    createdAt: asString(input.createdAt) || nowIso,
    updatedAt: asString(input.updatedAt) || nowIso,
    closedAt: typeof input.closedAt === 'string' ? input.closedAt : undefined,
    error: typeof input.error === 'string' ? input.error : undefined
  }
}

function normalizeEventRecord(value: unknown): CanvasEventRecord | null {
  if (!value || typeof value !== 'object') return null
  const input = value as Partial<CanvasEventRecord>
  if (!input.id || !input.canvasId || !input.kind) return null
  const rawDetail =
    input.detail && typeof input.detail === 'object'
      ? (input.detail as Record<string, unknown>)
      : undefined
  const evalDetail =
    input.kind === 'eval' || input.kind === 'eval.started' || input.kind === 'eval.completed'
      ? {
          ...(typeof rawDetail?.approvalId === 'string'
            ? { approvalId: rawDetail.approvalId }
            : {}),
          ...(rawDetail?.scriptHashAlgorithm === 'sha256-utf16le' ||
          rawDetail?.scriptHashAlgorithm === 'sha256'
            ? { scriptHashAlgorithm: rawDetail.scriptHashAlgorithm }
            : {}),
          ...(typeof rawDetail?.scriptHash === 'string'
            ? { scriptHash: rawDetail.scriptHash }
            : {}),
          ...(typeof rawDetail?.scriptLength === 'number'
            ? { scriptLength: rawDetail.scriptLength }
            : {}),
          ...(typeof rawDetail?.scriptByteLength === 'number'
            ? { scriptByteLength: rawDetail.scriptByteLength }
            : {}),
          ...(typeof rawDetail?.ok === 'boolean' ? { ok: rawDetail.ok } : {}),
          ...(rawDetail?.outcome === 'success' ||
          rawDetail?.outcome === 'script_error' ||
          rawDetail?.outcome === 'host_error'
            ? { outcome: rawDetail.outcome }
            : {})
        }
      : rawDetail
  return {
    schemaVersion: 1,
    id: input.id,
    canvasId: input.canvasId,
    kind: input.kind,
    provider: typeof input.provider === 'string' ? input.provider : undefined,
    chatId: typeof input.chatId === 'string' ? input.chatId : undefined,
    workspacePath:
      typeof input.workspacePath === 'string' ? input.workspacePath : undefined,
    runId: typeof input.runId === 'string' ? input.runId : undefined,
    approvalId: typeof input.approvalId === 'string' ? input.approvalId : undefined,
    detail: evalDetail,
    createdAt: asString(input.createdAt) || new Date().toISOString()
  }
}

function normalizeMark(value: unknown): CanvasMark | null {
  if (!value || typeof value !== 'object') return null
  const input = value as Partial<CanvasMark>
  const label = asString(input.label).trim()
  if (!label) return null
  const mark: CanvasMark = { label: label.slice(0, 200) }
  if (typeof input.ref === 'string' && input.ref) mark.ref = input.ref
  if (
    Array.isArray(input.bbox) &&
    input.bbox.length === 4 &&
    input.bbox.every((n) => typeof n === 'number' && Number.isFinite(n))
  ) {
    mark.bbox = [input.bbox[0], input.bbox[1], input.bbox[2], input.bbox[3]]
  }
  if (input.severity === 'info' || input.severity === 'warn' || input.severity === 'error') {
    mark.severity = input.severity
  }
  return mark
}

function normalizeAnnotation(value: unknown): CanvasAnnotation | null {
  if (!value || typeof value !== 'object') return null
  const input = value as Partial<CanvasAnnotation>
  if (!input.id || !input.canvasId) return null
  const marks = Array.isArray(input.marks)
    ? input.marks.map((m) => normalizeMark(m)).filter((m): m is CanvasMark => Boolean(m))
    : []
  return {
    schemaVersion: 1,
    id: input.id,
    canvasId: input.canvasId,
    chatId: typeof input.chatId === 'string' ? input.chatId : undefined,
    workspacePath:
      typeof input.workspacePath === 'string' ? input.workspacePath : undefined,
    runId: typeof input.runId === 'string' ? input.runId : undefined,
    marks,
    author: input.author === 'human' ? 'human' : 'agent',
    createdAt: asString(input.createdAt) || new Date().toISOString()
  }
}

export class CanvasStore {
  private readonly baseDir: string
  private readonly sessionsPath: string
  private readonly eventsPath: string
  private readonly annotationsPath: string
  private readonly sketchDocumentsPath: string
  private readonly evalApprovalUsesPath: string

  constructor(baseDir: string) {
    this.baseDir = baseDir
    this.sessionsPath = path.join(baseDir, 'canvas-sessions.json')
    this.eventsPath = path.join(baseDir, 'canvas-events.json')
    this.annotationsPath = path.join(baseDir, 'canvas-annotations.json')
    this.sketchDocumentsPath = path.join(baseDir, 'canvas-sketch-documents.json')
    this.evalApprovalUsesPath = path.join(baseDir, 'canvas-eval-approval-uses.json')
  }

  /** Remove every Canvas-owned durable record during a global history purge. */
  clearAll(): void {
    let stat: fs.Stats
    try {
      stat = fs.lstatSync(this.baseDir)
    } catch (error) {
      if (isMissingPathError(error)) return
      throw error
    }
    // Unlinking only a substituted link would falsely report success while the
    // redirected JSON survives. Never follow it; fail the enclosing clear.
    if (stat.isSymbolicLink()) {
      throw new Error(`Canvas store ${this.baseDir} was redirected.`)
    }
    if (!stat.isDirectory()) {
      throw new Error(`Canvas store ${this.baseDir} is not a directory.`)
    }
    const pinned = openStrictDirectory(this.baseDir)
    try {
      // The pathname was inspected before the descriptor open. Bind that
      // original identity to the operation-wide descriptor too; otherwise a
      // real-directory replacement between lstat and open could be cleared
      // successfully while the original directory retained every ledger.
      assertSameFileIdentity(this.baseDir, stat, pinned.stat)
      assertPinnedDirectory(this.baseDir, pinned)
      // Keep one directory identity pinned across the complete transaction.
      // Every atomic writer verifies that same inode before and after replace.
      writeJsonStrict(this.annotationsPath, [], pinned)
      writeJsonStrict(this.sketchDocumentsPath, [], pinned)
      writeJsonStrict(this.eventsPath, [], pinned)
      writeJsonStrict(this.sessionsPath, [], pinned)
      writeJsonStrict(this.evalApprovalUsesPath, [], pinned)
      purgeCanvasRecoveryArtifactsStrict(this.baseDir, pinned)
      assertPinnedDirectory(this.baseDir, pinned)
      fsyncDirectoryFdBestEffort(pinned.fd)
    } finally {
      fs.closeSync(pinned.fd)
    }
  }

  listSessions(): CanvasSessionRecord[] {
    return readJson<unknown[]>(this.sessionsPath, [])
      .map((item) => normalizeSessionRecord(item))
      .filter((item): item is CanvasSessionRecord => Boolean(item))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  /**
   * Host Arc honesty path — corrupt / redirected session ledgers throw
   * instead of painting a false-empty artifacts family. Missing file → [].
   */
  listSessionsStrict(): CanvasSessionRecord[] {
    return readJsonArrayStrict(this.sessionsPath)
      .map((item) => normalizeSessionRecord(item))
      .filter((item): item is CanvasSessionRecord => Boolean(item))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  getSession(id: string): CanvasSessionRecord | null {
    return this.listSessions().find((session) => session.id === id) || null
  }

  /** Insert or replace a session record (idempotent on id), newest-first capped. */
  upsertSession(record: CanvasSessionRecord): CanvasSessionRecord {
    const normalized = normalizeSessionRecord({ ...record, updatedAt: new Date().toISOString() })
    if (!normalized) throw new Error('Canvas session record is invalid.')
    const sessions = [
      normalized,
      ...this.listSessions().filter((session) => session.id !== normalized.id)
    ].slice(0, SESSION_HISTORY_LIMIT)
    writeJson(this.sessionsPath, sessions)
    return normalized
  }

  listEvents(canvasId?: string): CanvasEventRecord[] {
    const events = readJson<unknown[]>(this.eventsPath, [])
      .map((item) => normalizeEventRecord(item))
      .filter((item): item is CanvasEventRecord => Boolean(item))
    return canvasId ? events.filter((event) => event.canvasId === canvasId) : events
  }

  private listEventsStrict(pinned?: PinnedDirectory): CanvasEventRecord[] {
    return readJsonArrayStrict(this.eventsPath, pinned)
      .map((item) => normalizeEventRecord(item))
      .filter((item): item is CanvasEventRecord => Boolean(item))
  }

  /**
   * Remove Canvas state owned by the supplied chat/workspace authorities.
   * This is strict because a chat-history transaction must not commit while a
   * redirected or corrupt Canvas file silently retains the cleared history.
   */
  purgeAuthoritiesStrict(input: {
    chatIds?: Iterable<string>
    workspacePaths?: Iterable<string>
  }): void {
    const chatIds = new Set(
      [...(input.chatIds ?? [])].map((value) => value.trim()).filter(Boolean)
    )
    const workspacePaths = new Set(
      [...(input.workspacePaths ?? [])].map((value) => value.trim()).filter(Boolean)
    )
    if (chatIds.size === 0 && workspacePaths.size === 0) return

    const pinned = openStrictDirectory(this.baseDir)
    try {
      assertPinnedDirectory(this.baseDir, pinned)
      const sessions = readJsonArrayStrict(this.sessionsPath, pinned)
        .map((item) => normalizeSessionRecord(item))
        .filter((item): item is CanvasSessionRecord => Boolean(item))
      const matchesSession = (session: CanvasSessionRecord): boolean =>
        Boolean(
          (session.chatId && chatIds.has(session.chatId)) ||
            (session.workspacePath && workspacePaths.has(session.workspacePath))
        )
      const removedCanvasIds = new Set(
        sessions.filter(matchesSession).map((session) => session.id)
      )

      const events = readJsonArrayStrict(this.eventsPath, pinned)
        .map((item) => normalizeEventRecord(item))
        .filter((item): item is CanvasEventRecord => Boolean(item))
      for (const event of events) {
        if (
          (event.chatId && chatIds.has(event.chatId)) ||
          (event.workspacePath && workspacePaths.has(event.workspacePath))
        ) {
          removedCanvasIds.add(event.canvasId)
        }
      }
      const retainedEvents = events.filter(
        (event) =>
          !removedCanvasIds.has(event.canvasId) &&
          !(event.chatId && chatIds.has(event.chatId)) &&
          !(event.workspacePath && workspacePaths.has(event.workspacePath))
      )

      const knownCanvasIds = new Set([
        ...sessions.map((session) => session.id),
        ...events.map((event) => event.canvasId)
      ])
      const annotations = readJsonArrayStrict(this.annotationsPath, pinned)
        .map((item) => normalizeAnnotation(item))
        .filter((item): item is CanvasAnnotation => Boolean(item))
        .filter((annotation) => {
          if (removedCanvasIds.has(annotation.canvasId)) return false
          if (annotation.chatId && chatIds.has(annotation.chatId)) return false
          if (annotation.workspacePath && workspacePaths.has(annotation.workspacePath)) return false
          // Legacy annotations carried no authority. If both capped mapping
          // sources have aged out, retaining the orphan during a scoped privacy
          // clear would be unverifiable, so remove it conservatively.
          if (!annotation.chatId && !annotation.workspacePath) {
            return knownCanvasIds.has(annotation.canvasId)
          }
          return true
        })

      const sketchDocuments = readJsonArrayStrict(this.sketchDocumentsPath, pinned)
        .map((item) => normalizeSketchDocumentRecord(item))
        .filter((item): item is CanvasSketchDocumentRecord => Boolean(item))
        .filter((record) => {
          if (record.scope.startsWith('chat:')) return !chatIds.has(record.scope.slice(5))
          if (record.scope.startsWith('workspace:')) {
            return !workspacePaths.has(record.scope.slice('workspace:'.length))
          }
          return true
        })

      // Stale atomic-write/corruption artifacts may contain a full prior JSON
      // image. Remove them before declaring a scoped history purge complete.
      purgeCanvasRecoveryArtifactsStrict(this.baseDir, pinned)

      // Commit dependents first and the authority-bearing session mapping last.
      // If any earlier write fails, a retry can still derive every canvas id from
      // the unchanged sessions file instead of stranding orphan annotations.
      writeJsonStrict(this.annotationsPath, annotations, pinned)
      writeJsonStrict(this.sketchDocumentsPath, sketchDocuments, pinned)
      writeJsonStrict(this.eventsPath, retainedEvents, pinned)
      writeJsonStrict(
        this.sessionsPath,
        sessions.filter((session) => !matchesSession(session)),
        pinned
      )
      assertPinnedDirectory(this.baseDir, pinned)
      fsyncDirectoryFdBestEffort(pinned.fd)
    } finally {
      fs.closeSync(pinned.fd)
    }
  }

  /** Append an audit event (oldest trimmed past the cap). */
  appendEvent(event: CanvasEventRecord): CanvasEventRecord {
    const normalized = normalizeEventRecord(event)
    if (!normalized) throw new Error('Canvas event record is invalid.')
    const events = [...this.listEvents(), normalized].slice(-EVENT_HISTORY_LIMIT)
    writeJson(this.eventsPath, events)
    return normalized
  }

  /**
   * Append an event and propagate any durability failure. Signed-elevated
   * operations use this before execution so a full disk / permission failure
   * fails closed instead of silently running without a receipt.
   */
  appendEventStrict(event: CanvasEventRecord): CanvasEventRecord {
    const normalized = normalizeEventRecord(event)
    if (!normalized) throw new Error('Canvas event record is invalid.')
    const pinned = openStrictDirectory(this.baseDir)
    try {
      assertPinnedDirectory(this.baseDir, pinned)
      if (normalized.kind === 'eval.started') {
        const approvalId = normalized.approvalId?.trim()
        if (!approvalId) throw new Error('canvas eval.started requires an approvalId.')
        const usedApprovalIds = readStringArrayStrict(this.evalApprovalUsesPath, pinned)
        if (usedApprovalIds.includes(approvalId)) {
          throw new Error('canvas_eval approval receipt has already been consumed.')
        }
        // Claim first. If the subsequent event write fails, the approval remains
        // consumed and execution stays blocked—safe failure beats silent replay.
        writeJsonStrict(this.evalApprovalUsesPath, [...usedApprovalIds, approvalId], pinned)
      }
      const events = [...this.listEventsStrict(pinned), normalized].slice(-EVENT_HISTORY_LIMIT)
      writeJsonStrict(this.eventsPath, events, pinned)
      assertPinnedDirectory(this.baseDir, pinned)
      fsyncDirectoryFdBestEffort(pinned.fd)
      return normalized
    } finally {
      fs.closeSync(pinned.fd)
    }
  }

  listAnnotations(canvasId?: string): CanvasAnnotation[] {
    const annotations = readJson<unknown[]>(this.annotationsPath, [])
      .map((item) => normalizeAnnotation(item))
      .filter((item): item is CanvasAnnotation => Boolean(item))
    return canvasId ? annotations.filter((a) => a.canvasId === canvasId) : annotations
  }

  appendAnnotation(annotation: CanvasAnnotation): CanvasAnnotation {
    const normalized = normalizeAnnotation(annotation)
    if (!normalized) throw new Error('Canvas annotation is invalid.')
    const annotations = [...this.listAnnotations(), normalized].slice(-ANNOTATION_HISTORY_LIMIT)
    writeJson(this.annotationsPath, annotations)
    return normalized
  }

  getSketchDocument(scope: string): CanvasSketchDocument | null {
    const key = scope.trim()
    if (!key) return null
    const record = readJson<unknown[]>(this.sketchDocumentsPath, [])
      .map((item) => normalizeSketchDocumentRecord(item))
      .filter((item): item is CanvasSketchDocumentRecord => Boolean(item))
      .find((item) => item.scope === key)
    return record?.document ?? null
  }

  upsertSketchDocument(scope: string, document: CanvasSketchDocument): CanvasSketchDocument {
    const key = scope.trim()
    if (!key) throw new Error('Canvas sketch document scope is required.')
    const normalized = normalizeSketchDocument(document)
    if (!normalized) throw new Error('Canvas sketch document is invalid.')
    const updatedAt = new Date().toISOString()
    const record: CanvasSketchDocumentRecord = {
      schemaVersion: 1,
      scope: key,
      document: { ...normalized, updatedAt },
      updatedAt
    }
    const records = [
      record,
      ...readJson<unknown[]>(this.sketchDocumentsPath, [])
        .map((item) => normalizeSketchDocumentRecord(item))
        .filter((item): item is CanvasSketchDocumentRecord => Boolean(item))
        .filter((item) => item.scope !== key)
    ].slice(0, SKETCH_DOCUMENT_LIMIT)
    writeJson(this.sketchDocumentsPath, records)
    return record.document
  }
}
