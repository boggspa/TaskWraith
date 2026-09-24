import { spawn, type ChildProcess } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { HostProfileAuthorityLease } from '../host-runtime/HostProfileAuthorityLease'
import {
  HostRegistryPublisher,
  hostRegistryEntryPath,
  readHostRegistryEntry
} from '../host-runtime/HostRegistry'
import {
  listProcessCommandLines,
  observeProcessBirthIdentity,
  observeProcessCommandLine,
  type ProcessBirthObservation
} from '../host-runtime/ProcessBirthIdentity'
import {
  taskWraithHostAuthorityLeasePath,
  taskWraithHostDiscoveryPath,
  taskWraithHostSocketPath,
  taskWraithHostTokenPath
} from '../shared/taskWraithHostPaths.node'
import { terminateHostProcess, type HostTerminationTimings } from './HostProcessTermination'
import { HostShutdownClient } from './HostShutdownClient'
import { stopAllHosts } from './HostStopAll'

/**
 * Verified termination against real processes. Every process here is a child
 * this suite spawned under a temporary profile, a temporary registry root and
 * a payload directory in the OS temp dir; none is a real Host. Teardown kills a
 * child only while its birth identity still equals the one recorded at spawn,
 * and no argv scan ever sees a process this suite did not start.
 *
 * POSIX only: SIGSTOP/SIGTERM have no Windows equivalent (Windows termination
 * is the `taskkill /T /F` tree kill, covered by the unit suite's port).
 */

const FAST: Partial<HostTerminationTimings> = {
  ackMs: 400,
  drainMs: 400,
  termMs: 1_000,
  killMs: 5_000,
  pollMs: 50,
  exitMs: 400
}

/** A stand-in Host: binds the socket, optionally answers authenticated lifecycle/status requests. */
const FAKE_HOST_SOURCE = `'use strict'
const fs = require('node:fs')
const net = require('node:net')
const path = require('node:path')
const socketPath = process.env.FAKE_HOST_SOCKET
fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 })
try { fs.unlinkSync(socketPath) } catch {}
const startedAt = new Date().toISOString()
const server = net.createServer((socket) => {
  if (process.env.FAKE_HOST_AUTH !== '1') return
  let buffer = ''
  let authenticated = false
  const send = (frame) => socket.write(JSON.stringify({ transportVersion: 1, ...frame }) + '\\n')
  socket.on('data', (chunk) => {
    buffer += String(chunk)
    let newline
    while ((newline = buffer.indexOf('\\n')) >= 0) {
      const frame = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1)
      if (frame.type === 'hello' && frame.token === '7'.repeat(64)) {
        authenticated = true
        send({ type: 'welcome', welcome: {
          type: 'host.welcome', protocolVersion: 2, projectionVersion: 2,
          controlProtocolCompat: 1, hostId: 'fake-host', hostVersion: 'node-host-v1',
          sessionId: 'session-1', generation: 1, cursor: 0, freshness: 'live',
          authenticatedClient: frame.hello.client,
          capabilities: process.env.FAKE_HOST_LEGACY === 'missing-health'
            ? ['bootstrap', 'host-lifecycle'] : ['bootstrap', 'host-lifecycle', 'health']
        } })
      } else if (authenticated && frame.kind === 'host.status') {
        if (process.env.FAKE_HOST_LEGACY === 'unsupported-status') {
          send({ type: 'response', id: frame.id, ok: false, error: { code: 'unknown_request_kind' } })
          continue
        }
        send({ type: 'response', id: frame.id, ok: true, result: { kind: 'host.status', status: {
          pid: process.pid, startedAt, uptimeMs: 0, hostId: 'fake-host',
          profilePath: process.env.FAKE_HOST_PROFILE, persist: true,
          lifetime: { phase: 'held', holders: 1, implicitHolders: 0, declined: 0 },
          liveWork: { runs: 0 }, clients: []
        } } })
      } else if (authenticated && frame.kind === 'host.shutdown') {
        fs.writeFileSync(process.env.FAKE_HOST_SHUTDOWN_RECORD, 'shutdown received\\n')
        send({ type: 'response', id: frame.id, ok: true, result: { kind: 'host.shutdown', state: 'stopping' } })
        setImmediate(() => process.exit(0))
      }
    }
  })
})
if (process.env.FAKE_HOST_TERM === 'ignore') process.on('SIGTERM', () => {})
else process.on('SIGTERM', () => { server.close(); process.exit(0) })
server.listen(socketPath, () => process.stdout.write('ready\\n'))
setInterval(() => {}, 1000)
`

interface Tracked {
  readonly child: ChildProcess
  readonly pid: number
  readonly birth: Extract<ProcessBirthObservation, { state: 'live' }>
  readonly exited: Promise<NodeJS.Signals | number | null>
}

const tracked: Tracked[] = []
const temporary: string[] = []

afterEach(async () => {
  while (tracked.length) {
    const entry = tracked.pop()!
    const now = await observeProcessBirthIdentity(entry.pid)
    if (now.state === 'live' && now.birthIdentity === entry.birth.birthIdentity) {
      // Still the exact child this suite spawned: continue it if stopped, then kill it.
      try {
        process.kill(entry.pid, 'SIGCONT')
        process.kill(entry.pid, 'SIGKILL')
      } catch {
        // Already gone.
      }
    }
    await Promise.race([entry.exited, new Promise((resolve) => setTimeout(resolve, 5_000))])
  }
  while (temporary.length) rmSync(temporary.pop()!, { recursive: true, force: true })
})

function scratch(prefix: string): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  temporary.push(path)
  return path
}

async function track(child: ChildProcess): Promise<Tracked> {
  const exited = new Promise<NodeJS.Signals | number | null>((resolve) => {
    child.once('exit', (code, signal) => resolve(signal ?? code))
  })
  const pid = child.pid
  if (!pid) throw new Error('child did not start')
  const birth = await observeProcessBirthIdentity(pid)
  if (birth.state !== 'live') throw new Error(`child birth unobservable: ${birth.state}`)
  const entry = { child, pid, birth, exited }
  tracked.push(entry)
  return entry
}

function payloadCli(base: string): string {
  const cli = join(base, 'payload', 'host-runtime', 'cli.js')
  mkdirSync(dirname(cli), { recursive: true })
  writeFileSync(cli, FAKE_HOST_SOURCE)
  return cli
}

async function startFakeHost(
  base: string,
  profile: string,
  term: 'exit' | 'ignore',
  authenticated: boolean | 'missing-health' | 'unsupported-status' = false
): Promise<Tracked> {
  const socketPath = taskWraithHostSocketPath(profile)
  temporary.push(dirname(socketPath))
  const child = spawn(
    process.execPath,
    [payloadCli(base), 'serve', '--mode', 'production', '--profile', profile],
    {
      env: {
        ...process.env,
        FAKE_HOST_SOCKET: socketPath,
        FAKE_HOST_TERM: term,
        FAKE_HOST_AUTH: authenticated ? '1' : '0',
        FAKE_HOST_LEGACY: typeof authenticated === 'string' ? authenticated : '',
        FAKE_HOST_PROFILE: profile,
        FAKE_HOST_SHUTDOWN_RECORD: join(base, 'shutdown-observed')
      },
      stdio: ['ignore', 'pipe', 'ignore']
    }
  )
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('fake Host did not bind')), 10_000)
    child.stdout?.on('data', (chunk) => {
      if (String(chunk).includes('ready')) {
        clearTimeout(timer)
        resolve()
      }
    })
    child.once('exit', () => reject(new Error('fake Host exited before binding')))
  })
  return track(child)
}

async function startDecoy(argv: readonly string[]): Promise<Tracked> {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1e3)', ...argv], {
    stdio: 'ignore'
  })
  await new Promise((resolve) => setTimeout(resolve, 150))
  return track(child)
}

/**
 * A lease written on behalf of `process_` the way a pre-birth-identity build
 * wrote it: a nonce, with the process start it recorded (`startOffsetMs` off
 * the real one models a wall-clock step between process start and the lease).
 */
function publishLegacyLease(profile: string, process_: Tracked, startOffsetMs = 0): void {
  HostProfileAuthorityLease.acquire({
    profilePath: profile,
    processPort: {
      current: {
        pid: process_.pid,
        processStartIdentity: `node:${process_.pid}:172d23b8aef73`,
        processStartedAt: new Date(
          (process_.birth.startedAtMs ?? Date.now()) + startOffsetMs
        ).toISOString()
      },
      inspectOwner: () => 'unknown'
    }
  })
}

/**
 * Discovery and token naming `process_`, its listener started `startOffsetMs`
 * after it (before it, when negative: a dead Host's discovery).
 */
function publishDiscovery(profile: string, process_: Tracked, startOffsetMs = 4_000): void {
  writeFileSync(taskWraithHostTokenPath(profile), `${'7'.repeat(64)}\n`, { mode: 0o600 })
  writeFileSync(
    taskWraithHostDiscoveryPath(profile),
    `${JSON.stringify({
      protocolVersion: 2,
      socketPath: taskWraithHostSocketPath(profile),
      tokenPath: taskWraithHostTokenPath(profile),
      pid: process_.pid,
      startedAt: new Date((process_.birth.startedAtMs ?? Date.now()) + startOffsetMs).toISOString(),
      hostId: 'fake-host',
      hostVersion: 'node-host-v1'
    })}\n`,
    { mode: 0o600 }
  )
}

function profileArtefacts(profile: string): {
  readonly lease: boolean
  readonly discovery: boolean
  readonly token: boolean
} {
  return {
    lease: existsSync(taskWraithHostAuthorityLeasePath(profile)),
    discovery: existsSync(taskWraithHostDiscoveryPath(profile)),
    token: existsSync(taskWraithHostTokenPath(profile))
  }
}

/** Whether a contender could take the profile now (released again at once). */
function contenderAcquires(profile: string): boolean {
  try {
    HostProfileAuthorityLease.acquire({ profilePath: profile }).release()
    return true
  } catch {
    return false
  }
}

/** The artefacts a production Host publishes, written on behalf of `process_`. */
function publishArtefacts(
  profile: string,
  root: string,
  process_: Tracked,
  options: { readonly cliPath?: string; readonly registryBirth?: string | null } = {}
): void {
  const startedAt = new Date().toISOString()
  writeFileSync(taskWraithHostTokenPath(profile), `${'7'.repeat(64)}\n`, { mode: 0o600 })
  writeFileSync(
    taskWraithHostDiscoveryPath(profile),
    `${JSON.stringify({
      protocolVersion: 2,
      socketPath: taskWraithHostSocketPath(profile),
      tokenPath: taskWraithHostTokenPath(profile),
      pid: process_.pid,
      startedAt,
      hostId: 'fake-host',
      hostVersion: 'node-host-v1'
    })}\n`,
    { mode: 0o600 }
  )
  HostProfileAuthorityLease.acquire({
    profilePath: profile,
    processPort: {
      current: {
        pid: process_.pid,
        processStartIdentity: process_.birth.birthIdentity,
        processStartedAt: new Date(process_.birth.startedAtMs ?? Date.now()).toISOString()
      },
      inspectOwner: () => 'unknown'
    }
  })
  publishRegistryEntry(profile, root, process_, options)
}

function publishRegistryEntry(
  profile: string,
  root: string,
  process_: Tracked,
  options: { readonly cliPath?: string; readonly registryBirth?: string | null } = {}
): void {
  const birth =
    options.registryBirth === undefined ? process_.birth.birthIdentity : options.registryBirth
  new HostRegistryPublisher({
    root,
    profilePath: profile,
    pid: process_.pid,
    observeSelf: () =>
      birth === null
        ? { state: 'identity_unavailable' }
        : { state: 'live', birthIdentity: birth, startedAtMs: null },
    cliPath: options.cliPath ?? null,
    nodeExecutable: process.execPath
  }).publish({
    profilePath: profile,
    pid: process_.pid,
    startedAt: new Date().toISOString(),
    hostId: 'fake-host',
    persist: false,
    leaseMode: 'lease',
    holders: 1,
    implicitHolders: 0,
    lifetimePhase: 'held'
  })
}

/**
 * `successor` takes the profile over from `dead` the way a starting Host
 * does: it reclaims the dead owner's authority lease, recording its birth as
 * a digest (a current build) or a nonce (a build from before birth identity).
 */
function takeOverProfile(
  profile: string,
  dead: Tracked,
  successor: Tracked,
  build: 'current' | 'legacy'
): void {
  HostProfileAuthorityLease.acquire({
    profilePath: profile,
    processPort: {
      current: {
        pid: successor.pid,
        processStartIdentity:
          build === 'current' ? successor.birth.birthIdentity : `node:${successor.pid}:5e1b`,
        processStartedAt: new Date(successor.birth.startedAtMs ?? Date.now()).toISOString()
      },
      inspectOwner: (owner) => (owner.pid === dead.pid ? 'stale' : 'unknown')
    }
  })
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * The Host command line a refusal's advice describes, read the way an
 * operator reads it: `…` stands for any run of the command line, none at all
 * included, and the rest is literal.
 */
function describedHostCommand(detail: string): RegExp {
  const described = /\(`?([^`()]* serve [^`()]*?)`?\)/.exec(detail)?.[1]
  if (!described) throw new Error(`the advice describes no Host command: ${detail}`)
  const source = described
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/^…/, '.*')
    .replace(/ …$/, '(?: .*)?')
    .replace(/ … /g, ' (?:.* )?')
  return new RegExp(`^${source}$`)
}

/** The pid a record file names now, or null when it names none. */
function recordPid(file: string): number | null {
  try {
    const { pid } = JSON.parse(readFileSync(file, 'utf8')) as { readonly pid?: unknown }
    return typeof pid === 'number' ? pid : null
  } catch {
    return null
  }
}

/**
 * An operator who follows a reused-pid refusal to the letter. Unless pid N
 * runs the Host command the advice describes (no process in this suite is
 * the TaskWraith app), each file it names is removed, only while that file
 * still names pid N when the advice says so, and the stop is run again once
 * any was. The command line observed is only compared, never printed.
 */
async function followRefusalAdvice<T>(
  detail: string,
  stopAgain: () => Promise<T>
): Promise<{ readonly removed: readonly string[]; readonly again: T | null }> {
  const pid = Number(/If pid (\d+) is /.exec(detail)?.[1])
  if (!Number.isSafeInteger(pid)) throw new Error(`the advice names no pid: ${detail}`)
  const command = await observeProcessCommandLine(pid)
  if (command.state === 'live' && describedHostCommand(detail).test(command.commandLine)) {
    return { removed: [], again: null }
  }
  const whileNaming = detail.includes(`still names pid ${pid}`)
  const named = [
    ...detail.matchAll(/the (?:registry entry|authority lease|discovery) (\/\S+?)(?=\.? )/g)
  ].map((match) => match[1])
  if (!named.length) throw new Error(`the advice names no file: ${detail}`)
  const removed = named.filter((file) => !whileNaming || recordPid(file) === pid)
  for (const file of removed) rmSync(file)
  return { removed, again: removed.length ? await stopAgain() : null }
}

describe.skipIf(process.platform === 'win32')('verified termination against real processes', () => {
  it.each(['lease-only', 'all records'] as const)(
    'N1: skips shutdown and cleans a dead Host with %s without a drain wait',
    async (records) => {
      const base = scratch('host-dead-fast-')
      const profile = scratch('host-dead-fast-profile-')
      const root = join(base, 'hosts')
      const host = await startFakeHost(base, profile, 'ignore')
      publishArtefacts(profile, root, host)
      process.kill(host.pid, 'SIGKILL')
      await host.exited
      if (records === 'lease-only') {
        rmSync(taskWraithHostDiscoveryPath(profile))
        rmSync(taskWraithHostTokenPath(profile))
        rmSync(hostRegistryEntryPath(root, profile))
      }
      expect(existsSync(taskWraithHostAuthorityLeasePath(profile))).toBe(true)
      const operations: string[] = []
      const outcome = await terminateHostProcess({
        profilePath: profile,
        registryRoot: root,
        ports: {
          shutdown: async () => {
            operations.push('shutdown')
            throw new Error('a dead Host must not enter the socket drain')
          },
          signal: () => {
            operations.push('signal')
          },
          delay: async () => {
            operations.push('delay')
          }
        }
      })
      expect(outcome).toMatchObject({ kind: 'already_gone', pid: host.pid })
      expect(outcome.steps[0]).toBe('observe:dead')
      expect(operations).toEqual([])
      expect(outcome.swept).toEqual([
        ...(records === 'all records' ? ['registry', 'discovery', 'token'] : []),
        'lease',
        'socket',
        'socket-directory'
      ])
      expect(profileArtefacts(profile)).toEqual({ lease: false, discovery: false, token: false })
      expect(readHostRegistryEntry(root, profile).kind).toBe('missing')
      expect(existsSync(dirname(taskWraithHostSocketPath(profile)))).toBe(false)
    },
    30_000
  )

  it('N1: a successor that takes the profile during the dead-pid observation keeps its socket and every record', async () => {
    const base = scratch('host-dead-swap-a-')
    const other = scratch('host-dead-swap-b-')
    const profile = scratch('host-dead-swap-profile-')
    const root = join(base, 'hosts')
    const hostA = await startFakeHost(base, profile, 'ignore')
    publishArtefacts(profile, root, hostA)
    process.kill(hostA.pid, 'SIGKILL')
    await hostA.exited
    let hostB: Tracked | undefined
    const operations: string[] = []
    const outcome = await terminateHostProcess({
      profilePath: profile,
      registryRoot: root,
      timings: FAST,
      ports: {
        observe: async (pid) => {
          const observed = await observeProcessBirthIdentity(pid)
          if (!hostB && pid === hostA.pid && observed.state === 'dead') {
            hostB = await startFakeHost(other, profile, 'exit', true)
            takeOverProfile(profile, hostA, hostB, 'current')
            publishDiscovery(profile, hostB)
            publishRegistryEntry(profile, root, hostB)
          }
          return observed
        },
        shutdown: async (selectedProfile, budgets, expected) => {
          operations.push('shutdown')
          return new HostShutdownClient({
            profilePath: selectedProfile,
            expected,
            timeoutMs: budgets.ackMs,
            removalTimeoutMs: budgets.drainMs
          }).shutdown()
        },
        signal: () => {
          operations.push('signal')
        }
      }
    })
    expect(hostB).toBeDefined()
    expect(outcome).toEqual({
      kind: 'already_gone',
      pid: hostA.pid,
      steps: ['observe:dead'],
      swept: []
    })
    expect(operations).toEqual([])
    expect(alive(hostB!.pid)).toBe(true)
    expect(existsSync(join(other, 'shutdown-observed'))).toBe(false)
    expect(profileArtefacts(profile)).toEqual({ lease: true, discovery: true, token: true })
    expect(recordPid(taskWraithHostDiscoveryPath(profile))).toBe(hostB!.pid)
    expect(recordPid(taskWraithHostAuthorityLeasePath(profile))).toBe(hostB!.pid)
    expect(recordPid(hostRegistryEntryPath(root, profile))).toBe(hostB!.pid)
    expect(existsSync(taskWraithHostSocketPath(profile))).toBe(true)
    expect(contenderAcquires(profile)).toBe(false)
  }, 30_000)

  it('kills a wedged Host: the ack times out, birth and argv are verified, TERM is ignored, KILL lands, artefacts are swept', async () => {
    const base = scratch('host-termination-sub-')
    const profile = scratch('host-termination-profile-')
    const root = join(base, 'hosts')
    const host = await startFakeHost(base, profile, 'ignore')
    publishArtefacts(profile, root, host)
    process.kill(host.pid, 'SIGSTOP')

    const outcome = await terminateHostProcess({
      profilePath: profile,
      registryRoot: root,
      timings: FAST
    })

    expect(outcome.kind).toBe('killed')
    expect(outcome.steps.slice(0, 4)).toEqual([
      'socket:failed:Host shutdown request timed out',
      'verify:match',
      'signal:SIGTERM',
      'signal:SIGKILL'
    ])
    await expect(host.exited).resolves.toBe('SIGKILL')
    expect(outcome.swept).toEqual([
      'registry',
      'discovery',
      'token',
      'lease',
      'socket',
      'socket-directory'
    ])
    expect(existsSync(taskWraithHostDiscoveryPath(profile))).toBe(false)
    expect(existsSync(taskWraithHostTokenPath(profile))).toBe(false)
    expect(existsSync(taskWraithHostAuthorityLeasePath(profile))).toBe(false)
    expect(existsSync(dirname(taskWraithHostSocketPath(profile)))).toBe(false)
    expect(readHostRegistryEntry(root, profile).kind).toBe('missing')
  }, 30_000)

  it('stops at SIGTERM when the Host honours it', async () => {
    const base = scratch('host-termination-sub-')
    const profile = scratch('host-termination-profile-')
    const root = join(base, 'hosts')
    const host = await startFakeHost(base, profile, 'exit')
    publishArtefacts(profile, root, host)

    const outcome = await terminateHostProcess({
      profilePath: profile,
      registryRoot: root,
      timings: FAST
    })

    expect(outcome.kind).toBe('terminated')
    expect(outcome.steps).toContain('signal:SIGTERM')
    expect(outcome.steps).not.toContain('signal:SIGKILL')
    await expect(host.exited).resolves.toBe(0)
  }, 30_000)

  it('never signals a live process whose argv is not a Host for the profile, even with its exact birth', async () => {
    const base = scratch('host-termination-sub-')
    const profile = scratch('host-termination-profile-')
    const root = join(base, 'hosts')
    // Every artefact names this process with its real birth (the in-process
    // lane records Electron main this way), but it is not a Host serve.
    const bystander = await startDecoy([])
    publishArtefacts(profile, root, bystander)

    const outcome = await terminateHostProcess({
      profilePath: profile,
      registryRoot: root,
      timings: FAST
    })

    expect(outcome.kind).toBe('not_a_host')
    expect(outcome.steps).not.toContain('signal:SIGTERM')
    expect(alive(bystander.pid)).toBe(true)
    expect(existsSync(taskWraithHostAuthorityLeasePath(profile))).toBe(true)
    expect(existsSync(hostRegistryEntryPath(root, profile))).toBe(true)
  }, 30_000)

  it('stop-all stops only verified Hosts: look-alike decoys and an unverifiable entry survive', async () => {
    const base = scratch('host-stop-all-sub-')
    const root = join(base, 'hosts')
    const cli = payloadCli(base)
    const payloadRoot = dirname(dirname(cli))

    const hostProfile = scratch('host-stop-all-host-')
    const host = await startFakeHost(base, hostProfile, 'exit')
    publishArtefacts(hostProfile, root, host, { cliPath: cli })

    // A decoy whose argv mimics a Host for its profile and whose registry
    // entry was hand-edited to another birth: a reused pid, never signalled.
    const reusedProfile = scratch('host-stop-all-reused-')
    const reused = await startDecoy([cli, 'serve', '--profile', reusedProfile])
    publishRegistryEntry(reusedProfile, root, reused, {
      cliPath: cli,
      registryBirth: 'd'.repeat(64)
    })

    // A look-alike with no artefacts at all: the argv scan lists it unverified.
    const unregisteredProfile = scratch('host-stop-all-unregistered-')
    const unregistered = await startDecoy([cli, 'serve', '--profile', unregisteredProfile])

    // An entry that recorded no birth and has no lease to fall back on.
    const blindProfile = scratch('host-stop-all-blind-')
    const blind = await startDecoy([cli, 'serve', '--profile', blindProfile])
    publishRegistryEntry(blindProfile, root, blind, { cliPath: cli, registryBirth: null })

    const ours = new Set([host.pid, reused.pid, unregistered.pid, blind.pid])
    const report = await stopAllHosts({
      scope: { kind: 'payload-root', payloadRoot },
      scanArgv: true,
      registryRoot: root,
      ports: {
        // The real ps table, narrowed to this suite's own children.
        listProcesses: async () => {
          const listing = await listProcessCommandLines()
          return listing.ok
            ? { ok: true, processes: listing.processes.filter((entry) => ours.has(entry.pid)) }
            : listing
        },
        terminate: (input) => terminateHostProcess({ ...input, timings: FAST })
      }
    })

    const byProfile = new Map(report.hosts.map((entry) => [entry.profilePath, entry]))
    expect(byProfile.get(hostProfile)?.outcome?.kind).toBe('terminated')
    expect(byProfile.get(reusedProfile)).toMatchObject({
      liveness: 'pid_reused',
      outcome: { kind: 'pid_reused' }
    })
    expect(byProfile.get(unregisteredProfile)).toMatchObject({
      source: 'argv',
      liveness: 'unverified',
      selected: false
    })
    expect(byProfile.get(blindProfile)).toMatchObject({
      liveness: 'unverified',
      outcome: { kind: 'unverifiable' }
    })
    expect(report.exitCode).toBe(1)

    await expect(host.exited).resolves.toBe(0)
    expect(alive(reused.pid)).toBe(true)
    expect(alive(unregistered.pid)).toBe(true)
    expect(alive(blind.pid)).toBe(true)
    // The reused-pid entry was swept; the unverifiable one stays for a human.
    expect(readHostRegistryEntry(root, reusedProfile).kind).toBe('missing')
    expect(readHostRegistryEntry(root, blindProfile).kind).toBe('present')
  }, 60_000)
})

/**
 * Review note 12 and its residual: a registry entry left by a crashed Host
 * whose pid now belongs to a live owner of the profile lease. Every record is
 * judged by its own birth, the owner is never signalled unless it is a Host
 * serving this profile, and no record it could own is ever swept.
 */
describe.skipIf(process.platform === 'win32')(
  'verified termination with stale registry evidence',
  () => {
    it('N12-a/b: a stale registry entry (dead pid, or another birth for the owner pid) never costs a non-Host owner its artefacts', async () => {
      const base = scratch('host-termination-n12ab-')
      const root = join(base, 'hosts')
      const gone = await startDecoy([])
      process.kill(gone.pid, 'SIGKILL')
      await gone.exited
      for (const staleEntry of ['dead-pid', 'other-birth'] as const) {
        const profile = scratch(`host-termination-n12-${staleEntry}-`)
        const owner = await startDecoy([])
        publishDiscovery(profile, owner)
        HostProfileAuthorityLease.acquire({
          profilePath: profile,
          processPort: {
            current: {
              pid: owner.pid,
              processStartIdentity: owner.birth.birthIdentity,
              processStartedAt: new Date(owner.birth.startedAtMs ?? Date.now()).toISOString()
            },
            inspectOwner: () => 'unknown'
          }
        })
        if (staleEntry === 'dead-pid') publishRegistryEntry(profile, root, gone)
        else publishRegistryEntry(profile, root, owner, { registryBirth: 'c'.repeat(64) })

        const outcome = await terminateHostProcess({
          profilePath: profile,
          registryRoot: root,
          timings: FAST
        })

        expect(outcome.kind).toBe('not_a_host')
        expect(outcome.steps[0]).toBe('evidence:stale-registry')
        expect(outcome.steps.some((step) => step.startsWith('signal:'))).toBe(false)
        expect(alive(owner.pid)).toBe(true)
        expect(profileArtefacts(profile)).toEqual({ lease: true, discovery: true, token: true })
      }
    }, 30_000)

    it('N12-c: a live legacy-lease owner beside a stale registry digest on its pid keeps every artefact', async () => {
      const base = scratch('host-termination-n12c-')
      const root = join(base, 'hosts')
      for (const withDiscovery of [false, true]) {
        const profile = scratch(`host-termination-n12c-${withDiscovery ? 'discovery' : 'lease'}-`)
        // An Electron-main stand-in: not a Host, holding a pre-birth-identity lease.
        const owner = await startDecoy([])
        publishLegacyLease(profile, owner)
        if (withDiscovery) publishDiscovery(profile, owner)
        publishRegistryEntry(profile, root, owner, { registryBirth: 'c'.repeat(64) })
        const before = profileArtefacts(profile)

        const outcome = await terminateHostProcess({
          profilePath: profile,
          registryRoot: root,
          timings: FAST
        })

        expect(outcome.kind).toBe('not_a_host')
        expect(outcome.steps[0]).toBe('evidence:stale-registry')
        expect(outcome.steps.some((step) => step.startsWith('signal:'))).toBe(false)
        expect(outcome.swept).toEqual([])
        expect(alive(owner.pid)).toBe(true)
        expect(profileArtefacts(profile)).toEqual(before)
        // The owner still holds the profile: no contender can take it while it lives.
        expect(contenderAcquires(profile)).toBe(false)
      }
    }, 30_000)

    it('N12-d: a wedged legacy Host is verified by its lease start and stopped, with or without a stale registry digest', async () => {
      const base = scratch('host-termination-n12d-')
      const root = join(base, 'hosts')
      for (const staleEntry of [false, true]) {
        const profile = scratch(`host-termination-n12d-${staleEntry ? 'stale' : 'clean'}-`)
        const host = await startFakeHost(base, profile, 'exit')
        publishLegacyLease(profile, host)
        publishDiscovery(profile, host)
        if (staleEntry) publishRegistryEntry(profile, root, host, { registryBirth: 'c'.repeat(64) })
        process.kill(host.pid, 'SIGSTOP')

        const outcome = await terminateHostProcess({
          profilePath: profile,
          registryRoot: root,
          timings: FAST
        })

        expect(outcome.kind).toBe('killed')
        expect(outcome.steps).toContain('verify:match')
        await expect(host.exited).resolves.toBe('SIGKILL')
        expect(profileArtefacts(profile)).toEqual({ lease: false, discovery: false, token: false })
        expect(readHostRegistryEntry(root, profile).kind).toBe('missing')
      }
    }, 60_000)

    it('N12-d via stop-all --profile: exit 0 only once the wedged legacy Host is gone, never with it running leaseless', async () => {
      const base = scratch('host-termination-n12dcli-')
      const root = join(base, 'hosts')
      const profile = scratch('host-termination-n12dcli-profile-')
      const host = await startFakeHost(base, profile, 'exit')
      publishLegacyLease(profile, host)
      publishDiscovery(profile, host)
      publishRegistryEntry(profile, root, host, { registryBirth: 'c'.repeat(64) })
      process.kill(host.pid, 'SIGSTOP')

      const report = await stopAllHosts({
        scope: { kind: 'profile', profilePath: profile },
        registryRoot: root,
        ports: { terminate: (input) => terminateHostProcess({ ...input, timings: FAST }) }
      })

      expect(report.exitCode).toBe(0)
      expect(report.hosts).toMatchObject([
        { pid: host.pid, selected: true, outcome: { kind: 'killed' } }
      ])
      await expect(host.exited).resolves.toBe('SIGKILL')
      expect(profileArtefacts(profile).lease).toBe(false)
    }, 60_000)

    it('C1: a live legacy Host whose lease records a start 3 s off is refused as inconsistent: never signalled, nothing swept', async () => {
      const base = scratch('host-termination-c1-')
      const root = join(base, 'hosts')
      const profile = scratch('host-termination-c1-profile-')
      const host = await startFakeHost(base, profile, 'exit')
      // The discovery (written 4 s after the process started) names the live
      // Host; only the lease, taken after a wall-clock step, reads as another birth.
      publishLegacyLease(profile, host, 3_000)
      publishDiscovery(profile, host)

      const outcome = await terminateHostProcess({
        profilePath: profile,
        registryRoot: root,
        timings: FAST
      })

      expect(outcome).toMatchObject({ kind: 'inconsistent', pid: host.pid, swept: [] })
      expect(outcome.steps).toEqual([
        'socket:failed:Host shutdown request timed out',
        'verify:mismatch',
        'evidence:inconsistent'
      ])

      // E1: the advice describes a Host the way this one's command line reads,
      // so an operator who follows it leaves the Host and its records alone.
      // Removing the discovery and stopping again would read the lease alone
      // as a reused pid and sweep it from under the running Host.
      const followed = await followRefusalAdvice(outcome.detail ?? '', () =>
        terminateHostProcess({ profilePath: profile, registryRoot: root, timings: FAST })
      )
      expect(alive(host.pid)).toBe(true)
      expect(profileArtefacts(profile)).toEqual({ lease: true, discovery: true, token: true })
      // Still the profile's owner: no contender takes the lease from it.
      expect(contenderAcquires(profile)).toBe(false)
      expect(followed).toEqual({ removed: [], again: null })
      expect(outcome.detail).toBe(
        'a record naming the pid is not contradicted by the process now at it: the discovery ' +
          `${taskWraithHostDiscoveryPath(profile)}. If pid ${host.pid} is not a TaskWraith Host ` +
          `serving this profile (\`…/host-runtime/cli.js serve … --profile ${profile} …\`) or ` +
          `the TaskWraith app, and that file still names pid ${host.pid}, remove it and run ` +
          'stop-all again'
      )
    }, 30_000)

    it('D1: stop-all --profile refuses a reused pid beside a registry entry without a birth while that process lives, and clears once the file it names is removed', async () => {
      const base = scratch('host-termination-d1-')
      const root = join(base, 'hosts')
      const profile = scratch('host-termination-d1-profile-')
      // A Host died uncleanly and a long-lived process that is no Host took its
      // pid. Its lease and discovery predate that process; its registry entry
      // recorded no birth, so only that process's exit could prove it stale.
      const decoy = await startDecoy([])
      publishLegacyLease(profile, decoy, -60_000)
      publishDiscovery(profile, decoy, -60_000)
      publishRegistryEntry(profile, root, decoy, { registryBirth: null })
      const entryPath = hostRegistryEntryPath(root, profile)
      const lines: string[] = []
      const stop = () =>
        stopAllHosts({
          scope: { kind: 'profile', profilePath: profile },
          registryRoot: root,
          ports: {
            terminate: (input) =>
              terminateHostProcess({
                ...input,
                timings: FAST,
                ports: { log: (line) => lines.push(line) }
              })
          }
        })

      const refusal =
        'a record naming the pid is not contradicted by the process now at it: the registry ' +
        `entry ${entryPath}. If pid ${decoy.pid} is not a TaskWraith Host serving this profile ` +
        `(\`…/host-runtime/cli.js serve … --profile ${profile} …\`) or the TaskWraith app, and ` +
        `that file still names pid ${decoy.pid}, remove it and run stop-all again`
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const report = await stop()
        expect(report.exitCode).toBe(1)
        expect(report.hosts).toMatchObject([
          { pid: decoy.pid, outcome: { kind: 'inconsistent', swept: [], detail: refusal } }
        ])
        expect(lines.at(-1)).toContain(`inconsistent (${refusal}) after`)
        expect(alive(decoy.pid)).toBe(true)
        expect(existsSync(entryPath)).toBe(true)
        expect(profileArtefacts(profile)).toEqual({ lease: true, discovery: true, token: true })
        // The nonce lease is held while its pid lives: the profile stays blocked.
        expect(contenderAcquires(profile)).toBe(false)
      }

      // An operator following the advice finds that the pid runs no Host and
      // that the entry still names it, removes the entry and stops again.
      const followed = await followRefusalAdvice(refusal, stop)
      expect(followed.removed).toEqual([entryPath])
      const cleared = followed.again
      expect(cleared?.exitCode).toBe(0)
      expect(cleared?.hosts).toMatchObject([
        { pid: decoy.pid, outcome: { kind: 'pid_reused', swept: ['discovery', 'token', 'lease'] } }
      ])
      expect(alive(decoy.pid)).toBe(true)
      expect(profileArtefacts(profile)).toEqual({ lease: false, discovery: false, token: false })
      expect(contenderAcquires(profile)).toBe(true)
    }, 60_000)

    it('E1: a refusal that has gone stale never leads an operator to remove a record that now names another pid', async () => {
      const base = scratch('host-termination-e1-')
      for (const survivors of ['entry', 'entry and discovery'] as const) {
        const variant = survivors === 'entry' ? 'one' : 'two'
        const root = join(base, `hosts-${variant}`)
        const profile = scratch(`host-termination-e1-${variant}-`)
        // As in D1, but the Host that died was a current build: the process
        // now at its pid contradicts the birth digest in its lease, so a Host
        // that starts for the profile may reclaim it. A discovery written
        // after that process started is not contradicted either.
        const decoy = await startDecoy([])
        HostProfileAuthorityLease.acquire({
          profilePath: profile,
          processPort: {
            current: {
              pid: decoy.pid,
              processStartIdentity: 'c'.repeat(64),
              processStartedAt: new Date(
                (decoy.birth.startedAtMs ?? Date.now()) - 60_000
              ).toISOString()
            },
            inspectOwner: () => 'unknown'
          }
        })
        publishDiscovery(profile, decoy, survivors === 'entry' ? -60_000 : 4_000)
        publishRegistryEntry(profile, root, decoy, { registryBirth: null })
        const named =
          `the registry entry ${hostRegistryEntryPath(root, profile)}` +
          (survivors === 'entry'
            ? ''
            : ` and the discovery ${taskWraithHostDiscoveryPath(profile)}`)
        const stop = () =>
          stopAllHosts({
            scope: { kind: 'profile', profilePath: profile },
            registryRoot: root,
            ports: { terminate: (input) => terminateHostProcess({ ...input, timings: FAST }) }
          })

        const refused = await stop()
        expect(refused.exitCode).toBe(1)
        expect(refused.hosts).toMatchObject([
          { pid: decoy.pid, outcome: { kind: 'inconsistent', swept: [] } }
        ])
        const advice = refused.hosts[0]?.outcome?.detail ?? ''
        expect(advice).toContain(`: ${named}. If pid ${decoy.pid} is `)

        // Before the operator acts on it, a Host starts for the profile: it
        // reclaims the lease and rewrites the same discovery and registry entry.
        const successor = await startFakeHost(base, profile, 'exit')
        takeOverProfile(profile, decoy, successor, 'current')
        publishDiscovery(profile, successor)
        publishRegistryEntry(profile, root, successor)

        const followed = await followRefusalAdvice(advice, stop)
        expect(readHostRegistryEntry(root, profile)).toMatchObject({
          kind: 'present',
          entry: { pid: successor.pid }
        })
        expect(recordPid(taskWraithHostDiscoveryPath(profile))).toBe(successor.pid)
        expect(alive(successor.pid)).toBe(true)
        expect(profileArtefacts(profile)).toEqual({ lease: true, discovery: true, token: true })
        expect(contenderAcquires(profile)).toBe(false)
        expect(followed).toEqual({ removed: [], again: null })
      }
    }, 30_000)

    it("N12-e/i: a registry entry naming another profile's Host is refused, and a legacy lease beside the Host's own digest is stopped", async () => {
      const base = scratch('host-termination-n12ei-')
      const root = join(base, 'hosts')
      // e: profile X's registry (alone, then with a legacy X lease) names the live Host of Y.
      const profileY = scratch('host-termination-n12e-y-')
      const hostY = await startFakeHost(base, profileY, 'exit')
      publishArtefacts(profileY, root, hostY)
      for (const withLegacyLease of [false, true]) {
        const profileX = scratch('host-termination-n12e-x-')
        publishRegistryEntry(profileX, root, hostY)
        if (withLegacyLease) publishLegacyLease(profileX, hostY)
        const outcome = await terminateHostProcess({
          profilePath: profileX,
          registryRoot: root,
          timings: FAST
        })
        expect(outcome.kind).toBe('not_a_host')
        expect(outcome.steps.some((step) => step.startsWith('signal:'))).toBe(false)
      }
      expect(alive(hostY.pid)).toBe(true)
      expect(profileArtefacts(profileY)).toEqual({ lease: true, discovery: true, token: true })
      expect(readHostRegistryEntry(root, profileY).kind).toBe('present')

      // i: the control: the Host's own registry digest beside its legacy lease.
      const profile = scratch('host-termination-n12i-')
      const host = await startFakeHost(base, profile, 'exit')
      publishLegacyLease(profile, host)
      publishDiscovery(profile, host)
      publishRegistryEntry(profile, root, host)
      const outcome = await terminateHostProcess({
        profilePath: profile,
        registryRoot: root,
        timings: FAST
      })
      expect(outcome.kind).toBe('terminated')
      expect(outcome.steps.some((step) => step.startsWith('evidence:stale'))).toBe(false)
      await expect(host.exited).resolves.toBe(0)
      expect(profileArtefacts(profile)).toEqual({ lease: false, discovery: false, token: false })
      expect(readHostRegistryEntry(root, profile).kind).toBe('missing')
    }, 60_000)
  }
)

/**
 * S1b: `--payload-root` selects registry entries by the CLI they recorded,
 * and each entry names one Host by pid and birth. Termination by profile acts
 * on whichever Host holds the profile now, so a selected entry whose Host has
 * gone must never reach another Host that took the profile over.
 */
describe.skipIf(process.platform === 'win32')(
  'stop-all --payload-root acts only on the Host each selected entry names',
  () => {
    it.each(['missing-health', 'unsupported-status'] as const)(
      'terminates the verified expected legacy Host with %s without sending socket shutdown',
      async (legacy) => {
        const base = scratch('host-socket-legacy-')
        const profile = scratch('host-socket-legacy-profile-')
        const root = join(base, 'hosts')
        const host = await startFakeHost(base, profile, 'exit', legacy)
        publishArtefacts(profile, root, host)
        const signals: Array<{ pid: number; signal: string }> = []
        const outcome = await terminateHostProcess({
          profilePath: profile,
          registryRoot: root,
          expected: { pid: host.pid, birthIdentity: host.birth.birthIdentity },
          timings: { ...FAST, ackMs: 5_000 },
          ports: {
            signal: (pid, signal) => {
              signals.push({ pid, signal })
              process.kill(pid, signal)
            }
          }
        })
        expect(outcome).toMatchObject({ kind: 'terminated', pid: host.pid })
        expect(signals).toEqual([{ pid: host.pid, signal: 'SIGTERM' }])
        expect(outcome.steps).toContain('verify:match')
        expect(existsSync(join(base, 'shutdown-observed'))).toBe(false)
        expect(alive(host.pid)).toBe(false)
      },
      30_000
    )

    it.each(['missing-health', 'unsupported-status'] as const)(
      'leaves a legacy successor with %s untouched when it replaces A before connection',
      async (legacy) => {
        const base = scratch('host-socket-legacy-a-')
        const other = scratch('host-socket-legacy-b-')
        const profile = scratch('host-socket-legacy-swap-')
        const root = join(base, 'hosts')
        const hostA = await startFakeHost(base, profile, 'exit', true)
        publishArtefacts(profile, root, hostA)
        let hostB: Tracked | undefined
        const signals: number[] = []
        const outcome = await terminateHostProcess({
          profilePath: profile,
          registryRoot: root,
          expected: { pid: hostA.pid, birthIdentity: hostA.birth.birthIdentity },
          timings: { ...FAST, ackMs: 5_000 },
          ports: {
            shutdown: async (selectedProfile, budgets, expected) => {
              process.kill(hostA.pid, 'SIGKILL')
              await hostA.exited
              hostB = await startFakeHost(other, profile, 'exit', legacy)
              takeOverProfile(profile, hostA, hostB, 'legacy')
              publishDiscovery(profile, hostB)
              return new HostShutdownClient({
                profilePath: selectedProfile,
                expected,
                timeoutMs: budgets.ackMs,
                removalTimeoutMs: budgets.drainMs
              }).shutdown()
            },
            signal: (pid) => {
              signals.push(pid)
            }
          }
        })
        expect(hostB).toBeDefined()
        expect(outcome).toMatchObject({ kind: 'already_gone', pid: hostA.pid })
        expect(signals).toEqual([])
        expect(alive(hostB!.pid)).toBe(true)
        expect(existsSync(join(other, 'shutdown-observed'))).toBe(false)
        expect(profileArtefacts(profile)).toEqual({ lease: true, discovery: true, token: true })
        expect(recordPid(taskWraithHostDiscoveryPath(profile))).toBe(hostB!.pid)
        expect(recordPid(taskWraithHostAuthorityLeasePath(profile))).toBe(hostB!.pid)
        expect(contenderAcquires(profile)).toBe(false)
      },
      30_000
    )

    it('refuses the actual successor socket when Host A is swapped for B after the initial expected observation', async () => {
      const base = scratch('host-socket-fence-a-')
      const other = scratch('host-socket-fence-b-')
      const profile = scratch('host-socket-fence-profile-')
      const root = join(base, 'hosts')
      const hostA = await startFakeHost(base, profile, 'exit', true)
      publishArtefacts(profile, root, hostA)
      let hostB: Tracked | undefined
      const signals: number[] = []
      const expected = { pid: hostA.pid, birthIdentity: hostA.birth.birthIdentity }
      const outcome = await terminateHostProcess({
        profilePath: profile,
        registryRoot: root,
        expected,
        timings: { ...FAST, ackMs: 5_000 },
        ports: {
          shutdown: async (selectedProfile, budgets, selected) => {
            expect(selected).toEqual(expected)
            process.kill(hostA.pid, 'SIGKILL')
            await hostA.exited
            hostB = await startFakeHost(other, profile, 'exit', true)
            takeOverProfile(profile, hostA, hostB, 'current')
            publishDiscovery(profile, hostB)
            return new HostShutdownClient({
              profilePath: selectedProfile,
              expected: selected,
              timeoutMs: budgets.ackMs,
              removalTimeoutMs: budgets.drainMs
            }).shutdown()
          },
          signal: (pid) => {
            signals.push(pid)
          }
        }
      })
      expect(hostB).toBeDefined()
      expect(outcome).toMatchObject({
        kind: 'inconsistent',
        pid: hostA.pid,
        heldBy: hostB!.pid,
        swept: []
      })
      expect(outcome.steps[0]).toBe('expected:match')
      expect(signals).toEqual([])
      expect(alive(hostB!.pid)).toBe(true)
      expect(existsSync(join(other, 'shutdown-observed'))).toBe(false)
      expect(profileArtefacts(profile)).toEqual({ lease: true, discovery: true, token: true })
      expect(recordPid(taskWraithHostDiscoveryPath(profile))).toBe(hostB!.pid)
      expect(recordPid(taskWraithHostAuthorityLeasePath(profile))).toBe(hostB!.pid)
      expect(contenderAcquires(profile)).toBe(false)
    }, 30_000)

    it('S1b: a dead entry whose profile another Host now holds is swept, and that Host keeps running with its lease, discovery and token', async () => {
      const base = scratch('host-stop-all-s1b-')
      const root = join(base, 'hosts')
      const cli = payloadCli(base)
      const payloadRoot = dirname(dirname(cli))
      for (const build of ['current', 'legacy'] as const) {
        const profile = scratch(`host-stop-all-s1b-${build}-`)
        // Host A, served from the selected payload root, published its entry and died.
        const hostA = await startFakeHost(base, profile, 'exit')
        publishArtefacts(profile, root, hostA, { cliPath: cli })
        process.kill(hostA.pid, 'SIGKILL')
        await hostA.exited
        // Host B, from another payload root, took the profile over and published
        // no entry (its registry write failed, or it predates the registry).
        const hostB = await startFakeHost(scratch('host-stop-all-s1b-other-'), profile, 'exit')
        takeOverProfile(profile, hostA, hostB, build)
        publishDiscovery(profile, hostB)

        const report = await stopAllHosts({
          scope: { kind: 'payload-root', payloadRoot },
          registryRoot: root,
          sweep: true,
          ports: { terminate: (input) => terminateHostProcess({ ...input, timings: FAST }) }
        })

        expect({
          hostB: alive(hostB.pid) ? 'running' : 'stopped',
          artefacts: profileArtefacts(profile),
          socket: existsSync(taskWraithHostSocketPath(profile)),
          outcome: report.hosts.map((host) => [host.pid, host.outcome?.kind, host.outcome?.pid])
        }).toEqual({
          hostB: 'running',
          artefacts: { lease: true, discovery: true, token: true },
          socket: true,
          outcome: [[hostA.pid, 'already_gone', hostA.pid]]
        })
        expect(report.exitCode).toBe(0)
        expect(report.hosts).toMatchObject([
          {
            pid: hostA.pid,
            liveness: 'dead',
            selected: true,
            outcome: { heldBy: hostB.pid, swept: ['registry'] },
            note: `another Host (pid ${hostB.pid}) holds the profile now, outside this scope`
          }
        ])
        expect(report.hosts[0]?.outcome?.steps.some((step) => step.startsWith('signal:'))).toBe(
          false
        )
        // B still owns the profile, and only A's own entry is gone.
        expect(contenderAcquires(profile)).toBe(false)
        expect(readHostRegistryEntry(root, profile).kind).toBe('missing')
      }
    }, 60_000)

    it('S1b race: a Host running when listed but replaced before its stop is refused (exit 1), and the new Host keeps running', async () => {
      const base = scratch('host-stop-all-s1b-race-')
      const root = join(base, 'hosts')
      const cli = payloadCli(base)
      const payloadRoot = dirname(dirname(cli))
      const profile = scratch('host-stop-all-s1b-race-profile-')
      const hostA = await startFakeHost(base, profile, 'exit')
      publishArtefacts(profile, root, hostA, { cliPath: cli })
      const swapped: { host?: Tracked } = {}

      const report = await stopAllHosts({
        scope: { kind: 'payload-root', payloadRoot },
        registryRoot: root,
        ports: {
          terminate: async (input) => {
            // Listed live; before its stop, A dies and B takes the profile over.
            process.kill(hostA.pid, 'SIGKILL')
            await hostA.exited
            const hostB = await startFakeHost(scratch('host-stop-all-s1b-race-b-'), profile, 'exit')
            takeOverProfile(profile, hostA, hostB, 'current')
            publishDiscovery(profile, hostB)
            swapped.host = hostB
            return terminateHostProcess({ ...input, timings: FAST })
          }
        }
      })

      const hostB = swapped.host!
      expect({
        hostB: alive(hostB.pid) ? 'running' : 'stopped',
        artefacts: profileArtefacts(profile),
        outcome: report.hosts.map((host) => [host.liveness, host.outcome?.kind])
      }).toEqual({
        hostB: 'running',
        artefacts: { lease: true, discovery: true, token: true },
        outcome: [['live', 'inconsistent']]
      })
      expect(report.exitCode).toBe(1)
      expect(report.hosts).toMatchObject([
        {
          pid: hostA.pid,
          outcome: { pid: hostA.pid, heldBy: hostB.pid, swept: ['registry'] },
          note: `another Host (pid ${hostB.pid}) holds the profile now, not the expected one; it was left running`
        }
      ])
      expect(report.hosts[0]?.outcome?.steps.some((step) => step.startsWith('signal:'))).toBe(false)
      expect(contenderAcquires(profile)).toBe(false)
    }, 60_000)
  }
)
