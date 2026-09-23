import { execFile as nodeExecFile, execFileSync as nodeExecFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync as nodeReadFileSync } from 'node:fs'
import { readFile as nodeReadFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Electron-free process birth identity.
 *
 * A pid alone is reused by the operating system, so every "is this still the
 * Host I mean" decision (authority-lease reclaim, verified termination,
 * stop-all, the registry sweep) binds the pid to the moment the process was
 * born and compares that pair. The raw birth fact per platform:
 *
 *   darwin  `/bin/ps -o stat=,lstart= -p <pid>` under `LC_ALL=C TZ=UTC`
 *           (lstart is strftime `%c`, so both the locale and the zone must be
 *           pinned or two observers of one process disagree)
 *   linux   `/proc/sys/kernel/random/boot_id` + `/proc/<pid>/stat` field 22
 *           (start ticks since boot; the comm field can hold spaces, so the
 *           line is scanned from its last `)`)
 *   win32   the fixed system PowerShell reading `StartTime.ToUniversalTime().Ticks`
 *
 * The published identity is `sha256(platform NUL pid NUL raw)` as lowercase
 * hex, so it satisfies the authority lease's identity pattern (the raw
 * lstart string contains spaces and would not). An identity that cannot be
 * observed is reported as `identity_unavailable` and never degrades to
 * pid-only liveness: callers that would signal a process refuse instead.
 *
 * A zombie (exited, not yet reaped by a parent that is blocked or wedged)
 * is `dead`: it still answers `kill(pid, 0)` and keeps its start time, but it
 * holds no socket, lease or file and its command line is gone, so reading it
 * as alive would turn a Host that stopped cleanly into a refusal.
 *
 * The same recipe as main's WorkspaceLockProcessIdentity minus the Swift
 * bridge daemon, which is why this module can live in host-runtime. The two
 * digests are deliberately not interchangeable (main's carries its own domain
 * prefix and a microsecond darwin start); a cross-check compares start
 * instants, never digests.
 */

export type ProcessBirthObservation =
  | {
      readonly state: 'live'
      readonly birthIdentity: string
      /** Absolute start instant when the platform exposes one; null otherwise. */
      readonly startedAtMs: number | null
    }
  | { readonly state: 'dead' }
  | { readonly state: 'identity_unavailable' }

/**
 * A live process's command line. `argv` is exact where the platform exposes
 * it (linux `/proc/<pid>/cmdline`); elsewhere only the joined line is known.
 */
export type ProcessCommandLineObservation =
  | {
      readonly state: 'live'
      readonly commandLine: string
      readonly argv: readonly string[] | null
    }
  | { readonly state: 'dead' }
  | { readonly state: 'identity_unavailable' }

export interface ProcessCommandLineEntry {
  readonly pid: number
  readonly commandLine: string
}

export type ProcessCommandLineListing =
  | { readonly ok: true; readonly processes: readonly ProcessCommandLineEntry[] }
  | { readonly ok: false; readonly reason: 'unsupported' | 'unavailable' }

export interface ProcessBirthExecOptions {
  /** Absent means the child inherits this process's environment. */
  readonly env?: Readonly<Record<string, string>>
  readonly timeout: number
  readonly windowsHide: boolean
  readonly encoding: 'utf8'
  readonly maxBuffer?: number
}

export interface ProcessBirthIdentitySyncPorts {
  readonly platform: NodeJS.Platform
  readonly execFileSync: (
    file: string,
    args: readonly string[],
    options: ProcessBirthExecOptions
  ) => string
  readonly readFileSync: (path: string, encoding: 'utf8') => string
  readonly processKill: (pid: number, signal: 0) => void
  readonly windowsRoot: string
  readonly clockTicksPerSecond: number
}

export interface ProcessBirthIdentityAsyncPorts {
  readonly platform: NodeJS.Platform
  readonly execFile: (
    file: string,
    args: readonly string[],
    options: ProcessBirthExecOptions
  ) => Promise<string>
  readonly readFile: (path: string, encoding: 'utf8') => Promise<string>
  readonly processKill: (pid: number, signal: 0) => void
  readonly windowsRoot: string
  readonly clockTicksPerSecond: number
}

export const PROCESS_BIRTH_IDENTITY_PATTERN = /^[0-9a-f]{64}$/
/** Exec budget for one `ps` or PowerShell observation. */
export const PROCESS_BIRTH_EXEC_TIMEOUT_MS = 2_000
/** Exec budget for one whole-table `ps` listing (the argv scan). */
export const PROCESS_LISTING_EXEC_TIMEOUT_MS = 10_000
/** A busy machine's full `ps` table easily exceeds execFile's 1 MiB default. */
export const PROCESS_LISTING_MAX_BUFFER_BYTES = 32 * 1024 * 1024
/** `ps` lstart (1 s resolution) and the lease's process.uptime() timestamp agree to about a second. */
export const PROCESS_BIRTH_START_TOLERANCE_MS = 2_000

const PS_EXECUTABLE = '/bin/ps'
const PS_ENVIRONMENT: Readonly<Record<string, string>> = Object.freeze({ LC_ALL: 'C', TZ: 'UTC' })
const LINUX_BOOT_ID_PATH = '/proc/sys/kernel/random/boot_id'
const LINUX_STAT_PATH = '/proc/stat'
const NUL = String.fromCharCode(0)
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** .NET ticks (100 ns) between 0001-01-01 and the Unix epoch. */
const DOTNET_EPOCH_TICKS = 621_355_968_000_000_000n

interface RawBirth {
  readonly raw: string
  readonly startedAtMs: number | null
}

type RawRead =
  | { readonly ok: true; readonly birth: RawBirth }
  | { readonly ok: false; readonly zombie?: true }

const RAW_UNAVAILABLE: RawRead = Object.freeze({ ok: false })
const RAW_ZOMBIE: RawRead = Object.freeze({ ok: false, zombie: true })

function defaultWindowsRoot(): string {
  return process.env.SystemRoot || 'C:\\Windows'
}

const NODE_SYNC_PORTS: ProcessBirthIdentitySyncPorts = {
  platform: process.platform,
  execFileSync: (file, args, options) =>
    String(
      nodeExecFileSync(file, [...args], {
        ...options,
        // stderr is never forwarded: a pid that exits between the existence
        // probe and the read must not print `ps` noise into a Host's log.
        stdio: ['ignore', 'pipe', 'ignore']
      })
    ),
  readFileSync: (path, encoding) => nodeReadFileSync(path, encoding),
  processKill: (pid, signal) => process.kill(pid, signal),
  windowsRoot: defaultWindowsRoot(),
  clockTicksPerSecond: 100
}

const NODE_ASYNC_PORTS: ProcessBirthIdentityAsyncPorts = {
  platform: process.platform,
  execFile: (file, args, options) =>
    new Promise((resolve, reject) => {
      nodeExecFile(file, [...args], options, (error, stdout) => {
        if (error) reject(error)
        else resolve(String(stdout))
      })
    }),
  readFile: (path, encoding) => nodeReadFile(path, encoding),
  processKill: (pid, signal) => process.kill(pid, signal),
  windowsRoot: defaultWindowsRoot(),
  clockTicksPerSecond: 100
}

export function isProcessBirthIdentityDigest(value: unknown): value is string {
  return typeof value === 'string' && PROCESS_BIRTH_IDENTITY_PATTERN.test(value)
}

/** `sha256(platform NUL pid NUL raw)`, lowercase hex. */
export function digestProcessBirth(platform: NodeJS.Platform, pid: number, raw: string): string {
  return createHash('sha256')
    .update([platform, String(pid), raw].join(NUL), 'utf8')
    .digest('hex')
}

/**
 * `ps -o lstart=` under `LC_ALL=C TZ=UTC` prints strftime `%c`, e.g.
 * `Tue Sep 22 13:43:18 2026` (the day is space padded). Anything else is
 * treated as no observation.
 */
export function parsePsLstart(output: string): RawBirth | null {
  const raw = output.trim()
  const match =
    /^([A-Z][a-z]{2}) ([A-Z][a-z]{2}) ( \d|\d{2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/.exec(raw)
  if (!match) return null
  const month = MONTHS.indexOf(match[2])
  if (month < 0) return null
  const day = Number(match[3].trim())
  const startedAtMs = Date.UTC(
    Number(match[7]),
    month,
    day,
    Number(match[4]),
    Number(match[5]),
    Number(match[6])
  )
  if (!Number.isFinite(startedAtMs) || day < 1 || day > 31) return null
  return { raw, startedAtMs }
}

/**
 * `ps -o stat=,lstart=`: the process state flags, then the lstart. A state
 * starting with `Z` is a zombie; the lstart is parsed as by parsePsLstart.
 */
export function parsePsStatLstart(
  output: string
): { readonly zombie: boolean; readonly birth: RawBirth | null } | null {
  const match = /^\s*(\S+)\s+(.*\S)\s*$/.exec(output)
  if (!match) return null
  return { zombie: match[1].startsWith('Z'), birth: parsePsLstart(match[2]) }
}

function procStatFieldsAfterName(stat: string): readonly string[] | null {
  const endName = stat.lastIndexOf(')')
  if (endName < 0) return null
  return stat
    .slice(endName + 2)
    .trim()
    .split(/\s+/)
}

/**
 * proc(5) `/proc/<pid>/stat`: `pid (comm) state ppid ...`. `comm` may contain
 * spaces and parentheses, so the fields are counted from the LAST `)`; field
 * 22 (starttime, clock ticks since boot) is index 19 after that point.
 */
export function parseProcStatStartTicks(stat: string): string | null {
  const ticks = procStatFieldsAfterName(stat)?.[19]
  return ticks !== undefined && /^\d+$/.test(ticks) ? ticks : null
}

/** proc(5) state (field 3): `Z` zombie or `X` dead means the process has exited. */
export function procStatHasExited(stat: string): boolean {
  const state = procStatFieldsAfterName(stat)?.[0]
  return state === 'Z' || state === 'X'
}

export function parseProcStatBootTimeSeconds(stat: string): number | null {
  const match = /(?:^|\n)btime (\d+)(?:\n|$)/.exec(stat)
  return match ? Number(match[1]) : null
}

export function parseWindowsStartTicks(output: string): RawBirth | null {
  const ticks = output.trim()
  if (!/^\d+$/.test(ticks) || ticks === '0') return null
  const startedAtMs = Number((BigInt(ticks) - DOTNET_EPOCH_TICKS) / 10_000n)
  return { raw: ticks, startedAtMs: Number.isSafeInteger(startedAtMs) ? startedAtMs : null }
}

/** `/proc/<pid>/cmdline`: NUL-separated argv with a trailing NUL. */
export function parseProcCmdline(raw: string): readonly string[] | null {
  const argv = raw.split(NUL)
  while (argv.length > 0 && argv[argv.length - 1] === '') argv.pop()
  return argv.length > 0 ? argv : null
}

/** `ps -axo pid=,command=`: one `<pid> <command>` row per process, pid right-aligned. */
export function parsePsProcessTable(output: string): readonly ProcessCommandLineEntry[] {
  const processes: ProcessCommandLineEntry[] = []
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+) (.*\S)\s*$/.exec(line)
    if (!match) continue
    const pid = Number(match[1])
    if (validPid(pid)) processes.push({ pid, commandLine: match[2] })
  }
  return processes
}

function validPid(pid: unknown): pid is number {
  return typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 1
}

function isErrno(error: unknown, code: string): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  )
}

type Existence = 'exists' | 'dead' | 'unavailable'

function probeExistence(processKill: (pid: number, signal: 0) => void, pid: number): Existence {
  try {
    processKill(pid, 0)
    return 'exists'
  } catch (error) {
    // Only ESRCH proves death. EPERM means a process we could never signal
    // anyway (another user's), so its identity is reported unavailable rather
    // than read from ps and later acted on.
    return isErrno(error, 'ESRCH') ? 'dead' : 'unavailable'
  }
}

function powershellPath(windowsRoot: string): string {
  return join(windowsRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

function powershellArgs(script: readonly string[]): readonly string[] {
  return ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script.join('; ')]
}

function powershellStartTicksArgs(pid: number): readonly string[] {
  return powershellArgs([
    '$ErrorActionPreference = "Stop"',
    `$p = Get-Process -Id ${pid}`,
    '[Console]::Out.Write($p.StartTime.ToUniversalTime().Ticks)'
  ])
}

function powershellCommandLineArgs(pid: number): readonly string[] {
  return powershellArgs([
    '$ErrorActionPreference = "Stop"',
    `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"`,
    '[Console]::Out.Write($p.CommandLine)'
  ])
}

/** `ps` runs with a pinned locale and zone and nothing else in its environment. */
function psOptions(timeout = PROCESS_BIRTH_EXEC_TIMEOUT_MS): ProcessBirthExecOptions {
  return { env: PS_ENVIRONMENT, timeout, windowsHide: true, encoding: 'utf8' }
}

/**
 * PowerShell inherits this process's environment, as main's observer does:
 * Windows processes need SystemRoot and friends to start at all.
 */
function powershellOptions(): ProcessBirthExecOptions {
  return { timeout: PROCESS_BIRTH_EXEC_TIMEOUT_MS, windowsHide: true, encoding: 'utf8' }
}

function linuxBirth(
  bootId: string,
  stat: string,
  bootTimeSeconds: number | null,
  clockTicksPerSecond: number
): RawBirth | null {
  const trimmedBootId = bootId.trim()
  const ticks = parseProcStatStartTicks(stat)
  if (!trimmedBootId || !ticks) return null
  const startedAtMs =
    bootTimeSeconds !== null && clockTicksPerSecond > 0
      ? Math.round(bootTimeSeconds * 1_000 + (Number(ticks) * 1_000) / clockTicksPerSecond)
      : null
  return { raw: `${trimmedBootId}:${ticks}`, startedAtMs }
}

/** One `ps` call reads the state (for zombies) and the lstart (the birth) together. */
function psStatLstartArgs(pid: number): readonly string[] {
  return ['-o', 'stat=,lstart=', '-p', String(pid)]
}

function readRawSync(ports: ProcessBirthIdentitySyncPorts, pid: number): RawRead {
  try {
    let birth: RawBirth | null = null
    if (ports.platform === 'darwin') {
      const parsed = parsePsStatLstart(
        ports.execFileSync(PS_EXECUTABLE, psStatLstartArgs(pid), psOptions())
      )
      if (parsed?.zombie) return RAW_ZOMBIE
      birth = parsed?.birth ?? null
    } else if (ports.platform === 'linux') {
      const bootId = ports.readFileSync(LINUX_BOOT_ID_PATH, 'utf8')
      const stat = ports.readFileSync(`/proc/${pid}/stat`, 'utf8')
      if (procStatHasExited(stat)) return RAW_ZOMBIE
      let bootTime: number | null = null
      try {
        bootTime = parseProcStatBootTimeSeconds(ports.readFileSync(LINUX_STAT_PATH, 'utf8'))
      } catch {
        bootTime = null
      }
      birth = linuxBirth(bootId, stat, bootTime, ports.clockTicksPerSecond)
    } else if (ports.platform === 'win32') {
      birth = parseWindowsStartTicks(
        ports.execFileSync(
          powershellPath(ports.windowsRoot),
          powershellStartTicksArgs(pid),
          powershellOptions()
        )
      )
    }
    return birth ? { ok: true, birth } : RAW_UNAVAILABLE
  } catch {
    return RAW_UNAVAILABLE
  }
}

async function readRawAsync(ports: ProcessBirthIdentityAsyncPorts, pid: number): Promise<RawRead> {
  try {
    let birth: RawBirth | null = null
    if (ports.platform === 'darwin') {
      const parsed = parsePsStatLstart(
        await ports.execFile(PS_EXECUTABLE, psStatLstartArgs(pid), psOptions())
      )
      if (parsed?.zombie) return RAW_ZOMBIE
      birth = parsed?.birth ?? null
    } else if (ports.platform === 'linux') {
      const bootId = await ports.readFile(LINUX_BOOT_ID_PATH, 'utf8')
      const stat = await ports.readFile(`/proc/${pid}/stat`, 'utf8')
      if (procStatHasExited(stat)) return RAW_ZOMBIE
      let bootTime: number | null = null
      try {
        bootTime = parseProcStatBootTimeSeconds(await ports.readFile(LINUX_STAT_PATH, 'utf8'))
      } catch {
        bootTime = null
      }
      birth = linuxBirth(bootId, stat, bootTime, ports.clockTicksPerSecond)
    } else if (ports.platform === 'win32') {
      birth = parseWindowsStartTicks(
        await ports.execFile(
          powershellPath(ports.windowsRoot),
          powershellStartTicksArgs(pid),
          powershellOptions()
        )
      )
    }
    return birth ? { ok: true, birth } : RAW_UNAVAILABLE
  } catch {
    return RAW_UNAVAILABLE
  }
}

function classify(
  platform: NodeJS.Platform,
  processKill: (pid: number, signal: 0) => void,
  pid: number,
  read: RawRead
): ProcessBirthObservation {
  if (read.ok) {
    return {
      state: 'live',
      birthIdentity: digestProcessBirth(platform, pid, read.birth.raw),
      startedAtMs: read.birth.startedAtMs
    }
  }
  if (read.zombie) return { state: 'dead' }
  // The platform read failed after the pid existed: either it exited in
  // between (definitely dead now) or the birth is genuinely unobservable.
  return probeExistence(processKill, pid) === 'dead'
    ? { state: 'dead' }
    : { state: 'identity_unavailable' }
}

/** Synchronous observation; used where the caller is synchronous by contract (the authority lease). */
export function observeProcessBirthIdentitySync(
  pid: number,
  ports: Partial<ProcessBirthIdentitySyncPorts> = {}
): ProcessBirthObservation {
  if (!validPid(pid)) return { state: 'identity_unavailable' }
  const resolved: ProcessBirthIdentitySyncPorts = { ...NODE_SYNC_PORTS, ...ports }
  const existence = probeExistence(resolved.processKill, pid)
  if (existence === 'dead') return { state: 'dead' }
  if (existence === 'unavailable') return { state: 'identity_unavailable' }
  return classify(resolved.platform, resolved.processKill, pid, readRawSync(resolved, pid))
}

/** Asynchronous observation for clients that must not block their event loop (termination, stop-all). */
export async function observeProcessBirthIdentity(
  pid: number,
  ports: Partial<ProcessBirthIdentityAsyncPorts> = {}
): Promise<ProcessBirthObservation> {
  if (!validPid(pid)) return { state: 'identity_unavailable' }
  const resolved: ProcessBirthIdentityAsyncPorts = { ...NODE_ASYNC_PORTS, ...ports }
  const existence = probeExistence(resolved.processKill, pid)
  if (existence === 'dead') return { state: 'dead' }
  if (existence === 'unavailable') return { state: 'identity_unavailable' }
  return classify(resolved.platform, resolved.processKill, pid, await readRawAsync(resolved, pid))
}

/**
 * The command line of a live pid, with the same existence rules as the birth
 * observation: ESRCH is `dead`, EPERM or an unreadable line is
 * `identity_unavailable` (a caller that cannot read it must not signal).
 */
export async function observeProcessCommandLine(
  pid: number,
  ports: Partial<ProcessBirthIdentityAsyncPorts> = {}
): Promise<ProcessCommandLineObservation> {
  if (!validPid(pid)) return { state: 'identity_unavailable' }
  const resolved: ProcessBirthIdentityAsyncPorts = { ...NODE_ASYNC_PORTS, ...ports }
  const existence = probeExistence(resolved.processKill, pid)
  if (existence === 'dead') return { state: 'dead' }
  if (existence === 'unavailable') return { state: 'identity_unavailable' }
  try {
    if (resolved.platform === 'linux') {
      const argv = parseProcCmdline(await resolved.readFile(`/proc/${pid}/cmdline`, 'utf8'))
      if (argv) return { state: 'live', commandLine: argv.join(' '), argv }
    } else if (resolved.platform === 'darwin') {
      const line = (
        await resolved.execFile(PS_EXECUTABLE, ['-o', 'command=', '-p', String(pid)], psOptions())
      ).trim()
      if (line) return { state: 'live', commandLine: line, argv: null }
    } else if (resolved.platform === 'win32') {
      const line = (
        await resolved.execFile(
          powershellPath(resolved.windowsRoot),
          powershellCommandLineArgs(pid),
          powershellOptions()
        )
      ).trim()
      if (line) return { state: 'live', commandLine: line, argv: null }
    }
  } catch {
    // Fall through to the existence re-probe below.
  }
  return probeExistence(resolved.processKill, pid) === 'dead'
    ? { state: 'dead' }
    : { state: 'identity_unavailable' }
}

/**
 * Every process's command line, from one `ps -axo pid=,command=` table
 * (darwin and linux). Windows has no equivalent here in this release.
 */
export async function listProcessCommandLines(
  ports: Partial<Pick<ProcessBirthIdentityAsyncPorts, 'platform' | 'execFile'>> = {}
): Promise<ProcessCommandLineListing> {
  const platform = ports.platform ?? NODE_ASYNC_PORTS.platform
  const execFile = ports.execFile ?? NODE_ASYNC_PORTS.execFile
  if (platform !== 'darwin' && platform !== 'linux') return { ok: false, reason: 'unsupported' }
  try {
    const output = await execFile(PS_EXECUTABLE, ['-axo', 'pid=,command='], {
      ...psOptions(PROCESS_LISTING_EXEC_TIMEOUT_MS),
      maxBuffer: PROCESS_LISTING_MAX_BUFFER_BYTES
    })
    return { ok: true, processes: parsePsProcessTable(output) }
  } catch {
    return { ok: false, reason: 'unavailable' }
  }
}

/**
 * Compares an observation against the expectation a Host artefact carries.
 * A digest expectation must match exactly; a legacy record (pre-registry
 * Host, whose lease holds a per-process nonce) is matched by its recorded
 * process start within PROCESS_BIRTH_START_TOLERANCE_MS of the observed one.
 */
export type ProcessBirthMatch = 'match' | 'mismatch' | 'unverifiable'

export function matchProcessBirth(
  observation: ProcessBirthObservation,
  expected: { readonly birthIdentity?: string | null; readonly startedAtMs?: number | null }
): ProcessBirthMatch {
  if (observation.state !== 'live') return 'unverifiable'
  if (isProcessBirthIdentityDigest(expected.birthIdentity)) {
    return expected.birthIdentity === observation.birthIdentity ? 'match' : 'mismatch'
  }
  if (
    typeof expected.startedAtMs === 'number' &&
    Number.isFinite(expected.startedAtMs) &&
    observation.startedAtMs !== null
  ) {
    return Math.abs(observation.startedAtMs - expected.startedAtMs) <=
      PROCESS_BIRTH_START_TOLERANCE_MS
      ? 'match'
      : 'mismatch'
  }
  return 'unverifiable'
}

/**
 * A failed self observation is not retried sooner than this: the failure may
 * have been the full exec timeout, and callers sit on synchronous paths.
 */
export const CURRENT_PROCESS_BIRTH_RETRY_MS = 5_000

export interface CurrentProcessBirthIdentityOptions {
  readonly observe?: () => ProcessBirthObservation
  readonly now?: () => number
  readonly retryMs?: number
}

/**
 * This process's own birth identity, observed on first use (never at module
 * load: Electron main imports the lease module that calls this). A live
 * observation is cached for the process's life; a failure is answered from
 * memory for CURRENT_PROCESS_BIRTH_RETRY_MS and then observed again, so a
 * transient failure neither sticks nor runs a `ps` per call.
 */
export function createCurrentProcessBirthIdentity(
  options: CurrentProcessBirthIdentityOptions = {}
): () => ProcessBirthObservation {
  const observe = options.observe ?? (() => observeProcessBirthIdentitySync(process.pid))
  const now = options.now ?? (() => Date.now())
  const retryMs = options.retryMs ?? CURRENT_PROCESS_BIRTH_RETRY_MS
  let observed: ProcessBirthObservation | null = null
  let failure: { readonly at: number; readonly observation: ProcessBirthObservation } | null = null
  return () => {
    if (observed) return observed
    const at = now()
    if (failure && at >= failure.at && at - failure.at < retryMs) return failure.observation
    const observation = observe()
    if (observation.state === 'live') {
      observed = observation
      failure = null
    } else {
      failure = { at, observation }
    }
    return observation
  }
}

export const currentProcessBirthIdentity: () => ProcessBirthObservation =
  createCurrentProcessBirthIdentity()
