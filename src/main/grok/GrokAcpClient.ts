// Grok adapter over the provider-neutral ACP turn client (src/main/acp).
//
// The bidirectional JSON-RPC state machine (initialize → session/new →
// session/prompt, session/update streaming, client-mediated
// session/request_permission, default-deny safety, transport keep-alive,
// cancellation) now lives in AcpTurnClient; this file supplies the Grok-shaped
// hooks: read-only fs client capabilities, the denied-native-tool one-shot
// recovery, and the ENOENT setup copy. Behaviour is unchanged — the full
// GrokAcpClient.test.ts suite is the regression gate.
//
// TaskWraith-owned tools are passed through session/new `mcpServers`: write
// seats can receive the full brokered TaskWraith bridge, read-only seats a safe
// subset. We never send the `always-approve` command.

import {
  runAcpTurn,
  createAcpTurnAbortController,
  type AcpChildProcess,
  type AcpToolRecoveryContext,
  type AcpTurnHandle
} from '../acp/AcpTurnClient'
import type {
  NormalizedGrokRunEvent,
  AcpPermissionRequest,
  AcpPermissionDecision
} from './GrokAcpProtocol'
import { GROK_MCP_SHELL_TOOL_NAME } from './GrokCliArgs'

export type { AcpChildProcess } from '../acp/AcpTurnClient'

export interface GrokAcpRunOptions {
  prompt: string
  /** Main-authorized images; Grok ACP accepts inline blocks despite its stale image flag. */
  imagePaths?: readonly string[]
  /** Injected only for tests or an equivalent main-owned image reader. */
  readImageFile?: (imagePath: string) => Buffer
  cwd: string
  /** Spawns `grok --no-auto-update agent stdio` (injected for testability). */
  spawnProcess: () => AcpChildProcess
  /**
   * MCP servers advertised to the session (session/new `mcpServers`) — the full
   * TaskWraith bridge for write seats or the scoped safe-subset for read-only
   * seats. Omitted/empty = no TaskWraith tools.
   */
  mcpServers?: unknown[]
  /** True only after this exact ACP session receives the governed shell tool. */
  taskWraithShellToolAvailable?: boolean
  /** Normalized run events: content / thinking / init(sessionId) / result / warning. */
  onEvent: (event: NormalizedGrokRunEvent) => void
  /** Exact notification after every tool in one parallel ACP batch settles. */
  onToolBatchBoundary?: () => void
  /** Called once with the spawned child (for the cancellation registry). */
  onProcess?: (child: AcpChildProcess) => void
  /**
   * Client-mediated tool approval. Default (omitted) is DENY: the request is
   * answered with a reject/cancel outcome so the agent never hangs and never
   * gets a silent allow. runGrokAcpProvider supplies a handler routing to the
   * TaskWraith approval ledger.
   */
  onPermissionRequest?: (
    request: AcpPermissionRequest
  ) => AcpPermissionDecision | Promise<AcpPermissionDecision>
  /**
   * Called once when the child exits. `turnComplete` is true when the prompt
   * reached a terminal stopReason before exit; `terminalStatus` is that raw
   * stopReason so callers can distinguish a normal end_turn from
   * PermissionRejected/Cancelled.
   */
  onClose?: (code: number | null, turnComplete: boolean, terminalStatus?: string) => void
  /** Opt-in raw JSON-RPC frame tap (both directions) for gated debug capture. */
  onRawFrame?: (direction: 'in' | 'out', message: unknown) => void
  /**
   * Bounded same-session retry for a TRANSIENT `session/prompt` failure — xAI
   * 500s are the observed case. Defaults live in the neutral ACP core (2
   * attempts at 1s/3s); these exist so the Grok adapter and its tests can tune
   * them without reaching past runGrokAcpTurn.
   */
  transientPromptRetryLimit?: number
  transientPromptRetryDelayMs?: number | ((attempt: number) => number)
  /** How far back grok's stderr counts as explaining a bare JSON-RPC error. */
  stderrCorrelationWindowMs?: number
}

export interface GrokAcpRunHandle extends AcpTurnHandle {
  /**
   * Resolves only after the one-shot child emits its real `close` event and the
   * caller's terminal projection/cleanup callback has returned. A kill request
   * or RunManager terminal state is not close evidence.
   */
  closed: Promise<void>
}

const GROK_DENIED_TOOL_RECOVERY_WITH_BROKER_PROMPT =
  'Your previous native tool request was refused. A native Bash/Shell/terminal refusal can ' +
  'reflect TaskWraith containment rather than a denial of the underlying shell permission. Do ' +
  'not retry the native tool. If shell work is still needed and ' +
  `${GROK_MCP_SHELL_TOOL_NAME} is listed in your MCP tools, call it once instead: that ` +
  'host-mediated route honors the current shell grant and requests user approval when needed. ' +
  'Only if that MCP tool is unavailable or itself denied should you report the exact blocker; do ' +
  'not substitute unrelated side effects.'

export const GROK_DENIED_TOOL_RECOVERY_PROMPT =
  'Your previous native tool request was refused. A native Bash/Shell/terminal refusal can ' +
  'reflect TaskWraith containment rather than a denial of the underlying shell permission. Do ' +
  'not retry the native tool. The TaskWraith shell broker is unavailable for this turn, so do not ' +
  'call, search for, or infer a replacement shell tool. Report that exact blocker and continue ' +
  'from the evidence already available; do not substitute unrelated side effects.'

export function grokDeniedToolRecoveryPrompt(taskWraithShellToolAvailable: boolean): string {
  return taskWraithShellToolAvailable
    ? GROK_DENIED_TOOL_RECOVERY_WITH_BROKER_PROMPT
    : GROK_DENIED_TOOL_RECOVERY_PROMPT
}

export const GROK_FAILED_TOOL_CONTINUITY_PROMPT =
  'The previous TaskWraith broker or provider tool call failed or was declined. Respect the ' +
  'user decision and do not retry the same call or request the same permission again. An ' +
  'optional tool outcome is not a reason to cancel the participant turn: continue from the ' +
  'evidence already available and produce your final report. If the requested task genuinely ' +
  'cannot be completed, state the exact tool, command, or path still needed so the user can ' +
  'make one informed choice.'

export const GROK_PERMISSION_BOUNDARY_CONTINUITY_PROMPT =
  'TaskWraith returned a typed permission boundary, not a user refusal. If the tool result ' +
  'advertises a permissionOpportunity or legacy permissionRetry instruction, execute that exact ' +
  'advertised tool and arguments once, whether it names redeem_permission_opportunity or ' +
  'request_tool_permission. Never reconstruct or alter its retained target. This lets ' +
  'the user inspect the exact command and cwd. If the user then ' +
  'declines, do not retry or substitute another side effect; continue from available evidence ' +
  'and finish the participant turn.'

export function grokToolRecoveryPrompt(
  context: AcpToolRecoveryContext,
  taskWraithShellToolAvailable: boolean
): string {
  const request = context.deniedPermissionRequest
  const nativeShellRequest =
    context.reason === 'denied-permission-cancellation' &&
    request?.toolKind.toLowerCase() === 'execute' &&
    !/taskwraith/i.test(request.toolName)
  if (nativeShellRequest) return grokDeniedToolRecoveryPrompt(taskWraithShellToolAvailable)
  if (
    context.reason === 'failed-tool-terminal' &&
    /"permission(?:Opportunity|Retry)"\s*:|redeem_permission_opportunity|request_tool_permission|one auditable host execution|caller-declared paths cannot prove/i.test(
      context.lastFailedToolOutput || ''
    )
  ) {
    return GROK_PERMISSION_BOUNDARY_CONTINUITY_PROMPT
  }
  return GROK_FAILED_TOOL_CONTINUITY_PROMPT
}

export function isGrokDeniedToolCancellation(status: string | null | undefined): boolean {
  const normalized = String(status || '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '')
  return (
    normalized === 'cancelled' || normalized === 'canceled' || normalized === 'permissionrejected'
  )
}

/** Route RunManager cancellation through the provider handle before its raw
 *  process fallback runs. */
export function createGrokTurnAbortController(handle: { cancel: () => void }): AbortController {
  return createAcpTurnAbortController(handle)
}

const grokBinaryFromSpawnMessage = (message: string): string | null => {
  const match = message.match(/^spawn\s+(.+?)\s+ENOENT\b/)
  return match?.[1] ?? null
}

export const formatGrokProcessError = (err: Error): string => {
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
 * Run a single read-only Grok ACP turn. Delegates to the neutral turn client
 * with Grok's hooks: read-only fs client capabilities (Grok executes file/shell
 * tools natively and asks via session/request_permission), the denied-tool
 * one-shot recovery, and the ENOENT setup copy.
 */
export function runGrokAcpTurn(options: GrokAcpRunOptions): GrokAcpRunHandle {
  let resolveClosed!: () => void
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve
  })
  const handle = runAcpTurn({
    prompt: options.prompt,
    imagePaths: options.imagePaths,
    readImageFile: options.readImageFile,
    // Grok ACP builds accept inline image content even though their
    // initialize response currently reports promptCapabilities.image=false.
    // Keep the compatibility exception at the Grok adapter boundary; other
    // ACP providers remain fail-closed on an unadvertised image capability.
    allowUnadvertisedPromptImages: true,
    cwdLifetime: 'run',
    cwd: options.cwd,
    spawnProcess: options.spawnProcess,
    initializeParams: {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      clientInfo: { name: 'taskwraith', version: '1.0.6' }
    },
    mcpServers: options.mcpServers,
    onEvent: options.onEvent,
    onToolBatchBoundary: options.onToolBatchBoundary,
    onProcess: options.onProcess,
    onPermissionRequest: options.onPermissionRequest,
    deniedToolRecovery: {
      detect: isGrokDeniedToolCancellation,
      prompt: (context) =>
        grokToolRecoveryPrompt(context, Boolean(options.taskWraithShellToolAvailable)),
      shouldRecover: (context) =>
        context.toolFailureSeen && isGrokDeniedToolCancellation(context.terminalStatus),
      warning: (context) =>
        context.reason === 'denied-permission-cancellation' &&
        context.deniedPermissionRequest?.toolKind.toLowerCase() === 'execute'
          ? 'The agent cancelled after a refused native tool; continuing with clarified routing guidance.'
          : 'Grok stopped after a declined or failed tool; continuing once so it can finish from available evidence.'
    },
    formatProcessError: formatGrokProcessError,
    transientPromptRetryLimit: options.transientPromptRetryLimit,
    transientPromptRetryDelayMs: options.transientPromptRetryDelayMs,
    stderrCorrelationWindowMs: options.stderrCorrelationWindowMs,
    // Grok receives a bounded graceful termination request first. The neutral
    // ACP core sends SIGKILL after its grace window if no close event arrives.
    endProcess: (child) => child.kill('SIGTERM'),
    onClose: (code, turnComplete, terminalStatus) => {
      try {
        options.onClose?.(code, turnComplete, terminalStatus)
      } finally {
        resolveClosed()
      }
    },
    onRawFrame: options.onRawFrame
  })
  return { ...handle, closed }
}
