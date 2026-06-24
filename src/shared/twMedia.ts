/**
 * Node-free shared constants for the `twmedia://` media protocol — the scheme,
 * the mime↔ext mapping, and the renderer's URL builder. Importable from BOTH the
 * main protocol handler (Content-Type from ext) and the renderer (ref.mimeType →
 * a `<video src>` URL), so the two can never drift. MUST stay consistent with
 * TranscriptMediaAssetStore.mediaExtension (the write-side mime→ext) — locked by a
 * round-trip test in twMedia.test.ts.
 */

export const TW_MEDIA_SCHEME = 'twmedia'

// mime → on-disk ext. Includes the input aliases the asset store also accepts
// (image/jpg, audio/x-wav, audio/x-flac) so a ref carrying an alias mime still
// builds a URL to the canonically-stored file.
const MIME_TO_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/ogg': 'ogg',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm'
}

// ext → canonical mime (the Content-Type the protocol serves).
const EXT_TO_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm'
}

export function twMediaExtForMime(mimeType: string | null | undefined): string | null {
  return mimeType ? (MIME_TO_EXT[mimeType.toLowerCase()] ?? null) : null
}

export function twMediaMimeForExt(ext: string): string | null {
  return EXT_TO_MIME[ext.toLowerCase()] ?? null
}

/**
 * Build `twmedia://asset/<sha256>.<ext>` for a content-addressed asset, or null
 * when the mime isn't mappable or the sha is missing. The renderer feeds the
 * result to a `<video>`/`<audio>` `src`; the protocol streams it with HTTP Range.
 */
export function twMediaUrl(sha256: string | null | undefined, mimeType: string | null | undefined): string | null {
  if (!sha256) return null
  const ext = twMediaExtForMime(mimeType)
  if (!ext) return null
  return `${TW_MEDIA_SCHEME}://asset/${sha256}.${ext}`
}
