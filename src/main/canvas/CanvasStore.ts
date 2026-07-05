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
const CANVAS_DRIVER_KINDS: ReadonlySet<CanvasDriverKind> = new Set([
  'web',
  'html',
  'image',
  'sketch',
  'window',
  'device'
])
const SKETCH_ELEMENT_KINDS = new Set(['rect', 'ellipse', 'line', 'arrow', 'text', 'path'])

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

function writeJson<T>(filePath: string, data: T): void {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
  let fd: number | null = null
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fd = fs.openSync(tempPath, 'w')
    fs.writeFileSync(fd, JSON.stringify(data, null, 2), 'utf-8')
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = null
    fs.renameSync(tempPath, filePath)
    try {
      const dirFd = fs.openSync(path.dirname(filePath), 'r')
      fs.fsyncSync(dirFd)
      fs.closeSync(dirFd)
    } catch {
      // Directory fsync is best effort on some filesystems.
    }
  } catch (e) {
    console.error(`Failed to write ${filePath}`, e)
    if (fd !== null) {
      try {
        fs.closeSync(fd)
      } catch {
        // Preserve the original failure.
      }
    }
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath)
    } catch {
      // Stale temp files are safer than masking the original failure.
    }
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
    originAllowlist: Array.isArray(input.originAllowlist)
      ? input.originAllowlist.filter((h): h is string => typeof h === 'string')
      : [],
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
  return {
    schemaVersion: 1,
    id: input.id,
    canvasId: input.canvasId,
    kind: input.kind,
    provider: typeof input.provider === 'string' ? input.provider : undefined,
    chatId: typeof input.chatId === 'string' ? input.chatId : undefined,
    runId: typeof input.runId === 'string' ? input.runId : undefined,
    detail:
      input.detail && typeof input.detail === 'object'
        ? (input.detail as Record<string, unknown>)
        : undefined,
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
    marks,
    author: input.author === 'human' ? 'human' : 'agent',
    createdAt: asString(input.createdAt) || new Date().toISOString()
  }
}

export class CanvasStore {
  private readonly sessionsPath: string
  private readonly eventsPath: string
  private readonly annotationsPath: string
  private readonly sketchDocumentsPath: string

  constructor(baseDir: string) {
    this.sessionsPath = path.join(baseDir, 'canvas-sessions.json')
    this.eventsPath = path.join(baseDir, 'canvas-events.json')
    this.annotationsPath = path.join(baseDir, 'canvas-annotations.json')
    this.sketchDocumentsPath = path.join(baseDir, 'canvas-sketch-documents.json')
  }

  listSessions(): CanvasSessionRecord[] {
    return readJson<unknown[]>(this.sessionsPath, [])
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

  /** Append an audit event (oldest trimmed past the cap). */
  appendEvent(event: CanvasEventRecord): CanvasEventRecord {
    const normalized = normalizeEventRecord(event)
    if (!normalized) throw new Error('Canvas event record is invalid.')
    const events = [...this.listEvents(), normalized].slice(-EVENT_HISTORY_LIMIT)
    writeJson(this.eventsPath, events)
    return normalized
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
