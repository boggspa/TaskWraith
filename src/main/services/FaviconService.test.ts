import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FaviconService } from './FaviconService'

const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d
])

let tempDirs: string[] = []

function makeCacheDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'taskwraith-favicon-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
  tempDirs = []
})

describe('FaviconService', () => {
  it('fetches a declared favicon through the main-process cache', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === 'https://example.com/') {
        return new Response(
          '<html><head><title>Example Site</title><link rel="icon" href="/icon.png"></head></html>',
          { headers: { 'content-type': 'text/html' } }
        )
      }
      if (url === 'https://example.com/icon.png') {
        return new Response(PNG_BYTES, {
          headers: { 'content-type': 'image/png' }
        })
      }
      return new Response('', { status: 404 })
    })
    const service = new FaviconService({
      cacheDir: makeCacheDir(),
      fetchImpl,
      resolveHost: async () => ['93.184.216.34'],
      now: () => 1_000
    })

    const result = await service.getForUrl('https://example.com/docs/readme')

    expect(result).toMatchObject({
      ok: true,
      host: 'example.com',
      iconUrl: 'https://example.com/icon.png',
      contentType: 'image/png',
      source: 'network',
      title: 'Example Site'
    })
    expect(result.ok ? result.dataUrl : '').toMatch(/^data:image\/png;base64,/)
  })

  it('serves a cached favicon without refetching', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === 'https://example.com/') {
        return new Response('<link rel="icon" href="/icon.png">', {
          headers: { 'content-type': 'text/html' }
        })
      }
      return new Response(PNG_BYTES, { headers: { 'content-type': 'image/png' } })
    })
    const cacheDir = makeCacheDir()
    const service = new FaviconService({
      cacheDir,
      fetchImpl,
      resolveHost: async () => ['93.184.216.34'],
      now: () => 1_000
    })

    await expect(service.getForUrl('https://example.com')).resolves.toMatchObject({ ok: true })
    fetchImpl.mockClear()
    await expect(service.getForUrl('https://example.com/path')).resolves.toMatchObject({
      ok: true,
      source: 'cache'
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('blocks localhost, private addresses, unsafe schemes, and private DNS results', async () => {
    const fetchImpl = vi.fn()
    const service = new FaviconService({
      cacheDir: makeCacheDir(),
      fetchImpl,
      resolveHost: async () => ['192.168.1.5']
    })

    await expect(service.getForUrl('http://localhost:3000')).resolves.toMatchObject({
      ok: false,
      blocked: true
    })
    await expect(service.getForUrl('file:///tmp/index.html')).resolves.toMatchObject({
      ok: false,
      blocked: true
    })
    await expect(service.getForUrl('https://internal.example.test')).resolves.toMatchObject({
      ok: false,
      blocked: true
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('rejects SVG favicons rather than handing remote SVG to the renderer', async () => {
    const service = new FaviconService({
      cacheDir: makeCacheDir(),
      fetchImpl: vi.fn(async (url: string) => {
        if (url === 'https://example.com/') {
          return new Response('<link rel="icon" href="/favicon.svg">', {
            headers: { 'content-type': 'text/html' }
          })
        }
        return new Response('<svg><script>alert(1)</script></svg>', {
          headers: { 'content-type': 'image/svg+xml' }
        })
      }),
      resolveHost: async () => ['93.184.216.34']
    })

    await expect(service.getForUrl('https://example.com')).resolves.toMatchObject({
      ok: false,
      error: 'No supported favicon found.'
    })
  })

  it('does not follow public favicon redirects to localhost/private targets', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === 'https://example.com/') {
        return new Response('<link rel="icon" href="/icon.png">', {
          headers: { 'content-type': 'text/html' }
        })
      }
      if (url === 'https://example.com/icon.png') {
        return new Response('', {
          status: 302,
          headers: { location: 'http://127.0.0.1:3000/secret.png' }
        })
      }
      return new Response('', { status: 404 })
    })
    const service = new FaviconService({
      cacheDir: makeCacheDir(),
      fetchImpl,
      resolveHost: async (host) =>
        host === 'example.com' ? ['93.184.216.34'] : ['127.0.0.1']
    })

    await expect(service.getForUrl('https://example.com')).resolves.toMatchObject({
      ok: false,
      error: 'No supported favicon found.'
    })
    expect(fetchImpl.mock.calls.map(([url]) => url)).not.toContain(
      'http://127.0.0.1:3000/secret.png'
    )
  })

  it('does not follow page metadata redirects to link-local metadata services', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === 'https://example.com/') {
        return new Response('', {
          status: 302,
          headers: { location: 'http://169.254.169.254/latest/meta-data/' }
        })
      }
      if (url === 'https://example.com/favicon.ico') {
        return new Response(PNG_BYTES, { headers: { 'content-type': 'image/png' } })
      }
      return new Response('', { status: 404 })
    })
    const service = new FaviconService({
      cacheDir: makeCacheDir(),
      fetchImpl,
      resolveHost: async (host) =>
        host === 'example.com' ? ['93.184.216.34'] : ['169.254.169.254']
    })

    await expect(service.getForUrl('https://example.com')).resolves.toMatchObject({
      ok: true,
      iconUrl: 'https://example.com/favicon.ico'
    })
    expect(fetchImpl.mock.calls.map(([url]) => url)).not.toContain(
      'http://169.254.169.254/latest/meta-data/'
    )
  })
})
