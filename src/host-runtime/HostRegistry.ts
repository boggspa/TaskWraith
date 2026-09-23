import { createHash } from 'node:crypto'
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  type Stats
} from 'node:fs'
import { createConnection } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'

import {
  publishPrivateLocalControlArtifact,
  readPrivateLocalControlArtifact
} from '../shared/hostLocalControlArtifacts.node'
import {
  TASKWRAITH_HOST_SOCKET_FILE,
  taskWraithHostDiscoveryPath,
  taskWraithHostSocketPath
} from '../shared/taskWraithHostPaths.node'
import {
  currentProcessBirthIdentity,
  observeProcessBirthIdentity,
  type ProcessBirthObservation
} from './ProcessBirthIdentity'
import type {
  HostRegistryCheckResult,
  HostRegistryEntryInput,
  HostRegistryEntryRefresh,
  HostRegistryPublisherPort
} from './HostRegistryPort'

/**
 * Machine-wide Host registry: one entry per running production Host under
 * `~/.taskwraith/hosts/<sha16(profilePath)>.json`.
 *
 * The entry name is the same 16-hex suffix the socket directory uses
 * (`$TMPDIR/twh2-<uid>-<sha16>`), so a socket directory maps to its entry by
 * name and `stop-all` has a cross-profile enumerator where today only process
 * argv exists. The Host publishes after discovery (discovery stays the
 * readiness flag), refreshes on a 60 s tick, re-reads its own entry on that
 * tick, and removes it before releasing its authority lease. A leftover entry
 * after a crash is harmless: liveness is always decided by pid + birth
 * identity, never by file age.
 *
 * The publisher implements HostRegistryPort's contract; the production CLI
 * builds it (`createHostRegistryPublisherFromEnvironment`) and the production
 * server drives it.
 *
 * Tests and smoke scripts MUST point TASKWRAITH_HOST_REGISTRY_ROOT at a
 * temporary directory; the subprocess suites spawn real Hosts. The vitest
 * global setup (`scripts/vitest/hostRegistryIsolation.ts`) sets a per-run root
 * for every test and fails the run if anything is written under the real one.
 */

export const HOST_REGISTRY_SCHEMA = 'taskwraith.host-registry.v1'
export const HOST_REGISTRY_ROOT_ENV = 'TASKWRAITH_HOST_REGISTRY_ROOT'
/**
 * Awake-time cadence of the Host's registry refresh and self-check. This
 * module owns it; the production server imports it for its lease tick.
 */
export const HOST_REGISTRY_REFRESH_MS = 60_000
export const HOST_REGISTRY_MAX_ENTRY_BYTES = 16 * 1024
/** Same connect deadline as HostLocalServer's own stale-socket probe. */
export const HOST_REGISTRY_SOCKET_PROBE_MS = 350
/**
 * A socket directory younger than this is never swept: a starting Host
 * creates the directory, probes for a live predecessor (up to the probe
 * deadline) and only then binds, and its registry entry follows discovery.
 * Removing the directory inside that window would fail the start or orphan
 * the freshly bound socket.
 */
export const HOST_REGISTRY_SWEEP_MIN_AGE_MS = 60_000

const PRIVATE_DIRECTORY_MODE = 0o700
const ENTRY_ID_PATTERN = /^[0-9a-f]{16}$/
const SOCKET_DIRECTORY_PATTERN = /^twh2-([^-]+)-([0-9a-f]{16})$/
const LIFETIME_PHASE_PATTERN = /^[a-z][a-z-]{0,31}$/
const PAYLOAD_VERSION_PATTERN = /^sha256:[a-f0-9]{64}$/

export interface HostRegistryEntry {
  readonly schema: typeof HOST_REGISTRY_SCHEMA
  readonly profilePath: string
  readonly pid: number
  readonly birthIdentity: string | null
  readonly startedAt: string
  readonly hostId: string
  readonly bootEpoch: string | null
  readonly payloadVersion: string | null
  readonly socketPath: string
  readonly discoveryPath: string
  readonly cliPath: string | null
  readonly nodeExecutable: string | null
  readonly persist: boolean
  readonly leaseMode: 'lease'
  readonly writtenAt: string
  readonly beatSeq: number
  readonly holders: number
  readonly implicitHolders: number
  /**
   * A reader accepts any lower-case phase so a newer Host's entry still
   * decodes; this release's Hosts write a HostLifetimePhase.
   */
  readonly lifetimePhase: string
}

export interface HostRegistryPublisherOptions {
  readonly root: string
  readonly profilePath: string
  readonly cliPath?: string | null
  readonly nodeExecutable?: string | null
  readonly pid?: number
  readonly platform?: NodeJS.Platform
  readonly observeSelf?: () => ProcessBirthObservation
  readonly now?: () => Date
  readonly log?: (line: string) => void
}

export type HostRegistryEntryDecode =
  | { readonly ok: true; readonly entry: HostRegistryEntry }
  | { readonly ok: false; readonly error: string }

export type HostRegistryEntryRead =
  | { readonly kind: 'present'; readonly entry: HostRegistryEntry; readonly path: string }
  | { readonly kind: 'missing'; readonly path: string }
  | { readonly kind: 'unreadable'; readonly path: string; readonly error: string }

export interface HostRegistryListing {
  readonly root: string
  readonly entries: readonly HostRegistryEntry[]
  readonly unreadable: readonly { readonly path: string; readonly error: string }[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

function isBoundedString(value: unknown, max: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= max &&
    value.trim() === value &&
    !hasControlCharacters(value)
  )
}

function isCanonicalIso(value: unknown): value is string {
  if (!isBoundedString(value, 100)) return false
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
}

function isPid(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isErrno(error: unknown, codes: readonly string[]): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    codes.includes(String((error as { code?: unknown }).code))
  )
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** `~/.taskwraith/hosts`: the root a Host uses when nothing overrides it. */
export function hostRegistryDefaultRoot(home: string = homedir()): string {
  return join(home, '.taskwraith', 'hosts')
}

function configuredRoot(env: Readonly<NodeJS.ProcessEnv>): string | null {
  const configured = env[HOST_REGISTRY_ROOT_ENV]?.trim()
  return configured && isAbsolute(configured) ? configured : null
}

/**
 * `TASKWRAITH_HOST_REGISTRY_ROOT` from `env` when set and absolute, else from
 * `fallback` (this process's own environment), else `~/.taskwraith/hosts`. A
 * hand-built environment that omits the variable therefore still inherits the
 * process's override, which is how a test run's per-run root reaches it.
 */
export function resolveHostRegistryRoot(
  env: Readonly<NodeJS.ProcessEnv> = process.env,
  home: string = homedir(),
  fallback: Readonly<NodeJS.ProcessEnv> = process.env
): string {
  return configuredRoot(env) ?? configuredRoot(fallback) ?? hostRegistryDefaultRoot(home)
}

/** The socket-directory suffix: first 16 hex chars of sha256(profilePath). */
export function hostRegistryEntryId(profilePath: string): string {
  return createHash('sha256').update(profilePath).digest('hex').slice(0, 16)
}

export function hostRegistryEntryPath(root: string, profilePath: string): string {
  return join(root, `${hostRegistryEntryId(profilePath)}.json`)
}

/** realpath when the directory exists (the Host's lease path is a realpath), else the input. */
export function canonicalHostProfilePath(profilePath: string): string {
  try {
    return realpathSync(profilePath)
  } catch {
    return profilePath
  }
}

export function decodeHostRegistryEntry(value: unknown): HostRegistryEntryDecode {
  if (!isRecord(value)) return { ok: false, error: 'entry must be an object' }
  if (value.schema !== HOST_REGISTRY_SCHEMA) return { ok: false, error: 'unsupported schema' }
  if (!isBoundedString(value.profilePath, 4_096) || !isAbsolute(value.profilePath))
    return { ok: false, error: 'profilePath must be an absolute path' }
  if (!isPid(value.pid)) return { ok: false, error: 'pid must be a positive integer' }
  if (value.birthIdentity !== null && !isBoundedString(value.birthIdentity, 256))
    return { ok: false, error: 'birthIdentity must be a string or null' }
  if (!isCanonicalIso(value.startedAt))
    return { ok: false, error: 'startedAt must be canonical ISO' }
  if (!isBoundedString(value.hostId, 512)) return { ok: false, error: 'hostId must be a string' }
  if (value.bootEpoch !== null && !isBoundedString(value.bootEpoch, 512))
    return { ok: false, error: 'bootEpoch must be a string or null' }
  if (
    value.payloadVersion !== null &&
    (typeof value.payloadVersion !== 'string' ||
      !PAYLOAD_VERSION_PATTERN.test(value.payloadVersion))
  )
    return { ok: false, error: 'payloadVersion must be a SHA-256 identity or null' }
  if (!isBoundedString(value.socketPath, 1_000)) return { ok: false, error: 'socketPath invalid' }
  if (!isBoundedString(value.discoveryPath, 4_096))
    return { ok: false, error: 'discoveryPath invalid' }
  if (value.cliPath !== null && !isBoundedString(value.cliPath, 4_096))
    return { ok: false, error: 'cliPath must be a string or null' }
  if (value.nodeExecutable !== null && !isBoundedString(value.nodeExecutable, 4_096))
    return { ok: false, error: 'nodeExecutable must be a string or null' }
  if (typeof value.persist !== 'boolean') return { ok: false, error: 'persist must be boolean' }
  if (value.leaseMode !== 'lease') return { ok: false, error: 'leaseMode must be lease' }
  if (!isCanonicalIso(value.writtenAt))
    return { ok: false, error: 'writtenAt must be canonical ISO' }
  if (!isCount(value.beatSeq)) return { ok: false, error: 'beatSeq must be a count' }
  if (!isCount(value.holders)) return { ok: false, error: 'holders must be a count' }
  if (!isCount(value.implicitHolders))
    return { ok: false, error: 'implicitHolders must be a count' }
  if (typeof value.lifetimePhase !== 'string' || !LIFETIME_PHASE_PATTERN.test(value.lifetimePhase))
    return { ok: false, error: 'lifetimePhase invalid' }
  return {
    ok: true,
    entry: {
      schema: HOST_REGISTRY_SCHEMA,
      profilePath: value.profilePath,
      pid: value.pid,
      birthIdentity: value.birthIdentity as string | null,
      startedAt: value.startedAt,
      hostId: value.hostId,
      bootEpoch: value.bootEpoch as string | null,
      payloadVersion: value.payloadVersion as string | null,
      socketPath: value.socketPath,
      discoveryPath: value.discoveryPath,
      cliPath: value.cliPath as string | null,
      nodeExecutable: value.nodeExecutable as string | null,
      persist: value.persist,
      leaseMode: 'lease',
      writtenAt: value.writtenAt,
      beatSeq: value.beatSeq,
      holders: value.holders,
      implicitHolders: value.implicitHolders,
      lifetimePhase: value.lifetimePhase
    }
  }
}

function readEntryFile(path: string): HostRegistryEntryRead {
  let raw: string
  try {
    raw = readPrivateLocalControlArtifact(path, HOST_REGISTRY_MAX_ENTRY_BYTES)
  } catch (error) {
    // Only ENOENT is `missing`, the one read the self-check may stop on. A root
    // replaced by a file (ENOTDIR) or any other error is `unreadable`.
    if (isErrno(error, ['ENOENT'])) return { kind: 'missing', path }
    return { kind: 'unreadable', path, error: describe(error) }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return { kind: 'unreadable', path, error: `not JSON: ${describe(error)}` }
  }
  const decoded = decodeHostRegistryEntry(parsed)
  return decoded.ok
    ? { kind: 'present', entry: decoded.entry, path }
    : { kind: 'unreadable', path, error: decoded.error }
}

/** One profile's entry, by the profile's canonical path. */
export function readHostRegistryEntry(root: string, profilePath: string): HostRegistryEntryRead {
  return readEntryFile(hostRegistryEntryPath(root, canonicalHostProfilePath(profilePath)))
}

/** Every decodable entry under the root; a missing root is an empty registry. */
export function readHostRegistry(root: string): HostRegistryListing {
  let names: string[]
  try {
    names = readdirSync(root)
  } catch (error) {
    if (isErrno(error, ['ENOENT'])) return { root, entries: [], unreadable: [] }
    return { root, entries: [], unreadable: [{ path: root, error: describe(error) }] }
  }
  const entries: HostRegistryEntry[] = []
  const unreadable: { path: string; error: string }[] = []
  for (const name of names.sort()) {
    if (!name.endsWith('.json') || !ENTRY_ID_PATTERN.test(name.slice(0, -'.json'.length))) continue
    const read = readEntryFile(join(root, name))
    if (read.kind === 'present') entries.push(read.entry)
    else if (read.kind === 'unreadable') unreadable.push({ path: read.path, error: read.error })
  }
  return { root, entries, unreadable }
}

function sameStatIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

/**
 * Unlinks `path` only while it is still the exact file whose content was
 * judged: the inode is captured before the read and re-checked immediately
 * before the unlink, so a successor Host that atomically replaced the entry
 * in between (rename over the path) keeps its entry.
 */
export function removeHostRegistryEntryIfStill(
  path: string,
  judge: (entry: HostRegistryEntry) => boolean,
  unlink: (path: string) => void = unlinkSync
): boolean {
  let before: Stats
  try {
    before = lstatSync(path)
  } catch {
    return false
  }
  const read = readEntryFile(path)
  if (read.kind !== 'present' || !judge(read.entry)) return false
  let after: Stats
  try {
    after = lstatSync(path)
  } catch {
    return false
  }
  if (!sameStatIdentity(before, after)) return false
  unlink(path)
  return true
}

/** Who wrote an entry: a pid alone is reused by the operating system. */
export interface HostRegistryEntryIdentity {
  readonly pid: number
  readonly birthIdentity: string | null
  readonly bootEpoch: string | null
}

/**
 * Removes the entry for a profile only while it still names this exact Host:
 * the same pid, birth identity and boot epoch. A successor Host's entry is
 * never touched, even when the operating system handed it the same pid.
 */
export function removeHostRegistryEntryFor(
  root: string,
  profilePath: string,
  identity: HostRegistryEntryIdentity
): boolean {
  return removeHostRegistryEntryIfStill(
    hostRegistryEntryPath(root, canonicalHostProfilePath(profilePath)),
    (entry) =>
      entry.pid === identity.pid &&
      entry.birthIdentity === identity.birthIdentity &&
      entry.bootEpoch === identity.bootEpoch
  )
}

/** The production publisher: root from TASKWRAITH_HOST_REGISTRY_ROOT or `~/.taskwraith/hosts`. */
export function createHostRegistryPublisherFromEnvironment(input: {
  readonly profilePath: string
  readonly env?: Readonly<NodeJS.ProcessEnv>
  readonly cliPath?: string | null
  readonly nodeExecutable?: string | null
  readonly log?: (line: string) => void
}): HostRegistryPublisher {
  return new HostRegistryPublisher({
    root: resolveHostRegistryRoot(input.env ?? process.env),
    profilePath: input.profilePath,
    cliPath: input.cliPath ?? null,
    nodeExecutable: input.nodeExecutable ?? null,
    ...(input.log ? { log: input.log } : {})
  })
}

/**
 * The Host's own publisher. `publish` and `refresh` never throw: a registry
 * that cannot be written must not take a Host down. Until an entry has been
 * written, `check()` answers `unreadable`, which never stops anything.
 *
 * Once written, a failed write changes nothing the self-check sees: a write
 * that fails before its rename leaves the previous entry in place, and one
 * that fails after it keeps the complete new entry (never the helper's
 * rollback unlink, which would read as a deletion). So `check()` always reads
 * the file, and a deletion made while writes fail is still counted.
 */
export class HostRegistryPublisher implements HostRegistryPublisherPort {
  private readonly root: string
  private readonly options: HostRegistryPublisherOptions
  private entry: HostRegistryEntry | null = null
  private path: string | null = null
  /** An entry reached the path at least once (a rename happened). */
  private written = false
  /**
   * The self-check saw the entry deleted or taken over, or the Host removed
   * it: `refresh` never writes it again. Only a new `publish` clears it.
   */
  private relinquished = false

  constructor(options: HostRegistryPublisherOptions) {
    if (!isAbsolute(options.root)) throw new TypeError('Host registry root must be absolute.')
    if (!isAbsolute(options.profilePath))
      throw new TypeError('Host registry profile path must be absolute.')
    this.root = options.root
    this.options = options
  }

  get entryPath(): string | null {
    return this.path
  }

  get current(): HostRegistryEntry | null {
    return this.entry
  }

  publish(input: HostRegistryEntryInput): void {
    const now = (this.options.now ?? (() => new Date()))().toISOString()
    const platform = this.options.platform ?? process.platform
    // The Host names its lease path (a realpath); the entry id must hash the
    // same string the socket directory does, so a non-canonical spelling of
    // the publisher's own profile path is canonicalised the same way.
    const profilePath = canonicalHostProfilePath(input.profilePath)
    const pid = input.pid
    const self =
      pid === (this.options.pid ?? process.pid)
        ? (this.options.observeSelf ?? currentProcessBirthIdentity)()
        : ({ state: 'identity_unavailable' } as const)
    const entry: HostRegistryEntry = {
      schema: HOST_REGISTRY_SCHEMA,
      profilePath,
      pid,
      birthIdentity: self.state === 'live' ? self.birthIdentity : null,
      startedAt: input.startedAt,
      hostId: input.hostId,
      bootEpoch: input.bootEpoch ?? null,
      payloadVersion: input.payloadVersion ?? null,
      socketPath: input.socketPath ?? taskWraithHostSocketPath(profilePath, platform),
      discoveryPath: input.discoveryPath ?? taskWraithHostDiscoveryPath(profilePath),
      cliPath: this.options.cliPath ?? null,
      nodeExecutable: this.options.nodeExecutable ?? null,
      persist: input.persist,
      leaseMode: 'lease',
      writtenAt: now,
      beatSeq: 0,
      holders: input.holders,
      implicitHolders: input.implicitHolders,
      lifetimePhase: input.lifetimePhase
    }
    this.entry = entry
    this.path = hostRegistryEntryPath(this.root, profilePath)
    this.written = false
    this.relinquished = false
    this.write(entry, 'publish')
  }

  /**
   * Rewrites the entry with fresh counters only while the file at the path is
   * still this Host's, or could not be read (a rewrite repairs that). A
   * `missing` or `foreign` entry is left exactly as found, and so is anything
   * at the path once a check has seen either: the server's self-check runs
   * right after the refresh, and a refresh that recreated a deleted entry, or
   * overwrote a successor's, would make "stop after two missing checks"
   * unreachable.
   */
  refresh(patch: HostRegistryEntryRefresh): void {
    if (!this.entry || this.relinquished) return
    const verdict = this.check()
    if (verdict === 'missing' || verdict === 'foreign') return
    const now = (this.options.now ?? (() => new Date()))().toISOString()
    const entry: HostRegistryEntry = {
      ...this.entry,
      holders: patch.holders,
      implicitHolders: patch.implicitHolders,
      lifetimePhase: patch.lifetimePhase,
      writtenAt: now,
      beatSeq: this.entry.beatSeq + 1
    }
    this.entry = entry
    this.write(entry, 'refresh')
  }

  /**
   * `missing` (ENOENT) or `foreign` (readable, but pid / birthIdentity /
   * bootEpoch differ) are the self-check signals; `unreadable` (EIO, EACCES,
   * malformed, or an entry this publisher never managed to write) never is.
   * Either signal relinquishes the path: `refresh` never writes it again.
   */
  check(): HostRegistryCheckResult {
    if (!this.entry || !this.path || !this.written) return 'unreadable'
    const read = readEntryFile(this.path)
    if (read.kind === 'unreadable') return 'unreadable'
    const verdict: HostRegistryCheckResult =
      read.kind === 'missing' ? 'missing' : this.isOwn(read.entry) ? 'present' : 'foreign'
    if (verdict !== 'present') this.relinquished = true
    return verdict
  }

  /**
   * Removes the entry only while it still names this Host (pid, birth
   * identity and boot epoch), judged by content rather than by the inode of
   * the last successful write: a write that failed after its rename leaves
   * this Host's entry with an inode it never learned. The inode is re-checked
   * between the judged read and the unlink, so a successor that renamed its
   * entry over the path keeps it.
   */
  remove(): void {
    const path = this.path
    if (!path || !this.written) return
    this.relinquished = true
    try {
      if (removeHostRegistryEntryIfStill(path, (found) => this.isOwn(found))) return
      if (readEntryFile(path).kind === 'present')
        this.options.log?.('[host-registry] entry is foreign; left in place')
    } catch (error) {
      this.options.log?.(`[host-registry] entry removal failed: ${describe(error)}`)
    }
  }

  private isOwn(found: HostRegistryEntry): boolean {
    const own = this.entry
    return (
      own !== null &&
      found.pid === own.pid &&
      found.bootEpoch === own.bootEpoch &&
      found.birthIdentity === own.birthIdentity
    )
  }

  private write(entry: HostRegistryEntry, stage: 'publish' | 'refresh'): void {
    if (!this.path) return
    try {
      this.ensurePrivateRoot()
      publishPrivateLocalControlArtifact(
        this.path,
        `${JSON.stringify(entry)}\n`,
        HOST_REGISTRY_MAX_ENTRY_BYTES,
        {
          afterRename: () => {
            this.written = true
          },
          // A failure after the rename keeps the complete entry: unlinking it
          // would read as a deletion and strike this Host's own self-check.
          unlink: () => undefined
        }
      )
    } catch (error) {
      this.options.log?.(`[host-registry] ${stage} failed: ${describe(error)}`)
    }
  }

  /**
   * `mkdir` applies its mode only to a directory it creates; a root that
   * already exists group- or world-readable is tightened to owner-only. A
   * root this process cannot tighten (another owner, a symlink) is left as
   * found and logged: entries are owner-only files either way.
   */
  private ensurePrivateRoot(): void {
    mkdirSync(this.root, { recursive: true, mode: PRIVATE_DIRECTORY_MODE })
    if (process.platform === 'win32') return
    const stat = lstatSync(this.root)
    if (!stat.isDirectory() || (stat.mode & 0o077) === 0) return
    try {
      chmodSync(this.root, PRIVATE_DIRECTORY_MODE)
    } catch (error) {
      this.options.log?.(`[host-registry] could not make the root owner-only: ${describe(error)}`)
    }
  }
}

/** Connect probe with the same deadline HostLocalServer uses for a stale socket. */
export function hostSocketIsLive(
  socketPath: string,
  timeoutMs: number = HOST_REGISTRY_SOCKET_PROBE_MS
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(socketPath)
    let deadline: ReturnType<typeof setTimeout> | null = null
    const settle = (value: boolean) => {
      if (deadline) clearTimeout(deadline)
      socket.removeAllListeners()
      socket.destroy()
      resolve(value)
    }
    deadline = setTimeout(() => settle(false), timeoutMs)
    deadline.unref?.()
    socket.once('connect', () => settle(true))
    socket.once('error', () => settle(false))
  })
}

export interface HostRegistrySweepOptions {
  readonly root: string
  readonly platform?: NodeJS.Platform
  readonly temporaryDirectory?: string
  readonly uid?: number | string
  readonly observe?: (pid: number) => Promise<ProcessBirthObservation>
  readonly socketIsLive?: (socketPath: string) => Promise<boolean>
  readonly unlink?: (path: string) => void
  readonly rmdir?: (path: string) => void
  readonly log?: (line: string) => void
  /** Socket directories younger than this are kept (default HOST_REGISTRY_SWEEP_MIN_AGE_MS). */
  readonly minimumAgeMs?: number
  readonly now?: () => number
}

export interface HostRegistrySweepReport {
  readonly removedEntries: readonly string[]
  readonly keptEntries: readonly string[]
  readonly removedSocketDirectories: readonly string[]
  readonly keptSocketDirectories: readonly string[]
}

function currentUid(): string {
  return typeof process.getuid === 'function' ? String(process.getuid()) : 'user'
}

function newestChange(stat: Stats): number {
  return Math.max(stat.mtimeMs, stat.ctimeMs)
}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path)
  } catch {
    return null
  }
}

/**
 * True while the socket path is exactly what was probed: still absent, or the
 * same inode with no change since. A Host that re-bound the path between the
 * probe and now owns a new inode, so its socket is never unlinked.
 */
function socketUnchangedSinceProbe(socketPath: string, probed: Stats | null): boolean {
  const current = lstatOrNull(socketPath)
  if (probed === null || current === null) return probed === current
  return sameStatIdentity(probed, current) && newestChange(probed) === newestChange(current)
}

/**
 * Unlinks a Host socket only when it does not answer and is still exactly the
 * file that was probed: a Host that re-bound the path in between keeps it.
 */
export async function unlinkDeadHostSocket(
  socketPath: string,
  socketIsLive: (socketPath: string) => Promise<boolean> = hostSocketIsLive,
  unlink: (path: string) => void = unlinkSync
): Promise<boolean> {
  const probed = lstatOrNull(socketPath)
  if (!probed || (await socketIsLive(socketPath))) return false
  if (!socketUnchangedSinceProbe(socketPath, probed)) return false
  try {
    unlink(socketPath)
    return true
  } catch {
    return false
  }
}

/**
 * Removes registry entries whose pid is dead or born at another time, and
 * `twh2-<uid>-*` socket directories whose socket does not answer and whose
 * entry is absent or dead. A directory whose socket answers is never removed;
 * neither is one whose entry names a Host verified alive but not answering
 * (that is verified termination's job, not the sweep's), nor one changed
 * within the last HOST_REGISTRY_SWEEP_MIN_AGE_MS (a Host may be starting in
 * it). An entry is removed only while it still names the pid and birth that
 * were judged dead.
 */
export async function sweepHostRegistry(
  options: HostRegistrySweepOptions
): Promise<HostRegistrySweepReport> {
  const platform = options.platform ?? process.platform
  const observe = options.observe ?? ((pid: number) => observeProcessBirthIdentity(pid))
  const socketIsLive = options.socketIsLive ?? hostSocketIsLive
  const unlink = options.unlink ?? unlinkSync
  const rmdir = options.rmdir ?? rmdirSync
  const minimumAgeMs = options.minimumAgeMs ?? HOST_REGISTRY_SWEEP_MIN_AGE_MS
  const now = options.now ?? (() => Date.now())
  const listing = readHostRegistry(options.root)
  const removedEntries: string[] = []
  const keptEntries: string[] = []
  const liveEntryIds = new Set<string>()
  for (const entry of listing.entries) {
    const id = hostRegistryEntryId(entry.profilePath)
    const observation = await observe(entry.pid)
    const gone =
      observation.state === 'dead' ||
      (observation.state === 'live' &&
        entry.birthIdentity !== null &&
        observation.birthIdentity !== entry.birthIdentity)
    if (gone) {
      try {
        const removed = removeHostRegistryEntryIfStill(
          hostRegistryEntryPath(options.root, entry.profilePath),
          (current) =>
            current.pid === entry.pid &&
            current.birthIdentity === entry.birthIdentity &&
            current.bootEpoch === entry.bootEpoch,
          unlink
        )
        if (removed) {
          removedEntries.push(id)
          continue
        }
      } catch (error) {
        options.log?.(`[host-registry] sweep could not remove entry ${id}: ${describe(error)}`)
      }
    }
    keptEntries.push(id)
    liveEntryIds.add(id)
  }

  const removedSocketDirectories: string[] = []
  const keptSocketDirectories: string[] = []
  if (platform !== 'win32') {
    const temporaryDirectory = options.temporaryDirectory ?? tmpdir()
    const uid = String(options.uid ?? currentUid())
    let names: string[] = []
    try {
      names = readdirSync(temporaryDirectory)
    } catch (error) {
      options.log?.(
        `[host-registry] sweep could not list ${temporaryDirectory}: ${describe(error)}`
      )
    }
    for (const name of names.sort()) {
      const match = SOCKET_DIRECTORY_PATTERN.exec(name)
      if (!match || match[1] !== uid) continue
      const directory = join(temporaryDirectory, name)
      let directoryStat: Stats | null = null
      try {
        directoryStat = lstatSync(directory)
      } catch {
        directoryStat = null
      }
      if (!directoryStat?.isDirectory()) continue
      const socketPath = join(directory, TASKWRAITH_HOST_SOCKET_FILE)
      let socketStat: Stats | null = null
      try {
        socketStat = lstatSync(socketPath)
      } catch {
        socketStat = null
      }
      const newest = Math.max(
        newestChange(directoryStat),
        socketStat ? newestChange(socketStat) : 0
      )
      if (now() - newest < minimumAgeMs) {
        keptSocketDirectories.push(name)
        continue
      }
      if (socketStat && (await socketIsLive(socketPath))) {
        keptSocketDirectories.push(name)
        continue
      }
      if (liveEntryIds.has(match[2])) {
        keptSocketDirectories.push(name)
        continue
      }
      if (!socketUnchangedSinceProbe(socketPath, socketStat)) {
        keptSocketDirectories.push(name)
        continue
      }
      try {
        if (socketStat) unlink(socketPath)
        rmdir(directory)
        removedSocketDirectories.push(name)
      } catch (error) {
        if (!isErrno(error, ['ENOENT'])) {
          options.log?.(`[host-registry] sweep left ${name} in place: ${describe(error)}`)
        }
        keptSocketDirectories.push(name)
      }
    }
  }
  return { removedEntries, keptEntries, removedSocketDirectories, keptSocketDirectories }
}
