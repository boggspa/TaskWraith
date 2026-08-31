import type { Dirent, Stats } from 'fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'path'
import { KIMI_ACP_PRODUCTION_POSTURE_VERSION } from '../../shared/kimiAcpPosture'
import { KIMI_ACP_DENY_TOOLS } from './KimiAcpContainment'

export { KIMI_ACP_PRODUCTION_POSTURE_VERSION }

export interface KimiPrivateCwdFs {
  readFile: (path: string) => Promise<string>
  mkdir: (path: string) => Promise<void>
  mkdtemp: (prefix: string) => Promise<string>
  chmod: (path: string, mode: number) => Promise<void>
  lstat: (path: string) => Promise<Pick<Stats, 'isDirectory' | 'isSymbolicLink' | 'mode'>>
  realpath: (path: string) => Promise<string>
  readdir: (path: string) => Promise<Array<string | Dirent>>
  rm: (path: string) => Promise<void>
}

export interface KimiPrivateRunCwd {
  /** Empty TaskWraith-owned cwd supplied to both the process and ACP session. */
  cwd: string
  /** Re-check the private directory immediately before the provider spawn. */
  assertReadyForSpawn: () => Promise<void>
  /** Idempotently remove run-scoped storage or retain session continuity. */
  cleanup: () => Promise<void>
}

export type KimiPrivateCwdLifetime = 'run' | 'session'

/** Join every terminal callback to one cleanup operation. ACP may emit both a
 * child `error` and `close`; neither callback may release the seat early. */
export function createJoinedKimiCleanup(
  ...cleanups: Array<() => Promise<unknown>>
): () => Promise<void> {
  let cleanupPromise: Promise<void> | null = null
  return () => {
    cleanupPromise ??= Promise.allSettled(cleanups.map((cleanup) => cleanup())).then((results) => {
      const failure = results.find(
        (result): result is PromiseRejectedResult => result.status === 'rejected'
      )
      if (failure) {
        cleanupPromise = null
        throw failure.reason
      }
    })
    return cleanupPromise
  }
}

const SAFE_ACP_DEBUG_METHODS = new Set([
  'initialize',
  'session/new',
  'session/resume',
  'session/prompt',
  'session/cancel',
  'session/set_config_option'
])

/**
 * Return fixed, allowlisted protocol metadata for opt-in production debugging.
 * Never serialize params/results: session/new contains the gateway bearer and
 * cwd, while prompt/tool frames can contain workspace paths and user content.
 */
export function formatKimiProductionAcpDebugFrame(
  direction: 'in' | 'out',
  message: unknown
): string {
  const record =
    message && typeof message === 'object' && !Array.isArray(message)
      ? (message as Record<string, unknown>)
      : null
  const method = typeof record?.method === 'string' ? record.method : ''
  const rpcIdPresent = typeof record?.id === 'number' || typeof record?.id === 'string'
  const error =
    record?.error && typeof record.error === 'object' && !Array.isArray(record.error)
      ? (record.error as Record<string, unknown>)
      : null
  const metadata = {
    direction,
    kind: method ? (rpcIdPresent ? 'request' : 'notification') : error ? 'error' : 'response',
    ...(SAFE_ACP_DEBUG_METHODS.has(method) ? { method } : method ? { method: 'other' } : {}),
    ...(rpcIdPresent ? { rpcIdPresent: true } : {}),
    ...(typeof error?.code === 'number' ? { errorCode: error.code } : {})
  }
  return `[kimi-acp] ${JSON.stringify(metadata)}\n`
}

const KIMI_PROCESS_ENV_ALLOWLIST = [
  'PATH',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'COLORTERM',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
  'NO_COLOR',
  'FORCE_COLOR',
  'RUNNER_TRACKING_ID',
  'KIMI_CODE_HOME',
  'TASKWRAITH_PARENT_PROVIDER',
  'TASKWRAITH_RUN_ID',
  'TASKWRAITH_CHAT_ID'
] as const

/** TaskWraith's longest bounded MCP call is a 600-second ensemble await. Kimi
 * Code reads this supported process-level override; the ACP mcpServers schema
 * intentionally drops unknown per-server timeout fields. */
export const KIMI_TASKWRAITH_MCP_TOOL_TIMEOUT_MS = 630_000

/**
 * Build a Kimi-specific allowlisted spawn environment. In particular, do not
 * forward runtime-profile/process loader hooks (DYLD_*, LD_PRELOAD,
 * NODE_OPTIONS, PYTHONPATH, BASH_ENV, and peers) across the qualification
 * boundary.
 */
export function buildKimiContainedProcessEnv(
  environment: Record<string, string>,
  privateCwd: string
): Record<string, string> {
  const contained: Record<string, string> = {}
  for (const key of KIMI_PROCESS_ENV_ALLOWLIST) {
    if (typeof environment[key] === 'string') contained[key] = environment[key]
  }
  const noProxy = [environment.NO_PROXY, environment.no_proxy, '127.0.0.1', 'localhost', '::1']
    .flatMap((value) => String(value || '').split(','))
    .map((value) => value.trim())
    .filter(Boolean)
  const loopbackNoProxy = [...new Set(noProxy)].join(',')
  const privateHome = environment.KIMI_CODE_HOME || environment.HOME || privateCwd
  return {
    ...contained,
    KIMI_MCP_TOOL_TIMEOUT_MS: String(KIMI_TASKWRAITH_MCP_TOOL_TIMEOUT_MS),
    NO_PROXY: loopbackNoProxy,
    no_proxy: loopbackNoProxy,
    HOME: privateHome,
    USERPROFILE: privateHome,
    PWD: privateCwd,
    TMPDIR: privateCwd,
    TMP: privateCwd,
    TEMP: privateCwd,
    XDG_CONFIG_HOME: join(privateHome, 'xdg-config'),
    XDG_DATA_HOME: join(privateHome, 'xdg-data'),
    XDG_CACHE_HOME: join(privateHome, 'xdg-cache'),
    XDG_RUNTIME_DIR: join(privateHome, 'xdg-runtime'),
    APPDATA: join(privateHome, 'appdata'),
    LOCALAPPDATA: join(privateHome, 'local-appdata')
  }
}

/** Cleanup is retried once, and terminal bookkeeping runs even if cleanup or
 * transcript/usage projection throws. */
export async function finalizeKimiRunAfterCleanup(input: {
  cleanup: () => Promise<void>
  projectTerminal: (cleanupError?: unknown) => void | Promise<void>
  finish: () => void
}): Promise<void> {
  let cleanupError: unknown
  let projectionError: unknown
  try {
    try {
      await input.cleanup()
    } catch {
      try {
        await input.cleanup()
      } catch (error) {
        cleanupError = error
      }
    }
    try {
      await input.projectTerminal(cleanupError)
    } catch (error) {
      projectionError = error
    }
  } finally {
    input.finish()
  }
  if (projectionError) throw projectionError
  if (cleanupError) throw cleanupError
}

function isWithin(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child))
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/**
 * Allocate a mode-0700, empty cwd under the isolated Kimi home. Ephemeral runs
 * get an unguessable directory; resumable seats keep one stable workspace
 * identity for the native session lifetime.
 * The real workspace is intentionally not an input: it can only be reached by
 * the governed TaskWraith HTTP MCP gateway.
 */
export async function prepareKimiPrivateRunCwd(input: {
  isolatedHome: string
  fs: KimiPrivateCwdFs
  /** A resumable native session owns its cwd until the seat is deleted. */
  lifetime?: KimiPrivateCwdLifetime
  /** Existing native session whose original synthetic cwd may need repair. */
  resumeSessionId?: string | null
}): Promise<KimiPrivateRunCwd> {
  const runtimeRoot = join(input.isolatedHome, 'runtime-cwd')
  const [homeReal, homeStat] = await Promise.all([
    input.fs.realpath(input.isolatedHome),
    input.fs.lstat(input.isolatedHome)
  ])
  // Windows does not expose POSIX owner/group/other mode authority; require
  // directory identity only there (same posture as McpBridge / media stores).
  if (
    !homeStat.isDirectory() ||
    homeStat.isSymbolicLink() ||
    (process.platform !== 'win32' && (homeStat.mode & 0o077) !== 0)
  ) {
    throw new Error('Kimi isolated home failed its private-directory boundary check.')
  }
  try {
    const existingRoot = await input.fs.lstat(runtimeRoot)
    if (!existingRoot.isDirectory() || existingRoot.isSymbolicLink()) {
      throw new Error('Kimi private runtime root is not a real directory.')
    }
  } catch (error) {
    if ((error as { code?: unknown }).code !== 'ENOENT') throw error
    await input.fs.mkdir(runtimeRoot)
  }
  await input.fs.chmod(runtimeRoot, 0o700)
  const [rootReal, rootStat] = await Promise.all([
    input.fs.realpath(runtimeRoot),
    input.fs.lstat(runtimeRoot)
  ])
  if (
    !rootStat.isDirectory() ||
    rootStat.isSymbolicLink() ||
    (process.platform !== 'win32' && (rootStat.mode & 0o077) !== 0) ||
    !isWithin(homeReal, rootReal)
  ) {
    throw new Error('Kimi private runtime root escaped the isolated home.')
  }
  const lifetime = input.lifetime ?? 'run'
  const requestedResumeSessionId = String(input.resumeSessionId || '').trim()
  let persistedResumeCwd: string | null = null
  if (lifetime === 'session' && requestedResumeSessionId) {
    try {
      const index = await input.fs.readFile(join(input.isolatedHome, 'session_index.jsonl'))
      const records = index.split(/\r?\n/).filter(Boolean).reverse()
      for (const line of records) {
        let record: Record<string, unknown>
        try {
          record = JSON.parse(line) as Record<string, unknown>
        } catch {
          continue
        }
        if (record.sessionId !== requestedResumeSessionId) continue
        if (typeof record.workDir !== 'string' || !record.workDir.trim()) break
        const candidate = resolve(record.workDir)
        const candidateName = basename(candidate)
        const directChild = dirname(candidate) === resolve(runtimeRoot)
        const ownedName = candidateName === 'session' || /^run-[A-Za-z0-9]+$/.test(candidateName)
        if (!directChild || !ownedName) {
          throw new Error('Kimi persisted session cwd escaped its private runtime root.')
        }
        persistedResumeCwd = candidate
        break
      }
    } catch (error) {
      if ((error as { code?: unknown }).code !== 'ENOENT') throw error
    }
  }

  // New durable sessions share one stable empty workspace identity per seat.
  // Existing v1 sessions keep the exact run-* identity Kimi persisted; recreate
  // it inside the verified root when old per-run cleanup removed it.
  const cwd =
    lifetime === 'session'
      ? persistedResumeCwd || join(runtimeRoot, 'session')
      : await input.fs.mkdtemp(join(runtimeRoot, 'run-'))
  if (lifetime === 'session') {
    try {
      const existing = await input.fs.lstat(cwd)
      if (!existing.isDirectory() || existing.isSymbolicLink()) {
        throw new Error('Kimi private session cwd is not a real directory.')
      }
    } catch (error) {
      if ((error as { code?: unknown }).code !== 'ENOENT') throw error
      await input.fs.mkdir(cwd)
    }
  }
  await input.fs.chmod(cwd, 0o700)

  let cleaned = false
  const assertReadyForSpawn = async (): Promise<void> => {
    const [currentRootReal, currentRootStat, cwdReal, stat] = await Promise.all([
      input.fs.realpath(runtimeRoot),
      input.fs.lstat(runtimeRoot),
      input.fs.realpath(cwd),
      input.fs.lstat(cwd)
    ])
    if (
      !currentRootStat.isDirectory() ||
      currentRootStat.isSymbolicLink() ||
      currentRootReal !== rootReal ||
      !isWithin(homeReal, currentRootReal) ||
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      !isWithin(currentRootReal, cwdReal)
    ) {
      throw new Error('Kimi private runtime cwd failed its ownership boundary check.')
    }
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
      throw new Error('Kimi private runtime cwd is not mode 0700.')
    }
    const entries = await input.fs.readdir(cwd)
    if (entries.length > 0) {
      throw new Error('Kimi private runtime cwd was modified before provider startup.')
    }
  }

  const cleanup = async (): Promise<void> => {
    if (cleaned) return
    if (lifetime === 'session') return
    await input.fs.rm(cwd)
    cleaned = true
  }

  try {
    await assertReadyForSpawn()
    return { cwd, assertReadyForSpawn, cleanup }
  } catch (error) {
    // A failed boundary/emptiness check must not turn malformed continuity
    // state into a durable path, even when ordinary cleanup retains the cwd.
    await input.fs.rm(cwd).catch(() => undefined)
    throw error
  }
}

export interface KimiProductionSessionPlan {
  prompt: string
  resumeSessionId: string | null
  legacyResumeRejected: boolean
}

/**
 * Only an exact posture-version match may resume. Boolean-only records were
 * born under the legacy real-workspace cwd and are intentionally cold-started
 * with the signed full-context recovery prompt in the new seat-home namespace.
 */
export function buildKimiProductionSessionPlan(input: {
  prompt: string
  resumeFallbackPrompt?: string
  requestedResumeSessionId?: string | null
  persistedPostureVersion?: unknown
}): KimiProductionSessionPlan {
  const requested = String(input.requestedResumeSessionId || '').trim()
  const resumeAuthorized =
    requested.startsWith('session_') &&
    input.persistedPostureVersion === KIMI_ACP_PRODUCTION_POSTURE_VERSION
  if (resumeAuthorized) {
    return { prompt: input.prompt, resumeSessionId: requested, legacyResumeRejected: false }
  }
  // ANY sessionless session/new takes the full-context recovery prompt when
  // one was composed — not just the legacy-posture rejection. The provider
  // seat check can null the requested session AFTER composition (a real
  // rotation, e.g. a model switch); gating on `requested` sent the slim
  // resume prompt into a fresh session — context-blind (caught live 07-28:
  // k2.7→k3 switch answered "I don't have a codeword"). A genuinely fresh
  // chat composes no fallback, so this stays the plain prompt there.
  return {
    prompt: input.resumeFallbackPrompt || input.prompt,
    resumeSessionId: null,
    legacyResumeRejected: Boolean(requested)
  }
}

/** Exact production initialize payload. Absence of `clientCapabilities.fs` is
 * load-bearing: all workspace I/O belongs to the HTTP MCP gateway. */
export function buildKimiProductionInitializeParams(appVersion: string): Record<string, unknown> {
  return {
    protocolVersion: 1,
    clientCapabilities: {},
    clientInfo: { name: 'taskwraith', version: appVersion }
  }
}

export interface KimiProductionAcpSnapshot {
  cwd: string
  initializeParams: Record<string, unknown>
  mcpServers: [Record<string, unknown>]
  deniedNativeTools: readonly string[]
  session: KimiProductionSessionPlan
}

export interface KimiProductionGatewayHandle {
  server: Record<string, unknown>
  close: () => Promise<unknown>
}

/** Kimi Code's default MCP request timeout is about 60 seconds. UltraTask's
 * bounded join may legitimately wait up to 10 minutes, so the one main-owned
 * gateway receives a slightly larger per-server budget than TaskWraith's
 * 600-second tool clamp. */
export interface KimiProductionLaunchResult<T> {
  snapshot: KimiProductionAcpSnapshot
  handle: T
  cleanup: () => Promise<void>
}

export const KIMI_SPAWN_AUTHORITY_REVOKED_MESSAGE =
  'Kimi run authority was revoked before provider spawn; no provider process was started.'

/**
 * Last synchronous authority assertion before the admitted launch callback.
 * History deletion may invalidate a registered run while gateway/cwd/runtime
 * checks are awaiting. Treat an exception from the authority source as a
 * denial so setup cleanup runs without spawning the provider.
 */
export function assertKimiSpawnAuthority(isAuthorized: () => boolean): void {
  let authorized = false
  try {
    authorized = isAuthorized()
  } catch {
    authorized = false
  }
  if (!authorized) throw new Error(KIMI_SPAWN_AUTHORITY_REVOKED_MESSAGE)
}

/**
 * Executable production admission seam. The provider launch callback is reached
 * only after an authenticated loopback gateway exists and the private cwd has
 * passed its final check. The callback runs synchronously after that check, so
 * no filesystem mutation window is introduced before spawn.
 */
export async function launchKimiProductionAcp<T>(input: {
  taskWraithMcpAdvertised: boolean
  privateCwd: KimiPrivateRunCwd
  assertRuntimeReadyForSpawn: () => Promise<string>
  startGateway: () => Promise<KimiProductionGatewayHandle>
  snapshot: Omit<
    Parameters<typeof buildKimiProductionAcpSnapshot>[0],
    'privateCwd' | 'gatewayServer'
  >
  launch: (
    snapshot: KimiProductionAcpSnapshot,
    cleanup: () => Promise<void>,
    admittedBinaryPath: string
  ) => T
}): Promise<KimiProductionLaunchResult<T>> {
  if (!input.taskWraithMcpAdvertised) {
    await input.privateCwd.cleanup()
    throw new Error('Kimi production ACP requires the governed TaskWraith HTTP MCP gateway.')
  }

  let gateway: KimiProductionGatewayHandle | null = null
  let cleanup: (() => Promise<void>) | null = null
  try {
    gateway = await input.startGateway()
    const snapshot = buildKimiProductionAcpSnapshot({
      ...input.snapshot,
      privateCwd: input.privateCwd.cwd,
      gatewayServer: gateway.server
    })
    cleanup = createJoinedKimiCleanup(
      () => input.privateCwd.cleanup(),
      () => gateway!.close()
    )
    await input.privateCwd.assertReadyForSpawn()
    const admittedBinaryPath = await input.assertRuntimeReadyForSpawn()
    const handle = input.launch(snapshot, cleanup, admittedBinaryPath)
    return { snapshot, handle, cleanup }
  } catch (error) {
    if (cleanup) await cleanup().catch(() => undefined)
    else {
      await Promise.allSettled([input.privateCwd.cleanup(), ...(gateway ? [gateway.close()] : [])])
    }
    throw error
  }
}

/**
 * Single production composition seam used by the desktop runtime and live
 * qualification. It cannot represent a gateway-less or fs-capable seat.
 */
export function buildKimiProductionAcpSnapshot(input: {
  privateCwd: string
  gatewayServer: Record<string, unknown> | null | undefined
  appVersion: string
  prompt: string
  resumeFallbackPrompt?: string
  requestedResumeSessionId?: string | null
  persistedPostureVersion?: unknown
}): KimiProductionAcpSnapshot {
  if (!input.privateCwd || !input.gatewayServer) {
    throw new Error('Kimi production ACP requires a private cwd and TaskWraith HTTP gateway.')
  }
  const gateway = input.gatewayServer
  const headers = Array.isArray(gateway.headers) ? gateway.headers : []
  const hasAuthHeader = headers.some(
    (header) =>
      header &&
      typeof header === 'object' &&
      !Array.isArray(header) &&
      typeof (header as { name?: unknown }).name === 'string' &&
      Boolean((header as { name: string }).name.trim()) &&
      typeof (header as { value?: unknown }).value === 'string' &&
      Boolean((header as { value: string }).value.trim())
  )
  let loopbackHttp = false
  try {
    const url = new URL(String(gateway.url || ''))
    loopbackHttp =
      url.protocol === 'http:' &&
      (url.hostname === '127.0.0.1' || url.hostname === '::1' || url.hostname === 'localhost')
  } catch {
    loopbackHttp = false
  }
  if (gateway.name !== 'taskwraith' || gateway.type !== 'http' || !loopbackHttp || !hasAuthHeader) {
    throw new Error('Kimi production ACP gateway is not an authenticated loopback HTTP server.')
  }
  return {
    cwd: input.privateCwd,
    initializeParams: buildKimiProductionInitializeParams(input.appVersion),
    mcpServers: [gateway],
    deniedNativeTools: KIMI_ACP_DENY_TOOLS,
    session: buildKimiProductionSessionPlan(input)
  }
}
