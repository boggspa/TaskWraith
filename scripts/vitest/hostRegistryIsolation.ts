import { execFileSync } from 'node:child_process'
import { lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'

import {
  HOST_REGISTRY_ROOT_ENV,
  hostRegistryDefaultRoot
} from '../../src/host-runtime/HostRegistry'

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
 * Host uses when the variable is absent) for the whole run and fails it —
 * exit code 1 after the summary — when an entry there was written, rewritten
 * or removed by this run: a Host whose spawn environment dropped the variable,
 * or a test that swept the real root. It watches that root under both HOME and
 * the password database's home directory: a child spawned with a scrubbed
 * environment and no HOME resolves the latter. Polling sees a Host's entry
 * for its whole life, not only what is left at the end, so a Host that stops
 * cleanly and removes its entry is still caught.
 *
 * Writes by processes that are not descendants of this run are exempt: a
 * real Host (the app, a /verify instance, another agent's Host) keeps
 * publishing and refreshing during a test run. An entry is attributed by the
 * pid it names, walked up the process table to this vitest process while it
 * is still alive. Anything that cannot be attributed (a dead writer, a
 * malformed file, no process table on Windows) counts against the run: the
 * guard would rather be loud than let a test write into a user's registry.
 */

const POLL_INTERVAL_MS = 250
const RUN_ROOT_PREFIX = 'taskwraith-vitest-host-registry-'
/** The publisher's rename-into-place temporaries: `.<entry>.<pid>.<uuid>.tmp`. */
const PUBLISH_TEMPORARY = /^\..*\.tmp$/

export interface RegistryFileState {
  /** File identity, compared before any re-read. */
  readonly stamp: string
  /** Null when the path is not a readable regular file. */
  readonly content: string | null
  /** The pid the file names, when it names one. */
  readonly pid: number | null
}

/** Null means the root does not exist. */
export type RegistrySnapshot = ReadonlyMap<string, RegistryFileState> | null

export type ProcessParents = ReadonlyMap<number, number>

export type RegistryWriterAttribution = 'this-run' | 'other' | 'unknown'

export interface RegistryIsolationViolation {
  readonly name: string
  readonly change: 'created' | 'rewritten' | 'removed' | 'root-created'
  readonly pid: number | null
  readonly attribution: RegistryWriterAttribution | 'baseline-stale'
  readonly detail: string
}

function isErrno(error: unknown, codes: readonly string[]): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    codes.includes(String((error as { code?: unknown }).code))
  )
}

function pidOf(content: string | null): number | null {
  if (content === null) return null
  try {
    const parsed = JSON.parse(content) as { pid?: unknown }
    return typeof parsed.pid === 'number' && Number.isSafeInteger(parsed.pid) && parsed.pid > 0
      ? parsed.pid
      : null
  } catch {
    return null
  }
}

function profileOf(content: string | null): string | null {
  if (content === null) return null
  try {
    const parsed = JSON.parse(content) as { profilePath?: unknown }
    return typeof parsed.profilePath === 'string' ? parsed.profilePath : null
  } catch {
    return null
  }
}

/**
 * Every file in the root except the publisher's short-lived temporaries,
 * re-reading only files whose identity changed since `previous`.
 */
export function readRegistrySnapshot(
  root: string,
  previous: RegistrySnapshot = null
): Map<string, RegistryFileState> | null {
  let names: string[]
  try {
    names = readdirSync(root)
  } catch (error) {
    if (isErrno(error, ['ENOENT', 'ENOTDIR'])) return null
    throw error
  }
  const snapshot = new Map<string, RegistryFileState>()
  for (const name of names.sort()) {
    if (PUBLISH_TEMPORARY.test(name)) continue
    const path = join(root, name)
    let stamp: string
    try {
      const stat = lstatSync(path)
      stamp = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.mode}`
    } catch {
      continue
    }
    const known = previous?.get(name)
    if (known && known.stamp === stamp) {
      snapshot.set(name, known)
      continue
    }
    let content: string | null = null
    try {
      content = readFileSync(path, 'utf8')
    } catch {
      content = null
    }
    snapshot.set(name, { stamp, content, pid: pidOf(content) })
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

export interface RegistryIsolationGuardOptions {
  /** The registry a Host uses without the override. */
  readonly realRoot: string
  /** This vitest process: writers under it belong to the run. */
  readonly ancestorPid: number
  readonly readParents?: () => ProcessParents | null
}

/**
 * Tracks the real registry against a baseline. `poll()` is cheap (one
 * readdir, re-reads only changed files) and runs on an interval for the whole
 * test run; `violations()` is the verdict.
 */
export class RegistryIsolationGuard {
  private readonly options: RegistryIsolationGuardOptions
  private readonly readParents: () => ProcessParents | null
  private readonly rootExistedAtStart: boolean
  /** A root nobody here can list cannot be written by this run's Hosts either. */
  private readonly unlistableAtStart: boolean
  private known: RegistrySnapshot
  /** Last attribution per entry name; baseline entries start as `other` or `baseline-stale`. */
  private readonly owners = new Map<string, RegistryIsolationViolation['attribution']>()
  private readonly found: RegistryIsolationViolation[] = []
  private exemptWriterSeen = false

  constructor(options: RegistryIsolationGuardOptions) {
    this.options = options
    this.readParents = options.readParents ?? (() => readProcessParents())
    let baseline: RegistrySnapshot = null
    let unlistable = false
    try {
      baseline = readRegistrySnapshot(options.realRoot)
    } catch {
      unlistable = true
    }
    this.known = baseline
    this.unlistableAtStart = unlistable
    this.rootExistedAtStart = unlistable || baseline !== null
    if (this.known && this.known.size > 0) {
      const parents = this.readParents()
      for (const [name, state] of this.known) {
        const attribution = attributeRegistryWriter(state.pid, options.ancestorPid, parents)
        // A baseline entry naming a live process outside the run is a real
        // Host; anything else (a dead pid, a malformed file) is inert and
        // must still be there, unchanged, when the run ends.
        this.owners.set(name, attribution === 'other' ? 'other' : 'baseline-stale')
      }
    }
  }

  poll(): void {
    let current: RegistrySnapshot
    try {
      current = readRegistrySnapshot(this.options.realRoot, this.known)
    } catch (error) {
      if (this.unlistableAtStart) return
      if (!this.found.some((violation) => violation.name === '(root)')) {
        this.record({
          name: '(root)',
          change: 'rewritten',
          pid: null,
          attribution: 'unknown',
          detail: `the real registry root became unlistable during the run: ${String(error)}`
        })
      }
      return
    }
    const before = this.known ?? new Map<string, RegistryFileState>()
    const after = current ?? new Map<string, RegistryFileState>()
    let parents: ProcessParents | null | undefined
    const table = (): ProcessParents | null => {
      if (parents === undefined) parents = this.readParents()
      return parents
    }
    for (const [name, state] of after) {
      const previous = before.get(name)
      if (previous && previous.stamp === state.stamp) continue
      const attribution = attributeRegistryWriter(state.pid, this.options.ancestorPid, table())
      this.owners.set(name, attribution)
      if (attribution === 'other') {
        this.exemptWriterSeen = true
        continue
      }
      this.record({
        name,
        change: previous ? 'rewritten' : 'created',
        pid: state.pid,
        attribution,
        detail: this.describe(state)
      })
    }
    for (const [name, state] of before) {
      if (after.has(name)) continue
      const owner = this.owners.get(name)
      this.owners.delete(name)
      if (owner === 'other') continue
      if (owner === 'this-run' || owner === 'unknown') continue // recorded when it appeared
      this.record({
        name,
        change: 'removed',
        pid: state.pid,
        attribution: owner ?? 'unknown',
        detail: `an entry that was already in the real registry disappeared (${this.describe(state)})`
      })
    }
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
  }

  violations(): readonly RegistryIsolationViolation[] {
    return this.found
  }

  private describe(state: RegistryFileState): string {
    const profile = profileOf(state.content)
    return [
      state.pid === null ? 'no pid' : `pid ${state.pid}`,
      profile ? `profile ${profile}` : state.content === null ? 'not a readable file' : null
    ]
      .filter(Boolean)
      .join(', ')
  }

  /** One line per entry and writer: a Host refreshing its entry is one finding, not one per minute. */
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
    `[host-registry-isolation] FAILED: this test run wrote into the real Host registry ${realRoot}.`,
    ...violations.map(
      (violation) =>
        `  ${violation.change} ${violation.name} (${violation.attribution}): ${violation.detail}`
    ),
    `  Spawn Hosts with the inherited environment (it carries ${HOST_REGISTRY_ROOT_ENV}) or set`,
    '  that variable to a temporary directory explicitly; never publish into or sweep the real root.'
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
  readonly readParents?: () => ProcessParents | null
  readonly pollIntervalMs?: number
  readonly report?: (text: string) => void
  /** Marks the run failed; the summary has already printed by then. */
  readonly fail?: () => void
}

/** Starts the per-run root and the guard; the returned teardown gives the verdict. */
export function startHostRegistryIsolation(options: HostRegistryIsolationOptions = {}): () => void {
  const env = options.env ?? process.env
  const runRoot = mkdtempSync(join(options.temporaryDirectory ?? tmpdir(), RUN_ROOT_PREFIX))
  // The per-run root every worker and every Host they spawn inherits.
  env[HOST_REGISTRY_ROOT_ENV] = runRoot
  const guards = (options.realRoots ?? realHostRegistryRoots()).map(
    (realRoot) =>
      [
        realRoot,
        new RegistryIsolationGuard({
          realRoot,
          ancestorPid: options.ancestorPid ?? process.pid,
          ...(options.readParents ? { readParents: options.readParents } : {})
        })
      ] as const
  )
  const timer = setInterval(() => {
    for (const [, guard] of guards) guard.poll()
  }, options.pollIntervalMs ?? POLL_INTERVAL_MS)
  timer.unref()
  return () => {
    clearInterval(timer)
    for (const [, guard] of guards) guard.poll()
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
export default function setupHostRegistryIsolation(): () => void {
  return startHostRegistryIsolation()
}
