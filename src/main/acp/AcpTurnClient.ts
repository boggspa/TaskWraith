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
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  type BigIntStats
} from 'node:fs'
import { extname, isAbsolute } from 'node:path'
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
import { MAX_DURABLE_ATTACHMENT_REFS } from '../ScheduledAttachmentDurability'
import { TRANSCRIPT_MEDIA_MAX_FULL_IMAGE_BYTES } from '../services/TranscriptMediaAssetStore'
import { twMediaMimeForExt } from '../../shared/twMedia'

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

export interface AcpSessionConfigSelection {
  configId: string
  /** Preferred value for the current provider version. */
  value: string
  /** Older/newer provider spellings with equivalent semantics, in priority order. */
  fallbackValues?: readonly string[]
}

export interface AcpTurnOptions {
  prompt: string
  /**
   * Main-process-authorized image files for the initial user prompt. This
   * neutral transport performs format/size/capability validation and encoding,
   * but it is deliberately not an attachment authority: renderer-nominated
   * paths must be resolved to chat-owned paths before reaching this field.
   */
  imagePaths?: readonly string[]
  /** Injected only for tests or an equivalent main-owned file reader. */
  readImageFile?: (imagePath: string) => Buffer
  /**
   * Allow a provider adapter with independently verified image behavior to
   * send inline image blocks when the provider's ACP capability flag is stale.
   * This is intentionally opt-in: ordinary ACP lanes remain fail-closed when
   * the runtime does not advertise promptCapabilities.image=true.
   */
  allowUnadvertisedPromptImages?: boolean
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
  resumeConfigOptions?: ReadonlyArray<AcpSessionConfigSelection>
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
   * read-only seat never leaves Vibe's write-capable `ask` mode (called
   * `default` by older versions).
   */
  sessionConfigOptions?: ReadonlyArray<AcpSessionConfigSelection>
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
  /**
   * Called after the terminal `tool_result` that drains the complete tracked
   * tool batch has been forwarded through `onEvent`. Parallel calls are
   * tracked by their ACP ids; a call without an id makes that prompt's batch
   * boundary unknowable and suppresses this notification rather than guessing.
   * Notification only: the caller owns any cancel/requeue action.
   */
  onToolBatchBoundary?: () => void
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
   * turn. Delivery hooks fire only after provider output or a prompt result
   * proves that follow-up was admitted.
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
  /** Main-resolved, chat-owned paths; never renderer-nominated here. */
  imagePaths?: readonly string[]
  /** Fired only after provider output/result proves the follow-up prompt was admitted. */
  onDelivered: () => void
  onRejected?: (reason: string) => void
  onAmbiguous?: (reason: string) => void
}

interface PendingAcpSteer {
  text: string
  hooks: AcpSteerDeliveryHooks[]
  images: AcpPromptImageContent[]
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

export interface AcpPromptImageContent {
  type: 'image'
  data: string
  mimeType: string
}

/** Shared composer/durable count ceiling and TaskWraith's main-owned full-image
 * resource ceiling. ACP itself advertises image support as a boolean and does
 * not define a smaller provider byte cap. */
export const ACP_PROMPT_IMAGE_MAX_COUNT = MAX_DURABLE_ATTACHMENT_REFS
export const ACP_PROMPT_IMAGE_MAX_BYTES = TRANSCRIPT_MEDIA_MAX_FULL_IMAGE_BYTES

export class AcpImagePromptError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AcpImagePromptError'
  }
}

export interface AcpDescriptorImageReadHooks {
  /** Test-only synchronization point after descriptor identity validation. */
  afterOpen?: (fd: number) => void
}

function sameFileIdentity(
  left: { dev: bigint; ino: bigint },
  right: { dev: bigint; ino: bigint }
): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

/**
 * Read one already-authorized path through a single owned descriptor. The
 * normal path uses O_NOFOLLOW, so a terminal symlink never opens. Platforms
 * without that flag use lstat only as an expected identity, then prove the
 * opened fd is the same non-symlink regular file before reading from the fd.
 * At no point are bytes read by reopening the pathname.
 */
export function readMainAuthorizedAcpImageFile(
  imagePath: string,
  hooks: AcpDescriptorImageReadHooks = {}
): Buffer {
  const noFollowFlag =
    typeof fsConstants.O_NOFOLLOW === 'number' && fsConstants.O_NOFOLLOW > 0
      ? fsConstants.O_NOFOLLOW
      : 0
  let expectedIdentity: BigIntStats | null = null
  const captureFallbackIdentity = (): void => {
    expectedIdentity = lstatSync(imagePath, { bigint: true })
    if (expectedIdentity.isSymbolicLink()) {
      throw new AcpImagePromptError(`The attached ACP image cannot be a symlink (${imagePath}).`)
    }
  }
  let fd: number
  if (noFollowFlag === 0) {
    captureFallbackIdentity()
    fd = openSync(imagePath, fsConstants.O_RDONLY)
  } else {
    try {
      fd = openSync(imagePath, fsConstants.O_RDONLY | noFollowFlag)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code
      if (code !== 'EINVAL' && code !== 'ENOTSUP' && code !== 'EOPNOTSUPP') throw error
      captureFallbackIdentity()
      fd = openSync(imagePath, fsConstants.O_RDONLY)
    }
  }
  try {
    const before = fstatSync(fd, { bigint: true })
    if (!before.isFile()) {
      throw new AcpImagePromptError(`The attached ACP image is not a regular file (${imagePath}).`)
    }
    if (expectedIdentity && !sameFileIdentity(expectedIdentity, before)) {
      throw new AcpImagePromptError(
        `The attached ACP image changed identity while it was being opened (${imagePath}).`
      )
    }
    if (before.size <= 0n || before.size > BigInt(ACP_PROMPT_IMAGE_MAX_BYTES)) {
      throw new AcpImagePromptError(
        `The attached ACP image must be between 1 byte and ${ACP_PROMPT_IMAGE_MAX_BYTES} bytes (${imagePath}).`
      )
    }

    hooks.afterOpen?.(fd)
    const buffer = readFileSync(fd)
    const after = fstatSync(fd, { bigint: true })
    if (
      !sameFileIdentity(before, after) ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      BigInt(buffer.byteLength) !== before.size
    ) {
      throw new AcpImagePromptError(
        `The attached ACP image changed while it was being read (${imagePath}).`
      )
    }
    return buffer
  } finally {
    try {
      closeSync(fd)
    } catch {
      // The descriptor read has already settled; close failure cannot make a
      // different pathname authoritative or justify reopening it.
    }
  }
}

/**
 * Encode already-authorized main-process paths into ACP ImageContent blocks.
 * This function never establishes path authority; callers must do that before
 * invocation. It validates the complete array before any session/prompt frame
 * can be written, so an invalid member cannot cause partial attachment loss.
 */
export function loadMainAuthorizedAcpImageContents(
  imagePaths: readonly string[],
  readImageFile: (imagePath: string) => Buffer = readMainAuthorizedAcpImageFile
): AcpPromptImageContent[] {
  if (imagePaths.length > ACP_PROMPT_IMAGE_MAX_COUNT) {
    throw new AcpImagePromptError(
      `ACP prompts support at most ${ACP_PROMPT_IMAGE_MAX_COUNT} image attachments; received ${imagePaths.length}.`
    )
  }
  const images: AcpPromptImageContent[] = []
  for (const rawPath of imagePaths) {
    const imagePath = typeof rawPath === 'string' ? rawPath.trim() : ''
    if (!imagePath || !isAbsolute(imagePath)) {
      throw new AcpImagePromptError('ACP image attachments require main-authorized absolute paths.')
    }
    const extension = extname(imagePath).slice(1).toLowerCase()
    const mimeType = twMediaMimeForExt(extension === 'jpeg' ? 'jpg' : extension)
    if (!mimeType?.startsWith('image/')) {
      throw new AcpImagePromptError(
        `The attached file is not a supported ACP raster image (png, jpeg, gif, webp, bmp): ${imagePath}.`
      )
    }
    let buffer: Buffer
    try {
      buffer = readImageFile(imagePath)
    } catch (error) {
      if (error instanceof AcpImagePromptError) throw error
      throw new AcpImagePromptError(
        `The attached ACP image could not be read (${imagePath}): ${
          error instanceof Error ? error.message : String(error)
        }.`
      )
    }
    if (!Buffer.isBuffer(buffer) || buffer.byteLength <= 0) {
      throw new AcpImagePromptError(`The attached ACP image is empty or unreadable (${imagePath}).`)
    }
    if (buffer.byteLength > ACP_PROMPT_IMAGE_MAX_BYTES) {
      throw new AcpImagePromptError(
        `The attached ACP image exceeds the ${ACP_PROMPT_IMAGE_MAX_BYTES} byte limit (${imagePath}).`
      )
    }
    images.push({ type: 'image', data: buffer.toString('base64'), mimeType })
  }
  return images
}

function nonEmptyString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function isDefinitiveAcpPromptRejection(error: { code?: unknown }): boolean {
  return error.code === -32600 || error.code === -32601 || error.code === -32602
}

function isAcpPromptCancellation(error: { code?: unknown; message?: string }): boolean {
  return (
    error.code === -32800 ||
    /\b(?:cancel(?:led|ed)?|interrupt(?:ed|ion)?|abort(?:ed)?)\b/i.test(error.message || '')
  )
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

function agentSupportsPromptImages(initializeResult: unknown): boolean {
  if (!isRecord(initializeResult)) return false
  const capabilities = isRecord(initializeResult.agentCapabilities)
    ? initializeResult.agentCapabilities
    : null
  const promptCapabilities =
    capabilities && isRecord(capabilities.promptCapabilities)
      ? capabilities.promptCapabilities
      : null
  return promptCapabilities?.image === true
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
  const initialImagePaths = [...(options.imagePaths ?? [])]
  const readImageFile = options.readImageFile ?? readMainAuthorizedAcpImageFile
  let agentSupportsImagePrompts = false
  let initialPromptImages: AcpPromptImageContent[] = []
  let promptSent = false
  let turnComplete = false
  let terminalStatus: string | undefined
  let stdinClosed = false
  let closed = false
  let nextPromptRpcId = ACP_ID.prompt
  let nextConfigRpcId = ACP_CONFIG_RPC_START
  let sessionConfigQueue: Array<{ configId: string; values: string[] }> = []
  let configSessionKind: 'new' | 'resumed' = 'new'
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
  const outstandingToolIds = new Set<string>()
  const completedToolIds = new Set<string>()
  let toolBatchIdentityAmbiguous = false
  const observeToolBatchEvent = (event: AcpRunEvent): boolean => {
    if (event.type === 'tool_use') {
      const toolId = nonEmptyString(event.toolId)
      if (!toolId) {
        // Without an identity, a later terminal update cannot be proven to
        // close this exact call (especially when calls execute in parallel).
        toolBatchIdentityAmbiguous = true
        return false
      }
      // Some ACP peers replay the full terminal `tool_call` snapshot after
      // already sending its update. Tool ids are unique within one prompt, so
      // a completed id cannot reopen the batch or notify twice.
      if (!completedToolIds.has(toolId)) outstandingToolIds.add(toolId)
      return false
    }
    if (event.type !== 'tool_result') return false
    const toolId = nonEmptyString(event.toolId)
    if (!toolId || !outstandingToolIds.has(toolId)) return false
    outstandingToolIds.delete(toolId)
    completedToolIds.add(toolId)
    return outstandingToolIds.size === 0 && !toolBatchIdentityAmbiguous
  }
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
  let pendingSteer: PendingAcpSteer | null = null
  let pendingSteerCancelState: 'none' | 'deferred' | 'sent' = 'none'
  let activeSteerDelivery: { promptRpcId: number; hooks: AcpSteerDeliveryHooks[] } | null = null
  let settlingActiveSteerHooks = false
  let settlingPendingSteerHooks = false
  // Text of the prompt currently in flight — the recovery prompt, not the
  // original, once recovery has taken over. A transient retry must re-send
  // whatever actually failed.
  let inFlightPromptText = ''
  let inFlightPromptImages: AcpPromptImageContent[] = []
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

  const sendPrompt = (
    text: string,
    images: readonly AcpPromptImageContent[] = []
  ): number | null => {
    if (cancelRequested || closed || stdinClosed) return null
    deniedPromptRpcId = null
    deniedPermissionRequest = null
    assistantTextSeen = false
    toolFailureSeen = false
    lastFailedToolName = null
    lastFailedToolOutput = null
    lastObservedToolName = null
    toolNamesById.clear()
    outstandingToolIds.clear()
    completedToolIds.clear()
    toolBatchIdentityAmbiguous = false
    pendingSteerCancelState = 'none'
    const promptRpcId = nextPromptRpcId++
    // RPC id 4 is reserved for session/resume. The first prompt remains id 3
    // for trace compatibility; any recovery prompt continues at 5.
    if (nextPromptRpcId === ACP_ID.sessionResume) nextPromptRpcId += 1
    activePromptRpcId = promptRpcId
    inFlightPromptText = text
    inFlightPromptImages = [...images]
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
      prompt: [{ type: 'text', text }, ...images]
    })
    return promptRpcId
  }

  const settleActiveSteerDelivery = (
    outcome: 'delivered' | 'rejected' | 'ambiguous',
    reason?: string
  ): void => {
    const delivery = activeSteerDelivery
    activeSteerDelivery = null
    if (!delivery) return
    settlingActiveSteerHooks = true
    try {
      for (const hook of delivery.hooks) {
        try {
          if (outcome === 'delivered') hook.onDelivered()
          else if (outcome === 'rejected')
            hook.onRejected?.(reason || 'ACP rejected the steer prompt.')
          else hook.onAmbiguous?.(reason || 'ACP steer admission was ambiguous.')
        } catch {
          // One receipt callback must not prevent the remaining batch from settling.
        }
      }
    } finally {
      settlingActiveSteerHooks = false
    }
  }

  const rejectSteerHooksBeforeAdmission = (
    hooks: AcpSteerDeliveryHooks | undefined,
    reason: string
  ): boolean => {
    if (!hooks?.onRejected) return false
    const wasSettlingPendingHooks = settlingPendingSteerHooks
    settlingPendingSteerHooks = true
    try {
      hooks.onRejected(reason)
    } catch {
      // Receipt projection cannot turn a definite non-admission into delivery.
    } finally {
      settlingPendingSteerHooks = wasSettlingPendingHooks
    }
    return true
  }

  const settlePendingSteerRejection = (pending: PendingAcpSteer, reason: string): void => {
    const wasSettlingPendingHooks = settlingPendingSteerHooks
    settlingPendingSteerHooks = true
    try {
      for (const hook of pending.hooks) {
        try {
          hook.onRejected?.(reason)
        } catch {
          // One receipt callback must not prevent the rest of the batch settling.
        }
      }
    } finally {
      settlingPendingSteerHooks = wasSettlingPendingHooks
    }
  }

  const settleActiveSteerError = (error: { code?: unknown; message?: string }): void => {
    if (
      assistantTextSeen ||
      (pendingSteerCancelState === 'sent' && isAcpPromptCancellation(error))
    ) {
      settleActiveSteerDelivery('delivered')
    } else if (isDefinitiveAcpPromptRejection(error)) {
      settleActiveSteerDelivery('rejected', error.message || 'ACP rejected the steer prompt.')
    } else {
      settleActiveSteerDelivery(
        'ambiguous',
        error.message || 'ACP steer admission failed without definitive rejection.'
      )
    }
  }

  const sendPendingSteer = (): boolean => {
    const pending = pendingSteer
    pendingSteer = null
    pendingSteerCancelState = 'none'
    if (!pending) return false
    if (cancelRequested || closed || stdinClosed || !sessionId) {
      settlePendingSteerRejection(
        pending,
        'ACP steering was not sent because the live session was no longer available.'
      )
      return false
    }
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
    const promptRpcId = sendPrompt(followUpPrompt, pending.images)
    if (promptRpcId === null) {
      settlePendingSteerRejection(
        pending,
        'ACP steering was not sent because the follow-up prompt could not be written.'
      )
      return false
    }
    activeSteerDelivery = { promptRpcId, hooks: pending.hooks }
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
    sendPrompt(promptForTurn, initialPromptImages)
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
    const retryImages = [...inFlightPromptImages]
    // The old rpc id already received its error response; sendPrompt allocates
    // a fresh one against the same sessionId.
    options.onEvent({
      type: 'provider_warning',
      text: `ACP session/prompt failed: ${failureText} — transient provider failure; retrying (${attempt}/${limit}) in ${
        Math.round(delayMs / 100) / 10
      }s.`
    })
    clearTransientRetryTimer()
    transientRetryTimer = setTimeout(
      () => {
        transientRetryTimer = null
        if (cancelRequested || closed || stdinClosed || turnComplete) return
        const retryPromptRpcId = sendPrompt(retryText, retryImages)
        if (activeSteerDelivery && retryPromptRpcId !== null) {
          activeSteerDelivery = { ...activeSteerDelivery, promptRpcId: retryPromptRpcId }
        }
      },
      Math.max(0, delayMs)
    )
    return true
  }

  const applyNextSessionConfig = (result: unknown): void => {
    if (sessionConfigQueue.length === 0) {
      sendPromptOnce()
      return
    }
    const advertised = advertisedConfigOptions(result)
    const desired = sessionConfigQueue.shift()!
    const option = advertised.find((candidate) => candidate.id === desired.configId)
    if (!option) {
      options.onEvent({
        type: 'provider_warning',
        text: `ACP ${configSessionKind} session did not advertise config option "${desired.configId}"; keeping its persisted value.`
      })
      applyNextSessionConfig(result)
      return
    }
    const currentValue = String(option.currentValue ?? '')
    if (desired.values.includes(currentValue)) {
      applyNextSessionConfig(result)
      return
    }
    const selectedValue =
      option.values.length === 0
        ? desired.values[0]
        : desired.values.find((value) => option.values.includes(value))
    if (!selectedValue) {
      const requested =
        desired.values.length === 1
          ? `"${desired.values[0]}"`
          : `any allowed value (${desired.values.map((value) => `"${value}"`).join(', ')})`
      options.onEvent({
        type: 'provider_warning',
        text: `ACP ${configSessionKind} session does not offer ${requested} for config option "${desired.configId}"; keeping its persisted value.`
      })
      applyNextSessionConfig(result)
      return
    }
    const rpcId = nextConfigRpcId++
    pendingConfigRpcs.set(rpcId, { configId: desired.configId, value: selectedValue })
    writeRpc(rpcId, 'session/set_config_option', {
      sessionId,
      configId: desired.configId,
      value: selectedValue
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
      configSessionKind = resumed ? 'resumed' : 'new'
      sessionConfigQueue = requestedConfig
        .map((option) => {
          const values = [option.value, ...(option.fallbackValues ?? [])]
            .map(nonEmptyString)
            .filter((value, index, all) => value && all.indexOf(value) === index)
          return { configId: nonEmptyString(option.configId), values }
        })
        .filter((option) => option.configId && option.values.length > 0)
      applyNextSessionConfig(result)
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

  const failInitialImagePrompt = (reason: string): void => {
    terminalStatus = 'rpc_error:session/prompt-images'
    try {
      options.onEvent({
        type: 'provider_warning',
        text: `ACP session/prompt was not sent with its attachments: ${reason}`
      })
    } catch {
      // The transport failure remains authoritative if transcript projection fails.
    } finally {
      endProcess()
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
      if (
        activeSteerDelivery &&
        typeof message.id === 'number' &&
        message.id === activeSteerDelivery.promptRpcId &&
        message.result
      ) {
        settleActiveSteerDelivery('delivered')
      }
      // Any error closes the prompt slot. Most often this is an error-flavoured
      // acknowledgement of session/cancel, but a natural failure can also race
      // a tool-batch-deferred steer. In either case the latest steer may take
      // the now-free slot; admission for an older steer prompt is classified
      // separately before sending it.
      if (
        message.error &&
        typeof message.id === 'number' &&
        message.id === activePromptRpcId &&
        pendingSteer
      ) {
        const rpcError = message.error as { code?: unknown; message?: string }
        if (activeSteerDelivery?.promptRpcId === message.id) {
          // A prompt error closes the old follow-up even if a parallel tool
          // batch made the newer steer defer its cancel. Preserve exact
          // admission semantics for the old message before the latest steer
          // takes over the same session.
          settleActiveSteerError(rpcError)
        }
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
          !isDefinitiveAcpPromptRejection(rpcError) &&
          isTransientAcpPromptFailure(rpcError, { evidence: stderrEvidence() }) &&
          scheduleTransientPromptRetry(rpcError?.message || 'request error')
        ) {
          continue
        }
        if (step === 'session/prompt' && activeSteerDelivery?.promptRpcId === message.id) {
          settleActiveSteerError(rpcError)
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
        applyNextSessionConfig({ configOptions: [] })
        continue
      }
      if (message.id === ACP_ID.initialize && message.result) {
        agentSupportsImagePrompts = agentSupportsPromptImages(message.result)
        if (initialImagePaths.length > 0) {
          if (!agentSupportsImagePrompts && !options.allowUnadvertisedPromptImages) {
            failInitialImagePrompt(
              'the runtime did not advertise agentCapabilities.promptCapabilities.image=true. No image was silently omitted.'
            )
            continue
          }
          if (!agentSupportsImagePrompts) {
            options.onEvent({
              type: 'provider_warning',
              text: 'ACP runtime reported promptCapabilities.image=false; forwarding the verified inline image blocks through the provider compatibility path.'
            })
          }
          try {
            initialPromptImages = loadMainAuthorizedAcpImageContents(
              initialImagePaths,
              readImageFile
            )
          } catch (error) {
            failInitialImagePrompt(
              `${error instanceof Error ? error.message : String(error)} No image was silently omitted.`
            )
            continue
          }
        }
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
        applyNextSessionConfig(message.result)
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
        if (activeSteerDelivery && activePromptRpcId === activeSteerDelivery.promptRpcId) {
          settleActiveSteerDelivery('delivered')
        }
        const completedToolBatch = observeToolBatchEvent(event)
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
          if (completedToolBatch) {
            if (
              pendingSteer &&
              pendingSteerCancelState === 'deferred' &&
              sessionId &&
              activePromptRpcId !== null &&
              !cancelRequested &&
              !closed &&
              !stdinClosed
            ) {
              pendingSteerCancelState = 'sent'
              writeRpc(null, 'session/cancel', { sessionId })
            }
            try {
              options.onToolBatchBoundary?.()
            } catch {
              // Boundary notification is advisory. A coordinator failure must
              // not alter ACP transport or existing live-steer semantics.
            }
          }
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
      // caller falls back to boundary delivery. Check this before negotiated
      // image capability so startup cannot be misreported as an image refusal.
      if (cancelRequested || closed || stdinClosed || turnComplete) return false
      if (!sessionId || activePromptRpcId === null) return false
      const steerImagePaths = Array.isArray(hooks?.imagePaths) ? [...hooks.imagePaths] : []
      let steerImages: AcpPromptImageContent[] = []
      if (steerImagePaths.length > 0) {
        if (!agentSupportsImagePrompts && !options.allowUnadvertisedPromptImages) {
          return rejectSteerHooksBeforeAdmission(
            hooks,
            'ACP live steering was not sent because this runtime did not advertise agentCapabilities.promptCapabilities.image=true.'
          )
        }
        if (
          pendingSteer &&
          pendingSteer.images.length + steerImagePaths.length > ACP_PROMPT_IMAGE_MAX_COUNT
        ) {
          return rejectSteerHooksBeforeAdmission(
            hooks,
            `ACP live steering was not sent because the combined follow-up exceeds ${ACP_PROMPT_IMAGE_MAX_COUNT} images.`
          )
        }
        try {
          steerImages = loadMainAuthorizedAcpImageContents(steerImagePaths, readImageFile)
        } catch (error) {
          return rejectSteerHooksBeforeAdmission(
            hooks,
            `ACP live steering was not sent: ${
              error instanceof Error ? error.message : String(error)
            }`
          )
        }
      }
      // Preserve every message that arrives before the interrupted prompt
      // closes. Only the first message needs to issue session/cancel; the
      // combined follow-up carries the whole ordered batch.
      if (pendingSteer) {
        pendingSteer.text = appendSteeringMessage(pendingSteer.text, steerText)
        if (hooks) pendingSteer.hooks.push(hooks)
        pendingSteer.images.push(...steerImages)
      } else {
        pendingSteer = {
          text: steerText,
          hooks: hooks ? [hooks] : [],
          images: steerImages
        }
        if (outstandingToolIds.size > 0 || toolBatchIdentityAmbiguous) {
          pendingSteerCancelState = 'deferred'
        } else {
          pendingSteerCancelState = 'sent'
          writeRpc(null, 'session/cancel', { sessionId })
        }
      }
      return true
    },
    cancelSteer: () => {
      if (settlingActiveSteerHooks || settlingPendingSteerHooks) return
      // If session/cancel was already sent, the prompt close still arrives and
      // simply ends the turn normally — the steer text never becomes a prompt.
      const pending = pendingSteer
      if (pending) {
        pendingSteer = null
        pendingSteerCancelState = 'none'
        settlePendingSteerRejection(
          pending,
          'ACP steering was cancelled before its follow-up prompt was sent.'
        )
        return
      }
      // With no unsent follow-up left, the only remaining steer may already be
      // admitted. Cancellation cannot prove otherwise, so it is ambiguous.
      if (activeSteerDelivery) {
        settleActiveSteerDelivery(
          'ambiguous',
          'ACP steering was cancelled after its follow-up prompt may have been admitted.'
        )
      }
    },
    cancel: () => {
      cancelRequested = true
      clearTransientRetryTimer()
      activePromptRpcId = null
      deniedPromptRpcId = null
      deniedPermissionRequest = null
      const pending = pendingSteer
      pendingSteer = null
      pendingSteerCancelState = 'none'
      if (pending) {
        settlePendingSteerRejection(
          pending,
          'ACP steering was not sent because the provider run was cancelled.'
        )
      }
      if (activeSteerDelivery) {
        settleActiveSteerDelivery(
          'ambiguous',
          'ACP run cancellation raced a possibly admitted steer prompt.'
        )
      }
      // Interrupt an in-progress turn first (protocol), then terminate the
      // process via the provider terminator + SIGKILL backstop.
      if (sessionId && !turnComplete) writeRpc(null, 'session/cancel', { sessionId })
      endProcess()
    }
  }
}
