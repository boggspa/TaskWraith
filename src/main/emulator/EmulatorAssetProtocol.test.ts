import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createEmulatorAssetRegistry, emulatorEntryUrl } from './EmulatorAssetManifest'
import {
  EMULATOR_DOCUMENT_CSP,
  registerEmulatorAssetProtocol,
  TWEMU_PRIVILEGE
} from './EmulatorAssetProtocol'

vi.mock('electron', () => ({ protocol: { handle: vi.fn() } }))

import { protocol } from 'electron'

type ProtocolHandler = (request: Request) => Promise<Response>

function hash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function registeredHandler(): ProtocolHandler {
  const handler = vi.mocked(protocol.handle).mock.calls.at(-1)?.[1] as ProtocolHandler | undefined
  expect(handler).toBeTypeOf('function')
  if (!handler) throw new Error('twemu protocol handler was not registered')
  return handler
}

describe('registerEmulatorAssetProtocol', () => {
  let root: string
  let registry: ReturnType<typeof createEmulatorAssetRegistry>

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
    vi.mocked(protocol.handle).mockReset()
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('serves only a listed entry page with strict CSP and public-package posture', async () => {
    registerEmulatorAssetProtocol(registry)
    const response = await registeredHandler()(new Request(emulatorEntryUrl('homebrew-demo')))

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
    registerEmulatorAssetProtocol(registry)
    const response = await registeredHandler()(
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
    registerEmulatorAssetProtocol(registry)
    const response = await registeredHandler()(new Request('twemu://app/homebrew-demo/runtime.js'))

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('application/javascript; charset=utf-8')
    expect(response.headers.get('Content-Security-Policy')).toBeNull()
    expect(await response.text()).toBe('export const boot = true')
  })

  it('returns one opaque 404 for writes, remote URLs, traversal, and unlisted assets', async () => {
    registerEmulatorAssetProtocol(registry)
    const handler = registeredHandler()
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
