/**
 * Electron wiring for the closed `twemu://app` packaged-emulator bundle.
 *
 * The resolver is intentionally pure and injectable. This thin layer accepts
 * only GET/HEAD, maps every failure to the same 404, and never falls back to a
 * remote URL, filesystem URL, or unlisted resource.
 */
import { protocol } from 'electron'
import {
  resolveEmulatorAsset,
  TWEMU_SCHEME,
  type EmulatorAssetMimeType,
  type EmulatorAssetRegistry
} from './EmulatorAssetManifest'

export { TWEMU_SCHEME }

/** Registered synchronously before Electron app readiness in bootstrap.ts. */
export const TWEMU_PRIVILEGE = {
  scheme: TWEMU_SCHEME,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    allowServiceWorkers: false,
    bypassCSP: false,
    corsEnabled: false
  }
} as const

const DOCUMENT_CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "connect-src 'self'",
  "font-src 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "frame-src 'none'",
  "img-src 'self' data:",
  "media-src 'none'",
  "object-src 'none'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self'",
  "worker-src 'none'"
].join('; ')

function contentType(mimeType: EmulatorAssetMimeType): string {
  return mimeType === 'text/html' ||
    mimeType === 'text/css' ||
    mimeType === 'application/javascript'
    ? `${mimeType}; charset=utf-8`
    : mimeType
}

function notFound(): Response {
  return new Response('Not found', { status: 404 })
}

/** Register after Electron is ready; privilege registration is deliberately pre-ready. */
export function registerEmulatorAssetProtocol(registry: EmulatorAssetRegistry): void {
  protocol.handle(TWEMU_SCHEME, async (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') return notFound()
    const asset = resolveEmulatorAsset(registry, request.url)
    if (!asset) return notFound()

    const headers: Record<string, string> = {
      'Content-Type': contentType(asset.mimeType),
      'Content-Length': String(asset.bytes.byteLength),
      'Cache-Control': 'no-store',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'X-Content-Type-Options': 'nosniff'
    }
    if (asset.mimeType === 'text/html') headers['Content-Security-Policy'] = DOCUMENT_CSP
    if (request.method === 'HEAD') return new Response(null, { status: 200, headers })
    return new Response(asset.bytes as unknown as BodyInit, { status: 200, headers })
  })
}

export const EMULATOR_DOCUMENT_CSP = DOCUMENT_CSP
