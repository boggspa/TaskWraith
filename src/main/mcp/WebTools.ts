import { lookup } from 'dns/promises'
import { classifyCanvasHost } from '../canvas/canvasTypes'
import type { McpToolExecutionResult } from '../index.types'

export type WebMcpToolName = 'web_fetch' | 'web_search'

const MAX_WEB_TEXT_CHARS = 20_000
const WEB_TOOL_TIMEOUT_MS = 20_000
const MAX_FETCH_REDIRECTS = 5

/** Injectable IO seams so the SSRF guard + redirect-follow are unit-testable
 * without real network/DNS. Production uses global `fetch` + `dns.lookup`. */
export interface WebToolDeps {
  fetchImpl?: typeof fetch
  resolveHost?: (host: string) => Promise<string[]>
}

async function defaultResolveHost(host: string): Promise<string[]> {
  const records = await lookup(host, { all: true })
  return records.map((record) => record.address)
}

/** Thrown when a fetch target (or a redirect hop) is not a public internet
 * host. The message is deliberately instructive so the agent learns the
 * constraint instead of guessing. */
export class WebFetchBlockedError extends Error {
  constructor(
    readonly url: string,
    readonly reason: string
  ) {
    super(
      `blocked ${url}: resolves to a non-public address (${reason}). ` +
        'web_fetch/web_search may only reach public internet hosts — not localhost, ' +
        'private LAN ranges, link-local, or cloud-metadata endpoints.'
    )
    this.name = 'WebFetchBlockedError'
  }
}

export function isWebMcpToolName(toolName: string): toolName is WebMcpToolName {
  return toolName === 'web_fetch' || toolName === 'web_search'
}

/**
 * SSRF guard for the web tools. Allows ONLY public-internet destinations.
 * Validates in two layers: (1) classify the hostname string (catches IP
 * literals, NAT64/IPv4-mapped, and cloud-metadata DNS names via the shared
 * `classifyCanvasHost`); (2) resolve the hostname and classify EVERY returned
 * address (closes DNS-rebinding to a known-internal IP). There is NO allowlist —
 * a general web tool has no business reaching loopback or the LAN. Returns the
 * parsed URL on success; throws WebFetchBlockedError otherwise.
 *
 * Residual: a TOCTOU window remains between this lookup and the socket's own
 * resolution (true closure needs connection-pinning to the validated IP, which
 * undici/global fetch does not cleanly expose). This still defeats every
 * literal-IP / metadata-name / redirect-to-internal vector and rebinding to a
 * currently-internal address.
 */
export async function assertFetchTargetAllowed(
  rawUrl: string,
  resolveHost: (host: string) => Promise<string[]> = defaultResolveHost
): Promise<URL> {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new WebFetchBlockedError(rawUrl, 'invalid_url')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new WebFetchBlockedError(rawUrl, 'non_http_scheme')
  }
  const hostClass = classifyCanvasHost(parsed.hostname)
  if (hostClass !== 'public') {
    throw new WebFetchBlockedError(rawUrl, `host_${hostClass}`)
  }
  let addresses: string[]
  try {
    addresses = await resolveHost(parsed.hostname)
  } catch {
    throw new WebFetchBlockedError(rawUrl, 'dns_unresolved')
  }
  if (addresses.length === 0) {
    throw new WebFetchBlockedError(rawUrl, 'dns_empty')
  }
  for (const address of addresses) {
    const addrClass = classifyCanvasHost(address)
    if (addrClass !== 'public') {
      throw new WebFetchBlockedError(rawUrl, `resolved_${addrClass}`)
    }
  }
  return parsed
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => {
      const num = Number(code)
      return Number.isFinite(num) ? String.fromCodePoint(num) : ' '
    })
}

function htmlToText(value: string): string {
  return decodeHtmlEntities(
    value
      .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/\s+/g, ' ')
    .trim()
}

/** Strip a full HTML document down to its title + readable body text.
 * Drops `<head>`, scripts, styles, and other non-content noise so a model
 * receives prose instead of CSS/markup soup. Block-level tags become line
 * breaks so structure survives. */
function htmlDocumentToReadableText(html: string): { title: string; text: string } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  const title = titleMatch ? htmlToText(titleMatch[1]) : ''

  // Prefer the <body> when present so we skip <head> metadata/styles entirely.
  const bodyMatch = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)
  const source = bodyMatch ? bodyMatch[1] : html

  const withBreaks = source
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<\/(p|div|section|article|h[1-6]|li|tr|br|header|footer|nav|table)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')

  const text = decodeHtmlEntities(withBreaks)
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  return { title, text }
}

function looksLikeHtml(contentType: string, raw: string): boolean {
  if (/\b(?:text\/html|application\/xhtml\+xml)\b/i.test(contentType)) return true
  if (contentType) return false
  return /<html[\s>]|<!doctype html|<body[\s>]/i.test(raw)
}

function truncateWebText(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_WEB_TEXT_CHARS) return { text, truncated: false }
  return {
    text: `${text.slice(0, MAX_WEB_TEXT_CHARS)}\n...[truncated]`,
    truncated: true
  }
}

/** Fetch with an SSRF guard on the initial URL AND on every redirect hop.
 * `redirect: 'manual'` is mandatory: following redirects automatically would
 * let a public URL bounce to `169.254.169.254` (or localhost) after a 302 the
 * guard never sees. Each hop is re-validated through `assertFetchTargetAllowed`
 * before it is fetched. */
async function safeFetch(url: string, userAgent: string, deps: WebToolDeps): Promise<Response> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const resolveHost = deps.resolveHost ?? defaultResolveHost
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), WEB_TOOL_TIMEOUT_MS)
  try {
    let currentUrl = url
    for (let hop = 0; hop <= MAX_FETCH_REDIRECTS; hop += 1) {
      await assertFetchTargetAllowed(currentUrl, resolveHost)
      const response = await fetchImpl(currentUrl, {
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'user-agent': userAgent }
      })
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers?.get?.('location')
        if (!location) return response
        currentUrl = new URL(location, currentUrl).toString()
        continue
      }
      return response
    }
    throw new WebFetchBlockedError(url, 'too_many_redirects')
  } finally {
    clearTimeout(timer)
  }
}

async function executeWebFetch(
  args: Record<string, unknown>,
  deps: WebToolDeps
): Promise<McpToolExecutionResult> {
  const url = String(args.url || args.uri || '').trim()
  if (!/^https?:\/\//i.test(url)) {
    return {
      text: 'web_fetch error: url must be an absolute http(s) URL.',
      isError: true,
      structuredContent: { ok: false, tool: 'web_fetch', error: 'invalid_url' }
    }
  }
  const response = await safeFetch(url, 'TaskWraith-web_fetch/1.0', deps)
  const raw = await response.text()
  const contentType = String(response.headers?.get?.('content-type') || '')
  const isHtml = looksLikeHtml(contentType, raw)
  // Convert HTML to readable prose BEFORE truncating so the character budget
  // is spent on page content, not on <head>/<style>/<script> markup. Non-HTML
  // bodies (JSON, plain text, etc.) are passed through verbatim.
  let title = ''
  let extracted = raw
  if (isHtml) {
    const readable = htmlDocumentToReadableText(raw)
    title = readable.title
    extracted = readable.text || htmlToText(raw)
  }
  const { text: body, truncated } = truncateWebText(extracted)
  const headerLines = [
    `HTTP ${response.status} ${response.statusText || ''} for ${url}`.trim(),
    title ? `Title: ${title}` : '',
    isHtml ? 'Extracted readable page text:' : ''
  ].filter(Boolean)
  const text = `${headerLines.join('\n')}\n\n${body}`
  return {
    text,
    isError: !response.ok,
    structuredContent: {
      ok: response.ok,
      tool: 'web_fetch',
      url,
      status: response.status,
      statusText: response.statusText || '',
      contentType,
      isHtml,
      ...(title ? { title } : {}),
      truncated
    }
  }
}

function parseDuckDuckGoResults(html: string, query: string): string[] {
  const results: string[] = []
  const re = /<a\b[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g
  let match: RegExpExecArray | null
  while ((match = re.exec(html)) !== null && results.length < 8) {
    let href = match[1]
    const uddg = href.match(/[?&]uddg=([^&]+)/)
    if (uddg) {
      try {
        href = decodeURIComponent(uddg[1])
      } catch {
        // Keep the original href if decoding fails.
      }
    }
    const title = htmlToText(match[2])
    if (title && href) results.push(`- ${title}\n  ${href}`)
  }
  if (results.length > 0) return results
  const fallbackText = htmlToText(html)
  return fallbackText
    ? [`No structured results parsed for "${query}". Search page text preview:\n${fallbackText.slice(0, 2000)}`]
    : []
}

async function executeWebSearch(
  args: Record<string, unknown>,
  deps: WebToolDeps
): Promise<McpToolExecutionResult> {
  const query = String(args.query || args.q || '').trim()
  if (!query) {
    return {
      text: 'web_search error: query must be a non-empty string.',
      isError: true,
      structuredContent: { ok: false, tool: 'web_search', error: 'missing_query' }
    }
  }
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`
  const response = await safeFetch(url, 'TaskWraith-web_search/1.0', deps)
  const html = await response.text()
  const results = parseDuckDuckGoResults(html, query)
  const text =
    results.length > 0
      ? `Top web results for "${query}":\n\n${results.join('\n')}`
      : `No results parsed for "${query}" (search returned HTTP ${response.status}).`
  return {
    text,
    isError: !response.ok,
    structuredContent: {
      ok: response.ok,
      tool: 'web_search',
      query,
      status: response.status,
      resultCount: results.length
    }
  }
}

export async function executeWebMcpTool(
  toolName: WebMcpToolName,
  args: Record<string, unknown>,
  deps: WebToolDeps = {}
): Promise<McpToolExecutionResult> {
  try {
    if (toolName === 'web_fetch') return await executeWebFetch(args, deps)
    return await executeWebSearch(args, deps)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      text: `${toolName} error: ${message}`,
      isError: true,
      structuredContent: { ok: false, tool: toolName, error: message }
    }
  }
}
