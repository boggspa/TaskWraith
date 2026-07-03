import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { createInterface, type Interface as ReadlineInterface } from 'readline'
import {
  createCliEnv,
  createCliSpawnPlan,
  resolveCliProviderBinary
} from './providers/CliProviderRuntime'
import type { RuntimeProfile } from './store/types'
import { collectUserMcpProviderEnv, type UserMcpLaunchServer } from './UserMcpServers'

/**
 * Codex's app-server only accepts UUID thread ids (optionally `urn:uuid:`-
 * prefixed) for `thread/resume`. A `codex exec` fallback run mints a synthetic
 * `codex-exec-<ts>` session id; if that ever gets persisted as a chat's
 * providerSessionId, feeding it back to `thread/resume` throws "invalid thread
 * id" and the run perpetually falls back to exec (which re-mints another
 * `codex-exec-` id — a poison loop). Guard with this before resuming: a
 * non-UUID id has no app-server thread to resume, so the caller should
 * `thread/start` a fresh thread instead (whose UUID then replaces the bad id).
 */
const CODEX_APP_SERVER_THREAD_ID_RE =
  /^(urn:uuid:)?[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

export function isCodexAppServerThreadId(value: string | null | undefined): boolean {
  return typeof value === 'string' && CODEX_APP_SERVER_THREAD_ID_RE.test(value.trim())
}

/**
 * Detect the specific failure where the codex CLI refuses to start because
 * it cannot deserialize `~/.codex/config.toml`. This happens when the user's
 * Codex.app (a newer CLI) writes a config value that the older homebrew CLI
 * TaskWraith spawns does not understand — the real error we hit in production was:
 *
 *   Error loading config.toml: unknown variant `priority`, expected `fast`
 *   or `flex` in `service_tier`
 *
 * The CLI emits this on stderr and exits non-zero, so the app-server spawn /
 * probe / exec fallback all fail with a generic "exited" error. We classify
 * the stderr text so the caller can surface a clear, actionable message
 * (edit config.toml / `brew upgrade codex`) instead of the cryptic generic
 * "app-server unavailable; falling back to codex exec".
 *
 * Match strategy (kept deliberately tight to avoid false-positiving on normal
 * agent output that merely mentions a config path):
 *   - an explicit serde/config deserialize signature
 *     (`error loading config`, `unknown variant`, `unknown field`,
 *      `invalid type`, `missing field`, ``expected `x` or``, `expected one of`), OR
 *   - any phrase that pairs a `config.toml` reference with `parse`/`deserialize`/`invalid`.
 * We do NOT trigger on a bare `config.toml` mention alone.
 */
export function isCodexConfigParseError(stderr: string | null | undefined): boolean {
  if (typeof stderr !== 'string' || !stderr.trim()) return false
  const text = stderr.toLowerCase()
  // serde / clap-style config deserialize failures. The `expected \`x\` or
  // \`y\`` branch requires a backtick-quoted token before `or` so it matches
  // the serde variant-enum shape (`expected \`fast\` or \`flex\``) without
  // false-positiving on prose like "passed as expected or skipped".
  const serdeSignature =
    /error loading config|unknown variant|unknown field|invalid type:|missing field|duplicate key|expected `[^`]*` or|expected one of/.test(
      text
    )
  if (serdeSignature) return true
  // A config.toml reference combined with a parse/deserialize verb.
  if (
    /config\.toml/.test(text) &&
    /(pars|deserializ|invalid|could not|cannot|failed to load)/.test(text)
  ) {
    return true
  }
  return false
}

/**
 * Build the user-facing, actionable message for a detected config.toml parse
 * error (see `isCodexConfigParseError`). Exported so the wording stays pinned
 * by a unit test and so the same string is reused by every call site that can
 * hit this failure (app-server start, probe, exec fallback).
 */
export function codexConfigParseUserMessage(stderr: string): string {
  const detail = stderr.trim().split('\n')[0]?.trim() || stderr.trim()
  return (
    `Your ~/.codex/config.toml has a value the codex CLI rejected: ${detail} ` +
    `Edit it (for example, service_tier must be "fast" or "flex") or run ` +
    '`brew upgrade codex` to update the CLI, then retry.'
  )
}

export function buildCodexFastServiceTierCompatibilityArgs(): string[] {
  return ['-c', 'service_tier="fast"']
}

/**
 * Parse a codex `--version` line (e.g. `codex-cli 0.128.0` or
 * `codex-cli 0.136.0-alpha.2`) into comparable numeric parts plus a
 * prerelease tag. Returns null when no semver-looking token is present so the
 * caller can skip the comparison rather than guess. The leading `codex-cli`
 * label is ignored; we grab the first `x.y[.z]` token.
 */
export interface ParsedCodexVersion {
  major: number
  minor: number
  patch: number
  /** e.g. `alpha.2` for `0.136.0-alpha.2`; '' for a stable release. */
  prerelease: string
  raw: string
}

export function parseCodexVersion(version: string | null | undefined): ParsedCodexVersion | null {
  if (typeof version !== 'string') return null
  const match = version.match(/(\d+)\.(\d+)(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?/)
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: match[3] ? Number(match[3]) : 0,
    prerelease: match[4] || '',
    raw: version.trim()
  }
}

function comparePrerelease(a: string, b: string): number {
  // SemVer: a version WITHOUT a prerelease outranks one WITH a prerelease at
  // the same x.y.z (1.0.0 > 1.0.0-alpha). Two prereleases compare dot-segment
  // by dot-segment, numeric segments numerically, otherwise lexically.
  if (a === b) return 0
  if (!a) return 1
  if (!b) return -1
  const as = a.split('.')
  const bs = b.split('.')
  const len = Math.max(as.length, bs.length)
  for (let i = 0; i < len; i++) {
    const av = as[i]
    const bv = bs[i]
    if (av === undefined) return -1
    if (bv === undefined) return 1
    const an = /^\d+$/.test(av) ? Number(av) : null
    const bn = /^\d+$/.test(bv) ? Number(bv) : null
    if (an !== null && bn !== null) {
      if (an !== bn) return an < bn ? -1 : 1
    } else {
      const cmp = av < bv ? -1 : av > bv ? 1 : 0
      if (cmp !== 0) return cmp
    }
  }
  return 0
}

/**
 * Compare two codex version strings. Returns -1 if `a < b`, 1 if `a > b`,
 * 0 if equal/incomparable. Accepts raw `--version` output (the `codex-cli`
 * prefix and prerelease tags are handled). When either side fails to parse we
 * return 0 (treat as "can't tell — don't warn") so an unexpected version
 * format never produces a spurious upgrade nag.
 */
export function compareCodexVersions(
  a: string | null | undefined,
  b: string | null | undefined
): number {
  const pa = parseCodexVersion(a)
  const pb = parseCodexVersion(b)
  if (!pa || !pb) return 0
  if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1
  if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1
  if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1
  return comparePrerelease(pa.prerelease, pb.prerelease)
}

type JsonRpcId = number | string

interface PendingRequest {
  resolve: (value: any) => void
  reject: (error: Error) => void
  timeout: NodeJS.Timeout
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function capabilityValueEnabled(value: unknown): boolean {
  if (value === true) return true
  if (typeof value === 'string') return value.toLowerCase() === 'true'
  if (!isRecord(value)) return false
  return ['enabled', 'available', 'supported', 'write', 'update', 'control', 'native'].some(
    (key) => capabilityValueEnabled(value[key])
  )
}

function capabilityObjectHasGoalControl(value: unknown): boolean {
  if (!isRecord(value)) return false
  return Object.entries(value).some(([key, child]) => {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '')
    if (
      (normalized === 'nativegoalcontrol' ||
        normalized === 'goalcontrol' ||
        normalized === 'goallifecycle' ||
        normalized === 'goalstate') &&
      capabilityValueEnabled(child)
    ) {
      return true
    }
    if ((normalized === 'goal' || normalized === 'goals') && capabilityValueEnabled(child)) {
      return true
    }
    if (
      (normalized === 'capabilities' ||
        normalized === 'experimental' ||
        normalized === 'experimentalcapabilities' ||
        normalized === 'servercapabilities') &&
      capabilityObjectHasGoalControl(child)
    ) {
      return true
    }
    return false
  })
}

export function codexInitializeAdvertisesNativeGoalControl(initializeResult: unknown): boolean {
  return capabilityObjectHasGoalControl(initializeResult)
}

export interface CodexApprovalResponse {
  requestId: string
  action: 'accept' | 'acceptForSession' | 'decline' | 'cancel'
}

/**
 * Phase I2: Codex's app-server is spawned once per TaskWraith session
 * (long-lived JSON-RPC daemon). To give Codex agents the same MCP
 * tool surface that Gemini gets — including the new
 * `delegate_to_subthread` tool — we register an inline MCP server via
 * the CLI's `-c mcp_servers.<name>.*` config-override syntax at spawn
 * time. The bridge subprocess inherits TASKWRAITH_PARENT_PROVIDER
 * from the Codex CLI's env (via either process env inheritance OR
 * the explicit `mcp_servers.TaskWraith.env` config) so it can stamp
 * every broker request with `parentProvider='codex'`. TaskWraith main
 * then routes the approval modal + audit event to Codex specifically
 * — Gemini's workspace grants don't auto-allow Codex delegation.
 *
 * Callers populate this via `setMcpConfig` before `ensureStarted`.
 * Leaving it null (or `enabled=false`) preserves the pre-I2
 * behaviour: Codex spawns without the TaskWraith MCP server, so the
 * Codex agent can't call `delegate_to_subthread` — useful when the
 * user has the TaskWraith MCP bridge toggle disabled.
 */
export interface CodexMcpTaskWraithConfig {
  enabled: boolean
  bridgeBinaryPath: string
  bridgeArgs: string[]
  parentProvider: 'codex'
  userMcpServers?: UserMcpLaunchServer[]
}

export function codexRuntimeProfileKey(profile: RuntimeProfile | null | undefined): string {
  return profile?.id || 'default'
}

/**
 * Format a JS string for safe embedding inside a TOML double-quoted
 * string (i.e. the value half of a `-c key="value"` Codex CLI
 * override). TOML's basic-string rules require escaping `"` and `\`,
 * plus control characters. The values we feed in here are filesystem
 * paths + hex tokens + CLI flag literals, so we don't expect control
 * chars in practice — but escaping defensively keeps the surface
 * resilient if Electron ever returns a path containing a backslash
 * (notably on Windows builds).
 */
function tomlEscapeString(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
}

function isTomlBareKeyComponent(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value)
}

function formatTomlInlineStringTable(entries: Record<string, string>): string {
  return Object.entries(entries)
    .map(([key, value]) => `"${tomlEscapeString(key)}" = "${tomlEscapeString(value)}"`)
    .join(', ')
}

/**
 * Build the `-c mcp_servers.TaskWraith.*` CLI argument list for Codex
 * CLI. Exported so the I2 tests can pin the exact shape of the
 * inline MCP config (TOML escaping + arg order matter). The
 * mixed-case `TaskWraith` server key matches the registration name
 * the agent sees in its tool list (`TaskWraith__delegate_to_subthread`);
 * TOML keys are case-sensitive so the casing here must match the
 * `GEMINI_MCP_SERVER_NAME` constant in `index.ts`. The env var stays
 * `TASKWRAITH_PARENT_PROVIDER` to avoid changing the IPC contract
 * between the spawned bridge subprocess and main.
 */
export function buildCodexTaskWraithMcpArgs(config: CodexMcpTaskWraithConfig): string[] {
  const configArgs: string[] = []
  if (config.enabled) {
    const command = tomlEscapeString(config.bridgeBinaryPath)
    const args = config.bridgeArgs.map((arg) => `"${tomlEscapeString(arg)}"`).join(', ')
    const parentProvider = tomlEscapeString(config.parentProvider)
    configArgs.push(
      '-c',
      `mcp_servers.TaskWraith.command="${command}"`,
      '-c',
      `mcp_servers.TaskWraith.args=[${args}]`,
      '-c',
      `mcp_servers.TaskWraith.env={ TASKWRAITH_PARENT_PROVIDER = "${parentProvider}" }`
    )
  }
  for (const server of config.userMcpServers ?? []) {
    if (!isTomlBareKeyComponent(server.serverName)) continue
    if (server.transport === 'http') {
      configArgs.push('-c', `mcp_servers.${server.serverName}.url="${tomlEscapeString(server.url)}"`)
      if (server.bearerTokenEnvVar) {
        configArgs.push(
          '-c',
          `mcp_servers.${server.serverName}.bearer_token_env_var="${tomlEscapeString(
            server.bearerTokenEnvVar
          )}"`
        )
      }
      if (server.headers && Object.keys(server.headers).length > 0) {
        configArgs.push(
          '-c',
          `mcp_servers.${server.serverName}.http_headers={ ${formatTomlInlineStringTable(
            server.headers
          )} }`
        )
      }
      continue
    }
    if (server.transport !== 'stdio') continue
    const command = tomlEscapeString(server.command)
    const args = server.args.map((arg) => `"${tomlEscapeString(arg)}"`).join(', ')
    configArgs.push(
      '-c',
      `mcp_servers.${server.serverName}.command="${command}"`,
      '-c',
      `mcp_servers.${server.serverName}.args=[${args}]`
    )
    if (server.env && Object.keys(server.env).length > 0) {
      const env = Object.entries(server.env)
        .map(([key, value]) => `${key} = "${tomlEscapeString(value)}"`)
        .join(', ')
      configArgs.push('-c', `mcp_servers.${server.serverName}.env={ ${env} }`)
    }
  }
  return configArgs
}

export class CodexAppServerClient {
  private proc: ChildProcessWithoutNullStreams | null = null
  private stdoutReader: ReadlineInterface | null = null
  private nextId = 1
  private pending = new Map<JsonRpcId, PendingRequest>()
  private startPromise: Promise<void> | null = null
  private notificationHandler: ((message: any) => void) | null = null
  private requestHandler: ((message: any) => void) | null = null
  private stderrHandler: ((chunk: string) => void) | null = null
  private mcpConfig: CodexMcpTaskWraithConfig | null = null
  private runtimeProfile: RuntimeProfile | null = null
  private runtimeProfileKey = codexRuntimeProfileKey(null)
  private initializeResult: unknown = null
  // Ring buffer of the most recent stderr the codex CLI emitted. When the
  // app-server refuses to start because of a bad ~/.codex/config.toml, the
  // CLI writes the parse error here and exits — and `ensureStarted` otherwise
  // rejects with a generic "exited" message. We retain stderr so the start
  // failure can be enriched with (and classified against) the real cause.
  private recentStderr = ''

  /**
   * The most recent stderr captured from the codex CLI (bounded). Callers use
   * this to classify start failures (e.g. `isCodexConfigParseError`) so a
   * config.toml parse error surfaces an actionable message instead of the
   * generic exec-fallback notice.
   */
  getRecentStderr(): string {
    return this.recentStderr
  }

  supportsNativeGoalControl(): boolean {
    return codexInitializeAdvertisesNativeGoalControl(this.initializeResult)
  }

  setNotificationHandler(handler: ((message: any) => void) | null) {
    this.notificationHandler = handler
  }

  setRequestHandler(handler: ((message: any) => void) | null) {
    this.requestHandler = handler
  }

  setStderrHandler(handler: ((chunk: string) => void) | null) {
    this.stderrHandler = handler
  }

  /**
   * Phase I2: configure the TaskWraith MCP server that Codex CLI
   * registers at spawn. Must be called BEFORE `ensureStarted` —
   * once Codex's app-server is running we don't restart it just to
   * pick up new MCP config (Codex would lose its in-flight threads).
   * Pass `null` to clear; the next start spawns without any MCP
   * config overrides. Safe to call multiple times before start.
   */
  setMcpConfig(config: CodexMcpTaskWraithConfig | null): void {
    this.mcpConfig = config
  }

  setRuntimeProfile(profile: RuntimeProfile | null): void {
    const nextKey = codexRuntimeProfileKey(profile)
    if (nextKey === this.runtimeProfileKey) return
    this.dispose()
    this.runtimeProfile = profile
    this.runtimeProfileKey = nextKey
  }

  getRuntimeProfileKey(): string {
    return this.runtimeProfileKey
  }

  async ensureStarted(appVersion: string): Promise<void> {
    if (this.proc && !this.proc.killed) {
      return
    }
    if (this.startPromise) {
      return this.startPromise
    }

    this.startPromise = this.start(appVersion).finally(() => {
      this.startPromise = null
    })
    return this.startPromise
  }

  async request<T = any>(method: string, params: any = {}, timeoutMs = 30_000): Promise<T> {
    if (!this.proc || this.proc.killed || !this.proc.stdin.writable) {
      throw new Error('Codex app-server is not running.')
    }

    const id = this.nextId++
    const payload = { id, method, params }
    const result = new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Codex app-server request timed out: ${method}`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timeout })
    })
    this.write(payload)
    return result
  }

  notify(method: string, params: any = {}) {
    if (!this.proc || this.proc.killed || !this.proc.stdin.writable) {
      throw new Error('Codex app-server is not running.')
    }
    this.write({ method, params })
  }

  respond(id: JsonRpcId, result: any) {
    if (!this.proc || this.proc.killed || !this.proc.stdin.writable) {
      throw new Error('Codex app-server is not running.')
    }
    this.write({ id, result })
  }

  reject(id: JsonRpcId, message: string) {
    if (!this.proc || this.proc.killed || !this.proc.stdin.writable) {
      throw new Error('Codex app-server is not running.')
    }
    this.write({ id, error: { code: -32000, message } })
  }

  dispose() {
    this.startPromise = null
    this.initializeResult = null
    this.stdoutReader?.close()
    this.stdoutReader = null
    if (this.proc && !this.proc.killed) {
      this.proc.kill()
    }
    this.proc = null
    this.rejectPending(new Error('Codex app-server stopped.'))
  }

  private async start(
    appVersion: string,
    options: { forceFastServiceTier?: boolean } = {}
  ): Promise<void> {
    // Phase I2: prepend `-c mcp_servers.TaskWraith.*` config flags so
    // the Codex CLI registers the TaskWraith MCP bridge as an MCP server
    // for the whole app-server lifetime. The bridge subprocess
    // inherits TASKWRAITH_PARENT_PROVIDER='codex' from the env map AND
    // from the inline `mcp_servers.TaskWraith.env` override (belt &
    // braces — Codex CLI strips inherited env from MCP subprocesses
    // on some platforms, so we set it both ways).
    const mcpArgs = buildCodexTaskWraithMcpArgs(
      this.mcpConfig ?? {
        enabled: false,
        bridgeBinaryPath: '',
        bridgeArgs: [],
        parentProvider: 'codex'
      }
    )
    const codexArgs = [
      ...(options.forceFastServiceTier ? buildCodexFastServiceTierCompatibilityArgs() : []),
      ...mcpArgs,
      'app-server'
    ]
    const codexEnv: Record<string, string> = {
      ...(this.runtimeProfile?.env || {}),
      ...collectUserMcpProviderEnv(this.mcpConfig?.userMcpServers),
      FORCE_COLOR: '0',
      NO_COLOR: '1'
    }
    if (this.mcpConfig?.enabled) {
      codexEnv.TASKWRAITH_PARENT_PROVIDER = this.mcpConfig.parentProvider
    }
    if (this.runtimeProfile?.id) {
      codexEnv.TASKWRAITH_RUNTIME_PROFILE_ID = this.runtimeProfile.id
    }
    // Reset the stderr ring buffer for this start attempt so a stale error
    // from a prior failed start can't be misattributed to this one.
    this.recentStderr = ''
    this.initializeResult = null
    const resolvedCodex = await resolveCliProviderBinary('codex', this.runtimeProfile)
    if (!resolvedCodex.binaryPath) {
      throw new Error(resolvedCodex.error || 'Codex CLI was not found.')
    }
    const spawnPlan = createCliSpawnPlan(resolvedCodex.binaryPath, codexArgs)
    const proc = spawn(spawnPlan.command, spawnPlan.args, {
      shell: spawnPlan.shell,
      stdio: 'pipe',
      env: createCliEnv(codexEnv, resolvedCodex.binaryPath)
    })
    this.proc = proc

    const stdoutReader = createInterface({ input: proc.stdout })
    this.stdoutReader = stdoutReader
    stdoutReader.on('line', (line) => this.handleLine(line))

    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8')
      // Keep the tail bounded; a config parse error is short and appears first,
      // but the agent can later emit lots of stderr we don't want to retain.
      this.recentStderr = (this.recentStderr + text).slice(-8_000)
      this.stderrHandler?.(text)
    })

    proc.on('close', (code) => {
      this.stderrHandler?.(
        `Codex app-server exited with code ${typeof code === 'number' ? code : 'unknown'}.`
      )
      const isCurrentProcess = this.proc === proc
      if (isCurrentProcess) this.proc = null
      if (this.stdoutReader === stdoutReader) {
        this.stdoutReader.close()
        this.stdoutReader = null
      }
      if (isCurrentProcess) this.rejectPending(new Error('Codex app-server exited.'))
    })

    proc.on('error', (error) => {
      const isCurrentProcess = this.proc === proc
      if (isCurrentProcess) this.proc = null
      if (isCurrentProcess) this.rejectPending(error)
    })

    try {
      this.initializeResult = await this.request(
        'initialize',
        {
          clientInfo: {
            name: 'taskwraith',
            title: 'TaskWraith',
            version: appVersion
          },
          capabilities: {
            experimentalApi: true
          }
        },
        15_000
      )
    } catch (error) {
      // Enrich the generic start failure with whatever the CLI wrote to stderr
      // (e.g. a config.toml parse error) so the caller can classify it and show
      // an actionable message rather than the cryptic exec-fallback notice.
      const stderr = this.recentStderr.trim()
      if (stderr) {
        if (!options.forceFastServiceTier && isCodexConfigParseError(stderr)) {
          this.stderrHandler?.(
            'Codex rejected config.toml; retrying app-server with service_tier="fast" compatibility override.\n'
          )
          this.dispose()
          await this.start(appVersion, { forceFastServiceTier: true })
          return
        }
        const base = error instanceof Error ? error.message : String(error)
        const enriched = new Error(`${base} ${stderr}`) as Error & { codexStderr?: string }
        enriched.codexStderr = stderr
        throw enriched
      }
      throw error
    }
    this.notify('initialized')
  }

  private handleLine(line: string) {
    if (!line.trim()) return

    let parsed: any
    try {
      parsed = JSON.parse(line)
    } catch {
      this.stderrHandler?.(`Malformed Codex app-server JSON: ${line}`)
      return
    }

    const id = parsed?.id
    if (
      id !== undefined &&
      (Object.prototype.hasOwnProperty.call(parsed, 'result') ||
        Object.prototype.hasOwnProperty.call(parsed, 'error'))
    ) {
      const pending = this.pending.get(id)
      if (!pending) return
      clearTimeout(pending.timeout)
      this.pending.delete(id)
      if (parsed.error) {
        pending.reject(new Error(parsed.error.message || JSON.stringify(parsed.error)))
      } else {
        pending.resolve(parsed.result)
      }
      return
    }

    if (id !== undefined && parsed?.method) {
      this.requestHandler?.(parsed)
      return
    }

    if (parsed?.method) {
      this.notificationHandler?.(parsed)
    }
  }

  private write(payload: any) {
    this.proc?.stdin.write(`${JSON.stringify(payload)}\n`)
  }

  private rejectPending(error: Error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout)
      pending.reject(error)
    }
    this.pending.clear()
  }
}
