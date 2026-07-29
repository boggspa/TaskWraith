import { spawn, type ChildProcess, type SpawnOptions, type StdioOptions } from 'node:child_process'
import { accessSync, constants, realpathSync, statSync } from 'node:fs'
import { delimiter, isAbsolute, join, resolve } from 'node:path'

import { withExactWorkspaceLockOwnerEnv } from './WorkspaceLockExecutionIdentity'

export interface WorkspaceLockGatedProcessSpec {
  command: string
  args: readonly string[]
  cwd: string
  env: Readonly<Record<string, string | undefined>>
  shell?: boolean
  detached?: boolean
  windowsHide?: boolean
}

export interface WorkspaceLockGatedProcess {
  /**
   * The exact inert gate process whose PID/birth must own the transferred
   * lease. On release it becomes the target without changing incarnation.
   */
  child: ChildProcess
  /** Replace the gate only after durable lock transfer succeeds. */
  start(): void
}

export interface WorkspaceLockGatedProcessDependencies {
  nodeExecutable?: string
  spawnProcess?: typeof spawn
  platform?: NodeJS.Platform
  execveAvailable?: boolean
}

const GATED_PROCESS_SOURCE = String.raw`
let launched = false

process.once('message', (message) => {
  if (
    launched ||
    !message ||
    message.type !== 'taskwraith-workspace-lock-start' ||
    !message.spec ||
    typeof message.spec.executable !== 'string' ||
    typeof message.spec.argv0 !== 'string' ||
    !Array.isArray(message.spec.args)
  ) {
    process.exit(125)
    return
  }
  launched = true
  const spec = message.spec
  try {
    if (typeof process.execve !== 'function') {
      throw new Error('same-PID process replacement is unavailable')
    }
    if (process.connected) process.disconnect()
    process.execve(spec.executable, [spec.argv0, ...spec.args], spec.env)
  } catch (error) {
    process.stderr.write(String(error && error.message ? error.message : error) + '\n')
    process.exit(127)
  }
})

process.once('disconnect', () => {
  if (!launched) process.exit(125)
})
setImmediate(() => {
  if (!process.connected && !launched) process.exit(125)
})
`

/**
 * Spawn an inert Node gate. No workspace command exists until `start()` sends
 * the spec, so main can durably transfer the pre-admission lease to this exact
 * PID/birth first. After release, POSIX `execve` atomically replaces the gate
 * with the target while retaining its PID and stdio, so there is no wrapper
 * process whose death could orphan a still-mutating descendant.
 */
export function spawnWorkspaceLockGatedProcess(
  spec: WorkspaceLockGatedProcessSpec,
  workspaceLockOwnerId: string,
  deps: WorkspaceLockGatedProcessDependencies = {}
): WorkspaceLockGatedProcess {
  const spawnProcess = deps.spawnProcess ?? spawn
  const nodeExecutable = deps.nodeExecutable ?? process.execPath
  const platform = deps.platform ?? process.platform
  const execveAvailable =
    deps.execveAvailable ??
    typeof (process as NodeJS.Process & { execve?: unknown }).execve === 'function'
  if (platform === 'win32' || !execveAvailable) {
    throw new Error('Same-PID workspace-lock process replacement is unavailable on this runtime.')
  }
  if (spec.shell) {
    throw new Error('Same-PID workspace-lock process replacement requires exact argv.')
  }
  const env = exactExecEnvironment(spec.env, workspaceLockOwnerId)
  const executable = resolveExactExecutable(spec.command, spec.cwd, env)
  const gateEnv = {
    ...env,
    // process.execPath is Electron in packaged main. This makes its `-e`
    // invocation a plain Node child without starting another app instance.
    ELECTRON_RUN_AS_NODE: '1'
  }
  // stdin remains a pipe so interactive provider transports can write through
  // the inert process after transfer. Bytes written earlier remain buffered
  // and cannot execute a workspace command before `start()`.
  const stdio: StdioOptions = ['pipe', 'pipe', 'pipe', 'ipc']
  const child = spawnProcess(nodeExecutable, ['-e', GATED_PROCESS_SOURCE], {
    cwd: spec.cwd,
    env: gateEnv,
    shell: false,
    detached: spec.detached,
    windowsHide: spec.windowsHide,
    stdio
  } satisfies SpawnOptions)
  let started = false

  return {
    child,
    start: () => {
      if (started) throw new Error('Workspace-lock process gate was already released.')
      if (!child.pid || child.killed || !child.connected) {
        throw new Error('Workspace-lock process gate is not live.')
      }
      started = true
      child.send?.({
        type: 'taskwraith-workspace-lock-start',
        spec: {
          executable,
          argv0: spec.command,
          args: [...spec.args],
          env
        }
      })
    }
  }
}

function exactExecEnvironment(
  input: Readonly<Record<string, string | undefined>>,
  workspaceLockOwnerId: string
): Record<string, string> {
  const admitted = withExactWorkspaceLockOwnerEnv(input, workspaceLockOwnerId)
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(admitted)) {
    if (typeof value !== 'string') continue
    if (!key || key.includes('\u0000') || key.includes('=') || value.includes('\u0000')) {
      throw new Error('Workspace-lock process environment is malformed.')
    }
    env[key] = value
  }
  return env
}

function resolveExactExecutable(
  command: string,
  cwd: string,
  env: Readonly<Record<string, string>>
): string {
  if (!command || command.includes('\u0000')) {
    throw new Error('Workspace-lock process executable is malformed.')
  }
  const candidates =
    isAbsolute(command) || command.includes('/')
      ? [resolve(cwd, command)]
      : (env.PATH || '')
          .split(delimiter)
          .filter(Boolean)
          .map((directory) => join(directory, command))
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK)
      if (!statSync(candidate).isFile()) continue
      return realpathSync(candidate)
    } catch {
      // Keep searching the exact sanitized PATH.
    }
  }
  throw new Error(`Workspace-lock process executable was not found: ${command}`)
}
