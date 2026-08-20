import { spawn, type ChildProcess } from 'child_process'
import { randomUUID } from 'crypto'
import { existsSync } from 'fs'
import { join } from 'path'
import { createInterface, type Interface as ReadlineInterface } from 'readline'
import { resolvePackagedBridgeDaemonPath } from './BridgeDaemonBinaryPath'

/**
 * BridgeDaemonClient — Electron-side bridge to the
 * `TaskWraithBridgeDaemon` Swift binary.
 *
 * At this stage the client only verifies the spawn pipeline:
 *   1. Locate the daemon binary (`swift/TaskWraithBridge/.build/debug/...`).
 *   2. Spawn it with piped stdio (mirrors `CodexAppServerClient.start()`).
 *   3. Read the first stdout line — a single `daemon-hello` JSON announcement
 *      that confirms the self-contained TaskWraith daemon started.
 *   4. Surface the announcement to a caller-provided handler for telemetry.
 *
 * The daemon is now local-only: Screen Watch, creative-app helpers, editor
 * opening, Finder reveal, and stdio JSON-RPC diagnostics.
 *
 * The client is gated externally — `main/index.ts` only constructs it when
 * `TASKWRAITH_BRIDGE_DAEMON=1` is set in the environment. Production builds
 * leave the daemon dormant until the feature is generally available.
 */

export interface BridgeDaemonHello {
  kind: string
  daemon: string
  protocolVersion: string
  displayName: string
  bonjourServiceType: string
  quicALPN: string
  pid: number
  timestamp: string
}

export interface BridgeDaemonClientOptions {
  /** Override the daemon binary path. Falls back to the dev build location
   * inside the repo. Production builds will point at the bundled resource. */
  binaryPath?: string
  /** Called once the daemon prints its hello line. */
  onHello?: (hello: BridgeDaemonHello) => void
  /** Forwarded daemon stderr text (one line per write). */
  onStderr?: (text: string) => void
  /** Daemon exited unexpectedly. `code` is `null` when killed by signal. */
  onExit?: (code: number | null) => void
  /** Optional notification handler — server-pushed messages with no `id`. */
  onNotification?: (method: string, params: unknown) => void
  /** Optional inbound-request handler — Phase C3.5+. The daemon issues
   * `{id, method, params}` envelopes when it needs to ASK the host for
   * something and await an answer.
   * Return a value (sync or via Promise); the client encodes a JSON-RPC
   * result envelope and writes it back on stdin. Throw a `BridgeDaemonError`
   * to send a structured JSON-RPC error. Throwing any other Error sends a
   * generic `-32603 internalError`. If no handler is set, the
   * client responds with `-32601 methodNotFound` so the daemon awaiter
   * doesn't hang. */
  onRequest?: (method: string, params: unknown) => unknown | Promise<unknown>
  /** Request timeout in ms. Defaults to 10s — generous for transport ops
   * but won't hang indefinitely on a misbehaving daemon. */
  requestTimeoutMs?: number
}

/** Standard JSON-RPC 2.0 error shape. Surfaced to callers via thrown
 * `BridgeDaemonError` (so `try/catch` can inspect `code`). */
export interface BridgeDaemonRpcError {
  code: number
  message: string
  data?: unknown
}

export class BridgeDaemonError extends Error {
  readonly code: number
  readonly data: unknown
  constructor(rpcError: BridgeDaemonRpcError) {
    super(rpcError.message)
    this.name = 'BridgeDaemonError'
    this.code = rpcError.code
    this.data = rpcError.data
  }
}

interface PendingRequest {
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  method: string
  timer: NodeJS.Timeout
}

export class BridgeDaemonClient {
  private proc: ChildProcess | null = null
  private stdoutReader: ReadlineInterface | null = null
  private readonly options: BridgeDaemonClientOptions
  private startedAt: Date | null = null
  /** Outstanding request id → resolver. Cleared on response, error, timeout,
   * or daemon exit. */
  private readonly pending = new Map<string, PendingRequest>()
  private readonly requestTimeoutMs: number

  constructor(options: BridgeDaemonClientOptions = {}) {
    this.options = options
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000
  }

  /** Resolve the daemon binary location.
   *
   * Resolution order:
   *   1. Explicit `options.binaryPath` (tests / smokes override this).
   *   2. Packaged Electron build: `Contents/Helpers/TaskWraithBridgeDaemon`.
   *      `electron-builder.yml`'s mac `extraFiles` block places the release
   *      binary there, and
   *      `scripts/build-bridge-daemon.cjs` builds it just before
   *      electron-builder packs.
   *   3. Dev tree: `swift/TaskWraithBridge/.build/debug/...` (after
   *      `swift build`) or `.../release/...` (after `swift build -c
   *      release`).
   *
   * Returning a non-existent path is acceptable — `start()` checks
   * existsSync and surfaces a clear error so the developer can run
   * `swift build` (or check that the packaged binary embedded). */
  private resolveBinaryPath(): string {
    if (this.options.binaryPath) return this.options.binaryPath

    // process.resourcesPath points at Contents/Resources in a packaged app;
    // the resolver walks to the sibling Contents/Helpers directory. In dev it
    // points at Electron's vendored resources and falls through to SwiftPM.
    const bundled = resolvePackagedBridgeDaemonPath(process.resourcesPath)
    if (bundled) return bundled

    // Dev: prefer debug, fall back to release. Path is relative to
    // src/main/ → repo root.
    const devDebug = join(
      __dirname,
      '..',
      '..',
      'swift',
      'TaskWraithBridge',
      '.build',
      'debug',
      'TaskWraithBridgeDaemon'
    )
    if (existsSync(devDebug)) return devDebug
    return join(
      __dirname,
      '..',
      '..',
      'swift',
      'TaskWraithBridge',
      '.build',
      'release',
      'TaskWraithBridgeDaemon'
    )
  }

  /** Spawn the daemon. Resolves once the first hello line has been read,
   * or rejects if the process exits before announcing. */
  async start(): Promise<BridgeDaemonHello> {
    if (this.proc) {
      throw new Error('BridgeDaemonClient is already running')
    }
    const binaryPath = this.resolveBinaryPath()
    if (!existsSync(binaryPath)) {
      throw new Error(
        `BridgeDaemonClient: daemon binary not found at ${binaryPath}. Run \`swift build\` in swift/TaskWraithBridge first.`
      )
    }

    this.startedAt = new Date()
    this.proc = spawn(binaryPath, [], {
      shell: false,
      stdio: 'pipe'
    })

    return new Promise<BridgeDaemonHello>((resolve, reject) => {
      let settled = false
      const finishOk = (hello: BridgeDaemonHello) => {
        if (settled) return
        settled = true
        resolve(hello)
      }
      const finishErr = (err: Error) => {
        if (settled) return
        settled = true
        this.dispose()
        reject(err)
      }

      if (!this.proc) {
        finishErr(new Error('Spawn returned no process handle'))
        return
      }

      // Stdout — line-oriented, JSON per line. The first line is always
      // `daemon-hello`; subsequent lines are JSON-RPC 2.0 responses or
      // server-pushed notifications.
      this.stdoutReader = createInterface({ input: this.proc.stdout! })
      this.stdoutReader.on('line', (line) => {
        const trimmed = line.trim()
        if (!trimmed) return
        let parsed: unknown
        try {
          parsed = JSON.parse(trimmed)
        } catch {
          // Non-JSON line — ignore for now. Phase C-late will surface as a
          // structured parse error so daemon authors notice malformed output.
          return
        }
        if (!parsed || typeof parsed !== 'object') return
        const message = parsed as Record<string, unknown>

        // Hello announcement (one-shot, sent at daemon startup before any
        // JSON-RPC traffic).
        if (message.kind === 'daemon-hello') {
          const hello = message as unknown as BridgeDaemonHello
          this.options.onHello?.(hello)
          finishOk(hello)
          return
        }

        // Anything with an `id` is either:
        //   - a response to one of OUR outbound requests (has result/error)
        //   - an INBOUND request from the daemon (has method, no result/error)
        // Phase C3.5 added the inbound-request path; before that the daemon
        // never spoke first in id-bearing envelopes.
        if (typeof message.id === 'string' || typeof message.id === 'number') {
          const id = String(message.id)
          const hasResult = 'result' in message
          const hasError = 'error' in message
          if (hasResult || hasError) {
            const pending = this.pending.get(id)
            if (!pending) return // late response after timeout — drop it
            clearTimeout(pending.timer)
            this.pending.delete(id)
            if (hasError) {
              const errPayload = message.error as BridgeDaemonRpcError
              pending.reject(new BridgeDaemonError(errPayload))
            } else {
              pending.resolve(message.result)
            }
            return
          }
          if (typeof message.method === 'string') {
            void this.handleInboundRequest(id, message.method, message.params)
          }
          return
        }

        // JSON-RPC 2.0 notification — has `method`, no `id`. Push events
        // from the daemon (transport state, incoming actions, etc.) flow here.
        if (typeof message.method === 'string') {
          this.options.onNotification?.(message.method, message.params)
        }
      })

      this.proc.stderr?.on('data', (chunk: Buffer) => {
        this.options.onStderr?.(chunk.toString('utf8'))
      })

      this.proc.on('exit', (code) => {
        this.options.onExit?.(code)
        this.proc = null
        this.stdoutReader?.close()
        this.stdoutReader = null
        finishErr(new Error(`Daemon exited with code ${code ?? 'unknown'} before sending hello`))
      })

      this.proc.on('error', (err) => {
        finishErr(err)
      })

      // 1.0.5-EW19 — Attach swallow-only `error` listeners on each
      // stdio stream. EW14 fixed the synchronous + write-callback
      // EPIPE paths in `notify`, but Node ALSO emits a separate
      // `'error'` event on the underlying Pipe stream when the
      // remote end (the daemon) closes while a write is buffered.
      // Without a listener Node escalates that to
      // `uncaughtException` — i.e. the user's Electron error
      // dialog on quit. Stdin EPIPE during shutdown is expected
      // and harmless; stdout/stderr listeners are belt-and-braces
      // for any future write path through these streams.
      this.proc.stdin?.on('error', (_err) => {
        // Intentionally empty — see comment above.
      })
      this.proc.stdout?.on('error', (_err) => {
        // Defensive; stdout is read-only from our side so EPIPE
        // shouldn't fire here, but absorbing keeps us robust to
        // upstream Node changes.
      })
      this.proc.stderr?.on('error', (_err) => {
        // Defensive; same reasoning as stdout.
      })
    })
  }

  /**
   * Issue a JSON-RPC 2.0 request and await the response.
   *
   * - Generates a UUID id, registers a pending entry, writes the request line.
   * - Resolves with `result` when the daemon responds, rejects with
   *   `BridgeDaemonError` (carrying `code`) when the daemon returns an error.
   * - Rejects with a plain `Error` on timeout (default 10s, configurable via
   *   `BridgeDaemonClientOptions.requestTimeoutMs` for the client, or
   *   per-call via `options.timeoutMs` for methods like the attached-window
   *   picker that legitimately block on user gesture).
   *
   * Supported methods include `bridge.ping`, `bridge.status`, Screen Watch,
   * creative-app helpers, editor opening, and Finder reveal.
   */
  async request<T = unknown>(
    method: string,
    params?: unknown,
    options?: { timeoutMs?: number }
  ): Promise<T> {
    if (!this.proc || !this.proc.stdin || this.proc.stdin.destroyed) {
      throw new Error(`BridgeDaemonClient.request("${method}"): daemon is not running`)
    }
    const id = randomUUID()
    const envelope = {
      jsonrpc: '2.0' as const,
      id,
      method,
      ...(params !== undefined ? { params } : {})
    }
    const timeoutMs =
      typeof options?.timeoutMs === 'number' && options.timeoutMs > 0
        ? options.timeoutMs
        : this.requestTimeoutMs
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`BridgeDaemonClient.request("${method}"): timeout after ${timeoutMs}ms`))
        }
      }, timeoutMs)
      timer.unref?.()

      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        method,
        timer
      })

      try {
        this.proc!.stdin!.write(`${JSON.stringify(envelope)}\n`)
      } catch (err) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  /**
   * Handle a daemon → host inbound request. Invokes the caller-supplied
   * `onRequest` handler and writes a JSON-RPC response back to stdin so the
   * daemon-side awaiter resolves. If no handler is registered we respond with
   * method-not-found so the daemon doesn't hang on its configured timeout.
   */
  private async handleInboundRequest(id: string, method: string, params: unknown): Promise<void> {
    if (!this.options.onRequest) {
      this.respondError(id, -32601, `No onRequest handler registered for "${method}"`)
      return
    }
    try {
      const result = await Promise.resolve(this.options.onRequest(method, params))
      this.respondResult(id, result)
    } catch (err) {
      // BridgeDaemonError carries a structured code (we use it for round-tripping
      // a remote error back to the daemon). Any other Error becomes -32603.
      if (err instanceof BridgeDaemonError) {
        this.respondError(id, err.code, err.message, err.data)
      } else {
        const message = err instanceof Error ? err.message : String(err)
        this.respondError(id, -32603, message)
      }
    }
  }

  private respondResult(id: string, result: unknown): void {
    this.writeStdinLine({ jsonrpc: '2.0', id, result: result === undefined ? null : result })
  }

  private respondError(id: string, code: number, message: string, data?: unknown): void {
    const error: BridgeDaemonRpcError = {
      code,
      message,
      ...(data !== undefined ? { data } : {})
    }
    this.writeStdinLine({ jsonrpc: '2.0', id, error })
  }

  private writeStdinLine(envelope: object): void {
    if (!this.proc || !this.proc.stdin || this.proc.stdin.destroyed) return
    try {
      this.proc.stdin.write(`${JSON.stringify(envelope)}\n`)
    } catch {
      // Best-effort. If stdin is gone the daemon will eventually time out.
    }
  }

  /**
   * Send a JSON-RPC notification (no `id`, no response). Used for fire-and-
   * forget signals from Electron to the daemon — e.g. settings changes,
   * shutdown hints. The daemon's dispatcher silently drops unknown methods
   * for notifications, so versioning concerns are minimal.
   */
  notify(method: string, params?: unknown): void {
    if (!this.proc || !this.proc.stdin || this.proc.stdin.destroyed) {
      throw new Error(`BridgeDaemonClient.notify("${method}"): daemon is not running`)
    }
    const envelope = {
      jsonrpc: '2.0' as const,
      method,
      ...(params !== undefined ? { params } : {})
    }
    try {
      // 1.0.5-EW14 — Pre-EW14 this was a fire-and-forget
      // stdin.write; if the daemon's pipe closed between our
      // destroyed-check above and the actual write reaching the
      // OS (typical race during app quit), Node fires an EPIPE
      // from inside `afterWriteDispatched` — an async callback
      // the surrounding try/catch can't catch. The error
      // bubbled all the way up to Electron's uncaught-exception
      // dialog. Passing a callback to write() lets us swallow
      // EPIPE / write-after-end / similar terminal-write
      // errors gracefully; notifications are inherently
      // best-effort so a missed one on quit is fine.
      this.proc.stdin.write(`${JSON.stringify(envelope)}\n`, () => {
        // Intentionally empty — any error here is acceptable
        // (we either successfully sent or the daemon went away).
      })
    } catch {
      // Best-effort — notifications can't fail observably.
    }
  }

  /** Best-effort clean shutdown. Closes stdin (which the daemon treats as
   * a "parent died, exit" signal) and falls back to SIGTERM after a short
   * grace period. Safe to call multiple times. Any pending requests are
   * rejected so callers don't hang. */
  dispose(): void {
    const proc = this.proc
    // Reject everything in flight so callers can clean up.
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(new Error(`BridgeDaemonClient disposed before "${entry.method}" responded`))
      this.pending.delete(id)
    }
    if (!proc) return
    this.proc = null
    this.stdoutReader?.close()
    this.stdoutReader = null
    try {
      proc.stdin?.end()
    } catch {
      // Ignore — proc may already be dead.
    }
    // If the daemon hasn't exited within ~500ms of stdin close, signal it.
    setTimeout(() => {
      if (!proc.killed) {
        try {
          proc.kill('SIGTERM')
        } catch {
          // Ignore — proc may already be gone.
        }
      }
    }, 500).unref()
  }

  /** Diagnostics for the raw-events panel or settings UI. */
  status(): { running: boolean; startedAt: string | null; pid: number | null } {
    return {
      running: Boolean(this.proc && !this.proc.killed),
      startedAt: this.startedAt?.toISOString() ?? null,
      pid: this.proc?.pid ?? null
    }
  }
}
