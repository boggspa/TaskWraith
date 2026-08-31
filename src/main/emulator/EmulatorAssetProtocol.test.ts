import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createEmulatorAssetRegistry, emulatorEntryUrl } from './EmulatorAssetManifest'
import {
  EMULATOR_DOCUMENT_CSP,
  registerEmulatorAssetProtocol,
  TWEMU_PRIVILEGE,
  type EmulatorAssetProtocolHandler,
  type EmulatorSessionProtocol
} from './EmulatorAssetProtocol'

function hash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function fakeSessionProtocol() {
  let handler: EmulatorAssetProtocolHandler | null = null
  const protocol = {
    handle: vi.fn(async (scheme: string, next: EmulatorAssetProtocolHandler) => {
      expect(scheme).toBe('twemu')
      handler = next
    }),
    unhandle: vi.fn(async (scheme: string) => {
      expect(scheme).toBe('twemu')
    })
  } satisfies EmulatorSessionProtocol
  return { protocol, handler: () => handler }
}

function registeredHandler(
  session: ReturnType<typeof fakeSessionProtocol>
): EmulatorAssetProtocolHandler {
  const handler = session.handler()
  expect(handler).toBeTypeOf('function')
  if (!handler) throw new Error('twemu protocol handler was not registered')
  return handler
}

describe('registerEmulatorAssetProtocol', () => {
  let root: string
  let registry: ReturnType<typeof createEmulatorAssetRegistry>
  let session: ReturnType<typeof fakeSessionProtocol>

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-twemu-protocol-'))
    const index = Buffer.from('<!doctype html><title>Homebrew</title>')
    const runtime = Buffer.from('export const boot = true')
    fs.writeFileSync(path.join(root, 'index.html'), index)
    fs.writeFileSync(path.join(root, 'runtime.js'), runtime)
    registry = createEmulatorAssetRegistry([
      {
        rootPath: root,
        manifest: {
          schemaVersion: 1,
          gameId: 'homebrew-demo',
          entryPath: 'index.html',
          assets: [
            {
              path: 'index.html',
              sha256: hash(index),
              byteLength: index.byteLength,
              mimeType: 'text/html'
            },
            {
              path: 'runtime.js',
              sha256: hash(runtime),
              byteLength: runtime.byteLength,
              mimeType: 'application/javascript'
            }
          ]
        }
      }
    ])
    session = fakeSessionProtocol()
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('serves only a listed entry page with strict CSP and public-package posture', async () => {
    await registerEmulatorAssetProtocol(session.protocol, registry)
    const response = await registeredHandler(session)(
      new Request(emulatorEntryUrl('homebrew-demo'))
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8')
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(response.headers.get('Cross-Origin-Resource-Policy')).toBe('same-origin')
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull()
    expect(response.headers.get('Content-Security-Policy')).toBe(EMULATOR_DOCUMENT_CSP)
    expect(EMULATOR_DOCUMENT_CSP).toContain("default-src 'none'")
    expect(EMULATOR_DOCUMENT_CSP).toContain("connect-src 'self'")
    expect(EMULATOR_DOCUMENT_CSP).toContain("frame-src 'none'")
    expect(EMULATOR_DOCUMENT_CSP).toContain("worker-src 'none'")
    expect(EMULATOR_DOCUMENT_CSP).not.toContain("'unsafe-eval'")
    expect(await response.text()).toContain('Homebrew')
  })

  it('returns a bodyless HEAD response with the same authoritative metadata', async () => {
    await registerEmulatorAssetProtocol(session.protocol, registry)
    const response = await registeredHandler(session)(
      new Request(emulatorEntryUrl('homebrew-demo'), { method: 'HEAD' })
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Length')).toBe(
      String('<!doctype html><title>Homebrew</title>'.length)
    )
    expect(response.headers.get('Content-Security-Policy')).toBe(EMULATOR_DOCUMENT_CSP)
    expect(await response.text()).toBe('')
  })

  it('uses fixed MIME metadata for non-document assets without widening CSP', async () => {
    await registerEmulatorAssetProtocol(session.protocol, registry)
    const response = await registeredHandler(session)(
      new Request('twemu://app/homebrew-demo/runtime.js')
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('application/javascript; charset=utf-8')
    expect(response.headers.get('Content-Security-Policy')).toBeNull()
    expect(await response.text()).toBe('export const boot = true')
  })

  it('returns one opaque 404 for writes, remote URLs, traversal, and unlisted assets', async () => {
    await registerEmulatorAssetProtocol(session.protocol, registry)
    const handler = registeredHandler(session)
    for (const request of [
      new Request(emulatorEntryUrl('homebrew-demo'), { method: 'POST' }),
      new Request('https://example.test/index.html'),
      new Request('twemu://app/homebrew-demo/../index.html'),
      new Request('twemu://app/homebrew-demo/missing.wasm')
    ]) {
      const response = await handler(request)
      expect(response.status).toBe(404)
      expect(await response.text()).toBe('Not found')
    }
  })

  it('binds and coalesces concurrent unregistration on only the injected Canvas session protocol', async () => {
    const registration = await registerEmulatorAssetProtocol(session.protocol, registry)
    expect(session.protocol.handle).toHaveBeenCalledTimes(1)
    expect(session.protocol.unhandle).not.toHaveBeenCalled()

    await Promise.all([registration.unregister(), registration.unregister()])
    await registration.unregister()
    expect(session.protocol.unhandle).toHaveBeenCalledTimes(1)
  })

  it('keeps a failed unhandle retryable instead of reporting false cleanup', async () => {
    session.protocol.unhandle.mockRejectedValueOnce(new Error('session busy'))
    const registration = await registerEmulatorAssetProtocol(session.protocol, registry)

    await expect(registration.unregister()).rejects.toThrow('session busy')
    await expect(registration.unregister()).resolves.toBeUndefined()
    expect(session.protocol.unhandle).toHaveBeenCalledTimes(2)
  })

  it('declares an isolated, non-worker, non-service-worker origin before app readiness', () => {
    expect(TWEMU_PRIVILEGE).toMatchObject({
      scheme: 'twemu',
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        allowServiceWorkers: false,
        bypassCSP: false,
        corsEnabled: false
      }
    })
  })
})
