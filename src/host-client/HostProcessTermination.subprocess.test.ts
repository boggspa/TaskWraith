import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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
  type ProcessBirthObservation
} from '../host-runtime/ProcessBirthIdentity'
import {
  taskWraithHostAuthorityLeasePath,
  taskWraithHostDiscoveryPath,
  taskWraithHostSocketPath,
  taskWraithHostTokenPath
} from '../shared/taskWraithHostPaths.node'
import { terminateHostProcess, type HostTerminationTimings } from './HostProcessTermination'
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

/** A stand-in Host: binds the profile's socket, never answers, optionally ignores SIGTERM. */
const FAKE_HOST_SOURCE = `'use strict'
const fs = require('node:fs')
const net = require('node:net')
const path = require('node:path')
const socketPath = process.env.FAKE_HOST_SOCKET
fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 })
try { fs.unlinkSync(socketPath) } catch {}
const server = net.createServer(() => {})
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
  term: 'exit' | 'ignore'
): Promise<Tracked> {
  const socketPath = taskWraithHostSocketPath(profile)
  temporary.push(dirname(socketPath))
  const child = spawn(
    process.execPath,
    [payloadCli(base), 'serve', '--mode', 'production', '--profile', profile],
    {
      env: { ...process.env, FAKE_HOST_SOCKET: socketPath, FAKE_HOST_TERM: term },
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

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe.skipIf(process.platform === 'win32')('verified termination against real processes', () => {
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
