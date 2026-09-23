import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, rmdirSync, unlinkSync, type Stats } from 'node:fs'
import { dirname, posix, win32 } from 'node:path'

import {
  canonicalHostProfilePath,
  hostSocketIsLive,
  readHostRegistryEntry,
  removeHostRegistryEntryForPid,
  resolveHostRegistryRoot
} from '../host-runtime/HostRegistry'
import {
  HostProfileAuthorityLease,
  type HostProfileAuthorityOwnerRecord,
  type HostProfileAuthorityProcessPort
} from '../host-runtime/HostProfileAuthorityLease'
import {
  isProcessBirthIdentityDigest,
  matchProcessBirth,
  observeProcessBirthIdentity,
  observeProcessCommandLine,
  type ProcessBirthObservation,
  type ProcessCommandLineObservation
} from '../host-runtime/ProcessBirthIdentity'
import {
  HOST_LOCAL_CONTROL_MAX_DISCOVERY_BYTES,
  readPrivateLocalControlArtifact
} from '../shared/hostLocalControlArtifacts.node'
import {
  decodeTaskWraithHostDiscovery,
  taskWraithHostAuthorityLeasePath,
  taskWraithHostDiscoveryPath,
  taskWraithHostSocketPath,
  taskWraithHostTokenPath
} from '../shared/taskWraithHostPaths.node'
import { HostShutdownClient } from './HostShutdownClient'

/**
 * Verified termination of one production Host, by profile.
 *
 * Order: authenticated socket stop (ACK budget, then a drain budget for the
 * Host to remove its ownership artefacts, the authority lease last) → read the
 * pid evidence (discovery, authority lease, registry entry) → observe the
 * pid's birth identity → confirm the pid runs `host-runtime/cli.js serve` for
 * this profile → SIGTERM → SIGKILL, re-verifying birth and command line
 * immediately before every signal.
 *
 * Refusals, all without a signal:
 *  - the evidence names more than one pid (`inconsistent`);
 *  - the birth identity or the command line cannot be observed
 *    (`identity_unavailable`; the caller may only retry the socket path);
 *  - the evidence carries no birth to compare with (`unverifiable`);
 *  - the pid is alive with the recorded birth but is not a Host serving this
 *    profile (`not_a_host`) — the in-process lane records Electron main's pid
 *    in the discovery and the authority lease, and it is never signalled.
 *
 * A pid born at another time is a reused pid: the Host is already gone and
 * only its artefacts are swept (`pid_reused`), and an identity that changes
 * between TERM and KILL aborts the escalation the same way. After death the
 * socket file and directory, discovery, token, lease and registry entry are
 * removed — each only while it still names the dead Host, and the profile-side
 * artefacts only while no successor holds the profile's authority lease — so
 * the next launch neither waits on a stale socket nor loses a successor's
 * state.
 *
 * Electron-free: shared by Electron main, the TUI, `cli.js stop-all` and the
 * build script.
 */

export const HOST_TERMINATION_ACK_MS = 10_000
export const HOST_TERMINATION_DRAIN_MS = 45_000
export const HOST_TERMINATION_TERM_MS = 30_000
export const HOST_TERMINATION_KILL_MS = 10_000
export const HOST_TERMINATION_POLL_MS = 250
/**
 * After the socket stop returns (the lease, released last in the Host's
 * cleanup, is already gone) the process itself is expected to exit within this.
 */
export const HOST_TERMINATION_EXIT_MS = 5_000

export interface HostTerminationTimings {
  readonly ackMs: number
  readonly drainMs: number
  readonly termMs: number
  readonly killMs: number
  readonly pollMs: number
  readonly exitMs: number
}

export const DEFAULT_HOST_TERMINATION_TIMINGS: HostTerminationTimings = Object.freeze({
  ackMs: HOST_TERMINATION_ACK_MS,
  drainMs: HOST_TERMINATION_DRAIN_MS,
  termMs: HOST_TERMINATION_TERM_MS,
  killMs: HOST_TERMINATION_KILL_MS,
  pollMs: HOST_TERMINATION_POLL_MS,
  exitMs: HOST_TERMINATION_EXIT_MS
})

export interface HostTerminationLeaseEvidence {
  readonly pid: number
  readonly processStartIdentity: string
  readonly processStartedAt: string
  readonly acquiredAt: string
}

export interface HostTerminationEvidence {
  readonly discovery: {
    readonly pid: number
    readonly socketPath: string
    readonly startedAt: string
  } | null
  readonly lease: HostTerminationLeaseEvidence | null
  readonly registry: {
    readonly pid: number
    readonly birthIdentity: string | null
    readonly bootEpoch: string | null
  } | null
}

export interface HostTerminationExpectation {
  readonly birthIdentity?: string | null
  readonly startedAtMs?: number | null
}

export type HostTerminationSignal = 'SIGTERM' | 'SIGKILL'

export interface HostTerminationPorts {
  shutdown(
    profilePath: string,
    budgets: { readonly ackMs: number; readonly drainMs: number }
  ): Promise<'stopping' | 'already_stopping'>
  readEvidence(profilePath: string, registryRoot: string): HostTerminationEvidence
  observe(pid: number): Promise<ProcessBirthObservation>
  observeCommand(pid: number): Promise<ProcessCommandLineObservation>
  signal(pid: number, signal: HostTerminationSignal): void
  sweep(profilePath: string, pid: number | null, registryRoot: string): Promise<readonly string[]>
  delay(ms: number): Promise<void>
  now(): number
  log?(line: string): void
}

export type HostTerminationOutcomeKind =
  | 'stopped'
  | 'already_gone'
  | 'terminated'
  | 'killed'
  | 'identity_unavailable'
  | 'unverifiable'
  | 'not_a_host'
  | 'pid_reused'
  | 'inconsistent'
  | 'failed'

export interface HostTerminationOutcome {
  readonly kind: HostTerminationOutcomeKind
  readonly pid: number | null
  /** Every stage taken, in order, for the caller's log line. */
  readonly steps: readonly string[]
  /** Artefacts removed after the Host was proven gone. */
  readonly swept: readonly string[]
  readonly detail?: string
}

/** Outcomes after which the Host is proven gone (or never ran). */
export const HOST_TERMINATION_SUCCESS_KINDS: ReadonlySet<HostTerminationOutcomeKind> = new Set([
  'stopped',
  'already_gone',
  'terminated',
  'killed',
  'pid_reused'
])

export interface HostTerminationInput {
  readonly profilePath: string
  readonly registryRoot?: string
  readonly platform?: NodeJS.Platform
  readonly timings?: Partial<HostTerminationTimings>
  readonly ports?: Partial<HostTerminationPorts>
}

/** A peek port that reads the owner record without observing anything. */
const INERT_LEASE_PORT: HostProfileAuthorityProcessPort = {
  current: {
    pid: 1,
    processStartIdentity: 'host-termination-inert-port',
    processStartedAt: new Date(0).toISOString()
  },
  inspectOwner: () => 'unknown'
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function readLeaseOwner(profilePath: string): HostProfileAuthorityOwnerRecord | null {
  try {
    const peek = HostProfileAuthorityLease.peek({ profilePath, processPort: INERT_LEASE_PORT })
    return peek.kind === 'live' || peek.kind === 'stale' || peek.kind === 'unknown'
      ? peek.owner
      : null
  } catch {
    return null
  }
}

function readDiscovery(profilePath: string): HostTerminationEvidence['discovery'] {
  try {
    const decoded = decodeTaskWraithHostDiscovery(
      JSON.parse(
        readPrivateLocalControlArtifact(
          taskWraithHostDiscoveryPath(profilePath),
          HOST_LOCAL_CONTROL_MAX_DISCOVERY_BYTES
        )
      )
    )
    return decoded.ok
      ? {
          pid: decoded.discovery.pid,
          socketPath: decoded.discovery.socketPath,
          startedAt: decoded.discovery.startedAt
        }
      : null
  } catch {
    return null
  }
}

export function readHostTerminationEvidence(
  profilePath: string,
  registryRoot: string
): HostTerminationEvidence {
  const owner = readLeaseOwner(profilePath)
  const entry = readHostRegistryEntry(registryRoot, profilePath)
  return {
    discovery: readDiscovery(profilePath),
    // The owner token is capability material and never leaves the lease reader.
    lease: owner
      ? {
          pid: owner.pid,
          processStartIdentity: owner.processStartIdentity,
          processStartedAt: owner.processStartedAt,
          acquiredAt: owner.acquiredAt
        }
      : null,
    registry:
      entry.kind === 'present'
        ? {
            pid: entry.entry.pid,
            birthIdentity: entry.entry.birthIdentity,
            bootEpoch: entry.entry.bootEpoch
          }
        : null
  }
}

/** The single pid the evidence names, or null when it names none or several. */
export function hostTerminationTargetPid(evidence: HostTerminationEvidence): {
  readonly pid: number | null
  readonly inconsistent: boolean
} {
  const pids = new Set<number>()
  if (evidence.registry) pids.add(evidence.registry.pid)
  if (evidence.lease) pids.add(evidence.lease.pid)
  if (evidence.discovery) pids.add(evidence.discovery.pid)
  if (pids.size > 1) return { pid: null, inconsistent: true }
  const [pid] = pids
  return { pid: pid ?? null, inconsistent: false }
}

/**
 * What a signal must be verified against: the registry's birth identity, else
 * the lease's (when it is a digest), else the lease's recorded process start
 * (a pre-registry Host's nonce cannot be re-derived, but its start instant,
 * taken from process.uptime(), can be compared with the observed one).
 * Discovery's `startedAt` is the listener start, seconds after the process
 * start, so it is never used for this.
 */
export function hostTerminationExpectation(
  evidence: HostTerminationEvidence
): HostTerminationExpectation {
  if (evidence.registry?.birthIdentity) return { birthIdentity: evidence.registry.birthIdentity }
  if (evidence.lease && isProcessBirthIdentityDigest(evidence.lease.processStartIdentity)) {
    return { birthIdentity: evidence.lease.processStartIdentity }
  }
  if (evidence.lease) {
    const startedAtMs = Date.parse(evidence.lease.processStartedAt)
    return Number.isFinite(startedAtMs) ? { startedAtMs } : {}
  }
  return {}
}

export interface HostServeCommand {
  /** The `…/host-runtime/cli.js` path when it can be isolated; null otherwise. */
  readonly cliPath: string | null
  readonly profilePath: string
}

const CLI_SUFFIX = /(^|[\\/])host-runtime[\\/]cli\.js$/

function profileFromJoinedLine(rest: string): string | null {
  const trimmed = rest.trimStart()
  if (!trimmed) return null
  if (trimmed.startsWith('"')) {
    const close = trimmed.indexOf('"', 1)
    return close > 1 ? trimmed.slice(1, close) : null
  }
  const nextFlag = trimmed.search(/ --[A-Za-z]/)
  const value = (nextFlag >= 0 ? trimmed.slice(0, nextFlag) : trimmed).trimEnd()
  return value || null
}

/**
 * Recognises a Host serve command line: `<node> …/host-runtime/cli.js serve
 * … --profile <path> …`. With an exact argv (linux) every token is exact; with
 * only the joined line (darwin `ps`, Windows CIM) the profile runs to the next
 * ` --flag` or the end (both launchers put `--profile` last), or between
 * quotes on Windows.
 */
export function parseHostServeCommandLine(
  commandLine: string,
  argv: readonly string[] | null = null
): HostServeCommand | null {
  if (argv) {
    const cliIndex = argv.findIndex((token) => CLI_SUFFIX.test(token))
    if (cliIndex < 0 || argv[cliIndex + 1] !== 'serve') return null
    const profileIndex = argv.indexOf('--profile', cliIndex + 2)
    const profilePath = profileIndex >= 0 ? argv[profileIndex + 1] : undefined
    return profilePath ? { cliPath: argv[cliIndex], profilePath } : null
  }
  const serve = /host-runtime[\\/]cli\.js"?\s+serve(?:\s|$)/.exec(commandLine)
  if (!serve) return null
  const afterServe = commandLine.slice(serve.index + serve[0].length)
  const profileFlag = /(?:^|\s)--profile(?:\s+|=)/.exec(afterServe)
  if (!profileFlag) return null
  const profilePath = profileFromJoinedLine(
    afterServe.slice(profileFlag.index + profileFlag[0].length)
  )
  if (!profilePath) return null
  // The match starts at `host-runtime`; the path runs back to its opening
  // quote (Windows) or to the ` /` that starts an absolute POSIX path. The
  // result is for display: payload-root filtering never relies on it.
  const cliEnd = serve.index + 'host-runtime/cli.js'.length
  const head = commandLine.slice(0, cliEnd)
  const start =
    commandLine[cliEnd] === '"'
      ? head.lastIndexOf('"') + 1
      : head.startsWith('/') && !head.includes(' /')
        ? 0
        : head.lastIndexOf(' /') >= 0
          ? head.lastIndexOf(' /') + 1
          : head.lastIndexOf(' ') + 1
  return { cliPath: head.slice(start) || null, profilePath }
}

function sameProfile(left: string, right: string, platform: NodeJS.Platform): boolean {
  const path = platform === 'win32' ? win32 : posix
  const normalize = (value: string): string => {
    const canonical = canonicalHostProfilePath(path.resolve(value))
    return platform === 'win32' ? canonical.toLowerCase() : canonical
  }
  return normalize(left) === normalize(right)
}

/** Whether an observed command line is a Host serving exactly this profile. */
export function isHostServeCommandFor(
  observation: ProcessCommandLineObservation,
  profilePath: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  if (observation.state !== 'live') return false
  const parsed = parseHostServeCommandLine(observation.commandLine, observation.argv)
  return parsed !== null && sameProfile(parsed.profilePath, profilePath, platform)
}

function defaultSignal(platform: NodeJS.Platform): HostTerminationPorts['signal'] {
  return (pid, signal) => {
    if (platform === 'win32') {
      // No SIGTERM on Windows; both stages are the tree kill the smoke script uses.
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true
      })
      return
    }
    try {
      process.kill(pid, signal)
    } catch {
      // ESRCH: already gone; the poll that follows observes it.
    }
  }
}

function sameStatIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

/** Unlink `path` only while the file judged by `still` is the one at the path. */
function unlinkIfStill(path: string, still: () => boolean): boolean {
  let before: Stats
  try {
    before = lstatSync(path)
  } catch {
    return false
  }
  if (!still()) return false
  try {
    if (!sameStatIdentity(before, lstatSync(path))) return false
    unlinkSync(path)
    return true
  } catch {
    return false
  }
}

/**
 * Removes the artefacts that still name `pid` — discovery + token, the
 * authority lease, the socket file and its directory, and the registry entry.
 * The profile-side artefacts are left alone while the lease names another
 * owner: a successor has taken the profile and they are its artefacts now.
 * With no pid only a dead socket is removed, and only with no lease owner.
 */
export async function sweepHostArtefacts(
  profilePath: string,
  pid: number | null,
  registryRoot: string,
  options: {
    readonly platform?: NodeJS.Platform
    readonly socketIsLive?: (socketPath: string) => Promise<boolean>
  } = {}
): Promise<readonly string[]> {
  const platform = options.platform ?? process.platform
  const socketIsLive = options.socketIsLive ?? hostSocketIsLive
  const removed: string[] = []
  const owner = readLeaseOwner(profilePath)
  const successorHoldsProfile = owner !== null && (pid === null || owner.pid !== pid)
  if (pid !== null) {
    try {
      if (removeHostRegistryEntryForPid(registryRoot, profilePath, pid)) removed.push('registry')
    } catch {
      // A registry that cannot be written is swept by the next stop-all --sweep.
    }
  }
  if (successorHoldsProfile) return removed

  if (pid !== null) {
    const discoveryPath = taskWraithHostDiscoveryPath(profilePath)
    const discovery = readDiscovery(profilePath)
    if (discovery?.pid === pid) {
      if (unlinkIfStill(discoveryPath, () => readDiscovery(profilePath)?.pid === pid)) {
        removed.push('discovery')
      }
    }
    // The token carries no pid; it is removed once no discovery names a live Host.
    if (!existsSync(discoveryPath)) {
      const tokenPath = taskWraithHostTokenPath(profilePath)
      if (unlinkIfStill(tokenPath, () => !existsSync(discoveryPath))) removed.push('token')
    }
    if (owner && owner.pid === pid) {
      const leasePath = taskWraithHostAuthorityLeasePath(profilePath)
      const still = (): boolean => {
        const current = readLeaseOwner(profilePath)
        return (
          current !== null &&
          current.pid === owner.pid &&
          current.processStartIdentity === owner.processStartIdentity &&
          current.acquiredAt === owner.acquiredAt
        )
      }
      if (unlinkIfStill(leasePath, still)) removed.push('lease')
    }
  }
  if (platform !== 'win32') {
    const socketPath = taskWraithHostSocketPath(profilePath, platform)
    if (existsSync(socketPath) && !(await socketIsLive(socketPath))) {
      try {
        unlinkSync(socketPath)
        removed.push('socket')
      } catch {
        // Already gone.
      }
    }
    if (!existsSync(socketPath)) {
      try {
        rmdirSync(dirname(socketPath))
        removed.push('socket-directory')
      } catch {
        // Absent, or not ours to empty.
      }
    }
  }
  return removed
}

function defaultPorts(platform: NodeJS.Platform): HostTerminationPorts {
  return {
    shutdown: (profilePath, budgets) =>
      new HostShutdownClient({
        profilePath,
        timeoutMs: budgets.ackMs,
        removalTimeoutMs: budgets.drainMs
      }).shutdown(),
    readEvidence: readHostTerminationEvidence,
    observe: (pid) => observeProcessBirthIdentity(pid),
    observeCommand: (pid) => observeProcessCommandLine(pid),
    signal: defaultSignal(platform),
    sweep: (profilePath, pid, registryRoot) =>
      sweepHostArtefacts(profilePath, pid, registryRoot, { platform }),
    delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now()
  }
}

type Verdict = 'match' | 'dead' | 'mismatch' | 'unavailable' | 'unverifiable'
type SignalVerdict = Verdict | 'not_a_host'

async function verify(
  ports: HostTerminationPorts,
  pid: number,
  expected: HostTerminationExpectation
): Promise<Verdict> {
  const observation = await ports.observe(pid)
  if (observation.state === 'dead') return 'dead'
  if (observation.state === 'identity_unavailable') return 'unavailable'
  return matchProcessBirth(observation, expected)
}

/** The check that gates every signal: same birth, and a Host serving this profile. */
async function verifyForSignal(
  ports: HostTerminationPorts,
  pid: number,
  expected: HostTerminationExpectation,
  profilePath: string,
  platform: NodeJS.Platform
): Promise<SignalVerdict> {
  const birth = await verify(ports, pid, expected)
  if (birth !== 'match') return birth
  const command = await ports.observeCommand(pid)
  if (command.state === 'dead') return 'dead'
  if (command.state === 'identity_unavailable') return 'unavailable'
  return isHostServeCommandFor(command, profilePath, platform) ? 'match' : 'not_a_host'
}

async function pollUntilGone(
  ports: HostTerminationPorts,
  pid: number,
  expected: HostTerminationExpectation,
  budgetMs: number,
  pollMs: number
): Promise<'dead' | 'mismatch' | 'alive' | 'unavailable'> {
  const deadline = ports.now() + budgetMs
  let unavailable = false
  while (ports.now() < deadline) {
    await ports.delay(Math.max(1, Math.min(pollMs, deadline - ports.now())))
    const verdict = await verify(ports, pid, expected)
    if (verdict === 'dead') return 'dead'
    if (verdict === 'mismatch') return 'mismatch'
    unavailable = verdict === 'unavailable'
  }
  return unavailable ? 'unavailable' : 'alive'
}

export async function terminateHostProcess(
  input: HostTerminationInput
): Promise<HostTerminationOutcome> {
  const platform = input.platform ?? process.platform
  const timings: HostTerminationTimings = { ...DEFAULT_HOST_TERMINATION_TIMINGS, ...input.timings }
  const ports: HostTerminationPorts = { ...defaultPorts(platform), ...input.ports }
  const registryRoot = input.registryRoot ?? resolveHostRegistryRoot()
  const profilePath = canonicalHostProfilePath(input.profilePath)
  const steps: string[] = []
  const log = (line: string): void => ports.log?.(`[host-termination] ${profilePath}: ${line}`)

  const before = ports.readEvidence(profilePath, registryRoot)
  const target = hostTerminationTargetPid(before)
  if (target.inconsistent) {
    log('evidence names more than one pid; refusing to signal')
    return { kind: 'inconsistent', pid: null, steps: ['evidence:inconsistent'], swept: [] }
  }
  const pid = target.pid
  const expected = hostTerminationExpectation(before)

  const finish = async (
    kind: HostTerminationOutcomeKind,
    sweep: boolean,
    detail?: string
  ): Promise<HostTerminationOutcome> => {
    const swept = sweep ? await ports.sweep(profilePath, pid, registryRoot) : []
    if (swept.length) steps.push(`swept:${swept.join(',')}`)
    log(`${kind}${detail ? ` (${detail})` : ''} after ${steps.join(' -> ') || 'no steps'}`)
    return { kind, pid, steps, swept, ...(detail ? { detail } : {}) }
  }

  if (!before.discovery && !before.lease && !before.registry) {
    steps.push('evidence:none')
    return finish('already_gone', true)
  }

  // 1. The Host's own graceful path. With neither discovery nor a lease in the
  // profile (only a registry entry names the pid) there is no socket to ask.
  if (before.discovery || before.lease) {
    try {
      const state = await ports.shutdown(profilePath, {
        ackMs: timings.ackMs,
        drainMs: timings.drainMs
      })
      steps.push(`socket:${state}`)
      if (pid === null) return finish('stopped', true)
      const gone = await pollUntilGone(ports, pid, expected, timings.exitMs, timings.pollMs)
      if (gone === 'dead') return finish('stopped', true)
      if (gone === 'mismatch') return finish('stopped', true, 'pid reused after exit')
      if (gone === 'unavailable') return finish('identity_unavailable', false, 'after socket stop')
      steps.push('socket:process-lingering')
    } catch (error) {
      steps.push(`socket:failed:${describe(error)}`)
    }
  } else {
    steps.push('socket:skipped')
  }

  // 2. Verified fallback: SIGTERM (the Host's own graceful path), verified
  // immediately before.
  if (pid === null) return finish('unverifiable', false, 'no pid evidence')

  const beforeTerm = await verifyForSignal(ports, pid, expected, profilePath, platform)
  steps.push(`verify:${beforeTerm}`)
  if (beforeTerm === 'dead') return finish('already_gone', true)
  if (beforeTerm === 'mismatch') return finish('pid_reused', true)
  if (beforeTerm === 'unavailable') return finish('identity_unavailable', false)
  if (beforeTerm === 'unverifiable') return finish('unverifiable', false, 'no birth evidence')
  if (beforeTerm === 'not_a_host') return finish('not_a_host', false)
  ports.signal(pid, 'SIGTERM')
  steps.push('signal:SIGTERM')
  const afterTerm = await pollUntilGone(ports, pid, expected, timings.termMs, timings.pollMs)
  if (afterTerm === 'dead') return finish('terminated', true)
  if (afterTerm === 'mismatch') return finish('pid_reused', true, 'identity changed after SIGTERM')
  if (afterTerm === 'unavailable') return finish('identity_unavailable', false, 'after SIGTERM')

  // 3. SIGKILL, re-verified immediately before.
  const beforeKill = await verifyForSignal(ports, pid, expected, profilePath, platform)
  if (beforeKill !== 'match') {
    steps.push(`verify:${beforeKill}`)
    if (beforeKill === 'dead') return finish('terminated', true)
    if (beforeKill === 'mismatch')
      return finish('pid_reused', true, 'identity changed before SIGKILL')
    if (beforeKill === 'not_a_host') return finish('not_a_host', false, 'before SIGKILL')
    return finish('identity_unavailable', false, 'before SIGKILL')
  }
  ports.signal(pid, 'SIGKILL')
  steps.push('signal:SIGKILL')
  const afterKill = await pollUntilGone(ports, pid, expected, timings.killMs, timings.pollMs)
  if (afterKill === 'dead') return finish('killed', true)
  if (afterKill === 'mismatch') return finish('pid_reused', true, 'identity changed after SIGKILL')
  if (afterKill === 'unavailable') return finish('identity_unavailable', false, 'after SIGKILL')
  return finish('failed', false, 'process survived SIGKILL')
}
