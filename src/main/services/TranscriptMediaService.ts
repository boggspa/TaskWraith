import { createHash, randomUUID } from 'crypto'
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
export const TRANSCRIPT_MEDIA_MAX_PDF_BYTES = 80 * 1024 * 1024
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
  /** Exact realpaths authorized by a renderer-local OS file capability. */
  authorizedFilePaths?: readonly string[]
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
      /**
       * The exact bytes read from the already-authorized, nofollow-opened file
       * descriptor. Consumers must use this snapshot instead of reopening
       * `realPath`, which would reintroduce a validation-to-use race.
       */
      buffer: Buffer
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

export function sniffPdfMime(buffer: Buffer): 'application/pdf' | null {
  // ISO 32000 permits the header to occur within the first 1024 bytes. Keep
  // this bounded so a misleading extension can never classify arbitrary data
  // as a durable PDF attachment.
  return buffer.subarray(0, Math.min(buffer.length, 1024)).includes(Buffer.from('%PDF-'))
    ? 'application/pdf'
    : null
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

    const thumbnail =
      thumbnailer({ buffer: validation.buffer, mimeType: validation.mimeType, maxEdge: 512 }) ??
      (isTranscriptThumbnailMime(validation.mimeType) && validation.buffer.length <= 180_000
        ? {
            dataBase64: validation.buffer.toString('base64'),
            mimeType: validation.mimeType
          }
        : undefined)

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

function externalGrantCoversRealPath(
  grant: ExternalPathGrant,
  realCandidate: string
): boolean {
  if (!path.isAbsolute(grant.path)) return false
  const signedRoot = path.resolve(grant.path)
  try {
    const rootStat = fs.lstatSync(signedRoot)
    if (rootStat.isSymbolicLink()) return false
    if (grant.kind === 'file') {
      return rootStat.isFile() && realCandidate === signedRoot
    }
    return rootStat.isDirectory() && pathWithinRoot(realCandidate, signedRoot)
  } catch {
    return false
  }
}

function pathAllowedByWorkspaceOrExternalGrant(
  workspacePath: string | undefined,
  realCandidate: string,
  externalPathGrants: readonly ExternalPathGrant[],
  authorizedFilePaths: readonly string[] = []
): boolean {
  const realWorkspace = workspacePath ? realpathOrNull(workspacePath) : null
  if (realWorkspace && pathWithinRoot(realCandidate, realWorkspace)) return true
  if (externalPathGrants.some((grant) => externalGrantCoversRealPath(grant, realCandidate))) {
    return true
  }
  return authorizedFilePaths.some((authorizedPath) => {
    if (!path.isAbsolute(authorizedPath)) return false
    return realpathOrNull(authorizedPath) === realCandidate
  })
}

export type WorkspaceFileOpenReason =
  | 'invalid_path'
  | 'outside_allowed_roots'
  | 'missing'
  | 'not_file'
  | 'too_large'

export type OpenedWorkspaceFile =
  | {
      ok: true
      fd: number
      realPath: string
      stat: fs.Stats
      workspaceRelativePath?: string
    }
  | { ok: false; reason: WorkspaceFileOpenReason }

function sameFileIdentity(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function sameFileSnapshotVersion(left: fs.Stats, right: fs.Stats): boolean {
  return (
    sameFileIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  )
}

/**
 * Resolve, authorize, and open a workspace/grant-backed file as one bounded
 * operation. The descriptor is opened with O_NOFOLLOW and then checked against
 * the path's current lstat/realpath identity before it is returned. Callers own
 * the descriptor and must close it.
 *
 * Node does not expose a portable openat(2) directory walk. The post-open
 * identity checks are therefore important: if an attacker swaps the final path
 * or an ancestor while resolution is in flight, the opened inode must still be
 * the inode currently reached by the authorized candidate path. Once this
 * returns, consumers read/copy from the descriptor and never reopen the source
 * path, so later swaps cannot alter the consumed bytes.
 */
export function openAuthorizedWorkspaceFile({
  workspacePath,
  candidatePath,
  externalPathGrants,
  authorizedFilePaths = [],
  maxBytes
}: {
  workspacePath?: string
  candidatePath: string
  externalPathGrants: readonly ExternalPathGrant[]
  authorizedFilePaths?: readonly string[]
  maxBytes: number
}): OpenedWorkspaceFile {
  const decoded = decodeFileUrl(candidatePath.trim())
  if (!decoded || decoded.includes('\0') || /^https?:\/\//i.test(decoded)) {
    return { ok: false, reason: 'invalid_path' }
  }
  const absoluteCandidate = path.isAbsolute(decoded)
    ? decoded
    : workspacePath
      ? path.resolve(workspacePath, decoded)
      : ''
  if (!absoluteCandidate) return { ok: false, reason: 'invalid_path' }
  const initialRealPath = realpathOrNull(absoluteCandidate)
  if (!initialRealPath) return { ok: false, reason: 'missing' }
  if (
    !pathAllowedByWorkspaceOrExternalGrant(
      workspacePath,
      initialRealPath,
      externalPathGrants,
      authorizedFilePaths
    )
  ) {
    return { ok: false, reason: 'outside_allowed_roots' }
  }

  let initialLstat: fs.Stats
  try {
    initialLstat = fs.lstatSync(initialRealPath)
  } catch {
    return { ok: false, reason: 'missing' }
  }
  if (initialLstat.isSymbolicLink()) return { ok: false, reason: 'missing' }
  if (!initialLstat.isFile()) return { ok: false, reason: 'not_file' }
  if (initialLstat.size <= 0 || initialLstat.size > maxBytes) {
    return { ok: false, reason: 'too_large' }
  }

  let fd: number
  try {
    fd = fs.openSync(initialRealPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  } catch {
    return { ok: false, reason: 'missing' }
  }

  const fail = (reason: WorkspaceFileOpenReason): OpenedWorkspaceFile => {
    try {
      fs.closeSync(fd)
    } catch {
      // best-effort close on a rejected descriptor
    }
    return { ok: false, reason }
  }

  try {
    const descriptorStat = fs.fstatSync(fd)
    if (!descriptorStat.isFile()) return fail('not_file')
    if (descriptorStat.size <= 0 || descriptorStat.size > maxBytes) return fail('too_large')
    if (!sameFileIdentity(initialLstat, descriptorStat)) return fail('missing')

    // Re-resolve the original candidate after opening. This catches swaps of a
    // symlink candidate or one of its path components during the first lookup.
    const currentRealPath = realpathOrNull(absoluteCandidate)
    if (!currentRealPath) return fail('missing')
    if (
      !pathAllowedByWorkspaceOrExternalGrant(
        workspacePath,
        currentRealPath,
        externalPathGrants,
        authorizedFilePaths
      )
    ) {
      return fail('outside_allowed_roots')
    }
    if (currentRealPath !== initialRealPath) return fail('missing')

    const currentLstat = fs.lstatSync(currentRealPath)
    if (currentLstat.isSymbolicLink() || !currentLstat.isFile()) return fail('missing')
    if (!sameFileIdentity(currentLstat, descriptorStat)) return fail('missing')

    // One final resolution/identity pass closes the window between the first
    // post-open realpath and lstat checks. Later path swaps are harmless because
    // all consumption happens through `fd`.
    const finalRealPath = realpathOrNull(absoluteCandidate)
    if (finalRealPath !== currentRealPath) return fail('missing')
    const finalLstat = fs.lstatSync(finalRealPath)
    if (finalLstat.isSymbolicLink() || !sameFileIdentity(finalLstat, descriptorStat)) {
      return fail('missing')
    }

    const realWorkspace = workspacePath ? realpathOrNull(workspacePath) : null
    const workspaceRelativePath =
      realWorkspace && pathWithinRoot(finalRealPath, realWorkspace)
        ? path.relative(realWorkspace, finalRealPath)
        : undefined
    return {
      ok: true,
      fd,
      realPath: finalRealPath,
      stat: descriptorStat,
      ...(workspaceRelativePath ? { workspaceRelativePath } : {})
    }
  } catch {
    return fail('missing')
  }
}

export interface SnapshotRasterOrPdfAttachmentOptions {
  candidatePath: string
  /** Optional workspace root for a workspace-relative or workspace-owned file. */
  workspacePath?: string
  externalPathGrants?: readonly ExternalPathGrant[]
  /**
   * Exact paths authorized by a main-owned picker/attachment registry. This is
   * the global-chat authority seam: callers must not populate it from renderer
   * input alone.
   */
  authorizedFilePaths?: readonly string[]
  maxBytes?: number
}

export type RasterOrPdfAttachmentSnapshotResult =
  | {
      ok: true
      sourceRealPath: string
      mimeType: string
      byteLength: number
      sha256: string
      buffer: Buffer
    }
  | {
      ok: false
      reason: WorkspaceFileOpenReason | 'unsupported' | 'unsafe_svg'
    }

/**
 * Capture the exact raster/PDF bytes selected for a durable queue or schedule.
 * Resolution, authority, O_NOFOLLOW open, inode checks, bounded read, MIME
 * sniffing, and hashing occur as one descriptor-owned operation. Consumers
 * persist `buffer` immediately into a main-owned content-addressed store and
 * must never reopen `sourceRealPath`.
 */
export function snapshotRasterOrPdfAttachment({
  candidatePath,
  workspacePath,
  externalPathGrants = [],
  authorizedFilePaths = [],
  maxBytes = TRANSCRIPT_MEDIA_MAX_PDF_BYTES
}: SnapshotRasterOrPdfAttachmentOptions): RasterOrPdfAttachmentSnapshotResult {
  const requestedMaxBytes = Number.isFinite(maxBytes)
    ? Math.floor(maxBytes)
    : TRANSCRIPT_MEDIA_MAX_PDF_BYTES
  const effectiveMaxBytes = Math.max(1, Math.min(TRANSCRIPT_MEDIA_MAX_PDF_BYTES, requestedMaxBytes))
  const opened = openAuthorizedWorkspaceFile({
    workspacePath,
    candidatePath,
    externalPathGrants,
    authorizedFilePaths,
    maxBytes: effectiveMaxBytes
  })
  if (!opened.ok) return opened
  let buffer: Buffer | null
  try {
    buffer = readOpenedWorkspaceFile(opened)
  } finally {
    fs.closeSync(opened.fd)
  }
  if (!buffer) return { ok: false, reason: 'missing' }
  const imageMime = sniffImageMime(buffer)
  if (isTranscriptSvgMime(imageMime)) return { ok: false, reason: 'unsafe_svg' }
  if (
    isTranscriptRasterImageMime(imageMime) &&
    buffer.length > TRANSCRIPT_MEDIA_MAX_WORKSPACE_IMAGE_BYTES
  ) {
    return { ok: false, reason: 'too_large' }
  }
  const mimeType = isTranscriptRasterImageMime(imageMime) ? imageMime : sniffPdfMime(buffer)
  if (!mimeType) return { ok: false, reason: 'unsupported' }
  return {
    ok: true,
    sourceRealPath: opened.realPath,
    mimeType,
    byteLength: buffer.length,
    sha256: sha256Base64Url(buffer),
    buffer
  }
}

export function readOpenedWorkspaceFile(
  opened: Extract<OpenedWorkspaceFile, { ok: true }>
): Buffer | null {
  const expectedBytes = opened.stat.size
  const buffer = Buffer.allocUnsafe(expectedBytes)
  let offset = 0
  try {
    while (offset < expectedBytes) {
      const bytesRead = fs.readSync(opened.fd, buffer, offset, expectedBytes - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    const finalStat = fs.fstatSync(opened.fd)
    if (
      offset !== expectedBytes ||
      finalStat.size !== expectedBytes ||
      !sameFileSnapshotVersion(finalStat, opened.stat)
    ) {
      return null
    }
    return buffer
  } catch {
    return null
  }
}

export function validateWorkspaceImagePath({
  workspacePath,
  candidatePath,
  externalPathGrants = [],
  authorizedFilePaths = [],
  maxBytes = TRANSCRIPT_MEDIA_MAX_WORKSPACE_IMAGE_BYTES
}: WorkspaceImageValidationOptions): WorkspaceImageValidationResult {
  const opened = openAuthorizedWorkspaceFile({
    workspacePath,
    candidatePath,
    externalPathGrants,
    authorizedFilePaths,
    maxBytes
  })
  if (!opened.ok) return opened
  let buffer: Buffer | null
  try {
    buffer = readOpenedWorkspaceFile(opened)
  } finally {
    fs.closeSync(opened.fd)
  }
  if (!buffer) return { ok: false, reason: 'missing' }
  const sniffed = sniffImageMime(buffer)
  if (isTranscriptSvgMime(sniffed)) return { ok: false, reason: 'unsafe_svg' }
  if (!isTranscriptRasterImageMime(sniffed)) return { ok: false, reason: 'unsupported' }
  return {
    ok: true,
    realPath: opened.realPath,
    ...(opened.workspaceRelativePath
      ? { workspaceRelativePath: opened.workspaceRelativePath }
      : {}),
    mimeType: sniffed || 'image/png',
    byteLength: buffer.length,
    sha256: sha256Base64Url(buffer),
    buffer
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
  externalPathGrants?: readonly ExternalPathGrant[]
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
  const opened = openAuthorizedWorkspaceFile({
    workspacePath,
    candidatePath,
    externalPathGrants,
    maxBytes
  })
  if (!opened.ok) return opened
  let buffer: Buffer | null
  try {
    buffer = readOpenedWorkspaceFile(opened)
  } finally {
    fs.closeSync(opened.fd)
  }
  if (!buffer) return { ok: false, reason: 'missing' }
  const sniffed = sniffAudioMime(buffer)
  if (!sniffed) return { ok: false, reason: 'unsupported' }
  return {
    ok: true,
    realPath: opened.realPath,
    ...(opened.workspaceRelativePath
      ? { workspaceRelativePath: opened.workspaceRelativePath }
      : {}),
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

/**
 * Realpath-jailed, size-capped AUDIO/VIDEO preflight. It reads the coarse media
 * header from a verified descriptor, but the returned source `realPath` is not
 * a stable handoff: a later path-based consumer would reopen it. Call
 * `stageWorkspaceMediaSnapshot` before handing media to ffmpeg or a bridge
 * daemon.
 */
export function validateWorkspaceMediaPath({
  workspacePath,
  candidatePath,
  externalPathGrants = [],
  maxBytes = TRANSCRIPT_MEDIA_MAX_INPUT_BYTES
}: WorkspaceAudioValidationOptions): WorkspaceMediaValidationResult {
  const opened = openAuthorizedWorkspaceFile({
    workspacePath,
    candidatePath,
    externalPathGrants,
    maxBytes
  })
  if (!opened.ok) return opened
  const header = Buffer.alloc(64)
  let bytesRead = 0
  try {
    bytesRead = fs.readSync(opened.fd, header, 0, header.length, 0)
  } catch {
    return { ok: false, reason: 'missing' }
  } finally {
    fs.closeSync(opened.fd)
  }
  const sniffedHeader = header.subarray(0, bytesRead)
  const sniffed = sniffAudioMime(sniffedHeader) || sniffVideoMime(sniffedHeader)
  if (!sniffed) return { ok: false, reason: 'unsupported' }
  return {
    ok: true,
    realPath: opened.realPath,
    mimeType: sniffed,
    byteLength: opened.stat.size
  }
}

export type WorkspaceMediaSnapshotKind = 'image' | 'audio' | 'audio_video'

export interface StageWorkspaceMediaSnapshotOptions extends WorkspaceAudioValidationOptions {
  /** A main-process-owned directory outside agent-writable workspace roots. */
  stagingDirectory: string
  kind: WorkspaceMediaSnapshotKind
}

export type StagedWorkspaceMediaSnapshotResult =
  | {
      ok: true
      /** Stable main-owned snapshot path to hand to ffmpeg / bridge daemons. */
      realPath: string
      /** Canonical authorized source path, for audit/display only. Never reopen it. */
      sourceRealPath: string
      mimeType: string
      byteLength: number
      /**
       * Remove the exact staged inode. Call in a finally block after the final
       * subprocess/daemon consumer returns. Returns false if the staged path was
       * replaced, so cleanup can never unlink an attacker-swapped file.
       */
      cleanup: () => boolean
    }
  | {
      ok: false
      reason:
        | WorkspaceFileOpenReason
        | 'unsupported'
        | 'unsafe_svg'
        | 'unsafe_staging_directory'
        | 'snapshot_failed'
    }

function snapshotMime(
  header: Buffer,
  kind: WorkspaceMediaSnapshotKind
): { ok: true; mimeType: string } | { ok: false; reason: 'unsupported' | 'unsafe_svg' } {
  if (kind === 'image') {
    const mimeType = sniffImageMime(header)
    if (isTranscriptSvgMime(mimeType)) return { ok: false, reason: 'unsafe_svg' }
    return isTranscriptRasterImageMime(mimeType)
      ? { ok: true, mimeType: mimeType || 'image/png' }
      : { ok: false, reason: 'unsupported' }
  }
  const audioMime = sniffAudioMime(header)
  if (audioMime) return { ok: true, mimeType: audioMime }
  if (kind === 'audio_video') {
    const videoMime = sniffVideoMime(header)
    if (videoMime) return { ok: true, mimeType: videoMime }
  }
  return { ok: false, reason: 'unsupported' }
}

function stagedMediaExtension(mimeType: string): string {
  switch (mimeType) {
    case 'image/png':
      return 'png'
    case 'image/jpeg':
      return 'jpg'
    case 'image/webp':
      return 'webp'
    case 'image/gif':
      return 'gif'
    case 'image/bmp':
      return 'bmp'
    case 'audio/wav':
      return 'wav'
    case 'audio/mpeg':
      return 'mp3'
    case 'audio/mp4':
      return 'm4a'
    case 'audio/ogg':
      return 'ogg'
    case 'audio/flac':
      return 'flac'
    case 'video/mp4':
      return 'mp4'
    case 'video/quicktime':
      return 'mov'
    case 'video/webm':
      return 'webm'
    case 'video/x-msvideo':
      return 'avi'
    default:
      return 'media'
  }
}

function prepareMainOwnedStagingDirectory(stagingDirectory: string): string | null {
  if (!path.isAbsolute(stagingDirectory) || stagingDirectory.includes('\0')) return null
  const requested = path.resolve(stagingDirectory)
  try {
    fs.mkdirSync(requested, { recursive: true, mode: 0o700 })
    const requestedLstat = fs.lstatSync(requested)
    if (requestedLstat.isSymbolicLink() || !requestedLstat.isDirectory()) return null
    const canonical = realpathOrNull(requested)
    if (!canonical) return null
    const canonicalStat = fs.statSync(canonical)
    if (!canonicalStat.isDirectory()) return null
    const currentUid = typeof process.getuid === 'function' ? process.getuid() : null
    if (currentUid !== null && canonicalStat.uid !== currentUid) return null
    // Read/execute for other users is acceptable, but no other principal may
    // write into the directory that owns the stable snapshot paths. POSIX
    // only: Windows synthesizes mode bits (no signal there; ACLs unmodeled).
    if (process.platform !== 'win32' && (canonicalStat.mode & 0o022) !== 0) return null
    return canonical
  } catch {
    return null
  }
}

function stagingDirectoryIsAgentWritable(
  stagingRoot: string,
  workspacePath: string,
  externalPathGrants: readonly ExternalPathGrant[]
): boolean {
  const resolvedWorkspace = path.resolve(workspacePath)
  if (pathWithinRoot(stagingRoot, resolvedWorkspace)) return true
  const realWorkspace = realpathOrNull(workspacePath)
  if (realWorkspace && pathWithinRoot(stagingRoot, realWorkspace)) return true
  return externalPathGrants.some((grant) => {
    if (grant.kind !== 'directory' || !path.isAbsolute(grant.path)) return false
    const signedRoot = path.resolve(grant.path)
    try {
      const rootStat = fs.lstatSync(signedRoot)
      return (
        !rootStat.isSymbolicLink() &&
        rootStat.isDirectory() &&
        pathWithinRoot(stagingRoot, signedRoot)
      )
    } catch {
      return false
    }
  })
}

function exactInodeCleanup(
  filePath: string,
  stagingRoot: string,
  expectedStat: fs.Stats,
  options?: { requireStableSnapshot?: boolean }
): () => boolean {
  let cleaned = false
  return () => {
    if (cleaned || !pathWithinRoot(filePath, stagingRoot)) return false
    try {
      const current = fs.lstatSync(filePath)
      if (current.isSymbolicLink() || !sameFileIdentity(current, expectedStat)) return false
      // dev+ino alone is not enough once the snapshot is final: ext4 reuses
      // freed inode numbers, so a replacement can inherit the staged file's
      // identity. A completed snapshot is written exactly once, so size and
      // mtime must also match — anything else refuses (fail closed). The
      // mid-copy failure sweeper cannot use this: its expected stat predates
      // the copy, so size/mtime drift there is legitimate.
      if (
        options?.requireStableSnapshot &&
        (current.size !== expectedStat.size || current.mtimeMs !== expectedStat.mtimeMs)
      ) {
        return false
      }
      fs.unlinkSync(filePath)
      cleaned = true
      return true
    } catch {
      return false
    }
  }
}

export type WorkspaceMediaSnapshotTestStage = 'after_first_chunk'

type WorkspaceMediaSnapshotTestHook = (
  stage: WorkspaceMediaSnapshotTestStage
) => Promise<void> | void

let workspaceMediaSnapshotTestHook: WorkspaceMediaSnapshotTestHook | undefined

export function setWorkspaceMediaSnapshotTestHookForTests(
  hook: WorkspaceMediaSnapshotTestHook | undefined
): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('Workspace media snapshot test hooks are only available in tests.')
  }
  workspaceMediaSnapshotTestHook = hook
}

function readFileDescriptor(
  fd: number,
  buffer: Buffer,
  offset: number,
  length: number,
  position: number
): Promise<number> {
  return new Promise((resolve, reject) => {
    fs.read(fd, buffer, offset, length, position, (error, bytesRead) => {
      if (error) reject(error)
      else resolve(bytesRead)
    })
  })
}

function writeFileDescriptor(
  fd: number,
  buffer: Buffer,
  offset: number,
  length: number,
  position: number
): Promise<number> {
  return new Promise((resolve, reject) => {
    fs.write(fd, buffer, offset, length, position, (error, bytesWritten) => {
      if (error) reject(error)
      else resolve(bytesWritten)
    })
  })
}

function openFileDescriptor(filePath: string, flags: number, mode: number): Promise<number> {
  return new Promise((resolve, reject) => {
    fs.open(filePath, flags, mode, (error, fd) => {
      if (error) reject(error)
      else resolve(fd)
    })
  })
}

function statFileDescriptor(fd: number): Promise<fs.Stats> {
  return new Promise((resolve, reject) => {
    fs.fstat(fd, (error, stat) => {
      if (error) reject(error)
      else resolve(stat)
    })
  })
}

function syncFileDescriptor(fd: number): Promise<void> {
  return new Promise((resolve, reject) => {
    fs.fsync(fd, (error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

function closeFileDescriptor(fd: number): Promise<void> {
  return new Promise((resolve, reject) => {
    fs.close(fd, (error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

async function closeFileDescriptorBestEffort(fd: number | null): Promise<void> {
  if (fd === null) return
  try {
    await closeFileDescriptor(fd)
  } catch {
    // best-effort close
  }
}

/**
 * Copy an authorized workspace/grant-backed media file from its verified
 * nofollow descriptor into a private, main-owned staging directory. This is the
 * path-safe handoff for APIs that cannot consume bytes (ffmpeg, AVFoundation,
 * bridge daemons). The returned path is stable because untrusted workspace code
 * cannot rename or replace entries in the staging directory.
 *
 * The descriptor copy is asynchronous so a large authorized input cannot block
 * Electron's main event loop. Keep the input cap bounded and always invoke
 * `cleanup` in the tool executor's outermost finally block. The existing staging
 * sweeper remains crash cleanup, not the normal ownership mechanism.
 */
export async function stageWorkspaceMediaSnapshot({
  workspacePath,
  candidatePath,
  externalPathGrants = [],
  maxBytes,
  stagingDirectory,
  kind
}: StageWorkspaceMediaSnapshotOptions): Promise<StagedWorkspaceMediaSnapshotResult> {
  const effectiveMaxBytes =
    maxBytes ??
    (kind === 'image'
      ? TRANSCRIPT_MEDIA_MAX_WORKSPACE_IMAGE_BYTES
      : kind === 'audio'
        ? TRANSCRIPT_MEDIA_MAX_AUDIO_BYTES
        : TRANSCRIPT_MEDIA_MAX_INPUT_BYTES)
  const opened = openAuthorizedWorkspaceFile({
    workspacePath,
    candidatePath,
    externalPathGrants,
    maxBytes: effectiveMaxBytes
  })
  if (!opened.ok) return opened

  let destinationFd: number | null = null
  let destinationPath: string | null = null
  let destinationStat: fs.Stats | null = null
  let cleanupDestination: (() => boolean) | null = null
  try {
    const sourceHeader = Buffer.alloc(Math.min(512, opened.stat.size))
    const sourceHeaderBytes = await readFileDescriptor(
      opened.fd,
      sourceHeader,
      0,
      sourceHeader.length,
      0
    )
    const sourceMime = snapshotMime(sourceHeader.subarray(0, sourceHeaderBytes), kind)
    if (!sourceMime.ok) return sourceMime

    if (
      !path.isAbsolute(stagingDirectory) ||
      stagingDirectoryIsAgentWritable(
        path.resolve(stagingDirectory),
        workspacePath,
        externalPathGrants
      )
    ) {
      return { ok: false, reason: 'unsafe_staging_directory' }
    }
    const stagingRoot = prepareMainOwnedStagingDirectory(stagingDirectory)
    if (
      !stagingRoot ||
      stagingDirectoryIsAgentWritable(stagingRoot, workspacePath, externalPathGrants)
    ) {
      return { ok: false, reason: 'unsafe_staging_directory' }
    }
    destinationPath = path.join(
      stagingRoot,
      `tw-input-${randomUUID()}.${stagedMediaExtension(sourceMime.mimeType)}`
    )
    destinationFd = await openFileDescriptor(
      destinationPath,
      fs.constants.O_RDWR |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_NOFOLLOW,
      0o600
    )
    destinationStat = await statFileDescriptor(destinationFd)
    cleanupDestination = exactInodeCleanup(destinationPath, stagingRoot, destinationStat)
    const destinationLstat = fs.lstatSync(destinationPath)
    if (
      destinationLstat.isSymbolicLink() ||
      !destinationStat.isFile() ||
      !sameFileIdentity(destinationStat, destinationLstat)
    ) {
      return { ok: false, reason: 'snapshot_failed' }
    }

    const chunk = Buffer.allocUnsafe(Math.min(1024 * 1024, opened.stat.size))
    let sourceOffset = 0
    let copiedFirstChunk = false
    while (sourceOffset < opened.stat.size) {
      const requested = Math.min(chunk.length, opened.stat.size - sourceOffset)
      const bytesRead = await readFileDescriptor(opened.fd, chunk, 0, requested, sourceOffset)
      if (bytesRead === 0) break
      let written = 0
      while (written < bytesRead) {
        const bytesWritten = await writeFileDescriptor(
          destinationFd,
          chunk,
          written,
          bytesRead - written,
          sourceOffset + written
        )
        if (bytesWritten <= 0) return { ok: false, reason: 'snapshot_failed' }
        written += bytesWritten
      }
      sourceOffset += bytesRead
      if (!copiedFirstChunk) {
        copiedFirstChunk = true
        await workspaceMediaSnapshotTestHook?.('after_first_chunk')
      }
    }
    const finalSourceStat = await statFileDescriptor(opened.fd)
    if (
      sourceOffset !== opened.stat.size ||
      finalSourceStat.size !== opened.stat.size ||
      !sameFileSnapshotVersion(finalSourceStat, opened.stat)
    ) {
      return { ok: false, reason: 'snapshot_failed' }
    }
    await syncFileDescriptor(destinationFd)
    const finalDestinationStat = await statFileDescriptor(destinationFd)
    if (
      finalDestinationStat.size !== opened.stat.size ||
      !sameFileIdentity(finalDestinationStat, destinationStat)
    ) {
      return { ok: false, reason: 'snapshot_failed' }
    }

    const stagedHeader = Buffer.alloc(Math.min(512, finalDestinationStat.size))
    const stagedHeaderBytes = await readFileDescriptor(
      destinationFd,
      stagedHeader,
      0,
      stagedHeader.length,
      0
    )
    const stagedMime = snapshotMime(stagedHeader.subarray(0, stagedHeaderBytes), kind)
    if (!stagedMime.ok || stagedMime.mimeType !== sourceMime.mimeType) {
      return { ok: false, reason: stagedMime.ok ? 'snapshot_failed' : stagedMime.reason }
    }

    const stablePath = destinationPath
    const stableStat = finalDestinationStat
    const stableCleanup = exactInodeCleanup(stablePath, stagingRoot, stableStat, {
      requireStableSnapshot: true
    })
    cleanupDestination = null
    return {
      ok: true,
      realPath: stablePath,
      sourceRealPath: opened.realPath,
      mimeType: stagedMime.mimeType,
      byteLength: stableStat.size,
      cleanup: stableCleanup
    }
  } catch {
    return { ok: false, reason: 'snapshot_failed' }
  } finally {
    await closeFileDescriptorBestEffort(destinationFd)
    await closeFileDescriptorBestEffort(opened.fd)
    cleanupDestination?.()
  }
}
