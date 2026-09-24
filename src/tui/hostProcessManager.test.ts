import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import {
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'

import { HostProjectionIncompatibleProtocolError } from '../main/host/HostProjectionClient'
import {
  terminateHostProcess,
  type HostTerminationEvidence,
  type HostTerminationOutcome,
  type HostTerminationPorts
} from '../host-client/HostProcessTermination'
import { stopAllHosts, type HostStopAllOptions } from '../host-client/HostStopAll'
import {
  HOST_FULL_ACCESS_BOOTSTRAP_FD,
  HOST_FULL_ACCESS_BOOTSTRAP_FD_ENV,
  hostFullAccessBootstrapFrame
} from '../host-runtime/HostFullAccessBootstrap'
import {
  HOST_REGISTRY_SCHEMA,
  hostRegistryEntryPath,
  type HostRegistryEntry,
  type HostRegistryListing
} from '../host-runtime/HostRegistry'
import type { ProcessBirthObservation } from '../host-runtime/ProcessBirthIdentity'
import {
  assertTuiStandaloneHostWelcome,
  ensureTuiHostAvailable,
  planTuiHostStopAll,
  resolveTuiHostLaunchCommand,
  restartTuiHost,
  runTuiHostStopAll,
  TuiHostProductionCapabilityError,
  TUI_STANDALONE_HOST_CAPABILITY_FLOOR,
  TUI_STANDALONE_HOST_PRODUCTION_VERSION,
  type EnsureTuiHostAvailableInput,
  type TuiHostAuthenticatedProbe,
  type TuiHostLaunchCommand,
  type TuiHostStopAllRequest
} from './hostProcessManager'
import type { HostBootstrapWelcome } from '../shared/hostProtocol'

const STALE_PAYLOAD = `sha256:${'a'.repeat(64)}`
const FRESH_PAYLOAD = `sha256:${'b'.repeat(64)}`

/**
 * The port-call order `ensureTuiHostAvailable` made when it replaced a stale
 * Host by bare SIGTERM, captured from that implementation at a3f48c3b9, before
 * verified termination replaced it. The only permitted difference is the stop
 * itself.
 */
const PRE_VERIFICATION_STALE_REPLACEMENT_CALLS = [
  'probe:/profiles/stale',
  'resolveLaunchCommand',
  'resolvePayloadVersion',
  'stopProcess:4242',
  'delay',
  'probe:/profiles/stale',
  'openHostStderrLog:/profiles/stale',
  'spawn:/resources/tui-runtime/darwin-arm64/node',
  'delay',
  'probe:/profiles/stale'
]

function outcome(
  kind: HostTerminationOutcome['kind'],
  pid: number | null = 4242
): HostTerminationOutcome {
  return { kind, pid, steps: [`test:${kind}`], swept: [] }
}

class FakeChild extends EventEmitter {
  pid = 42
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  unref = vi.fn()
  readonly bootstrapChunks: Buffer[] = []
  readonly stdio: Array<null | NodeJS.ReadableStream | NodeJS.WritableStream>

  constructor(bootstrapPipe: Writable = new PassThrough()) {
    super()
    const readable = bootstrapPipe as Writable & NodeJS.ReadableStream
    readable.on?.('data', (chunk: Buffer) => this.bootstrapChunks.push(Buffer.from(chunk)))
    this.stdio = [null, null, null, bootstrapPipe]
  }

  asChildProcess(): ChildProcess {
    return this as unknown as ChildProcess
  }
}

function authenticatedProbe(pid = 42): TuiHostAuthenticatedProbe {
  const welcome = {
    hostVersion: TUI_STANDALONE_HOST_PRODUCTION_VERSION,
    hostId: 'host-1',
    capabilities: [...TUI_STANDALONE_HOST_CAPABILITY_FLOOR]
  } as HostBootstrapWelcome
  return {
    welcome,
    process: {
      pid,
      startedAt: '2026-08-30T00:00:00.000Z',
      hostId: welcome.hostId,
      hostVersion: welcome.hostVersion
    }
  }
}

function command(): TuiHostLaunchCommand {
  return {
    executable: '/resources/tui-runtime/darwin-arm64/node',
    args: [
      '/resources/host/host-runtime/cli.js',
      'serve',
      '--mode',
      'production',
      '--profile',
      '/profiles/a'
    ],
    cwd: '/resources/host/host-runtime',
    env: {}
  }
}

function withPayload(pid: number, payloadVersion: string): TuiHostAuthenticatedProbe {
  const probe = authenticatedProbe(pid)
  return { ...probe, process: { ...probe.process, payloadVersion } }
}

/**
 * The stale-replacement scenario with every port recorded in call order, the
 * same ports the pre-verification golden was captured through: a Host on an
 * older payload answers first, is gone on the next probe, and the relaunched
 * Host answers after that.
 */
function recordedStaleReplacement(
  calls: string[],
  child: FakeChild,
  overrides: Partial<EnsureTuiHostAvailableInput> = {}
): EnsureTuiHostAvailableInput {
  const answers = [
    async () => withPayload(4242, STALE_PAYLOAD),
    async () => {
      throw new Error('offline')
    },
    async () => withPayload(42, FRESH_PAYLOAD)
  ]
  let probes = 0
  return {
    userDataPath: '/profiles/stale',
    profile: 'development',
    probe: async (path) => {
      calls.push(`probe:${path}`)
      const answer = answers[Math.min(probes, answers.length - 1)]
      probes += 1
      return answer()
    },
    spawn: (executable) => {
      calls.push(`spawn:${executable}`)
      return child.asChildProcess()
    },
    resolveLaunchCommand: async () => {
      calls.push('resolveLaunchCommand')
      return command()
    },
    resolvePayloadVersion: async () => {
      calls.push('resolvePayloadVersion')
      return FRESH_PAYLOAD
    },
    openHostStderrLog: (path) => {
      calls.push(`openHostStderrLog:${path}`)
      return null
    },
    delay: async () => {
      calls.push('delay')
    },
    ...overrides
  }
}

const EVIDENCE_STARTED_AT = '2026-08-30T00:00:00.000Z'
const RECORDED_BIRTH = 'a'.repeat(64)

/** The records a stale Host at pid 4242 left: discovery, authority lease and registry entry. */
function staleHostEvidence(): HostTerminationEvidence {
  return {
    discovery: {
      pid: 4242,
      socketPath: '/tmp/twh2-test/taskwraith-host-v2.sock',
      startedAt: EVIDENCE_STARTED_AT
    },
    lease: {
      pid: 4242,
      processStartIdentity: RECORDED_BIRTH,
      processStartedAt: EVIDENCE_STARTED_AT,
      acquiredAt: EVIDENCE_STARTED_AT
    },
    registry: { pid: 4242, birthIdentity: RECORDED_BIRTH, bootEpoch: null }
  }
}

/**
 * Real verified termination over injected observation ports: the socket stop
 * is refused, so every decision after it rests on what `observe` says the pid
 * is now. Nothing here touches a real process or the filesystem.
 */
function verifiedTermination(
  observe: (pid: number) => Promise<ProcessBirthObservation>,
  signal: HostTerminationPorts['signal']
): EnsureTuiHostAvailableInput['terminateHost'] {
  let clock = 0
  return (request) =>
    terminateHostProcess({
      ...request,
      registryRoot: '/registry/unused',
      ports: {
        shutdown: async () => {
          throw new Error('connect ECONNREFUSED')
        },
        readEvidence: () => staleHostEvidence(),
        observe,
        observeCommand: async () => ({
          state: 'live',
          commandLine:
            '/usr/local/bin/node /repo/out/host/host-runtime/cli.js serve --mode production --profile /profiles/stale',
          argv: null
        }),
        signal,
        sweep: async () => [],
        delay: async () => undefined,
        now: () => (clock += 250)
      }
    })
}

describe('TUI Host process manager', () => {
  it('accepts only the standalone production version with the complete capability floor', () => {
    const welcome = (overrides: Partial<HostBootstrapWelcome> = {}) =>
      ({
        hostVersion: TUI_STANDALONE_HOST_PRODUCTION_VERSION,
        capabilities: [...TUI_STANDALONE_HOST_CAPABILITY_FLOOR],
        ...overrides
      }) as HostBootstrapWelcome

    expect(() => assertTuiStandaloneHostWelcome(welcome({ hostVersion: '1.9.6' }))).toThrow(
      TuiHostProductionCapabilityError
    )
    expect(() =>
      assertTuiStandaloneHostWelcome(welcome({ capabilities: ['commands', 'receipts'] }))
    ).toThrow(TuiHostProductionCapabilityError)
    expect(() => assertTuiStandaloneHostWelcome(welcome())).not.toThrow()
  })

  it('resolves the packaged platform Node runtime and Host CLI without Electron', async () => {
    const executable =
      '/Applications/TaskWraith.app/Contents/Resources/tui-runtime/darwin-arm64/node'
    const cli = '/Applications/TaskWraith.app/Contents/Resources/host/host-runtime/cli.js'
    const result = await resolveTuiHostLaunchCommand({
      profile: 'production',
      platform: 'darwin',
      architecture: 'arm64',
      moduleDir: '/Applications/TaskWraith.app/Contents/Resources/tui/tui',
      env: { ELECTRON_RUN_AS_NODE: '1' },
      userDataPath: '/profiles/a',
      pathExists: async (path) => path === executable || path === cli
    })

    expect(result).toEqual({
      executable,
      args: [cli, 'serve', '--mode', 'production', '--profile', '/profiles/a'],
      cwd: '/Applications/TaskWraith.app/Contents/Resources/host/host-runtime',
      env: {}
    })
  })

  it('never hands a production Host the test-only lease knobs, and keeps the persist escape hatch', async () => {
    for (const profile of ['production', 'development', 'node-package'] as const) {
      const result = await resolveTuiHostLaunchCommand({
        profile,
        platform: 'darwin',
        architecture: 'arm64',
        moduleDir: '/repo/out/tui/tui',
        workingDirectory: '/repo',
        userDataPath: '/profiles/a',
        nodeExecutable: '/usr/local/bin/node',
        isOrdinaryNode: () => true,
        env: {
          PATH: '/usr/bin',
          TASKWRAITH_HOST_LEASE_TIMING: 'heartbeat:100,ttl:200,grace:500',
          TASKWRAITH_HOST_LEASE_DISABLED: '1',
          TASKWRAITH_HOST_PERSIST: '1'
        },
        pathExists: async () => true
      })
      expect(result?.env, profile).toEqual({ PATH: '/usr/bin', TASKWRAITH_HOST_PERSIST: '1' })
    }
  })

  it('resolves a built development Host through an injected ordinary Node executable', async () => {
    const executable = '/usr/local/bin/node'
    const cli = '/repo/out/host/host-runtime/cli.js'
    const required = new Set([executable, cli])
    const result = await resolveTuiHostLaunchCommand({
      profile: 'development',
      platform: 'darwin',
      moduleDir: '/repo/out/tui/tui',
      workingDirectory: '/elsewhere',
      userDataPath: '/profiles/dev',
      nodeExecutable: executable,
      env: { TASKWRAITH_INSTANCE_ID: 'qa-two' },
      pathExists: async (path) => required.has(path)
    })

    expect(result).toMatchObject({
      executable,
      cwd: '/repo/out/host/host-runtime',
      args: [cli, 'serve', '--mode', 'production', '--profile', '/profiles/dev'],
      env: { TASKWRAITH_INSTANCE_ID: 'qa-two' }
    })
  })

  it('resolves an npm-packaged Host through the invoking ordinary Node executable', async () => {
    const executable = '/opt/homebrew/bin/node'
    const cli = '/npm/taskwraith/dist/host/host-runtime/cli.js'
    const required = new Set([executable, cli])
    const result = await resolveTuiHostLaunchCommand({
      profile: 'node-package',
      platform: 'darwin',
      moduleDir: '/npm/taskwraith/dist/tui/tui',
      userDataPath: '/profiles/npm',
      nodeExecutable: executable,
      env: { ELECTRON_RUN_AS_NODE: '1', TASKWRAITH_CLI_PACKAGE: '1' },
      pathExists: async (path) => required.has(path)
    })

    expect(result).toEqual({
      executable,
      cwd: '/npm/taskwraith/dist/host/host-runtime',
      args: [cli, 'serve', '--mode', 'production', '--profile', '/profiles/npm'],
      env: { TASKWRAITH_CLI_PACKAGE: '1' }
    })
  })

  it('refuses an npm package launch through Electron', async () => {
    await expect(
      resolveTuiHostLaunchCommand({
        profile: 'node-package',
        platform: 'darwin',
        moduleDir: '/npm/taskwraith/dist/tui/tui',
        userDataPath: '/profiles/npm',
        nodeExecutable: '/Applications/Electron.app/Contents/MacOS/Electron',
        isOrdinaryNode: () => false,
        pathExists: async () => true
      })
    ).rejects.toThrow(/ordinary Node executable/)
  })

  it('uses Windows path semantics for packaged Node and Host CLI', async () => {
    const executable = 'C:\\Apps\\TaskWraith\\resources\\tui-runtime\\win32-x64\\node.exe'
    const cli = 'C:\\Apps\\TaskWraith\\resources\\host\\host-runtime\\cli.js'
    const result = await resolveTuiHostLaunchCommand({
      profile: 'production',
      platform: 'win32',
      architecture: 'x64',
      moduleDir: 'C:\\Apps\\TaskWraith\\resources\\tui\\tui',
      env: {},
      userDataPath: 'C:\\profiles\\a',
      pathExists: async (path) => path === executable || path === cli
    })

    expect(result).toMatchObject({
      executable,
      cwd: 'C:\\Apps\\TaskWraith\\resources\\host\\host-runtime',
      args: [cli, 'serve', '--mode', 'production', '--profile', 'C:\\profiles\\a']
    })
  })

  it('rejects whitespace-padded profile paths instead of silently normalizing them', async () => {
    await expect(
      resolveTuiHostLaunchCommand({
        profile: 'production',
        platform: 'darwin',
        architecture: 'arm64',
        moduleDir: '/app/resources/tui/tui',
        userDataPath: ' /profiles/unsafe ',
        pathExists: async () => true
      })
    ).rejects.toThrow('absolute profile path')
  })

  it('rejects control characters in the profile path like the production Host CLI', async () => {
    for (const userDataPath of [
      '/profiles/host\u0000',
      '/profiles/host\u0007',
      '/profiles/host\u007f'
    ]) {
      await expect(
        resolveTuiHostLaunchCommand({
          profile: 'production',
          platform: 'darwin',
          architecture: 'arm64',
          moduleDir: '/app/resources/tui/tui',
          userDataPath,
          pathExists: async () => true
        })
      ).rejects.toThrow('absolute profile path')
    }
  })

  it('uses the same direct Node Host invocation for an isolated package-smoke profile', async () => {
    const executable = '/tmp/TaskWraith-smoke.app/Contents/Resources/tui-runtime/darwin-arm64/node'
    const cli = '/tmp/TaskWraith-smoke.app/Contents/Resources/host/host-runtime/cli.js'
    // The platform is injected as darwin below, so the profile path must use
    // POSIX semantics too: the runner's own temp dir is not an absolute path to
    // posix.isAbsolute() and would be rejected on non-POSIX runners. Nothing in
    // this test touches the filesystem for the profile path.
    const userDataPath = '/tmp/taskwraith-tui-package-smoke-resolver'
    const result = await resolveTuiHostLaunchCommand({
      profile: 'package-smoke',
      userDataPath,
      platform: 'darwin',
      architecture: 'arm64',
      moduleDir: '/tmp/TaskWraith-smoke.app/Contents/Resources/tui/tui',
      env: {},
      pathExists: async (path) => path === executable || path === cli
    })

    expect(result).toMatchObject({
      executable,
      args: [cli, 'serve', '--mode', 'production', '--profile', userDataPath]
    })
  })

  it('reuses an authenticated Host without spawning', async () => {
    const spawn = vi.fn()
    const resolveLaunchCommand = vi.fn()
    await expect(
      ensureTuiHostAvailable({
        userDataPath: '/profiles/existing',
        profile: 'production',
        probe: vi.fn().mockResolvedValue(undefined),
        spawn,
        resolveLaunchCommand
      })
    ).resolves.toEqual({ kind: 'existing' })
    expect(resolveLaunchCommand).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
  })

  it('verifies identity before replacing a stale Host', async () => {
    // `npm run tui` rebuilds out/host and then reused whatever Host was already
    // listening, so a rebuilt fix never ran until that process died on its own.
    // The replacement now goes through verified termination, and nothing else
    // about the sequence may move.
    const calls: string[] = []
    const result = await ensureTuiHostAvailable(
      recordedStaleReplacement(calls, new FakeChild(), {
        terminateHost: async (request) => {
          calls.push(`terminate:${request.profilePath}:${String(request.pid)}`)
          return outcome('stopped')
        }
      })
    )

    expect(result).toEqual({ kind: 'launched', pid: 42, replacedPid: 4242 })
    expect(calls).toEqual(
      PRE_VERIFICATION_STALE_REPLACEMENT_CALLS.map((call) =>
        call === 'stopProcess:4242' ? 'terminate:/profiles/stale:4242' : call
      )
    )
  })

  it('never signals a stale Host pid whose birth no longer matches its records', async () => {
    // The pid the probe saw now belongs to a process born an hour later: the
    // stale Host is already gone and its pid was reused. A bare SIGTERM by pid
    // would hit that unrelated process.
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    const signal = vi.fn()
    try {
      const calls: string[] = []
      const child = new FakeChild()
      const result = await ensureTuiHostAvailable(
        recordedStaleReplacement(calls, child, {
          terminateHost: verifiedTermination(
            async () => ({
              state: 'live',
              birthIdentity: 'c'.repeat(64),
              startedAtMs: Date.parse(EVIDENCE_STARTED_AT) + 3_600_000
            }),
            signal
          )
        })
      )

      expect(signal).not.toHaveBeenCalled()
      expect(kill).not.toHaveBeenCalled()
      // A reused pid proves the stale Host gone, so the current build launches.
      expect(result).toEqual({ kind: 'launched', pid: 42, replacedPid: 4242 })
    } finally {
      kill.mockRestore()
    }
  })

  it('keeps a stale Host whose identity cannot be verified, launches nothing, and says so', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    const signal = vi.fn()
    try {
      const calls: string[] = []
      const result = await ensureTuiHostAvailable(
        recordedStaleReplacement(calls, new FakeChild(), {
          terminateHost: verifiedTermination(
            async () => ({ state: 'identity_unavailable' }),
            signal
          )
        })
      )

      expect(result).toEqual({
        kind: 'existing',
        staleHost: { pid: 4242, refusal: 'identity_unavailable' }
      })
      expect(signal).not.toHaveBeenCalled()
      expect(kill).not.toHaveBeenCalled()
      expect(calls.some((call) => call.startsWith('spawn:'))).toBe(false)
    } finally {
      kill.mockRestore()
    }
  })

  it('keeps a Host whose payload matches, or that predates payload identity', async () => {
    const spawn = vi.fn()
    const terminateHost = vi.fn(async () => outcome('stopped'))
    const matching = authenticatedProbe(4242)
    await expect(
      ensureTuiHostAvailable({
        userDataPath: '/profiles/matching',
        profile: 'development',
        probe: vi.fn().mockResolvedValue({
          ...matching,
          process: { ...matching.process, payloadVersion: `sha256:${'b'.repeat(64)}` }
        }),
        spawn,
        terminateHost,
        resolveLaunchCommand: async () => command(),
        resolvePayloadVersion: async () => `sha256:${'b'.repeat(64)}`
      })
    ).resolves.toEqual({ kind: 'existing' })
    await expect(
      ensureTuiHostAvailable({
        userDataPath: '/profiles/legacy',
        profile: 'development',
        probe: vi.fn().mockResolvedValue(authenticatedProbe(4242)),
        spawn,
        terminateHost,
        resolveLaunchCommand: async () => command(),
        resolvePayloadVersion: async () => `sha256:${'b'.repeat(64)}`
      })
    ).resolves.toEqual({ kind: 'existing' })
    expect(terminateHost).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
  })

  it('serializes launch races and waits for an authenticated handshake', async () => {
    const child = new FakeChild()
    const spawn = vi.fn().mockReturnValue(child.asChildProcess())
    const sourceSecret = Buffer.alloc(32, 0xab)
    const expectedBootstrap = hostFullAccessBootstrapFrame(sourceSecret)
    const probe = vi
      .fn<() => Promise<TuiHostAuthenticatedProbe | void>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(authenticatedProbe())
    let releaseDelay: (() => void) | undefined
    const delay = vi.fn(
      () =>
        new Promise<void>((resolveDelay) => {
          releaseDelay = resolveDelay
        })
    )
    const input = {
      userDataPath: '/profiles/race',
      profile: 'production' as const,
      enableFullAccessPresence: true,
      createFullAccessSecret: () => sourceSecret,
      probe,
      spawn,
      resolveLaunchCommand: async () => command(),
      delay,
      // This test is about the launch race, not stderr capture. Without the
      // seam the real opener runs: on POSIX `/profiles/race` is unwritable so
      // it fails open to 'ignore', but on Windows it resolves to a writable
      // `C:\profiles\race` and a real fd lands in stdio[2].
      openHostStderrLog: () => null
    }

    const first = ensureTuiHostAvailable(input)
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1))
    const second = ensureTuiHostAvailable(input)
    releaseDelay?.()

    const [firstResult, secondResult] = await Promise.all([first, second])
    expect(firstResult).toMatchObject({ kind: 'launched', pid: 42 })
    expect(firstResult.kind === 'launched' && firstResult.fullAccessPresence).toBeDefined()
    expect(secondResult).toEqual({ kind: 'existing' })
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(spawn.mock.calls[0][2]).toMatchObject({
      detached: true,
      shell: false,
      stdio: ['ignore', 'ignore', 'ignore', 'pipe'],
      windowsHide: true
    })
    expect(Buffer.concat(child.bootstrapChunks)).toEqual(expectedBootstrap)
    expect(spawn.mock.calls[0]?.[2]?.env).toMatchObject({
      [HOST_FULL_ACCESS_BOOTSTRAP_FD_ENV]: String(HOST_FULL_ACCESS_BOOTSTRAP_FD)
    })
    expect(JSON.stringify(spawn.mock.calls[0]?.[2]?.env)).not.toContain(
      sourceSecret.toString('hex')
    )
    expectedBootstrap.fill(0)
    expect(sourceSecret).toEqual(Buffer.alloc(32))
    expect(child.unref).toHaveBeenCalledTimes(1)
    if (firstResult.kind === 'launched') firstResult.fullAccessPresence?.dispose()
  })

  it('fails Full Access presence closed when fd3 write or process binding is unproven', async () => {
    const rejectingPipe = new Writable({
      write(_chunk, _encoding, callback) {
        callback(new Error('pipe refused'))
      }
    })
    const child = new FakeChild(rejectingPipe)
    const sourceSecret = Buffer.alloc(32, 5)
    const probe = vi
      .fn<() => Promise<TuiHostAuthenticatedProbe | void>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(authenticatedProbe(99))

    await expect(
      ensureTuiHostAvailable({
        userDataPath: '/profiles/bootstrap-off',
        profile: 'production',
        enableFullAccessPresence: true,
        createFullAccessSecret: () => sourceSecret,
        probe,
        spawn: vi.fn().mockReturnValue(child.asChildProcess()),
        resolveLaunchCommand: async () => command(),
        delay: async () => {},
        now: (() => {
          let now = 0
          return () => (now += 10)
        })()
      })
    ).resolves.toEqual({ kind: 'launched', pid: 42 })
    expect(sourceSecret).toEqual(Buffer.alloc(32))
  })

  it('never launches a competing Host for an incompatible or custom profile', async () => {
    const spawn = vi.fn()
    await expect(
      ensureTuiHostAvailable({
        userDataPath: '/profiles/incompatible',
        profile: 'production',
        probe: vi.fn().mockRejectedValue(new HostProjectionIncompatibleProtocolError()),
        spawn,
        resolveLaunchCommand: async () => command()
      })
    ).rejects.toBeInstanceOf(HostProjectionIncompatibleProtocolError)
    await expect(
      ensureTuiHostAvailable({
        userDataPath: '/profiles/custom',
        profile: 'custom',
        probe: vi.fn().mockRejectedValue(new Error('offline')),
        spawn,
        resolveLaunchCommand: async () => command()
      })
    ).rejects.toThrow(/explicit user-data profile/)
    expect(spawn).not.toHaveBeenCalled()
  })

  it('never launches beside an App-mode Host even when its capability set is complete', async () => {
    const spawn = vi.fn()
    await expect(
      ensureTuiHostAvailable({
        userDataPath: '/profiles/app-mode-host',
        profile: 'production',
        probe: vi.fn().mockRejectedValue(new TuiHostProductionCapabilityError()),
        spawn,
        resolveLaunchCommand: async () => command()
      })
    ).rejects.toBeInstanceOf(TuiHostProductionCapabilityError)
    expect(spawn).not.toHaveBeenCalled()
  })

  it('reports a non-zero owned child exit without touching discovery PIDs', async () => {
    const child = new FakeChild()
    let clock = 0
    const delay = vi.fn(async (milliseconds: number) => {
      clock += milliseconds
      if (clock >= 500 && child.exitCode === null) {
        child.exitCode = 2
        child.emit('exit', 2, null)
      }
    })
    await expect(
      ensureTuiHostAvailable({
        userDataPath: '/profiles/failed-child',
        profile: 'production',
        timeoutMs: 2_000,
        pollMs: 500,
        now: () => clock,
        delay,
        probe: vi.fn().mockRejectedValue(new Error('offline')),
        spawn: vi.fn().mockReturnValue(child.asChildProcess()),
        resolveLaunchCommand: async () => command()
      })
    ).rejects.toThrow(/exit code 2/)
  })

  describe('Host stderr capture', () => {
    // The Host is spawned detached and unref'd, and it writes no run events, so
    // fd 2 is the only place a Host-side failure ever explains itself. Sending
    // it to 'ignore' is what makes a failed turn look like "nothing evidently
    // wrong". These pin the fd to a log file — never the inherited terminal,
    // which a stray line would corrupt mid-frame.
    async function launchCapturing(
      openHostStderrLog: (userDataPath: string) => number | null,
      enableFullAccessPresence = false
    ) {
      const child = new FakeChild()
      const spawn = vi.fn().mockReturnValue(child.asChildProcess())
      const result = await ensureTuiHostAvailable({
        userDataPath: '/profiles/stderr',
        profile: 'production' as const,
        enableFullAccessPresence,
        ...(enableFullAccessPresence
          ? { createFullAccessSecret: () => Buffer.alloc(32, 0xcd) }
          : {}),
        openHostStderrLog,
        probe: vi
          .fn<() => Promise<TuiHostAuthenticatedProbe | void>>()
          .mockRejectedValueOnce(new Error('offline'))
          .mockResolvedValue(authenticatedProbe()),
        spawn,
        resolveLaunchCommand: async () => command(),
        delay: vi.fn().mockResolvedValue(undefined)
      })
      if (result.kind === 'launched') result.fullAccessPresence?.dispose()
      return spawn
    }

    it('routes Host stderr to the opened log fd instead of discarding it', async () => {
      const spawn = await launchCapturing(vi.fn().mockReturnValue(77))

      expect(spawn.mock.calls[0]?.[2]?.stdio).toEqual(['ignore', 'ignore', 77])
    })

    it('keeps the log fd on stderr while Full Access still owns fd 3', async () => {
      const spawn = await launchCapturing(vi.fn().mockReturnValue(78), true)

      // fd 3 is the bootstrap secret channel; capturing stderr must not
      // displace it, and Full Access must not cost the user diagnostics.
      expect(spawn.mock.calls[0]?.[2]?.stdio).toEqual(['ignore', 'ignore', 78, 'pipe'])
    })

    it('opens the log against the profile that owns the Host', async () => {
      const open = vi.fn().mockReturnValue(79)
      await launchCapturing(open)

      expect(open).toHaveBeenCalledWith('/profiles/stderr')
    })

    it('still launches the Host when the log cannot be opened', async () => {
      const spawn = await launchCapturing(vi.fn().mockReturnValue(null))

      // Fail-open: a profile we cannot write must never cost the user a turn.
      expect(spawn.mock.calls[0]?.[2]?.stdio).toEqual(['ignore', 'ignore', 'ignore'])
    })

    it('closes the parent copy of the fd so relaunches cannot leak one each', async () => {
      // spawn dups the fd into the child, so the parent's copy is ours to close.
      // A long-lived TUI that relaunches the Host would otherwise leak per launch.
      const scratch = mkdtempSync(join(tmpdir(), 'tw-host-stderr-fd-'))
      const fd = openSync(join(scratch, 'stderr.log'), 'a')
      try {
        expect(() => fstatSync(fd)).not.toThrow()

        await launchCapturing(vi.fn().mockReturnValue(fd))

        expect(() => fstatSync(fd)).toThrow(/EBADF/)
      } finally {
        rmSync(scratch, { recursive: true, force: true })
      }
    })
  })
})

describe('TUI Host restart', () => {
  it('refuses an explicit profile before stopping anything', async () => {
    const terminateHost = vi.fn(async () => outcome('stopped'))
    await expect(
      restartTuiHost({
        userDataPath: '/profiles/custom',
        profile: 'custom',
        terminateHost,
        resolveLaunchCommand: async () => command()
      })
    ).rejects.toThrow(/explicit user-data profile/)
    expect(terminateHost).not.toHaveBeenCalled()
  })

  it('refuses before stopping anything when no Host could be launched afterwards', async () => {
    const terminateHost = vi.fn(async () => outcome('stopped'))
    await expect(
      restartTuiHost({
        userDataPath: '/profiles/no-runtime',
        profile: 'production',
        terminateHost,
        resolveLaunchCommand: async () => null
      })
    ).rejects.toThrow(/Node runtime could not be located/)
    expect(terminateHost).not.toHaveBeenCalled()
  })

  it('stops the Host through verified termination, then launches the current build', async () => {
    const calls: string[] = []
    const child = new FakeChild()
    const result = await restartTuiHost({
      userDataPath: '/profiles/restart',
      profile: 'production',
      pid: 4242,
      terminateHost: async (request) => {
        calls.push(`terminate:${request.profilePath}:${String(request.pid)}`)
        return outcome('stopped')
      },
      probe: vi
        .fn<() => Promise<TuiHostAuthenticatedProbe | void>>()
        .mockImplementationOnce(async () => {
          calls.push('probe')
          throw new Error('offline')
        })
        .mockImplementation(async () => {
          calls.push('probe')
          return authenticatedProbe(42)
        }),
      resolveLaunchCommand: async () => {
        calls.push('resolveLaunchCommand')
        return command()
      },
      spawn: () => {
        calls.push('spawn')
        return child.asChildProcess()
      },
      openHostStderrLog: () => null,
      delay: async () => undefined
    })

    expect(calls).toEqual([
      'resolveLaunchCommand',
      'terminate:/profiles/restart:4242',
      'probe',
      'spawn',
      'probe'
    ])
    expect(result).toEqual({
      termination: outcome('stopped'),
      launch: { kind: 'launched', pid: 42 }
    })
  })

  it('launches nothing when the stop is refused', async () => {
    const spawn = vi.fn()
    const probe = vi.fn()
    const result = await restartTuiHost({
      userDataPath: '/profiles/refused',
      profile: 'production',
      terminateHost: async () => outcome('identity_unavailable'),
      probe,
      spawn,
      resolveLaunchCommand: async () => command()
    })

    expect(result).toEqual({ termination: outcome('identity_unavailable') })
    expect(probe).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
  })
})

describe('TUI Host stop-all', () => {
  const BIRTH = (pid: number): string => pid.toString(16).padStart(64, '0')

  function entry(profilePath: string, pid: number, holders = 1): HostRegistryEntry {
    return {
      schema: HOST_REGISTRY_SCHEMA,
      profilePath,
      pid,
      birthIdentity: BIRTH(pid),
      startedAt: '2026-09-23T10:00:00.000Z',
      hostId: `host-${pid}`,
      bootEpoch: null,
      payloadVersion: FRESH_PAYLOAD,
      socketPath: `/tmp/twh2-test-${pid}/taskwraith-host-v2.sock`,
      discoveryPath: `${profilePath}/taskwraith-host-v2.json`,
      cliPath: `/payloads/${pid}/host-runtime/cli.js`,
      nodeExecutable: '/usr/local/bin/node',
      persist: false,
      leaseMode: 'lease',
      writtenAt: '2026-09-23T10:00:05.000Z',
      beatSeq: 1,
      holders,
      implicitHolders: 0,
      lifetimePhase: 'held'
    }
  }

  /**
   * The real stopAllHosts selection over an in-memory registry. Every pid is
   * observed alive with the birth its entry recorded, so nothing here reads
   * a real process table or a real registry.
   */
  function fakeRegistry(entries: HostRegistryEntry[]) {
    const listing = (): HostRegistryListing => ({ root: '/registry', entries, unreadable: [] })
    return (options: HostStopAllOptions) =>
      stopAllHosts({
        ...options,
        ports: {
          readRegistry: listing,
          observe: async (pid) => ({ state: 'live', birthIdentity: BIRTH(pid), startedAtMs: 0 }),
          listProcesses: async () => ({ ok: false, reason: 'unsupported' }),
          readEvidence: () => ({ discovery: null, lease: null, registry: null }),
          sweep: async () => {
            throw new Error('planning never sweeps')
          },
          ...options.ports
        }
      })
  }

  const byProfile = (profilePath: string): TuiHostStopAllRequest => ({
    scope: { kind: 'profile', profilePath },
    scanArgv: false
  })

  it('plans with the CLI scope and signals nothing', async () => {
    const terminate = vi.fn(async () => outcome('stopped'))
    const plan = await planTuiHostStopAll(byProfile('/profiles/b'), {
      registryRoot: '/registry',
      ports: {
        stopAll: fakeRegistry([entry('/profiles/a', 101), entry('/profiles/b', 202, 2)]),
        terminate
      }
    })

    expect(plan.hosts.map((host) => [host.pid, host.selected])).toEqual([
      [101, false],
      [202, true]
    ])
    expect(plan.selected).toMatchObject([{ pid: 202, profilePath: '/profiles/b', holders: 2 }])
    expect(terminate).not.toHaveBeenCalled()
  })

  it('lists every Host and selects none without a scope', async () => {
    const plan = await planTuiHostStopAll(
      { scope: { kind: 'list' }, scanArgv: false },
      {
        registryRoot: '/registry',
        ports: { stopAll: fakeRegistry([entry('/profiles/a', 101), entry('/profiles/b', 202)]) }
      }
    )
    expect(plan.hosts).toHaveLength(2)
    expect(plan.selected).toEqual([])
  })

  it('stops exactly the planned Hosts through verified termination', async () => {
    const registry = fakeRegistry([entry('/profiles/a', 101), entry('/profiles/b', 202)])
    const terminate = vi.fn(async () => outcome('stopped', 202))
    const plan = await planTuiHostStopAll(byProfile('/profiles/b'), {
      registryRoot: '/registry',
      ports: { stopAll: registry }
    })
    const result = await runTuiHostStopAll(plan, { ports: { stopAll: registry, terminate } })

    expect(terminate.mock.calls).toEqual([
      [{ profilePath: '/profiles/b', registryRoot: '/registry' }]
    ])
    expect(result).toEqual({
      kind: 'done',
      results: [{ host: plan.selected[0], outcome: outcome('stopped', 202) }]
    })
  })

  it('never sweeps: a dead registry entry outside the scope survives /host stop-all', async () => {
    // /host stop-all requests no sweep: each stopped Host's own verified
    // termination removes its own records, and a dead Host outside the scope
    // keeps its entry, whether or not a sweep would stay in scope. TMPDIR is
    // pinned too, so no sweep could reach the real temporary directory's
    // socket directories.
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'tw-tui-stop-all-')))
    const previousTmpdir = process.env.TMPDIR
    process.env.TMPDIR = join(base, 'tmp')
    try {
      mkdirSync(join(base, 'tmp'), { recursive: true })
      const root = join(base, 'hosts')
      mkdirSync(root, { recursive: true, mode: 0o700 })
      const inScope = join(base, 'profiles', 'dev')
      const outOfScope = join(base, 'profiles', 'crashed')
      // Beyond every platform's pid range, so the entry's Host is certainly gone.
      const deadPid = 99_999_999
      for (const record of [entry(inScope, 101), entry(outOfScope, deadPid)]) {
        writeFileSync(
          hostRegistryEntryPath(root, record.profilePath),
          `${JSON.stringify(record)}\n`,
          {
            mode: 0o600
          }
        )
      }
      const observe = async (pid: number): Promise<ProcessBirthObservation> =>
        pid === deadPid
          ? { state: 'dead' }
          : { state: 'live', birthIdentity: BIRTH(pid), startedAtMs: 0 }
      const stopAll = (options: HostStopAllOptions) =>
        stopAllHosts({ ...options, ports: { observe, ...options.ports } })
      const terminate = vi.fn(async () => outcome('stopped', 101))

      const plan = await planTuiHostStopAll(byProfile(inScope), {
        registryRoot: root,
        ports: { stopAll }
      })
      expect(plan.hosts.map((host) => [host.pid, host.liveness, host.selected])).toEqual(
        expect.arrayContaining([
          [101, 'live', true],
          [deadPid, 'dead', false]
        ])
      )
      const result = await runTuiHostStopAll(plan, { ports: { stopAll, terminate } })

      expect(result.kind).toBe('done')
      expect(terminate.mock.calls).toEqual([[{ profilePath: inScope, registryRoot: root }]])
      expect(existsSync(hostRegistryEntryPath(root, outOfScope))).toBe(true)
    } finally {
      if (previousTmpdir === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = previousTmpdir
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('refuses the whole run when the registry changed after the plan was shown', async () => {
    const entries = [entry('/profiles/a', 101)]
    const registry = fakeRegistry(entries)
    const terminate = vi.fn(async () => outcome('stopped'))
    const plan = await planTuiHostStopAll(
      { scope: { kind: 'all' }, scanArgv: false },
      { registryRoot: '/registry', ports: { stopAll: registry } }
    )
    // A Host the user never saw starts before they press y.
    entries.push(entry('/profiles/new', 303))
    const result = await runTuiHostStopAll(plan, { ports: { stopAll: registry, terminate } })

    expect(result.kind).toBe('registry_changed')
    expect(
      result.kind === 'registry_changed' && result.fresh.selected.map((host) => host.pid)
    ).toEqual([101, 303])
    expect(terminate).not.toHaveBeenCalled()
  })
})
