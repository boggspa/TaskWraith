// Provider-neutral bidirectional JSON-RPC (ACP) turn client. Drives the
// initialize → session/new → session/prompt lifecycle, streams session/update
// notifications through onEvent, mediates session/request_permission, and keeps
// the transport alive by answering every inbound request. Process spawn is
// INJECTED so the state machine is unit-testable against a fake child.
//
// This is the extraction of the Grok ACP client's guts (dossier slice 2):
// GrokAcpClient now delegates here with Grok-shaped hooks, and KimiAcpClient
// delegates here with Kimi-shaped hooks (fs client-authority handlers, its own
// initialize capabilities). The three provider-specific seams are hooks:
//   - initializeParams:   the `initialize` params (Grok disables fs caps;
//                         Kimi advertises fs read+write to regain workspace
//                         authority over every built-in file tool).
//   - onInboundRequest:   handle an inbound agent→client request the core does
//                         not (Kimi answers fs/read_text_file + fs/write_text_file
//                         here); return true when handled, false to fall through
//                         to the method-not-found keep-alive.
//   - deniedToolRecovery: optional one-shot same-session recovery prompt after a
//                         provider converts a denied native tool into a terminal
//                         cancellation (Grok-only; Kimi passes null).
//   - formatProcessError: provider-specific spawn/ENOENT copy.
//
// SAFETY: the permission machinery DEFAULTS TO DENY. A missing handler, a
// thrown handler, a rejected promise, or a late/stale decision can never
// resolve to an allow — mirrors the Grok default-deny contract exactly.

import {
  encodeAcpFrame,
  parseAcpStreamChunk,
  acpMessageToRunEvents,
  isAcpPermissionRequest,
  parseAcpPermissionRequest,
  buildAcpPermissionResponse,
  isAcpInboundRequest,
  buildAcpMethodNotFoundResponse,
  type AcpRunEvent,
  type AcpPermissionRequest,
  type AcpPermissionDecision
} from './AcpProtocol'

/** Minimal child-process surface this client needs (subset of ChildProcess). */
export interface AcpChildProcess {
  stdin: {
    write(data: string, cb?: (err?: Error | null) => void): boolean | void
    on?(event: 'error', listener: (err: Error) => void): void
    /** Close the stdin stream (EOF). Some ACP servers (Kimi Code) exit on stdin
     *  EOF and ignore SIGINT/SIGTERM entirely — see endProcess. */
    end?(): void
    destroyed?: boolean
    writable?: boolean
    writableEnded?: boolean
    writableDestroyed?: boolean
  } | null
  stdout: { on(event: 'data', listener: (chunk: Buffer | string) => void): void } | null
  stderr: { on(event: 'data', listener: (chunk: Buffer | string) => void): void } | null
  on(event: 'error', listener: (err: Error) => void): void
  on(event: 'close', listener: (code: number | null) => void): void
  kill(signal?: string): void
}

/** Helpers passed to onInboundRequest so a handler can reply without knowing
 *  the frame shape. Exactly one reply per request; the core does not reply
 *  again once the handler returns true. */
export interface AcpInboundReply {
  respondResult: (result: unknown) => void
  respondError: (code: number, message: string) => void
}

export interface AcpDeniedToolRecovery {
  /** True for a terminal status that represents "cancelled because a native
   *  tool was denied" (vs a genuine end_turn/error). */
  detect: (status: string | null | undefined) => boolean
  /** The single bounded follow-up prompt sent into the same session. */
  prompt: string
}

export interface AcpTurnOptions {
  prompt: string
  cwd: string
  /** Spawns the provider's ACP stdio process (injected for testability). */
  spawnProcess: () => AcpChildProcess
  /** The `initialize` request params (protocolVersion + clientCapabilities +
   *  optional clientInfo). The caller owns the fs-capability decision. */
  initializeParams: Record<string, unknown>
  /** MCP servers advertised to session/new (per-run TaskWraith bridge). */
  mcpServers?: unknown[]
  /** Normalized run events: content / thinking / init / result / tool / warning. */
  onEvent: (event: AcpRunEvent) => void
  onProcess?: (child: AcpChildProcess) => void
  /**
   * Client-mediated tool approval. When omitted, the default is DENY. A real
   * handler routes the request to the TaskWraith approval flow and returns the
   * decision written back.
   */
  onPermissionRequest?: (
    request: AcpPermissionRequest
  ) => AcpPermissionDecision | Promise<AcpPermissionDecision>
  /**
   * Handle an inbound agent→client request the core does not (fs/*, terminal/*,
   * provider extensions). Return true when a reply was sent via `reply`; return
   * false/undefined to fall through to the method-not-found keep-alive. Must be
   * synchronous about whether it will handle the request; the reply itself may
   * be issued asynchronously.
   */
  onInboundRequest?: (
    message: Record<string, unknown>,
    reply: AcpInboundReply
  ) => boolean | undefined
  /** Optional Grok-style denied-tool one-shot recovery. Null/omitted disables it. */
  deniedToolRecovery?: AcpDeniedToolRecovery | null
  /** Provider-specific formatting for a spawn/process error (ENOENT copy etc). */
  formatProcessError?: (err: Error) => string
  /**
   * How to terminate the ACP process after a completed turn or on cancel.
   * Default kills with SIGINT (Grok's `agent stdio` exits on SIGINT). Kimi Code's
   * `kimi acp` IGNORES SIGINT AND SIGTERM and only exits on stdin EOF, so its
   * adapter passes an stdin-close terminator. A SIGKILL backstop
   * (endProcessGraceMs) fires if the graceful terminator does not produce a
   * `close` in time, so no provider can ever hang a run.
   */
  endProcess?: (child: AcpChildProcess) => void
  /** Grace period before the SIGKILL backstop force-kills (default 4000ms). */
  endProcessGraceMs?: number
  /**
   * Called once when the child exits. `turnComplete` is true when the prompt
   * reached a terminal stopReason before exit; `terminalStatus` is that raw
   * status so callers can distinguish end_turn from Cancelled/PermissionRejected.
   */
  onClose?: (code: number | null, turnComplete: boolean, terminalStatus?: string) => void
  /** Opt-in raw JSON-RPC frame tap (both directions) for gated debug capture. */
  onRawFrame?: (direction: 'in' | 'out', message: unknown) => void
}

export interface AcpTurnHandle {
  /** User-initiated cancel: session/cancel (protocol) then kill. */
  cancel: () => void
}

const ACP_ID = { initialize: 1, sessionNew: 2, prompt: 3 } as const

function isTerminalStdinWriteError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null | undefined)?.code
  return (
    code === 'EPIPE' ||
    code === 'ECONNRESET' ||
    code === 'ERR_STREAM_DESTROYED' ||
    code === 'ERR_STREAM_WRITE_AFTER_END'
  )
}

/** Route RunManager cancellation through the provider handle before its raw
 *  process fallback runs (shared by every ACP provider). */
export function createAcpTurnAbortController(handle: { cancel: () => void }): AbortController {
  const controller = new AbortController()
  controller.signal.addEventListener('abort', () => handle.cancel(), { once: true })
  return controller
}

/**
 * Run a single ACP turn. Returns a handle whose `cancel()` interrupts an
 * in-progress turn. The caller wires `onEvent` to its run-event sink and
 * synthesizes the canonical result/exit from `onClose`.
 */
export function runAcpTurn(options: AcpTurnOptions): AcpTurnHandle {
  const child = options.spawnProcess()
  options.onProcess?.(child)

  let carry = ''
  let sessionId = ''
  let promptSent = false
  let turnComplete = false
  let terminalStatus: string | undefined
  let stdinClosed = false
  let closed = false
  let nextPromptRpcId = ACP_ID.prompt
  let activePromptRpcId: number | null = null
  let deniedPromptRpcId: number | null = null
  let deniedToolRecoveryAttempted = false
  let cancelRequested = false

  child.stdin?.on?.('error', (err) => {
    if (isTerminalStdinWriteError(err)) {
      stdinClosed = true
      return
    }
    options.onEvent({ type: 'provider_warning', text: err.message || String(err) })
  })

  const writeFrame = (message: Record<string, unknown>): void => {
    options.onRawFrame?.('out', message)
    const stdin = child.stdin
    if (
      stdinClosed ||
      !stdin ||
      stdin.destroyed ||
      stdin.writableEnded ||
      stdin.writableDestroyed ||
      stdin.writable === false
    ) {
      return
    }
    try {
      stdin.write(encodeAcpFrame(message), (err?: Error | null) => {
        if (!err) return
        if (isTerminalStdinWriteError(err)) {
          stdinClosed = true
          return
        }
        options.onEvent({ type: 'provider_warning', text: err.message || String(err) })
      })
    } catch (err) {
      if (isTerminalStdinWriteError(err)) {
        stdinClosed = true
        return
      }
      options.onEvent({
        type: 'provider_warning',
        text: err instanceof Error ? err.message : String(err)
      })
    }
  }

  const writeRpc = (id: number | null, method: string, params: unknown): void => {
    const message =
      id == null ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id, method, params }
    writeFrame(message)
  }

  const sendPrompt = (text: string): number | null => {
    if (cancelRequested || closed || stdinClosed) return null
    const promptRpcId = nextPromptRpcId++
    activePromptRpcId = promptRpcId
    writeRpc(promptRpcId, 'session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text }]
    })
    return promptRpcId
  }

  const writeResponse = (message: Record<string, unknown>): void => {
    writeFrame(message)
  }

  // Terminate the ACP process using the provider's terminator (default SIGINT),
  // with a SIGKILL backstop so a server that ignores the graceful signal (Kimi
  // Code ignores SIGINT+SIGTERM) can never leave the run hanging. Idempotent.
  let terminationRequested = false
  let killBackstop: ReturnType<typeof setTimeout> | null = null
  const clearKillBackstop = (): void => {
    if (killBackstop) {
      clearTimeout(killBackstop)
      killBackstop = null
    }
  }
  const endProcess = (): void => {
    if (terminationRequested) return
    terminationRequested = true
    try {
      if (options.endProcess) options.endProcess(child)
      else child.kill('SIGINT')
    } catch {
      try {
        child.kill('SIGKILL')
      } catch {
        /* ignore */
      }
    }
    if (!closed) {
      killBackstop = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          /* ignore */
        }
      }, options.endProcessGraceMs ?? 4000)
    }
  }

  const answerPermissionRequest = (request: AcpPermissionRequest): void => {
    const permissionPromptRpcId = activePromptRpcId
    const permissionPromptIsCurrent = (): boolean =>
      permissionPromptRpcId !== null &&
      permissionPromptRpcId === activePromptRpcId &&
      !cancelRequested &&
      !closed &&
      !turnComplete
    const recordDeniedPrompt = (): void => {
      if (permissionPromptIsCurrent()) {
        deniedPromptRpcId = permissionPromptRpcId
      }
    }
    const fallbackDeny = (): void => {
      if (!permissionPromptIsCurrent()) return
      recordDeniedPrompt()
      writeResponse(buildAcpPermissionResponse(request.rpcId, request.options, 'deny'))
    }
    let decision: AcpPermissionDecision | Promise<AcpPermissionDecision>
    try {
      decision = options.onPermissionRequest ? options.onPermissionRequest(request) : 'deny'
    } catch {
      fallbackDeny()
      return
    }
    Promise.resolve(decision)
      .then((resolved) => {
        // A ledger decision can outlive its turn. A late allow must never cross
        // cancellation/close or answer a newer recovery prompt; discard stale.
        if (!permissionPromptIsCurrent()) return
        if (resolved === 'deny') recordDeniedPrompt()
        writeResponse(buildAcpPermissionResponse(request.rpcId, request.options, resolved))
      })
      .catch(fallbackDeny)
    // Surface the request in the transcript only when no mediator is wired, so
    // the user sees WHY a tool was declined. With a handler the ledger card is
    // the surface, so stay quiet here.
    if (!options.onPermissionRequest) {
      options.onEvent({
        type: 'provider_warning',
        text: `The agent requested a tool (${request.toolName}) — declined because no TaskWraith permission mediator was attached.`
      })
    }
  }

  // Step 1 — initialize handshake with the caller-owned capabilities.
  writeRpc(ACP_ID.initialize, 'initialize', options.initializeParams)

  child.stdout?.on('data', (chunk) => {
    const parsed = parseAcpStreamChunk(chunk.toString(), carry)
    carry = parsed.carry
    for (const message of parsed.messages) {
      options.onRawFrame?.('in', message)
      // Inbound agent→client request: answer tool-permission asks before all else.
      if (isAcpPermissionRequest(message)) {
        const request = parseAcpPermissionRequest(message)
        if (request) answerPermissionRequest(request)
        continue
      }
      // A JSON-RPC ERROR response to a lifecycle request must FAIL the turn — the
      // client only advances on `result`, so without this it waits forever.
      if (
        message.error &&
        (message.id === ACP_ID.initialize ||
          message.id === ACP_ID.sessionNew ||
          (typeof message.id === 'number' && message.id === activePromptRpcId))
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
          text: `ACP ${step} failed: ${rpcError?.message || 'request error'}${detail}`
        })
        // Terminate via the provider terminator + SIGKILL backstop — a bare
        // SIGINT is ignored by Kimi Code's `kimi acp`, which would orphan the
        // process and hang the run (close never fires → onClose teardown never
        // runs → isolated home leaks).
        endProcess()
        continue
      }
      if (message.id === ACP_ID.initialize && message.result) {
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
          sendPrompt(options.prompt)
        }
        continue
      }
      // Any OTHER inbound agent→client request: give a provider hook first
      // chance (Kimi fs handlers), else answer method-not-found so the peer
      // never aborts the channel. A hook reply, like method-not-found, is never
      // an allow/result-for-a-tool.
      if (isAcpInboundRequest(message)) {
        const rpcId = message.id as number | string
        let replied = false
        const reply: AcpInboundReply = {
          respondResult: (result: unknown) => {
            replied = true
            writeResponse({ jsonrpc: '2.0', id: rpcId, result })
          },
          respondError: (code: number, errMessage: string) => {
            replied = true
            writeResponse({ jsonrpc: '2.0', id: rpcId, error: { code, message: errMessage } })
          }
        }
        const handled = options.onInboundRequest?.(message, reply)
        if (!handled && !replied) {
          writeResponse(buildAcpMethodNotFoundResponse(rpcId))
        }
        continue
      }
      // Notifications + responses: stream content/thinking; capture completion.
      for (const event of acpMessageToRunEvents(message)) {
        if (event.type === 'result') {
          const responsePromptRpcId =
            typeof message.id === 'number' && message.id === activePromptRpcId
              ? message.id
              : null
          if (responsePromptRpcId === null) continue
          const status = event.status || terminalStatus
          if (
            options.deniedToolRecovery &&
            !cancelRequested &&
            deniedPromptRpcId === responsePromptRpcId &&
            !deniedToolRecoveryAttempted &&
            options.deniedToolRecovery.detect(status)
          ) {
            // The provider converted a denied native tool into a terminal
            // cancellation. Keep the DENY, but give the same session one bounded
            // follow-up prompt so the participant can report from evidence.
            deniedToolRecoveryAttempted = true
            deniedPromptRpcId = null
            options.onEvent({
              type: 'provider_warning',
              text: 'The agent cancelled after a denied native tool; continuing without the denied tool.'
            })
            sendPrompt(options.deniedToolRecovery.prompt)
            continue
          }
          activePromptRpcId = null
          deniedPromptRpcId = null
          turnComplete = true
          terminalStatus = status
        } else {
          options.onEvent(event)
        }
      }
      if (turnComplete) {
        setTimeout(() => endProcess(), 25)
      }
    }
  })

  child.stderr?.on('data', (chunk) => {
    const text = chunk.toString().trim()
    if (text) options.onEvent({ type: 'provider_warning', text })
  })

  child.on('error', (err) => {
    closed = true
    clearKillBackstop()
    activePromptRpcId = null
    deniedPromptRpcId = null
    const text = options.formatProcessError ? options.formatProcessError(err) : err.message || String(err)
    options.onEvent({ type: 'provider_warning', text })
    options.onClose?.(1, turnComplete, terminalStatus)
  })
  child.on('close', (code) => {
    closed = true
    clearKillBackstop()
    activePromptRpcId = null
    deniedPromptRpcId = null
    options.onClose?.(code, turnComplete, terminalStatus)
  })

  return {
    cancel: () => {
      cancelRequested = true
      activePromptRpcId = null
      deniedPromptRpcId = null
      // Interrupt an in-progress turn first (protocol), then terminate the
      // process via the provider terminator + SIGKILL backstop.
      if (sessionId && !turnComplete) writeRpc(null, 'session/cancel', { sessionId })
      endProcess()
    }
  }
}
