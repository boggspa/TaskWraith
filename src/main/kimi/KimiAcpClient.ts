// Kimi Code adapter over the provider-neutral ACP turn client.
//
// Production Kimi seats deliberately advertise no ACP client-fs capability.
// Workspace operations are intended to use TaskWraith's governed HTTP MCP
// gateway. Native rule enforcement is separate evidence: the current provider
// may expose native tools despite the configured deny rules.

import {
  runAcpTurn,
  type AcpChildProcess,
  type AcpSessionConfigSelection,
  type AcpTurnHandle
} from '../acp/AcpTurnClient'
import type { AcpRunEvent, AcpPermissionRequest, AcpPermissionDecision } from '../acp/AcpProtocol'
import { buildKimiProductionInitializeParams } from './KimiProductionContainment'
import { createKimiRunRecovery, type KimiRunRecoveryOptions } from './KimiRunRecovery'
import { isKimiDeniedNativeTool } from './KimiToolPolicy'

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
   * Legacy post-resume contact check. Production recovery uses the stronger
   * post-configuration prepareSessionPrompt check and a served tool catalogue.
   */
  confirmResumedSession?: () => Promise<boolean>
  /** Main-owned gateway and exact-run context for readiness, receipts and handoff. */
  recovery?: KimiRunRecoveryOptions
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
  onWirePrompt?: (
    text: string,
    selected?: { sessionId: string; kind: 'initial' | 'retry' | 'steer' }
  ) => void
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
 * Managed recovery attributes native refusals and settles a repeated blocked
 * route at a drained tool boundary, retaining the existing session history.
 */
export function runKimiAcpTurn(options: KimiAcpRunOptions): KimiAcpRunHandle {
  const recovery = options.recovery ? createKimiRunRecovery(options.recovery) : null
  let correctionPrompt: string | null = null
  let toolSnapshotRequested = false
  let handle: AcpTurnHandle | null = null
  handle = runAcpTurn({
    prompt: options.prompt,
    imagePaths: options.imagePaths,
    resumeSessionId: options.resumeSessionId,
    resumeFallbackPrompt: options.resumeFallbackPrompt,
    allowResumeFallback: options.allowResumeFallback,
    resumeConfigOptions: options.resumeConfigOptions,
    sessionConfigOptions: recovery ? options.resumeConfigOptions : undefined,
    cwdLifetime: options.cwdLifetime,
    cwd: options.cwd,
    spawnProcess: options.spawnProcess,
    initializeParams: options.initializeParams ?? buildKimiProductionInitializeParams('1.0.6'),
    mcpServers: options.mcpServers,
    confirmResumedSession: recovery ? undefined : options.confirmResumedSession,
    prepareSessionPrompt: recovery?.prepareSessionPrompt,
    onEvent: (event) => {
      recovery?.onEvent(event)
      options.onEvent(event)
      if (
        recovery &&
        !toolSnapshotRequested &&
        ['thinking', 'content', 'tool_use'].includes(event.type)
      ) {
        toolSnapshotRequested = true
        void recovery.observeProviderTools().then(() => {
          const snapshot = recovery.snapshot()
          if (snapshot.outcome === 'blocked' && snapshot.blocker)
            handle?.finishBlocked?.(snapshot.blocker)
        })
      }
    },
    onToolBatchBoundary: () => {
      options.onToolBatchBoundary?.()
      const action = recovery?.boundaryAction()
      if (!action || !handle) return
      if (action.kind === 'blocked') handle.finishBlocked?.(action.message)
      else {
        correctionPrompt = action.message
        handle.steer(action.message)
      }
    },
    onProcess: options.onProcess,
    beforeInitialize: options.beforeInitialize,
    onPermissionRequest: recovery
      ? async (request) => {
          if (isKimiDeniedNativeTool(request)) {
            recovery.permissionResult(request, 'deny')
            return 'deny'
          }
          const decision = options.onPermissionRequest
            ? await options.onPermissionRequest(request)
            : 'deny'
          return decision
        }
      : options.onPermissionRequest,
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
    onClose: async (code, completed, status) => {
      recovery?.beginClose(handle?.wasBlockedByHost?.() === true)
      await options.onClose?.(code, completed, status)
      recovery?.close()
    },
    onRawFrame: (direction, message) => {
      recovery?.onRawFrame(direction, message)
      options.onRawFrame?.(direction, message)
    },
    onSessionReady: options.onSessionReady,
    onWirePrompt: (text, selected) => {
      recovery?.beginPrompt()
      toolSnapshotRequested = false
      if (selected?.kind === 'steer' && text !== correctionPrompt) recovery?.externalSteer()
      correctionPrompt = null
      options.onWirePrompt?.(text, selected)
    }
  })
  return handle
}
