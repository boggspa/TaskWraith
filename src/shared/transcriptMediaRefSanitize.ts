import type {
  TranscriptMediaRef,
  TranscriptMediaSource,
  TranscriptMediaStatus,
  TranscriptMediaThumbnail
} from '../main/store/types'

/**
 * Shared, node-free sanitizer for `media_refs` arriving on the RAW provider
 * lane.
 *
 * Two lanes feed transcript media refs:
 *  1. The SANITIZED lane — `createToolResultMediaRefs` in
 *     `src/main/services/TranscriptMediaService.ts` magic-byte sniffs the
 *     decoded image, rejects SVG, size-caps, and only ever produces
 *     raster refs from bytes it actually read. Those refs are trusted.
 *  2. The RAW lane — `feedOrchestrator`/the bridge transcript handlers
 *     `JSON.parse` raw provider (Gemini CLI) stdout and forward a
 *     `{ type: 'media_refs', mediaRefs: [...] }` object verbatim. A
 *     malicious/compromised provider controls EVERY field of those refs.
 *
 * Until now the RAW lane only filtered `!!ref && typeof ref === 'object'`, so
 * a hostile ref could carry an arbitrary `path` (e.g. `file:///etc/passwd`,
 * reachable via the desktop "Open file" overlay → `api.openExternalOrPath`),
 * a fake `sha256`, an oversize inlined `thumbnail`, or an `image/svg+xml`
 * mime. This module re-validates each RAW ref against the same allow-list
 * logic the remote projection already uses (`RemoteThreadProjection`'s
 * `validRemoteThumbnail` / `buildRowMedia`), but applied at every desktop +
 * ensemble ingestion point — not just the phone projection.
 *
 * The sanitized lane is intentionally NOT routed through here: its refs are
 * produced from sniffed bytes and may legitimately carry an `assetId`-only
 * shape. This sanitizer is only for provider-controlled (untrusted) input.
 */

/** Sources a RAW provider ref may declare. Mirrors `REMOTE_MEDIA_SOURCES`. */
const RAW_MEDIA_SOURCES = new Set<TranscriptMediaSource>([
  'generated',
  'workspace_path',
  'upload',
  'tool_result'
])

/**
 * The ONLY `groupKind` values a RAW (provider-controlled) ref may carry. `groupKind` is
 * cosmetic (it picks a renderer layout, e.g. the NLE filmstrip), but a hostile provider
 * must not be able to forge arbitrary grouping, so we value-restrict it to a known
 * allowlist — any other value is dropped (the ref still renders, just ungrouped). New
 * group kinds must be added here explicitly. House security posture: allowlist, not
 * length-cap.
 */
const SAFE_GROUP_KINDS = new Set<string>(['video_frames', 'audio_segment'])

/**
 * Sources for which a provider-supplied `path` is retained. Everything else
 * (notably `generated` / `tool_result` — the only sources that legitimately
 * ride the RAW provider lane) has its `path` stripped, so a hostile
 * `file:///etc/passwd` can never reach the desktop "Open file" overlay.
 *
 * `external_path` is not a `TranscriptMediaSource` today (it only exists as a
 * renderer-side `ChatMediaSource`), so in practice this means only genuine
 * `upload` refs keep a path — and uploads do not travel the provider stdout
 * lane, so the net effect on the RAW lane is an unconditional path strip for
 * every ref a provider can actually emit. The carve-out matches the
 * `chatMediaPreviewSrc` render gate verbatim for forward-compat.
 */
const RAW_MEDIA_PATH_SOURCES = new Set<string>(['upload', 'external_path'])

/**
 * Raster mimes accepted for the ref itself. SVG is deliberately excluded: the
 * sanitized lane rejects it (`decodedImageBlock` → `unsafe_svg`) and the
 * render gate only previews raster thumbnails, so an SVG ref on the RAW lane
 * is pure attack surface.
 */
const RAW_RASTER_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/gif',
  'image/bmp'
])

/**
 * Thumbnail mimes that may be base64-inlined and rendered as a `data:` URI.
 * Matches `REMOTE_THUMBNAIL_MIME_TYPES` and the `chatMediaPreviewSrc` regex.
 */
const RAW_THUMBNAIL_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp'])

const RAW_MEDIA_STATUSES = new Set<TranscriptMediaStatus>([
  'available',
  'missing',
  'denied',
  'unsafe_svg',
  'too_large',
  'unsupported'
])

/** Cap on a single inlined thumbnail's base64 length. Matches
 *  `REMOTE_MAX_MEDIA_THUMB_BASE64` in `RemoteThreadProjection`. */
export const RAW_MEDIA_MAX_THUMBNAIL_BASE64 = 180_000

/** Cap on how many refs a single provider `media_refs` event may contribute.
 *  Matches `TRANSCRIPT_MEDIA_MAX_REFS_PER_MESSAGE` / `REMOTE_MAX_MEDIA_REFS_PER_ROW`. */
export const RAW_MEDIA_MAX_REFS = 8

const RAW_MEDIA_MAX_PATH_LENGTH = 4096

/**
 * Canonical content-address (base64url sha256) shape. Mirrors the `SHA_RE` /
 * `SHA256_BASE64URL_PATTERN` the `twmedia://` protocol + asset store enforce.
 * Kept as a local literal (not imported) so this shared, node-free module never
 * reaches into a `main/` file. A provider-supplied `sha256` that fails this shape
 * is dropped rather than stored — defense-in-depth that narrows the blast radius
 * if a downstream URL builder is ever fed a RAW-lane ref directly.
 */
const RAW_SHA_RE = /^[A-Za-z0-9_-]{32,96}$/

/** base64 alphabet (standard + url-safe `=` padding) plus whitespace. A
 *  thumbnail body containing anything else (quotes, angle brackets, `data:`
 *  prefixes…) is rejected so it can never break out of the constructed
 *  `data:<mime>;base64,<body>` URI. */
const BASE64_BODY = /^[A-Za-z0-9+/=\s]+$/

function trimmedString(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed
}

function lowerMime(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : undefined
}

/**
 * Validate a provider-supplied thumbnail. Returns a bounded raster thumbnail
 * or `undefined`. Mirrors `validRemoteThumbnail` and additionally rejects a
 * non-base64 body.
 */
export function sanitizeRawThumbnail(raw: unknown): TranscriptMediaThumbnail | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const record = raw as Record<string, unknown>
  const dataBase64 = typeof record.dataBase64 === 'string' ? record.dataBase64 : ''
  const mimeType = lowerMime(record.mimeType)
  if (!dataBase64 || dataBase64.length > RAW_MEDIA_MAX_THUMBNAIL_BASE64) return undefined
  if (!RAW_THUMBNAIL_MIME_TYPES.has(mimeType)) return undefined
  if (!BASE64_BODY.test(dataBase64)) return undefined
  const thumbnail: TranscriptMediaThumbnail = { dataBase64, mimeType }
  const width = positiveInt(record.width)
  const height = positiveInt(record.height)
  if (width !== undefined) thumbnail.width = width
  if (height !== undefined) thumbnail.height = height
  return thumbnail
}

/**
 * A retained `path` must be a local file reference (absolute POSIX path or
 * `file://` URL) AND come from a path-bearing source. Anything else —
 * http(s)/data/javascript URIs, relative paths, paths from a non-allow-listed
 * source — is dropped so it can't reach the user-gated "Open file" overlay.
 */
function safeRetainedPath(value: unknown, source: string): string | undefined {
  if (!RAW_MEDIA_PATH_SOURCES.has(source)) return undefined
  const path = trimmedString(value, RAW_MEDIA_MAX_PATH_LENGTH)
  if (!path || path.includes('\0')) return undefined
  if (path.startsWith('/')) return path
  if (/^file:\/\//i.test(path)) return path
  return undefined
}

/**
 * Validate a single RAW-lane media ref. Returns a sanitized
 * `TranscriptMediaRef` (raster-only, with any unsafe `path`/`thumbnail`
 * neutralized) or `null` if the ref cannot be made safe + renderable.
 */
export function sanitizeRawProviderMediaRef(raw: unknown): TranscriptMediaRef | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>

  if (record.kind !== 'image') return null

  const source = record.source as TranscriptMediaSource
  if (!RAW_MEDIA_SOURCES.has(source)) return null

  // `format` defaults to raster; an explicit non-raster format (e.g. `svg`)
  // is rejected — this lane is raster-only.
  const rawFormat = record.format
  if (rawFormat !== undefined && rawFormat !== 'raster') return null

  // Raster mime only. `image/svg+xml` and unknown mimes are dropped.
  const mimeType = lowerMime(record.mimeType)
  if (!RAW_RASTER_MIME_TYPES.has(mimeType)) return null

  // `id` is the dedup key and is required by the renderer's
  // `collectChatMediaRefs` gate.
  const id = trimmedString(record.id, 256)
  if (!id) return null

  // `status` must be known; an unknown status is treated as hostile.
  const rawStatus = record.status
  if (rawStatus !== undefined && !RAW_MEDIA_STATUSES.has(rawStatus as TranscriptMediaStatus)) {
    return null
  }
  const status: TranscriptMediaStatus =
    rawStatus === undefined ? 'available' : (rawStatus as TranscriptMediaStatus)

  const thumbnail = sanitizeRawThumbnail(record.thumbnail)
  const path = safeRetainedPath(record.path, source)

  // A ref must retain at least one safe, renderable surface — a bounded raster
  // thumbnail or an allow-listed local path. Otherwise it is an inert / hostile
  // husk and is dropped (this also matches the renderer's own
  // `collectChatMediaRefs` gate, which discards `available` refs with neither).
  if (!thumbnail && !path) return null

  const ref: TranscriptMediaRef = {
    id,
    kind: 'image',
    format: 'raster',
    source,
    name: trimmedString(record.name, 256) || 'Image',
    mimeType,
    status
  }
  const alt = trimmedString(record.alt, 512)
  const caption = trimmedString(record.caption, 1024)
  const width = positiveInt(record.width)
  const height = positiveInt(record.height)
  const byteLength = positiveInt(record.byteLength)
  // A provider-supplied sha256 must match the canonical content-address shape, or
  // it is dropped (not stored): a malformed sha is never a valid asset key, and
  // letting garbage through would only widen the surface if a URL builder is ever
  // reused on a RAW-lane ref. Dropping it just falls back to assetId/id for dedup.
  const rawSha = trimmedString(record.sha256, 256)
  const sha256 = rawSha && RAW_SHA_RE.test(rawSha) ? rawSha : ''
  const assetId = trimmedString(record.assetId, 256)
  // `groupKind` is cosmetic but VALUE-RESTRICTED on the RAW lane: only a known group
  // kind survives, so a hostile provider can't forge arbitrary grouping. Anything else
  // (including a present-but-unknown value) is silently dropped → the ref renders
  // ungrouped. This is the forgery boundary for the filmstrip grouping.
  const groupKind =
    typeof record.groupKind === 'string' && SAFE_GROUP_KINDS.has(record.groupKind)
      ? record.groupKind
      : undefined
  if (alt) ref.alt = alt
  if (caption) ref.caption = caption
  if (groupKind) ref.groupKind = groupKind
  if (width !== undefined) ref.width = width
  if (height !== undefined) ref.height = height
  if (byteLength !== undefined) ref.byteLength = byteLength
  if (sha256) ref.sha256 = sha256
  if (assetId) ref.assetId = assetId
  if (thumbnail) ref.thumbnail = thumbnail
  if (path) ref.path = path
  // `workspaceId` / `workspaceRelativePath` are deliberately dropped: a
  // provider cannot be trusted to scope a ref to a workspace, and they are
  // only meaningful on sanitized main-side `workspace_path` refs.
  return ref
}

/**
 * Validate an array of RAW-lane media refs. Drops anything that cannot be made
 * safe, de-dupes by content identity (`sha256` → `assetId` → `id`), and caps
 * the count at `RAW_MEDIA_MAX_REFS`. Returns `[]` for any non-array input.
 */
export function sanitizeRawProviderMediaRefs(raw: unknown): TranscriptMediaRef[] {
  if (!Array.isArray(raw)) return []
  const refs: TranscriptMediaRef[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    if (refs.length >= RAW_MEDIA_MAX_REFS) break
    const ref = sanitizeRawProviderMediaRef(entry)
    if (!ref) continue
    const key = ref.sha256 || ref.assetId || ref.id
    if (seen.has(key)) continue
    seen.add(key)
    refs.push(ref)
  }
  return refs
}
