import { createHash } from 'crypto'
import { lookup } from 'dns/promises'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { request as httpRequest } from 'http'
import { request as httpsRequest } from 'https'
import { join } from 'path'
import { isIP, type LookupFunction } from 'net'
import { Readable } from 'stream'

export interface FaviconInfo {
  ok: true
  origin: string
  host: string
  iconUrl: string
  dataUrl: string
  contentType: string
  source: 'cache' | 'network'
  title?: string
}

export interface FaviconUnavailable {
  ok: false
  origin?: string
  host?: string
  blocked?: boolean
  error: string
}

export type FaviconResult = FaviconInfo | FaviconUnavailable

interface PinnedConnection {
  address: string
  family: 4 | 6
}

type FetchLike = (
  url: string,
  init?: RequestInit,
  connection?: PinnedConnection
) => Promise<Response>
type ResolveHost = (host: string) => Promise<string[]>

interface FaviconServiceOptions {
  cacheDir: string
  fetchImpl?: FetchLike
  resolveHost?: ResolveHost
  now?: () => number
  fetchTimeoutMs?: number
  maxConcurrentFetches?: number
  maxPendingRequests?: number
  maxPageBytes?: number
  maxIconBytes?: number
}

interface CachedFaviconMeta {
  origin: string
  host: string
  iconUrl: string
  contentType: string
  title?: string
  cachedAt: number
  fileName: string
}

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000
const MAX_ICON_BYTES = 256 * 1024
const MAX_PAGE_BYTES = 400_000
const FETCH_TIMEOUT_MS = 4000
const MAX_CONCURRENT_FETCHES = 4
const MAX_PENDING_REQUESTS = 32
const MAX_REDIRECTS = 5
const ALLOWED_IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/gif',
  'image/bmp',
  'image/x-icon',
  'image/vnd.microsoft.icon'
])
const BLOCKED_HOSTS = new Set(['localhost', 'localhost.localdomain'])

interface FetchedResource {
  status: number
  ok: boolean
  headers: Headers
  url: string
  bytes: Buffer
}

type PublicHostResolution =
  | { ok: true; connections: PinnedConnection[] }
  | { ok: false; error: string }

export class FaviconService {
  private readonly cacheDir: string
  private readonly fetchImpl: FetchLike
  private readonly resolveHost: ResolveHost
  private readonly now: () => number
  private readonly fetchTimeoutMs: number
  private readonly maxConcurrentFetches: number
  private readonly maxPendingRequests: number
  private readonly maxPageBytes: number
  private readonly maxIconBytes: number
  private activeFetches = 0
  private readonly fetchWaiters: Array<() => void> = []

  constructor(options: FaviconServiceOptions) {
    this.cacheDir = options.cacheDir
    this.fetchImpl = options.fetchImpl || fetchPinned
    this.resolveHost =
      options.resolveHost ||
      (async (host) => {
        const records = await lookup(host, { all: true, verbatim: true })
        return records.map((record) => record.address)
      })
    this.now = options.now || Date.now
    this.fetchTimeoutMs = options.fetchTimeoutMs ?? FETCH_TIMEOUT_MS
    this.maxConcurrentFetches = Math.max(
      1,
      Math.floor(options.maxConcurrentFetches ?? MAX_CONCURRENT_FETCHES)
    )
    this.maxPendingRequests = Math.max(
      0,
      Math.floor(options.maxPendingRequests ?? MAX_PENDING_REQUESTS)
    )
    this.maxPageBytes = Math.max(1, Math.floor(options.maxPageBytes ?? MAX_PAGE_BYTES))
    this.maxIconBytes = Math.max(1, Math.floor(options.maxIconBytes ?? MAX_ICON_BYTES))
  }

  async getForUrl(input: string): Promise<FaviconResult> {
    if (!(await this.acquireFetchSlot())) {
      return { ok: false, error: 'Too many favicon requests are already pending.' }
    }
    try {
      return await this.getForUrlWithSlot(input)
    } finally {
      this.releaseFetchSlot()
    }
  }

  private async getForUrlWithSlot(input: string): Promise<FaviconResult> {
    const normalized = normalizeFaviconTarget(input)
    if (!normalized.ok) return normalized
    const safety = await this.resolvePublicHost(normalized.url.hostname)
    if (!safety.ok) {
      return {
        ok: false,
        origin: normalized.origin,
        host: normalized.host,
        blocked: true,
        error: safety.error
      }
    }

    await mkdir(this.cacheDir, { recursive: true })
    const cacheKey = hashOrigin(normalized.origin)
    const cached = await this.readCache(cacheKey)
    if (cached && this.now() - cached.cachedAt < CACHE_TTL_MS) {
      const body = await readFile(join(this.cacheDir, cached.fileName)).catch(() => null)
      if (body) {
        return {
          ok: true,
          origin: cached.origin,
          host: cached.host,
          iconUrl: cached.iconUrl,
          dataUrl: toDataUrl(cached.contentType, body),
          contentType: cached.contentType,
          source: 'cache',
          ...(cached.title ? { title: cached.title } : {})
        }
      }
    }

    const page = await this.fetchPageMetadata(normalized.origin)
    const candidates = uniqueStrings([
      ...page.iconHrefs.map((href) => resolveCandidateUrl(href, normalized.origin)),
      `${normalized.origin}/favicon.ico`,
      `${normalized.origin}/favicon.png`,
      `${normalized.origin}/apple-touch-icon.png`
    ]).filter((candidate): candidate is string => Boolean(candidate))

    for (const candidate of candidates) {
      const icon = await this.fetchIcon(candidate)
      if (!icon) continue
      const fileName = `${cacheKey}${extensionForContentType(icon.contentType)}`
      await writeFile(join(this.cacheDir, fileName), icon.bytes)
      const meta: CachedFaviconMeta = {
        origin: normalized.origin,
        host: normalized.host,
        iconUrl: candidate,
        contentType: icon.contentType,
        cachedAt: this.now(),
        fileName,
        ...(page.title ? { title: page.title } : {})
      }
      await writeFile(join(this.cacheDir, `${cacheKey}.json`), JSON.stringify(meta, null, 2))
      return {
        ok: true,
        origin: normalized.origin,
        host: normalized.host,
        iconUrl: candidate,
        dataUrl: toDataUrl(icon.contentType, icon.bytes),
        contentType: icon.contentType,
        source: 'network',
        ...(page.title ? { title: page.title } : {})
      }
    }

    return {
      ok: false,
      origin: normalized.origin,
      host: normalized.host,
      error: 'No supported favicon found.'
    }
  }

  private async readCache(cacheKey: string): Promise<CachedFaviconMeta | null> {
    try {
      const raw = await readFile(join(this.cacheDir, `${cacheKey}.json`), 'utf8')
      const parsed = JSON.parse(raw) as Partial<CachedFaviconMeta>
      if (
        typeof parsed.origin !== 'string' ||
        typeof parsed.host !== 'string' ||
        typeof parsed.iconUrl !== 'string' ||
        typeof parsed.contentType !== 'string' ||
        typeof parsed.cachedAt !== 'number' ||
        typeof parsed.fileName !== 'string'
      ) {
        return null
      }
      return parsed as CachedFaviconMeta
    } catch {
      return null
    }
  }

  private async resolvePublicHost(host: string): Promise<PublicHostResolution> {
    const normalized = host.trim().toLowerCase()
    if (!normalized || BLOCKED_HOSTS.has(normalized) || normalized.endsWith('.local')) {
      return { ok: false, error: 'Local and private hosts are not eligible for favicon fetches.' }
    }

    if (isIP(normalized)) {
      return isPrivateAddress(normalized)
        ? { ok: false, error: 'Private network addresses are blocked.' }
        : {
            ok: true,
            connections: [{ address: normalized, family: isIP(normalized) as 4 | 6 }]
          }
    }

    let addresses: string[] = []
    try {
      addresses = await this.resolveHost(normalized)
    } catch {
      return { ok: false, error: 'Host could not be resolved safely.' }
    }
    if (
      addresses.length === 0 ||
      addresses.some((address) => isPrivateAddress(address) || !isIP(address))
    ) {
      return { ok: false, error: 'Host resolves to a private or unavailable address.' }
    }
    return {
      ok: true,
      connections: uniqueStrings(addresses).map((address) => ({
        address,
        family: isIP(address) as 4 | 6
      }))
    }
  }

  private async fetchPageMetadata(
    origin: string
  ): Promise<{ iconHrefs: string[]; title?: string }> {
    const response = await this.fetchPublicWithRedirects(
      origin,
      {
        headers: { Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1' }
      },
      this.maxPageBytes
    ).catch(() => null)
    const contentType = response?.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
    if (!response?.ok || !contentType?.includes('text/html')) return { iconHrefs: [] }
    return parsePageMetadata(response.bytes.toString('utf8'))
  }

  private async fetchIcon(url: string): Promise<{ bytes: Buffer; contentType: string } | null> {
    const normalized = normalizeFaviconTarget(url)
    if (!normalized.ok) return null
    const response = await this.fetchPublicWithRedirects(
      normalized.url.toString(),
      {
        headers: {
          Accept: 'image/avif,image/webp,image/png,image/jpeg,image/x-icon,image/*;q=0.8'
        }
      },
      this.maxIconBytes
    ).catch(() => null)
    if (!response?.ok) return null
    const finalUrl = normalizeFaviconTarget(response.url)
    if (!finalUrl.ok) return null
    if (response.bytes.byteLength === 0) {
      return null
    }
    const bytes = response.bytes
    const contentType =
      normalizeImageContentType(response.headers.get('content-type')) ||
      inferImageContentType(finalUrl.url.pathname, bytes)
    if (!contentType || !ALLOWED_IMAGE_TYPES.has(contentType)) return null
    return { bytes, contentType }
  }

  private async fetchPublicWithRedirects(
    url: string,
    init: RequestInit,
    maxBytes: number,
    redirects = 0
  ): Promise<FetchedResource | null> {
    if (redirects > MAX_REDIRECTS) return null
    const normalized = normalizeFaviconTarget(url)
    if (!normalized.ok) return null
    const safety = await this.resolvePublicHost(normalized.url.hostname)
    if (!safety.ok) return null
    const response = await this.fetchWithTimeout(
      normalized.url.toString(),
      init,
      safety.connections,
      maxBytes
    )
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (!location) return null
      let nextUrl: string
      try {
        nextUrl = new URL(location, normalized.url).toString()
      } catch {
        return null
      }
      return this.fetchPublicWithRedirects(nextUrl, init, maxBytes, redirects + 1)
    }
    return response
  }

  private async fetchWithTimeout(
    url: string,
    init: RequestInit,
    connections: PinnedConnection[],
    maxBytes: number
  ): Promise<FetchedResource> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.fetchTimeoutMs)
    try {
      let lastError: unknown
      for (const connection of connections) {
        try {
          const response = await waitForAbort(
            this.fetchImpl(
              url,
              {
                ...init,
                redirect: 'manual',
                credentials: 'omit',
                signal: controller.signal
              },
              connection
            ),
            controller.signal
          )
          if (response.status >= 300 && response.status < 400) {
            await response.body?.cancel().catch(() => undefined)
            return {
              status: response.status,
              ok: response.ok,
              headers: new Headers(response.headers),
              url,
              bytes: Buffer.alloc(0)
            }
          }
          const bytes = await readBoundedResponseBody(response, maxBytes, controller.signal)
          return {
            status: response.status,
            ok: response.ok,
            headers: new Headers(response.headers),
            url,
            bytes
          }
        } catch (error) {
          lastError = error
          if (controller.signal.aborted || error instanceof ResponseBodyLimitError) throw error
        }
      }
      throw lastError instanceof Error ? lastError : new Error('Favicon fetch failed.')
    } finally {
      clearTimeout(timeout)
      controller.abort()
    }
  }

  private async acquireFetchSlot(): Promise<boolean> {
    if (this.activeFetches < this.maxConcurrentFetches) {
      this.activeFetches += 1
      return true
    }
    if (this.fetchWaiters.length >= this.maxPendingRequests) return false
    await new Promise<void>((resolve) => this.fetchWaiters.push(resolve))
    return true
  }

  private releaseFetchSlot(): void {
    const next = this.fetchWaiters.shift()
    if (next) {
      next()
      return
    }
    this.activeFetches = Math.max(0, this.activeFetches - 1)
  }
}

class ResponseBodyLimitError extends Error {}

async function readBoundedResponseBody(
  response: Response,
  maxBytes: number,
  signal: AbortSignal
): Promise<Buffer> {
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel().catch(() => undefined)
    throw new ResponseBodyLimitError('Response body exceeded the allowed size.')
  }
  if (!response.body) return Buffer.alloc(0)

  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let received = 0
  let completed = false
  try {
    while (true) {
      const chunk = await readStreamChunk(reader, signal)
      if (chunk.done) {
        completed = true
        return Buffer.concat(chunks, received)
      }
      const bytes = Buffer.from(chunk.value)
      received += bytes.byteLength
      if (received > maxBytes) {
        throw new ResponseBodyLimitError('Response body exceeded the allowed size.')
      }
      chunks.push(bytes)
    }
  } finally {
    if (!completed) await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

function readStreamChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal
): Promise<ReadableStreamReadResult<Uint8Array>> {
  return waitForAbort(reader.read(), signal)
}

function waitForAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(createAbortError())
  return new Promise((resolve, reject) => {
    let settled = false
    const settle = (callback: () => void): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      callback()
    }
    const onAbort = (): void => settle(() => reject(createAbortError()))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (result) => settle(() => resolve(result)),
      (error) => settle(() => reject(error))
    )
  })
}

function createAbortError(): Error {
  const error = new Error('Favicon fetch timed out.')
  error.name = 'AbortError'
  return error
}

function fetchPinned(
  url: string,
  init: RequestInit = {},
  connection?: PinnedConnection
): Promise<Response> {
  if (!connection) return Promise.reject(new Error('A validated address is required.'))
  const target = new URL(url)
  const requestImpl = target.protocol === 'https:' ? httpsRequest : httpRequest
  const headers = new Headers(init.headers)
  headers.set('Accept-Encoding', 'identity')
  const lookupPinnedAddress: LookupFunction = (_hostname, options, callback) => {
    if (options.all) {
      callback(null, [connection])
      return
    }
    callback(null, connection.address, connection.family)
  }

  return new Promise((resolve, reject) => {
    const request = requestImpl(
      target,
      {
        method: init.method || 'GET',
        headers: Object.fromEntries(headers.entries()),
        lookup: lookupPinnedAddress,
        agent: false,
        maxHeaderSize: 16 * 1024,
        signal: init.signal || undefined
      },
      (incoming) => {
        const peerAddress = incoming.socket.remoteAddress
        if (!peerAddress || !sameNetworkAddress(peerAddress, connection.address)) {
          incoming.destroy()
          reject(new Error('The favicon peer did not match its validated address.'))
          return
        }

        try {
          const headers = new Headers()
          for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
            headers.append(incoming.rawHeaders[index], incoming.rawHeaders[index + 1])
          }
          const status = incoming.statusCode || 0
          const bodyAllowed = status !== 204 && status !== 205 && status !== 304
          const body = bodyAllowed ? (Readable.toWeb(incoming) as unknown as BodyInit) : null
          resolve(
            new Response(body, {
              status,
              statusText: incoming.statusMessage,
              headers
            })
          )
        } catch (error) {
          incoming.destroy()
          reject(error)
        }
      }
    )
    request.on('error', reject)
    request.end()
  })
}

function sameNetworkAddress(left: string, right: string): boolean {
  const normalize = (value: string): string => {
    const withoutZone = value.trim().toLowerCase().split('%')[0]
    return withoutZone.startsWith('::ffff:') ? withoutZone.slice('::ffff:'.length) : withoutZone
  }
  return normalize(left) === normalize(right)
}

function normalizeFaviconTarget(
  input: string
): { ok: true; url: URL; origin: string; host: string } | FaviconUnavailable {
  try {
    const raw = String(input || '').trim()
    if (!raw) return { ok: false, error: 'Missing URL.' }
    const url = new URL(raw)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return { ok: false, blocked: true, error: 'Only HTTP(S) URLs support favicons.' }
    }
    url.username = ''
    url.password = ''
    url.hash = ''
    const origin = url.origin
    return { ok: true, url, origin, host: url.hostname.replace(/^www\./i, '') }
  } catch {
    return { ok: false, error: 'Invalid URL.' }
  }
}

function parsePageMetadata(html: string): { iconHrefs: string[]; title?: string } {
  const iconHrefs: string[] = []
  const linkRegex = /<link\b[^>]*>/gi
  let match: RegExpExecArray | null
  while ((match = linkRegex.exec(html)) !== null) {
    const attrs = parseHtmlAttrs(match[0])
    const rel = attrs.rel?.toLowerCase() || ''
    if (!rel.includes('icon')) continue
    const href = attrs.href?.trim()
    if (href && !/^data:/i.test(href) && !/^javascript:/i.test(href)) iconHrefs.push(href)
  }
  const title = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]
  return {
    iconHrefs: uniqueStrings(iconHrefs),
    ...(title ? { title: decodeHtmlText(title).slice(0, 120) } : {})
  }
}

function parseHtmlAttrs(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  const attrRegex = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g
  let match: RegExpExecArray | null
  while ((match = attrRegex.exec(tag)) !== null) {
    attrs[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? ''
  }
  return attrs
}

function decodeHtmlText(value: string): string {
  return value
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

function resolveCandidateUrl(href: string, origin: string): string | null {
  try {
    return new URL(href, origin).toString()
  } catch {
    return null
  }
}

function normalizeImageContentType(value: string | null): string | null {
  const contentType = value?.split(';')[0]?.trim().toLowerCase() || ''
  if (contentType === 'image/jpg') return 'image/jpeg'
  if (contentType === 'image/vnd.microsoft.icon') return 'image/x-icon'
  return contentType || null
}

function inferImageContentType(pathname: string, bytes: Buffer): string | null {
  const lower = pathname.toLowerCase()
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png'
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg'
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF') return 'image/webp'
  if (lower.endsWith('.ico')) return 'image/x-icon'
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.gif')) return 'image/gif'
  return null
}

function extensionForContentType(contentType: string): string {
  if (contentType === 'image/png') return '.png'
  if (contentType === 'image/jpeg' || contentType === 'image/jpg') return '.jpg'
  if (contentType === 'image/webp') return '.webp'
  if (contentType === 'image/gif') return '.gif'
  if (contentType === 'image/bmp') return '.bmp'
  return '.ico'
}

function toDataUrl(contentType: string, bytes: Buffer): string {
  return `data:${contentType};base64,${bytes.toString('base64')}`
}

function hashOrigin(origin: string): string {
  return createHash('sha256').update(origin).digest('hex').slice(0, 24)
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    const trimmed = value?.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    result.push(trimmed)
  }
  return result
}

function isPrivateAddress(address: string): boolean {
  const value = address.trim().toLowerCase()
  if (!value) return true
  if (value === '::1' || value === '0:0:0:0:0:0:0:1') return true
  if (value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe80:')) return true
  if (value.startsWith('::ffff:')) return isPrivateAddress(value.slice('::ffff:'.length))
  if (!value.includes('.')) return false

  const octets = value.split('.').map((part) => Number(part))
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part))) return true
  const [a, b] = octets
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  if (a >= 224) return true
  return false
}
