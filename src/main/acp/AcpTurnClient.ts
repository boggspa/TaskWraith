// Provider-neutral bidirectional JSON-RPC (ACP) turn client. Drives the
// initialize → session/new|session/resume → optional session config →
// session/prompt lifecycle, streams session/update
// notifications through onEvent, mediates session/request_permission, and keeps
// the transport alive by answering every inbound request. Process spawn is
// INJECTED so the state machine is unit-testable against a fake child.
//
// This is the extraction of the Grok ACP client's guts (dossier slice 2):
// GrokAcpClient now delegates here with Grok-shaped hooks, and KimiAcpClient
// delegates here with Kimi-shaped hooks and its own initialize posture. The
// provider-specific seams are hooks:
//   - initializeParams:   the `initialize` params. Production Kimi advertises
//                         no client-fs capability; its workspace surface is the
//                         governed per-run HTTP MCP gateway.
//   - onInboundRequest:   handle an inbound agent→client request the core does
//                         not; return true when handled, false to fall through
//                         to the method-not-found keep-alive. Production Kimi
//                         installs no filesystem request handler.
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
  /**
   * Existing provider-native ACP session to rehydrate. The neutral client only
   * sends `session/resume` when the initialize response advertises that
   * capability; otherwise it opens a fresh session.
   */
  resumeSessionId?: string | null
  /**
   * Full-context prompt to use when a requested resume is unavailable or the
   * resume RPC rejects the saved session. This is intentionally separate from
   * `prompt`: callers may send a slim prompt on the native-resume path while
   * retaining an authorized cold-session recovery prompt.
   */
  resumeFallbackPrompt?: string
  /** Fail the turn instead of falling back to session/new after resume rejects. */
  allowResumeFallback?: boolean
  /**
   * Provider-supported ACP config selections to re-assert after a successful
   * session/resume and before the prompt. Kimi persists model/thinking in its
   * native session, so process-level defaults alone cannot change them on a
   * resumed turn.
   */
  resumeConfigOptions?: ReadonlyArray<{ configId: string; value: string }>
  /**
   * Config selections to apply to a FRESHLY opened session, after session/new
   * and before the prompt.
   *
   * Distinct from `resumeConfigOptions`, which only re-asserts settings a
   * provider persisted in its own session. This is for providers that expose no
   * other way to configure a run: Mistral Vibe's `vibe-acp` has no CLI surface
   * at all (`[-h] [-v] [--setup]`), so its model AND its permission mode can
   * only be selected here. Without it a Vibe seat silently inherits whatever
   * `active_model` sits in the user's global ~/.vibe/config.toml, and a
   * read-only seat never leaves the write-capable `default` mode.
   */
  sessionConfigOptions?: ReadonlyArray<{ configId: string; value: string }>
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
   * Async spawn admission that must finish before the first initialize frame.
   * Kimi uses this to durably bind its OAuth lease to the exact child PID/birth.
   */
  beforeInitialize?: (child: AcpChildProcess) => Promise<void>
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
  onClose?: (
    code: number | null,
    turnComplete: boolean,
    terminalStatus?: string
  ) => void | Promise<void>
  /** Opt-in raw JSON-RPC frame tap (both directions) for gated debug capture. */
  onRawFrame?: (direction: 'in' | 'out', message: unknown) => void
  /** Called after session/new or session/resume succeeds, before config/prompt. */
  onSessionReady?: (session: {
    sessionId: string
    resumed: boolean
    fallbackFromResume: boolean
  }) => void
}

export interface AcpTurnHandle {
  /** User-initiated cancel: session/cancel (protocol) then kill. */
  cancel: () => void
  /**
   * Resolves only after the exact child emits `close` and the provider-owned
   * `onClose` callback has settled. A kill request is not close evidence, and
   * async cleanup/projection performed by `onClose` remains inside this join.
   */
  closed: Promise<void>
}

// Keep prompt=3 for compatibility with existing protocol traces. Resume uses a
// separate lifecycle id and completes before the prompt is dispatched.
const ACP_ID = { initialize: 1, sessionNew: 2, prompt: 3, sessionResume: 4 } as const
const ACP_CONFIG_RPC_START = 1_000

function nonEmptyString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

interface AcpAdvertisedConfigOption {
  id: string
  currentValue?: unknown
  values: string[]
}

function advertisedConfigOptions(result: unknown): AcpAdvertisedConfigOption[] {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return []
  const raw = (result as { configOptions?: unknown }).configOptions
  if (!Array.isArray(raw)) return []
  const out: AcpAdvertisedConfigOption[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const record = entry as { id?: unknown; currentValue?: unknown; options?: unknown }
    const id = nonEmptyString(record.id)
    if (!id) continue
    const values = Array.isArray(record.options)
      ? record.options
          .map((option) =>
            option && typeof option === 'object' && !Array.isArray(option)
              ? nonEmptyString((option as { value?: unknown }).value)
              : ''
          )
          .filter(Boolean)
      : []
    out.push({ id, currentValue: record.currentValue, values })
  }
  return out
}

/** ACP 0.2-era agents exposed loadSession as a top-level boolean; current ACP
 * agents advertise the lighter session/resume method under sessionCapabilities.
 * Only the latter is sufficient here because TaskWraith owns transcript UI and
 * must not replay provider history as fresh updates. */
function agentSupportsSessionResume(initializeResult: unknown): boolean {
  if (!initializeResult || typeof initializeResult !== 'object' || Array.isArray(initializeResult)) {
    return false
  }
  const capabilities = (initializeResult as { agentCapabilities?: unknown }).agentCapabilities
  if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) return false
  const sessionCapabilities = (capabilities as { sessionCapabilities?: unknown })
    .sessionCapabilities
  if (
    !sessionCapabilities ||
    typeof sessionCapabilities !== 'object' ||
    Array.isArray(sessionCapabilities)
  ) {
    return false
  }
  return Object.prototype.hasOwnProperty.call(sessionCapabilities, 'resume')
}

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
  // Create both join authorities before spawning. `onProcess` is deliberately
  // invoked only after child close/error listeners are installed below.
  let resolveClosed!: () => void
  const closeSettled = new Promise<void>((resolve) => {
    resolveClosed = resolve
  })
  let resolveStartup!: () => void
  const startupSettled = new Promise<void>((resolve) => {
    resolveStartup = resolve
  })
  let startupSettlementDelivered = false
  const settleStartup = (): void => {
    if (startupSettlementDelivered) return
    startupSettlementDelivered = true
    resolveStartup()
  }

  const child = options.spawnProcess()

  let carry = ''
  let sessionId = ''
  const requestedResumeSessionId = nonEmptyString(options.resumeSessionId)
  const resumeRequested = Boolean(requestedResumeSessionId)
  let resumeRpcSent = false
  let fallbackFromResume = false
  let promptForTurn = options.prompt
  let promptSent = false
  let turnComplete = false
  let terminalStatus: string | undefined
  let stdinClosed = false
  let closed = false
  let nextPromptRpcId = ACP_ID.prompt
  let nextConfigRpcId = ACP_CONFIG_RPC_START
  let resumeConfigQueue: Array<{ configId: string; value: string }> = []
  const pendingConfigRpcs = new Map<number, { configId: string; value: string }>()
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
    // RPC id 4 is reserved for session/resume. The first prompt remains id 3
    // for trace compatibility; any recovery prompt continues at 5.
    if (nextPromptRpcId === ACP_ID.sessionResume) nextPromptRpcId += 1
    activePromptRpcId = promptRpcId
    writeRpc(promptRpcId, 'session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text }]
    })
    return promptRpcId
  }

  const sendSessionNew = (isResumeFallback: boolean): void => {
    fallbackFromResume = isResumeFallback
    if (isResumeFallback && typeof options.resumeFallbackPrompt === 'string') {
      promptForTurn = options.resumeFallbackPrompt
    }
    writeRpc(ACP_ID.sessionNew, 'session/new', {
      cwd: options.cwd,
      mcpServers: options.mcpServers ?? []
    })
  }

  const sendPromptOnce = (): void => {
    if (promptSent) return
    promptSent = true
    sendPrompt(promptForTurn)
  }

  const applyNextResumeConfig = (result: unknown): void => {
    if (resumeConfigQueue.length === 0) {
      sendPromptOnce()
      return
    }
    const advertised = advertisedConfigOptions(result)
    const desired = resumeConfigQueue.shift()!
    const option = advertised.find((candidate) => candidate.id === desired.configId)
    if (!option) {
      options.onEvent({
        type: 'provider_warning',
        text: `ACP resumed session did not advertise config option "${desired.configId}"; keeping its persisted value.`
      })
      applyNextResumeConfig(result)
      return
    }
    if (String(option.currentValue ?? '') === desired.value) {
      applyNextResumeConfig(result)
      return
    }
    if (option.values.length > 0 && !option.values.includes(desired.value)) {
      options.onEvent({
        type: 'provider_warning',
        text: `ACP resumed session does not offer "${desired.value}" for config option "${desired.configId}"; keeping its persisted value.`
      })
      applyNextResumeConfig(result)
      return
    }
    const rpcId = nextConfigRpcId++
    pendingConfigRpcs.set(rpcId, desired)
    writeRpc(rpcId, 'session/set_config_option', {
      sessionId,
      configId: desired.configId,
      value: desired.value
    })
  }

  const sessionReady = (resumed: boolean, result: unknown): void => {
    if (sessionId) {
      options.onEvent({ type: 'init', sessionId })
      options.onSessionReady?.({ sessionId, resumed, fallbackFromResume })
    }
    // A resumed session re-asserts what the provider persisted; a fresh one
    // applies the run's chosen configuration. Both drain through the same queue
    // and both end at sendPromptOnce().
    const requestedConfig = resumed ? options.resumeConfigOptions : options.sessionConfigOptions
    if (requestedConfig?.length) {
      resumeConfigQueue = requestedConfig
        .map((option) => ({
          configId: nonEmptyString(option.configId),
          value: nonEmptyString(option.value)
        }))
        .filter((option) => option.configId && option.value)
      applyNextResumeConfig(result)
    } else {
      sendPromptOnce()
    }
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
          message.id === ACP_ID.sessionResume ||
          (typeof message.id === 'number' && message.id === activePromptRpcId))
      ) {
        const rpcError = message.error as { message?: string; data?: unknown }
        if (
          message.id === ACP_ID.sessionResume &&
          options.allowResumeFallback !== false &&
          !promptSent
        ) {
          // A persisted id may pre-date native resume support, its seat home may
          // have been cleared, or the provider may reject a corrupt checkpoint.
          // Recover in the same authenticated ACP process with the separately
          // authorized full-context prompt.
          sessionId = ''
          sendSessionNew(true)
          continue
        }
        const step =
          message.id === ACP_ID.initialize
            ? 'initialize'
            : message.id === ACP_ID.sessionNew
              ? 'session/new'
              : message.id === ACP_ID.sessionResume
                ? 'session/resume'
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
      if (
        message.error &&
        typeof message.id === 'number' &&
        pendingConfigRpcs.has(message.id)
      ) {
        const config = pendingConfigRpcs.get(message.id)!
        pendingConfigRpcs.delete(message.id)
        const rpcError = message.error as { message?: string }
        options.onEvent({
          type: 'provider_warning',
          text: `ACP session config "${config.configId}" was not applied: ${
            rpcError?.message || 'request error'
          }`
        })
        applyNextResumeConfig({ configOptions: [] })
        continue
      }
      if (message.id === ACP_ID.initialize && message.result) {
        if (resumeRequested && agentSupportsSessionResume(message.result)) {
          resumeRpcSent = true
          writeRpc(ACP_ID.sessionResume, 'session/resume', {
            sessionId: requestedResumeSessionId,
            cwd: options.cwd,
            mcpServers: options.mcpServers ?? []
          })
        } else if (resumeRequested && options.allowResumeFallback === false) {
          options.onEvent({
            type: 'provider_warning',
            text: 'ACP session/resume is not advertised by this provider runtime.'
          })
          endProcess()
        } else {
          sendSessionNew(resumeRequested)
        }
        continue
      }
      if (message.id === ACP_ID.sessionNew && message.result) {
        const result = message.result as { sessionId?: string }
        sessionId = typeof result.sessionId === 'string' ? result.sessionId : ''
        sessionReady(false, message.result)
        continue
      }
      if (message.id === ACP_ID.sessionResume && message.result && resumeRpcSent) {
        sessionId = requestedResumeSessionId
        fallbackFromResume = false
        sessionReady(true, message.result)
        continue
      }
      if (
        typeof message.id === 'number' &&
        message.result &&
        pendingConfigRpcs.has(message.id)
      ) {
        pendingConfigRpcs.delete(message.id)
        applyNextResumeConfig(message.result)
        continue
      }
      // Any OTHER inbound agent→client request: give a provider hook first
      // chance, else answer method-not-found so the peer
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

  let processError: Error | null = null
  let terminalCloseDelivered = false
  child.on('error', (err) => {
    // Do not terminalize on `error`: request provider-specific termination and
    // let the joined `close` boundary own cleanup/projection. A failed spawn or
    // transport can otherwise emit no useful exit on provider wrappers and
    // leave the run open indefinitely.
    processError = err
    const text = options.formatProcessError ? options.formatProcessError(err) : err.message || String(err)
    try {
      options.onEvent({ type: 'provider_warning', text })
    } catch {
      // Provider termination is authoritative even when transcript projection
      // throws while reporting the process error.
    } finally {
      endProcess()
    }
  })
  child.on('close', (code) => {
    if (terminalCloseDelivered) return
    terminalCloseDelivered = true
    closed = true
    clearKillBackstop()
    activePromptRpcId = null
    deniedPromptRpcId = null
    const terminalCode = processError && (code === null || code === 0) ? 1 : code
    // The public close authority includes provider-owned async cleanup and
    // terminal projection. Resolve even when that callback rejects: callers
    // need exact settlement evidence and providers own their error surface.
    // Child close is necessary but not sufficient: Kimi's beforeInitialize
    // records the exact provider PID/birth in its OAuth lease. Cancellation or
    // process failure must not allow cleanup/history receipt to overtake that
    // pending startup operation.
    const deliverTerminalClose = (): void => {
      let closeResult: void | Promise<void>
      try {
        closeResult = options.onClose?.(terminalCode, turnComplete, terminalStatus)
      } catch {
        resolveClosed()
        return
      }
      void Promise.resolve(closeResult)
        .catch(() => undefined)
        .then(resolveClosed)
    }
    if (startupSettlementDelivered) deliverTerminalClose()
    else void startupSettled.then(deliverTerminalClose)
  })

  const sendInitialize = (): void => {
    if (!closed && !cancelRequested) {
      writeRpc(ACP_ID.initialize, 'initialize', options.initializeParams)
    }
  }
  const stopForStartupFailure = (message: string): void => {
    try {
      options.onEvent({ type: 'provider_warning', text: message })
    } catch {
      // A throwing projection must not skip provider termination.
    }
    endProcess()
  }

  // Expose the child only after exact close/error listeners exist. A host hook
  // may partially attach the process and then throw; contain that failure,
  // request termination, return a joinable handle, and let real `close` own the
  // terminal boundary.
  let processExposureSucceeded = false
  try {
    options.onProcess?.(child)
    processExposureSucceeded = true
  } catch (error) {
    processError = error instanceof Error ? error : new Error(String(error))
    stopForStartupFailure(
      'ACP provider process registration failed; the process was stopped before initialization.'
    )
    settleStartup()
  }

  if (processExposureSucceeded && options.beforeInitialize) {
    let startupOperation: Promise<void>
    try {
      startupOperation = Promise.resolve(options.beforeInitialize(child))
    } catch {
      stopForStartupFailure(
        'ACP provider startup authority could not be committed; the process was stopped.'
      )
      settleStartup()
      startupOperation = Promise.resolve()
    }
    if (!startupSettlementDelivered) {
      void startupOperation
        .then(sendInitialize)
        .catch(() => {
          stopForStartupFailure(
            'ACP provider startup authority could not be committed; the process was stopped.'
          )
        })
        .finally(settleStartup)
    }
  } else if (processExposureSucceeded) {
    // Step 1 — initialize handshake with the caller-owned capabilities.
    try {
      sendInitialize()
    } catch {
      stopForStartupFailure(
        'ACP provider initialization could not be sent; the process was stopped.'
      )
    } finally {
      settleStartup()
    }
  }

  return {
    closed: closeSettled,
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
