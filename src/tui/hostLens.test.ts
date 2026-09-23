import { describe, expect, it } from 'vitest'

import type { HostTerminationOutcome } from '../host-client/HostProcessTermination'
import type { HostStopAllHost } from '../host-client/HostStopAll'
import { parseHostProductionCli } from '../host-runtime/HostProductionCli'
import type { HostStatusProjection } from '../shared/hostProtocol'
import {
  buildHostStatusPanel,
  buildRestartConfirmPanel,
  buildStopAllPlanPanel,
  buildStopAllResultPanel,
  formatHostUptime,
  hostIdentitySegments,
  parseTuiHostCommand,
  shortPayloadVersion,
  tokenizeTuiHostArguments
} from './hostLens'
import type { TuiHostStopAllPlan, TuiHostStopAllRequest } from './hostProcessManager'

const PAYLOAD = `sha256:${'0123456789abcdef'.repeat(4)}`
const OWN = '/Users/a/Library/Application Support/TaskWraith'

function status(overrides: Partial<HostStatusProjection> = {}): HostStatusProjection {
  return {
    pid: 4242,
    startedAt: new Date(0).toISOString(),
    uptimeMs: 3 * 3_600_000 + 12 * 60_000,
    hostId: 'host-1',
    payloadVersion: PAYLOAD,
    profilePath: OWN,
    persist: false,
    lifetime: { phase: 'held', holders: 2, implicitHolders: 1, declined: 0 },
    liveWork: { runs: 0 },
    clients: [],
    ...overrides
  }
}

function row(
  profilePath: string,
  pid: number | null,
  overrides: Partial<HostStopAllHost> = {}
): HostStopAllHost {
  return {
    source: 'registry',
    profilePath,
    pid,
    cliPath: '/payload/host-runtime/cli.js',
    payloadVersion: PAYLOAD,
    startedAt: new Date(0).toISOString(),
    holders: 1,
    implicitHolders: 0,
    persist: false,
    liveness: 'live',
    selected: true,
    ...overrides
  }
}

function plan(
  request: TuiHostStopAllRequest,
  hosts: readonly HostStopAllHost[]
): TuiHostStopAllPlan {
  return {
    request,
    registryRoot: '/registry',
    hosts,
    selected: hosts.filter((host) => host.selected),
    unreadableEntries: 0,
    fingerprint: 'fingerprint'
  }
}

function outcome(kind: HostTerminationOutcome['kind'], detail?: string): HostTerminationOutcome {
  return { kind, pid: 1, steps: [], swept: [], ...(detail ? { detail } : {}) }
}

describe('/host arguments', () => {
  it('keeps an unquoted profile with spaces whole, up to the next flag', () => {
    expect(tokenizeTuiHostArguments(`stop-all --profile ${OWN}`)).toEqual([
      'stop-all',
      '--profile',
      OWN
    ])
    expect(tokenizeTuiHostArguments(`stop-all --profile ${OWN}   --scan-argv`)).toEqual([
      'stop-all',
      '--profile',
      OWN,
      '--scan-argv'
    ])
    expect(tokenizeTuiHostArguments('stop-all --payload-root "/Volumes/A B/out/host"')).toEqual([
      'stop-all',
      '--payload-root',
      '/Volumes/A B/out/host'
    ])
    expect(tokenizeTuiHostArguments("stop-all --profile '/x y' --all")).toEqual([
      'stop-all',
      '--profile',
      '/x y',
      '--all'
    ])
    expect(tokenizeTuiHostArguments('  restart  ')).toEqual(['restart'])
    expect(tokenizeTuiHostArguments('')).toEqual([])
  })

  it('reads a bare /host and status as the status lens, and restart as itself', () => {
    expect(parseTuiHostCommand('')).toEqual({ verb: 'status' })
    expect(parseTuiHostCommand('status')).toEqual({ verb: 'status' })
    expect(parseTuiHostCommand('restart')).toEqual({ verb: 'restart' })
    expect(parseTuiHostCommand('restart now')).toEqual({
      verb: 'invalid',
      message: '/host restart takes no arguments.'
    })
    expect(parseTuiHostCommand('status --all')).toEqual({
      verb: 'invalid',
      message: '/host status takes no arguments.'
    })
    expect(parseTuiHostCommand('reboot')).toEqual({
      verb: 'invalid',
      message: '/host expects status, restart or stop-all, not "reboot".'
    })
  })

  it('never defaults stop-all to --all: without a scope it only lists', () => {
    expect(parseTuiHostCommand('stop-all')).toEqual({
      verb: 'stop-all',
      request: { scope: { kind: 'list' }, scanArgv: false }
    })
    expect(parseTuiHostCommand('stop-all --scan-argv')).toEqual({
      verb: 'stop-all',
      request: { scope: { kind: 'list' }, scanArgv: true }
    })
  })

  it('scopes stop-all exactly as `cli.js stop-all` parses the same arguments', () => {
    for (const text of [
      'stop-all',
      'stop-all --all',
      'stop-all --all --scan-argv',
      `stop-all --profile ${OWN}`,
      'stop-all --scan-argv --payload-root /opt/TaskWraith/out/host'
    ]) {
      const tokens = tokenizeTuiHostArguments(text)
      const cli = parseHostProductionCli(tokens)
      if (cli.command !== 'stop-all') throw new Error(`${text} did not parse as stop-all`)
      expect(parseTuiHostCommand(text)).toEqual({
        verb: 'stop-all',
        request: { scope: cli.scope, scanArgv: cli.scanArgv }
      })
    }
  })

  it('refuses what the CLI refuses, without its usage block', () => {
    const refused = (text: string): string => {
      const command = parseTuiHostCommand(text)
      if (command.verb !== 'invalid') throw new Error(`${text} was accepted`)
      expect(command.message).not.toContain('Usage:')
      return command.message
    }
    expect(refused('stop-all --all --profile /x')).toBe(
      '--all, --profile and --payload-root are mutually exclusive.'
    )
    expect(refused('stop-all --profile relative/path')).toBe(
      '--profile must be an absolute canonical path.'
    )
    expect(refused('stop-all --profile /')).toBe(
      '--profile must be an absolute canonical non-root path.'
    )
    expect(refused('stop-all --profile')).toBe('--profile requires one value.')
    expect(refused('stop-all --everything')).toBe('Unknown argument "--everything".')
  })

  it('refuses --sweep and --json, which the TUI never passes on', () => {
    expect(parseTuiHostCommand('stop-all --all --sweep')).toEqual({
      verb: 'invalid',
      message:
        '--sweep is not offered here: each stopped Host removes its own records, and taskwraith-host stop-all --sweep clears the rest.'
    })
    expect(parseTuiHostCommand('stop-all --json')).toEqual({
      verb: 'invalid',
      message: '--json is for taskwraith-host stop-all.'
    })
  })
})

describe('/status Host segments', () => {
  it('formats uptime from the Host’s own clock, largest two units', () => {
    expect(formatHostUptime(-5)).toBe('0s')
    expect(formatHostUptime(59_999)).toBe('59s')
    expect(formatHostUptime(60_000)).toBe('1m 0s')
    expect(formatHostUptime(3_600_000)).toBe('1h 0m')
    expect(formatHostUptime(3 * 3_600_000 + 12 * 60_000)).toBe('3h 12m')
    expect(formatHostUptime(26 * 3_600_000)).toBe('1d 2h')
  })

  it('shortens a sha256 payload to twelve hex digits and leaves anything else alone', () => {
    expect(shortPayloadVersion(PAYLOAD)).toBe('sha256:0123456789ab')
    expect(shortPayloadVersion('development')).toBe('development')
  })

  it('adds pid, uptime, holders and payload, and leaves out what is not known', () => {
    expect(
      hostIdentitySegments({
        identity: { pid: 42, startedAt: 'x', payloadVersion: PAYLOAD },
        status: status(),
        lease: 'held'
      })
    ).toEqual(['pid 42', 'up 3h 12m', 'holders 2 (1 implicit)', 'payload sha256:0123456789ab'])
    expect(
      hostIdentitySegments({
        identity: null,
        status: status({
          lifetime: { phase: 'held', holders: 1, implicitHolders: 0, declined: 0 }
        }),
        lease: 'held'
      })
    ).toEqual(['pid 4242', 'up 3h 12m', 'holders 1', 'payload sha256:0123456789ab'])
    expect(hostIdentitySegments({ identity: null, status: null, lease: 'none' })).toEqual([])
  })

  it('names a Host from before leases in separate segments, so --ascii can join them', () => {
    const segments = hostIdentitySegments({
      identity: { pid: 42, startedAt: 'x' },
      status: null,
      lease: 'legacy'
    })
    expect(segments).toEqual(['pid 42', 'Host predates leases', '/host restart upgrades it'])
    expect(segments.join(' ')).not.toContain('·')
  })
})

describe('/host lens panels', () => {
  it('shows the Host as it reports itself, with this TUI’s lease', () => {
    const panel = buildHostStatusPanel({
      profilePath: OWN,
      connected: true,
      identity: { pid: 42, startedAt: 'x', payloadVersion: PAYLOAD },
      status: status({
        persist: true,
        lifetime: {
          phase: 'grace',
          graceRemainingMs: 30_000,
          holders: 0,
          implicitHolders: 0,
          declined: 2
        },
        liveWork: { runs: 3 },
        clients: [
          {
            clientClass: 'desktop',
            clientId: 'main',
            connectedForMs: 5_000,
            lease: 'declined',
            capabilities: []
          }
        ]
      }),
      lease: 'held'
    })
    expect(panel.fields).toEqual([
      { label: 'pid', value: '42' },
      { label: 'uptime', value: '3h 12m' },
      {
        label: 'lifetime',
        value: 'grace · exits in 30s unless a client holds it',
        tone: 'warning'
      },
      { label: 'holders', value: '0 · 2 declined' },
      { label: 'live runs', value: '3' },
      { label: 'persist', value: 'on · the last-lease exit is disabled' },
      { label: 'this TUI', value: 'holds a lease', tone: 'good' },
      { label: 'payload', value: 'sha256:0123456789ab' },
      { label: 'profile', value: OWN },
      { label: 'client', value: 'desktop · main · lease declined · 5s' }
    ])
    expect(panel.prompt).toBeUndefined()
  })

  it('says when it is not connected, why the status is missing, and what a legacy Host needs', () => {
    const panel = buildHostStatusPanel({
      profilePath: OWN,
      connected: false,
      identity: null,
      status: null,
      statusError: 'This Host predates host.status; /host restart upgrades it.',
      lease: 'legacy'
    })
    expect(panel.fields).toEqual([
      { label: 'connection', value: 'not connected', tone: 'warning' },
      {
        label: 'this TUI',
        value: 'Host predates leases · /host restart upgrades it',
        tone: 'warning'
      },
      { label: 'profile', value: OWN }
    ])
    expect(panel.notes).toEqual(['This Host predates host.status; /host restart upgrades it.'])
  })

  it('lists every Host without a scope, arms nothing, and says how to stop', () => {
    const panel = buildStopAllPlanPanel(
      plan({ scope: { kind: 'list' }, scanArgv: false }, [
        row(OWN, 42, { selected: false }),
        row('/profiles/b', null, { selected: false, liveness: 'dead', holders: null })
      ]),
      OWN
    )
    expect(panel.title).toBe('Hosts')
    expect(panel.prompt).toBeUndefined()
    expect(panel.hostsHeading).toBe('2 Hosts found')
    expect(panel.hosts).toEqual([
      { pid: 'pid 42', holders: 'holders 1+0', profile: OWN, note: 'this TUI' },
      { pid: 'pid ?', holders: 'holders ?', profile: '/profiles/b', note: 'dead', tone: 'warning' }
    ])
    expect(panel.notes).toEqual([
      'Listed only: pass --all, --profile <path> or --payload-root <dir> to stop Hosts.'
    ])
  })

  it('states the total an armed y stops, what stays running, and when its own Host is included', () => {
    const panel = buildStopAllPlanPanel(
      plan({ scope: { kind: 'all' }, scanArgv: true }, [
        row(OWN, 42),
        row('/profiles/b', 43),
        row('/profiles/c', 44),
        row('/profiles/d', 45, { selected: false })
      ]),
      OWN
    )
    expect(panel.title).toBe('Stop Hosts')
    expect(panel.fields).toEqual([
      { label: 'scope', value: 'every Host (--all)' },
      { label: 'registry', value: '/registry' },
      { label: 'argv scan', value: 'on' }
    ])
    expect(panel.hostsHeading).toBe('Stops 3 Hosts')
    expect(panel.hosts?.map((host) => host.pid)).toEqual(['pid 42', 'pid 43', 'pid 44'])
    expect(panel.prompt).toBe('y stops all 3 Hosts · any other key cancels')
    expect(panel.notes).toEqual([
      '1 other Host outside this scope keeps running.',
      "This TUI's own Host is included; the TUI stays offline until /host restart."
    ])
    expect(panel.hint).toBe('Nothing is stopped unless you press y.')
  })

  it('names one Host as this Host, and arms nothing when the scope matches none', () => {
    const one = buildStopAllPlanPanel(
      plan({ scope: { kind: 'profile', profilePath: '/profiles/b' }, scanArgv: false }, [
        row('/profiles/b', 43),
        row('/profiles/c', 44, { selected: false }),
        row('/profiles/d', 45, { selected: false })
      ]),
      OWN
    )
    expect(one.prompt).toBe('y stops this Host · any other key cancels')
    expect(one.notes).toEqual(['2 other Hosts outside this scope keep running.'])

    const none = buildStopAllPlanPanel(
      plan({ scope: { kind: 'payload-root', payloadRoot: '/opt/tw' }, scanArgv: true }, [
        row('/profiles/c', 44, { selected: false })
      ]),
      OWN
    )
    expect(none.prompt).toBeUndefined()
    expect(none.hostsHeading).toBe('No Host matches this scope')
  })

  it('reports unreadable registry entries and an unavailable argv scan', () => {
    const panel = buildStopAllPlanPanel(
      {
        ...plan({ scope: { kind: 'all' }, scanArgv: true }, [row('/profiles/b', 43)]),
        unreadableEntries: 1,
        scanUnavailable: 'ps is unavailable'
      },
      OWN
    )
    expect(panel.fields).toContainEqual({
      label: 'argv scan',
      value: 'unavailable (ps is unavailable)'
    })
    expect(panel.notes?.[0]).toBe('1 registry entry could not be read.')
  })

  it('reports each Host’s outcome, and a registry change as a refusal that stopped nothing', () => {
    const done = buildStopAllResultPanel(
      {
        kind: 'done',
        results: [
          { host: row(OWN, 42), outcome: outcome('terminated') },
          { host: row('/profiles/b', 43), outcome: outcome('not_a_host', 'pid runs vim') }
        ]
      },
      OWN
    )
    expect(done.hostsHeading).toBe('Stopped 1 of 2; 1 Host refused')
    expect(done.hosts).toEqual([
      {
        pid: 'pid 42',
        holders: 'holders 1+0',
        profile: OWN,
        note: 'this TUI · terminated',
        tone: 'good'
      },
      {
        pid: 'pid 43',
        holders: 'holders 1+0',
        profile: '/profiles/b',
        note: 'not_a_host (pid runs vim)',
        tone: 'error'
      }
    ])
    expect(done.notes).toEqual(['A refused Host keeps running; its row says why.'])

    const changed = buildStopAllResultPanel(
      { kind: 'registry_changed', fresh: plan({ scope: { kind: 'all' }, scanArgv: false }, []) },
      OWN
    )
    expect(changed.hosts).toBeUndefined()
    expect(changed.notes).toEqual([
      'The Host registry changed after the list was shown. Nothing was stopped.'
    ])
  })

  it('asks before a restart that ends live runs, naming how many', () => {
    expect(buildRestartConfirmPanel({ pid: 42, profilePath: OWN, liveRuns: 1 }).prompt).toBe(
      'y restarts the Host and ends 1 live run · any other key cancels'
    )
    expect(buildRestartConfirmPanel({ pid: null, profilePath: OWN, liveRuns: 3 })).toMatchObject({
      fields: [
        { label: 'pid', value: 'unknown' },
        { label: 'profile', value: OWN },
        { label: 'live runs', value: '3', tone: 'warning' }
      ],
      prompt: 'y restarts the Host and ends 3 live runs · any other key cancels'
    })
  })
})
