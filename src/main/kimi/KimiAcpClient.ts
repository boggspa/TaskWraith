// Kimi Code adapter over the provider-neutral ACP turn client.
//
// Production Kimi seats deliberately advertise no ACP client-fs capability.
// Every native filesystem/exec/egress/fan-out tool is denied by the isolated
// profile; the only workspace surface is TaskWraith's governed HTTP MCP
// gateway. This avoids both provider-side fallback and path check/use races.

import {
  runAcpTurn,
  type AcpChildProcess,
  type AcpSessionConfigSelection,
  type AcpTurnHandle
} from '../acp/AcpTurnClient'
import type { AcpRunEvent, AcpPermissionRequest, AcpPermissionDecision } from '../acp/AcpProtocol'
import { buildKimiProductionInitializeParams } from './KimiProductionContainment'

export type { AcpChildProcess } from '../acp/AcpTurnClient'

/**
 * Legacy live-probe shape retained temporarily so historical diagnostic suites
 * still typecheck. Production ignores these fields and exposes no fs handler.
 */
export interface KimiAcpFs {
  readTextFile: (path: string) => Promise<string>
  writeTextFile: (path: string, content: string) => Promise<void>
  resolve: (path: string) => string
  relative: (from: string, to: string) => string
  realpath: (path: string) => Promise<string>
  dirname: (path: string) => string
  basename: (path: string) => string
  join: (...parts: string[]) => string
}

export interface KimiAcpRunOptions {
  prompt: string
  /** Main-authorized images; the ACP runtime must advertise prompt image support. */
  imagePaths?: readonly string[]
  /** Existing Kimi Code ACP session persisted in this seat's KIMI_CODE_HOME. */
  resumeSessionId?: string | null
  /** Full-context prompt used only when native resume cannot be completed. */
  resumeFallbackPrompt?: string
  /** Native maintenance turns such as /compact must never cold-start. */
  allowResumeFallback?: boolean
  /** Model/thinking selections to re-assert on a resumed native session. */
  resumeConfigOptions?: ReadonlyArray<AcpSessionConfigSelection>
  /** Must be `session` for every durable seat, including its first turn. */
  cwdLifetime: 'run' | 'session'
  cwd: string
  spawnProcess: () => AcpChildProcess
  /** Defaults to the exact fs-free production initialize posture. */
  initializeParams?: Record<string, unknown>
  /** @deprecated Ignored. Historical probe compatibility only. */
  fsRoots?: readonly string[]
  /** @deprecated Ignored. Historical probe compatibility only. */
  fs?: KimiAcpFs
  /** MCP servers advertised to session/new or session/resume. */
  mcpServers?: unknown[]
  /**
   * Post-resume surface check (see AcpTurnClient). Kimi production wires this
   * to the per-run gateway bridge's first-contact probe: every native fs/exec
   * tool is deny-walled, so a resumed session that never touches the bridge
   * has ZERO usable tools and must be reminted with session/new instead.
   */
  confirmResumedSession?: () => Promise<boolean>
  onEvent: (event: AcpRunEvent) => void
  /** Exact notification after every tool in one parallel ACP batch settles. */
  onToolBatchBoundary?: () => void
  onProcess?: (child: AcpChildProcess) => void
  beforeInitialize?: (child: AcpChildProcess) => Promise<void>
  /** Tool-approval mediator for Bash/MCP asks. Default (omitted) DENIES. */
  onPermissionRequest?: (
    request: AcpPermissionRequest
  ) => AcpPermissionDecision | Promise<AcpPermissionDecision>
  onClose?: (
    code: number | null,
    turnComplete: boolean,
    terminalStatus?: string
  ) => void | Promise<void>
  onRawFrame?: (direction: 'in' | 'out', message: unknown) => void
  onSessionReady?: (session: {
    sessionId: string
    resumed: boolean
    fallbackFromResume: boolean
  }) => void
  /** Wire-prompt observation hook — see AcpTurnOptions.onWirePrompt. */
  onWirePrompt?: (text: string) => void
}

export type KimiAcpRunHandle = AcpTurnHandle

export function formatKimiProcessError(err: Error): string {
  const error = err as Error & { code?: unknown; path?: unknown }
  const message = err.message || String(err)
  const isMissingBinary = error.code === 'ENOENT' || /\bENOENT\b/.test(message)
  if (!isMissingBinary) return message
  const attemptedPath = typeof error.path === 'string' ? error.path : '~/.kimi-code/bin/kimi'
  return `Kimi Code could not be started. TaskWraith tried ${attemptedPath}, but macOS reported ENOENT. Open Settings -> Providers -> Kimi and confirm Kimi Code is installed and signed in (\`kimi login\`), then retry.`
}

/**
 * Run a single Kimi Code ACP turn. Advertises no fs client capability and
 * delegates the JSON-RPC lifecycle, permission default-deny, and cancellation
 * to the neutral core.
 * No denied-tool recovery (Kimi's denials are clean tool rejections, not
 * turn-cancellations).
 */
export function runKimiAcpTurn(options: KimiAcpRunOptions): KimiAcpRunHandle {
  return runAcpTurn({
    prompt: options.prompt,
    imagePaths: options.imagePaths,
    resumeSessionId: options.resumeSessionId,
    resumeFallbackPrompt: options.resumeFallbackPrompt,
    allowResumeFallback: options.allowResumeFallback,
    resumeConfigOptions: options.resumeConfigOptions,
    cwdLifetime: options.cwdLifetime,
    cwd: options.cwd,
    spawnProcess: options.spawnProcess,
    initializeParams: options.initializeParams ?? buildKimiProductionInitializeParams('1.0.6'),
    mcpServers: options.mcpServers,
    confirmResumedSession: options.confirmResumedSession,
    onEvent: options.onEvent,
    onToolBatchBoundary: options.onToolBatchBoundary,
    onProcess: options.onProcess,
    beforeInitialize: options.beforeInitialize,
    onPermissionRequest: options.onPermissionRequest,
    deniedToolRecovery: null,
    formatProcessError: formatKimiProcessError,
    // Kimi Code's `kimi acp` ignores SIGINT AND SIGTERM; it exits only on stdin
    // EOF. Terminate by closing stdin; the neutral core's SIGKILL backstop
    // catches the (unobserved) case where even that does not exit in time.
    endProcess: (child) => {
      try {
        child.stdin?.end?.()
      } catch {
        try {
          child.kill('SIGKILL')
        } catch {
          /* ignore */
        }
      }
    },
    onClose: options.onClose,
    onRawFrame: options.onRawFrame,
    onSessionReady: options.onSessionReady,
    onWirePrompt: options.onWirePrompt
  })
}
