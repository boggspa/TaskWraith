import type { OutsideSocketCommand } from './outsideCommand'

/**
 * A stdio MCP server exposing the same two verbs `tw threads` and `tw send`
 * already run, so a native Claude Code or Codex session in the same checkout
 * can talk to a TaskWraith chat without a hand-rolled socket client.
 *
 * It executes nothing itself: every call goes back through
 * `runOutsideCommand`, so the thread resolution, the working-tree scoping and
 * the refusals cannot drift from the CLI's.
 *
 * Deliberately self-contained. Production TUI sources may not import
 * `src/main`, so the framing below mirrors `McpBridgeNoAuthorityServer`
 * rather than sharing it.
 */
const SERVER_NAME = 'taskwraith'
const DEFAULT_PROTOCOL_VERSION = '2024-11-05'

export interface TaskWraithMcpCommandResult {
  code: number
  out: string[]
  err: string[]
}

export interface TaskWraithMcpDeps {
  runCommand: (command: OutsideSocketCommand) => Promise<TaskWraithMcpCommandResult>
  serverVersion: string
  /** Working tree the server was started in; the default scope for both tools. */
  defaultCwd: string
}

export interface TaskWraithMcpServerIo {
  stdin: NodeJS.ReadableStream
  stdout: { write(chunk: string): unknown }
  exit: (code?: number) => void
  deps: TaskWraithMcpDeps
}

type McpResponseTransport = 'framed' | 'line'

const CWD_PROPERTY = {
  type: 'string',
  description: 'Working tree to scope to. Defaults to where this server was started.'
} as const

const ALL_PROPERTY = {
  type: 'boolean',
  description: 'Search every workspace instead of just this working tree.'
} as const

export const TASKWRAITH_MCP_TOOLS = [
  {
    name: 'list_threads',
    description:
      'List TaskWraith chat threads in this working tree, with their id, status and title. Use this to find the thread id to send to.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Match a thread id exactly, or a title substring.' },
        cwd: CWD_PROPERTY,
        all: ALL_PROPERTY
      }
    }
  },
  {
    name: 'send_prompt',
    description:
      'Send one prompt into a TaskWraith chat. A live Ensemble round absorbs it as a steer; an idle Ensemble starts a round with it; a busy solo chat queues it until the run reaches a boundary. The transcript row names the sending process, so the text does not need to attribute itself.',
    inputSchema: {
      type: 'object',
      properties: {
        thread: {
          type: 'string',
          description:
            'Thread id, or a title substring that matches exactly one thread. An ambiguous title is refused with the candidates listed.'
        },
        text: { type: 'string', description: 'The prompt to send.' },
        cwd: CWD_PROPERTY,
        all: ALL_PROPERTY
      },
      required: ['thread', 'text']
    }
  }
] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function errorResponse(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } }
}

function toolResult(id: unknown, text: string, isError?: boolean): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id,
    result: {
      content: [{ type: 'text', text }],
      ...(isError ? { isError: true } : {})
    }
  }
}

function trimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** `all` drops the scope entirely; otherwise an explicit cwd beats the default. */
function scopeOf(args: Record<string, unknown>, defaultCwd: string): { cwd?: string } {
  if (args.all === true) return {}
  return { cwd: trimmedString(args.cwd) || defaultCwd }
}

function commandFor(
  tool: string,
  args: Record<string, unknown>,
  defaultCwd: string
): OutsideSocketCommand | { refusal: string } {
  if (tool === 'list_threads') {
    const query = trimmedString(args.query)
    return {
      kind: 'threads',
      ...(query ? { query } : {}),
      ...scopeOf(args, defaultCwd),
      json: false
    }
  }
  if (tool === 'send_prompt') {
    const selector = trimmedString(args.thread)
    const text = trimmedString(args.text)
    if (!selector) return { refusal: 'send_prompt needs a thread id or a title to match.' }
    if (!text) return { refusal: 'send_prompt needs the prompt text to send.' }
    return { kind: 'send', selector, text, ...scopeOf(args, defaultCwd), json: false }
  }
  return {
    refusal: `Unknown tool: ${tool}. This server offers ${TASKWRAITH_MCP_TOOLS.map((entry) => entry.name).join(' and ')}.`
  }
}

async function handleToolCall(
  id: unknown,
  params: unknown,
  deps: TaskWraithMcpDeps
): Promise<Record<string, unknown>> {
  const call = isRecord(params) ? params : {}
  const tool = typeof call.name === 'string' ? call.name : ''
  const args = isRecord(call.arguments) ? call.arguments : {}
  const resolved = commandFor(tool, args, deps.defaultCwd)
  if ('refusal' in resolved) return toolResult(id, resolved.refusal, true)
  try {
    const result = await deps.runCommand(resolved)
    const failed = result.code !== 0
    const lines = failed ? [...result.err, ...result.out] : [...result.out, ...result.err]
    const text = lines.join('\n').trim()
    return toolResult(id, text || (failed ? 'The command failed.' : 'Done.'), failed || undefined)
  } catch (error) {
    // A dead socket is a failed tool call, not a dead server: the client keeps
    // its session and can retry once the app is back.
    return toolResult(id, error instanceof Error ? error.message : String(error), true)
  }
}

/** The complete protocol surface. Returns null when the message takes no reply. */
export async function buildTaskWraithMcpResponse(
  request: unknown,
  deps: TaskWraithMcpDeps
): Promise<Record<string, unknown> | null> {
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
        serverInfo: { name: SERVER_NAME, version: deps.serverVersion }
      }
    }
  }
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} }
  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: TASKWRAITH_MCP_TOOLS } }
  }
  if (method === 'tools/call') return handleToolCall(id, request.params, deps)
  return errorResponse(id, -32601, `Unsupported MCP method: ${method}`)
}

/**
 * Serve the protocol on one stdio pair until the client hangs up. Nothing but
 * JSON-RPC may ever reach stdout here: it IS the transport, so a stray log
 * line desynchronises the client.
 */
export function serveTaskWraithMcp(io: TaskWraithMcpServerIo): void {
  let buffer = Buffer.alloc(0)
  let pending: Promise<void> = Promise.resolve()

  const write = (payload: unknown, transport: McpResponseTransport): void => {
    const body = JSON.stringify(payload)
    try {
      io.stdout.write(
        transport === 'line'
          ? `${body}\n`
          : `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`
      )
    } catch {
      /* the client has gone; there is nowhere to report it */
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
    // Serialised: a tool call reaches the socket, and answering two out of
    // order would interleave sends into the same thread.
    pending = pending.then(async () => {
      const response = await buildTaskWraithMcpResponse(parsed, io.deps)
      if (response) write(response, transport)
    })
  }

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
