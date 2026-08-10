/**
 * Shared, node-free contracts for TaskWraith Canvas charts.
 *
 * Dual-surface document: the same JSON is accepted from transcript
 * ```chart``` fences and from the MCP Canvas dock (`canvas_render_chart`).
 * Keeping the model declarative means agents describe series/points instead of
 * injecting chart-library scripts into a preview surface.
 *
 * SOURCE OF TRUTH: this module owns CanvasChart* types + validateCanvasChart +
 * parseCanvasChartFence. Main re-exports via `src/main/canvas/canvasTypes.ts`
 * for existing importers — do not reintroduce a second validator there.
 */

export const CANVAS_CHART_SCHEMA_VERSION = 1 as const

export const CANVAS_CHART_KINDS = ['line', 'bar', 'area', 'scatter'] as const
export type CanvasChartKind = (typeof CANVAS_CHART_KINDS)[number]

/** Bound how many independent series one chart document may carry. */
export const CANVAS_CHART_MAX_SERIES = 8
/** Bound point count per series before validation rejects the document. */
export const CANVAS_CHART_MAX_POINTS_PER_SERIES = 2000
/** Inclusive UTF-16 code-unit ceiling for `title`. */
export const CANVAS_CHART_MAX_TITLE_CHARS = 120
/** Inclusive UTF-8 byte ceiling for the JSON encoding of one chart document. */
export const CANVAS_CHART_MAX_JSON_BYTES = 256 * 1024

export interface CanvasChartPoint {
  x: number | string
  y: number
}

export interface CanvasChartSeries {
  id: string
  label: string
  points: CanvasChartPoint[]
}

export interface CanvasChartDocument {
  schemaVersion: typeof CANVAS_CHART_SCHEMA_VERSION
  title: string
  kind: CanvasChartKind
  series: CanvasChartSeries[]
  xLabel?: string
  yLabel?: string
}

export type CanvasChartValidation =
  | { ok: true; document: CanvasChartDocument }
  | { ok: false; reason: string }

const KIND_SET: ReadonlySet<string> = new Set(CANVAS_CHART_KINDS)

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function utf8ByteLength(text: string): number {
  // TextEncoder is available in both Electron renderer and Node/vitest — avoid
  // `Buffer` so this module stays renderer-safe (same discipline as meshScene).
  return new TextEncoder().encode(text).byteLength
}

function jsonByteLength(value: unknown): number | null {
  try {
    return utf8ByteLength(JSON.stringify(value))
  } catch {
    return null
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isChartKind(value: unknown): value is CanvasChartKind {
  return typeof value === 'string' && KIND_SET.has(value)
}

function validatePoint(raw: unknown, seriesId: string, index: number): CanvasChartPoint | string {
  if (!isRecord(raw)) {
    return `Series "${seriesId}" point ${index} must be an object.`
  }
  const { x, y } = raw
  if (!(typeof x === 'string' || isFiniteNumber(x))) {
    return `Series "${seriesId}" point ${index} needs a finite number or string \`x\`.`
  }
  if (!isFiniteNumber(y)) {
    return `Series "${seriesId}" point ${index} needs a finite number \`y\`.`
  }
  return { x, y }
}

function validateSeries(raw: unknown, index: number): CanvasChartSeries | string {
  if (!isRecord(raw)) {
    return `series[${index}] must be an object.`
  }
  if (typeof raw.id !== 'string' || !raw.id.trim()) {
    return `series[${index}] requires a non-empty string \`id\`.`
  }
  if (typeof raw.label !== 'string' || !raw.label.trim()) {
    return `series[${index}] requires a non-empty string \`label\`.`
  }
  if (!Array.isArray(raw.points) || raw.points.length === 0) {
    return `Series "${raw.id.trim()}" requires a non-empty \`points\` array.`
  }
  if (raw.points.length > CANVAS_CHART_MAX_POINTS_PER_SERIES) {
    return `Series "${raw.id.trim()}" has too many points (max ${CANVAS_CHART_MAX_POINTS_PER_SERIES}).`
  }
  const points: CanvasChartPoint[] = []
  for (let i = 0; i < raw.points.length; i += 1) {
    const point = validatePoint(raw.points[i], raw.id.trim(), i)
    if (typeof point === 'string') return point
    points.push(point)
  }
  return {
    id: raw.id.trim(),
    label: raw.label.trim(),
    points
  }
}

/**
 * Validate a chart document for transcript fences and MCP dock open.
 * Returns a fresh, unknown-key-stripped document on success.
 */
export function validateCanvasChart(raw: unknown): CanvasChartValidation {
  if (!isRecord(raw)) {
    return { ok: false, reason: 'Chart document must be a JSON object.' }
  }

  const encodedBytes = jsonByteLength(raw)
  if (encodedBytes === null) {
    return { ok: false, reason: 'Chart document could not be JSON-encoded.' }
  }
  if (encodedBytes > CANVAS_CHART_MAX_JSON_BYTES) {
    return {
      ok: false,
      reason: `Chart JSON too large (${encodedBytes} bytes; max ${CANVAS_CHART_MAX_JSON_BYTES}).`
    }
  }

  if (raw.schemaVersion !== CANVAS_CHART_SCHEMA_VERSION) {
    return {
      ok: false,
      reason: `Unsupported chart schemaVersion (expected ${CANVAS_CHART_SCHEMA_VERSION}).`
    }
  }

  if (typeof raw.title !== 'string') {
    return { ok: false, reason: 'Chart `title` must be a string.' }
  }
  const title = raw.title.trim()
  if (!title) {
    return { ok: false, reason: 'Chart `title` must be non-empty.' }
  }
  if (title.length > CANVAS_CHART_MAX_TITLE_CHARS) {
    return {
      ok: false,
      reason: `Chart \`title\` too long (max ${CANVAS_CHART_MAX_TITLE_CHARS} characters).`
    }
  }

  if (!isChartKind(raw.kind)) {
    return {
      ok: false,
      reason: `Unsupported chart kind (expected ${CANVAS_CHART_KINDS.join(' | ')}).`
    }
  }

  if (raw.xLabel !== undefined && typeof raw.xLabel !== 'string') {
    return { ok: false, reason: 'Chart `xLabel` must be a string when provided.' }
  }
  if (raw.yLabel !== undefined && typeof raw.yLabel !== 'string') {
    return { ok: false, reason: 'Chart `yLabel` must be a string when provided.' }
  }

  if (!Array.isArray(raw.series)) {
    return { ok: false, reason: 'Chart `series` must be an array.' }
  }
  if (raw.series.length === 0) {
    return { ok: false, reason: 'Chart requires at least one series.' }
  }
  if (raw.series.length > CANVAS_CHART_MAX_SERIES) {
    return {
      ok: false,
      reason: `Too many series (max ${CANVAS_CHART_MAX_SERIES}).`
    }
  }

  const series: CanvasChartSeries[] = []
  const seenIds = new Set<string>()
  for (let i = 0; i < raw.series.length; i += 1) {
    const entry = validateSeries(raw.series[i], i)
    if (typeof entry === 'string') {
      return { ok: false, reason: entry }
    }
    if (seenIds.has(entry.id)) {
      return { ok: false, reason: `Duplicate series id "${entry.id}".` }
    }
    seenIds.add(entry.id)
    series.push(entry)
  }

  const document: CanvasChartDocument = {
    schemaVersion: CANVAS_CHART_SCHEMA_VERSION,
    title,
    kind: raw.kind,
    series
  }
  if (typeof raw.xLabel === 'string') document.xLabel = raw.xLabel
  if (typeof raw.yLabel === 'string') document.yLabel = raw.yLabel
  return { ok: true, document }
}

/**
 * Parse the JSON body of a transcript ```chart``` fence (markers already stripped)
 * and validate it with {@link validateCanvasChart}.
 */
export function parseCanvasChartFence(fenceBody: string): CanvasChartValidation {
  if (typeof fenceBody !== 'string') {
    return { ok: false, reason: 'Chart fence body must be a string.' }
  }
  const trimmed = fenceBody.trim()
  if (!trimmed) {
    return { ok: false, reason: 'Chart fence body is empty.' }
  }
  const bytes = utf8ByteLength(trimmed)
  if (bytes > CANVAS_CHART_MAX_JSON_BYTES) {
    return {
      ok: false,
      reason: `Chart JSON too large (${bytes} bytes; max ${CANVAS_CHART_MAX_JSON_BYTES}).`
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed) as unknown
  } catch {
    return { ok: false, reason: 'Chart fence body is not valid JSON.' }
  }
  if (!isRecord(parsed)) {
    return { ok: false, reason: 'Chart fence JSON must be an object.' }
  }
  return validateCanvasChart(parsed)
}
