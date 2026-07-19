// Per-run localhost HTTP MCP server for Kimi Code ACP seats.
//
// Kimi Code's `kimi acp` session/new REJECTS stdio MCP servers (verified: it
// validates entries against an http/sse schema — `mcpCapabilities:{http,sse}`);
// every OTHER TaskWraith provider reaches the gateway over the stdio bridge, so
// Kimi needs an HTTP transport. Kimi's HTTP MCP client accepts plain
// `application/json` responses (no SSE required) plus an `Mcp-Session-Id`
// header, so this is a hand-rolled JSON-response endpoint — consistent with the
// rest of the app (which hand-rolls MCP JSON-RPC) and avoiding a new MCP-SDK
// dependency in the main bundle.
//
// The server is a thin transport: it authenticates the Bearer token, parses one
// JSON-RPC message per POST, and hands it to the injected `dispatch` (which the
// caller wires to the existing handleMcpJsonRpcMessage gateway dispatch, so all
// subset filtering + tools/call guards + broker routing are reused). It binds
// 127.0.0.1 only and mints a fresh random token per run; the URL + auth header
// are advertised to exactly one Kimi session via session/new mcpServers.

import http from 'http'
import { randomBytes, randomUUID } from 'crypto'
import { mcpUnexpectedInternalError } from '../mcp/McpInternalError'

export interface KimiHttpMcpBridgeOptions {
  /**
   * Dispatch one inbound MCP JSON-RPC message and resolve its response object,
   * or null for a notification (no reply). Must not throw for a normal error —
   * return a JSON-RPC error object instead; a thrown error is turned into a
   * generic -32603 response by the server.
   */
  dispatch: (message: Record<string, unknown>) => Promise<Record<string, unknown> | null>
  /** Max request body bytes (defensive). Default 8 MiB. */
  maxBodyBytes?: number
}

export interface KimiHttpMcpBridgeHandle {
  /** The URL to advertise to Kimi (http://127.0.0.1:<port>/mcp). */
  url: string
  /** The auth header name/value to advertise alongside the URL. */
  headerName: string
  headerValue: string
  /** Close the server; safe to call more than once. */
  close: () => Promise<void>
}

function isNotification(message: Record<string, unknown> | null): boolean {
  return !!message && typeof message.method === 'string' && message.id === undefined
}

export async function startKimiHttpMcpBridge(
  options: KimiHttpMcpBridgeOptions
): Promise<KimiHttpMcpBridgeHandle> {
  const token = randomBytes(24).toString('hex')
  const headerValue = `Bearer ${token}`
  const maxBodyBytes = options.maxBodyBytes ?? 8 * 1024 * 1024
  // A single session id echoed after initialize. The endpoint serves exactly one
  // Kimi session per run, so a fixed id is sufficient (StreamableHTTP requires
  // the header round-trip, not multi-session multiplexing here).
  let sessionId: string | null = null

  const server = http.createServer((req, res) => {
    void handleRequest(req, res).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(mcpUnexpectedInternalError(null)))
      }
    })
  })

  async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // Constant work regardless of match; a mismatch is a hard 401 (no timing game
    // worth playing for a localhost-only, per-run random token).
    if (req.headers['authorization'] !== headerValue) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'unauthorized' } }))
      return
    }
    // Kimi may open a GET stream for server-initiated messages; we never push, so
    // decline it. The client falls back to request/response over POST.
    if (req.method === 'GET') {
      res.writeHead(405, { Allow: 'POST' })
      res.end()
      return
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST' })
      res.end()
      return
    }
    let body = ''
    let tooLarge = false
    for await (const chunk of req) {
      body += chunk
      if (body.length > maxBodyBytes) {
        tooLarge = true
        break
      }
    }
    if (tooLarge) {
      res.writeHead(413, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'request too large' } }))
      return
    }
    let message: Record<string, unknown>
    try {
      message = JSON.parse(body)
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }))
      return
    }

    let response: Record<string, unknown> | null
    try {
      response = await options.dispatch(message)
    } catch {
      response = mcpUnexpectedInternalError(message.id)
    }

    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (message.method === 'initialize') {
      sessionId = sessionId ?? randomUUID()
      headers['Mcp-Session-Id'] = sessionId
    }
    if (response === null || isNotification(message)) {
      res.writeHead(202, headers)
      res.end()
      return
    }
    res.writeHead(200, headers)
    res.end(JSON.stringify(response))
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  const address = server.address()
  const port = address && typeof address === 'object' ? address.port : 0

  let closed = false
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    headerName: 'Authorization',
    headerValue,
    close: () =>
      new Promise<void>((resolve) => {
        if (closed) {
          resolve()
          return
        }
        closed = true
        server.close(() => resolve())
      })
  }
}
