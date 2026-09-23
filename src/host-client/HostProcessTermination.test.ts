import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import {
  HostProfileAuthorityLease,
  type HostProfileAuthorityProcessPort
} from '../host-runtime/HostProfileAuthorityLease'
import {
  HOST_REGISTRY_SCHEMA,
  hostRegistryEntryPath,
  readHostRegistryEntry
} from '../host-runtime/HostRegistry'
import type {
  ProcessBirthObservation,
  ProcessCommandLineObservation
} from '../host-runtime/ProcessBirthIdentity'
import {
  TASKWRAITH_HOST_SOCKET_FILE,
  taskWraithHostAuthorityLeasePath,
  taskWraithHostDiscoveryPath,
  taskWraithHostSocketPath,
  taskWraithHostTokenPath
} from '../shared/taskWraithHostPaths.node'
import {
  DEFAULT_HOST_TERMINATION_TIMINGS,
  createHostTerminationSignal,
  hostTerminationExpectation,
  hostTerminationTargetPid,
  isHostServeCommandFor,
  parseHostServeCommandLine,
  readHostTerminationEvidence,
  sweepHostArtefacts,
  terminateHostProcess,
  type HostTerminationEvidence,
  type HostTerminationInput,
  type HostTerminationPorts,
  type HostTerminationSignal
} from './HostProcessTermination'

const PROFILE = '/profiles/host-termination-p'
const PID = 4242
const BORN = 'a'.repeat(64)
const OTHER = 'b'.repeat(64)
/** When a process that took over the Host's pid started: after every Host artefact was written. */
const REUSED_START = Date.parse('2026-09-23T06:00:00.000Z')
const HOST_COMMAND = `/usr/local/bin/node /repo/out/host/host-runtime/cli.js serve --mode production --profile ${PROFILE}`

const live = (
  birthIdentity: string,
  startedAtMs: number | null = null
): ProcessBirthObservation => ({
  state: 'live',
  birthIdentity,
  startedAtMs
})

const hostCommand = (commandLine = HOST_COMMAND): ProcessCommandLineObservation => ({
  state: 'live',
  commandLine,
  argv: null
})

const REGISTRY_EVIDENCE: HostTerminationEvidence = {
  discovery: { pid: PID, socketPath: '/tmp/twh2/sock', startedAt: '2026-09-23T00:00:04.000Z' },
  lease: {
    pid: PID,
    processStartIdentity: BORN,
    processStartedAt: '2026-09-23T00:00:00.000Z',
    acquiredAt: '2026-09-23T00:00:00.100Z'
  },
  registry: { pid: PID, birthIdentity: BORN, bootEpoch: 'e'.repeat(64) }
}

/**
 * Every port is mocked, and every call still names a temporary registry root:
 * a port that stops being mocked can then never reach ~/.taskwraith/hosts.
 */
let REGISTRY_ROOT = ''
beforeAll(() => {
  REGISTRY_ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'host-termination-unit-registry-')))
})
afterAll(() => {
  rmSync(REGISTRY_ROOT, { recursive: true, force: true })
})

function terminate(input: Omit<HostTerminationInput, 'registryRoot'>) {
  return terminateHostProcess({ ...input, registryRoot: REGISTRY_ROOT })
}

function onTemporaryRoot(registryRoot: string): void {
  if (registryRoot !== REGISTRY_ROOT) {
    throw new Error(`port reached registry root ${registryRoot}, not the test's temporary root`)
  }
}

const NO_RECORDS: HostTerminationEvidence = { discovery: null, lease: null, registry: null }

interface Harness {
  readonly ports: Partial<HostTerminationPorts>
  readonly signals: Array<{
    readonly pid: number
    readonly signal: HostTerminationSignal
    readonly at: number
  }>
  readonly delays: number[]
  readonly sweeps: HostTerminationEvidence[]
  readonly budgets: Array<{ readonly ackMs: number; readonly drainMs: number }>
  readonly lines: string[]
  observeCalls(): number
  clock(): number
}

function harness(options: {
  readonly evidence?: HostTerminationEvidence
  readonly shutdown?: () => Promise<'stopping' | 'already_stopping'>
  readonly observe: (
    call: number,
    clock: number,
    signals: readonly HostTerminationSignal[],
    pid: number
  ) => ProcessBirthObservation
  readonly command?: (call: number) => ProcessCommandLineObservation
}): Harness {
  let clock = 0
  let observeCalls = 0
  let commandCalls = 0
  const signals: Harness['signals'] = []
  const delays: number[] = []
  const sweeps: HostTerminationEvidence[] = []
  const budgets: Harness['budgets'] = []
  const lines: string[] = []
  return {
    ports: {
      shutdown: async (_profile, budget) => {
        budgets.push(budget)
        if (options.shutdown) return options.shutdown()
        throw new Error('Host shutdown request timed out')
      },
      readEvidence: (_profile, registryRoot) => {
        onTemporaryRoot(registryRoot)
        return options.evidence ?? REGISTRY_EVIDENCE
      },
      observe: async (pid) => {
        observeCalls += 1
        return options.observe(
          observeCalls,
          clock,
          signals.map((entry) => entry.signal),
          pid
        )
      },
      observeCommand: async () => {
        commandCalls += 1
        return options.command ? options.command(commandCalls) : hostCommand()
      },
      signal: (pid, signal) => {
        signals.push({ pid, signal, at: clock })
      },
      sweep: async (_profile, dead, registryRoot) => {
        onTemporaryRoot(registryRoot)
        sweeps.push(dead)
        return ['registry']
      },
      delay: async (ms) => {
        delays.push(ms)
        clock += ms
      },
      now: () => clock,
      log: (line) => {
        lines.push(line)
      }
    },
    signals,
    delays,
    sweeps,
    budgets,
    lines,
    observeCalls: () => observeCalls,
    clock: () => clock
  }
}

describe('terminateHostProcess', () => {
  it('stops through the authenticated socket and sweeps once the process has exited', async () => {
    const run = harness({
      shutdown: async () => 'stopping',
      observe: (call) => (call === 1 ? live(BORN) : { state: 'dead' })
    })
    const outcome = await terminate({ profilePath: PROFILE, ports: run.ports })
    expect(outcome).toMatchObject({ kind: 'stopped', pid: PID, swept: ['registry'] })
    expect(outcome.steps).toEqual(['socket:stopping', 'swept:registry'])
    expect(run.signals).toEqual([])
    expect(run.sweeps).toEqual([REGISTRY_EVIDENCE])
    expect(run.budgets).toEqual([{ ackMs: 10_000, drainMs: 45_000 }])
  })

  it('escalates socket -> verify -> SIGTERM -> verify -> SIGKILL on the D14 timings', async () => {
    const run = harness({
      observe: (_call, _clock, signals) =>
        signals.includes('SIGKILL') ? { state: 'dead' } : live(BORN)
    })
    const outcome = await terminate({ profilePath: PROFILE, ports: run.ports })
    expect(outcome.kind).toBe('killed')
    expect(outcome.steps).toEqual([
      'socket:failed:Host shutdown request timed out',
      'verify:match',
      'signal:SIGTERM',
      'signal:SIGKILL',
      'swept:registry'
    ])
    expect(run.budgets).toEqual([{ ackMs: 10_000, drainMs: 45_000 }])
    // TERM is given its full 30 s before the KILL, polled every 250 ms.
    expect(run.signals).toEqual([
      { pid: PID, signal: 'SIGTERM', at: 0 },
      { pid: PID, signal: 'SIGKILL', at: 30_000 }
    ])
    expect(run.delays.slice(0, 120).every((ms) => ms === 250)).toBe(true)
    expect(run.delays).toHaveLength(121)
    expect(run.sweeps).toEqual([REGISTRY_EVIDENCE])
    expect(DEFAULT_HOST_TERMINATION_TIMINGS).toEqual({
      ackMs: 10_000,
      drainMs: 45_000,
      termMs: 30_000,
      killMs: 10_000,
      pollMs: 250,
      exitMs: 5_000
    })
  })

  it('reports a process that survives SIGKILL for the full KILL budget as failed, unswept', async () => {
    const run = harness({ observe: () => live(BORN) })
    const outcome = await terminate({ profilePath: PROFILE, ports: run.ports })
    expect(outcome.kind).toBe('failed')
    expect(run.signals.map((entry) => [entry.signal, entry.at])).toEqual([
      ['SIGTERM', 0],
      ['SIGKILL', 30_000]
    ])
    expect(run.clock()).toBe(40_000)
    expect(run.sweeps).toEqual([])
  })

  it('stops at SIGTERM when the Host exits inside the TERM budget', async () => {
    const run = harness({
      observe: (_call, clock, signals) =>
        signals.includes('SIGTERM') && clock >= 1_000 ? { state: 'dead' } : live(BORN)
    })
    const outcome = await terminate({ profilePath: PROFILE, ports: run.ports })
    expect(outcome.kind).toBe('terminated')
    expect(run.signals.map((entry) => entry.signal)).toEqual(['SIGTERM'])
    expect(run.clock()).toBe(1_000)
  })

  it('never signals a pid whose identity changed between TERM and KILL', async () => {
    // Calls: 1 the verify before TERM, 2-5 the four TERM polls (1 s at
    // 250 ms), 6 the re-verify before KILL — where the pid turns out to
    // belong to a process born at another time.
    const run = harness({
      observe: (call) => (call >= 6 ? live(OTHER, REUSED_START) : live(BORN))
    })
    const outcome = await terminate({
      profilePath: PROFILE,
      timings: { termMs: 1_000, killMs: 1_000 },
      ports: run.ports
    })
    // Call 7 observes the pid again to prove each record stale before the sweep.
    expect(run.observeCalls()).toBe(7)
    expect(outcome).toMatchObject({ kind: 'pid_reused', detail: 'identity changed before SIGKILL' })
    expect(run.signals.map((entry) => entry.signal)).toEqual(['SIGTERM'])
    expect(run.sweeps).toEqual([REGISTRY_EVIDENCE])
  })

  it('refuses to signal when identity is unavailable', async () => {
    const run = harness({ observe: () => ({ state: 'identity_unavailable' }) })
    const outcome = await terminate({ profilePath: PROFILE, ports: run.ports })
    expect(outcome.kind).toBe('identity_unavailable')
    expect(run.signals).toEqual([])
    expect(run.sweeps).toEqual([])
  })

  it('refuses to signal when the command line cannot be read, even with a matching birth', async () => {
    const run = harness({
      observe: () => live(BORN),
      command: () => ({ state: 'identity_unavailable' })
    })
    const outcome = await terminate({ profilePath: PROFILE, ports: run.ports })
    expect(outcome.kind).toBe('identity_unavailable')
    expect(run.signals).toEqual([])
    expect(run.sweeps).toEqual([])
  })

  it('never signals a live process that is not a Host serving this profile (the in-process lane)', async () => {
    for (const commandLine of [
      '/Applications/TaskWraith.app/Contents/MacOS/TaskWraith',
      `/usr/local/bin/node /repo/out/host/host-runtime/cli.js serve --mode production --profile ${PROFILE}-other`,
      `/usr/local/bin/node /repo/out/host/host-runtime/cli.js stop --profile ${PROFILE}`
    ]) {
      const run = harness({ observe: () => live(BORN), command: () => hostCommand(commandLine) })
      const outcome = await terminate({ profilePath: PROFILE, ports: run.ports })
      expect(outcome.kind).toBe('not_a_host')
      expect(run.signals).toEqual([])
      expect(run.sweeps).toEqual([])
    }
  })

  it('re-checks the command line before SIGKILL as well as before SIGTERM', async () => {
    const run = harness({
      observe: () => live(BORN),
      // Call 1 gates SIGTERM, call 2 gates SIGKILL.
      command: (call) =>
        call === 1
          ? hostCommand()
          : hostCommand('/Applications/TaskWraith.app/Contents/MacOS/TaskWraith')
    })
    const outcome = await terminate({
      profilePath: PROFILE,
      timings: { termMs: 500, killMs: 500 },
      ports: run.ports
    })
    expect(outcome).toMatchObject({ kind: 'not_a_host', detail: 'before SIGKILL' })
    expect(run.signals.map((entry) => entry.signal)).toEqual(['SIGTERM'])
  })

  it('refuses when the artefacts name more than one pid', async () => {
    const run = harness({
      evidence: { ...REGISTRY_EVIDENCE, discovery: { ...REGISTRY_EVIDENCE.discovery!, pid: 5151 } },
      observe: () => live(BORN)
    })
    const outcome = await terminate({ profilePath: PROFILE, ports: run.ports })
    expect(outcome).toMatchObject({ kind: 'inconsistent', pid: null })
    expect(run.budgets).toEqual([])
    expect(run.signals).toEqual([])
    expect(run.sweeps).toEqual([])
  })

  it('treats a reused pid as a Host already gone: sweeps its artefacts, never signals', async () => {
    const run = harness({ observe: () => live(OTHER, REUSED_START) })
    const outcome = await terminate({ profilePath: PROFILE, ports: run.ports })
    expect(outcome.kind).toBe('pid_reused')
    expect(run.signals).toEqual([])
    expect(run.sweeps).toEqual([REGISTRY_EVIDENCE])
  })

  it('refuses a reused pid that a surviving record may still name, and sweeps nothing', async () => {
    // A registry entry that recorded no birth, and a discovery written after
    // the process now at the pid started, could both be that process's own:
    // only the lease reads the pid as reused, so the evidence disagrees.
    const evidence: HostTerminationEvidence = {
      discovery: {
        pid: PID,
        socketPath: '/tmp/twh2/sock',
        startedAt: new Date(REUSED_START + 5_000).toISOString()
      },
      lease: REGISTRY_EVIDENCE.lease,
      registry: { pid: PID, birthIdentity: null, bootEpoch: null }
    }
    const run = harness({ evidence, observe: () => live(OTHER, REUSED_START) })
    const outcome = await terminate({ profilePath: PROFILE, ports: run.ports })
    expect(outcome).toMatchObject({
      kind: 'inconsistent',
      pid: PID,
      swept: [],
      detail: 'a record naming the pid is not contradicted by the process now at it'
    })
    expect(outcome.steps).toEqual([
      'socket:failed:Host shutdown request timed out',
      'verify:mismatch',
      'evidence:inconsistent'
    ])
    expect(run.signals).toEqual([])
    expect(run.sweeps).toEqual([])

    // An observation that fails before the sweep proves nothing: nothing is swept.
    const blind = harness({
      observe: (call) =>
        call === 1 ? live(OTHER, REUSED_START) : { state: 'identity_unavailable' }
    })
    await expect(terminate({ profilePath: PROFILE, ports: blind.ports })).resolves.toMatchObject({
      kind: 'pid_reused'
    })
    expect(blind.sweeps).toEqual([NO_RECORDS])
  })

  it('refuses a reused pid when the one record the process cannot contradict is a registry entry without a birth (C1)', async () => {
    const evidence: HostTerminationEvidence = {
      discovery: null,
      lease: REGISTRY_EVIDENCE.lease,
      registry: { pid: PID, birthIdentity: null, bootEpoch: null }
    }
    const run = harness({ evidence, observe: () => live(OTHER, REUSED_START) })
    const outcome = await terminate({ profilePath: PROFILE, ports: run.ports })
    expect(outcome).toMatchObject({ kind: 'inconsistent', pid: PID, swept: [] })
    expect(outcome.steps).toEqual([
      'socket:failed:Host shutdown request timed out',
      'verify:mismatch',
      'evidence:inconsistent'
    ])
    expect(run.signals).toEqual([])
    expect(run.sweeps).toEqual([])
  })

  it('refuses a legacy lease taken after a wall-clock step beside the live Host that wrote the discovery (C1)', async () => {
    // The lease's recorded start is 3 s off the process start, so the lease
    // alone reads the pid as reused; the discovery, written after the process
    // started, reads it as that process's own.
    const start = Date.parse('2026-09-23T05:00:00.000Z')
    const evidence: HostTerminationEvidence = {
      discovery: {
        pid: PID,
        socketPath: '/tmp/twh2/sock',
        startedAt: new Date(start + 4_000).toISOString()
      },
      lease: {
        pid: PID,
        processStartIdentity: `node:${PID}:172d23b8aef73`,
        processStartedAt: new Date(start + 3_000).toISOString(),
        acquiredAt: new Date(start + 3_100).toISOString()
      },
      registry: null
    }
    const run = harness({ evidence, observe: () => live(OTHER, start) })
    const outcome = await terminate({ profilePath: PROFILE, ports: run.ports })
    expect(outcome).toMatchObject({ kind: 'inconsistent', pid: PID, swept: [] })
    expect(outcome.steps).toEqual([
      'socket:failed:Host shutdown request timed out',
      'verify:mismatch',
      'evidence:inconsistent'
    ])
    expect(run.signals).toEqual([])
    expect(run.sweeps).toEqual([])
    expect(run.lines.at(-1)).toContain('inconsistent (a record naming the pid is not contradicted')
  })

  it('sweeps every record when each names a dead pid of its own: all dropped on the way in, already gone (C6)', async () => {
    const evidence: HostTerminationEvidence = {
      discovery: { pid: 4444, socketPath: '/tmp/twh2/sock', startedAt: '2026-09-23T00:00:04.000Z' },
      lease: { ...REGISTRY_EVIDENCE.lease!, pid: 4343 },
      registry: { ...REGISTRY_EVIDENCE.registry!, pid: 4242 }
    }
    const run = harness({ evidence, observe: () => ({ state: 'dead' }) })
    const outcome = await terminate({ profilePath: PROFILE, ports: run.ports })
    expect(outcome).toMatchObject({ kind: 'already_gone', pid: null })
    expect(outcome.steps).toEqual([
      'evidence:stale-registry',
      'evidence:stale-lease',
      'evidence:stale-discovery',
      'evidence:none',
      'swept:registry'
    ])
    expect(run.signals).toEqual([])
    expect(run.sweeps).toEqual([evidence])
  })

  it('judges a registry digest beside a legacy lease by each record: the lease owner is never swept', async () => {
    // A crashed registry Host left its entry; the pid now belongs to a live
    // process holding a legacy (nonce) lease that names it, born when the
    // lease says. It is not a Host serving this profile.
    const leaseStart = Date.parse('2026-09-23T05:00:00.000Z')
    const evidence: HostTerminationEvidence = {
      discovery: {
        pid: PID,
        socketPath: '/tmp/twh2/sock',
        startedAt: new Date(leaseStart + 4_000).toISOString()
      },
      lease: {
        pid: PID,
        processStartIdentity: `node:${PID}:172d23b8aef73`,
        processStartedAt: new Date(leaseStart + 400).toISOString(),
        acquiredAt: new Date(leaseStart + 500).toISOString()
      },
      registry: { pid: PID, birthIdentity: 'c'.repeat(64), bootEpoch: 'e'.repeat(64) }
    }
    const owner = harness({
      evidence,
      observe: () => live(OTHER, leaseStart),
      command: () => hostCommand('/Applications/TaskWraith.app/Contents/MacOS/TaskWraith')
    })
    const refused = await terminate({ profilePath: PROFILE, ports: owner.ports })
    expect(refused.kind).toBe('not_a_host')
    expect(refused.steps).toEqual([
      'evidence:stale-registry',
      'socket:failed:Host shutdown request timed out',
      'verify:not_a_host'
    ])
    expect(owner.signals).toEqual([])
    expect(owner.sweeps).toEqual([])

    // The same state held by a wedged pre-registry Host: verified by its
    // lease start and stopped, and only then is every record swept.
    const legacyHost = harness({
      evidence,
      observe: (_call, _clock, signals) =>
        signals.includes('SIGTERM') ? { state: 'dead' } : live(OTHER, leaseStart)
    })
    const stopped = await terminate({ profilePath: PROFILE, ports: legacyHost.ports })
    expect(stopped.kind).toBe('terminated')
    expect(stopped.steps.slice(0, 4)).toEqual([
      'evidence:stale-registry',
      'socket:failed:Host shutdown request timed out',
      'verify:match',
      'signal:SIGTERM'
    ])
    expect(legacyHost.sweeps).toEqual([evidence])
  })

  it("keeps a legacy lease beside the Host's own registry digest: nothing is dropped, the Host is verified", async () => {
    const leaseStart = Date.parse('2026-09-23T05:00:00.000Z')
    const evidence: HostTerminationEvidence = {
      ...REGISTRY_EVIDENCE,
      discovery: {
        pid: PID,
        socketPath: '/tmp/twh2/sock',
        startedAt: new Date(leaseStart + 4_000).toISOString()
      },
      lease: {
        pid: PID,
        processStartIdentity: `node:${PID}:abc`,
        processStartedAt: new Date(leaseStart).toISOString(),
        acquiredAt: new Date(leaseStart + 100).toISOString()
      }
    }
    const run = harness({
      evidence,
      observe: (_call, _clock, signals) =>
        signals.includes('SIGTERM') ? { state: 'dead' } : live(BORN, leaseStart)
    })
    const outcome = await terminate({ profilePath: PROFILE, ports: run.ports })
    expect(outcome.kind).toBe('terminated')
    expect(outcome.steps.slice(0, 2)).toEqual([
      'socket:failed:Host shutdown request timed out',
      'verify:match'
    ])
    expect(run.sweeps).toEqual([evidence])
  })

  it('sweeps a dead Host without signalling and reports no Host when nothing names one', async () => {
    const dead = harness({ observe: () => ({ state: 'dead' }) })
    await expect(terminate({ profilePath: PROFILE, ports: dead.ports })).resolves.toMatchObject({
      kind: 'already_gone',
      pid: PID
    })
    expect(dead.signals).toEqual([])
    expect(dead.sweeps).toEqual([REGISTRY_EVIDENCE])
    const empty = harness({
      evidence: { discovery: null, lease: null, registry: null },
      observe: () => live(BORN)
    })
    await expect(terminate({ profilePath: PROFILE, ports: empty.ports })).resolves.toMatchObject({
      kind: 'already_gone',
      pid: null,
      steps: ['evidence:none', 'swept:registry']
    })
    expect(empty.budgets).toEqual([])
  })

  it('refuses a registry entry that recorded no birth identity and has no lease to fall back on', async () => {
    const run = harness({
      evidence: {
        discovery: null,
        lease: null,
        registry: { pid: PID, birthIdentity: null, bootEpoch: null }
      },
      observe: () => live(BORN)
    })
    const outcome = await terminate({ profilePath: PROFILE, ports: run.ports })
    expect(outcome.kind).toBe('unverifiable')
    expect(outcome.steps).toEqual(['socket:skipped', 'verify:unverifiable'])
    expect(run.budgets).toEqual([])
    expect(run.signals).toEqual([])
  })

  it('skips the socket for a registry-only Host and judges its pid directly', async () => {
    const evidence: HostTerminationEvidence = {
      discovery: null,
      lease: null,
      registry: { pid: PID, birthIdentity: BORN, bootEpoch: null }
    }
    const run = harness({ evidence, observe: () => live(OTHER) })
    const outcome = await terminate({ profilePath: PROFILE, ports: run.ports })
    expect(outcome.kind).toBe('pid_reused')
    expect(outcome.steps).toEqual(['socket:skipped', 'verify:mismatch', 'swept:registry'])
    expect(run.budgets).toEqual([])
    expect(run.signals).toEqual([])
    expect(run.sweeps).toEqual([evidence])
  })

  it('verifies a pre-registry Host by its lease start instant within two seconds', async () => {
    const legacy: HostTerminationEvidence = {
      discovery: { pid: PID, socketPath: '/tmp/twh2/sock', startedAt: '2026-09-22T13:43:22.239Z' },
      lease: {
        pid: PID,
        processStartIdentity: 'node:4242:172d23b8aef73',
        processStartedAt: '2026-09-22T13:43:18.109Z',
        acquiredAt: '2026-09-22T13:43:18.208Z'
      },
      registry: null
    }
    expect(hostTerminationExpectation(legacy)).toEqual({
      startedAtMs: Date.parse('2026-09-22T13:43:18.109Z')
    })
    const lstart = Date.UTC(2026, 8, 22, 13, 43, 18)
    const matching = harness({
      evidence: legacy,
      observe: (_call, _clock, signals) =>
        signals.includes('SIGTERM') ? { state: 'dead' } : live(OTHER, lstart)
    })
    await expect(terminate({ profilePath: PROFILE, ports: matching.ports })).resolves.toMatchObject(
      { kind: 'terminated' }
    )
    // Discovery's listener start (4 s after the process start) is never the comparison.
    const reused = harness({ evidence: legacy, observe: () => live(OTHER, lstart + 60_000) })
    await expect(terminate({ profilePath: PROFILE, ports: reused.ports })).resolves.toMatchObject({
      kind: 'pid_reused'
    })
    expect(reused.signals).toEqual([])
  })

  it('keeps an identity-unavailable verdict after a socket stop unsignalled and unswept', async () => {
    const run = harness({
      shutdown: async () => 'stopping',
      observe: () => ({ state: 'identity_unavailable' })
    })
    const outcome = await terminate({ profilePath: PROFILE, ports: run.ports })
    expect(outcome.kind).toBe('identity_unavailable')
    expect(run.signals).toEqual([])
    expect(run.sweeps).toEqual([])
  })

  it('drops a stale registry entry beside a live Host by observation, stops the Host, and sweeps both', async () => {
    // A dead Host's entry (pid 5151) was never swept; the live Host (4242)
    // holds the discovery and the lease.
    const evidence: HostTerminationEvidence = {
      ...REGISTRY_EVIDENCE,
      registry: { pid: 5151, birthIdentity: OTHER, bootEpoch: 'd'.repeat(64) }
    }
    const run = harness({
      evidence,
      observe: (_call, _clock, signals, pid) =>
        pid === 5151 || signals.includes('SIGTERM') ? { state: 'dead' } : live(BORN)
    })
    const outcome = await terminate({ profilePath: PROFILE, ports: run.ports })
    expect(outcome).toMatchObject({ kind: 'terminated', pid: PID })
    expect(outcome.steps).toEqual([
      'evidence:stale-registry',
      'socket:failed:Host shutdown request timed out',
      'verify:match',
      'signal:SIGTERM',
      'swept:registry'
    ])
    expect(run.signals.map((entry) => [entry.pid, entry.signal])).toEqual([[PID, 'SIGTERM']])
    // The sweep sees every record read, the stale entry included.
    expect(run.sweeps).toEqual([evidence])
  })

  it('stays inconsistent, unsignalled and unswept while a disagreeing record cannot be proven stale', async () => {
    const unprovable: ProcessBirthObservation[] = [live(OTHER), { state: 'identity_unavailable' }]
    for (const other of unprovable) {
      const run = harness({
        evidence: {
          ...REGISTRY_EVIDENCE,
          registry: { pid: 5151, birthIdentity: OTHER, bootEpoch: null }
        },
        observe: (_call, _clock, _signals, pid) => (pid === 5151 ? other : live(BORN))
      })
      const outcome = await terminate({ profilePath: PROFILE, ports: run.ports })
      expect(outcome).toMatchObject({ kind: 'inconsistent', pid: null })
      expect(outcome.steps).toEqual(['evidence:inconsistent'])
      expect(run.budgets).toEqual([])
      expect(run.signals).toEqual([])
      expect(run.sweeps).toEqual([])
    }
  })

  it('never lets a registry digest overrule a disagreeing lease digest: the observed birth decides', async () => {
    // One pid, two births on record. Before, the registry's won unchecked: an
    // observed lease birth read as a reused pid and swept a live Host's lease,
    // discovery and token.
    const evidence: HostTerminationEvidence = {
      ...REGISTRY_EVIDENCE,
      lease: { ...REGISTRY_EVIDENCE.lease!, processStartIdentity: OTHER }
    }
    expect(hostTerminationTargetPid(evidence)).toEqual({ pid: null, inconsistent: true })
    const run = harness({
      evidence,
      observe: (_call, _clock, signals) =>
        signals.includes('SIGTERM') ? { state: 'dead' } : live(OTHER)
    })
    const outcome = await terminate({ profilePath: PROFILE, ports: run.ports })
    expect(outcome.kind).toBe('terminated')
    expect(outcome.steps.slice(0, 3)).toEqual([
      'evidence:stale-registry',
      'socket:failed:Host shutdown request timed out',
      'verify:match'
    ])
    const blind = harness({ evidence, observe: () => ({ state: 'identity_unavailable' }) })
    await expect(terminate({ profilePath: PROFILE, ports: blind.ports })).resolves.toMatchObject({
      kind: 'inconsistent'
    })
    expect(blind.signals).toEqual([])
    expect(blind.sweeps).toEqual([])
  })
})

describe('createHostTerminationSignal', () => {
  it('runs taskkill by its fixed system path on Windows, never through PATH', () => {
    const calls: unknown[][] = []
    const signal = createHostTerminationSignal('win32', {
      spawnSync: (...args) => {
        calls.push(args)
        return null
      },
      windowsRoot: 'C:\\Windows'
    })
    signal(4242, 'SIGTERM')
    signal(4242, 'SIGKILL')
    const expected = [
      'C:\\Windows\\System32\\taskkill.exe',
      ['/PID', '4242', '/T', '/F'],
      { stdio: 'ignore', windowsHide: true }
    ]
    expect(calls).toEqual([expected, expected])
    vi.stubEnv('SystemRoot', 'D:\\WINNT')
    try {
      const fromEnvironment: unknown[][] = []
      createHostTerminationSignal('win32', {
        spawnSync: (...args) => {
          fromEnvironment.push(args)
          return null
        }
      })(7, 'SIGTERM')
      expect(fromEnvironment[0]?.[0]).toBe('D:\\WINNT\\System32\\taskkill.exe')
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('sends the POSIX signal elsewhere and treats ESRCH as already gone', () => {
    const kill = vi.fn((_pid: number, _signal: HostTerminationSignal) => {
      throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' })
    })
    const spawnSync = vi.fn()
    const signal = createHostTerminationSignal('darwin', { kill, spawnSync })
    expect(() => signal(4242, 'SIGTERM')).not.toThrow()
    expect(kill).toHaveBeenCalledWith(4242, 'SIGTERM')
    expect(spawnSync).not.toHaveBeenCalled()
  })
})

describe('parseHostServeCommandLine', () => {
  it('reads the profile from a joined ps line, including spaces and a trailing flag', () => {
    expect(
      parseHostServeCommandLine(
        '/Applications/TaskWraith.app/Contents/Resources/tui-runtime/darwin-arm64/node /Applications/TaskWraith.app/Contents/Resources/host/host-runtime/cli.js serve --mode production --profile /Users/x/Library/Application Support/taskwraith'
      )
    ).toEqual({
      cliPath: '/Applications/TaskWraith.app/Contents/Resources/host/host-runtime/cli.js',
      profilePath: '/Users/x/Library/Application Support/taskwraith'
    })
    expect(
      parseHostServeCommandLine(
        'node /repo/out/host/host-runtime/cli.js serve --mode production --profile /p q --muse-binary /m'
      )
    ).toEqual({ cliPath: '/repo/out/host/host-runtime/cli.js', profilePath: '/p q' })
    expect(
      parseHostServeCommandLine(
        '"C:\\Program Files\\node.exe" "C:\\TW\\resources\\host\\host-runtime\\cli.js" serve --mode production --profile "C:\\Users\\x\\AppData\\Roaming\\TaskWraith"'
      )
    ).toEqual({
      cliPath: 'C:\\TW\\resources\\host\\host-runtime\\cli.js',
      profilePath: 'C:\\Users\\x\\AppData\\Roaming\\TaskWraith'
    })
  })

  it('reads an exact argv when the platform provides one', () => {
    expect(
      parseHostServeCommandLine('ignored', [
        '/usr/bin/node',
        '/repo/out/host/host-runtime/cli.js',
        'serve',
        '--mode',
        'production',
        '--profile',
        '/p --odd name'
      ])
    ).toEqual({ cliPath: '/repo/out/host/host-runtime/cli.js', profilePath: '/p --odd name' })
    expect(parseHostServeCommandLine('ignored', ['/usr/bin/node', '/x/cli.js', 'serve'])).toBeNull()
  })

  it('rejects everything that is not a Host serve command with a profile', () => {
    for (const line of [
      '/Applications/TaskWraith.app/Contents/MacOS/TaskWraith',
      'node /repo/out/host/host-runtime/cli.js stop --profile /p',
      'node /repo/out/host/host-runtime/cli.js serve --mode production',
      'node -e setInterval(()=>{},1e3) host-runtime/cli.jsx serve --profile /p',
      'vim /repo/src/host-runtime/cli.ts serve --profile /p'
    ]) {
      expect(parseHostServeCommandLine(line)).toBeNull()
    }
  })

  it('matches a profile through its canonical path', () => {
    const profile = realpathSync(mkdtempSync(join(tmpdir(), 'host-termination-canonical-')))
    try {
      expect(
        isHostServeCommandFor(
          hostCommand(`node /r/host-runtime/cli.js serve --profile ${profile}`),
          profile
        )
      ).toBe(true)
      expect(
        isHostServeCommandFor(
          hostCommand(`node /r/host-runtime/cli.js serve --profile ${profile}/..`),
          profile
        )
      ).toBe(false)
      expect(isHostServeCommandFor({ state: 'dead' }, profile)).toBe(false)
    } finally {
      rmSync(profile, { recursive: true, force: true })
    }
  })
})

describe('sweepHostArtefacts', () => {
  const temporary: string[] = []
  afterEach(() => {
    while (temporary.length) rmSync(temporary.pop()!, { recursive: true, force: true })
  })

  function scratch(prefix: string): string {
    const path = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
    temporary.push(path)
    return path
  }

  function portFor(pid: number, birth: string): HostProfileAuthorityProcessPort {
    return {
      current: { pid, processStartIdentity: birth, processStartedAt: '2026-09-23T00:00:00.000Z' },
      inspectOwner: () => 'stale'
    }
  }

  function seed(
    profile: string,
    root: string,
    pid: number,
    host: { readonly birth: string; readonly startedAt: string } = {
      birth: BORN,
      startedAt: '2026-09-23T00:00:04.000Z'
    }
  ): void {
    writeFileSync(taskWraithHostTokenPath(profile), 'token\n', { mode: 0o600 })
    writeFileSync(
      taskWraithHostDiscoveryPath(profile),
      `${JSON.stringify({
        protocolVersion: 2,
        socketPath: taskWraithHostSocketPath(profile),
        tokenPath: taskWraithHostTokenPath(profile),
        pid,
        startedAt: host.startedAt,
        hostId: 'host-1',
        hostVersion: 'node-host-v1'
      })}\n`,
      { mode: 0o600 }
    )
    mkdirSync(root, { recursive: true, mode: 0o700 })
    writeFileSync(
      hostRegistryEntryPath(root, profile),
      `${JSON.stringify({
        schema: HOST_REGISTRY_SCHEMA,
        profilePath: profile,
        pid,
        birthIdentity: host.birth,
        startedAt: host.startedAt,
        hostId: 'host-1',
        bootEpoch: null,
        payloadVersion: null,
        socketPath: taskWraithHostSocketPath(profile),
        discoveryPath: taskWraithHostDiscoveryPath(profile),
        cliPath: null,
        nodeExecutable: null,
        persist: false,
        leaseMode: 'lease',
        writtenAt: '2026-09-23T00:00:04.000Z',
        beatSeq: 0,
        holders: 0,
        implicitHolders: 0,
        lifetimePhase: 'held'
      })}\n`,
      { mode: 0o600 }
    )
    if (process.platform !== 'win32') {
      const socketPath = taskWraithHostSocketPath(profile)
      mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 })
      temporary.push(dirname(socketPath))
      writeFileSync(socketPath, '')
    }
  }

  it("removes every artefact that still carries the dead Host's records", async () => {
    const profile = scratch('host-termination-sweep-')
    const root = join(scratch('host-termination-registry-'), 'hosts')
    seed(profile, root, 91_001)
    const lease = HostProfileAuthorityLease.acquire({
      profilePath: profile,
      processPort: portFor(91_001, BORN)
    })
    expect(lease.owner.pid).toBe(91_001)
    const dead = readHostTerminationEvidence(profile, root)
    expect(dead).toMatchObject({
      discovery: { pid: 91_001 },
      lease: { pid: 91_001, processStartIdentity: BORN },
      registry: { pid: 91_001, birthIdentity: BORN }
    })
    const removed = await sweepHostArtefacts(profile, dead, root, {
      socketIsLive: async () => false
    })
    expect(removed).toEqual(
      process.platform === 'win32'
        ? ['registry', 'discovery', 'token', 'lease']
        : ['registry', 'discovery', 'token', 'lease', 'socket', 'socket-directory']
    )
    expect(existsSync(taskWraithHostDiscoveryPath(profile))).toBe(false)
    expect(existsSync(taskWraithHostTokenPath(profile))).toBe(false)
    expect(existsSync(taskWraithHostAuthorityLeasePath(profile))).toBe(false)
    expect(readHostRegistryEntry(root, profile).kind).toBe('missing')
    if (process.platform !== 'win32') {
      expect(existsSync(dirname(taskWraithHostSocketPath(profile)))).toBe(false)
    }
  })

  it("leaves a successor's profile artefacts alone and removes only the dead pid's registry entry", async () => {
    const profile = scratch('host-termination-successor-')
    const root = join(scratch('host-termination-registry-'), 'hosts')
    seed(profile, root, 91_001)
    const dead = readHostTerminationEvidence(profile, root)
    const successor = HostProfileAuthorityLease.acquire({
      profilePath: profile,
      processPort: portFor(91_002, 'c'.repeat(64))
    })
    const removed = await sweepHostArtefacts(profile, dead, root, {
      socketIsLive: async () => false
    })
    expect(removed).toEqual(['registry'])
    expect(existsSync(taskWraithHostDiscoveryPath(profile))).toBe(true)
    expect(existsSync(taskWraithHostTokenPath(profile))).toBe(true)
    expect(existsSync(taskWraithHostAuthorityLeasePath(profile))).toBe(true)
    if (process.platform !== 'win32') {
      expect(
        existsSync(join(dirname(taskWraithHostSocketPath(profile)), TASKWRAITH_HOST_SOCKET_FILE))
      ).toBe(true)
    }
    expect(successor.release()).toBe(true)
  })

  it('never removes a live socket or a discovery naming another pid', async () => {
    const profile = scratch('host-termination-live-socket-')
    const root = join(scratch('host-termination-registry-'), 'hosts')
    seed(profile, root, 91_003)
    const dead: HostTerminationEvidence = {
      discovery: {
        pid: 91_004,
        socketPath: taskWraithHostSocketPath(profile),
        startedAt: '2026-09-23T00:00:04.000Z'
      },
      lease: null,
      registry: { pid: 91_004, birthIdentity: BORN, bootEpoch: null }
    }
    const removed = await sweepHostArtefacts(profile, dead, root, {
      socketIsLive: async () => true
    })
    expect(removed).toEqual([])
    expect(existsSync(taskWraithHostDiscoveryPath(profile))).toBe(true)
    expect(readHostRegistryEntry(root, profile).kind).toBe('present')
    if (process.platform !== 'win32') {
      expect(existsSync(taskWraithHostSocketPath(profile))).toBe(true)
    }
  })

  it("keeps a same-pid successor's registry entry, discovery, token and lease", async () => {
    const profile = scratch('host-termination-same-pid-')
    const root = join(scratch('host-termination-registry-'), 'hosts')
    seed(profile, root, 91_005)
    const first = HostProfileAuthorityLease.acquire({
      profilePath: profile,
      processPort: portFor(91_005, BORN)
    })
    const dead = readHostTerminationEvidence(profile, root)
    // The first Host exits; the operating system hands its pid to the next
    // Host for the same profile, which publishes everything anew.
    expect(first.release()).toBe(true)
    const reborn = 'c'.repeat(64)
    seed(profile, root, 91_005, { birth: reborn, startedAt: '2026-09-23T01:00:04.000Z' })
    const successor = HostProfileAuthorityLease.acquire({
      profilePath: profile,
      processPort: portFor(91_005, reborn)
    })
    const removed = await sweepHostArtefacts(profile, dead, root, {
      socketIsLive: async () => true
    })
    expect(removed).toEqual([])
    expect(readHostRegistryEntry(root, profile)).toMatchObject({
      kind: 'present',
      entry: { pid: 91_005, birthIdentity: reborn }
    })
    expect(existsSync(taskWraithHostDiscoveryPath(profile))).toBe(true)
    expect(existsSync(taskWraithHostTokenPath(profile))).toBe(true)
    expect(existsSync(taskWraithHostAuthorityLeasePath(profile))).toBe(true)
    expect(successor.release()).toBe(true)
  })

  it('keeps a discovery a same-pid successor wrote after the dead one, and the token with it', async () => {
    const profile = scratch('host-termination-same-pid-discovery-')
    const root = join(scratch('host-termination-registry-'), 'hosts')
    seed(profile, root, 91_007)
    const dead = readHostTerminationEvidence(profile, root)
    // The successor, handed the same pid, has published its discovery but
    // holds no lease yet (or lost it): only the discovery's start tells them apart.
    seed(profile, root, 91_007, { birth: 'c'.repeat(64), startedAt: '2026-09-23T01:00:04.000Z' })
    const removed = await sweepHostArtefacts(profile, { ...dead, registry: null }, root, {
      socketIsLive: async () => true
    })
    expect(removed).toEqual([])
    expect(existsSync(taskWraithHostDiscoveryPath(profile))).toBe(true)
    expect(existsSync(taskWraithHostTokenPath(profile))).toBe(true)
  })

  it.skipIf(process.platform === 'win32')(
    'never unlinks a socket re-bound while the dead one was being probed',
    async () => {
      const profile = scratch('host-termination-rebound-')
      const root = join(scratch('host-termination-registry-'), 'hosts')
      seed(profile, root, 91_006)
      const dead = readHostTerminationEvidence(profile, root)
      const socketPath = taskWraithHostSocketPath(profile)
      const removed = await sweepHostArtefacts(profile, dead, root, {
        socketIsLive: async (probed) => {
          // The probe saw the dead socket; a starting Host then replaced it.
          unlinkSync(probed)
          writeFileSync(probed, 'rebound\n')
          return false
        }
      })
      expect(removed).toEqual(['registry', 'discovery', 'token'])
      expect(readFileSync(socketPath, 'utf8')).toBe('rebound\n')
    }
  )
})
