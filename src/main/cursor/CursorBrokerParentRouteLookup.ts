import { execFile, execFileSync, type ChildProcess } from 'node:child_process'
import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync
} from 'node:fs'
import { dirname, isAbsolute, join, parse, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ProviderId } from '../store/types'
import { parseMcpBridgeRouteFromEnv, type McpBridgeRouteEnvironment } from '../mcp/McpBridgeRoute'

export const CURSOR_BROKER_PARENT_ROUTE_DIRECTORY_NAME = 'cursor-broker-parent-routes'
export const CURSOR_BROKER_PARENT_ROUTE_MAX_ANCESTOR_DEPTH = 16

const PID_FILE_PATTERN = /^[1-9][0-9]{0,9}$/
const MAX_ROUTE_FILE_BYTES = 16_384

export type CursorBrokerParentPidReader = (pid: number) => number | null
export type CursorBrokerParentPidLiveness = (pid: number) => boolean

export interface RecordCursorBrokerParentRouteInput {
  readonly pid: number
  readonly env: Readonly<Record<string, string>>
  readonly socketPath: string
  readonly isPidAlive?: CursorBrokerParentPidLiveness
}

export interface ResolveCursorBrokerParentRouteInput {
  readonly startPid: number
  readonly socketPath: string
  readonly readParentPid?: CursorBrokerParentPidReader
  readonly isPidAlive?: CursorBrokerParentPidLiveness
}

export interface AttachCursorBrokerParentRouteInput {
  readonly provider: ProviderId | string
  readonly child: Pick<ChildProcess, 'pid' | 'once'>
  readonly extraEnv?: Readonly<Record<string, string>>
  readonly socketPath: string
  readonly isPidAlive?: CursorBrokerParentPidLiveness
}

export interface ExecFileCursorMcpBoundToParentRouteInput {
  readonly binaryPath: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly routeEnv: Readonly<Record<string, string>>
  readonly socketPath: string
  readonly timeout?: number
  readonly env?: NodeJS.ProcessEnv
  readonly callback: (error: Error | null, stdout: string, stderr: string) => void
  readonly execFileImpl?: typeof execFile
  readonly isPidAlive?: CursorBrokerParentPidLiveness
}

function isUsableAbsolutePath(value: string): boolean {
  if (!isAbsolute(value)) return false
  const normalized = resolve(value)
  return normalized === value && normalized !== parse(normalized).root
}

function requirePositivePid(pid: number): number {
  if (!Number.isInteger(pid) || pid <= 1 || !PID_FILE_PATTERN.test(String(pid))) {
    throw new TypeError('Cursor broker parent route pid must be a positive integer.')
  }
  return pid
}

export function cursorBrokerParentRouteDirectory(socketPath: string): string {
  if (!isUsableAbsolutePath(socketPath)) {
    throw new TypeError('Cursor broker parent route socket path is invalid.')
  }
  const parent = dirname(socketPath)
  if (parent === parse(parent).root) {
    throw new TypeError('Cursor broker parent route socket parent is invalid.')
  }
  return join(parent, CURSOR_BROKER_PARENT_ROUTE_DIRECTORY_NAME)
}

function routeFilePath(socketPath: string, pid: number): string {
  return join(cursorBrokerParentRouteDirectory(socketPath), `${requirePositivePid(pid)}.json`)
}

function assertTrustedDirectory(path: string, create: boolean): void {
  let stat: ReturnType<typeof lstatSync> | null = null
  try {
    stat = lstatSync(path)
  } catch (error) {
    if (!create || !isMissing(error)) throw error
  }
  if (!stat) {
    mkdirSync(path, { recursive: true, mode: 0o700 })
    chmodSync(path, 0o700)
    stat = lstatSync(path)
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('Cursor broker parent route directory is not a trusted directory.')
  }
}

function isMissing(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  )
}

export function defaultCursorBrokerParentPidIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export function defaultCursorBrokerParentPid(pid: number): number | null {
  if (!Number.isInteger(pid) || pid <= 1) return null
  if (pid === process.pid) {
    const ppid = process.ppid
    return Number.isInteger(ppid) && ppid > 1 ? ppid : null
  }
  try {
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      const closeParen = stat.lastIndexOf(')')
      if (closeParen < 0) return null
      const ppid = Number(stat.slice(closeParen + 2).split(/\s+/)[1])
      return Number.isInteger(ppid) && ppid > 0 ? ppid : null
    }
    const output = execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 1_000,
      stdio: ['ignore', 'pipe', 'ignore']
    })
    const ppid = Number(output.trim().split(/\s+/).pop())
    return Number.isInteger(ppid) && ppid > 0 ? ppid : null
  } catch {
    return null
  }
}

function cloneRouteEnv(env: Readonly<Record<string, string>>): Record<string, string> {
  const parsed = parseMcpBridgeRouteFromEnv(env)
  if (!parsed.ok) {
    throw new TypeError('Cursor broker parent route environment is incomplete.')
  }
  const cloned: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') cloned[key] = value
  }
  return cloned
}

function writePrivateJsonFile(path: string, body: string): void {
  const directory = dirname(path)
  assertTrustedDirectory(directory, true)
  const temporaryPath = join(directory, `.route-${process.pid}-${randomUUID()}.tmp`)
  let fd: number | null = null
  try {
    fd = openSync(temporaryPath, 'wx', 0o600)
    writeSync(fd, body, undefined, 'utf8')
    chmodSync(temporaryPath, 0o600)
    fsyncSync(fd)
    closeSync(fd)
    fd = null
    renameSync(temporaryPath, path)
    chmodSync(path, 0o600)
  } catch (error) {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        // Best-effort.
      }
    }
    try {
      rmSync(temporaryPath, { force: true })
    } catch {
      // Best-effort.
    }
    throw error
  }
}

export function recordCursorBrokerParentRoute(input: RecordCursorBrokerParentRouteInput): {
  path: string
} {
  const pid = requirePositivePid(input.pid)
  const isPidAlive = input.isPidAlive ?? defaultCursorBrokerParentPidIsAlive
  if (!isPidAlive(pid)) {
    throw new Error('Cursor broker parent route pid is not alive.')
  }
  if (!isUsableAbsolutePath(input.socketPath)) {
    throw new TypeError('Cursor broker parent route socket path is invalid.')
  }
  const env = cloneRouteEnv(input.env)
  const parsed = parseMcpBridgeRouteFromEnv(env)
  if (!parsed.ok) {
    throw new TypeError('Cursor broker parent route environment is incomplete.')
  }
  if (parsed.value.endpoint.socketPath !== resolve(input.socketPath)) {
    throw new TypeError('Cursor broker parent route socket does not match the recorded endpoint.')
  }
  const path = routeFilePath(input.socketPath, pid)
  writePrivateJsonFile(path, `${JSON.stringify(env)}\n`)
  return { path }
}

export function releaseCursorBrokerParentRoute(input: {
  readonly pid: number
  readonly socketPath: string
}): void {
  if (!Number.isInteger(input.pid) || input.pid <= 1) return
  if (!PID_FILE_PATTERN.test(String(input.pid))) return
  try {
    rmSync(routeFilePath(input.socketPath, input.pid), { force: true })
  } catch {
    // Best-effort: a later lookup still fail-closes if the pid is dead.
  }
}

function readRecordedRoute(
  socketPath: string,
  pid: number
): { readonly value: McpBridgeRouteEnvironment; readonly env: Record<string, string> } | null {
  if (!PID_FILE_PATTERN.test(String(pid))) return null
  let bytes: string
  try {
    const path = routeFilePath(socketPath, pid)
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_ROUTE_FILE_BYTES) return null
    bytes = readFileSync(path, 'utf8')
  } catch {
    return null
  }
  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(bytes)
  } catch {
    return null
  }
  if (!parsedJson || typeof parsedJson !== 'object' || Array.isArray(parsedJson)) return null
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(parsedJson as Record<string, unknown>)) {
    if (typeof value !== 'string') return null
    env[key] = value
  }
  const parsed = parseMcpBridgeRouteFromEnv(env)
  if (!parsed.ok) return null
  if (parsed.value.endpoint.socketPath !== resolve(socketPath)) return null
  return { value: parsed.value, env }
}

export function resolveCursorBrokerParentRouteFromAncestors(
  input: ResolveCursorBrokerParentRouteInput
): {
  readonly ok: true
  readonly value: McpBridgeRouteEnvironment
  readonly env: Record<string, string>
} | null {
  if (!isUsableAbsolutePath(input.socketPath)) return null
  const readParentPid = input.readParentPid ?? defaultCursorBrokerParentPid
  const isPidAlive = input.isPidAlive ?? defaultCursorBrokerParentPidIsAlive
  let pid = readParentPid(input.startPid)
  for (let depth = 0; depth < CURSOR_BROKER_PARENT_ROUTE_MAX_ANCESTOR_DEPTH; depth += 1) {
    if (pid === null || pid <= 1) return null
    if (isPidAlive(pid)) {
      const recorded = readRecordedRoute(input.socketPath, pid)
      if (recorded) return { ok: true, ...recorded }
    }
    const next = readParentPid(pid)
    if (next === pid) return null
    pid = next
  }
  return null
}

export function attachCursorBrokerParentRouteIfNeeded(
  input: AttachCursorBrokerParentRouteInput
): boolean {
  if (input.provider !== 'cursor') return false
  const extraEnv = input.extraEnv
  if (!extraEnv) return false
  const bind = (pid: number): boolean => {
    try {
      recordCursorBrokerParentRoute({
        pid,
        env: extraEnv,
        socketPath: input.socketPath,
        isPidAlive: input.isPidAlive
      })
    } catch {
      return false
    }
    input.child.once('close', () => {
      releaseCursorBrokerParentRoute({ pid, socketPath: input.socketPath })
    })
    input.child.once('error', () => {
      releaseCursorBrokerParentRoute({ pid, socketPath: input.socketPath })
    })
    return true
  }
  if (typeof input.child.pid === 'number' && input.child.pid > 1) {
    return bind(input.child.pid)
  }
  input.child.once('spawn', () => {
    if (typeof input.child.pid === 'number' && input.child.pid > 1) {
      bind(input.child.pid)
    }
  })
  return false
}

export function execFileCursorMcpBoundToParentRoute(
  input: ExecFileCursorMcpBoundToParentRouteInput
): ChildProcess {
  const launch = input.execFileImpl ?? execFile
  const child = launch(
    input.binaryPath,
    [...input.args],
    {
      cwd: input.cwd,
      timeout: input.timeout,
      env: { ...process.env, ...input.env, ...input.routeEnv }
    },
    (error, stdout, stderr) => {
      input.callback(
        error instanceof Error ? error : error ? new Error(String(error)) : null,
        String(stdout || ''),
        String(stderr || '')
      )
    }
  )
  attachCursorBrokerParentRouteIfNeeded({
    provider: 'cursor',
    child,
    extraEnv: input.routeEnv,
    socketPath: input.socketPath,
    isPidAlive: input.isPidAlive
  })
  return child
}
