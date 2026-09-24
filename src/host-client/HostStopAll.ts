import { posix, win32 } from 'node:path'

import {
  canonicalHostProfilePath,
  readHostRegistry,
  resolveHostRegistryRoot,
  sweepHostRegistry,
  type HostRegistryEntry,
  type HostRegistryListing,
  type HostRegistrySweepReport
} from '../host-runtime/HostRegistry'
import {
  PROCESS_BIRTH_START_TOLERANCE_MS,
  listProcessCommandLines,
  observeProcessBirthIdentity,
  type ProcessBirthObservation,
  type ProcessCommandLineListing
} from '../host-runtime/ProcessBirthIdentity'
import {
  HOST_TERMINATION_SUCCESS_KINDS,
  parseHostServeCommandLine,
  readHostTerminationEvidence,
  terminateHostProcess,
  type HostTerminationEvidence,
  type HostTerminationExpectedHost,
  type HostTerminationOutcome
} from './HostProcessTermination'

/**
 * Machine-wide `stop-all` over the Host registry.
 *
 * Scope is always explicit: with no scope the verb only lists (the CLI exits
 * 3), `--profile` names one profile, `--payload-root` selects the Hosts whose
 * registry entry recorded a CLI under one payload directory, and `--all`
 * selects every verified Host (the install script and the TUI verb, after
 * confirmation). Each selected Host goes through verified termination, which
 * never signals a pid whose birth or command line it cannot confirm.
 *
 * Termination by profile acts on whichever Host holds the profile when it
 * runs, unless the caller supplies `expected` (the CLI's paired
 * `--expect-pid` and `--expect-birth`). An explicit expectation confines a
 * profile stop to that one Host and refuses a replacement. `--payload-root` does not work that
 * way: each selected entry names one Host by pid and birth, and termination
 * acts on that Host or on none (HostTerminationInput.expected), so it never
 * reaches the installed app's Host, a build that publishes no entry, or a
 * Host whose registry write failed. When the entry's Host is gone and another
 * Host holds its profile, only the entry's own proven-stale records go: that
 * is a success, and a note names the other Host, which keeps running. When a
 * Host that was running when listed has been replaced by another by the time
 * it is stopped, the run refuses it, names the new Host, and exits 1. An
 * entry that recorded no birth cannot show which process it names, so it is
 * refused unless its pid is dead; `--profile` stops it. `--all` checks
 * nothing of this: a dead entry under `--all` stops whichever Host holds its
 * profile now, even one the listing never showed.
 *
 * `--scan-argv` adds Hosts started before the registry existed (one release
 * only): a `host-runtime/cli.js serve … --profile <p>` process is a candidate
 * only when that profile's discovery and authority lease both name its pid
 * and the lease's recorded process start is within
 * PROCESS_BIRTH_START_TOLERANCE_MS of the observed start. Every process that
 * names a profile is judged, so a look-alike (a wrapper, a hand-typed
 * command) can never hide the genuine Host; anything unverified is listed and
 * left alone. Under `--payload-root` a scanned Host is named by its pid and
 * the birth observed while scanning, like an entry. Windows has no argv scan
 * here.
 *
 * `--sweep` then removes dead registry entries and socket directories: with
 * `--profile` or `--payload-root` only the selected Hosts' own (termination
 * has already removed each one's proven-stale discovery, token and lease), and
 * every profile's only with `--all`. It needs a scope like any other
 * mutation, and a listing never sweeps.
 */

export type HostStopAllScope =
  | { readonly kind: 'list' }
  | { readonly kind: 'all' }
  | { readonly kind: 'profile'; readonly profilePath: string }
  | { readonly kind: 'payload-root'; readonly payloadRoot: string }

export type HostStopAllLiveness =
  | 'live'
  | 'dead'
  | 'pid_reused'
  | 'identity_unavailable'
  | 'unverified'
  | 'unknown'

export type HostStopAllSource = 'registry' | 'argv' | 'profile'

export interface HostStopAllHost {
  readonly source: HostStopAllSource
  readonly profilePath: string
  readonly pid: number | null
  /** The registry's recorded birth, or the birth observed for a scanned Host. */
  readonly birthIdentity: string | null
  readonly cliPath: string | null
  readonly payloadVersion: string | null
  readonly startedAt: string | null
  readonly holders: number | null
  readonly implicitHolders: number | null
  readonly persist: boolean | null
  readonly liveness: HostStopAllLiveness
  readonly selected: boolean
  readonly outcome?: HostTerminationOutcome
  readonly note?: string
}

export interface HostStopAllReport {
  readonly registryRoot: string
  readonly scope: HostStopAllScope
  readonly scanArgv: boolean
  readonly hosts: readonly HostStopAllHost[]
  readonly unreadableEntries: readonly { readonly path: string; readonly error: string }[]
  readonly scan?: { readonly ok: boolean; readonly reason?: string }
  readonly sweep?: HostRegistrySweepReport
  /** 0 every selected Host is gone, 1 one or more refused or failed, 3 listed only. */
  readonly exitCode: 0 | 1 | 3
}

export interface HostStopAllPorts {
  readRegistry(root: string): HostRegistryListing
  listProcesses(): Promise<ProcessCommandLineListing>
  observe(pid: number): Promise<ProcessBirthObservation>
  readEvidence(profilePath: string, registryRoot: string): HostTerminationEvidence
  terminate(input: {
    readonly profilePath: string
    readonly registryRoot: string
    /** The one Host this termination may act on, when identity-bound. */
    readonly expected?: HostTerminationExpectedHost
  }): Promise<HostTerminationOutcome>
  /** The registry sweep over these profiles' records only, or machine-wide when null. */
  sweep(
    registryRoot: string,
    profilePaths: readonly string[] | null
  ): Promise<HostRegistrySweepReport>
}

export interface HostStopAllOptions {
  readonly scope: HostStopAllScope
  /** Only with profile scope: stop this Host, refusing a replacement. */
  readonly expected?: HostTerminationExpectedHost
  readonly scanArgv?: boolean
  readonly sweep?: boolean
  readonly registryRoot?: string
  readonly platform?: NodeJS.Platform
  readonly env?: Readonly<NodeJS.ProcessEnv>
  /** Termination progress lines (the CLI sends them to stderr). */
  readonly log?: (line: string) => void
  readonly ports?: Partial<HostStopAllPorts>
}

function pathApi(platform: NodeJS.Platform): typeof posix {
  return platform === 'win32' ? win32 : posix
}

function canonical(path: string, platform: NodeJS.Platform): string {
  const value = canonicalHostProfilePath(pathApi(platform).resolve(path))
  return platform === 'win32' ? value.toLowerCase() : value
}

/** Whether `cliPath` lives under `payloadRoot` (both compared canonically). */
export function isUnderPayloadRoot(
  cliPath: string | null,
  payloadRoot: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  if (!cliPath) return false
  const api = pathApi(platform)
  const root = canonical(payloadRoot, platform)
  const candidates = [canonical(cliPath, platform), canonical(api.dirname(cliPath), platform)]
  return candidates.some((candidate) => candidate.startsWith(`${root}${api.sep}`))
}

/** `…/host-runtime/cli.js` immediately followed (after an optional quote) by `serve`. */
const SERVE_CLI = /host-runtime[\\/]cli\.js"?\s+serve(?:\s|$)/

/**
 * The argv form of the payload-root test for a scanned process: the CLI token
 * that `serve` follows must be exactly `<payloadRoot>/host-runtime/cli.js`.
 * The match is anchored at both ends of that token — it must start the line
 * or follow whitespace or a quote — so a CLI that merely ends with the needle
 * (`/Volumes/Backup/Users/me/repo/out/host/…` for `/Users/me/repo/out/host`)
 * is another payload, and a needle elsewhere on the line (inside a profile
 * path) is never the CLI.
 */
export function commandServesPayloadRoot(
  commandLine: string,
  payloadRoot: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  const api = pathApi(platform)
  const fold = (value: string): string => (platform === 'win32' ? value.toLowerCase() : value)
  const line = fold(commandLine)
  const serve = SERVE_CLI.exec(line)
  if (!serve) return false
  const cli = line.slice(0, serve.index + 'host-runtime/cli.js'.length)
  const roots = new Set([api.resolve(payloadRoot), canonical(payloadRoot, platform)])
  return [...roots].some((root) => {
    const needle = fold(api.join(root, 'host-runtime', 'cli.js'))
    if (!cli.endsWith(needle)) return false
    const start = cli.length - needle.length
    return start === 0 || /[\s"]/.test(cli[start - 1])
  })
}

function registryLiveness(
  entry: HostRegistryEntry,
  observation: ProcessBirthObservation
): HostStopAllLiveness {
  if (observation.state === 'dead') return 'dead'
  if (observation.state === 'identity_unavailable') return 'identity_unavailable'
  if (entry.birthIdentity === null) return 'unverified'
  return observation.birthIdentity === entry.birthIdentity ? 'live' : 'pid_reused'
}

function defaultPorts(
  platform: NodeJS.Platform,
  log: ((line: string) => void) | undefined
): HostStopAllPorts {
  return {
    readRegistry: readHostRegistry,
    listProcesses: () => listProcessCommandLines({ platform }),
    observe: (pid) => observeProcessBirthIdentity(pid),
    readEvidence: readHostTerminationEvidence,
    terminate: (input) =>
      terminateHostProcess({ ...input, platform, ...(log ? { ports: { log } } : {}) }),
    sweep: (registryRoot, profilePaths) =>
      sweepHostRegistry({
        root: registryRoot,
        platform,
        ...(profilePaths ? { profilePaths } : {}),
        ...(log ? { log } : {})
      })
  }
}

interface Candidate extends Omit<HostStopAllHost, 'selected' | 'outcome'> {
  readonly key: string
  /** For a scanned Host: the joined command line, for payload-root matching. */
  readonly commandLine?: string
  /** The Host this candidate names: the entry's pid and birth, or the scanned ones. */
  readonly identity?: HostTerminationExpectedHost
}

async function registryCandidates(
  listing: HostRegistryListing,
  ports: HostStopAllPorts,
  platform: NodeJS.Platform
): Promise<Candidate[]> {
  return Promise.all(
    listing.entries.map(async (entry): Promise<Candidate> => {
      const observation = await ports.observe(entry.pid)
      return {
        key: canonical(entry.profilePath, platform),
        source: 'registry',
        profilePath: entry.profilePath,
        pid: entry.pid,
        birthIdentity: entry.birthIdentity,
        cliPath: entry.cliPath,
        payloadVersion: entry.payloadVersion,
        startedAt: entry.startedAt,
        holders: entry.holders,
        implicitHolders: entry.implicitHolders,
        persist: entry.persist,
        liveness: registryLiveness(entry, observation),
        identity: { pid: entry.pid, birthIdentity: entry.birthIdentity }
      }
    })
  )
}

async function scannedCandidates(
  known: ReadonlySet<string>,
  registryRoot: string,
  ports: HostStopAllPorts,
  platform: NodeJS.Platform
): Promise<{ readonly scan: { ok: boolean; reason?: string }; readonly hosts: Candidate[] }> {
  const listing = await ports.listProcesses()
  if (!listing.ok) return { scan: { ok: false, reason: listing.reason }, hosts: [] }
  const hosts: Candidate[] = []
  const evidenceByProfile = new Map<string, HostTerminationEvidence>()
  // Every process naming a profile is judged on its own: at most one can match
  // that profile's discovery and lease, and a look-alike listed first (a lower
  // pid) must not hide it.
  for (const process_ of listing.processes) {
    const parsed = parseHostServeCommandLine(process_.commandLine)
    if (!parsed) continue
    const key = canonical(parsed.profilePath, platform)
    if (known.has(key)) continue
    let evidence = evidenceByProfile.get(key)
    if (!evidence) {
      evidence = ports.readEvidence(parsed.profilePath, registryRoot)
      evidenceByProfile.set(key, evidence)
    }
    const observation = await ports.observe(process_.pid)
    let liveness: HostStopAllLiveness = 'unverified'
    let note: string | undefined
    if (observation.state === 'dead') liveness = 'dead'
    else if (observation.state === 'identity_unavailable') liveness = 'identity_unavailable'
    else if (evidence.discovery?.pid !== process_.pid || evidence.lease?.pid !== process_.pid) {
      note = 'discovery and lease do not both name this pid'
    } else {
      const recorded = Date.parse(evidence.lease.processStartedAt)
      if (
        observation.startedAtMs !== null &&
        Number.isFinite(recorded) &&
        Math.abs(observation.startedAtMs - recorded) <= PROCESS_BIRTH_START_TOLERANCE_MS
      ) {
        liveness = 'live'
      } else {
        note = 'process start does not match the lease within 2 s'
      }
    }
    hosts.push({
      key,
      source: 'argv',
      profilePath: parsed.profilePath,
      pid: process_.pid,
      birthIdentity: observation.state === 'live' ? observation.birthIdentity : null,
      cliPath: parsed.cliPath,
      payloadVersion: null,
      startedAt: evidence.discovery?.pid === process_.pid ? evidence.discovery.startedAt : null,
      holders: null,
      implicitHolders: null,
      persist: null,
      liveness,
      commandLine: process_.commandLine,
      ...(observation.state === 'live'
        ? { identity: { pid: process_.pid, birthIdentity: observation.birthIdentity } }
        : {}),
      ...(note ? { note } : {})
    })
  }
  return { scan: { ok: true }, hosts }
}

function reportedHost(
  candidate: Candidate,
  selected: boolean,
  outcome: HostTerminationOutcome | undefined,
  outcomeNote?: string
): HostStopAllHost {
  const note = [candidate.note, outcomeNote].filter(Boolean).join('; ')
  return {
    source: candidate.source,
    profilePath: candidate.profilePath,
    pid: candidate.pid,
    birthIdentity: candidate.birthIdentity,
    cliPath: candidate.cliPath,
    payloadVersion: candidate.payloadVersion,
    startedAt: candidate.startedAt,
    holders: candidate.holders,
    implicitHolders: candidate.implicitHolders,
    persist: candidate.persist,
    liveness: candidate.liveness,
    selected,
    ...(outcome ? { outcome } : {}),
    ...(note ? { note } : {})
  }
}

/**
 * With an expected Host, termination acts only on that Host, and `heldBy`
 * names another Host that holds the profile instead; that Host was left
 * alone. An expected Host already gone when it was selected (a dead entry, or
 * a reused pid) needed only its own records swept, so the outcome stands and
 * gains a note. Otherwise the expected Host was replaced after it was
 * selected: even though it is gone, that is refused, and counts as a failure.
 */
function expectedHostOutcome(
  outcome: HostTerminationOutcome,
  goneWhenSelected: boolean
): { readonly outcome: HostTerminationOutcome; readonly note?: string } {
  if (outcome.heldBy === undefined) return { outcome }
  if (goneWhenSelected) {
    return {
      outcome,
      note: `another Host (pid ${outcome.heldBy}) holds the profile now, outside this scope`
    }
  }
  const note = `another Host (pid ${outcome.heldBy}) holds the profile now, not the expected one; it was left running`
  return {
    outcome: HOST_TERMINATION_SUCCESS_KINDS.has(outcome.kind)
      ? { ...outcome, kind: 'inconsistent', detail: note }
      : outcome,
    note
  }
}

function selects(
  candidate: Candidate,
  scope: HostStopAllScope,
  platform: NodeJS.Platform
): boolean {
  // An unverified scanned process is listed, never stopped; a registry entry
  // is always handed to verified termination, which sweeps a dead or reused
  // entry and refuses an unobservable one.
  if (candidate.source === 'argv' && candidate.liveness !== 'live') return false
  switch (scope.kind) {
    case 'list':
      return false
    case 'all':
      return true
    case 'profile':
      return candidate.key === canonical(scope.profilePath, platform)
    case 'payload-root':
      return candidate.source === 'argv'
        ? commandServesPayloadRoot(candidate.commandLine ?? '', scope.payloadRoot, platform)
        : isUnderPayloadRoot(candidate.cliPath, scope.payloadRoot, platform)
  }
}

export async function stopAllHosts(options: HostStopAllOptions): Promise<HostStopAllReport> {
  if (options.expected && options.scope.kind !== 'profile')
    throw new Error('An expected Host requires profile scope.')
  const platform = options.platform ?? process.platform
  const ports: HostStopAllPorts = { ...defaultPorts(platform, options.log), ...options.ports }
  const registryRoot = options.registryRoot ?? resolveHostRegistryRoot(options.env ?? process.env)
  const scanArgv = options.scanArgv === true
  const listing = ports.readRegistry(registryRoot)
  const candidates = await registryCandidates(listing, ports, platform)
  let scan: HostStopAllReport['scan']
  if (scanArgv) {
    const scanned = await scannedCandidates(
      new Set(candidates.map((candidate) => candidate.key)),
      registryRoot,
      ports,
      platform
    )
    scan = scanned.scan
    candidates.push(...scanned.hosts)
  }
  if (
    options.scope.kind === 'profile' &&
    !candidates.some((candidate) => selects(candidate, options.scope, platform))
  ) {
    // An explicit profile is stopped by its own artefacts even when it has no
    // registry entry (a pre-registry Host, or one whose entry was removed).
    const evidence = ports.readEvidence(options.scope.profilePath, registryRoot)
    const pid =
      options.expected?.pid ??
      evidence.registry?.pid ??
      evidence.lease?.pid ??
      evidence.discovery?.pid ??
      null
    const observation = pid === null ? null : await ports.observe(pid)
    const birthIdentity = options.expected
      ? (options.expected.birthIdentity ?? null)
      : evidence.registry?.pid === pid
        ? evidence.registry.birthIdentity
        : observation?.state === 'live'
          ? observation.birthIdentity
          : null
    candidates.push({
      key: canonical(options.scope.profilePath, platform),
      source: 'profile',
      profilePath: options.scope.profilePath,
      pid,
      birthIdentity,
      cliPath: null,
      payloadVersion: null,
      startedAt: options.expected ? null : (evidence.discovery?.startedAt ?? null),
      holders: null,
      implicitHolders: null,
      persist: null,
      liveness: 'unknown'
    })
  }

  const payloadRoot = options.scope.kind === 'payload-root'
  const hosts = await Promise.all(
    candidates.map(async (candidate): Promise<HostStopAllHost> => {
      if (!selects(candidate, options.scope, platform)) {
        return reportedHost(candidate, false, undefined)
      }
      const expected = options.expected ?? (payloadRoot ? candidate.identity : undefined)
      const outcome = await ports.terminate({
        profilePath: candidate.profilePath,
        registryRoot,
        ...(expected ? { expected } : {})
      })
      if (!expected) return reportedHost(candidate, true, outcome)
      // An explicit caller expectation names the action's target even if its
      // records have vanished or now describe a successor. Do not report that
      // successor's pid or metadata as though it were the Host we acted on.
      const reported =
        options.expected &&
        (candidate.pid !== expected.pid || candidate.birthIdentity !== expected.birthIdentity)
          ? {
              ...candidate,
              source: 'profile' as const,
              pid: expected.pid,
              birthIdentity: expected.birthIdentity ?? null,
              cliPath: null,
              payloadVersion: null,
              startedAt: null,
              holders: null,
              implicitHolders: null,
              persist: null,
              liveness: 'unknown' as const
            }
          : candidate
      const gone =
        !options.expected && (candidate.liveness === 'dead' || candidate.liveness === 'pid_reused')
      const scoped = expectedHostOutcome(outcome, gone)
      return reportedHost(reported, true, scoped.outcome, scoped.note)
    })
  )
  // A listing changes nothing, a sweep included. A scoped sweep stays in its
  // scope: the selected Hosts' own records, whatever else is dead.
  const sweep =
    options.sweep === true && options.scope.kind !== 'list'
      ? await ports.sweep(
          registryRoot,
          options.scope.kind === 'all'
            ? null
            : hosts.filter((host) => host.selected).map((host) => host.profilePath)
        )
      : undefined
  const failed = hosts.some(
    (host) => host.outcome && !HOST_TERMINATION_SUCCESS_KINDS.has(host.outcome.kind)
  )
  return {
    registryRoot,
    scope: options.scope,
    scanArgv,
    hosts,
    unreadableEntries: listing.unreadable,
    ...(scan ? { scan } : {}),
    ...(sweep ? { sweep } : {}),
    exitCode: options.scope.kind === 'list' ? 3 : failed ? 1 : 0
  }
}

/** One human line per Host, then the sweep and any unreadable entries. */
export function formatHostStopAllReport(report: HostStopAllReport): string {
  const lines: string[] = []
  if (!report.hosts.length) lines.push(`No TaskWraith Hosts in ${report.registryRoot}.`)
  for (const host of report.hosts) {
    const fields = [
      host.pid === null ? 'pid ?' : `pid ${host.pid}`,
      host.liveness,
      host.source,
      host.profilePath
    ]
    if (host.cliPath) fields.push(host.cliPath)
    if (host.holders !== null) fields.push(`holders ${host.holders}+${host.implicitHolders ?? 0}`)
    if (host.persist) fields.push('persist')
    fields.push(host.outcome ? `-> ${host.outcome.kind}` : host.selected ? '-> selected' : 'listed')
    if (host.note) fields.push(`(${host.note})`)
    lines.push(fields.join(' · '))
  }
  if (report.scan && !report.scan.ok) lines.push(`argv scan unavailable (${report.scan.reason})`)
  for (const entry of report.unreadableEntries) {
    lines.push(`unreadable registry entry ${entry.path}: ${entry.error}`)
  }
  if (report.sweep) {
    lines.push(
      `swept ${report.sweep.removedEntries.length} registry entr${
        report.sweep.removedEntries.length === 1 ? 'y' : 'ies'
      } and ${report.sweep.removedSocketDirectories.length} socket director${
        report.sweep.removedSocketDirectories.length === 1 ? 'y' : 'ies'
      }`
    )
  }
  if (report.exitCode === 3) {
    lines.push('Listed only: pass --all, --profile <path> or --payload-root <dir> to stop Hosts.')
  }
  return `${lines.join('\n')}\n`
}
