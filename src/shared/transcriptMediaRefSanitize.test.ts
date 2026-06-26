import { describe, expect, it } from 'vitest'
import {
  RAW_MEDIA_MAX_REFS,
  RAW_MEDIA_MAX_THUMBNAIL_BASE64,
  sanitizeRawProviderMediaRef,
  sanitizeRawProviderMediaRefs,
  sanitizeRawThumbnail
} from './transcriptMediaRefSanitize'

// A valid base64url sha256 (>=32 chars) — the RAW sanitizer now drops a sha that
// doesn't match the canonical content-address shape, so fixtures use a real one.
const VALID_SHA = 'abc123def456ghi789jkl012mno345pq'

/** A legitimate raster ref as the sanitized lane would emit it over the RAW
 *  transport (raster image with a small bounded thumbnail, no path). */
function legitRef(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'run-1:tool-image:abc123',
    kind: 'image',
    format: 'raster',
    source: 'tool_result',
    name: 'tool image 1',
    mimeType: 'image/png',
    byteLength: 4096,
    sha256: VALID_SHA,
    assetId: 'run:run-1:tool-image:abc123',
    thumbnail: { dataBase64: 'iVBORw0KGgo=', mimeType: 'image/png', width: 16, height: 16 },
    status: 'available',
    ...overrides
  }
}

describe('sanitizeRawProviderMediaRef', () => {
  it('keeps a legitimate raster ref with a bounded thumbnail', () => {
    const ref = sanitizeRawProviderMediaRef(legitRef())
    expect(ref).not.toBeNull()
    expect(ref?.id).toBe('run-1:tool-image:abc123')
    expect(ref?.mimeType).toBe('image/png')
    expect(ref?.thumbnail?.dataBase64).toBe('iVBORw0KGgo=')
    expect(ref?.sha256).toBe(VALID_SHA)
    expect(ref?.path).toBeUndefined()
  })

  it('keeps a whitelisted groupKind (video_frames) and a bounded caption', () => {
    const ref = sanitizeRawProviderMediaRef(
      legitRef({ groupKind: 'video_frames', caption: '0:03' })
    )
    expect(ref?.groupKind).toBe('video_frames')
    expect(ref?.caption).toBe('0:03')
  })

  it('DROPS an unknown groupKind (forgery boundary) but keeps the ref ungrouped', () => {
    const ref = sanitizeRawProviderMediaRef(
      legitRef({ groupKind: 'evil_arbitrary_group', caption: '0:03' })
    )
    expect(ref).not.toBeNull()
    expect(ref?.groupKind).toBeUndefined()
    // The rest of the (legit) ref still survives — only the forged grouping is stripped.
    expect(ref?.caption).toBe('0:03')
    expect(ref?.id).toBe('run-1:tool-image:abc123')
  })

  it('drops a non-string groupKind', () => {
    expect(sanitizeRawProviderMediaRef(legitRef({ groupKind: 42 }))?.groupKind).toBeUndefined()
    expect(sanitizeRawProviderMediaRef(legitRef({ groupKind: { evil: true } }))?.groupKind).toBeUndefined()
  })

  it('caps a caption at 1024 chars', () => {
    const ref = sanitizeRawProviderMediaRef(legitRef({ caption: 'x'.repeat(2000) }))
    expect((ref?.caption ?? '').length).toBe(1024)
  })

  it('strips a hostile file:// path from a tool_result ref (keeps the ref via its thumbnail)', () => {
    const ref = sanitizeRawProviderMediaRef(legitRef({ path: 'file:///etc/passwd' }))
    expect(ref).not.toBeNull()
    expect(ref?.path).toBeUndefined()
    expect(ref?.thumbnail).toBeTruthy()
  })

  it('drops a generated ref whose only surface is a hostile path (path stripped → nothing renderable)', () => {
    const ref = sanitizeRawProviderMediaRef(
      legitRef({ source: 'generated', path: 'file:///etc/passwd', thumbnail: undefined })
    )
    expect(ref).toBeNull()
  })

  it('drops a ref with an image/svg+xml mime', () => {
    expect(sanitizeRawProviderMediaRef(legitRef({ mimeType: 'image/svg+xml' }))).toBeNull()
  })

  it('drops audio/video kinds — the RAW provider lane stays raster-only (S0a gate-lock)', () => {
    // After widening TranscriptMediaKind to image|audio|video, AV refs must still
    // arrive ONLY via the sanitized tool-result lane, NEVER untrusted provider
    // stdout. This regression-locks the gate so the widening can't reopen the hole.
    expect(sanitizeRawProviderMediaRef(legitRef({ kind: 'video', mimeType: 'video/mp4' }))).toBeNull()
    expect(sanitizeRawProviderMediaRef(legitRef({ kind: 'audio', mimeType: 'audio/wav' }))).toBeNull()
    // …even carrying a hostile path that would be dangerous if it leaked through.
    expect(
      sanitizeRawProviderMediaRef(
        legitRef({ kind: 'video', mimeType: 'video/mp4', path: 'file:///etc/passwd' })
      )
    ).toBeNull()
  })

  it('drops a ref with an explicit svg format', () => {
    expect(
      sanitizeRawProviderMediaRef(legitRef({ format: 'svg', mimeType: 'image/png' }))
    ).toBeNull()
  })

  it('drops a ref with an unrecognized (fake) source', () => {
    expect(sanitizeRawProviderMediaRef(legitRef({ source: 'external_path' }))).toBeNull()
    expect(sanitizeRawProviderMediaRef(legitRef({ source: 'remote_url' }))).toBeNull()
  })

  it('drops a ref with an unknown status', () => {
    expect(sanitizeRawProviderMediaRef(legitRef({ status: 'totally_fine_trust_me' }))).toBeNull()
  })

  it('drops a non-image kind', () => {
    expect(sanitizeRawProviderMediaRef(legitRef({ kind: 'file' }))).toBeNull()
  })

  it('drops a ref with no usable id', () => {
    expect(sanitizeRawProviderMediaRef(legitRef({ id: '   ' }))).toBeNull()
    expect(sanitizeRawProviderMediaRef(legitRef({ id: 42 }))).toBeNull()
  })

  it('drops non-object / array input', () => {
    expect(sanitizeRawProviderMediaRef(null)).toBeNull()
    expect(sanitizeRawProviderMediaRef('file:///etc/passwd')).toBeNull()
    expect(sanitizeRawProviderMediaRef([legitRef()])).toBeNull()
  })

  it('drops an oversize inlined thumbnail (and the ref, since it has no path)', () => {
    const huge = 'A'.repeat(RAW_MEDIA_MAX_THUMBNAIL_BASE64 + 1)
    const ref = sanitizeRawProviderMediaRef(
      legitRef({ thumbnail: { dataBase64: huge, mimeType: 'image/png' } })
    )
    expect(ref).toBeNull()
  })

  it('strips a thumbnail with a non-raster (svg) mime', () => {
    const ref = sanitizeRawProviderMediaRef(
      legitRef({
        path: '/Users/me/Pictures/real.png',
        source: 'upload',
        thumbnail: { dataBase64: 'PHN2Zz4=', mimeType: 'image/svg+xml' }
      })
    )
    // Thumbnail stripped (svg mime), but the upload ref survives via its path.
    expect(ref).not.toBeNull()
    expect(ref?.thumbnail).toBeUndefined()
    expect(ref?.path).toBe('/Users/me/Pictures/real.png')
  })

  it('strips a thumbnail whose base64 body carries injection characters', () => {
    const ref = sanitizeRawProviderMediaRef(
      legitRef({ thumbnail: { dataBase64: 'abc"><script>', mimeType: 'image/png' } })
    )
    expect(ref).toBeNull()
  })

  it('retains a safe absolute path for an upload ref with no thumbnail', () => {
    const ref = sanitizeRawProviderMediaRef({
      id: 'upload-1',
      kind: 'image',
      source: 'upload',
      name: 'photo.png',
      mimeType: 'image/png',
      path: '/Users/me/Pictures/photo.png',
      status: 'available'
    })
    expect(ref?.path).toBe('/Users/me/Pictures/photo.png')
  })

  it('strips a javascript: scheme path even on an upload ref → ref dropped', () => {
    const ref = sanitizeRawProviderMediaRef({
      id: 'upload-evil',
      kind: 'image',
      source: 'upload',
      name: 'x',
      mimeType: 'image/png',
      // eslint-disable-next-line no-script-url
      path: 'javascript:alert(1)',
      status: 'available'
    })
    expect(ref).toBeNull()
  })

  it('strips an http(s) path even on an upload ref → ref dropped when no thumbnail', () => {
    const ref = sanitizeRawProviderMediaRef({
      id: 'upload-http',
      kind: 'image',
      source: 'upload',
      name: 'x',
      mimeType: 'image/png',
      path: 'https://evil.example/track.png',
      status: 'available'
    })
    expect(ref).toBeNull()
  })

  it('drops provider-supplied workspaceId / workspaceRelativePath', () => {
    const ref = sanitizeRawProviderMediaRef(
      legitRef({ workspaceId: 'ws-evil', workspaceRelativePath: '../../etc/passwd' })
    )
    expect(ref).not.toBeNull()
    expect((ref as Record<string, unknown>).workspaceId).toBeUndefined()
    expect((ref as Record<string, unknown>).workspaceRelativePath).toBeUndefined()
  })

  it('defaults a missing/blank name to "Image"', () => {
    expect(sanitizeRawProviderMediaRef(legitRef({ name: '   ' }))?.name).toBe('Image')
    expect(sanitizeRawProviderMediaRef(legitRef({ name: undefined }))?.name).toBe('Image')
  })

  it('drops a fake numeric sha256/byteLength rather than trusting it', () => {
    const ref = sanitizeRawProviderMediaRef(legitRef({ sha256: 12345, byteLength: -10 }))
    expect(ref).not.toBeNull()
    expect(ref?.sha256).toBeUndefined()
    expect(ref?.byteLength).toBeUndefined()
  })

  it('drops a sha256 that fails the canonical content-address shape (defense-in-depth)', () => {
    // Too short, and one carrying disallowed characters — both must be dropped
    // (the ref survives via its thumbnail), never stored as a fake asset key.
    expect(sanitizeRawProviderMediaRef(legitRef({ sha256: 'abc123' }))?.sha256).toBeUndefined()
    expect(
      sanitizeRawProviderMediaRef(legitRef({ sha256: '../../etc/passwd/aaaaaaaaaaaaaaaaaaaaaaaaaaaa' }))?.sha256
    ).toBeUndefined()
    // A canonical base64url sha of valid length is retained.
    expect(sanitizeRawProviderMediaRef(legitRef({ sha256: VALID_SHA }))?.sha256).toBe(VALID_SHA)
  })
})

describe('sanitizeRawThumbnail', () => {
  it('accepts a bounded raster thumbnail', () => {
    expect(sanitizeRawThumbnail({ dataBase64: 'iVBORw0KGgo=', mimeType: 'image/jpeg' })).toEqual({
      dataBase64: 'iVBORw0KGgo=',
      mimeType: 'image/jpeg'
    })
  })

  it('rejects svg, oversize, bad-base64, and non-object thumbnails', () => {
    expect(sanitizeRawThumbnail({ dataBase64: 'PHN2Zz4=', mimeType: 'image/svg+xml' })).toBeUndefined()
    expect(
      sanitizeRawThumbnail({
        dataBase64: 'A'.repeat(RAW_MEDIA_MAX_THUMBNAIL_BASE64 + 1),
        mimeType: 'image/png'
      })
    ).toBeUndefined()
    expect(sanitizeRawThumbnail({ dataBase64: 'a b<c>', mimeType: 'image/png' })).toBeUndefined()
    expect(sanitizeRawThumbnail(null)).toBeUndefined()
    expect(sanitizeRawThumbnail('iVBORw0KGgo=')).toBeUndefined()
  })
})

describe('sanitizeRawProviderMediaRefs', () => {
  it('returns [] for non-array input', () => {
    expect(sanitizeRawProviderMediaRefs(undefined)).toEqual([])
    expect(sanitizeRawProviderMediaRefs({ mediaRefs: [legitRef()] })).toEqual([])
    expect(sanitizeRawProviderMediaRefs(null)).toEqual([])
  })

  it('drops hostile refs and keeps legit ones in a mixed batch', () => {
    const refs = sanitizeRawProviderMediaRefs([
      legitRef({ id: 'a', sha256: `${VALID_SHA}aa`, assetId: 'asset-a' }),
      legitRef({ id: 'b', sha256: `${VALID_SHA}bb`, assetId: 'asset-b', mimeType: 'image/svg+xml' }), // dropped (svg)
      'file:///etc/passwd', // dropped (not object)
      legitRef({ id: 'c', sha256: `${VALID_SHA}cc`, assetId: 'asset-c', source: 'workspace_path', path: 'file:///etc/shadow' }) // kept, path stripped
    ])
    expect(refs.map((r) => r.id)).toEqual(['a', 'c'])
    expect(refs.every((r) => r.path === undefined)).toBe(true)
  })

  it('de-dupes by content identity (sha256 → assetId → id)', () => {
    const refs = sanitizeRawProviderMediaRefs([
      legitRef({ id: 'x1', sha256: VALID_SHA }),
      legitRef({ id: 'x2', sha256: VALID_SHA })
    ])
    expect(refs).toHaveLength(1)
  })

  it('caps the batch at RAW_MEDIA_MAX_REFS', () => {
    const many = Array.from({ length: RAW_MEDIA_MAX_REFS + 5 }, (_, i) =>
      // distinct VALID shas so each is a distinct dedup key (the sanitizer now drops
      // a malformed sha, which would otherwise collapse these onto a shared assetId).
      legitRef({ id: `id-${i}`, sha256: `${VALID_SHA}${String(i).padStart(2, '0')}`, assetId: `asset-${i}` })
    )
    expect(sanitizeRawProviderMediaRefs(many)).toHaveLength(RAW_MEDIA_MAX_REFS)
  })
})
