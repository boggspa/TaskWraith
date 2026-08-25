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
//                         provider converts a denied permission or failed tool
//                         into a terminal turn (Kimi passes null).
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
import { isTransientAcpPromptFailure } from './AcpTransientPromptFailure'
import { appendSteeringMessage } from '../steering/SteeringMessageBatch'

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

export type AcpToolRecoveryReason =
  | 'denied-permission-cancellation'
  | 'failed-tool-terminal'

export interface AcpToolRecoveryContext {
  readonly reason: AcpToolRecoveryReason
  readonly terminalStatus: string | null | undefined
  readonly deniedPermissionRequest: AcpPermissionRequest | null
  readonly assistantTextSeen: boolean
  readonly toolFailureSeen: boolean
  readonly lastFailedToolName: string | null
  readonly lastFailedToolOutput: string | null
}

export interface AcpDeniedToolRecovery {
  /** True for a terminal status that represents "cancelled because a native
   *  tool was denied" (vs a genuine end_turn/error). */
  detect: (status: string | null | undefined) => boolean
  /** The single bounded follow-up prompt sent into the same session. */
  prompt: string | ((context: AcpToolRecoveryContext) => string)
  /** Additive provider seam for a terminal failed tool that did not travel
   * through session/request_permission (for example a declined broker tool). */
  shouldRecover?: (context: AcpToolRecoveryContext) => boolean
  /** Optional provider-specific, user-visible explanation for the recovery. */
  warning?: string | ((context: AcpToolRecoveryContext) => string)
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
   * Wire-prompt observation hook: called with the EXACT text of every
   * `session/prompt` this turn writes — the initial prompt, the
   * resume-fallback recovery prompt when a resume rejects (selected INSIDE
   * this client, invisible to the call site), and mid-turn steer injections.
   * Evidence only: never awaited, and a throwing hook must not affect the
   * turn (calls are wrapped).
   */
  onWirePrompt?: (text: string) => void
  /**
   * Optional provider adapter for live-steer continuity. Some ACP servers roll
   * a cancelled prompt's partial assistant output out of native history. The
   * core supplies a bounded tail so that adapter can frame it as already-shown
   * context alongside the authoritative user steer.
   */
  formatSteerPrompt?: (context: AcpSteerPromptContext) => string
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
  /**
   * Lifetime of `cwd` as a provider-visible workspace identity. A native
   * session may be resumed only when the path remains valid for that session's
   * whole lifetime; disposable run scratch must never be used for resume.
   */
  cwdLifetime: 'run' | 'session'
  cwd: string
  /** Spawns the provider's ACP stdio process (injected for testability). */
  spawnProcess: () => AcpChildProcess
  /** The `initialize` request params (protocolVersion + clientCapabilities +
   *  optional clientInfo). The caller owns the fs-capability decision. */
  initializeParams: Record<string, unknown>
  /** MCP servers advertised to session/new (per-run TaskWraith bridge). */
  mcpServers?: unknown[]
  /**
   * Called after session/resume succeeds and before config/prompt. Resolve
   * true to keep the resumed session; false to abandon it and mint a fresh
   * session/new instead (the resume-fallback prompt rides it, exactly as when
   * resume is not advertised). A rejected promise keeps the resumed session —
   * a broken probe must not cost a healthy session its history. Absent →
   * resumed sessions are always kept.
   */
  confirmResumedSession?: () => Promise<boolean>
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
   * How many times a TRANSIENT `session/prompt` RPC failure may be re-sent on
   * the same live session before the turn terminalizes (default 2). A provider
   * blip — xAI 500s are the observed case — leaves the agent process and its
   * ACP session healthy, so killing the turn discards a recoverable run. Only
   * failures `isTransientAcpPromptFailure` recognizes are retried; auth and
   * quota walls terminalize immediately, unchanged.
   */
  transientPromptRetryLimit?: number
  /**
   * Backoff before each transient prompt retry. A number is used verbatim for
   * every attempt; a function receives the 1-based attempt number. Default is
   * 1s then 3s. Tests pass 0.
   */
  transientPromptRetryDelayMs?: number | ((attempt: number) => number)
  /**
   * How far back stderr counts as describing the prompt failure being
   * classified (default 10_000ms). Providers log the upstream body to their
   * tracing channel and then reply with a bare JSON-RPC envelope — grok's gap
   * is ~13ms — so without this correlation the classifier sees no evidence at
   * all. Older stderr is ignored so a stale 500 cannot license an unrelated
   * retry.
   */
  stderrCorrelationWindowMs?: number
  /**
   * Called once when the child exits. `turnComplete` is true when the prompt
   * reached a terminal stopReason before exit; `terminalStatus` is that raw
   * status so callers can distinguish end_turn from Cancelled/PermissionRejected,
   * or `rpc_error:<step>` when an ACP lifecycle request failed before a terminal
   * response.
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
   * Mid-turn steering (Strategy A, "acp-interrupt"): cooperatively interrupt
   * the in-flight prompt with `session/cancel` and, when the provider closes
   * that prompt, re-prompt the SAME ACP session with `text` as the user's next
   * message. The session id, MCP servers, and provider-native history are all
   * preserved — unlike `cancel()` the process stays alive and the run keeps
   * streaming through the original `onEvent` sink.
   *
   * Returns false when there is no in-flight prompt to interrupt (startup,
   * settled, cancelled, closed, or empty text). The caller must then fall back
   * to boundary delivery — a false return NEVER delivers the text.
   *
   * Calls received before the first interrupt lands are batched in arrival
   * order; the provider still receives exactly one follow-up prompt per closed
   * turn, and every included delivery hook fires after that prompt is sent.
   */
  steer: (text: string, hooks?: AcpSteerDeliveryHooks) => boolean
  /**
   * Abandon a queued steering follow-up WITHOUT touching the run: the in-flight
   * prompt is left to finish (or to have finished) naturally and no follow-up
   * prompt is sent. Used when the user cancels the steer itself, and by
   * RunManager teardown paths that must not silently deliver a stale steer.
   */
  cancelSteer: () => void
  /**
   * Resolves only after the exact child emits `close` and the provider-owned
   * `onClose` callback has settled. A kill request is not close evidence, and
   * async cleanup/projection performed by `onClose` remains inside this join.
   */
  closed: Promise<void>
}

export interface AcpSteerDeliveryHooks {
  /** Fired after the follow-up session/prompt frame is written to the live ACP session. */
  onDelivered: () => void
}

export interface AcpSteerPromptContext {
  /** User-authored steering text accepted by the live transport. */
  readonly steerText: string
  /** Bounded tail of assistant text already streamed for the interrupted prompt. */
  readonly interruptedAssistantText: string
  readonly interruptedAssistantTextWasTruncated: boolean
  /** Exact prompt whose response was interrupted. */
  readonly interruptedPromptText: string
}

// Keep prompt=3 for compatibility with existing protocol traces. Resume uses a
// separate lifecycle id and completes before the prompt is dispatched.
const ACP_ID = { initialize: 1, sessionNew: 2, prompt: 3, sessionResume: 4 } as const
const ACP_CONFIG_RPC_START = 1_000
const MAX_ACP_STEER_ASSISTANT_CONTEXT_CHARS = 16 * 1024

function nonEmptyString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function acpToolCallId(value: Record<string, unknown>): string {
  return (
    nonEmptyString(value.toolCallId) || nonEmptyString(value.toolCallID) || nonEmptyString(value.id)
  )
}

function acpToolCallKey(sessionId: unknown, toolCall: Record<string, unknown>): string {
  const normalizedSessionId = nonEmptyString(sessionId)
  const toolCallId = acpToolCallId(toolCall)
  return normalizedSessionId && toolCallId ? `${normalizedSessionId}\u0000${toolCallId}` : ''
}

function toolOutputIndicatesFailure(value: string): boolean {
  return (
    /"ok"\s*:\s*false/i.test(value) ||
    /\buser\s+(?:declined|rejected|cancelled|canceled)\b/i.test(value) ||
    /\bpermission\s+(?:denied|rejected)\b/i.test(value) ||
    /\btool(?: call)?\s+(?:failed|rejected)\b/i.test(value)
  )
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
  const requestedResumeSessionId = nonEmptyString(options.resumeSessionId)
  if (requestedResumeSessionId && options.cwdLifetime !== 'session') {
    throw new Error('ACP session/resume requires a session-scoped cwd.')
  }
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
  let deniedPermissionRequest: AcpPermissionRequest | null = null
  let deniedToolRecoveryAttempted = false
  let assistantTextSeen = false
  let toolFailureSeen = false
  let lastFailedToolName: string | null = null
  let lastFailedToolOutput: string | null = null
  let lastObservedToolName: string | null = null
  const toolNamesById = new Map<string, string>()
  // ACP emits the full ToolCall notification before request_permission, but
  // some agents repeat only its id/title/kind in the permission request. Vibe
  // can also put its structured machine identity on a later tool_call_update
  // while omitting rawInput entirely. Retain a small, session-bound, one-use
  // merged copy so the permission adapter sees every correlated transport
  // field. This is presentation/correlation data only; it never changes the
  // permission decision.
  const pendingToolCalls = new Map<string, Record<string, unknown>>()
  const conflictedToolCallKeys = new Set<string>()
  const structuredToolMetadataConflicts = (
    first: Record<string, unknown> | null,
    second: Record<string, unknown> | null
  ): boolean =>
    Boolean(
      first &&
      second &&
      ['tool_name', 'effect_kind'].some(
        (field) =>
          first[field] !== undefined &&
          second[field] !== undefined &&
          first[field] !== second[field]
      )
    )
  const rememberToolCall = (message: Record<string, unknown>): void => {
    if (message.method !== 'session/update') return
    const params = isRecord(message.params) ? message.params : null
    const update = params && isRecord(params.update) ? params.update : null
    if (
      !update ||
      (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update')
    ) {
      return
    }
    if (!isRecord(update.rawInput) && !isRecord(update.input) && !isRecord(update._meta)) return
    const key = acpToolCallKey(params?.sessionId, update)
    if (!key) return
    if (conflictedToolCallKeys.has(key)) return
    const previous = pendingToolCalls.get(key)
    const previousMetadata = isRecord(previous?._meta) ? previous._meta : null
    const updateMetadata = isRecord(update._meta) ? update._meta : null
    if (structuredToolMetadataConflicts(previousMetadata, updateMetadata)) {
      pendingToolCalls.delete(key)
      conflictedToolCallKeys.add(key)
      if (conflictedToolCallKeys.size > 64) {
        const oldest = conflictedToolCallKeys.values().next().value
        if (typeof oldest === 'string') conflictedToolCallKeys.delete(oldest)
      }
      return
    }
    const merged = { ...previous, ...update }
    if (!isRecord(update.rawInput) && isRecord(previous?.rawInput)) {
      merged.rawInput = previous.rawInput
    }
    if (!isRecord(update.input) && isRecord(previous?.input)) merged.input = previous.input
    if (previousMetadata || updateMetadata) {
      merged._meta = { ...previousMetadata, ...updateMetadata }
    }
    pendingToolCalls.set(key, merged)
    if (pendingToolCalls.size > 64) {
      const oldest = pendingToolCalls.keys().next().value
      if (typeof oldest === 'string') pendingToolCalls.delete(oldest)
    }
  }
  const enrichPermissionRequest = (request: AcpPermissionRequest): AcpPermissionRequest => {
    const rawToolCall = request.rawToolCall
    if (!rawToolCall) return request
    const key = acpToolCallKey(request.sessionId, rawToolCall)
    if (!key) return request
    if (conflictedToolCallKeys.delete(key)) {
      pendingToolCalls.delete(key)
      return request
    }
    const remembered = pendingToolCalls.get(key)
    if (!remembered) return request
    pendingToolCalls.delete(key)
    const rememberedMetadata = isRecord(remembered._meta) ? remembered._meta : null
    const requestMetadata = isRecord(rawToolCall._meta) ? rawToolCall._meta : null
    if (structuredToolMetadataConflicts(rememberedMetadata, requestMetadata)) return request
    return {
      ...request,
      rawToolCall: {
        ...remembered,
        ...rawToolCall,
        ...(rememberedMetadata || requestMetadata
          ? { _meta: { ...rememberedMetadata, ...requestMetadata } }
          : {}),
        ...(!isRecord(rawToolCall.rawInput) && isRecord(remembered.input)
          ? { rawInput: remembered.input }
          : {})
      }
    }
  }
  let cancelRequested = false
  /**
   * Steering text queued by handle.steer() while a prompt is in flight. Set
   * when `session/cancel` is written; consumed when the provider closes the
   * interrupted prompt (result OR RPC error) and the follow-up prompt is sent.
   * Never survives the turn that owns it — a steer that never earns a prompt
   * close is left for the boundary-delivery path, exactly like pi's undrained
   * steering queue (see PiSteerDelivery finding 3).
   */
  let pendingSteer: { text: string; hooks: AcpSteerDeliveryHooks[] } | null = null
  // Text of the prompt currently in flight — the recovery prompt, not the
  // original, once recovery has taken over. A transient retry must re-send
  // whatever actually failed.
  let inFlightPromptText = ''
  let activePromptAssistantText = ''
  let activePromptAssistantTextWasTruncated = false
  let transientPromptRetries = 0
  let transientRetryTimer: ReturnType<typeof setTimeout> | null = null
  // Recent provider stderr, kept only long enough to explain a prompt failure
  // that arrives as a bare JSON-RPC envelope. Bounded in both time and bytes:
  // this is a classification hint, never a log.
  const recentStderr: Array<{ at: number; text: string }> = []
  const collectStderr = (text: string): void => {
    recentStderr.push({ at: Date.now(), text })
    while (recentStderr.length > 32) recentStderr.shift()
  }
  const stderrEvidence = (): string => {
    const windowMs = options.stderrCorrelationWindowMs ?? 10_000
    // A non-positive window disables correlation outright. Without this, 0 still
    // admits same-millisecond stderr, which reads as "off" but is not.
    if (windowMs <= 0) return ''
    const cutoff = Date.now() - windowMs
    return recentStderr
      .filter((entry) => entry.at >= cutoff)
      .map((entry) => entry.text)
      .join('\n')
      .slice(-8192)
  }

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
    deniedPromptRpcId = null
    deniedPermissionRequest = null
    assistantTextSeen = false
    toolFailureSeen = false
    lastFailedToolName = null
    lastFailedToolOutput = null
    lastObservedToolName = null
    toolNamesById.clear()
    const promptRpcId = nextPromptRpcId++
    // RPC id 4 is reserved for session/resume. The first prompt remains id 3
    // for trace compatibility; any recovery prompt continues at 5.
    if (nextPromptRpcId === ACP_ID.sessionResume) nextPromptRpcId += 1
    activePromptRpcId = promptRpcId
    inFlightPromptText = text
    activePromptAssistantText = ''
    activePromptAssistantTextWasTruncated = false
    if (options.onWirePrompt) {
      try {
        options.onWirePrompt(text)
      } catch {
        // Evidence only — a capture failure must never affect the turn.
      }
    }
    writeRpc(promptRpcId, 'session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text }]
    })
    return promptRpcId
  }

  const sendPendingSteer = (): boolean => {
    const pending = pendingSteer
    pendingSteer = null
    if (!pending || cancelRequested || closed || stdinClosed || !sessionId) return false
    let followUpPrompt = pending.text
    if (options.formatSteerPrompt) {
      try {
        const formatted = options.formatSteerPrompt({
          steerText: pending.text,
          interruptedAssistantText: activePromptAssistantText,
          interruptedAssistantTextWasTruncated: activePromptAssistantTextWasTruncated,
          interruptedPromptText: inFlightPromptText
        })
        if (formatted.trim()) followUpPrompt = formatted
      } catch {
        // A continuity aid must never lose an accepted steering instruction.
      }
    }
    if (sendPrompt(followUpPrompt) === null) return false
    for (const hook of pending.hooks) {
      try {
        hook.onDelivered()
      } catch {
        // Receipt evidence must not stop later receipts or live delivery.
      }
    }
    return true
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

  const clearTransientRetryTimer = (): void => {
    if (transientRetryTimer) {
      clearTimeout(transientRetryTimer)
      transientRetryTimer = null
    }
  }

  /**
   * Re-send the in-flight prompt on the same live session after a transient
   * upstream failure. Returns false when the budget is spent or the turn is no
   * longer eligible, in which case the caller terminalizes as before.
   */
  const scheduleTransientPromptRetry = (failureText: string): boolean => {
    if (cancelRequested || closed || stdinClosed || !sessionId) return false
    if (!inFlightPromptText) return false
    const limit = options.transientPromptRetryLimit ?? 2
    if (transientPromptRetries >= limit) return false
    const attempt = ++transientPromptRetries
    const configuredDelay = options.transientPromptRetryDelayMs
    const delayMs =
      typeof configuredDelay === 'function'
        ? configuredDelay(attempt)
        : typeof configuredDelay === 'number'
          ? configuredDelay
          : attempt === 1
            ? 1000
            : 3000
    const retryText = inFlightPromptText
    // The old rpc id already received its error response; sendPrompt allocates
    // a fresh one against the same sessionId.
    options.onEvent({
      type: 'provider_warning',
      text: `ACP session/prompt failed: ${failureText} — transient provider failure; retrying (${attempt}/${limit}) in ${Math.round(
        delayMs / 100
      ) / 10}s.`
    })
    clearTransientRetryTimer()
    transientRetryTimer = setTimeout(() => {
      transientRetryTimer = null
      if (cancelRequested || closed || stdinClosed || turnComplete) return
      sendPrompt(retryText)
    }, Math.max(0, delayMs))
    return true
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
    // A retry that lands after teardown begins would write into a dying stdin.
    clearTransientRetryTimer()
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
        deniedPermissionRequest = request
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
      rememberToolCall(message)
      // Inbound agent→client request: answer tool-permission asks before all else.
      if (isAcpPermissionRequest(message)) {
        const request = parseAcpPermissionRequest(message)
        if (request) answerPermissionRequest(enrichPermissionRequest(request))
        continue
      }
      // Steering interrupt acknowledgement, error-flavoured: some providers
      // answer our `session/cancel` with an RPC error on the interrupted
      // prompt instead of a prompt result. That still closes the prompt — send
      // the queued steering follow-up rather than failing the whole turn.
      if (
        message.error &&
        typeof message.id === 'number' &&
        message.id === activePromptRpcId &&
        pendingSteer
      ) {
        activePromptRpcId = null
        deniedPromptRpcId = null
        deniedPermissionRequest = null
        sendPendingSteer()
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
        const rpcError = message.error as { code?: unknown; message?: string; data?: unknown }
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
        // A transient upstream failure (provider 5xx, transport blip) leaves
        // this process and its ACP session healthy — only the model call died.
        // Re-send on the same session rather than discarding a recoverable
        // turn. Auth and quota walls are excluded by the classifier and fall
        // straight through to the terminalize path below.
        if (
          step === 'session/prompt' &&
          isTransientAcpPromptFailure(rpcError, { evidence: stderrEvidence() }) &&
          scheduleTransientPromptRetry(rpcError?.message || 'request error')
        ) {
          continue
        }
        // Preserve the failed lifecycle step through child close. Without a
        // non-success status, provider adapters can normalize an unfinished
        // prompt to success and replace the real RPC failure with an unrelated
        // empty-response diagnosis.
        terminalStatus = `rpc_error:${step}`
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
        const resumeResult = message.result
        const acceptResumedSession = (): void => {
          sessionId = requestedResumeSessionId
          fallbackFromResume = false
          sessionReady(true, resumeResult)
        }
        if (!options.confirmResumedSession) {
          acceptResumedSession()
          continue
        }
        // The confirmation is async (e.g. waiting for the per-run gateway
        // bridge's first contact); the prompt is not sent until it settles.
        void Promise.resolve()
          .then(() => options.confirmResumedSession!())
          .then(
            (keep) => {
              if (closed || cancelRequested) return
              if (keep) {
                acceptResumedSession()
                return
              }
              options.onEvent({
                type: 'provider_warning',
                text: 'ACP resumed session did not confirm its tool surface; starting a fresh session with the cold-start prompt.'
              })
              sendSessionNew(true)
            },
            () => {
              // Fail open: a broken probe must not cost a healthy session.
              if (!closed && !cancelRequested) acceptResumedSession()
            }
          )
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
        if (event.type === 'content' && event.text) {
          assistantTextSeen = true
          activePromptAssistantText += event.text
          if (activePromptAssistantText.length > MAX_ACP_STEER_ASSISTANT_CONTEXT_CHARS) {
            activePromptAssistantText = activePromptAssistantText.slice(
              -MAX_ACP_STEER_ASSISTANT_CONTEXT_CHARS
            )
            activePromptAssistantTextWasTruncated = true
          }
        } else if (event.type === 'tool_use') {
          const toolName = nonEmptyString(event.toolName) || 'tool'
          lastObservedToolName = toolName
          if (event.toolId) toolNamesById.set(event.toolId, toolName)
        } else if (event.type === 'tool_result') {
          const toolOutput = nonEmptyString(event.toolOutput)
          if (event.toolStatus === 'error' || toolOutputIndicatesFailure(toolOutput)) {
            toolFailureSeen = true
            lastFailedToolName =
              (event.toolId ? toolNamesById.get(event.toolId) : undefined) ||
              lastObservedToolName ||
              'tool'
            lastFailedToolOutput = toolOutput || null
          }
        }
        if (event.type === 'result') {
          const responsePromptRpcId =
            typeof message.id === 'number' && message.id === activePromptRpcId
              ? message.id
              : null
          if (responsePromptRpcId === null) continue
          const status = event.status || terminalStatus
          const recovery = options.deniedToolRecovery
          // A steering interrupt owns the follow-up slot: never spend the
          // denied-tool one-shot recovery on a prompt WE cancelled on purpose.
          if (
            recovery &&
            !cancelRequested &&
            !deniedToolRecoveryAttempted &&
            !pendingSteer
          ) {
            let deniedCancellation = false
            try {
              deniedCancellation =
                deniedPromptRpcId === responsePromptRpcId && recovery.detect(status)
            } catch {
              deniedCancellation = false
            }
            let recoveryReason: AcpToolRecoveryReason = deniedCancellation
              ? 'denied-permission-cancellation'
              : 'failed-tool-terminal'
            let recoveryContext: AcpToolRecoveryContext = {
              reason: recoveryReason,
              terminalStatus: status,
              deniedPermissionRequest,
              assistantTextSeen,
              toolFailureSeen,
              lastFailedToolName,
              lastFailedToolOutput
            }
            let failedToolRecovery = false
            try {
              failedToolRecovery = recovery.shouldRecover?.(recoveryContext) === true
            } catch {
              failedToolRecovery = false
            }
            if (deniedCancellation || failedToolRecovery) {
              recoveryReason = deniedCancellation
                ? 'denied-permission-cancellation'
                : 'failed-tool-terminal'
              recoveryContext = { ...recoveryContext, reason: recoveryReason }
              let prompt = ''
              let warning = ''
              try {
                prompt =
                  typeof recovery.prompt === 'function'
                    ? recovery.prompt(recoveryContext)
                    : recovery.prompt
                warning =
                  typeof recovery.warning === 'function'
                    ? recovery.warning(recoveryContext)
                    : recovery.warning ||
                      'The provider stopped after a declined or failed tool; continuing once so it can finish from available evidence.'
              } catch {
                prompt = ''
              }
              if (prompt.trim()) {
                // Keep the denial/failure intact, but give the same session one
                // bounded chance to report rather than turning an optional tool
                // outcome into a fatal participant cancellation.
                deniedToolRecoveryAttempted = true
                options.onEvent({ type: 'provider_warning', text: warning })
                if (sendPrompt(prompt) !== null) continue
              }
            }
          }
          activePromptRpcId = null
          deniedPromptRpcId = null
          deniedPermissionRequest = null
          if (pendingSteer && !cancelRequested && !closed && !stdinClosed && sessionId) {
            // `session/cancel` landed and the provider closed the interrupted
            // prompt. Re-prompt the SAME session with the steering text as the
            // user's next message: the turn stays alive, its events keep
            // streaming through onEvent, and close-out/usage accounting are
            // unchanged. The per-prompt flags reset inside sendPrompt.
            if (sendPendingSteer()) continue
          }
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
    if (!text) return
    collectStderr(text)
    options.onEvent({ type: 'provider_warning', text })
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
    clearTransientRetryTimer()
    activePromptRpcId = null
    deniedPromptRpcId = null
    deniedPermissionRequest = null
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
    steer: (text: string, hooks?: AcpSteerDeliveryHooks): boolean => {
      const steerText = typeof text === 'string' ? text.trim() : ''
      if (!steerText) return false
      // Only an in-flight prompt can be interrupted. Before dispatch
      // (activePromptRpcId null), after settle (turnComplete), after a user
      // cancel, or with a dead stdin there is nothing to steer into — the
      // caller falls back to boundary delivery.
      if (cancelRequested || closed || stdinClosed || turnComplete) return false
      if (!sessionId || activePromptRpcId === null) return false
      // Preserve every message that arrives before the interrupted prompt
      // closes. Only the first message needs to issue session/cancel; the
      // combined follow-up carries the whole ordered batch.
      if (pendingSteer) {
        pendingSteer.text = appendSteeringMessage(pendingSteer.text, steerText)
        if (hooks) pendingSteer.hooks.push(hooks)
      } else {
        pendingSteer = { text: steerText, hooks: hooks ? [hooks] : [] }
        writeRpc(null, 'session/cancel', { sessionId })
      }
      return true
    },
    cancelSteer: () => {
      // If session/cancel was already sent, the prompt close still arrives and
      // simply ends the turn normally — the steer text never becomes a prompt.
      pendingSteer = null
    },
    cancel: () => {
      cancelRequested = true
      clearTransientRetryTimer()
      activePromptRpcId = null
      deniedPromptRpcId = null
      deniedPermissionRequest = null
      pendingSteer = null
      // Interrupt an in-progress turn first (protocol), then terminate the
      // process via the provider terminator + SIGKILL backstop.
      if (sessionId && !turnComplete) writeRpc(null, 'session/cancel', { sessionId })
      endProcess()
    }
  }
}
