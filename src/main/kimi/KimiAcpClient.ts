// Kimi Code adapter over the provider-neutral ACP turn client.
//
// Unlike Grok (which executes file/shell tools natively and only asks via
// session/request_permission), Kimi Code routes its built-in file tools
// (Read/Write/Edit) through the ACP CLIENT fs capabilities when the
// client advertises them. This adapter advertises fs read+write and implements
// the handlers with WORKSPACE PATH AUTHORITY: a read or write for a path
// outside the granted roots is refused, so the model cannot use its auto-
// running file tools to escape the workspace. This is the `--agent-file
// allowed_tools:[]` successor — TaskWraith owns every file byte in and out.
//
// The egress tools (WebSearch/FetchURL) and sub-agent fan-out (AgentSwarm) are
// denied by the isolated-home config deny wall (KimiAcpContainment), not here —
// they never reach the client. Bash + MCP tools DO ask via
// session/request_permission, routed through onPermissionRequest.

import {
  runAcpTurn,
  type AcpChildProcess,
  type AcpInboundReply,
  type AcpTurnHandle
} from '../acp/AcpTurnClient'
import { isPathWithinRoots } from './KimiAcpContainment'
import type { AcpRunEvent, AcpPermissionRequest, AcpPermissionDecision } from '../acp/AcpProtocol'

export type { AcpChildProcess } from '../acp/AcpTurnClient'

/** Injected fs surface for the client-authority handlers (node fs in prod). */
export interface KimiAcpFs {
  readTextFile: (path: string) => Promise<string>
  writeTextFile: (path: string, content: string) => Promise<void>
  resolve: (path: string) => string
  relative: (from: string, to: string) => string
  /** Resolve symlinks; rejects if the path does not exist. */
  realpath: (path: string) => Promise<string>
  dirname: (path: string) => string
  basename: (path: string) => string
  join: (...parts: string[]) => string
}

export interface KimiAcpRunOptions {
  prompt: string
  /** Existing Kimi Code ACP session persisted in this seat's KIMI_CODE_HOME. */
  resumeSessionId?: string | null
  /** Full-context prompt used only when native resume cannot be completed. */
  resumeFallbackPrompt?: string
  /** Native maintenance turns such as /compact must never cold-start. */
  allowResumeFallback?: boolean
  /** Model/thinking selections to re-assert on a resumed native session. */
  resumeConfigOptions?: ReadonlyArray<{ configId: string; value: string }>
  cwd: string
  spawnProcess: () => AcpChildProcess
  /** Roots the fs handlers will serve: the workspace + external path grants. */
  fsRoots: readonly string[]
  fs: KimiAcpFs
  /** MCP servers advertised to session/new or session/resume. */
  mcpServers?: unknown[]
  onEvent: (event: AcpRunEvent) => void
  onProcess?: (child: AcpChildProcess) => void
  /** Tool-approval mediator for Bash/MCP asks. Default (omitted) DENIES. */
  onPermissionRequest?: (
    request: AcpPermissionRequest
  ) => AcpPermissionDecision | Promise<AcpPermissionDecision>
  onClose?: (code: number | null, turnComplete: boolean, terminalStatus?: string) => void
  onRawFrame?: (direction: 'in' | 'out', message: unknown) => void
  onSessionReady?: (session: {
    sessionId: string
    resumed: boolean
    fallbackFromResume: boolean
  }) => void
}

export type KimiAcpRunHandle = AcpTurnHandle

const KIMI_FS_READ = 'fs/read_text_file'
const KIMI_FS_WRITE = 'fs/write_text_file'
// JSON-RPC application error for a client-refused fs path (not a protocol error).
const KIMI_FS_DENIED_CODE = -32001

export function formatKimiProcessError(err: Error): string {
  const error = err as Error & { code?: unknown; path?: unknown }
  const message = err.message || String(err)
  const isMissingBinary = error.code === 'ENOENT' || /\bENOENT\b/.test(message)
  if (!isMissingBinary) return message
  const attemptedPath = typeof error.path === 'string' ? error.path : '~/.kimi-code/bin/kimi'
  return `Kimi Code could not be started. TaskWraith tried ${attemptedPath}, but macOS reported ENOENT. Open Settings -> Providers -> Kimi and confirm Kimi Code is installed and signed in (\`kimi login\`), then retry.`
}

function pathParam(message: Record<string, unknown>): string {
  const params = message.params
  if (params && typeof params === 'object' && !Array.isArray(params)) {
    const p = (params as { path?: unknown }).path
    if (typeof p === 'string') return p
  }
  return ''
}

function contentParam(message: Record<string, unknown>): string {
  const params = message.params
  if (params && typeof params === 'object' && !Array.isArray(params)) {
    const c = (params as { content?: unknown }).content
    if (typeof c === 'string') return c
  }
  return ''
}

/**
 * Build the inbound-request handler that answers Kimi's fs capability requests
 * under workspace path authority. Exported for direct unit testing.
 */
export function createKimiFsInboundHandler(options: {
  fsRoots: readonly string[]
  fs: KimiAcpFs
  onEvent: (event: AcpRunEvent) => void
}) {
  const { fsRoots, fs, onEvent } = options

  // Resolve symlinks BEFORE the authority check: path.resolve/relative are
  // lexical, so a symlink inside a granted root (shipped in a repo or created
  // mid-run) could otherwise read/write OUTSIDE it — e.g. /ws/link/passwd passes
  // the lexical check when /ws/link -> /etc. A brand-new write target won't
  // exist, so resolve its PARENT (which does) and re-attach the basename, so the
  // symlinked directory is caught for writes too.
  const realResolve = async (target: string): Promise<string> => {
    try {
      return await fs.realpath(target)
    } catch {
      try {
        return fs.join(await fs.realpath(fs.dirname(target)), fs.basename(target))
      } catch {
        return fs.resolve(target)
      }
    }
  }
  const withinAuthority = async (target: string): Promise<boolean> => {
    const [resolvedTarget, resolvedRoots] = await Promise.all([
      realResolve(target),
      Promise.all(
        fsRoots.map(async (root) => {
          try {
            return await fs.realpath(root)
          } catch {
            return fs.resolve(root)
          }
        })
      )
    ])
    return isPathWithinRoots(resolvedTarget, resolvedRoots, {
      resolve: fs.resolve,
      relative: fs.relative
    })
  }

  return (message: Record<string, unknown>, reply: AcpInboundReply): boolean => {
    const method = message.method
    if (method !== KIMI_FS_READ && method !== KIMI_FS_WRITE) return false
    const target = pathParam(message)
    withinAuthority(target)
      .then((ok) => {
        if (!ok) {
          onEvent({
            type: 'provider_warning',
            text: `Kimi requested a ${method === KIMI_FS_WRITE ? 'write' : 'read'} outside the workspace (${target || 'unknown path'}); TaskWraith denied it.`
          })
          reply.respondError(KIMI_FS_DENIED_CODE, 'Path is outside the granted workspace roots.')
          return undefined
        }
        if (method === KIMI_FS_READ) {
          return fs.readTextFile(target).then((content) => reply.respondResult({ content }))
        }
        return fs.writeTextFile(target, contentParam(message)).then(() => reply.respondResult(null))
      })
      .catch((error) =>
        reply.respondError(
          KIMI_FS_DENIED_CODE,
          `${method === KIMI_FS_WRITE ? 'Write' : 'Read'} failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      )
    return true
  }
}

/**
 * Run a single Kimi Code ACP turn. Advertises fs client capabilities and
 * mediates every fs request under workspace authority; delegates the JSON-RPC
 * lifecycle, permission default-deny, and cancellation to the neutral core.
 * No denied-tool recovery (Kimi's denials are clean tool rejections, not
 * turn-cancellations).
 */
export function runKimiAcpTurn(options: KimiAcpRunOptions): KimiAcpRunHandle {
  const onInboundRequest = createKimiFsInboundHandler({
    fsRoots: options.fsRoots,
    fs: options.fs,
    onEvent: options.onEvent
  })
  return runAcpTurn({
    prompt: options.prompt,
    resumeSessionId: options.resumeSessionId,
    resumeFallbackPrompt: options.resumeFallbackPrompt,
    allowResumeFallback: options.allowResumeFallback,
    resumeConfigOptions: options.resumeConfigOptions,
    cwd: options.cwd,
    spawnProcess: options.spawnProcess,
    initializeParams: {
      protocolVersion: 1,
      // Advertise fs authority so built-in file tools route through us.
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
      clientInfo: { name: 'taskwraith', version: '1.0.6' }
    },
    mcpServers: options.mcpServers,
    onEvent: options.onEvent,
    onProcess: options.onProcess,
    onPermissionRequest: options.onPermissionRequest,
    onInboundRequest,
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
    onSessionReady: options.onSessionReady
  })
}
