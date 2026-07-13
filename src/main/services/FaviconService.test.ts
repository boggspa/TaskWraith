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

  it('pins the validated public address instead of allowing a private fetch-time resolution', async () => {
    const secondResolution = vi.fn(() => '127.0.0.1')
    const pinnedAddresses: string[] = []
    let reachedPrivateAddress = false
    const fetchImpl = vi.fn(
      async (url: string, _init?: RequestInit, connection?: { address: string; family: 4 | 6 }) => {
        const transportAddress = connection?.address || secondResolution()
        pinnedAddresses.push(transportAddress)
        if (transportAddress === '127.0.0.1') reachedPrivateAddress = true
        if (url === 'https://example.com/') {
          return new Response('<link rel="icon" href="/icon.png">', {
            headers: { 'content-type': 'text/html' }
          })
        }
        return new Response(PNG_BYTES, { headers: { 'content-type': 'image/png' } })
      }
    )
    const service = new FaviconService({
      cacheDir: makeCacheDir(),
      fetchImpl,
      resolveHost: async () => ['93.184.216.34']
    })

    await expect(service.getForUrl('https://example.com')).resolves.toMatchObject({ ok: true })
    expect(secondResolution).not.toHaveBeenCalled()
    expect(reachedPrivateAddress).toBe(false)
    expect(pinnedAddresses).toEqual(['93.184.216.34', '93.184.216.34'])
  })

  it('does not connect when a host changes from a public to a private validation result', async () => {
    let resolutions = 0
    const fetchImpl = vi.fn()
    const service = new FaviconService({
      cacheDir: makeCacheDir(),
      fetchImpl,
      resolveHost: async () => [resolutions++ === 0 ? '93.184.216.34' : '127.0.0.1']
    })

    await expect(service.getForUrl('https://example.com')).resolves.toMatchObject({
      ok: false,
      error: 'No supported favicon found.'
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
      resolveHost: async (host) => (host === 'example.com' ? ['93.184.216.34'] : ['127.0.0.1'])
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

  it('bounds streamed page metadata before parsing declared icon links', async () => {
    let pageCancelled = false
    const oversizedHtml = new TextEncoder().encode(
      `${' '.repeat(80)}<link rel="icon" href="http://127.0.0.1/private.png">`
    )
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === 'https://example.com/') {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(oversizedHtml)
            },
            cancel() {
              pageCancelled = true
            }
          }),
          { headers: { 'content-type': 'text/html' } }
        )
      }
      if (url === 'https://example.com/favicon.ico') {
        return new Response(PNG_BYTES, { headers: { 'content-type': 'image/png' } })
      }
      return new Response('', { status: 404 })
    })
    const service = new FaviconService({
      cacheDir: makeCacheDir(),
      fetchImpl,
      resolveHost: async () => ['93.184.216.34'],
      maxPageBytes: 64
    })

    await expect(service.getForUrl('https://example.com')).resolves.toMatchObject({
      ok: true,
      iconUrl: 'https://example.com/favicon.ico'
    })
    expect(pageCancelled).toBe(true)
    expect(fetchImpl.mock.calls.map(([url]) => url)).not.toContain('http://127.0.0.1/private.png')
  })

  it('rejects and cancels oversized streamed icon bodies', async () => {
    let iconCancelled = false
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === 'https://example.com/') {
        return new Response('<link rel="icon" href="/huge.png">', {
          headers: { 'content-type': 'text/html' }
        })
      }
      if (url === 'https://example.com/huge.png') {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(65))
            },
            cancel() {
              iconCancelled = true
            }
          }),
          { headers: { 'content-type': 'image/png' } }
        )
      }
      return new Response('', { status: 404 })
    })
    const service = new FaviconService({
      cacheDir: makeCacheDir(),
      fetchImpl,
      resolveHost: async () => ['93.184.216.34'],
      maxIconBytes: 64
    })

    await expect(service.getForUrl('https://example.com')).resolves.toMatchObject({
      ok: false,
      error: 'No supported favicon found.'
    })
    expect(iconCancelled).toBe(true)
  })

  it('keeps the timeout armed through a never-ending response body and cancels it', async () => {
    let bodyCancelled = false
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === 'https://example.com/') {
        return new Response('<link rel="icon" href="/hanging.png">', {
          headers: { 'content-type': 'text/html' }
        })
      }
      if (url === 'https://example.com/hanging.png') {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(PNG_BYTES)
            },
            cancel() {
              bodyCancelled = true
            }
          }),
          { headers: { 'content-type': 'image/png' } }
        )
      }
      return new Response('', { status: 404 })
    })
    const service = new FaviconService({
      cacheDir: makeCacheDir(),
      fetchImpl,
      resolveHost: async () => ['93.184.216.34'],
      fetchTimeoutMs: 20
    })

    await expect(service.getForUrl('https://example.com')).resolves.toMatchObject({
      ok: false,
      error: 'No supported favicon found.'
    })
    expect(bodyCancelled).toBe(true)
  })

  it('caps simultaneous network fetches across concurrent favicon requests', async () => {
    let activeFetches = 0
    let peakFetches = 0
    const fetchImpl = vi.fn(async () => {
      activeFetches += 1
      peakFetches = Math.max(peakFetches, activeFetches)
      await new Promise((resolve) => setTimeout(resolve, 2))
      activeFetches -= 1
      return new Response('', { status: 404 })
    })
    const service = new FaviconService({
      cacheDir: makeCacheDir(),
      fetchImpl,
      resolveHost: async () => ['93.184.216.34'],
      maxConcurrentFetches: 2
    })

    await Promise.all(
      Array.from({ length: 5 }, (_, index) => service.getForUrl(`https://example${index}.com`))
    )
    expect(peakFetches).toBe(2)
  })

  it('fails fast when the bounded request queue is full', async () => {
    let releaseFirstFetch: () => void = () => undefined
    const firstFetchReleased = new Promise<void>((resolve) => {
      releaseFirstFetch = resolve
    })
    let reportFirstFetchStarted: () => void = () => undefined
    const firstFetchStarted = new Promise<void>((resolve) => {
      reportFirstFetchStarted = resolve
    })
    let fetchCount = 0
    const fetchImpl = vi.fn(async () => {
      fetchCount += 1
      if (fetchCount === 1) {
        reportFirstFetchStarted()
        await firstFetchReleased
      }
      return new Response('', { status: 404 })
    })
    const service = new FaviconService({
      cacheDir: makeCacheDir(),
      fetchImpl,
      resolveHost: async () => ['93.184.216.34'],
      maxConcurrentFetches: 1,
      maxPendingRequests: 1
    })

    const activeRequest = service.getForUrl('https://active.example.com')
    await firstFetchStarted
    const queuedRequest = service.getForUrl('https://queued.example.com')

    await expect(service.getForUrl('https://rejected.example.com')).resolves.toEqual({
      ok: false,
      error: 'Too many favicon requests are already pending.'
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    releaseFirstFetch()
    await Promise.all([activeRequest, queuedRequest])
  })
})
