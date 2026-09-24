import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { HOST_TERMINATION_SUCCESS_KINDS } from '../src/host-client/HostProcessTermination'
import {
  HOST_PROFILE_AUTHORITY_LEASE_FILENAME,
  HOST_PROFILE_AUTHORITY_MAX_RECORD_BYTES
} from '../src/host-runtime/HostProfileAuthorityLease'
import {
  HOST_REGISTRY_MAX_ENTRY_BYTES,
  HOST_REGISTRY_ROOT_ENV,
  HOST_REGISTRY_SCHEMA,
  decodeHostRegistryEntry,
  hostRegistryEntryId,
  hostRegistryEntryPath,
  hostSocketIsLive,
  readHostRegistry,
  readHostRegistryEntry,
  resolveHostRegistryRoot,
  type HostRegistryEntry
} from '../src/host-runtime/HostRegistry'
import {
  observeProcessBirthIdentity,
  type ProcessBirthObservation
} from '../src/host-runtime/ProcessBirthIdentity'
import {
  HOST_LOCAL_CONTROL_MAX_DISCOVERY_BYTES,
  publishPrivateLocalControlArtifact
} from '../src/shared/hostLocalControlArtifacts.node'
import {
  TASKWRAITH_HOST_DISCOVERY_FILE,
  TASKWRAITH_HOST_SOCKET_FILE,
  taskWraithHostSocketPath
} from '../src/shared/taskWraithHostPaths.node'

/**
 * The build hook that stops this checkout's own Hosts before `host:build`
 * rewrites `out/host` (scripts/host-stop-all.cjs). Every registry here is a
 * temporary root, every checkout a temporary directory, and every process a
 * child this suite spawned; the real `~/.taskwraith` is never read.
 */

type Liveness = 'alive' | 'dead' | 'foreign' | 'unknown'

interface ProfileRecord {
  readonly kind: 'present' | 'missing' | 'unreadable'
  readonly pid?: number
}

interface CliRun {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string
}

interface CliStopInput {
  readonly execPath: string
  readonly cliPath: string
  readonly profilePath: string
  readonly expected: { readonly pid: number; readonly birthIdentity: string }
  readonly registryRoot: string
  readonly env: NodeJS.ProcessEnv
}

interface HookHost {
  readonly profilePath: string
  readonly pid: number
  readonly liveness: Liveness
  readonly action: string
  readonly result?: string
  readonly outcome?: string
  readonly entry?: string
  readonly socketDirectory?: string
  readonly note?: string
}

interface HookReport {
  readonly payloadRoot: string
  readonly registryRoot: string
  readonly mode: 'cli' | 'fallback'
  readonly hosts: readonly HookHost[]
  readonly warnings: readonly string[]
  readonly error?: string
  readonly exitCode: number
}

interface HookPorts {
  readRegistry?: (root: string) => Promise<unknown>
  readEntry?: (file: string) => Promise<unknown>
  probePid?: (pid: number) => Liveness
  readProfileRecords?: (
    profilePath: string
  ) => Promise<{ discovery: ProfileRecord; lease: ProfileRecord }>
  runCliStop?: (input: CliStopInput) => Promise<CliRun>
  cliIsPresent?: (cliPath: string) => Promise<boolean>
}

interface HookOptions {
  readonly checkoutRoot: string
  readonly payloadRoot: string
  readonly registryRoot?: string
  readonly temporaryDirectory?: string
  readonly uid?: string
  readonly env?: NodeJS.ProcessEnv
  readonly walkDeadlineMs?: number
  readonly ports?: HookPorts
}

interface HookIo {
  readonly checkoutRoot?: string
  readonly env?: NodeJS.ProcessEnv
  readonly stdout?: (text: string) => void
  readonly stderr?: (text: string) => void
  readonly hookDeadlineMs?: number
  readonly options?: Partial<HookOptions>
}

interface HookModule {
  readonly CLI_SUCCESS_KINDS: ReadonlySet<string>
  readonly EXIT_OK: number
  readonly EXIT_SCOPE_BROKEN: number
  readonly EXIT_USAGE: number
  readonly HOST_AUTHORITY_LEASE_FILE: string
  readonly HOST_AUTHORITY_LEASE_MAX_BYTES: number
  readonly HOST_DISCOVERY_FILE: string
  readonly HOST_DISCOVERY_MAX_BYTES: number
  readonly HOST_REGISTRY_MAX_ENTRY_BYTES: number
  readonly HOST_REGISTRY_ROOT_ENV: string
  readonly HOST_REGISTRY_SCHEMA: string
  decodeHostRegistryEntry(value: unknown): unknown
  hostRegistryEntryId(profilePath: string): string
  isUnderPayloadRoot(cliPath: unknown, payloadRoot: string, platform?: NodeJS.Platform): boolean
  main(argv: readonly string[], io?: HookIo): Promise<number>
  parseArguments(argv: readonly string[]): { payloadRoot: string; json: boolean }
  readRegistry(root: string): Promise<unknown>
  readEntryFile(file: string): Promise<unknown>
  resolvePayloadRoot(requested: string, checkoutRoot: string, platform?: NodeJS.Platform): string
  resolveRegistryRoot(env: NodeJS.ProcessEnv, home: string): string
  runHostStopAll(options: HookOptions): Promise<HookReport>
  selfTestScopeFilter(
    payloadRoot: string,
    checkoutRoot: string,
    platform?: NodeJS.Platform
  ): string[]
}

const require = createRequire(import.meta.url)
const SCRIPT_PATH = fileURLToPath(new URL('./host-stop-all.cjs', import.meta.url))
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const hook = require('./host-stop-all.cjs') as HookModule
const POSIX = process.platform !== 'win32'
/** Tests that spawn processes: vitest's 5 s local default is too tight on a loaded machine. */
const PROCESS_TEST_TIMEOUT_MS = 20_000

const temporary: string[] = []

afterEach(() => {
  while (temporary.length) rmSync(temporary.pop()!, { recursive: true, force: true })
})

function scratch(prefix: string): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  temporary.push(path)
  return path
}

/** A checkout whose `out/host` exists (with a stand-in CLI) or not at all. */
function checkout(base: string, name: string, withCli: boolean): string {
  const root = join(base, name)
  mkdirSync(join(root, 'scripts'), { recursive: true })
  if (withCli) {
    mkdirSync(join(root, 'out', 'host', 'host-runtime'), { recursive: true })
    writeFileSync(join(root, 'out', 'host', 'host-runtime', 'cli.js'), 'process.exit(9)\n')
  }
  return realpathSync(root)
}

function cliOf(payloadRoot: string): string {
  return join(payloadRoot, 'host-runtime', 'cli.js')
}

let nextPid = 40_000

function entryFor(
  profilePath: string,
  cliPath: string | null,
  overrides: Partial<HostRegistryEntry> = {}
): HostRegistryEntry {
  nextPid += 1
  return {
    schema: 'taskwraith.host-registry.v1',
    profilePath,
    pid: nextPid,
    birthIdentity: 'a'.repeat(64),
    startedAt: '2026-09-23T10:00:00.000Z',
    hostId: 'host-install-1',
    bootEpoch: `boot-${nextPid}`,
    payloadVersion: null,
    socketPath: taskWraithHostSocketPath(profilePath),
    discoveryPath: join(profilePath, TASKWRAITH_HOST_DISCOVERY_FILE),
    cliPath,
    nodeExecutable: process.execPath,
    persist: false,
    leaseMode: 'lease',
    writtenAt: '2026-09-23T10:00:00.000Z',
    beatSeq: 0,
    holders: 1,
    implicitHolders: 0,
    lifetimePhase: 'held',
    ...overrides
  }
}

/** Exactly as a Host publishes: owner-only, atomic, under the entry's own name. */
function writeEntry(registryRoot: string, entry: HostRegistryEntry): string {
  mkdirSync(registryRoot, { recursive: true, mode: 0o700 })
  const path = hostRegistryEntryPath(registryRoot, entry.profilePath)
  publishPrivateLocalControlArtifact(
    path,
    `${JSON.stringify(entry)}\n`,
    HOST_REGISTRY_MAX_ENTRY_BYTES
  )
  return path
}

function writePrivate(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true })
  publishPrivateLocalControlArtifact(path, contents, 64 * 1024)
}

/** A pid that existed a moment ago and is gone now. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], {
    encoding: 'utf8'
  })
  return Number(child.stdout)
}

/** `stop-all --profile <p> --json` as the built CLI prints it (golden shape, captured at a3f48c3b9). */
function cliReport(
  registryRoot: string,
  profilePath: string,
  outcome: string,
  pid: number,
  others: readonly { profilePath: string; selected: boolean }[] = []
): string {
  const row = (path: string, selected: boolean) => ({
    source: 'registry',
    profilePath: path,
    pid,
    birthIdentity: 'b'.repeat(64),
    cliPath: '/somewhere/out/host/host-runtime/cli.js',
    payloadVersion: null,
    startedAt: '2026-09-23T10:00:00.000Z',
    holders: 0,
    implicitHolders: 0,
    persist: false,
    liveness: 'live',
    selected,
    ...(selected
      ? { outcome: { kind: outcome, pid, steps: ['socket:stopping'], swept: ['registry'] } }
      : {})
  })
  return `${JSON.stringify(
    {
      registryRoot,
      scope: { kind: 'profile', profilePath },
      scanArgv: false,
      hosts: [
        row(profilePath, true),
        ...others.map((other) => row(other.profilePath, other.selected))
      ],
      unreadableEntries: [],
      exitCode: HOST_TERMINATION_SUCCESS_KINDS.has(outcome as never) ? 0 : 1
    },
    null,
    2
  )}\n`
}

function recordingCli(registryRoot: string, outcome = 'stopped') {
  const calls: CliStopInput[] = []
  const runCliStop = async (input: CliStopInput): Promise<CliRun> => {
    calls.push(input)
    return {
      code: 0,
      signal: null,
      stdout: cliReport(registryRoot, input.profilePath, outcome, input.expected.pid),
      stderr: ''
    }
  }
  return { calls, runCliStop }
}

const MISSING_RECORDS = async () => ({
  discovery: { kind: 'missing' } as ProfileRecord,
  lease: { kind: 'missing' } as ProfileRecord
})

describe('host-stop-all mirrors the Host registry it reads', () => {
  it('pins every mirrored constant to its source', () => {
    expect(hook.HOST_REGISTRY_SCHEMA).toBe(HOST_REGISTRY_SCHEMA)
    expect(hook.HOST_REGISTRY_ROOT_ENV).toBe(HOST_REGISTRY_ROOT_ENV)
    expect(hook.HOST_REGISTRY_MAX_ENTRY_BYTES).toBe(HOST_REGISTRY_MAX_ENTRY_BYTES)
    expect(hook.HOST_DISCOVERY_FILE).toBe(TASKWRAITH_HOST_DISCOVERY_FILE)
    expect(hook.HOST_DISCOVERY_MAX_BYTES).toBe(HOST_LOCAL_CONTROL_MAX_DISCOVERY_BYTES)
    expect(hook.HOST_AUTHORITY_LEASE_FILE).toBe(HOST_PROFILE_AUTHORITY_LEASE_FILENAME)
    expect(hook.HOST_AUTHORITY_LEASE_MAX_BYTES).toBe(HOST_PROFILE_AUTHORITY_MAX_RECORD_BYTES)
    expect([...hook.CLI_SUCCESS_KINDS].sort()).toEqual([...HOST_TERMINATION_SUCCESS_KINDS].sort())
    for (const profile of ['/Users/a/Library/Application Support/TaskWraith Dev', '/tmp/p']) {
      expect(hook.hostRegistryEntryId(profile)).toBe(hostRegistryEntryId(profile))
    }
    if (POSIX) {
      // Registry identity and Host socket directory derive from the same profile.
      const profile = '/Users/a/Library/Application Support/TaskWraith Dev verify'
      const uid = typeof process.getuid === 'function' ? process.getuid() : 'user'
      expect(dirname(taskWraithHostSocketPath(profile))).toBe(
        join(tmpdir(), `twh2-${uid}-${hook.hostRegistryEntryId(profile)}`)
      )
    }
    const home = join(tmpdir(), 'home')
    const absolute = join(tmpdir(), 'registry')
    for (const value of [undefined, '', '   ', 'relative/root', absolute, `  ${absolute}  `]) {
      const env = value === undefined ? {} : { [HOST_REGISTRY_ROOT_ENV]: value }
      expect(hook.resolveRegistryRoot(env, home)).toBe(resolveHostRegistryRoot(env, home, {}))
    }
  })

  it('reads a registry exactly as HostRegistry.readHostRegistry does', async () => {
    const root = join(scratch('host-stop-all-reader-'), 'hosts')
    expect(await hook.readRegistry(root)).toEqual(readHostRegistry(root))
    const good = entryFor('/profiles/good', '/checkout/out/host/host-runtime/cli.js')
    const sparse = entryFor('/profiles/sparse', null, {
      birthIdentity: null,
      bootEpoch: null,
      payloadVersion: `sha256:${'b'.repeat(64)}`,
      nodeExecutable: null,
      persist: true,
      lifetimePhase: 'draining'
    })
    writeEntry(root, good)
    writeEntry(root, sparse)
    const named = (text: string) => join(root, `${text}.json`)
    writePrivate(named('0000000000000001'), '{"schema": ')
    writePrivate(named('0000000000000002'), `${JSON.stringify({ ...good, schema: 'v2' })}\n`)
    writePrivate(named('0000000000000003'), `${JSON.stringify({ ...good, pid: 0 })}\n`)
    writePrivate(named('0000000000000004'), `${'x'.repeat(HOST_REGISTRY_MAX_ENTRY_BYTES + 1)}`)
    writePrivate(join(root, 'ABCDEF0123456789.json'), `${JSON.stringify(good)}\n`)
    writePrivate(join(root, '000000000000000.json'), `${JSON.stringify(good)}\n`)
    writePrivate(join(root, '.DS_Store'), 'finder')
    mkdirSync(named('0000000000000005'))
    if (POSIX) {
      writePrivate(named('0000000000000006'), `${JSON.stringify(good)}\n`)
      chmodSync(named('0000000000000006'), 0o644)
      symlinkSync(hostRegistryEntryPath(root, good.profilePath), named('0000000000000007'))
    }
    const expected = readHostRegistry(root)
    // The fixture exercises both kinds: vacuity guard.
    expect(expected.entries).toHaveLength(2)
    expect(expected.unreadable.length).toBeGreaterThanOrEqual(POSIX ? 7 : 5)
    expect(await hook.readRegistry(root)).toEqual(expected)

    const file = join(scratch('host-stop-all-reader-file-'), 'not-a-directory')
    writeFileSync(file, 'x')
    expect(await hook.readRegistry(file)).toEqual(readHostRegistry(file))
  })

  it('decodes every malformed entry exactly as HostRegistry does', () => {
    const base = entryFor('/profiles/decode', '/checkout/out/host/host-runtime/cli.js')
    const control = `a${String.fromCharCode(1)}b`
    const bad: readonly unknown[] = [
      null,
      undefined,
      '',
      0,
      -1,
      1.5,
      '1',
      ' x',
      control,
      'relative/path',
      'Running',
      'x'.repeat(5_000),
      '2026-09-23T10:00:00Z',
      'sha256:abc',
      true,
      [],
      {}
    ]
    const cases: unknown[] = [null, [], 'entry', 7]
    for (const key of Object.keys(base)) {
      const { [key]: _omitted, ...without } = base as unknown as Record<string, unknown>
      cases.push(without)
      for (const value of bad) cases.push({ ...base, [key]: value })
    }
    for (const value of cases) {
      expect(hook.decodeHostRegistryEntry(value)).toEqual(decodeHostRegistryEntry(value))
    }
    expect(hook.decodeHostRegistryEntry(base)).toEqual({ ok: true, entry: base })
  })
})

describe('host-stop-all scope', () => {
  it('matches only a CLI strictly under the payload root, with a separator boundary', () => {
    const base = scratch('host-stop-all-scope-')
    const root = join(base, 'AGBench', 'out', 'host')
    const inScope = [cliOf(root), join(root, 'host-runtime', '..', 'host-runtime', 'cli.js')]
    const outOfScope = [
      cliOf(`${root}2`),
      cliOf(`${root}-old`),
      join(root, '..', 'host2', 'host-runtime', 'cli.js'),
      root,
      `${root}${POSIX ? '/' : '\\'}`,
      cliOf(join(base, 'AGBench-worktree', 'out', 'host')),
      cliOf(join(base, 'AGBench', '.claude', 'worktrees', 'peer', 'out', 'host')),
      '/Applications/TaskWraith.app/Contents/Resources/host/host-runtime/cli.js',
      join('out', 'host', 'host-runtime', 'cli.js'),
      '',
      null,
      42
    ]
    for (const path of inScope) expect(hook.isUnderPayloadRoot(path, root), path).toBe(true)
    for (const path of outOfScope) {
      expect(hook.isUnderPayloadRoot(path, root), String(path)).toBe(false)
    }
    // Windows: case-insensitive, either separator.
    const windowsRoot = 'C:\\Users\\Ada\\AGBench\\out\\host'
    expect(
      hook.isUnderPayloadRoot(
        'c:\\users\\ada\\agbench\\OUT\\HOST\\host-runtime\\cli.js',
        windowsRoot,
        'win32'
      )
    ).toBe(true)
    expect(
      hook.isUnderPayloadRoot(
        'C:/Users/Ada/AGBench/out/host/host-runtime/cli.js',
        windowsRoot,
        'win32'
      )
    ).toBe(true)
    expect(
      hook.isUnderPayloadRoot(
        'C:\\Users\\Ada\\AGBench\\out\\host2\\host-runtime\\cli.js',
        windowsRoot,
        'win32'
      )
    ).toBe(false)
    expect(
      hook.isUnderPayloadRoot(
        'C:\\Program Files\\TaskWraith\\resources\\host\\host-runtime\\cli.js',
        windowsRoot,
        'win32'
      )
    ).toBe(false)
  })

  it('passes its own self-test for POSIX and Windows checkouts', () => {
    expect(
      hook.selfTestScopeFilter('/Users/a/AGBench/out/host', '/Users/a/AGBench', 'darwin')
    ).toEqual([])
    expect(hook.selfTestScopeFilter('/out/host', '/', 'linux')).toEqual([])
    expect(
      hook.selfTestScopeFilter(
        'C:\\Users\\Ada\\AGBench\\out\\host',
        'C:\\Users\\Ada\\AGBench',
        'win32'
      )
    ).toEqual([])
  })

  it('accepts only the out/host of its own checkout as the payload root', () => {
    const base = scratch('host-stop-all-root-')
    const root = checkout(base, 'AGBench', false)
    const expected = join(root, 'out', 'host')
    for (const requested of ['out/host', './out/host', 'out/host/', 'out/../out/host', expected]) {
      expect(hook.resolvePayloadRoot(requested, root)).toBe(expected)
    }
    for (const requested of [
      'out/host2',
      'out',
      'out/host/host-runtime',
      '.',
      '/Applications/TaskWraith.app/Contents/Resources/host',
      join(base, 'AGBench-worktree', 'out', 'host'),
      join(root, '.claude', 'worktrees', 'peer', 'out', 'host')
    ]) {
      expect(() => hook.resolvePayloadRoot(requested, root), requested).toThrow(
        /must name the out\/host of this checkout/
      )
    }
  })

  it('refuses to run without a scope, and never offers --all', async () => {
    for (const argv of [[], ['--json']]) {
      expect(() => hook.parseArguments(argv)).toThrow(/Refusing to run without a scope/)
    }
    for (const [argv, message] of [
      [['--sweep'], /--sweep is unavailable here/],
      [['--payload-root', 'out/host', '--sweep'], /--sweep is unavailable here/],
      [['--payload-root', 'out/host', '--all'], /--all is never available here/],
      [['--all'], /--all is never available here/],
      [['--payload-root', 'out/host', '--profile', '/p'], /--profile is unavailable here/],
      [['--payload-root', 'out/host', '--scan-argv'], /--scan-argv is unavailable here/],
      [['--payload-root'], /requires one value/],
      [['--payload-root', '--sweep'], /requires one value/],
      [['--payload-root', 'out/host', '--payload-root', 'out/host'], /may appear once/],
      [['--payload-root=out/host'], /Unknown argument/]
    ] as const) {
      expect(() => hook.parseArguments(argv), argv.join(' ')).toThrow(message)
    }
    expect(hook.parseArguments(['--payload-root', 'out/host', '--json'])).toEqual({
      payloadRoot: 'out/host',
      json: true
    })

    const base = scratch('host-stop-all-refusal-')
    const root = checkout(base, 'AGBench', true)
    const registryRoot = join(base, 'registry')
    writeEntry(registryRoot, entryFor(join(base, 'p'), cliOf(join(root, 'out', 'host'))))
    let reads = 0
    let stops = 0
    let stderr = ''
    for (const argv of [[], ['--sweep'], ['--payload-root', 'out/host', '--all']]) {
      const code = await hook.main(argv, {
        checkoutRoot: root,
        stdout: () => undefined,
        stderr: (text) => {
          stderr += text
        },
        options: {
          registryRoot,
          ports: {
            readRegistry: async (path) => {
              reads += 1
              return readHostRegistry(path)
            },
            runCliStop: async () => {
              stops += 1
              return { code: 0, signal: null, stdout: '', stderr: '' }
            }
          }
        }
      })
      expect(code).toBe(hook.EXIT_USAGE)
    }
    expect(reads).toBe(0)
    expect(stops).toBe(0)
    expect(stderr).toContain('Refusing to run without a scope: pass --payload-root out/host.')
    expect(stderr).toContain('--all is never available here')
  })
})

describe('host-stop-all build hook', () => {
  it.each([null, 'legacy-nonce', 'a'.repeat(63), 'g'.repeat(64), `${'a'.repeat(64)}\n`])(
    'leaves a Host with an unusable birth digest alone (%j)',
    async (birthIdentity) => {
      const base = scratch('host-stop-all-birth-')
      const root = checkout(base, 'AGBench', true)
      const payloadRoot = join(root, 'out', 'host')
      const registryRoot = join(base, 'registry')
      const own = entryFor(join(base, 'profile'), cliOf(payloadRoot), { birthIdentity })
      const entryPath = writeEntry(registryRoot, own)
      const before = readFileSync(entryPath, 'utf8')
      const cli = recordingCli(registryRoot)
      const report = await hook.runHostStopAll({
        checkoutRoot: root,
        payloadRoot,
        registryRoot,
        ports: {
          probePid: () => 'alive',
          readProfileRecords: MISSING_RECORDS,
          runCliStop: cli.runCliStop
        }
      })
      expect(report.exitCode).toBe(hook.EXIT_OK)
      expect(report.warnings.join('\n')).toMatch(/no valid birth digest|unreadable registry/)
      expect(cli.calls).toEqual([])
      expect(readFileSync(entryPath, 'utf8')).toBe(before)
    }
  )

  it.each([7, 4242, 98765])('keeps selected PID %i in an already-gone report', async (pid) => {
    const base = scratch('host-stop-all-expected-pid-')
    const root = checkout(base, 'AGBench', true)
    const payloadRoot = join(root, 'out', 'host')
    const registryRoot = join(base, 'registry')
    const own = entryFor(join(base, 'profile'), cliOf(payloadRoot), {
      pid,
      birthIdentity: 'A'.repeat(64)
    })
    writeEntry(registryRoot, own)
    const cli = recordingCli(registryRoot, 'already_gone')
    const report = await hook.runHostStopAll({
      checkoutRoot: root,
      payloadRoot,
      registryRoot,
      ports: {
        probePid: () => 'alive',
        readProfileRecords: MISSING_RECORDS,
        runCliStop: cli.runCliStop
      }
    })
    expect(report.exitCode).toBe(hook.EXIT_OK)
    expect(report.hosts).toMatchObject([{ pid, result: 'gone', outcome: 'already_gone' }])
    expect(cli.calls).toMatchObject([{ expected: { pid, birthIdentity: 'a'.repeat(64) } }])
  })

  it.each(['row-missing', 'row-mismatch', 'outcome-missing', 'outcome-mismatch', 'no-row'])(
    'fails the build on an unbound CLI PID: %s',
    async (violation) => {
      const base = scratch('host-stop-all-pid-escape-')
      const root = checkout(base, 'AGBench', true)
      const payloadRoot = join(root, 'out', 'host')
      const registryRoot = join(base, 'registry')
      const own = entryFor(join(base, 'profile'), cliOf(payloadRoot))
      writeEntry(registryRoot, own)
      const report = JSON.parse(cliReport(registryRoot, own.profilePath, 'stopped', own.pid))
      const target = violation.startsWith('row') ? report.hosts[0] : report.hosts[0].outcome
      if (violation === 'no-row') report.hosts = []
      else if (violation.endsWith('missing')) delete target.pid
      else target.pid = own.pid + 1
      let stderr = ''
      const runCliStop = vi.fn(async () => ({
        code: 0,
        signal: null,
        stdout: JSON.stringify(report),
        stderr: ''
      }))
      const code = await hook.main(['--payload-root', 'out/host'], {
        checkoutRoot: root,
        stdout: () => undefined,
        stderr: (text) => {
          stderr += text
        },
        options: {
          registryRoot,
          ports: { probePid: () => 'alive', readProfileRecords: MISSING_RECORDS, runCliStop }
        }
      })
      expect(code).toBe(hook.EXIT_SCOPE_BROKEN)
      expect(stderr).toContain(`expected pid ${own.pid}`)
      expect(runCliStop).toHaveBeenCalledTimes(1)
    }
  )

  it('warns and continues without stopping anything when the registry is unreadable', async () => {
    const base = scratch('host-stop-all-unreadable-root-')
    const root = checkout(base, 'AGBench', true)
    const registryRoot = join(base, 'not-a-directory')
    writeFileSync(registryRoot, 'preserve me')
    const cli = recordingCli(registryRoot)
    const report = await hook.runHostStopAll({
      checkoutRoot: root,
      payloadRoot: join(root, 'out', 'host'),
      registryRoot,
      ports: { runCliStop: cli.runCliStop }
    })
    expect(report.exitCode).toBe(hook.EXIT_OK)
    expect(report.warnings.join('\n')).toContain('unreadable registry entry')
    expect(cli.calls).toEqual([])
    expect(readFileSync(registryRoot, 'utf8')).toBe('preserve me')
  })

  it('leaves an EPERM process and its registry entry untouched', async () => {
    const base = scratch('host-stop-all-eperm-')
    const root = checkout(base, 'AGBench', true)
    const payloadRoot = join(root, 'out', 'host')
    const registryRoot = join(base, 'registry')
    const own = entryFor(join(base, 'profile'), cliOf(payloadRoot))
    writeEntry(registryRoot, own)
    const cli = recordingCli(registryRoot)
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      expect([pid, signal]).toEqual([own.pid, 0])
      throw Object.assign(new Error('permission denied'), { code: 'EPERM' })
    })
    try {
      const report = await hook.runHostStopAll({
        checkoutRoot: root,
        payloadRoot,
        registryRoot,
        ports: { runCliStop: cli.runCliStop }
      })
      expect(report.exitCode).toBe(hook.EXIT_OK)
      expect(report.hosts).toMatchObject([
        { pid: own.pid, liveness: 'foreign', action: 'left-alone' }
      ])
      expect(cli.calls).toEqual([])
      expect(readHostRegistryEntry(registryRoot, own.profilePath).kind).toBe('present')
    } finally {
      kill.mockRestore()
    }
  })

  it('never stops a Host serving another payload root', async () => {
    const base = scratch('host-stop-all-foreign-')
    const root = checkout(base, 'AGBench', true)
    const payloadRoot = join(root, 'out', 'host')
    const registryRoot = join(base, 'registry')
    const own = entryFor(join(base, 'profiles', 'own'), cliOf(payloadRoot))
    const foreign = [
      entryFor(
        join(base, 'profiles', 'installed'),
        '/Applications/TaskWraith.app/Contents/Resources/host/host-runtime/cli.js'
      ),
      entryFor(
        join(base, 'profiles', 'sibling'),
        cliOf(join(base, 'AGBench-worktree', 'out', 'host'))
      ),
      entryFor(
        join(base, 'profiles', 'nested'),
        cliOf(join(root, '.claude', 'worktrees', 'peer', 'out', 'host'))
      ),
      entryFor(join(base, 'profiles', 'host2'), cliOf(`${payloadRoot}2`)),
      entryFor(join(base, 'profiles', 'relative'), join('out', 'host', 'host-runtime', 'cli.js')),
      entryFor(join(base, 'profiles', 'none'), null)
    ]
    for (const entry of [own, ...foreign]) writeEntry(registryRoot, entry)
    expect(readHostRegistry(registryRoot).entries).toHaveLength(foreign.length + 1)
    const cli = recordingCli(registryRoot)
    const report = await hook.runHostStopAll({
      checkoutRoot: root,
      payloadRoot,
      registryRoot,
      ports: {
        probePid: () => 'alive',
        readProfileRecords: MISSING_RECORDS,
        runCliStop: cli.runCliStop
      }
    })
    // Positive control: this checkout's own Host is stopped...
    expect(cli.calls.map((call) => call.profilePath)).toEqual([own.profilePath])
    expect(report.hosts).toEqual([
      expect.objectContaining({
        profilePath: own.profilePath,
        action: 'cli-stop',
        result: 'gone',
        outcome: 'stopped'
      })
    ])
    // ...and no other Host is even listed, let alone stopped.
    expect(report.exitCode).toBe(hook.EXIT_OK)
    expect(report.mode).toBe('cli')
    expect(readHostRegistry(registryRoot).entries).toHaveLength(foreign.length + 1)
  })

  it(
    'preserves dead checkout, installed, sibling and orphan records and sockets with or without a CLI',
    async () => {
      const gone = deadPid()
      for (const withCli of [true, false]) {
        const base = scratch('host-stop-all-survive-')
        const root = checkout(base, 'AGBench', withCli)
        const payloadRoot = join(root, 'out', 'host')
        const registryRoot = join(base, 'registry')
        const temporaryDirectory = join(base, 'tmp')
        const uid = '501'
        const own = entryFor(join(base, 'profiles', 'own'), cliOf(payloadRoot), { pid: gone })
        const installed = entryFor(
          join(base, 'profiles', 'installed'),
          '/Applications/TaskWraith.app/Contents/Resources/host/host-runtime/cli.js',
          { pid: gone }
        )
        const sibling = entryFor(
          join(base, 'profiles', 'sibling'),
          cliOf(join(base, 'AGBench-wt', 'out', 'host')),
          {
            pid: gone
          }
        )
        for (const entry of [own, installed, sibling]) writeEntry(registryRoot, entry)
        const socketDirectory = (profilePath: string) =>
          join(temporaryDirectory, `twh2-${uid}-${hostRegistryEntryId(profilePath)}`)
        const orphan = join(temporaryDirectory, `twh2-${uid}-${'f'.repeat(16)}`)
        for (const directory of [
          socketDirectory(own.profilePath),
          socketDirectory(installed.profilePath),
          socketDirectory(sibling.profilePath),
          orphan
        ]) {
          mkdirSync(directory, { recursive: true })
          writeFileSync(join(directory, TASKWRAITH_HOST_SOCKET_FILE), '')
        }
        const cli = recordingCli(registryRoot)
        const report = await hook.runHostStopAll({
          checkoutRoot: root,
          payloadRoot,
          registryRoot,
          temporaryDirectory,
          uid,
          ports: {
            runCliStop: cli.runCliStop
          }
        })
        expect(report.mode).toBe(withCli ? 'cli' : 'fallback')
        expect(cli.calls).toEqual([])
        expect(report.hosts).toEqual([
          expect.objectContaining({
            profilePath: own.profilePath,
            liveness: 'dead',
            action: 'listed'
          })
        ])
        // Even the in-scope dead Host's records and socket remain untouched.
        expect(readHostRegistryEntry(registryRoot, own.profilePath).kind).toBe('present')
        expect(existsSync(socketDirectory(own.profilePath))).toBe(true)
        // The out-of-scope dead entries and their directories survive, and so
        // does a directory no entry names.
        expect(readHostRegistryEntry(registryRoot, installed.profilePath).kind).toBe('present')
        expect(readHostRegistryEntry(registryRoot, sibling.profilePath).kind).toBe('present')
        expect(existsSync(socketDirectory(installed.profilePath))).toBe(true)
        expect(existsSync(socketDirectory(sibling.profilePath))).toBe(true)
        expect(existsSync(orphan)).toBe(true)
      }
    },
    PROCESS_TEST_TIMEOUT_MS
  )

  it('run from a sibling worktree, considers only the out/host of that worktree', async () => {
    const base = scratch('host-stop-all-sibling-')
    const main = checkout(base, 'AGBench', true)
    const worktree = checkout(base, 'AGBench-wt', true)
    const registryRoot = join(base, 'registry')
    const mainHost = entryFor(join(base, 'profiles', 'main'), cliOf(join(main, 'out', 'host')))
    const worktreeHost = entryFor(
      join(base, 'profiles', 'wt'),
      cliOf(join(worktree, 'out', 'host'))
    )
    writeEntry(registryRoot, mainHost)
    writeEntry(registryRoot, worktreeHost)
    for (const [checkoutRoot, expected] of [
      [worktree, worktreeHost],
      [main, mainHost]
    ] as const) {
      const cli = recordingCli(registryRoot)
      const code = await hook.main(['--payload-root', 'out/host'], {
        checkoutRoot,
        stdout: () => undefined,
        stderr: () => undefined,
        options: {
          registryRoot,
          ports: {
            probePid: () => 'alive',
            readProfileRecords: MISSING_RECORDS,
            runCliStop: cli.runCliStop
          }
        }
      })
      expect(code).toBe(hook.EXIT_OK)
      expect(cli.calls.map((call) => call.profilePath)).toEqual([expected.profilePath])
      expect(cli.calls[0].cliPath).toBe(cliOf(join(checkoutRoot, 'out', 'host')))
    }
  })

  it(
    'continues a first build without signalling or deleting live, dead or foreign records',
    async () => {
      const base = scratch('host-stop-all-first-build-')
      const root = checkout(base, 'AGBench', false)
      const payloadRoot = join(root, 'out', 'host')
      expect(existsSync(join(root, 'out'))).toBe(false)
      const registryRoot = join(base, 'registry')
      const live = entryFor(join(base, 'profiles', 'live'), cliOf(payloadRoot))
      const gone = deadPid()
      const dead = entryFor(join(base, 'profiles', 'dead'), cliOf(payloadRoot), { pid: gone })
      const foreignDead = entryFor(join(base, 'profiles', 'foreign'), cliOf(`${payloadRoot}2`), {
        pid: gone
      })
      for (const entry of [live, dead, foreignDead]) writeEntry(registryRoot, entry)
      const cli = recordingCli(registryRoot)
      let stderr = ''
      let stdout = ''
      const code = await hook.main(['--payload-root', 'out/host'], {
        checkoutRoot: root,
        stdout: (text) => {
          stdout += text
        },
        stderr: (text) => {
          stderr += text
        },
        options: {
          registryRoot,
          temporaryDirectory: join(base, 'tmp'),
          ports: {
            probePid: (pid) => (pid === live.pid ? 'alive' : 'dead'),
            runCliStop: cli.runCliStop
          }
        }
      })
      expect(code).toBe(hook.EXIT_OK)
      expect(cli.calls).toEqual([])
      expect(stderr).toContain(`pid ${live.pid} (${live.profilePath}) left running: no built`)
      expect(stdout).toContain(`pid ${live.pid} alive ${live.profilePath} -> left-running`)
      expect(stdout).toContain(`pid ${dead.pid} dead ${dead.profilePath} -> listed`)
      expect(readHostRegistryEntry(registryRoot, live.profilePath).kind).toBe('present')
      expect(readHostRegistryEntry(registryRoot, dead.profilePath).kind).toBe('present')
      expect(readHostRegistryEntry(registryRoot, foreignDead.profilePath).kind).toBe('present')
    },
    PROCESS_TEST_TIMEOUT_MS
  )

  it(
    'finishes a first build with no out and no registry, quickly and as a real process',
    () => {
      const base = scratch('host-stop-all-empty-')
      const root = checkout(base, 'AGBench', false)
      copyFileSync(SCRIPT_PATH, join(root, 'scripts', 'host-stop-all.cjs'))
      for (const registryRoot of [
        join(base, 'no-registry'),
        scratch('host-stop-all-empty-registry-')
      ]) {
        const started = Date.now()
        const run = spawnSync(
          process.execPath,
          [join(root, 'scripts', 'host-stop-all.cjs'), '--payload-root', 'out/host'],
          {
            cwd: root,
            env: { ...process.env, [HOST_REGISTRY_ROOT_ENV]: registryRoot },
            encoding: 'utf8'
          }
        )
        const elapsed = Date.now() - started
        expect(run.status, run.stderr).toBe(0)
        expect(run.stderr).toBe('')
        expect(run.stdout).toBe(
          `host-stop-all: no Host in ${registryRoot} serves ${join(root, 'out', 'host')}\n`
        )
        // Well under 2 s on a development machine; hosted runners get the same
        // headroom vitest.config.ts gives them.
        expect(elapsed).toBeLessThan(process.env.CI ? 10_000 : 2_000)
      }
      expect(existsSync(join(root, 'out'))).toBe(false)
    },
    PROCESS_TEST_TIMEOUT_MS
  )

  it(
    'hands the built CLI the exact profile, PID, digest and registry without broader flags',
    async () => {
      const base = scratch('host-stop-all-argv-')
      const root = checkout(base, 'AGBench', true)
      const payloadRoot = join(root, 'out', 'host')
      const registryRoot = join(base, 'registry')
      const own = entryFor(join(base, 'profiles', 'own'), cliOf(payloadRoot))
      const record = join(base, 'cli-argv.json')
      writeFileSync(
        cliOf(payloadRoot),
        [
          "const fs = require('node:fs')",
          "const profile = process.argv[process.argv.indexOf('--profile') + 1]",
          'fs.writeFileSync(process.env.FAKE_CLI_RECORD, JSON.stringify({ argv: process.argv.slice(2), registryRoot: process.env.TASKWRAITH_HOST_REGISTRY_ROOT }))',
          `process.stdout.write(${JSON.stringify(cliReport(registryRoot, '@PROFILE@', 'stopped', own.pid))}.split('@PROFILE@').join(profile))`,
          "process.stderr.write('[host-termination] stopped after socket:stopping\\n')"
        ].join('\n')
      )
      writeEntry(registryRoot, own)
      const report = await hook.runHostStopAll({
        checkoutRoot: root,
        payloadRoot,
        registryRoot,
        env: {
          ...process.env,
          FAKE_CLI_RECORD: record,
          [HOST_REGISTRY_ROOT_ENV]: join(base, 'elsewhere')
        },
        ports: { probePid: () => 'alive', readProfileRecords: MISSING_RECORDS }
      })
      const seen = JSON.parse(readFileSync(record, 'utf8')) as {
        argv: string[]
        registryRoot: string
      }
      expect(seen.argv).toEqual([
        'stop-all',
        '--profile',
        own.profilePath,
        '--expect-pid',
        String(own.pid),
        '--expect-birth',
        own.birthIdentity,
        '--json'
      ])
      expect(seen.registryRoot).toBe(registryRoot)
      expect(report.hosts).toEqual([
        expect.objectContaining({
          action: 'cli-stop',
          result: 'gone',
          outcome: 'stopped',
          log: ['[host-termination] stopped after socket:stopping']
        })
      ])
    },
    PROCESS_TEST_TIMEOUT_MS
  )

  it('leaves a live Host alone when its profile records name another process', async () => {
    const base = scratch('host-stop-all-records-')
    const root = checkout(base, 'AGBench', true)
    const payloadRoot = join(root, 'out', 'host')
    const registryRoot = join(base, 'registry')
    const token = '0'.repeat(64)
    const discovery = (entry: HostRegistryEntry, overrides: Record<string, unknown> = {}) =>
      JSON.stringify({
        protocolVersion: 2,
        socketPath: entry.socketPath,
        tokenPath: join(entry.profilePath, 'taskwraith-host-v2.token'),
        pid: entry.pid,
        startedAt: entry.startedAt,
        ...overrides
      })
    const lease = (entry: HostRegistryEntry, overrides: Record<string, unknown> = {}) =>
      JSON.stringify({
        schemaVersion: 1,
        purpose: 'taskwraith:host-profile-authority-owner:v1',
        pid: entry.pid,
        processStartIdentity: entry.birthIdentity,
        processStartedAt: '2026-09-23T09:59:59.000Z',
        acquiredAt: '2026-09-23T09:59:59.500Z',
        token,
        ...overrides
      })
    const cases: {
      name: string
      discovery?: (entry: HostRegistryEntry) => string
      lease?: (entry: HostRegistryEntry) => string
      reason: RegExp | null
    }[] = [
      { name: 'consistent', discovery: (e) => discovery(e), lease: (e) => lease(e), reason: null },
      { name: 'registry-only', reason: null },
      {
        name: 'discovery-pid',
        discovery: (e) => discovery(e, { pid: e.pid + 1 }),
        reason: /its discovery names pid/
      },
      {
        name: 'discovery-start',
        discovery: (e) => discovery(e, { startedAt: '2026-09-23T11:00:00.000Z' }),
        reason: /another start of that pid/
      },
      {
        name: 'discovery-socket',
        discovery: (e) => discovery(e, { socketPath: `${e.socketPath}-successor` }),
        reason: /another start of that pid/
      },
      {
        name: 'discovery-garbage',
        discovery: () => '{"pid": ',
        reason: /its discovery is unreadable/
      },
      {
        name: 'lease-pid',
        lease: (e) => lease(e, { pid: e.pid + 1 }),
        reason: /its authority lease names pid/
      },
      {
        name: 'lease-unreadable',
        lease: () => '{"pid": ',
        reason: /its authority lease is unreadable/
      },
      {
        name: 'lease-birth',
        lease: (e) => lease(e, { processStartIdentity: 'c'.repeat(64) }),
        reason: /another birth of that pid/
      }
    ]
    const entries = new Map<string, HostRegistryEntry>()
    for (const testCase of cases) {
      const entry = entryFor(join(base, 'profiles', testCase.name), cliOf(payloadRoot))
      entries.set(testCase.name, entry)
      writeEntry(registryRoot, entry)
      mkdirSync(entry.profilePath, { recursive: true })
      if (testCase.discovery) {
        writePrivate(
          join(entry.profilePath, TASKWRAITH_HOST_DISCOVERY_FILE),
          testCase.discovery(entry)
        )
      }
      if (testCase.lease) {
        writePrivate(
          join(entry.profilePath, HOST_PROFILE_AUTHORITY_LEASE_FILENAME),
          testCase.lease(entry)
        )
      }
    }
    const cli = recordingCli(registryRoot)
    const report = await hook.runHostStopAll({
      checkoutRoot: root,
      payloadRoot,
      registryRoot,
      ports: { probePid: () => 'alive', runCliStop: cli.runCliStop }
    })
    expect(cli.calls.map((call) => call.profilePath).sort()).toEqual(
      [entries.get('consistent')!.profilePath, entries.get('registry-only')!.profilePath].sort()
    )
    for (const testCase of cases) {
      const host = report.hosts.find(
        (row) => row.profilePath === entries.get(testCase.name)!.profilePath
      )
      if (testCase.reason === null) {
        expect(host, testCase.name).toMatchObject({ action: 'cli-stop', result: 'gone' })
      } else {
        expect(host?.action, testCase.name).toBe('left-alone')
        expect(host?.note, testCase.name).toMatch(testCase.reason)
      }
    }
    // The lease's owner token never reaches the report.
    expect(JSON.stringify(report)).not.toContain(token)
  })

  it.each(['pid', 'cliPath'] as const)(
    'leaves a Host alone when registry %s changes before the stop',
    async (field) => {
      const base = scratch('host-stop-all-changed-')
      const root = checkout(base, 'AGBench', true)
      const payloadRoot = join(root, 'out', 'host')
      const registryRoot = join(base, 'registry')
      const judged = entryFor(join(base, 'profiles', 'replaced'), cliOf(payloadRoot))
      writeEntry(registryRoot, judged)
      const cli = recordingCli(registryRoot)
      let probes = 0
      const report = await hook.runHostStopAll({
        checkoutRoot: root,
        payloadRoot,
        registryRoot,
        ports: {
          probePid: () => {
            probes += 1
            // Another start on the profile, after the entry was judged in scope.
            if (probes === 1) {
              writeEntry(
                registryRoot,
                field === 'pid'
                  ? { ...judged, pid: judged.pid + 1, bootEpoch: 'boot-other' }
                  : { ...judged, cliPath: cliOf(`${payloadRoot}2`) }
              )
            }
            return 'alive'
          },
          readProfileRecords: MISSING_RECORDS,
          runCliStop: cli.runCliStop
        }
      })
      expect(probes).toBe(1)
      expect(cli.calls).toEqual([])
      expect(report.hosts).toEqual([
        expect.objectContaining({
          pid: judged.pid,
          action: 'left-alone',
          note: 'its registry entry changed'
        })
      ])
    }
  )

  it('fails the build when the CLI reports acting outside the profile it was given', async () => {
    const base = scratch('host-stop-all-escape-')
    const root = checkout(base, 'AGBench', true)
    const payloadRoot = join(root, 'out', 'host')
    const registryRoot = join(base, 'registry')
    const own = entryFor(join(base, 'profiles', 'own'), cliOf(payloadRoot))
    writeEntry(registryRoot, own)
    const escapes = [
      cliReport(registryRoot, own.profilePath, 'stopped', own.pid, [
        { profilePath: '/Users/a/Library/Application Support/TaskWraith', selected: true }
      ]),
      cliReport(registryRoot, own.profilePath, 'stopped', own.pid).replace(
        '"kind": "profile"',
        '"kind": "all"'
      )
    ]
    for (const stdout of escapes) {
      let stderr = ''
      const code = await hook.main(['--payload-root', 'out/host'], {
        checkoutRoot: root,
        stdout: () => undefined,
        stderr: (text) => {
          stderr += text
        },
        options: {
          registryRoot,
          ports: {
            probePid: () => 'alive',
            readProfileRecords: MISSING_RECORDS,
            runCliStop: async () => ({ code: 0, signal: null, stdout, stderr: '' })
          }
        }
      })
      expect(code).toBe(hook.EXIT_SCOPE_BROKEN)
      expect(stderr).toContain('ERROR the CLI acted outside the profile it was given')
    }

    // One CLI reports an escape, another is still running at the deadline:
    // the escape still fails the build.
    const slow = entryFor(join(base, 'profiles', 'slow'), cliOf(payloadRoot))
    writeEntry(registryRoot, slow)
    let stderr = ''
    const code = await hook.main(['--payload-root', 'out/host'], {
      checkoutRoot: root,
      hookDeadlineMs: 500,
      stdout: () => undefined,
      stderr: (text) => {
        stderr += text
      },
      options: {
        registryRoot,
        ports: {
          probePid: () => 'alive',
          readProfileRecords: MISSING_RECORDS,
          runCliStop: (input) =>
            input.profilePath === slow.profilePath
              ? new Promise(() => undefined)
              : Promise.resolve({ code: 0, signal: null, stdout: escapes[0], stderr: '' })
        }
      }
    })
    expect(code).toBe(hook.EXIT_SCOPE_BROKEN)
    expect(stderr).toContain('passed 500 ms; the build continues')
    expect(stderr).toContain('ERROR the CLI acted outside the profile it was given')
  })

  it('warns once without weaker retry when the prior CLI rejects identity flags or refuses', async () => {
    const base = scratch('host-stop-all-refused-')
    const root = checkout(base, 'AGBench', true)
    const payloadRoot = join(root, 'out', 'host')
    const registryRoot = join(base, 'registry')
    const own = entryFor(join(base, 'profiles', 'own'), cliOf(payloadRoot))
    writeEntry(registryRoot, own)
    const runs: [CliRun, string, RegExp][] = [
      [
        {
          code: 2,
          signal: null,
          stdout: '',
          stderr: 'taskwraith-host: Unknown argument --expect-pid'
        },
        'no-report',
        /printed no stop-all report \(exit 2; it predates stop-all or refused the arguments\)/
      ],
      [
        {
          code: 1,
          signal: null,
          stdout: cliReport(registryRoot, own.profilePath, 'identity_unavailable', own.pid),
          stderr: ''
        },
        'refused',
        /left running: verified termination answered identity_unavailable/
      ],
      [
        { code: null, signal: 'SIGKILL', stdout: '{', stderr: '' },
        'no-report',
        /exit SIGKILL; no JSON report/
      ]
    ]
    for (const [run, result, warning] of runs) {
      const runCliStop = vi.fn(async () => run)
      const report = await hook.runHostStopAll({
        checkoutRoot: root,
        payloadRoot,
        registryRoot,
        ports: {
          probePid: () => 'alive',
          readProfileRecords: MISSING_RECORDS,
          runCliStop
        }
      })
      expect(report.exitCode).toBe(hook.EXIT_OK)
      expect(report.hosts[0]).toMatchObject({ action: 'cli-stop', result })
      expect(report.warnings.join('\n')).toMatch(warning)
      expect(report.warnings).toHaveLength(1)
      expect(runCliStop).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          profilePath: own.profilePath,
          expected: { pid: own.pid, birthIdentity: own.birthIdentity }
        })
      )
    }
  })

  it('preserves an entry a successor rewrites immediately after the dead-PID probe', async () => {
    const base = scratch('host-stop-all-successor-')
    const root = checkout(base, 'AGBench', true)
    const payloadRoot = join(root, 'out', 'host')
    const registryRoot = join(base, 'registry')
    const temporaryDirectory = join(base, 'tmp')
    const dead = entryFor(join(base, 'profiles', 'restarted'), cliOf(payloadRoot))
    writeEntry(registryRoot, dead)
    const successor = { ...dead, pid: dead.pid + 1, bootEpoch: 'boot-successor' }
    const directory = join(temporaryDirectory, `twh2-501-${hostRegistryEntryId(dead.profilePath)}`)
    mkdirSync(directory, { recursive: true })
    let probes = 0
    const report = await hook.runHostStopAll({
      checkoutRoot: root,
      payloadRoot,
      registryRoot,
      temporaryDirectory,
      uid: '501',
      ports: {
        probePid: (pid) => {
          probes += 1
          // A successor starts on the profile right after the dead one is judged.
          if (probes === 1) writeEntry(registryRoot, successor)
          return pid === dead.pid ? 'dead' : 'alive'
        }
      }
    })
    expect(probes).toBeGreaterThan(0)
    expect(report.hosts).toEqual([
      expect.objectContaining({
        pid: dead.pid,
        action: 'listed'
      })
    ])
    const read = readHostRegistryEntry(registryRoot, dead.profilePath)
    expect(read.kind === 'present' ? read.entry.pid : null).toBe(successor.pid)
    expect(existsSync(directory)).toBe(true)
  })

  it('lists a dead entry and leaves an unobservable pid alone', async () => {
    const base = scratch('host-stop-all-listed-')
    const root = checkout(base, 'AGBench', true)
    const payloadRoot = join(root, 'out', 'host')
    const registryRoot = join(base, 'registry')
    const dead = entryFor(join(base, 'profiles', 'dead'), cliOf(payloadRoot))
    const foreign = entryFor(join(base, 'profiles', 'foreign'), cliOf(payloadRoot))
    writeEntry(registryRoot, dead)
    writeEntry(registryRoot, foreign)
    const cli = recordingCli(registryRoot)
    const report = await hook.runHostStopAll({
      checkoutRoot: root,
      payloadRoot,
      registryRoot,
      ports: {
        probePid: (pid) => (pid === dead.pid ? 'dead' : 'foreign'),
        runCliStop: cli.runCliStop
      }
    })
    expect(cli.calls).toEqual([])
    expect(report.hosts.find((host) => host.pid === dead.pid)?.action).toBe('listed')
    expect(report.hosts.find((host) => host.pid === foreign.pid)?.action).toBe('left-alone')
    expect(report.warnings.join('\n')).toContain('left alone: its pid is foreign')
    expect(readHostRegistry(registryRoot).entries).toHaveLength(2)
  })

  it(
    'bounds a hung registry walk and a hung CLI, and lets the build continue',
    async () => {
      const base = scratch('host-stop-all-deadline-')
      const root = checkout(base, 'AGBench', true)
      const payloadRoot = join(root, 'out', 'host')
      const registryRoot = join(base, 'registry')

      const walkStarted = Date.now()
      const walk = await hook.runHostStopAll({
        checkoutRoot: root,
        payloadRoot,
        registryRoot,
        walkDeadlineMs: 50,
        ports: { readRegistry: () => new Promise(() => undefined) }
      })
      expect(Date.now() - walkStarted).toBeLessThan(2_000)
      expect(walk.exitCode).toBe(hook.EXIT_OK)
      expect(walk.hosts).toEqual([])
      expect(walk.warnings).toEqual(['the registry walk passed 50 ms; nothing was stopped'])

      const pidFile = join(base, 'hung-cli.pid')
      writeFileSync(
        cliOf(payloadRoot),
        // Hangs well past the hook deadline, but never outlives a failed run.
        "require('node:fs').writeFileSync(process.env.FAKE_CLI_PID, String(process.pid))\nsetTimeout(() => {}, 30000)\n"
      )
      const hung = entryFor(join(base, 'profiles', 'own'), cliOf(payloadRoot))
      writeEntry(registryRoot, hung)
      let stderr = ''
      let stdout = ''
      const code = await hook.main(['--payload-root', 'out/host'], {
        checkoutRoot: root,
        env: { ...process.env, FAKE_CLI_PID: pidFile },
        hookDeadlineMs: 1_500,
        stdout: (text) => {
          stdout += text
        },
        stderr: (text) => {
          stderr += text
        },
        options: {
          registryRoot,
          ports: { probePid: () => 'alive', readProfileRecords: MISSING_RECORDS }
        }
      })
      expect(code).toBe(hook.EXIT_OK)
      expect(stderr).toContain(
        `warning: stopping the Hosts of this checkout (${hung.profilePath}) passed 1500 ms; the build continues`
      )
      // A run that gave up never reports that nothing was in scope.
      expect(stdout).not.toContain('no Host in')
      expect(stdout).toBe('')
      // The hung CLI child (never a Host) was killed.
      const cliPid = Number(readFileSync(pidFile, 'utf8'))
      const deadline = Date.now() + 5_000
      let gone = false
      while (!gone && Date.now() < deadline) {
        try {
          process.kill(cliPid, 0)
          await new Promise((resolve) => setTimeout(resolve, 50))
        } catch {
          gone = true
        }
      }
      expect(gone).toBe(true)
    },
    PROCESS_TEST_TIMEOUT_MS
  )

  it('fails the build loudly when the scope filter itself is broken', async () => {
    const source = readFileSync(SCRIPT_PATH, 'utf8')
    const intact = 'return candidate.startsWith(`${root}${api.sep}`)'
    expect(source.split(intact)).toHaveLength(2)
    const base = scratch('host-stop-all-broken-')
    const root = checkout(base, 'AGBench', true)
    const broken = join(root, 'scripts', 'host-stop-all.cjs')
    writeFileSync(broken, source.replace(intact, 'return candidate.startsWith(root)'))
    const mutated = require(broken) as HookModule
    const registryRoot = join(base, 'registry')
    writeEntry(registryRoot, entryFor(join(base, 'p'), cliOf(join(`${root}`, 'out', 'host2'))))
    let reads = 0
    let stops = 0
    let stderr = ''
    const code = await mutated.main(['--payload-root', 'out/host'], {
      checkoutRoot: root,
      stdout: () => undefined,
      stderr: (text) => {
        stderr += text
      },
      options: {
        registryRoot,
        ports: {
          readRegistry: async (path) => {
            reads += 1
            return readHostRegistry(path)
          },
          probePid: () => 'alive',
          readProfileRecords: MISSING_RECORDS,
          runCliStop: async () => {
            stops += 1
            return { code: 0, signal: null, stdout: '', stderr: '' }
          }
        }
      }
    })
    expect(code).toBe(hook.EXIT_SCOPE_BROKEN)
    expect(stderr).toContain('ERROR the scope filter failed its self-test')
    expect(stderr).toContain('host2')
    expect(reads).toBe(0)
    expect(stops).toBe(0)
  })
})

interface Tracked {
  readonly child: ChildProcess
  readonly pid: number
  readonly birth: Extract<ProcessBirthObservation, { state: 'live' }>
  readonly exited: Promise<unknown>
  stderr: string
}

const tracked: Tracked[] = []
const socketDirectories: string[] = []

afterEach(async () => {
  while (tracked.length) {
    const entry = tracked.pop()!
    const now = await observeProcessBirthIdentity(entry.pid)
    if (now.state === 'live' && now.birthIdentity === entry.birth.birthIdentity) {
      // Still exactly the Host this suite spawned.
      try {
        process.kill(entry.pid, 'SIGKILL')
      } catch {
        // Already gone.
      }
    }
    await Promise.race([entry.exited, new Promise((resolve) => setTimeout(resolve, 5_000))])
  }
  while (socketDirectories.length) {
    rmSync(socketDirectories.pop()!, { recursive: true, force: true })
  }
})

async function waitFor(check: () => boolean | Promise<boolean>, label: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

function runHook(checkoutRoot: string, registryRoot: string): Promise<CliRun> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [join(checkoutRoot, 'scripts', 'host-stop-all.cjs'), '--payload-root', 'out/host', '--json'],
      { cwd: checkoutRoot, env: { ...process.env, [HOST_REGISTRY_ROOT_ENV]: registryRoot } }
    )
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }))
  })
}

describe.skipIf(!POSIX)('host-stop-all against real Hosts', () => {
  it('stops only its own live Host, preserves every dead record, and a sibling stops only its own', async () => {
    const base = scratch('host-stop-all-real-')
    const checkoutA = join(base, 'AGBench')
    const checkoutB = join(base, 'AGBench-wt')
    const payloadA = join(checkoutA, 'out', 'host')
    const compile = spawnSync(
      process.execPath,
      [
        join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
        '-p',
        join(REPO_ROOT, 'src', 'host-runtime', 'tsconfig.json'),
        '--outDir',
        payloadA
      ],
      { cwd: REPO_ROOT, encoding: 'utf8' }
    )
    expect(compile.status, `${compile.stdout}${compile.stderr}`).toBe(0)
    const workers = spawnSync(
      process.execPath,
      [
        join(REPO_ROOT, 'scripts', 'build-history-workers.cjs'),
        '--outdir',
        join(payloadA, 'host-node')
      ],
      { cwd: REPO_ROOT, encoding: 'utf8' }
    )
    expect(workers.status, workers.stderr).toBe(0)
    cpSync(payloadA, join(checkoutA, 'out', 'host2'), { recursive: true })
    cpSync(payloadA, join(checkoutB, 'out', 'host'), { recursive: true })
    for (const root of [checkoutA, checkoutB]) {
      mkdirSync(join(root, 'scripts'), { recursive: true })
      copyFileSync(SCRIPT_PATH, join(root, 'scripts', 'host-stop-all.cjs'))
    }
    const registryRoot = join(base, 'registry')
    const hostEnv = {
      ...process.env,
      [HOST_REGISTRY_ROOT_ENV]: registryRoot,
      // No grace exit while a phase runs: these Hosts have no client.
      TASKWRAITH_HOST_PERSIST: '1',
      PATH: ''
    }

    const startHost = async (payload: string, profile: string): Promise<Tracked> => {
      socketDirectories.push(dirname(taskWraithHostSocketPath(profile)))
      const child = spawn(
        process.execPath,
        [cliOf(payload), 'serve', '--mode', 'production', '--profile', profile],
        { env: hostEnv, stdio: ['ignore', 'ignore', 'pipe'] }
      )
      const exited = new Promise((resolve) => child.once('exit', resolve))
      const pid = child.pid
      if (!pid) throw new Error('Host did not start')
      const birth = await observeProcessBirthIdentity(pid)
      if (birth.state !== 'live') throw new Error(`Host birth unobservable: ${birth.state}`)
      const host: Tracked = { child, pid, birth, exited, stderr: '' }
      child.stderr?.setEncoding('utf8')
      child.stderr?.on('data', (chunk: string) => {
        if (host.stderr.length < 64 * 1024) host.stderr += chunk
      })
      tracked.push(host)
      await waitFor(() => {
        const read = readHostRegistryEntry(registryRoot, profile)
        return read.kind === 'present' && read.entry.pid === pid
      }, `the registry entry of ${profile}`)
      return host
    }
    const isAlive = async (host: Tracked) => {
      const now = await observeProcessBirthIdentity(host.pid)
      return now.state === 'live' && now.birthIdentity === host.birth.birthIdentity
    }
    const kill = async (host: Tracked) => {
      expect(await isAlive(host)).toBe(true)
      process.kill(host.pid, 'SIGKILL')
      await host.exited
    }

    const profile = (name: string) => join(base, 'profiles', name)
    const [ownLive, ownDead, siblingLive, host2Dead] = await Promise.all([
      startHost(payloadA, profile('own-live')),
      startHost(payloadA, profile('own-dead')),
      startHost(join(checkoutB, 'out', 'host'), profile('sibling-live')),
      startHost(join(checkoutA, 'out', 'host2'), profile('host2-dead'))
    ])
    await kill(ownDead)
    await kill(host2Dead)
    const socketDirectoryOf = (name: string) => dirname(taskWraithHostSocketPath(profile(name)))
    expect(existsSync(socketDirectoryOf('own-dead'))).toBe(true)
    expect(existsSync(socketDirectoryOf('host2-dead'))).toBe(true)
    expect(readHostRegistry(registryRoot).entries).toHaveLength(4)

    // The build hook of checkout A.
    const first = await runHook(checkoutA, registryRoot)
    expect(first.code, `${first.stderr}\n${ownLive.stderr}`).toBe(0)
    const firstReport = JSON.parse(first.stdout) as HookReport
    expect(firstReport.mode).toBe('cli')
    expect(firstReport.hosts.map((host) => host.profilePath).sort()).toEqual(
      [profile('own-dead'), profile('own-live')].sort()
    )
    expect(
      firstReport.hosts.find((host) => host.profilePath === profile('own-live'))
    ).toMatchObject({
      liveness: 'alive',
      action: 'cli-stop',
      result: 'gone',
      outcome: 'stopped'
    })
    expect(
      firstReport.hosts.find((host) => host.profilePath === profile('own-dead'))
    ).toMatchObject({
      liveness: 'dead',
      action: 'listed'
    })
    await ownLive.exited
    expect(await isAlive(ownLive)).toBe(false)
    expect(readHostRegistryEntry(registryRoot, profile('own-live')).kind).toBe('missing')
    expect(existsSync(socketDirectoryOf('own-live'))).toBe(false)
    expect(readHostRegistryEntry(registryRoot, profile('own-dead')).kind).toBe('present')
    // The sibling's live Host and the dead out/host2 Host's records survive.
    expect(await isAlive(siblingLive)).toBe(true)
    expect(readHostRegistryEntry(registryRoot, profile('sibling-live')).kind).toBe('present')
    expect(await hostSocketIsLive(taskWraithHostSocketPath(profile('sibling-live')))).toBe(true)
    expect(readHostRegistryEntry(registryRoot, profile('host2-dead')).kind).toBe('present')
    expect(existsSync(socketDirectoryOf('host2-dead'))).toBe(true)

    // The same hook, run from the sibling checkout, stops only its own Host.
    const second = await runHook(checkoutB, registryRoot)
    expect(second.code, `${second.stderr}\n${siblingLive.stderr}`).toBe(0)
    const secondReport = JSON.parse(second.stdout) as HookReport
    expect(secondReport.hosts).toEqual([
      expect.objectContaining({
        profilePath: profile('sibling-live'),
        result: 'gone',
        outcome: 'stopped'
      })
    ])
    await siblingLive.exited
    expect(readHostRegistryEntry(registryRoot, profile('host2-dead')).kind).toBe('present')
    expect(existsSync(socketDirectoryOf('host2-dead'))).toBe(true)
    expect(existsSync(socketDirectoryOf('own-dead'))).toBe(true)

    // A real Host from another payload takes the selected profile immediately
    // after the final registry read. The CLI must still act only on A's identity.
    const replacedProfile = profile('replaced-after-check')
    const original = await startHost(payloadA, replacedProfile)
    let successor: Tracked | undefined
    const selectedEntry = hostRegistryEntryPath(registryRoot, replacedProfile)
    const swapped = await hook.runHostStopAll({
      checkoutRoot: checkoutA,
      payloadRoot: payloadA,
      registryRoot,
      env: hostEnv,
      ports: {
        readEntry: async (file) => {
          const captured = await hook.readEntryFile(file)
          if (file === selectedEntry && !successor) {
            await kill(original)
            successor = await startHost(join(checkoutB, 'out', 'host'), replacedProfile)
          }
          return captured
        }
      }
    })
    expect(successor).toBeDefined()
    expect(swapped.exitCode).toBe(hook.EXIT_OK)
    expect(swapped.hosts.find((row) => row.profilePath === replacedProfile)).toMatchObject({
      pid: original.pid,
      action: 'cli-stop',
      result: 'refused',
      outcome: 'inconsistent'
    })
    expect(await isAlive(successor!)).toBe(true)
    expect(await hostSocketIsLive(taskWraithHostSocketPath(replacedProfile))).toBe(true)
    const surviving = readHostRegistryEntry(registryRoot, replacedProfile)
    expect(surviving.kind === 'present' ? surviving.entry.pid : null).toBe(successor!.pid)
    expect(readHostRegistryEntry(registryRoot, profile('own-dead')).kind).toBe('present')
    expect(existsSync(socketDirectoryOf('own-dead'))).toBe(true)
  }, 180_000)
})
