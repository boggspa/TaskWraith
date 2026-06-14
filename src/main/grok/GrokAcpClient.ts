// Bidirectional JSON-RPC (ACP) client for `grok agent stdio`. Drives the
// read-only turn flow: initialize → session/new → session/prompt, streaming
// session/update notifications back through `onEvent`. Process spawn is
// INJECTED so the state machine is unit-testable against a fake child (no real
// process / model call in tests). Protocol shapes proven by the G1 spike.
//
// TaskWraith-owned tools are passed through session/new `mcpServers`: write
// seats can receive the full brokered TaskWraith bridge, while read-only seats
// can receive a safe subset. We never send the `always-approve` command.

import {
  encodeAcpFrame,
  parseAcpStreamChunk,
  acpMessageToRunEvents,
  isAcpPermissionRequest,
  parseAcpPermissionRequest,
  buildAcpPermissionResponse,
  isAcpInboundRequest,
  buildAcpMethodNotFoundResponse,
  type NormalizedGrokRunEvent,
  type AcpPermissionRequest,
  type AcpPermissionDecision
} from './GrokAcpProtocol'

/** Minimal child-process surface this client needs (subset of ChildProcess). */
export interface AcpChildProcess {
  stdin: { write(data: string): void } | null
  stdout: { on(event: 'data', listener: (chunk: Buffer | string) => void): void } | null
  stderr: { on(event: 'data', listener: (chunk: Buffer | string) => void): void } | null
  on(event: 'error', listener: (err: Error) => void): void
  on(event: 'close', listener: (code: number | null) => void): void
  kill(signal?: string): void
}

export interface GrokAcpRunOptions {
  prompt: string
  cwd: string
  /** Spawns `grok --no-auto-update agent stdio` (injected for testability). */
  spawnProcess: () => AcpChildProcess
  /**
   * G5b — MCP servers advertised to the session (session/new `mcpServers`). For
   * this can be the full TaskWraith bridge for write-capable seats or the scoped
   * safe-subset bridge for read-only seats. Omitted/empty = no TaskWraith tools.
   * Each entry is an ACP stdio server descriptor; shape stays `unknown` here
   * because the live ACP wire shape is confirmed by gated traces, not assumed by
   * the client.
   */
  mcpServers?: unknown[]
  /** Normalized run events: content / thinking / init(sessionId) / result / warning. */
  onEvent: (event: NormalizedGrokRunEvent) => void
  /** Called once with the spawned child (for the cancellation registry). */
  onProcess?: (child: AcpChildProcess) => void
  /**
   * G5 — client-mediated tool approval. When the agent sends
   * `session/request_permission`, this resolves the decision that's written
   * back. The default (when omitted) is DENY: the request is answered with a
   * 'cancelled'/reject outcome so the agent never hangs and never gets a silent
   * allow. runGrokAcpProvider supplies a real handler that routes the request
   * to the TaskWraith approval ledger (G5c, the live-verified follow-up).
   */
  onPermissionRequest?: (
    request: AcpPermissionRequest
  ) => AcpPermissionDecision | Promise<AcpPermissionDecision>
  /**
   * Called once when the child exits. `turnComplete` is true when the prompt
   * reached a terminal stopReason before exit. `terminalStatus` is that raw
   * stopReason/status, so callers can distinguish a normal end_turn from
   * PermissionRejected/Cancelled instead of collapsing every completion to
   * success. The exit code alone is not enough because a normal turn ends by
   * SIGINT-killing the stdio server.
   */
  onClose?: (code: number | null, turnComplete: boolean, terminalStatus?: string) => void
  /**
   * G4d — opt-in raw JSON-RPC frame tap (both directions). Used by the gated
   * TASKWRAITH_GROK_DEBUG capture so the live ACP wire shape can be confirmed from
   * a single in-app run — in particular whether Grok actually emits `tool_call`
   * session/updates and `session/request_permission` requests (the safety
   * precondition for trusting write-over-ACP). Never affects behavior.
   */
  onRawFrame?: (direction: 'in' | 'out', message: unknown) => void
}

export interface GrokAcpRunHandle {
  /** User-initiated cancel: session/cancel (protocol) then kill. */
  cancel: () => void
}

const ACP_ID = { initialize: 1, sessionNew: 2, prompt: 3 } as const

const grokBinaryFromSpawnMessage = (message: string): string | null => {
  const match = message.match(/^spawn\s+(.+?)\s+ENOENT\b/)
  return match?.[1] ?? null
}

const formatGrokProcessError = (err: Error): string => {
  const error = err as Error & { code?: unknown; path?: unknown }
  const message = err.message || String(err)
  const isMissingBinary = error.code === 'ENOENT' || /\bENOENT\b/.test(message)
  if (!isMissingBinary) return message

  const attemptedPath =
    typeof error.path === 'string'
      ? error.path
      : grokBinaryFromSpawnMessage(message) || '~/.grok/bin/grok'

  return `Grok CLI could not be started. TaskWraith tried ${attemptedPath}, but macOS reported ENOENT (no such file or directory). Open Settings -> Providers -> Grok and reinstall or sign in, or run Grok once in Terminal so it can repair ~/.grok/bin/grok, then retry.`
}

/**
 * Run a single read-only ACP turn. Returns a handle whose `cancel()` interrupts
 * an in-progress turn. The caller wires `onEvent` to its run-event sink and
 * synthesizes the canonical result/exit from `onClose`.
 */
export function runGrokAcpTurn(options: GrokAcpRunOptions): GrokAcpRunHandle {
  const child = options.spawnProcess()
  options.onProcess?.(child)

  let carry = ''
  let sessionId = ''
  let promptSent = false
  let turnComplete = false
  let terminalStatus: string | undefined

  const writeRpc = (id: number | null, method: string, params: unknown): void => {
    const message =
      id == null ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id, method, params }
    options.onRawFrame?.('out', message)
    try {
      child.stdin?.write(encodeAcpFrame(message))
    } catch {
      // stdin may be gone if the child exited; ignored.
    }
  }

  // Write a raw JSON-RPC response object (already shaped {jsonrpc,id,result}).
  const writeResponse = (message: Record<string, unknown>): void => {
    options.onRawFrame?.('out', message)
    try {
      child.stdin?.write(encodeAcpFrame(message))
    } catch {
      // stdin may be gone if the child exited; ignored.
    }
  }

  // G5 — answer an inbound session/request_permission. Resolves the decision
  // (handler or default DENY), then writes the response. Default-deny means a
  // missing handler / rejected promise can never silently allow a tool, and the
  // agent never hangs waiting for a reply.
  const answerPermissionRequest = (request: AcpPermissionRequest): void => {
    const fallbackDeny = (): void =>
      writeResponse(buildAcpPermissionResponse(request.rpcId, request.options, 'deny'))
    let decision: AcpPermissionDecision | Promise<AcpPermissionDecision>
    try {
      decision = options.onPermissionRequest ? options.onPermissionRequest(request) : 'deny'
    } catch {
      fallbackDeny()
      return
    }
    Promise.resolve(decision)
      .then((resolved) =>
        writeResponse(buildAcpPermissionResponse(request.rpcId, request.options, resolved))
      )
      .catch(fallbackDeny)
    // Surface the request in the transcript only when no mediator is wired
    // (so the user sees WHY a tool was declined). With a handler (G5c) the
    // ledger card is the surface, so stay quiet here.
    if (!options.onPermissionRequest) {
      options.onEvent({
        type: 'provider_warning',
        text: `Grok requested a tool (${request.toolName}) — declined because no TaskWraith permission mediator was attached.`
      })
    }
  }

  // Step 1 — initialize handshake (read-only client capabilities).
  writeRpc(ACP_ID.initialize, 'initialize', {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    clientInfo: { name: 'taskwraith', version: '1.0.6' }
  })

  child.stdout?.on('data', (chunk) => {
    const parsed = parseAcpStreamChunk(chunk.toString(), carry)
    carry = parsed.carry
    for (const message of parsed.messages) {
      options.onRawFrame?.('in', message)
      // G5 — inbound agent→client request: answer tool-permission asks before
      // anything else (it's a request with an id + method, not a response).
      if (isAcpPermissionRequest(message)) {
        const request = parseAcpPermissionRequest(message)
        if (request) answerPermissionRequest(request)
        continue
      }
      // A JSON-RPC ERROR response to one of our lifecycle requests (initialize /
      // session/new / session/prompt) must FAIL the turn. The client only
      // advances on `result`, so without this it waits forever for a result that
      // never arrives — observed: a rejected session/new mcpServers entry hung the
      // turn in "Thinking…". Surface the reason and kill so onClose fires.
      if (
        message.error &&
        (message.id === ACP_ID.initialize ||
          message.id === ACP_ID.sessionNew ||
          message.id === ACP_ID.prompt)
      ) {
        const rpcError = message.error as { message?: string; data?: unknown }
        const step =
          message.id === ACP_ID.initialize
            ? 'initialize'
            : message.id === ACP_ID.sessionNew
              ? 'session/new'
              : 'session/prompt'
        const detail = typeof rpcError?.data === 'string' ? ` (${rpcError.data})` : ''
        options.onEvent({
          type: 'provider_warning',
          text: `Grok ACP ${step} failed: ${rpcError?.message || 'request error'}${detail}`
        })
        child.kill('SIGINT')
        continue
      }
      // Lifecycle correlation by request id (single sequential flow).
      if (message.id === ACP_ID.initialize && message.result) {
        // Step 2 — create a session in the workspace. mcpServers carries the
        // TaskWraith scoped bridge for a read-only seat (G5b); empty otherwise (G4).
        writeRpc(ACP_ID.sessionNew, 'session/new', {
          cwd: options.cwd,
          mcpServers: options.mcpServers ?? []
        })
        continue
      }
      if (message.id === ACP_ID.sessionNew && message.result) {
        const result = message.result as { sessionId?: string }
        sessionId = typeof result.sessionId === 'string' ? result.sessionId : ''
        if (sessionId) options.onEvent({ type: 'init', sessionId })
        if (!promptSent) {
          promptSent = true
          // Step 3 — the prompt (the only step that calls the model).
          writeRpc(ACP_ID.prompt, 'session/prompt', {
            sessionId,
            prompt: [{ type: 'text', text: options.prompt }]
          })
        }
        continue
      }
      // Transport keep-alive: any OTHER inbound agent→client request (a method
      // WITH an id we didn't handle above — e.g. an _x.ai/* extension or an
      // fs/terminal method) MUST get a JSON-RPC reply, or Grok aborts the
      // channel ("ext_method" / "channel closed"). Answer method-not-found —
      // never an allow. Notifications (method, no id) + responses fall through
      // to the run-event mapper below.
      if (isAcpInboundRequest(message)) {
        writeResponse(buildAcpMethodNotFoundResponse(message.id as number | string))
        continue
      }
      // Everything else: stream updates / capture completion. We forward
      // content + thinking to the sink, but NOT the ACP `result` — the caller
      // synthesizes the canonical result/exit from onClose (mirrors the
      // headless path). A result event signals the turn is done and carries
      // the stopReason the caller needs for honest final status.
      for (const event of acpMessageToRunEvents(message)) {
        if (event.type === 'result') {
          turnComplete = true
          terminalStatus = event.status || terminalStatus
        } else {
          options.onEvent(event)
        }
      }
      if (turnComplete) {
        // Normal completion: just close the process (do NOT session/cancel —
        // that's only for interrupting an in-progress turn).
        setTimeout(() => child.kill('SIGINT'), 25)
      }
    }
  })

  child.stderr?.on('data', (chunk) => {
    const text = chunk.toString().trim()
    if (text) options.onEvent({ type: 'provider_warning', text })
  })

  child.on('error', (err) => {
    options.onEvent({ type: 'provider_warning', text: formatGrokProcessError(err) })
    options.onClose?.(1, turnComplete, terminalStatus)
  })
  child.on('close', (code) => options.onClose?.(code, turnComplete, terminalStatus))

  return {
    cancel: () => {
      if (sessionId && !turnComplete) writeRpc(null, 'session/cancel', { sessionId })
      child.kill('SIGINT')
    }
  }
}
