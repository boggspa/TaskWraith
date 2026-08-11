import path from 'path'
import type { TranscriptMediaRef, TranscriptMediaThumbnail } from '../store/types'
import type { TranscriptMediaAssetStore } from '../services/TranscriptMediaAssetStore'
import {
  defaultTranscriptMediaThumbnailer,
  isTranscriptRasterImageMime,
  sha256Base64Url,
  sniffImageMime,
  type TranscriptMediaThumbnailer
} from '../services/TranscriptMediaService'
import { sanitizeRawThumbnail } from '../../shared/transcriptMediaRefSanitize'
import {
  BLACKBOARD_MAX_IMAGE_ATTACHMENTS,
  BLACKBOARD_MAX_THUMBNAIL_BYTES
} from '../../shared/blackboardMedia'

export { BLACKBOARD_MAX_IMAGE_ATTACHMENTS, BLACKBOARD_MAX_THUMBNAIL_BYTES }
export const BLACKBOARD_MAX_IMAGE_BYTES = 8 * 1024 * 1024
export const BLACKBOARD_THUMBNAIL_MAX_EDGE = 384

const BLACKBOARD_MEDIA_SHA256_PATTERN = /^[A-Za-z0-9_-]{32,96}$/
const BLACKBOARD_MEDIA_SOURCES = new Set<TranscriptMediaRef['source']>([
  'generated',
  'tool_result',
  'upload'
])
const BLACKBOARD_MEDIA_STATUSES = new Set<NonNullable<TranscriptMediaRef['status']>>([
  'available',
  'missing',
  'denied',
  'too_large',
  'unsupported'
])

export interface BlackboardImageBufferInput {
  buffer: Buffer
  name?: string
  mimeType?: string
}

export interface BlackboardAgentImageRef {
  attachmentId: string
  name: string
  mimeType: string
  byteLength?: number
  width?: number
  height?: number
  status?: TranscriptMediaRef['status']
  hasThumbnail: boolean
  inspectWith: 'inspect_chat_attachment'
}

type BlackboardMediaStore = Pick<TranscriptMediaAssetStore, 'writeOwnedMany'>

export type PersistBlackboardImagesResult =
  | { ok: true; mediaRefs: TranscriptMediaRef[] }
  | {
      ok: false
      code:
        | 'blackboard_image_count_exceeded'
        | 'blackboard_image_empty'
        | 'blackboard_image_too_large'
        | 'blackboard_image_unsupported'
        | 'blackboard_image_thumbnail_failed'
        | 'blackboard_image_persistence_failed'
      error: string
    }

function boundedString(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return ''
  return value.trim().slice(0, maxLength)
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined
}

function boundedBlackboardThumbnail(value: unknown): TranscriptMediaThumbnail | undefined {
  const thumbnail = sanitizeRawThumbnail(value)
  if (!thumbnail) return undefined
  const byteLength = Buffer.byteLength(thumbnail.dataBase64, 'base64')
  return byteLength > 0 && byteLength <= BLACKBOARD_MAX_THUMBNAIL_BYTES ? thumbnail : undefined
}

/**
 * Fail-closed persisted-record sanitizer. Blackboard image refs are always
 * thumbnail-present, raster-only and pathless; store ownership is checked by
 * TranscriptMediaOwnershipClaims before a content address remains usable.
 */
export function sanitizeBlackboardMediaRefs(value: unknown): TranscriptMediaRef[] {
  if (!Array.isArray(value)) return []
  const refs: TranscriptMediaRef[] = []
  const seen = new Set<string>()
  for (const raw of value) {
    if (refs.length >= BLACKBOARD_MAX_IMAGE_ATTACHMENTS) break
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const record = raw as Record<string, unknown>
    if (record.kind !== 'image') continue
    const source = record.source as TranscriptMediaRef['source']
    if (!BLACKBOARD_MEDIA_SOURCES.has(source)) continue
    const mimeType = boundedString(record.mimeType, 128).toLowerCase()
    if (!isTranscriptRasterImageMime(mimeType)) continue
    const id = boundedString(record.id, 256)
    const thumbnail = boundedBlackboardThumbnail(record.thumbnail)
    if (!id || !thumbnail) continue
    const rawStatus = record.status
    if (
      rawStatus !== undefined &&
      !BLACKBOARD_MEDIA_STATUSES.has(rawStatus as NonNullable<TranscriptMediaRef['status']>)
    ) {
      continue
    }
    const shaCandidate = boundedString(record.sha256, 128)
    const sha256 = BLACKBOARD_MEDIA_SHA256_PATTERN.test(shaCandidate) ? shaCandidate : ''
    const assetId = boundedString(record.assetId, 256)
    const key = sha256 || assetId || id
    if (seen.has(key)) continue
    seen.add(key)
    const ref: TranscriptMediaRef = {
      id,
      kind: 'image',
      format: 'raster',
      source,
      name: boundedString(record.name, 256) || 'Blackboard image',
      mimeType,
      thumbnail,
      status: rawStatus as TranscriptMediaRef['status'] | undefined
    }
    const byteLength = positiveInteger(record.byteLength)
    const width = positiveInteger(record.width)
    const height = positiveInteger(record.height)
    const alt = boundedString(record.alt, 512)
    const caption = boundedString(record.caption, 1024)
    if (byteLength !== undefined) ref.byteLength = byteLength
    if (width !== undefined) ref.width = width
    if (height !== undefined) ref.height = height
    if (alt) ref.alt = alt
    if (caption) ref.caption = caption
    if (sha256) ref.sha256 = sha256
    if (assetId) ref.assetId = assetId
    refs.push(ref)
  }
  return refs
}

export function blackboardMediaRefsForAgent(value: unknown): BlackboardAgentImageRef[] {
  return sanitizeBlackboardMediaRefs(value).map((ref) => ({
    attachmentId: ref.id,
    name: ref.name,
    mimeType: ref.mimeType,
    ...(ref.byteLength ? { byteLength: ref.byteLength } : {}),
    ...(ref.width ? { width: ref.width } : {}),
    ...(ref.height ? { height: ref.height } : {}),
    ...(ref.status ? { status: ref.status } : {}),
    hasThumbnail: Boolean(ref.thumbnail),
    inspectWith: 'inspect_chat_attachment'
  }))
}

export function formatBlackboardMediaForPrompt(value: unknown): string {
  const refs = blackboardMediaRefsForAgent(value)
  if (refs.length === 0) return ''
  const labels = refs.map(
    (ref) => `${JSON.stringify(ref.name)} attachmentId=${JSON.stringify(ref.attachmentId)}`
  )
  return ` [images: ${labels.join(', ')}; view with inspect_chat_attachment]`
}

function createBoundedThumbnail(
  input: BlackboardImageBufferInput,
  mimeType: string,
  thumbnailer: TranscriptMediaThumbnailer
): TranscriptMediaThumbnail | null {
  const edges = [BLACKBOARD_THUMBNAIL_MAX_EDGE, 320, 256, 192, 128]
  for (const maxEdge of edges) {
    const thumbnail = thumbnailer({ buffer: input.buffer, mimeType, maxEdge })
    const bounded = boundedBlackboardThumbnail(thumbnail)
    if (bounded) return bounded
  }
  return null
}

function safeImageName(value: string | undefined, index: number): string {
  const basename = value ? path.basename(value.replace(/[\u0000-\u001f\u007f]/g, '')) : ''
  return basename.trim().slice(0, 256) || `Blackboard image ${index + 1}`
}

/**
 * Validate decoded image snapshots, generate small presentation thumbnails,
 * and atomically publish originals plus exact chat ownership grants.
 */
export function persistBlackboardImages(input: {
  appChatId: string
  entryId: string
  images: readonly BlackboardImageBufferInput[]
  store: BlackboardMediaStore
  thumbnailer?: TranscriptMediaThumbnailer
}): PersistBlackboardImagesResult {
  if (input.images.length > BLACKBOARD_MAX_IMAGE_ATTACHMENTS) {
    return {
      ok: false,
      code: 'blackboard_image_count_exceeded',
      error: `A Blackboard entry can attach at most ${BLACKBOARD_MAX_IMAGE_ATTACHMENTS} images.`
    }
  }
  if (input.images.length === 0) return { ok: true, mediaRefs: [] }
  const thumbnailer = input.thumbnailer || defaultTranscriptMediaThumbnailer
  const prepared: Array<{
    buffer: Buffer
    mimeType: string
    name: string
    sha256: string
    thumbnail: TranscriptMediaThumbnail
  }> = []
  const seen = new Set<string>()
  for (let index = 0; index < input.images.length; index += 1) {
    const image = input.images[index]
    if (!Buffer.isBuffer(image.buffer) || image.buffer.length === 0) {
      return {
        ok: false,
        code: 'blackboard_image_empty',
        error: `Blackboard image ${index + 1} is empty.`
      }
    }
    if (image.buffer.length > BLACKBOARD_MAX_IMAGE_BYTES) {
      return {
        ok: false,
        code: 'blackboard_image_too_large',
        error: `Blackboard image ${index + 1} exceeds the ${BLACKBOARD_MAX_IMAGE_BYTES} byte limit.`
      }
    }
    const mimeType = sniffImageMime(image.buffer)
    if (!isTranscriptRasterImageMime(mimeType)) {
      return {
        ok: false,
        code: 'blackboard_image_unsupported',
        error: `Blackboard image ${index + 1} is not a supported raster image.`
      }
    }
    const sha256 = sha256Base64Url(image.buffer)
    if (seen.has(sha256)) continue
    seen.add(sha256)
    const thumbnail = createBoundedThumbnail(image, mimeType!, thumbnailer)
    if (!thumbnail) {
      return {
        ok: false,
        code: 'blackboard_image_thumbnail_failed',
        error: `Blackboard image ${index + 1} could not be decoded into a bounded preview.`
      }
    }
    prepared.push({
      buffer: image.buffer,
      mimeType: mimeType!,
      name: safeImageName(image.name, index),
      sha256,
      thumbnail
    })
  }
  const written = input.store.writeOwnedMany(
    prepared.map((image) => ({
      sha256: image.sha256,
      mimeType: image.mimeType,
      buffer: image.buffer,
      appChatId: input.appChatId
    }))
  )
  if (!written.ok) {
    return {
      ok: false,
      code: 'blackboard_image_persistence_failed',
      error: `Blackboard image persistence failed: ${written.reason}.`
    }
  }
  const entryId = boundedString(input.entryId, 160) || 'entry'
  return {
    ok: true,
    mediaRefs: prepared.map((image, index) => ({
      id: `blackboard:${entryId}:image:${index}:${image.sha256.slice(0, 12)}`,
      kind: 'image',
      format: 'raster',
      source: 'upload',
      name: image.name,
      mimeType: image.mimeType,
      byteLength: image.buffer.length,
      sha256: image.sha256,
      assetId: `blackboard-image:${image.sha256}`,
      thumbnail: image.thumbnail,
      status: 'available'
    }))
  }
}
