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
  type HostTerminationOutcome
} from './HostProcessTermination'

/**
 * Machine-wide `stop-all` over the Host registry.
 *
 * Scope is always explicit: with no scope the verb only lists (the CLI exits
 * 3), `--profile` names one profile, `--payload-root` selects the Hosts whose
 * recorded CLI lives under one payload directory (the build hook passes this
 * repository's `out/host`, so a rebuild never touches the production app's
 * Host or a peer's `/verify` Host), and `--all` selects every verified Host
 * (the install script and the TUI verb, after confirmation). Each selected
 * Host goes through verified termination, which never signals a pid whose
 * birth or command line it cannot confirm.
 *
 * `--scan-argv` adds Hosts started before the registry existed (one release
 * only): a `host-runtime/cli.js serve … --profile <p>` process is a candidate
 * only when that profile's discovery and authority lease both name its pid
 * and the lease's recorded process start is within
 * PROCESS_BIRTH_START_TOLERANCE_MS of the observed start. Anything else is
 * listed as unverified and left alone. Windows has no argv scan here.
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
  }): Promise<HostTerminationOutcome>
  sweep(registryRoot: string): Promise<HostRegistrySweepReport>
}

export interface HostStopAllOptions {
  readonly scope: HostStopAllScope
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

/**
 * The argv form of the payload-root test for a scanned process: the joined
 * command line must name `<payloadRoot>/host-runtime/cli.js` literally.
 */
function commandServesPayloadRoot(
  commandLine: string,
  payloadRoot: string,
  platform: NodeJS.Platform
): boolean {
  const api = pathApi(platform)
  const roots = new Set([api.resolve(payloadRoot), canonical(payloadRoot, platform)])
  const haystack = platform === 'win32' ? commandLine.toLowerCase() : commandLine
  return [...roots].some((root) => {
    const needle = api.join(root, 'host-runtime', 'cli.js')
    return haystack.includes(platform === 'win32' ? needle.toLowerCase() : needle)
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
    sweep: (registryRoot) =>
      sweepHostRegistry({ root: registryRoot, platform, ...(log ? { log } : {}) })
  }
}

interface Candidate extends Omit<HostStopAllHost, 'selected' | 'outcome'> {
  readonly key: string
  /** For a scanned Host: the joined command line, for payload-root matching. */
  readonly commandLine?: string
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
        cliPath: entry.cliPath,
        payloadVersion: entry.payloadVersion,
        startedAt: entry.startedAt,
        holders: entry.holders,
        implicitHolders: entry.implicitHolders,
        persist: entry.persist,
        liveness: registryLiveness(entry, observation)
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
  const seen = new Set<string>()
  for (const process_ of listing.processes) {
    const parsed = parseHostServeCommandLine(process_.commandLine)
    if (!parsed) continue
    const key = canonical(parsed.profilePath, platform)
    if (known.has(key) || seen.has(key)) continue
    seen.add(key)
    const evidence = ports.readEvidence(parsed.profilePath, registryRoot)
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
      cliPath: parsed.cliPath,
      payloadVersion: null,
      startedAt: evidence.discovery?.pid === process_.pid ? evidence.discovery.startedAt : null,
      holders: null,
      implicitHolders: null,
      persist: null,
      liveness,
      commandLine: process_.commandLine,
      ...(note ? { note } : {})
    })
  }
  return { scan: { ok: true }, hosts }
}

function reportedHost(
  candidate: Candidate,
  selected: boolean,
  outcome: HostTerminationOutcome | undefined
): HostStopAllHost {
  return {
    source: candidate.source,
    profilePath: candidate.profilePath,
    pid: candidate.pid,
    cliPath: candidate.cliPath,
    payloadVersion: candidate.payloadVersion,
    startedAt: candidate.startedAt,
    holders: candidate.holders,
    implicitHolders: candidate.implicitHolders,
    persist: candidate.persist,
    liveness: candidate.liveness,
    selected,
    ...(outcome ? { outcome } : {}),
    ...(candidate.note ? { note: candidate.note } : {})
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
    const pid = evidence.registry?.pid ?? evidence.lease?.pid ?? evidence.discovery?.pid ?? null
    candidates.push({
      key: canonical(options.scope.profilePath, platform),
      source: 'profile',
      profilePath: options.scope.profilePath,
      pid,
      cliPath: null,
      payloadVersion: null,
      startedAt: evidence.discovery?.startedAt ?? null,
      holders: null,
      implicitHolders: null,
      persist: null,
      liveness: 'unknown'
    })
  }

  const hosts = await Promise.all(
    candidates.map(async (candidate): Promise<HostStopAllHost> => {
      const selected = selects(candidate, options.scope, platform)
      const outcome = selected
        ? await ports.terminate({ profilePath: candidate.profilePath, registryRoot })
        : undefined
      return reportedHost(candidate, selected, outcome)
    })
  )
  const sweep = options.sweep === true ? await ports.sweep(registryRoot) : undefined
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
