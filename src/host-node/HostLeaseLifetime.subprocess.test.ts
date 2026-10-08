import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { createConnection, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { buildSync } from 'esbuild'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { HostLeaseClient, declineHostLease } from '../host-client/HostLeaseClient'
import {
  terminateHostProcess,
  type HostTerminationTimings
} from '../host-client/HostProcessTermination'
import { HostProjectionClient } from '../host-client/HostProjectionClient'
import type { HostStopAllHost, HostStopAllReport } from '../host-client/HostStopAll'
import { HOST_LEASE_DISABLED_ENV, HOST_LEASE_TIMING_ENV } from '../host-runtime/HostLeaseRegistry'
import {
  HOST_REGISTRY_ROOT_ENV,
  HOST_REGISTRY_SWEEP_MIN_AGE_MS,
  HostRegistryPublisher,
  hostRegistryEntryId,
  readHostRegistry,
  readHostRegistryEntry
} from '../host-runtime/HostRegistry'
import { observeProcessBirthIdentity } from '../host-runtime/ProcessBirthIdentity'
import {
  HOST_PROTOCOL_VERSION,
  type HostBootstrapWelcome,
  type HostCapability,
  type HostCommand
} from '../shared/hostProtocol'
import {
  TASKWRAITH_HOST_SOCKET_FILE,
  decodeTaskWraithHostDiscovery,
  taskWraithHostAuthorityLeasePath,
  taskWraithHostDiscoveryPath,
  taskWraithHostSocketPath,
  taskWraithHostTokenPath
} from '../shared/taskWraithHostPaths.node'
import { HOST_LIFETIME_STOP_DEADLINE_MS } from './HostNodeProductionServer'

/**
 * The Host lifetime end to end (Host-lifetime programme S7): production Hosts
 * built once from this checkout, held and let go by real lease clients,
 * stopped by `stop-all` and by verified termination.
 *
 * Isolation. Every process this suite starts gets an environment built from
 * nothing: PATH '' (no provider CLI resolves), and HOME, the XDG roots,
 * TMPDIR (where Host sockets live and what `stop-all --sweep` walks) and
 * TASKWRAITH_HOST_REGISTRY_ROOT all inside one temporary root. No key,
 * provider home or registry of this worker's own reaches a Host. The worker
 * points its own TMPDIR at the same directory while the suite runs, because a
 * client trusts only the socket path it derives from its own temp dir.
 *
 * `stop-all --all` runs only in scenario 4 and only registry-scoped: the argv
 * scan (`--scan-argv`, the one path that reads the machine's process table) is
 * never passed, and every report is checked to have run without it and to list
 * nothing but this suite's entries. The processes it could reach are Hosts and
 * decoys this suite started.
 *
 * Teardown kills every process the suite started, by pid, and only while its
 * birth identity still equals the one observed at start (where birth cannot be
 * observed, only while Node has not reaped the child); a process that outlives
 * teardown fails the suite.
 *
 * Windows skips the scenarios that need POSIX signals (SIGSTOP), a Unix socket
 * directory (stop-all's sweep, the half-closed socket of the late stop) or the
 * POSIX shell fake Muse (busy at grace, the resumed drain).
 */

const IS_WINDOWS = process.platform === 'win32'
const GRACE_MS = 1_500
const TTL_MS = 800
/** Every Host here runs under this: heartbeat, lapse and grace scaled down. */
const TIMING = `heartbeat:200,ttl:${TTL_MS},grace:${GRACE_MS}`
/** Budgets for a Host that cannot answer: its ack, then TERM, then KILL. */
const WEDGED_HOST_TIMINGS: Partial<HostTerminationTimings> = {
  ackMs: 1_000,
  drainMs: 1_000,
  termMs: 1_000,
  killMs: 5_000,
  pollMs: 50,
  exitMs: 1_000
}
/** Budgets for a Host that answers: the socket stop is expected to do it all. */
const ANSWERING_HOST_TIMINGS: Partial<HostTerminationTimings> = {
  ackMs: 5_000,
  drainMs: 15_000,
  termMs: 5_000,
  killMs: 5_000,
  pollMs: 50,
  exitMs: 5_000
}
/** The capability set of a client that submits commands and reads history. */
const COMMAND_CAPABILITIES: HostCapability[] = [
  'bootstrap',
  'commands',
  'receipts',
  'setup',
  'provider-catalog',
  'provider-auth',
  'history',
  'health'
]
const COMMAND_CLIENT_ID = 'subprocess-client'
const WINDOWS_SYSTEM_ENV = ['SystemRoot', 'windir', 'SystemDrive', 'ComSpec', 'PATHEXT']

/**
 * A lease holder in its own process: the real HostProjectionClient and
 * HostLeaseClient, bundled from this checkout. It prints one line once it
 * holds a lease, then renews on the lease client's own timer until killed.
 */
const LEASE_HOLDER_ENTRY = `
import { HostLeaseClient } from './HostLeaseClient'
import { HostProjectionClient } from './HostProjectionClient'

const [profile, clientId] = process.argv.slice(2)
const client = new HostProjectionClient({
  userDataPath: profile,
  client: { clientId, clientClass: 'tui', clientVersion: '1.0' },
  capabilities: ['bootstrap', 'health']
})
client
  .connect()
  .then(async () => {
    const lease = new HostLeaseClient({ client })
    const state = await lease.acquire()
    process.stdout.write(JSON.stringify({ state, leaseId: lease.leaseId }) + '\\n')
  })
  .catch((error) => {
    process.stderr.write('lease holder failed: ' + String(error) + '\\n')
    process.exit(1)
  })
setInterval(() => undefined, 60_000)
`

interface SuiteRoot {
  readonly root: string
  readonly tmp: string
  readonly home: string
  readonly xdg: string
  readonly registry: string
  readonly profiles: string
  readonly gates: string
  readonly out: string
  readonly cli: string
  readonly holder: string
}

interface ExitStatus {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  /** When the exit event fired. */
  readonly at: number
}

interface Started {
  readonly label: string
  readonly pid: number
  /** Null for a process this suite did not spawn itself (a Host's fake Muse). */
  readonly child: ChildProcess | null
  /** The birth observed right after start; null where it cannot be observed. */
  readonly birth: Promise<string | null>
  exit: ExitStatus | null
  /** Settles once the process has exited and its stdio has closed. */
  readonly closed: Promise<ExitStatus>
  stderr(): string
  stdout(): string
}

interface GatedMuse {
  readonly name: string
  readonly binary: string
  readonly gate: string
  readonly pidFile: string
  readonly text: string
}

let suite: SuiteRoot | null = null
let staleSocketDirectory: { readonly name: string; readonly plantedAt: number } | null = null
const started: Started[] = []
const clients = new Set<HostProjectionClient>()
const rawSockets = new Set<Socket>()
const gates = new Set<string>()
const workerTmpdir: { readonly had: boolean; readonly value: string | undefined } = {
  had: 'TMPDIR' in process.env,
  value: process.env.TMPDIR
}

function paths(): SuiteRoot {
  if (!suite) throw new Error('the suite root was not built')
  return suite
}

/**
 * A Host's socket is `<TMPDIR>/twh2-<uid>-<16 hex>/taskwraith-host-v2.sock`,
 * and a Unix socket path is capped near 104 bytes on darwin. macOS's per-user
 * temp dir alone is about 48 characters, so a private TMPDIR beneath it would
 * overflow the cap (the listen fails EINVAL); /tmp is short on every POSIX
 * system. A Windows Host listens on a named pipe and never reads TMPDIR for it.
 */
function temporaryBase(): string {
  return IS_WINDOWS || tmpdir().length <= 24 ? tmpdir() : '/tmp'
}

function isolatedEnv(
  extra: Readonly<Record<string, string>> = {},
  omit: readonly string[] = []
): NodeJS.ProcessEnv {
  const root = paths()
  const env: NodeJS.ProcessEnv = {
    PATH: '',
    HOME: root.home,
    TMPDIR: root.tmp,
    XDG_CONFIG_HOME: join(root.xdg, 'config'),
    XDG_DATA_HOME: join(root.xdg, 'data'),
    XDG_STATE_HOME: join(root.xdg, 'state'),
    XDG_CACHE_HOME: join(root.xdg, 'cache'),
    XDG_RUNTIME_DIR: join(root.xdg, 'runtime'),
    [HOST_REGISTRY_ROOT_ENV]: root.registry,
    [HOST_LEASE_TIMING_ENV]: TIMING
  }
  if (IS_WINDOWS) {
    // Node and PowerShell need the system directories; everything else stays private.
    for (const key of WINDOWS_SYSTEM_ENV) {
      const value = process.env[key]
      if (value) env[key] = value
    }
    Object.assign(env, {
      TEMP: root.tmp,
      TMP: root.tmp,
      USERPROFILE: root.home,
      APPDATA: join(root.xdg, 'config'),
      LOCALAPPDATA: join(root.xdg, 'data')
    })
  }
  Object.assign(env, extra)
  for (const key of omit) delete env[key]
  return env
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function waitFor(check: () => boolean, label: string, timeoutMs = 12_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`)
    await delay(25)
  }
}

async function waitForAsync(
  check: () => Promise<boolean>,
  label: string,
  timeoutMs = 12_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`)
    await delay(25)
  }
}

function observeBirth(pid: number): Promise<string | null> {
  return observeProcessBirthIdentity(pid).then(
    (observation) => (observation.state === 'live' ? observation.birthIdentity : null),
    () => null
  )
}

function startProcess(label: string, args: readonly string[], options: SpawnOptions): Started {
  const child = spawn(process.execPath, [...args], options)
  const pid = child.pid
  if (!pid) throw new Error(`${label} did not start`)
  let stderr = ''
  let stdout = ''
  // Drained continuously, so a pipe can never back-pressure the process.
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk: string) => {
    if (stderr.length < 256 * 1024) stderr += chunk
  })
  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => {
    if (stdout.length < 1024 * 1024) stdout += chunk
  })
  child.on('error', (error) => {
    stderr += `\n[spawn error] ${error.message}`
  })
  const entry: Started = {
    label,
    pid,
    child,
    // On Windows Node retains the exact child process handle until exit.
    // Starting an extra PowerShell birth probe here competes with the very
    // short startup grace this fixture measures. Adopted processes still
    // require a separately observed birth identity below.
    birth: IS_WINDOWS ? Promise.resolve(null) : observeBirth(pid),
    exit: null,
    closed: new Promise<ExitStatus>((resolve) => {
      child.once('exit', (code, signal) => {
        entry.exit = { code, signal, at: Date.now() }
      })
      child.once('close', () => resolve(entry.exit ?? { code: null, signal: null, at: Date.now() }))
    }),
    stderr: () => stderr,
    stdout: () => stdout
  }
  started.push(entry)
  return entry
}

/** Tracks a process a Host started for this suite (its fake Muse), so teardown reaches it too. */
function adoptProcess(label: string, pid: number): Started {
  const entry: Started = {
    label,
    pid,
    child: null,
    birth: observeBirth(pid),
    exit: null,
    closed: new Promise<ExitStatus>(() => undefined),
    stderr: () => '',
    stdout: () => ''
  }
  started.push(entry)
  return entry
}

/** Still exactly the process this suite started: the same birth, or an unreaped child. */
async function isStillRunning(entry: Started): Promise<boolean> {
  const recorded = await entry.birth
  if (recorded === null) {
    return entry.child !== null && entry.child.exitCode === null && entry.child.signalCode === null
  }
  const now = await observeProcessBirthIdentity(entry.pid)
  return now.state === 'live' && now.birthIdentity === recorded
}

function sendSignal(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal)
  } catch {
    // Already gone, or a signal this platform cannot deliver.
  }
}

async function signalStarted(entry: Started, signal: NodeJS.Signals): Promise<number> {
  if (!(await isStillRunning(entry))) throw new Error(`${entry.label} is no longer running`)
  const signalledAt = Date.now()
  if (IS_WINDOWS && entry.child) {
    if (!entry.child.kill(signal)) throw new Error(`${entry.label} could not be signalled`)
  } else sendSignal(entry.pid, signal)
  return signalledAt
}

async function waitForExit(entry: Started, timeoutMs = 15_000): Promise<ExitStatus> {
  return withTimeout(entry.closed, timeoutMs, `${entry.label} to exit`)
}

/**
 * Kills every process still running that this suite started, each only after
 * re-proving it is the same process, and returns any that outlived the kill.
 */
async function killEverythingStarted(): Promise<string[]> {
  const survivors: string[] = []
  for (const entry of started.splice(0).reverse()) {
    if (await isStillRunning(entry)) {
      // A stopped process must be continued for anything but SIGKILL; SIGKILL lands either way.
      sendSignal(entry.pid, 'SIGCONT')
      if (entry.child && IS_WINDOWS) entry.child.kill('SIGKILL')
      else sendSignal(entry.pid, 'SIGKILL')
      if (entry.child) await Promise.race([entry.closed, delay(5_000)])
      else {
        const deadline = Date.now() + 5_000
        while (Date.now() < deadline && (await isStillRunning(entry))) await delay(50)
      }
    }
    if (await isStillRunning(entry)) survivors.push(`${entry.label} (pid ${entry.pid})`)
  }
  return survivors
}

function releaseEveryGate(): void {
  for (const gate of gates) {
    if (existsSync(dirname(gate))) writeFileSync(gate, '')
  }
}

function closeEveryConnection(): void {
  for (const client of clients) client.close()
  clients.clear()
  for (const socket of rawSockets) socket.destroy()
  rawSockets.clear()
}

function profileDir(name: string): string {
  const profile = join(paths().profiles, name)
  mkdirSync(profile, { recursive: true })
  return profile
}

function spawnHost(
  profile: string,
  options: {
    readonly env?: Readonly<Record<string, string>>
    readonly omitEnv?: readonly string[]
    readonly args?: readonly string[]
    readonly detached?: boolean
  } = {}
): Started {
  return startProcess(
    `Host ${profile}`,
    [paths().cli, 'serve', '--mode', 'production', '--profile', profile, ...(options.args ?? [])],
    {
      env: isolatedEnv(options.env, options.omitEnv),
      stdio: ['ignore', 'ignore', 'pipe'],
      // HostExternalSupervisor's spawn shape, when asked for.
      ...(options.detached ? { detached: true, windowsHide: true } : {})
    }
  )
}

async function connectClient(
  profile: string,
  identity: { readonly clientId: string; readonly clientClass: 'tui' | 'test' },
  capabilities: HostCapability[]
): Promise<{ readonly client: HostProjectionClient; readonly welcome: HostBootstrapWelcome }> {
  await waitFor(
    () => existsSync(taskWraithHostDiscoveryPath(profile)),
    `discovery for ${identity.clientId}`
  )
  const client = new HostProjectionClient({
    userDataPath: profile,
    client: { ...identity, clientVersion: '1.0' },
    capabilities
  })
  clients.add(client)
  const welcome = await client.connect()
  return { client, welcome }
}

/** A TUI-shaped client that never speaks host.lease unless the test makes it. */
function openClient(
  profile: string,
  clientId: string
): Promise<{ readonly client: HostProjectionClient; readonly welcome: HostBootstrapWelcome }> {
  return connectClient(profile, { clientId, clientClass: 'tui' }, ['bootstrap', 'health'])
}

/** The client whose identity `command()` stamps as the actor: it submits and reads history. */
function openCommandClient(
  profile: string
): Promise<{ readonly client: HostProjectionClient; readonly welcome: HostBootstrapWelcome }> {
  return connectClient(
    profile,
    { clientId: COMMAND_CLIENT_ID, clientClass: 'test' },
    COMMAND_CAPABILITIES
  )
}

/** A lease holder in its own process, returned once it holds its lease. */
async function startHolder(profile: string, clientId: string): Promise<Started> {
  const holder = startProcess(`lease holder ${clientId}`, [paths().holder, profile, clientId], {
    env: isolatedEnv(),
    stdio: ['ignore', 'pipe', 'pipe']
  })
  await waitFor(
    () => holder.stdout().includes('\n') || holder.exit !== null,
    `${clientId} to hold its lease`
  )
  const line = holder.stdout().split('\n')[0]
  expect(line, holder.stderr()).not.toBe('')
  expect(JSON.parse(line)).toEqual({ state: 'held', leaseId: expect.any(String) })
  return holder
}

async function runCli(
  args: readonly string[],
  env: NodeJS.ProcessEnv = isolatedEnv()
): Promise<{ readonly status: number | null; readonly stdout: string; readonly stderr: string }> {
  const run = startProcess(`cli.js ${args.join(' ')}`, [paths().cli, ...args], {
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const exit = await withTimeout(run.closed, 90_000, `cli.js ${args.join(' ')}`)
  return { status: exit.code, stdout: run.stdout(), stderr: run.stderr() }
}

function command(
  name: HostCommand['name'],
  id: string,
  target: Record<string, string>,
  arguments_: Record<string, unknown>
): HostCommand {
  return {
    type: 'host.command',
    protocolVersion: HOST_PROTOCOL_VERSION,
    commandId: id,
    idempotencyKey: `key-${id}`,
    actor: { actorId: COMMAND_CLIENT_ID, clientId: COMMAND_CLIENT_ID, clientClass: 'test' },
    name,
    target,
    arguments: arguments_,
    issuedAt: '2026-09-23T00:00:00.000Z'
  }
}

async function createThread(
  client: HostProjectionClient,
  name: string
): Promise<{ readonly workspaceId: string; readonly threadId: string }> {
  const workspace = join(paths().root, 'workspaces', name)
  mkdirSync(workspace, { recursive: true })
  const registered = await client.submitCommand(
    command('workspace.register', `cmd-ws-${name}`, {}, { path: workspace })
  )
  const workspaceId =
    registered.resultRef?.kind === 'workspace' ? registered.resultRef.workspaceId : ''
  const created = await client.submitCommand(
    command('thread.create', `cmd-thread-${name}`, {}, { scope: 'workspace', workspaceId })
  )
  const threadId = created.resultRef?.kind === 'thread' ? created.resultRef.threadId : ''
  expect(workspaceId).not.toBe('')
  expect(threadId).not.toBe('')
  return { workspaceId, threadId }
}

/**
 * A POSIX fake Muse that holds its run open until the test releases it: it
 * records its pid (so teardown can reach it), waits for the gate file (at most
 * a minute, so a failed test cannot leave it running), then reports one
 * completed terminal record.
 */
function writeGatedMuse(name: string): GatedMuse {
  const root = paths()
  const binary = join(root.root, `muse-${name}`)
  const gate = join(root.gates, `${name}.release`)
  const pidFile = join(root.gates, `${name}.pid`)
  const text = `gated muse ${name} completed`
  const record = JSON.stringify({
    schema_version: 1,
    id: '44444444-4444-4444-4444-444444444444',
    stream: { kind: 'session', id: `gated-muse-${name}` },
    sequence: 1,
    recorded_at: 1780531400000000,
    record_type: 'event',
    payload_type: 'run.terminal.completed',
    payload: { kind: 'run_terminal_completed', terminal: 'completed', text }
  })
  gates.add(gate)
  // @portability-ok: a POSIX shell fake Muse; every scenario that runs one is skipped on win32.
  writeFileSync(
    binary,
    [
      '#!/bin/sh',
      `echo $$ > '${pidFile}'`,
      'i=0',
      `while [ ! -f '${gate}' ] && [ "$i" -lt 600 ]; do /bin/sleep 0.1; i=$((i + 1)); done`,
      `printf '%s\\n' '${record}'`,
      ''
    ].join('\n')
  )
  chmodSync(binary, 0o700)
  return { name, binary, gate, pidFile, text }
}

function releaseGate(muse: GatedMuse): void {
  writeFileSync(muse.gate, '')
}

/** Configures a thread for the fake Muse and starts one run; returns once the Muse runs. */
async function startMuseRun(
  client: HostProjectionClient,
  muse: GatedMuse
): Promise<{ readonly threadId: string }> {
  const { threadId } = await createThread(client, muse.name)
  const offers = await client.getProviderOffers('muse')
  await expect(
    client.submitCommand(
      command(
        'thread.configure',
        'cmd-config',
        { threadId },
        {
          providerId: 'muse',
          modelId: 'muse-spark-1.2',
          postureId: 'default',
          offerRevision: offers.offerRevision
        }
      )
    )
  ).resolves.toMatchObject({ status: 'succeeded' })
  await expect(
    client.submitCommand(command('composer.send', 'cmd-send', { threadId }, { text: muse.name }))
  ).resolves.toMatchObject({ status: 'succeeded' })
  await waitFor(() => existsSync(muse.pidFile), `the ${muse.name} Muse to start`)
  let pid = 0
  await waitFor(() => {
    pid = Number(readFileSync(muse.pidFile, 'utf8').trim())
    return Number.isSafeInteger(pid) && pid > 1
  }, `the ${muse.name} Muse pid`)
  adoptProcess(`fake Muse ${muse.name}`, pid)
  return { threadId }
}

/**
 * A Host lists its threads through its history mirror, which hydrates
 * asynchronously after the listener starts: a restarted Host can answer an
 * empty snapshot for a moment before its threads come back.
 */
async function waitForThread(client: HostProjectionClient, threadId: string): Promise<void> {
  await waitForAsync(
    async () =>
      (await client.getSnapshot()).snapshot.threads.some((thread) => thread.id === threadId),
    `thread ${threadId} in the snapshot`,
    15_000
  )
}

function museHostArgs(muse: GatedMuse): {
  readonly env: Readonly<Record<string, string>>
  readonly args: readonly string[]
} {
  return { env: { META_API_KEY: 'subprocess-test-key' }, args: ['--muse-binary', muse.binary] }
}

/** The Host's own stop: discovery, token, authority lease, registry entry and socket all gone. */
function expectProfileReleased(profile: string): void {
  expect(existsSync(taskWraithHostDiscoveryPath(profile))).toBe(false)
  expect(existsSync(taskWraithHostTokenPath(profile))).toBe(false)
  expect(existsSync(taskWraithHostAuthorityLeasePath(profile))).toBe(false)
  expect(readHostRegistryEntry(paths().registry, profile).kind).toBe('missing')
  if (!IS_WINDOWS) {
    const socketPath = taskWraithHostSocketPath(profile)
    expect(socketPath.startsWith(`${paths().tmp}/`)).toBe(true)
    expect(existsSync(socketPath)).toBe(false)
    expect(existsSync(dirname(socketPath))).toBe(false)
  }
}

/** A registry entry written on behalf of `pid`, recording `birthIdentity` as its birth. */
function publishRegistryEntry(profile: string, pid: number, birthIdentity: string | null): void {
  new HostRegistryPublisher({
    root: paths().registry,
    profilePath: profile,
    pid,
    observeSelf: () =>
      birthIdentity === null
        ? { state: 'identity_unavailable' }
        : { state: 'live', birthIdentity, startedAtMs: null },
    cliPath: paths().cli,
    nodeExecutable: process.execPath
  }).publish({
    profilePath: profile,
    pid,
    startedAt: new Date().toISOString(),
    hostId: 'hand-edited-host',
    persist: false,
    leaseMode: 'lease',
    holders: 1,
    implicitHolders: 0,
    lifetimePhase: 'held'
  })
}

/**
 * A socket directory as a crashed Host leaves it: its socket bound, then the
 * listener killed before it could unlink, so a dead socket inode stays behind.
 */
async function plantDeadSocketDirectory(label: string): Promise<string> {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'user'
  const name = `twh2-${uid}-${hostRegistryEntryId(join(paths().profiles, `never-served-${label}`))}`
  const socketPath = join(paths().tmp, name, TASKWRAITH_HOST_SOCKET_FILE)
  mkdirSync(dirname(socketPath), { mode: 0o700 })
  const listener = startProcess(
    `crashed listener ${label}`,
    [
      '-e',
      `require('node:net').createServer().listen(${JSON.stringify(socketPath)}, () => process.kill(process.pid, 'SIGKILL'))`
    ],
    { env: isolatedEnv(), stdio: 'ignore' }
  )
  expect((await waitForExit(listener)).signal).toBe('SIGKILL')
  expect(existsSync(socketPath)).toBe(true)
  return name
}

function stopAllReport(stdout: string): HostStopAllReport {
  return JSON.parse(stdout) as HostStopAllReport
}

function byProfile(report: HostStopAllReport): Map<string, HostStopAllHost> {
  return new Map(report.hosts.map((host) => [host.profilePath, host]))
}

beforeAll(async () => {
  const root = realpathSync(mkdtempSync(join(temporaryBase(), 'tw-s7-')))
  const out = join(root, 'out')
  suite = {
    root,
    tmp: join(root, 'tmp'),
    home: join(root, 'home'),
    xdg: join(root, 'xdg'),
    registry: join(root, 'registry'),
    profiles: join(root, 'profiles'),
    gates: join(root, 'gates'),
    out,
    cli: join(out, 'host-runtime', 'cli.js'),
    holder: join(root, 'lease-holder.cjs')
  }
  for (const directory of [suite.tmp, suite.home, suite.profiles, suite.gates]) {
    mkdirSync(directory, { recursive: true })
  }
  for (const name of ['config', 'data', 'state', 'cache', 'runtime']) {
    mkdirSync(join(suite.xdg, name), { recursive: true, mode: 0o700 })
  }
  if (!IS_WINDOWS) {
    process.env.TMPDIR = suite.tmp
    // Planted before the build so it is old enough for scenario 4's sweep by then.
    const name = await plantDeadSocketDirectory('stale')
    staleSocketDirectory = { name, plantedAt: Date.now() }
  }

  // One build for every Host: the host tsconfig, then the history workers
  // (HostNodeProductionServe.subprocess.test.ts's two stages), then the holder.
  const compile = spawnSync(
    process.execPath,
    [
      join(process.cwd(), 'node_modules', 'typescript', 'bin', 'tsc'),
      '-p',
      join(process.cwd(), 'src', 'host-runtime', 'tsconfig.json'),
      '--outDir',
      out
    ],
    { cwd: process.cwd(), encoding: 'utf8' }
  )
  expect(compile.status, compile.stdout).toBe(0)
  const workers = spawnSync(
    process.execPath,
    [
      join(process.cwd(), 'scripts', 'build-history-workers.cjs'),
      '--outdir',
      join(out, 'host-node')
    ],
    { cwd: process.cwd(), encoding: 'utf8' }
  )
  expect(workers.status, workers.stderr).toBe(0)
  buildSync({
    stdin: {
      contents: LEASE_HOLDER_ENTRY,
      resolveDir: join(process.cwd(), 'src', 'host-client'),
      sourcefile: 'lease-holder.ts',
      loader: 'ts'
    },
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    outfile: suite.holder,
    logLevel: 'silent'
  })
  expect(existsSync(suite.cli)).toBe(true)
  expect(existsSync(suite.holder)).toBe(true)
}, 180_000)

afterEach(async () => {
  closeEveryConnection()
  releaseEveryGate()
  const survivors = await killEverythingStarted()
  // A Host killed here leaves its entry behind; each scenario starts from an empty registry.
  if (suite) rmSync(suite.registry, { recursive: true, force: true })
  expect(survivors, 'processes this suite started outlived teardown').toEqual([])
}, 60_000)

afterAll(async () => {
  closeEveryConnection()
  releaseEveryGate()
  const survivors = await killEverythingStarted()
  if (workerTmpdir.had) process.env.TMPDIR = workerTmpdir.value
  else delete process.env.TMPDIR
  if (suite) rmSync(suite.root, { recursive: true, force: true })
  suite = null
  expect(survivors, 'processes this suite started outlived teardown').toEqual([])
}, 60_000)

describe('1. grace exit', () => {
  it('exits one grace after its last lease holder is killed, removing every artefact it published', async () => {
    const profile = profileDir('grace')
    const host = spawnHost(profile)
    const holder = await startHolder(profile, 'tui-grace-holder')
    const discovery = decodeTaskWraithHostDiscovery(
      JSON.parse(readFileSync(taskWraithHostDiscoveryPath(profile), 'utf8'))
    )
    if (!discovery.ok) throw new Error(discovery.error)
    // The isolation took: the socket lives in this suite's TMPDIR, the entry in its registry.
    if (!IS_WINDOWS) {
      expect(discovery.discovery.socketPath.startsWith(join(paths().tmp, 'twh2-'))).toBe(true)
    }
    expect(readHostRegistryEntry(paths().registry, profile)).toMatchObject({
      kind: 'present',
      entry: { pid: host.pid, profilePath: profile, leaseMode: 'lease' }
    })

    const killedAt = await signalStarted(holder, 'SIGKILL')
    const exit = await waitForExit(host)

    expect(exit.code, host.stderr()).toBe(0)
    // It waited out the grace, and left within it plus two seconds.
    expect(exit.at - killedAt).toBeGreaterThanOrEqual(GRACE_MS - 300)
    expect(exit.at - killedAt).toBeLessThanOrEqual(GRACE_MS + 2_000)
    expect(host.stderr()).toContain(`${HOST_LEASE_TIMING_ENV} shortened timing`)
    expect(host.stderr()).toContain('[host-lease] exit requested: idle')
    expectProfileReleased(profile)
  }, 60_000)

  it('control: a second holder keeps the Host serving past two graces after the first is killed', async () => {
    const profile = profileDir('grace-two-holders')
    const host = spawnHost(profile)
    const first = await startHolder(profile, 'tui-grace-first')
    const second = await startHolder(profile, 'tui-grace-second')

    await signalStarted(first, 'SIGKILL')
    await waitForExit(first)
    await delay(2 * GRACE_MS)
    expect(host.exit, host.stderr()).toBeNull()

    // A probe that declines, so it does not count itself among the holders.
    const { client: probe } = await openClient(profile, 'tui-grace-probe')
    await expect(declineHostLease(probe)).resolves.toBe('declined')
    await expect(probe.getHealth()).resolves.toMatchObject({ type: 'host.health' })
    const status = await probe.getHostStatus()
    expect(status).toMatchObject({
      pid: host.pid,
      lifetime: { phase: 'held', holders: 1, implicitHolders: 0 }
    })
    // Two TTLs and more have passed: the survivor's lease is held only because it renews.
    expect(status.clients).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ clientId: 'tui-grace-second', lease: 'explicit' }),
        expect.objectContaining({ clientId: 'tui-grace-probe', lease: 'declined' })
      ])
    )
    // Armed once, at birth, before any holder attached; never again while one held.
    expect(host.stderr().split('grace armed').length - 1).toBe(1)

    probe.close()
    await delay(GRACE_MS / 2)
    expect(host.exit, 'a declined probe leaving changes nothing').toBeNull()
    const killedAt = await signalStarted(second, 'SIGKILL')
    const exit = await waitForExit(host)
    expect(exit.code, host.stderr()).toBe(0)
    expect(exit.at - killedAt).toBeGreaterThanOrEqual(GRACE_MS - 300)
    expect(exit.at - killedAt).toBeLessThanOrEqual(GRACE_MS + 2_000)
    expectProfileReleased(profile)
  }, 60_000)
})

describe('2. implicit holder', () => {
  it('keeps a Host for an authenticated client that never speaks host.lease, and lets it go when that client closes', async () => {
    const profile = profileDir('implicit')
    const host = spawnHost(profile)
    // An old app or TUI: it authenticates and never sends a lease frame.
    const { client } = await openClient(profile, 'tui-before-leases')

    await delay(2 * GRACE_MS)
    expect(host.exit, host.stderr()).toBeNull()
    await expect(client.getHostStatus()).resolves.toMatchObject({
      lifetime: { phase: 'held', holders: 1, implicitHolders: 1 },
      clients: [expect.objectContaining({ clientId: 'tui-before-leases', lease: 'implicit' })]
    })

    const closedAt = Date.now()
    client.close()
    const exit = await waitForExit(host)
    expect(exit.code, host.stderr()).toBe(0)
    expect(exit.at - closedAt).toBeGreaterThanOrEqual(GRACE_MS - 300)
    expect(exit.at - closedAt).toBeLessThanOrEqual(GRACE_MS + 2_000)
    expect(host.stderr()).toContain('[host-lease] exit requested: idle')
    expectProfileReleased(profile)
  }, 60_000)

  it('control: a client that declines holds nothing, though its socket stays open', async () => {
    const profile = profileDir('declined')
    const host = spawnHost(profile)
    const { client } = await openClient(profile, 'tui-declining')
    const declinedAt = Date.now()
    await expect(declineHostLease(client)).resolves.toBe('declined')

    await delay(GRACE_MS / 2)
    expect(client.connected).toBe(true)
    const exit = await waitForExit(host)
    expect(exit.code, host.stderr()).toBe(0)
    expect(exit.at - declinedAt).toBeGreaterThanOrEqual(GRACE_MS - 300)
    expect(exit.at - declinedAt).toBeLessThanOrEqual(GRACE_MS + 2_000)
    expect(host.stderr()).toContain('[host-lease] exit requested: idle')
    expectProfileReleased(profile)
  }, 60_000)
})

describe.skipIf(IS_WINDOWS)('3. busy at grace', () => {
  it('holds a Host whose grace expires mid-run until the run completes, then exits drained with the run on disk', async () => {
    const profile = profileDir('busy')
    const muse = writeGatedMuse('busy')
    const host = spawnHost(profile, museHostArgs(muse))
    const { client: app } = await openCommandClient(profile)
    const { threadId } = await startMuseRun(app, muse)

    // The app goes away (its socket closes, as on a crash) with the run in flight.
    const closedAt = Date.now()
    app.close()
    await waitFor(
      () => host.stderr().includes('[host-lease] grace expired with 1 live run(s): draining'),
      'the drain',
      15_000
    )
    expect(Date.now() - closedAt).toBeGreaterThanOrEqual(GRACE_MS - 300)
    // Well past its grace, the run alone holds it.
    await delay(closedAt + 2 * GRACE_MS - Date.now())
    expect(host.exit, host.stderr()).toBeNull()

    const releasedAt = Date.now()
    releaseGate(muse)
    const exit = await waitForExit(host)
    expect(exit.code, host.stderr()).toBe(0)
    expect(exit.at - releasedAt).toBeLessThan(5_000)
    expect(host.stderr()).toContain('[host-lease] exit requested: drained')
    expect(host.stderr()).not.toContain('exit requested: idle')
    expectProfileReleased(profile)

    // The run's terminal record is on disk: the next Host on the profile reads it back.
    const reader = spawnHost(profile)
    const { client } = await openCommandClient(profile)
    await waitForAsync(
      async () =>
        (await client.getSnapshot()).snapshot.runs.some(
          (run) => run.runId === 'cmd-send' && run.providerOutcome === 'completed'
        ),
      'the completed run in the snapshot',
      15_000
    )
    await waitForAsync(
      async () =>
        (await client.getThreadHistory({ threadId, limit: 20 })).entries.some(
          (entry) => entry.text === muse.text
        ),
      'the run text in the history',
      15_000
    )
    client.close()
    expect((await waitForExit(reader)).code, reader.stderr()).toBe(0)
    expectProfileReleased(profile)
  }, 90_000)

  it('control: a run that completed before the last client left does not hold the Host', async () => {
    const profile = profileDir('busy-finished')
    const muse = writeGatedMuse('finished')
    const host = spawnHost(profile, museHostArgs(muse))
    const { client: app } = await openCommandClient(profile)
    const { threadId } = await startMuseRun(app, muse)
    releaseGate(muse)
    await waitForAsync(async () => {
      const history = await app.getThreadHistory({ threadId, limit: 20 })
      return history.entries.some((entry) => entry.text === muse.text)
    }, 'the run to complete')
    await waitForAsync(
      async () => (await app.getHostStatus()).liveWork.runs === 0,
      'no live run left'
    )

    const closedAt = Date.now()
    app.close()
    const exit = await waitForExit(host)
    expect(exit.code, host.stderr()).toBe(0)
    expect(exit.at - closedAt).toBeGreaterThanOrEqual(GRACE_MS - 300)
    expect(exit.at - closedAt).toBeLessThanOrEqual(GRACE_MS + 2_000)
    expect(host.stderr()).toContain('[host-lease] exit requested: idle')
    expect(host.stderr()).not.toContain('draining')
    expectProfileReleased(profile)
  }, 90_000)
})

describe.skipIf(IS_WINDOWS)('a resumed drain (S1a re-review R1, N3e)', () => {
  it('does not end drained until one grace after the client that interrupted it left', async () => {
    const profile = profileDir('drain-resume')
    const muse = writeGatedMuse('resume')
    const host = spawnHost(profile, museHostArgs(muse))
    const { client: app } = await openCommandClient(profile)
    await startMuseRun(app, muse)
    app.close()
    await waitFor(
      () => host.stderr().includes('[host-lease] grace expired with 1 live run(s): draining'),
      'the drain',
      15_000
    )

    // The app comes back during the drain, sees the run finish, and drops once.
    const { client: visitor } = await openClient(profile, 'tui-drain-visitor')
    const visitedAt = Date.now()
    await waitFor(() => host.stderr().includes('draining cancelled'), 'the drain to pause')
    releaseGate(muse)
    await waitForAsync(
      async () => (await visitor.getHostStatus()).liveWork.runs === 0,
      'the run to finish'
    )
    const leftAt = Date.now()
    // Shorter than a grace, or the Host would rightly arm a fresh grace instead.
    expect(leftAt - visitedAt, 'the visit must be shorter than the grace').toBeLessThan(GRACE_MS)
    visitor.close()
    await waitFor(() => host.stderr().includes('draining resumes'), 'the drain to resume')

    // The run is over, yet the client that left still gets a grace to return.
    await delay(leftAt + GRACE_MS / 2 - Date.now())
    expect(host.exit, host.stderr()).toBeNull()
    const { client: back } = await openClient(profile, 'tui-drain-back')
    await expect(back.getHostStatus()).resolves.toMatchObject({
      pid: host.pid,
      lifetime: { phase: 'held', holders: 1 }
    })

    const backLeftAt = Date.now()
    back.close()
    const exit = await waitForExit(host)
    expect(exit.code, host.stderr()).toBe(0)
    expect(exit.at - backLeftAt).toBeGreaterThanOrEqual(GRACE_MS - 300)
    expect(host.stderr()).toContain('[host-lease] exit requested: drained')
    expectProfileReleased(profile)
  }, 90_000)
})

describe.skipIf(IS_WINDOWS)('a lifetime stop past its deadline', () => {
  /**
   * A connection that never says hello and never closes its side holds the
   * listener's client drain for one full drain timeout during the stop; the
   * held drain comes from half-closing a Unix-domain socket.
   */
  async function holdHalfOpen(profile: string): Promise<void> {
    await waitFor(() => existsSync(taskWraithHostDiscoveryPath(profile)), 'discovery')
    const socket = createConnection({
      path: taskWraithHostSocketPath(profile),
      allowHalfOpen: true
    })
    rawSockets.add(socket)
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve)
      socket.once('error', reject)
    })
    socket.on('error', () => undefined)
  }

  /** The pid the profile's discovery names, or null while there is none to read. */
  function discoveryPid(profile: string): number | null {
    try {
      const decoded = decodeTaskWraithHostDiscovery(
        JSON.parse(readFileSync(taskWraithHostDiscoveryPath(profile), 'utf8'))
      )
      return decoded.ok ? decoded.discovery.pid : null
    } catch {
      return null
    }
  }

  it('ends the process at its deadline, keeping the profile authority, and the next Host takes the profile over', async () => {
    const profile = profileDir('late-stop')
    const host = spawnHost(profile, { env: { [HOST_LEASE_TIMING_ENV]: `${TIMING},stop:300` } })
    await holdHalfOpen(profile)
    await waitFor(
      () => host.stderr().includes(`grace ${GRACE_MS}ms, stop deadline 300ms`),
      'the timing line'
    )
    await waitFor(
      () => host.stderr().includes('stopping after the last client lease (idle)'),
      'the lifetime stop',
      10_000
    )
    const stopAt = Date.now()

    const exit = await waitForExit(host)
    expect(exit.code, host.stderr()).toBe(1)
    // At the deadline, not once the held drain (a full second) let the stop finish.
    expect(exit.at - stopAt).toBeGreaterThanOrEqual(200)
    expect(exit.at - stopAt).toBeLessThan(900)
    expect(host.stderr()).toContain(
      'stopping after the last client lease did not finish within 300 ms, profile authority retained'
    )
    // Crash-equivalent: the authority lease and the registry entry name a process that is gone.
    expect(existsSync(taskWraithHostAuthorityLeasePath(profile))).toBe(true)
    expect(readHostRegistryEntry(paths().registry, profile)).toMatchObject({
      kind: 'present',
      entry: { pid: host.pid }
    })

    // The next Host takes the profile over, serves it, and leaves cleanly.
    const next = spawnHost(profile)
    // The stop ended inside the client drain, before discovery was removed, so
    // the dead Host's record can still be on disk: wait for the next Host's own.
    await waitFor(() => discoveryPid(profile) === next.pid, "the next Host's discovery")
    const { client } = await openClient(profile, 'tui-takeover')
    await expect(client.getHostStatus()).resolves.toMatchObject({ pid: next.pid })
    client.close()
    expect((await waitForExit(next)).code, next.stderr()).toBe(0)
    expectProfileReleased(profile)
  }, 60_000)

  it('control: stop: may only shorten the deadline, so the same stop under a longer one is on time', async () => {
    const profile = profileDir('late-stop-ceiling')
    const requested = 999_999_999
    const host = spawnHost(profile, {
      env: { [HOST_LEASE_TIMING_ENV]: `${TIMING},stop:${requested}` }
    })
    await holdHalfOpen(profile)
    await waitFor(() => host.stderr().includes('shortened timing'), 'the timing line')
    expect(host.stderr()).toContain(
      `stop:${requested} ignored, it may only shorten the ${HOST_LIFETIME_STOP_DEADLINE_MS}ms stop deadline`
    )
    expect(host.stderr()).not.toContain(`stop deadline ${requested}ms`)

    const exit = await waitForExit(host)
    expect(exit.code, host.stderr()).toBe(0)
    expect(host.stderr()).toContain('stopping after the last client lease (idle)')
    expect(host.stderr()).not.toContain('did not finish')
    expectProfileReleased(profile)
  }, 60_000)
})

describe('a stderr reader that has gone (S1a review F1)', () => {
  it('leaves the Host running, and it still leaves one grace after its last client', async () => {
    const profile = profileDir('orphaned')
    const host = spawnHost(profile, { detached: true })
    const { client: app } = await openClient(profile, 'tui-epipe-app')

    // The app that spawned it exits: the read end of its stderr pipe goes away,
    // and every lease line after this one is a write with no reader.
    const stderr = host.child!.stderr!
    const readerGone = new Promise((resolve) => stderr.once('close', resolve))
    stderr.destroy()
    await readerGone
    app.close()
    await delay(500)
    expect(host.exit, 'the Host must outlive its stderr reader').toBeNull()

    // Reopened within the grace, it finds its Host.
    const { client: relaunched } = await openClient(profile, 'tui-epipe-relaunched')
    await expect(relaunched.getHostStatus()).resolves.toMatchObject({
      pid: host.pid,
      lifetime: { phase: 'held', holders: 1 }
    })

    const leftAt = Date.now()
    relaunched.close()
    const exit = await waitForExit(host)
    expect(exit.code).toBe(0)
    expect(exit.at - leftAt).toBeGreaterThanOrEqual(GRACE_MS - 300)
    expectProfileReleased(profile)
  }, 60_000)
})

describe('5. restart preserves state', () => {
  it('a Host stopped by verified termination over its socket comes back with a new pid and boot epoch, the same hostId, and its thread', async () => {
    const profile = profileDir('restart')
    const first = spawnHost(profile)
    const { client, welcome } = await openCommandClient(profile)
    const { threadId } = await createThread(client, 'restart')

    const outcome = await terminateHostProcess({
      profilePath: profile,
      registryRoot: paths().registry,
      timings: ANSWERING_HOST_TIMINGS
    })
    client.close()
    expect(outcome).toMatchObject({ kind: 'stopped', pid: first.pid })
    expect(outcome.steps[0]).toBe('socket:stopping')
    expect(outcome.steps.some((step) => step.startsWith('signal:'))).toBe(false)
    expect((await waitForExit(first)).code, first.stderr()).toBe(0)
    expectProfileReleased(profile)

    const second = spawnHost(profile)
    const { client: again, welcome: rewelcome } = await openCommandClient(profile)
    expect(second.pid).not.toBe(first.pid)
    expect(rewelcome.hostId).toBe(welcome.hostId)
    expect(welcome.bootEpoch).toMatch(/^[0-9a-f]{64}$/)
    expect(rewelcome.bootEpoch).toMatch(/^[0-9a-f]{64}$/)
    expect(rewelcome.bootEpoch).not.toBe(welcome.bootEpoch)
    await waitForThread(again, threadId)

    // Control: the hostId is the profile's, not every Host's.
    const otherProfile = profileDir('restart-other')
    const otherHost = spawnHost(otherProfile)
    const { client: other, welcome: otherWelcome } = await openCommandClient(otherProfile)
    expect(otherWelcome.hostId).not.toBe(welcome.hostId)

    again.close()
    other.close()
    expect((await waitForExit(second)).code, second.stderr()).toBe(0)
    expect((await waitForExit(otherHost)).code, otherHost.stderr()).toBe(0)
    expectProfileReleased(profile)
    expectProfileReleased(otherProfile)
  }, 90_000)

  it.skipIf(IS_WINDOWS)(
    'a wedged Host (SIGSTOP) is stopped by the verified TERM/KILL fallback, and the next Host still has its thread',
    async () => {
      const profile = profileDir('wedged')
      const first = spawnHost(profile)
      const { client, welcome } = await openCommandClient(profile)
      const { threadId } = await createThread(client, 'wedged')

      // Wedged, and never continued: the socket stop can only time out.
      await signalStarted(first, 'SIGSTOP')
      const outcome = await terminateHostProcess({
        profilePath: profile,
        registryRoot: paths().registry,
        timings: WEDGED_HOST_TIMINGS
      })
      client.close()
      expect(outcome).toMatchObject({ kind: 'killed', pid: first.pid })
      expect(outcome.steps.slice(0, 4)).toEqual([
        'socket:failed:Host shutdown request timed out',
        'verify:match',
        'signal:SIGTERM',
        'signal:SIGKILL'
      ])
      expect((await waitForExit(first)).signal).toBe('SIGKILL')
      expect([...outcome.swept].sort()).toEqual(
        ['discovery', 'lease', 'registry', 'socket', 'socket-directory', 'token'].sort()
      )
      expectProfileReleased(profile)

      const second = spawnHost(profile)
      const { client: again, welcome: rewelcome } = await openCommandClient(profile)
      expect(second.pid).not.toBe(first.pid)
      expect(rewelcome.hostId).toBe(welcome.hostId)
      expect(rewelcome.bootEpoch).not.toBe(welcome.bootEpoch)
      await waitForThread(again, threadId)
      again.close()
      expect((await waitForExit(second)).code, second.stderr()).toBe(0)
      expectProfileReleased(profile)
    },
    90_000
  )
})

describe('6. legacy Host', () => {
  it('a Host with the lease kinds stubbed out answers them unknown_request_kind, the lease client goes legacy, and nothing times it out', async () => {
    const profile = profileDir('legacy')
    const host = spawnHost(profile, { env: { [HOST_LEASE_DISABLED_ENV]: '1' } })
    const { client } = await openClient(profile, 'tui-legacy')
    await waitFor(
      () =>
        host
          .stderr()
          .includes(
            `${HOST_LEASE_DISABLED_ENV}=1 under ${HOST_LEASE_TIMING_ENV}: answering host.lease and host.status as a pre-lease Host`
          ),
      'the legacy line'
    )

    const lease = new HostLeaseClient({ client })
    const legacy: string[] = []
    lease.on('legacy', () => legacy.push('legacy'))
    await expect(lease.acquire()).resolves.toBe('legacy')
    expect(lease.mode).toBe('legacy')
    expect(legacy).toEqual(['legacy'])
    await expect(client.getHostStatus()).rejects.toMatchObject({ code: 'unknown_request_kind' })
    await expect(client.getHealth()).resolves.toMatchObject({ type: 'host.health' })
    // A pre-registry Host publishes no entry.
    expect(readHostRegistryEntry(paths().registry, profile).kind).toBe('missing')

    // No lease lifetime: alone, it is still serving two graces later.
    lease.dispose()
    client.close()
    await delay(2 * GRACE_MS)
    expect(host.exit, host.stderr()).toBeNull()
    const stop = await runCli(['stop', '--profile', profile])
    expect(stop.status, stop.stderr).toBe(0)
    expect((await waitForExit(host)).code, host.stderr()).toBe(0)
    expectProfileReleased(profile)
  }, 60_000)

  it('control: the switch is ignored without the timing override', async () => {
    const profile = profileDir('legacy-ignored')
    const host = spawnHost(profile, {
      env: { [HOST_LEASE_DISABLED_ENV]: '1' },
      omitEnv: [HOST_LEASE_TIMING_ENV]
    })
    const { client } = await openClient(profile, 'tui-legacy-ignored')
    const lease = new HostLeaseClient({ client })
    await expect(lease.acquire()).resolves.toBe('held')
    expect(lease.mode).toBe('lease')
    await expect(client.getHostStatus()).resolves.toMatchObject({
      lifetime: { phase: 'held', holders: 1, implicitHolders: 0 }
    })
    expect(readHostRegistryEntry(paths().registry, profile).kind).toBe('present')
    expect(host.stderr()).not.toContain('pre-lease Host')

    lease.dispose()
    const stop = await runCli(['stop', '--profile', profile])
    expect(stop.status, stop.stderr).toBe(0)
    expect((await waitForExit(host)).code, host.stderr()).toBe(0)
    expectProfileReleased(profile)
  }, 60_000)
})

/**
 * Last in the file on purpose: the sweep keeps any socket directory changed in
 * the last HOST_REGISTRY_SWEEP_MIN_AGE_MS, and the stale one planted before the
 * build has aged past that by now (run alone, the test waits out the rest).
 */
describe.skipIf(IS_WINDOWS)('4. stop-all --all --sweep over the suite registry only', () => {
  it('stops both Hosts, removes what is stale, keeps what is young, and never reaches the look-alike decoy', async () => {
    const root = paths()
    const profileA = profileDir('stop-all-a')
    const profileB = profileDir('stop-all-b')
    const hostA = spawnHost(profileA)
    const hostB = spawnHost(profileB)
    await startHolder(profileA, 'tui-stop-all-a')
    await startHolder(profileB, 'tui-stop-all-b')
    await waitFor(
      () =>
        readHostRegistryEntry(root.registry, profileA).kind === 'present' &&
        readHostRegistryEntry(root.registry, profileB).kind === 'present',
      'both registry entries'
    )
    // Host A's serve line word for word, in a process this suite started.
    const decoy = startProcess(
      'decoy with the argv of Host A',
      [
        '-e',
        'setInterval(() => undefined, 1000)',
        root.cli,
        'serve',
        '--mode',
        'production',
        '--profile',
        profileA
      ],
      { env: isolatedEnv(), stdio: 'ignore' }
    )
    expect(await decoy.birth).not.toBeNull()
    // An entry left behind by a Host that is gone, under a birth nothing has.
    const ghostProfile = profileDir('stop-all-ghost')
    const gone = startProcess('exited process', ['-e', ''], { env: isolatedEnv(), stdio: 'ignore' })
    await waitForExit(gone)
    publishRegistryEntry(ghostProfile, gone.pid, 'e'.repeat(64))
    // A socket directory changed moments ago: a Host may be starting in it.
    const young = await plantDeadSocketDirectory('young')
    const stale = staleSocketDirectory!
    await delay(stale.plantedAt + HOST_REGISTRY_SWEEP_MIN_AGE_MS + 1_000 - Date.now())

    const run = await runCli(['stop-all', '--all', '--sweep', '--json'])
    expect(run.status, `${run.stdout}${run.stderr}`).toBe(0)
    const report = stopAllReport(run.stdout)

    // Registry-scoped: only this suite's root was read, and the argv scan never ran.
    expect(report).toMatchObject({
      registryRoot: root.registry,
      scope: { kind: 'all' },
      scanArgv: false,
      exitCode: 0
    })
    expect(report.scan).toBeUndefined()
    expect(report.hosts.map((host) => host.source)).toEqual(['registry', 'registry', 'registry'])
    const hosts = byProfile(report)
    expect([...hosts.keys()].sort()).toEqual([profileA, profileB, ghostProfile].sort())
    expect(hosts.get(profileA)).toMatchObject({
      pid: hostA.pid,
      liveness: 'live',
      selected: true,
      outcome: { kind: 'stopped' }
    })
    expect(hosts.get(profileB)).toMatchObject({
      pid: hostB.pid,
      liveness: 'live',
      selected: true,
      outcome: { kind: 'stopped' }
    })
    expect(['already_gone', 'pid_reused']).toContain(hosts.get(ghostProfile)?.outcome?.kind)
    for (const host of report.hosts) {
      expect(host.outcome?.steps.some((step) => step.startsWith('signal:'))).toBe(false)
    }

    expect((await waitForExit(hostA)).code, hostA.stderr()).toBe(0)
    expect((await waitForExit(hostB)).code, hostB.stderr()).toBe(0)
    expectProfileReleased(profileA)
    expectProfileReleased(profileB)
    expect(readHostRegistry(root.registry)).toMatchObject({ entries: [], unreadable: [] })
    expect(report.sweep?.removedSocketDirectories).toContain(stale.name)
    expect(report.sweep?.keptSocketDirectories).toContain(young)
    expect(existsSync(join(root.tmp, stale.name))).toBe(false)
    expect(existsSync(join(root.tmp, young))).toBe(true)
    expect(await isStillRunning(decoy)).toBe(true)
  }, 150_000)

  it('lists an entry hand-edited to record no birth identity, and never signals the process it names', async () => {
    const root = paths()
    const profile = profileDir('stop-all-unverified')
    // Its argv would pass as a Host serving the entry's profile: only the missing
    // birth identity stands between it and a SIGTERM.
    const decoy = startProcess(
      'decoy named by a hand-edited entry',
      [
        '-e',
        'setInterval(() => undefined, 1000)',
        root.cli,
        'serve',
        '--mode',
        'production',
        '--profile',
        profile
      ],
      { env: isolatedEnv(), stdio: 'ignore' }
    )
    expect(await decoy.birth).not.toBeNull()
    publishRegistryEntry(profile, decoy.pid, null)

    const run = await runCli(['stop-all', '--all', '--sweep', '--json'])
    expect(run.status, `${run.stdout}${run.stderr}`).toBe(1)
    const report = stopAllReport(run.stdout)
    expect(report).toMatchObject({ registryRoot: root.registry, scanArgv: false, exitCode: 1 })
    expect(report.scan).toBeUndefined()
    expect(report.hosts).toEqual([
      expect.objectContaining({
        source: 'registry',
        profilePath: profile,
        pid: decoy.pid,
        liveness: 'unverified',
        selected: true,
        outcome: expect.objectContaining({ kind: 'unverifiable' })
      })
    ])
    expect(report.hosts[0].outcome?.steps.some((step) => step.startsWith('signal:'))).toBe(false)
    expect(await isStillRunning(decoy)).toBe(true)
    // Left in place for a human to judge; the sweep removes only what it proves stale.
    expect(readHostRegistryEntry(root.registry, profile).kind).toBe('present')
  }, 90_000)
})
