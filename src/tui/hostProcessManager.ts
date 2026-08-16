import { randomUUID } from 'node:crypto'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { spawn as spawnChild } from 'node:child_process'
import { access } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { posix, resolve, win32, type PlatformPath } from 'node:path'

import {
  HostProjectionClient,
  HostProjectionIncompatibleProtocolError
} from '../main/host/HostProjectionClient'
import {
  PACKAGE_SMOKE_ARG,
  PACKAGE_SMOKE_USER_DATA_ARG,
  resolveInstanceLaunchPosture
} from '../main/InstanceLaunchPosture'
import { TUI_HEADLESS_HOST_ARG, TUI_HEADLESS_HOST_PARENT_ARG } from '../main/TuiHeadlessHostSession'

const DEFAULT_START_TIMEOUT_MS = 120_000
const DEFAULT_POLL_MS = 250
const DEFAULT_PROBE_TIMEOUT_MS = 1_500

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
  readonly parentPid?: number
  readonly moduleDir?: string
  readonly workingDirectory?: string
  readonly platform?: NodeJS.Platform
  readonly env?: NodeJS.ProcessEnv
  readonly homeDirectory?: string
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
  readonly timeoutMs?: number
  readonly pollMs?: number
  readonly probeTimeoutMs?: number
  readonly probe?: (userDataPath: string, connectTimeoutMs: number) => Promise<void>
  readonly resolveLaunchCommand?: () => Promise<TuiHostLaunchCommand | null>
  readonly spawn?: TuiHostSpawn
  readonly now?: () => number
  readonly delay?: (milliseconds: number) => Promise<void>
}

export type EnsureTuiHostAvailableResult =
  | { readonly kind: 'existing' }
  | { readonly kind: 'launched'; readonly pid: number | null }

function headlessArgs(parentPid: number): string[] {
  return [TUI_HEADLESS_HOST_ARG, `${TUI_HEADLESS_HOST_PARENT_ARG}${parentPid}`]
}

function launchArgs(input: {
  profile: TuiHostLaunchProfile
  parentPid: number
  platform: NodeJS.Platform
  userDataPath?: string
}): string[] {
  const args = headlessArgs(input.parentPid)
  if (input.profile !== 'package-smoke') return args
  const userDataPath = String(input.userDataPath || '').trim()
  const smokeArgs = [PACKAGE_SMOKE_ARG, `${PACKAGE_SMOKE_USER_DATA_ARG}${userDataPath}`]
  const posture = resolveInstanceLaunchPosture({
    isPackaged: true,
    argv: smokeArgs,
    temporaryDirectory: tmpdir()
  })
  if (posture.kind !== 'package-smoke' || posture.userDataPath !== resolve(userDataPath)) {
    throw new Error('TUI package smoke requires its exact disposable temp profile.')
  }
  return [
    ...smokeArgs,
    ...args,
    ...(input.platform === 'darwin' ? ['--use-mock-keychain'] : []),
    ...(input.platform === 'linux' ? ['--no-sandbox', '--disable-gpu'] : [])
  ]
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

function packagedCandidates(
  platform: NodeJS.Platform,
  resourcesDir: string,
  env: NodeJS.ProcessEnv,
  homeDirectory: string,
  args: readonly string[]
): TuiHostLaunchCandidate[] {
  const api = pathApi(platform)
  const installRoot = api.resolve(resourcesDir, '..')
  const explicitExecutable = String(env.TASKWRAITH_TUI_APP_EXECUTABLE || '').trim()
  const candidates: string[] = []
  if (explicitExecutable && api.isAbsolute(explicitExecutable)) candidates.push(explicitExecutable)

  if (api.basename(resourcesDir).toLowerCase() === 'resources') {
    if (platform === 'darwin')
      candidates.push(api.resolve(resourcesDir, '..', 'MacOS', 'TaskWraith'))
    else if (platform === 'win32') candidates.push(api.resolve(installRoot, 'TaskWraith.exe'))
    else
      candidates.push(
        api.resolve(installRoot, 'taskwraith'),
        api.resolve(installRoot, 'TaskWraith')
      )
  }

  if (platform === 'darwin') {
    candidates.push(
      '/Applications/TaskWraith.app/Contents/MacOS/TaskWraith',
      api.resolve(
        homeDirectory,
        'Applications',
        'TaskWraith.app',
        'Contents',
        'MacOS',
        'TaskWraith'
      )
    )
  } else if (platform === 'win32') {
    const localAppData = String(env.LOCALAPPDATA || '').trim()
    const programFiles = String(env.ProgramFiles || '').trim()
    if (localAppData) {
      candidates.push(api.resolve(localAppData, 'Programs', 'TaskWraith', 'TaskWraith.exe'))
    }
    if (programFiles) candidates.push(api.resolve(programFiles, 'TaskWraith', 'TaskWraith.exe'))
  } else {
    const appImage = String(env.APPIMAGE || '').trim()
    if (appImage && api.isAbsolute(appImage)) candidates.push(appImage)
    candidates.push('/opt/TaskWraith/taskwraith')
  }

  return uniquePaths(candidates, platform).map((executable) => ({
    executable,
    args,
    cwd: api.dirname(executable),
    env: hostEnvironment(env),
    requiredPaths: [executable]
  }))
}

function developmentCandidates(
  platform: NodeJS.Platform,
  moduleDir: string,
  workingDirectory: string,
  env: NodeJS.ProcessEnv,
  args: readonly string[]
): TuiHostLaunchCandidate[] {
  const api = pathApi(platform)
  const roots = uniquePaths([api.resolve(moduleDir, '..', '..', '..'), workingDirectory], platform)
  const executableName = platform === 'win32' ? 'electron.exe' : 'electron'
  return roots.map((repoRoot) => {
    const executable =
      platform === 'darwin'
        ? api.resolve(
            repoRoot,
            'node_modules',
            'electron',
            'dist',
            'Electron.app',
            'Contents',
            'MacOS',
            'Electron'
          )
        : api.resolve(repoRoot, 'node_modules', 'electron', 'dist', executableName)
    return {
      executable,
      args: [repoRoot, ...args],
      cwd: repoRoot,
      env: hostEnvironment(env),
      requiredPaths: [
        executable,
        api.resolve(repoRoot, 'package.json'),
        api.resolve(repoRoot, 'out', 'main', 'index.js')
      ]
    }
  })
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
 * Resolve only a direct application executable. Shell launchers, open(1), and
 * ELECTRON_RUN_AS_NODE are intentionally excluded from the Host trust path.
 */
export async function resolveTuiHostLaunchCommand(
  input: ResolveTuiHostLaunchCommandInput
): Promise<TuiHostLaunchCommand | null> {
  if (input.profile === 'custom') return null
  const parentPid = input.parentPid ?? process.pid
  if (!Number.isSafeInteger(parentPid) || parentPid < 1) {
    throw new Error('TUI Host launch requires a positive parent process identity.')
  }
  const moduleDir = input.moduleDir ?? __dirname
  const workingDirectory = input.workingDirectory ?? process.cwd()
  const platform = input.platform ?? process.platform
  const env = input.env ?? process.env
  const homeDirectory = input.homeDirectory ?? homedir()
  const pathExists = input.pathExists ?? defaultPathExists
  const args = launchArgs({
    profile: input.profile,
    parentPid,
    platform,
    userDataPath: input.userDataPath
  })
  const resourcesDir = pathApi(platform).resolve(moduleDir, '..', '..')
  const candidates =
    input.profile === 'development'
      ? developmentCandidates(platform, moduleDir, workingDirectory, env, args)
      : packagedCandidates(platform, resourcesDir, env, homeDirectory, args)

  for (const candidate of candidates) {
    const availability = await Promise.all(candidate.requiredPaths.map((path) => pathExists(path)))
    if (availability.every(Boolean)) {
      const { requiredPaths: _requiredPaths, ...command } = candidate
      return command
    }
  }
  return null
}

async function authenticatedProbe(userDataPath: string, connectTimeoutMs: number): Promise<void> {
  const client = new HostProjectionClient({
    client: {
      clientId: `tui-launch-${randomUUID()}`,
      clientClass: 'tui',
      clientVersion: 'host-launch-v1',
      displayName: 'TaskWraith TUI launcher'
    },
    capabilities: ['bootstrap', 'health'],
    userDataPath,
    connectTimeoutMs,
    requestTimeoutMs: connectTimeoutMs
  })
  try {
    await client.connect()
  } finally {
    client.close()
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
      'user-data profile because the app cannot safely infer its launch authority.'
    )
  }
  return `TaskWraith Host is offline and the ${profile} app executable could not be located.`
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
  const child = spawn(command.executable, command.args, {
    cwd: command.cwd,
    env: command.env,
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  })
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
  child.unref()

  const now = input.now ?? (() => Date.now())
  const delay = input.delay ?? defaultDelay
  const timeoutMs = input.timeoutMs ?? DEFAULT_START_TIMEOUT_MS
  const pollMs = input.pollMs ?? DEFAULT_POLL_MS
  const startedAt = now()
  const deadline = startedAt + timeoutMs

  while (now() < deadline) {
    await delay(Math.min(pollMs, Math.max(1, deadline - now())))
    try {
      await probe(input.userDataPath, Math.min(probeTimeoutMs, Math.max(1, deadline - now())))
      return { kind: 'launched', pid: child.pid ?? null }
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
  if (existing) return existing
  const operation = ensureTuiHostAvailableOnce(input)
  inFlightStarts.set(key, operation)
  try {
    return await operation
  } finally {
    if (inFlightStarts.get(key) === operation) inFlightStarts.delete(key)
  }
}
