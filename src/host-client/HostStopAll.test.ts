import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  HOST_REGISTRY_SCHEMA,
  hostRegistryEntryId,
  hostRegistryEntryPath,
  sweepHostRegistry,
  type HostRegistryEntry,
  type HostRegistryListing
} from '../host-runtime/HostRegistry'
import type { ProcessBirthObservation } from '../host-runtime/ProcessBirthIdentity'
import {
  terminateHostProcess,
  type HostTerminationEvidence,
  type HostTerminationExpectedHost,
  type HostTerminationOutcome
} from './HostProcessTermination'
import {
  commandServesPayloadRoot,
  formatHostStopAllReport,
  isUnderPayloadRoot,
  stopAllHosts,
  type HostStopAllPorts,
  type HostStopAllScope
} from './HostStopAll'

const ROOT = '/registry/hosts'
const REPO_PAYLOAD = '/repo/out/host'
const APP_PAYLOAD = '/Applications/TaskWraith.app/Contents/Resources/host'
const BORN = (seed: string): string => seed.repeat(64)

function entry(
  profilePath: string,
  pid: number,
  cliPath: string | null,
  birthIdentity: string | null
): HostRegistryEntry {
  return {
    schema: HOST_REGISTRY_SCHEMA,
    profilePath,
    pid,
    birthIdentity,
    startedAt: '2026-09-23T00:00:04.000Z',
    hostId: `host-${pid}`,
    bootEpoch: null,
    payloadVersion: null,
    socketPath: `/tmp/twh2-501-${pid}/taskwraith-host-v2.sock`,
    discoveryPath: `${profilePath}/taskwraith-host-v2.json`,
    cliPath,
    nodeExecutable: '/usr/local/bin/node',
    persist: false,
    leaseMode: 'lease',
    writtenAt: '2026-09-23T00:00:04.000Z',
    beatSeq: 1,
    holders: 1,
    implicitHolders: 0,
    lifetimePhase: 'held'
  }
}

const DEV = entry('/profiles/dev', 101, `${REPO_PAYLOAD}/host-runtime/cli.js`, BORN('a'))
const VERIFY = entry('/profiles/verify', 102, `${REPO_PAYLOAD}/host-runtime/cli.js`, BORN('b'))
const APP = entry('/profiles/app', 103, `${APP_PAYLOAD}/host-runtime/cli.js`, BORN('c'))

const LEGACY_PROFILE = '/profiles/legacy app'
const LEGACY_PID = 201
const LEGACY_START = Date.UTC(2026, 8, 22, 13, 43, 18)
const LEGACY_COMMAND = `${APP_PAYLOAD}/../tui-runtime/darwin-arm64/node ${APP_PAYLOAD}/host-runtime/cli.js serve --mode production --profile ${LEGACY_PROFILE}`

const stopped = (pid: number): HostTerminationOutcome => ({
  kind: 'stopped',
  pid,
  steps: ['socket:stopping'],
  swept: []
})

function legacyEvidence(
  pid = LEGACY_PID,
  leaseStart = LEGACY_START + 109
): HostTerminationEvidence {
  return {
    discovery: {
      pid,
      socketPath: '/tmp/twh2-501-x/taskwraith-host-v2.sock',
      startedAt: new Date(LEGACY_START + 4_130).toISOString()
    },
    lease: {
      pid,
      processStartIdentity: `node:${pid}:172d23b8aef73`,
      processStartedAt: new Date(leaseStart).toISOString(),
      acquiredAt: new Date(leaseStart + 100).toISOString()
    },
    registry: null
  }
}

function ports(
  options: {
    readonly entries?: readonly HostRegistryEntry[]
    readonly processes?: readonly { readonly pid: number; readonly commandLine: string }[]
    readonly observe?: (pid: number) => ProcessBirthObservation
    readonly evidence?: (profilePath: string) => HostTerminationEvidence
  } = {}
): HostStopAllPorts & {
  readonly terminated: string[]
  readonly swept: string[]
  readonly sweptScopes: Array<readonly string[] | null>
} {
  const terminated: string[] = []
  const swept: string[] = []
  const sweptScopes: Array<readonly string[] | null> = []
  const entries = options.entries ?? [DEV, VERIFY, APP]
  const listing: HostRegistryListing = { root: ROOT, entries, unreadable: [] }
  return {
    terminated,
    swept,
    sweptScopes,
    readRegistry: () => listing,
    listProcesses: async () => ({ ok: true, processes: options.processes ?? [] }),
    observe: async (pid) => {
      if (options.observe) return options.observe(pid)
      const known = entries.find((candidate) => candidate.pid === pid)
      return known?.birthIdentity
        ? { state: 'live', birthIdentity: known.birthIdentity, startedAtMs: null }
        : { state: 'live', birthIdentity: BORN('f'), startedAtMs: LEGACY_START }
    },
    readEvidence: (profilePath) =>
      options.evidence
        ? options.evidence(profilePath)
        : { discovery: null, lease: null, registry: null },
    terminate: async ({ profilePath }) => {
      terminated.push(profilePath)
      const pid =
        entries.find((candidate) => candidate.profilePath === profilePath)?.pid ?? LEGACY_PID
      return stopped(pid)
    },
    sweep: async (root, profilePaths) => {
      swept.push(root)
      sweptScopes.push(profilePaths)
      return {
        removedEntries: [],
        keptEntries: [],
        removedSocketDirectories: [],
        keptSocketDirectories: []
      }
    }
  }
}

const scratchRoots: string[] = []
afterEach(() => {
  while (scratchRoots.length) rmSync(scratchRoots.pop()!, { recursive: true, force: true })
})

async function run(
  scope: HostStopAllScope,
  injected: ReturnType<typeof ports>,
  extra: {
    readonly scanArgv?: boolean
    readonly sweep?: boolean
    readonly expected?: HostTerminationExpectedHost
  } = {}
) {
  return stopAllHosts({ scope, registryRoot: ROOT, platform: 'darwin', ports: injected, ...extra })
}

describe('stopAllHosts', () => {
  it('lists every Host and stops nothing without a scope (exit 3)', async () => {
    const injected = ports()
    const report = await run({ kind: 'list' }, injected)
    expect(report.exitCode).toBe(3)
    expect(injected.terminated).toEqual([])
    expect(report.hosts.map((host) => [host.profilePath, host.liveness, host.selected])).toEqual([
      ['/profiles/dev', 'live', false],
      ['/profiles/verify', 'live', false],
      ['/profiles/app', 'live', false]
    ])
    expect(formatHostStopAllReport(report)).toContain(
      'Listed only: pass --all, --profile <path> or --payload-root <dir> to stop Hosts.'
    )
  })

  it('leaves Hosts serving another payload root alive', async () => {
    const injected = ports()
    const report = await run({ kind: 'payload-root', payloadRoot: REPO_PAYLOAD }, injected)
    expect(report.exitCode).toBe(0)
    expect(injected.terminated.sort()).toEqual(['/profiles/dev', '/profiles/verify'])
    expect(report.hosts.find((host) => host.profilePath === '/profiles/app')).toMatchObject({
      selected: false
    })
    expect(
      report.hosts.find((host) => host.profilePath === '/profiles/app')?.outcome
    ).toBeUndefined()
  })

  it('never matches a payload root by string prefix alone', async () => {
    const injected = ports({
      entries: [
        entry('/profiles/sibling', 104, '/repo/out/host-old/host-runtime/cli.js', BORN('d'))
      ]
    })
    await run({ kind: 'payload-root', payloadRoot: REPO_PAYLOAD }, injected)
    expect(injected.terminated).toEqual([])
    expect(
      isUnderPayloadRoot('/repo/out/host/host-runtime/cli.js', '/repo/out/host', 'darwin')
    ).toBe(true)
    expect(isUnderPayloadRoot(null, '/repo/out/host', 'darwin')).toBe(false)
  })

  it('stops one profile with --profile, and a profile the registry does not know by its own artefacts', async () => {
    const injected = ports()
    const report = await run({ kind: 'profile', profilePath: '/profiles/verify' }, injected)
    expect(injected.terminated).toEqual(['/profiles/verify'])
    expect(report.hosts.filter((host) => host.selected)).toHaveLength(1)
    const orphan = ports({
      evidence: () => legacyEvidence(301)
    })
    const orphanReport = await run({ kind: 'profile', profilePath: '/profiles/orphan' }, orphan)
    expect(orphan.terminated).toEqual(['/profiles/orphan'])
    expect(orphanReport.hosts.at(-1)).toMatchObject({
      source: 'profile',
      profilePath: '/profiles/orphan',
      pid: 301,
      birthIdentity: BORN('f'),
      selected: true
    })
  })

  it('stops every registry Host with --all and reports a refusal as exit 1', async () => {
    const injected = ports()
    injected.terminate = async ({ profilePath }) => {
      injected.terminated.push(profilePath)
      return profilePath === '/profiles/app'
        ? { kind: 'identity_unavailable', pid: 103, steps: [], swept: [] }
        : stopped(1)
    }
    const report = await run({ kind: 'all' }, injected)
    expect(injected.terminated.sort()).toEqual([
      '/profiles/app',
      '/profiles/dev',
      '/profiles/verify'
    ])
    expect(report.exitCode).toBe(1)
  })

  it('adds a pre-registry Host from argv only when discovery, lease and start time all agree', async () => {
    const processes = [
      { pid: LEGACY_PID, commandLine: LEGACY_COMMAND },
      // A decoy with look-alike argv whose profile names another pid.
      {
        pid: 202,
        commandLine: `/usr/local/bin/node -e setInterval(()=>{},1e3) ${APP_PAYLOAD}/host-runtime/cli.js serve --profile /profiles/decoy`
      },
      // A process started a minute after the lease was taken: a reused pid.
      {
        pid: 203,
        commandLine: `/usr/local/bin/node ${APP_PAYLOAD}/host-runtime/cli.js serve --profile /profiles/late`
      },
      // A registry Host is never double-listed.
      { pid: 101, commandLine: `/usr/local/bin/node ${DEV.cliPath} serve --profile /profiles/dev` },
      { pid: 204, commandLine: '/usr/sbin/cron' },
      // The lease names the pid with a matching start, but discovery names another.
      {
        pid: 205,
        commandLine: `/usr/local/bin/node ${APP_PAYLOAD}/host-runtime/cli.js serve --profile /profiles/stale-discovery`
      },
      // Discovery names the pid, but the lease names another.
      {
        pid: 206,
        commandLine: `/usr/local/bin/node ${APP_PAYLOAD}/host-runtime/cli.js serve --profile /profiles/stale-lease`
      }
    ]
    const injected = ports({
      processes,
      observe: (pid) => {
        if (pid === 203) {
          return { state: 'live', birthIdentity: BORN('9'), startedAtMs: LEGACY_START + 60_000 }
        }
        const known = [DEV, VERIFY, APP].find((candidate) => candidate.pid === pid)
        return known
          ? { state: 'live', birthIdentity: known.birthIdentity!, startedAtMs: null }
          : { state: 'live', birthIdentity: BORN('8'), startedAtMs: LEGACY_START }
      },
      evidence: (profilePath) => {
        if (profilePath === LEGACY_PROFILE) return legacyEvidence()
        if (profilePath === '/profiles/decoy') return legacyEvidence(999)
        if (profilePath === '/profiles/late') return legacyEvidence(203)
        if (profilePath === '/profiles/stale-discovery') {
          const evidence = legacyEvidence(205)
          return { ...evidence, discovery: { ...evidence.discovery!, pid: 999 } }
        }
        if (profilePath === '/profiles/stale-lease') {
          const evidence = legacyEvidence(206)
          return { ...evidence, lease: { ...evidence.lease!, pid: 999 } }
        }
        return { discovery: null, lease: null, registry: null }
      }
    })
    const report = await run({ kind: 'all' }, injected, { scanArgv: true })
    const byProfile = new Map(report.hosts.map((host) => [host.profilePath, host]))
    expect(byProfile.get(LEGACY_PROFILE)).toMatchObject({
      source: 'argv',
      pid: LEGACY_PID,
      liveness: 'live',
      selected: true,
      cliPath: `${APP_PAYLOAD}/host-runtime/cli.js`
    })
    expect(byProfile.get('/profiles/decoy')).toMatchObject({
      liveness: 'unverified',
      selected: false,
      note: 'discovery and lease do not both name this pid'
    })
    expect(byProfile.get('/profiles/late')).toMatchObject({
      liveness: 'unverified',
      selected: false,
      note: 'process start does not match the lease within 2 s'
    })
    for (const profile of ['/profiles/stale-discovery', '/profiles/stale-lease']) {
      expect(byProfile.get(profile)).toMatchObject({
        liveness: 'unverified',
        selected: false,
        note: 'discovery and lease do not both name this pid'
      })
    }
    expect(report.hosts.filter((host) => host.profilePath === '/profiles/dev')).toHaveLength(1)
    expect(injected.terminated).toEqual([
      '/profiles/dev',
      '/profiles/verify',
      '/profiles/app',
      LEGACY_PROFILE
    ])
    expect(report.scan).toEqual({ ok: true })
  })

  it('judges every scanned process for a profile, so a look-alike listed first never hides the Host', async () => {
    const processes = [
      // A wrapper with a lower pid naming the same profile: it matches neither
      // the discovery nor the lease.
      {
        pid: 150,
        commandLine: `/bin/sh -c node ${APP_PAYLOAD}/host-runtime/cli.js serve --profile ${LEGACY_PROFILE}`
      },
      { pid: LEGACY_PID, commandLine: LEGACY_COMMAND }
    ]
    const injected = ports({ entries: [], processes, evidence: () => legacyEvidence() })
    const report = await run({ kind: 'all' }, injected, { scanArgv: true })
    expect(report.hosts.map((host) => [host.pid, host.liveness, host.selected])).toEqual([
      [150, 'unverified', false],
      [LEGACY_PID, 'live', true]
    ])
    expect(injected.terminated).toEqual([LEGACY_PROFILE])
  })

  it('selects a scanned Host for --payload-root by the CLI path its argv names', async () => {
    const injected = ports({
      entries: [],
      processes: [{ pid: LEGACY_PID, commandLine: LEGACY_COMMAND }],
      evidence: () => legacyEvidence()
    })
    await run({ kind: 'payload-root', payloadRoot: REPO_PAYLOAD }, injected, { scanArgv: true })
    expect(injected.terminated).toEqual([])
    await run({ kind: 'payload-root', payloadRoot: APP_PAYLOAD }, injected, { scanArgv: true })
    expect(injected.terminated).toEqual([LEGACY_PROFILE])
  })

  it('reports an unavailable scan and never scans without --scan-argv', async () => {
    const listProcesses = vi.fn(async () => ({
      ok: false as const,
      reason: 'unsupported' as const
    }))
    const injected = { ...ports({ entries: [] }), listProcesses }
    const report = await run({ kind: 'all' }, injected, { scanArgv: true })
    expect(report.scan).toEqual({ ok: false, reason: 'unsupported' })
    expect(formatHostStopAllReport(report)).toContain('argv scan unavailable (unsupported)')
    listProcesses.mockClear()
    await run({ kind: 'all' }, injected)
    expect(listProcesses).not.toHaveBeenCalled()
  })

  it('classifies registry entries by pid and birth for the listing', async () => {
    const injected = ports({
      entries: [DEV, VERIFY, APP, entry('/profiles/blind', 105, null, null)],
      observe: (pid) => {
        if (pid === 101) return { state: 'dead' }
        if (pid === 102) return { state: 'live', birthIdentity: BORN('9'), startedAtMs: null }
        if (pid === 103) return { state: 'identity_unavailable' }
        return { state: 'live', birthIdentity: BORN('e'), startedAtMs: null }
      }
    })
    const report = await run({ kind: 'list' }, injected)
    expect(report.hosts.map((host) => host.liveness)).toEqual([
      'dead',
      'pid_reused',
      'identity_unavailable',
      'unverified'
    ])
    // Plan rows carry the recorded identity, including a missing birth; an
    // observation of the replacement process must never rewrite that target.
    expect(report.hosts.map((host) => host.birthIdentity)).toEqual([
      BORN('a'),
      BORN('b'),
      BORN('c'),
      null
    ])
  })

  it('leaves a scanned Host whose CLI merely ends with the payload root alive', async () => {
    // Discovery, lease and start all agree: only the payload root is wrong.
    const mirrored = `/usr/local/bin/node /Volumes/Backup${REPO_PAYLOAD}/host-runtime/cli.js serve --mode production --profile ${LEGACY_PROFILE}`
    const injected = ports({
      entries: [],
      processes: [{ pid: LEGACY_PID, commandLine: mirrored }],
      evidence: () => legacyEvidence()
    })
    const report = await run({ kind: 'payload-root', payloadRoot: REPO_PAYLOAD }, injected, {
      scanArgv: true
    })
    expect(report.hosts).toMatchObject([{ pid: LEGACY_PID, liveness: 'live', selected: false }])
    expect(injected.terminated).toEqual([])
  })

  it('never sweeps while it only lists, even when asked to', async () => {
    const injected = ports()
    const report = await run({ kind: 'list' }, injected, { sweep: true })
    expect(report.exitCode).toBe(3)
    expect(report.sweep).toBeUndefined()
    expect(injected.swept).toEqual([])
    expect(injected.terminated).toEqual([])
  })

  it('sweeps the registry after the terminations only when asked', async () => {
    const injected = ports()
    const quiet = await run({ kind: 'payload-root', payloadRoot: REPO_PAYLOAD }, injected)
    expect(quiet.sweep).toBeUndefined()
    expect(injected.swept).toEqual([])
    const swept = await run({ kind: 'payload-root', payloadRoot: REPO_PAYLOAD }, injected, {
      sweep: true
    })
    expect(injected.swept).toEqual([ROOT])
    expect(formatHostStopAllReport(swept)).toContain(
      'swept 0 registry entries and 0 socket directories'
    )
  })

  it('keeps a scoped --sweep to the selected Hosts, and sweeps every profile only with --all', async () => {
    const injected = ports()
    await run({ kind: 'payload-root', payloadRoot: REPO_PAYLOAD }, injected, { sweep: true })
    await run({ kind: 'profile', profilePath: '/profiles/app' }, injected, { sweep: true })
    await run({ kind: 'payload-root', payloadRoot: '/elsewhere/out/host' }, injected, {
      sweep: true
    })
    await run({ kind: 'all' }, injected, { sweep: true })
    expect(injected.sweptScopes).toEqual([
      ['/profiles/dev', '/profiles/verify'],
      ['/profiles/app'],
      [],
      null
    ])
  })

  it('leaves a dead record outside a scoped --sweep in place: registry entry and socket directory (S6)', async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'host-stop-all-sweep-')))
    scratchRoots.push(base)
    const root = join(base, 'hosts')
    const temporaryDirectory = join(base, 'tmp')
    const payloadRoot = join(base, 'repo', 'out', 'host')
    const inScope = join(base, 'profiles', 'dev')
    const outOfScope = join(base, 'profiles', 'app')
    const directory = (profile: string) =>
      join(temporaryDirectory, `twh2-501-${hostRegistryEntryId(profile)}`)
    const dead = async (): Promise<ProcessBirthObservation> => ({ state: 'dead' })
    const seed = (): void => {
      rmSync(root, { recursive: true, force: true })
      rmSync(temporaryDirectory, { recursive: true, force: true })
      mkdirSync(root, { recursive: true, mode: 0o700 })
      mkdirSync(temporaryDirectory, { recursive: true })
      // Both Hosts are gone: a crashed dev Host of this checkout, and the
      // production app's, whose entry the scope never selects.
      for (const [profile, record] of [
        [inScope, entry(inScope, 301, `${payloadRoot}/host-runtime/cli.js`, BORN('a'))],
        [outOfScope, entry(outOfScope, 302, `${APP_PAYLOAD}/host-runtime/cli.js`, BORN('c'))]
      ] as const) {
        writeFileSync(hostRegistryEntryPath(root, profile), `${JSON.stringify(record)}\n`, {
          mode: 0o600
        })
        mkdirSync(directory(profile))
      }
    }
    const stop = (scope: HostStopAllScope) =>
      stopAllHosts({
        scope,
        registryRoot: root,
        platform: 'darwin',
        sweep: true,
        ports: {
          observe: dead,
          // Termination sweeps nothing here: whatever goes, the sweep removed.
          terminate: async ({ profilePath }) => ({
            kind: 'already_gone',
            pid: profilePath === inScope ? 301 : 302,
            steps: [],
            swept: []
          }),
          sweep: (registryRoot, profilePaths) =>
            sweepHostRegistry({
              root: registryRoot,
              ...(profilePaths ? { profilePaths } : {}),
              platform: 'darwin',
              temporaryDirectory,
              uid: 501,
              observe: dead,
              socketIsLive: async () => false,
              now: () => Date.now() + 3_600_000
            })
        }
      })

    for (const scope of [
      { kind: 'payload-root', payloadRoot },
      { kind: 'profile', profilePath: inScope }
    ] as const) {
      seed()
      const report = await stop(scope)
      // Listed in entry-id order, which the random scratch path decides.
      expect(new Map(report.hosts.map((host) => [host.profilePath, host.selected]))).toEqual(
        new Map([
          [inScope, true],
          [outOfScope, false]
        ])
      )
      expect(report.sweep).toEqual({
        removedEntries: [hostRegistryEntryId(inScope)],
        keptEntries: [],
        removedSocketDirectories: [`twh2-501-${hostRegistryEntryId(inScope)}`],
        keptSocketDirectories: []
      })
      expect(existsSync(hostRegistryEntryPath(root, inScope))).toBe(false)
      expect(existsSync(directory(inScope))).toBe(false)
      expect(existsSync(hostRegistryEntryPath(root, outOfScope))).toBe(true)
      expect(existsSync(directory(outOfScope))).toBe(true)
    }

    // Only --all sweeps every profile's dead records.
    seed()
    const all = await stop({ kind: 'all' })
    expect([...(all.sweep?.removedEntries ?? [])].sort()).toEqual(
      [hostRegistryEntryId(inScope), hostRegistryEntryId(outOfScope)].sort()
    )
    expect(existsSync(directory(outOfScope))).toBe(false)
  })

  it('hands its own registry sweep the scope: a dead entry outside --profile is left in place (S6)', async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'host-stop-all-sweep-')))
    scratchRoots.push(base)
    const root = join(base, 'hosts')
    const inScope = join(base, 'profiles', 'dev')
    const outOfScope = join(base, 'profiles', 'app')
    // A pid nothing runs at any more: both Hosts are gone.
    const exited = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
    await new Promise((resolve) => exited.once('exit', resolve))
    const gone = exited.pid!
    mkdirSync(root, { mode: 0o700 })
    for (const profile of [inScope, outOfScope]) {
      writeFileSync(
        hostRegistryEntryPath(root, profile),
        `${JSON.stringify(entry(profile, gone, `${APP_PAYLOAD}/host-runtime/cli.js`, BORN('a')))}\n`,
        { mode: 0o600 }
      )
    }
    const report = await stopAllHosts({
      scope: { kind: 'profile', profilePath: inScope },
      registryRoot: root,
      // Windows: the default sweep then leaves the real temp directory's
      // socket directories alone, and judges only these entries.
      platform: 'win32',
      sweep: true,
      ports: {
        observe: async () => ({ state: 'dead' }),
        terminate: async () => ({ kind: 'already_gone', pid: gone, steps: [], swept: [] })
      }
    })
    expect(report.sweep).toEqual({
      removedEntries: [hostRegistryEntryId(inScope)],
      keptEntries: [],
      removedSocketDirectories: [],
      keptSocketDirectories: []
    })
    expect(existsSync(hostRegistryEntryPath(root, inScope))).toBe(false)
    expect(existsSync(hostRegistryEntryPath(root, outOfScope))).toBe(true)
  })

  it('hands termination the pid and birth each selected entry names under --payload-root, and nothing under --profile or --all (S1b)', async () => {
    const inputs: Array<Parameters<HostStopAllPorts['terminate']>[0]> = []
    const injected = ports()
    injected.terminate = async (input) => {
      inputs.push(input)
      return stopped(1)
    }
    await run({ kind: 'payload-root', payloadRoot: REPO_PAYLOAD }, injected)
    expect(inputs).toStrictEqual([
      {
        profilePath: '/profiles/dev',
        registryRoot: ROOT,
        expected: { pid: 101, birthIdentity: BORN('a') }
      },
      {
        profilePath: '/profiles/verify',
        registryRoot: ROOT,
        expected: { pid: 102, birthIdentity: BORN('b') }
      }
    ])
    // --profile and --all stop whichever Host holds each profile now.
    inputs.length = 0
    await run({ kind: 'profile', profilePath: '/profiles/verify' }, injected)
    await run({ kind: 'all' }, injected)
    expect(inputs).toStrictEqual([
      { profilePath: '/profiles/verify', registryRoot: ROOT },
      { profilePath: '/profiles/dev', registryRoot: ROOT },
      { profilePath: '/profiles/verify', registryRoot: ROOT },
      { profilePath: '/profiles/app', registryRoot: ROOT }
    ])
    inputs.length = 0
    const expected = { pid: 102, birthIdentity: BORN('b') }
    await run({ kind: 'profile', profilePath: '/profiles/verify' }, injected, { expected })
    expect(inputs).toStrictEqual([
      { profilePath: '/profiles/verify', registryRoot: ROOT, expected }
    ])
  })

  it('rejects an expected Host outside profile scope before reading or mutating anything', async () => {
    const injected = ports()
    injected.readRegistry = vi.fn(injected.readRegistry)
    injected.terminate = vi.fn(injected.terminate)
    for (const scope of [
      { kind: 'list' },
      { kind: 'all' },
      { kind: 'payload-root', payloadRoot: REPO_PAYLOAD }
    ] as const) {
      await expect(
        run(scope, injected, {
          expected: { pid: 101, birthIdentity: BORN('a') }
        })
      ).rejects.toThrow('An expected Host requires profile scope.')
    }
    expect(injected.readRegistry).not.toHaveBeenCalled()
    expect(injected.terminate).not.toHaveBeenCalled()
  })

  it('does not borrow a successor discovery listener start for an expected fallback plan row', async () => {
    const injected = ports({
      entries: [],
      evidence: () => ({
        registry: null,
        lease: null,
        discovery: {
          pid: 5151,
          socketPath: '/tmp/replaced.sock',
          startedAt: '2026-09-24T01:00:00.000Z'
        }
      })
    })
    const expected = { pid: 4242, birthIdentity: BORN('e') }
    const report = await run({ kind: 'profile', profilePath: '/profiles/replaced' }, injected, {
      expected
    })
    expect(report.hosts).toMatchObject([{ ...expected, startedAt: null }])
  })

  it('reports the expected pid and birth when a profile has already lost every Host record', async () => {
    const empty = { registry: null, lease: null, discovery: null }
    const shutdown = vi.fn(async () => 'stopping' as const)
    const signal = vi.fn()
    for (const pid of [7, 4242, 98765]) {
      const expected = { pid, birthIdentity: BORN('e') }
      const injected = ports({ entries: [], observe: () => ({ state: 'dead' }) })
      injected.terminate = (input) =>
        terminateHostProcess({
          ...input,
          ports: {
            readEvidence: () => empty,
            observe: async () => ({ state: 'dead' }),
            shutdown,
            signal,
            sweep: async () => [],
            log: () => {}
          }
        })
      const report = await run({ kind: 'profile', profilePath: '/profiles/gone' }, injected, {
        expected
      })
      expect(report.exitCode).toBe(0)
      expect(report.hosts).toMatchObject([
        {
          source: 'profile',
          profilePath: '/profiles/gone',
          ...expected,
          selected: true,
          outcome: { kind: 'already_gone', pid, swept: [] }
        }
      ])
      expect(report.hosts).toHaveLength(1)
    }
    expect(shutdown).not.toHaveBeenCalled()
    expect(signal).not.toHaveBeenCalled()
  })

  it('hands termination a scanned Host by its pid and the birth observed while scanning, under --payload-root only (S1b)', async () => {
    const inputs: Array<Parameters<HostStopAllPorts['terminate']>[0]> = []
    const injected = ports({
      entries: [],
      processes: [{ pid: LEGACY_PID, commandLine: LEGACY_COMMAND }],
      evidence: () => legacyEvidence()
    })
    injected.terminate = async (input) => {
      inputs.push(input)
      return stopped(LEGACY_PID)
    }
    const report = await run({ kind: 'payload-root', payloadRoot: APP_PAYLOAD }, injected, {
      scanArgv: true
    })
    expect(report.hosts).toMatchObject([{ pid: LEGACY_PID, birthIdentity: BORN('f') }])
    await run({ kind: 'all' }, injected, { scanArgv: true })
    expect(inputs).toStrictEqual([
      {
        profilePath: LEGACY_PROFILE,
        registryRoot: ROOT,
        expected: { pid: LEGACY_PID, birthIdentity: BORN('f') }
      },
      { profilePath: LEGACY_PROFILE, registryRoot: ROOT }
    ])
  })

  it("under --payload-root notes the Host that took a gone entry's profile, and refuses a listed Host replaced before its stop (S1b)", async () => {
    const taken: HostTerminationOutcome = {
      kind: 'already_gone',
      pid: 101,
      steps: ['evidence:stale-registry', 'expected:dead', 'swept:registry'],
      swept: ['registry'],
      detail: 'another Host (pid 777) holds the profile now',
      heldBy: 777
    }
    const outside = 'another Host (pid 777) holds the profile now, outside this scope'
    const replaced =
      'another Host (pid 777) holds the profile now, not the expected one; it was left running'
    const cases: Array<readonly [HostRegistryEntry, ProcessBirthObservation, string]> = [
      [DEV, { state: 'dead' }, 'dead'],
      [DEV, { state: 'live', birthIdentity: BORN('9'), startedAtMs: null }, 'pid_reused'],
      [DEV, { state: 'live', birthIdentity: BORN('a'), startedAtMs: null }, 'live'],
      [DEV, { state: 'identity_unavailable' }, 'identity_unavailable'],
      [
        { ...DEV, birthIdentity: null },
        { state: 'live', birthIdentity: BORN('9'), startedAtMs: null },
        'unverified'
      ]
    ]
    for (const [listed, observation, liveness] of cases) {
      const injected = ports({ entries: [listed], observe: () => observation })
      injected.terminate = async () => taken
      const report = await run({ kind: 'payload-root', payloadRoot: REPO_PAYLOAD }, injected)
      const gone = liveness === 'dead' || liveness === 'pid_reused'
      expect(report.hosts).toStrictEqual([
        expect.objectContaining({
          liveness,
          outcome: gone ? taken : { ...taken, kind: 'inconsistent', detail: replaced },
          note: gone ? outside : replaced
        })
      ])
      expect(report.exitCode).toBe(gone ? 0 : 1)
      expect(formatHostStopAllReport(report)).toContain(
        gone ? `-> already_gone · (${outside})` : `-> inconsistent · (${replaced})`
      )
    }
    // Replaced by a Host that was handed the same pid: refused the same way.
    const reused: HostTerminationOutcome = { ...taken, kind: 'pid_reused', heldBy: 101 }
    const injected = ports({ entries: [DEV] })
    injected.terminate = async () => reused
    const report = await run({ kind: 'payload-root', payloadRoot: REPO_PAYLOAD }, injected)
    expect(report.exitCode).toBe(1)
    expect(report.hosts[0]?.outcome).toStrictEqual({
      ...reused,
      kind: 'inconsistent',
      detail:
        'another Host (pid 101) holds the profile now, not the expected one; it was left running'
    })
  })

  it("never stops, signals or sweeps the Host holding a selected entry's profile through verified termination, and --profile still stops it (S1b)", async () => {
    const holder = 777
    const evidence: HostTerminationEvidence = {
      registry: { pid: 101, birthIdentity: BORN('a'), bootEpoch: null },
      lease: {
        pid: holder,
        processStartIdentity: BORN('7'),
        processStartedAt: '2026-09-23T01:00:00.000Z',
        acquiredAt: '2026-09-23T01:00:00.100Z'
      },
      discovery: {
        pid: holder,
        socketPath: '/tmp/twh2-501-x/taskwraith-host-v2.sock',
        startedAt: '2026-09-23T01:00:04.000Z'
      }
    }
    // The entry's Host (101) is dead by the time termination runs; the
    // listing saw it dead, or alive a moment before it was replaced.
    const stop = async (
      scope: HostStopAllScope,
      listed: ProcessBirthObservation,
      expected?: HostTerminationExpectedHost,
      listedEntry = DEV
    ) => {
      const seen = { shutdowns: 0, signals: 0, sweeps: [] as HostTerminationEvidence[] }
      let clock = 0
      const report = await stopAllHosts({
        scope,
        ...(expected ? { expected } : {}),
        registryRoot: ROOT,
        platform: 'darwin',
        ports: {
          ...ports({ entries: [listedEntry], observe: () => listed }),
          terminate: (input) =>
            terminateHostProcess({
              ...input,
              platform: 'darwin',
              ports: {
                shutdown: async () => {
                  seen.shutdowns += 1
                  return 'stopping'
                },
                readEvidence: () => evidence,
                observe: async (pid) =>
                  pid === holder && seen.shutdowns === 0
                    ? { state: 'live', birthIdentity: BORN('7'), startedAtMs: null }
                    : { state: 'dead' },
                observeCommand: async () => ({ state: 'dead' }),
                signal: () => {
                  seen.signals += 1
                },
                sweep: async (_profile, dead) => {
                  seen.sweeps.push(dead)
                  return ['registry']
                },
                delay: async (ms) => {
                  clock += ms
                },
                now: () => clock
              }
            })
        }
      })
      return { report, seen }
    }
    const ownEntry = { registry: evidence.registry, lease: null, discovery: null }
    const payloadRoot: HostStopAllScope = { kind: 'payload-root', payloadRoot: REPO_PAYLOAD }

    const dead = await stop(payloadRoot, { state: 'dead' })
    expect(dead.report.exitCode).toBe(0)
    expect(dead.report.hosts).toMatchObject([
      {
        pid: 101,
        liveness: 'dead',
        outcome: { kind: 'already_gone', pid: 101, heldBy: holder, swept: ['registry'] },
        note: `another Host (pid ${holder}) holds the profile now, outside this scope`
      }
    ])
    expect(dead.seen).toEqual({ shutdowns: 0, signals: 0, sweeps: [ownEntry] })

    const race = await stop(payloadRoot, {
      state: 'live',
      birthIdentity: BORN('a'),
      startedAtMs: null
    })
    expect(race.report.exitCode).toBe(1)
    expect(race.report.hosts).toMatchObject([
      {
        pid: 101,
        liveness: 'live',
        outcome: {
          kind: 'inconsistent',
          pid: 101,
          heldBy: holder,
          detail: `another Host (pid ${holder}) holds the profile now, not the expected one; it was left running`
        }
      }
    ])
    expect(race.seen).toEqual({ shutdowns: 0, signals: 0, sweeps: [ownEntry] })

    // Explicit expected identity binds --profile too, even when the registry
    // already lists the replacement before this invocation begins.
    for (const listedEntry of [DEV, { ...DEV, pid: holder, birthIdentity: BORN('7') }]) {
      const guarded = await stop(
        { kind: 'profile', profilePath: '/profiles/dev' },
        { state: 'dead' },
        { pid: 101, birthIdentity: BORN('a') },
        listedEntry
      )
      expect(guarded.report.exitCode).toBe(1)
      expect(guarded.report.hosts).toMatchObject([
        {
          pid: 101,
          birthIdentity: BORN('a'),
          outcome: { kind: 'inconsistent', pid: 101, heldBy: holder }
        }
      ])
      expect(guarded.seen).toEqual({ shutdowns: 0, signals: 0, sweeps: [ownEntry] })
    }

    // Control: --profile stops whichever Host holds the profile, here the holder.
    const profile = await stop({ kind: 'profile', profilePath: '/profiles/dev' }, { state: 'dead' })
    expect(profile.report.exitCode).toBe(0)
    expect(profile.report.hosts).toMatchObject([
      { pid: 101, outcome: { kind: 'stopped', pid: holder } }
    ])
    expect(profile.seen.shutdowns).toBe(1)
  })
})

describe('commandServesPayloadRoot', () => {
  it('matches only the CLI token that serve follows, anchored at both ends', () => {
    const root = '/Users/me/repo/out/host'
    const cli = `${root}/host-runtime/cli.js`
    expect(
      commandServesPayloadRoot(`/usr/local/bin/node ${cli} serve --profile /p`, root, 'darwin')
    ).toBe(true)
    expect(commandServesPayloadRoot(`${cli} serve --profile /p`, root, 'darwin')).toBe(true)
    expect(
      commandServesPayloadRoot(`/usr/local/bin/node "${cli}" serve --profile /p`, root, 'darwin')
    ).toBe(true)
    // Same suffix, another payload.
    expect(
      commandServesPayloadRoot(`node /Volumes/Backup${cli} serve --profile /p`, root, 'darwin')
    ).toBe(false)
    expect(commandServesPayloadRoot(`node /x${cli} serve --profile /p`, root, 'darwin')).toBe(false)
    // The needle appears on the line, but not as the CLI serve follows.
    expect(
      commandServesPayloadRoot(
        `node /other/host-runtime/cli.js serve --profile ${cli}`,
        root,
        'darwin'
      )
    ).toBe(false)
    expect(commandServesPayloadRoot(`node ${cli}.bak serve --profile /p`, root, 'darwin')).toBe(
      false
    )
    expect(commandServesPayloadRoot(`node ${cli} stop --profile /p`, root, 'darwin')).toBe(false)
  })

  it('matches a quoted Windows CLI case-insensitively and no other drive', () => {
    const line =
      '"C:\\Program Files\\node.exe" "C:\\TW\\resources\\host\\host-runtime\\cli.js" serve --mode production --profile "C:\\Users\\x"'
    expect(commandServesPayloadRoot(line, 'C:\\TW\\resources\\host', 'win32')).toBe(true)
    expect(commandServesPayloadRoot(line, 'c:\\tw\\RESOURCES\\host', 'win32')).toBe(true)
    expect(commandServesPayloadRoot(line, 'D:\\TW\\resources\\host', 'win32')).toBe(false)
    expect(commandServesPayloadRoot(line, 'C:\\resources\\host', 'win32')).toBe(false)
  })
})

describe('isUnderPayloadRoot', () => {
  const temporary: string[] = []
  afterEach(() => {
    while (temporary.length) rmSync(temporary.pop()!, { recursive: true, force: true })
  })

  it('compares canonical paths, so a symlinked spelling of the root still matches', () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'host-stop-all-root-')))
    temporary.push(base)
    mkdirSync(join(base, 'out', 'host', 'host-runtime'), { recursive: true })
    const cli = join(base, 'out', 'host', 'host-runtime', 'cli.js')
    expect(isUnderPayloadRoot(cli, join(base, 'out', 'host'))).toBe(true)
    expect(isUnderPayloadRoot(cli, join(base, 'out', 'host', '..', 'host'))).toBe(true)
    expect(isUnderPayloadRoot(cli, join(base, 'out', 'hos'))).toBe(false)
  })
})
