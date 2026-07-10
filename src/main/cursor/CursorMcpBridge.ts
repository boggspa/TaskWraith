// 1.0.6-CRUX34 — TaskWraith Cursor MCP bridge (OQ#2).
//
// The CR-net probes proved native Cursor web tools (webSearch/webFetch) are
// hard-rejected ("User Rejected") in headless `-p`, and that the
// `permissions.allow` token matcher does NOT govern them. The OQ#2 spike first
// proved the web-only path, and the full provider path now uses a workspace-local
// `.cursor/mcp.json` registering a brokered TaskWraith MCP server. Plan mode
// executes no tools, so this bridge is write/default-mode only.
//
// This module is PURE (no Electron / no fs) so it's unit-testable: it owns the
// MCP server SOURCE (written to a temp file per-run by the caller, so there's no
// packaging/path wiring — the source ships inside the bundled main process) plus
// the pure helpers that build/merge the `.cursor/mcp.json` + the cli.json allow
// rule. The Electron-side lifecycle (write temp server, write mcp.json, merge
// allow, pass --approve-mcps, restore) lives in index.ts / CursorWorkspaceConfig.

import { TASKWRAITH_MCP_TOOLS } from '../TaskWraithMcpTools'
import {
  PLAN_MCP_ADVERTISE_TOOLS,
  READ_ONLY_MCP_ADVERTISE_TOOLS
} from '../mcp/McpAutoAllowedTools'
import type { CursorCliConfig } from './CursorWorkspaceConfig'

/** Cursor's older Home MCP bridge used the plain `taskwraith` id for a web-only
 *  two-tool server. Keep a transient workspace-local alias for compatibility
 *  with existing Cursor sessions that still call `mcp_taskwraith-*`; write-mode
 *  setup points this alias at the full broker after removing stale workspace
 *  entries with the same reserved name. */
export const CURSOR_LEGACY_WEB_MCP_SERVER_NAME = 'taskwraith'

/** The MCP server name used for the full per-run broker. */
export const CURSOR_MCP_SERVER_NAME = 'taskwraith-broker'

/** The MCP server name used for the READ-ONLY per-run broker (Grok parity —
 *  mirrors GROK_SCOPED_MCP_SERVER_NAME). A distinct name from the full broker so
 *  the read-only seat's `.cursor/mcp.json` registers a `--safe-subset` bridge
 *  that advertises ONLY the non-mutating read tools; the name also keeps the
 *  read-only and write brokers from colliding in the workspace config. */
export const CURSOR_SCOPED_MCP_SERVER_NAME = 'taskwraith-cursor'

/** Allow rules that pre-approve every tool from the full TaskWraith MCP server.
 *  Cursor's documented permission token is `Mcp(server:tool)`, while stream-json
 *  and rejection messages display brokered calls as `server-tool`. Keep the
 *  documented wildcard for the real namespace, enumerate documented exact
 *  `server:tool` entries so we do not depend on wildcard behavior, and retain
 *  the observed hyphen spellings as a compatibility belt-and-braces fallback.
 *  Never add a broad prefix wildcard rule: a workspace MCP server with a similar
 *  name must not ride TaskWraith's approval. This does NOT touch the native
 *  Shell/Write deny rules. */
/** Rules for the canonical TaskWraith-owned broker only. Global B-mode must use
 * this set so a preserved user server named `taskwraith` never inherits broker
 * approval. */
export const CURSOR_BROKER_MCP_ALLOW_RULES: readonly string[] = [
  `Mcp(${CURSOR_MCP_SERVER_NAME}:*)`,
  ...TASKWRAITH_MCP_TOOLS.map((tool) => `Mcp(${CURSOR_MCP_SERVER_NAME}:${tool})`),
  ...TASKWRAITH_MCP_TOOLS.map((tool) => `Mcp(${CURSOR_MCP_SERVER_NAME}-${tool})`)
]

const CURSOR_LEGACY_MCP_ALLOW_RULES: readonly string[] = [
  ...TASKWRAITH_MCP_TOOLS.map((tool) => `Mcp(${CURSOR_LEGACY_WEB_MCP_SERVER_NAME}:${tool})`),
  ...TASKWRAITH_MCP_TOOLS.map((tool) => `Mcp(${CURSOR_LEGACY_WEB_MCP_SERVER_NAME}-${tool})`)
]

/** Combined rules are only for legacy workspace A-mode, where TaskWraith owns
 * both registered aliases and removes/restores them around the run. */
export const CURSOR_MCP_ALLOW_RULES: readonly string[] = [
  ...CURSOR_BROKER_MCP_ALLOW_RULES,
  ...CURSOR_LEGACY_MCP_ALLOW_RULES
]

/** Exact read-only rules for the canonical global broker name. Server approval
 * is handled separately by `cursor-agent mcp enable`; no wildcard is needed. */
export const CURSOR_BROKER_READONLY_MCP_ALLOW_RULES: readonly string[] = [
  ...READ_ONLY_MCP_ADVERTISE_TOOLS.map((tool) => `Mcp(${CURSOR_MCP_SERVER_NAME}:${tool})`),
  ...READ_ONLY_MCP_ADVERTISE_TOOLS.map((tool) => `Mcp(${CURSOR_MCP_SERVER_NAME}-${tool})`)
]

/** Plan-seat variant: exact canonical-broker rules for the read tools plus the
 * host-gated Canvas/media plan instruments. */
export const CURSOR_BROKER_PLAN_MCP_ALLOW_RULES: readonly string[] = [
  ...PLAN_MCP_ADVERTISE_TOOLS.map((tool) => `Mcp(${CURSOR_MCP_SERVER_NAME}:${tool})`),
  ...PLAN_MCP_ADVERTISE_TOOLS.map((tool) => `Mcp(${CURSOR_MCP_SERVER_NAME}-${tool})`)
]

/** Allow rules that pre-approve the READ-ONLY scoped broker's tools. The bridge
 *  is launched `--safe-subset`, so it advertises ONLY READ_ONLY_MCP_ADVERTISE_TOOLS
 *  (TASKWRAITH_MCP_TOOLS ∩ the gate-skip safe set); enumerate exactly those under
 *  the scoped server name, with the documented wildcard + the observed hyphen
 *  spelling as a belt-and-braces fallback. Never lists a mutating tool (the
 *  safe-subset set is DERIVED and test-guarded), so a read-only seat cannot ride
 *  this rule to a write. Kept separate from CURSOR_MCP_ALLOW_RULES (the full
 *  write broker) so the two brokers' approvals never overlap. */
export const CURSOR_READONLY_MCP_ALLOW_RULES: readonly string[] = [
  `Mcp(${CURSOR_SCOPED_MCP_SERVER_NAME}:*)`,
  ...READ_ONLY_MCP_ADVERTISE_TOOLS.map((tool) => `Mcp(${CURSOR_SCOPED_MCP_SERVER_NAME}:${tool})`),
  ...READ_ONLY_MCP_ADVERTISE_TOOLS.map((tool) => `Mcp(${CURSOR_SCOPED_MCP_SERVER_NAME}-${tool})`)
]

export function isReservedCursorMcpServerName(name: string): boolean {
  return (
    name === CURSOR_MCP_SERVER_NAME ||
    name.startsWith(`${CURSOR_MCP_SERVER_NAME}-`) ||
    name === CURSOR_SCOPED_MCP_SERVER_NAME ||
    name.startsWith(`${CURSOR_SCOPED_MCP_SERVER_NAME}-`) ||
    name === CURSOR_LEGACY_WEB_MCP_SERVER_NAME ||
    name.startsWith(`${CURSOR_LEGACY_WEB_MCP_SERVER_NAME}-`)
  )
}

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
 * Build the `mcpServers` entry for the full TaskWraith broker server. Pure — the caller
 * merges it into the workspace `.cursor/mcp.json` via {@link mergeCursorMcpConfig}.
 */
export function buildCursorMcpServerEntry(
  invocation: CursorMcpServerInvocation
): Record<string, unknown> {
  const entry = {
    command: invocation.command,
    args: [...invocation.args],
    ...(invocation.env ? { env: invocation.env } : {})
  }
  return {
    [CURSOR_MCP_SERVER_NAME]: entry,
    [CURSOR_LEGACY_WEB_MCP_SERVER_NAME]: {
      command: invocation.command,
      args: [...invocation.args],
      ...(invocation.env ? { env: invocation.env } : {})
    }
  }
}

/**
 * Build the `mcpServers` entry for the READ-ONLY scoped broker (Grok parity).
 * Registers ONLY the scoped server name (no legacy alias) — the invocation's
 * args must include the `--safe-subset` flag so the broker advertises only the
 * non-mutating read tools. Pure; the caller merges it via
 * {@link mergeCursorMcpConfig}.
 */
export function buildCursorReadOnlyMcpServerEntry(
  invocation: CursorMcpServerInvocation
): Record<string, unknown> {
  return {
    [CURSOR_SCOPED_MCP_SERVER_NAME]: {
      command: invocation.command,
      args: [...invocation.args],
      ...(invocation.env ? { env: invocation.env } : {})
    }
  }
}

// ── "B" mode: durable GLOBAL registration (~/.cursor/mcp.json) ───────────────
// The live cursor-agent CLI (2026.06) proved the root cause: `--approve-mcps`
// approves the SERVER only, and a per-run WORKSPACE `.cursor/mcp.json` server
// never reaches the durable "approved" state (`cursor-agent mcp list` → "ready"),
// so headless `-p` rejects its every tool call ("User rejected MCP"). GLOBALLY
// registered servers DO reach "ready" (the user's `taskwraith` web server does).
// So B-mode registers the broker(s) in the global `~/.cursor/mcp.json` and relies
// on `cursor-agent mcp enable <name>` (approval is by NAME, so it survives the
// per-launch token refresh below). The full broker (write seats) and the
// safe-subset broker (read-only seats) are distinct names so a seat only enables
// the one it should have. The legacy `taskwraith` alias is deliberately NOT
// registered globally — it collides with the user's own global `taskwraith` web
// server.

/**
 * Build the GLOBAL broker `mcpServers` entry (full tool surface) WITHOUT the
 * legacy alias. Pure; merged via {@link mergeGlobalCursorMcpServers}.
 */
export function buildCursorBrokerMcpServerEntry(
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
 * Merge TaskWraith broker entries into a GLOBAL `~/.cursor/mcp.json` shape (or
 * {}). Unlike {@link mergeCursorMcpConfig} (workspace, which strips reserved
 * names), this PRESERVES every existing server — including the user's own global
 * `taskwraith` web server and `agbench` — and only adds/refreshes the exact
 * broker entries passed (repair-on-stale, since the socket token rotates each
 * launch). Optional removals are reserved for obsolete TaskWraith-owned aliases;
 * callers must never pass user-owned server names. Pure.
 */
export function mergeGlobalCursorMcpServers(
  existing: unknown,
  brokerEntries: Record<string, unknown>,
  removeServerNames: readonly string[] = []
): Record<string, unknown> {
  const base = asRecord(existing)
  const servers: Record<string, unknown> = { ...asRecord(base.mcpServers) }
  for (const name of removeServerNames) delete servers[name]
  Object.assign(servers, brokerEntries)
  return { ...base, mcpServers: servers }
}

/**
 * Would writing `brokerEntries` change the existing global config? Used to skip
 * a no-op rewrite (and the resulting cursor-agent config-reload churn) when the
 * broker entries already match. Compares only the broker keys. Pure.
 */
export function globalCursorMcpNeedsUpdate(
  existing: unknown,
  brokerEntries: Record<string, unknown>,
  removeServerNames: readonly string[] = []
): boolean {
  const servers = asRecord(asRecord(existing).mcpServers)
  for (const name of removeServerNames) {
    if (name in servers && !(name in brokerEntries)) return true
  }
  for (const [name, entry] of Object.entries(brokerEntries)) {
    if (JSON.stringify(servers[name]) !== JSON.stringify(entry)) return true
  }
  return false
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
  const existingServers = asRecord(base.mcpServers)
  const servers: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(existingServers)) {
    if (!isReservedCursorMcpServerName(name)) servers[name] = value
  }
  Object.assign(servers, serverEntry)
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
