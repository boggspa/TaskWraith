import { randomBytes, randomUUID } from 'node:crypto'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { spawn as spawnChild } from 'node:child_process'
import { access } from 'node:fs/promises'
import { dirname, posix, resolve, win32, type PlatformPath } from 'node:path'
import type { Writable } from 'node:stream'

import {
  HOST_TERMINATION_SUCCESS_KINDS,
  terminateHostProcess,
  type HostTerminationExpectedHost,
  type HostTerminationOutcome,
  type HostTerminationOutcomeKind
} from '../host-client/HostProcessTermination'
import {
  HostProjectionClient,
  HostProjectionIncompatibleProtocolError,
  type HostProjectionDiscoveryProcessIdentity
} from '../host-client/HostProjectionClient'
import {
  stopAllHosts,
  type HostStopAllHost,
  type HostStopAllOptions,
  type HostStopAllReport,
  type HostStopAllScope
} from '../host-client/HostStopAll'
import {
  HOST_FULL_ACCESS_BOOTSTRAP_FD,
  HOST_FULL_ACCESS_BOOTSTRAP_FD_ENV,
  hostFullAccessBootstrapFrame
} from '../host-runtime/HostFullAccessBootstrap'
import { resolveHostPayloadVersion } from '../host-runtime/HostPayloadIdentity'
import { withoutHostLeaseTestKnobs } from '../host-runtime/HostLeaseRegistry'
import { resolveHostRegistryRoot } from '../host-runtime/HostRegistry'
import type { HostBootstrapWelcome, HostCapability } from '../shared/hostProtocol'
import {
  createTuiFullAccessPresence,
  type TuiFullAccessPresence,
  type TuiFullAccessHostProcessBinding
} from './fullAccessConsent'
import { closeHostStderrLogFd, openHostStderrLogFd } from './hostStderrLog'

const DEFAULT_START_TIMEOUT_MS = 120_000
const DEFAULT_POLL_MS = 250
const DEFAULT_PROBE_TIMEOUT_MS = 1_500
const DEFAULT_BOOTSTRAP_WRITE_TIMEOUT_MS = 2_000
/** Provider shutdown may wait on a live turn; give a stale Host time to leave. */
const DEFAULT_STOP_TIMEOUT_MS = 45_000
export const TUI_STANDALONE_HOST_CAPABILITY_FLOOR: readonly HostCapability[] = [
  'commands',
  'receipts',
  'setup',
  'provider-catalog',
  'provider-auth',
  'history',
  'health'
]
export const TUI_STANDALONE_HOST_PRODUCTION_VERSION = 'node-host-v1'

export type TuiHostLaunchProfile =
  | 'production'
  | 'development'
  | 'package-smoke'
  | 'node-package'
  | 'custom'

export interface TuiHostLaunchCommand {
  readonly executable: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
}

interface TuiHostLaunchCandidate extends TuiHostLaunchCommand {
  readonly requiredPaths: readonly string[]
}

export interface ResolveTuiHostLaunchCommandInput {
  readonly profile: TuiHostLaunchProfile
  readonly moduleDir?: string
  readonly workingDirectory?: string
  readonly platform?: NodeJS.Platform
  readonly architecture?: NodeJS.Architecture
  readonly env?: NodeJS.ProcessEnv
  /** Development seam; must be an ordinary Node executable, never Electron. */
  readonly nodeExecutable?: string
  readonly isOrdinaryNode?: (path: string) => boolean
  readonly userDataPath?: string
  readonly pathExists?: (path: string) => Promise<boolean>
}

type TuiHostSpawn = (
  executable: string,
  args: readonly string[],
  options: SpawnOptions
) => ChildProcess

export interface EnsureTuiHostAvailableInput extends ResolveTuiHostLaunchCommandInput {
  readonly userDataPath: string
  /** A completed restart may attach to a concurrent winner, but never stop it. */
  readonly replaceStaleHost?: boolean
  /** Only an interactive TUI may retain a launch-bound Full Access signer. */
  readonly enableFullAccessPresence?: boolean
  readonly timeoutMs?: number
  readonly pollMs?: number
  readonly probeTimeoutMs?: number
  readonly bootstrapWriteTimeoutMs?: number
  readonly probe?: (
    userDataPath: string,
    connectTimeoutMs: number
  ) => Promise<TuiHostAuthenticatedProbe | void>
  readonly resolveLaunchCommand?: () => Promise<TuiHostLaunchCommand | null>
  readonly spawn?: TuiHostSpawn
  readonly createFullAccessSecret?: () => Buffer
  /**
   * Opens the append-mode fd the spawned Host writes stderr to, or returns
   * `null` to fall back to `'ignore'`. Injectable so tests can prove the fd
   * reaches `stdio[2]` without touching a real profile directory.
   */
  readonly openHostStderrLog?: (userDataPath: string) => number | null
  readonly now?: () => number
  readonly delay?: (milliseconds: number) => Promise<void>
  /**
   * Payload identity of the Host this launch command would start. A running
   * standalone Host that reports a different identity is replaced: a rebuilt
   * Host that is never restarted keeps serving the old code.
   */
  readonly resolvePayloadVersion?: (
    command: TuiHostLaunchCommand
  ) => string | null | Promise<string | null>
  /**
   * Stops a stale standalone Host. The default is verified termination
   * (HostProcessTermination): the Host's own authenticated stop first, and a
   * signal only after the pid's birth identity and command line are verified
   * again, so a pid that has since been reused is never signalled.
   */
  readonly terminateHost?: TuiHostTerminate
  /** Machine-wide Host registry root; defaults to TASKWRAITH_HOST_REGISTRY_ROOT or ~/.taskwraith/hosts. */
  readonly registryRoot?: string
  readonly stopTimeoutMs?: number
}

/** One profile's Host to stop, and the pid the caller judged it by. */
export interface TuiHostTerminationRequest {
  readonly profilePath: string
  readonly pid: number | null
  readonly expected?: HostTerminationExpectedHost | null
  readonly registryRoot?: string
}

export type TuiHostTerminate = (
  request: TuiHostTerminationRequest
) => Promise<HostTerminationOutcome>

export type EnsureTuiHostAvailableResult =
  | {
      readonly kind: 'existing'
      /**
       * A Host on an older payload that could not be proven gone: verified
       * termination refused to signal it, or it outlived SIGKILL. It keeps
       * serving this profile, and the caller should say so.
       */
      readonly staleHost?: { readonly pid: number; readonly refusal: HostTerminationOutcomeKind }
    }
  | {
      readonly kind: 'launched'
      readonly pid: number | null
      /** The stale Host this launch replaced, when one was stopped first. */
      readonly replacedPid?: number
      readonly fullAccessPresence?: TuiFullAccessPresence
    }

export interface TuiHostAuthenticatedProbe {
  readonly welcome: HostBootstrapWelcome
  readonly process: HostProjectionDiscoveryProcessIdentity
}

export class TuiHostProductionCapabilityError extends HostProjectionIncompatibleProtocolError {
  constructor() {
    super('TaskWraith Host is diagnostic or missing required production capabilities.')
    this.name = 'TuiHostProductionCapabilityError'
  }
}

function hostCliArgs(cliPath: string, profilePath: string): string[] {
  return [cliPath, 'serve', '--mode', 'production', '--profile', profilePath]
}

function pathApi(platform: NodeJS.Platform): PlatformPath {
  return platform === 'win32' ? win32 : posix
}

function uniquePaths(paths: readonly string[], platform: NodeJS.Platform): string[] {
  const api = pathApi(platform)
  return [...new Set(paths.map((path) => api.resolve(path)))]
}

function hostEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // The lease test knobs never reach a production Host from a stray shell
  // export; TASKWRAITH_HOST_PERSIST, the user's escape hatch, does.
  const result = withoutHostLeaseTestKnobs(env)
  delete result.ELECTRON_RUN_AS_NODE
  return result
}

function packagedCandidate(
  platform: NodeJS.Platform,
  resourcesDir: string,
  architecture: NodeJS.Architecture,
  env: NodeJS.ProcessEnv,
  userDataPath: string
): TuiHostLaunchCandidate {
  const api = pathApi(platform)
  const runtime = api.resolve(
    resourcesDir,
    'tui-runtime',
    `${platform}-${architecture}`,
    platform === 'win32' ? 'node.exe' : 'node'
  )
  const cli = api.resolve(resourcesDir, 'host', 'host-runtime', 'cli.js')
  return {
    executable: runtime,
    args: hostCliArgs(cli, api.resolve(userDataPath)),
    cwd: api.dirname(cli),
    env: hostEnvironment(env),
    requiredPaths: [runtime, cli]
  }
}

/**
 * The npm CLI package ships the same pure-Node Host payload as the desktop
 * package, but deliberately does not duplicate TaskWraith's 100+ MB pinned
 * Node runtime. npm has already admitted an ordinary Node executable before
 * this profile is selected; keep that boundary explicit instead of silently
 * falling back from a broken desktop package.
 */
function nodePackageCandidate(
  platform: NodeJS.Platform,
  resourcesDir: string,
  env: NodeJS.ProcessEnv,
  userDataPath: string,
  nodeExecutable: string
): TuiHostLaunchCandidate {
  const api = pathApi(platform)
  const cli = api.resolve(resourcesDir, 'host', 'host-runtime', 'cli.js')
  return {
    executable: nodeExecutable,
    args: hostCliArgs(cli, api.resolve(userDataPath)),
    cwd: api.dirname(cli),
    env: hostEnvironment(env),
    requiredPaths: [nodeExecutable, cli]
  }
}

function developmentCandidates(
  platform: NodeJS.Platform,
  moduleDir: string,
  workingDirectory: string,
  env: NodeJS.ProcessEnv,
  userDataPath: string,
  nodeExecutable: string
): TuiHostLaunchCandidate[] {
  const api = pathApi(platform)
  const roots = uniquePaths([api.resolve(moduleDir, '..', '..', '..'), workingDirectory], platform)
  return roots.map((repoRoot) => {
    const cli = api.resolve(repoRoot, 'out', 'host', 'host-runtime', 'cli.js')
    return {
      executable: nodeExecutable,
      args: hostCliArgs(cli, api.resolve(userDataPath)),
      cwd: api.dirname(cli),
      env: hostEnvironment(env),
      requiredPaths: [nodeExecutable, cli]
    }
  })
}

function ordinaryNodeExecutable(path: string, platform: NodeJS.Platform): boolean {
  const base = pathApi(platform).basename(path).toLowerCase()
  return (base === 'node' || base === 'node.exe') && !/electron/i.test(path)
}

async function defaultPathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/**
 * Resolve only a direct ordinary-Node Host invocation. Shell launchers,
 * Electron, open(1), and ELECTRON_RUN_AS_NODE stay outside this trust path.
 */
export async function resolveTuiHostLaunchCommand(
  input: ResolveTuiHostLaunchCommandInput
): Promise<TuiHostLaunchCommand | null> {
  if (input.profile === 'custom') return null
  const moduleDir = input.moduleDir ?? __dirname
  const workingDirectory = input.workingDirectory ?? process.cwd()
  const platform = input.platform ?? process.platform
  const env = input.env ?? process.env
  const pathExists = input.pathExists ?? defaultPathExists
  const userDataPath = String(input.userDataPath || '')
  // Same control-character policy as the production Host CLI (C0 + DEL): fail
  // fast here instead of letting the spawned host reject --profile downstream.
  const hasControlCharacter = [...userDataPath].some((character) => {
    const code = character.charCodeAt(0)
    return code <= 0x1f || code === 0x7f
  })
  if (
    !userDataPath ||
    userDataPath.trim() !== userDataPath ||
    hasControlCharacter ||
    !pathApi(platform).isAbsolute(userDataPath)
  ) {
    throw new Error('TUI Host launch requires an absolute profile path.')
  }
  const resourcesDir = pathApi(platform).resolve(moduleDir, '..', '..')
  const architecture = input.architecture ?? process.arch
  const nodeExecutable = input.nodeExecutable ?? process.execPath
  const isOrdinaryNode =
    input.isOrdinaryNode ??
    ((path: string) => ordinaryNodeExecutable(path, platform) && !process.versions.electron)
  if (
    (input.profile === 'development' || input.profile === 'node-package') &&
    !isOrdinaryNode(nodeExecutable)
  ) {
    throw new Error(`TUI ${input.profile} Host launch requires an ordinary Node executable.`)
  }
  const candidates =
    input.profile === 'development'
      ? developmentCandidates(
          platform,
          moduleDir,
          workingDirectory,
          env,
          userDataPath,
          nodeExecutable
        )
      : input.profile === 'node-package'
        ? [nodePackageCandidate(platform, resourcesDir, env, userDataPath, nodeExecutable)]
        : [packagedCandidate(platform, resourcesDir, architecture, env, userDataPath)]

  for (const candidate of candidates) {
    const availability = await Promise.all(candidate.requiredPaths.map((path) => pathExists(path)))
    if (availability.every(Boolean)) {
      const { requiredPaths: _requiredPaths, ...command } = candidate
      return command
    }
  }
  return null
}

async function authenticatedProbe(
  userDataPath: string,
  connectTimeoutMs: number
): Promise<TuiHostAuthenticatedProbe> {
  const client = new HostProjectionClient({
    client: {
      clientId: `tui-launch-${randomUUID()}`,
      clientClass: 'tui',
      clientVersion: 'host-launch-v1',
      displayName: 'TaskWraith TUI launcher'
    },
    capabilities: ['bootstrap', ...TUI_STANDALONE_HOST_CAPABILITY_FLOOR],
    userDataPath,
    connectTimeoutMs,
    requestTimeoutMs: connectTimeoutMs
  })
  try {
    const welcome = await client.connect()
    assertTuiStandaloneHostWelcome(welcome)
    const processIdentity = client.discoveryProcessIdentity
    if (!processIdentity) throw new Error('TaskWraith Host process identity is unavailable.')
    return { welcome, process: processIdentity }
  } finally {
    client.close()
  }
}

/** Reject an App/diagnostic Host even if it speaks a compatible wire protocol. */
export function assertTuiStandaloneHostWelcome(welcome: HostBootstrapWelcome): void {
  if (
    welcome.hostVersion !== TUI_STANDALONE_HOST_PRODUCTION_VERSION ||
    !TUI_STANDALONE_HOST_CAPABILITY_FLOOR.every((capability) =>
      welcome.capabilities.includes(capability)
    )
  ) {
    throw new TuiHostProductionCapabilityError()
  }
}

function defaultDelay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
}

function incompatibleHost(error: unknown): boolean {
  return error instanceof HostProjectionIncompatibleProtocolError
}

function launchUnavailableMessage(profile: TuiHostLaunchProfile): string {
  if (profile === 'custom') {
    return (
      'TaskWraith Host is offline. Automatic startup is unavailable for an explicit ' +
      'user-data profile because the standalone Host cannot safely infer its launch authority.'
    )
  }
  return `TaskWraith Host is offline and the ${profile} Node runtime could not be located.`
}

function validSecret(value: Buffer): boolean {
  return Buffer.isBuffer(value) && value.byteLength === 32
}

async function writeFullAccessBootstrap(
  child: ChildProcess,
  secret: Buffer,
  timeoutMs: number
): Promise<boolean> {
  const pipe = child.stdio?.[3] as Writable | null | undefined
  if (!pipe || typeof pipe.end !== 'function') return false
  const frame = hostFullAccessBootstrapFrame(secret)
  try {
    return await new Promise<boolean>((resolveWrite) => {
      let settled = false
      const finish = (written: boolean): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolveWrite(written)
      }
      const onError = (): void => finish(false)
      const onFinish = (): void => finish(true)
      const timer = setTimeout(() => {
        try {
          pipe.destroy()
        } catch {
          // Destroy is best effort; timeout still means capability-off.
        }
        finish(false)
      }, timeoutMs)
      timer.unref?.()
      pipe.once('error', onError)
      pipe.once('finish', onFinish)
      try {
        // One bounded write followed by EOF. The Host does not continue until
        // it has consumed this exact fd3 frame or failed closed.
        pipe.end(frame)
      } catch {
        finish(false)
      }
    })
  } finally {
    frame.fill(0)
  }
}

function exactOwnedBinding(
  probe: TuiHostAuthenticatedProbe | void,
  pid: number | undefined
): TuiFullAccessHostProcessBinding | null {
  if (
    !probe ||
    !pid ||
    probe.process.pid !== pid ||
    !probe.process.hostId ||
    !probe.process.hostVersion ||
    probe.process.hostId !== probe.welcome.hostId ||
    probe.process.hostVersion !== probe.welcome.hostVersion
  ) {
    return null
  }
  return {
    pid,
    startedAt: probe.process.startedAt,
    hostId: probe.process.hostId,
    hostVersion: probe.process.hostVersion
  }
}

function launchPayloadVersion(command: TuiHostLaunchCommand): string | null {
  const cli = command.args[0]
  if (!cli) return null
  try {
    return resolveHostPayloadVersion(resolve(dirname(cli), '..'))
  } catch {
    return null
  }
}

function defaultTerminateHost(request: TuiHostTerminationRequest): Promise<HostTerminationOutcome> {
  if (!request.expected || request.expected.pid !== request.pid) {
    return Promise.resolve({
      kind: 'unverifiable',
      pid: request.pid,
      steps: [],
      swept: [],
      detail: 'The selected Host identity is unavailable; no Host was stopped.'
    })
  }
  return terminateHostProcess({
    profilePath: request.profilePath,
    expected: request.expected,
    ...(request.registryRoot ? { registryRoot: request.registryRoot } : {})
  })
}

/** Capture before confirmation; a later discovery must never change its target. */
export function tuiHostTerminationExpectation(
  identity: {
    readonly pid: number | null
    readonly startedAt: string | null
    readonly birthIdentity?: string | null
  } | null
): HostTerminationExpectedHost | null {
  if (!identity?.pid) return null
  const startedAtMs = identity.startedAt ? Date.parse(identity.startedAt) : NaN
  return {
    pid: identity.pid,
    birthIdentity: identity.birthIdentity ?? null,
    ...(Number.isFinite(startedAtMs) ? { startedAtMs } : {})
  }
}

/**
 * A live standalone Host whose payload differs from what this launcher would
 * start is stale: `npm run tui` rebuilt out/host, then reused the process
 * already listening, so a fix never ran until that process died on its own.
 * A Host that predates payload identity cannot be compared and is kept.
 */
async function stalePayloadHost(
  input: EnsureTuiHostAvailableInput,
  existing: TuiHostAuthenticatedProbe
): Promise<{ readonly pid: number; readonly command: TuiHostLaunchCommand } | null> {
  const running = existing.process.payloadVersion
  if (!running || input.profile === 'custom') return null
  const command = input.resolveLaunchCommand
    ? await input.resolveLaunchCommand()
    : await resolveTuiHostLaunchCommand(input)
  if (!command) return null
  let expected: string | null
  try {
    expected = await (input.resolvePayloadVersion ?? launchPayloadVersion)(command)
  } catch {
    expected = null
  }
  if (!expected || expected === running) return null
  return { pid: existing.process.pid, command }
}

/** Resolves with the probe error once the stale Host stops answering. */
async function awaitHostExit(input: {
  readonly userDataPath: string
  readonly pid: number
  readonly probe: NonNullable<EnsureTuiHostAvailableInput['probe']>
  readonly probeTimeoutMs: number
  readonly stopTimeoutMs: number
  readonly now: () => number
  readonly delay: (milliseconds: number) => Promise<void>
  readonly pollMs: number
}): Promise<unknown> {
  const deadline = input.now() + input.stopTimeoutMs
  while (input.now() < deadline) {
    await input.delay(Math.min(input.pollMs, Math.max(1, deadline - input.now())))
    try {
      await input.probe(
        input.userDataPath,
        Math.min(input.probeTimeoutMs, Math.max(1, deadline - input.now()))
      )
    } catch (error) {
      if (incompatibleHost(error)) throw error
      return error
    }
  }
  throw new Error(
    `TaskWraith Host (pid ${input.pid}) runs an older payload and did not stop; ` +
      'stop it and start the TUI again.'
  )
}

const inFlightStarts = new Map<string, Promise<EnsureTuiHostAvailableResult>>()

async function ensureTuiHostAvailableOnce(
  input: EnsureTuiHostAvailableInput
): Promise<EnsureTuiHostAvailableResult> {
  const probe = input.probe ?? authenticatedProbe
  const probeTimeoutMs = input.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
  const now = input.now ?? (() => Date.now())
  const delay = input.delay ?? defaultDelay
  const pollMs = input.pollMs ?? DEFAULT_POLL_MS
  let lastProbeError: unknown
  let probed: { readonly ok: true; readonly value: TuiHostAuthenticatedProbe | void } | null
  try {
    probed = { ok: true, value: await probe(input.userDataPath, probeTimeoutMs) }
  } catch (error) {
    if (incompatibleHost(error)) throw error
    lastProbeError = error
    probed = null
  }

  let replacedPid: number | undefined
  let command: TuiHostLaunchCommand | null = null
  if (probed) {
    if (input.replaceStaleHost === false) return { kind: 'existing' }
    const stale = probed.value ? await stalePayloadHost(input, probed.value) : null
    if (!stale) return { kind: 'existing' }
    // Verified termination, never a bare SIGTERM by pid: the pid the probe saw
    // may belong to another process by now. Only an outcome that proves the
    // Host gone lets the wait below and the launch after it proceed; a refusal
    // leaves the stale Host serving, and the caller says so.
    const termination = await (input.terminateHost ?? defaultTerminateHost)({
      profilePath: input.userDataPath,
      pid: stale.pid,
      expected: tuiHostTerminationExpectation(probed.value?.process ?? null),
      ...(input.registryRoot ? { registryRoot: input.registryRoot } : {})
    })
    if (!HOST_TERMINATION_SUCCESS_KINDS.has(termination.kind)) {
      return { kind: 'existing', staleHost: { pid: stale.pid, refusal: termination.kind } }
    }
    lastProbeError = await awaitHostExit({
      userDataPath: input.userDataPath,
      pid: stale.pid,
      probe,
      probeTimeoutMs,
      stopTimeoutMs: input.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS,
      now,
      delay,
      pollMs
    })
    replacedPid = stale.pid
    command = stale.command
  }

  if (input.profile === 'custom') {
    throw new Error(launchUnavailableMessage(input.profile), { cause: lastProbeError })
  }

  if (!command) {
    command = input.resolveLaunchCommand
      ? await input.resolveLaunchCommand()
      : await resolveTuiHostLaunchCommand(input)
  }
  if (!command) throw new Error(launchUnavailableMessage(input.profile), { cause: lastProbeError })

  const spawn =
    input.spawn ?? ((executable, args, options) => spawnChild(executable, [...args], options))
  let bootstrapSecret: Buffer | null = null
  if (input.enableFullAccessPresence === true) {
    const candidate = (input.createFullAccessSecret ?? (() => randomBytes(32)))()
    if (validSecret(candidate)) bootstrapSecret = candidate
    else candidate.fill(0)
  }
  let child: ChildProcess
  // The Host is detached and unref'd, so anything it writes to fd 2 outlives
  // this call with no reader. Sending that to a log FILE (never the inherited
  // terminal, which a stray line would corrupt mid-frame) is the only durable
  // explanation a failed Host-side turn ever gets: the Host writes no run
  // events, and its receipt ring is shared with the desktop renderer.
  // Fail-open — a log we cannot open must not stop the Host from starting.
  const stderrLogFd = (input.openHostStderrLog ?? openHostStderrLogFd)(input.userDataPath)
  const stderrTarget = stderrLogFd ?? 'ignore'
  try {
    child = spawn(command.executable, command.args, {
      cwd: command.cwd,
      env: bootstrapSecret
        ? {
            ...command.env,
            [HOST_FULL_ACCESS_BOOTSTRAP_FD_ENV]: String(HOST_FULL_ACCESS_BOOTSTRAP_FD)
          }
        : command.env,
      detached: true,
      shell: false,
      stdio: bootstrapSecret
        ? ['ignore', 'ignore', stderrTarget, 'pipe']
        : ['ignore', 'ignore', stderrTarget],
      windowsHide: true
    })
  } catch (error) {
    bootstrapSecret?.fill(0)
    throw error
  } finally {
    // spawn dups the fd into the child; the parent's copy would otherwise leak
    // once per launch. Closing here is safe even on the throwing path above.
    closeHostStderrLogFd(stderrLogFd)
  }
  const outcome: {
    spawnError: Error | null
    exit: { code: number | null; signal: NodeJS.Signals | null } | null
  } = { spawnError: null, exit: null }
  child.once('error', (error) => {
    outcome.spawnError = error
  })
  child.once('exit', (code, signal) => {
    outcome.exit = { code, signal }
  })
  const bootstrapWritten = bootstrapSecret
    ? await writeFullAccessBootstrap(
        child,
        bootstrapSecret,
        input.bootstrapWriteTimeoutMs ?? DEFAULT_BOOTSTRAP_WRITE_TIMEOUT_MS
      )
    : false
  child.unref()

  const timeoutMs = input.timeoutMs ?? DEFAULT_START_TIMEOUT_MS
  const startedAt = now()
  const deadline = startedAt + timeoutMs

  try {
    while (now() < deadline) {
      await delay(Math.min(pollMs, Math.max(1, deadline - now())))
      try {
        const authenticated = await probe(
          input.userDataPath,
          Math.min(probeTimeoutMs, Math.max(1, deadline - now()))
        )
        const binding = bootstrapWritten ? exactOwnedBinding(authenticated, child.pid) : null
        const fullAccessPresence =
          binding && bootstrapSecret
            ? createTuiFullAccessPresence(bootstrapSecret, binding)
            : undefined
        return {
          kind: 'launched',
          pid: authenticated?.process.pid ?? child.pid ?? null,
          ...(replacedPid !== undefined ? { replacedPid } : {}),
          ...(fullAccessPresence ? { fullAccessPresence } : {})
        }
      } catch (error) {
        if (incompatibleHost(error)) throw error
        lastProbeError = error
      }
      if (outcome.spawnError) {
        throw new Error(
          `TaskWraith Host process could not be launched: ${outcome.spawnError.message}`,
          {
            cause: outcome.spawnError
          }
        )
      }
      if (
        outcome.exit &&
        outcome.exit.code !== 0 &&
        now() - startedAt >= Math.max(1_000, pollMs * 2)
      ) {
        const detail = outcome.exit.signal
          ? `signal ${outcome.exit.signal}`
          : `exit code ${String(outcome.exit.code)}`
        throw new Error(`TaskWraith Host process ended before authentication (${detail}).`, {
          cause: lastProbeError
        })
      }
    }

    throw new Error('Timed out waiting for the TaskWraith Host to authenticate.', {
      cause: lastProbeError
    })
  } finally {
    bootstrapSecret?.fill(0)
  }
}

/**
 * Reuse an authenticated Host when one exists. Otherwise serialize one direct
 * application launch per userData profile and wait for an authenticated v2
 * handshake—not merely a discovery file or PID.
 */
export async function ensureTuiHostAvailable(
  input: EnsureTuiHostAvailableInput
): Promise<EnsureTuiHostAvailableResult> {
  const key = resolve(input.userDataPath)
  const existing = inFlightStarts.get(key)
  if (existing) {
    await existing
    return { kind: 'existing' }
  }
  const operation = ensureTuiHostAvailableOnce(input)
  inFlightStarts.set(key, operation)
  try {
    return await operation
  } finally {
    if (inFlightStarts.get(key) === operation) inFlightStarts.delete(key)
  }
}

export interface RestartTuiHostInput extends EnsureTuiHostAvailableInput {
  /** The pid this TUI is attached to, for the termination request and the report. */
  readonly pid?: number | null
  /** Identity captured when the restart was requested, before any confirmation. */
  readonly expected?: HostTerminationExpectedHost | null
}

export interface RestartTuiHostResult {
  readonly termination: HostTerminationOutcome
  /** Absent when the stop was refused: nothing was launched. */
  readonly launch?: EnsureTuiHostAvailableResult
}

/**
 * `/host restart`: verified termination of this profile's Host, then the
 * ordinary launch path. A restart that cannot launch afterwards must not stop
 * anything, so an explicit (custom) profile, which the TUI never launches, is
 * refused and the launch command is resolved before the Host is touched.
 */
export async function restartTuiHost(input: RestartTuiHostInput): Promise<RestartTuiHostResult> {
  if (input.profile === 'custom') throw new Error(launchUnavailableMessage(input.profile))
  const command = input.resolveLaunchCommand
    ? await input.resolveLaunchCommand()
    : await resolveTuiHostLaunchCommand(input)
  if (!command) throw new Error(launchUnavailableMessage(input.profile))
  let termination: HostTerminationOutcome
  if (input.expected === null) {
    // No Host was connected when the user asked. Never stop a Host that
    // appeared meanwhile; a still-offline profile may be launched below.
    try {
      const current = await (input.probe ?? authenticatedProbe)(
        input.userDataPath,
        input.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
      )
      return {
        termination: {
          kind: 'inconsistent',
          pid: null,
          ...(current ? { heldBy: current.process.pid } : {}),
          steps: [],
          swept: [],
          detail: 'A Host is now serving this profile that was not in the restart request.'
        }
      }
    } catch (error) {
      if (incompatibleHost(error)) throw error
    }
    termination = { kind: 'already_gone', pid: null, steps: [], swept: [] }
  } else {
    termination = await (input.terminateHost ?? defaultTerminateHost)({
      profilePath: input.userDataPath,
      pid: input.expected?.pid ?? input.pid ?? null,
      expected: input.expected,
      ...(input.registryRoot ? { registryRoot: input.registryRoot } : {})
    })
  }
  if (termination.heldBy !== undefined || !HOST_TERMINATION_SUCCESS_KINDS.has(termination.kind)) {
    return { termination }
  }
  const launch = await ensureTuiHostAvailable({
    ...input,
    replaceStaleHost: false,
    resolveLaunchCommand: async () => command
  })
  return { termination, launch }
}

/**
 * `/host stop-all`, scoped exactly as `cli.js stop-all` parses it. There is no
 * sweep: each stopped Host's verified termination removes exactly that Host's
 * entry, socket and profile records, and whatever else is dead is left to
 * `taskwraith-host stop-all --sweep`, so nothing outside the confirmed list is
 * ever touched from here.
 */
export interface TuiHostStopAllRequest {
  readonly scope: HostStopAllScope
  readonly scanArgv: boolean
}

export interface TuiHostStopAllPlan {
  readonly request: TuiHostStopAllRequest
  readonly registryRoot: string
  /** Every Host found, selected or not. */
  readonly hosts: readonly HostStopAllHost[]
  /** Exactly the Hosts an explicit `y` stops; empty for a listing. */
  readonly selected: readonly HostStopAllHost[]
  readonly unreadableEntries: number
  /** Why `--scan-argv` could not list processes, when it could not. */
  readonly scanUnavailable?: string
  /** What the plan was read from; execution refuses when a fresh read differs. */
  readonly fingerprint: string
}

export interface TuiHostStopAllResult {
  readonly host: HostStopAllHost
  readonly outcome: HostTerminationOutcome
}

export type TuiHostStopAllOutcome =
  | { readonly kind: 'registry_changed'; readonly fresh: TuiHostStopAllPlan }
  | { readonly kind: 'done'; readonly results: readonly TuiHostStopAllResult[] }

export interface TuiHostStopAllPorts {
  readonly stopAll?: (options: HostStopAllOptions) => Promise<HostStopAllReport>
  readonly terminate?: (input: {
    readonly profilePath: string
    readonly registryRoot: string
    readonly expected: HostTerminationExpectedHost
  }) => Promise<HostTerminationOutcome>
}

export interface TuiHostStopAllOptions {
  readonly registryRoot?: string
  readonly env?: Readonly<NodeJS.ProcessEnv>
  readonly ports?: TuiHostStopAllPorts
}

/**
 * Never shown and never acted on: planning hands stopAllHosts a terminate port
 * that signals nothing, so its selection is exactly the one an execution with
 * this scope would make.
 */
const PLAN_ONLY_OUTCOME: HostTerminationOutcome = Object.freeze({
  kind: 'already_gone',
  pid: null,
  steps: Object.freeze(['plan-only']),
  swept: Object.freeze([])
})

function stopAllFingerprint(
  hosts: readonly HostStopAllHost[],
  unreadableEntries: number,
  scanUnavailable: string | undefined
): string {
  const rows = hosts
    .map((host) =>
      JSON.stringify([
        host.source,
        host.profilePath,
        host.pid,
        host.birthIdentity,
        host.startedAt,
        host.cliPath,
        host.payloadVersion,
        host.liveness,
        host.selected,
        host.persist
      ])
    )
    .sort()
  return JSON.stringify({ rows, unreadableEntries, scanUnavailable: scanUnavailable ?? null })
}

/** Lists what `request` would stop, signalling nothing. */
export async function planTuiHostStopAll(
  request: TuiHostStopAllRequest,
  options: TuiHostStopAllOptions = {}
): Promise<TuiHostStopAllPlan> {
  const registryRoot = options.registryRoot ?? resolveHostRegistryRoot(options.env ?? process.env)
  const report = await (options.ports?.stopAll ?? stopAllHosts)({
    scope: request.scope,
    scanArgv: request.scanArgv,
    registryRoot,
    ports: { terminate: async () => PLAN_ONLY_OUTCOME }
  })
  const hosts = report.hosts.map(({ outcome: _outcome, ...host }) => host)
  const scanUnavailable = report.scan && !report.scan.ok ? report.scan.reason : undefined
  return {
    request,
    registryRoot,
    hosts,
    selected: hosts.filter((host) => host.selected),
    unreadableEntries: report.unreadableEntries.length,
    ...(scanUnavailable ? { scanUnavailable } : {}),
    fingerprint: stopAllFingerprint(hosts, report.unreadableEntries.length, scanUnavailable)
  }
}

/** Prefer the selected Host's birth digest while retaining the connection's target. */
export async function prepareTuiHostRestart(
  profilePath: string,
  expected: HostTerminationExpectedHost | null,
  options: TuiHostStopAllOptions = {}
): Promise<HostTerminationExpectedHost | null> {
  if (!expected) return null
  const plan = await planTuiHostStopAll(
    {
      scope: { kind: 'profile', profilePath },
      scanArgv: false
    },
    options
  )
  const host = plan.selected.find(
    (row) =>
      row.pid === expected.pid &&
      row.startedAt !== null &&
      Date.parse(row.startedAt) === expected.startedAtMs
  )
  return host?.birthIdentity ? { ...expected, birthIdentity: host.birthIdentity } : expected
}

/**
 * Stops exactly the Hosts `plan` showed. The registry is read again first and
 * anything that changed refuses the whole run, so a Host the user never saw is
 * never stopped; each selected Host then goes through verified termination,
 * which re-checks its identity before every signal and removes only that
 * Host's own records afterwards.
 */
export async function runTuiHostStopAll(
  plan: TuiHostStopAllPlan,
  options: TuiHostStopAllOptions = {}
): Promise<TuiHostStopAllOutcome> {
  const fresh = await planTuiHostStopAll(plan.request, {
    ...options,
    registryRoot: plan.registryRoot
  })
  if (fresh.fingerprint !== plan.fingerprint) return { kind: 'registry_changed', fresh }
  const terminate = options.ports?.terminate ?? terminateHostProcess
  const results = await Promise.all(
    plan.selected.map(async (host) => {
      const expected = tuiHostTerminationExpectation(host)
      return {
        host,
        outcome: expected
          ? await terminate({
              profilePath: host.profilePath,
              registryRoot: plan.registryRoot,
              expected
            })
          : await defaultTerminateHost({ profilePath: host.profilePath, pid: host.pid })
      }
    })
  )
  return { kind: 'done', results }
}

/**
 * What the interactive TUI may do to Hosts, injected by the CLI. `restart` is
 * absent when this session never launches a Host (`--no-start-host`, or an
 * explicit profile), and `restartUnavailable` says why.
 */
export interface TuiHostControl {
  readonly prepareRestart?: (
    expected: HostTerminationExpectedHost | null
  ) => Promise<HostTerminationExpectedHost | null>
  readonly restart?: (expected: HostTerminationExpectedHost | null) => Promise<RestartTuiHostResult>
  readonly restartUnavailable?: string
  readonly planStopAll: (request: TuiHostStopAllRequest) => Promise<TuiHostStopAllPlan>
  readonly runStopAll: (plan: TuiHostStopAllPlan) => Promise<TuiHostStopAllOutcome>
}
