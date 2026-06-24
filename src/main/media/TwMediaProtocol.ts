import fs from 'fs'
import { Readable } from 'stream'
import { protocol } from 'electron'
import { TW_MEDIA_SCHEME, readAssetSlice, resolveMediaRange, resolveTwMediaAsset } from './twMediaRange'

/**
 * The `twmedia://` custom protocol — Range-seekable streaming of content-addressed
 * transcript media (audio/video) out of the asset store, the gate for all real
 * `<video>`/`<audio>` playback (a video can't be base64-inlined / is non-seekable
 * as a data: URI). Pure logic (Range math, URL parse, jail) is in twMediaRange.ts;
 * this is the thin electron wiring.
 *
 * Security: the URL carries only `<sha256>.<ext>` — never a filesystem path — and
 * resolves through `resolveTwMediaAsset` (realpath jail). The scheme is privileged
 * but `bypassCSP:false` + `corsEnabled:false`, and it is added explicitly to
 * `media-src` in the renderer CSP (defence in depth). 404 is returned identically
 * for bad-hash and not-found (no existence oracle).
 */

export { TW_MEDIA_SCHEME }

/** Passed to `protocol.registerSchemesAsPrivileged` BEFORE app `ready` (it can
 * only be called once, pre-ready). `stream:true` is the load-bearing flag — it
 * tells Chromium's `<video>`/`<audio>` to expect a streamed/ranged response. */
export const TW_MEDIA_PRIVILEGE = {
  scheme: TW_MEDIA_SCHEME,
  privileges: {
    standard: true,
    secure: true,
    stream: true,
    supportFetchAPI: true,
    bypassCSP: false,
    corsEnabled: false
  }
} as const

/** Below this slice size, return a Buffer body instead of a stream — works around
 * Electron's malformed-ReadableStream bug (#41872) for the common small-range and
 * whole-audio case; large video still streams off disk. */
const BUFFER_BODY_THRESHOLD = 8 * 1024 * 1024

export function registerTwMediaProtocol(assetBaseDir: string): void {
  protocol.handle(TW_MEDIA_SCHEME, async (request) => {
    const asset = resolveTwMediaAsset(assetBaseDir, request.url)
    // Opaque 404 for bad-hash / unsupported-ext / missing / out-of-jail — no oracle.
    if (!asset) return new Response('Not found', { status: 404 })

    const baseHeaders: Record<string, string> = {
      'Content-Type': asset.mime,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      // The Content-Type is from a fixed image/audio/video allow-list (never an
      // active type), but nosniff forecloses any future ext-map drift becoming a
      // content-sniffing vector. Belt-and-suspenders, free.
      'X-Content-Type-Options': 'nosniff'
    }

    if (request.method === 'HEAD') {
      return new Response(null, {
        status: 200,
        headers: { ...baseHeaders, 'Content-Length': String(asset.size) }
      })
    }

    const range = resolveMediaRange(request.headers.get('Range'), asset.size)
    if (range.status === 416) {
      return new Response('Range not satisfiable', {
        status: 416,
        headers: { ...baseHeaders, 'Content-Range': range.contentRange ?? `bytes */${asset.size}` }
      })
    }

    const headers: Record<string, string> = {
      ...baseHeaders,
      'Content-Length': String(range.contentLength)
    }
    if (range.status === 206 && range.contentRange) headers['Content-Range'] = range.contentRange

    // Buffer body for small slices (dodges electron#41872 malformed-stream bug),
    // disk stream for large video. The cast bridges Node's Buffer/stream types to
    // the DOM BodyInit lib type — Electron's Response accepts both at runtime.
    const body: Buffer | ReadableStream =
      range.contentLength <= BUFFER_BODY_THRESHOLD
        ? readAssetSlice(asset.realPath, range.start, range.end)
        : (Readable.toWeb(
            fs.createReadStream(asset.realPath, { start: range.start, end: range.end })
          ) as unknown as ReadableStream)
    return new Response(body as unknown as BodyInit, { status: range.status, headers })
  })
}
