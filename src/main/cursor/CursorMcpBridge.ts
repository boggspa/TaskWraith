// 1.0.6-CRUX34 — TaskWraith Cursor MCP web bridge (OQ#2).
//
// The CR-net probes proved native Cursor web tools (webSearch/webFetch) are
// hard-rejected ("User Rejected") in headless `-p`, and that the
// `permissions.allow` token matcher does NOT govern them. The OQ#2 spike then
// proved the constructive path WORKS: a workspace-local `.cursor/mcp.json`
// registering an TaskWraith MCP server + `allow: ["Mcp(taskwraith:*)"]` +
// `--approve-mcps` IS invoked by Cursor in headless DEFAULT/write mode (the
// agent called our `web_fetch` and used the result). Plan mode executes no
// tools, so this bridge is write/default-mode only (see the blueprint verdict).
//
// This module is PURE (no Electron / no fs) so it's unit-testable: it owns the
// MCP server SOURCE (written to a temp file per-run by the caller, so there's no
// packaging/path wiring — the source ships inside the bundled main process) plus
// the pure helpers that build/merge the `.cursor/mcp.json` + the cli.json allow
// rule. The Electron-side lifecycle (write temp server, write mcp.json, merge
// allow, pass --approve-mcps, restore) lives in index.ts / CursorWorkspaceConfig.

import type { CursorCliConfig } from './CursorWorkspaceConfig'

/** Allow rules that pre-approve every tool from the `taskwraith` MCP server.
 *  Cursor has reported brokered denials under both `taskwraith:<tool>` and
 *  `taskwraith-<tool>` names, so keep both spellings allowed. This does NOT
 *  touch the native Shell/Write deny rules. */
export const CURSOR_MCP_ALLOW_RULES: readonly string[] = [
  'Mcp(taskwraith:*)',
  'Mcp(taskwraith-*)'
]

/** The MCP server name (the `taskwraith` in `Mcp(taskwraith:*)` + the mcp.json key). */
export const CURSOR_MCP_SERVER_NAME = 'taskwraith'

/**
 * The web_fetch MCP server, embedded as source so the caller can drop it to a
 * temp `.cjs` at runtime — no extraResources / packaged-path resolution needed.
 *
 * Protocol: stdio, newline-delimited JSON-RPC 2.0 (the MCP stdio transport).
 * Tools: `web_fetch(url)` — a READ-ONLY network fetch (http/https), 20s timeout,
 * 20KB body cap, follows redirects. No filesystem or shell access. Avoids
 * template literals + `${}` so it embeds cleanly in this TS template string
 * (newlines in emitted strings are written as the escaped `\n` sequence).
 */
export const CURSOR_WEB_FETCH_MCP_SERVER_SOURCE = `// TaskWraith Cursor web_fetch MCP server (generated; do not edit).
'use strict'
const readline = require('readline')
function send(m) { try { process.stdout.write(JSON.stringify(m) + '\\n') } catch (e) {} }
const WEB_FETCH_TOOL = {
  name: 'web_fetch',
  description: 'Fetch the live text contents of an absolute http(s) URL. Use this whenever you need to read a web page or pull current online information and you already have a URL — it is the working way to access the web here. Returns the HTTP status + (truncated) body. Read-only network; cannot write files or run shell.',
  inputSchema: {
    type: 'object',
    properties: { url: { type: 'string', description: 'The absolute http(s) URL to fetch.' } },
    required: ['url']
  }
}
async function doFetch(url) {
  if (typeof url !== 'string' || !/^https?:\\/\\//i.test(url)) {
    throw new Error('url must be an absolute http(s) URL')
  }
  const controller = new AbortController()
  const timer = setTimeout(function () { controller.abort() }, 20000)
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'user-agent': 'TaskWraith-Cursor-web_fetch/1.0' }
    })
    const raw = await res.text()
    const body = raw.length > 20000 ? raw.slice(0, 20000) + '\\n...[truncated]' : raw
    return 'HTTP ' + res.status + ' ' + (res.statusText || '') + ' for ' + url + '\\n\\n' + body
  } finally {
    clearTimeout(timer)
  }
}
const WEB_SEARCH_TOOL = {
  name: 'web_search',
  description: 'Search the web for a query and return the top result titles + URLs. Use this whenever you need to find current online information and do NOT already have a URL (then web_fetch a result for the details). It is the working way to search the web here. Read-only network; cannot write files or run shell.',
  inputSchema: {
    type: 'object',
    properties: { query: { type: 'string', description: 'The search query.' } },
    required: ['query']
  }
}
async function doSearch(query) {
  if (typeof query !== 'string' || !query.trim()) throw new Error('query must be a non-empty string')
  const controller = new AbortController()
  const timer = setTimeout(function () { controller.abort() }, 20000)
  try {
    const res = await fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query), {
      signal: controller.signal,
      headers: { 'user-agent': 'TaskWraith-Cursor-web_search/1.0' }
    })
    const html = await res.text()
    const results = []
    const re = /<a\\b[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\\s\\S]*?)<\\/a>/g
    let m
    while ((m = re.exec(html)) !== null && results.length < 8) {
      let href = m[1]
      const uddg = href.match(/[?&]uddg=([^&]+)/)
      if (uddg) { try { href = decodeURIComponent(uddg[1]) } catch (e) {} }
      const title = m[2].replace(/<[^>]+>/g, '').replace(/\\s+/g, ' ').trim()
      if (title && href) results.push('- ' + title + '\\n  ' + href)
    }
    if (results.length === 0) {
      return 'No results parsed for "' + query + '" (search returned HTTP ' + res.status + ').'
    }
    return 'Top web results for "' + query + '":\\n\\n' + results.join('\\n')
  } finally {
    clearTimeout(timer)
  }
}
readline.createInterface({ input: process.stdin }).on('line', async function (line) {
  line = (line || '').trim()
  if (!line) return
  let msg
  try { msg = JSON.parse(line) } catch (e) { return }
  const id = msg.id
  const method = msg.method
  const params = msg.params || {}
  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id: id, result: {
      protocolVersion: params.protocolVersion || '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'taskwraith', version: '1.0.0' }
    } })
  } else if (method === 'notifications/initialized') {
    // notification, no response
  } else if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id: id, result: { tools: [WEB_FETCH_TOOL, WEB_SEARCH_TOOL] } })
  } else if (method === 'tools/call') {
    const name = params.name
    const args = params.arguments || {}
    if (name === 'web_fetch') {
      try {
        const text = await doFetch(args.url)
        send({ jsonrpc: '2.0', id: id, result: { content: [{ type: 'text', text: text }] } })
      } catch (e) {
        send({ jsonrpc: '2.0', id: id, result: { content: [{ type: 'text', text: 'web_fetch error: ' + String((e && e.message) || e) }], isError: true } })
      }
    } else if (name === 'web_search') {
      try {
        const text = await doSearch(args.query)
        send({ jsonrpc: '2.0', id: id, result: { content: [{ type: 'text', text: text }] } })
      } catch (e) {
        send({ jsonrpc: '2.0', id: id, result: { content: [{ type: 'text', text: 'web_search error: ' + String((e && e.message) || e) }], isError: true } })
      }
    } else {
      send({ jsonrpc: '2.0', id: id, error: { code: -32601, message: 'Unknown tool: ' + name } })
    }
  } else if (method === 'ping') {
    send({ jsonrpc: '2.0', id: id, result: {} })
  } else if (id !== undefined && id !== null) {
    send({ jsonrpc: '2.0', id: id, error: { code: -32601, message: 'Method not found: ' + method } })
  }
})
`

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

/** How to spawn the bridge server. `command` is normally the Electron binary
 *  (`process.execPath`) with `env.ELECTRON_RUN_AS_NODE=1`, so no system `node`
 *  is required in a packaged build; `args` is `[<temp server .cjs path>]`. */
export interface CursorMcpServerInvocation {
  command: string
  args: string[]
  env?: Record<string, string>
}

/**
 * Build the `mcpServers` entry for the `taskwraith` server. Pure — the caller
 * merges it into the workspace `.cursor/mcp.json` via {@link mergeCursorMcpConfig}.
 */
export function buildCursorMcpServerEntry(
  invocation: CursorMcpServerInvocation
): Record<string, unknown> {
  return {
    [CURSOR_MCP_SERVER_NAME]: {
      command: invocation.command,
      args: [...invocation.args],
      ...(invocation.env ? { env: invocation.env } : {})
    }
  }
}

/**
 * Merge the TaskWraith server entry into an existing `.cursor/mcp.json` shape (or
 * {}), preserving any other registered MCP servers + unknown top-level keys.
 * Pure.
 */
export function mergeCursorMcpConfig(
  existing: unknown,
  serverEntry: Record<string, unknown>
): Record<string, unknown> {
  const base = asRecord(existing)
  const servers = { ...asRecord(base.mcpServers), ...serverEntry }
  return { ...base, mcpServers: servers }
}

/**
 * Merge `allowRules` into a `.cursor/cli.json` shape (or {}), preserving any
 * existing allow/deny entries + unknown top-level keys, deduping allow rules.
 * Mirrors `mergeCursorDenyRules` (which handles the deny side). Pure.
 */
export function mergeCursorAllowRules(
  existing: unknown,
  allowRules: readonly string[]
): CursorCliConfig {
  const base = asRecord(existing)
  const perms = asRecord(base.permissions)
  const allow = stringArray(perms.allow)
  const deny = stringArray(perms.deny)
  for (const rule of allowRules) {
    if (!allow.includes(rule)) allow.push(rule)
  }
  return { ...base, permissions: { allow, deny } }
}
