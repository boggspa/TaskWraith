import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  watch as watchDirectory
} from 'node:fs'
import { homedir, tmpdir, userInfo } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'

import { isHostServeCommandFor } from '../../src/host-client/HostProcessTermination'
import {
  HOST_REGISTRY_ROOT_ENV,
  hostRegistryDefaultRoot
} from '../../src/host-runtime/HostRegistry'
import {
  PROCESS_BIRTH_START_TOLERANCE_MS,
  isProcessBirthIdentityDigest,
  observeProcessBirthIdentitySync,
  parseProcCmdline,
  type ProcessBirthObservation,
  type ProcessCommandLineObservation
} from '../../src/host-runtime/ProcessBirthIdentity'

/**
 * Vitest global setup: Host registry isolation for every test run.
 *
 * Every `cli.js serve` a suite spawns publishes a machine-wide registry entry
 * (HostRegistry.ts). Setup points TASKWRAITH_HOST_REGISTRY_ROOT at a per-run
 * temporary directory before any worker starts, so every worker and every
 * process a worker spawns with the inherited environment publishes there. A
 * suite that needs its own root still sets one explicitly.
 *
 * The guard watches the real registry (`~/.taskwraith/hosts`, the root a
 * Host uses when the variable is absent, under both HOME and the password
 * database's home directory) for the whole run, strictly read-only. Every
 * poll snapshots each file there (name, inode, size, mtime, mode and a hash
 * of its bytes) and diffs it against the last one; a directory watch adds the
 * names a poll would miss, so an entry written and removed between two polls
 * is still seen. Any creation, rewrite or removal fails the run (exit code 1
 * after the summary) unless it is provably a real Host's own lifecycle,
 * judged by the process, never by the pid an entry merely names:
 *
 * - an entry is created or rewritten by a Host outside the run: the process
 *   it names is alive with exactly the birth identity it records, its command
 *   line is a Host serving the entry's profile, it does not run under this
 *   test run, and either its profile lies outside the run's temporary roots
 *   (a real profile: a test Host always serves a temporary one, so this is
 *   what tells an app relaunched mid-run, whose only ancestor is launchd,
 *   from an orphaned test Host), or it started before the run, or it has an
 *   ancestor (other than init) that did, as a Host the app starts mid-run;
 * - a rewrite that changes whose entry it is (pid, birth identity or boot
 *   epoch: what the Host's own self-check compares) replaces a Host that is
 *   gone;
 * - an entry disappears as its Host exits: removal is judged after a grace,
 *   and a Host still running with the same birth then means someone else
 *   deleted a live Host's entry — the kill switch that stops it.
 *
 * Only `<16 hex>.json` names are entries: nothing reads any other name in the
 * root (a Finder `.DS_Store`, a publish temporary), so the guard ignores them
 * too. Anything else — an entry naming init or a dead pid, a malformed entry,
 * a removed baseline entry, an entry that came and went between polls, no
 * process table (Windows) — counts against the run: the guard would rather be
 * loud than let a test write into a user's registry. Teardown lets the watch
 * deliver before its last poll (TEARDOWN_SETTLE_MS), so an entry written and
 * removed in the run's final moments is still seen when the watch reports it
 * in that time. One limitation: on linux an orphan is re-parented to a
 * subreaper, which can predate the run, so an orphaned Host that verifies as
 * a real one is read as outside the run; on darwin every orphan goes to
 * launchd, which never counts.
 */

const POLL_INTERVAL_MS = 250
/** How long a verified outside Host may take to exit after its entry disappears. */
const REMOVAL_GRACE_MS = 10_000
/**
 * How long teardown lets the watch deliver before its last poll: FSEvents and
 * inotify report asynchronously (about 30-50 ms here), so an entry written
 * and removed as a run's last act would otherwise land after the verdict.
 */
const TEARDOWN_SETTLE_MS = 250
const RUN_ROOT_PREFIX = 'taskwraith-vitest-host-registry-'
/** The only names a Host or `stop-all` reads in the root (HostRegistry.ts ENTRY_ID_PATTERN). */
const ENTRY_NAME = /^[0-9a-f]{16}\.json$/

/** What an entry file names, when it parses as a JSON object. */
export interface RegistryEntryRecord {
  readonly pid: number | null
  readonly birthIdentity: string | null
  readonly bootEpoch: string | null
  readonly profilePath: string | null
}

export interface RegistryFileState {
  /** Device, inode, size, mtime and mode. */
  readonly stamp: string
  /** sha256 of the bytes; null when the path is not a readable regular file. */
  readonly hash: string | null
  readonly record: RegistryEntryRecord | null
}

/** Null means the root does not exist. */
export type RegistrySnapshot = ReadonlyMap<string, RegistryFileState> | null

export type ProcessParents = ReadonlyMap<number, number>

export type RegistryWriterAttribution = 'this-run' | 'other' | 'unknown'

/**
 * Whose entry a violation is about: one running under this run, a live
 * process outside it that is not a verifiable Host, nothing observable, an
 * entry that was already there and inert, or a verified outside Host.
 */
export type RegistryIsolationAttribution =
  | 'this-run'
  | 'unverified'
  | 'unknown'
  | 'baseline-stale'
  | 'outside-host'

export interface RegistryIsolationViolation {
  readonly name: string
  readonly change: 'created' | 'rewritten' | 'removed' | 'transient' | 'root-created'
  readonly pid: number | null
  readonly attribution: RegistryIsolationAttribution
  readonly detail: string
}

/** The process facts the guard judges a writer by; all synchronous. */
export interface RegistryGuardProcessPorts {
  /** Every pid's parent; null where no table is available. */
  readonly readParents: () => ProcessParents | null
  readonly observeBirth: (pid: number) => ProcessBirthObservation
  readonly observeCommand: (pid: number) => ProcessCommandLineObservation
}

/** A directory watch; returns null when the platform cannot watch it. */
export type RegistryDirectoryWatch = (
  path: string,
  onChange: (name: string | null) => void
) => { close(): void } | null

function isErrno(error: unknown, codes: readonly string[]): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    codes.includes(String((error as { code?: unknown }).code))
  )
}

function recordOf(bytes: Buffer | null): RegistryEntryRecord | null {
  if (bytes === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(bytes.toString('utf8'))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const value = parsed as {
    pid?: unknown
    birthIdentity?: unknown
    bootEpoch?: unknown
    profilePath?: unknown
  }
  return {
    pid:
      typeof value.pid === 'number' && Number.isSafeInteger(value.pid) && value.pid > 0
        ? value.pid
        : null,
    birthIdentity: typeof value.birthIdentity === 'string' ? value.birthIdentity : null,
    bootEpoch: typeof value.bootEpoch === 'string' ? value.bootEpoch : null,
    profilePath: typeof value.profilePath === 'string' ? value.profilePath : null
  }
}

/**
 * Every entry-named file in the root (`<16 hex>.json`), each read and hashed
 * afresh; no other name is ever read by a Host. A symbolic link is stamped,
 * never followed.
 */
export function readRegistrySnapshot(root: string): Map<string, RegistryFileState> | null {
  let names: string[]
  try {
    names = readdirSync(root)
  } catch (error) {
    if (isErrno(error, ['ENOENT', 'ENOTDIR'])) return null
    throw error
  }
  const snapshot = new Map<string, RegistryFileState>()
  for (const name of names.sort()) {
    if (!ENTRY_NAME.test(name)) continue
    const path = join(root, name)
    let stamp: string
    let regular: boolean
    try {
      const stat = lstatSync(path)
      stamp = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.mode}`
      regular = stat.isFile()
    } catch {
      continue
    }
    let bytes: Buffer | null = null
    if (regular) {
      try {
        bytes = readFileSync(path)
      } catch {
        bytes = null
      }
    }
    snapshot.set(name, {
      stamp,
      hash: bytes ? createHash('sha256').update(bytes).digest('hex') : null,
      record: recordOf(bytes)
    })
  }
  return snapshot
}

/** `ps -axo pid=,ppid=` on darwin and linux; null where no table is available. */
export function readProcessParents(
  platform: NodeJS.Platform = process.platform
): ProcessParents | null {
  if (platform !== 'darwin' && platform !== 'linux') return null
  let output: string
  try {
    output = execFileSync('/bin/ps', ['-axo', 'pid=,ppid='], {
      encoding: 'utf8',
      env: { LC_ALL: 'C' },
      timeout: 10_000,
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore']
    })
  } catch {
    return null
  }
  const parents = new Map<number, number>()
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line)
    if (match) parents.set(Number(match[1]), Number(match[2]))
  }
  return parents
}

/**
 * A pid's command line, synchronously: exact argv from /proc on linux, the
 * joined line from ps on darwin. ESRCH is `dead`; anything unreadable is
 * `identity_unavailable`, which never verifies a Host.
 */
export function readProcessCommandSync(
  pid: number,
  platform: NodeJS.Platform = process.platform
): ProcessCommandLineObservation {
  try {
    if (platform === 'linux') {
      const argv = parseProcCmdline(readFileSync(`/proc/${pid}/cmdline`, 'utf8'))
      if (argv) return { state: 'live', commandLine: argv.join(' '), argv }
    } else if (platform === 'darwin') {
      const line = execFileSync('/bin/ps', ['-o', 'command=', '-p', String(pid)], {
        encoding: 'utf8',
        env: { LC_ALL: 'C' },
        timeout: 2_000,
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim()
      if (line) return { state: 'live', commandLine: line, argv: null }
    }
  } catch {
    // Fall through to the existence probe.
  }
  try {
    process.kill(pid, 0)
  } catch (error) {
    if (isErrno(error, ['ESRCH'])) return { state: 'dead' }
  }
  return { state: 'identity_unavailable' }
}

/** Whether `pid` is `ancestor` or runs under it, judged from one process table. */
export function attributeRegistryWriter(
  pid: number | null,
  ancestor: number,
  parents: ProcessParents | null
): RegistryWriterAttribution {
  if (pid === null || parents === null || !parents.has(pid)) return 'unknown'
  const seen = new Set<number>()
  let current: number | undefined = pid
  while (current !== undefined && current > 0 && !seen.has(current)) {
    if (current === ancestor) return 'this-run'
    seen.add(current)
    current = parents.get(current)
  }
  return 'other'
}

const DEFAULT_PROCESS_PORTS: RegistryGuardProcessPorts = {
  readParents: () => readProcessParents(),
  observeBirth: (pid) => observeProcessBirthIdentitySync(pid),
  observeCommand: (pid) => readProcessCommandSync(pid)
}

/** fs.watch without keeping the run alive; a directory it cannot watch is polled only. */
export const watchRegistryDirectory: RegistryDirectoryWatch = (path, onChange) => {
  try {
    const watcher = watchDirectory(path, { persistent: false }, (_event, name) =>
      onChange(typeof name === 'string' ? name : null)
    )
    watcher.on('error', () => undefined)
    return watcher
  } catch {
    return null
  }
}

/**
 * The directories a test profile lives under: the OS temporary directory,
 * /tmp and /var/tmp, each as spelled and as resolved (on darwin each resolves
 * under /private, and a Host's entry records its profile resolved).
 */
export function temporaryRoots(): readonly string[] {
  const roots = new Set<string>()
  for (const candidate of [tmpdir(), '/tmp', '/var/tmp']) {
    roots.add(resolve(candidate))
    try {
      roots.add(realpathSync(candidate))
    } catch {
      // Absent here: its spelling is still a temporary root.
    }
  }
  return [...roots]
}

/** Whether `path`, normalised without following links, lies inside one of `roots`. */
function isUnderAny(path: string, roots: readonly string[]): boolean {
  const spelling = resolve(path)
  return roots.some((root) => spelling.startsWith(`${root}${sep}`))
}

export interface RegistryIsolationGuardOptions {
  /** The registry a Host uses without the override. */
  readonly realRoot: string
  /** This vitest process: writers under it belong to the run. */
  readonly ancestorPid: number
  readonly ports?: Partial<RegistryGuardProcessPorts>
  /**
   * When the run began; a Host started after it, serving a temporary profile,
   * needs an ancestor that did not.
   */
  readonly runStartedAtMs?: number
  /** Where test profiles live; temporaryRoots() by default. */
  readonly temporaryRoots?: readonly string[]
  readonly removalGraceMs?: number
  readonly now?: () => number
  /** Watches the root (or its parent while the root is absent) between polls. */
  readonly watch?: RegistryDirectoryWatch
  /** Called on every watch event, so the owner can poll at once. */
  readonly onWatchEvent?: () => void
}

/** Whose entry it is: the fields the Host's own self-check compares. */
interface HostEntryIdentity {
  readonly pid: number
  readonly birthIdentity: string
  readonly bootEpoch: string | null
}

type EntryOwner =
  | ({ readonly kind: 'outside-host' } & HostEntryIdentity)
  | { readonly kind: 'baseline-stale' }
  | { readonly kind: 'flagged' }

type Verification =
  | ({ readonly ok: true } & HostEntryIdentity)
  | {
      readonly ok: false
      readonly attribution: RegistryIsolationAttribution
      readonly reason: string
    }

interface PendingRemoval {
  readonly pid: number
  readonly birthIdentity: string
  readonly profilePath: string | null
  readonly deadline: number
}

function identityOf(identity: HostEntryIdentity): HostEntryIdentity {
  return { pid: identity.pid, birthIdentity: identity.birthIdentity, bootEpoch: identity.bootEpoch }
}

function sameHostEntry(owner: HostEntryIdentity, record: RegistryEntryRecord): boolean {
  return (
    record.pid === owner.pid &&
    record.birthIdentity === owner.birthIdentity &&
    record.bootEpoch === owner.bootEpoch
  )
}

/**
 * Tracks the real registry against a baseline. `poll()` runs on an interval
 * and on every watch event for the whole test run; `violations()` is the
 * verdict once `pendingRemovals()` is zero or has timed out.
 */
export class RegistryIsolationGuard {
  private readonly options: RegistryIsolationGuardOptions
  private readonly ports: RegistryGuardProcessPorts
  private readonly now: () => number
  private readonly runStartedAtMs: number
  private readonly temporaryRoots: readonly string[]
  private readonly rootExistedAtStart: boolean
  /** A root nobody here can list cannot be written by this run's Hosts either. */
  private readonly unlistableAtStart: boolean
  private known: RegistrySnapshot
  private readonly owners = new Map<string, EntryOwner>()
  private readonly pending = new Map<string, PendingRemoval>()
  /** Names a watch reported since the last poll. */
  private readonly noted = new Set<string>()
  /** Every name any snapshot held: a late watch event for one is never transient. */
  private readonly everSeen = new Set<string>()
  private readonly found: RegistryIsolationViolation[] = []
  private exemptWriterSeen = false
  private watched: { readonly key: string; readonly handle: { close(): void } } | null = null

  constructor(options: RegistryIsolationGuardOptions) {
    this.options = options
    this.ports = { ...DEFAULT_PROCESS_PORTS, ...options.ports }
    this.now = options.now ?? Date.now
    this.runStartedAtMs = options.runStartedAtMs ?? this.now()
    this.temporaryRoots = options.temporaryRoots ?? temporaryRoots()
    let baseline: RegistrySnapshot = null
    let unlistable = false
    try {
      baseline = readRegistrySnapshot(options.realRoot)
    } catch {
      unlistable = true
    }
    this.known = baseline
    for (const name of baseline?.keys() ?? []) this.everSeen.add(name)
    this.unlistableAtStart = unlistable
    this.rootExistedAtStart = unlistable || baseline !== null
    if (this.known && this.known.size > 0) {
      const table = this.memoizedParents()
      for (const [name, state] of this.known) {
        // A baseline entry that is a live Host's own record belongs to that
        // Host; anything else (a dead pid, a malformed file) is inert and
        // must still be there, unchanged, when the run ends.
        const verified = this.verifyOutsideHost(state.record, table, false)
        this.owners.set(
          name,
          verified.ok
            ? { ...identityOf(verified), kind: 'outside-host' }
            : { kind: 'baseline-stale' }
        )
      }
    }
    this.rearmWatch()
  }

  /** A watch event: remember an entry name, so one that is gone by the next poll still counts. */
  note(name: string | null): void {
    if (name && ENTRY_NAME.test(name)) this.noted.add(name)
  }

  poll(): void {
    let current: RegistrySnapshot
    try {
      current = readRegistrySnapshot(this.options.realRoot)
    } catch (error) {
      if (this.unlistableAtStart) return
      this.record({
        name: '(root)',
        change: 'rewritten',
        pid: null,
        attribution: 'unknown',
        detail: `the real registry root became unlistable during the run: ${String(error)}`
      })
      return
    }
    const before = this.known ?? new Map<string, RegistryFileState>()
    const after = current ?? new Map<string, RegistryFileState>()
    const table = this.memoizedParents()

    for (const name of after.keys()) this.everSeen.add(name)
    for (const name of this.noted) {
      if (this.everSeen.has(name)) continue
      this.record({
        name,
        change: 'transient',
        pid: null,
        attribution: 'unknown',
        detail:
          'a file appeared in the real registry and was gone before the next poll could read it'
      })
    }
    this.noted.clear()

    for (const [name, state] of after) {
      const previous = before.get(name)
      if (previous && previous.stamp === state.stamp && previous.hash === state.hash) continue
      this.judgeWrite(name, previous ?? null, state, table)
    }
    for (const [name, state] of before) {
      if (after.has(name)) continue
      this.judgeRemoval(name, state)
    }
    this.settlePending()

    if (!this.rootExistedAtStart && current !== null && !this.exemptWriterSeen) {
      if (!this.found.some((violation) => violation.change === 'root-created')) {
        this.record({
          name: '(root)',
          change: 'root-created',
          pid: null,
          attribution: 'unknown',
          detail: 'the directory did not exist before the run'
        })
      }
    }
    this.known = current
    this.rearmWatch()
  }

  /** Removals still inside their grace: the verdict is not final until this is zero. */
  pendingRemovals(): number {
    return this.pending.size
  }

  violations(): readonly RegistryIsolationViolation[] {
    return this.found
  }

  close(): void {
    this.watched?.handle.close()
    this.watched = null
  }

  private judgeWrite(
    name: string,
    previous: RegistryFileState | null,
    state: RegistryFileState,
    table: () => ProcessParents | null
  ): void {
    const owner = this.owners.get(name)
    const record = state.record
    // A refresh by the Host already verified as this entry's owner keeps its
    // standing even if the ancestor that anchored it has since exited. Owner
    // means what the Host's self-check compares: pid, birth and boot epoch.
    const sameOwner =
      owner?.kind === 'outside-host' && record !== null && sameHostEntry(owner, record)
    const verified = this.verifyOutsideHost(record, table, !sameOwner)
    if (verified.ok) {
      if (
        sameOwner ||
        owner?.kind !== 'outside-host' ||
        this.gone(owner.pid, owner.birthIdentity)
      ) {
        this.owners.set(name, { ...identityOf(verified), kind: 'outside-host' })
        this.exemptWriterSeen = true
        return
      }
      this.owners.set(name, { kind: 'flagged' })
      this.record({
        name,
        change: 'rewritten',
        pid: verified.pid,
        attribution: 'outside-host',
        detail:
          verified.pid === owner.pid && verified.birthIdentity === owner.birthIdentity
            ? `the entry of pid ${owner.pid}, still running, was rewritten with another boot epoch: that Host reads it as foreign and stops itself`
            : `the entry of pid ${owner.pid}, still running, was replaced by one for pid ${verified.pid}`
      })
      return
    }
    this.owners.set(name, { kind: 'flagged' })
    this.record({
      name,
      change: previous ? 'rewritten' : 'created',
      pid: record?.pid ?? null,
      attribution: verified.attribution,
      detail: `${this.describe(record)}: ${verified.reason}`
    })
  }

  private judgeRemoval(name: string, state: RegistryFileState): void {
    const owner = this.owners.get(name)
    this.owners.delete(name)
    if (owner?.kind === 'outside-host') {
      this.pending.set(name, {
        pid: owner.pid,
        birthIdentity: owner.birthIdentity,
        profilePath: state.record?.profilePath ?? null,
        deadline: this.now() + (this.options.removalGraceMs ?? REMOVAL_GRACE_MS)
      })
      return
    }
    // A flagged entry was reported when it appeared.
    if (owner?.kind === 'flagged') return
    this.record({
      name,
      change: 'removed',
      pid: state.record?.pid ?? null,
      attribution: 'baseline-stale',
      detail: `an entry that was already in the real registry disappeared (${this.describe(state.record)})`
    })
  }

  /** A verified Host's entry is gone: fine once that Host has exited, a violation if it outlives the grace. */
  private settlePending(): void {
    for (const [name, removal] of this.pending) {
      if (this.gone(removal.pid, removal.birthIdentity)) {
        this.pending.delete(name)
        continue
      }
      if (this.now() < removal.deadline) continue
      this.pending.delete(name)
      this.record({
        name,
        change: 'removed',
        pid: removal.pid,
        attribution: 'outside-host',
        detail:
          `the entry of Host pid ${removal.pid}${removal.profilePath ? ` (profile ${removal.profilePath})` : ''} ` +
          'was deleted while that Host kept running: it stops itself on the missing entry'
      })
    }
  }

  private gone(pid: number, birthIdentity: string): boolean {
    const observation = this.ports.observeBirth(pid)
    return (
      observation.state === 'dead' ||
      (observation.state === 'live' && observation.birthIdentity !== birthIdentity)
    )
  }

  /**
   * Whether `record` is the live entry of a Host outside this run: the pid is
   * alive with exactly the recorded birth, runs a Host serving the recorded
   * profile, is not under this run and — when `anchored` — serves a profile
   * outside the temporary roots, or started before the run, or has a
   * non-init ancestor that did.
   */
  private verifyOutsideHost(
    record: RegistryEntryRecord | null,
    table: () => ProcessParents | null,
    anchored: boolean
  ): Verification {
    if (!record) return { ok: false, attribution: 'unknown', reason: 'not a readable entry' }
    const pid = record.pid
    if (pid === null) return { ok: false, attribution: 'unknown', reason: 'it names no pid' }
    const parents = table()
    if (attributeRegistryWriter(pid, this.options.ancestorPid, parents) === 'this-run') {
      return { ok: false, attribution: 'this-run', reason: `pid ${pid} runs under this test run` }
    }
    const birth = this.ports.observeBirth(pid)
    if (birth.state === 'dead') {
      return { ok: false, attribution: 'unknown', reason: `pid ${pid} is not running` }
    }
    if (birth.state !== 'live') {
      return { ok: false, attribution: 'unknown', reason: `pid ${pid} cannot be observed` }
    }
    if (parents === null) {
      return { ok: false, attribution: 'unknown', reason: 'no process table to place its writer' }
    }
    if (
      !isProcessBirthIdentityDigest(record.birthIdentity) ||
      record.birthIdentity !== birth.birthIdentity
    ) {
      return {
        ok: false,
        attribution: 'unverified',
        reason: `pid ${pid} is not the process the entry records`
      }
    }
    if (
      !record.profilePath ||
      !isHostServeCommandFor(this.ports.observeCommand(pid), record.profilePath)
    ) {
      return {
        ok: false,
        attribution: 'unverified',
        reason: `pid ${pid} is not a Host serving the entry's profile`
      }
    }
    // A real profile (outside every temporary root) is never a test's: its
    // Host is the user's, whatever its ancestry (an app relaunched from the
    // Dock, or a TUI whose `tw` has exited, leaves only launchd above it).
    if (
      anchored &&
      isUnderAny(record.profilePath, this.temporaryRoots) &&
      !this.predatesRun(birth) &&
      !this.hasAncestorOutsideRun(pid, parents)
    ) {
      return {
        ok: false,
        attribution: 'unverified',
        reason: `pid ${pid} serves a temporary profile, started during this run and no ancestor outside it did`
      }
    }
    return { ok: true, pid, birthIdentity: birth.birthIdentity, bootEpoch: record.bootEpoch }
  }

  private predatesRun(birth: ProcessBirthObservation): boolean {
    return (
      birth.state === 'live' &&
      birth.startedAtMs !== null &&
      birth.startedAtMs < this.runStartedAtMs - PROCESS_BIRTH_START_TOLERANCE_MS
    )
  }

  private hasAncestorOutsideRun(pid: number, parents: ProcessParents): boolean {
    const seen = new Set<number>([pid])
    let current = parents.get(pid)
    // Init (and the kernel) adopt every orphan: never an anchor.
    while (current !== undefined && current > 1 && !seen.has(current)) {
      if (current === this.options.ancestorPid) return false
      seen.add(current)
      if (this.predatesRun(this.ports.observeBirth(current))) return true
      current = parents.get(current)
    }
    return false
  }

  private memoizedParents(): () => ProcessParents | null {
    let parents: ProcessParents | null | undefined
    return () => {
      if (parents === undefined) parents = this.ports.readParents()
      return parents
    }
  }

  /** Watch the root, or its parent while the root is absent; re-armed when either changes. */
  private rearmWatch(): void {
    const watch = this.options.watch
    if (!watch) return
    const root = this.options.realRoot
    let target: string | null = null
    let key = ''
    for (const candidate of [root, dirname(root)]) {
      try {
        const stat = lstatSync(candidate)
        if (!stat.isDirectory()) continue
        target = candidate
        key = `${candidate}:${stat.dev}:${stat.ino}`
        break
      } catch {
        // Absent: try the parent.
      }
    }
    if (this.watched?.key === key) return
    this.close()
    if (!target) return
    const watching = target
    const handle = watch(watching, (name) => {
      if (watching === root) this.note(name)
      this.options.onWatchEvent?.()
    })
    if (handle) this.watched = { key, handle }
  }

  private describe(record: RegistryEntryRecord | null): string {
    if (!record) return 'not a readable entry'
    return [
      record.pid === null ? 'no pid' : `pid ${record.pid}`,
      record.profilePath ? `profile ${record.profilePath}` : null
    ]
      .filter(Boolean)
      .join(', ')
  }

  /** One line per entry and pid: a Host refreshing its entry is one finding, not one per minute. */
  private record(violation: RegistryIsolationViolation): void {
    const duplicate = this.found.some(
      (existing) => existing.name === violation.name && existing.pid === violation.pid
    )
    if (!duplicate) this.found.push(violation)
  }
}

export function formatRegistryIsolationViolations(
  realRoot: string,
  violations: readonly RegistryIsolationViolation[]
): string {
  const lines = [
    `[host-registry-isolation] FAILED: this test run changed the real Host registry ${realRoot}.`,
    ...violations.map(
      (violation) =>
        `  ${violation.change} ${violation.name} (${violation.attribution}): ${violation.detail}`
    ),
    `  Spawn Hosts with the inherited environment (it carries ${HOST_REGISTRY_ROOT_ENV}) or set`,
    '  that variable to a temporary directory explicitly; never publish into, edit or sweep the real root.'
  ]
  return `${lines.join('\n')}\n`
}

/**
 * `~/.taskwraith/hosts` under HOME and under the password database's home
 * directory, once each. Never derived from the override: setup has already
 * pointed that at the per-run root.
 */
export function realHostRegistryRoots(): readonly string[] {
  const homes = [homedir()]
  try {
    homes.push(userInfo().homedir)
  } catch {
    // No password database entry for this uid: HOME is the only home.
  }
  return [...new Set(homes.filter(Boolean).map((home) => hostRegistryDefaultRoot(home)))]
}

export interface HostRegistryIsolationOptions {
  /** The environment workers inherit; the vitest main process's by default. */
  readonly env?: NodeJS.ProcessEnv
  /** The registries a Host uses without the override; realHostRegistryRoots() by default. */
  readonly realRoots?: readonly string[]
  readonly temporaryDirectory?: string
  readonly ancestorPid?: number
  readonly ports?: Partial<RegistryGuardProcessPorts>
  readonly runStartedAtMs?: number
  readonly pollIntervalMs?: number
  readonly removalGraceMs?: number
  /** fs.watch by default; null polls only. */
  readonly watch?: RegistryDirectoryWatch | null
  /** How long teardown lets the watch deliver before its last poll (TEARDOWN_SETTLE_MS). */
  readonly teardownSettleMs?: number
  readonly report?: (text: string) => void
  /** Marks the run failed; the summary has already printed by then. */
  readonly fail?: () => void
}

/** Starts the per-run root and the guard; the returned teardown gives the verdict. */
export function startHostRegistryIsolation(
  options: HostRegistryIsolationOptions = {}
): () => Promise<void> {
  const env = options.env ?? process.env
  const runRoot = mkdtempSync(join(options.temporaryDirectory ?? tmpdir(), RUN_ROOT_PREFIX))
  // The per-run root every worker and every Host they spawn inherits.
  env[HOST_REGISTRY_ROOT_ENV] = runRoot
  const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS
  const removalGraceMs = options.removalGraceMs ?? REMOVAL_GRACE_MS
  const runStartedAtMs = options.runStartedAtMs ?? Date.now()
  const watch = options.watch === undefined ? watchRegistryDirectory : options.watch
  const guards: Array<readonly [string, RegistryIsolationGuard]> = []
  let scheduled = false
  const pollAll = (): void => {
    for (const [, guard] of guards) guard.poll()
  }
  const pollSoon = (): void => {
    if (scheduled) return
    scheduled = true
    setImmediate(() => {
      scheduled = false
      pollAll()
    })
  }
  for (const realRoot of options.realRoots ?? realHostRegistryRoots()) {
    guards.push([
      realRoot,
      new RegistryIsolationGuard({
        realRoot,
        ancestorPid: options.ancestorPid ?? process.pid,
        runStartedAtMs,
        removalGraceMs,
        ...(options.ports ? { ports: options.ports } : {}),
        ...(watch ? { watch, onWatchEvent: pollSoon } : {})
      })
    ])
  }
  const timer = setInterval(pollAll, pollIntervalMs)
  timer.unref()
  const teardownSettleMs = options.teardownSettleMs ?? TEARDOWN_SETTLE_MS
  return async () => {
    clearInterval(timer)
    if (watch) {
      // Drain the watch: its events arrive asynchronously, so an entry written
      // and removed as the run's last act is only noted after a moment. The
      // settle ends in a setImmediate, which runs only once the loop has
      // handled pending I/O: an event that fell due with the settle timer
      // (timers run first) is still delivered before the last poll.
      await new Promise((resolve) => setTimeout(resolve, teardownSettleMs))
      await new Promise((resolve) => setImmediate(resolve))
    }
    pollAll()
    // A removal is judged only once its Host has had its grace to exit.
    const settleBy = Date.now() + removalGraceMs + pollIntervalMs
    while (guards.some(([, guard]) => guard.pendingRemovals() > 0) && Date.now() < settleBy) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
      pollAll()
    }
    for (const [, guard] of guards) guard.close()
    rmSync(runRoot, { recursive: true, force: true })
    const reports = guards
      .filter(([, guard]) => guard.violations().length > 0)
      .map(([realRoot, guard]) => formatRegistryIsolationViolations(realRoot, guard.violations()))
    if (reports.length === 0) return
    ;(options.report ?? ((text) => void process.stderr.write(text)))(reports.join(''))
    ;(
      options.fail ??
      (() => {
        process.exitCode = 1
      })
    )()
  }
}

/** Vitest `globalSetup` entry. */
export default function setupHostRegistryIsolation(): () => Promise<void> {
  return startHostRegistryIsolation()
}
