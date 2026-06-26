import { createHash } from 'crypto'
import fs from 'fs'
import path from 'path'
import type {
  ExternalPathGrant,
  TranscriptMediaRef,
  TranscriptMediaSource,
  TranscriptMediaThumbnail
} from '../store/types'

export const TRANSCRIPT_MEDIA_MAX_TOOL_IMAGE_BYTES = 8 * 1024 * 1024
export const TRANSCRIPT_MEDIA_MAX_WORKSPACE_IMAGE_BYTES = 12 * 1024 * 1024
export const TRANSCRIPT_MEDIA_MAX_REFS_PER_MESSAGE = 8
/**
 * Absolute ceiling on a per-call `maxRefs` override. A caller (the trusted main-side
 * dispatch seam) may raise the per-message ref cap above the default 8 (e.g. a 24-frame
 * inspect_video_frames filmstrip), but the override is HARD-clamped to this ceiling so a
 * forged/oversized hint can't make one message emit an unbounded number of refs.
 */
export const TRANSCRIPT_MEDIA_MAX_REFS_CEILING = 32

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

export interface TranscriptMediaAssetWriter {
  (input: {
    assetId: string
    sha256: string
    buffer: Buffer
    mimeType: string
    source: Extract<TranscriptMediaSource, 'generated' | 'tool_result'>
  }): void
}

export interface CreateToolResultMediaRefsOptions {
  messageId: string
  runId?: string
  toolName?: string
  blocks: readonly unknown[]
  source?: Extract<TranscriptMediaSource, 'generated' | 'tool_result'>
  namePrefix?: string
  thumbnailer?: TranscriptMediaThumbnailer
  assetWriter?: TranscriptMediaAssetWriter
  maxBytes?: number
  maxRefs?: number
  /**
   * Optional per-image-block presentation hints from the (trusted, main-side) tool
   * result. `labels[i]` becomes the `caption` of the ref built from the i-th image block
   * (in `blocks` order); `groupKind` is stamped onto every produced ref so the renderer
   * can group a contiguous run (e.g. `video_frames` → an NLE filmstrip). `maxRefs` is a
   * convenience mirror of the top-level `maxRefs` (the dispatch seam passes the hint here);
   * when both are set the top-level one wins. Cosmetic only.
   */
  hints?: { groupKind?: string; labels?: string[]; maxRefs?: number }
}

export interface CreateWorkspacePathMediaRefsOptions {
  messageId: string
  content: string
  workspaceId?: string
  workspacePath: string
  externalPathGrants?: readonly ExternalPathGrant[]
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

type MarkdownImageCandidate = {
  alt?: string
  path: string
}

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

/**
 * Merge two media-ref lists, de-duplicating by content/identity key
 * (sha256 → assetId → id). Used to accumulate refs onto a message both in the
 * single-chat path (index.ts) and the ensemble path (EnsembleOrchestrator), so
 * a re-emitted/re-flushed ref never doubles up.
 */
export function mergeTranscriptMediaRefs(
  existing: readonly TranscriptMediaRef[] | undefined,
  incoming: readonly TranscriptMediaRef[]
): TranscriptMediaRef[] {
  const refs: TranscriptMediaRef[] = []
  const seen = new Set<string>()
  for (const ref of [...(existing || []), ...incoming]) {
    const key = ref.sha256 || ref.assetId || ref.id
    if (!key || seen.has(key)) continue
    seen.add(key)
    refs.push(ref)
  }
  return refs
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

function imageBlockFromProviderUnknown(value: unknown): McpImageContentBlock | null {
  const direct = imageBlockFromUnknown(value)
  if (direct) return direct
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const source = record.source
  if (record.type === 'image' && source && typeof source === 'object' && !Array.isArray(source)) {
    const sourceRecord = source as Record<string, unknown>
    const mimeType = normalizedMimeType(sourceRecord.media_type ?? sourceRecord.mimeType)
    const data = typeof sourceRecord.data === 'string' ? sourceRecord.data.trim() : ''
    if ((sourceRecord.type === undefined || sourceRecord.type === 'base64') && mimeType && data) {
      return { type: 'image', mimeType, data }
    }
  }
  const inlineData = record.inlineData ?? record.inline_data
  if (inlineData && typeof inlineData === 'object' && !Array.isArray(inlineData)) {
    const inlineRecord = inlineData as Record<string, unknown>
    const mimeType = normalizedMimeType(inlineRecord.mimeType ?? inlineRecord.mime_type)
    const data = typeof inlineRecord.data === 'string' ? inlineRecord.data.trim() : ''
    if (mimeType && data) return { type: 'image', mimeType, data }
  }
  const imageUrl = record.image_url ?? record.imageUrl
  const url =
    typeof imageUrl === 'string'
      ? imageUrl
      : imageUrl && typeof imageUrl === 'object' && !Array.isArray(imageUrl)
        ? (imageUrl as Record<string, unknown>).url
        : undefined
  if (typeof url === 'string') {
    return imageBlockFromDataUrl(url)
  }
  return null
}

function imageBlockFromDataUrl(value: string): McpImageContentBlock | null {
  const match = value.trim().match(/^data:([^;,]+);base64,(.+)$/i)
  if (!match) return null
  const mimeType = normalizedMimeType(match[1])
  const data = match[2].trim()
  if (!mimeType || !data) return null
  return { type: 'image', mimeType, data }
}

function parseJsonObjectLike(value: unknown): unknown {
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) return value
  try {
    return JSON.parse(trimmed)
  } catch {
    return value
  }
}

function blankMarkdownCodeRanges(value: string): string {
  const chars = value.split('')
  const lines = value.match(/[^\n]*(?:\n|$)/g) || []
  let offset = 0
  let inFence = false
  for (const line of lines) {
    if (!line) continue
    const fenceMatch = line.match(/^\s*(```|~~~)/)
    if (inFence || fenceMatch) {
      for (let i = offset; i < offset + line.length; i += 1) chars[i] = ' '
      if (fenceMatch) inFence = !inFence
      offset += line.length
      continue
    }
    for (const match of line.matchAll(/`[^`\n]*`/g)) {
      const start = offset + (match.index ?? 0)
      for (let i = start; i < start + match[0].length; i += 1) chars[i] = ' '
    }
    offset += line.length
  }
  return chars.join('')
}

function markdownDestinationFromRaw(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return ''
  if (trimmed.startsWith('<')) {
    const end = trimmed.indexOf('>')
    return end > 1 ? trimmed.slice(1, end).trim() : ''
  }
  const quote = trimmed[0]
  if (quote === '"' || quote === "'") return ''
  const match = trimmed.match(/^(\S+)/)
  return match?.[1]?.trim() || ''
}

function isLocalMarkdownImagePath(value: string): boolean {
  if (!value || value.includes('\0')) return false
  if (/^(https?|data|blob|javascript|mailto):/i.test(value)) return false
  const scheme = value.match(/^([a-z][a-z0-9+.-]*):/i)?.[1]?.toLowerCase()
  return !scheme || scheme === 'file'
}

export function extractMarkdownImagePathCandidates(content: string): MarkdownImageCandidate[] {
  if (!content || !content.includes('![')) return []
  const scan = blankMarkdownCodeRanges(content)
  const candidates: MarkdownImageCandidate[] = []
  const seen = new Set<string>()
  const imagePattern = /!\[([^\]\n]{0,240})\]\(([^)\n]{1,2048})\)/g
  let match: RegExpExecArray | null
  while ((match = imagePattern.exec(scan)) !== null) {
    const candidatePath = markdownDestinationFromRaw(match[2] || '')
    if (!isLocalMarkdownImagePath(candidatePath)) continue
    const key = candidatePath
    if (seen.has(key)) continue
    seen.add(key)
    const alt = (match[1] || '').trim()
    candidates.push({
      path: candidatePath,
      ...(alt ? { alt } : {})
    })
    if (candidates.length >= TRANSCRIPT_MEDIA_MAX_REFS_PER_MESSAGE) break
  }
  return candidates
}

export function extractMcpImageBlocksFromRawResult(raw: unknown): McpImageContentBlock[] {
  const parsed = parseJsonObjectLike(raw)
  const blocks: McpImageContentBlock[] = []
  const visit = (node: unknown): void => {
    const parsedNode = parseJsonObjectLike(node)
    if (!parsedNode || typeof parsedNode !== 'object') return
    if (Array.isArray(parsedNode)) {
      parsedNode.forEach(visit)
      return
    }
    const block = imageBlockFromUnknown(parsedNode)
    if (block) {
      blocks.push(block)
      return
    }
    const record = parsedNode as Record<string, unknown>
    for (const key of ['content', 'result', 'output']) {
      visit(record[key])
    }
  }
  visit(parsed)
  const seen = new Set<string>()
  return blocks.filter((block) => {
    const key = `${block.mimeType}:${block.data.length}:${block.data.slice(0, 48)}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function extractProviderImageBlocksFromRawEvent(raw: unknown): McpImageContentBlock[] {
  const parsed = parseJsonObjectLike(raw)
  const blocks: McpImageContentBlock[] = []
  const seenObjects = new Set<unknown>()
  const visit = (node: unknown, depth: number): void => {
    if (blocks.length >= TRANSCRIPT_MEDIA_MAX_REFS_PER_MESSAGE || depth > 10) return
    const parsedNode = parseJsonObjectLike(node)
    if (!parsedNode || typeof parsedNode !== 'object') return
    if (seenObjects.has(parsedNode)) return
    seenObjects.add(parsedNode)
    if (Array.isArray(parsedNode)) {
      parsedNode.forEach((entry) => visit(entry, depth + 1))
      return
    }
    const block = imageBlockFromProviderUnknown(parsedNode)
    if (block) {
      blocks.push(block)
      return
    }
    const record = parsedNode as Record<string, unknown>
    for (const key of ['content', 'parts', 'message', 'delta', 'candidate', 'candidates']) {
      visit(record[key], depth + 1)
    }
  }
  visit(parsed, 0)
  const seen = new Set<string>()
  return blocks.filter((block) => {
    const key = `${block.mimeType}:${block.data.length}:${block.data.slice(0, 48)}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
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
  source = 'tool_result',
  namePrefix,
  thumbnailer = defaultTranscriptMediaThumbnailer,
  assetWriter,
  maxBytes = TRANSCRIPT_MEDIA_MAX_TOOL_IMAGE_BYTES,
  maxRefs,
  hints
}: CreateToolResultMediaRefsOptions): TranscriptMediaRef[] {
  // Resolve the effective per-message cap. The top-level `maxRefs` is primary; the
  // `hints.maxRefs` mirror only applies when no top-level value was passed. A non-finite
  // / < 1 value falls back to the default (8), and the result is HARD-clamped to
  // TRANSCRIPT_MEDIA_MAX_REFS_CEILING (32) so a forged main-side hint can't blow up the
  // ref count. Every non-filmstrip path passes no override → 8. (Note: NOT a destructure
  // default — that would swallow the "was it explicitly passed?" signal the mirror needs.)
  const overrideMaxRefs = maxRefs ?? hints?.maxRefs
  const requestedMaxRefs =
    typeof overrideMaxRefs === 'number' && Number.isFinite(overrideMaxRefs) && overrideMaxRefs >= 1
      ? Math.floor(overrideMaxRefs)
      : TRANSCRIPT_MEDIA_MAX_REFS_PER_MESSAGE
  const effectiveMaxRefs = Math.min(requestedMaxRefs, TRANSCRIPT_MEDIA_MAX_REFS_CEILING)
  const refs: TranscriptMediaRef[] = []
  const sourceSegment = source === 'generated' ? 'generated-image' : 'tool-image'
  // `groupKind` (when present) is stamped on every produced ref; `labels` align to the
  // image blocks in `blocks` order (blockIndex), NOT to refs.length — so a label still
  // maps to its block even if an earlier block was skipped (non-image) without producing
  // a ref. A non-string / empty label is simply omitted (no caption).
  const groupKind =
    typeof hints?.groupKind === 'string' && hints.groupKind ? hints.groupKind : undefined
  const labelAt = (i: number): string | undefined => {
    const label = hints?.labels?.[i]
    return typeof label === 'string' && label.length > 0 ? label : undefined
  }
  let blockIndex = -1
  for (const rawBlock of blocks) {
    if (refs.length >= effectiveMaxRefs) break
    const block = imageBlockFromUnknown(rawBlock)
    if (!block) continue
    blockIndex += 1
    const caption = labelAt(blockIndex)
    const decoded = decodedImageBlock(block, maxBytes)
    const index = refs.length + 1
    if ('error' in decoded) {
      refs.push({
        id: `${messageId}:${sourceSegment}:${index}`,
        kind: 'image',
        format: isTranscriptSvgMime(block.mimeType) ? 'svg' : 'raster',
        source,
        name:
          namePrefix ||
          (toolName
            ? `${toolName} image ${index}`
            : source === 'generated'
              ? `Generated image ${index}`
              : `Tool result image ${index}`),
        mimeType: normalizedMimeType(block.mimeType) || 'application/octet-stream',
        status: decoded.error,
        ...(caption ? { caption } : {}),
        ...(groupKind ? { groupKind } : {})
      })
      continue
    }
    const hash = sha256Base64Url(decoded.buffer)
    const thumbnail =
      thumbnailer({ buffer: decoded.buffer, mimeType: decoded.mimeType, maxEdge: 512 }) ??
      (isTranscriptThumbnailMime(decoded.mimeType) && decoded.buffer.length <= 180_000
        ? {
            dataBase64: decoded.buffer.toString('base64'),
            mimeType: decoded.mimeType
          }
        : undefined)
    const assetId = runId ? `run:${runId}:${sourceSegment}:${hash}` : `${sourceSegment}:${hash}`
    try {
      assetWriter?.({
        assetId,
        sha256: hash,
        buffer: decoded.buffer,
        mimeType: decoded.mimeType,
        source
      })
    } catch {
      // Full-size persistence is best-effort; bounded thumbnails remain safe.
    }
    refs.push({
      id: `${messageId}:${sourceSegment}:${hash.slice(0, 16)}`,
      kind: 'image',
      format: 'raster',
      source,
      name:
        namePrefix ||
        (toolName
          ? `${toolName} image ${index}`
          : source === 'generated'
            ? `Generated image ${index}`
            : `Tool result image ${index}`),
      mimeType: decoded.mimeType,
      byteLength: decoded.buffer.length,
      sha256: hash,
      assetId,
      thumbnail,
      status: 'available',
      ...(caption ? { caption } : {}),
      ...(groupKind ? { groupKind } : {})
    })
  }
  return refs
}

function workspaceValidationStatus(
  reason: Exclude<WorkspaceImageValidationResult, { ok: true }>['reason']
): TranscriptMediaRef['status'] {
  switch (reason) {
    case 'unsafe_svg':
      return 'unsafe_svg'
    case 'too_large':
      return 'too_large'
    case 'missing':
    case 'not_file':
      return 'missing'
    case 'unsupported':
      return 'unsupported'
    default:
      return 'denied'
  }
}

export function createWorkspacePathMediaRefs({
  messageId,
  content,
  workspaceId,
  workspacePath,
  externalPathGrants = [],
  thumbnailer = defaultTranscriptMediaThumbnailer,
  maxBytes = TRANSCRIPT_MEDIA_MAX_WORKSPACE_IMAGE_BYTES,
  maxRefs = TRANSCRIPT_MEDIA_MAX_REFS_PER_MESSAGE
}: CreateWorkspacePathMediaRefsOptions): TranscriptMediaRef[] {
  const refs: TranscriptMediaRef[] = []
  const candidates = extractMarkdownImagePathCandidates(content)
  for (const candidate of candidates) {
    if (refs.length >= maxRefs) break
    const index = refs.length + 1
    const validation = validateWorkspaceImagePath({
      workspaceId,
      workspacePath,
      candidatePath: candidate.path,
      externalPathGrants,
      maxBytes
    })
    const fallbackIdHash = sha256Base64Url(Buffer.from(`${candidate.path}:${index}`))
    const name = path.basename(candidate.path.replace(/\/+$/, '')) || `Image ${index}`
    if (!validation.ok) {
      refs.push({
        id: `${messageId}:workspace-image:${fallbackIdHash.slice(0, 16)}`,
        kind: 'image',
        format: validation.reason === 'unsafe_svg' ? 'svg' : 'raster',
        source: 'workspace_path',
        name,
        ...(candidate.alt ? { alt: candidate.alt } : {}),
        mimeType:
          validation.reason === 'unsafe_svg' ? 'image/svg+xml' : 'application/octet-stream',
        status: workspaceValidationStatus(validation.reason)
      })
      continue
    }

    let thumbnail: TranscriptMediaThumbnail | undefined
    try {
      const buffer = fs.readFileSync(validation.realPath)
      thumbnail =
        thumbnailer({ buffer, mimeType: validation.mimeType, maxEdge: 512 }) ??
        (isTranscriptThumbnailMime(validation.mimeType) && buffer.length <= 180_000
          ? {
              dataBase64: buffer.toString('base64'),
              mimeType: validation.mimeType
            }
          : undefined)
    } catch {
      // The file passed validation but disappeared before thumbnailing.
    }

    refs.push({
      id: `${messageId}:workspace-image:${validation.sha256.slice(0, 16)}`,
      kind: 'image',
      format: 'raster',
      source: 'workspace_path',
      name,
      ...(candidate.alt ? { alt: candidate.alt } : {}),
      mimeType: validation.mimeType,
      byteLength: validation.byteLength,
      sha256: validation.sha256,
      path: validation.realPath,
      ...(workspaceId ? { workspaceId } : {}),
      ...(validation.workspaceRelativePath
        ? { workspaceRelativePath: validation.workspaceRelativePath }
        : {}),
      thumbnail,
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

const AUDIO_SOURCE_MIME_TYPES = new Set([
  'audio/wav',
  'audio/mpeg',
  'audio/mp4',
  'audio/ogg',
  'audio/flac'
])

/** Generous cap on a decodable audio SOURCE. The tool OUTPUT (a waveform PNG) is
 * small; this bounds the input we read + base64-inject into the offscreen
 * decoder. ~20MB ≈ ~20 min MP3 / ~2 min 44.1k stereo WAV. */
export const TRANSCRIPT_MEDIA_MAX_AUDIO_BYTES = 20 * 1024 * 1024

export function isTranscriptAudioMime(mime: string | null | undefined): boolean {
  return !!mime && AUDIO_SOURCE_MIME_TYPES.has(mime)
}

/** Magic-byte sniff for the audio containers Chromium's decodeAudioData accepts.
 * Used to (a) reject a non-audio source path and (b) report the container in the
 * analysis meta. Mirrors sniffImageMime's style. */
export function sniffAudioMime(buffer: Buffer): string | null {
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WAVE'
  ) {
    return 'audio/wav'
  }
  if (buffer.length >= 4 && buffer.subarray(0, 4).toString('ascii') === 'fLaC') {
    return 'audio/flac'
  }
  if (buffer.length >= 4 && buffer.subarray(0, 4).toString('ascii') === 'OggS') {
    return 'audio/ogg'
  }
  // MP4/M4A: 'ftyp' box at offset 4.
  if (buffer.length >= 12 && buffer.subarray(4, 8).toString('ascii') === 'ftyp') {
    return 'audio/mp4'
  }
  // MP3 with an ID3v2 tag.
  if (buffer.length >= 3 && buffer.subarray(0, 3).toString('ascii') === 'ID3') {
    return 'audio/mpeg'
  }
  // Bare MPEG/AAC frame sync (0xFFEx) — MP3 without a tag, or ADTS AAC.
  if (buffer.length >= 2 && buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) {
    return 'audio/mpeg'
  }
  return null
}

export interface WorkspaceAudioValidationOptions {
  workspacePath: string
  candidatePath: string
  externalPathGrants?: { path: string }[]
  maxBytes?: number
}
export type WorkspaceAudioValidationResult =
  | {
      ok: true
      realPath: string
      workspaceRelativePath?: string
      mimeType: string
      byteLength: number
      dataBase64: string
    }
  | {
      ok: false
      reason: 'invalid_path' | 'missing' | 'not_file' | 'too_large' | 'outside_allowed_roots' | 'unsupported'
    }

/** Realpath-jailed, grant-aware, size-capped resolution of a workspace AUDIO
 * file — the audio twin of validateWorkspaceImagePath, reusing the identical
 * security primitives (decodeFileUrl, realpath jail, root membership), only the
 * mime sniff differs (audio containers, not raster). Returns the bytes base64'd
 * so the offscreen decoder can ingest them. */
export function validateWorkspaceAudioPath({
  workspacePath,
  candidatePath,
  externalPathGrants = [],
  maxBytes = TRANSCRIPT_MEDIA_MAX_AUDIO_BYTES
}: WorkspaceAudioValidationOptions): WorkspaceAudioValidationResult {
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
  const sniffed = sniffAudioMime(buffer)
  if (!sniffed) return { ok: false, reason: 'unsupported' }
  const realWorkspace = realpathOrNull(workspacePath)
  const workspaceRelativePath =
    realWorkspace && pathWithinRoot(realCandidate, realWorkspace)
      ? path.relative(realWorkspace, realCandidate)
      : undefined
  return {
    ok: true,
    realPath: realCandidate,
    ...(workspaceRelativePath ? { workspaceRelativePath } : {}),
    mimeType: sniffed,
    byteLength: buffer.length,
    dataBase64: buffer.toString('base64')
  }
}

const VIDEO_SOURCE_MIME_TYPES = new Set([
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'video/x-msvideo'
])

/** Generous cap for an ffmpeg INPUT file. It's read by PATH (never loaded into
 * memory), so this bounds how large a file we'll hand to ffmpeg/ffprobe. */
export const TRANSCRIPT_MEDIA_MAX_INPUT_BYTES = 1024 * 1024 * 1024

/** Coarse magic-byte sniff for common video containers — "is this plausibly a
 * video file" for the ffmpeg input jail. ffprobe gives the authoritative stream
 * info; this only rejects obvious non-media before we exec a subprocess. */
export function sniffVideoMime(buffer: Buffer): string | null {
  if (buffer.length >= 12 && buffer.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brand = buffer.subarray(8, 12).toString('ascii')
    return brand.startsWith('qt') ? 'video/quicktime' : 'video/mp4'
  }
  // EBML (Matroska / WebM).
  if (buffer.length >= 4 && buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) {
    return 'video/webm'
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'AVI '
  ) {
    return 'video/x-msvideo'
  }
  return null
}

export function isTranscriptVideoMime(mime: string | null | undefined): boolean {
  return !!mime && VIDEO_SOURCE_MIME_TYPES.has(mime)
}

export type WorkspaceMediaValidationResult =
  | { ok: true; realPath: string; mimeType: string; byteLength: number }
  | {
      ok: false
      reason: 'invalid_path' | 'missing' | 'not_file' | 'too_large' | 'outside_allowed_roots' | 'unsupported'
    }

/** Realpath-jailed, size-capped resolution of a workspace AUDIO or VIDEO file for
 * ffmpeg/ffprobe INPUT. Reuses the exact jail primitives as the audio/image
 * validators, but does NOT read the whole file (a video can be gigabytes) — only
 * the 64-byte header for a coarse media sniff — and returns the realPath (ffmpeg
 * opens it by path), never the bytes. */
export function validateWorkspaceMediaPath({
  workspacePath,
  candidatePath,
  externalPathGrants = [],
  maxBytes = TRANSCRIPT_MEDIA_MAX_INPUT_BYTES
}: WorkspaceAudioValidationOptions): WorkspaceMediaValidationResult {
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

  const header = Buffer.alloc(64)
  try {
    const fd = fs.openSync(realCandidate, 'r')
    try {
      fs.readSync(fd, header, 0, 64, 0)
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return { ok: false, reason: 'missing' }
  }
  const sniffed = sniffAudioMime(header) || sniffVideoMime(header)
  if (!sniffed) return { ok: false, reason: 'unsupported' }
  return { ok: true, realPath: realCandidate, mimeType: sniffed, byteLength: stat.size }
}
