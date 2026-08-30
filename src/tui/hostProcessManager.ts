import { randomBytes, randomUUID } from 'node:crypto'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { spawn as spawnChild } from 'node:child_process'
import { access } from 'node:fs/promises'
import { posix, resolve, win32, type PlatformPath } from 'node:path'
import type { Writable } from 'node:stream'

import {
  HostProjectionClient,
  HostProjectionIncompatibleProtocolError,
  type HostProjectionDiscoveryProcessIdentity
} from '../host-client/HostProjectionClient'
import {
  HOST_FULL_ACCESS_BOOTSTRAP_FD,
  HOST_FULL_ACCESS_BOOTSTRAP_FD_ENV,
  hostFullAccessBootstrapFrame
} from '../host-runtime/HostFullAccessBootstrap'
import type { HostBootstrapWelcome, HostCapability } from '../shared/hostProtocol'
import {
  createTuiFullAccessPresence,
  type TuiFullAccessPresence,
  type TuiFullAccessHostProcessBinding
} from './fullAccessConsent'

const DEFAULT_START_TIMEOUT_MS = 120_000
const DEFAULT_POLL_MS = 250
const DEFAULT_PROBE_TIMEOUT_MS = 1_500
const DEFAULT_BOOTSTRAP_WRITE_TIMEOUT_MS = 2_000
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

export type TuiHostLaunchProfile = 'production' | 'development' | 'package-smoke' | 'custom'

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
  readonly now?: () => number
  readonly delay?: (milliseconds: number) => Promise<void>
}

export type EnsureTuiHostAvailableResult =
  | { readonly kind: 'existing' }
  | {
      readonly kind: 'launched'
      readonly pid: number | null
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
  const result = { ...env }
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
  if (
    !userDataPath ||
    userDataPath.trim() !== userDataPath ||
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
  if (input.profile === 'development' && !isOrdinaryNode(nodeExecutable)) {
    throw new Error('TUI development Host launch requires an ordinary Node executable.')
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

const inFlightStarts = new Map<string, Promise<EnsureTuiHostAvailableResult>>()

async function ensureTuiHostAvailableOnce(
  input: EnsureTuiHostAvailableInput
): Promise<EnsureTuiHostAvailableResult> {
  const probe = input.probe ?? authenticatedProbe
  const probeTimeoutMs = input.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
  let lastProbeError: unknown
  try {
    await probe(input.userDataPath, probeTimeoutMs)
    return { kind: 'existing' }
  } catch (error) {
    if (incompatibleHost(error)) throw error
    lastProbeError = error
  }

  if (input.profile === 'custom') {
    throw new Error(launchUnavailableMessage(input.profile), { cause: lastProbeError })
  }

  const command = input.resolveLaunchCommand
    ? await input.resolveLaunchCommand()
    : await resolveTuiHostLaunchCommand(input)
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
      stdio: bootstrapSecret ? ['ignore', 'ignore', 'ignore', 'pipe'] : 'ignore',
      windowsHide: true
    })
  } catch (error) {
    bootstrapSecret?.fill(0)
    throw error
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

  const now = input.now ?? (() => Date.now())
  const delay = input.delay ?? defaultDelay
  const timeoutMs = input.timeoutMs ?? DEFAULT_START_TIMEOUT_MS
  const pollMs = input.pollMs ?? DEFAULT_POLL_MS
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
          pid: child.pid ?? null,
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
