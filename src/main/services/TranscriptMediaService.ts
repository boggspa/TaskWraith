import { createHash } from 'crypto'
import fs from 'fs'
import path from 'path'
import type {
  ExternalPathGrant,
  TranscriptMediaRef,
  TranscriptMediaThumbnail
} from '../store/types'

export const TRANSCRIPT_MEDIA_MAX_TOOL_IMAGE_BYTES = 8 * 1024 * 1024
export const TRANSCRIPT_MEDIA_MAX_WORKSPACE_IMAGE_BYTES = 12 * 1024 * 1024
export const TRANSCRIPT_MEDIA_MAX_REFS_PER_MESSAGE = 8

const RASTER_IMAGE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/gif',
  'image/bmp'
])

const THUMBNAIL_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp'])

export interface McpImageContentBlock {
  type: 'image'
  mimeType: string
  data: string
}

export interface TranscriptMediaThumbnailer {
  (input: { buffer: Buffer; mimeType: string; maxEdge: number }): TranscriptMediaThumbnail | null
}

export interface CreateToolResultMediaRefsOptions {
  messageId: string
  runId?: string
  toolName?: string
  blocks: readonly unknown[]
  thumbnailer?: TranscriptMediaThumbnailer
  maxBytes?: number
  maxRefs?: number
}

export interface WorkspaceImageValidationOptions {
  workspaceId?: string
  workspacePath: string
  candidatePath: string
  externalPathGrants?: readonly ExternalPathGrant[]
  maxBytes?: number
}

export type WorkspaceImageValidationResult =
  | {
      ok: true
      realPath: string
      workspaceRelativePath?: string
      mimeType: string
      byteLength: number
      sha256: string
    }
  | { ok: false; reason: 'invalid_path' | 'outside_allowed_roots' | 'missing' | 'not_file' | 'too_large' | 'unsupported' | 'unsafe_svg' }

function normalizedMimeType(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

export function isTranscriptRasterImageMime(value: unknown): boolean {
  const mime = normalizedMimeType(value)
  return RASTER_IMAGE_MIME_TYPES.has(mime)
}

export function isTranscriptThumbnailMime(value: unknown): boolean {
  const mime = normalizedMimeType(value)
  return THUMBNAIL_MIME_TYPES.has(mime)
}

export function isTranscriptSvgMime(value: unknown): boolean {
  const mime = normalizedMimeType(value)
  return mime === 'image/svg+xml' || mime === 'image/svg'
}

export function sha256Base64Url(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('base64url')
}

export function sniffImageMime(buffer: Buffer): string | null {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
    return 'image/png'
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg'
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp'
  }
  if (
    buffer.length >= 6 &&
    (buffer.subarray(0, 6).toString('ascii') === 'GIF87a' ||
      buffer.subarray(0, 6).toString('ascii') === 'GIF89a')
  ) {
    return 'image/gif'
  }
  if (buffer.length >= 2 && buffer.subarray(0, 2).toString('ascii') === 'BM') {
    return 'image/bmp'
  }
  const head = buffer.subarray(0, Math.min(buffer.length, 512)).toString('utf8').toLowerCase()
  if (head.includes('<svg') || head.includes('<!doctype svg') || head.includes('<?xml')) {
    return 'image/svg+xml'
  }
  return null
}

export function defaultTranscriptMediaThumbnailer({
  buffer,
  maxEdge
}: {
  buffer: Buffer
  mimeType: string
  maxEdge: number
}): TranscriptMediaThumbnail | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { nativeImage } = require('electron')
    if (!nativeImage) return null
    const image = nativeImage.createFromBuffer(buffer)
    if (image.isEmpty()) return null
    const { width, height } = image.getSize()
    if (!width || !height) return null
    const longest = Math.max(width, height)
    const scale = longest > maxEdge ? maxEdge / longest : 1
    const resized =
      scale < 1
        ? image.resize({
            width: Math.max(1, Math.round(width * scale)),
            height: Math.max(1, Math.round(height * scale)),
            quality: 'good'
          })
        : image
    let quality = 75
    let jpeg = resized.toJPEG(quality)
    while (jpeg.length > 80_000 && quality > 30) {
      quality -= 15
      jpeg = resized.toJPEG(quality)
    }
    if (!jpeg.length) return null
    const { width: thumbWidth, height: thumbHeight } = resized.getSize()
    return {
      dataBase64: jpeg.toString('base64'),
      mimeType: 'image/jpeg',
      width: thumbWidth,
      height: thumbHeight
    }
  } catch {
    return null
  }
}

function imageBlockFromUnknown(value: unknown): McpImageContentBlock | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const mimeType = normalizedMimeType(record.mimeType ?? record.mime_type)
  const data = typeof record.data === 'string' ? record.data.trim() : ''
  if (record.type !== 'image' || !mimeType || !data) return null
  return { type: 'image', mimeType, data }
}

function decodedImageBlock(
  block: McpImageContentBlock,
  maxBytes: number
): { buffer: Buffer; mimeType: string } | { error: 'too_large' | 'unsupported' | 'unsafe_svg' } {
  if (isTranscriptSvgMime(block.mimeType)) return { error: 'unsafe_svg' }
  if (!isTranscriptRasterImageMime(block.mimeType)) return { error: 'unsupported' }
  let buffer: Buffer
  try {
    buffer = Buffer.from(block.data, 'base64')
  } catch {
    return { error: 'unsupported' }
  }
  if (!buffer.length || buffer.length > maxBytes) return { error: 'too_large' }
  const sniffed = sniffImageMime(buffer)
  if (isTranscriptSvgMime(sniffed)) return { error: 'unsafe_svg' }
  if (!isTranscriptRasterImageMime(sniffed)) return { error: 'unsupported' }
  return { buffer, mimeType: sniffed || normalizedMimeType(block.mimeType) }
}

export function createToolResultMediaRefs({
  messageId,
  runId,
  toolName,
  blocks,
  thumbnailer = defaultTranscriptMediaThumbnailer,
  maxBytes = TRANSCRIPT_MEDIA_MAX_TOOL_IMAGE_BYTES,
  maxRefs = TRANSCRIPT_MEDIA_MAX_REFS_PER_MESSAGE
}: CreateToolResultMediaRefsOptions): TranscriptMediaRef[] {
  const refs: TranscriptMediaRef[] = []
  for (const rawBlock of blocks) {
    if (refs.length >= maxRefs) break
    const block = imageBlockFromUnknown(rawBlock)
    if (!block) continue
    const decoded = decodedImageBlock(block, maxBytes)
    const index = refs.length + 1
    if ('error' in decoded) {
      refs.push({
        id: `${messageId}:tool-image:${index}`,
        kind: 'image',
        format: isTranscriptSvgMime(block.mimeType) ? 'svg' : 'raster',
        source: 'tool_result',
        name: toolName ? `${toolName} image ${index}` : `Tool result image ${index}`,
        mimeType: normalizedMimeType(block.mimeType) || 'application/octet-stream',
        status: decoded.error
      })
      continue
    }
    const hash = sha256Base64Url(decoded.buffer)
    refs.push({
      id: `${messageId}:tool-image:${hash.slice(0, 16)}`,
      kind: 'image',
      format: 'raster',
      source: 'tool_result',
      name: toolName ? `${toolName} image ${index}` : `Tool result image ${index}`,
      mimeType: decoded.mimeType,
      byteLength: decoded.buffer.length,
      sha256: hash,
      assetId: runId ? `run:${runId}:tool-image:${hash}` : `tool-image:${hash}`,
      thumbnail: thumbnailer({ buffer: decoded.buffer, mimeType: decoded.mimeType, maxEdge: 512 }) ?? undefined,
      status: 'available'
    })
  }
  return refs
}

function decodeFileUrl(value: string): string {
  if (!/^file:\/\//i.test(value)) return value
  try {
    return decodeURIComponent(new URL(value).pathname)
  } catch {
    return ''
  }
}

function pathWithinRoot(realPath: string, realRoot: string): boolean {
  const rel = path.relative(realRoot, realPath)
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel))
}

function realpathOrNull(value: string): string | null {
  try {
    return fs.realpathSync.native(value)
  } catch {
    try {
      return fs.realpathSync(value)
    } catch {
      return null
    }
  }
}

export function validateWorkspaceImagePath({
  workspacePath,
  candidatePath,
  externalPathGrants = [],
  maxBytes = TRANSCRIPT_MEDIA_MAX_WORKSPACE_IMAGE_BYTES
}: WorkspaceImageValidationOptions): WorkspaceImageValidationResult {
  const decoded = decodeFileUrl(candidatePath.trim())
  if (!decoded || decoded.includes('\0') || /^https?:\/\//i.test(decoded)) {
    return { ok: false, reason: 'invalid_path' }
  }
  const absoluteCandidate = path.isAbsolute(decoded) ? decoded : path.resolve(workspacePath, decoded)
  const realCandidate = realpathOrNull(absoluteCandidate)
  if (!realCandidate) return { ok: false, reason: 'missing' }

  const roots = [workspacePath, ...externalPathGrants.map((grant) => grant.path)].filter(Boolean)
  const realRoots = roots.map((root) => realpathOrNull(root)).filter((root): root is string => !!root)
  if (!realRoots.some((root) => pathWithinRoot(realCandidate, root))) {
    return { ok: false, reason: 'outside_allowed_roots' }
  }

  let stat: fs.Stats
  try {
    stat = fs.statSync(realCandidate)
  } catch {
    return { ok: false, reason: 'missing' }
  }
  if (!stat.isFile()) return { ok: false, reason: 'not_file' }
  if (stat.size <= 0 || stat.size > maxBytes) return { ok: false, reason: 'too_large' }

  let buffer: Buffer
  try {
    buffer = fs.readFileSync(realCandidate)
  } catch {
    return { ok: false, reason: 'missing' }
  }
  const sniffed = sniffImageMime(buffer)
  if (isTranscriptSvgMime(sniffed)) return { ok: false, reason: 'unsafe_svg' }
  if (!isTranscriptRasterImageMime(sniffed)) return { ok: false, reason: 'unsupported' }
  const realWorkspace = realpathOrNull(workspacePath)
  const workspaceRelativePath =
    realWorkspace && pathWithinRoot(realCandidate, realWorkspace)
      ? path.relative(realWorkspace, realCandidate)
      : undefined
  return {
    ok: true,
    realPath: realCandidate,
    ...(workspaceRelativePath ? { workspaceRelativePath } : {}),
    mimeType: sniffed || 'image/png',
    byteLength: buffer.length,
    sha256: sha256Base64Url(buffer)
  }
}
