/**
 * Session-scoped Electron wiring for the closed `twemu://app` package bundle.
 *
 * The resolver is intentionally pure and injectable. Each Canvas gets an
 * isolated in-memory Electron session, so registering on the global/default
 * protocol registry is insufficient. This layer attaches only to the exact
 * session protocol passed by the runtime bridge, accepts GET/HEAD, maps every
 * failure to the same 404, and never falls back to a remote URL, filesystem URL,
 * or unlisted resource.
 */
import {
  resolveEmulatorAsset,
  TWEMU_SCHEME,
  type EmulatorAssetMimeType,
  type EmulatorAssetRegistry
} from './EmulatorAssetManifest'

export { TWEMU_SCHEME }

export type EmulatorAssetProtocolHandler = (request: Request) => Response | Promise<Response>

/** Narrow Electron `session.protocol` seam; production passes this exact instance. */
export interface EmulatorSessionProtocol {
  handle(scheme: string, handler: EmulatorAssetProtocolHandler): void | Promise<void>
  unhandle(scheme: string): void | Promise<void>
}

export interface EmulatorAssetProtocolRegistration {
  unregister(): Promise<void>
}

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
  const value = String(mimeType)
  return value.startsWith('text/') ||
    value === 'application/javascript' ||
    value === 'application/json'
    ? `${value}; charset=utf-8`
    : value
}

function notFound(): Response {
  return new Response('Not found', { status: 404 })
}

/**
 * Register after Electron is ready on the exact Canvas session. The returned
 * idempotent disposer must run before a surface is destroyed or abandoned.
 */
export async function registerEmulatorAssetProtocol(
  sessionProtocol: EmulatorSessionProtocol,
  registry: EmulatorAssetRegistry
): Promise<EmulatorAssetProtocolRegistration> {
  const handler: EmulatorAssetProtocolHandler = async (request) => {
    try {
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
    } catch {
      return notFound()
    }
  }
  await sessionProtocol.handle(TWEMU_SCHEME, handler)
  let active = true
  let unregistering: Promise<void> | null = null
  return {
    unregister(): Promise<void> {
      if (!active) return Promise.resolve()
      if (unregistering) return unregistering
      unregistering = Promise.resolve(sessionProtocol.unhandle(TWEMU_SCHEME)).then(
        () => {
          active = false
        },
        (error) => {
          unregistering = null
          throw error
        }
      )
      return unregistering
    }
  }
}

export const EMULATOR_DOCUMENT_CSP = DOCUMENT_CSP
