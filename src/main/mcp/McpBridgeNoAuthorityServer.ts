// A zero-authority MCP handshake for a bridge launch that carries no endpoint.
//
// TaskWraith's persisted MCP registration is deliberately credential-free: the
// socket path, broker token, and instance epoch reach the child through the
// environment of the process TaskWraith itself spawns. That registration lives
// in configs other clients read — agy's global `mcp_config.json` most of all,
// which the user's own AntiGravity IDE and any manual `agy` session load too.
// Those clients launch the exact same argv with none of the authority, and the
// child then refuses to boot.
//
// Refusing is correct. Dying mid-handshake is not: the client reports it as
// `connection closed: calling "initialize": client is closing: EOF`, shows a
// hard error next to a server the user never knowingly installed, and retries.
// Answering the handshake with an empty tool list is exactly as closed — no
// tool is advertised, no call is answerable, no endpoint value is disclosed —
// while reading, correctly, as a server with nothing to offer.
//
// Deliberately self-contained: this runs from `devAppName` BEFORE Electron
// userData is resolved, so it must not pull in the bridge runtime (or anything
// else that reads a profile path) to reach a stdout writer.

/** Matches the live bridge so a client sees one server identity either way. */
const SERVER_NAME = 'TaskWraith MCP Bridge'
const DEFAULT_PROTOCOL_VERSION = '2024-11-05'
const DEFAULT_APP_VERSION = '1.0.0'

export interface McpBridgeNoAuthorityServerIo {
  stdin: NodeJS.ReadableStream
  stdout: { write(chunk: string): unknown }
  exit: (code?: number) => void
  appVersion?: string
}

type McpResponseTransport = 'framed' | 'line'

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function errorResponse(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } }
}

/**
 * The complete no-authority protocol surface. Returns `null` when the message
 * takes no reply (any notification). Messages are never logged and replies
 * never carry a path, token, epoch, or argv value.
 */
export function buildNoAuthorityMcpResponse(
  request: unknown,
  appVersion?: string
): Record<string, unknown> | null {
  if (!isRecord(request)) return errorResponse(null, -32600, 'Invalid MCP request.')
  const id = request.id
  const method = typeof request.method === 'string' ? request.method : ''
  if (!method) return errorResponse(id, -32600, 'Invalid MCP request.')
  if (method.startsWith('notifications/')) return null
  if (method === 'initialize') {
    const requested = isRecord(request.params) ? request.params.protocolVersion : undefined
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion:
          typeof requested === 'string' && requested ? requested : DEFAULT_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: appVersion || DEFAULT_APP_VERSION }
      }
    }
  }
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} }
  // An empty catalogue is the honest answer, and it is what stops a client
  // from ever reaching the call path below.
  if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: [] } }
  return errorResponse(
    id,
    -32601,
    'This TaskWraith MCP server was started without a live TaskWraith session and offers no tools. Start it from TaskWraith instead.'
  )
}

/**
 * Serve the handshake on one stdio pair until the client hangs up. Installs
 * only stdin handlers: the caller stays responsible for making sure nothing
 * else in main boots behind it.
 */
export function serveMcpBridgeWithoutAuthority(io: McpBridgeNoAuthorityServerIo): void {
  let buffer = Buffer.alloc(0)

  const write = (payload: unknown, transport: McpResponseTransport): void => {
    const body = JSON.stringify(payload)
    try {
      // A client that has already gone leaves a broken pipe; there is nothing
      // to report it to, and throwing here would take the process with it.
      io.stdout.write(
        transport === 'line'
          ? `${body}\n`
          : `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`
      )
    } catch {
      /* ignore */
    }
  }

  const dispatch = (body: string, transport: McpResponseTransport): void => {
    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch {
      write(errorResponse(null, -32700, 'Malformed MCP JSON request.'), transport)
      return
    }
    const response = buildNoAuthorityMcpResponse(parsed, io.appVersion)
    if (response) write(response, transport)
  }

  // Both framings the live bridge accepts, chosen per message exactly as it
  // does, so a client is answered in the shape it asked in.
  const parseMessages = (): void => {
    while (buffer.length > 0) {
      const text = buffer.toString('utf8')
      if (text.startsWith('Content-Length:')) {
        const headerEnd = text.indexOf('\r\n\r\n')
        if (headerEnd < 0) return
        const lengthMatch = text.slice(0, headerEnd).match(/Content-Length:\s*(\d+)/i)
        const contentLength = lengthMatch ? Number(lengthMatch[1]) : 0
        if (!Number.isFinite(contentLength) || contentLength <= 0) {
          buffer = buffer.subarray(headerEnd + 4)
          continue
        }
        const bodyStart = Buffer.byteLength(text.slice(0, headerEnd + 4), 'utf8')
        if (buffer.length < bodyStart + contentLength) return
        const body = buffer.subarray(bodyStart, bodyStart + contentLength).toString('utf8')
        buffer = buffer.subarray(bodyStart + contentLength)
        dispatch(body, 'framed')
        continue
      }
      const lineEnd = text.indexOf('\n')
      if (lineEnd < 0) return
      const lineBytes = Buffer.byteLength(text.slice(0, lineEnd + 1), 'utf8')
      const line = buffer.subarray(0, lineBytes).toString('utf8').trim()
      buffer = buffer.subarray(lineBytes)
      if (line) dispatch(line, 'line')
    }
  }

  const finish = (): void => io.exit(0)

  io.stdin.on('data', (chunk: Buffer | string) => {
    buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8')])
    parseMessages()
  })
  io.stdin.on('end', finish)
  io.stdin.on('close', finish)
  io.stdin.on('error', finish)
  io.stdin.resume?.()
}
