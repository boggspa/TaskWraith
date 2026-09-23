import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  HOST_REGISTRY_SCHEMA,
  type HostRegistryEntry,
  type HostRegistryListing
} from '../host-runtime/HostRegistry'
import type { ProcessBirthObservation } from '../host-runtime/ProcessBirthIdentity'
import type { HostTerminationEvidence, HostTerminationOutcome } from './HostProcessTermination'
import {
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
): HostStopAllPorts & { readonly terminated: string[]; readonly swept: string[] } {
  const terminated: string[] = []
  const swept: string[] = []
  const entries = options.entries ?? [DEV, VERIFY, APP]
  const listing: HostRegistryListing = { root: ROOT, entries, unreadable: [] }
  return {
    terminated,
    swept,
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
    sweep: async (root) => {
      swept.push(root)
      return {
        removedEntries: [],
        keptEntries: [],
        removedSocketDirectories: [],
        keptSocketDirectories: []
      }
    }
  }
}

async function run(
  scope: HostStopAllScope,
  injected: ReturnType<typeof ports>,
  extra: { readonly scanArgv?: boolean; readonly sweep?: boolean } = {}
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
