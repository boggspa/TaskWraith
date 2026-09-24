import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, rmdirSync, unlinkSync, type Stats } from 'node:fs'
import { dirname, posix, win32 } from 'node:path'

import {
  canonicalHostProfilePath,
  hostRegistryEntryPath,
  hostSocketIsLive,
  readHostRegistryEntry,
  removeHostRegistryEntryFor,
  resolveHostRegistryRoot,
  unlinkDeadHostSocket
} from '../host-runtime/HostRegistry'
import {
  HostProfileAuthorityLease,
  type HostProfileAuthorityOwnerRecord,
  type HostProfileAuthorityProcessPort
} from '../host-runtime/HostProfileAuthorityLease'
import {
  PROCESS_BIRTH_START_TOLERANCE_MS,
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
 *  - the evidence names more than one pid, or two birth digests for one pid,
 *    and observing each pid cannot prove every disagreeing record stale
 *    (`inconsistent`). A registry digest beside a legacy (nonce) lease is
 *    resolved the same way: each record is judged by its own birth;
 *  - the birth identity or the command line cannot be observed
 *    (`identity_unavailable`; the caller may only retry the socket path);
 *  - the evidence carries no birth to compare with (`unverifiable`);
 *  - the pid is alive with the recorded birth but is not a Host serving this
 *    profile (`not_a_host`) — the in-process lane records Electron main's pid
 *    in the discovery and the authority lease, and it is never signalled.
 *
 * A pid born at another time is a reused pid: the Host is already gone and
 * only its artefacts are swept (`pid_reused`), and an identity that changes
 * between TERM and KILL aborts the escalation the same way. When a fresh
 * observation of that pid still contradicts none of the birth one record
 * carries, the records disagree about whose pid it is: that is refused as
 * `inconsistent`, and nothing is swept. The refusal names each such record's
 * file: only that process's exit can prove a registry entry that recorded no
 * birth stale, so an operator who confirms the process is neither this
 * profile's Host nor the TaskWraith app removes the file and stops again.
 * After death the socket file and directory, discovery, token, lease and
 * registry entry are removed — each only while it still carries exactly the
 * record read before termination (never by pid alone: a successor may have
 * been handed the same pid), only once that record is proven stale (its pid
 * is dead, or the process now at that pid contradicts the record's own
 * birth), and the profile-side artefacts only while no other owner holds the
 * profile's authority lease — so the next launch neither waits on a stale
 * socket nor loses a successor's or a live owner's state.
 *
 * All of the above acts on whichever Host the profile's records name when
 * termination runs. A caller that selected one Host (`stop-all
 * --payload-root`) passes it as `expected`. Once the evidence is resolved,
 * and before the socket stop (which reaches whichever Host serves the
 * profile) or any signal, the records must name that Host's pid, and that
 * pid must be observed alive with that Host's birth, which the records do not
 * contradict; only when it cannot be observed do the records stand in, and
 * then they must carry that very birth digest. Every later observation
 * re-checks the birth. Otherwise nothing is stopped or signalled: the
 * expected Host proven gone is `already_gone` (its pid is dead) or
 * `pid_reused` (another process has it), and only records naming its pid
 * are swept, each once proven stale; anything else is refused. Another Host
 * the records name instead is reported in `heldBy` and left alone, and its
 * records are never offered to an operator as ones to remove.
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

/**
 * One Host by pid and birth: a birth digest, else a process start matched
 * within PROCESS_BIRTH_START_TOLERANCE_MS. See HostTerminationInput.expected.
 */
export interface HostTerminationExpectedHost extends HostTerminationExpectation {
  readonly pid: number
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
  /**
   * Removes the artefacts that still carry exactly one of `dead`'s records:
   * every record in it is proven stale.
   */
  sweep(
    profilePath: string,
    dead: HostTerminationEvidence,
    registryRoot: string
  ): Promise<readonly string[]>
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
  /**
   * With `expected` only: the pid of another Host the profile's records name
   * now, when termination did not act because it is not the expected Host.
   * Nothing of that Host is stopped, signalled or swept.
   */
  readonly heldBy?: number
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
  /**
   * The only Host termination may act on. Without it, termination acts on
   * whichever Host the profile's records name when it runs (`stop-all
   * --profile`). With it, before the socket stop or any signal, the resolved
   * records must name this pid and the pid must be observed alive with this
   * birth (records carrying this very birth digest stand in only when it
   * cannot be observed); every later observation re-checks the birth.
   * Otherwise nothing is stopped or signalled: a Host proven gone is
   * `already_gone` (dead) or `pid_reused`, with only records naming its pid
   * swept, each once proven stale, and anything else is refused. Another Host
   * the records name is reported in `heldBy`, and every outcome reports this
   * Host's pid.
   */
  readonly expected?: HostTerminationExpectedHost
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

/**
 * The single pid the evidence names, or null when it names none. It is
 * inconsistent when it names several pids, or when the registry and the lease
 * both carry a birth digest and the digests differ: neither may then decide
 * alone which process is the Host.
 */
export function hostTerminationTargetPid(evidence: HostTerminationEvidence): {
  readonly pid: number | null
  readonly inconsistent: boolean
} {
  const pids = new Set<number>()
  if (evidence.registry) pids.add(evidence.registry.pid)
  if (evidence.lease) pids.add(evidence.lease.pid)
  if (evidence.discovery) pids.add(evidence.discovery.pid)
  if (pids.size > 1) return { pid: null, inconsistent: true }
  const registryBirth = evidence.registry?.birthIdentity
  const leaseBirth = evidence.lease?.processStartIdentity
  if (
    isProcessBirthIdentityDigest(registryBirth) &&
    isProcessBirthIdentityDigest(leaseBirth) &&
    registryBirth !== leaseBirth
  ) {
    return { pid: null, inconsistent: true }
  }
  const [pid] = pids
  return { pid: pid ?? null, inconsistent: false }
}

function leaseExpectation(lease: HostTerminationLeaseEvidence): HostTerminationExpectation {
  if (isProcessBirthIdentityDigest(lease.processStartIdentity)) {
    return { birthIdentity: lease.processStartIdentity }
  }
  const startedAtMs = Date.parse(lease.processStartedAt)
  return Number.isFinite(startedAtMs) ? { startedAtMs } : {}
}

type HostTerminationRecord = 'registry' | 'lease' | 'discovery'

const RECORDS: readonly HostTerminationRecord[] = ['registry', 'lease', 'discovery']

const RECORD_NOUNS: Readonly<Record<HostTerminationRecord, string>> = {
  registry: 'registry entry',
  lease: 'authority lease',
  discovery: 'discovery'
}

function recordFile(
  record: HostTerminationRecord,
  profilePath: string,
  registryRoot: string
): string {
  if (record === 'registry') return hostRegistryEntryPath(registryRoot, profilePath)
  return record === 'lease'
    ? taskWraithHostAuthorityLeasePath(profilePath)
    : taskWraithHostDiscoveryPath(profilePath)
}

/**
 * Why a reused pid is refused, and how an operator clears it: each record the
 * process now at the pid cannot contradict, by file. The in-process lane
 * records the TaskWraith app's own pid, so the app is excluded as well.
 */
function survivorRefusal(
  pid: number,
  survivors: readonly HostTerminationRecord[],
  profilePath: string,
  registryRoot: string
): string {
  const named = survivors
    .map((record) => `the ${RECORD_NOUNS[record]} ${recordFile(record, profilePath, registryRoot)}`)
    .join(' and ')
  const files = survivors.length === 1 ? 'that file' : 'those files'
  return (
    `a record naming the pid is not contradicted by the process now at it: ${named}. ` +
    `If pid ${pid} is neither this profile's Host (host-runtime/cli.js serve --profile ` +
    `${profilePath}) nor the TaskWraith app, remove ${files} and stop again`
  )
}

const NO_EVIDENCE: HostTerminationEvidence = Object.freeze({
  discovery: null,
  lease: null,
  registry: null
})

/** Only the records that name `pid`: with an expected Host, nothing else is swept. */
function recordsNaming(evidence: HostTerminationEvidence, pid: number): HostTerminationEvidence {
  return {
    registry: evidence.registry?.pid === pid ? evidence.registry : null,
    lease: evidence.lease?.pid === pid ? evidence.lease : null,
    discovery: evidence.discovery?.pid === pid ? evidence.discovery : null
  }
}

/**
 * Whether an observation of the pid a record names proves that record stale.
 * A dead pid proves every record stale. A live process proves stale only what
 * contradicts the record's own birth: a registry or lease digest it does not
 * carry, a legacy lease whose recorded start is more than
 * PROCESS_BIRTH_START_TOLERANCE_MS from its start, or a discovery written
 * before it started (a Host's listener starts after its process). A registry
 * entry that recorded no birth is proven stale only by death, and nothing is
 * proven by an observation that failed.
 */
function recordIsStale(
  evidence: HostTerminationEvidence,
  record: HostTerminationRecord,
  observation: ProcessBirthObservation
): boolean {
  if (observation.state === 'dead') return true
  if (observation.state !== 'live') return false
  if (record === 'registry') {
    const birthIdentity = evidence.registry?.birthIdentity
    return (
      isProcessBirthIdentityDigest(birthIdentity) &&
      matchProcessBirth(observation, { birthIdentity }) === 'mismatch'
    )
  }
  if (record === 'lease') {
    return (
      evidence.lease !== null &&
      matchProcessBirth(observation, leaseExpectation(evidence.lease)) === 'mismatch'
    )
  }
  const writtenAt = evidence.discovery ? Date.parse(evidence.discovery.startedAt) : Number.NaN
  return (
    observation.startedAtMs !== null &&
    Number.isFinite(writtenAt) &&
    writtenAt < observation.startedAtMs - PROCESS_BIRTH_START_TOLERANCE_MS
  )
}

/**
 * A registry birth digest beside a legacy (nonce) lease. The two carry
 * different kinds of birth, so the digest-against-digest check cannot compare
 * them; letting the digest decide alone would read the live owner of that
 * lease as a reused pid and sweep its lease.
 */
function registryDigestBesideLegacyLease(evidence: HostTerminationEvidence): boolean {
  return (
    isProcessBirthIdentityDigest(evidence.registry?.birthIdentity) &&
    evidence.lease !== null &&
    !isProcessBirthIdentityDigest(evidence.lease.processStartIdentity)
  )
}

/**
 * Resolves evidence by observation: a record that its pid's observation
 * proves stale is dropped (and swept after the termination). A record that
 * cannot be proven stale — an unobservable pid, a live pid that contradicts
 * nothing the record carries — is kept, so evidence that stays inconsistent
 * is refused and nothing is signalled.
 */
async function dropStaleEvidence(
  ports: Pick<HostTerminationPorts, 'observe'>,
  evidence: HostTerminationEvidence
): Promise<{
  readonly kept: HostTerminationEvidence
  readonly stale: HostTerminationEvidence
  readonly dropped: readonly HostTerminationRecord[]
}> {
  const observations = new Map<number, Promise<ProcessBirthObservation>>()
  const observe = (pid: number): Promise<ProcessBirthObservation> => {
    let observation = observations.get(pid)
    if (!observation) {
      observation = ports.observe(pid)
      observations.set(pid, observation)
    }
    return observation
  }
  const judge = async (record: HostTerminationRecord): Promise<boolean> => {
    const value = evidence[record]
    return value !== null && recordIsStale(evidence, record, await observe(value.pid))
  }
  const registryStale = await judge('registry')
  const leaseStale = await judge('lease')
  const discoveryStale = await judge('discovery')
  const dropped: HostTerminationRecord[] = []
  if (registryStale) dropped.push('registry')
  if (leaseStale) dropped.push('lease')
  if (discoveryStale) dropped.push('discovery')
  return {
    kept: {
      registry: registryStale ? null : evidence.registry,
      lease: leaseStale ? null : evidence.lease,
      discovery: discoveryStale ? null : evidence.discovery
    },
    stale: {
      registry: registryStale ? evidence.registry : null,
      lease: leaseStale ? evidence.lease : null,
      discovery: discoveryStale ? evidence.discovery : null
    },
    dropped
  }
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
  return evidence.lease ? leaseExpectation(evidence.lease) : {}
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

export interface HostTerminationSignalPorts {
  readonly spawnSync: (
    file: string,
    args: readonly string[],
    options: { readonly stdio: 'ignore'; readonly windowsHide: true }
  ) => unknown
  readonly kill: (pid: number, signal: HostTerminationSignal) => void
  /** %SystemRoot%, as ProcessBirthIdentity pins PowerShell. */
  readonly windowsRoot: string
}

/**
 * The signal port. On Windows both stages are the tree kill the smoke script
 * uses, by the fixed system path: a `taskkill` resolved through PATH could be
 * any program earlier on it.
 */
export function createHostTerminationSignal(
  platform: NodeJS.Platform,
  ports: Partial<HostTerminationSignalPorts> = {}
): HostTerminationPorts['signal'] {
  const run =
    ports.spawnSync ?? ((file, args, options) => spawnSync(file, [...args], { ...options }))
  const kill = ports.kill ?? ((pid, signal) => process.kill(pid, signal))
  const windowsRoot = ports.windowsRoot ?? (process.env.SystemRoot || 'C:\\Windows')
  return (pid, signal) => {
    if (platform === 'win32') {
      run(win32.join(windowsRoot, 'System32', 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true
      })
      return
    }
    try {
      kill(pid, signal)
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

function sameLeaseRecord(
  current: Pick<
    HostProfileAuthorityOwnerRecord,
    'pid' | 'processStartIdentity' | 'acquiredAt'
  > | null,
  dead: HostTerminationLeaseEvidence
): boolean {
  return (
    current !== null &&
    current.pid === dead.pid &&
    current.processStartIdentity === dead.processStartIdentity &&
    current.acquiredAt === dead.acquiredAt
  )
}

function sameDiscoveryRecord(
  current: HostTerminationEvidence['discovery'],
  dead: NonNullable<HostTerminationEvidence['discovery']>
): boolean {
  return (
    current !== null &&
    current.pid === dead.pid &&
    current.socketPath === dead.socketPath &&
    current.startedAt === dead.startedAt
  )
}

/**
 * Removes the artefacts that still carry exactly one of `dead`'s records —
 * the registry entry (pid, birth identity and boot epoch), the discovery
 * (pid, socket and start), the authority lease (pid, birth and acquisition)
 * — then the token once no discovery is left, and a socket that no longer
 * answers. A pid alone is never enough: a successor for the same profile may
 * have been handed the dead Host's pid. The profile-side artefacts are left
 * alone while any other owner holds the lease: a successor has taken the
 * profile and they are its artefacts now. With no records only a dead socket
 * is removed, and only with no lease owner.
 */
export async function sweepHostArtefacts(
  profilePath: string,
  dead: HostTerminationEvidence,
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
  const deadLease = dead.lease
  const ownerIsDead = deadLease !== null && sameLeaseRecord(owner, deadLease)
  const successorHoldsProfile = owner !== null && !ownerIsDead
  if (dead.registry) {
    try {
      if (removeHostRegistryEntryFor(registryRoot, profilePath, dead.registry)) {
        removed.push('registry')
      }
    } catch {
      // A registry that cannot be written is swept by the next stop-all --sweep.
    }
  }
  if (successorHoldsProfile) return removed

  if (dead.discovery || dead.lease || dead.registry) {
    const discoveryPath = taskWraithHostDiscoveryPath(profilePath)
    const deadDiscovery = dead.discovery
    if (deadDiscovery && sameDiscoveryRecord(readDiscovery(profilePath), deadDiscovery)) {
      const still = (): boolean => sameDiscoveryRecord(readDiscovery(profilePath), deadDiscovery)
      if (unlinkIfStill(discoveryPath, still)) removed.push('discovery')
    }
    // The token carries no pid; it is removed once no discovery names a live Host.
    if (!existsSync(discoveryPath)) {
      const tokenPath = taskWraithHostTokenPath(profilePath)
      if (unlinkIfStill(tokenPath, () => !existsSync(discoveryPath))) removed.push('token')
    }
    if (deadLease && ownerIsDead) {
      const leasePath = taskWraithHostAuthorityLeasePath(profilePath)
      const still = (): boolean => sameLeaseRecord(readLeaseOwner(profilePath), deadLease)
      if (unlinkIfStill(leasePath, still)) removed.push('lease')
    }
  }
  if (platform !== 'win32') {
    const socketPath = taskWraithHostSocketPath(profilePath, platform)
    // Re-checked after the probe: a Host that re-bound it in between keeps it.
    if (await unlinkDeadHostSocket(socketPath, socketIsLive)) removed.push('socket')
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
    signal: createHostTerminationSignal(platform),
    sweep: (profilePath, dead, registryRoot) =>
      sweepHostArtefacts(profilePath, dead, registryRoot, { platform }),
    delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now()
  }
}

type Verdict = 'match' | 'dead' | 'mismatch' | 'unavailable' | 'unverifiable'
type SignalVerdict = Verdict | 'not_a_host'

async function verify(
  ports: HostTerminationPorts,
  pid: number,
  expected: HostTerminationExpectation,
  expectedHost: HostTerminationExpectation | null
): Promise<Verdict> {
  const observation = await ports.observe(pid)
  if (observation.state === 'dead') return 'dead'
  if (observation.state === 'identity_unavailable') return 'unavailable'
  // A process born other than the expected Host is never that Host.
  if (expectedHost && matchProcessBirth(observation, expectedHost) === 'mismatch') return 'mismatch'
  return matchProcessBirth(observation, expected)
}

/** The check that gates every signal: same birth, and a Host serving this profile. */
async function verifyForSignal(
  ports: HostTerminationPorts,
  pid: number,
  expected: HostTerminationExpectation,
  expectedHost: HostTerminationExpectation | null,
  profilePath: string,
  platform: NodeJS.Platform
): Promise<SignalVerdict> {
  const birth = await verify(ports, pid, expected, expectedHost)
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
  expectedHost: HostTerminationExpectation | null,
  budgetMs: number,
  pollMs: number
): Promise<'dead' | 'mismatch' | 'alive' | 'unavailable'> {
  const deadline = ports.now() + budgetMs
  let unavailable = false
  while (ports.now() < deadline) {
    await ports.delay(Math.max(1, Math.min(pollMs, deadline - ports.now())))
    const verdict = await verify(ports, pid, expected, expectedHost)
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
  // With an expected Host every outcome is about it, so each reports its pid.
  const expectedHost = input.expected ?? null

  // `judged` is what the termination acts on; `stale` holds the records
  // already proven stale on the way in. Nothing is swept that is not proven
  // stale, at the end, by an observation of the pid it names.
  const before = ports.readEvidence(profilePath, registryRoot)
  let judged = before
  let stale = NO_EVIDENCE
  let target = hostTerminationTargetPid(before)
  if (target.inconsistent || registryDigestBesideLegacyLease(before)) {
    const resolved = await dropStaleEvidence(ports, before)
    for (const source of resolved.dropped) steps.push(`evidence:stale-${source}`)
    judged = resolved.kept
    stale = resolved.stale
    target = hostTerminationTargetPid(judged)
    if (target.inconsistent) {
      steps.push('evidence:inconsistent')
      log('evidence names more than one Host and none is provably stale; refusing to signal')
      return { kind: 'inconsistent', pid: expectedHost?.pid ?? null, steps, swept: [] }
    }
  }
  const pid = target.pid
  const expected = hostTerminationExpectation(judged)

  /**
   * A fresh observation of the target pid, judged against every record that
   * names it. `stale` is what may be swept: the records dropped as stale on
   * the way in, and each record the observation proves stale — all of them
   * once the pid is dead; while another process lives at it, only those
   * contradicting their own birth. A record that cannot be proven stale is
   * never swept. `refusal` names each record whose birth a live process at
   * the pid contradicts not at all (each may be its own), or is null.
   */
  const finalJudgement = async (): Promise<{
    readonly stale: HostTerminationEvidence
    readonly refusal: string | null
  }> => {
    if (pid === null) return { stale, refusal: null }
    const observation = await ports.observe(pid)
    const staleNow = (record: HostTerminationRecord): boolean =>
      judged[record] !== null && recordIsStale(judged, record, observation)
    const survives = (record: HostTerminationRecord): boolean =>
      observation.state === 'live' && judged[record] !== null && !staleNow(record)
    const survivors = RECORDS.filter(survives)
    return {
      stale: {
        registry: staleNow('registry') ? judged.registry : stale.registry,
        lease: staleNow('lease') ? judged.lease : stale.lease,
        discovery: staleNow('discovery') ? judged.discovery : stale.discovery
      },
      refusal: survivors.length ? survivorRefusal(pid, survivors, profilePath, registryRoot) : null
    }
  }

  const finish = async (
    kind: HostTerminationOutcomeKind,
    sweep: boolean,
    detail?: string,
    heldBy: number | null = null
  ): Promise<HostTerminationOutcome> => {
    let swept: readonly string[] = []
    if (sweep) {
      const judgement = await finalJudgement()
      // With `heldBy` the surviving records are known to be the holder's own.
      if (kind === 'pid_reused' && heldBy === null && judgement.refusal !== null) {
        // One record reads the pid as reused, another as the live process's
        // own (a legacy lease taken after a wall-clock step reads as another
        // birth beside the discovery that process wrote): the evidence
        // disagrees about whose pid it is, so this is a refusal, not a
        // success, and nothing is swept. It holds while that process lives.
        steps.push('evidence:inconsistent')
        log(`inconsistent (${judgement.refusal}) after ${steps.join(' -> ')}`)
        return { kind: 'inconsistent', pid, steps, swept: [], detail: judgement.refusal }
      }
      const dead = expectedHost ? recordsNaming(judgement.stale, expectedHost.pid) : judgement.stale
      swept = await ports.sweep(profilePath, dead, registryRoot)
    }
    if (swept.length) steps.push(`swept:${swept.join(',')}`)
    log(`${kind}${detail ? ` (${detail})` : ''} after ${steps.join(' -> ') || 'no steps'}`)
    return {
      kind,
      pid: expectedHost?.pid ?? pid,
      steps,
      swept,
      ...(detail ? { detail } : {}),
      ...(heldBy !== null ? { heldBy } : {})
    }
  }

  /**
   * With an expected Host: null when the resolved records name it and it is
   * alive — the same pid, a live process there born as it was, and nothing
   * in the records contradicting that birth. Alive, it still holds the
   * profile's authority lease, so no other Host can be serving the profile.
   * When it cannot be observed, the records must carry its very birth digest.
   * Otherwise the outcome, reached with no socket stop and no signal;
   * `heldBy` is the Host the records name instead, unless an observation
   * proves them all stale.
   */
  const refuseAnotherHost = async (
    host: HostTerminationExpectedHost,
    named: number
  ): Promise<HostTerminationOutcome | null> => {
    const observation = await ports.observe(host.pid)
    const verdict: Verdict =
      observation.state === 'dead'
        ? 'dead'
        : observation.state === 'identity_unavailable'
          ? 'unavailable'
          : matchProcessBirth(observation, host)
    steps.push(`expected:${verdict}`)
    if (
      named === host.pid &&
      (verdict === 'match'
        ? matchProcessBirth(observation, expected) !== 'mismatch'
        : verdict === 'unavailable' &&
          isProcessBirthIdentityDigest(host.birthIdentity) &&
          expected.birthIdentity === host.birthIdentity)
    ) {
      return null
    }
    const gone = verdict === 'dead' || verdict === 'mismatch'
    let heldBy: number | null = null
    if (named !== host.pid || gone) {
      const holder = named === host.pid ? observation : await ports.observe(named)
      const current = RECORDS.some(
        (record) => judged[record] !== null && !recordIsStale(judged, record, holder)
      )
      if (current) heldBy = named
    }
    const held = heldBy === null ? null : `another Host (pid ${heldBy}) holds the profile now`
    if (gone) {
      const kind = verdict === 'dead' ? 'already_gone' : 'pid_reused'
      return finish(kind, true, held ?? undefined, heldBy)
    }
    if (verdict === 'match') {
      const reason =
        named === host.pid
          ? `the profile's records name pid ${named} with another birth than the expected Host`
          : `the expected Host (pid ${host.pid}) is still running, but ${held ?? `the profile's records name pid ${named}`}`
      return finish('inconsistent', false, reason, heldBy)
    }
    const reason =
      verdict === 'unavailable'
        ? `the expected Host (pid ${host.pid}) cannot be observed`
        : `the expected Host (pid ${host.pid}) carries no birth to compare with`
    return finish(
      verdict === 'unavailable' ? 'identity_unavailable' : 'unverifiable',
      false,
      held ? `${reason}; ${held}` : reason,
      heldBy
    )
  }

  if (!judged.discovery && !judged.lease && !judged.registry) {
    steps.push('evidence:none')
    return finish('already_gone', true)
  }

  // 0. An expected Host: termination acts on it or on none. Checked here,
  // before the socket stop (which reaches whichever Host serves the profile)
  // and any signal; verify() re-checks its birth at every later observation.
  if (expectedHost && pid !== null) {
    const refused = await refuseAnotherHost(expectedHost, pid)
    if (refused) return refused
  }

  // 1. The Host's own graceful path. With neither discovery nor a lease in the
  // profile (only a registry entry names the pid) there is no socket to ask.
  if (judged.discovery || judged.lease) {
    try {
      const state = await ports.shutdown(profilePath, {
        ackMs: timings.ackMs,
        drainMs: timings.drainMs
      })
      steps.push(`socket:${state}`)
      if (pid === null) return finish('stopped', true)
      const gone = await pollUntilGone(
        ports,
        pid,
        expected,
        expectedHost,
        timings.exitMs,
        timings.pollMs
      )
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

  const beforeTerm = await verifyForSignal(
    ports,
    pid,
    expected,
    expectedHost,
    profilePath,
    platform
  )
  steps.push(`verify:${beforeTerm}`)
  if (beforeTerm === 'dead') return finish('already_gone', true)
  if (beforeTerm === 'mismatch') return finish('pid_reused', true)
  if (beforeTerm === 'unavailable') return finish('identity_unavailable', false)
  if (beforeTerm === 'unverifiable') return finish('unverifiable', false, 'no birth evidence')
  if (beforeTerm === 'not_a_host') return finish('not_a_host', false)
  ports.signal(pid, 'SIGTERM')
  steps.push('signal:SIGTERM')
  const afterTerm = await pollUntilGone(
    ports,
    pid,
    expected,
    expectedHost,
    timings.termMs,
    timings.pollMs
  )
  if (afterTerm === 'dead') return finish('terminated', true)
  if (afterTerm === 'mismatch') return finish('pid_reused', true, 'identity changed after SIGTERM')
  if (afterTerm === 'unavailable') return finish('identity_unavailable', false, 'after SIGTERM')

  // 3. SIGKILL, re-verified immediately before.
  const beforeKill = await verifyForSignal(
    ports,
    pid,
    expected,
    expectedHost,
    profilePath,
    platform
  )
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
  const afterKill = await pollUntilGone(
    ports,
    pid,
    expected,
    expectedHost,
    timings.killMs,
    timings.pollMs
  )
  if (afterKill === 'dead') return finish('killed', true)
  if (afterKill === 'mismatch') return finish('pid_reused', true, 'identity changed after SIGKILL')
  if (afterKill === 'unavailable') return finish('identity_unavailable', false, 'after SIGKILL')
  return finish('failed', false, 'process survived SIGKILL')
}
