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
  type AcpTurnHandle
} from '../acp/AcpTurnClient'
import type {
  NormalizedGrokRunEvent,
  AcpPermissionRequest,
  AcpPermissionDecision
} from './GrokAcpProtocol'

export type { AcpChildProcess } from '../acp/AcpTurnClient'

export interface GrokAcpRunOptions {
  prompt: string
  cwd: string
  /** Spawns `grok --no-auto-update agent stdio` (injected for testability). */
  spawnProcess: () => AcpChildProcess
  /**
   * MCP servers advertised to the session (session/new `mcpServers`) — the full
   * TaskWraith bridge for write seats or the scoped safe-subset for read-only
   * seats. Omitted/empty = no TaskWraith tools.
   */
  mcpServers?: unknown[]
  /** Normalized run events: content / thinking / init(sessionId) / result / warning. */
  onEvent: (event: NormalizedGrokRunEvent) => void
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
}

export interface GrokAcpRunHandle extends AcpTurnHandle {
  /**
   * Resolves only after the one-shot child emits its real `close` event and the
   * caller's terminal projection/cleanup callback has returned. A kill request
   * or RunManager terminal state is not close evidence.
   */
  closed: Promise<void>
}

export const GROK_DENIED_TOOL_RECOVERY_PROMPT =
  'Your previous native tool request was denied by TaskWraith policy. Continue this same turn ' +
  'without retrying that tool or substituting another side-effecting tool. Answer from the ' +
  'evidence already gathered. If the denied operation is essential, explain the blocker and ' +
  'the safe next step instead of ending the turn.'

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
    cwd: options.cwd,
    spawnProcess: options.spawnProcess,
    initializeParams: {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      clientInfo: { name: 'taskwraith', version: '1.0.6' }
    },
    mcpServers: options.mcpServers,
    onEvent: options.onEvent,
    onProcess: options.onProcess,
    onPermissionRequest: options.onPermissionRequest,
    deniedToolRecovery: {
      detect: isGrokDeniedToolCancellation,
      prompt: GROK_DENIED_TOOL_RECOVERY_PROMPT
    },
    formatProcessError: formatGrokProcessError,
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
