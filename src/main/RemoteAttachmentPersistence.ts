import { createHash } from 'crypto'
import fs from 'fs'
import path from 'path'
import type { TranscriptMediaAssetStore } from './services/TranscriptMediaAssetStore'
import { TRANSCRIPT_MEDIA_MAX_FULL_IMAGE_BYTES } from './services/TranscriptMediaAssetStore'

export interface RemoteImageAttachmentInput {
  dataBase64: string
  mimeType: string
  id?: string
  markup?: unknown
}

export interface PersistedRemoteImageAttachment {
  path: string
  mimeType: 'image/png' | 'image/jpeg'
  buffer: Buffer
  id?: string
  markup?: RemoteImageMarkup
  markupPromptText?: string
}

export const REMOTE_IMAGE_MARKUP_SCHEMA_VERSION = 1
/** Encoded JSON cap for one attachment's `markup` object. 16 KiB. */
export const MAX_REMOTE_IMAGE_MARKUP_JSON_BYTES = 16_384
export const MAX_REMOTE_IMAGE_MARKUP_PRIMITIVES = 32
export const MAX_REMOTE_IMAGE_MARKUP_POINTS_PER_STROKE = 256
export const MAX_REMOTE_IMAGE_ATTACHMENT_ID_CHARS = 128
export const MIN_REMOTE_IMAGE_MARKUP_THICKNESS = 0.25
export const MAX_REMOTE_IMAGE_MARKUP_THICKNESS = 64

export interface RemoteImageMarkupCoordinate {
  x: number
  y: number
}

export interface RemoteImageMarkupColor {
  r: number
  g: number
  b: number
  a: number
}

export type RemoteImageMarkupPrimitive =
  | {
      type: 'stroke'
      points: RemoteImageMarkupCoordinate[]
      color: RemoteImageMarkupColor
      thickness: number
    }
  | {
      type: 'rect'
      start: RemoteImageMarkupCoordinate
      end: RemoteImageMarkupCoordinate
      color: RemoteImageMarkupColor
      thickness: number
    }
  | {
      type: 'arrow'
      start: RemoteImageMarkupCoordinate
      end: RemoteImageMarkupCoordinate
      color: RemoteImageMarkupColor
      thickness: number
    }

export interface RemoteImageMarkup {
  schemaVersion: typeof REMOTE_IMAGE_MARKUP_SCHEMA_VERSION
  attachmentId: string
  primitives: RemoteImageMarkupPrimitive[]
}

export type RemoteImageAttachmentMeta =
  | { ok: true; id?: string; markup?: RemoteImageMarkup }
  | { ok: false; reason: string }

type RemoteAttachmentAssetStore = Pick<TranscriptMediaAssetStore, 'writeOwnedMany'>

const MAX_REMOTE_IMAGE_ATTACHMENTS = 20
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
const LEGACY_REMOTE_ATTACHMENT_PATTERN =
  /^[A-Za-z0-9-]+(?:-steer)?-[1-9]\d*-[0-9]+\.(?:png|jpg)$/

function sameIdentity(
  left: Pick<fs.Stats, 'dev' | 'ino'>,
  right: Pick<fs.Stats, 'dev' | 'ino'>
): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function assertCurrentUserOwned(stat: fs.Stats, label: string): void {
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error(`${label} is not owned by the current user.`)
  }
}

function canonicalMimeType(value: string): 'image/png' | 'image/jpeg' | null {
  if (value === 'image/png') return value
  if (value === 'image/jpeg' || value === 'image/jpg') return 'image/jpeg'
  return null
}

function decodeCanonicalBase64(value: string): Buffer {
  const normalized = value.trim().replace(/\s+/g, '')
  if (!normalized || !BASE64_PATTERN.test(normalized)) {
    throw new Error('Remote image attachment is not canonical base64.')
  }
  const buffer = Buffer.from(normalized, 'base64')
  if (
    buffer.length <= 0 ||
    buffer.length > TRANSCRIPT_MEDIA_MAX_FULL_IMAGE_BYTES ||
    buffer.toString('base64').replace(/=+$/, '') !== normalized.replace(/=+$/, '')
  ) {
    throw new Error('Remote image attachment exceeds the safe image boundary.')
  }
  return buffer
}

const MARKUP_KEYS = new Set(['schemaVersion', 'attachmentId', 'primitives'])
const COLOR_KEYS = new Set(['r', 'g', 'b', 'a'])
const POINT_KEYS = new Set(['x', 'y'])
const STROKE_KEYS = new Set(['type', 'points', 'color', 'thickness'])
const SEGMENT_KEYS = new Set(['type', 'start', 'end', 'color', 'thickness'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key))
}

function hasAsciiControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

function isUnit(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
}

function parseAttachmentId(
  value: unknown
): { ok: true; id: string } | { ok: false; reason: string } {
  if (typeof value !== 'string') {
    return { ok: false, reason: 'attachment id must be a string' }
  }
  if (value.trim() !== value || value.length === 0) {
    return { ok: false, reason: 'attachment id must be a non-empty trimmed string' }
  }
  if (value.length > MAX_REMOTE_IMAGE_ATTACHMENT_ID_CHARS) {
    return {
      ok: false,
      reason: `attachment id exceeds ${MAX_REMOTE_IMAGE_ATTACHMENT_ID_CHARS} characters`
    }
  }
  if (hasAsciiControlCharacter(value)) {
    return { ok: false, reason: 'attachment id contains a control character' }
  }
  return { ok: true, id: value }
}

function parseCoordinate(
  value: unknown,
  label: string
): { ok: true; coordinate: RemoteImageMarkupCoordinate } | { ok: false; reason: string } {
  if (!isRecord(value) || !hasOnlyKeys(value, POINT_KEYS)) {
    return { ok: false, reason: `${label} must be {x,y}` }
  }
  if (!isUnit(value.x) || !isUnit(value.y)) {
    return { ok: false, reason: `${label} coordinates must be finite numbers in 0..1` }
  }
  return { ok: true, coordinate: { x: value.x, y: value.y } }
}

function parseColor(
  value: unknown
): { ok: true; color: RemoteImageMarkupColor } | { ok: false; reason: string } {
  if (!isRecord(value) || !hasOnlyKeys(value, COLOR_KEYS)) {
    return { ok: false, reason: 'color must be {r,g,b} with optional a' }
  }
  if (!isUnit(value.r) || !isUnit(value.g) || !isUnit(value.b)) {
    return { ok: false, reason: 'color components must be finite numbers in 0..1' }
  }
  const alpha = value.a === undefined ? 1 : value.a
  if (!isUnit(alpha)) {
    return { ok: false, reason: 'color alpha must be a finite number in 0..1' }
  }
  return { ok: true, color: { r: value.r, g: value.g, b: value.b, a: alpha } }
}

function parseThickness(
  value: unknown
): { ok: true; thickness: number } | { ok: false; reason: string } {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < MIN_REMOTE_IMAGE_MARKUP_THICKNESS ||
    value > MAX_REMOTE_IMAGE_MARKUP_THICKNESS
  ) {
    return {
      ok: false,
      reason: `thickness must be finite and in ${MIN_REMOTE_IMAGE_MARKUP_THICKNESS}..${MAX_REMOTE_IMAGE_MARKUP_THICKNESS}`
    }
  }
  return { ok: true, thickness: value }
}

function parsePrimitive(
  value: unknown,
  index: number
): { ok: true; primitive: RemoteImageMarkupPrimitive } | { ok: false; reason: string } {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return { ok: false, reason: `primitive ${index} is not a typed object` }
  }
  const color = parseColor(value.color)
  if (!color.ok) return { ok: false, reason: `primitive ${index}: ${color.reason}` }
  const thickness = parseThickness(value.thickness)
  if (!thickness.ok) {
    return { ok: false, reason: `primitive ${index}: ${thickness.reason}` }
  }

  if (value.type === 'stroke') {
    if (!hasOnlyKeys(value, STROKE_KEYS) || !Array.isArray(value.points)) {
      return {
        ok: false,
        reason: `primitive ${index} stroke must be {type,points,color,thickness}`
      }
    }
    if (value.points.length === 0) {
      return { ok: false, reason: `primitive ${index} stroke requires at least one point` }
    }
    if (value.points.length > MAX_REMOTE_IMAGE_MARKUP_POINTS_PER_STROKE) {
      return {
        ok: false,
        reason: `primitive ${index} stroke exceeds ${MAX_REMOTE_IMAGE_MARKUP_POINTS_PER_STROKE} points`
      }
    }
    const points: RemoteImageMarkupCoordinate[] = []
    for (let i = 0; i < value.points.length; i += 1) {
      const point = parseCoordinate(value.points[i], `primitive ${index} point ${i}`)
      if (!point.ok) return point
      points.push(point.coordinate)
    }
    return {
      ok: true,
      primitive: {
        type: 'stroke',
        points,
        color: color.color,
        thickness: thickness.thickness
      }
    }
  }

  if (value.type === 'rect' || value.type === 'arrow') {
    if (!hasOnlyKeys(value, SEGMENT_KEYS)) {
      return {
        ok: false,
        reason: `primitive ${index} ${value.type} must be {type,start,end,color,thickness}`
      }
    }
    const start = parseCoordinate(value.start, `primitive ${index} start`)
    if (!start.ok) return start
    const end = parseCoordinate(value.end, `primitive ${index} end`)
    if (!end.ok) return end
    return {
      ok: true,
      primitive: {
        type: value.type,
        start: start.coordinate,
        end: end.coordinate,
        color: color.color,
        thickness: thickness.thickness
      }
    }
  }

  return { ok: false, reason: `primitive ${index} has unknown type` }
}

export function parseRemoteImageMarkup(
  value: unknown
): { ok: true; markup: RemoteImageMarkup } | { ok: false; reason: string } {
  if (!isRecord(value)) {
    return { ok: false, reason: 'markup must be an object' }
  }
  let encodedBytes: number
  try {
    encodedBytes = Buffer.byteLength(JSON.stringify(value), 'utf8')
  } catch {
    return { ok: false, reason: 'markup is not JSON-serializable' }
  }
  if (encodedBytes > MAX_REMOTE_IMAGE_MARKUP_JSON_BYTES) {
    return {
      ok: false,
      reason: `markup exceeds ${MAX_REMOTE_IMAGE_MARKUP_JSON_BYTES} UTF-8 bytes`
    }
  }
  if (!hasOnlyKeys(value, MARKUP_KEYS)) {
    return { ok: false, reason: 'markup allows only schemaVersion, attachmentId, primitives' }
  }
  if (value.schemaVersion !== REMOTE_IMAGE_MARKUP_SCHEMA_VERSION) {
    return { ok: false, reason: 'markup schemaVersion must be 1' }
  }
  const attachmentId = parseAttachmentId(value.attachmentId)
  if (!attachmentId.ok) return attachmentId
  if (!Array.isArray(value.primitives)) {
    return { ok: false, reason: 'markup primitives must be an array' }
  }
  if (value.primitives.length > MAX_REMOTE_IMAGE_MARKUP_PRIMITIVES) {
    return {
      ok: false,
      reason: `markup exceeds ${MAX_REMOTE_IMAGE_MARKUP_PRIMITIVES} primitives`
    }
  }
  const primitives: RemoteImageMarkupPrimitive[] = []
  for (let i = 0; i < value.primitives.length; i += 1) {
    const primitive = parsePrimitive(value.primitives[i], i)
    if (!primitive.ok) return primitive
    primitives.push(primitive.primitive)
  }
  return {
    ok: true,
    markup: {
      schemaVersion: REMOTE_IMAGE_MARKUP_SCHEMA_VERSION,
      attachmentId: attachmentId.id,
      primitives
    }
  }
}

export function parseRemoteImageAttachmentMeta(entry: unknown): RemoteImageAttachmentMeta {
  if (!isRecord(entry)) {
    return { ok: false, reason: 'attachment is not an object' }
  }
  const hasId = entry.id !== undefined
  const hasMarkup = entry.markup !== undefined
  if (!hasId && !hasMarkup) return { ok: true }

  let id: string | undefined
  if (hasId) {
    const parsedId = parseAttachmentId(entry.id)
    if (!parsedId.ok) return parsedId
    id = parsedId.id
  }
  if (!hasMarkup) return { ok: true, id }

  const markup = parseRemoteImageMarkup(entry.markup)
  if (!markup.ok) return markup
  if (!id) {
    return { ok: false, reason: 'markup requires a matching attachment id' }
  }
  if (markup.markup.attachmentId !== id) {
    return { ok: false, reason: 'markup attachmentId must match attachment id' }
  }
  return { ok: true, id, markup: markup.markup }
}

function formatCoordinate(point: RemoteImageMarkupCoordinate): string {
  return `(${point.x.toFixed(4)}, ${point.y.toFixed(4)})`
}

function formatColor(color: RemoteImageMarkupColor): string {
  return `rgba(${color.r}, ${color.g}, ${color.b}, ${color.a})`
}

function formatPrimitive(primitive: RemoteImageMarkupPrimitive): string {
  const color = formatColor(primitive.color)
  if (primitive.type === 'stroke') {
    const path = primitive.points.map(formatCoordinate).join(' → ')
    return `- stroke (${primitive.points.length} points): ${path}; color ${color}; thickness ${primitive.thickness}`
  }
  const span = `${formatCoordinate(primitive.start)} → ${formatCoordinate(primitive.end)}`
  return `- ${primitive.type}: ${span}; color ${color}; thickness ${primitive.thickness}`
}

/** Provider-visible coordinate text. Image bytes may still be the original
 * photo; this is how the host names the marks. */
export function formatRemoteImageMarkupForProvider(markup: RemoteImageMarkup): string {
  const header = `[Image annotation on attachment ${markup.attachmentId}, schemaVersion ${markup.schemaVersion}]`
  if (markup.primitives.length === 0) return header
  return [header, ...markup.primitives.map(formatPrimitive)].join('\n')
}

export function dispatchFieldsFromPersistedRemoteImages(
  attachments: readonly PersistedRemoteImageAttachment[]
): { imagePaths: string[]; markupPromptText?: string } {
  const imagePaths = attachments.map((attachment) => attachment.path)
  const texts = attachments
    .map((attachment) => attachment.markupPromptText)
    .filter((text): text is string => typeof text === 'string' && text.length > 0)
  return texts.length === 0
    ? { imagePaths }
    : { imagePaths, markupPromptText: texts.join('\n\n') }
}

/**
 * Persist phone/remote image input in the same chat-owned content-addressed
 * store as transcript media. This replaces anonymous OS-temp staging: the
 * bytes and ownership grant publish atomically, participate in the
 * transaction-long media history fence, and are removed by the exact chat or
 * global history purge. User-selected source files are never inputs here.
 */
export function persistRemoteImageAttachments(input: {
  appChatId: string
  attachments: readonly RemoteImageAttachmentInput[]
  store: RemoteAttachmentAssetStore
}): PersistedRemoteImageAttachment[] {
  const appChatId = input.appChatId.trim()
  if (!appChatId) throw new Error('Remote image attachment requires a canonical chat id.')
  if (input.attachments.length > MAX_REMOTE_IMAGE_ATTACHMENTS) {
    throw new Error('Remote image attachment count exceeds the safe boundary.')
  }

  const decoded = input.attachments.map((attachment) => {
    const mimeType = canonicalMimeType(attachment.mimeType)
    if (!mimeType) throw new Error('Remote image attachment type is unsupported.')
    const meta = parseRemoteImageAttachmentMeta(attachment)
    if (!meta.ok) {
      throw new Error(`Remote image attachment metadata is invalid: ${meta.reason}.`)
    }
    const buffer = decodeCanonicalBase64(attachment.dataBase64)
    return {
      mimeType,
      buffer,
      sha256: createHash('sha256').update(buffer).digest('base64url'),
      id: meta.id,
      markup: meta.markup,
      markupPromptText: meta.markup
        ? formatRemoteImageMarkupForProvider(meta.markup)
        : undefined
    }
  })
  if (decoded.length === 0) return []

  const written = input.store.writeOwnedMany(
    decoded.map((attachment) => ({
      sha256: attachment.sha256,
      mimeType: attachment.mimeType,
      buffer: attachment.buffer,
      appChatId
    }))
  )
  if (!written.ok) {
    throw new Error(`Remote image attachment persistence failed: ${written.reason}.`)
  }
  if (written.assets.length !== decoded.length) {
    throw new Error('Remote image attachment persistence returned an incomplete batch.')
  }
  return written.assets.map((asset, index) => {
    const persisted: PersistedRemoteImageAttachment = {
      path: asset.path,
      mimeType: decoded[index].mimeType,
      buffer: decoded[index].buffer
    }
    if (decoded[index].id) persisted.id = decoded[index].id
    if (decoded[index].markup) persisted.markup = decoded[index].markup
    if (decoded[index].markupPromptText) {
      persisted.markupPromptText = decoded[index].markupPromptText
    }
    return persisted
  })
}

/**
 * Remove only files created by the retired anonymous phone-staging path. New
 * attachments never enter this directory. Any unknown entry, link, directory
 * substitution, or ownership mismatch fails closed instead of risking a user
 * file. The caller may report the failure, but must not broaden the target.
 */
export function purgeLegacyRemoteAttachmentTempRoot(rootPath: string): number {
  let rootBefore: fs.Stats
  try {
    rootBefore = fs.lstatSync(rootPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw error
  }
  if (!rootBefore.isDirectory() || rootBefore.isSymbolicLink()) {
    throw new Error('Legacy remote attachment root is not a real directory.')
  }
  assertCurrentUserOwned(rootBefore, 'Legacy remote attachment root')

  const directoryFd = fs.openSync(
    rootPath,
    fs.constants.O_RDONLY |
      (fs.constants.O_DIRECTORY ?? 0) |
      (fs.constants.O_NOFOLLOW ?? 0)
  )
  let deleted = 0
  try {
    const openedRoot = fs.fstatSync(directoryFd)
    if (!openedRoot.isDirectory() || !sameIdentity(rootBefore, openedRoot)) {
      throw new Error('Legacy remote attachment root changed while it was opened.')
    }
    for (const entry of fs.readdirSync(rootPath).sort()) {
      if (!LEGACY_REMOTE_ATTACHMENT_PATTERN.test(entry)) {
        throw new Error('Legacy remote attachment root contains an unknown entry.')
      }
      const filePath = path.join(rootPath, entry)
      const before = fs.lstatSync(filePath)
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
        throw new Error('Legacy remote attachment entry is not an unlink-safe file.')
      }
      assertCurrentUserOwned(before, 'Legacy remote attachment entry')
      const fd = fs.openSync(
        filePath,
        fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0)
      )
      try {
        const opened = fs.fstatSync(fd)
        const currentRoot = fs.lstatSync(rootPath)
        const currentPath = fs.lstatSync(filePath)
        if (
          !opened.isFile() ||
          opened.nlink !== 1 ||
          !sameIdentity(before, opened) ||
          !sameIdentity(opened, currentPath) ||
          !sameIdentity(openedRoot, currentRoot)
        ) {
          throw new Error('Legacy remote attachment entry changed before deletion.')
        }
        fs.unlinkSync(filePath)
        try {
          fs.lstatSync(filePath)
          throw new Error('Legacy remote attachment entry survived deletion.')
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        deleted += 1
      } finally {
        fs.closeSync(fd)
      }
    }
    // Directory-handle fsync is best-effort: Windows maps fsync to
    // FlushFileBuffers, which rejects directory handles with EPERM/EACCES.
    // File unlinks above already completed; this barrier only strengthens
    // directory durability on platforms that support it.
    try {
      fs.fsyncSync(directoryFd)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code
      if (
        code !== 'EPERM' &&
        code !== 'EACCES' &&
        code !== 'EINVAL' &&
        code !== 'EBADF' &&
        code !== 'EISDIR' &&
        code !== 'ENOTSUP'
      ) {
        throw error
      }
    }
    const finalRoot = fs.lstatSync(rootPath)
    if (!sameIdentity(openedRoot, finalRoot)) {
      throw new Error('Legacy remote attachment root changed during deletion.')
    }
  } finally {
    fs.closeSync(directoryFd)
  }
  return deleted
}
